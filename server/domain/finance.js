import { all, one, insert, update, tx } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { paise, rupees } from '../lib/money.js';
import { audit, nextRef } from '../core/base.js';

export function financeSummary(projectId) {
  const p = one('SELECT * FROM projects WHERE id=?', projectId);
  if (!p) return null;
  const invoices = all("SELECT * FROM invoices WHERE project_id=? AND status!='cancelled'", projectId);
  const received = one('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE project_id=?', projectId).n;
  const refunded = one('SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE project_id=?', projectId).n;
  const credit = invoices.reduce((n, i) => n + Math.max(0, Math.round((i.paid_amount - i.amount) * 100)), 0);
  return { contract: p.contract_value, received, refunded, netReceived: rupees(Math.round((received - refunded) * 100)),
    due: rupees(invoices.reduce((n, i) => n + Math.max(0, Math.round((i.amount - i.paid_amount) * 100)), 0)),
    refundable: rupees(Math.max(0, credit - Math.round(refunded * 100))),
    require_payment_before_handover: !!p.require_payment_before_handover,
    credits: all('SELECT * FROM credit_notes WHERE project_id=? ORDER BY id DESC', projectId),
    refunds: all('SELECT * FROM refunds WHERE project_id=? ORDER BY id DESC', projectId) };
}

// Reduce unbilled work first, then invoices. Never represent a credit as billable work.
export function applyScopeCredit(project, change, actor) {
  const amount = -Number(change.cost_impact);
  let remaining = paise(amount, { min: 0.01 });
  const existing = one('SELECT * FROM credit_notes WHERE change_request_id=?', change.id);
  if (existing) return existing;
  const milestones = all('SELECT * FROM milestones WHERE project_id=? AND amount>0 ORDER BY seq DESC', project.id);
  const ordered = milestones.sort((a, b) => Number(!!one("SELECT id FROM invoices WHERE milestone_id=? AND status!='cancelled'", a.id)) - Number(!!one("SELECT id FROM invoices WHERE milestone_id=? AND status!='cancelled'", b.id)));
  const allocations = [];
  const available = ordered.reduce((n, m) => n + paise(m.amount), 0);
  if (remaining > available) throw new Error('Scope reduction exceeds the remaining billable contract; review previous adjustments');
  for (const m of ordered) {
    if (!remaining) break;
    const cut = Math.min(remaining, paise(m.amount));
    const nextAmount = rupees(paise(m.amount) - cut);
    const inv = one("SELECT * FROM invoices WHERE milestone_id=? AND status!='cancelled' ORDER BY id LIMIT 1", m.id);
    if (inv) {
      const invoiceAmount = rupees(Math.max(0, paise(inv.amount) - cut));
      update('invoices', inv.id, { original_amount: inv.original_amount ?? inv.amount, amount: invoiceAmount,
        status: inv.paid_amount >= invoiceAmount ? 'paid' : inv.paid_amount > 0 ? 'partially_paid' : 'issued',
        paid_at: inv.paid_amount >= invoiceAmount ? inv.paid_at || nowIso() : null });
    }
    update('milestones', m.id, { amount: nextAmount, baseline_version: project.baseline_version + 1, updated_at: nowIso() });
    allocations.push({ milestone_id: m.id, invoice_id: inv?.id || null, amount: rupees(cut), previous_amount: m.amount });
    remaining -= cut;
  }
  const id = insert('credit_notes', { ref: nextRef('NS-CN'), project_id: project.id, change_request_id: change.id, amount, reason: change.title, allocations: JSON.stringify(allocations), created_at: nowIso() });
  audit(actor, 'credit.issued', 'project', project.id, { creditId: id, amount, allocations });
  return one('SELECT * FROM credit_notes WHERE id=?', id);
}

export function recordRefund(projectId, data, actor) {
  return tx(() => {
    let cents;
    try { cents = paise(data.amount, { min: 0.01 }); } catch (e) { return { error: e.message }; }
    const key = String(data.client_event_id || '').trim();
    const reference = String(data.reference || '').trim().toUpperCase();
    const method = String(data.method || 'bank');
    if (!key || key.length > 128 || !reference || reference.length > 150 || !['bank', 'upi', 'cash', 'cheque', 'card'].includes(method)) return { error: 'Refund needs a valid request key, method and transaction reference' };
    const prior = one('SELECT * FROM refunds WHERE client_event_id=? OR (project_id=? AND method=? AND reference=?)', key, projectId, method, reference);
    if (prior) return prior.project_id === projectId && paise(prior.amount) === cents && prior.method === method && prior.reference === reference ? { ok: true, duplicate: true, id: prior.id } : { error: 'This refund key or reference has already been used with different details' };
    const s = financeSummary(projectId);
    if (!s || cents > paise(s.refundable)) return { error: 'Refund exceeds available client credit' };
    const id = insert('refunds', { project_id: projectId, amount: rupees(cents), method, reference, client_event_id: key, recorded_by: actor.id, created_at: nowIso() });
    audit(`user:${actor.id}`, 'refund.recorded', 'project', projectId, { id, amount: rupees(cents), method, reference });
    return { ok: true, id };
  });
}
