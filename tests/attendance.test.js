import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.js';

let h, staff, owner, day, it, architect, manager, finance;
before(async () => {
  h = await boot(); staff = await import('../server/domain/staff.js'); owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  day = h.util.addDays(h.util.istDate(), -1);
  const create = async (data) => {
    const response = await h.api('POST', '/api/team', { shift_start: '09:00', shift_end: '18:00', weekly_off: [], ...data });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    h.db.update('users', response.body.id, { created_at: h.util.fromIst(day, '00:00').toISOString() });
    return { id: response.body.id, pin: response.body.pin, ...data };
  };
  it = await create({ name: 'Office IT Executive', role: 'staff', department: 'IT', title: 'IT Executive', work_mode: 'office', phone: '9800000301' });
  architect = await create({ name: 'Design Architect', role: 'architect', department: 'Design', title: 'Architect & Designer', work_mode: 'field', phone: '9800000302' });
  manager = await create({ name: 'Office Manager', role: 'manager', department: 'Office', work_mode: 'office', email: 'attendance-manager@test.local', password: 'ManagerTest123!' });
  finance = await create({ name: 'Accounts Employee', role: 'finance', department: 'Accounts', work_mode: 'office', email: 'attendance-finance@test.local', password: 'FinanceTest123!' });
});
after(async () => { if (h) await h.close(); });
function event(userId, kind, hm, patch = {}) {
  const at = h.util.fromIst(day, hm).toISOString();
  return h.db.insert('attendance_events', { user_id: userId, kind, device_time: at, server_time: at, effective_time: at, validation: 'accepted', reasons: '[]', place_name: 'Jaipur Office', place_type: 'office', lat: 26.9, lng: 75.8, ...patch });
}
async function dashboardCookie(email, password) {
  const response = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns': '1' }, body: JSON.stringify({ login: email, password }) });
  assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
}
test('all employee access roles appear; department and work mode are independent metadata', async () => {
  event(it.id, 'in', '09:00'); event(it.id, 'out', '18:00');
  event(architect.id, 'in', '09:45'); event(architect.id, 'out', '18:00', { place_name: 'Client site', place_type: 'visit' });
  const response = await h.api('GET', `/api/attendance/dashboard?day=${day}`);
  assert.equal(response.status, 200);
  for (const user of [it, architect, manager, finance]) assert.ok(response.body.rows.some((r) => r.user.id === user.id), `${user.role} is visible`);
  const row = response.body.rows.find((r) => r.user.id === it.id);
  assert.equal(row.user.department, 'IT'); assert.equal(row.user.role, 'staff'); assert.equal(row.user.work_mode, 'office');
  assert.equal(row.status, 'present'); assert.equal(row.hours, 9); assert.equal(row.checked_in, false);
  assert.equal(response.body.rows.find((r) => r.user.id === architect.id).status, 'late');
  assert.ok(response.body.rows.every((r) => r.user.role !== 'owner'));
  assert.equal(response.body.filters.includeOwners, false);
  const owners = await h.api('GET', `/api/attendance/dashboard?day=${day}&includeOwners=1`);
  assert.ok(owners.body.rows.some((r) => r.user.role === 'owner'));
  const metadata = (await h.api('GET', `/api/team/${it.id}`)).body.user;
  assert.equal(metadata.department, 'IT'); assert.equal(metadata.role, 'staff');
  assert.equal((await h.api('PATCH', `/api/team/${it.id}`, { department: 'Information Technology', work_mode: 'hybrid' })).status, 200);
  assert.equal(h.db.one('SELECT role FROM users WHERE id=?', it.id).role, 'staff');
  await h.api('PATCH', `/api/team/${it.id}`, { department: 'IT', work_mode: 'office' });
});
test('daily filters and CSV match the selected employees and use India time', async () => {
  const filtered = await h.api('GET', `/api/attendance/dashboard?day=${day}&department=IT&role=staff&work_mode=office&q=Executive&status=present&presence=out`);
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.rows.map((r) => r.user.id), [it.id]);
  const csv = await h.api('GET', `/api/attendance/export.csv?view=daily&day=${day}&department=IT`);
  assert.equal(csv.status, 200); assert.ok(csv.body.includes('Office IT Executive')); assert.ok(!csv.body.includes('Design Architect'));
  assert.ok(csv.body.includes(`${day}T09:00:00+05:30`));
  assert.equal((await h.api('GET', `/api/attendance/dashboard?day=${day}&department=%27%20OR%201%3D1--`)).body.rows.length, 0);
  assert.equal((await h.api('GET', '/api/attendance/dashboard?day=2026-02-30')).status, 400);
  assert.equal((await h.api('GET', '/api/attendance/monthly?month=2026-13')).status, 400);
  assert.equal((await h.api('PATCH', `/api/team/${it.id}`, { work_mode: 'admin' })).status, 400);
  assert.equal((await h.api('PATCH', `/api/team/${it.id}`, { department: ['IT'] })).status, 400);
});
test('approved corrections and rejected events are reflected without changing original evidence', async () => {
  const result = await h.api('POST', '/api/team', { name: 'Review Employee', role: 'staff', department: 'IT', work_mode: 'office', weekly_off: [], shift_start: '09:00', grace_min: 15 });
  const id = result.body.id;
  h.db.update('users', id, { created_at: h.util.fromIst(day, '00:00').toISOString() });
  const original = h.util.fromIst(day, '11:00').toISOString();
  const punch = event(id, 'in', '11:00', { validation: 'needs_review', reasons: '["late","no_location"]' });
  event(id, 'out', '18:00'); event(id, 'in', '19:00', { review_status: 'rejected', review_note: 'Duplicate wrong punch' });
  const approval = h.db.insert('approvals', { kind: 'attendance_exception', entity_type: 'attendance_event', entity_id: punch, title: 'Review', status: 'pending', created_at: new Date().toISOString() });
  const corrected = h.util.fromIst(day, '09:00').toISOString();
  assert.equal((await h.api('POST', `/api/approvals/${approval}/decide`, { decision: 'approve', corrected_time: corrected, note: 'Manager verified office entry' })).status, 200);
  const response = await h.api('GET', `/api/attendance/employee/${id}?day=${day}`);
  assert.equal(response.body.status, 'present'); assert.equal(response.body.checked_in, false); assert.equal(response.body.hours, 9);
  assert.equal(response.body.rejected_events, 1); assert.equal(response.body.events.length, 3);
  const saved = h.db.one('SELECT * FROM attendance_events WHERE id=?', punch);
  assert.equal(saved.device_time, original); assert.equal(saved.server_time, original); assert.equal(saved.effective_time, corrected);
  assert.equal(saved.reasons, '["late","no_location"]'); assert.equal(saved.validation, 'needs_review');
  assert.ok(!response.body.flags.includes('late'));
});
test('monthly reports exclude future/pre-account absence and preserve inactive history', async () => {
  const month = day.slice(0, 7);
  const report = await h.api('GET', `/api/attendance/monthly?month=${month}&q=Office%20IT%20Executive`);
  assert.equal(report.status, 200); assert.equal(report.body.rows.length, 1);
  const row = report.body.rows[0]; assert.equal(row.counts.absent, 0);
  assert.ok(row.days.every((d) => d.day <= h.util.istDate()));
  assert.ok(row.days.filter((d) => d.day < day).every((d) => d.status === 'not_enrolled'));
  const originalCount = h.db.one('SELECT COUNT(*) n FROM attendance_events WHERE user_id=?', it.id).n;
  await h.api('PATCH', `/api/team/${it.id}`, { active: false });
  assert.equal((await h.api('GET', `/api/attendance/dashboard?day=${day}&q=Office%20IT%20Executive`)).body.rows.length, 0);
  const history = await h.api('GET', `/api/attendance/dashboard?day=${day}&q=Office%20IT%20Executive&includeInactive=1`);
  assert.equal(history.body.rows[0].user.active, false); assert.equal(history.body.rows[0].status, 'present'); assert.equal(history.body.rows[0].hours, 9);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM attendance_events WHERE user_id=?', it.id).n, originalCount);
  await h.api('PATCH', `/api/team/${it.id}`, { active: true });
});
test('office staff keep app attendance; only owner/manager can read dedicated reports', async () => {
  const login = await h.api('POST', '/api/auth/app-login', { phone: it.phone, pin: it.pin }, { noCookie: true });
  assert.equal(login.status, 200);
  const auth = { noCookie: true, headers: { authorization: `Bearer ${login.body.token}` } };
  const { getSettings } = await import('../server/core/base.js'); const office = getSettings().office;
  const punch = await h.api('POST', '/api/app/attendance', { kind: 'in', lat: office.lat, lng: office.lng, accuracy_m: 10, client_event_id: 'office-it-app-checkin' }, auth);
  assert.equal(punch.status, 200); assert.equal(punch.body.validation, 'accepted');
  assert.equal((await h.api('GET', '/api/attendance/dashboard', undefined, auth)).status, 401);
  assert.equal((await h.api('GET', '/api/attendance/export.csv', undefined, { noCookie: true })).status, 401);
  const financeCookie = await dashboardCookie(finance.email, finance.password);
  assert.equal((await h.api('GET', '/api/attendance/dashboard', undefined, { noCookie: true, headers: { cookie: financeCookie } })).status, 403);
  const managerCookie = await dashboardCookie(manager.email, manager.password);
  const report = await h.api('GET', '/api/attendance/dashboard?department=IT', undefined, { noCookie: true, headers: { cookie: managerCookie } });
  assert.equal(report.status, 200); assert.ok(report.body.rows.some((r) => r.user.id === it.id && r.checked_in));
});
test('CSV neutralizes formula-like employee metadata', async () => {
  const result = await h.api('POST', '/api/team', { name: '=1+1', role: 'staff', department: '+Reports', title: '@SUM(1)', work_mode: 'office' });
  assert.equal(result.status, 200);
  const csv = await h.api('GET', '/api/attendance/export.csv?view=daily&department=%2BReports');
  assert.equal(csv.status, 200); assert.ok(csv.body.includes('"\'=1+1"')); assert.ok(csv.body.includes('"\'+Reports"')); assert.ok(csv.body.includes('"\'@SUM(1)"'));
});

test('hourly reminders cover office roles and later shifts without repeating or accepting rejected evidence', async () => {
  const today = h.util.istDate();
  const make = (name, role, extra = {}) => staff.createUser({ name, role, department: 'Reminder test', work_mode: 'office', weekly_off: [], shift_start: '09:00', grace_min: 15, ...extra }, owner).id;
  const ids = { office: make('Reminder IT', 'staff'), manager: make('Reminder Manager', 'manager'), finance: make('Reminder Finance', 'finance'), late: make('Afternoon Designer', 'architect', { shift_start: '15:00' }), rejected: make('Rejected Checkin', 'staff'), pending: make('Unverified Checkin', 'staff'), off: make('Weekly Off', 'staff', { weekly_off: [h.util.dayOfWeek(today)] }), leave: make('Approved Leave', 'staff'), inactive: make('Inactive Employee', 'staff'), owner: make('Reminder Owner', 'owner') };
  h.db.update('users', ids.inactive, { active: 0 });
  h.db.insert('leave_requests', { user_id: ids.leave, type: 'casual', from_date: today, to_date: today, status: 'approved', created_at: new Date().toISOString() });
  const punchTime = h.util.fromIst(today, '09:00').toISOString();
  h.db.insert('attendance_events', { user_id: ids.rejected, kind: 'in', device_time: punchTime, server_time: punchTime, effective_time: punchTime, validation: 'accepted', reasons: '[]', review_status: 'rejected' });
  h.db.insert('attendance_events', { user_id: ids.pending, kind: 'in', device_time: punchTime, server_time: punchTime, effective_time: punchTime, validation: 'needs_review', reasons: '["outside_geofence"]' });
  const sweep = (hm) => h.db.tx(() => staff.attendanceMorningSweep(h.util.fromIst(today, hm)));
  const early = sweep('09:44');
  assert.ok(!early.names.includes('Reminder IT'), 'waits for shift start + grace + 30 minute reminder delay');
  const first = sweep('10:15');
  for (const name of ['Reminder IT', 'Reminder Manager', 'Reminder Finance', 'Rejected Checkin']) assert.ok(first.names.includes(name), name);
  for (const name of ['Afternoon Designer', 'Weekly Off', 'Approved Leave', 'Inactive Employee', 'Reminder Owner', 'Unverified Checkin']) assert.ok(!first.names.includes(name), name);
  assert.ok(first.reviewNames.includes('Unverified Checkin'));
  assert.equal(h.db.one("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND title='You have not checked in today'", ids.pending).n, 0);
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE audience='managers' AND link='#/attendance?status=needs_review' AND body LIKE '%Unverified Checkin%'"));
  const again = sweep('11:15'); assert.equal(again.reminded, 0); assert.equal(again.awaitingReview, 0);
  assert.ok(!sweep('15:44').names.includes('Afternoon Designer'));
  assert.deepEqual(sweep('16:15').names, ['Afternoon Designer']);
  assert.equal(sweep('17:15').reminded, 0);
  for (const id of [ids.office, ids.manager, ids.finance, ids.late, ids.rejected]) assert.equal(h.db.one("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND title='You have not checked in today'", id).n, 1);
  const next = h.util.addDays(today, 1);
  assert.ok(h.db.tx(() => staff.attendanceMorningSweep(h.util.fromIst(next, '10:15'))).names.includes('Reminder IT'), 'new day permits one new reminder');
});

test('backend and n8n attendance schedules both check later shifts hourly', async () => {
  const { ROUTINES } = await import('../server/core/routines.js');
  assert.deepEqual(ROUTINES['attendance-morning'].when(), { type: 'hourly', minute: 15 });
  const workflow = JSON.parse(fs.readFileSync(new URL('../n8n/workflows/02-scheduled-routines.json', import.meta.url), 'utf8'));
  const trigger = workflow.nodes.find((node) => node.name === 'Every hour at :15');
  assert.equal(trigger.parameters.rule.interval[0].expression, '15 * * * *');
  const target = workflow.connections[trigger.name].main[0][0].node;
  assert.ok(workflow.nodes.find((node) => node.name === target).parameters.url.endsWith('/attendance-morning/run'));
});

test('delayed WhatsApp attendance reminders recheck resolved evidence, employment and recipient', async () => {
  const today = h.util.istDate(); const { getSettings, saveSettings } = await import('../server/core/base.js');
  const original = { ...getSettings().attendance };
  h.db.tx(() => saveSettings({ attendance: { ...original, morning_check_after_min: 0 } }, 'test'));
  const rows = ['checked', 'leave', 'inactive', 'phone', 'old_day', 'valid', 'pending', 'off'].map((scenario, i) => {
    const phone = `98000004${String(i).padStart(2, '0')}`;
    const id = staff.createUser({ name: `Queued ${scenario}`, role: 'staff', phone, shift_start: '00:00', grace_min: 0, weekly_off: [] }, owner).id;
    return { scenario, id, phone: h.util.normPhone(phone) };
  });
  h.db.tx(() => staff.attendanceMorningSweep());
  for (const row of rows) {
    const job = h.db.one('SELECT * FROM outbox WHERE dedupe_key=?', `att-remind:${row.id}:${today}`);
    assert.ok(job, row.scenario); row.jobId = job.id;
    assert.equal(JSON.parse(job.guard).type, 'attendance_missing');
    if (row.scenario === 'checked' || row.scenario === 'pending') {
      const stamp = new Date().toISOString();
      h.db.insert('attendance_events', { user_id: row.id, kind: 'in', device_time: stamp, server_time: stamp, effective_time: stamp, validation: row.scenario === 'pending' ? 'needs_review' : 'accepted', reasons: row.scenario === 'pending' ? '["no_location"]' : '[]' });
    } else if (row.scenario === 'leave') h.db.insert('leave_requests', { user_id: row.id, type: 'casual', from_date: today, to_date: today, status: 'approved', created_at: new Date().toISOString() });
    else if (row.scenario === 'inactive') h.db.update('users', row.id, { active: 0 });
    else if (row.scenario === 'phone') h.db.update('users', row.id, { phone: '919800000499' });
    else if (row.scenario === 'old_day') h.db.update('outbox', job.id, { guard: JSON.stringify({ ...JSON.parse(job.guard), day: h.util.addDays(today, -1) }) });
    else if (row.scenario === 'off') h.db.update('users', row.id, { weekly_off: JSON.stringify([h.util.dayOfWeek(today)]) });
  }
  await h.drain();
  for (const row of rows) {
    const job = h.db.one('SELECT status FROM outbox WHERE id=?', row.jobId);
    assert.equal(job.status, row.scenario === 'valid' ? 'sent' : 'cancelled', row.scenario);
  }
  h.db.tx(() => saveSettings({ attendance: original }, 'test'));
});
