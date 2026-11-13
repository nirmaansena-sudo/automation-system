import { html, api, on, toast, dt, empty, label, confirmBox } from '/shared/ui.js';

const FRIENDLY = { leads: 'Leads', contacts: 'Clients & contacts', projects: 'Projects', milestones: 'Project stages', site_logs: 'Site logs', invoices: 'Invoices', payments: 'Payments', quotations: 'Quotations', visits: 'Site visits', visit_offers: 'Visit offers', users: 'Staff', attendance_events: 'Attendance events', attendance_days: 'Attendance register', leave_requests: 'Leave', expense_claims: 'Expenses', tasks: 'Tasks', tickets: 'Tickets', messages: 'WhatsApp messages', outbox: 'Outgoing queue', inbound_events: 'Incoming webhook events', approvals: 'Approvals', audit_log: 'Audit history', media: 'Photos & files', change_requests: 'Change requests', timers: 'Timers (deadlines)', notifications: 'Notifications', zones: 'Zones', faqs: 'FAQ answers', wa_templates: 'WhatsApp templates', calendar_holds: 'Calendar holds', routine_runs: 'Routine runs', settings: 'Settings', conversations: 'Conversations', holidays: 'Holidays', counters: 'Reference counters', system_state: 'System state' };

async function tables() {
  const rows = await api.get('/api/data/tables');
  return html`<div class="grid g-auto">${rows.map((t) => html`<a class="card" style="text-decoration:none" href="#/data/${t.name}"><div class="muted small">${t.name}</div><div style="font-weight:600;margin-top:2px">${FRIENDLY[t.name] || label(t.name)}</div><div class="stat-value" style="font-size:20px">${t.rows.toLocaleString('en-IN')}</div></a>`)}</div>`;
}

async function table(name, query) {
  const page = Number(query.page || 0);
  const d = await api.get(`/api/data/tables/${name}?page=${page}&q=${encodeURIComponent(query.q || '')}`);
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  const cell = (v) => { if (v === null || v === undefined) return html`<span class="muted">—</span>`; const s = String(v); return s.length > 80 ? html`<span data-tip="${s.slice(0, 600)}">${s.slice(0, 80)}…</span>` : s; };
  return html`<div class="row between" style="margin-bottom:10px"><div class="row"><a class="btn small" href="#/data">‹ All tables</a><b>${FRIENDLY[name] || name}</b><span class="muted">${d.total.toLocaleString('en-IN')} rows</span></div>
    <div class="row"><input class="search" type="search" aria-label="Search" id="tq" placeholder="Search" value="${query.q || ''}"><a class="btn" href="/api/data/tables/${name}/export.csv">Export CSV</a></div></div>
    <div class="card flush"><div class="table-wrap" style="max-height:70vh">${d.rows.length ? html`<table class="t dense small"><thead><tr>${d.columns.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${d.rows.map((r) => html`<tr>${d.columns.map((c) => html`<td class="nowrap">${cell(r[c])}</td>`)}</tr>`)}</tbody></table>` : empty('No rows')}</div></div>
    <div class="row" style="margin-top:10px">${page > 0 ? html`<a class="btn small" href="#/data/${name}?page=${page - 1}&q=${query.q || ''}">‹ Previous</a>` : ''}<span class="muted">Page ${page + 1} of ${pages}</span>${page + 1 < pages ? html`<a class="btn small" href="#/data/${name}?page=${page + 1}&q=${query.q || ''}">Next ›</a>` : ''}</div>
    <p class="muted small" style="margin-top:8px">Read-only view. Records change through the dashboard and WhatsApp flows so every change is validated and written to the audit history.</p>`;
}

async function audit(query) {
  const rows = await api.get(`/api/data/audit?q=${encodeURIComponent(query.q || '')}`);
  return html`<div class="row" style="margin-bottom:10px"><input class="search" type="search" aria-label="Search action, person, entity" id="aq" placeholder="Search action, person, entity" value="${query.q || ''}"></div>
    <div class="card flush"><div class="table-wrap"><table class="t dense small"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>${rows.map((a) => html`<tr><td class="nowrap">${dt(a.at)}</td><td>${a.actor}</td><td>${a.action}</td><td>${a.entity_type || ''} ${a.entity_id || ''}</td><td class="muted">${a.data ? JSON.stringify(a.data).slice(0, 160) : ''}</td></tr>`)}</tbody></table></div></div>`;
}

async function backups(user) {
  if (user.role !== 'owner') return empty('Only the owner can manage backups');
  const rows = await api.get('/api/data/backups');
  return html`<div class="notice small" style="margin-bottom:12px">Encrypted full backups include the database, photos and configuration. Keep the decryption key or configured backup password separately: losing both prevents recovery. <a class="link" href="/api/data/backup-key">Download backup key</a>. Use <code>BACKUP_OFFSITE_DIR</code> for an automatic second copy; choose a separate disk or synced folder. Restore into a new directory using the instructions in <code>docs/RECOVERY.md</code>.</div><div class="row between" style="margin-bottom:10px"><span class="muted">Nightly at 2 AM · last 14 archives retained locally. Large backups temporarily pause processing.</span><button class="btn primary" id="bk">Back up now</button></div>
    <div class="card flush"><table class="t"><thead><tr><th>File</th><th class="r">Size</th><th></th></tr></thead><tbody>${rows.map((b) => html`<tr><td><code>${b.file}</code></td><td class="r num">${(b.size / 1024 / 1024).toFixed(2)} MB</td><td><a class="btn small" href="/api/data/backups/${b.file}">Download</a></td></tr>`)}</tbody></table></div>`;
}

export default {
  title: 'Database',
  async render(ctx) {
    if (ctx.params[0]) return table(ctx.params[0], ctx.query);
    const tab = ctx.query.tab || 'tables';
    const body = tab === 'audit' ? await audit(ctx.query) : tab === 'backups' ? await backups(ctx.user) : await tables();
    return html`<div class="page-head"><div><h1>Database</h1><div class="sub">Browse every table, export to Excel (CSV), see who changed what, and manage backups.</div></div></div>
      <nav class="tabs"><a class="${tab === 'tables' ? 'on' : ''}" href="#/data">Tables</a><a class="${tab === 'audit' ? 'on' : ''}" href="#/data?tab=audit">Audit history</a><a class="${tab === 'backups' ? 'on' : ''}" href="#/data?tab=backups">Backups</a></nav>${body}`;
  },
  mount(root, ctx) {
    let t;
    on(root, 'input', '#tq', (e, el) => { clearTimeout(t); t = setTimeout(() => { location.hash = `#/data/${ctx.params[0]}?q=${encodeURIComponent(el.value)}`; }, 450); });
    on(root, 'input', '#aq', (e, el) => { clearTimeout(t); t = setTimeout(() => { location.hash = `#/data?tab=audit&q=${encodeURIComponent(el.value)}`; }, 450); });
    on(root, 'click', '#bk', async () => { try { const r = await api.post('/api/data/backup'); toast(r.ok ? `Saved ${r.result.file}` : r.error || 'Backup failed', r.ok ? 'ok' : 'err'); ctx.app.refresh(); } catch (err) { toast(err.message, 'err'); } });
  },
};
