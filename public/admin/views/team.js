import { html, raw, api, on, toast, modal, dt, date, time, ago, inr, badge, empty, label, phone, options, todayIst } from '/shared/ui.js';

const TABS = [['board', 'Today'], ['people', 'People'], ['register', 'Attendance register'], ['requests', 'Leave & expenses'], ['payroll', 'Payroll']];
const ROLES = ['manager', 'architect', 'engineer', 'supervisor', 'staff', 'finance', 'owner'];
const CODE = { present: ['P', 'good'], late: ['L', 'warn'], half_day: ['½', 'warn'], absent: ['A', 'bad'], leave: ['LV', 'info'], needs_review: ['?', 'bad'], weekly_off: ['–', 'muted'], holiday: ['H', 'muted'], not_checked_in: ['·', 'muted'] };
let settingsCache = null;

async function board() {
  const rows = await api.get('/api/team/board');
  return html`<div class="grid g3">${rows.map((r) => html`<a class="card" style="text-decoration:none" href="#/team/person/${r.user.id}">
    <div class="row between"><div><b>${r.user.name}</b><div class="muted small">${label(r.user.role)}${r.user.title ? ` · ${r.user.title}` : ''}</div></div>${badge(r.status)}</div>
    <dl class="kv small" style="margin-top:10px;grid-template-columns:90px 1fr"><dt>Check-in</dt><dd>${r.firstIn ? `${time(r.firstIn)}` : '—'}${r.lastEvent ? html` · now ${r.checkedIn ? 'in' : 'out'}${r.lastEvent.place ? ` at ${r.lastEvent.place}` : ''}` : ''}${r.lastEvent?.validation === 'needs_review' ? ' ⚠' : ''}</dd>
    <dt>Tasks</dt><dd>${r.tasks.done}/${r.tasks.total} done${r.tasks.overdue ? html` · <b>${r.tasks.overdue} overdue</b>` : ''}</dd>
    <dt>Visits</dt><dd>${r.visits.length ? r.visits.map((v) => `${time(v.start_at)} ${label(v.status)}`).join(', ') : '—'}</dd><dt>Site logs</dt><dd>${r.logs}</dd><dt>Last active</dt><dd>${r.lastActivity ? ago(r.lastActivity) : '—'}</dd></dl></a>`)}</div>`;
}

async function people() {
  const rows = await api.get('/api/team');
  return html`<div class="row between" style="margin-bottom:10px"><span class="muted">All employees can record attendance in the team app with phone + PIN. Use the staff access role for IT, design or office employees who do not need manager permissions; department and job title describe their work.</span><button class="btn primary" data-act="add">＋ Add person</button></div>
    <div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Department / work mode</th><th>Access role</th><th>WhatsApp</th><th>Zones</th><th>Shift</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((u) => html`<tr><td><a class="link" href="#/team/person/${u.id}"><b>${u.name}</b></a><div class="muted small">${u.title || ''}${u.email ? ` · ${u.email}` : ''}</div></td><td>${u.department || 'Unassigned'}<div class="muted small">${label(u.work_mode || 'office')}</div></td><td>${label(u.role)}</td><td class="nowrap">${phone(u.phone)}</td><td class="small">${u.zones.length ? u.zones.map(label).join(', ') : (['architect', 'engineer'].includes(u.role) ? 'all zones' : '—')}</td><td class="nowrap small">${u.shift_start}–${u.shift_end}</td><td>${u.active ? badge('active') : html`<span class="badge muted">inactive</span>`}</td>
      <td class="nowrap"><button class="btn small" data-edit="${u.id}">Edit</button>${u.role !== 'owner' ? html`<button class="btn small ghost" data-pin="${u.id}">Reset PIN</button>` : ''}</td></tr>`)}</tbody></table></div></div>`;
}

async function register(month) {
  const d = await api.get(`/api/attendance/register?month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  const days = Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const cell = (uid, dayStr) => { const r = d.days.find((x) => x.user_id === uid && x.day === dayStr); if (!r) return html`<div class="cell muted">${dayStr > todayIst() ? '' : '·'}</div>`; const [c, tone] = CODE[r.status] || ['?', 'muted']; return html`<div class="cell ${tone}" data-tip="${dayStr}: ${label(r.status)}${r.first_in ? ` · in ${time(r.first_in)}` : ''}${r.last_out ? ` · out ${time(r.last_out)}` : ''} · ${Math.round(r.minutes / 6) / 10} h">${c}</div>`; };
  const prev = new Date(y, m - 2, 1); const next = new Date(y, m, 1);
  const fmt = (dd) => `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
  return html`<div class="row between" style="margin-bottom:10px"><div class="row"><a class="btn small" href="#/team?tab=register&month=${fmt(prev)}">‹</a><b>${new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</b><a class="btn small" href="#/team?tab=register&month=${fmt(next)}">›</a></div>
    <div class="row small muted">${Object.entries(CODE).map(([k, [c, tone]]) => html`<span class="row" style="gap:4px"><span class="reg"><span class="cell ${tone}" style="display:inline-grid;width:22px;height:20px">${c}</span></span>${label(k)}</span>`)}</div></div>
    <div class="card table-wrap"><table class="reg"><thead><tr><th></th>${days.map((dd) => html`<th>${Number(dd.slice(8))}</th>`)}</tr></thead><tbody>${d.users.map((u) => html`<tr><td class="name"><a class="link" href="#/team/person/${u.id}">${u.name}</a></td>${days.map((dd) => html`<td>${cell(u.id, dd)}</td>`)}</tr>`)}</tbody></table></div>
    <p class="muted small" style="margin-top:8px">Original check-in events are never edited. Exceptions are reviewed in Approvals; approved corrections are stored next to the original.</p>`;
}

async function requests() {
  const [leave, exp] = await Promise.all([api.get('/api/leave'), api.get('/api/expenses')]);
  return html`<div class="grid g2"><section class="card flush"><header><h2>Leave requests</h2></header><div class="table-wrap"><table class="t"><thead><tr><th>Person</th><th>Dates</th><th>Type</th><th>Status</th></tr></thead><tbody>${leave.map((l) => html`<tr><td>${l.name}<div class="muted small">${l.reason || ''}</div></td><td class="nowrap">${date(l.from_date)} → ${date(l.to_date)}</td><td>${l.type}</td><td>${badge(l.status)}</td></tr>`)}</tbody></table></div></section>
    <section class="card flush"><header><h2>Expense claims</h2></header><div class="table-wrap"><table class="t"><thead><tr><th>Person</th><th>Claim</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead><tbody>${exp.map((x) => html`<tr><td>${x.name}</td><td>${label(x.category)}<div class="muted small">${x.description || ''}${x.project_ref ? ` · ${x.project_ref}` : ''}</div>${x.receipt_media_id ? html`<a class="link small" target="_blank" rel="noopener" href="/media/${x.receipt_media_id}">receipt</a>` : ''}</td><td class="r num">${inr(x.amount)}</td><td>${badge(x.status)}</td><td>${x.status === 'approved' ? html`<button class="btn small" data-paid="${x.id}">Mark paid</button>` : ''}</td></tr>`)}</tbody></table></div></section></div>`;
}

async function payroll(month) {
  const d = await api.get(`/api/payroll?month=${month}`);
  return html`<div class="row between" style="margin-bottom:10px"><label class="row"><b>Month</b><input type="month" id="pm" value="${d.month}" style="max-width:180px"></label><a class="btn primary" href="/api/payroll/export.csv?month=${d.month}">Download CSV</a></div>
    <div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Role</th><th class="r">Present</th><th class="r">Late</th><th class="r">Half day</th><th class="r">Absent</th><th class="r">Leave</th><th class="r">To review</th><th class="r">Hours</th><th class="r">Expenses</th></tr></thead><tbody>
    ${d.rows.map((r) => html`<tr><td>${r.name}</td><td>${label(r.role)}</td><td class="r num">${r.present}</td><td class="r num">${r.late}</td><td class="r num">${r.half_day}</td><td class="r num">${r.absent}</td><td class="r num">${r.leave}</td><td class="r num">${r.needs_review ? html`<b>${r.needs_review}</b>` : 0}</td><td class="r num">${r.hours}</td><td class="r num">${inr(r.expenses)}</td></tr>`)}</tbody></table></div></div>
    <p class="muted small" style="margin-top:8px">On the 1st of each month a payroll approval is created automatically. Resolve "to review" days before exporting.</p>`;
}

async function person(id) {
  const d = await api.get(`/api/team/${id}`);
  const u = d.user;
  return html`<div class="page-head"><div><div class="muted small"><a class="link" href="#/team?tab=people">Team</a> / ${u.name}</div><h1>${u.name}</h1><div class="sub">${u.department || 'Department unassigned'} · ${label(u.work_mode || 'office')} · access: ${label(u.role)}${u.title ? ` · ${u.title}` : ''} · ${phone(u.phone)} · shift ${u.shift_start}–${u.shift_end}</div></div><div class="row"><button class="btn" data-edit="${u.id}">Edit</button></div></div>
    <div class="grid g2">
      <section class="card"><header><h2>This month</h2></header><div class="row" style="flex-wrap:wrap;gap:4px">${d.days.map((r) => { const [c, tone] = CODE[r.status] || ['?', 'muted']; return html`<span class="reg"><span class="cell ${tone}" style="display:inline-grid" data-tip="${r.day}: ${label(r.status)}">${c}</span></span>`; })}</div>
        <h3 style="margin:14px 0 6px">Recent check-ins</h3><table class="t dense small"><tbody>${d.events.slice(0, 12).map((e) => html`<tr><td class="nowrap">${dt(e.effective_time)}</td><td>${e.kind === 'in' ? 'In' : 'Out'}${e.auto ? ' (auto)' : ''}</td><td>${e.place_name || '—'}${e.distance_m !== null && e.distance_m !== undefined ? ` · ${Math.round(e.distance_m)} m` : ''}</td><td>${badge(e.review_status || e.validation, { accepted: 'good', needs_review: 'bad' })}</td></tr>`)}</tbody></table></section>
      <section class="card"><header><h2>Open tasks</h2></header>${d.tasks.length ? html`<div class="list">${d.tasks.map((t) => html`<div class="item"><div class="grow"><div class="title">${t.title}</div><div class="muted small">${t.due_at ? `due ${dt(t.due_at)}` : ''}</div></div>${badge(t.status)}</div>`)}</div>` : empty('No tasks')}</section>
      <section class="card"><header><h2>Visits</h2></header>${d.visits.length ? html`<div class="list">${d.visits.slice(0, 10).map((v) => html`<div class="item"><div class="grow"><div class="title">${v.ref} · ${v.client || v.lead_ref}</div><div class="muted small">${dt(v.start_at)}</div></div>${badge(v.status)}</div>`)}</div>` : empty('No visits')}</section>
      <section class="card"><header><h2>Activity</h2></header><div class="timeline">${d.activity.slice(0, 20).map((a) => html`<div class="ev">${label(a.action.replace(/\./g, ' '))} <span class="muted small">${dt(a.at)}</span></div>`)}</div></section>
    </div>`;
}

async function personForm(u = {}) {
  if (!settingsCache) settingsCache = await api.get('/api/settings');
  const zones = settingsCache.zones.filter((z) => !['outside'].includes(z.code));
  const services = settingsCache.catalog.services;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Only the owner creates manager/finance accounts or changes their login details (server enforces this too).
  const isOwner = window.nsApp?.user?.role === 'owner';
  const PRIV = ['owner', 'manager', 'finance'];
  const locked = !isOwner && PRIV.includes(u.role);
  const roleChoices = isOwner ? ROLES : ROLES.filter((r) => !PRIV.includes(r) || r === u.role);
  const lock = locked ? 'disabled' : '';
  return html`<div class="form-grid">
    ${locked ? html`<div class="notice warn full small">Only the owner can change the role, phone, email, password or status of manager and finance accounts.</div>` : ''}
    <label class="field"><span>Name</span><input name="name" required maxlength="120" value="${u.name || ''}"></label><label class="field"><span>Access role</span><select name="role" ${lock}>${options(roleChoices, u.role || 'staff')}</select></label>
    <p class="muted small full">Access role controls permissions. For example, an IT employee can use role staff, department IT, and job title IT Executive. Architects/engineers who receive visit assignments need the corresponding access role.</p>
    <label class="field"><span>Department</span><input name="department" maxlength="80" value="${u.department || ''}" placeholder="e.g. IT, Design, Architecture, Office, Accounts"></label><label class="field"><span>Work mode</span><select name="work_mode">${options([{ value: 'office', label: 'Office' }, { value: 'field', label: 'Field / sites' }, { value: 'hybrid', label: 'Office + field' }], u.work_mode || 'office')}</select></label>
    <label class="field"><span>WhatsApp number</span><input name="phone" ${lock} value="${u.phone ? u.phone.slice(2) : ''}" placeholder="98xxxxxxxx"></label><label class="field"><span>Email (dashboard users)</span><input name="email" type="email" ${lock} value="${u.email || ''}"></label>
    <label class="field"><span>Job title</span><input name="title" maxlength="120" value="${u.title || ''}"></label><label class="field"><span>Dashboard password <span class="hint">(managers & finance)</span></span><input name="password" type="password" minlength="8" ${lock} placeholder="${u.id ? 'leave blank to keep' : ''}"></label>
    <label class="field"><span>Shift start</span><input name="shift_start" type="time" value="${u.shift_start || '09:00'}"></label><label class="field"><span>Shift end</span><input name="shift_end" type="time" value="${u.shift_end || '18:00'}"></label>
    <label class="field"><span>Grace minutes</span><input name="grace_min" type="number" value="${u.grace_min ?? 15}"></label><label class="field"><span>Max visits per day</span><input name="daily_visit_cap" type="number" value="${u.daily_visit_cap ?? 3}"></label>
    <div class="field full"><span>Weekly off</span><div class="checks">${days.map((dd, i) => html`<label class="check"><input type="checkbox" name="weekly_off" data-multi="1" value="${i}" ${(u.weekly_off || [0]).includes(i) ? 'checked' : ''}> ${dd}</label>`)}</div></div>
    <div class="field full"><span>Zones (architects/engineers — leave empty for all)</span><div class="checks">${zones.map((z) => html`<label class="check"><input type="checkbox" name="zones" data-multi="1" value="${z.code}" ${(u.zones || []).includes(z.code) ? 'checked' : ''}> ${z.name}</label>`)}</div></div>
    <div class="field full"><span>Skills (services this person can visit for — empty means all)</span><div class="checks">${services.map((s) => html`<label class="check"><input type="checkbox" name="skills" data-multi="1" value="${s.code}" ${(u.skills || []).includes(s.code) ? 'checked' : ''}> ${s.en}</label>`)}</div></div>
    ${u.id ? html`<label class="check full"><input type="checkbox" name="active" ${lock} ${u.active ? 'checked' : ''}> Active (unticking logs them out and stops new visits)</label>` : ''}</div>`;
}
const clean = (f) => ({ ...f, weekly_off: (f.weekly_off || []).map(Number), grace_min: Number(f.grace_min), daily_visit_cap: Number(f.daily_visit_cap), password: f.password || undefined, email: f.email || null, phone: f.phone || null });

export default {
  title: 'Team & attendance',
  topics: ['team', 'attendance', 'tasks'],
  async render(ctx) {
    if (ctx.params[0] === 'person') return person(ctx.params[1]);
    const tab = ctx.query.tab || 'board';
    const month = ctx.query.month || todayIst().slice(0, 7);
    const body = tab === 'people' ? await people() : tab === 'register' ? await register(month) : tab === 'requests' ? await requests() : tab === 'payroll' ? await payroll(month) : await board();
    return html`<div class="page-head"><div><h1>Team & attendance</h1><div class="sub">Who is working where, attendance with GPS evidence, leave, expenses and payroll inputs.</div></div>
      <div class="row">${['owner', 'manager'].includes(ctx.user?.role) ? html`<a class="btn primary" href="#/attendance">Attendance dashboard</a>` : ''}<button class="btn" data-sweep="morning" title="Check employees whose shift reminder time has passed">Check missing attendance</button></div></div>
      <nav class="tabs">${TABS.map(([k, l]) => html`<a class="${k === tab ? 'on' : ''}" href="#/team?tab=${k}">${l}</a>`)}</nav>${body}`;
  },
  mount(root, ctx) {
    const refresh = () => ctx.app.refresh();
    on(root, 'click', '[data-act="add"]', async () => {
      try {
        const r = await modal({ title: 'Add person', wide: true, submit: 'Add', body: await personForm(), onSubmit: (f) => api.post('/api/team', clean(f)) });
        if (r?.pin) await modal({ title: 'Employee app PIN', cancel: null, submit: 'Done', body: html`<p>Share this PIN privately. They log in at <code>/app/</code> with their phone number and this PIN, and can change it in the app.</p><p style="font-size:28px;font-weight:700;letter-spacing:.2em">${r.pin}</p>`, onSubmit: () => true });
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
    on(root, 'click', '[data-edit]', async (e, el) => {
      try {
        const { user } = await api.get(`/api/team/${el.dataset.edit}`);
        await modal({ title: `Edit ${user.name}`, wide: true, body: await personForm(user), onSubmit: (f) => api.patch(`/api/team/${user.id}`, clean(f)) });
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
    on(root, 'click', '[data-pin]', async (e, el) => {
      try { const r = await api.post(`/api/team/${el.dataset.pin}/reset-pin`); await modal({ title: 'New PIN', cancel: null, submit: 'Done', body: html`<p style="font-size:28px;font-weight:700;letter-spacing:.2em">${r.pin}</p><p class="muted">The old PIN and app sessions stop working.</p>`, onSubmit: () => true }); } catch (err) { toast(err.message, 'err'); }
    });
    on(root, 'click', '[data-paid]', async (e, el) => { try { await api.post(`/api/expenses/${el.dataset.paid}/paid`); toast('Marked paid'); refresh(); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'click', '[data-sweep]', async (e, el) => { try { const r = await api.post(`/api/attendance/sweep/${el.dataset.sweep}`); toast(r.reminded ? `Reminded: ${r.names.join(', ')}` : r.awaitingReview ? `${r.awaitingReview} unverified check-in(s) flagged for review` : r.missing ? `${r.missing} still missing; today's reminders already sent` : 'No new attendance reminders due; check the dashboard for pending reviews'); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'change', '#pm', (e, el) => { location.hash = `#/team?tab=payroll&month=${el.value}`; });
  },
};
