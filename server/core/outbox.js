// Transactional outbox + dispatcher ("Shared messaging, delivery and recovery").
// Business code calls enqueue*() inside its transaction; the dispatcher sends
// after commit, rechecks eligibility before every attempt, retries safely and
// reconciles unknown outcomes using biz_opaque_callback_data.
import { all, one, run, insert, update, tx, onCommit } from '../db/index.js';
import { nowIso, addMinIso, minutesBetween, jparse, truncate } from '../lib/util.js';
import { broadcast, bad } from '../lib/http.js';
import { config } from '../config.js';
import { getProvider } from '../whatsapp/providers.js';
import { previewOf, renderTemplateBody } from '../whatsapp/format.js';
import { audit, notify, createTask, setState } from './base.js';
import { randomUUID } from 'node:crypto';

const BACKOFF_MIN = [0.5, 2, 10, 30, 120, 360];
const RECONCILE_MIN = 5;
const WINDOW_MARGIN_MIN = 10;
const guards = new Map();

/** Domain modules register eligibility checks: guard {type, ...} → true if still valid. */
export function registerGuard(type, fn) { guards.set(type, fn); }

function contactFor(waId) { return one('SELECT * FROM contacts WHERE wa_id = ?', waId); }

/**
 * Queue a WhatsApp message. Must be called inside the business transaction.
 * opts: { to (wa_id), kind, message (spec), template ({name, params, buttons}),
 *         essential, guard, dedupeKey, sender ('bot'|'system'|'user:ID'), delayMin }
 */
export function enqueueWhatsApp(opts) {
  const { to, kind, message, template, essential = false, guard, dedupeKey, sender = 'system', delayMin = 0, optional = false } = opts;
  if (!to) return null;
  if (dedupeKey) {
    const ex = one('SELECT id FROM outbox WHERE dedupe_key = ?', dedupeKey);
    if (ex) return ex.id;
  }
  let contact = contactFor(to);
  if (!contact) {
    const at = nowIso();
    const cid = insert('contacts', { wa_id: to, kind: 'client', created_at: at, updated_at: at });
    contact = one('SELECT * FROM contacts WHERE id = ?', cid);
  }
  const at = nowIso();
  const id = insert('outbox', {
    channel: 'whatsapp', to_wa_id: to, contact_id: contact.id, kind,
    payload: JSON.stringify(message), template: template ? JSON.stringify(template) : null,
    essential: essential ? 1 : 0, sender, guard: guard ? JSON.stringify(guard) : null,
    status: 'queued', next_attempt_at: delayMin ? addMinIso(at, delayMin) : at, route: optional ? 'optional' : null,
    dedupe_key: dedupeKey || null, created_at: at, updated_at: at,
  });
  insert('messages', {
    contact_id: contact.id, direction: 'out', type: message.type, body: previewOf(message),
    payload: JSON.stringify(message), sender, status: 'queued', outbox_id: id, created_at: at, status_at: at,
  });
  touchConversation(contact.id, '↪ ' + truncate(previewOf(message), 80), false);
  onCommit(() => { broadcast('inbox'); kickDispatcher(); });
  return id;
}

/** Queue a domain event for n8n (reliable, retried). */
export function enqueueEvent(type, data) {
  if (!config.n8n.baseUrl) return null;
  const at = nowIso();
  const id = insert('outbox', { channel: 'n8n', kind: type, payload: JSON.stringify({ eventId: randomUUID(), type, data, at }), status: 'queued', next_attempt_at: at, created_at: at, updated_at: at, max_attempts: 8 });
  onCommit(kickDispatcher);
  return id;
}

export function touchConversation(contactId, preview, inbound) {
  const at = nowIso();
  const conv = one('SELECT id FROM conversations WHERE contact_id = ?', contactId);
  if (!conv) insert('conversations', { contact_id: contactId, last_message_at: at, last_message_preview: preview, unread: inbound ? 1 : 0, updated_at: at });
  else run(`UPDATE conversations SET last_message_at=?, last_message_preview=?, unread = unread + ?, updated_at=? WHERE id=?`, at, preview, inbound ? 1 : 0, at, conv.id);
}

let kickTimer = null;
let dispatching = false;
export function kickDispatcher() {
  if (!config.workersEnabled || kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; dispatchLoop().catch((e) => console.error('dispatcher', e)); }, 25);
}
let dispatchingSince = 0;
async function dispatchLoop() {
  if (dispatching && Date.now() - dispatchingSince > 10 * 60 * 1000) {
    // A send never came back. Its lease has expired, so the job is picked up again safely.
    console.error(`[${nowIso()}] Outgoing-message worker was stuck; starting a fresh run.`);
    setState('outbox_restarted', nowIso());
    dispatching = false;
  }
  if (dispatching) return;
  dispatching = true; dispatchingSince = Date.now();
  const mine = dispatchingSince;
  try { for (let i = 0; i < 50; i++) { const n = await dispatchOnce(); if (!n) break; } } finally { if (dispatchingSince === mine) dispatching = false; }
}

/** Claim due jobs: oldest unfinished job per recipient (FIFO), leases for crash safety. */
function claimJobs(max) {
  return tx(() => {
    const at = nowIso();
    run(`UPDATE outbox SET status='unknown', next_attempt_at=?, last_error=COALESCE(last_error, 'Lease expired before a result was recorded'), updated_at=?, lease_until=NULL WHERE channel='whatsapp' AND status='sending' AND lease_until < ?`, addMinIso(at, RECONCILE_MIN), at, at);
    run(`UPDATE outbox SET status='queued', next_attempt_at=?, lease_until=NULL WHERE channel='n8n' AND status IN ('sending','unknown') AND (lease_until < ? OR status='unknown')`, at, at);
    for (const j of all("SELECT * FROM outbox WHERE channel='whatsapp' AND status='unknown' AND next_attempt_at <= ?", at)) {
      createTask({ title: `Verify delivery before resending: ${j.kind}`, description: `The provider may already have accepted message ${j.id} to ${j.to_wa_id}. Check its delivery in the provider console or with the recipient, then resolve it in Messages. Do not send another copy until non-delivery is confirmed.`, kind: 'delivery_reconciliation', priority: 'high', entityType: 'outbox', entityId: j.id, dedupeKey: `reconcile:${j.id}` });
      update('outbox', j.id, { next_attempt_at: null, updated_at: at });
      run("UPDATE messages SET status='unknown', error='Delivery unknown; verification required before resend', status_at=? WHERE outbox_id=?", at, j.id);
      notify({ audience: 'managers', title: 'Verify a WhatsApp delivery', body: `${j.kind}: delivery is unknown. Further messages to this recipient are held until resolved.`, link: '#/messages', level: 'warn' });
    }
    const rows = all(`SELECT o.* FROM outbox o
      WHERE o.status = 'queued' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.channel = o.channel AND COALESCE(p.to_wa_id,'') = COALESCE(o.to_wa_id,'')
                        AND p.id < o.id AND p.status IN ('queued','sending','unknown'))
      ORDER BY o.id LIMIT ?`, at, max);
    for (const r of rows) run(`UPDATE outbox SET status='sending', lease_until=?, attempts=attempts+1, updated_at=? WHERE id=?`, addMinIso(at, 3), at, r.id);
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

export async function dispatchOnce(max = 6) {
  const jobs = claimJobs(max);
  await Promise.all(jobs.map((j) => (j.channel === 'n8n' ? sendN8n(j) : sendWhatsApp(j)).catch((e) => {
    console.error('outbox job failed unexpectedly', j.id, e);
    tx(() => fail(j, 'internal', e.message, true));
  })));
  if (jobs.length) setState('outbox_last_run', nowIso());
  return jobs.length;
}

function windowOpen(contact) {
  if (!contact?.last_inbound_at) return false;
  return minutesBetween(contact.last_inbound_at, nowIso()) < 24 * 60 - WINDOW_MARGIN_MIN;
}

function templateLanguage(name, lang) {
  const rows = all('SELECT language, status FROM wa_templates WHERE name = ?', name);
  if (!rows.length) return null;
  const sim = getProvider().name === 'simulator';
  const ok = (r) => r.status === 'approved' || sim;
  const pref = rows.find((r) => r.language === lang && ok(r));
  if (pref) return pref.language;
  const en = rows.find((r) => r.language === 'en' && ok(r));
  return en ? en.language : null;
}

/** Recheck everything just before sending. Returns {action, spec, route}. */
function decide(job) {
  const contact = one('SELECT * FROM contacts WHERE id = ?', job.contact_id);
  if (!contact) return { action: 'cancel', reason: 'Contact missing' };
  if (contact.erased_at) return { action: 'cancel', reason: 'Contact data erased' };
  const guard = jparse(job.guard);
  if (guard) {
    const check = guards.get(guard.type);
    if (check && !check(guard)) return { action: 'cancel', reason: `No longer current (${guard.type})` };
  }
  if (contact.opted_out && !job.essential) return { action: 'cancel', reason: 'Recipient opted out' };
  const message = jparse(job.payload);
  const template = jparse(job.template);
  const forceTemplate = job.route === 'force_template';
  if (!forceTemplate && windowOpen(contact)) return { action: 'send', spec: message, route: 'freeform', contact };
  if (template) {
    const lang = templateLanguage(template.name, contact.language);
    if (lang) return { action: 'send', spec: { type: 'template', ...template, language: lang }, route: 'template', contact };
    return { action: 'operator', reason: `Outside the 24-hour window and template "${template.name}" is not approved yet`, contact };
  }
  if (job.route === 'optional') return { action: 'cancel', reason: 'Skipped: outside the 24-hour window (optional message)' };
  return { action: 'operator', reason: 'Outside the 24-hour window and no template exists for this message', contact };
}

async function sendWhatsApp(job) {
  const d = tx(() => {
    const decision = decide(job);
    if (decision.action === 'cancel') {
      update('outbox', job.id, { status: 'cancelled', last_error: decision.reason, updated_at: nowIso(), lease_until: null });
      run("UPDATE messages SET status='cancelled', error=?, status_at=? WHERE outbox_id=?", decision.reason, nowIso(), job.id);
      onCommit(() => broadcast('inbox'));
    } else if (decision.action === 'operator') {
      update('outbox', job.id, { status: 'needs_operator', last_error: decision.reason, updated_at: nowIso(), lease_until: null });
      run("UPDATE messages SET status='needs_operator', error=?, status_at=? WHERE outbox_id=?", decision.reason, nowIso(), job.id);
      const c = decision.contact;
      createTask({
        title: `Send manually: ${job.kind} to ${c?.name || c?.profile_name || c?.wa_id}`,
        description: `${decision.reason}. Call the person or send from the WhatsApp app, then mark this task done.\n\nMessage:\n${previewOf(jparse(job.payload))}`,
        kind: 'operator_send', priority: job.essential ? 'high' : 'normal', entityType: 'outbox', entityId: job.id, dedupeKey: `operator:${job.id}`,
      });
      onCommit(() => broadcast('inbox'));
    }
    return decision;
  });
  if (d.action !== 'send') return;

  let result;
  try { result = await getProvider().send(job.to_wa_id, d.spec, { callbackData: `ob:${job.id}` }); }
  catch (e) { result = { ok: false, code: 'internal', message: e.message, unknown: true }; }

  tx(() => {
    const at = nowIso();
    const cur = one('SELECT * FROM outbox WHERE id = ?', job.id);
    if (cur.status === 'sent') return; // a status webhook already reconciled it
    if (result.ok) {
      update('outbox', job.id, { status: 'sent', wamid: result.wamid, route: d.route, sent_at: at, updated_at: at, lease_until: null, last_error: null, error_code: null });
      const body = d.route === 'template' ? templatePreview(d.spec) : undefined;
      run(`UPDATE messages SET status='sent', wamid=?, route=?, status_at=?, error=NULL ${body ? ', body=?' : ''} WHERE outbox_id=?`, ...(body ? [result.wamid, d.route, at, body, job.id] : [result.wamid, d.route, at, job.id]));
      run('UPDATE contacts SET last_outbound_at=? WHERE id=?', at, job.contact_id);
    } else if (result.window && d.route === 'freeform' && cur.route === 'optional' && !cur.template) {
      update('outbox', job.id, { status: 'cancelled', last_error: 'Skipped: outside the 24-hour window (optional message)', updated_at: at, lease_until: null });
      run("UPDATE messages SET status='cancelled', error=?, status_at=? WHERE outbox_id=?", 'Skipped (outside 24h window)', at, job.id);
    } else if (result.window && d.route === 'freeform') {
      update('outbox', job.id, { status: 'queued', route: 'force_template', next_attempt_at: at, last_error: result.message, error_code: result.code, updated_at: at, lease_until: null, attempts: Math.max(0, cur.attempts - 1) });
    } else if (result.unknown) {
      update('outbox', job.id, { status: 'unknown', next_attempt_at: addMinIso(at, RECONCILE_MIN), last_error: result.message, error_code: result.code, updated_at: at, lease_until: null });
      run("UPDATE messages SET status='unknown', error=?, status_at=? WHERE outbox_id=?", 'Waiting for delivery receipt; automatic resend disabled', at, job.id);
    } else if (result.transient && cur.attempts < cur.max_attempts) {
      const wait = BACKOFF_MIN[Math.min(cur.attempts - 1, BACKOFF_MIN.length - 1)];
      update('outbox', job.id, { status: 'queued', next_attempt_at: addMinIso(at, wait), last_error: result.message, error_code: result.code, updated_at: at, lease_until: null });
      run("UPDATE messages SET status='retrying', error=?, status_at=? WHERE outbox_id=?", result.message, at, job.id);
    } else {
      fail(cur, result.code, result.message);
    }
    onCommit(() => broadcast('inbox'));
  });
}

function templatePreview(spec) {
  const t = one('SELECT body FROM wa_templates WHERE name=? AND language=?', spec.name, spec.language);
  return t ? `[Template ${spec.name}] ${renderTemplateBody(t.body, spec.params)}` : previewOf(spec);
}

function fail(job, code, message, internal = false) {
  const at = nowIso();
  update('outbox', job.id, { status: 'failed', last_error: message, error_code: String(code ?? ''), updated_at: at, lease_until: null });
  if (job.channel === 'whatsapp') run("UPDATE messages SET status='failed', error=?, status_at=? WHERE outbox_id=?", message, at, job.id);
  audit('system', 'outbox.failed', 'outbox', job.id, { code, message, kind: job.kind });
  if (job.channel === 'n8n') {
    notify({ audience: 'owner', title: 'n8n did not receive an event', body: `${job.kind}: ${message}`, link: '#/messages', level: 'warn' });
    return;
  }
  const c = one('SELECT * FROM contacts WHERE id = ?', job.contact_id);
  if (job.essential || internal) {
    createTask({
      title: `Message failed: ${job.kind} to ${c?.name || c?.profile_name || c?.wa_id}`,
      description: `WhatsApp could not deliver this message (${code}: ${message}). Please contact the person another way.`,
      kind: 'operator_send', priority: 'high', entityType: 'outbox', entityId: job.id, dedupeKey: `failed:${job.id}`,
    });
  } else {
    notify({ audience: 'managers', title: 'A WhatsApp message failed', body: `${job.kind} to ${c?.wa_id}: ${message}`, link: '#/messages', level: 'warn' });
  }
}

async function sendN8n(job) {
  let ok = false; let msg = '';
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 60000);
  try {
    const res = await fetch(config.n8n.baseUrl + config.n8n.eventsPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NS-Secret': config.n8n.secret, 'Idempotency-Key': jparse(job.payload, {}).eventId || `legacy-outbox-${job.id}` },
      body: job.payload, signal: ac.signal,
    });
    clearTimeout(t);
    ok = res.ok; msg = ok ? '' : `HTTP ${res.status}`;
  } catch (e) { msg = e.name === 'AbortError' ? 'timeout' : e.message; }
  finally { clearTimeout(t); }
  tx(() => {
    const at = nowIso();
    const cur = one('SELECT * FROM outbox WHERE id = ?', job.id);
    if (ok) { update('outbox', job.id, { status: 'sent', sent_at: at, updated_at: at, lease_until: null, last_error: null }); setState('n8n_last_delivery', at); }
    else if (cur.attempts < cur.max_attempts) {
      const wait = BACKOFF_MIN[Math.min(cur.attempts - 1, BACKOFF_MIN.length - 1)];
      update('outbox', job.id, { status: 'queued', next_attempt_at: addMinIso(at, wait), last_error: msg, updated_at: at, lease_until: null });
    } else fail(cur, 'n8n', msg);
  });
}

const RANK = { queued: 0, retrying: 0, sent: 1, delivered: 2, read: 3, played: 3, failed: 9 };
/** Apply a status webhook (sent/delivered/read/failed). Runs inside a transaction. */
export function applyStatus(st) {
  const at = nowIso();
  let job = null;
  const m = /^ob:(\d+)$/.exec(st.callbackData || '');
  if (m) job = one('SELECT * FROM outbox WHERE id = ?', Number(m[1]));
  if (!job && st.wamid) job = one('SELECT * FROM outbox WHERE wamid = ?', st.wamid);
  if (st.status === 'failed' && job) {
    const message = one('SELECT status FROM messages WHERE outbox_id=?', job.id);
    // A late receipt from a previous attempt must not undo a cancellation,
    // confirmed delivery, or a newer successful provider attempt.
    if (['cancelled', 'failed', 'needs_operator'].includes(job.status) ||
      (job.wamid && st.wamid && job.wamid !== st.wamid) ||
      ['delivered', 'read', 'played'].includes(message?.status)) return;
  }
  if (job && ['unknown', 'sending', 'queued'].includes(job.status) && ['sent', 'delivered', 'read', 'played'].includes(st.status)) {
    update('outbox', job.id, { status: 'sent', wamid: st.wamid, sent_at: job.sent_at || at, updated_at: at, lease_until: null, last_error: job.status === 'unknown' ? 'Reconciled from status webhook' : job.last_error });
    run("UPDATE tasks SET status='done', updated_at=? WHERE dedupe_key=?", at, `reconcile:${job.id}`);
  }
  const msg = (st.wamid && one('SELECT * FROM messages WHERE wamid = ?', st.wamid)) || (job && one('SELECT * FROM messages WHERE outbox_id = ?', job.id));
  if (msg) {
    const cur = RANK[msg.status] ?? 0; const nxt = RANK[st.status] ?? 0;
    if (nxt > cur || st.status === 'failed') {
      const err = st.errors?.[0];
      run('UPDATE messages SET status=?, wamid=COALESCE(wamid, ?), status_at=?, error=COALESCE(?, error), category=COALESCE(?, category) WHERE id=?',
        st.status, st.wamid, at, err ? `${err.code}: ${err.title || err.message || ''}` : null, st.pricing?.category || null, msg.id);
    } else if (st.pricing?.category && !msg.category) {
      run('UPDATE messages SET category=? WHERE id=?', st.pricing.category, msg.id);
    }
  }
  if (st.status === 'failed' && job) {
    const err = st.errors?.[0] || {};
    const transient = [130429, 131000, 131016, 131056].includes(Number(err.code));
    const cur = one('SELECT * FROM outbox WHERE id = ?', job.id);
    if (transient && cur.attempts < cur.max_attempts) {
      update('outbox', job.id, { status: 'queued', next_attempt_at: addMinIso(at, BACKOFF_MIN[Math.min(cur.attempts, 5)]), last_error: `Delivery failed: ${err.code}`, updated_at: at });
    } else if (Number(err.code) === 131047 && cur.route !== 'template' && cur.template) {
      update('outbox', job.id, { status: 'queued', route: 'force_template', next_attempt_at: at, last_error: 'Outside 24h window', updated_at: at });
    } else if (cur.status !== 'failed') {
      fail(cur, err.code || 'failed', err.title || err.message || 'Delivery failed');
    }
  }
  onCommit(() => broadcast('inbox'));
}

/** Manual retry from the dashboard. */
export function resolveUnknownJob(id, actor, { outcome, note, wamid } = {}) {
  const job = one('SELECT * FROM outbox WHERE id=?', id);
  if (!job || job.status !== 'unknown') throw bad('Only an unknown delivery can be reconciled');
  if (!['sent', 'not_sent', 'cancelled'].includes(outcome) || typeof note !== 'string' || note.trim().length < 8) throw bad('Choose an outcome and record how delivery was verified (at least 8 characters)');
  const at = nowIso();
  const status = outcome === 'not_sent' ? 'queued' : outcome;
  update('outbox', id, { status, next_attempt_at: outcome === 'not_sent' ? at : null, lease_until: null, updated_at: at, last_error: `Verified by ${actor}: ${note.trim().slice(0, 500)}`, ...(outcome === 'sent' ? { sent_at: at, ...(wamid ? { wamid: String(wamid).slice(0, 200) } : {}) } : {}) });
  run('UPDATE messages SET status=?, status_at=?, error=NULL, wamid=COALESCE(?,wamid) WHERE outbox_id=?', status, at, outcome === 'sent' && wamid ? String(wamid).slice(0, 200) : null, id);
  run("UPDATE tasks SET status='done', updated_at=? WHERE dedupe_key=?", at, `reconcile:${id}`);
  audit(actor, 'outbox.reconcile', 'outbox', id, { outcome, note: note.trim().slice(0, 500) });
  onCommit(() => { broadcast('inbox'); kickDispatcher(); });
  return true;
}

export function retryJob(id, actor) {
  const job = one('SELECT * FROM outbox WHERE id = ?', id);
  if (!job || !['failed', 'needs_operator', 'cancelled'].includes(job.status)) return false;
  update('outbox', id, { status: 'queued', next_attempt_at: nowIso(), attempts: 0, updated_at: nowIso(), last_error: null });
  run("UPDATE messages SET status='queued', error=NULL WHERE outbox_id=?", id);
  audit(actor, 'outbox.retry', 'outbox', id);
  onCommit(kickDispatcher);
  return true;
}

export function outboxHealth() {
  const at = nowIso();
  return {
    queued: one("SELECT COUNT(*) n FROM outbox WHERE status IN ('queued','sending','unknown')").n,
    overdue: one("SELECT COUNT(*) n FROM outbox WHERE status IN ('queued','unknown') AND next_attempt_at < ?", addMinIso(at, -5)).n,
    failed24h: one("SELECT COUNT(*) n FROM outbox WHERE status='failed' AND updated_at > ?", addMinIso(at, -1440)).n,
    operator: one("SELECT COUNT(*) n FROM outbox WHERE status IN ('needs_operator','unknown')").n,
    unknown: one("SELECT COUNT(*) n FROM outbox WHERE status='unknown'").n,
  };
}
