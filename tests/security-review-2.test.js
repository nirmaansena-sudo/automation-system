// Regression tests for the second pass of the November 2026 review (docs/SECURITY-REVIEW.md, round 2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './helpers.js';

let h; let owner; let manager; let managerAuth; let financeAuth; let staffUser; let staffToken; let managerToken;
async function post(p, body, headers = {}) {
  const r = await fetch(h.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns': '1', ...headers }, body: JSON.stringify(body) });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, cookie: r.headers.get('set-cookie')?.split(';')[0] || '', headers: r.headers };
}
const as = (cookie) => ({ noCookie: true, headers: { cookie } });
const bearer = (token) => ({ noCookie: true, headers: { authorization: `Bearer ${token}` } });

before(async () => {
  h = await boot();
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  const m = await h.api('POST', '/api/team', { name: 'R2 manager', role: 'manager', email: 'r2-manager@test.local', phone: '9822000001', password: 'r2-manager-pass', pin: '717171' });
  manager = h.db.one('SELECT * FROM users WHERE id=?', m.body.id);
  managerAuth = as((await post('/api/auth/login', { login: manager.email, password: 'r2-manager-pass' })).cookie);
  managerToken = (await post('/api/auth/app-login', { phone: manager.phone, pin: '717171' })).body.token;
  await h.api('POST', '/api/team', { name: 'R2 finance', role: 'finance', email: 'r2-finance@test.local', password: 'r2-finance-pass' });
  financeAuth = as((await post('/api/auth/login', { login: 'r2-finance@test.local', password: 'r2-finance-pass' })).cookie);
  const s = await h.api('POST', '/api/team', { name: 'R2 staff', role: 'staff', phone: '9822000003', pin: '737373', notes: 'Private HR note: probation' });
  staffUser = h.db.one('SELECT * FROM users WHERE id=?', s.body.id);
  staffToken = (await post('/api/auth/app-login', { phone: staffUser.phone, pin: '737373' })).body.token;
});
after(async () => { await h.close(); h.db.closeDb(); });

test('stored XSS: milestone fields are validated and the client page has a strict CSP', async () => {
  const ms = h.db.one('SELECT m.*, p.public_token FROM milestones m JOIN projects p ON p.id=m.project_id ORDER BY m.id LIMIT 1');
  const evil = '<img src=x onerror=alert(document.cookie)>';
  assert.equal((await h.api('PATCH', `/api/milestones/${ms.id}`, { progress: evil }, managerAuth)).status, 400);
  assert.equal((await h.api('PATCH', `/api/milestones/${ms.id}`, { planned_end: evil }, managerAuth)).status, 400);
  assert.equal((await h.api('PATCH', `/api/milestones/${ms.id}`, { name: 'Roof slab', progress: 40 }, managerAuth)).status, 200);
  // Even a bad value already stored in the database is rendered as a number.
  h.db.run("UPDATE milestones SET status='in_progress', progress=? WHERE id=?", evil, ms.id);
  const page = await fetch(`${h.base}/p/${ms.public_token}`);
  const body = await page.text();
  assert.equal(page.status, 200);
  assert.doesNotMatch(body, /onerror=/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const admin = await fetch(`${h.base}/admin/`);
  assert.match(admin.headers.get('content-security-policy'), /script-src 'self'/); await admin.text();
});

test('stored XSS: payment stage names cannot contain markup', async () => {
  const r = await h.api('PATCH', '/api/settings', { default_payment_schedules: { turnkey: [{ name: '<img src=x onerror=alert(1)>', pct: 100 }] } }, managerAuth);
  assert.equal(r.status, 400);
});

test('client buttons act only on the pressing client’s own records', async () => {
  const ms = h.db.one('SELECT m.*, p.client_contact_id FROM milestones m JOIN projects p ON p.id=m.project_id WHERE p.client_contact_id IS NOT NULL ORDER BY m.id LIMIT 1');
  h.db.run("UPDATE milestones SET status='client_review' WHERE id=?", ms.id);
  await h.say('919833000099', 'Hi', 'Stranger');
  await h.press('919833000099', `MS:A:${ms.id}`);
  assert.equal(h.db.one('SELECT status FROM milestones WHERE id=?', ms.id).status, 'client_review', 'a stranger cannot sign off');
  assert.ok(h.db.one("SELECT 1 FROM audit_log WHERE action='bot.foreign_button_rejected'"));
  const client = h.db.one('SELECT wa_id FROM contacts WHERE id=?', ms.client_contact_id);
  await h.press(client.wa_id, `MS:A:${ms.id}`);
  assert.notEqual(h.db.one('SELECT status FROM milestones WHERE id=?', ms.id).status, 'client_review', 'the real client can');
});

test('the webhook URL needs the key even in simulator mode', async () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'X', changes: [{ field: 'messages', value: { messages: [{ from: '919833000777', id: 'wamid.R2SIM', timestamp: '1', type: 'text', text: { body: 'hi' } }] } }] }] });
  const noKey = await fetch(`${h.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(noKey.status, 401); await noKey.text();
  const key = (await h.api('GET', '/api/settings')).body.system.secrets.verifyToken;
  const withKey = await fetch(`${h.base}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns-webhook-key': key }, body });
  assert.equal(withKey.status, 200); await withKey.text();
});

test('anonymous uploads are refused before the body is read', async () => {
  const big = Buffer.alloc(30 * 1024 * 1024, 0x61);
  const started = Date.now();
  let status;
  try { const r = await fetch(`${h.base}/api/app/visits/1/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }); status = r.status; await r.text(); } catch { status = 'closed'; }
  assert.ok(status === 401 || status === 'closed', `got ${status}`);
  assert.ok(Date.now() - started < 10000);
});

test('attendance: live check-ins use the server clock; back-dated offline items go to review', async () => {
  const hourAgo = new Date(Date.now() - 60 * 60000).toISOString();
  const office = (await h.api('GET', '/api/settings')).body.settings.office;
  const live = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: office.lat, lng: office.lng, accuracy_m: 10, device_time: hourAgo, offline: true }, bearer(staffToken));
  assert.equal(live.status, 200);
  const ev = h.db.one('SELECT * FROM attendance_events WHERE id=?', live.body.id);
  assert.ok(Math.abs(Date.parse(ev.effective_time) - Date.now()) < 60000, 'server time, not the claimed phone time');
  const synced = await h.api('POST', '/api/app/sync', { items: [{ type: 'attendance', kind: 'out', lat: office.lat, lng: office.lng, accuracy_m: 10, device_time: new Date(Date.now() - 30 * 60000).toISOString(), client_event_id: 'r2-offline-1' }] }, bearer(staffToken));
  assert.equal(synced.body[0].validation, 'needs_review');
  assert.ok(synced.body[0].reasons.includes('offline_backdated'));
  const noAccuracy = await h.api('POST', '/api/app/attendance', { kind: 'out', lat: office.lat, lng: office.lng }, bearer(staffToken));
  assert.ok(noAccuracy.body.reasons.includes('poor_accuracy'), 'missing accuracy is not a free 50 m');
});

test('expenses: nobody approves their own claim, and manager then a different finance person must approve', async () => {
  const mine = await h.api('POST', '/api/app/expenses', { category: 'food', amount: 250 }, bearer(managerToken));
  assert.equal(mine.status, 200);
  const own = h.db.one("SELECT id FROM approvals WHERE kind='expense' AND entity_id=?", mine.body.id);
  assert.equal((await h.api('POST', `/api/approvals/${own.id}/decide`, { decision: 'approve' }, managerAuth)).status, 400, 'own claim');

  const claim = await h.api('POST', '/api/app/expenses', { category: 'fuel', amount: 300 }, bearer(staffToken));
  const first = h.db.one("SELECT id FROM approvals WHERE kind='expense' AND entity_id=? AND status='pending'", claim.body.id);
  assert.equal((await h.api('POST', `/api/approvals/${first.id}/decide`, { decision: 'approve' }, financeAuth)).status, 400, 'finance cannot do the manager stage');
  assert.equal((await h.api('POST', `/api/approvals/${first.id}/decide`, { decision: 'approve' }, managerAuth)).status, 200);
  const second = h.db.one("SELECT id FROM approvals WHERE kind='expense' AND entity_id=? AND status='pending'", claim.body.id);
  assert.equal((await h.api('POST', `/api/approvals/${second.id}/decide`, { decision: 'approve' }, managerAuth)).status, 400, 'the manager cannot also do the finance check');
  assert.equal((await h.api('POST', `/api/approvals/${second.id}/decide`, { decision: 'approve' }, financeAuth)).status, 200);

  assert.equal((await h.api('POST', '/api/app/expenses', { category: 'food', amount: 10.005 }, bearer(staffToken))).status, 400, 'sub-paise amounts');
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  assert.equal((await h.api('POST', '/api/app/expenses', { category: 'food', amount: 10, claim_date: tomorrow }, bearer(staffToken))).status, 400, 'future claim date');
});

test('a manager’s PIN app session has only employee rights', async () => {
  const lead = h.db.one('SELECT id FROM leads ORDER BY id LIMIT 1');
  const { config } = await import('../server/config.js');
  fs.writeFileSync(path.join(config.mediaDir, 'r2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const photo = h.db.insert('media', { mime: 'image/jpeg', file_path: 'r2.jpg', owner_type: 'lead', owner_id: lead.id, uploaded_by: 'client', status: 'stored', created_at: new Date().toISOString() });
  const viaApp = await fetch(`${h.base}/media/${photo}`, { headers: { authorization: `Bearer ${managerToken}` } });
  assert.equal(viaApp.status, 403); await viaApp.arrayBuffer();
  const viaDashboard = await fetch(`${h.base}/media/${photo}`, { headers: managerAuth.headers });
  assert.equal(viaDashboard.status, 200); await viaDashboard.arrayBuffer();
  const visit = h.db.one('SELECT id FROM visits ORDER BY id LIMIT 1');
  assert.equal((await h.api('GET', `/api/app/visits/${visit.id}/travel`, undefined, bearer(managerToken))).status, 403);
  const me = await h.api('GET', '/api/me', undefined, bearer(managerToken));
  assert.equal(me.body.user.role, 'staff'); assert.equal(me.body.dashboard, false);
});

test('backups: only the owner starts one, at most every 10 minutes', async () => {
  assert.equal((await h.api('POST', '/api/routines/backup/run', { force: true }, managerAuth)).status, 403);
  assert.equal((await h.api('POST', '/api/data/backup', {})).status, 200);
  assert.equal((await h.api('POST', '/api/data/backup', {})).status, 429);
  assert.equal((await h.api('POST', '/api/routines/backup/run', { force: true })).status, 429);
});

test('site logs: dates, stages and event ids are validated', async () => {
  const p = h.db.one("SELECT * FROM projects WHERE status NOT IN ('closed','cancelled') AND supervisor_id IS NOT NULL ORDER BY id LIMIT 1");
  const sup = h.db.one('SELECT * FROM users WHERE id=?', p.supervisor_id);
  h.db.run('UPDATE users SET pin_hash=? WHERE id=?', (await import('../server/lib/util.js')).hashSecret('747474'), sup.id);
  const t = bearer((await post('/api/auth/app-login', { phone: sup.phone, pin: '747474' })).body.token);
  const base = { work_done: 'Shuttering for slab', lat: p.site_lat, lng: p.site_lng };
  assert.equal((await h.api('POST', `/api/app/projects/${p.id}/logs`, { ...base, log_date: 'not-a-date' }, t)).status, 400);
  assert.equal((await h.api('POST', `/api/app/projects/${p.id}/logs`, { ...base, log_date: '2020-01-01' }, t)).status, 400);
  assert.equal((await h.api('POST', `/api/app/projects/${p.id}/logs`, { ...base, milestone_id: 999999, progress: 50 }, t)).status, 400, 'stage of another project');
  assert.equal((await h.api('POST', `/api/app/projects/${p.id}/logs`, { ...base, progress: 'lots' }, t)).status, 400);
  const ok = await h.api('POST', `/api/app/projects/${p.id}/logs`, { ...base, client_event_id: 'r2-log-1' }, t);
  assert.equal(ok.status, 200);
  const res = (await import('../server/domain/projects.js')).addSiteLog(p.id, staffUser.id, { ...base, client_event_id: 'r2-log-1' });
  assert.match(res.error, /another account/);
});

test('payments: one bank reference cannot be recorded twice under different methods', async () => {
  const project = h.db.one('SELECT id FROM projects ORDER BY id LIMIT 1');
  const created = await h.api('POST', `/api/projects/${project.id}/invoices`, { amount: 5000, title: 'Extra work' });
  assert.equal(created.status, 200);
  assert.equal((await h.api('POST', `/api/projects/${project.id}/invoices`, { amount: 5000, title: 'Extra work' })).status, 400, 'double submit blocked');
  const inv = h.db.one('SELECT * FROM invoices WHERE id=?', created.body.id);
  assert.equal((await h.api('POST', `/api/invoices/${inv.id}/payments`, { amount: 1, method: 'bank', reference: 'UTR-R2-777' })).status, 200);
  const again = await h.api('POST', `/api/invoices/${inv.id}/payments`, { amount: 1, method: 'upi', reference: 'utr-r2-777' });
  assert.equal(again.status, 400);
});

test('employees do not see HR notes; finance does not see raw GPS events', async () => {
  const me = await h.api('GET', '/api/app/me', undefined, bearer(staffToken));
  assert.equal(me.body.user.notes, undefined);
  assert.equal((await h.api('GET', '/api/attendance/events', undefined, financeAuth)).status, 403);
  const detail = await h.api('GET', `/api/team/${staffUser.id}`, undefined, financeAuth);
  assert.ok(detail.body.events.every((e) => e.lat === null && e.lng === null));
});
