// "Reliable intake": verify signature → store raw event (deduplicated) → ACK.
// Processing happens afterwards, per contact, in order.
import crypto from 'node:crypto';
import { run, tx } from '../db/index.js';
import { nowIso, safeEqual } from '../lib/util.js';
import { config } from '../config.js';
import { setState } from '../core/base.js';

export function verifySubscription(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] && config.whatsapp.verifyToken && safeEqual(String(query['hub.verify_token']), config.whatsapp.verifyToken)) return query['hub.challenge'];
  return null;
}

/**
 * Is this webhook POST really from WhatsApp?
 *  - Meta Cloud API: X-Hub-Signature-256 = HMAC-SHA256(app secret, raw body).
 *  - 360dialog does not sign webhooks: set a secret header when you register the
 *    webhook (X-NS-Webhook-Key: <verify token>) or append ?key=<verify token> to the URL.
 */
export function verifySignature(rawBody, headers = {}, query = {}) {
  const w = config.whatsapp;
  if (!w.appSecret) {
    // The simulator injects messages inside the server and never needs this URL. If the
    // URL is reachable from outside (tunnel/server), posting to it still needs the key,
    // otherwise anyone could impersonate any client or employee.
    if (w.provider === 'dialog360' || w.provider === 'simulator') {
      const key = headers['x-ns-webhook-key'] || query.key;
      return !!key && !!w.verifyToken && safeEqual(key, w.verifyToken);
    }
    return false;
  }
  const header = headers['x-hub-signature-256'];
  if (!header || !String(header).startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', w.appSecret).update(rawBody).digest('hex');
  return safeEqual(String(header).slice(7), expected);
}

/** Cloud API webhook JSON → normalised events. */
export function parseWebhook(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile?.name || null;
      if (change.field === 'messages' || !change.field) {
        for (const m of v.messages || []) events.push({ kind: 'message', key: `msg:${m.id}`, waId: m.from, data: normaliseMessage(m, names[m.from]) });
        for (const s of v.statuses || []) {
          events.push({ kind: 'status', key: `st:${s.id}:${s.status}:${s.timestamp}`, waId: s.recipient_id, data: { wamid: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id, callbackData: s.biz_opaque_callback_data || null, errors: s.errors || null, pricing: s.pricing || null } });
        }
      }
      if (change.field === 'smb_message_echoes') {
        for (const m of v.message_echoes || []) events.push({ kind: 'echo', key: `echo:${m.id}`, waId: m.to, data: { wamid: m.id, to: m.to, type: m.type, text: m.text?.body || null, timestamp: m.timestamp } });
      }
    }
  }
  return events;
}

function normaliseMessage(m, profileName) {
  const out = { wamid: m.id, from: m.from, timestamp: m.timestamp, type: m.type, profileName, contextId: m.context?.id || null, text: null, buttonId: null, buttonTitle: null, location: null, media: null, referral: m.referral || null };
  switch (m.type) {
    case 'text': out.text = m.text?.body || ''; break;
    case 'interactive': {
      const i = m.interactive || {};
      if (i.type === 'button_reply') { out.buttonId = i.button_reply?.id; out.buttonTitle = i.button_reply?.title; }
      else if (i.type === 'list_reply') { out.buttonId = i.list_reply?.id; out.buttonTitle = i.list_reply?.title; }
      else if (i.type === 'nfm_reply') { out.text = i.nfm_reply?.body || ''; }
      break;
    }
    case 'button': out.buttonId = m.button?.payload; out.buttonTitle = m.button?.text; break;
    case 'location': out.location = { lat: m.location?.latitude, lng: m.location?.longitude, name: m.location?.name || null, address: m.location?.address || null }; break;
    case 'image': case 'document': case 'audio': case 'video': case 'sticker': {
      const md = m[m.type] || {};
      out.media = { id: md.id, mime: md.mime_type, caption: md.caption || null, filename: md.filename || null, voice: !!md.voice, simData: md._sim_data || null };
      out.text = md.caption || null;
      break;
    }
    case 'contacts': out.text = (m.contacts || []).map((c) => `${c.name?.formatted_name || ''} ${(c.phones || []).map((p) => p.phone).join(' ')}`).join('; '); break;
    case 'reaction': out.text = null; break;
    default: out.text = m.text?.body || null;
  }
  return out;
}

/** Store events durably (dedupe by key). Returns counts. */
export function ingest(body, provider = config.whatsapp.provider) {
  const events = parseWebhook(body);
  let stored = 0;
  tx(() => {
    const at = nowIso();
    for (const e of events) {
      const r = run('INSERT OR IGNORE INTO inbound_events(provider, kind, dedupe_key, wa_id, payload, status, received_at) VALUES (?,?,?,?,?,?,?)', provider, e.kind, e.key, e.waId, JSON.stringify(e.data), 'pending', at);
      stored += r.changes;
    }
    if (events.length) setState('webhook_last_received', at);
  });
  return { received: events.length, stored, duplicates: events.length - stored };
}

/** Website enquiry form (already OTP-verified on the website). */
export function ingestWebsiteForm(form) {
  const key = `form:${form.reference_id || form.reference || ''}:${form.mobile || form.whatsapp || ''}:${form.submitted_at || ''}`;
  const r = run('INSERT OR IGNORE INTO inbound_events(provider, kind, dedupe_key, wa_id, payload, status, received_at) VALUES (?,?,?,?,?,?,?)', 'website', 'form', key, null, JSON.stringify(form), 'pending', nowIso());
  return { stored: r.changes };
}

/** Build a Cloud-API-shaped webhook body (used by the simulator and tests). */
export function fakeWebhook({ from, name, message, statuses }) {
  const value = { messaging_product: 'whatsapp', metadata: { display_phone_number: '917891719291', phone_number_id: 'SIMULATOR' } };
  if (message) { value.contacts = [{ profile: { name: name || null }, wa_id: from }]; value.messages = [{ from, id: message.id || 'wamid.SIMIN' + crypto.randomBytes(9).toString('hex'), timestamp: String(Math.floor(Date.now() / 1000)), ...message }]; }
  if (statuses) value.statuses = statuses;
  return { object: 'whatsapp_business_account', entry: [{ id: 'SIM', changes: [{ field: 'messages', value }] }] };
}
