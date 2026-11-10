// 360dialog provider: webhook authentication by secret key (360dialog does not sign
// webhooks) and outbound messages through the 360dialog API with D360-API-KEY.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { boot } from './helpers.js';

const received = [];
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    if (json.status === 'read') { res.end('{}'); return; }
    received.push({ url: req.url, key: req.headers['d360-api-key'], body: json });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: json.to }], messages: [{ id: 'wamid.D' + crypto.randomBytes(6).toString('hex') }] }));
  });
});

let h;
const TOKEN = 'verify-token-360';
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  h = await boot({ WHATSAPP_PROVIDER: 'dialog360', DIALOG360_BASE_URL: `http://127.0.0.1:${mock.address().port}`, DIALOG360_API_KEY: 'd360-test-key', WHATSAPP_VERIFY_TOKEN: TOKEN, WHATSAPP_APP_SECRET: '' });
});
after(async () => { await h.close(); mock.close(); });

const textMsg = (from, body, id) => ({ object: 'whatsapp_business_account', entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, contacts: [{ wa_id: from, profile: { name: 'Test' } }], messages: [{ from, id, timestamp: '1', type: 'text', text: { body } }] } }] }] });
async function post(obj, { query = '', headers = {} } = {}) {
  const res = await fetch(`${h.base}/webhooks/whatsapp${query}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
  return res.status;
}

test('360dialog webhook: rejected without the secret key, accepted with URL key or header', async () => {
  assert.equal(await post(textMsg('919700000101', 'Hi', 'wamid.K0')), 401, 'no key → rejected');
  assert.equal(await post(textMsg('919700000101', 'Hi', 'wamid.K0'), { query: '?key=wrong' }), 401, 'wrong key → rejected');
  assert.equal(await post(textMsg('919700000101', 'Hi', 'wamid.K0'), { headers: { 'x-ns-webhook-key': 'wrong' } }), 401, 'wrong header → rejected');
  assert.equal(await post(textMsg('919700000101', 'Hi', 'wamid.K1'), { query: `?key=${TOKEN}` }), 200, 'URL key accepted');
  assert.equal(await post(textMsg('919700000102', 'Hello', 'wamid.K2'), { headers: { 'x-ns-webhook-key': TOKEN } }), 200, 'header key accepted');
  assert.equal(h.db.one('SELECT COUNT(*) n FROM inbound_events').n, 2, 'only authenticated events stored');
});

test('360dialog: replies go to the 360dialog API with the D360-API-KEY header', async () => {
  await h.drain();
  const sent = received.filter((r) => r.body.to === '919700000101');
  assert.ok(sent.length >= 1, 'bot replied through 360dialog');
  assert.equal(sent[0].url, '/messages');
  assert.equal(sent[0].key, 'd360-test-key');
  assert.equal(sent[0].body.messaging_product, 'whatsapp');
  const ob = h.db.one("SELECT status FROM outbox WHERE to_wa_id='919700000101' ORDER BY id LIMIT 1");
  assert.equal(ob.status, 'sent');
});
