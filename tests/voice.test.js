import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot } from './helpers.js';
let h, mock, config, saveMediaBuffer, voice, costs, owner, requests = [], mode = 'ok';
before(async () => {
  h = await boot();
  ({ config } = await import('../server/config.js'));
  ({ saveMediaBuffer } = await import('../server/whatsapp/providers.js'));
  voice = await import('../server/lib/transcription.js');
  costs = await import('../server/lib/costs.js');
  owner = h.db.one("SELECT * FROM users WHERE role='owner'");
  mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (mode === 'failure') { res.writeHead(503); res.end('unavailable'); return; }
    if (mode === 'slow') { setTimeout(() => { res.end(JSON.stringify({ text: 'late' })); }, 1500); return; }
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'कल site पर 10 बजे मिलते हैं।' }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  config.transcription = { url: '', token: '', timeoutMs: 30000, dailyLimit: 25 };
});
after(async () => { if (h) await h.close(); if (mock) { mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); } });
function audio(bytes = Buffer.from('OggS dummy voice'), mime = 'audio/ogg') {
  const stored = saveMediaBuffer(bytes, mime);
  const id = h.db.insert('media', { mime, file_path: stored.filePath, size: stored.size, sha256: stored.sha256, status: 'stored', created_at: new Date().toISOString() });
  const c = h.db.one('SELECT id FROM contacts LIMIT 1');
  h.db.insert('messages', { contact_id: c.id, direction: 'in', type: 'audio', body: 'Voice note', media_id: id, sender: 'client', status: 'received', created_at: new Date().toISOString() });
  return id;
}
const enable = () => { config.transcription.url = `http://127.0.0.1:${mock.address().port}/inference`; };
test('transcription is disabled by default and access requires a manager login', async () => {
  const id = audio();
  assert.equal((await h.api('POST', `/api/voice/${id}/transcribe`, {})).status, 400);
  assert.equal(requests.length, 0);
  assert.equal((await h.api('POST', `/api/voice/${id}/transcribe`, {}, { noCookie: true })).status, 401);
});
test('multipart local transcription is cached across concurrent/repeated requests and never replies', async () => {
  enable(); const id = audio(); const before = requests.length;
  const outgoing = h.db.one('SELECT COUNT(*) n FROM outbox').n;
  const results = await Promise.all([h.api('POST', `/api/voice/${id}/transcribe`, { language: 'auto' }), h.api('POST', `/api/voice/${id}/transcribe`, { language: 'auto' })]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(requests.length - before, 1);
  assert.match(requests.at(-1).headers['content-type'], /multipart\/form-data; boundary=/);
  assert.match(requests.at(-1).body, /name="file"; filename="voice.ogg"/);
  assert.match(requests.at(-1).body, /name="language"\r\n\r\nauto/);
  assert.match(requests.at(-1).body, /name="response_format"\r\n\r\njson/);
  assert.equal((await h.api('POST', `/api/voice/${id}/transcribe`, {})).body.cached, true);
  assert.equal(requests.length - before, 1);
  assert.equal(h.db.one('SELECT COUNT(*) n FROM outbox').n, outgoing);
  const review = await h.api('PATCH', `/api/voice/${id}/review`, { text: 'कल साइट पर दस बजे।' });
  assert.equal(review.status, 200); assert.ok(review.body.reviewed_at);
  const saved = h.db.one('SELECT * FROM media_transcripts WHERE media_id=?', id);
  assert.equal(saved.original_text, 'कल site पर 10 बजे मिलते हैं।');
  assert.equal(saved.text, 'कल साइट पर दस बजे।');
  assert.equal(h.db.one('SELECT body FROM messages WHERE media_id=?', id).body, 'Voice note');
});
test('oversized/non-audio files fail before network activity and daily cap counts failed attempts', async () => {
  enable(); const before = requests.length;
  assert.equal((await h.api('POST', `/api/voice/${audio(Buffer.alloc(8 * 1024 * 1024 + 1))}/transcribe`, {})).status, 400);
  assert.equal((await h.api('POST', `/api/voice/${audio(Buffer.from('png'), 'image/png')}/transcribe`, {})).status, 400);
  assert.equal(requests.length, before);
  const used = h.db.one("SELECT COUNT(*) n FROM compute_usage WHERE kind='transcription'").n;
  config.transcription.dailyLimit = used + 1; mode = 'failure';
  assert.equal((await h.api('POST', `/api/voice/${audio()}/transcribe`, {})).status, 502);
  assert.equal((await h.api('POST', `/api/voice/${audio()}/transcribe`, {})).status, 429);
  assert.equal(requests.length, before + 1); mode = 'ok'; config.transcription.dailyLimit = 25;
});
test('a configured timeout is bounded and a failed result can be retried manually', async () => {
  enable(); const id = audio(); mode = 'slow'; config.transcription.timeoutMs = 1000;
  const started = Date.now();
  assert.equal((await h.api('POST', `/api/voice/${id}/transcribe`, {})).status, 502);
  assert.ok(Date.now() - started < 3000);
  assert.equal(voice.getTranscript(id).status, 'failed');
  mode = 'ok'; config.transcription.timeoutMs = 30000;
  assert.equal((await h.api('POST', `/api/voice/${id}/transcribe`, {})).status, 200);
});
test('cost reports exclude later months, leave unknown tariffs unpriced, and cap AI before any network call', async () => {
  const contact = h.db.one('SELECT id FROM contacts LIMIT 1');
  for (const created_at of ['2027-01-31T18:29:59.000Z', '2027-01-31T18:30:00.000Z']) h.db.insert('messages', { contact_id: contact.id, direction: 'out', type: 'text', status: 'sent', route: 'freeform', created_at });
  h.db.insert('outbox', { kind: 'queued-january-sent-february', payload: '{}', status: 'sent', created_at: '2027-01-31T18:29:59.000Z', sent_at: '2027-01-31T18:30:00.000Z' });
  const january = costs.usageReport('2027-01');
  assert.equal(january.byCategory.find((x) => x.cat === 'service').n, 1);
  assert.equal(january.byKind.some((x) => x.kind === 'queued-january-sent-february'), false);
  assert.equal(costs.usageReport('2027-02').byKind.find((x) => x.kind === 'queued-january-sent-february').n, 1);
  assert.equal(january.lines.find((x) => x.key === 'service').estimate, null);
  costs.saveCostPolicy({ rates: { service: 0.75 }, fixedMonthlyCost: 100, monthlyBudget: 50, aiDailyLimit: 0 }, owner);
  assert.equal(costs.usageReport('2027-01').knownEstimate, 100.75);
  assert.equal(costs.usageReport('2027-01').budgetExceeded, true);
  assert.throws(() => costs.saveCostPolicy({ rates: { service: [] } }, owner));
  assert.throws(() => costs.saveCostPolicy({ aiDailyLimit: null }, owner));
  const saved = { ...config.ai }; config.ai.mode = 'openai'; config.ai.apiKey = 'test-no-call'; config.ai.baseUrl = 'http://127.0.0.1:1'; config.ai.model = '';
  const { understand, aiEnabled } = await import('../server/bot/ai.js');
  assert.equal(aiEnabled(), false, 'No assumed model is selected');
  config.ai.model = 'test-explicit-model';
  assert.equal(await understand({ text: 'test message', zones: [] }), null);
  assert.ok(h.db.one("SELECT value FROM system_state WHERE key='ai_daily_limit'"));
  Object.assign(config.ai, saved);
  const endpoint = await h.api('GET', '/api/messages/usage?month=2027-01');
  assert.equal(endpoint.status, 200); assert.equal(endpoint.body.freeServiceTier, undefined);
});
