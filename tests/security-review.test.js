// Regression tests for the November 2026 red-team review (docs/SECURITY-REVIEW.md).
// Each test reproduces an attack that used to work and checks that it now fails.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './helpers.js';

let h; let owner; let manager; let managerAuth; let finance; let financeAuth;
// The test server sits "behind" a trusted proxy on 127.0.0.0/8 (CIDR form), so
// X-Forwarded-For decides the client address, as with Caddy in production.
const from = (ip) => ({ 'x-forwarded-for': ip });
async function post(p, body, headers = {}) {
  const r = await fetch(h.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns': '1', ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, cookie: r.headers.get('set-cookie')?.split(';')[0] || '' };
}
const dashboardLogin = (login, password, ip = '198.51.100.20') => post('/api/auth/login', { login, password }, from(ip));
const appLogin = (phone, pin, ip = '198.51.100.21') => post('/api/auth/app-login', { phone, pin }, from(ip));
const as = (cookie) => ({ noCookie: true, headers: { cookie } });

before(async () => {
  h = await boot({ TRUSTED_PROXY_IPS: '127.0.0.0/8' });
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  const m = await h.api('POST', '/api/team', { name: 'Review manager', role: 'manager', email: 'review-manager@test.local', phone: '9811000001', password: 'manager-pass-1', pin: '615243' });
  assert.equal(m.status, 200); manager = h.db.one('SELECT * FROM users WHERE id=?', m.body.id);
  managerAuth = as((await dashboardLogin(manager.email, 'manager-pass-1')).cookie);
  const f = await h.api('POST', '/api/team', { name: 'Review finance', role: 'finance', email: 'review-finance@test.local', phone: '9811000002', password: 'finance-pass-1' });
  assert.equal(f.status, 200); finance = h.db.one('SELECT * FROM users WHERE id=?', f.body.id);
  financeAuth = as((await dashboardLogin(finance.email, 'finance-pass-1')).cookie);
});
after(async () => { await h.close(); h.db.closeDb(); });

test('F1: a PIN-based app session cannot download the business export; a dashboard session can', async () => {
  const login = await appLogin(manager.phone, '615243');
  assert.equal(login.status, 200, 'managers may still use the employee app');
  for (const suffix of ['inventory', 'business.json', 'business.zip']) {
    const r = await fetch(`${h.base}/api/exports/${suffix}`, { headers: { authorization: `Bearer ${login.body.token}` } });
    assert.equal(r.status, 401, `app bearer must not reach /api/exports/${suffix}`); await r.arrayBuffer();
  }
  const ok = await h.api('GET', '/api/exports/inventory', undefined, managerAuth);
  assert.equal(ok.status, 200, 'the same manager with a dashboard login still can');
});

test('F2: trusted proxy ranges (CIDR) give each visitor their own address, so one attacker cannot lock everyone out', async () => {
  for (let i = 0; i < 32; i++) await dashboardLogin(`nobody${i}@test.local`, 'wrong-password', '203.0.113.66');
  const blocked = await dashboardLogin(owner.email, 'password123', '203.0.113.66');
  assert.equal(blocked.status, 429, 'the attacking address is throttled');
  const others = await dashboardLogin(owner.email, 'password123', '198.51.100.77');
  assert.equal(others.status, 200, 'everyone else can still log in');
});

test('F2: clientIp trusts CIDR ranges and flags an unconfigured proxy', async () => {
  const { clientIp, trustMatcher, proxyWarning } = await import('../server/lib/http.js');
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('172.30.97.10', '203.0.113.5'), ['172.30.97.0/24']), '203.0.113.5');
  assert.equal(clientIp(req('172.30.98.10', '203.0.113.5'), ['172.30.97.0/24']), '172.30.98.10', 'outside the range is not trusted');
  assert.equal(clientIp(req('203.0.113.9', '10.0.0.1'), ['172.30.97.0/24']), '203.0.113.9', 'a public client cannot spoof its address');
  assert.equal(trustMatcher(['not-an-ip', '10.0.0.0/99'])('10.0.0.1'), false, 'invalid entries are ignored');
  clientIp(req('172.18.0.5', '203.0.113.5'), []);
  assert.equal(proxyWarning()?.remote !== undefined, true, 'X-Forwarded-For from an untrusted private address is reported');
  const { healthReport } = await import('../server/core/routines.js');
  assert.ok(healthReport().warnings.some((w) => /TRUSTED_PROXY_IPS/.test(w)), 'the dashboard health panel shows the proxy warning');
});

test('F3: a manager cannot take over or create manager/finance accounts; the owner can, and people are told', async () => {
  const deny = async (method, p, body) => { const r = await h.api(method, p, body, managerAuth); assert.equal(r.status, 403, `${method} ${p} ${JSON.stringify(body)}`); };
  await deny('PATCH', `/api/team/${finance.id}`, { password: 'attacker-pass-1' });
  await deny('PATCH', `/api/team/${finance.id}`, { role: 'staff' });
  await deny('PATCH', `/api/team/${finance.id}`, { phone: '9811000099' });
  await deny('PATCH', `/api/team/${finance.id}`, { email: 'attacker@test.local' });
  await deny('PATCH', `/api/team/${finance.id}`, { active: false });
  await deny('POST', `/api/team/${finance.id}/reset-pin`, {});
  await deny('POST', '/api/team', { name: 'Shadow manager', role: 'manager', email: 'shadow@test.local', password: 'shadow-pass-1' });
  const architect = h.db.one("SELECT * FROM users WHERE role='architect' AND active=1 LIMIT 1");
  await deny('PATCH', `/api/team/${architect.id}`, { role: 'manager' });
  assert.equal((await dashboardLogin(finance.email, 'attacker-pass-1')).status, 401, 'the finance password is unchanged');

  // Day-to-day edits that are not about login or access still work for managers.
  assert.equal((await h.api('PATCH', `/api/team/${finance.id}`, { shift_start: '10:00', role: 'finance', email: finance.email }, managerAuth)).status, 200);
  assert.equal((await h.api('PATCH', `/api/team/${architect.id}`, { phone: '9811000123' }, managerAuth)).status, 200, 'managers still manage field staff');
  assert.equal((await h.api('POST', `/api/team/${architect.id}/reset-pin`, {}, managerAuth)).status, 200);
  const notice = h.db.one("SELECT * FROM notifications WHERE user_id=? AND title='Your account was changed' ORDER BY id DESC LIMIT 1", architect.id);
  assert.match(notice.body, /phone number|app PIN/);
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE user_id=? AND title LIKE 'Account changed:%'", owner.id), 'the owner is told about changes made by others');

  // The owner keeps full control.
  assert.equal((await h.api('PATCH', `/api/team/${finance.id}`, { password: 'finance-pass-2' })).status, 200);
  assert.equal((await dashboardLogin(finance.email, 'finance-pass-2')).status, 200);
  financeAuth = as((await dashboardLogin(finance.email, 'finance-pass-2')).cookie);
});

test('F4: logins for unknown and known accounts take the same time', async () => {
  const staff = h.db.all("SELECT phone FROM users WHERE active=1 AND phone IS NOT NULL AND role IN ('staff','supervisor','engineer') LIMIT 5").map((u) => u.phone);
  const time = async (phone, i) => { const s = performance.now(); await appLogin(phone, '000000', `192.0.2.${10 + i}`); return performance.now() - s; };
  const known = []; const unknown = [];
  for (let i = 0; i < 5; i++) { known.push(await time(staff[i % staff.length], i)); unknown.push(await time(`98777700${10 + i}`, 20 + i)); }
  const median = (a) => [...a].sort((x, y) => x - y)[2];
  assert.ok(median(unknown) > median(known) * 0.5, `unknown ${median(unknown).toFixed(1)} ms vs known ${median(known).toFixed(1)} ms`);
});

test('F5: a trip from a home pin the architect moved recently needs an explicit manager check', async () => {
  const dispatch = await import('../server/domain/dispatch.js');
  const travel = await import('../server/domain/travel.js');
  const architect = h.db.one("SELECT * FROM users WHERE role='architect' AND active=1 ORDER BY id LIMIT 1");
  dispatch.setLocationProfile(architect.id, { home_lat: 26.95, home_lng: 75.75, default_origin: 'home' }, 'user:' + owner.id);
  const before = h.db.one('SELECT * FROM architect_locations WHERE user_id=?', architect.id);
  assert.equal(before.home_changed_by, `user:${owner.id}`);
  const moved = dispatch.setLocationProfile(architect.id, { home_lat: 27.25, home_lng: 75.75 }, `user:${architect.id}`);
  assert.ok(moved.home_moved_km > 30 && moved.home_moved_km < 35, `moved ${moved.home_moved_km} km`);
  const alert = h.db.one("SELECT * FROM notifications WHERE title LIKE 'Home pin changed%' ORDER BY id DESC LIMIT 1");
  assert.match(alert.body, /Moved 3\d\.\d km/);
  const audit = h.db.one("SELECT data FROM audit_log WHERE action='travel.origin_updated' ORDER BY id DESC LIMIT 1").data;
  assert.doesNotMatch(audit, /27\.25|75\.75/, 'coordinates stay out of the audit log');

  // A visit whose site is known, confirmed and assigned to this architect.
  const visit = h.db.one("SELECT v.* FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? AND l.site_lat IS NOT NULL ORDER BY v.id LIMIT 1", architect.id)
    || (() => { const v = h.db.one("SELECT v.* FROM visits v JOIN leads l ON l.id=v.lead_id WHERE l.site_lat IS NOT NULL ORDER BY v.id LIMIT 1"); h.db.run('UPDATE visits SET architect_id=? WHERE id=?', architect.id, v.id); return h.db.one('SELECT * FROM visits WHERE id=?', v.id); })();
  h.db.run("UPDATE visits SET status='confirmed' WHERE id=?", visit.id);
  const ownerRow = h.db.one('SELECT * FROM users WHERE id=?', owner.id);
  dispatch.saveDispatchSettings({ travel: { ...dispatch.travelSettings(), rate_per_km: 8 } }, 'test');
  const chosen = await travel.selectTravel(visit.id, architect, { origin_type: 'home' });
  assert.ok(chosen.home_change, 'the estimate carries the warning');
  assert.equal(chosen.home_change.by_self, true);
  assert.throws(() => travel.approveTravel(visit.id, ownerRow, { expected_revision: chosen.revision, verified_distance_km: 40, note: 'Checked route' }), /home pin was changed/);
  const ok = travel.approveTravel(visit.id, ownerRow, { ack_home_change: true, expected_revision: chosen.revision, verified_distance_km: 40, note: 'Checked route and new address' });
  assert.equal(ok.status, 'approved');
});

test('F6: the website form secret is accepted only as a header', async () => {
  const secret = (await h.api('GET', '/api/settings')).body.system.secrets.websiteSecret;
  const body = { mobile: '9811000777', name: 'URL secret test', reference_id: 'NS-JPR-2026-9101' };
  const viaUrl = await fetch(`${h.base}/api/public/website-enquiry?secret=${encodeURIComponent(secret)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(viaUrl.status, 401); await viaUrl.arrayBuffer();
  const viaHeader = await fetch(`${h.base}/api/public/website-enquiry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-website-secret': secret }, body: JSON.stringify(body) });
  assert.equal(viaHeader.status, 200); await viaHeader.arrayBuffer();
});

test('F6: finance can open bills, not client chat photos or attendance selfies', async () => {
  const { config } = await import('../server/config.js');
  fs.writeFileSync(path.join(config.mediaDir, 'review-test.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const add = (owner_type) => h.db.insert('media', { mime: 'image/jpeg', file_path: 'review-test.jpg', owner_type, owner_id: 1, uploaded_by: 'client', status: 'stored', created_at: new Date().toISOString() });
  const bill = add('expense'); const chatPhoto = add('lead'); const selfie = add('attendance');
  const get = async (id, auth) => { const r = await fetch(`${h.base}/media/${id}`, { headers: auth.headers }); await r.arrayBuffer(); return r.status; };
  assert.equal(await get(bill, financeAuth), 200);
  assert.equal(await get(chatPhoto, financeAuth), 403);
  assert.equal(await get(selfie, financeAuth), 403);
  assert.equal(await get(chatPhoto, managerAuth), 200, 'managers keep access');
});

test('F6: the health panel asks the owner to download the backup key until it is saved', async () => {
  const run = await h.api('POST', '/api/data/backup', {});
  assert.equal(run.status, 200);
  const warn = () => h.api('GET', '/api/settings').then((r) => r.body.system.health.warnings.some((w) => /backup key/.test(w)));
  assert.equal(await warn(), true);
  const key = await fetch(`${h.base}/api/data/backup-key`, { headers: { cookie: (await dashboardLogin(owner.email, 'password123', '198.51.100.90')).cookie } });
  assert.equal(key.status, 200); await key.arrayBuffer();
  assert.equal(await warn(), false);
});
