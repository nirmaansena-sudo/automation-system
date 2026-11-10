// H3 provides a local, fee-free spatial index. Territories guide dispatch;
// availability and travel distance always take precedence over a cell owner.
import { latLngToCell, cellToLatLng, cellToBoundary, polygonToCells, gridDisk, isValidCell } from 'h3-js';
import { all, one, run, tx } from '../db/index.js';
import { getSettings, saveSettings, audit } from '../core/base.js';
import { nowIso, haversineM, jparse } from '../lib/util.js';
import { bad, notFound } from '../lib/http.js';

export const DISPATCH_DEFAULTS = Object.freeze({ enabled: true, center_lat: 26.9124, center_lng: 75.7873, radius_km: 25, resolution: 7, workload_km: 1.5, territory_bonus_km: 1, max_distance_km: 80, road_factor: 1.3, speed_kmh: 25 });
export const TRAVEL_DEFAULTS = Object.freeze({ rate_per_km: null, base_amount: 0, minimum_amount: 0, maximum_amount: null, round_trip: false, rounding_rupees: 1, require_manager_approval: true });
const coordinate = (value, bound) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= bound;
export const pointOK = (lat, lng) => coordinate(lat, 90) && coordinate(lng, 180);
const requireObject = (value, name) => { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw bad(`${name} must be an object`); };
export function dispatchSettings() { return { ...DISPATCH_DEFAULTS, ...(getSettings().dispatch || {}) }; }
export function travelSettings() { return { ...TRAVEL_DEFAULTS, ...(getSettings().travel || {}) }; }
const number = (v, name, lo, hi, nullable = false) => {
  if (nullable && (v === null || v === '')) return null;
  if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) || Number(v) < lo || Number(v) > hi) throw bad(`${name} must be between ${lo} and ${hi}`);
  return Number(v);
};
export function validateDispatch(patch) {
  requireObject(patch, 'Dispatch settings');
  const d = { ...dispatchSettings(), ...patch };
  d.center_lat = number(d.center_lat, 'Coverage latitude', -85, 85); d.center_lng = number(d.center_lng, 'Coverage longitude', -180, 180);
  for (const [k, lo, hi] of [['radius_km', 2, 60], ['resolution', 6, 8], ['workload_km', 0, 20], ['territory_bonus_km', 0, 10], ['max_distance_km', 1, 200], ['road_factor', 1, 3], ['speed_kmh', 5, 100]]) d[k] = number(d[k], k, lo, hi);
  if (!Number.isInteger(d.resolution)) throw bad('Hex resolution must be a whole number');
  if (typeof d.enabled !== 'boolean') throw bad('Dispatch enabled must be true or false');
  if (coverageCells(d).length > 6000) throw bad('Coverage is too large for this resolution; lower the resolution or radius');
  return Object.fromEntries(Object.keys(DISPATCH_DEFAULTS).map(k => [k, d[k]]));
}
export function validateTravel(patch) {
  requireObject(patch, 'Travel settings');
  const p = { ...travelSettings(), ...patch };
  p.rate_per_km = number(p.rate_per_km, 'Rate per km', 0, 1000, true);
  for (const k of ['base_amount', 'minimum_amount']) p[k] = number(p[k], k, 0, 100000);
  p.maximum_amount = number(p.maximum_amount, 'Maximum amount', 0, 100000, true);
  p.rounding_rupees = number(p.rounding_rupees, 'Rounding increment', 1, 100);
  if (p.maximum_amount !== null && p.maximum_amount < p.minimum_amount) throw bad('Maximum cannot be below minimum');
  if (typeof p.round_trip !== 'boolean') throw bad('Round trip must be true or false');
  // Financial approval is deliberately mandatory; a chosen origin alone cannot pay a claim.
  p.require_manager_approval = true;
  return Object.fromEntries(Object.keys(TRAVEL_DEFAULTS).map(k => [k, p[k]]));
}
export function saveDispatchSettings(data, actor) {
  requireObject(data, 'Dispatch settings');
  const { dispatch, travel } = data;
  const patch = {};
  if (Object.hasOwn(data, 'dispatch')) patch.dispatch = validateDispatch(dispatch);
  if (Object.hasOwn(data, 'travel')) patch.travel = validateTravel(travel);
  return tx(() => { saveSettings(patch, actor); territoryMemo = null; return { dispatch: dispatchSettings(), travel: travelSettings() }; });
}
export function locationProfile(userId) {
  return one('SELECT * FROM architect_locations WHERE user_id=?', userId) || { user_id: userId, home_lat: null, home_lng: null, home_label: '', default_origin: 'office' };
}
export function setLocationProfile(userId, data, actor) {
  requireObject(data, 'Origin profile');
  if (!one("SELECT 1 FROM users WHERE id=? AND role IN ('architect','engineer') AND active=1", userId)) throw notFound('Active architect or engineer not found');
  const old = locationProfile(userId), p = { ...old, ...data };
  if (p.home_label !== undefined && p.home_label !== null && (typeof p.home_label !== 'string' || p.home_label.length > 120)) throw bad('Home label must be text of at most 120 characters');
  if (!['home', 'office'].includes(p.default_origin)) throw bad('Choose home or office');
  const cleared = [p.home_lat, p.home_lng].every(v => v === null || v === '');
  if (!cleared && !pointOK(p.home_lat, p.home_lng)) throw bad('Enter a valid home latitude and longitude');
  if (p.default_origin === 'home' && cleared) throw bad('Save a home pin first');
  return tx(() => {
    run('INSERT INTO architect_locations(user_id,home_lat,home_lng,home_label,default_origin,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET home_lat=excluded.home_lat,home_lng=excluded.home_lng,home_label=excluded.home_label,default_origin=excluded.default_origin,updated_at=excluded.updated_at', userId, cleared ? null : Number(p.home_lat), cleared ? null : Number(p.home_lng), String(p.home_label || '').slice(0, 120), p.default_origin, nowIso());
    audit(actor, 'travel.origin_updated', 'user', userId, { default_origin: p.default_origin, home_pin_set: !cleared });
    territoryMemo = null;
    return locationProfile(userId);
  });
}
export function originFor(userId, kind) {
  const p = locationProfile(userId), office = getSettings().office || {};
  const type = kind || p.default_origin;
  const origin = type === 'home' ? { type, lat: p.home_lat, lng: p.home_lng, label: p.home_label || 'Home' } : { type: 'office', lat: office.lat, lng: office.lng, label: office.name || 'Office' };
  return pointOK(origin.lat, origin.lng) ? { ...origin, lat: Number(origin.lat), lng: Number(origin.lng) } : null;
}
export function cellFor(lat, lng, settings = dispatchSettings()) { return pointOK(lat, lng) ? latLngToCell(Number(lat), Number(lng), settings.resolution) : null; }
function coverageCells(s) {
  const ring = Array.from({ length: 72 }, (_, i) => { const a = i * Math.PI / 36; return [s.center_lat + s.radius_km / 111.195 * Math.sin(a), s.center_lng + s.radius_km / (111.195 * Math.cos(s.center_lat * Math.PI / 180)) * Math.cos(a)]; });
  return polygonToCells(ring, s.resolution).sort();
}
let territoryMemo = null;
export function territoryPlan() {
  const s = dispatchSettings();
  const users = all("SELECT id,name,daily_visit_cap FROM users WHERE active=1 AND role IN ('architect','engineer') AND phone IS NOT NULL AND daily_visit_cap>0 ORDER BY id").map(u => ({ ...u, origin: originFor(u.id) }));
  const key = JSON.stringify([s, users]);
  if (territoryMemo?.key === key) return territoryMemo.value;
  const cells = coverageCells(s);
  if (cells.length > 6000) throw bad('Reduce hex coverage or resolution');
  const centers = new Map(cells.map(c => [c, cellToLatLng(c)]));
  const owners = new Map(), counts = new Map(users.map(u => [u.id, 0]));
  // Spread coincident office origins into separate seeds, then grow connected sectors.
  const seeds = [];
  for (const u of users.slice(0, cells.length)) {
    let seed;
    if (u.origin && !seeds.some(x => haversineM(x.lat, x.lng, u.origin.lat, u.origin.lng) < 1500)) {
      seed = cells.reduce((best, c) => { if (owners.has(c)) return best; const p = centers.get(c), cost = haversineM(...p, u.origin.lat, u.origin.lng); return !best || cost < best.cost ? { c, cost } : best; }, null)?.c;
    } else {
      seed = cells.reduce((best, c) => { if (owners.has(c)) return best; const p = centers.get(c); const cost = seeds.length ? Math.min(...seeds.map(x => haversineM(...p, x.lat, x.lng))) : -haversineM(...p, s.center_lat, s.center_lng); return !best || cost > best.cost ? { c, cost } : best; }, null)?.c;
    }
    if (!seed) continue;
    const [lat, lng] = centers.get(seed); seeds.push({ id: u.id, cell: seed, lat, lng, capacity: Math.max(1, u.daily_visit_cap) }); owners.set(seed, u.id); counts.set(u.id, 1);
  }
  const cellSet = new Set(cells);
  const frontiers = new Map(seeds.map(seed => [seed.id, new Set(gridDisk(seed.cell, 1).filter(c => cellSet.has(c) && !owners.has(c)))]));
  while (owners.size < cells.length && seeds.length) {
    let picked = null;
    const candidates = [...seeds].sort((a, b) => counts.get(a.id) / a.capacity - counts.get(b.id) / b.capacity || a.id - b.id);
    for (const seed of candidates) {
      let best = null;
      const frontier = frontiers.get(seed.id);
      for (const c of frontier) { if (owners.has(c)) { frontier.delete(c); continue; } const cost = haversineM(...centers.get(c), seed.lat, seed.lng); if (!best || cost < best.cost || (cost === best.cost && c < best.c)) best = { c, cost }; }
      if (best) { picked = { seed, cell: best.c }; break; }
    }
    if (!picked) {
      const c = cells.find(x => !owners.has(x));
      const seed = [...seeds].sort((a, b) => haversineM(...centers.get(c), a.lat, a.lng) - haversineM(...centers.get(c), b.lat, b.lng))[0];
      picked = { seed, cell: c };
    }
    owners.set(picked.cell, picked.seed.id); counts.set(picked.seed.id, counts.get(picked.seed.id) + 1);
    for (const c of gridDisk(picked.cell, 1)) if (cellSet.has(c) && !owners.has(c)) frontiers.get(picked.seed.id).add(c);
  }
  const value = { settings: s, cells, owners, users: users.map(({ origin, ...u }) => ({ ...u, cells: counts.get(u.id), origin_type: origin?.type || null })), centers };
  territoryMemo = { key, value }; return value;
}
export function coverageGeoJSON() {
  const plan = territoryPlan(), demand = new Map();
  for (const p of all("SELECT site_lat,site_lng FROM leads WHERE site_lat IS NOT NULL AND status NOT IN ('lost','converted','won')")) { const cell = cellFor(p.site_lat, p.site_lng, plan.settings); demand.set(cell, (demand.get(cell) || 0) + 1); }
  const places = all('SELECT name,lat,lng FROM zones WHERE active=1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY sort').filter(p => pointOK(p.lat,p.lng) && plan.owners.has(cellFor(p.lat,p.lng,plan.settings)));
  return { type: 'FeatureCollection', label: 'Configurable Jaipur service area — not an official city boundary', architects: plan.users, places, settings: plan.settings, features: plan.cells.map(cell => { const points = cellToBoundary(cell, true); return { type: 'Feature', properties: { cell, architect_id: plan.owners.get(cell) || null, enquiries: demand.get(cell) || 0 }, geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] } }; }) };
}
export function proximity(userId, lead) {
  const s = dispatchSettings(), origin = originFor(userId), cell = cellFor(lead.site_lat, lead.site_lng, s);
  if (!origin || !cell) return { distance_km: null, origin_type: origin?.type || null, cell, territory: false, penalty: 0 };
  const distance_km = haversineM(origin.lat, origin.lng, Number(lead.site_lat), Number(lead.site_lng)) / 1000 * s.road_factor;
  const territory = territoryPlan().owners.get(cell) === userId;
  return { distance_km: Math.round(distance_km * 10) / 10, origin_type: origin.type, cell, territory, penalty: distance_km - (territory ? s.territory_bonus_km : 0), estimated: true };
}
