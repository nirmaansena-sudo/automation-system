// Attendance (GPS evidence, offline sync, review), sweeps, leave → scheduling, expenses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let h; let suresh; let mahesh; let anjali;
before(async () => {
  h = await boot();
  const login = async (phone) => { const r = await h.api('POST', '/api/auth/app-login', { phone, pin: '1234' }, { noCookie: true }); return { headers: { authorization: `Bearer ${r.body.token}` }, noCookie: true }; };
  suresh = await login('9800000104'); mahesh = await login('9800000105'); anjali = await login('9800000102');
});
after(async () => { await h.close(); });

test('check-in at the assigned site is accepted; far away needs manager review; review keeps the original', async () => {
  const at = await h.api('POST', '/api/app/attendance', { kind: 'out', lat: 26.90893, lng: 75.73427, accuracy_m: 12, client_event_id: 'e1' }, suresh);
  assert.equal(at.status, 200, JSON.stringify(at.body));
  const far = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: 26.8, lng: 75.9, accuracy_m: 10, client_event_id: 'e2' }, mahesh);
  assert.equal(far.body.validation, 'needs_review'); assert.ok(far.body.reasons.includes('outside_geofence'));
  const dup = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: 26.8, lng: 75.9, accuracy_m: 10, client_event_id: 'e2' }, mahesh);
  assert.equal(dup.body.duplicate, true, 'same offline event synced twice is stored once');
  const appr = h.db.one("SELECT * FROM approvals WHERE kind='attendance_exception' AND entity_id=? AND status='pending'", far.body.id);
  assert.ok(appr);
  const corrected = new Date(Date.now() - 30 * 60e3).toISOString();
  const r = await h.api('POST', `/api/approvals/${appr.id}/decide`, { decision: 'approve', corrected_time: corrected, note: 'At supplier yard, confirmed by phone' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = h.db.one('SELECT * FROM attendance_events WHERE id=?', far.body.id);
  assert.equal(ev.review_status, 'approved'); assert.equal(ev.validation, 'needs_review', 'original validation kept');
  assert.equal(ev.effective_time, corrected); assert.ok(ev.server_time !== corrected, 'server receipt time kept');
});

test('no GPS or poor accuracy is evidence for review, not automatic absence; offline events keep device time', async () => {
  const noGps = await h.api('POST', '/api/app/attendance', { kind: 'out', client_event_id: 'e3' }, mahesh);
  assert.equal(noGps.body.validation, 'needs_review'); assert.ok(noGps.body.reasons.includes('no_location'));
  const deviceTime = new Date(Date.now() - 3 * 3600e3).toISOString();
  const sync = await h.api('POST', '/api/app/sync', { items: [{ type: 'attendance', kind: 'in', lat: 26.9498, lng: 75.7381, accuracy_m: 20, device_time: deviceTime, client_event_id: 'off-1' }] }, anjali);
  assert.equal(sync.status, 200);
  const ev = h.db.one("SELECT * FROM attendance_events WHERE client_event_id='off-1'");
  assert.equal(ev.offline, 1); assert.equal(ev.effective_time, deviceTime, 'device capture time is used');
  assert.ok(JSON.parse(ev.reasons).includes('offline_sync'));
});

test('evening sweep closes forgotten check-outs for review', async () => {
  // An open session that certainly belongs to today, whatever time the suite runs at.
  const open = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: 26.90893, lng: 75.73427, accuracy_m: 12, client_event_id: 'sweep-open-1' }, suresh);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const before = h.db.one("SELECT COUNT(*) n FROM approvals WHERE kind='attendance_exception' AND title LIKE 'Missing check-out%'").n;
  const r = await h.api('POST', '/api/attendance/sweep/evening');
  assert.equal(r.status, 200);
  assert.ok(r.body.closed >= 1, 'open sessions were closed');
  const after = h.db.one("SELECT COUNT(*) n FROM approvals WHERE kind='attendance_exception' AND title LIKE 'Missing check-out%'").n;
  assert.equal(after - before, r.body.closed);
});

test('approved leave blocks the architect from visit offers; rejection notifies', async () => {
  const day = h.util.addDays(h.util.istDate(), 1);
  const req = await h.api('POST', '/api/app/leave', { type: 'casual', from_date: day, to_date: day, reason: 'family function' }, anjali);
  assert.equal(req.status, 200);
  const a = h.db.one("SELECT * FROM approvals WHERE kind='leave' AND entity_id=? AND status='pending'", req.body.id);
  assert.equal((await h.api('POST', `/api/approvals/${a.id}/decide`, { decision: 'approve' })).status, 200);
  const lead = h.db.one("SELECT * FROM leads WHERE name='Sunita Agarwal'");
  const { eligibleArchitects } = await import('../server/domain/scheduling.js');
  const start = h.util.fromIst(day, '12:00'); const end = new Date(start.getTime() + 3600e3);
  const names = eligibleArchitects(lead, start, end).map((x) => x.user.name);
  assert.ok(!names.includes('Anjali Verma'), 'architect on leave is not offered visits');
  const req2 = await h.api('POST', '/api/app/leave', { type: 'sick', from_date: day, to_date: day }, mahesh);
  const a2 = h.db.one("SELECT * FROM approvals WHERE kind='leave' AND entity_id=? AND status='pending'", req2.body.id);
  await h.api('POST', `/api/approvals/${a2.id}/decide`, { decision: 'reject', note: 'Site pour that day' });
  assert.equal(h.db.one('SELECT status FROM leave_requests WHERE id=?', req2.body.id).status, 'rejected');
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE user_id=(SELECT id FROM users WHERE phone='919800000105') AND title LIKE 'Leave not approved%'"));
});

test('expense: manager approval then finance approval; staff cannot touch other people\'s tasks', async () => {
  const ex = await h.api('POST', '/api/app/expenses', { category: 'fuel', amount: 650, description: 'Site visits' }, mahesh);
  assert.equal(ex.status, 200);
  const a1 = h.db.one("SELECT * FROM approvals WHERE kind='expense' AND entity_id=? AND status='pending'", ex.body.id);
  await h.api('POST', `/api/approvals/${a1.id}/decide`, { decision: 'approve' });
  assert.equal(h.db.one('SELECT status FROM expense_claims WHERE id=?', ex.body.id).status, 'pending_finance');
  const a2 = h.db.one("SELECT * FROM approvals WHERE kind='expense' AND entity_id=? AND status='pending'", ex.body.id);
  await h.api('POST', `/api/approvals/${a2.id}/decide`, { decision: 'approve' });
  assert.equal(h.db.one('SELECT status FROM expense_claims WHERE id=?', ex.body.id).status, 'approved');
  const other = h.db.one("SELECT id FROM tasks WHERE assignee_id=(SELECT id FROM users WHERE phone='919800000104') LIMIT 1");
  const r = await h.api('PATCH', `/api/app/tasks/${other.id}`, { status: 'done' }, mahesh);
  assert.equal(r.status, 403);
});

test('roles: employees cannot use the dashboard API; automation key is required for n8n endpoints', async () => {
  const r = await h.api('GET', '/api/leads', undefined, mahesh);
  assert.equal(r.status, 401);
  const noKey = await h.api('POST', '/api/automation/routines/daily-site-digest/run', {}, { noCookie: true });
  assert.equal(noKey.status, 401);
  const { config } = await import('../server/config.js');
  const ok = await h.api('POST', '/api/automation/routines/daily-site-digest/run', {}, { noCookie: true, headers: { 'x-automation-key': config.automationKey } });
  assert.equal(ok.status, 200);
  const again = await h.api('POST', '/api/automation/routines/daily-site-digest/run', {}, { noCookie: true, headers: { 'x-automation-key': config.automationKey } });
  assert.equal(again.body.skipped, true, 'a routine runs once per period even if triggered twice');
});
