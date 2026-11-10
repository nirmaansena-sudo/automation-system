import { bad } from '../lib/http.js';
import { usageReport, saveCostPolicy } from '../lib/costs.js';
export function registerCosts(r) {
  const auth = { auth: 'dashboard', roles: ['owner', 'manager', 'finance'] };
  r.get('/api/costs', auth, (ctx) => { try { return { ...usageReport(ctx.query.month), canEditLimits: ctx.user.role === 'owner' }; } catch (error) { throw bad(error.message); } });
  r.patch('/api/costs/policy', auth, (ctx) => { try { return { ok: true, policy: saveCostPolicy(ctx.body || {}, ctx.user) }; } catch (error) { throw bad(error.message); } });
}
