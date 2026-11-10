import { createPurchaseOrder, moveStock, closePurchaseOrder, linkMaterialExpense, setProjectBudget, recordExternalCost, operationsOverview, operationsCsv } from '../domain/operations.js';
export function registerOperations(r) {
  const view = { auth: 'dashboard', roles: ['owner','manager','finance'] };
  const manage = { auth: 'dashboard', roles: ['owner','manager'] };
  r.get('/api/operations', view, () => operationsOverview());
  r.get('/api/operations/export.csv', view, (ctx) => { ctx.res.setHeader('Content-Disposition', 'attachment; filename="project-costs.csv"'); ctx.text(operationsCsv(),200,'text/csv; charset=utf-8'); });
  r.post('/api/operations/orders', manage, (ctx) => createPurchaseOrder(ctx.body,ctx.user));
  r.post('/api/operations/orders/:id/receive', manage, (ctx) => moveStock(Number(ctx.params.id),'receive',ctx.body,ctx.user));
  r.post('/api/operations/orders/:id/consume', manage, (ctx) => moveStock(Number(ctx.params.id),'consume',ctx.body,ctx.user));
  r.post('/api/operations/orders/:id/close', manage, (ctx) => closePurchaseOrder(Number(ctx.params.id),ctx.body,ctx.user));
  r.post('/api/operations/orders/:id/link-expense', manage, (ctx) => linkMaterialExpense(Number(ctx.params.id),ctx.body,ctx.user));
  r.post('/api/operations/budgets', manage, (ctx) => setProjectBudget(ctx.body,ctx.user));
  r.post('/api/operations/costs', manage, (ctx) => recordExternalCost(ctx.body,ctx.user));
}
