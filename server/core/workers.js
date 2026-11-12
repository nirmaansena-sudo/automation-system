// Background loops: inbound processor (per-contact FIFO), outbox dispatcher,
// timers and the routine scheduler.
import { all, one, run, tx } from '../db/index.js';
import { now, nowIso, addMinIso, minutesBetween, jparse } from '../lib/util.js';
import { config } from '../config.js';
import { notify, setState } from './base.js';
import { applyStatus, dispatchOnce, kickDispatcher, enqueueWhatsApp } from './outbox.js';
import { processDueTimers } from './timers.js';
import { schedulerTick } from './routines.js';
import { processInboundEvent } from '../bot/engine.js';
import { t } from '../bot/i18n.js';
import { getContactByWa } from '../domain/common.js';

let inboundAgain = false;

function claimMessages(max) {
  return tx(() => {
    const at = nowIso();
    run("UPDATE inbound_events SET status='pending' WHERE status='processing' AND locked_at < ?", addMinIso(at, -5));
    const rows = all(`SELECT e.* FROM inbound_events e WHERE e.status='pending' AND e.kind != 'status'
      AND NOT EXISTS (SELECT 1 FROM inbound_events p WHERE e.wa_id IS NOT NULL AND p.wa_id = e.wa_id AND p.kind != 'status' AND p.id < e.id AND p.status IN ('pending','processing'))
      ORDER BY e.id LIMIT ?`, max * 4);
    const picked = []; const seen = new Set();
    for (const r of rows) {
      if (r.attempts > 0 && r.locked_at && minutesBetween(r.locked_at, at) < 0.5 * r.attempts) continue;
      const k = r.wa_id || `id:${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k); picked.push(r);
      if (picked.length >= max) break;
    }
    for (const r of picked) run("UPDATE inbound_events SET status='processing', locked_at=?, attempts=attempts+1 WHERE id=?", at, r.id);
    return picked.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

function processStatuses() {
  const rows = all("SELECT * FROM inbound_events WHERE status='pending' AND kind='status' ORDER BY id LIMIT 300");
  if (!rows.length) return 0;
  tx(() => {
    for (const e of rows) {
      try { tx(() => applyStatus(jparse(e.payload, {}))); run("UPDATE inbound_events SET status='done', processed_at=? WHERE id=?", nowIso(), e.id); }
      catch (err) { run("UPDATE inbound_events SET status='failed', last_error=?, processed_at=? WHERE id=?", String(err.message).slice(0, 300), nowIso(), e.id); }
    }
  });
  return rows.length;
}

async function handleOne(e) {
  try {
    await processInboundEvent(e);
    tx(() => run("UPDATE inbound_events SET status='done', processed_at=?, last_error=NULL WHERE id=?", nowIso(), e.id));
  } catch (err) {
    console.error(`Inbound event ${e.id} failed (attempt ${e.attempts}):`, err);
    tx(() => {
      if (e.attempts >= 3) {
        run("UPDATE inbound_events SET status='failed', last_error=?, processed_at=? WHERE id=?", String(err.stack || err.message).slice(0, 1000), nowIso(), e.id);
        notify({ audience: 'owner', title: 'A WhatsApp message could not be processed', body: `${e.wa_id || e.kind}: ${err.message}`, link: '#/messages', level: 'error' });
        const c = e.wa_id ? getContactByWa(e.wa_id) : null;
        if (c && e.kind === 'message') {
          run("UPDATE conversations SET needs_attention=1, attention_reason='Bot error — please reply personally' WHERE contact_id=?", c.id);
          enqueueWhatsApp({ to: c.wa_id, kind: 'bot.error', sender: 'bot', essential: true, message: { type: 'text', text: t('generic_error', c.language) }, dedupeKey: `boterr:${e.id}` });
        }
      } else {
        run("UPDATE inbound_events SET status='pending', last_error=?, locked_at=? WHERE id=?", String(err.message).slice(0, 500), nowIso(), e.id);
      }
    });
  }
}

let current = null;
let currentSince = 0;
const STALLED_MS = 10 * 60 * 1000;
let runNo = 0;
async function inboundLoop(run) {
  for (let i = 0; i < 200; i++) {
    if (run !== runNo) return; // this run was abandoned as stuck; a newer one has taken over
    currentSince = Date.now(); // heartbeat: "stuck" means one batch, not a busy hour
    inboundAgain = false;
    const st = processStatuses();
    const batch = claimMessages(4);
    if (batch.length) await Promise.all(batch.map(handleOne));
    if (!st && !batch.length && !inboundAgain) break;
  }
}
/** Single-flight inbound loop. Callers can await the run in progress. */
export function processInbound() {
  if (current && Date.now() - currentSince > STALLED_MS) {
    // Something awaited inside never answered. Let go of that run: its events return to the
    // queue after their lock expires and a fresh run takes over.
    console.error(`[${nowIso()}] Incoming-message worker was stuck for ${Math.round((Date.now() - currentSince) / 60000)} min; starting a fresh run.`);
    try { tx(() => notify({ audience: 'owner', title: 'Message handling was stuck and has been restarted', body: 'Incoming WhatsApp messages were waiting for more than 10 minutes. They are being processed again now. If this repeats, check the internet connection and the AI/WhatsApp settings.', link: '#/settings', level: 'error' })); } catch (e) { console.error('could not record the restart', e.message); }
    setState('inbound_restarted', nowIso());
    current = null;
  }
  if (current) { inboundAgain = true; return current; }
  const p = inboundLoop(++runNo);
  current = p; currentSince = Date.now();
  const clear = () => { if (current === p) current = null; };
  p.then(clear, clear);
  return p;
}

let kick = null;
export function kickInbound() {
  if (!config.workersEnabled || kick) return;
  kick = setTimeout(() => { kick = null; processInbound().catch((e) => console.error('inbound loop', e)); }, 10);
}

/** Process everything that is due now (used by tests and the simulator). */
export async function drain(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await processInbound();
    const t1 = processDueTimers();
    const sent = await dispatchOnce(20);
    const pendingIn = one("SELECT COUNT(*) n FROM inbound_events WHERE status IN ('pending','processing')").n;
    const dueOut = one("SELECT COUNT(*) n FROM outbox WHERE status IN ('queued','unknown') AND next_attempt_at <= ?", nowIso()).n;
    if (!t1 && !sent && !pendingIn && !dueOut) break;
  }
}

export function startWorkers() {
  if (!config.workersEnabled) return;
  setInterval(() => kickInbound(), 2000);
  setInterval(() => kickDispatcher(), 2000);
  setInterval(() => { try { processDueTimers(); } catch (e) { console.error('timers', e); } }, 15000);
  setInterval(() => { try { schedulerTick(); } catch (e) { console.error('scheduler', e); } }, 30000);
  setTimeout(() => { try { processDueTimers(); schedulerTick(); } catch (e) { console.error(e); } }, 3000);
  setState('workers_started', nowIso());
}

export function inboundState() { return { running: !!current, again: inboundAgain, since: current ? currentSince : null }; }
/** Test hook: pretend the current run started `ms` ago. */
export function ageInboundRunForTests(ms) { if (current) currentSince = Date.now() - ms; }
