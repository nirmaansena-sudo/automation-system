// Versioned quotations: draft → manager approval → client accept / request changes.
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { nowIso, addMinIso, jparse, randomToken, inr, fmtDateLong, istDate, addDays } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, nextRef, notify, createTask, setting } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent, registerGuard } from '../core/outbox.js';
import { t } from '../bot/i18n.js';
import { COMMERCIAL_MODELS, SERVICE_TYPES } from '../bot/catalog.js';
import { getContact, setFlow, quoteLink } from './common.js';
import { getLead, updateLead, createApproval } from './leads.js';
import { createProjectFromQuote } from './projects.js';
import { paise, rupees } from '../lib/money.js';

export function getQuote(id) { return one('SELECT * FROM quotations WHERE id = ?', id); }
function latestVersion(leadId) { return one('SELECT COALESCE(MAX(version),0) v FROM quotations WHERE lead_id=?', leadId).v; }

registerGuard('quote', (g) => {
  const q = getQuote(g.id);
  return !!q && q.version === latestVersion(q.lead_id) && (!g.status || g.status.includes(q.status));
});

export function computeQuote(items, gstPct) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('Add 1–200 quotation line items');
  const gst = Number(gstPct);
  if (gstPct === null || gstPct === '' || !Number.isFinite(gst) || gst < 0 || gst > 100) throw new Error('GST percentage must be between 0 and 100');
  const clean = items.map((i) => {
    if (!i || typeof i.desc !== 'string' || !i.desc.trim()) throw new Error('Every line item needs a description');
    const qty = Number(i.qty); const ratePaise = paise(i.rate, { min: 0 });
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000000) throw new Error('Quantity must be positive and within range');
    const amountPaise = Math.round(qty * ratePaise);
    if (!Number.isSafeInteger(amountPaise) || amountPaise > 10000000000000) throw new Error('Line amount is too large');
    return { desc: i.desc.trim().slice(0, 200), qty, unit: String(i.unit || 'sq ft').slice(0, 40), rate: rupees(ratePaise), amount: rupees(amountPaise) };
  });
  const subtotalPaise = clean.reduce((a, i) => a + paise(i.amount), 0);
  const totalPaise = Math.round(subtotalPaise * (1 + gst / 100));
  if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0 || totalPaise > 10000000000000) throw new Error('Quotation total must be positive and within range');
  const subtotal = rupees(subtotalPaise); const total = rupees(totalPaise);
  return { items: clean, subtotal, total };
}

export function defaultSchedule(model) {
  const all = setting('default_payment_schedules');
  return (all[model] || all.with_material).map((m) => ({ ...m }));
}

export function createQuotation(leadId, data, actor) {
  const lead = getLead(leadId);
  if (!lead) return { error: 'Lead not found' };
  const gst = data.gst_pct ?? setting('gst_pct');
  let computed;
  try { computed = computeQuote(data.items, gst); } catch (e) { return { error: e.message }; }
  const { items, subtotal, total } = computed;
  if (!items.length) return { error: 'Add at least one line item' };
  const source = data.payment_schedule ?? defaultSchedule(data.commercial_model || 'turnkey');
  if (!Array.isArray(source) || !source.length || source.length > 100) return { error: 'Add 1–100 payment stages' };
  const schedule = source.map((m) => ({ name: String(m?.name || '').trim().slice(0, 120), pct: Number(m?.pct), site: m?.site !== false }));
  if (schedule.some((m) => !m.name || !Number.isFinite(m.pct) || m.pct < 0 || m.pct > 100 || Math.abs(m.pct * 100 - Math.round(m.pct * 100)) > 0.00001)) return { error: 'Every stage needs a name and a percentage from 0 to 100 with at most two decimals' };
  const pctSum = schedule.reduce((a, m) => a + Math.round(m.pct * 100), 0);
  if (pctSum !== 10000) return { error: `Payment schedule adds up to ${pctSum / 100}%, it must be exactly 100%` };
  const days = Number(data.valid_days ?? setting('quote_validity_days'));
  if (!Number.isInteger(days) || days < 1 || days > 365) return { error: 'Quotation validity must be 1–365 days' };
  if (data.commercial_model && !COMMERCIAL_MODELS[data.commercial_model]) return { error: 'Invalid commercial model' };
  if (data.service_type && !SERVICE_TYPES[data.service_type]) return { error: 'Invalid service type' };
  const prev = one('SELECT ref FROM quotations WHERE lead_id=? ORDER BY version DESC LIMIT 1', leadId);
  const at = nowIso();
  run("UPDATE quotations SET status='superseded', updated_at=? WHERE lead_id=? AND status IN ('draft','pending_approval','approved','sent','revision_requested')", at, leadId);
  run("UPDATE approvals SET status='cancelled', decided_at=? WHERE kind='quotation' AND status='pending' AND entity_id IN (SELECT id FROM quotations WHERE lead_id=?)", at, leadId);
  const id = insert('quotations', {
    ref: prev?.ref || nextRef('NS-QT'), lead_id: leadId, version: latestVersion(leadId) + 1,
    service_type: data.service_type || 'construction', commercial_model: data.commercial_model || 'turnkey',
    items: JSON.stringify(items), subtotal, gst_pct: gst, total, payment_schedule: JSON.stringify(schedule),
    notes: data.notes || null, valid_until: addDays(istDate(), days),
    status: 'draft', created_by: actor?.id || null, created_at: at, updated_at: at,
  });
  updateLead(leadId, { status: 'quoting' }, `user:${actor?.id}`);
  audit(`user:${actor?.id}`, 'quote.created', 'quotation', id, { total });
  onCommit(() => broadcast('leads'));
  return { id };
}

export function submitQuotation(id, actor) {
  const q = getQuote(id);
  if (!q || q.status !== 'draft') return { error: 'Only drafts can be submitted' };
  update('quotations', id, { status: 'pending_approval', updated_at: nowIso() });
  const lead = getLead(q.lead_id);
  createApproval('quotation', 'quotation', id, `Approve quotation ${q.ref} v${q.version} · ${lead.ref}`, `${lead.name || ''} · ${SERVICE_TYPES[q.service_type] || q.service_type} · ${COMMERCIAL_MODELS[q.commercial_model] || q.commercial_model} · ${inr(q.total)}`, { leadId: lead.id }, addMinIso(nowIso(), 24 * 60));
  audit(`user:${actor?.id}`, 'quote.submitted', 'quotation', id);
  return { ok: true };
}

export function decideQuotation(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const q = getQuote(a.entity_id);
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, nowIso(), a.id);
  if (decision !== 'approve') {
    update('quotations', q.id, { status: 'draft', updated_at: nowIso() });
    createTask({ title: `Revise quotation ${q.ref} v${q.version}`, description: note || 'Manager returned the quotation.', assigneeId: q.created_by, entityType: 'lead', entityId: q.lead_id });
    return { ok: true };
  }
  update('quotations', q.id, { status: 'approved', approved_by: actor?.id || null, updated_at: nowIso() });
  return sendQuotation(q.id, actor);
}

export function sendQuotation(id, actor) {
  const q = getQuote(id);
  const lead = getLead(q.lead_id); const c = getContact(lead.contact_id);
  const token = q.public_token || randomToken(18);
  const at = nowIso();
  update('quotations', q.id, { status: 'sent', public_token: token, sent_at: at, updated_at: at });
  updateLead(lead.id, { status: 'quote_sent' }, `user:${actor?.id}`);
  const lang = c.language || 'en';
  const link = quoteLink({ public_token: token });
  const service = `${SERVICE_TYPES[q.service_type] || q.service_type} · ${COMMERCIAL_MODELS[q.commercial_model] || q.commercial_model}`;
  enqueueWhatsApp({
    to: c.wa_id, kind: 'quote.sent', essential: true, guard: { type: 'quote', id: q.id, status: ['sent'] },
    message: { type: 'buttons', text: t('quote_ready', lang, { ref: q.ref, ver: q.version, service, total: inr(q.total), valid: fmtDateLong(q.valid_until), link }), buttons: [{ id: `Q:A:${q.id}:${q.version}`, title: t('btn_quote_accept', lang) }, { id: `Q:C:${q.id}:${q.version}`, title: t('btn_quote_change', lang) }, { id: `Q:H:${q.id}:${q.version}`, title: t('btn_call_me', lang) }] },
    template: { name: 'ns_quotation_ready', params: [q.ref, q.version, service, inr(q.total), fmtDateLong(q.valid_until), link], buttons: [{ type: 'quick_reply', payload: `Q:A:${q.id}:${q.version}` }, { type: 'quick_reply', payload: `Q:C:${q.id}:${q.version}` }] },
  });
  audit(`user:${actor?.id}`, 'quote.sent', 'quotation', q.id);
  enqueueEvent('quotation.sent', { id: q.id, ref: q.ref, version: q.version, total: q.total, leadRef: lead.ref });
  onCommit(() => broadcast('leads'));
  return { ok: true, link };
}

/** Client buttons: accept / changes / call. */
export function clientQuoteAction(quoteId, version, action) {
  const q = getQuote(quoteId);
  if (!q || q.version !== Number(version) || q.status !== 'sent' || q.version !== latestVersion(q.lead_id)) return { stale: true };
  if (q.valid_until && q.valid_until < istDate()) return { stale: true, expired: true };
  const lead = getLead(q.lead_id); const c = getContact(lead.contact_id);
  if (action === 'accept') {
    update('quotations', q.id, { status: 'accepted', decided_at: nowIso(), updated_at: nowIso() });
    const project = createProjectFromQuote(getQuote(q.id));
    audit('client', 'quote.accepted', 'quotation', q.id, { project: project.id });
    return { ok: true, projectId: project.id };
  }
  if (action === 'change') {
    update('quotations', q.id, { status: 'revision_requested', decided_at: nowIso(), updated_at: nowIso() });
    setFlow(c.id, 'quote_change', null, { quoteId: q.id });
    enqueueWhatsApp({ to: c.wa_id, kind: 'quote.change_ask', sender: 'bot', message: { type: 'text', text: t('quote_change_ask', c.language) } });
    createTask({ title: `Client wants changes: ${q.ref} v${q.version}`, description: 'Waiting for the client\'s note in the chat.', assigneeId: q.created_by, entityType: 'lead', entityId: lead.id, priority: 'high', dedupeKey: `quote-change:${q.id}` });
    return { ok: true };
  }
  createTask({ title: `Call client about quotation ${q.ref}`, description: `${lead.name || ''} asked for a call.`, kind: 'call_client', priority: 'high', entityType: 'lead', entityId: lead.id, dedupeKey: `quote-call:${q.id}` });
  enqueueWhatsApp({ to: c.wa_id, kind: 'quote.call_ack', sender: 'bot', message: { type: 'text', text: t('handoff', c.language) } });
  return { ok: true };
}

export function recordQuoteChangeNote(quoteId, text) {
  const q = getQuote(quoteId);
  if (!q) return;
  update('quotations', q.id, { client_note: [q.client_note, text].filter(Boolean).join('\n').slice(0, 2000), updated_at: nowIso() });
  notify({ audience: 'managers', title: `Quotation change request ${q.ref}`, body: text.slice(0, 200), link: `#/leads/${q.lead_id}` });
}

/** Routine: mark expired quotations and create follow-ups. */
export function expireQuotations() {
  const today = istDate();
  const rows = all("SELECT * FROM quotations WHERE status='sent' AND valid_until < ?", today);
  for (const q of rows) {
    update('quotations', q.id, { status: 'expired', updated_at: nowIso() });
    const lead = getLead(q.lead_id);
    createTask({ title: `Quotation expired: ${q.ref} · ${lead.name || ''}`, description: 'Call the client — update rates and resend if still interested.', kind: 'follow_up', entityType: 'lead', entityId: lead.id, dedupeKey: `quote-expired:${q.id}` });
  }
  return rows.length;
}
