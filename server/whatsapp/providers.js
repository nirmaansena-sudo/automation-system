// WhatsApp providers. All return the same normalised result so the outbox
// does not care which one is active:
//   { ok:true, wamid } | { ok:false, code, message, transient, window, unknown }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { toCloudPayload } from './format.js';

// Largest WhatsApp attachment the system stores (videos/documents above this stay in the chat only).
export const MAX_INBOUND_MEDIA = 25 * 1024 * 1024;
const TRANSIENT = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056, 133004, 131057]);
const WINDOW = new Set([131047, 470]);

export function classifyError(code, httpStatus) {
  const c = Number(code);
  if (WINDOW.has(c)) return { transient: false, window: true };
  if (TRANSIENT.has(c) || (httpStatus && httpStatus >= 500)) return { transient: true, window: false };
  if (httpStatus === 429) return { transient: true, window: false };
  return { transient: false, window: false };
}

async function timedFetch(url, opts, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

/** Network failure: did the request possibly reach WhatsApp? */
function networkResult(e) {
  const code = e?.cause?.code || e?.code || '';
  if (e?.name === 'AbortError') return { ok: false, code: 'timeout', message: 'Timed out waiting for WhatsApp', unknown: true, transient: false };
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED'].includes(code)) {
    return { ok: false, code: code || 'network', message: `Could not reach WhatsApp (${code})`, transient: true };
  }
  return { ok: false, code: code || 'network', message: e?.message || 'Network error', unknown: true, transient: false };
}

function cloudLike({ name, messagesUrl, mediaBase, headers }) {
  return {
    name,
    async send(to, spec, { callbackData } = {}) {
      const payload = toCloudPayload(to, spec, callbackData);
      let res;
      try {
        res = await timedFetch(messagesUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(payload) }, config.whatsapp.requestTimeoutMs);
      } catch (e) { return networkResult(e); }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.ok && body?.messages?.[0]?.id) return { ok: true, wamid: body.messages[0].id, raw: body };
      const err = body?.error || {};
      const cls = classifyError(err.code, res.status);
      return { ok: false, code: String(err.code ?? res.status), message: err.error_data?.details || err.message || `HTTP ${res.status}`, ...cls };
    },
    async markRead(wamid) {
      try {
        await timedFetch(messagesUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: wamid }) }, 5000);
      } catch { /* not important */ }
    },
    async downloadMedia(mediaId) {
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(String(mediaId))) throw new Error('Invalid media id');
      const meta = await timedFetch(`${mediaBase()}/${encodeURIComponent(mediaId)}`, { headers: headers() }, 15000);
      if (!meta.ok) throw new Error(`Media lookup failed (${meta.status})`);
      const info = await meta.json();
      if (Number(info.file_size) > MAX_INBOUND_MEDIA) throw new Error('Media too large to store');
      let url = info.url;
      if (name === 'dialog360' && url) { const u = new URL(url); url = `${config.whatsapp.dialogBase}${u.pathname}${u.search}`; }
      const file = await timedFetch(url, { headers: headers() }, 30000);
      if (!file.ok) throw new Error(`Media download failed (${file.status})`);
      if (Number(file.headers.get('content-length')) > MAX_INBOUND_MEDIA) throw new Error('Media too large to store');
      return { buffer: Buffer.from(await file.arrayBuffer()), mime: info.mime_type || file.headers.get('content-type') || 'application/octet-stream' };
    },
  };
}

function cloudProvider() {
  const w = config.whatsapp;
  return cloudLike({
    name: 'cloud',
    messagesUrl: () => `${w.graphBase}/${w.graphVersion}/${w.phoneNumberId}/messages`,
    mediaBase: () => `${w.graphBase}/${w.graphVersion}`,
    headers: () => ({ Authorization: `Bearer ${w.token}` }),
  });
}
function dialogProvider() {
  const w = config.whatsapp;
  return cloudLike({
    name: 'dialog360',
    messagesUrl: () => `${w.dialogBase}/messages`,
    mediaBase: () => w.dialogBase,
    headers: () => ({ 'D360-API-KEY': w.dialogApiKey }),
  });
}

/**
 * Simulator: nothing leaves the computer. Messages appear in the dashboard's
 * WhatsApp simulator. It can inject failures (Settings → sim_fail_rate) and
 * echoes "delivered" status webhooks so the full pipeline is exercised.
 */
let simHooks = { onSent: null, failRate: () => 0 };
export function setSimulatorHooks(h) { simHooks = { ...simHooks, ...h }; }
function simulatorProvider() {
  return {
    name: 'simulator',
    async send(to, spec, { callbackData } = {}) {
      toCloudPayload(to, spec, callbackData); // validates the spec exactly like the real thing
      const rate = Number(simHooks.failRate() || 0);
      if (rate > 0 && Math.random() < rate) {
        const roll = Math.random();
        if (roll < 0.4) return { ok: false, code: '131000', message: 'Simulated: something went wrong', transient: true };
        if (roll < 0.7) return { ok: false, code: 'timeout', message: 'Simulated: timeout (unknown outcome)', unknown: true };
        return { ok: false, code: '130429', message: 'Simulated: rate limit hit', transient: true };
      }
      const wamid = 'wamid.SIM' + crypto.randomBytes(9).toString('hex');
      if (simHooks.onSent) setTimeout(() => simHooks.onSent({ wamid, to, callbackData, spec }), 400);
      return { ok: true, wamid };
    },
    async markRead() {},
    async downloadMedia() { throw new Error('Simulator media is stored directly'); },
  };
}

let provider = null;
export function getProvider() {
  if (!provider) {
    const p = config.whatsapp.provider;
    provider = p === 'cloud' ? cloudProvider() : p === 'dialog360' ? dialogProvider() : simulatorProvider();
  }
  return provider;
}
export function setProviderForTests(p) { provider = p; }

export function providerStatus() {
  const w = config.whatsapp;
  const p = w.provider;
  const missing = [];
  if (p === 'cloud') {
    if (!w.token) missing.push('WHATSAPP_TOKEN');
    if (!w.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
    if (!w.appSecret) missing.push('WHATSAPP_APP_SECRET');
  }
  if (p === 'dialog360' && !w.dialogApiKey) missing.push('DIALOG360_API_KEY');
  return { provider: p, ready: missing.length === 0, missing, graphVersion: w.graphVersion, coexistence: w.coexistence };
}

export function saveMediaBuffer(buffer, mime, mediaDir = config.mediaDir) {
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'video/mp4': '.mp4' })[String(mime).split(';')[0]] || '.bin';
  const d = new Date();
  const dir = path.join(mediaDir, `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(10).toString('hex') + ext;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer);
  return { filePath: path.relative(mediaDir, full), size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}
