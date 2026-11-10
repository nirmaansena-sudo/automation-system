// n8n layer: workflow files are valid, their Code nodes behave, and the backend
// talks to n8n correctly (AI understanding + reliable event delivery).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wf = (f) => JSON.parse(fs.readFileSync(path.join(root, 'n8n', 'workflows', f), 'utf8'));
const code = (w, name) => w.nodes.find((n) => n.name === name).parameters.jsCode;
async function runCode(js, input, env) {
  const fn = new Function('$input', '$env', `return (async () => { ${js} })()`);
  return fn({ first: () => ({ json: input }) }, env);
}

const hits = { ai: [], events: [] };
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    if (req.url === '/webhook/ns-ai-understand') {
      hits.ai.push({ secret: req.headers['x-ns-secret'], json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ intent: 'new_enquiry', services: ['turnkey'], zone: 'mansarovar', area_sqft: 1800, confidence: 0.92, summary: 'Wants a house near Mansarovar' }));
      return;
    }
    if (req.url === '/webhook/ns-events') { hits.events.push({ secret: req.headers['x-ns-secret'], json }); res.end('{"message":"Workflow was started"}'); return; }
    res.writeHead(404); res.end();
  });
});

let h;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  h = await boot({ AI_MODE: 'n8n', N8N_BASE_URL: `http://127.0.0.1:${mock.address().port}` });
});
after(async () => { await h.close(); mock.close(); });

test('all workflow files pass the structural check', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'check-n8n.js')], { encoding: 'utf8' });
  assert.match(out, /All n8n workflow files look valid/);
});

test('AI workflow code: rejects a wrong secret, builds the request, parses the reply', async () => {
  const w = wf('01-ai-understanding.json');
  const env = { NS_N8N_SECRET: 's3', NS_AI_MODEL: 'test-model' };
  await assert.rejects(runCode(code(w, 'Check secret & build AI request'), { headers: { 'x-ns-secret': 'bad' }, body: {} }, env));
  const [req] = await runCode(code(w, 'Check secret & build AI request'), { headers: { 'x-ns-secret': 's3' }, body: { prompt: { system: 'SYS', user: 'USER' } } }, env);
  assert.equal(req.json.model, 'test-model'); assert.equal(req.json.messages[1].content, 'USER');
  const [ok] = await runCode(code(w, 'Parse answer'), { choices: [{ message: { content: 'Sure: {"intent":"faq","faq_id":2,"confidence":0.8}' } }] }, env);
  assert.equal(ok.json.intent, 'faq');
  const [fallback] = await runCode(code(w, 'Parse answer'), { error: { message: 'timeout' } }, env);
  assert.equal(fallback.json.intent, 'other');
});

test('event & watchdog workflow code', async () => {
  const events = wf('03-business-events.json');
  assert.equal(events.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters.responseMode, 'lastNode', 'acknowledge after downstream work');
  await assert.rejects(runCode(code(events, 'Format event'), { headers: {}, body: {} }, {}), /Unauthorised/);
  const [identified] = await runCode(code(events, 'Format event'), { headers: { 'x-ns-secret': 'k' }, body: { eventId: 'event-stable-123', type: 'test', data: {} } }, { NS_N8N_SECRET: 'k' });
  assert.equal(identified.json.eventId, 'event-stable-123');
  const [e] = await runCode(code(wf('03-business-events.json'), 'Format event'), { headers: { 'x-ns-secret': 'k' }, body: { type: 'lead.submitted', at: 'now', data: { ref: 'NS-JPR-2026-0009', services: ['turnkey'], zone: 'vaishali' } } }, { NS_N8N_SECRET: 'k' });
  assert.match(e.json.title, /NS-JPR-2026-0009/); assert.equal(e.json.important, true);
  const ev = code(wf('05-health-watchdog.json'), 'Evaluate');
  assert.equal((await runCode(ev, { error: { message: 'ECONNREFUSED' } }, {}))[0].json.down, true);
  assert.equal((await runCode(ev, { ok: true, warnings: [] }, {}))[0].json.problem, false);
  assert.equal((await runCode(ev, { ok: false, warnings: ['Timer loop not running'] }, {}))[0].json.problem, true);
});

test('backend uses n8n for AI understanding (with the shared secret) and fills lead fields', async () => {
  const P = '919811100011';
  await h.say(P, 'Need help with a plot near the big temple, can you do everything for us?', 'Ankit');
  assert.ok(hits.ai.length >= 1, 'n8n AI webhook was called');
  const { config } = await import('../server/config.js');
  assert.equal(hits.ai[0].secret, config.n8n.secret);
  assert.ok(hits.ai[0].json.prompt.system.includes('Nirmaan Sena'));
  const lead = h.db.one('SELECT * FROM leads WHERE phone=?', P);
  assert.equal(lead.zone, 'mansarovar'); assert.equal(lead.area_sqft, 1800);
  assert.match(lead.ai_summary || '', /Mansarovar/);
  const m = h.last(P);
  assert.ok((m.payload.sections || []).flatMap((s) => s.rows).some((r) => r.id.startsWith('F:nature')), 'asks only the next missing field');
});

test('business events are delivered to n8n through the outbox', async () => {
  const lead = h.db.one("SELECT * FROM leads WHERE phone='919811100011'");
  h.db.tx(() => { h.db.run("UPDATE leads SET project_nature='new_build', execution_window='immediate', address='Near temple', location_source='text', preferred_slots='[]' WHERE id=?", lead.id); });
  const { submitLead } = await import('../server/domain/leads.js');
  h.db.tx(() => submitLead(lead.id, { slotOther: true }));
  await h.drain();
  const got = hits.events.find((x) => x.json.type === 'lead.submitted' && x.json.data.ref === lead.ref);
  assert.ok(got, 'lead.submitted reached n8n');
  assert.match(got.json.eventId, /^[0-9a-f-]{36}$/, 'event has a stable deduplication identifier');
  const { config } = await import('../server/config.js');
  assert.equal(got.secret, config.n8n.secret);
  assert.equal(h.db.one("SELECT COUNT(*) n FROM outbox WHERE channel='n8n' AND status='sent'").n >= 1, true);
});
