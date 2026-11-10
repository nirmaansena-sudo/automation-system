import { all, one, insert, update, tx } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { nowIso } from '../lib/util.js';
import { audit } from '../core/base.js';
import { financeSummary, recordRefund } from '../domain/finance.js';

const auth = { auth: 'dashboard', roles: ['owner', 'manager', 'finance'] };
function cell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s) && typeof value !== 'number') s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export function registerFinance(r) {
  r.get('/api/finance/projects/:id', auth, (ctx) => {
    const id = Number(ctx.params.id); const summary = financeSummary(id);
    if (!summary) throw notFound();
    return { ...summary, payments: all('SELECT p.*, r.statement_reference, r.reconciled_at FROM payments p LEFT JOIN reconciliations r ON r.payment_id=p.id WHERE p.project_id=? ORDER BY p.id DESC', id) };
  });
  r.patch('/api/finance/projects/:id/policy', auth, (ctx) => tx(() => {
    const id = Number(ctx.params.id);
    if (!one('SELECT id FROM projects WHERE id=?', id)) throw notFound();
    if (typeof ctx.body?.require_payment_before_handover !== 'boolean') throw bad('Choose whether payment is required before handover');
    const enabled = ctx.body.require_payment_before_handover;
    const reason = String(ctx.body.reason || '').trim();
    if (!reason) throw bad('Give a reason for the policy change');
    update('projects', id, { require_payment_before_handover: enabled ? 1 : 0, updated_at: nowIso() });
    audit(`user:${ctx.user.id}`, 'finance.handover_policy', 'project', id, { enabled, reason });
    return { ok: true };
  }));
  r.post('/api/finance/projects/:id/refunds', auth, (ctx) => {
    const result = recordRefund(Number(ctx.params.id), ctx.body || {}, ctx.user);
    if (result.error) throw bad(result.error);
    return result;
  });
  r.post('/api/finance/payments/:id/reconcile', auth, (ctx) => tx(() => {
    const payment = one('SELECT * FROM payments WHERE id=?', Number(ctx.params.id));
    if (!payment) throw notFound();
    const reference = String(ctx.body?.statement_reference || '').trim();
    if (!reference || reference.length > 150) throw bad('Enter the bank statement reference (max 150 characters)');
    const prior = one('SELECT * FROM reconciliations WHERE payment_id=?', payment.id);
    if (prior) { if (prior.statement_reference === reference) return { ok: true, duplicate: true }; throw bad('Payment already reconciled to another statement reference'); }
    insert('reconciliations', { payment_id: payment.id, statement_reference: reference, note: String(ctx.body?.note || '').slice(0, 500), reconciled_by: ctx.user.id, reconciled_at: nowIso() });
    audit(`user:${ctx.user.id}`, 'payment.reconciled', 'project', payment.project_id, { paymentId: payment.id, reference });
    return { ok: true };
  }));
  r.get('/api/finance/export.csv', auth, (ctx) => {
    const id = ctx.query.project ? Number(ctx.query.project) : null;
    if (ctx.query.project && (!Number.isInteger(id) || id < 1)) throw bad('Invalid project');
    const where = id ? 'WHERE p.id=?' : '';
    const rows = [];
    for (const p of all(`SELECT p.* FROM projects p ${where} ORDER BY p.id`, ...(id ? [id] : []))) {
      for (const i of all('SELECT * FROM invoices WHERE project_id=?', p.id)) rows.push([p.ref, 'invoice', i.ref, i.created_at, i.original_amount ?? i.amount, '', i.status, '', i.title]);
      for (const c of all('SELECT * FROM credit_notes WHERE project_id=?', p.id)) {
        for (const allocation of JSON.parse(c.allocations || '[]')) rows.push([p.ref, allocation.invoice_id ? 'invoice_credit' : 'unbilled_scope_reduction', c.ref, c.created_at, -allocation.amount, '', 'issued', '', `${c.reason}; ${allocation.invoice_id ? `invoice id ${allocation.invoice_id}` : `milestone id ${allocation.milestone_id}`}`]);
      }
      for (const a of all('SELECT a.*, r.statement_reference FROM payments a LEFT JOIN reconciliations r ON r.payment_id=a.id WHERE a.project_id=?', p.id)) rows.push([p.ref, 'payment', a.reference, a.received_at, a.amount, a.method, a.statement_reference ? 'reconciled' : 'unreconciled', a.statement_reference || '', '']);
      for (const f of all('SELECT * FROM refunds WHERE project_id=?', p.id)) rows.push([p.ref, 'refund', f.reference, f.created_at, -f.amount, f.method, 'recorded', '', '']);
    }
    audit(`user:${ctx.user.id}`, 'finance.export', 'project', id, { rows: rows.length });
    ctx.res.setHeader('Content-Disposition', 'attachment; filename="finance-ledger.csv"');
    ctx.text([['Project', 'Type', 'Reference', 'Date', 'Amount_INR', 'Method', 'Status', 'Statement_reference', 'Description'], ...rows].map((row) => row.map(cell).join(',')).join('\r\n'), 200, 'text/csv; charset=utf-8');
  });
}
