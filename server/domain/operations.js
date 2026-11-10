// Cost tracking on a gross amount basis. This is not a general ledger or profit recognition.
import crypto from 'node:crypto';
import { all, one, run, insert, tx, onCommit } from '../db/index.js';
import { bad, notFound, broadcast } from '../lib/http.js';
import { nowIso, istDate } from '../lib/util.js';
import { audit, nextRef } from '../core/base.js';

const rupees = (p) => Math.round(p) / 100;
const qty = (q) => q / 1000;
const value = (q, p) => Math.round(q * p / 1000);
function text(v, name, max = 200) { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw bad(`${name} is required (maximum ${max} characters)`); return v.trim(); }
function number(v, name, scale, allowZero = false) {
  if (v === '' || v === null || typeof v === 'boolean' || !['string', 'number'].includes(typeof v)) throw bad(`${name} must be a number`);
  const n = Number(v); const scaled = Math.round(n * scale);
  if (!Number.isFinite(n) || !Number.isSafeInteger(scaled) || n < 0 || (!allowZero && scaled <= 0) || Math.abs(n * scale - scaled) > 1e-6 || scaled > 1e12) throw bad(`${name} must be ${allowZero ? 'non-negative' : 'positive'} with at most ${scale === 100 ? 2 : 3} decimals`);
  return scaled;
}
function id(v, name = 'ID') { if (!['number','string'].includes(typeof v) || (typeof v==='string' && !v.trim())) throw bad(`Invalid ${name}`); const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw bad(`Invalid ${name}`); return n; }
function project(v) { const p = one('SELECT id,ref,status FROM projects WHERE id=?', id(v, 'project')); if (!p) throw notFound('Project not found'); return p; }
function order(v) { const p = one('SELECT * FROM purchase_orders WHERE id=?', id(v, 'order')); if (!p) throw notFound('Purchase order not found'); return p; }
function hash(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function mutate(action, data, user, fn) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Provide a JSON object');
  const key = text(data.client_event_id, 'Request ID', 120);
  const payload = Object.fromEntries(Object.keys(data).filter((k) => k !== 'client_event_id').sort().map((k) => [k, data[k]]));
  const digest = hash({ userId: user.id, payload });
  return tx(() => {
    const previous = one('SELECT * FROM operation_events WHERE client_event_id=?', key);
    if (previous) {
      if (previous.action !== action || previous.request_hash !== digest) throw bad('Request ID was already used for different data');
      return { ...JSON.parse(previous.result), duplicate: true };
    }
    const result = fn();
    insert('operation_events', { client_event_id: key, action, request_hash: digest, result: JSON.stringify(result), created_at: nowIso() });
    audit(`user:${user.id}`, `operations.${action}`, 'project', result.project_id || null, { ...payload, result });
    onCommit(() => broadcast('operations'));
    return result;
  });
}
function expenseForOrder(po, expenseId) {
  const e = one('SELECT * FROM expense_claims WHERE id=?', id(expenseId, 'expense'));
  if (!e || e.project_id !== po.project_id || e.status === 'rejected') throw bad('Choose a non-rejected expense for this project');
  if (one('SELECT visit_id FROM visit_travel WHERE expense_id=?', e.id)) throw bad('Travel expenses cannot pay for material orders');
  if (Math.round(e.amount * 100) !== value(po.quantity_milli, po.unit_cost_paise)) throw bad('Material reimbursement must match the full order amount');
  const used = one('SELECT id FROM purchase_orders WHERE expense_id=?', e.id);
  if (used && used.id !== po.id) throw bad('Expense is already linked to another order');
  return e.id;
}
export function createPurchaseOrder(data, user) {
  return mutate('order.create', data, user, () => {
    const p = project(data.project_id);
    if (['cancelled','closed'].includes(p.status)) throw bad('Cannot place orders for a closed or cancelled project');
    const q = number(data.quantity, 'Quantity', 1000); const price = number(data.unit_cost, 'Unit cost', 100, true);
    if (!Number.isSafeInteger(q * price)) throw bad('Order amount exceeds supported precision');
    const at = nowIso();
    const po = { project_id: p.id, material: text(data.material, 'Material'), unit: text(data.unit, 'Unit', 30), supplier: text(data.supplier, 'Supplier'), quantity_milli: q, unit_cost_paise: price, note: String(data.note || '').slice(0, 1000), created_by: user.id, created_at: at, updated_at: at };
    if (data.expense_id) po.expense_id = expenseForOrder(po, data.expense_id);
    const ref = nextRef('NS-PO');
    const orderId = insert('purchase_orders', { ref, ...po });
    return { ok: true, id: orderId, ref, project_id: p.id };
  });
}
export function moveStock(orderId, kind, data, user) {
  if (!['receive','consume'].includes(kind)) throw bad('Unknown stock movement');
  return mutate(`stock.${kind}:${orderId}`, data, user, () => {
    const po = order(orderId); const q = number(data.quantity, 'Quantity', 1000);
    const reference = text(data.reference, kind === 'receive' ? 'Delivery reference' : 'Usage reference', 100).toUpperCase();
    if (one('SELECT id FROM stock_movements WHERE order_id=? AND kind=? AND reference=?', po.id, kind, reference)) throw bad('This reference was already recorded for the order');
    if (kind === 'receive' && (po.status !== 'open' || q > po.quantity_milli - po.received_milli)) throw bad('Receipt exceeds the open order quantity');
    if (kind === 'consume' && q > po.received_milli - po.consumed_milli) throw bad('Insufficient stock; receive the material first');
    const cost = kind === 'consume' ? value(po.consumed_milli + q, po.unit_cost_paise) - value(po.consumed_milli, po.unit_cost_paise) : 0;
    const movementId = insert('stock_movements', { order_id: po.id, kind, quantity_milli: q, cost_paise: cost, reference, note: String(data.note || '').slice(0, 1000), actor_id: user.id, created_at: nowIso() });
    run(`UPDATE purchase_orders SET ${kind === 'receive' ? 'received_milli' : 'consumed_milli'}=${kind === 'receive' ? 'received_milli' : 'consumed_milli'}+?,updated_at=? WHERE id=?`, q, nowIso(), po.id);
    return { ok: true, id: movementId, project_id: po.project_id, cost: rupees(cost) };
  });
}
export function closePurchaseOrder(orderId, data, user) {
  return mutate(`order.close:${orderId}`, data, user, () => {
    const po = order(orderId);
    text(data.note, 'Reason', 1000);
    if (po.expense_id && po.received_milli !== po.quantity_milli) throw bad('A reimbursed order cannot be partly cancelled; resolve its expense first');
    run("UPDATE purchase_orders SET status='closed',updated_at=? WHERE id=?", nowIso(), po.id);
    return { ok: true, id: po.id, project_id: po.project_id };
  });
}
export function linkMaterialExpense(orderId, data, user) {
  return mutate(`order.expense:${orderId}`, data, user, () => {
    const po = order(orderId);
    if (po.expense_id) throw bad('Order already has a linked reimbursement');
    if (po.status === 'closed' && po.received_milli !== po.quantity_milli) throw bad('Partially cancelled orders cannot link a full-order reimbursement');
    const expenseId = expenseForOrder(po, data.expense_id);
    run('UPDATE purchase_orders SET expense_id=?,updated_at=? WHERE id=?', expenseId, nowIso(), po.id);
    return { ok: true, id: po.id, project_id: po.project_id };
  });
}
export function setProjectBudget(data, user) {
  return mutate('budget.set', data, user, () => {
    const p = project(data.project_id); const amount = number(data.amount, 'Budget', 100, true);
    const old = one('SELECT * FROM project_budgets WHERE project_id=?', p.id);
    if (Number(data.expected_revision || 0) !== (old?.revision || 0)) throw bad('Budget changed; refresh before editing');
    run('INSERT INTO project_budgets(project_id,amount_paise,note,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET amount_paise=excluded.amount_paise,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at,revision=revision+1', p.id, amount, String(data.note || '').slice(0, 1000), user.id, nowIso());
    return { ok: true, project_id: p.id, revision: (old?.revision || 0) + 1 };
  });
}
export function recordExternalCost(data, user) {
  return mutate('cost.create', data, user, () => {
    const p = project(data.project_id); const amount = number(data.amount, 'Cost', 100);
    if (!['labour','subcontractor','equipment','overhead','other'].includes(data.category)) throw bad('Select a cost category');
    const date = String(data.cost_date || istDate());
    const parsedDate = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw bad('Invalid cost date');
    const reference = text(data.reference, 'Supplier invoice/reference', 100).toUpperCase();
    if (one('SELECT id FROM project_external_costs WHERE project_id=? AND reference=?', p.id, reference)) throw bad('This cost reference was already recorded');
    if (data.expense_id) throw bad('Use the existing employee expense; do not enter it again as an external cost');
    const costId = insert('project_external_costs', { project_id: p.id, category: data.category, amount_paise: amount, reference, note: text(data.note, 'Description', 1000), cost_date: date, created_by: user.id, created_at: nowIso() });
    return { ok: true, id: costId, project_id: p.id };
  });
}

export function operationsOverview() {
  const orders = all('SELECT o.*,p.ref project_ref FROM purchase_orders o JOIN projects p ON p.id=o.project_id ORDER BY o.id DESC').map((o) => ({ ...o, quantity: qty(o.quantity_milli), received: qty(o.received_milli), consumed: qty(o.consumed_milli), stock: qty(o.received_milli-o.consumed_milli), unit_cost: rupees(o.unit_cost_paise), order_value: rupees(value(o.quantity_milli,o.unit_cost_paise)) }));
  const expenses = all("SELECT e.*,p.ref project_ref FROM expense_claims e LEFT JOIN projects p ON p.id=e.project_id WHERE e.project_id IS NOT NULL ORDER BY e.id DESC");
  const travel = all("SELECT t.*,e.status expense_status,e.amount expense_amount,v.status visit_status,v.revision current_revision,v.architect_id current_architect,l.site_lat current_site_lat,l.site_lng current_site_lng,COALESCE(v.project_id,(SELECT id FROM projects WHERE lead_id=v.lead_id ORDER BY id DESC LIMIT 1)) cost_project_id FROM visit_travel t JOIN visits v ON v.id=t.visit_id LEFT JOIN leads l ON l.id=v.lead_id LEFT JOIN expense_claims e ON e.id=t.expense_id");
  const travelCostPaise = (t) => {
    // Once finance approves an expense its historical cost remains, including
    // after client erasure. An unclaimed estimate must still be current.
    if (['approved','paid'].includes(t.expense_status)) return Math.round(t.expense_amount*100);
    if (t.expense_status==='rejected' || !['approved','claimed'].includes(t.status) || t.visit_status==='cancelled' || t.visit_revision!==t.current_revision || t.user_id!==t.current_architect || t.site_lat!==t.current_site_lat || t.site_lng!==t.current_site_lng) return 0;
    return Math.round((t.amount || 0)*100);
  };
  const external = all('SELECT * FROM project_external_costs ORDER BY id DESC').map((c) => ({ ...c, amount: rupees(c.amount_paise) }));
  const budgets = all('SELECT * FROM project_budgets');
  const rows = all('SELECT id,ref,name,status,contract_value FROM projects ORDER BY id DESC').map((p) => {
    const material = orders.filter((o) => o.project_id === p.id);
    const materialCost = material.reduce((s,o) => s + value(o.consumed_milli,o.unit_cost_paise),0);
    const materialCommitment = material.reduce((s,o) => s + value(o.status === 'closed' ? o.received_milli : o.quantity_milli,o.unit_cost_paise) - value(o.consumed_milli,o.unit_cost_paise),0);
    const linkedMaterial = new Set(material.map((o) => o.expense_id).filter(Boolean));
    const pt = travel.filter((t) => t.cost_project_id === p.id);
    const linkedTravel = new Set(travel.map((t) => t.expense_id).filter(Boolean));
    // Travel is included once here even if its expense has no project_id yet.
    const travelCost = pt.reduce((s,t) => s + travelCostPaise(t),0);
    const expenseCost = expenses.filter((e) => e.project_id === p.id && ['approved','paid'].includes(e.status) && !linkedMaterial.has(e.id) && !linkedTravel.has(e.id)).reduce((s,e) => s+Math.round(e.amount*100),0);
    const externalCost = external.filter((c) => c.project_id === p.id).reduce((s,c) => s+c.amount_paise,0);
    const actual = materialCost+expenseCost+travelCost+externalCost; const budget = budgets.find((b) => b.project_id === p.id); const contract = Math.round((p.contract_value || 0)*100);
    return { ...p, budget: budget ? rupees(budget.amount_paise) : null, budget_revision: budget?.revision || 0, material_cost: rupees(materialCost), expense_cost: rupees(expenseCost), travel_cost: rupees(travelCost), external_cost: rupees(externalCost), actual_cost: rupees(actual), remaining_commitment: rupees(materialCommitment), budget_remaining: budget ? rupees(budget.amount_paise-actual-materialCommitment) : null, contract_less_costs: rupees(contract-actual), contract_less_committed_costs: rupees(contract-actual-materialCommitment) };
  });
  const unallocated = one("SELECT COUNT(*) count,COALESCE(SUM(amount),0) amount FROM expense_claims e WHERE project_id IS NULL AND status IN ('approved','paid') AND NOT EXISTS(SELECT 1 FROM visit_travel t WHERE t.expense_id=e.id)");
  const unallocatedTravel = rupees(travel.filter((t) => !t.cost_project_id).reduce((s,t) => s+travelCostPaise(t),0));
  return { rows, orders, expenses, unallocated: { expenses: unallocated.count, amount: unallocated.amount, travel_amount: unallocatedTravel }, external_costs: external, movements: all('SELECT m.*,o.ref order_ref FROM stock_movements m JOIN purchase_orders o ON o.id=m.order_id ORDER BY m.id DESC LIMIT 200').map((m) => ({ ...m, quantity: qty(m.quantity_milli), cost: rupees(m.cost_paise) })), basis: 'Gross contract value compared with consumed material at order cost, approved/paid expenses, approved travel once, and recorded external costs. Remaining material commitment includes unused stock and open unreceived orders. Excludes unrecorded future costs, tax adjustments and overhead unless entered. This is a cost estimate, not accounting profit.' };
}

export function operationsCsv() {
  const keys = ['ref','name','contract_value','budget','material_cost','expense_cost','travel_cost','external_cost','actual_cost','remaining_commitment','budget_remaining','contract_less_costs','contract_less_committed_costs'];
  const cell = (v) => { let s = v == null ? '' : String(v); if (/^[\s\u0000-\u001f\uFEFF]*[=+\-@]/.test(s) && typeof v !== 'number') s = "'" + s; return '"' + s.replace(/"/g,'""') + '"'; };
  return [keys.map(cell).join(','), ...operationsOverview().rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n');
}
