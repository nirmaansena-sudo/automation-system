import { all, one, tx } from '../db/index.js';
import { bad, notFound, forbidden } from '../lib/http.js';
import { config } from '../config.js';
import { dispatchSettings, travelSettings, saveDispatchSettings, locationProfile, setLocationProfile, coverageGeoJSON } from '../domain/dispatch.js';
import { travelOptions, selectTravel, approveTravel, claimTravel, listTravel } from '../domain/travel.js';
import { eligibleArchitects } from '../domain/scheduling.js';
import { addMinIso } from '../lib/util.js';
import { getSettings } from '../core/base.js';

export function registerDispatch(r) {
  const manager = { auth: 'dashboard', roles: ['owner', 'manager'] }, finance = { auth: 'dashboard', roles: ['owner', 'manager', 'finance'] }, app = { auth: 'app' };
  r.get('/api/dispatch', manager, () => ({ dispatch: dispatchSettings(), travel: travelSettings(), office: getSettings().office, routing: config.routing?.osrmUrl ? 'configured' : 'estimate_only', team: all("SELECT id,name,role,daily_visit_cap FROM users WHERE active=1 AND role IN ('architect','engineer') ORDER BY name").map(u => ({ ...u, location: locationProfile(u.id) })) }));
  r.patch('/api/dispatch', manager, ctx => saveDispatchSettings(ctx.body, `user:${ctx.user.id}`));
  r.get('/api/dispatch/coverage', manager, () => coverageGeoJSON());
  r.put('/api/dispatch/team/:id/location', manager, ctx => setLocationProfile(Number(ctx.params.id), ctx.body || {}, `user:${ctx.user.id}`));
  r.get('/api/dispatch/candidates', manager, ctx => {
    const lead = one('SELECT * FROM leads WHERE id=?', Number(ctx.query.lead_id)); if (!lead) throw notFound('Lead not found');
    const date = new Date(ctx.query.start); if (!Number.isFinite(date.getTime())) throw bad('Select a valid visit time');
    return eligibleArchitects(lead, date.toISOString(), addMinIso(date.toISOString(), getSettings().visit_duration_min)).map(({ user, ...rank }) => ({ ...rank, id: user.id, name: user.name }));
  });
  r.get('/api/travel', finance, () => ({ trips: listTravel(), policy: travelSettings() }));
  r.get('/api/travel/visits/:id', manager, ctx => travelOptions(Number(ctx.params.id), ctx.user));
  r.post('/api/travel/visits/:id/select', manager, ctx => selectTravel(Number(ctx.params.id), ctx.user, ctx.body || {}));
  r.post('/api/travel/visits/:id/approve', manager, ctx => approveTravel(Number(ctx.params.id), ctx.user, ctx.body || {}));
  r.get('/api/app/travel/profile', app, ctx => ({ profile: locationProfile(ctx.user.id), can_set_origin: ['architect', 'engineer'].includes(ctx.user.role) }));
  r.put('/api/app/travel/profile', app, ctx => setLocationProfile(ctx.user.id, ctx.body || {}, `user:${ctx.user.id}`));
  r.get('/api/app/visits/:id/travel', app, ctx => travelOptions(Number(ctx.params.id), ctx.user));
  r.post('/api/app/visits/:id/travel', app, ctx => selectTravel(Number(ctx.params.id), ctx.user, ctx.body || {}));
  r.post('/api/app/visits/:id/travel/claim', app, ctx => claimTravel(Number(ctx.params.id), ctx.user));
}
