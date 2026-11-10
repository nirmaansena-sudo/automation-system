import crypto from 'node:crypto';
import { all, one, insert, run, update, tx } from '../db/index.js';
import { config } from '../config.js';
import { audit, notify } from '../core/base.js';
import { nowIso, haversineM, jparse, istDate } from '../lib/util.js';
import { bad, notFound, forbidden } from '../lib/http.js';
import { originFor, pointOK, travelSettings, dispatchSettings, validateTravel } from './dispatch.js';
import { submitExpense } from './staff.js';

const pendingRoutes = new Map();
export function travelAmount(distanceKm, policy) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > 2000) throw bad('Invalid travel distance');
  policy = validateTravel(policy);
  if (policy.rate_per_km === null || policy.rate_per_km === undefined) return null;
  let amount = Math.max(policy.minimum_amount, policy.base_amount + distanceKm * policy.rate_per_km);
  amount = Math.round(amount / policy.rounding_rupees) * policy.rounding_rupees;
  amount = Math.max(policy.minimum_amount, amount);
  if (policy.maximum_amount !== null) amount = Math.min(amount, policy.maximum_amount);
  return Math.round(amount * 100) / 100;
}
async function routeDistance(origin, site, roundTrip) {
  const settings = dispatchSettings();
  const directKm = haversineM(origin.lat, origin.lng, site.lat, site.lng) / 1000;
  const fallback = () => ({ distance_km: Math.round(directKm * settings.road_factor * (roundTrip ? 2 : 1) * 100) / 100, duration_min: Math.round(directKm * settings.road_factor * (roundTrip ? 2 : 1) / settings.speed_kmh * 60), source: 'estimated', warning: 'Estimated from straight-line distance with a road allowance. Manager must verify before reimbursement.' });
  if (!config.routing?.osrmUrl) return fallback();
  const coords = [origin, site, ...(roundTrip ? [origin] : [])].map(p => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const key = crypto.createHash('sha256').update(config.routing.osrmUrl + '|' + coords).digest('hex');
  const cached = one('SELECT * FROM route_cache WHERE cache_key=? AND expires_at>?', key, nowIso());
  if (cached) return { distance_km: cached.distance_km, duration_min: cached.duration_min, source: 'osrm', cached: true };
  if (pendingRoutes.has(key)) return pendingRoutes.get(key);
  const task = (async () => {
    try {
      const url = new URL(config.routing.osrmUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid routing service URL');
      url.pathname = `${url.pathname.replace(/\/$/, '')}/route/v1/driving/${coords}`;
      url.search = 'overview=false&steps=false';
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!res.ok) throw new Error('Routing service unavailable');
      const data = await res.json(), r = data.routes?.[0];
      if (data.code !== 'Ok' || !r || !Number.isFinite(r.distance) || r.distance < directKm * 1000 * 0.9 || r.distance > 2000000 || !Number.isFinite(r.duration) || r.duration < 0) throw new Error('No reliable road route returned');
      const value = { distance_km: Math.round(r.distance / 10) / 100, duration_min: Math.round(r.duration / 60), source: 'osrm' };
      run('INSERT INTO route_cache(cache_key,distance_km,duration_min,source,expires_at,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET distance_km=excluded.distance_km,duration_min=excluded.duration_min,expires_at=excluded.expires_at,created_at=excluded.created_at', key, value.distance_km, value.duration_min, value.source, new Date(Date.now() + 30 * 86400000).toISOString(), nowIso());
      run('DELETE FROM route_cache WHERE expires_at<?', nowIso());
      return value;
    } catch { return { ...fallback(), warning: 'Road routing unavailable. This is an estimate; verify the distance before approval.' }; }
    finally { pendingRoutes.delete(key); }
  })();
  pendingRoutes.set(key, task); return task;
}
function visitContext(visitId) {
  const v = one('SELECT v.*,l.site_lat,l.site_lng,l.address,l.locality FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.id=?', visitId);
  if (!v) throw notFound('Visit not found');
  return v;
}
function canView(v, user) { if (!['owner', 'manager', 'finance'].includes(user.role) && v.architect_id !== user.id) throw forbidden('This visit is not assigned to you'); }
const HOME_CHANGE_REVIEW_DAYS = 30;
/** A trip from a home pin that moved recently needs an explicit manager check. */
function homeChange(row) {
  if (row.origin_type !== 'home') return null;
  const loc = one('SELECT home_changed_at, home_moved_km, home_changed_by FROM architect_locations WHERE user_id=?', row.user_id);
  // Pins set or moved by a manager are already checked; the architect's own changes are not.
  if (!loc?.home_changed_at || loc.home_changed_by !== `user:${row.user_id}`) return null;
  const days = (Date.now() - Date.parse(loc.home_changed_at)) / 86400000;
  if (!(days < HOME_CHANGE_REVIEW_DAYS)) return null;
  return { changed_at: loc.home_changed_at, days_ago: Math.max(0, Math.floor(days)), moved_km: loc.home_moved_km, by_self: loc.home_changed_by === `user:${row.user_id}` };
}
function publicTravel(row) {
  // Route endpoints include an architect's home. APIs need the chosen origin
  // type and approved amounts, not precise coordinates from the audit snapshot.
  const { origin_lat, origin_lng, site_lat, site_lng, ...safe } = row;
  return { ...safe, home_change: homeChange(row) };
}
function staleTravel(row, visit) {
  const policy = jparse(row.policy, {});
  const origin = originFor(visit.architect_id, row.origin_type);
  return row.visit_revision !== visit.revision || row.user_id !== visit.architect_id || row.site_lat !== visit.site_lat || row.site_lng !== visit.site_lng ||
    (row.status === 'proposed' && (!origin || origin.lat !== row.origin_lat || origin.lng !== row.origin_lng || JSON.stringify(policy) !== JSON.stringify(travelSettings())));
}
export function readTravel(visitId, user) {
  const v = visitContext(visitId); canView(v, user);
  const row = one('SELECT t.*,e.status expense_status FROM visit_travel t LEFT JOIN expense_claims e ON e.id=t.expense_id WHERE t.visit_id=?', visitId);
  return row ? publicTravel({ ...row, policy: jparse(row.policy, {}), stale: staleTravel(row, v) }) : null;
}
export async function travelOptions(visitId, user) {
  const v = visitContext(visitId); canView(v, user);
  if (!['owner', 'manager'].includes(user.role) && v.architect_id !== user.id) throw forbidden('Only the assigned architect or manager can compare origins');
  const policy = travelSettings(), site = { lat: v.site_lat, lng: v.site_lng };
  const current = readTravel(visitId, user);
  if (v.status === 'cancelled') return { current, choices: [], policy, message: 'Visit cancelled; no new travel claim can be created.' };
  if (!pointOK(site.lat, site.lng)) return { current, choices: [], policy, message: 'Ask the client to share a site location pin first.' };
  const choices = await Promise.all(['office', 'home'].map(async type => {
    const origin = originFor(v.architect_id, type);
    if (!origin) return { type, unavailable: `Save a ${type} location first` };
    const distance = await routeDistance(origin, site, policy.round_trip);
    return { type, label: origin.label, ...distance, amount: travelAmount(distance.distance_km, policy) };
  }));
  return { current, choices, policy, visit_status: v.status, rate_configured: policy.rate_per_km !== null };
}
export async function selectTravel(visitId, user, { origin_type, expected_revision = null }, { authorize } = {}) {
  if (!['home', 'office'].includes(origin_type)) throw bad('Choose home or office');
  if (expected_revision !== null && (!Number.isInteger(expected_revision) || expected_revision < 1)) throw bad('Invalid estimate revision');
  const v = visitContext(visitId); canView(v, user);
  if (!['owner', 'manager'].includes(user.role) && v.architect_id !== user.id) throw forbidden();
  if (!['confirmed', 'in_progress', 'report_submitted', 'completed'].includes(v.status)) throw bad('Travel is unavailable for this visit');
  if (!pointOK(v.site_lat, v.site_lng)) throw bad('Client site pin is missing');
  const origin = originFor(v.architect_id, origin_type); if (!origin) throw bad(`Save the ${origin_type} location first`);
  const policy = travelSettings(), routeSettings = dispatchSettings(), routingUrl = config.routing?.osrmUrl, site = { lat: v.site_lat, lng: v.site_lng };
  const distance = await routeDistance(origin, site, policy.round_trip);
  return tx(() => {
    // Channels with a mutable conversation/account context can reauthorize
    // here after the route lookup, immediately before the write transaction.
    authorize?.({ distance, origin, site, policy });
    const latest = visitContext(visitId), old = one('SELECT * FROM visit_travel WHERE visit_id=?', visitId);
    if (latest.revision !== v.revision || latest.architect_id !== v.architect_id || latest.site_lat !== v.site_lat || latest.site_lng !== v.site_lng || !['confirmed', 'in_progress', 'report_submitted', 'completed'].includes(latest.status)) throw bad('Visit changed; refresh and try again');
    const latestOrigin = originFor(v.architect_id, origin_type);
    if (!latestOrigin || latestOrigin.lat !== origin.lat || latestOrigin.lng !== origin.lng || JSON.stringify(policy) !== JSON.stringify(travelSettings()) || JSON.stringify(routeSettings) !== JSON.stringify(dispatchSettings()) || routingUrl !== config.routing?.osrmUrl) throw bad('Origin or travel settings changed; refresh and try again');
    if (old?.expense_id) throw bad('Travel already claimed; ask a manager to review the expense');
    if (old && expected_revision !== old.revision) throw bad('Travel estimate changed; refresh before choosing');
    const at = nowIso(), patch = { user_id: v.architect_id, visit_revision: v.revision, origin_type, origin_lat: origin.lat, origin_lng: origin.lng, site_lat: site.lat, site_lng: site.lng, distance_km: distance.distance_km, distance_source: distance.source, duration_min: distance.duration_min, amount: travelAmount(distance.distance_km, policy), policy: JSON.stringify(policy), status: 'proposed', revision: (old?.revision || 0) + 1, approved_by: null, approved_at: null, note: distance.warning || null, updated_at: at };
    if (old) run(`UPDATE visit_travel SET ${Object.keys(patch).map(k => `${k}=?`).join(',')} WHERE visit_id=?`, ...Object.values(patch), visitId);
    else insert('visit_travel', { visit_id: visitId, ...patch, created_at: at });
    audit(`user:${user.id}`, 'travel.selected', 'visit', visitId, { origin_type, distance_km: distance.distance_km, amount: patch.amount, source: distance.source });
    notify({ audience: 'managers', title: `Travel approval · ${v.ref}`, body: `${origin_type} · ${distance.distance_km} km${patch.amount === null ? ' · rate not set' : ` · ₹${patch.amount}`}`, link: '#/travel' });
    return readTravel(visitId, user);
  });
}
export function approveTravel(visitId, user, data) {
  if (!['owner', 'manager'].includes(user.role)) throw forbidden();
  return tx(() => {
    const current = readTravel(visitId, user), v = visitContext(visitId);
    if (!current || current.stale || v.status === 'cancelled' || current.expense_id) throw bad('Select a current origin before approval');
    if (Number(data.expected_revision) !== current.revision) throw bad('Estimate changed; refresh before approval');
    if (current.home_change && data.ack_home_change !== true) {
      const h = current.home_change;
      throw bad(`The home pin was changed ${h.days_ago === 0 ? 'today' : `${h.days_ago} day(s) ago`}${h.moved_km !== null ? ` (moved ${h.moved_km} km)` : ''}${h.by_self ? ' by the architect' : ''}. Check the starting point, then tick “I checked the home location”.`);
    }
    if (String(data.note || '').trim().length < 3) throw bad('Add a short approval or distance verification note');
    const policy = validateTravel({ ...current.policy, ...(data.rate_per_km !== undefined ? { rate_per_km: data.rate_per_km } : {}) });
    if (policy.rate_per_km === null) throw bad('Manager must set the rate per km first');
    let distance = current.distance_km, source = current.distance_source;
    if (data.verified_distance_km !== undefined && data.verified_distance_km !== '') {
      if (data.verified_distance_km === null || typeof data.verified_distance_km === 'boolean' || !['string', 'number'].includes(typeof data.verified_distance_km)) throw bad('Enter a numeric verified distance');
      distance = Number(data.verified_distance_km);
      if (!Number.isFinite(distance) || distance < 0 || distance > 2000) throw bad('Verified distance must be between 0 and 2000 km');
      distance = Math.round(distance * 100) / 100; source = 'manager_verified';
    }
    if (source === 'estimated' && data.accept_estimate !== true) throw bad('Verify the road distance or explicitly accept the estimate');
    run("UPDATE visit_travel SET distance_km=?,distance_source=?,amount=?,policy=?,status='approved',revision=revision+1,approved_by=?,approved_at=?,note=?,updated_at=? WHERE visit_id=?", distance, source, travelAmount(distance, policy), JSON.stringify(policy), user.id, nowIso(), String(data.note).trim().slice(0, 1000), nowIso(), visitId);
    audit(`user:${user.id}`, 'travel.approved', 'visit', visitId, { distance_km: distance, amount: travelAmount(distance, policy), rate: policy.rate_per_km, source, home_change_acknowledged: current.home_change ? { days_ago: current.home_change.days_ago, moved_km: current.home_change.moved_km } : undefined });
    return readTravel(visitId, user);
  });
}
export function claimTravel(visitId, user) {
  return tx(() => {
    const v = visitContext(visitId); canView(v, user);
    if (v.architect_id !== user.id) throw forbidden('Only the assigned architect can submit this claim');
    const t = readTravel(visitId, user);
    if (t?.expense_id) return { ok: true, duplicate: true, expense_id: t.expense_id };
    if (!t || t.stale || t.status !== 'approved') throw bad('Manager must approve the current travel estimate first');
    if (!['report_submitted', 'completed'].includes(v.status)) throw bad('Submit the visit report before claiming travel');
    if (!(t.amount > 0)) throw bad('This trip has no payable travel amount');
    const res = submitExpense(user.id, { category: 'travel', amount: t.amount, claim_date: istDate(v.start_at), description: `${v.ref}: ${t.origin_type} to site${t.policy.round_trip ? ' and return' : ''}; ${t.distance_km} km × ₹${t.policy.rate_per_km}/km; ${t.distance_source}. Travel approval by user ${t.approved_by}.` });
    if (res.error) throw bad(res.error);
    const expenseId = res.id;
    if (!expenseId) throw new Error('Expense claim was not created');
    run("UPDATE visit_travel SET expense_id=?,status='claimed',updated_at=? WHERE visit_id=?", expenseId, nowIso(), visitId);
    audit(`user:${user.id}`, 'travel.claimed', 'visit', visitId, { expense_id: expenseId, amount: t.amount });
    return { ok: true, expense_id: expenseId };
  });
}
export function listTravel() {
  return all('SELECT t.*,v.ref,v.status visit_status,v.revision current_visit_revision,v.start_at,u.name architect,e.status expense_status FROM visit_travel t JOIN visits v ON v.id=t.visit_id JOIN users u ON u.id=t.user_id LEFT JOIN expense_claims e ON e.id=t.expense_id ORDER BY t.updated_at DESC LIMIT 500').map(r => publicTravel({ ...r, policy: jparse(r.policy, {}), stale: staleTravel(r, visitContext(r.visit_id)) }));
}
