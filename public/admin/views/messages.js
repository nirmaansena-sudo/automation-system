import { html, api, on, toast, modal, dt, ago, badge, empty, label, phone, options, barList } from '/shared/ui.js';

const TABS = [['outbox', 'Outgoing queue'], ['templates', 'Templates'], ['usage', 'Usage & cost'], ['failed', 'Failed incoming'], ['timers', 'Failed deadlines']];

async function outbox(status) {
  const rows = await api.get(`/api/messages/outbox${status ? `?status=${status}` : ''}`);
  return html`<div class="chips" style="margin-bottom:10px">${[['', 'All'], ['queued', 'Queued'], ['unknown', 'Unknown outcome'], ['needs_operator', 'Needs manual send'], ['failed', 'Failed'], ['sent', 'Sent'], ['cancelled', 'Cancelled']].map(([k, l]) => html`<a class="chip ${(status || '') === k ? 'on' : ''}" href="#/messages?tab=outbox&status=${k}">${l}</a>`)}</div>
    <div class="card flush"><div class="table-wrap">${rows.length ? html`<table class="t"><thead><tr><th>#</th><th>To</th><th>Kind</th><th>Route</th><th>Status</th><th>Attempts</th><th>Last error</th><th>Created</th><th></th></tr></thead><tbody>
      ${rows.map((o) => html`<tr><td class="num muted">${o.id}</td><td>${o.channel === 'n8n' ? html`<span class="tag">n8n event</span>` : html`${o.name || o.profile_name || ''}<div class="muted small">${phone(o.to_wa_id)}</div>`}</td><td class="small">${o.kind}</td><td>${o.route ? label(o.route) : '—'}</td><td>${badge(o.status)}</td><td class="num">${o.attempts}</td><td class="small muted">${o.last_error || ''}${o.error_code ? ` (${o.error_code})` : ''}</td><td class="nowrap small">${dt(o.created_at)}</td><td>${o.status === 'unknown' ? html`<button class="btn small" data-reconcile="${o.id}">Verify delivery</button>` : ['failed', 'needs_operator', 'cancelled'].includes(o.status) ? html`<button class="btn small" data-retry="${o.id}">Retry</button>` : ''}</td></tr>`)}
    </tbody></table>` : empty('Nothing here')}</div></div>
    <p class="muted small" style="margin-top:8px">Every message is rechecked just before sending (still current? opted out? 24-hour window?). Timeouts are treated as “unknown” and reconciled with WhatsApp's delivery receipts before any resend.</p>`;
}

async function failedTimers() {
  const rows = await api.get('/api/timers/failed');
  return html`<div class="card"><h2>Deadlines needing attention</h2><p class="muted small">Automatic retries are exhausted. Resolve the reported problem, then retry. Current business state is checked again before acting.</p>${rows.length ? rows.map(t => html`<div class="item"><div class="grow"><b>${label(t.kind)}</b><div class="small muted">${t.entity_type} ${t.entity_id} · ${dt(t.due_at)} · ${t.result}</div></div><button class="btn small" data-timer-retry="${t.id}">Retry deadline</button></div>`) : empty('No failed deadlines')}</div>`;
}

async function templates() {
  const rows = await api.get('/api/messages/templates');
  return html`<div class="notice small" style="margin-bottom:12px">Outside the 24-hour window WhatsApp only delivers approved templates. Create each template below in <b>WhatsApp Manager → Message templates</b> (category <b>Utility</b>, same name, language English / Hindi), wait for approval, then set its status here to <b>approved</b>. Full list with examples: <code>docs/TEMPLATES.md</code>.</div>
    <div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Lang</th><th>Category</th><th>Body</th><th>Buttons</th><th>Status</th></tr></thead><tbody>
    ${rows.map((t) => html`<tr><td class="nowrap"><code>${t.name}</code></td><td>${t.language}</td><td>${t.category}</td><td class="small" style="min-width:320px">${t.body}<div class="muted">Variables: ${t.params.map((p, i) => `{{${i + 1}}} ${p}`).join(' · ')}</div></td><td class="small">${t.buttons.map((b) => b.text).join(', ') || '—'}</td>
      <td><select data-tpl="${t.name}" data-lang="${t.language}" style="width:auto">${options(['draft', 'submitted', 'approved', 'rejected'], t.status)}</select></td></tr>`)}</tbody></table></div></div>`;
}

async function usage(month) {
  const u = await api.get(`/api/messages/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  const service = (u.byCategory.find(x => x.cat === 'service') || {}).n || 0;
  return html`<div class="notice small" style="margin-bottom:14px">Provider rates and allowances vary. <a class="link" href="#/costs">Open Usage & costs</a> to enter your actual rates, review estimates and set compute limits.</div>
    <div class="grid g3" style="margin-bottom:14px"><div class="stat"><div class="stat-label">Incoming messages</div><div class="stat-value">${u.inbound}</div><div class="stat-sub">${u.month}</div></div><div class="stat"><div class="stat-label">Free-form replies</div><div class="stat-value">${service}</div><div class="stat-sub">No assumed free allowance</div></div><div class="stat"><div class="stat-label">Template messages</div><div class="stat-value">${u.byCategory.filter(x => x.cat !== 'service').reduce((n,x) => n+x.n,0)}</div><div class="stat-sub">Count by recorded category</div></div></div>
    <div class="grid g2"><section class="card"><h2>By category</h2>${u.byCategory.length ? barList(u.byCategory.map(x => ({label:x.cat,value:x.n}))) : empty('No messages this month')}</section><section class="card"><h2>Top message kinds</h2>${u.byKind.length ? barList(u.byKind.map(x => ({label:x.kind,value:x.n}))) : empty('No messages this month')}</section></div>`;
}
async function failed() {
  const rows = await api.get('/api/inbound/failed');
  return rows.length ? html`<div class="card flush"><table class="t"><thead><tr><th>#</th><th>Kind</th><th>From</th><th>Error</th><th>Received</th><th></th></tr></thead><tbody>${rows.map((r) => html`<tr><td>${r.id}</td><td>${r.kind}</td><td>${phone(r.wa_id)}</td><td class="small muted pre">${(r.last_error || '').slice(0, 300)}</td><td>${dt(r.received_at)}</td><td><button class="btn small" data-reprocess="${r.id}">Process again</button></td></tr>`)}</tbody></table></div>` : empty('No failed incoming events', 'Each incoming message is retried 3 times before it lands here.');
}

export default {
  title: 'Messages',
  topics: ['inbox'],
  async render(ctx) {
    const tab = ctx.query.tab || 'outbox';
    const body = tab === 'templates' ? await templates() : tab === 'usage' ? await usage(ctx.query.month) : tab === 'failed' ? await failed() : tab === 'timers' ? await failedTimers() : await outbox(ctx.query.status);
    return html`<div class="page-head"><div><h1>Messages</h1><div class="sub">The single controlled sender for client replies, architect offers, reminders and alerts.</div></div></div>
      <nav class="tabs">${TABS.map(([k, l]) => html`<a class="${k === tab ? 'on' : ''}" href="#/messages?tab=${k}">${l}</a>`)}</nav>${body}`;
  },
  mount(root, ctx) {
    on(root, 'click', '[data-reconcile]', async (e, el) => { try { const result = await modal({ title: 'Resolve uncertain WhatsApp delivery', submit: 'Record verified outcome', body: html`<div class="stack"><p>Check the provider delivery log or confirm with the recipient first. Choosing “not sent” allows a new send and can duplicate a message if the check is wrong.</p><label class="field"><span>Verified outcome</span><select name="outcome">${options([{value:'sent',label:'Confirmed sent — do not resend'},{value:'cancelled',label:'Cancel this message'},{value:'not_sent',label:'Confirmed not sent — allow resend'}])}</select></label><label class="field"><span>Evidence / reason (at least 8 characters)</span><textarea name="note" required minlength="8"></textarea></label><label class="field"><span>Provider message ID (optional)</span><input name="wamid"></label></div>`, onSubmit: b => api.post(`/api/messages/outbox/${el.dataset.reconcile}/reconcile`, b) }); if(result){toast('Delivery outcome recorded');ctx.app.refresh();} }catch(err){toast(err.message,'err');} });
    on(root, 'click', '[data-timer-retry]', async (e, el) => { try { await api.post(`/api/timers/${el.dataset.timerRetry}/retry`); toast('Deadline queued again'); ctx.app.refresh(); } catch(err){toast(err.message,'err');} });
    on(root, 'click', '[data-retry]', async (e, el) => { try { await api.post(`/api/messages/outbox/${el.dataset.retry}/retry`); toast('Queued again'); ctx.app.refresh(); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'change', '[data-tpl]', async (e, el) => { try { await api.patch('/api/messages/templates', { name: el.dataset.tpl, language: el.dataset.lang, status: el.value }); toast('Template status saved'); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'click', '[data-reprocess]', async (e, el) => { try { await api.post(`/api/inbound/${el.dataset.reprocess}/retry`); toast('Queued for processing'); ctx.app.refresh(); } catch (err) { toast(err.message, 'err'); } });
  },
};
