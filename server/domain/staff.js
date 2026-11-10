// Employees: accounts, attendance (GPS as evidence, offline sync, review),
// leave (blocks calendar), expenses (manager → finance), tasks, sweeps.
import { all, one, run, insert, update, onCommit } from '../db/index.js';
import { now, nowIso, addMinIso, jparse, istDate, fromIst, addDays, dayOfWeek, daysInclusive, haversineM, hashSecret, hmToMin, istParts, minutesBetween, inr, fmtTime, normPhone } from '../lib/util.js';
import { broadcast } from '../lib/http.js';
import { audit, notify, createTask, setting, getSettings, getState, setState } from '../core/base.js';
import { enqueueWhatsApp, enqueueEvent, registerGuard } from '../core/outbox.js';
import { getUser, ensureContact, appLink } from './common.js';
import { createApproval } from './leads.js';
import crypto from 'node:crypto';
import { forbidden, bad } from '../lib/http.js';
import { validatePassword, DASHBOARD_ROLES } from '../lib/auth.js';

export const ROLES = ['owner', 'manager', 'architect', 'engineer', 'supervisor', 'staff', 'finance'];
export const FIELD_ROLES = ['architect', 'engineer', 'supervisor', 'staff'];
export const WORK_MODES = ['office', 'field', 'hybrid'];

// ---------- users ----------
export function publicUser(u) {
  if (!u) return null;
  const { password_hash, pin_hash, ...rest } = u;
  return { ...rest, zones: jparse(u.zones, []), skills: jparse(u.skills, []), weekly_off: jparse(u.weekly_off, []), has_password: !!password_hash, has_pin: !!pin_hash };
}
export function createUser(data, actor) {
  if (!data.name || !ROLES.includes(data.role)) return { error: 'Name and a valid role are required' };
  const error = validateUser(data);
  if (error) return { error };
  if (actor && actor.role !== 'owner' && data.role === 'owner') throw forbidden('Only an owner can create an owner account');
  const phone = data.phone ? normPhone(data.phone) : null;
  if (phone && one('SELECT 1 FROM users WHERE phone=?', phone)) return { error: 'Another person already uses this phone number' };
  if (data.email && one('SELECT 1 FROM users WHERE email=?', String(data.email).toLowerCase())) return { error: 'Another person already uses this email' };
  const pin = data.pin || String(crypto.randomInt(100000, 1000000));
  const at = nowIso();
  const id = insert('users', {
    name: String(data.name).trim(), phone, email: data.email ? String(data.email).toLowerCase().trim() : null, role: data.role, title: data.title?.trim() || null,
    department: String(data.department || '').trim(), work_mode: data.work_mode || (['architect', 'engineer', 'supervisor'].includes(data.role) ? 'field' : 'office'),
    password_hash: data.password ? hashSecret(data.password) : null, pin_hash: hashSecret(pin),
    zones: JSON.stringify(data.zones || []), skills: JSON.stringify(data.skills || []), shift_start: data.shift_start || '09:00', shift_end: data.shift_end || '18:00',
    grace_min: Number(data.grace_min ?? 15), weekly_off: JSON.stringify(data.weekly_off ?? [0]), daily_visit_cap: Number(data.daily_visit_cap ?? 3), active: 1, notes: data.notes || null, created_at: at, updated_at: at,
  });
  if (phone) ensureContact(phone, { userId: id, name: data.name });
  audit(actor ? `user:${actor.id}` : 'system', 'user.created', 'user', id, { role: data.role });
  onCommit(() => broadcast('team'));
  return { id, pin };
}
export function updateUser(id, data, actor) {
  const u = getUser(id);
  if (!u) return { error: 'Not found' };
  if (actor && actor.role !== 'owner' && (u.role === 'owner' || data.role === 'owner')) throw forbidden('Only an owner can change an owner account');
  const error = validateUser(data);
  if (error) return { error };
  const patch = { updated_at: nowIso() };
  for (const k of ['name', 'role', 'title', 'shift_start', 'shift_end', 'notes']) if (data[k] !== undefined) patch[k] = data[k];
  if (data.department !== undefined) patch.department = String(data.department || '').trim();
  if (data.work_mode !== undefined) patch.work_mode = data.work_mode;
  if (data.email !== undefined) patch.email = data.email ? String(data.email).toLowerCase().trim() : null;
  if (data.phone !== undefined) { patch.phone = data.phone ? normPhone(data.phone) : null; if (patch.phone && one('SELECT 1 FROM users WHERE phone=? AND id!=?', patch.phone, id)) return { error: 'Phone already used' }; }
  for (const k of ['grace_min', 'daily_visit_cap']) if (data[k] !== undefined) patch[k] = Number(data[k]);
  for (const k of ['zones', 'skills', 'weekly_off']) if (data[k] !== undefined) patch[k] = JSON.stringify(data[k]);
  if (data.active !== undefined) patch.active = data.active ? 1 : 0;
  if (data.password) patch.password_hash = hashSecret(data.password);
  if (patch.role && !ROLES.includes(patch.role)) return { error: 'Invalid role' };
  update('users', id, patch);
  if (patch.phone) ensureContact(patch.phone, { userId: id });
  if (patch.active === 0 || patch.password_hash || (patch.role && patch.role !== u.role) || (patch.phone && patch.phone !== u.phone)) run('DELETE FROM sessions WHERE user_id=?', id);
  audit(`user:${actor?.id}`, 'user.updated', 'user', id, { ...patch, password_hash: undefined, password: data.password ? '***' : undefined });
  onCommit(() => broadcast('team'));
  return { ok: true };
}
export function resetPin(id, actor) {
  const user = getUser(id);
  if (!user) throw bad('User not found');
  if (!actor || !['owner', 'manager'].includes(actor.role)) throw forbidden();
  if (user.role === 'owner' && actor.role !== 'owner') throw forbidden('Only an owner can reset an owner PIN');
  const pin = String(crypto.randomInt(100000, 1000000));
  update('users', id, { pin_hash: hashSecret(pin), updated_at: nowIso() });
  run("DELETE FROM sessions WHERE user_id=? AND kind='app'", id);
  audit(`user:${actor?.id}`, 'user.pin_reset', 'user', id);
  return { pin };
}

function validateUser(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Employee details must be an object';
  if (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120)) return 'Name must be 1–120 characters';
  if (data.department !== undefined && data.department !== null && (typeof data.department !== 'string' || data.department.trim().length > 80 || /[\u0000-\u001f]/.test(data.department))) return 'Department must be at most 80 characters without control characters';
  if (data.title !== undefined && data.title !== null && (typeof data.title !== 'string' || data.title.length > 120)) return 'Job title must be at most 120 characters';
  if (data.work_mode !== undefined && !WORK_MODES.includes(data.work_mode)) return 'Work mode must be office, field or hybrid';
  if (data.email && (typeof data.email !== 'string' || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()))) return 'Enter a valid email';
  if (data.phone && (typeof data.phone !== 'string' || data.phone.length > 32 || !/^\d{11,15}$/.test(normPhone(data.phone) || ''))) return 'Enter a valid phone number';
  if (data.password !== undefined) { try { validatePassword(data.password); } catch (e) { return e.message; } }
  if (data.pin !== undefined && (typeof data.pin !== 'string' || !/^\d{4,8}$/.test(data.pin))) return 'PIN must be 4–8 digits';
  for (const field of ['shift_start', 'shift_end']) if (data[field] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[field])) return 'Shift times must use HH:MM';
  if (data.grace_min !== undefined && (!Number.isInteger(Number(data.grace_min)) || Number(data.grace_min) < 0 || Number(data.grace_min) > 240)) return 'Grace period must be 0–240 minutes';
  if (data.daily_visit_cap !== undefined && (!Number.isInteger(Number(data.daily_visit_cap)) || Number(data.daily_visit_cap) < 1 || Number(data.daily_visit_cap) > 20)) return 'Daily visit cap must be 1–20';
  if (data.weekly_off !== undefined && (!Array.isArray(data.weekly_off) || data.weekly_off.some((x) => !Number.isInteger(x) || x < 0 || x > 6))) return 'Weekly off must contain weekday numbers from 0 to 6';
  for (const field of ['zones', 'skills']) if (data[field] !== undefined && (!Array.isArray(data[field]) || data[field].length > 50 || data[field].some((x) => typeof x !== 'string' || x.length > 100))) return `Invalid ${field}`;
  return null;
}

const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// ---------- attendance ----------
export function allowedPlaces(user, day) {
  const s = getSettings();
  const places = [];
  if (s.office?.lat) places.push({ type: 'office', id: null, name: s.office.name || 'Office', lat: s.office.lat, lng: s.office.lng, radius: s.office.radius_m || 200 });
  for (const p of all("SELECT * FROM projects WHERE status IN ('active','handover','awaiting_advance') AND site_lat IS NOT NULL AND (supervisor_id=? OR engineer_id=? OR architect_id=? OR manager_id=?)", user.id, user.id, user.id, user.id)) {
    places.push({ type: 'project', id: p.id, name: `${p.ref} site`, lat: p.site_lat, lng: p.site_lng, radius: p.geofence_m || 250 });
  }
  const from = fromIst(day, '00:00').toISOString(); const to = fromIst(addDays(day, 1), '00:00').toISOString();
  for (const v of all("SELECT v.id, v.ref, l.site_lat, l.site_lng FROM visits v JOIN leads l ON l.id=v.lead_id WHERE v.architect_id=? AND v.start_at>=? AND v.start_at<? AND v.status IN ('confirmed','in_progress','report_submitted','completed') AND l.site_lat IS NOT NULL", user.id, from, to)) {
    places.push({ type: 'visit', id: v.id, name: `Visit ${v.ref}`, lat: v.site_lat, lng: v.site_lng, radius: 300 });
  }
  return places;
}

const BLOCKING = ['no_location', 'poor_accuracy', 'outside_geofence', 'sync_too_late', 'device_time_in_future', 'out_without_in'];

export function recordAttendance(userId, ev) {
  if (ev.client_event_id) {
    if (typeof ev.client_event_id !== 'string' || ev.client_event_id.length > 128) return { error: 'Invalid event ID' };
    const ex = one('SELECT * FROM attendance_events WHERE client_event_id=?', ev.client_event_id);
    if (ex && ex.user_id !== userId) return { error: 'Event ID belongs to another account' };
    if (ex) return { ok: true, id: ex.id, validation: ex.validation, reasons: jparse(ex.reasons, []), duplicate: true };
  }
  const u = getUser(userId);
  if (!u || !u.active) return { error: 'User inactive' };
  if (!['in', 'out'].includes(ev.kind)) return { error: 'kind must be in or out' };
  const cfg = setting('attendance');
  const serverT = now();
  const deviceT = ev.device_time ? new Date(ev.device_time) : serverT;
  if (Number.isNaN(deviceT.getTime())) return { error: 'Bad device time' };
  const reasons = [];
  const lat = ev.lat === undefined || ev.lat === null || ev.lat === '' ? null : Number(ev.lat);
  const lng = ev.lng === undefined || ev.lng === null || ev.lng === '' ? null : Number(ev.lng);
  const acc = ev.accuracy_m === undefined || ev.accuracy_m === null ? null : Number(ev.accuracy_m);
  if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) || (acc !== null && (!Number.isFinite(acc) || acc < 0))) return { error: 'Invalid GPS coordinates or accuracy' };
  const skewMin = (serverT - deviceT) / 60000;
  const offline = !!ev.offline || skewMin > cfg.skew_limit_min;
  if (skewMin < -cfg.skew_limit_min) reasons.push('device_time_in_future');
  if (offline && skewMin > cfg.offline_max_h * 60) reasons.push('sync_too_late');
  const effective = offline && !reasons.includes('sync_too_late') ? deviceT : serverT;
  const day = istDate(effective);
  let place = null; let dist = null;
  if (lat === null || lng === null) reasons.push('no_location');
  else {
    if (acc !== null && acc > cfg.accuracy_limit_m) reasons.push('poor_accuracy');
    const places = allowedPlaces(u, day);
    let preferred = ev.place_type ? places.find((p) => p.type === ev.place_type && (p.id ?? null) === (ev.place_id ?? null)) : null;
    const ranked = places.map((p) => ({ p, d: haversineM(lat, lng, p.lat, p.lng) })).sort((a, b) => a.d - b.d);
    const pick = preferred ? { p: preferred, d: haversineM(lat, lng, preferred.lat, preferred.lng) } : ranked[0];
    if (pick) {
      place = pick.p; dist = pick.d;
      const tolerance = place.radius + Math.min(acc ?? 50, 100);
      if (dist > tolerance) {
        const anyInside = ranked.find((r) => r.d <= r.p.radius + Math.min(acc ?? 50, 100));
        if (anyInside) { place = anyInside.p; dist = anyInside.d; } else reasons.push('outside_geofence');
      }
    }
  }
  const lastToday = one("SELECT * FROM attendance_events WHERE user_id=? AND effective_time>=? AND effective_time<=? AND (review_status IS NULL OR review_status != 'rejected') ORDER BY effective_time DESC LIMIT 1",
    userId, fromIst(day, '00:00').toISOString(), effective.toISOString());
  if (ev.kind === 'out' && (!lastToday || lastToday.kind !== 'in')) reasons.push('out_without_in');
  if (ev.kind === 'in' && lastToday?.kind === 'in') reasons.push('already_checked_in');
  const p = istParts(effective); const mins = p.hh * 60 + p.mm;
  if (ev.kind === 'in' && !lastToday && mins > hmToMin(u.shift_start) + u.grace_min) reasons.push('late');
  if (ev.kind === 'out' && mins < hmToMin(u.shift_end) - 30) reasons.push('early_out');
  if (offline) reasons.push('offline_sync');
  const validation = reasons.some((r) => BLOCKING.includes(r)) ? 'needs_review' : 'accepted';
  const id = insert('attendance_events', {
    user_id: userId, kind: ev.kind, device_time: deviceT.toISOString(), server_time: serverT.toISOString(), effective_time: effective.toISOString(),
    lat, lng, accuracy_m: acc, place_type: place?.type || null, place_id: place?.id ?? null, place_name: place?.name || null, distance_m: dist,
    photo_media_id: ev.photo_media_id || null, client_event_id: ev.client_event_id || null, offline: offline ? 1 : 0,
    validation, reasons: JSON.stringify(reasons), note: ev.note || null,
  });
  if (validation === 'needs_review') {
    createApproval('attendance_exception', 'attendance_event', id, `Attendance check · ${u.name} · ${ev.kind === 'in' ? 'check-in' : 'check-out'} ${fmtTime(effective)}`,
      reasons.filter((r) => BLOCKING.includes(r)).map(reasonText).join(', ') + (dist !== null && place ? ` · ${Math.round(dist)} m from ${place.name}` : ''), { userId, day });
  }
  recomputeDay(userId, day);
  audit(`user:${userId}`, `attendance.${ev.kind}`, 'user', userId, { id, validation, reasons });
  onCommit(() => broadcast('attendance'));
  return { ok: true, id, validation, reasons, place: place?.name || null, distance_m: dist };
}

export function reasonText(r) {
  return ({ no_location: 'no GPS location', poor_accuracy: 'weak GPS accuracy', outside_geofence: 'outside office/site area', sync_too_late: 'synced too late', device_time_in_future: 'phone clock is wrong', out_without_in: 'check-out without check-in', already_checked_in: 'already checked in', late: 'late', early_out: 'left early', offline_sync: 'recorded offline', missing_checkout: 'forgot to check out' })[r] || r;
}

/** Manager review: approve (optionally with corrected time) or reject. Originals are kept. */
export function reviewAttendance(approvalId, { decision, note, corrected_time }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const ev = one('SELECT * FROM attendance_events WHERE id=?', a.entity_id);
  const at = nowIso();
  const patch = { review_status: decision === 'approve' ? 'approved' : 'rejected', reviewed_by: actor?.id || null, review_note: note || null, reviewed_at: at };
  if (decision === 'approve' && corrected_time) {
    const ct = new Date(corrected_time);
    if (!Number.isNaN(ct.getTime())) patch.effective_time = ct.toISOString();
  }
  update('attendance_events', ev.id, patch);
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, at, a.id);
  recomputeDay(ev.user_id, istDate(ev.effective_time));
  if (patch.effective_time) recomputeDay(ev.user_id, istDate(patch.effective_time));
  notify({ userId: ev.user_id, title: `Attendance ${decision === 'approve' ? 'approved' : 'rejected'}`, body: note || '', link: '#/attendance' });
  audit(`user:${actor?.id}`, 'attendance.review', 'attendance_event', ev.id, { decision, note, corrected_time });
  onCommit(() => broadcast('attendance'));
  return { ok: true };
}

function leaveOn(userId, day) { return one("SELECT * FROM leave_requests WHERE user_id=? AND status='approved' AND from_date<=? AND to_date>=?", userId, day, day); }
function isHoliday(day) { return one('SELECT name FROM holidays WHERE day=?', day); }

// A queued reminder may be retried later. Recheck the employee and today's
// evidence before every send so resolved attendance and old phone numbers stay quiet.
registerGuard('attendance_missing', (g) => {
  const day = istDate(); const u = getUser(g.userId);
  if (g.day !== day || !u?.active || u.role === 'owner' || u.phone !== g.phone) return false;
  if (isHoliday(day) || jparse(u.weekly_off, []).includes(dayOfWeek(day)) || leaveOn(u.id, day)) return false;
  const due = addMinIso(fromIst(day, u.shift_start), Number(u.grace_min) + Number(setting('attendance').morning_check_after_min));
  if (now() < new Date(due)) return false;
  return !one("SELECT 1 FROM attendance_events WHERE user_id=? AND kind='in' AND effective_time>=? AND effective_time<? AND (review_status IS NULL OR review_status!='rejected')", u.id, fromIst(day, '00:00').toISOString(), fromIst(addDays(day, 1), '00:00').toISOString());
});

/** Pure derived view. Original evidence remains untouched; rejected events never set current state. */
export function summarizeAttendanceDay(u, day, { events = [], leave = null, holiday = null, at = nowIso() } = {}) {
  const evs = events.filter((e) => e.review_status !== 'rejected').sort((a, b) => a.effective_time.localeCompare(b.effective_time) || a.id - b.id);
  const flags = new Set();
  let minutes = 0; let openIn = null; let firstIn = null; let lastOut = null; let pending = false; let pendingCount = 0;
  for (const e of evs) {
    for (const r of jparse(e.reasons, [])) if (r !== 'late') flags.add(r);
    if (e.validation === 'needs_review' && !e.review_status) { pending = true; pendingCount++; }
    if (e.kind === 'in') { if (!openIn) openIn = e.effective_time; if (!firstIn) firstIn = e.effective_time; }
    if (e.kind === 'out') { if (openIn) { minutes += Math.max(0, minutesBetween(openIn, e.effective_time)); openIn = null; } lastOut = e.effective_time; }
  }
  const today = istDate(at);
  if (openIn && day === today) minutes += Math.max(0, minutesBetween(openIn, at));
  // Lateness follows the approved effective time, not the immutable original reason string.
  if (firstIn && new Date(firstIn) > new Date(addMinIso(fromIst(day, u.shift_start), Number(u.grace_min)))) flags.add('late');
  if (openIn && day < today) { flags.add('missing_checkout'); pending = true; }
  const cfg = setting('attendance');
  let status;
  if (!evs.length) {
    if (leave) status = 'leave';
    else if (holiday) status = 'holiday';
    else if (jparse(u.weekly_off, []).includes(dayOfWeek(day))) status = 'weekly_off';
    else status = day < today ? 'absent' : 'not_checked_in';
  } else if (pending) status = 'needs_review';
  else if (lastOut && !openIn && minutes < cfg.half_day_min) status = 'half_day';
  else if (flags.has('late')) status = 'late';
  else status = 'present';
  return { status, first_in: firstIn, last_out: lastOut, minutes: Math.round(minutes), flags: [...flags], checked_in: !!openIn,
    last_event: evs.at(-1) || null, pending_events: pendingCount, event_count: evs.length, rejected_events: events.length - evs.length };
}

export function recomputeDay(userId, day) {
  const u = getUser(userId);
  if (!u) return;
  const from = fromIst(day, '00:00').toISOString(); const to = fromIst(addDays(day, 1), '00:00').toISOString();
  const events = all('SELECT * FROM attendance_events WHERE user_id=? AND effective_time>=? AND effective_time<? ORDER BY effective_time,id', userId, from, to);
  const result = summarizeAttendanceDay(u, day, { events, leave: leaveOn(userId, day), holiday: isHoliday(day) });
  run(`INSERT INTO attendance_days(user_id, day, status, first_in, last_out, minutes, flags, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, day) DO UPDATE SET status=excluded.status, first_in=excluded.first_in, last_out=excluded.last_out, minutes=excluded.minutes, flags=excluded.flags, updated_at=excluded.updated_at`,
  userId, day, result.status, result.first_in, result.last_out, result.minutes, JSON.stringify(result.flags), nowIso());
  return result.status;
}

/** Hourly check of each employee's shift, with one reminder per person/type/day. */
export function attendanceMorningSweep(at = now()) {
  const day = istDate(at); const dow = dayOfWeek(day);
  if (isHoliday(day)) return { reminded: 0, names: [], awaitingReview: 0, reviewNames: [], missing: 0 };
  const cfg = setting('attendance');
  const missing = []; const review = []; let missingTotal = 0;
  const start = fromIst(day, '00:00').toISOString(); const end = fromIst(addDays(day, 1), '00:00').toISOString();
  for (const u of all("SELECT * FROM users WHERE active=1 AND role!='owner'")) {
    if (jparse(u.weekly_off, []).includes(dow) || leaveOn(u.id, day)) continue;
    const due = addMinIso(fromIst(day, u.shift_start), Number(u.grace_min) + Number(cfg.morning_check_after_min));
    if (new Date(at) < new Date(due)) continue;
    const checkins = all("SELECT * FROM attendance_events WHERE user_id=? AND kind='in' AND effective_time>=? AND effective_time<? AND (review_status IS NULL OR review_status!='rejected')", u.id, start, end);
    const stateKey = `attendance-reminder:${u.id}`;
    const saved = getState(stateKey)?.value;
    const sent = saved?.day === day ? saved : { day };
    if (checkins.length) {
      // Pending location/clock evidence is neither a missing punch nor confirmed presence.
      if (checkins.every((e) => e.validation === 'needs_review' && !e.review_status) && !sent.review) {
        review.push(u); setState(stateKey, { ...sent, review: true });
      }
      continue;
    }
    missingTotal++;
    if (sent.missing) continue;
    missing.push(u);
    setState(stateKey, { ...sent, missing: true });
    notify({ userId: u.id, title: 'You have not checked in today', body: 'Check in from the app or apply for leave.', link: '#/home', level: 'warn' });
    if (u.phone) enqueueWhatsApp({ to: u.phone, kind: 'attendance.reminder', dedupeKey: `att-remind:${u.id}:${day}`, guard: { type: 'attendance_missing', userId: u.id, phone: u.phone, day }, message: { type: 'text', text: `Hi ${u.name.split(' ')[0]}, you haven't checked in today. Please check in from the app: ${appLink()} or apply for leave.` }, template: { name: 'ns_attendance_reminder', params: [u.name.split(' ')[0], day] } });
  }
  if (missing.length) notify({ audience: 'managers', title: `${missing.length} not checked in yet`, body: missing.map((u) => u.name).join(', '), link: '#/attendance?status=not_checked_in', level: 'warn' });
  if (review.length) notify({ audience: 'managers', title: `${review.length} check-in(s) await evidence review`, body: review.map((u) => u.name).join(', ') + '. Review location/time evidence before confirming attendance.', link: '#/attendance?status=needs_review', level: 'warn' });
  return { reminded: missing.length, names: missing.map((u) => u.name), missing: missingTotal, awaitingReview: review.length, reviewNames: review.map((u) => u.name) };
}

/** Evening sweep: close open sessions as "missing checkout" for review. */
export function attendanceEveningSweep(dayArg) {
  const day = dayArg || istDate();
  let closed = 0;
  for (const u of all('SELECT * FROM users WHERE active=1')) {
    const last = one("SELECT * FROM attendance_events WHERE user_id=? AND effective_time>=? AND effective_time<? AND (review_status IS NULL OR review_status!='rejected') ORDER BY effective_time DESC LIMIT 1", u.id, fromIst(day, '00:00').toISOString(), fromIst(addDays(day, 1), '00:00').toISOString());
    if (last && last.kind === 'in') {
      const shiftEnd = fromIst(day, u.shift_end);
      const eff = new Date(Math.max(shiftEnd.getTime(), new Date(last.effective_time).getTime() + 60000)).toISOString();
      const id = insert('attendance_events', { user_id: u.id, kind: 'out', device_time: null, server_time: nowIso(), effective_time: eff, validation: 'needs_review', reasons: JSON.stringify(['missing_checkout']), note: 'Auto-closed at shift end — confirm the actual time', auto: 1 });
      createApproval('attendance_exception', 'attendance_event', id, `Missing check-out · ${u.name} · ${day}`, 'Auto-closed at shift end. Approve, or approve with the correct time, or reject.', { userId: u.id, day });
      closed++;
    }
    recomputeDay(u.id, day);
  }
  onCommit(() => broadcast('attendance'));
  return { closed };
}

/** Live team board for managers. */
export function teamBoard(day = istDate()) {
  const from = fromIst(day, '00:00').toISOString(); const to = fromIst(addDays(day, 1), '00:00').toISOString();
  return all("SELECT * FROM users WHERE active=1 AND role != 'owner' ORDER BY role, name").map((u) => {
    const evs = all("SELECT * FROM attendance_events WHERE user_id=? AND effective_time>=? AND effective_time<? ORDER BY effective_time,id", u.id, from, to);
    const computed = summarizeAttendanceDay(u, day, { events: evs, leave: leaveOn(u.id, day), holiday: isHoliday(day) });
    const last = computed.last_event;
    const tasks = one("SELECT COUNT(*) total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done, SUM(CASE WHEN status NOT IN ('done','cancelled') AND due_at < ? THEN 1 ELSE 0 END) overdue FROM tasks WHERE assignee_id=? AND (due_at IS NULL OR (due_at>=? AND due_at<?) OR status NOT IN ('done','cancelled'))", nowIso(), u.id, from, to);
    const visits = all("SELECT id, ref, status, start_at FROM visits WHERE architect_id=? AND start_at>=? AND start_at<? AND status!='cancelled' ORDER BY start_at", u.id, from, to);
    const logs = one('SELECT COUNT(*) n FROM site_logs WHERE user_id=? AND log_date=?', u.id, day).n;
    const lastActivity = one("SELECT MAX(at) at FROM audit_log WHERE actor=? AND at>=?", `user:${u.id}`, from)?.at;
    return {
      user: publicUser(u), checkedIn: computed.checked_in, lastEvent: last ? { kind: last.kind, at: last.effective_time, place: last.place_name, distance_m: last.distance_m, validation: last.validation, review_status: last.review_status } : null,
      firstIn: computed.first_in, status: computed.status,
      tasks: { total: tasks.total || 0, done: tasks.done || 0, overdue: tasks.overdue || 0 }, visits, logs, lastActivity,
    };
  });
}

// ---------- leave ----------
export function requestLeave(userId, { type = 'casual', from_date, to_date, reason }) {
  if (!validDay(from_date) || !validDay(to_date) || to_date < from_date || Date.parse(to_date) - Date.parse(from_date) > 365 * 86400000) return { error: 'Choose valid dates within one year' };
  if (!['casual', 'sick', 'earned', 'unpaid'].includes(type)) return { error: 'Choose a valid leave type' };
  if (reason && (typeof reason !== 'string' || reason.length > 2000)) return { error: 'Reason must be at most 2,000 characters' };
  const u = getUser(userId);
  const id = insert('leave_requests', { user_id: userId, type, from_date, to_date, reason: reason || null, status: 'pending', created_at: nowIso() });
  createApproval('leave', 'leave', id, `Leave · ${u.name} · ${from_date}${to_date !== from_date ? ' → ' + to_date : ''}`, `${type}${reason ? ' · ' + reason : ''}`, { userId });
  audit(`user:${userId}`, 'leave.requested', 'leave', id);
  return { ok: true, id };
}
export function decideLeave(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const lr = one('SELECT * FROM leave_requests WHERE id=?', a.entity_id);
  const u = getUser(lr.user_id);
  const at = nowIso();
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, at, a.id);
  update('leave_requests', lr.id, { status: decision === 'approve' ? 'approved' : 'rejected', decided_by: actor?.id || null, decision_note: note || null, decided_at: at });
  if (decision === 'approve') {
    const start = fromIst(lr.from_date, '00:00').toISOString(); const end = fromIst(addDays(lr.to_date, 1), '00:00').toISOString();
    insert('calendar_holds', { user_id: u.id, start_at: start, end_at: end, kind: 'leave', ref_type: 'leave', ref_id: lr.id, status: 'active', created_at: at });
    const clashes = all("SELECT ref, start_at FROM visits WHERE architect_id=? AND status='confirmed' AND start_at>=? AND start_at<?", u.id, start, end);
    if (clashes.length) createTask({ title: `Reassign ${clashes.length} visit(s): ${u.name} is on leave`, description: clashes.map((v) => `${v.ref} ${new Date(v.start_at).toISOString()}`).join('\n'), priority: 'high', kind: 'general', assigneeId: actor?.id, dedupeKey: `leave-clash:${lr.id}` });
    for (const d of daysInclusive(lr.from_date, lr.to_date)) recomputeDay(u.id, d);
  }
  notify({ userId: u.id, title: `Leave ${decision === 'approve' ? 'approved ✅' : 'not approved'}`, body: `${lr.from_date} → ${lr.to_date}${note ? ' · ' + note : ''}`, link: '#/requests' });
  if (u.phone) enqueueWhatsApp({ to: u.phone, kind: 'leave.decision', message: { type: 'text', text: `Leave ${lr.from_date} → ${lr.to_date}: ${decision === 'approve' ? 'approved ✅' : 'not approved'}${note ? ' — ' + note : ''}` }, template: { name: 'ns_staff_alert', params: [`leave ${lr.from_date} to ${lr.to_date} ${decision === 'approve' ? 'approved' : 'not approved'}`] } });
  audit(`user:${actor?.id}`, `leave.${decision}`, 'leave', lr.id, { note });
  onCommit(() => { broadcast('team'); broadcast('attendance'); });
  return { ok: true };
}

// ---------- expenses ----------
export function submitExpense(userId, { category, amount, claim_date, project_id, description, receipt_media_id }) {
  const amt = Number(amount);
  if (!['travel', 'fuel', 'material', 'food', 'tools', 'other'].includes(category) || !Number.isFinite(amt) || !(amt > 0) || amt > 100000000) return { error: 'Choose a valid category and finite positive amount' };
  if (claim_date && !validDay(claim_date)) return { error: 'Choose a valid claim date' };
  if (description && (typeof description !== 'string' || description.length > 4000)) return { error: 'Description must be at most 4,000 characters' };
  const u = getUser(userId);
  if (!u || !u.active) return { error: 'User inactive' };
  if (project_id && !DASHBOARD_ROLES.includes(u.role) && !one('SELECT 1 FROM projects WHERE id=? AND (manager_id=? OR architect_id=? OR engineer_id=? OR supervisor_id=?)', project_id, userId, userId, userId, userId)) return { error: 'Not your project' };
  const id = insert('expense_claims', { user_id: userId, category, amount: amt, claim_date: claim_date || istDate(), project_id: project_id || null, description: description || null, receipt_media_id: receipt_media_id || null, status: 'pending_manager', created_at: nowIso() });
  if (receipt_media_id) run("UPDATE media SET owner_type='expense', owner_id=? WHERE id=?", id, receipt_media_id);
  createApproval('expense', 'expense', id, `Expense · ${u.name} · ${inr(amt)}`, `${category}${description ? ' · ' + description : ''}`, { userId, stage: 'manager' });
  audit(`user:${userId}`, 'expense.submitted', 'expense', id);
  return { ok: true, id };
}
export function decideExpense(approvalId, { decision, note }, actor) {
  const a = one('SELECT * FROM approvals WHERE id=?', approvalId);
  if (!a || a.status !== 'pending') return { error: 'Already handled' };
  const ex = one('SELECT * FROM expense_claims WHERE id=?', a.entity_id);
  const u = getUser(ex.user_id);
  const at = nowIso();
  const stage = jparse(a.data, {}).stage || 'manager';
  run('UPDATE approvals SET status=?, decision=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?', decision === 'approve' ? 'approved' : 'rejected', decision, actor?.id || null, note || null, at, a.id);
  if (decision !== 'approve') {
    update('expense_claims', ex.id, { status: 'rejected', note: note || null, ...(stage === 'manager' ? { manager_id: actor?.id, manager_at: at } : { finance_id: actor?.id, finance_at: at }) });
    notify({ userId: u.id, title: 'Expense not approved', body: `${inr(ex.amount)} · ${note || ''}`, link: '#/requests' });
  } else if (stage === 'manager') {
    update('expense_claims', ex.id, { status: 'pending_finance', manager_id: actor?.id || null, manager_at: at });
    createApproval('expense', 'expense', ex.id, `Finance check · ${u.name} · ${inr(ex.amount)}`, `${ex.category} · manager approved`, { userId: u.id, stage: 'finance' });
  } else {
    update('expense_claims', ex.id, { status: 'approved', finance_id: actor?.id || null, finance_at: at });
    notify({ userId: u.id, title: 'Expense approved ✅', body: inr(ex.amount), link: '#/requests' });
    enqueueEvent('expense.approved', { user: u.name, amount: ex.amount, category: ex.category });
  }
  audit(`user:${actor?.id}`, `expense.${stage}.${decision}`, 'expense', ex.id, { note });
  return { ok: true };
}

// ---------- tasks ----------
export function updateTask(id, patch, actor) {
  const tk = one('SELECT * FROM tasks WHERE id=?', id);
  if (!tk) return { error: 'Task not found' };
  const set = { updated_at: nowIso() };
  for (const k of ['title', 'description', 'priority', 'due_at']) if (patch[k] !== undefined) set[k] = patch[k];
  if (patch.assignee_id !== undefined) set.assignee_id = patch.assignee_id || null;
  if (patch.status) { set.status = patch.status; if (patch.status === 'done') set.completed_at = nowIso(); }
  if (patch.note) set.evidence = [tk.evidence, `${new Date().toISOString().slice(0, 16)} ${patch.note}`].filter(Boolean).join('\n').slice(0, 4000);
  update('tasks', id, set);
  if (patch.assignee_id && patch.assignee_id !== tk.assignee_id) notify({ userId: patch.assignee_id, title: `Task assigned: ${tk.title}`, link: '#/tasks' });
  audit(`user:${actor?.id}`, 'task.update', 'task', id, patch);
  onCommit(() => broadcast('tasks'));
  return { ok: true };
}

/** Monthly attendance + expense summary for payroll (previous month by default). */
export function monthlySummary(month) {
  const m = month || (() => { const p = istParts(); const d = new Date(Date.UTC(p.y, p.m - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
  const rows = all("SELECT * FROM users WHERE active=1 AND role != 'owner' ORDER BY name").map((u) => {
    const days = all('SELECT status, minutes FROM attendance_days WHERE user_id=? AND day LIKE ?', u.id, `${m}%`);
    const count = (s) => days.filter((d) => d.status === s).length;
    const exp = one("SELECT COALESCE(SUM(amount),0) s FROM expense_claims WHERE user_id=? AND status IN ('approved','paid') AND claim_date LIKE ?", u.id, `${m}%`).s;
    return { name: u.name, role: u.role, present: count('present') + count('late'), late: count('late'), half_day: count('half_day'), absent: count('absent'), leave: count('leave'), needs_review: count('needs_review'), hours: Math.round(days.reduce((a, d) => a + d.minutes, 0) / 60), expenses: exp };
  });
  return { month: m, rows };
}
