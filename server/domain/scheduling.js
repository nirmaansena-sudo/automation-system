// Architect assignment: slots, eligibility, versioned offers with calendar
// holds (created in the same transaction), architect and client responses.
import { all, one, run, insert, update, tx, onCommit } from '../db/index.js';
import { now, nowIso, addMin, addMinIso, jparse, istDate, fromIst, addDays, dayOfWeek, fmtSlot, fmtTime, minutesBetween, haversineM } from '../lib/util.js';
import { proximity, dispatchSettings, pointOK } from './dispatch.js';
import { broadcast } from '../lib/http.js';
import { audit, notify, createTask, getSettings, setting } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent, registerGuard } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { t } from '../bot/i18n.js';
import { getContact, getUser, ensureContact, setFlow, servicesText, leadPlace, areaText, natureText, firstName } from './common.js';
import { getLead, updateLead, createApproval } from './leads.js';
import { confirmVisitFromOffer } from './visits.js';

// ---------- availability ----------
function isHoliday(day) { return !!one('SELECT 1 FROM holidays WHERE day = ?', day); }

export function hasConflict(userId, start, end, ignoreHoldId = null) {
  const s = getSettings();
  const from = addMinIso(start, -s.visit_buffer_min); const to = addMinIso(end, s.visit_buffer_min);
  return !!one(`SELECT 1 FROM calendar_holds WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at > ?)
    AND start_at < ? AND end_at > ? AND (? IS NULL OR id != ?) LIMIT 1`, userId, nowIso(), to, from, ignoreHoldId, ignoreHoldId);
}
function onLeave(userId, day) {
  const start = fromIst(day, '00:00').toISOString(); const end = fromIst(addDays(day, 1), '00:00').toISOString();
  return !!one("SELECT 1 FROM calendar_holds WHERE user_id=? AND status='active' AND kind IN ('leave','block') AND start_at < ? AND end_at > ? LIMIT 1", userId, end, start);
}
function visitsOnDay(userId, day) {
  const start = fromIst(day, '00:00').toISOString(); const end = fromIst(addDays(day, 1), '00:00').toISOString();
  return one(`SELECT COUNT(*) n FROM calendar_holds WHERE user_id=? AND status='active' AND kind IN ('hold','visit') AND (expires_at IS NULL OR expires_at > ?) AND start_at >= ? AND start_at < ?`, userId, nowIso(), start, end).n;
}
function weekLoad(userId) {
  return one("SELECT COUNT(*) n FROM visits WHERE architect_id=? AND status NOT IN ('cancelled') AND start_at > ? AND start_at < ?", userId, addMinIso(nowIso(), -7 * 1440), addMinIso(nowIso(), 7 * 1440)).n;
}

/** Ranked list of architects who can take this lead at [start, end). */
export function eligibleArchitects(lead, start, end, excludeIds = []) {
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime()) || new Date(end) <= new Date(start)) return [];
  const day = istDate(start); const dow = dayOfWeek(day);
  if (isHoliday(day)) return [];
  const dispatch = dispatchSettings();
  const services = jparse(lead.services, []);
  const users = all("SELECT * FROM users WHERE active=1 AND role IN ('architect','engineer') AND phone IS NOT NULL");
  const out = [];
  for (const u of users) {
    if (excludeIds.includes(u.id)) continue;
    if (jparse(u.weekly_off, []).includes(dow)) continue;
    const shiftStart = fromIst(day, u.shift_start), shiftEnd = fromIst(day, u.shift_end);
    if (shiftEnd <= shiftStart) shiftEnd.setDate(shiftEnd.getDate() + 1);
    if (new Date(start) < shiftStart || new Date(end) > shiftEnd) continue;
    const skills = jparse(u.skills, []);
    if (skills.length && services.length && !services.some((s) => skills.includes(s))) continue;
    if (onLeave(u.id, day)) continue;
    if (hasConflict(u.id, start, end)) continue;
    if (visitsOnDay(u.id, day) >= u.daily_visit_cap) continue;
    const trip = proximity(u.id, lead);
    if (dispatch.enabled && trip.distance_km !== null && trip.distance_km > dispatch.max_distance_km) continue;
    if (dispatch.enabled && !travelGapAvailable(u.id, lead, start, end, dispatch)) continue;
    const zones = jparse(u.zones, []);
    let score = 0;
    if (lead.zone && zones.includes(lead.zone)) score += 50; else if (!zones.length) score += 20;
    if (skills.length && services.some((s) => skills.includes(s))) score += 10;
    const load = weekLoad(u.id);
    if (dispatch.enabled && trip.distance_km !== null) score = (zones.includes(lead.zone) ? 2 : 0) - trip.penalty - load * dispatch.workload_km;
    else score -= load * 3;
    out.push({ user: u, score: Math.round(score * 100) / 100, distance_km: trip.distance_km, distance_source: trip.distance_km === null ? 'missing_pin' : 'estimated', origin_type: trip.origin_type, cell: trip.cell, territory: trip.territory, workload: load });
  }
  return out.sort((a, b) => b.score - a.score || a.user.id - b.user.id);
}

function travelGapAvailable(userId, lead, start, end, dispatch) {
  if (!pointOK(lead.site_lat, lead.site_lng)) return true;
  const visits = all("SELECT v.start_at,v.end_at,l.site_lat,l.site_lng FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? AND v.status NOT IN ('cancelled','no_show_client','no_show_architect') AND v.start_at>=? AND v.start_at<?", userId, fromIst(istDate(start), '00:00').toISOString(), fromIst(addDays(istDate(start), 1), '00:00').toISOString());
  for (const v of visits) {
    if (!pointOK(v.site_lat, v.site_lng)) continue;
    const travelMin = haversineM(v.site_lat, v.site_lng, lead.site_lat, lead.site_lng) / 1000 * dispatch.road_factor / dispatch.speed_kmh * 60;
    const gap = new Date(v.end_at) <= new Date(start) ? minutesBetween(v.end_at, start) : new Date(v.start_at) >= new Date(end) ? minutesBetween(end, v.start_at) : -1;
    if (gap < travelMin) return false;
  }
  return true;
}

export function candidateSlots(days) {
  const s = getSettings();
  const minStart = addMin(now(), s.min_lead_time_min);
  const out = [];
  const today = istDate();
  for (let i = 0; i <= (days ?? s.slot_days_ahead); i++) {
    const d = addDays(today, i);
    if (isHoliday(d)) continue;
    for (const hm of s.visit_slots) {
      const st = fromIst(d, hm);
      if (st >= minStart) out.push(st);
    }
  }
  return out;
}
/** Slots where at least one architect is free (for the client's list). */
export function availableSlots(lead, limit = 9) {
  const dur = setting('visit_duration_min');
  const res = [];
  for (const st of candidateSlots()) {
    const en = addMin(st, dur);
    if (eligibleArchitects(lead, st, en).length) res.push(st.toISOString());
    if (res.length >= limit) break;
  }
  return res;
}
export const slotId = (isoStr) => isoStr.replace(/[-:]/g, '').slice(0, 13); // 20261108T0530
export function slotFromId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})$/.exec(id);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString() : null;
}

// ---------- offers ----------
export function getOffer(id) { return one('SELECT * FROM visit_offers WHERE id = ?', id); }
function currentRevision(leadId) { return one('SELECT COALESCE(MAX(revision),0) r FROM visit_offers WHERE lead_id = ?', leadId).r; }

registerGuard('offer', (g) => {
  const o = getOffer(g.id);
  return !!o && o.revision === currentRevision(o.lead_id) && (!g.status || g.status.includes(o.status));
});

export function releaseHold(holdId) {
  if (holdId) run("UPDATE calendar_holds SET status='released' WHERE id=? AND status='active'", holdId);
}
function closeOffer(o, status, reason) {
  update('visit_offers', o.id, { status, decline_reason: reason || o.decline_reason, responded_at: nowIso(), updated_at: nowIso() });
  releaseHold(o.hold_id);
  cancelTimers('offer', o.id);
}

/**
 * Create an offer for a lead. Picks the best architect unless one is given.
 * Returns { offerId, architect, slot } or { error }.
 */
class OfferError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export function createOffer(leadId, opts = {}) {
  try { return createOfferTx(leadId, opts); } catch (e) { if (e instanceof OfferError) return { error: e.message, code: e.code }; throw e; }
}
function createOfferTx(leadId, { architectId = null, slotStart = null, createdBy = 'system', attempt = null } = {}) {
  return tx(() => {
    const s = getSettings();
    const lead = getLead(leadId);
    if (!lead) throw new OfferError('Lead not found');
    // Supersede older offers first (inside a savepoint: rolled back if no architect can be found).
    for (const p of all("SELECT * FROM visit_offers WHERE lead_id=? AND status IN ('pending','accepted')", leadId)) closeOffer(p, 'superseded', 'New offer created');
    let start = slotStart ? new Date(slotStart) : null;
    if (start && !Number.isFinite(start.getTime())) throw new OfferError('Select a valid visit date and time');
    if (!start || start < now()) {
      const first = availableSlots(lead, 1)[0];
      if (!first) throw new OfferError('No architect is free in the next few days. Add a slot or free an architect\'s calendar.', 'no_architect');
      start = new Date(first);
    }
    const end = addMin(start, s.visit_duration_min);
    const tried = all("SELECT architect_id FROM visit_offers WHERE lead_id=? AND slot_start=? AND status IN ('declined','expired')", leadId, start.toISOString()).map((r) => r.architect_id);
    let arch;
    if (architectId) {
      arch = getUser(Number(architectId));
      if (!arch || !arch.active) throw new OfferError('Architect not found or inactive');
      if (!arch.phone) throw new OfferError(`${arch.name} has no WhatsApp number on file`);
      if (hasConflict(arch.id, start, end)) throw new OfferError(`${arch.name} is busy at ${fmtSlot(start)}. Choose another time or architect.`, 'busy');
      if (!eligibleArchitects(lead, start, end).some(x => x.user.id === arch.id)) throw new OfferError(`${arch.name} is unavailable or ineligible for this time. Check shift, leave, daily limit, skills and travel distance.`, 'ineligible');
    } else {
      const list = eligibleArchitects(lead, start, end, tried);
      if (!list.length) throw new OfferError(`No eligible architect is free at ${fmtSlot(start)}.`, 'no_architect');
      arch = list[0].user;
    }
    const at = nowIso();
    const revision = currentRevision(leadId) + 1;
    const n = attempt || (one('SELECT COUNT(*) n FROM visit_offers WHERE lead_id=? AND slot_start=?', leadId, start.toISOString()).n + 1);
    const expiresAt = addMinIso(at, s.offer_timeout_min);
    const holdId = insert('calendar_holds', { user_id: arch.id, start_at: start.toISOString(), end_at: end.toISOString(), kind: 'hold', ref_type: 'offer', status: 'active', expires_at: addMinIso(at, s.offer_timeout_min + s.client_confirm_timeout_min + 15), created_at: at });
    const offerId = insert('visit_offers', { lead_id: leadId, architect_id: arch.id, revision, attempt: n, slot_start: start.toISOString(), slot_end: end.toISOString(), status: 'pending', expires_at: expiresAt, hold_id: holdId, created_by: createdBy, created_at: at, updated_at: at });
    run('UPDATE calendar_holds SET ref_id=? WHERE id=?', offerId, holdId);
    updateLead(leadId, { status: 'scheduling' }, createdBy);

    const ac = ensureContact(arch.phone, { userId: arch.id });
    const lang = ac.language || 'en';
    const deadline = fmtTime(expiresAt, lang);
    enqueueWhatsApp({
      to: arch.phone, kind: 'offer.architect', sender: 'system', essential: true,
      guard: { type: 'offer', id: offerId, status: ['pending'] },
      message: {
        type: 'buttons',
        text: t('offer_architect', lang, { ref: lead.ref, services: servicesText(lead.services, lang), nature: natureText(lead, lang), place: leadPlace(lead, lang), area: areaText(lead, lang), slot: fmtSlot(start, lang), deadline }),
        buttons: [{ id: `OF:A:${offerId}:${revision}`, title: t('btn_accept', lang) }, { id: `OF:D:${offerId}:${revision}`, title: t('btn_decline', lang) }],
      },
      template: { name: 'ns_visit_offer', params: [lead.ref, servicesText(lead.services, lang), leadPlace(lead, lang), fmtSlot(start, lang), deadline], buttons: [{ type: 'quick_reply', payload: `OF:A:${offerId}:${revision}` }, { type: 'quick_reply', payload: `OF:D:${offerId}:${revision}` }] },
    });
    schedule('offer_expiry', { entityType: 'offer', entityId: offerId, revision, dueAt: expiresAt, dedupeKey: `offer-expiry:${offerId}` });
    notify({ userId: arch.id, title: `New visit request ${lead.ref}`, body: `${fmtSlot(start)} · ${leadPlace(lead)}`, link: '#/offers', level: 'warn' });
    audit(createdBy, 'offer.created', 'lead', leadId, { offerId, architect: arch.id, slot: start.toISOString(), revision, attempt: n });
    onCommit(() => broadcast('visits'));
    return { offerId, architect: { id: arch.id, name: arch.name }, slot: start.toISOString() };
  });
}

/** After a decline/expiry: next architect for the same slot, else manager decides. */
function nextAttempt(lead, offer, reason) {
  const max = setting('max_offer_attempts');
  const attempts = one('SELECT COUNT(*) n FROM visit_offers WHERE lead_id=? AND slot_start=?', lead.id, offer.slot_start).n;
  if (attempts < max) {
    const r = createOffer(lead.id, { slotStart: offer.slot_start, createdBy: 'system', attempt: attempts + 1 });
    if (!r.error) return r;
  }
  updateLead(lead.id, { status: 'awaiting_approval' }, 'system');
  createApproval('lead_assignment', 'lead', lead.id, `No architect confirmed · ${lead.ref}`,
    `Last: ${reason}. ${attempts} architect(s) tried for ${fmtSlot(offer.slot_start)}. Pick another time or architect.`, { reason: 'no_architect' }, addMinIso(nowIso(), 30));
  notify({ audience: 'managers', title: `No architect for ${lead.ref}`, body: `Tried ${attempts}. Please assign manually.`, link: '#/approvals', level: 'error' });
  return { error: 'no_architect' };
}

registerTimer('offer_expiry', (tm) => {
  const o = getOffer(tm.entity_id);
  if (!o || o.status !== 'pending' || o.revision !== tm.revision) return 'stale';
  closeOffer(o, 'expired', 'No reply in time');
  const lead = getLead(o.lead_id);
  const arch = getUser(o.architect_id);
  if (arch?.phone) {
    const c = ensureContact(arch.phone, { userId: arch.id });
    enqueueWhatsApp({ to: arch.phone, kind: 'offer.expired', sender: 'system', optional: true, message: { type: 'text', text: t('offer_expired_note', c.language, { ref: lead.ref }) } });
  }
  audit('system', 'offer.expired', 'lead', lead.id, { offerId: o.id });
  nextAttempt(lead, o, `${arch?.name || 'architect'} did not reply`);
  return 'expired';
});

/** Architect pressed Accept/Decline (WhatsApp button or app). */
export function architectRespond(offerId, revision, accept, { userId = null, reason = null, via = 'whatsapp' } = {}) {
  return tx(() => {
    const o = getOffer(offerId);
    if (!o || o.revision !== Number(revision) || o.status !== 'pending' || o.revision !== currentRevision(o.lead_id)) return { stale: true };
    if (userId && o.architect_id !== userId) return { stale: true };
    if (new Date(o.expires_at) < now()) return { stale: true };
    const s = getSettings();
    const lead = getLead(o.lead_id);
    const arch = getUser(o.architect_id);
    const ac = ensureContact(arch.phone, { userId: arch.id });
    const at = nowIso();
    cancelTimers('offer', o.id, ['offer_expiry']);
    if (!accept) {
      closeOffer(o, 'declined', reason || 'Declined');
      enqueueWhatsApp({ to: arch.phone, kind: 'offer.declined_ack', sender: 'system', message: { type: 'text', text: t('offer_declined_ack', ac.language) } });
      audit(`user:${arch.id}`, 'offer.declined', 'lead', lead.id, { offerId, via, reason });
      nextAttempt(lead, o, `${arch.name} declined${reason ? ': ' + reason : ''}`);
      return { ok: true, declined: true };
    }
    const deadline = addMinIso(at, s.client_confirm_timeout_min);
    update('visit_offers', o.id, { status: 'accepted', responded_at: at, client_deadline: deadline, updated_at: at });
    run('UPDATE calendar_holds SET expires_at=? WHERE id=?', addMinIso(deadline, 15), o.hold_id);
    enqueueWhatsApp({ to: arch.phone, kind: 'offer.accepted_ack', sender: 'system', message: { type: 'text', text: t('offer_accepted_ack', ac.language) } });
    askClientToConfirm(o, lead, arch);
    schedule('client_confirm_reminder', { entityType: 'offer', entityId: o.id, revision: o.revision, dueAt: addMinIso(at, Math.round(s.client_confirm_timeout_min / 2)), dedupeKey: `ccr:${o.id}` });
    schedule('client_confirm_deadline', { entityType: 'offer', entityId: o.id, revision: o.revision, dueAt: deadline, dedupeKey: `ccd:${o.id}` });
    audit(`user:${arch.id}`, 'offer.accepted', 'lead', lead.id, { offerId, via });
    onCommit(() => broadcast('visits'));
    return { ok: true, accepted: true };
  });
}

function askClientToConfirm(o, lead, arch) {
  const c = getContact(lead.contact_id);
  const lang = c.language || 'en';
  const archName = (lang === 'hi' ? 'आर्किटेक्ट ' : 'Ar. ') + arch.name;
  enqueueWhatsApp({
    to: c.wa_id, kind: 'visit.confirm_request', sender: 'system', essential: true,
    guard: { type: 'offer', id: o.id, status: ['accepted'] },
    message: {
      type: 'buttons', text: t('client_confirm', lang, { architect: archName, place: leadPlace(lead, lang), slot: fmtSlot(o.slot_start, lang) }),
      buttons: [{ id: `VC:Y:${o.id}:${o.revision}`, title: t('btn_yes_confirm', lang) }, { id: `VC:R:${o.id}:${o.revision}`, title: t('btn_other_time', lang) }, { id: `VC:N:${o.id}:${o.revision}`, title: t('btn_cancel', lang) }],
    },
    template: { name: 'ns_visit_confirm_request', params: [(c.name || c.profile_name || '').split(' ')[0] || (lang === 'hi' ? 'जी' : 'there'), archName, leadPlace(lead, lang), fmtSlot(o.slot_start, lang)], buttons: [{ type: 'quick_reply', payload: `VC:Y:${o.id}:${o.revision}` }, { type: 'quick_reply', payload: `VC:R:${o.id}:${o.revision}` }, { type: 'quick_reply', payload: `VC:N:${o.id}:${o.revision}` }] },
  });
  setFlow(c.id, 'await_visit_confirm', null, { offerId: o.id, rev: o.revision });
}

registerTimer('client_confirm_reminder', (tm) => {
  const o = getOffer(tm.entity_id);
  if (!o || o.status !== 'accepted' || o.revision !== tm.revision) return 'stale';
  const lead = getLead(o.lead_id); const c = getContact(lead.contact_id);
  enqueueWhatsApp({
    to: c.wa_id, kind: 'visit.confirm_reminder', sender: 'system', guard: { type: 'offer', id: o.id, status: ['accepted'] },
    message: { type: 'buttons', text: t('client_confirm_reminder', c.language, { slot: fmtSlot(o.slot_start, c.language) }), buttons: [{ id: `VC:Y:${o.id}:${o.revision}`, title: t('btn_yes_confirm', c.language) }, { id: `VC:R:${o.id}:${o.revision}`, title: t('btn_other_time', c.language) }, { id: `VC:N:${o.id}:${o.revision}`, title: t('btn_cancel', c.language) }] },
  });
  return 'reminded';
});

registerTimer('client_confirm_deadline', (tm) => {
  const o = getOffer(tm.entity_id);
  if (!o || o.status !== 'accepted' || o.revision !== tm.revision) return 'stale';
  closeOffer(o, 'client_timeout', 'Client did not confirm');
  const lead = getLead(o.lead_id); const c = getContact(lead.contact_id);
  const arch = getUser(o.architect_id);
  enqueueWhatsApp({ to: c.wa_id, kind: 'visit.client_timeout', sender: 'system', message: { type: 'text', text: t('client_timeout', c.language) }, template: { name: 'ns_client_update', params: [lead.ref, c.language === 'hi' ? 'पुष्टि नहीं मिली, जब तैयार हों VISIT लिखें' : 'we did not get your confirmation, reply VISIT when you are ready to book a new time'] } });
  if (arch?.phone) { const ac = ensureContact(arch.phone, { userId: arch.id }); enqueueWhatsApp({ to: arch.phone, kind: 'visit.released', sender: 'system', message: { type: 'text', text: t('visit_cancelled_architect', ac.language, { ref: lead.ref, slot: fmtSlot(o.slot_start, ac.language) }) }, template: { name: 'ns_staff_alert', params: [`visit ${lead.ref} on ${fmtSlot(o.slot_start)} is cancelled, client did not confirm`] } }); }
  updateLead(lead.id, { status: 'needs_followup' }, 'system');
  setFlow(c.id, null);
  createTask({ title: `Client didn't confirm visit · ${lead.ref}`, description: `${lead.name || ''} did not confirm ${fmtSlot(o.slot_start)} with ${arch?.name}. Call to fix a new time.`, kind: 'call_client', priority: 'high', entityType: 'lead', entityId: lead.id, dedupeKey: `client-timeout:${o.id}` });
  return 'timed out';
});

/** Client pressed Confirm / Another time / Cancel. Returns {stale}|{ok, action}. */
export function clientRespond(offerId, revision, action) {
  return tx(() => {
    const o = getOffer(offerId);
    if (!o || o.revision !== Number(revision) || o.status !== 'accepted' || o.revision !== currentRevision(o.lead_id)) return { stale: true };
    const lead = getLead(o.lead_id);
    const c = getContact(lead.contact_id);
    const arch = getUser(o.architect_id);
    if (action === 'confirm') {
      if (o.client_deadline && new Date(o.client_deadline) < now()) return { stale: true };
      cancelTimers('offer', o.id);
      const visit = confirmVisitFromOffer(o);
      setFlow(c.id, null);
      return { ok: true, action, visitId: visit.id };
    }
    closeOffer(o, 'client_declined', action === 'reslot' ? 'Client asked for another time' : 'Client cancelled');
    if (arch?.phone) { const ac = ensureContact(arch.phone, { userId: arch.id }); enqueueWhatsApp({ to: arch.phone, kind: 'visit.released', sender: 'system', message: { type: 'text', text: t('visit_cancelled_architect', ac.language, { ref: lead.ref, slot: fmtSlot(o.slot_start, ac.language) }) }, template: { name: 'ns_staff_alert', params: [`visit ${lead.ref} on ${fmtSlot(o.slot_start)} is cancelled by the client`] } }); }
    if (action === 'reslot') {
      updateLead(lead.id, { preferred_slots: [], status: 'scheduling' }, 'client');
      setFlow(c.id, 'reslot', null, { leadId: lead.id });
      return { ok: true, action, askSlots: true };
    }
    updateLead(lead.id, { status: 'lost' }, 'client');
    run('UPDATE leads SET lost_reason=? WHERE id=?', 'Client cancelled the visit', lead.id);
    setFlow(c.id, null);
    enqueueWhatsApp({ to: c.wa_id, kind: 'visit.cancelled', sender: 'bot', message: { type: 'text', text: t('visit_cancelled_client', c.language) } });
    notify({ audience: 'managers', title: `Client cancelled visit · ${lead.ref}`, body: lead.name || '', link: `#/leads/${lead.id}`, level: 'warn' });
    enqueueEvent('visit.cancelled_by_client', { leadId: lead.id, ref: lead.ref });
    return { ok: true, action };
  });
}

/** Client picked a new slot after "Another time" — straight to a new offer (lead already approved). */
export function reofferAfterReslot(leadId, slotIso) {
  updateLead(leadId, { preferred_slots: slotIso ? [slotIso] : [] }, 'client');
  const lastArch = one("SELECT architect_id FROM visit_offers WHERE lead_id=? ORDER BY id DESC LIMIT 1", leadId);
  const lead = getLead(leadId);
  if (slotIso && lastArch) {
    const arch = getUser(lastArch.architect_id);
    const end = addMin(new Date(slotIso), setting('visit_duration_min'));
    if (arch && !hasConflict(arch.id, new Date(slotIso), end)) {
      const r = createOffer(leadId, { architectId: arch.id, slotStart: slotIso, createdBy: 'client' });
      if (!r.error) return r;
    }
  }
  if (slotIso) {
    const r = createOffer(leadId, { slotStart: slotIso, createdBy: 'client' });
    if (!r.error) return r;
  }
  updateLead(leadId, { status: 'awaiting_approval' }, 'system');
  createApproval('lead_assignment', 'lead', leadId, `Re-schedule visit · ${lead.ref}`, `Client asked for ${slotIso ? fmtSlot(slotIso) : 'a call to fix a time'}.`, { reason: 'reslot' }, addMinIso(nowIso(), 30));
  return { error: 'manual' };
}

export function pendingOffersFor(userId) {
  return all(`SELECT o.*, l.ref, l.name AS client_name, l.zone, l.locality, l.services, l.project_nature, l.area_sqft, l.area_text
    FROM visit_offers o JOIN leads l ON l.id=o.lead_id WHERE o.architect_id=? AND o.status='pending' ORDER BY o.slot_start`, userId);
}
export function offerAgeMin(o) { return minutesBetween(o.created_at, nowIso()); }
