import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let h; let owner; let architect; let other; let appAuth; let otherAuth; let financeAuth;
let dispatch; let travel; let config; let sequence = 0;
const bearer = (token) => ({ noCookie: true, headers: { authorization: `Bearer ${token}` } });
before(async () => {
  h = await boot();
  dispatch = await import('../server/domain/dispatch.js'); travel = await import('../server/domain/travel.js');
  ({ config } = await import('../server/config.js'));
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  async function person(name, phone, role, email) {
    const created = await h.api('POST', '/api/team', { name, phone, role, email, password: 'dispatch-password', pin: '575757' }); assert.equal(created.status, 200);
    const user = h.db.one('SELECT * FROM users WHERE id=?', created.body.id);
    const logged = await h.api('POST', '/api/auth/app-login', { phone, pin: '575757' }, { noCookie: true }); assert.equal(logged.status, 200);
    return { user, auth: bearer(logged.body.token) };
  }
  const a = await person('Dispatch architect', '9999000101', 'architect', 'dispatch-a@test.local'); architect = a.user; appAuth = a.auth;
  const b = await person('Other architect', '9999000102', 'architect', 'dispatch-b@test.local'); other = b.user; otherAuth = b.auth;
  await person('Dispatch finance', '9999000103', 'finance', 'dispatch-finance@test.local');
  const login = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'dispatch-finance@test.local', password: 'dispatch-password' }) }); assert.equal(login.status, 200);
  financeAuth = { noCookie: true, headers: { cookie: login.headers.get('set-cookie').split(';')[0] } };
  dispatch.saveDispatchSettings({ dispatch: { radius_km: 2, resolution: 6 }, travel: { rate_per_km: 10, base_amount: 20, minimum_amount: 30, maximum_amount: 100, rounding_rupees: 1 } }, `user:${owner.id}`);
  dispatch.setLocationProfile(architect.id, { home_lat: 26.95, home_lng: 75.75, home_label: 'Private home address', default_origin: 'home' }, `user:${architect.id}`);
});
after(async () => { if (h) { await h.close(); h.db.closeDb(); } });
function fixture(status = 'report_submitted') {
  sequence++;
  const c = h.db.insert('contacts', { wa_id: `91999999${String(sequence).padStart(4, '0')}`, name: `Travel client ${sequence}` });
  const lead = h.db.insert('leads', { contact_id: c, ref: `SEC-TRAVEL-L${sequence}`, name: `Travel client ${sequence}`, site_lat: 26.92 + sequence * 0.0001, site_lng: 75.80, status: 'visit_confirmed' });
  const id = h.db.insert('visits', { ref: `SEC-TRAVEL-V${sequence}`, lead_id: lead, architect_id: architect.id, revision: 1, start_at: h.util.nowIso(), end_at: h.util.addMinIso(h.util.nowIso(), 60), status });
  return { id, lead };
}
async function approvedVisit() {
  const visit = fixture(); const selected = await travel.selectTravel(visit.id, architect, { origin_type: 'home' });
  travel.approveTravel(visit.id, owner, { expected_revision: selected.revision, verified_distance_km: 12, note: 'Checked distance against actual route' });
  return visit;
}

test('policy and coordinates reject malformed/null/boolean input', async () => {
  for (const value of [null, [], false]) {
    assert.throws(() => dispatch.validateTravel(value));
    assert.throws(() => dispatch.validateDispatch(value));
  }
  for (const value of [false, true, [], {}, '', ' ', null, Infinity]) assert.equal(dispatch.pointOK(value, 75), false);
  assert.equal(dispatch.pointOK(0, 0), true); assert.equal(dispatch.pointOK('26.95', '75.75'), true);
  assert.equal((await h.api('PATCH', '/api/dispatch', { travel: null })).status, 400);
  assert.equal((await h.api('PUT', '/api/app/travel/profile', { home_lat: false, home_lng: 75, default_origin: 'home' }, appAuth)).status, 400);
  assert.throws(() => travel.travelAmount(5, { rate_per_km: NaN }));
});

test('finance sees costs without route endpoints, and colleagues cannot view or choose a trip', async () => {
  const visit = fixture(); const choice = await travel.selectTravel(visit.id, architect, { origin_type: 'home' });
  assert.equal(choice.origin_lat, undefined); assert.equal(choice.site_lat, undefined);
  const denied = await h.api('GET', `/api/app/visits/${visit.id}/travel`, undefined, otherAuth); assert.equal(denied.status, 403);
  assert.equal((await h.api('POST', `/api/app/visits/${visit.id}/travel`, { origin_type: 'home' }, otherAuth)).status, 403);
  const rows = await h.api('GET', '/api/travel', undefined, financeAuth); assert.equal(rows.status, 200);
  for (const row of rows.body.trips) for (const field of ['origin_lat', 'origin_lng', 'site_lat', 'site_lng']) assert.equal(Object.hasOwn(row, field), false);
  assert.equal((await h.api('GET', '/api/dispatch', undefined, financeAuth)).status, 403);
  const financeApp = await h.api('POST', '/api/auth/app-login', { phone: '9999000103', pin: '575757' }, { noCookie: true });
  assert.equal((await h.api('GET', `/api/app/visits/${visit.id}/travel`, undefined, bearer(financeApp.body.token))).status, 403);
});

test('claims use capped approved snapshots, ignore caller amounts, and deduplicate', async () => {
  const visit = await approvedVisit();
  const approved = travel.readTravel(visit.id, architect); assert.equal(approved.amount, 100);
  // Later default changes do not rewrite an already approved financial snapshot.
  dispatch.saveDispatchSettings({ travel: { rate_per_km: 100 } }, `user:${owner.id}`);
  const first = await h.api('POST', `/api/app/visits/${visit.id}/travel/claim`, { amount: 999999, distance_km: 500 }, appAuth); assert.equal(first.status, 200);
  assert.equal(h.db.one('SELECT amount FROM expense_claims WHERE id=?', first.body.expense_id).amount, 100);
  const second = await h.api('POST', `/api/app/visits/${visit.id}/travel/claim`, {}, appAuth); assert.equal(second.body.duplicate, true); assert.equal(second.body.expense_id, first.body.expense_id);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM expense_claims WHERE id=?', first.body.expense_id).n, 1);
  dispatch.saveDispatchSettings({ travel: { rate_per_km: 10 } }, `user:${owner.id}`);
});

test('cancelled visits cannot create, approve or claim new reimbursement', async () => {
  const cancelled = fixture('cancelled'); await assert.rejects(travel.selectTravel(cancelled.id, architect, { origin_type: 'home' }), /unavailable/);
  const visit = fixture(); const selected = await travel.selectTravel(visit.id, architect, { origin_type: 'home' });
  h.db.run("UPDATE visits SET status='cancelled' WHERE id=?", visit.id);
  assert.throws(() => travel.approveTravel(visit.id, owner, { expected_revision: selected.revision, accept_estimate: true, note: 'Cancelled trip' }), /current origin/);
  const approved = await approvedVisit(); h.db.run("UPDATE visits SET status='cancelled' WHERE id=?", approved.id);
  assert.throws(() => travel.claimTravel(approved.id, architect), /report/);
});

test('estimate revisions, changed assignments and null verified distance are rejected', async () => {
  const visit = fixture(); const first = await travel.selectTravel(visit.id, architect, { origin_type: 'home' });
  await assert.rejects(travel.selectTravel(visit.id, architect, { origin_type: 'office' }), /estimate changed/);
  const second = await travel.selectTravel(visit.id, architect, { origin_type: 'office', expected_revision: first.revision });
  assert.throws(() => travel.approveTravel(visit.id, owner, { expected_revision: first.revision, verified_distance_km: 10, note: 'Route checked' }), /Estimate changed/);
  assert.throws(() => travel.approveTravel(visit.id, owner, { expected_revision: second.revision, verified_distance_km: null, note: 'Route checked' }), /numeric/);
  h.db.run('UPDATE visits SET architect_id=? WHERE id=?', other.id, visit.id);
  assert.equal(travel.readTravel(visit.id, owner).stale, true);
  assert.throws(() => travel.approveTravel(visit.id, owner, { expected_revision: second.revision, verified_distance_km: 10, note: 'Route checked' }), /current origin/);
});

test('origin, policy and assignment changes during routing cannot commit stale snapshots', async () => {
  const originalFetch = globalThis.fetch; const originalRouting = { ...config.routing };
  try {
    config.routing = { ...config.routing, osrmUrl: 'https://routing-test.invalid' };
    for (const change of ['origin', 'policy', 'assignment']) {
      const visit = fixture(); let release;
      globalThis.fetch = async (url, options) => {
        if (!String(url).startsWith('https://routing-test.invalid')) return originalFetch(url, options);
        return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 20000, duration: 1800 }] }) }); });
      };
      const selection = travel.selectTravel(visit.id, architect, { origin_type: 'home' }); assert.equal(typeof release, 'function');
      if (change === 'origin') dispatch.setLocationProfile(architect.id, { home_lat: 26.951 }, `user:${architect.id}`);
      if (change === 'policy') dispatch.saveDispatchSettings({ travel: { rate_per_km: 11 } }, `user:${owner.id}`);
      if (change === 'assignment') h.db.run('UPDATE visits SET architect_id=? WHERE id=?', other.id, visit.id);
      release(); await assert.rejects(selection, /changed/);
      assert.equal(h.db.one('SELECT 1 FROM visit_travel WHERE visit_id=?', visit.id), undefined);
    }
  } finally { globalThis.fetch = originalFetch; config.routing = originalRouting; }
});

test('coverage is bounded and publishes no precise staff home profile', async () => {
  const coverage = dispatch.coverageGeoJSON(); assert.ok(coverage.features.length > 0 && coverage.features.length <= 6000);
  for (const row of coverage.architects) {
    assert.equal(row.home_lat, undefined); assert.equal(row.home_lng, undefined); assert.equal(row.home_label, undefined);
  }
  assert.throws(() => dispatch.validateDispatch({ resolution: 8, radius_km: 60 }), /too large/);
});
