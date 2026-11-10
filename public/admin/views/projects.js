import { html, raw, api, on, toast, modal, dt, date, ago, inr, compact, badge, empty, label, phone, options, todayIst } from '/shared/ui.js';

async function list(query) {
  const rows = await api.get(`/api/projects${query.status ? `?status=${query.status}` : ''}`);
  return html`<div class="page-head"><div><h1>Projects</h1><div class="sub">One Project ID per job: team, stages, daily site logs, money and changes.</div></div></div>
    <div class="chips" style="margin-bottom:12px">${[['', 'All'], ['awaiting_advance', 'Awaiting advance'], ['active', 'Active'], ['on_hold', 'On hold'], ['handover', 'Handover'], ['warranty', 'Warranty'], ['closed', 'Closed']].map(([k, l]) => html`<a class="chip ${(query.status || '') === k ? 'on' : ''}" href="#/projects${k ? `?status=${k}` : ''}">${l}</a>`)}</div>
    ${rows.length ? html`<div class="grid g3">${rows.map((p) => html`<a class="card" style="text-decoration:none" href="#/projects/${p.id}">
      <div class="row between"><b>${p.ref}</b>${badge(p.status)}</div><div style="margin:6px 0 2px;font-weight:600">${p.client_name || p.name}</div><div class="muted small">${p.address || label(p.zone)}</div>
      <div style="margin-top:12px" class="small"><div class="row between"><span class="ink2">${p.current_stage || (p.status === 'awaiting_advance' ? 'Waiting for booking payment' : '—')}</span><span class="num">${p.current_progress ?? ''}${p.current_progress !== null && p.current_progress !== undefined ? '%' : ''}</span></div>
      <div class="progress" style="margin-top:5px"><i style="width:${p.current_progress || 0}%"></i></div></div>
      <div class="row between small muted" style="margin-top:10px"><span>👷 ${p.supervisor || 'no supervisor'}</span><span>paid ₹${compact(p.paid)} / ₹${compact(p.contract_value)}</span></div>
      <div class="small ${p.status === 'active' && p.last_log !== todayIst() ? 'ink2' : 'muted'}" style="margin-top:4px">${p.last_log ? `Last site log: ${date(p.last_log)}` : 'No site log yet'}${p.status === 'active' && p.last_log !== todayIst() ? ' · ⚠ none today' : ''}</div></a>`)}</div>` : empty('No projects yet', 'A project is created automatically when a client accepts a quotation.')}`;
}

const TABS = [['overview', 'Profile & team'], ['stages', 'Stages'], ['logs', 'Site logs'], ['money', 'Money'], ['changes', 'Changes'], ['tickets', 'Tickets'], ['history', 'History']];

async function detail(id, tab) {
  const d = await api.get(`/api/projects/${id}`);
  const p = d.project;
  const team = (uid) => d.team.find((u) => u.id === uid)?.name || '—';
  const paid = d.payments.reduce((a, x) => a + x.amount, 0);
  const due = d.invoices.filter((i) => ['issued', 'partially_paid'].includes(i.status)).reduce((a, i) => a + i.amount - i.paid_amount, 0);
  let body = '';
  if (tab === 'overview') body = html`<div class="grid g2"><section class="card"><header><h2>Profile</h2><button class="btn small" data-act="edit">Edit profile & team</button></header>
      <dl class="kv"><dt>Client</dt><dd>${p.client_name} · ${phone(p.client_phone)}</dd><dt>Address</dt><dd>${p.address || '—'}${p.site_lat ? html` · <a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${p.site_lat},${p.site_lng}">map</a>` : ''}</dd>
      <dt>Work</dt><dd>${label(p.service_type)} · ${label(p.commercial_model)}${p.area_sqft ? ` · ${p.area_sqft} sq ft` : ''}</dd><dt>Contract</dt><dd>${inr(p.contract_value)} · baseline v${p.baseline_version}</dd>
      <dt>Dates</dt><dd>${p.start_date ? date(p.start_date) : 'not started'} → ${p.target_end ? date(p.target_end) : '—'}</dd><dt>Site geofence</dt><dd>${p.geofence_m} m (attendance check)</dd>
      <dt>Daily client update</dt><dd>${p.digest_enabled ? 'on (7 PM)' : 'off'}</dd><dt>Portfolio use</dt><dd>${p.portfolio_consent ? 'client agreed (locality only)' : 'not allowed'}</dd><dt>Authorised numbers</dt><dd>${p.authorized_phones.map(phone).join(', ')}</dd>
      ${p.warranty_until ? html`<dt>Warranty</dt><dd>till ${date(p.warranty_until)}</dd>` : ''}</dl></section>
    <section class="card"><header><h2>Team</h2></header><dl class="kv"><dt>Manager</dt><dd>${team(p.manager_id)}</dd><dt>Architect</dt><dd>${team(p.architect_id)}</dd><dt>Site engineer</dt><dd>${team(p.engineer_id)}</dd><dt>Supervisor</dt><dd>${team(p.supervisor_id)}</dd></dl>
      <div class="divider"></div><div class="row"><a class="btn small" target="_blank" rel="noopener" href="${p.link}">Open client's project page</a><button class="btn small" data-act="update">Send update to client</button></div>
      <p class="muted small" style="margin-top:8px">The client page is private (link only) and shows stages, daily logs with photos and payments.</p></section></div>`;
  if (tab === 'stages') body = html`<section class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>#</th><th>Stage</th><th>Status</th><th>Progress</th><th>Planned</th><th class="r">Amount</th><th></th></tr></thead><tbody>
      ${d.milestones.map((m) => html`<tr><td>${m.seq}</td><td><b>${m.name}</b>${m.review_note ? html`<div class="muted small">${m.review_note}</div>` : ''}${m.client_note ? html`<div class="small">Client: ${m.client_note}</div>` : ''}</td><td>${badge(m.status)}</td><td><div class="progress"><i style="width:${m.progress}%"></i></div><span class="muted small">${m.progress}%</span></td><td class="nowrap small">${m.planned_start ? date(m.planned_start) : '—'} → ${m.planned_end ? date(m.planned_end) : '—'}</td><td class="r num">${inr(m.amount)}</td>
        <td class="nowrap">${m.status === 'planned' ? html`<button class="btn small" data-ms="start" data-id="${m.id}">Start</button>` : ''}${['in_progress', 'rework'].includes(m.status) ? html`<button class="btn small" data-ms="ready" data-id="${m.id}">Ready for review</button>` : ''}${m.status === 'client_review' ? html`<button class="btn small" data-ms="override" data-id="${m.id}">Record client OK</button>` : ''}<button class="btn small ghost" data-ms="dates" data-id="${m.id}" data-s="${m.planned_start || ''}" data-e="${m.planned_end || ''}" data-n="${m.name}">Dates</button></td></tr>`)}
    </tbody></table></div></section><p class="muted small" style="margin-top:8px">Loop: work → “Ready for review” → quality check (Approvals) → client signs off on WhatsApp → invoice → next stage starts automatically. The last stage leads to snag list & handover.</p>`;
  if (tab === 'logs') body = html`<div class="row between" style="margin-bottom:10px"><span class="muted">Supervisors post logs from the app; the client gets one digest at 7 PM.</span><button class="btn" data-act="log">＋ Add log</button></div>
    ${d.logs.length ? d.logs.map((l) => html`<article class="card" style="margin-bottom:10px"><div class="row between"><b>${date(l.log_date)}</b><span class="muted small">${l.author || ''}${l.distance_m !== null && l.distance_m !== undefined ? ` · ${Math.round(l.distance_m)} m from site` : ''}${l.digest_sent_at ? ' · sent to client' : ''}${l.client_visible ? '' : ' · internal'}</span></div>
      <p style="margin-top:6px" class="pre">${l.work_done || ''}</p>${Object.keys(l.labour).length ? html`<div class="row small">${Object.entries(l.labour).map(([k, v]) => html`<span class="tag">${label(k)}: ${v}</span>`)}</div>` : ''}${l.issues ? html`<div class="notice warn small" style="margin-top:6px">⚠ ${l.issues}</div>` : ''}
      ${l.media.length ? html`<div class="thumbs" style="margin-top:8px">${l.media.map((m) => html`<a href="/media/${m.id}" target="_blank" rel="noopener"><img src="/media/${m.id}" alt="site photo" loading="lazy"></a>`)}</div>` : ''}</article>`) : empty('No site logs yet')}`;
  if (tab === 'money') body = html`<div class="grid g4" style="margin-bottom:14px"><div class="stat"><div class="stat-label">Contract value</div><div class="stat-value">${inr(p.contract_value)}</div></div><div class="stat"><div class="stat-label">Received</div><div class="stat-value">${inr(paid)}</div></div><div class="stat"><div class="stat-label">Due now</div><div class="stat-value">${inr(due)}</div></div><div class="stat"><div class="stat-label">Not yet invoiced</div><div class="stat-value">${inr(Math.max(0, p.contract_value - d.invoices.filter((i) => i.status !== 'cancelled').reduce((a, i) => a + i.amount, 0)))}</div></div></div>
    <section class="card flush"><header><h2>Invoices</h2><button class="btn small" data-act="invoice">＋ Extra invoice</button></header><div class="table-wrap"><table class="t"><thead><tr><th>Invoice</th><th>For</th><th>Due</th><th>Status</th><th class="r">Amount</th><th class="r">Paid</th><th></th></tr></thead><tbody>
      ${d.invoices.map((i) => html`<tr><td class="nowrap"><b>${i.ref}</b></td><td>${i.title}</td><td class="nowrap">${date(i.due_date)}${i.reminders ? html`<div class="muted small">${i.reminders} reminder(s)</div>` : ''}</td><td>${badge(i.status)}</td><td class="r num">${inr(i.amount)}</td><td class="r num">${inr(i.paid_amount)}</td><td class="nowrap">${['issued', 'partially_paid'].includes(i.status) ? html`<button class="btn small primary" data-pay="${i.id}" data-amt="${i.amount - i.paid_amount}">Record payment</button><button class="btn small ghost" data-link="${i.id}">Payment link</button>` : ''}</td></tr>`)}
    </tbody></table></div></section>
    <section class="card flush" style="margin-top:14px"><header><h2>Payments received</h2></header><div class="table-wrap"><table class="t"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="r">Amount</th></tr></thead><tbody>${d.payments.map((x) => html`<tr><td>${dt(x.received_at)}</td><td>${x.method}</td><td>${x.reference || ''}</td><td class="r num">${inr(x.amount)}</td></tr>`)}</tbody></table></div></section>`;
  if (tab === 'changes') body = html`<div class="row between" style="margin-bottom:10px"><span class="muted">Changes are drafts until approved. Approved changes create a new baseline version — nothing is silently overwritten.</span><button class="btn" data-act="change">＋ Change request</button></div>
    ${d.changes.length ? html`<div class="card flush"><table class="t"><thead><tr><th>Ref</th><th>Change</th><th class="r">Cost</th><th class="r">Days</th><th>Status</th></tr></thead><tbody>${d.changes.map((c) => html`<tr><td>${c.ref}</td><td><b>${c.title}</b><div class="muted small">${c.description || ''}</div></td><td class="r num">${inr(c.cost_impact)}</td><td class="r num">${c.days_impact}</td><td>${badge(c.status)}${c.new_baseline_version ? html`<div class="muted small">baseline v${c.new_baseline_version}</div>` : ''}</td></tr>`)}</tbody></table></div>` : empty('No change requests')}`;
  if (tab === 'tickets') body = d.tickets.length ? html`<div class="card flush"><table class="t"><thead><tr><th>Ref</th><th>Subject</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead><tbody>${d.tickets.map((t) => html`<tr><td>${t.ref}</td><td>${t.subject}<div class="muted small pre">${t.description || ''}</div></td><td>${badge(t.priority)}</td><td>${badge(t.status)}</td><td>${dt(t.due_at)}</td></tr>`)}</tbody></table></div>` : empty('No tickets');
  if (tab === 'history') body = html`<div class="card"><div class="timeline">${d.timeline.map((a) => html`<div class="ev"><b>${label(a.action.replace(/\./g, ' '))}</b> <span class="muted small">${a.actor} · ${dt(a.at)}</span></div>`)}</div></div>`;
  if (tab === 'money') {
    const finance = await api.get(`/api/finance/projects/${id}`);
    body = html`<section class="card" style="margin-bottom:14px"><header><h2>Finance controls</h2><a class="btn small" href="/api/finance/export.csv?project=${id}">Export finance CSV</a></header><div class="row"><span>Payment before handover: <b>${finance.require_payment_before_handover ? 'required' : 'optional'}</b></span><button class="btn small" data-policy="${finance.require_payment_before_handover ? '0' : '1'}">Change policy</button></div><p class="muted">Net received after refunds: ${inr(finance.netReceived)} · Client credit available for refund: ${inr(finance.refundable)}</p>${finance.refundable > 0 ? html`<button class="btn" data-refund="${finance.refundable}">Record refund</button>` : ''}<p class="muted small">Record refunds after making the payment through your bank. CSV exports are for reconciliation; map transaction types before importing into accounting software.</p></section>${body}
      <section class="card" style="margin-top:14px"><h2>Bank reconciliation</h2>${finance.payments.map((payment) => html`<div class="row between" style="padding:8px 0"><span>${date(payment.received_at)} · ${inr(payment.amount)} · ${payment.reference || 'No reference'}</span>${payment.reconciled_at ? html`<span class="tag">Matched: ${payment.statement_reference}</span>` : html`<button class="btn small" data-reconcile="${payment.id}">Match bank entry</button>`}</div>`)}</section>
      <section class="card" style="margin-top:14px"><h2>Scope credits and refunds</h2>${finance.credits.map((credit) => html`<p><b>${credit.ref}</b> · ${inr(credit.amount)} · ${credit.reason}</p>`)}${finance.refunds.map((refund) => html`<p>Refund ${inr(refund.amount)} · ${refund.reference} · ${date(refund.created_at)}</p>`)}${!finance.credits.length && !finance.refunds.length ? html`<p class="muted">No credits or refunds</p>` : ''}</section>`;
  }
  return html`<div class="page-head"><div><div class="muted small"><a class="link" href="#/projects">Projects</a> / ${p.ref}</div><h1>${p.ref} ${badge(p.status)}</h1><div class="sub">${p.name}</div></div>
    <div class="row"><a class="btn" href="#/inbox/${p.client_contact_id}">💬 Client chat</a>${p.status === 'active' ? html`<button class="btn ghost" data-status="on_hold">Put on hold</button>` : ''}${p.status === 'on_hold' ? html`<button class="btn" data-status="active">Resume</button>` : ''}${p.status === 'warranty' ? html`<button class="btn ghost" data-status="closed">Close project</button>` : ''}</div></div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a class="${k === tab ? 'on' : ''}" href="#/projects/${id}?tab=${k}">${l}</a>`)}</nav>${body}`;
}

export default {
  title: (ctx) => (ctx.params[0] ? 'Project' : 'Projects'),
  topics: ['projects'],
  render(ctx) { return ctx.params[0] ? detail(ctx.params[0], ctx.query.tab || 'overview') : list(ctx.query); },
  mount(root, ctx) {
    const id = ctx.params[0];
    const done = (msg) => { toast(msg || 'Saved'); ctx.app.refresh(); };
    const fail = (e) => toast(e.message, 'err');
    on(root, 'click', '[data-policy]', async (e, el) => {
      try { const result = await modal({ title: 'Handover payment policy', body: html`<p>${el.dataset.policy === '1' ? 'Require full contract payment before handover.' : 'Allow handover with outstanding payments.'}</p><label class="field"><span>Reason</span><input name="reason" required></label>`, onSubmit: (f) => api.patch(`/api/finance/projects/${id}/policy`, { require_payment_before_handover: el.dataset.policy === '1', reason: f.reason }) }); if (result) done('Policy saved'); } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-refund]', async (e, el) => {
      const key = crypto.randomUUID();
      try { const result = await modal({ title: 'Record a completed refund', body: html`<label class="field"><span>Amount ₹</span><input name="amount" type="number" min="0.01" step="0.01" max="${el.dataset.refund}" required></label><label class="field"><span>Method</span><select name="method">${options(['bank', 'upi', 'cash', 'cheque', 'card'])}</select></label><label class="field"><span>Transaction reference</span><input name="reference" required></label>`, onSubmit: (f) => api.post(`/api/finance/projects/${id}/refunds`, { ...f, amount: Number(f.amount), client_event_id: key }) }); if (result) done('Refund recorded'); } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-reconcile]', async (e, el) => {
      try { const result = await modal({ title: 'Match a bank statement entry', body: html`<label class="field"><span>Statement transaction reference</span><input name="statement_reference" required></label><label class="field"><span>Note</span><input name="note"></label>`, onSubmit: (f) => api.post(`/api/finance/payments/${el.dataset.reconcile}/reconcile`, f) }); if (result) done('Payment reconciled'); } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-act]', async (e, el) => {
      try {
        const act = el.dataset.act;
        if (act === 'edit') {
          const d = await api.get(`/api/projects/${id}`); const p = d.project;
          const people = (roles) => d.team.filter((u) => roles.includes(u.role)).map((u) => ({ value: u.id, label: `${u.name} (${u.role})` }));
          await modal({ title: 'Project profile & team', wide: true, body: html`<div class="form-grid">
            <label class="field full"><span>Project name</span><input name="name" value="${p.name || ''}"></label>
            <label class="field full"><span>Site address</span><input name="address" value="${p.address || ''}"></label>
            <label class="field"><span>Site latitude</span><input name="site_lat" type="number" step="any" value="${p.site_lat ?? ''}"></label><label class="field"><span>Site longitude</span><input name="site_lng" type="number" step="any" value="${p.site_lng ?? ''}"></label>
            <label class="field"><span>Geofence radius (m)</span><input name="geofence_m" type="number" value="${p.geofence_m}"></label><label class="field"><span>Area (sq ft)</span><input name="area_sqft" type="number" value="${p.area_sqft ?? ''}"></label>
            <label class="field"><span>Manager</span><select name="manager_id">${options(people(['owner', 'manager']), p.manager_id, { blank: '—' })}</select></label><label class="field"><span>Architect</span><select name="architect_id">${options(people(['architect', 'engineer']), p.architect_id, { blank: '—' })}</select></label>
            <label class="field"><span>Site engineer</span><select name="engineer_id">${options(people(['engineer', 'architect']), p.engineer_id, { blank: '—' })}</select></label><label class="field"><span>Supervisor</span><select name="supervisor_id">${options(people(['supervisor', 'engineer', 'staff']), p.supervisor_id, { blank: '—' })}</select></label>
            <label class="field"><span>Start date</span><input name="start_date" type="date" value="${p.start_date || ''}"></label><label class="field"><span>Target completion</span><input name="target_end" type="date" value="${p.target_end || ''}"></label>
            <label class="field full"><span>Authorised WhatsApp numbers (comma separated)</span><input name="authorized_phones" value="${p.authorized_phones.join(', ')}"><span class="hint">Only these numbers can ask the bot about this project.</span></label>
            <label class="check"><input type="checkbox" name="digest_enabled" ${p.digest_enabled ? 'checked' : ''}> Daily 7 PM update to client</label><label class="check"><input type="checkbox" name="portfolio_consent" ${p.portfolio_consent ? 'checked' : ''}> Client allows portfolio use (locality only)</label>
            <label class="field full"><span>Internal notes</span><textarea name="notes">${p.notes || ''}</textarea></label></div>`,
            onSubmit: (f) => api.patch(`/api/projects/${id}`, { ...f, digest_enabled: f.digest_enabled ? 1 : 0, portfolio_consent: f.portfolio_consent ? 1 : 0, site_lat: f.site_lat === '' ? null : Number(f.site_lat), site_lng: f.site_lng === '' ? null : Number(f.site_lng), geofence_m: Number(f.geofence_m) || 250, manager_id: f.manager_id ? Number(f.manager_id) : null, architect_id: f.architect_id ? Number(f.architect_id) : null, engineer_id: f.engineer_id ? Number(f.engineer_id) : null, supervisor_id: f.supervisor_id ? Number(f.supervisor_id) : null, area_sqft: f.area_sqft ? Number(f.area_sqft) : null, authorized_phones: f.authorized_phones.split(',').map((x) => x.trim()).filter(Boolean) }) });
          done();
        } else if (act === 'update') {
          await modal({ title: 'Send an update to the client', submit: 'Send on WhatsApp', body: html`<label class="field"><span>Message</span><textarea name="text" required placeholder="e.g. Curing of the slab is going well. Brickwork starts Monday."></textarea></label>`, onSubmit: (f) => api.post(`/api/projects/${id}/update`, f) });
          done('Update queued');
        } else if (act === 'log') {
          const d = await api.get(`/api/projects/${id}`);
          await modal({ title: 'Add site log', body: html`<label class="field"><span>Work done today</span><textarea name="work_done" required></textarea></label><div class="form-grid" style="margin-top:10px"><label class="field"><span>Stage</span><select name="milestone_id">${options(d.milestones.filter((m) => ['in_progress', 'rework'].includes(m.status)).map((m) => ({ value: m.id, label: m.name })), '', { blank: '—' })}</select></label><label class="field"><span>Stage progress %</span><input name="progress" type="number" min="0" max="99"></label>
            <label class="field"><span>Masons</span><input name="mason" type="number" min="0"></label><label class="field"><span>Helpers</span><input name="helper" type="number" min="0"></label></div><label class="field" style="margin-top:10px"><span>Issues (alerts the manager)</span><input name="issues"></label><label class="check" style="margin-top:10px"><input type="checkbox" name="client_visible" checked> Include in client's daily update</label>`,
            onSubmit: (f) => api.post(`/api/projects/${id}/logs`, { work_done: f.work_done, milestone_id: f.milestone_id ? Number(f.milestone_id) : null, progress: f.progress === '' ? null : Number(f.progress), labour: { ...(f.mason ? { mason: Number(f.mason) } : {}), ...(f.helper ? { helper: Number(f.helper) } : {}) }, issues: f.issues || null, client_visible: f.client_visible }) });
          done();
        } else if (act === 'invoice') {
          await modal({ title: 'Extra invoice', body: html`<div class="form-grid"><label class="field full"><span>For</span><input name="title" required placeholder="e.g. Extra boundary wall"></label><label class="field"><span>Amount ₹</span><input name="amount" type="number" required></label><label class="field"><span>Due date</span><input name="due_date" type="date"></label><label class="field full"><span>Payment link (optional)</span><input name="payment_link" placeholder="https://"></label></div>`, onSubmit: (f) => api.post(`/api/projects/${id}/invoices`, { ...f, amount: Number(f.amount) }) });
          done('Invoice sent to client');
        } else if (act === 'change') {
          await modal({ title: 'New change request', body: html`<label class="field"><span>Change</span><input name="title" required placeholder="e.g. Add balcony on first floor"></label><label class="field" style="margin-top:10px"><span>Details</span><textarea name="description"></textarea></label><div class="form-grid" style="margin-top:10px"><label class="field"><span>Cost impact ₹</span><input name="cost_impact" type="number" value="0"></label><label class="field"><span>Time impact (days)</span><input name="days_impact" type="number" value="0"></label></div><p class="muted small" style="margin-top:8px">Goes to Approvals; if cost or time changes, the client approves on WhatsApp before the baseline changes.</p>`, onSubmit: (f) => api.post(`/api/projects/${id}/changes`, { ...f, cost_impact: Number(f.cost_impact), days_impact: Number(f.days_impact) }) });
          done('Change request created');
        }
      } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-ms]', async (e, el) => {
      const mid = el.dataset.id;
      try {
        if (el.dataset.ms === 'start') { await api.patch(`/api/milestones/${mid}`, { start: true }); done('Stage started'); }
        if (el.dataset.ms === 'ready') { await modal({ title: 'Mark stage ready for quality review', body: html`<label class="field"><span>Note for reviewer</span><textarea name="note"></textarea></label>`, onSubmit: (f) => api.post(`/api/milestones/${mid}/submit`, f) }); done('Sent to Approvals'); }
        if (el.dataset.ms === 'override') { await modal({ title: 'Record client sign-off', body: html`<p class="muted">Use when the client approved by phone or in person.</p><label class="field"><span>Note</span><input name="note" required placeholder="e.g. Approved on site visit 12 Nov"></label>`, onSubmit: (f) => api.post(`/api/milestones/${mid}/client-override`, { approve: true, note: f.note }) }); done('Recorded'); }
        if (el.dataset.ms === 'dates') { await modal({ title: `Dates · ${el.dataset.n}`, body: html`<div class="form-grid"><label class="field"><span>Planned start</span><input type="date" name="planned_start" value="${el.dataset.s}"></label><label class="field"><span>Planned end</span><input type="date" name="planned_end" value="${el.dataset.e}"></label></div>`, onSubmit: (f) => api.patch(`/api/milestones/${mid}`, f) }); done(); }
      } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-pay]', async (e, el) => {
      try {
        const key = crypto.randomUUID();
        const result = await modal({ title: 'Record payment', body: html`<div class="form-grid"><label class="field"><span>Amount ₹</span><input name="amount" type="number" min="0.01" step="0.01" max="${el.dataset.amt}" value="${el.dataset.amt}" required></label><label class="field"><span>Method</span><select name="method">${options(['upi', 'bank', 'cheque', 'cash', 'card'])}</select></label><label class="field full"><span>Reference (UTR / cheque no.)</span><input name="reference"></label></div>`, onSubmit: (f) => api.post(`/api/invoices/${el.dataset.pay}/payments`, { ...f, amount: Number(f.amount), client_event_id: key }) });
        if (result) done(result.duplicate ? 'Payment already recorded' : 'Payment recorded — client notified');
      } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-link]', async (e, el) => {
      try { await modal({ title: 'Payment link', body: html`<label class="field"><span>UPI / payment gateway link</span><input name="payment_link" placeholder="https://"></label><p class="muted small">Included in reminders sent to the client.</p>`, onSubmit: (f) => api.patch(`/api/invoices/${el.dataset.link}`, f) }); done(); } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-status]', async (e, el) => { try { await api.patch(`/api/projects/${id}`, { status: el.dataset.status }); done('Status updated'); } catch (err) { fail(err); } });
  },
};
