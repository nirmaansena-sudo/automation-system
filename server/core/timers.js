// Durable timers (deadlines). Each timer names the entity and revision it was
// created for; handlers must check the entity is still at that revision/state
// before acting, so rescheduled or cancelled items never fire stale actions.
import { all, one, run, insert, update, tx } from '../db/index.js';
import { nowIso, addMinIso, jparse } from '../lib/util.js';
import { setState, notify, audit } from './base.js';

const handlers = new Map();
export function registerTimer(kind, fn) { handlers.set(kind, fn); }

export function schedule(kind, { entityType, entityId, revision = null, dueAt, data = {}, dedupeKey }) {
  if (dedupeKey) {
    const ex = one('SELECT id, status FROM timers WHERE dedupe_key = ?', dedupeKey);
    if (ex) {
      if (ex.status === 'pending') run('UPDATE timers SET due_at=?, data=?, revision=?, attempts=0, next_attempt_at=NULL WHERE id=?', dueAt, JSON.stringify(data), revision, ex.id);
      else run("UPDATE timers SET due_at=?, data=?, revision=?, status='pending', fired_at=NULL, result=NULL, attempts=0, next_attempt_at=NULL WHERE id=?", dueAt, JSON.stringify(data), revision, ex.id);
      return ex.id;
    }
  }
  return insert('timers', { kind, entity_type: entityType, entity_id: entityId, revision, due_at: dueAt, data: JSON.stringify(data), dedupe_key: dedupeKey || null, status: 'pending', created_at: nowIso() });
}

export function cancelTimers(entityType, entityId, kinds) {
  if (kinds && kinds.length) {
    run(`UPDATE timers SET status='cancelled', fired_at=? WHERE status='pending' AND entity_type=? AND entity_id=? AND kind IN (${kinds.map(() => '?').join(',')})`, nowIso(), entityType, entityId, ...kinds);
  } else {
    run("UPDATE timers SET status='cancelled', fired_at=? WHERE status='pending' AND entity_type=? AND entity_id=?", nowIso(), entityType, entityId);
  }
}

/** Fire all due timers (each in its own transaction). */
export function processDueTimers(limit = 50) {
  const due = all("SELECT * FROM timers WHERE status='pending' AND due_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY due_at, id LIMIT ?", nowIso(), nowIso(), limit);
  let fired = 0;
  for (const t of due) {
    try {
      tx(() => {
        const cur = one('SELECT status FROM timers WHERE id = ?', t.id);
        if (cur.status !== 'pending') return;
        const h = handlers.get(t.kind);
        if (!h) throw new Error(`No handler registered for ${t.kind}`);
        const result = h({ ...t, data: jparse(t.data, {}) }) || 'done';
        if (result && typeof result.then === 'function') throw new Error('Timer handlers must be synchronous and transactional');
        update('timers', t.id, { status: 'fired', attempts: t.attempts + 1, next_attempt_at: null, fired_at: nowIso(), result: String(result).slice(0, 200) });
      });
      fired++;
    } catch (e) {
      console.error('timer failed', t.kind, t.id, e);
      tx(() => {
        const attempts = t.attempts + 1;
        const exhausted = attempts >= 5;
        update('timers', t.id, { status: exhausted ? 'failed' : 'pending', attempts, next_attempt_at: exhausted ? null : addMinIso(nowIso(), [1, 5, 15, 60][attempts - 1]), fired_at: exhausted ? nowIso() : null, result: String(e.message).slice(0, 200) });
        if (attempts === 1 || exhausted) notify({ audience: 'owner', title: exhausted ? `Timer requires attention: ${t.kind}` : `Timer retry scheduled: ${t.kind}`, body: `Timer ${t.id}: ${e.message}`, link: '#/settings', level: exhausted ? 'error' : 'warn' });
      });
    }
  }
  setState('timers_last_run', nowIso());
  return fired;
}

export function retryTimer(id, actor) {
  const result = run("UPDATE timers SET status='pending', attempts=0, next_attempt_at=NULL, fired_at=NULL WHERE id=? AND status='failed'", id);
  if (result.changes) audit(actor, 'timer.retry', 'timer', id);
  return !!result.changes;
}
