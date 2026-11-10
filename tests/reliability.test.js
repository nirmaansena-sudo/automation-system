// Messaging reliability against a mock WhatsApp Cloud API (real HTTP adapter):
// signatures, dedupe, 24 h window/templates, retries, unknown outcomes, FIFO, guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

const script = []; const received = [];
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    if (json.status === 'read') { res.end('{}'); return; }
    received.push({ url: req.url, auth: req.headers.authorization, body: json });
    const step = script.shift() || 'ok';
    const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (step === 'ok') return reply(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: json.to }], messages: [{ id: 'wamid.T' + crypto.randomBytes(6).toString('hex') }] });
    if (step === 'timeout') return setTimeout(() => reply(200, { messages: [{ id: 'wamid.LATE' }] }), 900);
    if (step === 'http500') return reply(500, { error: { message: 'boom', code: 1 } });
    const code = Number(step.split(':')[1]);
    return reply(400, { error: { message: `err ${code}`, code, error_data: { details: `details ${code}` } } });
  });
});

let h; let mockUrl;
const APP_SECRET = 'test-app-secret';
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}`;
  h = await boot({ WHATSAPP_PROVIDER: 'cloud', WHATSAPP_GRAPH_BASE: mockUrl, WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123456', WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_TIMEOUT_MS: '300' });
});
after(async () => { await h.close(); mock.close(); });

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
async function postWebhook(obj, signature) {
  const raw = JSON.stringify(obj);
  const res = await fetch(h.base + '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', ...(signature !== null ? { 'x-hub-signature-256': signature ?? sign(raw) } : {}) }, body: raw });
  return res.status;
}
const textMsg = (from, body, id) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '123456' }, contacts: [{ wa_id: from, profile: { name: 'Test' } }], messages: [{ from, id, timestamp: '1', type: 'text', text: { body } }] } }] }] });

test('webhook: verification handshake, signature check, durable dedupe', async () => {
  const { config } = await import('../server/config.js');
  const ok = await fetch(`${h.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${config.whatsapp.verifyToken}&hub.challenge=12345`);
  assert.equal(await ok.text(), '12345');
  const bad = await fetch(`${h.base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
  assert.equal(bad.status, 403);
  assert.equal(await postWebhook(textMsg('919700000001', 'Hi', 'wamid.A1'), null), 401, 'unsigned rejected');
  assert.equal(await postWebhook(textMsg('919700000001', 'Hi', 'wamid.A1'), 'sha256=00'), 401, 'bad signature rejected');
  assert.equal(await postWebhook(textMsg('919700000001', 'Hi', 'wamid.A1')), 200);
  assert.equal(await postWebhook(textMsg('919700000001', 'Hi', 'wamid.A1')), 200, 'duplicate still acknowledged');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM inbound_events WHERE dedupe_key='msg:wamid.A1'").n, 1, 'stored once');
  await h.drain();
  const sent = received.filter((r) => r.body.to === '919700000001');
  assert.equal(sent.length, 1, 'replied once');
  assert.equal(sent[0].url, '/v24.0/123456/messages');
  assert.equal(sent[0].auth, 'Bearer tok');
  assert.equal(sent[0].body.type, 'interactive'); assert.equal(sent[0].body.interactive.type, 'list');
  assert.match(sent[0].body.biz_opaque_callback_data, /^ob:\d+$/, 'every send carries the outbox id');
  assert.ok(sent[0].body.interactive.action.sections.flatMap((s) => s.rows).length <= 10, 'WhatsApp list limit respected');
});

test('transient error is retried with backoff; permanent error escalates to a task', async () => {
  script.push('error:131000');
  await postWebhook(textMsg('919700000002', 'Hi', 'wamid.B1'));
  await h.drain();
  const job = h.db.one("SELECT * FROM outbox WHERE to_wa_id='919700000002' ORDER BY id DESC LIMIT 1");
  assert.equal(job.status, 'queued'); assert.equal(job.error_code, '131000');
  h.util.advanceClock(60e3); await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', job.id).status, 'sent', 'sent on retry');
  h.util.resetClock();
  script.push('error:131026');
  const { tx } = h.db;
  const { enqueueWhatsApp } = await import('../server/core/outbox.js');
  const id = tx(() => enqueueWhatsApp({ to: '919700000002', kind: 'test.permanent', essential: true, message: { type: 'text', text: 'x' } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', id).status, 'failed');
  assert.ok(h.db.one("SELECT 1 FROM tasks WHERE dedupe_key=?", `failed:${id}`), 'owner gets a task for an essential failure');
});

test('outside the 24 h window: template if approved, otherwise operator task; 131047 reroutes to template', async () => {
  const { tx } = h.db;
  const { enqueueWhatsApp, retryJob } = await import('../server/core/outbox.js');
  const W = '919700000003';
  const id = tx(() => enqueueWhatsApp({ to: W, kind: 'test.update', message: { type: 'text', text: 'hello' }, template: { name: 'ns_client_update', params: ['NS-PRJ', 'update'] } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', id).status, 'needs_operator', 'draft template cannot be used in cloud mode');
  assert.ok(h.db.one('SELECT 1 FROM tasks WHERE dedupe_key=?', `operator:${id}`));
  h.db.run("UPDATE wa_templates SET status='approved' WHERE name='ns_client_update'");
  tx(() => retryJob(id, 'test'));
  await h.drain();
  const sent = received.filter((r) => r.body.to === W).pop();
  assert.equal(sent.body.type, 'template'); assert.equal(sent.body.template.name, 'ns_client_update');
  assert.deepEqual(sent.body.template.components[0].parameters.map((p) => p.text), ['NS-PRJ', 'update']);
  // window says open (client wrote) but WhatsApp answers 131047 → template
  h.db.run("UPDATE contacts SET last_inbound_at=? WHERE wa_id=?", new Date().toISOString(), W);
  script.push('error:131047');
  const id2 = tx(() => enqueueWhatsApp({ to: W, kind: 'test.window', message: { type: 'text', text: 'hi again' }, template: { name: 'ns_client_update', params: ['A', 'B'] } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status, route FROM outbox WHERE id=?', id2).route, 'template');
});

test('timeout = unknown outcome → reconciled from the status webhook (no duplicate send)', async () => {
  const { tx } = h.db;
  const { enqueueWhatsApp, dispatchOnce } = await import('../server/core/outbox.js');
  const U = '919700000004';
  h.db.run("INSERT OR IGNORE INTO contacts(wa_id, kind, last_inbound_at, created_at, updated_at) VALUES (?, 'client', ?, ?, ?)", U, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  h.db.run('UPDATE contacts SET last_inbound_at=? WHERE wa_id=?', new Date().toISOString(), U);
  script.push('timeout');
  const id = tx(() => enqueueWhatsApp({ to: U, kind: 'test.timeout', message: { type: 'text', text: 'are you there' } }));
  await dispatchOnce();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', id).status, 'unknown');
  const before = received.filter((r) => r.body.to === U).length;
  // WhatsApp later reports the message as sent, echoing our callback data
  const st = { object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.LATE', status: 'sent', timestamp: '2', recipient_id: U, biz_opaque_callback_data: `ob:${id}` }] } }] }] };
  assert.equal(await postWebhook(st), 200);
  await h.drain();
  h.util.advanceClock(6 * 60e3); await h.drain(); h.util.resetClock();
  const row = h.db.one('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(row.status, 'sent'); assert.equal(row.wamid, 'wamid.LATE');
  assert.equal(received.filter((r) => r.body.to === U).length, before, 'not sent twice');
});

test('FIFO per recipient and stale messages are cancelled by their guard', async () => {
  const { tx } = h.db;
  const { enqueueWhatsApp } = await import('../server/core/outbox.js');
  const F = '919700000005';
  h.db.run("INSERT OR IGNORE INTO contacts(wa_id, kind, created_at, updated_at) VALUES (?, 'client', ?, ?)", F, new Date().toISOString(), new Date().toISOString());
  h.db.run('UPDATE contacts SET last_inbound_at=? WHERE wa_id=?', new Date().toISOString(), F);
  script.push('http500');
  const a = tx(() => enqueueWhatsApp({ to: F, kind: 'first', message: { type: 'text', text: 'first' } }));
  const b = tx(() => enqueueWhatsApp({ to: F, kind: 'second', message: { type: 'text', text: 'second' } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', a).status, 'queued');
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', b).status, 'queued', 'second waits for the first');
  h.util.advanceClock(60e3); await h.drain(); h.util.resetClock();
  const texts = received.filter((r) => r.body.to === F && r.body.type === 'text').map((r) => r.body.text.body);
  assert.deepEqual(texts.slice(-2), ['first', 'second'], 'delivered in order');
  // guard: an offer message for an offer that is no longer current is never sent
  const g = tx(() => enqueueWhatsApp({ to: F, kind: 'offer.architect', message: { type: 'text', text: 'old offer' }, guard: { type: 'offer', id: 999999, status: ['pending'] } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', g).status, 'cancelled');
});

test('opted-out contacts only get essential messages', async () => {
  const { tx } = h.db;
  const { enqueueWhatsApp } = await import('../server/core/outbox.js');
  const O = '919700000006';
  h.db.run("INSERT OR IGNORE INTO contacts(wa_id, kind, opted_out, last_inbound_at, created_at, updated_at) VALUES (?, 'client', 1, ?, ?, ?)", O, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const n = tx(() => enqueueWhatsApp({ to: O, kind: 'digest', message: { type: 'text', text: 'daily update' } }));
  const e = tx(() => enqueueWhatsApp({ to: O, kind: 'visit.confirmed', essential: true, message: { type: 'text', text: 'your visit' } }));
  await h.drain();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', n).status, 'cancelled');
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', e).status, 'sent');
});
