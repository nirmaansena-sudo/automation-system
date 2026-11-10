import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let h, staff, other, owner, common, travel, dispatch, engine, config;
let serial = 0;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8WQAAAAASUVORK5CYII=';
before(async () => {
  h = await boot();
  common = await import('../server/domain/common.js');
  travel = await import('../server/domain/travel.js');
  dispatch = await import('../server/domain/dispatch.js');
  engine = await import('../server/bot/engine.js');
  ({ config } = await import('../server/config.js'));
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  for (const [name, phone] of [['WA architect', '919999001101'], ['Other architect', '919999001102']]) {
    const response = await h.api('POST', '/api/team', { name, phone, role: 'architect', pin: '121212' });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  staff = h.db.one('SELECT * FROM users WHERE phone=?', '919999001101');
  other = h.db.one('SELECT * FROM users WHERE phone=?', '919999001102');
  dispatch.saveDispatchSettings({ travel: { rate_per_km: 10, base_amount: 0, minimum_amount: 0, maximum_amount: 200, rounding_rupees: 1 } }, `user:${owner.id}`);
  dispatch.setLocationProfile(staff.id, { home_lat: 26.95, home_lng: 75.75, home_label: 'Private home address', default_origin: 'home' }, `user:${staff.id}`);
});
after(async () => { if (h) { h.util.resetClock(); (await import('../server/whatsapp/providers.js')).setSimulatorHooks({ onSent: () => {} }); await h.close(); h.db.closeDb(); } });

function visit(architect = staff, status = 'confirmed') {
  const n = ++serial;
  const c = h.db.insert('contacts', { wa_id: `919700${String(n).padStart(6, '0')}`, name: `Client ${n}` });
  const lead = h.db.insert('leads', { contact_id: c, ref: `WA-L${n}`, name: `Client ${n}`, phone: `919700${String(n).padStart(6, '0')}`, address: `Private site ${n}, Jaipur`, services: '["interiors"]', requirements: 'Design a family living room', site_lat: 26.92, site_lng: 75.80, status: 'visit_confirmed' });
  const id = h.db.insert('visits', { ref: `WA-V${n}`, lead_id: lead, architect_id: architect.id, start_at: h.util.addMinIso(h.util.nowIso(), 60), end_at: h.util.addMinIso(h.util.nowIso(), 120), revision: 1, status });
  return { id, lead, c };
}
function project(architect = staff) {
  const v = visit(architect), n = ++serial;
  const id = h.db.insert('projects', { ref: `WA-P${n}`, name: `Assigned house ${n}`, lead_id: v.lead, client_contact_id: v.c, status: 'active', architect_id: architect.id, manager_id: owner.id, public_token: `test-public-project-${n}`, address: 'Site address', contract_value: 1234567 });
  h.db.insert('milestones', { project_id: id, seq: 1, name: 'Design drawings', status: 'in_progress', progress: 50 });
  return { id, ...h.db.one('SELECT * FROM projects WHERE id=?', id) };
}
function task(architect = staff) {
  const n = ++serial;
  return h.db.insert('tasks', { title: `Prepare drawing ${n}`, description: `Work brief ${n}`, assignee_id: architect.id, updated_at: h.util.nowIso() });
}
const context = () => common.getConversation(common.ensureContact(staff.phone).id);
const draft = () => JSON.parse(context().ctx || '{}');
const click = (prefix) => {
  const b = h.findButton(h.last(staff.phone), prefix) || h.listRows(h.last(staff.phone)).find(x => x.id.startsWith(prefix));
  assert.ok(b, `Expected ${prefix} in ${JSON.stringify(h.last(staff.phone)?.payload)}`);
  return h.press(staff.phone, b.id);
};
const photo = () => h.say(staff.phone, { type: 'image', image: { mime_type: 'image/png', _sim_data: png } });
async function reportDraft(id, withPhoto = false) {
  await h.press(staff.phone, `W:REPORT:${id}`);
  await h.say(staff.phone, 'Interior renovation and room layout');
  await click('W:SKIP:'); await click('W:SKIP:');
  await h.say(staff.phone, 'Prepare drawings for manager review');
  if (withPhoto) await photo();
  await click('W:REVIEW:');
  return draft();
}
async function replayLastInbound() {
  const event = h.db.one("SELECT * FROM inbound_events WHERE kind='message' AND wa_id=? ORDER BY id DESC LIMIT 1", staff.phone);
  await engine.processInboundEvent(event); await h.drain();
}

test('known staff get bilingual work menus and only their assigned visits, without attendance actions', async () => {
  const mine = visit(), theirs = visit(other);
  await h.say(staff.phone, 'MENU');
  assert.ok(h.listRows(h.last(staff.phone)).some(x => x.id === 'W:VISITS:0'));
  assert.equal(h.listRows(h.last(staff.phone)).some(x => /attendance/i.test(x.id + x.title)), false);
  await h.pick(staff.phone, 'W:VISITS:0');
  assert.ok(h.listRows(h.last(staff.phone)).some(x => x.id === `W:V:${mine.id}`));
  assert.equal(h.listRows(h.last(staff.phone)).some(x => x.id === `W:V:${theirs.id}`), false);
  await h.pick(staff.phone, `W:V:${mine.id}`);
  assert.match(h.last(staff.phone).body, /Private site/);
  await h.pick(staff.phone, `W:NAV:${mine.id}`);
  assert.match(h.last(staff.phone).body, /google\.com\/maps/);
  await h.press(staff.phone, `W:V:${theirs.id}`); assert.match(h.last(staff.phone).body, /not assigned/);
  await h.press(staff.phone, 'W:V:not-a-number'); assert.match(h.last(staff.phone).body, /Invalid work reference/);
  await h.say(staff.phone, 'हिंदी'); assert.match(h.last(staff.phone).body, /नमस्ते/);
  await h.say(staff.phone, 'English'); assert.match(h.last(staff.phone).body, /Hello/);
  const before = h.db.one('SELECT COUNT(*) n FROM attendance_events').n;
  await h.say(staff.phone, 'attendance'); assert.match(h.last(staff.phone).body, /employee app/);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM attendance_events').n, before);
});

test('visit report waits for explicit confirmation, attaches private draft photos and is replay safe', async () => {
  const v = visit();
  const d = await reportDraft(v.id, true);
  assert.equal(h.db.one('SELECT status FROM visits WHERE id=?', v.id).status, 'confirmed');
  const media = h.db.one('SELECT * FROM media WHERE id=?', d.media_ids[0]);
  assert.equal(media.owner_type, 'staff_message'); assert.equal(media.uploaded_by, `user:${staff.id}`);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM approvals WHERE entity_type=? AND entity_id=?', 'visit', v.id).n, 0);
  await click('W:SAVE:');
  assert.equal(h.db.one('SELECT status FROM visits WHERE id=?', v.id).status, 'report_submitted');
  assert.equal(JSON.parse(h.db.one('SELECT report FROM visits WHERE id=?', v.id).report).scope, d.data.scope);
  assert.equal(h.db.one('SELECT owner_type FROM media WHERE id=?', media.id).owner_type, 'visit');
  await replayLastInbound();
  assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='visit.report' AND entity_id=?", v.id).n, 1);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM approvals WHERE kind='visit_report' AND entity_id=?", v.id).n, 1);
  await h.press(staff.phone, `W:SAVE:${d.nonce}`);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='visit.report' AND entity_id=?", v.id).n, 1);
});

test('cancel, expired drafts and reassignment prevent submission and photo leakage', async () => {
  const v = visit(); const d = await reportDraft(v.id, true);
  h.db.run('UPDATE visits SET architect_id=?,revision=revision+1 WHERE id=?', other.id, v.id);
  await h.press(staff.phone, `W:SAVE:${d.nonce}`); assert.match(h.last(staff.phone).body, /not assigned/);
  assert.equal(h.db.one('SELECT status FROM visits WHERE id=?', v.id).status, 'confirmed');
  assert.equal(h.db.one('SELECT owner_type FROM media WHERE id=?', d.media_ids[0]).owner_type, 'staff_message');
  await h.say(staff.phone, 'CANCEL'); assert.equal(context().flow, null);
  const next = visit(); const d2 = await reportDraft(next.id);
  h.util.advanceClock(121 * 60000);
  await h.press(staff.phone, `W:SAVE:${d2.nonce}`); assert.match(h.last(staff.phone).body, /expired/);
  assert.equal(h.db.one('SELECT status FROM visits WHERE id=?', next.id).status, 'confirmed');
  h.util.resetClock(); await h.say(staff.phone, 'MENU');
});

test('task status and note are confirmed, assignment checked, stale drafts rejected and lists paginated', async () => {
  const mine = task(), theirs = task(other);
  await h.press(staff.phone, `W:TS:${theirs}:done`); assert.match(h.last(staff.phone).body, /not assigned/);
  await h.press(staff.phone, `W:TS:${mine}:done`); await h.say(staff.phone, 'Drawing sent to manager');
  assert.equal(h.db.one('SELECT status FROM tasks WHERE id=?', mine).status, 'todo');
  const d = draft(); h.db.run("UPDATE tasks SET status='in_progress' WHERE id=?", mine);
  await h.press(staff.phone, `W:SAVE:${d.nonce}`); assert.match(h.last(staff.phone).body, /task changed/);
  await h.press(staff.phone, `W:TS:${mine}:done`); await h.say(staff.phone, 'Drawing sent to manager'); await click('W:SAVE:');
  assert.equal(h.db.one('SELECT status FROM tasks WHERE id=?', mine).status, 'done');
  assert.match(h.db.one('SELECT evidence FROM tasks WHERE id=?', mine).evidence, /Drawing sent/);
  for (let i = 0; i < 16; i++) task();
  await h.press(staff.phone, 'W:TASKS:0'); let rows = h.listRows(h.last(staff.phone));
  assert.ok(rows.length <= 10); assert.ok(rows.some(x => x.id === 'W:TASKS:1'));
  await h.pick(staff.phone, 'W:TASKS:1'); rows = h.listRows(h.last(staff.phone)); assert.equal(rows.length, 10);
  assert.ok(rows.some(x => x.id === 'W:TASKS:0'));
});

test('project work updates preserve explicit client visibility and only publish confirmed photos', async () => {
  const p = project(), foreign = project(other);
  await h.press(staff.phone, `W:P:${foreign.id}`); assert.match(h.last(staff.phone).body, /not assigned/);
  await h.press(staff.phone, `W:P:${p.id}`); assert.match(h.last(staff.phone).body, /Design drawings/); assert.doesNotMatch(h.last(staff.phone).body, /1234567/);
  async function submit(visibility) {
    await h.press(staff.phone, `W:LOG:${p.id}`); await h.say(staff.phone, 'Ceiling drawings prepared'); await click('W:SKIP:'); await photo(); await click('W:REVIEW:');
    const d = draft(); assert.equal(h.db.one('SELECT owner_type FROM media WHERE id=?', d.media_ids[0]).owner_type, 'staff_message');
    await h.press(staff.phone, `W:SAVE:${d.nonce}:${visibility}`);
    return { log: h.db.one('SELECT * FROM site_logs WHERE project_id=? ORDER BY id DESC LIMIT 1', p.id), media: d.media_ids[0] };
  }
  const privateLog = await submit('private'); assert.equal(privateLog.log.client_visible, 0);
  assert.equal((await h.api('GET', `/media/${privateLog.media}?t=${p.public_token}`, undefined, { noCookie: true })).status, 403);
  const visibleLog = await submit('client'); assert.equal(visibleLog.log.client_visible, 1);
  assert.equal(h.db.one('SELECT owner_id FROM media WHERE id=?', visibleLog.media).owner_id, visibleLog.log.id);
  assert.equal((await h.api('GET', `/media/${visibleLog.media}?t=${p.public_token}`, undefined, { noCookie: true })).status, 200);
  await replayLastInbound(); assert.equal(h.db.one('SELECT COUNT(*) n FROM site_logs WHERE project_id=?', p.id).n, 2);
});

test('home and office travel estimates require confirmation, manager approval and one claim', async () => {
  const v = visit(staff, 'report_submitted');
  await h.press(staff.phone, `W:TR:${v.id}`);
  assert.match(h.last(staff.phone).body, /Home:/); assert.match(h.last(staff.phone).body, /Office:/); assert.doesNotMatch(h.last(staff.phone).body, /26\.95|Private home address/);
  await click(`W:TO:${v.id}:home`); assert.equal(travel.readTravel(v.id, staff), null);
  await click('W:SAVE:'); let current = travel.readTravel(v.id, staff); assert.equal(current.origin_type, 'home'); assert.equal(current.status, 'proposed');
  await h.press(staff.phone, `W:CL:${v.id}`); assert.match(h.last(staff.phone).body, /manager approval/);
  travel.approveTravel(v.id, owner, { expected_revision: current.revision, verified_distance_km: 30, note: 'Verified real route' });
  await h.press(staff.phone, `W:CL:${v.id}`); assert.equal(h.db.one('SELECT COUNT(*) n FROM expense_claims WHERE user_id=?', staff.id).n, 0);
  const d = draft(); await click('W:SAVE:'); current = travel.readTravel(v.id, staff);
  assert.ok(current.expense_id); assert.equal(h.db.one('SELECT amount FROM expense_claims WHERE id=?', current.expense_id).amount, 200);
  await replayLastInbound(); await h.press(staff.phone, `W:CL:${v.id}`); await h.press(staff.phone, `W:SAVE:${d.nonce}`);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM expense_claims WHERE user_id=?', staff.id).n, 1);
  const foreign = visit(other); await h.press(staff.phone, `W:TR:${foreign.id}`); assert.match(h.last(staff.phone).body, /not assigned/);
});

test('changed travel origin and manager takeover during route await cannot save a stale confirmation', async () => {
  const v = visit();
  await h.press(staff.phone, `W:TR:${v.id}`); await click(`W:TO:${v.id}:home`);
  const d = draft();
  dispatch.setLocationProfile(staff.id, { home_lat: 26.96, home_lng: 75.75, home_label: 'Moved home', default_origin: 'home' }, `user:${staff.id}`);
  await h.press(staff.phone, `W:SAVE:${d.nonce}`); assert.match(h.last(staff.phone).body, /estimate changed/); assert.equal(travel.readTravel(v.id, staff), null);
  const previousUrl = config.routing.osrmUrl, fetch0 = globalThis.fetch;
  try {
    config.routing.osrmUrl = 'https://routing.test.invalid';
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(config.routing.osrmUrl)) {
        // This callback runs while travelOptions is awaiting an external route.
        h.db.tx(() => engine.takeOver(common.ensureContact(staff.phone).id, owner));
        return { ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 20000, duration: 2000 }] }) };
      }
      return fetch0(url, options);
    };
    await h.press(staff.phone, `W:TO:${v.id}:home:0`);
    assert.equal(context().mode, 'human'); assert.equal(travel.readTravel(v.id, staff), null);
  } finally { globalThis.fetch = fetch0; config.routing.osrmUrl = previousUrl; h.db.tx(() => engine.releaseToBot(context().id)); }
});

test('staff help alerts managers and old work buttons stay paused until explicit release', async () => {
  const t = task(); await h.press(staff.phone, `W:TS:${t}:done`); await click('W:SKIP:'); const d = draft();
  await h.say(staff.phone, 'HELP'); assert.equal(context().mode, 'human'); assert.ok(context().human_requested_at);
  assert.ok(h.db.one("SELECT 1 FROM notifications WHERE title LIKE 'Staff needs help%'"));
  const replies = h.outbound(staff.phone).length;
  await h.press(staff.phone, `W:SAVE:${d.nonce}`); await h.say(staff.phone, 'MENU');
  assert.equal(h.outbound(staff.phone).length, replies); assert.equal(h.db.one('SELECT status FROM tasks WHERE id=?', t).status, 'todo');
  h.db.tx(() => engine.releaseToBot(context().id)); await h.say(staff.phone, 'MENU'); assert.equal(context().mode, 'bot');
});

test('disabled and changed-number staff cannot fall into earlier client flows or forge business actions', async () => {
  const contact = common.ensureContact(staff.phone), v = visit();
  common.setFlow(contact.id, 'quote_change', null, { quoteId: 1 });
  h.db.run('UPDATE users SET active=0 WHERE id=?', staff.id);
  await h.press(staff.phone, `W:REPORT:${v.id}`); assert.match(h.last(staff.phone).body, /access is unavailable/);
  h.db.run('UPDATE users SET active=1,phone=? WHERE id=?', '919999001103', staff.id);
  await h.say(staff.phone, 'MENU'); assert.match(h.last(staff.phone).body, /access is unavailable/);
  h.db.run('UPDATE users SET phone=? WHERE id=?', staff.phone, staff.id);
  await h.say(staff.phone, 'MENU'); await h.press(staff.phone, 'Q:A:1'); assert.match(h.last(staff.phone).body, /not available in the staff work menu/);
  const unknown = '919999001199'; await h.press(unknown, `W:REPORT:${v.id}`);
  assert.equal(h.db.one('SELECT status FROM visits WHERE id=?', v.id).status, 'confirmed');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM inbound_events WHERE status IN ('failed','dead') AND wa_id=?", staff.phone).n, 0);
});

test('queued work responses are cancelled if assignment or human ownership changes before delivery', async () => {
  const v = visit();
  async function queue(buttonId) {
    await engine.processInboundEvent({ kind: 'message', payload: JSON.stringify({ wamid: `wamid.QUEUE-${++serial}`, from: staff.phone, type: 'interactive', buttonId }) });
    return h.db.one('SELECT * FROM outbox WHERE to_wa_id=? ORDER BY id DESC LIMIT 1', staff.phone);
  }
  const details = await queue(`W:V:${v.id}`); assert.equal(details.status, 'queued');
  h.db.run('UPDATE visits SET architect_id=? WHERE id=?', other.id, v.id);
  await h.drain(); assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', details.id).status, 'cancelled');
  const mine = task();
  const list = await queue('W:TASKS:0');
  const listedId = JSON.parse(list.guard).resource[0].id;
  h.db.run('UPDATE tasks SET assignee_id=? WHERE id=?', other.id, listedId);
  await h.drain(); assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', list.id).status, 'cancelled');
  const taskDetail = await queue(`W:T:${mine}`);
  h.db.tx(() => engine.takeOver(common.ensureContact(staff.phone).id, owner));
  await h.drain(); assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', taskDetail.id).status, 'cancelled');
  h.db.tx(() => engine.releaseToBot(context().id));
});
