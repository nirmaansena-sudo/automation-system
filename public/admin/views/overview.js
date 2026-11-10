import { html, api, stat, inr, compact, ago, time, columnChart, barList, badge, empty, label, phone } from '/shared/ui.js';

const FUNNEL = ['capturing', 'awaiting_approval', 'scheduling', 'visit_confirmed', 'visit_done', 'quoting', 'quote_sent', 'won', 'lost', 'stale', 'needs_followup', 'out_of_area'];

export default {
  title: 'Overview',
  topics: ['leads', 'approvals', 'visits', 'inbox', 'projects', 'attendance', 'tasks'],
  async render({ user, app }) {
    const d = await api.get('/api/dashboard/overview');
    const k = d.kpis;
    const hour = Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(new Date()));
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const series = d.leadsByDay.map((x) => ({ label: x.day.slice(8), title: x.day, value: x.n }));
    const funnel = FUNNEL.map((s) => ({ label: label(s), value: (d.funnel.find((f) => f.status === s) || {}).n || 0 })).filter((x) => x.value > 0);
    const service = (d.usage.find((u) => u.cat === 'service') || {}).n || 0;
    const templates = d.usage.filter((u) => u.cat !== 'service').reduce((a, u) => a + u.n, 0);
    const h = d.health;
    return html`
      <div class="page-head"><div><h1>${greet}, ${user.name.split(' ')[0]}</h1><div class="sub">Here is what needs attention today.</div></div>
        <div class="row">${user.role!=='finance'&&app.provider==='simulator'?html`<a class="btn" href="#/simulator">📱 Test on simulator</a>`:''}<a class="btn primary" href="#/approvals">Review approvals (${k.pendingApprovals})</a></div></div>
      ${['owner','manager'].includes(user.role)?html`<div class="row" style="margin-bottom:14px"><a class="btn" href="#/attendance">Employee attendance</a><a class="btn" href="#/reports">Reports & exports</a><a class="btn" href="#/automation">WhatsApp automation</a></div>`:''}
      <div class="grid g-auto" style="margin-bottom:14px">
        ${stat('New leads today', k.leadsToday, `${k.openLeads} open in pipeline`)}
        ${stat('Avg first response', k.avgFirstResponseMin === null ? '—' : `${k.avgFirstResponseMin} min`, 'last 30 days · website promise < 15 min', k.avgFirstResponseMin > 15 ? 'alert' : '')}
        ${stat('Approvals waiting', k.pendingApprovals, 'one decision per lead', k.pendingApprovals > 5 ? 'alert' : '')}
        ${stat('Site visits today', k.visitsToday)}
        ${stat('Active projects', k.activeProjects)}
        ${stat('Team checked in', `${k.presentToday}/${k.teamSize}`, 'field and office staff')}
        ${stat('Chats needing a person', k.needsHuman, '', k.needsHuman ? 'alert' : '')}
        ${stat('Overdue tasks', k.overdueTasks, '', k.overdueTasks ? 'alert' : '')}
        ${stat('Payments due', inr(k.paymentsDue), 'all open invoices')}
        ${stat('Collected this month', `₹${compact(k.collectedMonth)}`)}
      </div>
      <div class="grid g2">
        <section class="card"><header><h2>Needs your decision</h2><a class="link" href="#/approvals">All approvals</a></header>
          ${d.approvals.length ? html`<div class="list">${d.approvals.map((a) => html`<div class="item"><span class="badge ${a.escalated ? 'bad' : 'warn'}">${a.label}</span><div class="grow"><div class="title">${a.title}</div><div class="muted small">${a.summary || ''}</div></div><span class="muted small nowrap">${ago(a.created_at)}</span></div>`)}</div>` : empty('Nothing waiting', 'New enquiries, reports, quotations and leave requests will appear here.')}
        </section>
        <section class="card"><header><h2>Site visits today</h2><a class="link" href="#/visits">Calendar</a></header>
          ${d.visitsToday.length ? html`<div class="list">${d.visitsToday.map((v) => html`<div class="item"><div class="num nowrap" style="width:70px;font-weight:600">${time(v.start_at)}</div><div class="grow"><div class="title">${v.client || v.lead_ref}</div><div class="muted small">${v.architect} · ${label(v.zone)} · ${v.ref}</div></div>${badge(v.status)}</div>`)}</div>` : empty('No visits today')}
        </section>
        <section class="card"><header><h2>New leads per day</h2><span class="muted small">last 14 days</span></header>
          ${series.some((s) => s.value) ? columnChart(series, { unit: ' leads' }) : empty('No leads yet', 'Try the WhatsApp simulator to create one.')}
        </section>
        <section class="card"><header><h2>Lead pipeline</h2><span class="muted small">last 90 days, by status</span></header>
          ${funnel.length ? barList(funnel) : empty('No leads yet')}
        </section>
        <section class="card"><header><h2>Chats needing a person</h2><a class="link" href="#/inbox?filter=attention">Inbox</a></header>
          ${d.attention.length ? html`<div class="list">${d.attention.map((c) => html`<a class="item" style="text-decoration:none" href="#/inbox/${c.contact_id}"><div class="avatar">${(c.name || c.profile_name || '?').slice(0, 1)}</div><div class="grow"><div class="title">${c.name || c.profile_name || phone(c.wa_id)}</div><div class="muted small">${c.attention_reason || ''}</div></div><span class="muted small">${ago(c.last_message_at)}</span></a>`)}</div>` : empty('All chats handled')}
        </section>
        <section class="card"><header><h2>System health</h2><a class="link" href="#/settings">Settings</a></header>
          ${h.ok ? html`<div class="notice good">✅ Everything is running.</div>` : html`<div class="notice warn"><b>Check these:</b><ul style="margin:6px 0 0 18px;padding:0">${h.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`}
          <dl class="kv" style="margin-top:12px">
            <dt>Last WhatsApp event</dt><dd>${h.lastWebhook ? ago(h.lastWebhook) : 'none yet'}</dd>
            <dt>Messages in queue</dt><dd>${h.outbox.queued}${h.outbox.operator ? html` · <a class="link" href="#/tasks">${h.outbox.operator} need manual sending</a>` : ''}</dd>
            <dt>n8n</dt><dd>${h.n8nLastSeen ? `seen ${ago(h.n8nLastSeen)}` : 'not connected (backend runs all routines)'}</dd>
            <dt>Last backup</dt><dd>${h.lastBackup ? `${ago(h.lastBackup.at)} · ${h.lastBackup.file}` : 'not yet'}</dd>
          </dl>
          <div style="margin-top:14px"><div class="row between small"><span class="ink2">Recorded WhatsApp sends (${d.month})</span><span class="num">${service + templates}</span></div>
            <div class="muted small" style="margin-top:4px">${service} free-form replies · ${templates} template messages. Cost estimates use your configured rates.</div>
            <a class="link small" href="#/costs?month=${encodeURIComponent(d.month)}">View usage & cost estimates</a></div>
        </section>
      </div>`;
  },
};
