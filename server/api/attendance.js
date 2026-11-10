// Dedicated manager reporting. Reads original/effective evidence without writing
// attendance rows; all corrections continue through the existing approval flow.
import { all, one } from '../db/index.js';
import { bad, notFound } from '../lib/http.js';
import { istDate, nowIso, fromIst, addDays, daysInclusive, jparse } from '../lib/util.js';
import { ROLES, WORK_MODES, summarizeAttendanceDay } from '../domain/staff.js';
import { audit } from '../core/base.js';

const AUTH = { auth: 'dashboard', roles: ['owner', 'manager'] };
const STATUSES = ['present', 'late', 'half_day', 'absent', 'leave', 'needs_review', 'not_checked_in', 'holiday', 'weekly_off', 'not_enrolled', 'inactive'];
const USER_COLUMNS = 'id,name,role,title,department,work_mode,active,shift_start,shift_end,grace_min,weekly_off,created_at';
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= istDate();
}
function flag(value, field) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw bad(`${field} must be 0 or 1`);
}
function parseFilters(query) {
  const filters = {
    q: String(query.q || '').trim(), department: String(query.department || '').trim(),
    role: String(query.role || ''), work_mode: String(query.work_mode || ''), status: String(query.status || ''),
    presence: String(query.presence || ''), includeOwners: flag(query.includeOwners, 'includeOwners'),
    includeInactive: flag(query.includeInactive, 'includeInactive'), unassigned: flag(query.unassigned, 'unassigned'),
  };
  if (filters.q.length > 120 || filters.department.length > 80 || /[\u0000-\u001f]/.test(filters.q + filters.department)) throw bad('Search or department is invalid');
  if (filters.role && !ROLES.includes(filters.role)) throw bad('Invalid access role');
  if (filters.work_mode && !WORK_MODES.includes(filters.work_mode)) throw bad('Invalid work mode');
  if (filters.status && !STATUSES.includes(filters.status)) throw bad('Invalid attendance status');
  if (filters.presence && !['in', 'out', 'none'].includes(filters.presence)) throw bad('Invalid recorded state');
  if (filters.role === 'owner') filters.includeOwners = true;
  return filters;
}
function roster(filters) {
  const users = all(`SELECT ${USER_COLUMNS} FROM users ${filters.includeInactive ? '' : 'WHERE active=1'} ORDER BY active DESC,name COLLATE NOCASE,id`)
    .filter((u) => filters.includeOwners || u.role !== 'owner');
  const options = { departments: [...new Set(users.map((u) => u.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)), roles: ROLES, work_modes: WORK_MODES, statuses: STATUSES };
  const search = filters.q.toLocaleLowerCase();
  return { options, users: users.filter((u) => (!filters.role || u.role === filters.role) && (!filters.work_mode || u.work_mode === filters.work_mode)
    && (!filters.department || u.department === filters.department) && (!filters.unassigned || !u.department)
    && (!search || `${u.name} ${u.id} ${u.title || ''} ${u.department || ''}`.toLocaleLowerCase().includes(search))) };
}
function loadEvidence(first, last) {
  const start = fromIst(first, '00:00').toISOString(); const end = fromIst(addDays(last, 1), '00:00').toISOString();
  const groups = new Map();
  for (const event of all('SELECT * FROM attendance_events WHERE effective_time>=? AND effective_time<? ORDER BY effective_time,id', start, end)) {
    const key = `${event.user_id}:${istDate(event.effective_time)}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event);
  }
  const leaves = all("SELECT * FROM leave_requests WHERE status='approved' AND from_date<=? AND to_date>=?", last, first);
  const holidays = new Map(all('SELECT * FROM holidays WHERE day>=? AND day<=?', first, last).map((h) => [h.day, h]));
  const saved = new Map(all('SELECT * FROM attendance_days WHERE day>=? AND day<=?', first, last).map((d) => [`${d.user_id}:${d.day}`, d]));
  return { groups, leaves, holidays, saved };
}
function dayRecord(user, day, evidence, at) {
  const events = evidence.groups.get(`${user.id}:${day}`) || [];
  const leave = evidence.leaves.find((l) => l.user_id === user.id && l.from_date <= day && l.to_date >= day);
  const result = summarizeAttendanceDay(user, day, { events, leave, holiday: evidence.holidays.get(day), at });
  if (!events.length && !leave) {
    if (user.created_at && day < istDate(user.created_at)) result.status = 'not_enrolled';
    else if (!user.active) {
      const previous = evidence.saved.get(`${user.id}:${day}`);
      result.status = day < istDate(at) && previous ? previous.status : 'inactive';
      if (previous && day < istDate(at)) { result.minutes = previous.minutes; result.flags = jparse(previous.flags, []); }
    }
  }
  const last = result.last_event;
  return { day, status: result.status, first_in: result.first_in, last_out: result.last_out, minutes: result.minutes,
    hours: Math.round(result.minutes / 60 * 100) / 100, checked_in: result.checked_in, flags: result.flags,
    pending_events: result.pending_events, event_count: result.event_count, rejected_events: result.rejected_events,
    last_event: last ? { id: last.id, kind: last.kind, at: last.effective_time, place: last.place_name, place_type: last.place_type,
      lat: last.lat, lng: last.lng, accuracy_m: last.accuracy_m, validation: last.validation, review_status: last.review_status, auto: !!last.auto } : null };
}
function profile(user) { return { id: user.id, name: user.name, role: user.role, title: user.title, department: user.department, work_mode: user.work_mode, active: !!user.active, shift_start: user.shift_start, shift_end: user.shift_end }; }
function countStatuses(rows) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}
function matchesState(row, filters) {
  const presence = !row.last_event ? 'none' : row.checked_in ? 'in' : 'out';
  return (!filters.status || filters.status === row.status) && (!filters.presence || filters.presence === presence);
}
export function attendanceDashboard(query = {}) {
  const day = query.day || istDate();
  if (!validDay(day)) throw bad('Choose a valid date from 2000 through today');
  const filters = parseFilters(query); const { users, options } = roster(filters); const at = nowIso();
  const evidence = loadEvidence(day, day);
  const allRows = users.map((user) => ({ user: profile(user), ...dayRecord(user, day, evidence, at) }));
  return { day, timezone: 'Asia/Kolkata', generatedAt: at, filters, options,
    summary: { employees: allRows.length, ...countStatuses(allRows), reported_in: allRows.filter((r) => r.checked_in).length,
      reported_out: allRows.filter((r) => r.last_event && !r.checked_in).length, pending_events: allRows.reduce((n, r) => n + r.pending_events, 0) },
    rows: allRows.filter((row) => matchesState(row, filters)) };
}
export function attendanceMonthly(query = {}) {
  const month = query.month || istDate().slice(0, 7);
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < '2000-01' || month > istDate().slice(0, 7)) throw bad('Choose a valid month from 2000 through the current month');
  const first = `${month}-01`; const [year, m] = month.split('-').map(Number);
  const finalDay = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10); const last = finalDay < istDate() ? finalDay : istDate();
  const days = daysInclusive(first, last); const filters = parseFilters(query); const { users, options } = roster(filters);
  if (filters.presence) throw bad('Recorded-state filtering is available in the daily dashboard');
  const at = nowIso(); const evidence = loadEvidence(first, last);
  const allRows = users.map((user) => {
    const records = days.map((day) => dayRecord(user, day, evidence, at));
    return { user: profile(user), counts: countStatuses(records), hours: Math.round(records.reduce((n, r) => n + r.minutes, 0) / 60 * 100) / 100,
      pending_events: records.reduce((n, r) => n + r.pending_events, 0), days: records };
  });
  const rows = allRows.filter((r) => !filters.status || r.counts[filters.status] > 0);
  return { month, first, last, days, timezone: 'Asia/Kolkata', generatedAt: at, filters, options,
    summary: { employees: allRows.length, reportedDays: days.length, ...countStatuses(allRows.flatMap((r) => r.days)) }, rows };
}
function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
const istStamp = (value) => value ? new Date(Date.parse(value) + 330 * 60000).toISOString().slice(0, 19) + '+05:30' : '';
export function registerAttendance(r) {
  r.get('/api/attendance/dashboard', AUTH, (ctx) => attendanceDashboard(ctx.query));
  r.get('/api/attendance/monthly', AUTH, (ctx) => attendanceMonthly(ctx.query));
  r.get('/api/attendance/employee/:id', AUTH, (ctx) => {
    const user = one(`SELECT ${USER_COLUMNS} FROM users WHERE id=?`, Number(ctx.params.id));
    if (!user) throw notFound();
    const day = ctx.query.day || istDate(); if (!validDay(day)) throw bad('Choose a valid date through today');
    const evidence = loadEvidence(day, day);
    const events = (evidence.groups.get(`${user.id}:${day}`) || []).map((e) => ({ ...e, reasons: jparse(e.reasons, []),
      approval_id: one("SELECT id FROM approvals WHERE kind='attendance_exception' AND entity_id=? AND status='pending'", e.id)?.id || null }));
    return { user: profile(user), ...dayRecord(user, day, evidence, nowIso()), events };
  });
  r.get('/api/attendance/export.csv', AUTH, (ctx) => {
    const monthly = ctx.query.view === 'monthly';
    if (ctx.query.view && !['daily', 'monthly'].includes(ctx.query.view)) throw bad('Choose daily or monthly export');
    const data = monthly ? attendanceMonthly(ctx.query) : attendanceDashboard(ctx.query);
    const head = monthly
      ? ['Month', 'Employee ID', 'Name', 'Department', 'Job title', 'Access role', 'Work mode', 'Active now', ...STATUSES, 'Recorded hours', 'Pending review events']
      : ['Date IST', 'Employee ID', 'Name', 'Department', 'Job title', 'Access role', 'Work mode', 'Active now', 'Status', 'First in IST', 'Last out IST', 'Recorded state', 'Last recorded location', 'Recorded hours', 'Pending review events'];
    const rows = data.rows.map((row) => {
      const u = row.user; const base = [monthly ? data.month : data.day, u.id, u.name, u.department, u.title, u.role, u.work_mode, u.active ? 'yes' : 'no'];
      return monthly ? [...base, ...STATUSES.map((status) => row.counts[status] || 0), row.hours, row.pending_events]
        : [...base, row.status, istStamp(row.first_in), istStamp(row.last_out), row.last_event ? row.checked_in ? 'in' : 'out' : 'no event', row.last_event?.place || '', row.hours, row.pending_events];
    });
    audit(`user:${ctx.user.id}`, 'attendance.report_export', 'attendance', null, { view: monthly ? 'monthly' : 'daily', period: monthly ? data.month : data.day, filters: data.filters, rows: rows.length });
    ctx.res.setHeader('Content-Disposition', `attachment; filename="attendance-${monthly ? data.month : data.day}.csv"`);
    ctx.text('\ufeff' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'), 200, 'text/csv; charset=utf-8');
  });
}
