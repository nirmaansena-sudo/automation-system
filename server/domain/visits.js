// Site visits: confirmation (architect gets client details + location pin),
// reminders, check-in, no-shows, reports and report review.
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { now, nowIso, addMinIso, jparse, fmtSlot, haversineM, mapsLink, prettyPhone } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, nextRef, notify, createTask, getSettings, setting } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent, registerGuard } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { t } from '../bot/i18n.js';
import { getContact, getUser, ensureContact, setFlow, servicesText, leadPlace, areaText, natureText, visitLink, fullAddress } from './common.js';
import { getLead, updateLead, createApproval, markLost } from './leads.js';
import { releaseHold, availableSlots } from './scheduling.js';

export function getVisit(id) { return one('SELECT * FROM visits WHERE id = ?', id); }

registerGuard('visit', (g) => {
  const v = getVisit(g.id);
  return !!v && v.revision === g.rev && (!g.status || g.status.includes(v.status));
});

export function confirmVisitFromOffer(o) {
  const s = getSettings();
  const lead = getLead(o.lead_id);
  const c = getContact(lead.contact_id);
  const arch = getUser(o.architect_id);
  const at = nowIso();
  const ref = nextRef('NS-VIS');
  const id = insert('visits', { ref, lead_id: lead.id, architect_id: arch.id, offer_id: o.id, hold_id: o.hold_id, revision: 1, start_at: o.slot_start, end_at: o.slot_end, status: 'confirmed', created_at: at, updated_at: at });
  run("UPDATE calendar_holds SET kind='visit', ref_type='visit', ref_id=?, expires_at=NULL WHERE id=?", id, o.hold_id);
  update('visit_offers', o.id, { status: 'client_confirmed', updated_at: at });
  updateLead(lead.id, { status: 'visit_confirmed' }, 'client');
  const lang = c.language || 'en';
  const archName = (lang === 'hi' ? 'आर्किटेक्ट ' : 'Ar. ') + arch.name;
  const guard = { type: 'visit', id, rev: 1, status: ['confirmed'] };

  // Client confirmation
  enqueueWhatsApp({
    to: c.wa_id, kind: 'visit.confirmed', sender: 'system', essential: true, guard,
    message: { type: 'text', text: t('visit_confirmed_client', lang, { ref, architect: archName, slot: fmtSlot(o.slot_start, lang), place: leadPlace(lead, lang) }) },
    template: { name: 'ns_visit_confirmed', params: [ref, fmtSlot(o.slot_start, lang), archName] },
  });

  // Architect: full client details + location pin (your core requirement)
  const ac = ensureContact(arch.phone, { userId: arch.id });
  const al = ac.language || 'en';
  const maps = mapsLink(lead.site_lat, lead.site_lng, lead.address || leadPlace(lead));
  const address = fullAddress(lead, al);
  const clientName = lead.name || c.name || c.profile_name || 'Client';
  enqueueWhatsApp({
    to: arch.phone, kind: 'visit.details_architect', sender: 'system', essential: true, guard,
    message: { type: 'text', text: t('visit_details_architect', al, { ref, slot: fmtSlot(o.slot_start, al), client: clientName, phone: prettyPhone(c.wa_id), address, services: servicesText(lead.services, al), nature: natureText(lead, al), area: areaText(lead, al), notes: lead.requirements || '—', maps, link: visitLink(id) }) },
    template: { name: 'ns_visit_details', params: [ref, fmtSlot(o.slot_start, al), clientName, prettyPhone(c.wa_id), address, maps] },
  });
  if (lead.site_lat !== null && lead.site_lat !== undefined) {
    enqueueWhatsApp({
      to: arch.phone, kind: 'visit.location_pin', sender: 'system', guard,
      message: { type: 'location', lat: lead.site_lat, lng: lead.site_lng, name: `Site: ${clientName} (${ref})`, address: address.slice(0, 250) },
      optional: true,
    });
  }

  // Reminders and checks (each checks the visit is still at revision 1 / confirmed)
  const start = new Date(o.slot_start).getTime();
  const nowMs = now().getTime();
  if (start - 24 * 3600e3 > nowMs + 30 * 60e3) schedule('visit_reminder', { entityType: 'visit', entityId: id, revision: 1, dueAt: new Date(start - 24 * 3600e3).toISOString(), data: { who: 'client' }, dedupeKey: `vr24:${id}:1` });
  if (start - 2 * 3600e3 > nowMs + 10 * 60e3) {
    schedule('visit_reminder', { entityType: 'visit', entityId: id, revision: 1, dueAt: new Date(start - 2 * 3600e3).toISOString(), data: { who: 'client' }, dedupeKey: `vr2c:${id}:1` });
    schedule('visit_reminder', { entityType: 'visit', entityId: id, revision: 1, dueAt: new Date(start - 2 * 3600e3).toISOString(), data: { who: 'architect' }, dedupeKey: `vr2a:${id}:1` });
  }
  schedule('visit_noshow_check', { entityType: 'visit', entityId: id, revision: 1, dueAt: addMinIso(o.slot_start, 30), dedupeKey: `vns:${id}:1` });
  schedule('visit_report_due', { entityType: 'visit', entityId: id, revision: 1, dueAt: addMinIso(o.slot_end, s.report_due_h * 60), data: { level: 1 }, dedupeKey: `vrd:${id}:1` });
  notify({ userId: arch.id, title: `Visit confirmed ${ref}`, body: `${fmtSlot(o.slot_start)} · ${leadPlace(lead)}`, link: `#/visit/${id}`, level: 'info' });
  notify({ audience: 'managers', title: `Visit confirmed ${ref}`, body: `${lead.ref} · ${arch.name} · ${fmtSlot(o.slot_start)}`, link: '#/visits' });
  audit('client', 'visit.confirmed', 'visit', id, { lead: lead.id, offer: o.id });
  enqueueEvent('visit.confirmed', { visitId: id, ref, leadRef: lead.ref, architect: arch.name, start: o.slot_start, zone: lead.zone });
  onCommit(() => broadcast('visits'));
  return getVisit(id);
}

registerTimer('visit_reminder', (tm) => {
  const v = getVisit(tm.entity_id);
  if (!v || v.status !== 'confirmed' || v.revision !== tm.revision) return 'stale';
  const lead = getLead(v.lead_id); const arch = getUser(v.architect_id); const c = getContact(lead.contact_id);
  const guard = { type: 'visit', id: v.id, rev: v.revision, status: ['confirmed'] };
  if (tm.data.who === 'client') {
    const lang = c.language || 'en'; const archName = (lang === 'hi' ? 'आर्किटेक्ट ' : 'Ar. ') + arch.name;
    enqueueWhatsApp({ to: c.wa_id, kind: 'visit.reminder_client', guard, message: { type: 'text', text: t('reminder_client', lang, { architect: archName, slot: fmtSlot(v.start_at, lang) }) }, template: { name: 'ns_visit_reminder', params: [v.ref, fmtSlot(v.start_at, lang), leadPlace(lead, lang)] } });
  } else if (arch?.phone) {
    const ac = ensureContact(arch.phone, { userId: arch.id });
    const maps = mapsLink(lead.site_lat, lead.site_lng, lead.address);
    enqueueWhatsApp({ to: arch.phone, kind: 'visit.reminder_architect', guard, message: { type: 'text', text: t('reminder_architect', ac.language, { ref: v.ref, slot: fmtSlot(v.start_at, ac.language), place: leadPlace(lead, ac.language), maps }) }, template: { name: 'ns_visit_reminder', params: [v.ref, fmtSlot(v.start_at, ac.language), leadPlace(lead, ac.language)] } });
  }
  return 'sent';
});

registerTimer('visit_noshow_check', (tm) => {
  const v = getVisit(tm.entity_id);
  if (!v || v.status !== 'confirmed' || v.revision !== tm.revision) return 'stale';
  const lead = getLead(v.lead_id); const arch = getUser(v.architect_id); const c = getContact(lead.contact_id);
  notify({ audience: 'managers', title: `Visit ${v.ref} not started`, body: `${arch?.name} has not checked in at ${leadPlace(lead)} (${fmtSlot(v.start_at)}). Call the architect.`, link: `#/visits`, level: 'error' });
  createTask({ title: `Visit not started: ${v.ref}`, description: `${arch?.name} has not checked in 30 minutes after ${fmtSlot(v.start_at)}. Call ${arch?.name} (${prettyPhone(arch?.phone)}) and the client (${prettyPhone(c.wa_id)}).`, kind: 'system_alert', priority: 'high', entityType: 'visit', entityId: v.id, dedupeKey: `noshow:${v.id}:${v.revision}` });
  enqueueWhatsApp({ to: c.wa_id, kind: 'visit.architect_late', guard: { type: 'visit', id: v.id, rev: v.revision, status: ['confirmed'] }, message: { type: 'text', text: t('architect_late', c.language) }, template: { name: 'ns_client_update', params: [v.ref, c.language === 'hi' ? 'हमारे आर्किटेक्ट को थोड़ी देर हो रही है, टीम जल्द अपडेट देगी' : 'our architect is running a little late, our team will update you shortly'] } });
  return 'alerted';
});

registerTimer('visit_report_due', (tm) => {
  const v = getVisit(tm.entity_id);
  if (!v || !['confirmed', 'in_progress'].includes(v.status) || v.revision !== tm.revision) return 'stale';
  const arch = getUser(v.architect_id);
  if (tm.data.level === 1) {
    notify({ userId: arch.id, title: `Visit report pending: ${v.ref}`, body: 'Please submit the site report from the app.', link: `#/visit/${v.id}`, level: 'warn' });
    if (arch.phone) enqueueWhatsApp({ to: arch.phone, kind: 'visit.report_reminder', message: { type: 'text', text: `⏰ Please submit the site report for ${v.ref} in the app: ${visitLink(v.id)}` }, template: { name: 'ns_staff_alert', params: [`site report pending for ${v.ref}`] } });
    schedule('visit_report_due', { entityType: 'visit', entityId: v.id, revision: v.revision, dueAt: addMinIso(nowIso(), 18 * 60), data: { level: 2 }, dedupeKey: `vrd2:${v.id}:${v.revision}` });
    return 'architect reminded';
  }
  createTask({ title: `Site report overdue: ${v.ref}`, description: `${arch?.name} has not submitted the report.`, kind: 'system_alert', priority: 'high', entityType: 'visit', entityId: v.id, dedupeKey: `report-overdue:${v.id}` });
  return 'escalated';
});

/** Cancel (or prepare reschedule of) a confirmed visit. */
export function cancelVisit(visitId, { reason = 'Cancelled', actor = 'system', notifyClient = true, notifyArchitect = true, reslot = false } = {}) {
  const v = getVisit(visitId);
  if (!v || !['confirmed', 'in_progress'].includes(v.status)) return { error: 'Visit is not active' };
  const lead = getLead(v.lead_id); const c = getContact(lead.contact_id); const arch = getUser(v.architect_id);
  update('visits', v.id, { status: 'cancelled', cancel_reason: reason, revision: v.revision + 1, updated_at: nowIso() });
  releaseHold(v.hold_id);
  cancelTimers('visit', v.id);
  if (notifyArchitect && arch?.phone) {
    const ac = ensureContact(arch.phone, { userId: arch.id });
    enqueueWhatsApp({ to: arch.phone, kind: 'visit.cancelled_architect', essential: true, message: { type: 'text', text: t('visit_cancelled_architect', ac.language, { ref: v.ref, slot: fmtSlot(v.start_at, ac.language) }) }, template: { name: 'ns_staff_alert', params: [`visit ${v.ref} on ${fmtSlot(v.start_at)} is cancelled`] } });
  }
  if (reslot) {
    updateLead(lead.id, { status: 'scheduling', preferred_slots: [] }, actor);
    setFlow(c.id, 'reslot', null, { leadId: lead.id });
    if (notifyClient) sendSlotList(c, lead, 'pick_new_time');
  } else {
    if (notifyClient) enqueueWhatsApp({ to: c.wa_id, kind: 'visit.cancelled', essential: true, message: { type: 'text', text: t('visit_cancelled_client', c.language) }, template: { name: 'ns_client_update', params: [v.ref, reason] } });
    updateLead(lead.id, { status: 'needs_followup' }, actor);
  }
  audit(actor, reslot ? 'visit.rescheduling' : 'visit.cancelled', 'visit', v.id, { reason });
  onCommit(() => broadcast('visits'));
  return { ok: true };
}

/** Slot picker for clients (also used after "Another time"). */
export function sendSlotList(c, lead, key = 'ask_slot') {
  const lang = c.language || 'en';
  const slots = availableSlots(lead, 9);
  const rows = slots.map((s) => ({ id: `F:slot:${s.replace(/[-:]/g, '').slice(0, 13)}`, title: fmtSlot(s, lang).slice(0, 24) }));
  rows.push({ id: 'F:slot:other', title: t('slot_other', lang) });
  return enqueueWhatsApp({ to: c.wa_id, kind: 'lead.ask_slot', sender: 'bot', message: { type: 'list', text: t(key, lang), button: t('slot_button', lang), sections: [{ title: t('slot_section', lang), rows }] } });
}

export function visitCheckin(visitId, userId, { lat, lng, accuracy } = {}) {
  const v = getVisit(visitId);
  if (!v || v.architect_id !== userId) return { error: 'Not your visit' };
  if (v.status !== 'confirmed') return { error: `Visit is ${v.status}` };
  const lead = getLead(v.lead_id);
  const dist = haversineM(lat, lng, lead.site_lat, lead.site_lng);
  update('visits', v.id, { status: 'in_progress', checkin_at: nowIso(), checkin_lat: lat ?? null, checkin_lng: lng ?? null, checkin_distance_m: dist, updated_at: nowIso() });
  cancelTimers('visit', v.id, ['visit_noshow_check', 'visit_reminder']);
  audit(`user:${userId}`, 'visit.checkin', 'visit', v.id, { lat, lng, accuracy, dist });
  onCommit(() => broadcast('visits'));
  return { ok: true, distance_m: dist };
}

export function markClientNoShow(visitId, userId) {
  const v = getVisit(visitId);
  if (!v || v.architect_id !== userId || !['confirmed', 'in_progress'].includes(v.status)) return { error: 'Visit not active' };
  const lead = getLead(v.lead_id); const c = getContact(lead.contact_id);
  update('visits', v.id, { status: 'no_show_client', revision: v.revision + 1, updated_at: nowIso() });
  releaseHold(v.hold_id);
  cancelTimers('visit', v.id);
  updateLead(lead.id, { status: 'needs_followup' }, `user:${userId}`);
  enqueueWhatsApp({ to: c.wa_id, kind: 'visit.client_noshow', essential: true, message: { type: 'buttons', text: t('client_noshow', c.language), buttons: [{ id: `VN:R:${v.id}`, title: t('btn_new_time', c.language) }, { id: `VN:C:${v.id}`, title: t('btn_call_me', c.language) }] }, template: { name: 'ns_client_update', params: [v.ref, c.language === 'hi' ? 'आर्किटेक्ट साइट पर पहुँचे पर आपसे मिल नहीं पाए, कृपया नया समय बताएँ' : 'our architect reached your site but could not meet you, please share a new time'] } });
  createTask({ title: `Client not available: ${v.ref}`, description: `${lead.name || ''} was not at the site. Call to reschedule.`, kind: 'call_client', entityType: 'lead', entityId: lead.id, dedupeKey: `client-noshow:${v.id}` });
  audit(`user:${userId}`, 'visit.client_noshow', 'visit', v.id);
  onCommit(() => broadcast('visits'));
  return { ok: true };
}

export function submitVisitReport(visitId, userId, report) {
  const v = getVisit(visitId);
  if (!v || (userId && v.architect_id !== userId)) return { error: 'Not your visit' };
  if (!['confirmed', 'in_progress', 'report_submitted'].includes(v.status)) return { error: `Visit is ${v.status}` };
  const lead = getLead(v.lead_id);
  const at = nowIso();
  update('visits', v.id, { status: 'report_submitted', report: JSON.stringify(report), report_at: at, checkout_at: v.checkout_at || at, review_status: 'pending', updated_at: at });
  cancelTimers('visit', v.id);
  updateLead(lead.id, { status: 'visit_done' }, `user:${userId}`);
  createApproval('visit_report', 'visit', v.id, `Review site report · ${v.ref} · ${lead.ref}`,
    `${lead.name || ''} · ${report.recommendation || ''} · Budget: ${report.budget_range || '—'} · Interest: ${report.interest || '—'}`, { leadId: lead.id }, addMinIso(at, 24 * 60));
  notify({ audience: 'managers', title: `Site report submitted ${v.ref}`, body: lead.ref, link: '#/approvals' });
  audit(`user:${userId}`, 'visit.report', 'visit', v.id, report);
  enqueueEvent('visit.report_submitted', { visitId: v.id, ref: v.ref, leadRef: lead.ref });
  onCommit(() => broadcast('visits'));
  return { ok: true };
}

/** Manager: approve → quotation · revisit → new offer · close → lost. */
export function decideVisitReport(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const v = getVisit(a.entity_id); const lead = getLead(v.lead_id);
  const at = nowIso();
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'close' ? 'rejected' : 'approved', decision, actor?.id || null, note || null, at, a.id);
  if (decision === 'approve') {
    update('visits', v.id, { status: 'completed', review_status: 'approved', review_note: note || null, updated_at: at });
    updateLead(lead.id, { status: 'quoting' }, `user:${actor?.id}`);
    createTask({ title: `Prepare quotation for ${lead.ref}`, description: `Site report approved. ${note || ''}`, kind: 'general', priority: 'high', entityType: 'lead', entityId: lead.id, assigneeId: v.architect_id, dueAt: addMinIso(at, 48 * 60), dedupeKey: `quote-task:${lead.id}:${v.id}` });
  } else if (decision === 'revisit') {
    update('visits', v.id, { status: 'completed', review_status: 'revisit', review_note: note || null, updated_at: at });
    updateLead(lead.id, { status: 'awaiting_approval', preferred_slots: [] }, `user:${actor?.id}`);
    createApproval('lead_assignment', 'lead', lead.id, `Revisit needed · ${lead.ref}`, note || 'Manager asked for another visit.', { reason: 'revisit' });
  } else {
    update('visits', v.id, { status: 'completed', review_status: 'closed', review_note: note || null, updated_at: at });
    markLost(lead.id, note || 'Closed after site visit', `user:${actor?.id}`);
  }
  audit(`user:${actor?.id}`, `visit.report_${decision}`, 'visit', v.id, { note });
  onCommit(() => broadcast('visits'));
  return { ok: true };
}

export function upcomingVisitFor(contactId) {
  return one(`SELECT v.* FROM visits v JOIN leads l ON l.id=v.lead_id WHERE l.contact_id=? AND v.status='confirmed' AND v.start_at > ? ORDER BY v.start_at LIMIT 1`, contactId, nowIso());
}
export function visitsForArchitect(userId, fromIso, toIso) {
  return all(`SELECT v.*, l.ref AS lead_ref, l.name AS client_name, l.zone, l.locality, l.address, l.site_lat, l.site_lng, l.services, l.project_nature, l.area_sqft, l.area_text, l.requirements, l.phone AS client_phone
    FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? AND v.start_at >= ? AND v.start_at < ? ORDER BY v.start_at`, userId, fromIso, toIso);
}
