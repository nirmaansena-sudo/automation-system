import { html, api, on, toast, modal, formData, dt, date, time, badge, label, options, empty, todayIst } from '/shared/ui.js';

let report = null;
const STATUS = { present: 'Present', late: 'Late', half_day: 'Half day', absent: 'Absent', leave: 'Approved leave', needs_review: 'Needs review', not_checked_in: 'Not checked in', weekly_off: 'Weekly off', holiday: 'Holiday', not_enrolled: 'Before account creation', inactive: 'Inactive / no record' };
const TONES = { present: 'good', late: 'warn', half_day: 'warn', absent: 'bad', leave: 'info', needs_review: 'bad', not_checked_in: 'warn', inactive: 'muted', not_enrolled: 'muted' };
const statusBadge = (status) => html`<span class="badge ${TONES[status] || 'muted'}">${STATUS[status] || label(status)}</span>`;
function paramsFor(data, view) {
  const out = new URLSearchParams(); out.set('view', view);
  const filters = data.filters || data;
  for (const key of ['q', 'department', 'role', 'work_mode', 'status', ...(view === 'daily' ? ['presence'] : [])]) if (filters[key]) out.set(key, filters[key]);
  for (const key of ['includeOwners', 'includeInactive', 'unassigned']) if (filters[key] === true || filters[key] === '1') out.set(key, '1');
  out.set(view === 'monthly' ? 'month' : 'day', view === 'monthly' ? data.month || data.day?.slice(0, 7) || todayIst().slice(0, 7) : data.day || data.last || todayIst());
  return out.toString();
}
function filterForm(data, view) {
  const f = data.filters;
  return html`<form id="attendance-filters" class="card" style="margin-bottom:14px"><input type="hidden" name="view" value="${view}"><div class="form-grid">
    <label class="field"><span>${view === 'monthly' ? 'Month' : 'Date'} (India time)</span><input type="${view === 'monthly' ? 'month' : 'date'}" name="${view === 'monthly' ? 'month' : 'day'}" min="${view === 'monthly' ? '2000-01' : '2000-01-01'}" max="${view === 'monthly' ? todayIst().slice(0, 7) : todayIst()}" value="${view === 'monthly' ? data.month : data.day}" required></label>
    <label class="field"><span>Search employee</span><input name="q" maxlength="120" value="${f.q}" placeholder="Name, employee ID or job title"></label>
    <label class="field"><span>Department</span><select name="departmentChoice">${options([{ value: '', label: 'All departments' }, { value: 'none', label: 'Department unassigned' }, ...data.options.departments.map((d) => ({ value: `dept:${d}`, label: d }))], f.unassigned ? 'none' : f.department ? `dept:${f.department}` : '')}</select></label>
    <label class="field"><span>Access role</span><select name="role">${options(data.options.roles, f.role, { blank: 'All access roles' })}</select></label>
    <label class="field"><span>Work mode</span><select name="work_mode">${options(data.options.work_modes, f.work_mode, { blank: 'All work modes' })}</select></label>
    <label class="field"><span>${view === 'monthly' ? 'Has days with status' : 'Attendance status'}</span><select name="status">${options(Object.entries(STATUS).map(([value, text]) => ({ value, label: text })), f.status, { blank: 'All statuses' })}</select></label>
    ${view === 'daily' ? html`<label class="field"><span>Last recorded state</span><select name="presence">${options([{ value: 'in', label: 'Checked in' }, { value: 'out', label: 'Checked out' }, { value: 'none', label: 'No event' }], f.presence, { blank: 'All states' })}</select></label>` : ''}</div>
    <div class="row" style="margin-top:12px;flex-wrap:wrap"><label class="check"><input type="checkbox" name="includeOwners" ${f.includeOwners ? 'checked' : ''}> Include owners</label><label class="check"><input type="checkbox" name="includeInactive" ${f.includeInactive ? 'checked' : ''}> Include inactive accounts / history</label><button class="btn primary">Apply filters</button><a class="btn ghost" href="#/attendance?view=${view}">Reset</a></div></form>`;
}
function summaryCards(data, view) {
  const keys = [['employees', 'Employees in scope'], ['present', view === 'monthly' ? 'Present days' : 'Present'], ['late', view === 'monthly' ? 'Late days' : 'Late'], ['absent', view === 'monthly' ? 'Absent days' : 'Absent'], ['leave', view === 'monthly' ? 'Leave days' : 'Approved leave'], ['not_checked_in', 'Not checked in'], ['needs_review', 'Needs review'], ['half_day', view === 'monthly' ? 'Half days' : 'Half day']];
  return html`<div class="grid g4" style="margin-bottom:14px">${keys.map(([key, title]) => html`<div class="stat"><div class="stat-label">${title}</div><div class="stat-value">${data.summary[key] || 0}</div></div>`)}</div>`;
}
function personCell(u) { return html`<a class="link" href="#/team/person/${u.id}"><b>${u.name}</b></a><div class="muted small">#${u.id}${u.title ? ` · ${u.title}` : ''}${!u.active ? ' · inactive now' : ''}</div>`; }
function locationCell(event) {
  if (!event) return html`<span class="muted">No recorded location</span>`;
  const gps = event.lat !== null && event.lng !== null && Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lng));
  return html`${event.place || (gps ? 'GPS recorded' : 'No GPS')} ${gps ? html`<a class="link small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${Number(event.lat)},${Number(event.lng)}">Map</a>` : ''}<div class="muted small">${time(event.at)}${event.validation === 'needs_review' && !event.review_status ? ' · unverified' : event.review_status === 'approved' ? ' · reviewed' : ''}${event.auto ? ' · automatic checkout' : ''}</div>`;
}
function dailyTable(data) {
  if (!data.rows.length) return empty('No employees match these filters', 'Reset filters or include inactive accounts for older records.');
  return html`<div class="card flush table-wrap"><table class="t"><thead><tr><th>Employee</th><th>Department / mode</th><th>Access role / shift</th><th>Status</th><th>First in</th><th>Last out</th><th>Recorded state</th><th>Last recorded location</th><th>Hours</th><th></th></tr></thead><tbody>${data.rows.map((r) => html`<tr><td>${personCell(r.user)}</td><td>${r.user.department || 'Unassigned'}<div class="muted small">${label(r.user.work_mode)}</div></td><td>${label(r.user.role)}<div class="muted small">${r.user.shift_start}–${r.user.shift_end}</div></td><td>${statusBadge(r.status)}${r.pending_events ? html`<div class="small muted">${r.pending_events} event(s) awaiting review</div>` : ''}</td><td class="nowrap">${time(r.first_in)}</td><td class="nowrap">${time(r.last_out)}</td><td>${r.last_event ? r.checked_in ? data.day === todayIst() ? 'Checked in' : 'No checkout recorded' : 'Checked out' : 'No event'}</td><td>${locationCell(r.last_event)}</td><td class="num">${r.hours.toFixed(2)}</td><td><button class="btn small" data-att-evidence="${r.user.id}" data-day="${data.day}">Evidence</button></td></tr>`)}</tbody></table></div>`;
}
function monthlyTable(data) {
  if (!data.rows.length) return empty('No employees match these filters');
  return html`<div class="card flush table-wrap"><table class="t"><thead><tr><th>Employee</th><th>Department / mode</th><th>Present</th><th>Late</th><th>Half day</th><th>Absent</th><th>Leave</th><th>Not checked in</th><th>Review</th><th>Off / holiday</th><th>Recorded hours</th><th></th></tr></thead><tbody>${data.rows.map((r) => html`<tr><td>${personCell(r.user)}<div class="muted small">${label(r.user.role)}</div></td><td>${r.user.department || 'Unassigned'}<div class="muted small">${label(r.user.work_mode)}</div></td>${['present', 'late', 'half_day', 'absent', 'leave', 'not_checked_in', 'needs_review'].map((s) => html`<td class="num">${r.counts[s] || 0}</td>`)}<td class="num">${r.counts.weekly_off + r.counts.holiday}</td><td class="num">${r.hours.toFixed(2)}</td><td><button class="btn small" data-att-days="${r.user.id}">View days</button></td></tr>`)}</tbody></table></div>`;
}
async function evidenceDialog(id, day) {
  const d = await api.get(`/api/attendance/employee/${id}?day=${encodeURIComponent(day)}`);
  await modal({ title: `${d.user.name} · ${date(day)}`, wide: true, submit: null, cancel: 'Close', body: html`<p>${statusBadge(d.status)} · ${d.hours.toFixed(2)} recorded hours</p><p class="muted small">Device capture and server receipt are original evidence. Approved corrections change the effective time; rejected events do not set attendance state.</p>${d.events.length ? d.events.map((e) => html`<section class="card" style="margin:10px 0"><div class="row between"><b>${e.kind === 'in' ? 'Check-in' : 'Check-out'} · ${dt(e.effective_time)}</b>${badge(e.review_status || e.validation)}</div><dl class="kv small"><dt>Device capture</dt><dd>${dt(e.device_time)}</dd><dt>Server receipt</dt><dd>${dt(e.server_time)}</dd><dt>Effective time</dt><dd>${dt(e.effective_time)}</dd><dt>Place</dt><dd>${e.place_name || 'No verified place'}</dd><dt>Flags</dt><dd>${e.reasons.map(label).join(', ') || 'None'}</dd><dt>Staff note</dt><dd>${e.note || '—'}</dd><dt>Review note</dt><dd>${e.review_note || '—'}</dd></dl>${e.approval_id ? html`<a class="btn small" href="#/approvals?kind=attendance_exception">Review in Approvals</a>` : ''}</section>`) : empty('No punch events on this date')}` });
}
export default {
  title: 'Employee attendance', topics: ['attendance', 'team'],
  async render(ctx) {
    const view = ctx.query.view === 'monthly' ? 'monthly' : 'daily';
    const params = paramsFor({ ...ctx.query, includeOwners: ctx.query.includeOwners === '1', includeInactive: ctx.query.includeInactive === '1', unassigned: ctx.query.unassigned === '1' }, view);
    const data = await api.get(`/api/attendance/${view === 'monthly' ? 'monthly' : 'dashboard'}?${params}`); report = data;
    const scope = data.filters.includeOwners ? 'Owners included.' : 'Owners excluded; select Include owners to show them.';
    return html`<div class="page-head"><div><h1>Employee attendance</h1><div class="sub">Office, IT, design, architecture and field teams in one report.</div></div><div class="row"><a class="btn" href="#/team?tab=people">Manage employees</a><button class="btn" id="attendance-refresh">Refresh</button><a class="btn primary" href="/api/attendance/export.csv?${paramsFor(data, view)}">Export CSV</a></div></div>
      <nav class="tabs"><a class="${view === 'daily' ? 'on' : ''}" href="#/attendance?${paramsFor(data, 'daily')}">Daily dashboard</a><a class="${view === 'monthly' ? 'on' : ''}" href="#/attendance?${paramsFor(data, 'monthly')}">Monthly report</a></nav>
      ${filterForm(data, view)}${summaryCards(data, view)}<p class="muted small" style="margin-bottom:10px">${data.filters.includeInactive ? 'Active and inactive accounts.' : 'All active employee access roles.'} ${scope} Summary cards follow employee filters; status/state filters narrow the table. Showing ${data.rows.length} of ${data.summary.employees} employees.</p>
      ${view === 'monthly' ? monthlyTable(data) : dailyTable(data)}
      <p class="muted small" style="margin-top:12px">India time (Asia/Kolkata). Locations are recorded at check-in/out, not tracked continuously. Today’s missing check-ins stay “Not checked in”; past scheduled days without evidence show “Absent”. Future dates and days before account creation are not counted as absences. ${view === 'monthly' ? `This report covers ${date(data.first)} through ${date(data.last)}. ` : ''}Profile filters and shift/week-off rules use current employee settings. Hours with pending evidence require review before payroll use.</p>`;
  },
  mount(root, ctx) {
    on(root, 'submit', '#attendance-filters', (event, form) => {
      event.preventDefault(); const data = formData(form);
      data.unassigned = data.departmentChoice === 'none'; data.department = data.departmentChoice?.startsWith('dept:') ? data.departmentChoice.slice(5) : '';
      location.hash = `#/attendance?${paramsFor(data, data.view)}`;
    });
    on(root, 'click', '#attendance-refresh', () => ctx.app.refresh());
    on(root, 'click', '[data-att-evidence]', async (event, button) => { try { await evidenceDialog(button.dataset.attEvidence, button.dataset.day); } catch (e) { toast(e.message, 'err'); } });
    on(root, 'click', '[data-att-days]', async (event, button) => {
      const row = report?.rows.find((r) => r.user.id === Number(button.dataset.attDays)); if (!row?.days) return;
      await modal({ title: `${row.user.name} · ${report.month}`, wide: true, submit: null, cancel: 'Close', body: html`<div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Status</th><th>First in</th><th>Last out</th><th>Hours</th></tr></thead><tbody>${row.days.map((d) => html`<tr><td>${date(d.day)}</td><td>${statusBadge(d.status)}</td><td>${time(d.first_in)}</td><td>${time(d.last_out)}</td><td>${d.hours.toFixed(2)}</td></tr>`)}</tbody></table></div>` });
    });
  },
};
