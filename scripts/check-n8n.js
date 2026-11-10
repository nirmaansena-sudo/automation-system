// Structural check of the n8n workflow files (run: npm run check).
// Verifies JSON, unique node names/ids, known node types, connections and triggers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'n8n', 'workflows');
const KNOWN = {
  'n8n-nodes-base.webhook': [2], 'n8n-nodes-base.respondToWebhook': [1.1], 'n8n-nodes-base.code': [2], 'n8n-nodes-base.httpRequest': [4.2],
  'n8n-nodes-base.scheduleTrigger': [1.2], 'n8n-nodes-base.if': [2], 'n8n-nodes-base.emailSend': [2.1], 'n8n-nodes-base.noOp': [1],
  'n8n-nodes-base.errorTrigger': [1], 'n8n-nodes-base.stickyNote': [1],
};
const TRIGGERS = ['n8n-nodes-base.webhook', 'n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.errorTrigger'];
let failures = 0;
const fail = (f, msg) => { failures++; console.error(`✗ ${f}: ${msg}`); };

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  let wf;
  try { wf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { fail(f, `invalid JSON: ${e.message}`); continue; }
  if (!wf.name || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object') { fail(f, 'missing name/nodes/connections'); continue; }
  const names = new Set(); const ids = new Set();
  for (const n of wf.nodes) {
    if (names.has(n.name)) fail(f, `duplicate node name "${n.name}"`); names.add(n.name);
    if (!/^[0-9a-f-]{36}$/.test(n.id || '')) fail(f, `bad id on "${n.name}"`);
    if (ids.has(n.id)) fail(f, `duplicate id on "${n.name}"`); ids.add(n.id);
    if (!KNOWN[n.type]) fail(f, `unknown node type ${n.type}`);
    else if (!KNOWN[n.type].includes(n.typeVersion)) fail(f, `unexpected typeVersion ${n.typeVersion} for ${n.type}`);
    if (!Array.isArray(n.position) || n.position.length !== 2) fail(f, `bad position on "${n.name}"`);
    if (typeof n.parameters !== 'object') fail(f, `missing parameters on "${n.name}"`);
    if (n.type === 'n8n-nodes-base.webhook' && !n.webhookId) fail(f, `webhook "${n.name}" has no webhookId`);
    if (n.type === 'n8n-nodes-base.code') { try { new Function('$input', '$env', '$json', `return (async () => { ${n.parameters.jsCode} })`); } catch (e) { fail(f, `code in "${n.name}" does not parse: ${e.message}`); } }
  }
  for (const [from, outs] of Object.entries(wf.connections)) {
    if (!names.has(from)) fail(f, `connection from unknown node "${from}"`);
    for (const branch of outs.main || []) for (const c of branch) if (!names.has(c.node)) fail(f, `connection to unknown node "${c.node}"`);
  }
  if (!wf.nodes.some((n) => TRIGGERS.includes(n.type))) fail(f, 'no trigger node');
  const connected = new Set(Object.keys(wf.connections));
  for (const outs of Object.values(wf.connections)) for (const b of outs.main || []) for (const c of b) connected.add(c.node);
  for (const n of wf.nodes) if (n.type !== 'n8n-nodes-base.stickyNote' && !connected.has(n.name)) fail(f, `node "${n.name}" is not connected`);
  if (!failures) console.log(`✓ ${f} — ${wf.nodes.length} nodes · "${wf.name}"`);
}
if (failures) { console.error(`\n${failures} problem(s) found`); process.exit(1); }
console.log('\nAll n8n workflow files look valid.');
