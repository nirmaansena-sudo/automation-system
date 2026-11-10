// Projects: creation from an accepted quotation, milestone loop (work →
// quality review → client sign-off → invoice → payment → next), site logs,
// change requests (versioned baseline), handover and warranty.
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { nowIso, addMinIso, jparse, randomToken, inr, istDate, addDays, fmtDateLong, haversineM, truncate } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, nextRef, notify, createTask, setting } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent, registerGuard } from '../core/outbox.js';
import { schedule, cancelTimers, registerTimer } from '../core/timers.js';
import { t } from '../bot/i18n.js';
import { getContact, getUser, setFlow, projectLink, leadPlace, fullAddress } from './common.js';
import { getLead, updateLead, createApproval } from './leads.js';
import { paise, rupees, allocateAmounts } from '../lib/money.js';
import { applyScopeCredit, financeSummary } from './finance.js';

export function getProject(id) { return one('SELECT * FROM projects WHERE id = ?', id); }
export function getMilestone(id) { return one('SELECT * FROM milestones WHERE id = ?', id); }
const firstManager = () => one("SELECT id FROM users WHERE active=1 AND role IN ('manager','owner') ORDER BY role='owner', id LIMIT 1");
const payText = (lang, inv) => (inv?.payment_link ? (lang === 'hi' ? `भुगतान लिंक: ${inv.payment_link}` : `Pay here: ${inv.payment_link}`) : setting('payment_instructions'));

registerGuard('milestone', (g) => { const m = getMilestone(g.id); return !!m && (!g.status || g.status.includes(m.status)); });
registerGuard('change_request', (g) => { const cr = one('SELECT status FROM change_requests WHERE id=?', g.id); return !!cr && (!g.status || g.status.includes(cr.status)); });

export function createProjectFromQuote(q, actor = 'client') {
  const lead = getLead(q.lead_id);
  const c = getContact(lead.contact_id);
  const at = nowIso();
  const visit = one("SELECT architect_id FROM visits WHERE lead_id=? AND status IN ('completed','report_submitted') ORDER BY id DESC LIMIT 1", lead.id);
  const ref = nextRef('NS-PRJ', 3);
  const id = insert('projects', {
    ref, name: `${lead.name || 'Client'} — ${leadPlace(lead)}`, lead_id: lead.id, client_contact_id: c.id, client_name: lead.name || c.name || c.profile_name, client_phone: c.wa_id,
    zone: lead.zone, address: fullAddress(lead), site_lat: lead.site_lat, site_lng: lead.site_lng,
    service_type: q.service_type, commercial_model: q.commercial_model, area_sqft: lead.area_sqft, contract_value: q.total, quotation_id: q.id,
    status: 'awaiting_advance', manager_id: lead.owner_id || firstManager()?.id || null, architect_id: visit?.architect_id || null,
    start_date: null, public_token: randomToken(18), authorized_phones: JSON.stringify([c.wa_id]), created_at: at, updated_at: at,
  });
  run('UPDATE quotations SET project_id=? WHERE id=?', id, q.id);
  run("UPDATE leads SET status='won', project_id=?, updated_at=? WHERE id=?", id, at, lead.id);
  const schedule = jparse(q.payment_schedule, []);
  const amounts = allocateAmounts(q.total, schedule);
  schedule.forEach((m, i) => {
    insert('milestones', { project_id: id, seq: i + 1, name: m.name, baseline_version: 1, pay_pct: m.pct, amount: amounts[i], needs_site_work: m.site === false ? 0 : 1, status: 'planned', created_at: at, updated_at: at });
  });
  const first = one('SELECT * FROM milestones WHERE project_id=? ORDER BY seq LIMIT 1', id);
  const project = getProject(id);
  let inv = null;
  if (first && first.amount > 0 && !first.needs_site_work) {
    inv = issueInvoice(project, first, { notify: false });
    update('milestones', first.id, { status: 'invoiced', updated_at: at });
  }
  const lang = c.language || 'en';
  const link = projectLink(project);
  enqueueWhatsApp({
    to: c.wa_id, kind: 'project.welcome', essential: true,
    message: { type: 'text', text: t('quote_accepted', lang, { project: ref, amount: inr(inv?.amount || 0), pay: payText(lang, inv), link }) },
    template: { name: 'ns_project_welcome', params: [ref, inr(inv?.amount || 0), link] },
  });
  notify({ audience: 'managers', title: `🎉 New project ${ref}`, body: `${project.client_name} · ${inr(q.total)}`, link: `#/projects/${id}`, level: 'info' });
  createTask({ title: `Assign supervisor & plan dates for ${ref}`, description: 'Set the site supervisor, engineer and milestone dates in the project profile.', priority: 'high', entityType: 'project', entityId: id, assigneeId: project.manager_id, dedupeKey: `project-setup:${id}` });
  audit(actor, 'project.created', 'project', id, { quote: q.id, total: q.total });
  enqueueEvent('project.created', { id, ref, client: project.client_name, value: q.total });
  onCommit(() => { broadcast('projects'); broadcast('leads'); });
  return project;
}

export function issueInvoice(project, milestone, { notify: notifyClient = true, title } = {}) {
  const at = nowIso();
  const id = insert('invoices', { ref: nextRef('NS-INV'), project_id: project.id, milestone_id: milestone?.id || null, title: title || milestone?.name || 'Invoice', amount: milestone ? milestone.amount : 0, due_date: addDays(istDate(), setting('payment_terms_days')), status: 'issued', issued_at: at, created_at: at });
  const inv = one('SELECT * FROM invoices WHERE id=?', id);
  if (notifyClient) {
    const c = getContact(project.client_contact_id); const lang = c?.language || 'en';
    if (c) enqueueWhatsApp({ to: c.wa_id, kind: 'invoice.issued', essential: true, message: { type: 'text', text: t('invoice_issued', lang, { ref: inv.ref, amount: inr(inv.amount), title: inv.title, due: fmtDateLong(inv.due_date), pay: payText(lang, inv) }) }, template: { name: 'ns_invoice', params: [inv.ref, project.ref, inr(inv.amount), inv.title, fmtDateLong(inv.due_date), payText(lang, inv)] } });
  }
  enqueueEvent('invoice.issued', { id, ref: inv.ref, project: project.ref, amount: inv.amount, due: inv.due_date });
  return inv;
}

export function recordPayment(invoiceId, { amount, method = 'bank', reference = '', receivedAt, client_event_id }, actor) {
  const inv = one('SELECT * FROM invoices WHERE id=?', invoiceId);
  if (!inv || inv.status === 'cancelled') return { error: 'Invoice not found' };
  let cents;
  try { cents = paise(amount, { min: 0.01 }); } catch (e) { return { error: e.message }; }
  const amt = rupees(cents);
  if (!['bank', 'upi', 'cash', 'cheque', 'card'].includes(method)) return { error: 'Invalid payment method' };
  const key = String(client_event_id || '').trim() || null;
  const normalized = String(reference || '').trim().toUpperCase() || null;
  if ((key && key.length > 128) || (normalized && normalized.length > 150)) return { error: 'Payment reference or request key is too long' };
  if (!key && !normalized) return { error: 'Provide a transaction reference or a unique request key' };
  const previous = one('SELECT * FROM payments WHERE (client_event_id=? AND ? IS NOT NULL) OR (invoice_id=? AND method=? AND (normalized_reference=? OR UPPER(TRIM(reference))=?) AND ? IS NOT NULL) LIMIT 1', key, key, inv.id, method, normalized, normalized, normalized);
  if (previous) return previous.invoice_id === inv.id && paise(previous.amount) === cents && previous.method === method && (String(previous.reference || '').trim().toUpperCase() || null) === normalized
    ? { ok: true, duplicate: true, id: previous.id, fullyPaid: inv.status === 'paid' }
    : { error: 'This payment key or reference has already been used with different details' };
  if (cents > Math.round((inv.amount - inv.paid_amount) * 100)) return { error: 'Payment exceeds the outstanding invoice amount' };
  if (receivedAt && !Number.isFinite(Date.parse(receivedAt))) return { error: 'Invalid payment date' };
  const at = nowIso();
  insert('payments', { invoice_id: inv.id, project_id: inv.project_id, amount: amt, method, reference: String(reference).trim(), normalized_reference: normalized, client_event_id: key, received_at: receivedAt || at, recorded_by: actor?.id || null, created_at: at });
  const paid = rupees(Math.round(inv.paid_amount * 100) + cents);
  const full = Math.round(paid * 100) >= Math.round(inv.amount * 100);
  update('invoices', inv.id, { paid_amount: paid, status: full ? 'paid' : 'partially_paid', paid_at: full ? at : null });
  const project = getProject(inv.project_id);
  const c = getContact(project.client_contact_id); const lang = c?.language || 'en';
  if (c) enqueueWhatsApp({ to: c.wa_id, kind: 'payment.received', essential: true, message: { type: 'text', text: t('payment_received', lang, { amount: inr(amt), project: project.ref }) }, template: { name: 'ns_client_update', params: [project.ref, `payment of ${inr(amt)} received, thank you`] } });
  if (full && inv.milestone_id) {
    const ms = getMilestone(inv.milestone_id);
    update('milestones', ms.id, { status: 'paid', updated_at: at });
    if (project.status === 'awaiting_advance') activateProject(project, actor);
  }
  audit(`user:${actor?.id}`, 'payment.recorded', 'invoice', inv.id, { amount: amt, method, reference });
  enqueueEvent('payment.recorded', { invoice: inv.ref, project: project.ref, amount: amt });
  onCommit(() => broadcast('projects'));
  return { ok: true, fullyPaid: full };
}

function activateProject(project, actor) {
  const at = nowIso();
  update('projects', project.id, { status: 'active', start_date: project.start_date || istDate(), updated_at: at });
  const sup = getUser(project.supervisor_id);
  const c = getContact(project.client_contact_id);
  if (c) enqueueWhatsApp({ to: c.wa_id, kind: 'project.active', message: { type: 'text', text: t('project_active', c.language, { project: project.ref, supervisor: sup ? sup.name : (c.language === 'hi' ? 'जल्द तय होंगे' : 'being assigned') }) }, template: { name: 'ns_client_update', params: [project.ref, 'your project is now active, daily site updates will follow'] } });
  startNextMilestone(project.id);
  audit(`user:${actor?.id}`, 'project.active', 'project', project.id);
}

export function startNextMilestone(projectId) {
  const next = one("SELECT * FROM milestones WHERE project_id=? AND status='planned' ORDER BY seq LIMIT 1", projectId);
  if (!next) return null;
  update('milestones', next.id, { status: 'in_progress', planned_start: next.planned_start || istDate(), updated_at: nowIso() });
  const p = getProject(projectId);
  const owner = next.needs_site_work ? (p.supervisor_id || p.engineer_id || p.manager_id) : (p.architect_id || p.manager_id);
  createTask({ title: `${p.ref}: start "${next.name}"`, description: 'Post daily site logs. Mark "Ready for review" with photos when complete.', assigneeId: owner, entityType: 'milestone', entityId: next.id, dedupeKey: `ms-start:${next.id}` });
  onCommit(() => broadcast('projects'));
  return next;
}

/** Supervisor/engineer: stage complete → quality review. */
export function submitMilestone(msId, userId, note) {
  const ms = getMilestone(msId);
  if (!ms || !['in_progress', 'rework'].includes(ms.status)) return { error: 'This stage is not in progress' };
  const p = getProject(ms.project_id);
  update('milestones', ms.id, { status: 'ready_for_review', progress: 100, review_note: note || null, updated_at: nowIso() });
  createApproval('milestone', 'milestone', ms.id, `Quality review · ${p.ref} · ${ms.name}`, note || 'Stage marked complete by site team. Check photos in the site log.', { projectId: p.id }, addMinIso(nowIso(), 24 * 60));
  audit(`user:${userId}`, 'milestone.submitted', 'milestone', ms.id, { note });
  onCommit(() => broadcast('projects'));
  return { ok: true };
}

/** Manager/engineer quality decision: pass → client sign-off; rework → back to site. */
export function decideMilestone(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const ms = getMilestone(a.entity_id); const p = getProject(ms.project_id);
  const at = nowIso();
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'pass' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, at, a.id);
  if (decision !== 'pass') {
    update('milestones', ms.id, { status: 'rework', review_note: note || 'Rework needed', reviewed_by: actor?.id || null, updated_at: at });
    createTask({ title: `Rework: ${p.ref} · ${ms.name}`, description: note || 'Quality review asked for rework.', assigneeId: p.supervisor_id || p.engineer_id || p.manager_id, priority: 'high', entityType: 'milestone', entityId: ms.id });
    audit(`user:${actor?.id}`, 'milestone.rework', 'milestone', ms.id, { note });
    onCommit(() => broadcast('projects'));
    return { ok: true };
  }
  update('milestones', ms.id, { status: 'client_review', reviewed_by: actor?.id || null, review_note: note || null, updated_at: at });
  const c = getContact(p.client_contact_id); const lang = c?.language || 'en';
  const link = projectLink(p);
  if (c) enqueueWhatsApp({
    to: c.wa_id, kind: 'milestone.client_review', essential: true, guard: { type: 'milestone', id: ms.id, status: ['client_review'] },
    message: { type: 'buttons', text: t('milestone_review', lang, { milestone: ms.name, project: p.ref, link }), buttons: [{ id: `MS:A:${ms.id}`, title: t('btn_ms_ok', lang) }, { id: `MS:X:${ms.id}`, title: t('btn_ms_issue', lang) }] },
    template: { name: 'ns_milestone_review', params: [ms.name, p.ref, link], buttons: [{ type: 'quick_reply', payload: `MS:A:${ms.id}` }, { type: 'quick_reply', payload: `MS:X:${ms.id}` }] },
  });
  schedule('milestone_client_deadline', { entityType: 'milestone', entityId: ms.id, dueAt: addMinIso(at, 72 * 60), dedupeKey: `msd:${ms.id}` });
  audit(`user:${actor?.id}`, 'milestone.passed', 'milestone', ms.id, { note });
  onCommit(() => broadcast('projects'));
  return { ok: true };
}

registerTimer('milestone_client_deadline', (tm) => {
  const ms = getMilestone(tm.entity_id);
  if (!ms || ms.status !== 'client_review') return 'stale';
  const p = getProject(ms.project_id);
  createTask({ title: `Client hasn't signed off ${p.ref} · ${ms.name}`, description: 'Call the client to walk through the photos and get sign-off.', kind: 'call_client', priority: 'high', entityType: 'milestone', entityId: ms.id, assigneeId: p.manager_id, dedupeKey: `ms-signoff:${ms.id}` });
  return 'escalated';
});

/** Client sign-off (button) or manager override from dashboard. */
export function clientMilestone(msId, approve, { note, actor = 'client' } = {}) {
  const ms = getMilestone(msId);
  if (!ms || ms.status !== 'client_review') return { stale: true };
  const p = getProject(ms.project_id);
  const c = getContact(p.client_contact_id);
  const at = nowIso();
  cancelTimers('milestone', ms.id);
  if (!approve) {
    update('milestones', ms.id, { status: 'rework', client_note: note || null, updated_at: at });
    if (c) setFlow(c.id, 'ms_concern', null, { milestoneId: ms.id, projectId: p.id });
    createTask({ title: `Client concern: ${p.ref} · ${ms.name}`, description: note || 'Client raised a concern — see chat.', assigneeId: p.engineer_id || p.supervisor_id || p.manager_id, priority: 'high', entityType: 'milestone', entityId: ms.id });
    notify({ audience: 'managers', title: `Client raised a concern · ${p.ref}`, body: ms.name, link: `#/projects/${p.id}`, level: 'warn' });
    audit(actor, 'milestone.client_concern', 'milestone', ms.id, { note });
    return { ok: true, concern: true };
  }
  update('milestones', ms.id, { status: 'accepted', client_signoff_at: at, completed_at: at, updated_at: at });
  if (c && actor === 'client') enqueueWhatsApp({ to: c.wa_id, kind: 'milestone.approved_ack', sender: 'bot', message: { type: 'text', text: t('ms_approved_ack', c.language, { milestone: ms.name }) } });
  if (ms.amount > 0) { issueInvoice(p, ms); update('milestones', ms.id, { status: 'invoiced', updated_at: at }); }
  const remaining = one("SELECT COUNT(*) n FROM milestones WHERE project_id=? AND status IN ('planned','in_progress','ready_for_review','rework','client_review')", p.id).n;
  if (remaining === 0) {
    update('projects', p.id, { status: 'handover', updated_at: at });
    createApproval('handover', 'project', p.id, `Handover · ${p.ref}`, 'All stages accepted. Complete the snag list, then approve handover.', {});
    createTask({ title: `Snag list & handover: ${p.ref}`, description: 'Walk the site with the client, fix snags, collect keys handover sign-off.', assigneeId: p.manager_id, priority: 'high', entityType: 'project', entityId: p.id, dedupeKey: `handover:${p.id}` });
  } else startNextMilestone(p.id);
  audit(actor, 'milestone.accepted', 'milestone', ms.id);
  enqueueEvent('milestone.accepted', { project: p.ref, milestone: ms.name, amount: ms.amount });
  onCommit(() => broadcast('projects'));
  return { ok: true };
}

export function decideHandover(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const p = getProject(a.entity_id);
  if (decision === 'approve' && p.require_payment_before_handover) {
    const balance = financeSummary(p.id);
    if (balance.due > 0 || Math.round((p.contract_value - balance.netReceived) * 100) > 0) return { error: 'Collect the outstanding contract balance before handover, or disable the project payment gate with an audited decision' };
  }
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, nowIso(), a.id);
  if (decision !== 'approve') return { ok: true };
  const until = addDays(istDate(), 365 * setting('warranty_years'));
  update('projects', p.id, { status: 'warranty', handover_at: nowIso(), warranty_until: until, updated_at: nowIso() });
  const c = getContact(p.client_contact_id);
  if (c) enqueueWhatsApp({ to: c.wa_id, kind: 'project.handover', essential: true, message: { type: 'text', text: t('handover_done', c.language, { project: p.ref, until: fmtDateLong(until) }) }, template: { name: 'ns_client_update', params: [p.ref, `handover complete, structural warranty valid till ${fmtDateLong(until)}`] } });
  audit(`user:${actor?.id}`, 'project.handover', 'project', p.id, { note });
  enqueueEvent('project.handover', { project: p.ref });
  onCommit(() => broadcast('projects'));
  return { ok: true };
}

/** Daily site log from the supervisor app (idempotent per client_event_id). */
export function addSiteLog(projectId, userId, data) {
  if (data.client_event_id) {
    const ex = one('SELECT id FROM site_logs WHERE client_event_id=?', data.client_event_id);
    if (ex) return { ok: true, id: ex.id, duplicate: true };
  }
  const p = getProject(projectId);
  if (!p) return { error: 'Project not found' };
  const at = nowIso();
  const dist = haversineM(data.lat, data.lng, p.site_lat, p.site_lng);
  const id = insert('site_logs', {
    project_id: p.id, user_id: userId, log_date: data.log_date || istDate(data.device_time ? new Date(data.device_time) : undefined),
    work_done: truncate(data.work_done || '', 2000), labour: JSON.stringify(data.labour || {}), materials: data.materials || null, issues: data.issues || null,
    milestone_id: data.milestone_id || null, progress: data.progress ?? null, lat: data.lat ?? null, lng: data.lng ?? null, distance_m: dist,
    client_visible: data.client_visible === false ? 0 : 1, client_event_id: data.client_event_id || null, device_time: data.device_time || null, created_at: at,
  });
  if (data.milestone_id && data.progress !== undefined && data.progress !== null) {
    run("UPDATE milestones SET progress=?, status=CASE WHEN status IN ('planned','rework') THEN 'in_progress' ELSE status END, updated_at=? WHERE id=? AND project_id=?", Math.max(0, Math.min(99, Number(data.progress))), at, data.milestone_id, p.id);
  }
  if (data.issues) notify({ userId: p.manager_id, title: `Site issue · ${p.ref}`, body: truncate(data.issues, 160), link: `#/projects/${p.id}`, level: 'warn' });
  audit(`user:${userId}`, 'site_log.created', 'project', p.id, { log: id });
  onCommit(() => broadcast('projects'));
  return { ok: true, id };
}

export function createChangeRequest(projectId, { title, description, cost_impact = 0, days_impact = 0 }, actor) {
  const p = getProject(projectId);
  if (!p || !title) return { error: 'Project and title are required' };
  try { paise(cost_impact, { min: -Number(p.contract_value || 0) }); } catch (e) { return { error: e.message }; }
  if (!Number.isInteger(Number(days_impact)) || Math.abs(Number(days_impact)) > 3650) return { error: 'Time impact must be a whole number of days within 10 years' };
  const id = insert('change_requests', { ref: nextRef('NS-CR', 3), project_id: p.id, title, description: description || null, requested_by: actor ? `user:${actor.id}` : 'client', cost_impact: Number(cost_impact) || 0, days_impact: Number(days_impact) || 0, status: 'pending_manager', created_at: nowIso() });
  createApproval('change_request', 'change_request', id, `Change request · ${p.ref} · ${title}`, `Cost ${inr(cost_impact)} · ${days_impact} days`, { projectId: p.id });
  audit(actor ? `user:${actor.id}` : 'client', 'change.created', 'project', p.id, { id, title });
  return { ok: true, id };
}

export function decideChangeManager(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const cr = one('SELECT * FROM change_requests WHERE id=?', a.entity_id); const p = getProject(cr.project_id);
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, nowIso(), a.id);
  if (decision !== 'approve') { update('change_requests', cr.id, { status: 'rejected', decided_at: nowIso() }); return { ok: true }; }
  if (!cr.cost_impact && !cr.days_impact) return applyChange(cr.id, `user:${actor?.id}`);
  update('change_requests', cr.id, { status: 'pending_client' });
  const c = getContact(p.client_contact_id); const lang = c?.language || 'en';
  if (c) enqueueWhatsApp({
    to: c.wa_id, kind: 'change.client_approval', essential: true, guard: { type: 'change_request', id: cr.id, status: ['pending_client'] },
    message: { type: 'buttons', text: t('change_request', lang, { project: p.ref, title: cr.title, cost: inr(cr.cost_impact), days: cr.days_impact }), buttons: [{ id: `CR:A:${cr.id}`, title: t('btn_approve', lang) }, { id: `CR:R:${cr.id}`, title: t('btn_reject', lang) }] },
    template: { name: 'ns_change_request', params: [p.ref, cr.title, inr(cr.cost_impact), `${cr.days_impact} days`], buttons: [{ type: 'quick_reply', payload: `CR:A:${cr.id}` }, { type: 'quick_reply', payload: `CR:R:${cr.id}` }] },
  });
  return { ok: true };
}

export function clientChangeDecision(crId, approve) {
  const cr = one('SELECT * FROM change_requests WHERE id=?', crId);
  if (!cr || cr.status !== 'pending_client') return { stale: true };
  if (!approve) { update('change_requests', cr.id, { status: 'rejected', decided_at: nowIso() }); audit('client', 'change.rejected', 'project', cr.project_id, { id: cr.id }); return { ok: true }; }
  return applyChange(cr.id, 'client');
}

/** New baseline version: contract value and remaining dates change; nothing is silently overwritten. */
export function applyChange(crId, actor) {
  const cr = one('SELECT * FROM change_requests WHERE id=?', crId);
  if (!cr || !['pending_manager', 'pending_client'].includes(cr.status)) return { stale: true };
  const p = getProject(cr.project_id);
  if (Number(p.contract_value) + Number(cr.cost_impact) < 0) return { error: 'Scope reduction exceeds the current contract value' };
  if (cr.cost_impact < 0) applyScopeCredit(p, cr, actor);
  const ver = p.baseline_version + 1;
  update('projects', p.id, { contract_value: rupees(paise(p.contract_value || 0) + paise(cr.cost_impact, { min: -Number(p.contract_value || 0) })), baseline_version: ver, target_end: p.target_end && cr.days_impact ? addDays(p.target_end, cr.days_impact) : p.target_end, updated_at: nowIso() });
  if (cr.days_impact) {
    for (const m of all("SELECT * FROM milestones WHERE project_id=? AND status IN ('planned','in_progress','rework')", p.id)) {
      update('milestones', m.id, { planned_end: m.planned_end ? addDays(m.planned_end, cr.days_impact) : null, planned_start: m.planned_start && m.status === 'planned' ? addDays(m.planned_start, cr.days_impact) : m.planned_start, baseline_version: ver, updated_at: nowIso() });
    }
  }
  if (cr.cost_impact > 0) insert('milestones', { project_id: p.id, seq: (one('SELECT MAX(seq) s FROM milestones WHERE project_id=?', p.id).s || 0) + 1, name: `Change ${cr.ref}: ${cr.title}`.slice(0, 120), baseline_version: ver, pay_pct: 0, amount: cr.cost_impact, needs_site_work: 1, status: 'planned', created_at: nowIso(), updated_at: nowIso() });
  update('change_requests', cr.id, { status: 'applied', new_baseline_version: ver, decided_at: nowIso() });
  audit(actor, 'change.applied', 'project', p.id, { id: cr.id, baseline: ver });
  onCommit(() => broadcast('projects'));
  return { ok: true, baseline: ver };
}

export function projectStatusText(p, lang = 'en') {
  const ms = one("SELECT * FROM milestones WHERE project_id=? AND status IN ('in_progress','ready_for_review','rework','client_review') ORDER BY seq LIMIT 1", p.id)
    || one("SELECT * FROM milestones WHERE project_id=? AND status='planned' ORDER BY seq LIMIT 1", p.id);
  const next = ms ? one("SELECT * FROM milestones WHERE project_id=? AND seq > ? ORDER BY seq LIMIT 1", p.id, ms.seq) : null;
  const log = one('SELECT * FROM site_logs WHERE project_id=? AND client_visible=1 ORDER BY id DESC LIMIT 1', p.id);
  const due = one("SELECT COALESCE(SUM(amount - paid_amount),0) d FROM invoices WHERE project_id=? AND status IN ('issued','partially_paid')", p.id).d;
  const statusMap = { awaiting_advance: lang === 'hi' ? 'बुकिंग राशि की प्रतीक्षा' : 'awaiting booking payment', active: lang === 'hi' ? 'काम चल रहा है' : 'in progress', on_hold: lang === 'hi' ? 'रुका हुआ' : 'on hold', handover: lang === 'hi' ? 'हैंडओवर' : 'handover', warranty: lang === 'hi' ? 'वारंटी में' : 'under warranty' };
  return t('project_status', lang, {
    project: p.ref, status: statusMap[p.status] || p.status, milestone: ms ? ms.name : '—', progress: ms ? ms.progress : 100,
    last: log ? `${log.log_date}: ${truncate(log.work_done || '', 120)}` : '—', next: next ? next.name : '—',
    due: due > 0 ? t('amount_due', lang, { amount: inr(due) }) : '',
  }) + `\n🔗 ${projectLink(p)}`;
}

export function paymentsText(p, lang = 'en') {
  const paid = financeSummary(p.id).netReceived;
  const open = all("SELECT * FROM invoices WHERE project_id=? AND status IN ('issued','partially_paid') ORDER BY due_date", p.id);
  const due = open.reduce((a, i) => a + (i.amount - i.paid_amount), 0);
  const list = open.length ? '\n' + open.map((i) => `• ${i.ref} ${i.title}: ${inr(i.amount - i.paid_amount)} (${fmtDateLong(i.due_date)})`).join('\n') + '\n' + setting('payment_instructions') : '';
  return t('payments_summary', lang, { project: p.ref, contract: inr(p.contract_value), paid: inr(paid), due: inr(due), list });
}

/** Text summary of today's client-visible logs, for the 7 PM digest. */
export function digestSummary(projectId, day, lang = 'en') {
  const logs = all('SELECT * FROM site_logs WHERE project_id=? AND log_date=? AND client_visible=1 ORDER BY id', projectId, day);
  if (!logs.length) return null;
  const work = logs.map((l) => l.work_done).filter(Boolean).join('; ');
  const labour = logs.reduce((acc, l) => { for (const [k, v] of Object.entries(jparse(l.labour, {}))) acc[k] = Math.max(acc[k] || 0, Number(v) || 0); return acc; }, {});
  const workers = Object.values(labour).reduce((a, b) => a + b, 0);
  const photos = one("SELECT COUNT(*) n FROM media WHERE owner_type='site_log' AND owner_id IN (SELECT id FROM site_logs WHERE project_id=? AND log_date=?)", projectId, day).n;
  const parts = [truncate(work, 300)];
  if (workers) parts.push(lang === 'hi' ? `👷 ${workers} कारीगर` : `👷 ${workers} workers on site`);
  if (photos) parts.push(lang === 'hi' ? `📷 ${photos} फ़ोटो` : `📷 ${photos} photos`);
  return { text: parts.join('\n'), logIds: logs.map((l) => l.id) };
}
