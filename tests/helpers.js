// Test harness: boots the real server in-process on a temp database with the
// WhatsApp simulator, background loops off (tests call drain() explicitly).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function boot(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstest-'));
  Object.assign(process.env, { DATA_DIR: dir, NS_DISABLE_WORKERS: 'true', NS_TEST: 'true', WHATSAPP_PROVIDER: 'simulator', PUBLIC_URL: 'http://test.local', ...extraEnv });
  const { buildServer } = await import('../server/index.js');
  const server = buildServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = await import('../server/db/index.js');
  const workers = await import('../server/core/workers.js');
  const webhook = await import('../server/whatsapp/webhook.js');
  const base_ = await import('../server/core/base.js');
  const util = await import('../server/lib/util.js');
  let cookie = '';
  async function api(method, p, body, opts = {}) {
    const headers = { 'x-ns': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
    if (!opts.noCookie && cookie) headers.cookie = cookie;
    const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc && !opts.noCookie) cookie = sc.split(';')[0];
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  // owner + demo data, business hours = all day so tests do not depend on the clock
  const setup = await api('POST', '/api/setup', { name: 'Owner', email: 'owner@test.local', password: 'password123', demo: true });
  if (setup.status !== 200) throw new Error('setup failed ' + JSON.stringify(setup.body));
  db.tx(() => base_.saveSettings({ business_hours: { open: '00:00', close: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } }, 'test'));

  const drain = () => workers.drain(60);
  async function say(from, msg, name) {
    const message = typeof msg === 'string' ? { type: 'text', text: { body: msg } } : msg;
    webhook.ingest(webhook.fakeWebhook({ from, name, message }), 'simulator');
    await drain();
  }
  const press = (from, id, title = 'btn') => say(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const pick = (from, id, title = 'row') => say(from, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title } } });
  const tplPress = (from, payload) => say(from, { type: 'button', button: { payload, text: 'btn' } });
  const location = (from, lat, lng, name = 'Site', address = 'Jaipur') => say(from, { type: 'location', location: { latitude: lat, longitude: lng, name, address } });
  function outbound(waId) {
    return db.all("SELECT m.*, o.route AS ob_route, o.template AS ob_template FROM messages m JOIN contacts c ON c.id=m.contact_id LEFT JOIN outbox o ON o.id=m.outbox_id WHERE c.wa_id=? AND m.direction='out' ORDER BY m.id", waId)
      .map((m) => ({ ...m, payload: m.payload ? JSON.parse(m.payload) : null }));
  }
  const last = (waId) => { const o = outbound(waId); return o[o.length - 1]; };
  const findButton = (msg, prefix) => (msg.payload?.buttons || []).find((b) => b.id.startsWith(prefix));
  const listRows = (msg) => (msg.payload?.sections || []).flatMap((s) => s.rows);
  return { dir, server, base, api, db, drain, say, press, pick, tplPress, location, outbound, last, findButton, listRows, util, close: () => new Promise((r) => server.close(r)) };
}
