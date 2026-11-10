// Leads: capture, qualification (ONE manager gate), decisions.
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { now, nowIso, addMinIso, jparse, fmtSlot, fromIst, istDate, addDays } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, nextRef, notify, createTask, setting, isBusinessHours, businessHoursText } from '../core/base.js';
import { enqueueEvent } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { getContact, sendText, sendRawText, setFlow, firstName, servicesText, leadPlace, areaText, natureText } from './common.js';
import { eligibleArchitects, availableSlots, createOffer } from './scheduling.js';

export const LEAD_OPEN = ['capturing', 'awaiting_approval', 'out_of_area', 'scheduling', 'visit_confirmed', 'visit_done', 'quoting', 'quote_sent', 'needs_followup'];

export function getLead(id) { return one('SELECT * FROM leads WHERE id = ?', id); }
export function openLeadFor(contactId) {
  return one(`SELECT * FROM leads WHERE contact_id = ? AND status IN (${LEAD_OPEN.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, contactId, ...LEAD_OPEN);
}

export function createLead({ contactId, source = 'whatsapp', fields = {}, ref, actor = 'bot' }) {
  const c = getContact(contactId);
  const at = nowIso();
  const id = insert('leads', {
    ref: ref || nextRef('NS-JPR'), contact_id: contactId, source, status: 'capturing',
    name: fields.name || c?.name || c?.profile_name || null, phone: c?.wa_id || null,
    services: JSON.stringify(fields.services || []), zone: fields.zone || null, locality: fields.locality || null,
    project_nature: fields.project_nature || null, area_sqft: fields.area_sqft || null, area_text: fields.area_text || null,
    execution_window: fields.execution_window || null, requirements: fields.requirements || null,
    address: fields.address || null, site_lat: fields.site_lat ?? null, site_lng: fields.site_lng ?? null, location_source: fields.location_source || null,
    consent: fields.consent ? 1 : 0, ai_summary: fields.ai_summary || null, created_at: at, updated_at: at,
  });
  audit(actor, 'lead.created', 'lead', id, { source });
  onCommit(() => broadcast('leads'));
  return getLead(id);
}

const FIELD_COLS = ['name', 'zone', 'locality', 'address', 'site_lat', 'site_lng', 'location_source', 'project_nature', 'area_sqft', 'area_text', 'execution_window', 'requirements', 'priority', 'owner_id', 'ai_summary'];
export function updateLead(id, patch, actor = 'bot') {
  const cur = getLead(id);
  const set = { updated_at: nowIso() };
  for (const k of FIELD_COLS) if (patch[k] !== undefined) set[k] = patch[k];
  if (patch.services !== undefined) set.services = JSON.stringify([...new Set(patch.services)]);
  if (patch.preferred_slots !== undefined) set.preferred_slots = JSON.stringify(patch.preferred_slots);
  if (patch.status !== undefined) set.status = patch.status;
  update('leads', id, set);
  audit(actor, 'lead.update', 'lead', id, { ...patch, from_status: patch.status ? cur.status : undefined });
  onCommit(() => broadcast('leads'));
  return getLead(id);
}

export function needsVisit(lead) {
  const services = jparse(lead.services, []);
  return services.some((s) => setting('services_requiring_visit').includes(s));
}
export function requiredFields(lead) {
  const services = jparse(lead.services, []);
  if (!services.length) return ['services', 'zone', 'nature', 'area', 'window', 'name'];
  if (!needsVisit(lead)) return ['services', 'zone', 'requirements', 'name'];
  return ['services', 'zone', 'nature', 'area', 'window', 'name', 'location', 'slot'];
}
export function fieldDone(lead, f, ctx = {}) {
  switch (f) {
    case 'services': return jparse(lead.services, []).length > 0;
    case 'zone': return !!lead.zone;
    case 'nature': return !!lead.project_nature;
    case 'area': return !!(lead.area_sqft || lead.area_text);
    case 'window': return !!lead.execution_window;
    case 'name': return !!lead.name;
    case 'requirements': return !!lead.requirements;
    case 'location': return lead.site_lat !== null || !!lead.address || lead.location_source === 'skipped';
    case 'slot': return jparse(lead.preferred_slots, []).length > 0 || !!ctx.slotOther;
    default: return true;
  }
}
export function missingFields(lead, ctx) { return requiredFields(lead).filter((f) => !fieldDone(lead, f, ctx)); }

/** Lead submitted by the client (or website) → qualification. */
export function submitLead(leadId, { actor = 'bot', slotOther = false } = {}) {
  let lead = getLead(leadId);
  const contact = getContact(lead.contact_id);
  const lang = contact?.language || 'en';
  const at = nowIso();
  run('UPDATE leads SET submitted_at=COALESCE(submitted_at, ?), first_response_at=COALESCE(first_response_at, ?), consent=1, updated_at=? WHERE id=?', at, at, at, leadId);
  setFlow(lead.contact_id, null);
  enqueueEvent('lead.submitted', { id: lead.id, ref: lead.ref, zone: lead.zone, services: jparse(lead.services, []), source: lead.source });

  if (lead.zone === 'outside') {
    updateLead(leadId, { status: 'out_of_area' }, actor);
    createApproval('lead_review', 'lead', leadId, `Outside Jaipur enquiry ${lead.ref}`, `${lead.name || ''} · ${servicesText(lead.services)} · ${lead.locality || 'location not given'}`, {});
    sendText(contact, 'out_of_area', { ref: lead.ref }, { kind: 'lead.out_of_area', sender: 'bot' });
    return { outcome: 'out_of_area' };
  }
  if (!needsVisit(lead)) {
    updateLead(leadId, { status: 'needs_followup' }, actor);
    createTask({ title: `Call ${lead.name || 'client'} about ${servicesText(lead.services)} (${lead.ref})`, description: lead.requirements || '', kind: 'follow_up', priority: 'high', entityType: 'lead', entityId: leadId, dueAt: addMinIso(at, 60), dedupeKey: `lead-followup:${leadId}` });
    sendText(contact, 'submitted_no_visit', { name: firstName(contact), ref: lead.ref }, { kind: 'lead.submitted', sender: 'bot' });
    return { outcome: 'follow_up' };
  }

  const slots = jparse(lead.preferred_slots, []);
  const slotPart = slots.length ? (lang === 'hi' ? ` (${fmtSlot(slots[0], 'hi')})` : ` for ${fmtSlot(slots[0], 'en')}`) : '';
  if (setting('auto_approve_leads') && slots.length && lead.zone) {
    updateLead(leadId, { status: 'awaiting_approval' }, actor);
    const r = createOffer(leadId, { slotStart: slots[0], createdBy: 'auto' });
    if (!r.error) {
      run('UPDATE leads SET qualified_at=? WHERE id=?', at, leadId);
      sendText(contact, 'submitted', { name: firstName(contact), ref: lead.ref, slot: slotPart }, { kind: 'lead.submitted', sender: 'bot' });
      return { outcome: 'auto_offer', offerId: r.offerId };
    }
  }
  updateLead(leadId, { status: 'awaiting_approval' }, actor);
  lead = getLead(leadId);
  const suggestion = suggestAssignment(lead);
  createApproval('lead_assignment', 'lead', leadId, `Approve visit · ${lead.ref} · ${lead.name || 'client'}`,
    `${servicesText(lead.services)} · ${natureText(lead)} · ${areaText(lead)} · ${leadPlace(lead)}${slotOther ? ' · client asked for a call to fix the time' : ''}`,
    { suggestion }, dueForSla());
  const open = isBusinessHours();
  if (open) sendText(contact, 'submitted', { name: firstName(contact), ref: lead.ref, slot: slotPart }, { kind: 'lead.submitted', sender: 'bot' });
  else sendText(contact, 'submitted_closed', { name: firstName(contact), ref: lead.ref, ...businessHoursText() }, { kind: 'lead.submitted', sender: 'bot' });
  notify({ audience: 'managers', title: `New enquiry ${lead.ref} needs approval`, body: `${lead.name || ''} · ${servicesText(lead.services)} · ${leadPlace(lead)}`, link: `#/approvals`, level: 'warn' });
  return { outcome: 'awaiting_approval' };
}

/** Due time for the approval SLA, counting only business hours roughly. */
function dueForSla() {
  const sla = setting('approval_sla_min');
  if (isBusinessHours()) return addMinIso(nowIso(), sla);
  const bh = setting('business_hours');
  let day = istDate();
  const openToday = fromIst(day, bh.open);
  if (now() >= openToday) day = addDays(day, 1);
  return addMinIso(fromIst(day, bh.open), sla);
}

export function suggestAssignment(lead) {
  const slots = jparse(lead.preferred_slots, []);
  const dur = setting('visit_duration_min');
  const tryList = slots.length ? slots : availableSlots(lead, 3);
  for (const s of tryList) {
    const start = new Date(s); const end = new Date(start.getTime() + dur * 60000);
    const list = eligibleArchitects(lead, start, end);
    if (list.length) return { slot: start.toISOString(), architectId: list[0].user.id, architect: list[0].user.name, alternatives: list.slice(1, 4).map((x) => ({ id: x.user.id, name: x.user.name })) };
  }
  return null;
}

export function createApproval(kind, entityType, entityId, title, summary, data = {}, dueAt = null) {
  run("UPDATE approvals SET status='cancelled', decided_at=? WHERE kind=? AND entity_type=? AND entity_id=? AND status='pending'", nowIso(), kind, entityType, entityId);
  const id = insert('approvals', { kind, entity_type: entityType, entity_id: entityId, title, summary, data: JSON.stringify(data), status: 'pending', requested_by: 'system', due_at: dueAt, created_at: nowIso() });
  if (dueAt) schedule('approval_sla', { entityType: 'approval', entityId: id, dueAt, dedupeKey: `approval-sla:${id}` });
  onCommit(() => broadcast('approvals'));
  return id;
}

registerTimer('approval_sla', (tm) => {
  const a = one('SELECT * FROM approvals WHERE id = ?', tm.entity_id);
  if (!a || a.status !== 'pending') return 'already decided';
  run('UPDATE approvals SET escalated=1 WHERE id=?', a.id);
  notify({ audience: 'owner', title: `Waiting too long: ${a.title}`, body: `Pending since ${fmtSlot(a.created_at)}. Please decide or delegate.`, link: '#/approvals', level: 'error' });
  return 'escalated';
});

/** Manager decision on a lead (approve & send offer / need info / call / reject). */
export function decideLead(approvalId, { decision, architectId, slotStart, note, notifyClient = true }, actor) {
  const a = one('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'This approval was already handled.' };
  const lead = getLead(a.entity_id);
  const contact = getContact(lead.contact_id);
  const at = nowIso();
  const close = (status) => run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', status, decision, actor?.id || null, note || null, at, a.id);
  if (decision === 'approve') {
    const r = createOffer(lead.id, { architectId: architectId || null, slotStart: slotStart || jparse(lead.preferred_slots, [])[0] || null, createdBy: `user:${actor?.id}` });
    if (r.error) return r;
    close('approved');
    run('UPDATE leads SET qualified_at=COALESCE(qualified_at, ?) WHERE id=?', at, lead.id);
    cancelTimers('approval', a.id);
    audit(`user:${actor?.id}`, 'lead.approved', 'lead', lead.id, { offerId: r.offerId });
    return r;
  }
  if (decision === 'need_info') {
    if (!note) return { error: 'Please type the question for the client.' };
    sendRawText(contact, note, { kind: 'lead.need_info', sender: `user:${actor?.id}`, essential: true });
    setFlow(contact.id, 'lead_info', null, { leadId: lead.id });
    run('UPDATE approvals SET decision_note=? WHERE id=?', `Asked client: ${note}`, a.id);
    audit(`user:${actor?.id}`, 'lead.need_info', 'lead', lead.id, { note });
    return { ok: true };
  }
  if (decision === 'call') {
    close('done');
    updateLead(lead.id, { status: 'needs_followup' }, `user:${actor?.id}`);
    createTask({ title: `Call ${lead.name || 'client'} (${lead.ref})`, description: note || 'Manager asked for a call before booking a visit.', kind: 'call_client', priority: 'high', entityType: 'lead', entityId: lead.id, assigneeId: actor?.id, dueAt: addMinIso(at, 60) });
    return { ok: true };
  }
  if (decision === 'reject') {
    close('rejected');
    run('UPDATE leads SET status=?, lost_reason=?, updated_at=? WHERE id=?', 'lost', note || 'Not a fit', at, lead.id);
    if (notifyClient) sendRawText(contact, contact.language === 'hi'
      ? `🙏 आपकी पूछताछ ${lead.ref} के लिए धन्यवाद। इस बार हम यह काम नहीं ले पाएँगे${note ? ` (${note})` : ''}। भविष्य में ज़रूर संपर्क करें।`
      : `🙏 Thank you for your enquiry ${lead.ref}. We won't be able to take this up right now${note ? ` (${note})` : ''}. Please do reach out again in future.`, { kind: 'lead.rejected', sender: `user:${actor?.id}` });
    audit(`user:${actor?.id}`, 'lead.rejected', 'lead', lead.id, { note });
    onCommit(() => broadcast('leads'));
    return { ok: true };
  }
  if (decision === 'accept_outside') {
    close('approved');
    updateLead(lead.id, { zone: 'other_jaipur', status: 'capturing' }, `user:${actor?.id}`);
    return submitLead(lead.id, { actor: `user:${actor?.id}` });
  }
  return { error: 'Unknown decision' };
}

export function markLost(leadId, reason, actor) {
  run("UPDATE leads SET status='lost', lost_reason=?, updated_at=? WHERE id=?", reason, nowIso(), leadId);
  run("UPDATE approvals SET status='cancelled', decided_at=? WHERE entity_type='lead' AND entity_id=? AND status='pending'", nowIso(), leadId);
  audit(actor, 'lead.lost', 'lead', leadId, { reason });
  onCommit(() => broadcast('leads'));
}

export function leadSummaryForStaff(lead) {
  return `${lead.ref} · ${lead.name || ''} · ${servicesText(lead.services)} · ${natureText(lead)} · ${areaText(lead)} · ${leadPlace(lead)}`;
}
