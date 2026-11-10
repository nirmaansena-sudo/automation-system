import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
let h, ops, user, projectId, orderId;
let seq = 0;
const event = (data) => ({...data,client_event_id:`operations-test-${++seq}`});
before(async () => {
  h = await boot({ AI_MODE:'off', N8N_BASE_URL:'http://127.0.0.1:1' });
  ops = await import('../server/domain/operations.js');
  user = h.db.one("SELECT * FROM users WHERE role='owner'");
  projectId = h.db.insert('projects',{ref:'OPS-TEST',name:'Cost test',status:'active',contract_value:10000,created_at:h.util.nowIso()});
});
after(async () => { if(h) await h.close(); });

test('purchase order, receipt and consumption are atomic/idempotent and cannot create negative stock', () => {
  const payload=event({project_id:projectId,material:'Cement',unit:'bag',supplier:'Supplier A',quantity:10,unit_cost:100});
  const po=ops.createPurchaseOrder(payload,user); orderId=po.id;
  assert.equal(ops.createPurchaseOrder(payload,user).duplicate,true);
  assert.throws(()=>ops.createPurchaseOrder({...payload,quantity:11},user),/different data/);
  assert.throws(()=>ops.moveStock(orderId,'consume',event({quantity:1,reference:'use-before-receipt'}),user),/Insufficient stock/);
  const receipt=event({quantity:6,reference:'DEL-1'});
  ops.moveStock(orderId,'receive',receipt,user);
  assert.equal(ops.moveStock(orderId,'receive',receipt,user).duplicate,true);
  assert.throws(()=>ops.moveStock(orderId,'receive',event({quantity:6,reference:'DEL-2'}),user),/exceeds/);
  assert.throws(()=>ops.moveStock(orderId,'receive',event({quantity:1,reference:'del-1'}),user),/already recorded/);
  const usage=event({quantity:2,reference:'USE-1'});
  assert.equal(ops.moveStock(orderId,'consume',usage,user).cost,200);
  assert.equal(ops.moveStock(orderId,'consume',usage,user).duplicate,true);
  assert.throws(()=>ops.moveStock(orderId,'consume',event({quantity:5,reference:'USE-2'}),user),/Insufficient stock/);
  const row=ops.operationsOverview().rows.find(p=>p.id===projectId);
  assert.equal(row.material_cost,200);assert.equal(row.remaining_commitment,800);
  assert.equal(h.db.one('SELECT received_milli,consumed_milli FROM purchase_orders WHERE id=?',orderId).received_milli,6000);
});

test('material reimbursements and approved travel are each counted once', () => {
  const expenseId=h.db.insert('expense_claims',{user_id:user.id,project_id:projectId,category:'materials',amount:1000,status:'approved',created_at:h.util.nowIso()});
  ops.linkMaterialExpense(orderId,event({expense_id:expenseId}),user);
  h.db.insert('expense_claims',{user_id:user.id,project_id:projectId,category:'fuel',amount:50,status:'approved',created_at:h.util.nowIso()});
  const travelExpense=h.db.insert('expense_claims',{user_id:user.id,project_id:projectId,category:'travel',amount:75,status:'approved',created_at:h.util.nowIso()});
  const visitId=h.db.insert('visits',{ref:'OPS-TRAVEL',project_id:projectId,architect_id:user.id,status:'completed',start_at:h.util.nowIso(),end_at:h.util.nowIso()});
  h.db.insert('visit_travel',{visit_id:visitId,user_id:user.id,visit_revision:1,origin_type:'office',origin_lat:26,origin_lng:75,site_lat:26.1,site_lng:75.1,distance_km:10,distance_source:'manual',amount:75,policy:'{}',status:'claimed',expense_id:travelExpense,created_at:h.util.nowIso(),updated_at:h.util.nowIso()});
  ops.recordExternalCost(event({project_id:projectId,category:'labour',amount:125,reference:'LABOUR-1',note:'Daily labour',cost_date:'2026-11-04'}),user);
  const row=ops.operationsOverview().rows.find(p=>p.id===projectId);
  assert.equal(row.expense_cost,50);assert.equal(row.travel_cost,75);assert.equal(row.material_cost,200);assert.equal(row.external_cost,125);assert.equal(row.actual_cost,450);
  assert.equal(row.contract_less_committed_costs,8750);
  assert.throws(()=>ops.closePurchaseOrder(orderId,event({note:'Short order'}),user),/reimbursed order/);
});

test('budgets use revisions and external references prevent duplicate costs', () => {
  const first=event({project_id:projectId,amount:1500,expected_revision:0});
  assert.equal(ops.setProjectBudget(first,user).revision,1);
  assert.equal(ops.setProjectBudget(first,user).duplicate,true);
  assert.throws(()=>ops.setProjectBudget(event({project_id:projectId,amount:900,expected_revision:0}),user),/Budget changed/);
  const row=ops.operationsOverview().rows.find(p=>p.id===projectId);
  assert.equal(row.budget_remaining,250);
  assert.throws(()=>ops.recordExternalCost(event({project_id:projectId,category:'labour',amount:125,reference:'labour-1',note:'Duplicate'}),user),/already recorded/);
  assert.throws(()=>ops.recordExternalCost(event({project_id:projectId,category:'labour',amount:1,reference:'BAD-DATE',note:'x',cost_date:'2026-99-99'}),user),/Invalid cost date/);
});

test('closing a partial order releases only unreceived commitments and preserves usable stock', () => {
  const po=ops.createPurchaseOrder(event({project_id:projectId,material:'Steel',unit:'kg',supplier:'B',quantity:10,unit_cost:2}),user);
  ops.moveStock(po.id,'receive',event({quantity:4,reference:'STEEL-DEL'}),user);
  ops.closePurchaseOrder(po.id,event({note:'Supplier could supply only four kilograms'}),user);
  assert.throws(()=>ops.moveStock(po.id,'receive',event({quantity:1,reference:'MORE'}),user),/open order/);
  ops.moveStock(po.id,'consume',event({quantity:3,reference:'STEEL-USE'}),user);
  const o=ops.operationsOverview().orders.find(o=>o.id===po.id);
  assert.equal(o.stock,1);assert.equal(o.consumed,3);
  assert.equal(ops.operationsOverview().rows.find(p=>p.id===projectId).remaining_commitment,802);
});

test('fractional use allocates rounded pennies cumulatively and invalid quantities are rejected', () => {
  const po=ops.createPurchaseOrder(event({project_id:projectId,material:'Tiny unit',unit:'kg',supplier:'C',quantity:1,unit_cost:0.01}),user);
  ops.moveStock(po.id,'receive',event({quantity:1,reference:'TINY-DEL'}),user);
  for (const [i,q] of [0.333,0.333,0.334].entries()) ops.moveStock(po.id,'consume',event({quantity:q,reference:`TINY-${i}`}),user);
  assert.equal(h.db.one('SELECT SUM(cost_paise) n FROM stock_movements WHERE order_id=?',po.id).n,1);
  for(const quantity of [0,-1,0.0001,'Infinity',null,true]) assert.throws(()=>ops.createPurchaseOrder(event({project_id:projectId,material:'Bad',unit:'kg',supplier:'C',quantity,unit_cost:1}),user));
});

test('CSV neutralizes spreadsheet formula injection', () => {
  const original=h.db.one('SELECT name FROM projects WHERE id=?',projectId).name;
  h.db.run('UPDATE projects SET name=? WHERE id=?','\t=HYPERLINK("https://invalid.test")',projectId);
  try { assert.ok(ops.operationsCsv().includes('"\'\t=HYPERLINK(')); } finally {h.db.run('UPDATE projects SET name=? WHERE id=?',original,projectId);}
});

test('operations routes enforce owner/manager writes and allow finance read access', async () => {
  const owner=await h.api('GET','/api/operations');assert.equal(owner.status,200,JSON.stringify(owner.body));
  const payload=event({project_id:projectId,amount:2000,expected_revision:1});
  const login=await h.api('POST','/api/auth/login',{login:'neha@demo.local',password:'demo1234'});assert.equal(login.status,200);
  assert.equal((await h.api('GET','/api/operations')).status,200);
  assert.equal((await h.api('POST','/api/operations/budgets',payload)).status,403);
  const manager=await h.api('POST','/api/auth/login',{login:'priya@demo.local',password:'demo1234'});assert.equal(manager.status,200);
  assert.equal((await h.api('POST','/api/operations/budgets',payload)).status,200);
  const app=await h.api('POST','/api/auth/app-login',{phone:'9800000101',pin:'1234'},{noCookie:true});
  assert.equal((await h.api('GET','/api/operations',undefined,{noCookie:true,headers:{authorization:`Bearer ${app.body.token}`}})).status,401);
});

test('invalid JSON bodies and coerced project IDs fail as validation errors', async () => {
  for(const body of [null,[],true,'string']) assert.throws(()=>ops.createPurchaseOrder(body,user),e=>e.status===400);
  for(const project_id of [true,[projectId],{},'']) assert.throws(()=>ops.createPurchaseOrder(event({project_id,material:'X',unit:'bag',supplier:'Y',quantity:1,unit_cost:1}),user),e=>e.status===400);
});

test('cancelled and stale travel estimates are excluded while approved historical expenses remain after erasure', () => {
  const lead=h.db.one('SELECT * FROM leads WHERE site_lat IS NOT NULL LIMIT 1');
  const visit=h.db.insert('visits',{ref:'OPS-STALE',project_id:projectId,lead_id:lead.id,architect_id:user.id,status:'confirmed',start_at:h.util.nowIso(),end_at:h.util.nowIso()});
  h.db.insert('visit_travel',{visit_id:visit,user_id:user.id,visit_revision:1,origin_type:'office',origin_lat:26,origin_lng:75,site_lat:lead.site_lat,site_lng:lead.site_lng,distance_km:10,distance_source:'manual',amount:100,policy:'{}',status:'approved',created_at:h.util.nowIso(),updated_at:h.util.nowIso()});
  const cost=()=>ops.operationsOverview().rows.find(p=>p.id===projectId).travel_cost;
  assert.equal(cost(),175);
  h.db.run("UPDATE visits SET status='cancelled' WHERE id=?",visit);assert.equal(cost(),75);
  h.db.run("UPDATE visits SET status='confirmed',revision=2 WHERE id=?",visit);assert.equal(cost(),75);
  h.db.run("UPDATE visit_travel SET status='erased' WHERE expense_id IS NOT NULL");assert.equal(cost(),75,'approved expense cost survives location erasure');
});
