import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './helpers.js';

let h; let owner; let manager; let managerAuth; let employee; let employeeAuth;
const bearer = (token) => ({ noCookie: true, headers: { authorization: `Bearer ${token}` } });
async function dashboard(login, password, mfa_code) {
  const response = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, mfa_code }) });
  return { status: response.status, body: await response.json(), auth: { noCookie: true, headers: { cookie: response.headers.get('set-cookie')?.split(';')[0] || '' } } };
}
async function appLogin(phone, pin, mfa_code) { return h.api('POST', '/api/auth/app-login', { phone, pin, mfa_code }, { noCookie: true }); }
before(async () => {
  h = await boot();
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  h.db.run('UPDATE users SET phone=? WHERE id=?', '919999000001', owner.id);
  const m = await h.api('POST', '/api/team', { name: 'Security manager', role: 'manager', email: 'security-manager@test.local', phone: '9999000002', password: 'manager-password', pin: '626262' });
  assert.equal(m.status, 200); manager = h.db.one('SELECT * FROM users WHERE id=?', m.body.id);
  managerAuth = (await dashboard(manager.email, 'manager-password')).auth;
  const s = await h.api('POST', '/api/team', { name: 'Security employee', role: 'staff', phone: '9999000003', pin: '636363' });
  assert.equal(s.status, 200); employee = h.db.one('SELECT * FROM users WHERE id=?', s.body.id);
  employeeAuth = bearer((await appLogin(employee.phone, '636363')).body.token);
});
after(async () => { await h.close(); h.db.closeDb(); });

test('malformed cookies return 400 and the server continues serving requests', async () => {
  const bad = await h.api('GET', '/health', undefined, { noCookie: true, headers: { cookie: 'ns_session=%ZZ' } });
  assert.equal(bad.status, 400);
  assert.equal((await h.api('GET', '/health', undefined, { noCookie: true })).status, 200);
});

test('forwarded IP headers are used only through explicitly trusted proxy hops', async () => {
  const { clientIp } = await import('../server/lib/http.js');
  const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.6, 10.0.0.5' } };
  assert.equal(clientIp(request), '127.0.0.1');
  assert.equal(clientIp(request, ['127.0.0.1']), '10.0.0.5');
  assert.equal(clientIp(request, ['127.0.0.1', '10.0.0.5']), '203.0.113.6');
});

test('managers cannot reset an owner PIN, and an app PIN cannot change the owner password', async () => {
  const oldHash = h.db.one('SELECT pin_hash FROM users WHERE id=?', owner.id).pin_hash;
  const denied = await h.api('POST', `/api/team/${owner.id}/reset-pin`, {}, managerAuth);
  assert.equal(denied.status, 403); assert.equal(h.db.one('SELECT pin_hash FROM users WHERE id=?', owner.id).pin_hash, oldHash);
  const login = await appLogin('9999000001', 'password123'); assert.equal(login.status, 200);
  const changed = await h.api('POST', '/api/me/password', { password: 'malicious-new-password', current_pin: 'password123' }, bearer(login.body.token));
  assert.equal(changed.status, 400);
  assert.equal((await dashboard('owner@test.local', 'password123')).status, 200);
});

test('PIN changes require the current secret and revoke every existing session', async () => {
  const second = bearer((await appLogin(employee.phone, '636363')).body.token);
  assert.equal((await h.api('POST', '/api/me/password', { pin: '646464' }, employeeAuth)).status, 400);
  assert.equal((await h.api('POST', '/api/me/password', { pin: '646464', current_pin: 'bad' }, employeeAuth)).status, 401);
  assert.equal((await h.api('POST', '/api/me/password', { pin: '646464', current_pin: '636363' }, employeeAuth)).status, 200);
  assert.equal((await h.api('GET', '/api/app/me', undefined, employeeAuth)).status, 401);
  assert.equal((await h.api('GET', '/api/app/me', undefined, second)).status, 401);
  const login = await appLogin(employee.phone, '646464'); assert.equal(login.status, 200); employeeAuth = bearer(login.body.token);
});

test('employees can read assigned project and visit media, not unrelated IDs', async () => {
  const project = h.db.one('SELECT * FROM projects LIMIT 1');
  const lead = h.db.one('SELECT * FROM leads WHERE id=?', project.lead_id);
  const { config } = await import('../server/config.js');
  const file = 'security-fixture.txt'; fs.writeFileSync(path.join(config.mediaDir, file), 'private fixture');
  const media = h.db.insert('media', { file_path: file, mime: 'text/plain', owner_type: 'project', owner_id: project.id, status: 'stored' });
  assert.equal((await h.api('GET', `/media/${media}`, undefined, employeeAuth)).status, 403);
  h.db.run('UPDATE projects SET engineer_id=? WHERE id=?', employee.id, project.id);
  assert.equal((await h.api('GET', `/media/${media}`, undefined, employeeAuth)).status, 200);
  const leadMedia = h.db.insert('media', { file_path: file, mime: 'text/plain', owner_type: 'lead', owner_id: lead.id, status: 'stored' });
  assert.equal((await h.api('GET', `/media/${leadMedia}`, undefined, employeeAuth)).status, 200);
  h.db.run('UPDATE projects SET engineer_id=NULL WHERE id=?', project.id);
  assert.equal((await h.api('GET', `/media/${leadMedia}`, undefined, employeeAuth)).status, 403);
  assert.equal((await h.api('GET', `/media/${media}`, undefined, managerAuth)).status, 200);
});

test('invalid GPS, event ownership, leave dates and expense values are rejected', async () => {
  const invalid = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: 'NaN', lng: 75 }, employeeAuth);
  assert.equal(invalid.status, 400);
  const { recordAttendance, submitExpense } = await import('../server/domain/staff.js');
  const foreignId = 'security-owned-event';
  h.db.tx(() => recordAttendance(manager.id, { kind: 'in', client_event_id: foreignId }));
  assert.equal((await h.api('POST', '/api/app/attendance', { kind: 'in', client_event_id: foreignId }, employeeAuth)).status, 400);
  assert.equal((await h.api('POST', '/api/app/leave', { from_date: '2026-02-30', to_date: '2026-03-01' }, employeeAuth)).status, 400);
  assert.equal((await h.api('POST', '/api/app/expenses', { category: 'fuel', amount: 'Infinity' }, employeeAuth)).status, 400);
  assert.ok(submitExpense(employee.id, { category: 'fuel', amount: Infinity }).error);
});

test('TOTP uses the RFC test vector and MFA enrollment enforces one-time factors', async () => {
  const { totpCode } = await import('../server/lib/mfa.js');
  assert.equal(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  const setup = await h.api('POST', '/api/me/mfa/setup', { current_password: 'manager-password' }, managerAuth);
  assert.equal(setup.status, 200); assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  const enrolled = await h.api('POST', '/api/me/mfa/enable', { current_password: 'manager-password', mfa_code: totpCode(setup.body.secret) }, managerAuth);
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body)); assert.equal(enrolled.body.recovery_codes.length, 8);
  const encrypted = h.db.one('SELECT secret FROM account_security WHERE user_id=?', manager.id).secret;
  assert.notEqual(encrypted, setup.body.secret); assert.ok(!encrypted.includes(setup.body.secret));
  assert.equal((await dashboard(manager.email, 'manager-password')).body.mfa_required, true);
  assert.equal((await dashboard(manager.email, 'manager-password', totpCode(setup.body.secret))).status, 401, 'the enrollment code cannot be replayed');
  const recovery = enrolled.body.recovery_codes[0];
  const login = await dashboard(manager.email, 'manager-password', recovery); assert.equal(login.status, 200); managerAuth = login.auth;
  assert.equal((await dashboard(manager.email, 'manager-password', recovery)).status, 401, 'recovery codes work once');
  assert.equal((await appLogin(manager.phone, '626262')).body.mfa_required, true, 'PIN login also requires MFA');
  const changed = await h.api('POST', '/api/me/password', { password: 'manager-new-password', current_password: 'manager-password', mfa_code: enrolled.body.recovery_codes[1] }, managerAuth);
  assert.equal(changed.status, 200); assert.equal((await h.api('GET', '/api/me', undefined, managerAuth)).status, 401);
  const relogin = await dashboard(manager.email, 'manager-new-password', enrolled.body.recovery_codes[2]); assert.equal(relogin.status, 200); managerAuth = relogin.auth;
  assert.equal((await h.api('GET', '/api/data/tables/account_security', undefined, managerAuth)).status, 404);
});

test('settings reject malformed values and preserve valid compound settings', async () => {
  const { validateSettings } = await import('../server/lib/settings-validation.js');
  const { DEFAULT_SETTINGS } = await import('../server/core/base.js');
  assert.doesNotThrow(() => validateSettings(DEFAULT_SETTINGS));
  for (const patch of [null, [], { business_hours: null }, { office: { lat: null } }, { visit_duration_min: -1 }, { attendance: {} }, { default_payment_schedules: { design: [{ name: 'Pay', pct: 50 }] } }]) assert.throws(() => validateSettings(patch));
  assert.throws(() => validateSettings(JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.equal((await h.api('PATCH', '/api/settings', { travel: null })).status, 400);
  assert.equal((await h.api('PATCH', '/api/settings', { dispatch: null })).status, 400);
  assert.equal((await h.api('PATCH', `/api/team/${owner.id}`, { password: 'bypass-should-fail' })).status, 400);
});

test('invoice edits validate URLs and real dates, preserve paid records and audit changes', async () => {
  const project = h.db.one('SELECT id FROM projects LIMIT 1');
  const unpaid = h.db.insert('invoices', { ref: 'SEC-INV-UNPAID', project_id: project.id, title: 'Invoice fixture', amount: 100, paid_amount: 0, status: 'issued' });
  const paid = h.db.insert('invoices', { ref: 'SEC-INV-PAID', project_id: project.id, title: 'Paid fixture', amount: 100, paid_amount: 100, status: 'paid' });
  for (const body of [{ payment_link: 'javascript:alert(1)' }, { payment_link: 'https://user:secret@example.test/pay' }, { due_date: '2026-02-30' }]) assert.equal((await h.api('PATCH', `/api/invoices/${unpaid}`, body)).status, 400);
  assert.equal((await h.api('PATCH', '/api/invoices/999999', { due_date: '2026-12-01' })).status, 404);
  assert.equal((await h.api('PATCH', `/api/invoices/${paid}`, { status: 'cancelled' })).status, 400);
  const valid = await h.api('PATCH', `/api/invoices/${unpaid}`, { due_date: '2026-12-01', payment_link: 'https://payments.example.test/invoice' });
  assert.equal(valid.status, 200); assert.equal(h.db.one('SELECT due_date FROM invoices WHERE id=?', unpaid).due_date, '2026-12-01');
  assert.ok(h.db.one("SELECT 1 FROM audit_log WHERE action='invoice.updated' AND entity_id=?", project.id));
});

test('erasure removes raw payloads and revoked project links, and is idempotent', async () => {
  const { eraseContact } = await import('../server/domain/privacy.js');
  const c = h.db.insert('contacts', { wa_id: '919991112223', name: 'Private Person', kind: 'client', created_at: h.util.nowIso() });
  const lead = h.db.insert('leads', { contact_id: c, ref: 'SEC-ERASE-1', name: 'Private Person', phone: '919991112223', address: 'Private road', status: 'lost' });
  const project = h.db.insert('projects', { ref: 'SEC-PROJECT-1', client_contact_id: c, lead_id: lead, client_phone: '919991112223', client_name: 'Private Person', status: 'closed', public_token: 'private-project-link' });
  const order = h.db.insert('purchase_orders', { ref: 'SEC-PO-1', project_id: project, material: 'Private Person cement', unit: 'bag', supplier: 'Supplier for Private Person', quantity_milli: 1000, unit_cost_paise: 100, note: 'Private Person address', created_by: owner.id, created_at: h.util.nowIso(), updated_at: h.util.nowIso() });
  const movement = h.db.insert('stock_movements', { order_id: order, kind: 'receive', quantity_milli: 1000, reference: 'Private Person receipt', note: 'Private road', actor_id: owner.id, created_at: h.util.nowIso() });
  const inbound = h.db.insert('inbound_events', { provider: 'website', kind: 'form', dedupe_key: 'erase-form', payload: JSON.stringify({ mobile: '9991112223', name: 'Private Person' }) });
  const job = h.db.insert('outbox', { contact_id: c, to_wa_id: '919991112223', kind: 'test', payload: JSON.stringify({ text: 'Private Person' }), status: 'queued' });
  h.db.insert('conversations', { contact_id: c, ctx: JSON.stringify({ name: 'Private Person' }), last_message_preview: 'Private Person' });
  const result = h.db.tx(() => eraseContact(c, owner)); assert.equal(result.ok, true);
  assert.equal(h.db.one('SELECT payload FROM inbound_events WHERE id=?', inbound).payload, '{}');
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', job).status, 'cancelled');
  assert.equal(h.db.one('SELECT public_token FROM projects WHERE id=?', project).public_token, null);
  assert.equal(h.db.one('SELECT ctx FROM conversations WHERE contact_id=?', c).ctx, '{}');
  assert.equal(h.db.one('SELECT reference FROM stock_movements WHERE id=?', movement).reference, `ERASED-${movement}`);
  const erasedOrder = h.db.one('SELECT * FROM purchase_orders WHERE id=?', order); assert.equal(erasedOrder.note, null); assert.ok(!erasedOrder.material.includes('Private Person'));
  assert.equal(h.db.tx(() => eraseContact(c, owner)).already_erased, true);
});

test('whitespace, email aliases and spoofed IPs cannot bypass account throttling', async () => {
  const created = await h.api('POST', '/api/team', { name: 'Rate test', email: 'rate@test.local', phone: '9999000004', role: 'manager', password: 'rate-password' });
  assert.equal(created.status, 200);
  for (let n = 0; n < 6; n++) {
    const r = await h.api('POST', '/api/auth/login', { login: `${' '.repeat(n)}rate@test.local`, password: 'bad-password' }, { noCookie: true, headers: { 'x-forwarded-for': `203.0.113.${n + 1}` } });
    assert.equal(r.status, 401);
  }
  const locked = await h.api('POST', '/api/auth/login', { login: '9999000004', password: 'rate-password' }, { noCookie: true, headers: { 'x-forwarded-for': '198.51.100.99' } });
  assert.equal(locked.status, 429);
});
