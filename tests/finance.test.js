import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
let h, quotes, projects, finance, owner;
before(async () => {
  h = await boot();
  quotes = await import('../server/domain/quotations.js');
  projects = await import('../server/domain/projects.js');
  finance = await import('../server/domain/finance.js');
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
});
after(async () => { if (h) await h.close(); });
function makeProject(total = 1000, schedule = [{ name: 'Advance', pct: 100, site: false }]) {
  const lead = h.db.one('SELECT * FROM leads LIMIT 1');
  const q = h.db.tx(() => quotes.createQuotation(lead.id, { items: [{ desc: 'Work', qty: 1, rate: total }], gst_pct: 0, payment_schedule: schedule }, owner));
  assert.ok(q.id, JSON.stringify(q));
  return h.db.tx(() => projects.createProjectFromQuote(quotes.getQuote(q.id)));
}
test('quotation rejects invalid money and schedule totals and allocates every paise', () => {
  const lead = h.db.one('SELECT * FROM leads LIMIT 1');
  for (const rate of [-1, Infinity, NaN, 'abc', 1.001]) assert.throws(() => quotes.computeQuote([{ desc: 'Work', qty: 1, rate }], 18));
  assert.throws(() => quotes.computeQuote([{ desc: 'Work', qty: -3, rate: 10 }], 0));
  assert.throws(() => quotes.computeQuote([{ desc: 'Work', qty: 1, rate: 10 }], -5));
  for (const schedule of [[{ name: 'A', pct: 99.6 }], [{ name: 'A', pct: 150 }, { name: 'B', pct: -50 }]]) {
    const r = h.db.tx(() => quotes.createQuotation(lead.id, { items: [{ desc: 'Work', qty: 1, rate: 10 }], gst_pct: 0, payment_schedule: schedule }, owner));
    assert.ok(r.error);
  }
  const p = makeProject(100.01, [{ name: 'A', pct: 33.33, site: false }, { name: 'B', pct: 33.33 }, { name: 'C', pct: 33.34 }]);
  assert.equal(h.db.all('SELECT amount FROM milestones WHERE project_id=?', p.id).reduce((n, x) => n + Math.round(x.amount * 100), 0), 10001);
});
test('payment replay is idempotent, different reuse and overpayment fail', () => {
  const p = makeProject(); const inv = h.db.one('SELECT * FROM invoices WHERE project_id=?', p.id);
  const record = (data) => h.db.tx(() => projects.recordPayment(inv.id, data, owner));
  const data = { amount: 300, reference: 'bank-001', method: 'bank', client_event_id: 'payment-one' };
  assert.equal(record(data).ok, true);
  assert.equal(record(data).duplicate, true);
  assert.equal(record({ ...data, client_event_id: 'new-key', reference: 'BANK-001' }).duplicate, true);
  assert.ok(record({ ...data, amount: 400 }).error);
  assert.ok(record({ amount: 701, reference: 'too-much' }).error);
  assert.equal(h.db.one('SELECT paid_amount FROM invoices WHERE id=?', inv.id).paid_amount, 300);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM payments WHERE invoice_id=?', inv.id).n, 1);
});
test('scope reduction credits paid invoices and refunds can only consume available credit once', () => {
  const p = makeProject(); const inv = h.db.one('SELECT * FROM invoices WHERE project_id=?', p.id);
  h.db.tx(() => projects.recordPayment(inv.id, { amount: 1000, reference: 'paid-credit' }, owner));
  const cr = h.db.tx(() => projects.createChangeRequest(p.id, { title: 'Remove optional work', cost_impact: -200 }, owner));
  h.db.tx(() => projects.applyChange(cr.id, 'test'));
  assert.equal(projects.getProject(p.id).contract_value, 800);
  assert.equal(h.db.one('SELECT amount FROM invoices WHERE id=?', inv.id).amount, 800);
  assert.equal(finance.financeSummary(p.id).refundable, 200);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM milestones WHERE project_id=? AND amount<0', p.id).n, 0);
  const data = { amount: 150, method: 'bank', reference: 'refund-1', client_event_id: 'refund-once' };
  assert.equal(finance.recordRefund(p.id, data, owner).ok, true);
  assert.equal(finance.recordRefund(p.id, data, owner).duplicate, true);
  assert.ok(finance.recordRefund(p.id, { ...data, amount: 100, reference: 'refund-2', client_event_id: 'refund-two' }, owner).error);
  assert.equal(finance.financeSummary(p.id).netReceived, 850);
  assert.equal(finance.financeSummary(p.id).refundable, 50);
});
test('optional handover payment gate leaves approval pending until collection', () => {
  const p = makeProject();
  h.db.update('projects', p.id, { require_payment_before_handover: 1 });
  const id = h.db.insert('approvals', { kind: 'handover', entity_type: 'project', entity_id: p.id, title: 'Handover', status: 'pending', created_at: new Date().toISOString() });
  const denied = h.db.tx(() => projects.decideHandover(id, { decision: 'approve' }, owner));
  assert.ok(denied.error);
  assert.equal(h.db.one('SELECT status FROM approvals WHERE id=?', id).status, 'pending');
  const inv = h.db.one('SELECT * FROM invoices WHERE project_id=?', p.id);
  h.db.tx(() => projects.recordPayment(inv.id, { amount: 1000, reference: 'handover-pay' }, owner));
  assert.equal(h.db.tx(() => projects.decideHandover(id, { decision: 'approve' }, owner)).ok, true);
});
test('finance endpoints expose reconciliation/export to managers and reject anonymous writes', async () => {
  const p = makeProject(); const inv = h.db.one('SELECT * FROM invoices WHERE project_id=?', p.id);
  const payment = await h.api('POST', `/api/invoices/${inv.id}/payments`, { amount: 100, reference: '=SUM(1)', client_event_id: 'api-payment' });
  assert.equal(payment.status, 200);
  const overview = await h.api('GET', `/api/finance/projects/${p.id}`);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.received, 100);
  const paymentId = overview.body.payments[0].id;
  assert.equal((await h.api('POST', `/api/finance/payments/${paymentId}/reconcile`, { statement_reference: 'STMT-1' })).status, 200);
  assert.equal((await h.api('GET', `/api/finance/projects/${p.id}`)).body.payments[0].statement_reference, 'STMT-1');
  const exported = await h.api('GET', `/api/finance/export.csv?project=${p.id}`);
  assert.equal(exported.status, 200);
  assert.ok(exported.body.includes("'=SUM(1)"), 'formula-like external reference is escaped in CSV');
  assert.equal((await h.api('PATCH', `/api/finance/projects/${p.id}/policy`, { require_payment_before_handover: true, reason: 'Collect before delivery' })).status, 200);
  assert.equal((await h.api('POST', `/api/finance/payments/${paymentId}/reconcile`, { statement_reference: 'STMT-2' }, { noCookie: true })).status, 401);
});
