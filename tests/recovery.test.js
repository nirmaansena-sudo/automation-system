import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './helpers.js';
let h;
before(async () => { h = await boot({ AI_MODE: 'off', N8N_BASE_URL: 'http://127.0.0.1:1' }); });
after(async () => { if (h) await h.close(); });

test('unknown sends remain held indefinitely, late receipt reconciles, manual retry requires evidence', async () => {
  const { enqueueWhatsApp, dispatchOnce, applyStatus, retryJob, resolveUnknownJob } = await import('../server/core/outbox.js');
  const phone = '919700009901';
  const a = h.db.tx(() => enqueueWhatsApp({ to: phone, kind: 'recovery.unknown', message: { type: 'text', text: 'one' } }));
  h.db.run("UPDATE outbox SET status='unknown', next_attempt_at=? WHERE id=?", h.util.addMinIso(h.util.nowIso(), -10), a);
  const b = h.db.tx(() => enqueueWhatsApp({ to: phone, kind: 'recovery.next', message: { type: 'text', text: 'two' } }));
  await dispatchOnce();
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', a).status, 'unknown');
  assert.equal(h.db.one('SELECT attempts FROM outbox WHERE id=?', a).attempts, 0, 'no provider send attempted');
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', b).status, 'queued', 'FIFO held');
  assert.ok(h.db.one('SELECT id FROM tasks WHERE dedupe_key=?', `reconcile:${a}`));
  assert.equal(h.db.tx(() => retryJob(a, 'test')), false);
  assert.throws(() => h.db.tx(() => resolveUnknownJob(a, 'test', { outcome: 'not_sent', note: 'x' })), /verified/);
  h.db.tx(() => applyStatus({ callbackData: `ob:${a}`, wamid: 'wamid.RECOVERY', status: 'delivered' }));
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', a).status, 'sent');
  assert.equal(h.db.one('SELECT status FROM tasks WHERE dedupe_key=?', `reconcile:${a}`).status, 'done');
  h.db.run("UPDATE outbox SET status='unknown' WHERE id=?", b);
  assert.equal(h.db.tx(() => resolveUnknownJob(b, 'test', { outcome: 'not_sent', note: 'Provider confirms no delivery' })), true);
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?', b).status, 'queued');
  h.db.run("UPDATE outbox SET status='cancelled' WHERE id=?", b);
});

test('crash-expired WhatsApp leases enter reconciliation without another send', async () => {
  const { enqueueWhatsApp, dispatchOnce } = await import('../server/core/outbox.js');
  const id = h.db.tx(() => enqueueWhatsApp({ to: '919700009902', kind: 'recovery.crash', message: { type: 'text', text: 'x' } }));
  h.db.run("UPDATE outbox SET status='sending', lease_until=?, attempts=1 WHERE id=?", h.util.addMinIso(h.util.nowIso(), -10), id);
  await dispatchOnce();
  const job = h.db.one('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(job.status, 'unknown'); assert.equal(job.attempts, 1);
});

test('routine failure rolls back effects; scheduled retry and crash recovery run exactly once', async () => {
  const { ROUTINES, runRoutine } = await import('../server/core/routines.js');
  let fail = true;
  ROUTINES['test-recovery'] = { label: 'Test recovery', when: () => ({ type: 'daily', time: '00:00' }), run: () => {
    h.db.run("INSERT INTO audit_log(at,actor,action) VALUES (?,'test','recovery.effect')", h.util.nowIso());
    if (fail) throw new Error('injected transient failure'); return { recovered: true };
  }};
  try {
    assert.ok(runRoutine('test-recovery').error);
    assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='recovery.effect'").n, 0);
    assert.equal(runRoutine('test-recovery').skipped, true);
    fail = false; h.util.advanceClock(61e3);
    assert.equal(runRoutine('test-recovery').ok, true);
    assert.equal(runRoutine('test-recovery').skipped, true);
    assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='recovery.effect'").n, 1);
    h.db.run("UPDATE routine_runs SET status='running', started_at=?, attempts=1 WHERE routine='test-recovery'", h.util.addMinIso(h.util.nowIso(), -11));
    h.db.run("DELETE FROM audit_log WHERE action='recovery.effect'");
    assert.equal(runRoutine('test-recovery').ok, true);
    assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='recovery.effect'").n, 1);
  } finally { delete ROUTINES['test-recovery']; h.util.resetClock(); }
});

test('timer retries roll back partial effects, alert on exhaustion and support explicit recovery', async () => {
  const { registerTimer, schedule, processDueTimers, retryTimer } = await import('../server/core/timers.js');
  let fail = true;
  registerTimer('test-retry', () => { h.db.run("INSERT INTO audit_log(at,actor,action) VALUES (?,'test','timer.effect')", h.util.nowIso()); if (fail) throw new Error('temporary timer error'); return 'ok'; });
  const id = schedule('test-retry', { dueAt: h.util.nowIso() });
  for (let i = 0; i < 5; i++) { processDueTimers(); h.util.advanceClock(61 * 60e3); }
  assert.equal(h.db.one('SELECT status FROM timers WHERE id=?', id).status, 'failed');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='timer.effect'").n, 0);
  assert.ok(h.db.one("SELECT id FROM notifications WHERE title LIKE 'Timer requires attention:%'"));
  fail = false; assert.equal(h.db.tx(() => retryTimer(id, 'test')), true); processDueTimers();
  assert.equal(h.db.one('SELECT status FROM timers WHERE id=?', id).status, 'fired');
  assert.equal(h.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='timer.effect'").n, 1);
  h.util.resetClock();
});

test('nested rollback discards commit hooks', () => {
  let called = false;
  h.db.tx(() => { try { h.db.tx(() => { h.db.onCommit(() => { called = true; }); throw new Error('rollback'); }); } catch {} });
  assert.equal(called, false);
});

test('encrypted full backup verifies checksums, restores media/config, rejects tampering and never overwrites', async () => {
  const { config } = await import('../server/config.js');
  const { createFullBackup, validateBackup, restoreBackup } = await import('../server/lib/backups.js');
  fs.writeFileSync(path.join(config.mediaDir, 'test-photo.txt'), 'test media snapshot');
  const password = 'test-only-backup-password';
  const backup = createFullBackup({ password, offsiteDir: path.join(h.dir, 'offsite-test') });
  const file = path.join(config.backupDir, backup.file);
  const check = validateBackup(file, { password });
  assert.ok(check.files.some((f) => f.path === 'media/test-photo.txt'));
  assert.ok(check.files.some((f) => f.path === 'secrets.json'));
  assert.ok(check.files.some((f) => f.path === 'configuration/runtime.json'));
  assert.equal(fs.readFileSync(file).includes(Buffer.from('test media snapshot')), false);
  assert.throws(() => validateBackup(file, { password: 'incorrect-backup-password' }), /authentication failed/);
  const dest = path.join(h.dir, 'restored-test');
  assert.equal(restoreBackup(file, dest, { password }).ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'media', 'test-photo.txt'), 'utf8'), 'test media snapshot');
  assert.throws(() => restoreBackup(file, dest, { password }), /new directory/);
  const tampered = path.join(h.dir, 'tampered.nsbackup'); const bytes = fs.readFileSync(file); bytes[bytes.length - 20] ^= 1; fs.writeFileSync(tampered, bytes);
  assert.throws(() => validateBackup(tampered, { password }), /authentication failed/);
  assert.equal(fs.existsSync(path.join(h.dir, 'offsite-test', backup.file)), true);
});

test('late failure receipts cannot revive cancelled jobs or regress confirmed delivery', async () => {
  const {enqueueWhatsApp,resolveUnknownJob,applyStatus}=await import('../server/core/outbox.js');
  const create=()=>h.db.tx(()=>enqueueWhatsApp({to:'919700009903',kind:'recovery.late-failure',message:{type:'text',text:'test'}}));
  const cancelled=create();h.db.run("UPDATE outbox SET status='unknown' WHERE id=?",cancelled);
  h.db.tx(()=>resolveUnknownJob(cancelled,'test',{outcome:'cancelled',note:'Cancel without another send'}));
  h.db.tx(()=>applyStatus({callbackData:`ob:${cancelled}`,wamid:'wamid.OLD-CANCEL',status:'failed',errors:[{code:131000}]}));
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?',cancelled).status,'cancelled');
  const delivered=create();
  h.db.tx(()=>applyStatus({callbackData:`ob:${delivered}`,wamid:'wamid.DELIVERED',status:'delivered'}));
  h.db.tx(()=>applyStatus({callbackData:`ob:${delivered}`,wamid:'wamid.DELIVERED',status:'failed',errors:[{code:131000}]}));
  assert.equal(h.db.one('SELECT status FROM outbox WHERE id=?',delivered).status,'sent');
  assert.equal(h.db.one('SELECT status FROM messages WHERE outbox_id=?',delivered).status,'delivered');
});
