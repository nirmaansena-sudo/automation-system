// Scheduled routines. Each run has a run key per period, so triggering the
// same routine twice (n8n + backend fallback, or a double click) never runs it twice.
import { all, one, run, insert, update, tx } from '../db/index.js';
import { now, nowIso, addMinIso, istDate, istParts, addDays, hmToMin, truncate, inr, fmtDateLong, jparse } from '../lib/util.js';
import { config } from '../config.js';
import { audit, notify, createTask, setting, setState, getState } from './base.js';
import { enqueueWhatsApp, enqueueEvent, outboxHealth } from './outbox.js';
import { t } from '../bot/i18n.js';
import { getContact, projectLink } from '../domain/common.js';
import { digestSummary } from '../domain/projects.js';
import { attendanceMorningSweep, attendanceEveningSweep, monthlySummary } from '../domain/staff.js';
import { expireQuotations } from '../domain/quotations.js';
import { nudgeStaleLeads } from '../bot/engine.js';
import { createFullBackup } from '../lib/backups.js';

const pad = (n) => String(n).padStart(2, '0');
const monthKey = () => { const p = istParts(); return `${p.y}-${pad(p.m)}`; };

export const ROUTINES = {
  'manager-morning-brief': { label: 'Manager morning brief', when: () => ({ type: 'daily', time: '08:30' }), run: morningBrief },
  'attendance-morning': { label: 'Attendance: missing or unverified check-in', when: () => ({ type: 'hourly', minute: 15 }), run: () => attendanceMorningSweep() },
  'payment-reminders': { label: 'Payment reminders', when: () => ({ type: 'daily', time: '10:30' }), run: paymentReminders },
  'lead-followups': { label: 'Lead nudges & quote expiry', when: () => ({ type: 'daily', time: '11:00' }), run: () => ({ ...nudgeStaleLeads(), quotesExpired: expireQuotations() }) },
  'daily-site-digest': { label: 'Daily client site update', when: () => ({ type: 'daily', time: setting('digest_time') || '19:00' }), run: dailyDigest },
  'attendance-evening': { label: 'Attendance: missing check-out', when: () => ({ type: 'daily', time: '21:00' }), run: () => attendanceEveningSweep() },
  'backup': { label: 'Database backup', when: () => ({ type: 'daily', time: '02:00' }), run: backup, noTx: true },
  'monthly-summary': { label: 'Monthly attendance & expense summary', when: () => ({ type: 'monthly', day: 1, time: '09:00' }), run: monthly },
  'housekeeping': { label: 'Housekeeping', when: () => ({ type: 'hourly', minute: 5 }), run: housekeeping },
};

function runKey(name, when) {
  const p = istParts();
  if (when.type === 'monthly') return `${name}:${monthKey()}`;
  if (when.type === 'hourly') return `${name}:${istDate()}T${pad(p.hh)}`;
  return `${name}:${istDate()}`;
}

/** Run a routine once per period. trigger: internal | fallback | n8n | manual */
export function runRoutine(name, trigger = 'manual', { force = false } = {}) {
  const r = ROUTINES[name];
  if (!r) return { error: `Unknown routine ${name}` };
  const key = force ? `${runKey(name, r.when())}:manual:${Date.now()}` : runKey(name, r.when());
  const started = nowIso();
  const existing = one('SELECT * FROM routine_runs WHERE run_key=?', key);
  if (existing?.status === 'done') return { skipped: true, reason: 'Already ran for this period', runKey: key };
  if (existing?.status === 'running' && existing.started_at > addMinIso(started, -10)) return { skipped: true, reason: 'Run is in progress', runKey: key };
  if (existing && (existing.attempts >= 5 || (existing.next_attempt_at && existing.next_attempt_at > started))) return { skipped: true, reason: existing.attempts >= 5 ? 'Retry limit reached; review and run manually' : 'Waiting for retry', runKey: key };
  const attempts = (existing?.attempts || 0) + 1;
  if (existing) run("UPDATE routine_runs SET status='running', attempts=?, started_at=?, finished_at=NULL, next_attempt_at=NULL, trigger=? WHERE run_key=?", attempts, started, trigger, key);
  else run('INSERT INTO routine_runs(routine, run_key, trigger, status, started_at, attempts) VALUES (?,?,?,?,?,?)', name, key, trigger, 'running', started, attempts);
  try {
    let result;
    const finish = () => run('UPDATE routine_runs SET status=?, result=?, finished_at=?, next_attempt_at=NULL WHERE run_key=?', 'done', JSON.stringify(result ?? {}), nowIso(), key);
    // Business changes and the completion marker commit together. After a crash,
    // either both exist or both roll back, so recovery cannot duplicate the work.
    if (r.noTx) { result = r.run(); finish(); }
    else tx(() => { result = r.run(); if (result && typeof result.then === 'function') throw new Error('Routine handlers must be synchronous'); finish(); });
    if (trigger === 'n8n') setState('n8n_last_seen', nowIso());
    return { ok: true, runKey: key, result };
  } catch (e) {
    run('UPDATE routine_runs SET status=?, result=?, finished_at=?, next_attempt_at=? WHERE run_key=?', 'failed', JSON.stringify({ error: e.message }), nowIso(), attempts >= 5 ? null : addMinIso(nowIso(), [1, 5, 15, 60][attempts - 1]), key);
    notify({ audience: 'owner', title: `Routine failed: ${r.label}`, body: e.message, link: '#/settings', level: 'error' });
    return { error: e.message, runKey: key };
  }
}

function isDue(when) {
  const p = istParts(); const mins = p.hh * 60 + p.mm;
  if (when.type === 'hourly') return p.mm >= when.minute;
  if (when.type === 'monthly') return p.d >= when.day && (p.d > when.day || mins >= hmToMin(when.time));
  return mins >= hmToMin(when.time);
}
function dueMinutesAgo(when) {
  const p = istParts(); const mins = p.hh * 60 + p.mm;
  if (when.type === 'hourly') return p.mm - when.minute;
  if (when.type === 'monthly') return p.d > when.day ? 9999 : mins - hmToMin(when.time);
  return mins - hmToMin(when.time);
}

/** Called every 30 s. In n8n mode the backend only runs a routine if n8n missed it. */
export function schedulerTick() {
  for (const [name, r] of Object.entries(ROUTINES)) {
    const when = r.when();
    if (!isDue(when)) continue;
    const key = runKey(name, when);
    const previous = one('SELECT status FROM routine_runs WHERE run_key=?', key);
    // Daily routines are not "caught up" if the computer was off for most of the day (except backup).
    if (!previous && when.type === 'daily' && dueMinutesAgo(when) > 6 * 60 && name !== 'backup') continue;
    if (previous?.status === 'done') continue;
    const viaN8n = config.routinesMode === 'n8n' && name !== 'housekeeping';
    if (viaN8n && dueMinutesAgo(when) < config.routineFallbackMin) continue;
    const res = runRoutine(name, viaN8n ? 'fallback' : 'internal');
    if (viaN8n && res.ok) notify({ audience: 'owner', title: `n8n missed "${r.label}" — backend ran it`, body: 'Check that n8n is running and the workflow is published.', link: '#/settings', level: 'warn' });
  }
  setState('scheduler_last_tick', nowIso());
}

export function routineStatus() {
  return Object.entries(ROUTINES).map(([name, r]) => {
    const last = one('SELECT * FROM routine_runs WHERE routine=? ORDER BY id DESC LIMIT 1', name);
    return { name, label: r.label, when: r.when(), last: last ? { ...last, result: jparse(last.result, null) } : null };
  });
}

// ---------------------------------------------------------------- routine bodies
function dailyDigest() {
  const day = istDate();
  let sent = 0; let skipped = 0;
  for (const p of all("SELECT * FROM projects WHERE status IN ('active','handover') AND digest_enabled=1")) {
    const c = getContact(p.client_contact_id);
    if (!c || c.opted_out) { skipped++; continue; }
    const lang = c.language || 'en';
    const sum = digestSummary(p.id, day, lang);
    if (!sum) { skipped++; continue; }
    const link = projectLink(p);
    enqueueWhatsApp({
      to: c.wa_id, kind: 'project.daily_digest', dedupeKey: `digest:${p.id}:${day}`,
      message: { type: 'text', text: t('daily_update', lang, { project: p.ref, summary: sum.text, link }) },
      template: { name: 'ns_daily_update', params: [p.ref, truncate(sum.text.replace(/\n/g, ' · '), 500), link] },
    });
    run(`UPDATE site_logs SET digest_sent_at=? WHERE id IN (${sum.logIds.map(() => '?').join(',')})`, nowIso(), ...sum.logIds);
    sent++;
  }
  const noLog = all("SELECT p.ref, u.name sup FROM projects p LEFT JOIN users u ON u.id=p.supervisor_id WHERE p.status='active' AND NOT EXISTS (SELECT 1 FROM site_logs l WHERE l.project_id=p.id AND l.log_date=?)", day);
  if (noLog.length) notify({ audience: 'managers', title: `${noLog.length} active site(s) without today's log`, body: noLog.map((x) => `${x.ref}${x.sup ? ' (' + x.sup + ')' : ''}`).join(', '), link: '#/projects', level: 'warn' });
  return { sent, skipped, sitesWithoutLog: noLog.length };
}

function morningBrief() {
  const today = istDate(); const y = addDays(today, -1);
  const from = new Date(Date.parse(`${y}T00:00:00+05:30`)).toISOString(); const to = new Date(Date.parse(`${today}T00:00:00+05:30`)).toISOString();
  const end = new Date(Date.parse(`${addDays(today, 1)}T00:00:00+05:30`)).toISOString();
  const stats = {
    newLeads: one('SELECT COUNT(*) n FROM leads WHERE created_at>=? AND created_at<?', from, to).n,
    visitsToday: one("SELECT COUNT(*) n FROM visits WHERE start_at>=? AND start_at<? AND status!='cancelled'", to, end).n,
    pendingApprovals: one("SELECT COUNT(*) n FROM approvals WHERE status='pending'").n,
    overdueTasks: one("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','cancelled') AND due_at < ?", nowIso()).n,
    activeProjects: one("SELECT COUNT(*) n FROM projects WHERE status='active'").n,
    paymentsDue: one("SELECT COALESCE(SUM(amount-paid_amount),0) s FROM invoices WHERE status IN ('issued','partially_paid') AND due_date<=?", addDays(today, 7)).s,
    ...outboxHealth(),
  };
  const body = `Leads yesterday ${stats.newLeads} · Visits today ${stats.visitsToday} · Approvals waiting ${stats.pendingApprovals} · Overdue tasks ${stats.overdueTasks} · Active projects ${stats.activeProjects} · Payments due this week ${inr(stats.paymentsDue)}${stats.failed24h ? ` · ⚠ ${stats.failed24h} failed messages` : ''}`;
  notify({ audience: 'managers', title: '☀️ Morning brief', body, link: '#/overview' });
  enqueueEvent('brief.morning', stats);
  if (setting('owner_whatsapp_alerts')) {
    for (const u of all("SELECT * FROM users WHERE role='owner' AND active=1 AND phone IS NOT NULL")) enqueueWhatsApp({ to: u.phone, kind: 'staff.brief', dedupeKey: `brief:${u.id}:${today}`, message: { type: 'text', text: `☀️ Morning brief\n${body.replace(/ · /g, '\n')}` }, template: { name: 'ns_staff_alert', params: [`morning brief: ${body}`.slice(0, 900)] } });
  }
  return stats;
}

function paymentReminders() {
  const today = istDate(); const soon = addDays(today, 2);
  let reminded = 0; let escalated = 0;
  for (const inv of all("SELECT * FROM invoices WHERE status IN ('issued','partially_paid') AND due_date<=?", soon)) {
    const p = one('SELECT * FROM projects WHERE id=?', inv.project_id);
    const c = getContact(p.client_contact_id);
    if (inv.reminders >= 3) {
      if (inv.due_date < addDays(today, -7)) { createTask({ title: `Overdue payment ${inv.ref} · ${p.ref}`, description: `${inr(inv.amount - inv.paid_amount)} due since ${inv.due_date}. Call the client.`, kind: 'follow_up', priority: 'high', entityType: 'project', entityId: p.id, assigneeId: p.manager_id, dedupeKey: `overdue:${inv.id}` }); escalated++; }
      continue;
    }
    if (inv.last_reminder_at && (Date.parse(nowIso()) - Date.parse(inv.last_reminder_at)) < 3 * 86400e3) continue;
    if (!c) continue;
    const lang = c.language || 'en';
    const pay = inv.payment_link ? (lang === 'hi' ? `भुगतान लिंक: ${inv.payment_link}` : `Pay here: ${inv.payment_link}`) : setting('payment_instructions');
    enqueueWhatsApp({ to: c.wa_id, kind: 'invoice.reminder', dedupeKey: `payrem:${inv.id}:${today}`, message: { type: 'text', text: t('payment_reminder', lang, { amount: inr(inv.amount - inv.paid_amount), title: inv.title, project: p.ref, due: fmtDateLong(inv.due_date), pay }) }, template: { name: 'ns_payment_reminder', params: [p.ref, inr(inv.amount - inv.paid_amount), inv.title, fmtDateLong(inv.due_date), pay] } });
    run('UPDATE invoices SET reminders=reminders+1, last_reminder_at=? WHERE id=?', nowIso(), inv.id);
    reminded++;
  }
  return { reminded, escalated };
}

function backup() {
  const result = createFullBackup();
  setState('backup_last', { at: nowIso(), ...result });
  return result;
}

function monthly() {
  const s = monthlySummary();
  const hasData = one('SELECT 1 FROM attendance_days WHERE day LIKE ? LIMIT 1', `${s.month}%`);
  if (!s.rows.length || !hasData) return { month: s.month, skipped: 'no attendance recorded for that month' };
  const id = insert('approvals', { kind: 'payroll', entity_type: 'payroll', entity_id: null, title: `Approve payroll inputs · ${s.month}`, summary: `${s.rows.length} people · download the CSV from Team → Payroll`, data: JSON.stringify({ month: s.month }), status: 'pending', requested_by: 'system', created_at: nowIso() });
  notify({ audience: 'owner', title: `Payroll summary ready · ${s.month}`, link: '#/approvals' });
  notify({ audience: 'finance', title: `Payroll summary ready · ${s.month}`, link: '#/team' });
  enqueueEvent('payroll.summary', s);
  return { month: s.month, people: s.rows.length, approval: id };
}

function housekeeping() {
  const at = nowIso();
  const sessions = run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString()).changes;
  const holds = run("UPDATE calendar_holds SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?", at).changes;
  const stuck = run("UPDATE inbound_events SET status='pending' WHERE status='processing' AND locked_at < ?", addMinIso(at, -10)).changes;
  const oldNotif = run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', addMinIso(at, -60 * 24 * 60)).changes;
  return { sessions, holds, stuck, oldNotif };
}

/** Health summary used by the dashboard and the n8n watchdog. */
export function healthReport() {
  const ob = outboxHealth();
  const warnings = [];
  const stuck = one("SELECT COUNT(*) n FROM inbound_events WHERE status IN ('pending','processing') AND received_at < ?", addMinIso(nowIso(), -5)).n;
  const failedIn = one("SELECT COUNT(*) n FROM inbound_events WHERE status='failed' AND received_at > ?", addMinIso(nowIso(), -1440)).n;
  const timers = getState('timers_last_run');
  const sched = getState('scheduler_last_tick');
  if (ob.overdue > 0) warnings.push(`${ob.overdue} outgoing message(s) overdue`);
  if (ob.operator > ob.unknown) warnings.push(`${ob.operator - ob.unknown} message(s) need manual sending`);
  if (ob.unknown > 0) warnings.push(`${ob.unknown} message delivery outcome(s) unknown; verify before resending`);
  if (stuck > 0) warnings.push(`${stuck} incoming event(s) waiting > 5 min`);
  if (failedIn > 0) warnings.push(`${failedIn} incoming event(s) failed in 24 h`);
  if (!timers || (now().getTime() - Date.parse(timers.updated_at)) > 5 * 60e3) warnings.push('Timer loop not running');
  if (!sched || (now().getTime() - Date.parse(sched.updated_at)) > 5 * 60e3) warnings.push('Scheduler not running');
  const failedRoutines = all("SELECT routine, run_key FROM routine_runs WHERE status='failed' AND started_at > ?", addMinIso(nowIso(), -1440));
  for (const r of failedRoutines) warnings.push(`Routine failed: ${r.routine}`);
  const failedTimers = one("SELECT COUNT(*) n FROM timers WHERE status='failed'").n;
  const retryingTimers = one("SELECT COUNT(*) n FROM timers WHERE status='pending' AND attempts>0").n;
  if (failedTimers) warnings.push(`${failedTimers} timer(s) exhausted retries; review required`);
  if (retryingTimers) warnings.push(`${retryingTimers} timer(s) waiting for retry`);
  const abandoned = one("SELECT COUNT(*) n FROM routine_runs WHERE status='running' AND started_at < ?", addMinIso(nowIso(), -10)).n;
  if (abandoned) warnings.push(`${abandoned} routine run(s) interrupted; current periods recover automatically`);
  const ageMin = (iso) => (iso ? (now().getTime() - Date.parse(iso)) / 60e3 : Infinity);
  const badSig = getState('webhook_bad_signature')?.value;
  if (ageMin(badSig) < 1440) warnings.push('Webhooks with a bad signature in the last 24 h (check WHATSAPP_APP_SECRET / the webhook key)');
  if (config.whatsapp.provider !== 'simulator' && !getState('webhook_last_received')) warnings.push('No WhatsApp webhook received yet (check the callback URL and the "messages" subscription)');
  const lastBackup = getState('backup_last')?.value;
  const started = getState('server_started')?.value;
  if (ageMin(lastBackup?.at) > 36 * 60 && ageMin(started) > 60) warnings.push('No database backup in the last 36 hours');
  if (config.routinesMode === 'n8n' && ageMin(getState('n8n_last_seen')?.value) > 30 && ageMin(started) > 30) warnings.push('n8n not seen for 30+ minutes (the backend is running the routines itself)');
  return {
    ok: warnings.length === 0, at: nowIso(), warnings, outbox: ob, inbound: { stuck, failed24h: failedIn },
    lastWebhook: getState('webhook_last_received')?.value || null, n8nLastSeen: getState('n8n_last_seen')?.value || null,
    lastBackup: getState('backup_last')?.value || null, routinesMode: config.routinesMode,
  };
}
