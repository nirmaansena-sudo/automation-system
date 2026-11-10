// Optional AI understanding. The AI only classifies and extracts fields — it
// never writes messages that go to clients. Modes: off | n8n | anthropic | openai.
// Any failure or timeout returns null and the rule-based flow continues.
import { config } from '../config.js';
import { SERVICE_CODES, NATURES, WINDOWS } from './catalog.js';
import { setState } from '../core/base.js';
import { nowIso } from '../lib/util.js';
import { reserveCompute, finishCompute } from '../lib/costs.js';

const INTENTS = ['new_enquiry', 'provide_details', 'existing_project', 'project_status', 'payment', 'complaint', 'talk_to_human', 'faq', 'greeting', 'job_or_vendor', 'opt_out', 'thanks', 'other'];

export function aiEnabled() {
  const m = config.ai.mode;
  if (m === 'n8n') return !!config.n8n.baseUrl;
  if (m === 'anthropic' || m === 'openai') return !!config.ai.apiKey && !!config.ai.model;
  return false;
}
export function aiStatus() {
  const m = config.ai.mode;
  const problems = [];
  if (m === 'n8n' && !config.n8n.baseUrl) problems.push('N8N_BASE_URL is not set');
  if ((m === 'anthropic' || m === 'openai') && !config.ai.apiKey) problems.push('AI_API_KEY is not set');
  if ((m === 'anthropic' || m === 'openai') && !config.ai.model) problems.push('AI_MODEL is not set; choose an explicitly configured model');
  return { mode: m, enabled: aiEnabled() && !problems.length, problems, model: modelName() };
}
function modelName() {
  if (config.ai.model) return config.ai.model;
  return '';
}

export function buildPrompt({ text, step, known, zones, faqs }) {
  const system = [
    'You are the understanding module of the WhatsApp assistant for Nirmaan Sena, a construction, architecture and interiors company in Jaipur, India.',
    'Read the customer\'s latest WhatsApp message (English, Hindi or Hinglish) and return ONLY one JSON object. Never write a reply to the customer.',
    'JSON fields:',
    `- intent: one of ${INTENTS.join(', ')}`,
    `- services: array using only ${SERVICE_CODES.join(', ')}`,
    `- zone: one of ${zones.map((z) => z.code).join(', ')} or null (other_jaipur = a Jaipur area not listed; outside = not in Jaipur)`,
    '- locality: colony/area name if mentioned, else null',
    `- project_nature: one of ${NATURES.map((n) => n.code).join(', ')} or null`,
    '- area_sqft: number or null (1 gaj = 9 sq ft, 30x40 = 1200 sq ft)',
    `- execution_window: one of ${WINDOWS.map((w) => w.code).join(', ')} or null`,
    '- name: the customer\'s own name if they state it, else null',
    '- requirements: short summary of extra requirement details, else null',
    '- faq_id: the id of the FAQ the customer is asking, else null',
    '- confidence: number 0..1 for the intent',
    '- summary: one short English line for staff',
    `Conversation step: ${step || 'none'}. Already known: ${JSON.stringify(known || {})}.`,
    `FAQs: ${JSON.stringify((faqs || []).map((f) => ({ id: f.id, q: f.question })))}`,
    'Zones: ' + zones.map((z) => `${z.code}=${z.name}`).join('; '),
  ].join('\n');
  return { system, user: String(text || '').slice(0, 2000) };
}

function extractJson(s) {
  if (!s) return null;
  const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

export function sanitize(raw, zones) {
  if (!raw || typeof raw !== 'object') return null;
  const zoneCodes = zones.map((z) => z.code);
  const pickEnum = (v, list) => (list.includes(v) ? v : null);
  const area = Number(raw.area_sqft);
  return {
    intent: pickEnum(raw.intent, INTENTS) || 'other',
    services: Array.isArray(raw.services) ? [...new Set(raw.services.filter((s) => SERVICE_CODES.includes(s)))] : [],
    zone: pickEnum(raw.zone, zoneCodes),
    locality: raw.locality ? String(raw.locality).slice(0, 120) : null,
    project_nature: pickEnum(raw.project_nature, NATURES.map((n) => n.code)),
    area_sqft: Number.isFinite(area) && area >= 100 && area <= 500000 ? Math.round(area) : null,
    execution_window: pickEnum(raw.execution_window, WINDOWS.map((w) => w.code)),
    name: raw.name ? String(raw.name).replace(/[^\p{L}\p{M}\s.'-]/gu, '').trim().slice(0, 60) || null : null,
    requirements: raw.requirements ? String(raw.requirements).slice(0, 500) : null,
    faq_id: Number.isInteger(Number(raw.faq_id)) && raw.faq_id !== null ? Number(raw.faq_id) : null,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    summary: raw.summary ? String(raw.summary).slice(0, 200) : null,
  };
}

async function post(url, headers, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ac.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`AI HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 200)}`);
    return json;
  } finally { clearTimeout(t); }
}

/** Returns sanitized understanding or null. */
export async function understand(input) {
  if (!aiEnabled()) return null;
  const usageId = reserveCompute('ai', config.ai.dailyLimit, { provider: config.ai.mode });
  if (!usageId) { setState('ai_daily_limit', { at: nowIso(), reason: 'Daily compute limit reached; rules remain active' }); return null; }
  const prompt = buildPrompt(input);
  const started = Date.now();
  try {
    let raw = null;
    if (config.ai.mode === 'anthropic') {
      const r = await post((config.ai.baseUrl || 'https://api.anthropic.com') + '/v1/messages',
        { 'x-api-key': config.ai.apiKey, 'anthropic-version': '2023-06-01' },
        { model: modelName(), max_tokens: 500, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] }, config.ai.timeoutMs);
      raw = extractJson((r?.content || []).map((c) => c.text || '').join(''));
    } else if (config.ai.mode === 'openai') {
      const r = await post((config.ai.baseUrl || 'https://api.openai.com/v1') + '/chat/completions',
        { Authorization: `Bearer ${config.ai.apiKey}` },
        { model: modelName(), messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], response_format: { type: 'json_object' } }, config.ai.timeoutMs);
      raw = extractJson(r?.choices?.[0]?.message?.content);
    } else if (config.ai.mode === 'n8n') {
      const r = await post(config.n8n.baseUrl + config.n8n.aiPath, { 'X-NS-Secret': config.n8n.secret },
        { prompt, context: { step: input.step, known: input.known, text: input.text } }, config.ai.timeoutMs);
      raw = r && typeof r === 'object' && r.intent ? r : extractJson(typeof r === 'string' ? r : JSON.stringify(r?.output ?? r));
    }
    const out = sanitize(raw, input.zones);
    finishCompute(usageId, out ? 'ok' : 'failed', Date.now() - started);
    setState('ai_last_ok', { at: nowIso(), ms: Date.now() - started });
    return out;
  } catch (e) {
    finishCompute(usageId, 'failed', Date.now() - started);
    setState('ai_last_error', { at: nowIso(), error: String(e.message).slice(0, 300) });
    return null;
  }
}
