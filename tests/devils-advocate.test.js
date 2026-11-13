// Regression tests for the November 2026 "devil's advocate" review (docs/RELIABILITY-REVIEW.md).
// Each test reproduces something that went wrong with realistic, awkward input or timing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let h; let base; let owner;
const AMIT = '919811111101'; // demo client with a running project

const conv = (wa) => h.db.one('SELECT c.*, k.opted_out, k.id contact FROM conversations c JOIN contacts k ON k.id=c.contact_id WHERE k.wa_id=?', wa);
const leadOf = (wa) => h.db.one('SELECT * FROM leads WHERE phone=? ORDER BY id DESC LIMIT 1', wa);
const setSettings = (patch) => h.db.tx(() => base.saveSettings(patch, 'test'));
const ist = (day, hm) => h.util.fromIst(day, hm);
/** Move the simulated clock forward to the next given weekday (0 = Sunday) at HH:MM India time. */
function goTo(dow, hm) {
  let day = h.util.istDate();
  let target = ist(day, hm);
  while (target <= h.util.now() || h.util.dayOfWeek(day) !== dow) { day = h.util.addDays(day, 1); target = ist(day, hm); }
  h.util.advanceClock(target.getTime() - h.util.now().getTime());
  return day;
}
async function manualLead(phone, name, slot, extra = {}) {
  const r = await h.api('POST', '/api/leads', { phone, name, services: ['turnkey'], zone: 'vaishali', project_nature: 'new_build', area_sqft: 1500, execution_window: 'immediate', slot, submit: true, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return h.db.one('SELECT * FROM leads WHERE id=?', r.body.id);
}
/** Times are compared with a few seconds of slack: the simulated clock keeps ticking. */
const near = (actual, expected, label) => assert.ok(Math.abs(Date.parse(actual) - new Date(expected).getTime()) < 5000, `${label || 'time'}: ${actual} should be about ${new Date(expected).toISOString()}`);
const pendingOffer = (leadId) => h.db.one("SELECT * FROM visit_offers WHERE lead_id=? AND status='pending' ORDER BY id DESC LIMIT 1", leadId);
const offerMessage = (offerId) => h.db.one("SELECT * FROM outbox WHERE kind='offer.architect' AND guard LIKE ? ORDER BY id DESC LIMIT 1", `%"id":${offerId},%`);

before(async () => {
  h = await boot();
  base = await import('../server/core/base.js');
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
});
after(async () => { h.util.resetClock(); await h.close(); });

// ---------------------------------------------------------------- the bot misread ordinary sentences
test('"Stop work" from a client with a running project reaches a person and never unsubscribes them', async () => {
  for (const text of ['Stop work', 'kaam band karo', 'Please pause the construction till Monday']) {
    h.db.run("UPDATE conversations SET mode='bot', needs_attention=0 WHERE contact_id=(SELECT id FROM contacts WHERE wa_id=?)", AMIT);
    await h.say(AMIT, text, 'Amit Jain');
    const c = conv(AMIT);
    assert.equal(c.opted_out, 0, `"${text}" must not unsubscribe`);
    assert.equal(c.mode, 'human', `"${text}" goes to a person`);
    assert.match(c.attention_reason, /stop or pause work on NS-PRJ/);
  }
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE title LIKE '%asked to stop work%'"), 'managers are told in plain words');
});

test('STOP still unsubscribes, the team is told when it affects a live project, START subscribes again', async () => {
  await h.say(AMIT, 'STOP');
  assert.equal(conv(AMIT).opted_out, 1);
  assert.match(h.last(AMIT).body, /unsubscribed/i);
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE title LIKE '%unsubscribed from WhatsApp updates%' AND body LIKE 'NS-PRJ%'"), 'manager notification names the project');
  await h.say(AMIT, 'START');
  assert.equal(conv(AMIT).opted_out, 0);
  // A stranger who unsubscribes needs no manager attention.
  const before = h.db.one("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%unsubscribed%'").n;
  await h.say('919700100001', 'please stop messages', 'Stranger');
  assert.equal(conv('919700100001').opted_out, 1);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM notifications WHERE title LIKE '%unsubscribed%'").n, before);
});

test('"fire safety work" is an enquiry, "fire at the site" is an emergency', async () => {
  await h.say('919700100002', 'I need fire safety work for my shop in Malviya Nagar', 'Shop Owner');
  let c = conv('919700100002');
  assert.equal(c.mode, 'bot'); assert.notEqual(c.attention_reason, '🚨 EMERGENCY');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE kind='staff.emergency'").n, 0, 'the owner is not woken up');
  await h.say('919700100003', 'free fire khelna hai', 'Kid');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE kind='staff.emergency'").n, 0);
  await h.say('919700100004', 'fire at the site please help', 'Neighbour');
  c = conv('919700100004');
  assert.equal(c.attention_reason, '🚨 EMERGENCY');
});

test('"a house for a 4 person family" and "staff quarters" are enquiries, not requests for a person', async () => {
  await h.say('919700100005', 'I want a house for 4 person family in Mansarovar 1200 sqft', 'Family Man');
  let c = conv('919700100005');
  assert.equal(c.mode, 'bot'); assert.equal(c.flow, 'lead');
  const lead = leadOf('919700100005');
  assert.equal(lead.zone, 'mansarovar'); assert.equal(lead.area_sqft, 1200);
  await h.say('919700100006', 'staff quarters banwana hai jagatpura me 200 gaj', 'Factory Owner');
  c = conv('919700100006');
  assert.equal(c.mode, 'bot'); assert.equal(leadOf('919700100006').zone, 'jagatpura');
  // Asking for a person still works, in a short message or with a clear phrase.
  await h.say('919700100007', 'agent please', 'Wants Human');
  assert.equal(conv('919700100007').mode, 'human');
  await h.say('919700100008', 'please connect me to your manager, I have a question about my bill', 'Wants Manager');
  assert.equal(conv('919700100008').mode, 'human');
});

test('plot size is read from the right number: not the family size, the BHK count or the road width', async () => {
  const { parseArea } = await import('../server/bot/nlu.js');
  const sqft = (t) => parseArea(t)?.sqft ?? null;
  assert.equal(sqft('3 bhk flat 1400 sqft'), 1400);
  assert.equal(sqft('house for 4 person family, 1200 sqft'), 1200);
  assert.equal(sqft('40 feet road, plot 150 gaj'), 1350);
  assert.equal(sqft('near 200 ft bypass, plot 111 gaj'), 999);
  assert.equal(sqft('plot on 200 feet bypass'), null, 'a road name is not an area');
  assert.equal(sqft('200 feet bypass ke paas 1800'), 1800);
  assert.equal(sqft('plot in mansarovar 302020'), null, 'a PIN code is not an area');
  assert.equal(sqft('1200 feet ka plot hai'), 1200);
  assert.equal(sqft('१५० गज'), 1350, 'Hindi numerals');
  assert.equal(sqft('30x40'), 1200); assert.equal(sqft('1500'), 1500); assert.equal(sqft('2 bhk'), null);
});

test('a greeting that already says what is needed starts the enquiry instead of the menu', async () => {
  await h.say('919700100009', 'Hello, renovation karwana hai', 'Renu');
  const lead = leadOf('919700100009');
  assert.ok(lead, 'an enquiry was started');
  assert.deepEqual(JSON.parse(lead.services), ['renovation']);
  assert.ok(!h.listRows(h.last('919700100009')).some((r) => r.id.startsWith('M:svc:')), 'not the generic service menu');
  // A bare greeting still gets the menu.
  await h.say('919700100010', 'Hello', 'Plain');
  assert.ok(h.listRows(h.last('919700100010')).some((r) => r.id === 'M:svc:turnkey'));
});

test('a location pin sent before the area question answers it; a far-away pin does not', async () => {
  const A = '919700100011';
  await h.say(A, 'Need architect for new house 2000 sqft', 'Pin First');
  assert.equal(conv(A).step, 'zone', 'bot is asking for the area');
  await h.location(A, 26.9131, 75.7425, 'My plot', 'Gandhi Path, Vaishali Nagar');
  let lead = leadOf(A);
  assert.equal(lead.zone, 'vaishali', 'area taken from the pin');
  assert.equal(lead.site_lat, 26.9131);
  assert.notEqual(conv(A).step, 'zone', 'moved on to the next question');
  assert.match(h.last(A).body, /Got your location/);

  const B = '919700100012';
  await h.say(B, 'Need architect for new house 2000 sqft', 'Far Pin');
  await h.location(B, 28.6139, 77.209, 'Connaught Place', 'New Delhi');
  lead = leadOf(B);
  assert.equal(lead.zone, null, 'a pin 240 km away is where the person is, not the site');
  assert.equal(conv(B).step, 'zone', 'still asks which area of Jaipur');
});

test('the approval card warns when the pin is far from the chosen area', async () => {
  const lead = await manualLead('9700100013', 'Wrong Pin', undefined);
  h.db.run('UPDATE leads SET site_lat=28.6139, site_lng=77.209 WHERE id=?', lead.id);
  const list = (await h.api('GET', '/api/approvals')).body;
  const mine = list.find((a) => a.entity_id === lead.id && a.kind === 'lead_assignment');
  assert.match(mine.leadText.pinWarning, /about 2\d\d km from the chosen area/);
  h.db.run('UPDATE leads SET site_lat=26.9131, site_lng=75.7425 WHERE id=?', lead.id);
  const again = (await h.api('GET', '/api/approvals')).body.find((a) => a.entity_id === lead.id);
  assert.equal(again.leadText.pinWarning, '');
  // One damaged record must not take the approvals page down.
  h.db.run("UPDATE leads SET preferred_slots='[\"not a date\"]' WHERE id=?", lead.id);
  const safe = await h.api('GET', '/api/approvals');
  assert.equal(safe.status, 200);
  assert.ok(safe.body.find((a) => a.entity_id === lead.id));
  h.db.run("UPDATE leads SET preferred_slots='[]' WHERE id=?", lead.id);
});

// ---------------------------------------------------------------- deadlines ran through the night
test('office-time helpers: the clock stops while the office is closed', () => {
  setSettings({ business_hours: { open: '08:00', close: '18:00', days: [1, 2, 3, 4, 5, 6] } });
  const mon = (() => { let d = h.util.istDate(); while (h.util.dayOfWeek(d) !== 1) d = h.util.addDays(d, 1); return d; })();
  const sat = h.util.addDays(mon, 5); const nextMon = h.util.addDays(mon, 7);
  assert.equal(base.workingDeadline(30, ist(mon, '10:00')).toISOString(), ist(mon, '10:30').toISOString(), 'inside office hours it is a plain 30 minutes');
  assert.equal(base.workingDeadline(30, ist(mon, '17:50')).toISOString(), ist(h.util.addDays(mon, 1), '08:20').toISOString(), '10 minutes today, 20 tomorrow');
  assert.equal(base.workingDeadline(30, ist(mon, '23:00')).toISOString(), ist(h.util.addDays(mon, 1), '08:30').toISOString());
  assert.equal(base.workingDeadline(240, ist(mon, '17:30')).toISOString(), ist(h.util.addDays(mon, 1), '11:30').toISOString());
  assert.equal(base.workingDeadline(30, ist(sat, '17:50')).toISOString(), ist(nextMon, '08:20').toISOString(), 'Sunday is closed');
  assert.equal(base.nextOpening(ist(mon, '05:00')).toISOString(), ist(mon, '08:00').toISOString());
  assert.equal(base.nextOpening(ist(mon, '12:00')).toISOString(), ist(mon, '12:00').toISOString());
  // "Open 00:00–23:59" means always open: no minute of the day counts as closed.
  setSettings({ business_hours: { open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } });
  assert.equal(base.isBusinessHours(ist(mon, '23:59')), true);
  assert.equal(base.workingDeadline(30, ist(mon, '23:50')).toISOString(), ist(h.util.addDays(mon, 1), '00:20').toISOString());
});

test('an enquiry auto-approved at night is offered when the office opens and is not lost overnight', async () => {
  setSettings({ business_hours: { open: '08:00', close: '18:00', days: [0, 1, 2, 3, 4, 5, 6] }, auto_approve_leads: true });
  const mon = goTo(1, '23:00'); const tue = h.util.addDays(mon, 1); const wed = h.util.addDays(mon, 2);
  const lead = await manualLead('9700100020', 'Night Owl', ist(wed, '12:00').toISOString());
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?', lead.id).status, 'scheduling', 'auto-approved');
  const offer = pendingOffer(lead.id);
  near(offer.expires_at, ist(tue, '08:30'), 'reply time counts office hours only');
  await h.drain();
  const msg = offerMessage(offer.id);
  assert.equal(msg.status, 'queued', 'the architect is not messaged at 11 pm');
  assert.ok(msg.next_attempt_at >= ist(tue, '08:00').toISOString() && msg.next_attempt_at < ist(tue, '08:02').toISOString(), msg.next_attempt_at);
  h.util.advanceClock(6 * 3600e3); await h.drain(); // 5 am
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', offer.id).status, 'pending', 'still waiting at 5 am (it used to expire at 11:30 pm)');
  goTo(2, '08:02'); await h.drain();
  assert.equal(offerMessage(offer.id).status, 'sent', 'sent when the office opens');
  goTo(2, '08:31'); await h.drain();
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', offer.id).status, 'expired');
  assert.ok(pendingOffer(lead.id), 'the next architect is asked in office hours');
  setSettings({ auto_approve_leads: false });
});

test('a manager’s own evening approval is sent at once; the client can confirm next morning', async () => {
  const tue = goTo(2, '17:30'); const wed = h.util.addDays(tue, 1); const thu = h.util.addDays(tue, 2);
  const lead = await manualLead('9700100021', 'Evening Client', ist(thu, '12:00').toISOString());
  const appr = (await h.api('GET', '/api/approvals')).body.find((a) => a.entity_id === lead.id && a.kind === 'lead_assignment');
  const dec = await h.api('POST', `/api/approvals/${appr.id}/decide`, { decision: 'approve' });
  assert.equal(dec.status, 200, JSON.stringify(dec.body));
  await h.drain();
  const offer = pendingOffer(lead.id);
  assert.equal(offerMessage(offer.id).status, 'sent', 'a manager’s click is delivered immediately');
  near(offer.expires_at, ist(tue, '18:00'), 'offer ends at closing time');
  const arch = h.db.one('SELECT phone FROM users WHERE id=?', offer.architect_id).phone;
  await h.tplPress(arch, `OF:A:${offer.id}:${offer.revision}`);
  const accepted = h.db.one('SELECT * FROM visit_offers WHERE id=?', offer.id);
  assert.equal(accepted.status, 'accepted');
  near(accepted.client_deadline, ist(wed, '11:30'), '4 office hours: 30 min today + 3.5 h tomorrow');
  const reminder = h.db.one("SELECT * FROM timers WHERE dedupe_key=?", `ccr:${offer.id}`);
  near(reminder.due_at, ist(wed, '09:30'), 'the reminder is not sent at night');
  h.util.advanceClock(8 * 3600e3); await h.drain(); // 1:30 am
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', offer.id).status, 'accepted', 'not timed out overnight (it used to at 9:30 pm)');
  goTo(3, '09:31'); await h.drain();
  assert.ok(h.db.one("SELECT 1 FROM outbox WHERE kind='visit.confirm_reminder' AND to_wa_id='919700100021'"), 'morning reminder');
  const yes = h.outbound('919700100021').map((m) => h.findButton(m, 'VC:Y')).filter(Boolean).pop();
  await h.press('919700100021', yes.id);
  assert.equal(h.db.one('SELECT status FROM leads WHERE id=?', lead.id).status, 'visit_confirmed');
});

test('nobody can accept or confirm a visit after its time; the deadline ends before the visit', async () => {
  const thu = goTo(4, '09:00');
  const lead = await manualLead('9700100022', 'Short Notice', undefined);
  const made = await h.api('POST', `/api/leads/${lead.id}/offer`, { slotStart: ist(thu, '10:30').toISOString() });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const offer = pendingOffer(lead.id);
  near(offer.expires_at, ist(thu, '09:30'));
  const arch = h.db.one('SELECT phone FROM users WHERE id=?', offer.architect_id).phone;
  h.util.advanceClock(5 * 60e3);
  await h.tplPress(arch, `OF:A:${offer.id}:${offer.revision}`);
  const accepted = h.db.one('SELECT * FROM visit_offers WHERE id=?', offer.id);
  near(accepted.client_deadline, ist(thu, '10:00'), 'confirm at least 30 minutes before the visit');
  const reminder = h.db.one('SELECT * FROM timers WHERE dedupe_key=?', `ccr:${offer.id}`);
  assert.ok(reminder.due_at > ist(thu, '09:05').toISOString() && reminder.due_at < ist(thu, '10:00').toISOString());
  const yes = h.outbound('919700100022').map((m) => h.findButton(m, 'VC:Y')).filter(Boolean).pop();
  goTo(4, '10:35'); await h.drain();
  assert.equal(h.db.one('SELECT status FROM visit_offers WHERE id=?', offer.id).status, 'client_timeout');
  await h.press('919700100022', yes.id);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM visits WHERE lead_id=?', lead.id).n, 0, 'no visit is confirmed for a time already past');
  assert.match(h.last('919700100022').body, /no longer active/i);
  // An offer whose time has passed cannot be accepted either (older data, clock changes).
  const lead2 = await manualLead('9700100023', 'Past Slot', undefined);
  await h.api('POST', `/api/leads/${lead2.id}/offer`, { slotStart: ist(thu, '12:00').toISOString() });
  const o2 = pendingOffer(lead2.id);
  h.db.run('UPDATE visit_offers SET slot_start=?, expires_at=? WHERE id=?', ist(thu, '10:00').toISOString(), ist(thu, '13:00').toISOString(), o2.id);
  const scheduling = await import('../server/domain/scheduling.js');
  assert.deepEqual(scheduling.architectRespond(o2.id, o2.revision, true), { stale: true });
  setSettings({ business_hours: { open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } });
});

test('a travel claim for a visit booked for tomorrow is dated today, not refused as a future date', async () => {
  const travel = await import('../server/domain/travel.js');
  const staff = h.db.one("SELECT * FROM users WHERE phone='919800000101'");
  const c = h.db.insert('contacts', { wa_id: '919700100030', name: 'Tomorrow Visit' });
  const lead = h.db.insert('leads', { contact_id: c, ref: 'DA-L1', name: 'Tomorrow Visit', phone: '919700100030', address: 'Site, Jaipur', services: '["interiors"]', site_lat: 26.92, site_lng: 75.8, status: 'visit_done' });
  const tomorrow = h.util.addDays(h.util.istDate(), 1);
  const visit = h.db.insert('visits', { ref: 'DA-V1', lead_id: lead, architect_id: staff.id, start_at: ist(tomorrow, '10:00').toISOString(), end_at: ist(tomorrow, '11:00').toISOString(), revision: 1, status: 'report_submitted' });
  const dispatch = await import('../server/domain/dispatch.js');
  dispatch.saveDispatchSettings({ dispatch: { radius_km: 2, resolution: 6 }, travel: { rate_per_km: 10, base_amount: 20, minimum_amount: 30, maximum_amount: 500, rounding_rupees: 1 } }, `user:${owner.id}`);
  dispatch.setLocationProfile(staff.id, { home_lat: 26.95, home_lng: 75.75, home_label: 'Home', default_origin: 'home' }, `user:${staff.id}`);
  const chosen = await travel.selectTravel(visit, staff, { origin_type: 'home' });
  travel.approveTravel(visit, owner, { ack_home_change: true, expected_revision: chosen.revision, verified_distance_km: 12, note: 'Checked on the map' });
  const claim = travel.claimTravel(visit, staff);
  assert.ok(claim.expense_id, JSON.stringify(claim));
  assert.equal(h.db.one('SELECT claim_date FROM expense_claims WHERE id=?', claim.expense_id).claim_date, h.util.istDate());
});

test('the 9 pm check-out sweep is caught up next morning when the computer was off', async () => {
  const user = h.db.one("SELECT * FROM users WHERE phone='919800000105'");
  const yesterday = h.util.addDays(h.util.istDate(), -1);
  h.db.run('DELETE FROM attendance_events WHERE user_id=?', user.id);
  h.db.run("DELETE FROM routine_runs WHERE run_key=?", `attendance-evening:${yesterday}`);
  h.db.insert('attendance_events', { user_id: user.id, kind: 'in', device_time: ist(yesterday, '09:10').toISOString(), server_time: ist(yesterday, '09:10').toISOString(), effective_time: ist(yesterday, '09:10').toISOString(), validation: 'accepted', reasons: '[]' });
  const title = `Missing check-out · ${user.name} · ${yesterday}`;
  assert.equal(h.db.one('SELECT COUNT(*) n FROM approvals WHERE title=?', title).n, 0);
  const run1 = await h.api('POST', '/api/routines/housekeeping/run', { force: true });
  assert.equal(run1.status, 200, JSON.stringify(run1.body));
  assert.equal(h.db.one('SELECT COUNT(*) n FROM approvals WHERE title=?', title).n, 1, 'the forgotten check-out reaches a manager');
  assert.equal(h.db.one('SELECT status FROM attendance_days WHERE user_id=? AND day=?', user.id, yesterday).status, 'needs_review');
  await h.api('POST', '/api/routines/housekeeping/run', { force: true });
  assert.equal(h.db.one('SELECT COUNT(*) n FROM approvals WHERE title=?', title).n, 1, 'running again changes nothing');
});

// ---------------------------------------------------------------- awkward input gave "something went wrong"
test('bad input gets a clear answer instead of a server error', async () => {
  const expect = async (method, p, body, status, re) => {
    const r = await h.api(method, p, body);
    assert.equal(r.status, status, `${method} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    if (re) assert.match(String(r.body.error), re);
  };
  await expect('GET', '/api/leads/%E0%A4%A', undefined, 400, /address is not valid/);
  await expect('GET', '/admin/%E0%A4%A.js', undefined, 404);
  await expect('POST', '/api/leads', [], 400, /named fields/);
  await expect('POST', '/api/tasks', 'x', 400, /named fields/);
  await expect('POST', '/api/inbox/999999/takeover', {}, 404, /Chat not found/);
  await expect('POST', '/api/inbox/999999/release', {}, 404);
  await expect('POST', '/api/projects/999999/update', { text: 'Hello' }, 404, /Project not found/);
  await expect('POST', '/api/leads/999999/submit', {}, 404, /Lead not found/);
  await expect('PATCH', '/api/leads/999999', { name: 'x' }, 404);
  const task = h.db.one('SELECT id FROM tasks ORDER BY id LIMIT 1');
  await expect('PATCH', `/api/tasks/${task.id}`, { assignee_id: 999999 }, 400, /active team member/);
  await expect('PATCH', `/api/tasks/${task.id}`, { status: 'banana' }, 400, /status/);
  await expect('PATCH', `/api/tasks/${task.id}`, { title: null }, 400, /Title is required/);
  await expect('POST', '/api/tasks', { title: 'Call client', due_at: 'next week' }, 400, /Due time/);
  await expect('POST', '/api/tasks', { title: 'Call client', priority: 'urgent' }, 400, /priority/);
  await expect('POST', '/api/leads', { phone: '9700100040', name: 'Bad Slot', services: ['turnkey'], slot: 'tomorrow morning' }, 400, /Visit time/);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM leads WHERE phone='919700100040'").n, 0, 'nothing half-saved');
  await expect('POST', '/api/leads', { phone: '9700100040', services: 'turnkey' }, 400, /services/);
  await expect('POST', '/api/leads', { phone: '9700100040', area_sqft: 'big' }, 400, /Area/);
  await expect('POST', '/api/leads', { phone: '9700100040', zone: 'atlantis' }, 400, /area from the list/);
  await expect('PUT', '/api/zones', { zones: 'all' }, 400, /list of zones/);
  await expect('POST', '/api/attendance/recompute', { day: '2026-99-99' }, 400, /real date/);
  await expect('PATCH', '/api/faqs/999999', { question: 'x' }, 404);
  const faq = h.db.one('SELECT id FROM faqs LIMIT 1');
  await expect('PATCH', `/api/faqs/${faq.id}`, { question: null }, 400, /Question is required/);
  // The form's "Priority" was ignored when creating a lead.
  const made = await h.api('POST', '/api/leads', { phone: '9700100041', name: 'Urgent Walk-in', services: ['renovation'], priority: 'high', zone: '', project_nature: '', execution_window: '' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(h.db.one('SELECT priority FROM leads WHERE id=?', made.body.id).priority, 'high');
});

test('website enquiries: a bad number is refused at once and a repeated post is one enquiry', async () => {
  const secret = JSON.parse(fs.readFileSync(path.join(h.dir, 'secrets.json'), 'utf8')).websiteSecret;
  const post = async (body) => { const r = await fetch(`${h.base}/api/public/website-enquiry`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-website-secret': secret }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const failedBefore = h.db.one("SELECT COUNT(*) n FROM inbound_events WHERE kind='form'").n;
  for (const mobile of ['12345', 'not a number', { a: 1 }, '']) {
    const r = await post({ reference_id: 'NS-JPR-2026-7001', name: 'Bad Phone', mobile });
    assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, /valid mobile/);
  }
  assert.equal(h.db.one("SELECT COUNT(*) n FROM inbound_events WHERE kind='form'").n, failedBefore, 'nothing is queued to fail later');
  const form = { reference_id: 'NS-JPR-2026-7002', name: 'Web Visitor', mobile: '97001 00060', services: ['Turnkey construction'], locality: 'Vaishali Nagar', area: '150 gaj', consent: true };
  const first = await post(form); await h.drain();
  assert.equal(first.status, 200); assert.equal(first.body.stored, 1);
  const again = await post({ ...form, submitted_at: '2026-11-12T10:00:00Z' }); await h.drain();
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true, 'the website can retry safely');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM leads WHERE phone='919700100060'").n, 1, 'one lead');
  assert.equal(h.db.one("SELECT ref FROM leads WHERE phone='919700100060'").ref, 'NS-JPR-2026-7002');
  assert.equal(h.outbound('919700100060').filter((m) => /7002/.test(m.body || '')).length, 1, 'the client is greeted once');
});

test('the safety net explains database refusals in plain words', async () => {
  const http = await import('../server/lib/http.js');
  assert.match(http.constraintMessage(new Error('FOREIGN KEY constraint failed')), /no longer exists/);
  assert.match(http.constraintMessage(new Error('NOT NULL constraint failed: tasks.due_at')), /required detail is missing: due at/);
  assert.match(http.constraintMessage(new Error('UNIQUE constraint failed: users.phone')), /phone is already in use/);
  assert.equal(http.constraintMessage(new Error('disk I/O error')), null, 'real server faults stay server faults');
});

test('employee app: a damaged saved item is reported, and an upload that is too large gets an answer', async () => {
  const login = await h.api('POST', '/api/auth/app-login', { phone: '9800000104', pin: '1234' }, { noCookie: true });
  const auth = { noCookie: true, headers: { authorization: `Bearer ${login.body.token}` } };
  const sync = await h.api('POST', '/api/app/sync', { items: [null, 'x', { type: 'task', client_event_id: 'ok-1', task_id: 999999, status: 'done' }] }, auth);
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body.length, 3);
  assert.match(sync.body[0].error, /damaged/);
  const bad = await h.api('POST', '/api/app/visits/1/report', { photos: 'one.jpg' }, { noCookie: true, headers: { authorization: `Bearer ${(await h.api('POST', '/api/auth/app-login', { phone: '9800000101', pin: '1234' }, { noCookie: true })).body.token}` } });
  assert.equal(bad.status, 400);
  // 100 KB to an endpoint that accepts 16 KB: a proper "too large" answer, not a dropped connection.
  const big = await fetch(`${h.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ns': '1' }, body: JSON.stringify({ login: 'a', password: 'x'.repeat(100 * 1024) }) });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /too large/);
});

// ---------------------------------------------------------------- settings mistakes were silent
test('a typing mistake in the settings stops the start with a plain message; warnings reach the health panel', () => {
  const run = (env) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nscfg-'));
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "const { config, configProblems } = await import('./server/config.js'); console.log(JSON.stringify({ provider: config.whatsapp.provider, ...configProblems() }));"], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dir, NS_TEST: 'true', ...env }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  let p = run({ WHATSAPP_PROVIDER: 'meta' });
  assert.match(p.errors.join(' '), /WHATSAPP_PROVIDER must be simulator, cloud or dialog360/);
  p = run({ WHATSAPP_PROVIDER: ' Cloud ' });
  assert.equal(p.provider, 'cloud', 'capital letters and spaces are forgiven');
  assert.deepEqual(p.errors, []);
  assert.match(p.warnings.join(' '), /WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET are empty/);
  p = run({ PORT: 'abc' });
  assert.equal(p.errors.length, 1); assert.match(p.errors[0], /PORT must be a number/);
  p = run({ PUBLIC_URL: 'ops.example.com/' });
  assert.match(p.errors.join(' '), /PUBLIC_URL must be a full address/);
  p = run({ AI_MODE: 'chatgpt' });
  assert.match(p.errors.join(' '), /AI_MODE must be/);
  p = run({ COOKIE_SECURE: 'true' });
  assert.match(p.warnings.join(' '), /COOKIE_SECURE is true but PUBLIC_URL is plain http/);
  p = run({ PUBLIC_URL: 'https://ops.example.com' });
  assert.match(p.warnings.join(' '), /set COOKIE_SECURE=true/);
  p = run({});
  assert.deepEqual(p, { provider: 'simulator', errors: [], warnings: [] }, 'the default settings are clean');
  // The server itself refuses to start and tells the launcher not to retry (exit code 78).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nscfg-'));
  const start = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/main.js'], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dir, WHATSAPP_PROVIDER: 'whatsapp' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(start.status, 78, start.stderr);
  assert.match(start.stderr, /The system did not start/);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.db')), [], 'no database is created for a start that was refused');
});

test('the shipped .env.example has no unknown or misspelt settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsenv-'));
  for (const d of ['server', 'node_modules']) fs.symlinkSync(path.join(ROOT, d), path.join(dir, d), 'dir');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  // A Windows editor may add a byte-order mark and CRLF line ends: both must be harmless.
  fs.writeFileSync(path.join(dir, '.env'), '﻿' + fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').replace(/\r?\n/g, '\r\n') + '\r\nWHATSAP_TOKEN=typo\r\nthis line has no equals sign\r\n');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--preserve-symlinks', '--preserve-symlinks-main', '--input-type=module', '-e', "const { configProblems } = await import('./server/config.js'); console.log(JSON.stringify(configProblems()));"], { cwd: dir, env: { PATH: process.env.PATH, DATA_DIR: path.join(dir, 'data'), NS_TEST: 'true' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(p.errors, []);
  assert.equal(p.warnings.length, 2, JSON.stringify(p.warnings));
  assert.match(p.warnings.join(' '), /does not know: WHATSAP_TOKEN/);
  assert.match(p.warnings.join(' '), /ignored because it has no "="/);
});

// ---------------------------------------------------------------- self-healing
test('the supervisor restarts the system after a crash and does not loop on a settings mistake', { skip: process.platform === 'win32' ? 'uses POSIX process tools' : false, timeout: 60000 }, async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nssup-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sup = spawn(process.execPath, ['server/supervisor.js'], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; sup.stdout.on('data', (d) => { log += d; }); sup.stderr.on('data', (d) => { log += d; });
  const healthy = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); } return false; };
  const child = () => execFileSync('pgrep', ['-P', String(sup.pid)], { encoding: 'utf8' }).trim().split('\n')[0];
  try {
    assert.ok(await healthy(15000), `first start\n${log}`);
    const first = child();
    process.kill(Number(first), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(await healthy(25000), `restarted after the crash\n${log}`);
    assert.notEqual(child(), first, 'a new process is serving');
    assert.match(log, /stopped unexpectedly .* Starting it again/);
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
  }
  const bad = spawnSync(process.execPath, ['server/supervisor.js'], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: 'ninety' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(bad.status, 78, 'a settings mistake is reported once, not retried forever');
});

test('message handling that hangs is abandoned so new messages keep flowing', async () => {
  const providers = await import('../server/whatsapp/providers.js');
  const workers = await import('../server/core/workers.js');
  const webhook = await import('../server/whatsapp/webhook.js');
  await h.drain();
  // A media download that never answers (it used to freeze every later message).
  providers.setProviderForTests({ name: 'simulator', async send() { return { ok: true, wamid: `wamid.T${Date.now()}${Math.random()}` }; }, async markRead() {}, downloadMedia: () => new Promise(() => {}) });
  try {
    webhook.ingest(webhook.fakeWebhook({ from: '919700100050', name: 'Hangs', message: { type: 'image', image: { id: 'MEDIA-NEVER', mime_type: 'image/jpeg' } } }), 'simulator');
    workers.processInbound();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(workers.inboundState().running, true, 'the run is stuck on the download');
    webhook.ingest(webhook.fakeWebhook({ from: '919700100051', name: 'Waiting', message: { type: 'text', text: { body: 'Hello' } } }), 'simulator');
    await Promise.race([workers.processInbound(), new Promise((r) => setTimeout(r, 300))]);
    assert.equal(h.outbound('919700100051').length, 0, 'the second person waits while the first run is alive');
    workers.ageInboundRunForTests(11 * 60 * 1000);
    await Promise.race([workers.processInbound(), new Promise((_, rej) => setTimeout(() => rej(new Error('still stuck')), 5000))]);
    await h.drain();
    assert.ok(h.outbound('919700100051').length >= 1, 'the waiting person is answered by the fresh run');
    assert.ok(h.db.one("SELECT 1 FROM system_state WHERE key='inbound_restarted'"), 'recorded for the health panel');
    assert.ok(h.db.one("SELECT 1 FROM notifications WHERE title LIKE 'Message handling was stuck%'"), 'the owner is told');
    const overview = await h.api('GET', '/api/dashboard/overview');
    assert.match(JSON.stringify(overview.body.health.warnings), /got stuck and was restarted automatically/);
  } finally { providers.setProviderForTests(null); }
});

// ---------------------------------------------------------------- screens
test('screens: the phone card-table class is not also a general layout class', () => {
  // A table once took the class "stack", which the stylesheet already used for a
  // column layout: every table on a desktop screen lost its column alignment.
  const css = fs.readFileSync(path.join(ROOT, 'public/shared/style.css'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'public/shared/ui.js'), 'utf8');
  const cls = /table\.classList\.add\('([a-z-]+)'\)/.exec(ui)?.[1];
  assert.ok(cls, 'ui.js marks card tables with a class');
  assert.ok(css.includes(`table.t.${cls} `), 'the stylesheet styles that class on tables');
  const withoutTableRules = css.replaceAll(`table.t.${cls}`, '');
  assert.ok(!new RegExp(`\\.${cls}(?![\\w-])`).test(withoutTableRules), `".${cls}" must only ever style tables`);
});

test('screens: phone layout rules come after the rules they change', () => {
  // The phone rule for page headings once sat above the general rule and lost to it.
  const css = fs.readFileSync(path.join(ROOT, 'public/shared/style.css'), 'utf8');
  const general = css.indexOf('\n.page-head {');
  const phone = css.indexOf('.page-head { align-items: stretch; flex-direction: column; }');
  assert.ok(general > 0 && phone > general, 'the phone heading rule follows the general one');
});

test('team app: a slow GPS or a closed camera can never lose a check-in', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
  const punch = app.slice(app.indexOf('async function punch('), app.indexOf('// ----', app.indexOf('async function punch(')));
  assert.ok(punch.indexOf('pickSelfie()') < punch.indexOf('await locate()'), 'the camera opens straight from the tap, before the wait for GPS');
  assert.match(app, /addEventListener\('cancel'/, 'closing the camera continues without a photo');
  assert.match(app, /'#punch, #punchout', \(e, el\) => withBusy\(/, 'a second tap while working is ignored');
});
