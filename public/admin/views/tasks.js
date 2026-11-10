import { html, api, on, toast, modal, dt, ago, badge, empty, label, phone, options, fromLocalInput } from '/shared/ui.js';

let people = null;
async function team() { if (!people) people = (await api.get('/api/team')).filter((u) => u.active); return people; }

async function tasks(query) {
  const st = query.status || 'open';
  const rows = await api.get(`/api/tasks?status=${st}${query.assignee ? `&assignee=${query.assignee}` : ''}`);
  const ppl = await team();
  const now = Date.now();
  return html`<div class="row between" style="margin-bottom:10px"><div class="chips">${[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([k, l]) => html`<a class="chip ${st === k ? 'on' : ''}" href="#/tasks?status=${k}${query.assignee ? `&assignee=${query.assignee}` : ''}">${l}</a>`)}
      <select id="who" style="width:auto">${options(ppl.map((u) => ({ value: u.id, label: u.name })), query.assignee || '', { blank: 'Everyone' })}</select></div><button class="btn primary" data-act="new">＋ New task</button></div>
    <div class="card flush"><div class="table-wrap">${rows.length ? html`<table class="t"><thead><tr><th>Task</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead><tbody>
      ${rows.map((t) => html`<tr><td><b>${t.title}</b>${t.description ? html`<div class="muted small pre">${t.description.slice(0, 240)}</div>` : ''}${t.evidence ? html`<div class="small ink2 pre">${t.evidence.split('\n').slice(-2).join('\n')}</div>` : ''}<div class="muted small">${label(t.kind)} · ${t.created_by}${t.entity_type ? ` · ${t.entity_type} #${t.entity_id}` : ''}</div></td>
        <td class="nowrap">${t.assignee || '—'}</td><td>${badge(t.priority)}</td><td class="nowrap ${t.due_at && new Date(t.due_at).getTime() < now && !['done', 'cancelled'].includes(t.status) ? '' : 'muted'}">${t.due_at ? html`${dt(t.due_at)}${new Date(t.due_at).getTime() < now && !['done', 'cancelled'].includes(t.status) ? html` <span class="badge bad">overdue</span>` : ''}` : '—'}</td>
        <td><select data-status="${t.id}" style="width:auto">${options(['todo', 'in_progress', 'blocked', 'done', 'cancelled'], t.status)}</select></td></tr>`)}
    </tbody></table>` : empty('No tasks here')}</div></div>`;
}

async function tickets() {
  const rows = await api.get('/api/tickets');
  return rows.length ? html`<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Ticket</th><th>Client</th><th>Project</th><th>Priority</th><th>Assignee</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
    ${rows.map((t) => html`<tr><td><b>${t.ref}</b><div>${t.subject}</div><div class="muted small pre">${(t.description || '').slice(0, 300)}</div></td><td>${t.name || t.profile_name || phone(t.wa_id)}</td><td>${t.project_ref || '—'}</td><td>${badge(t.priority)}</td><td>${t.assignee || '—'}</td><td class="nowrap">${t.first_response_at ? html`<span class="muted small">answered</span>` : ago(t.due_at)}</td><td>${badge(t.status)}</td>
      <td class="nowrap"><button class="btn small" data-reply="${t.id}">Reply / update</button><a class="btn small ghost" href="#/inbox/${t.contact_id}">Chat</a></td></tr>`)}</tbody></table></div></div>` : empty('No tickets', 'Existing clients raise issues from the WhatsApp menu.');
}

export default {
  title: 'Tasks & tickets',
  topics: ['tasks', 'tickets'],
  async render(ctx) {
    const tab = ctx.query.tab || 'tasks';
    return html`<div class="page-head"><div><h1>Tasks & tickets</h1><div class="sub">Tasks are created by people and by the system (calls to make, messages to send manually, overdue reports). Tickets are client support requests with a response time.</div></div></div>
      <nav class="tabs"><a class="${tab === 'tasks' ? 'on' : ''}" href="#/tasks">Tasks</a><a class="${tab === 'tickets' ? 'on' : ''}" href="#/tasks?tab=tickets">Client tickets</a></nav>
      ${tab === 'tickets' ? await tickets() : await tasks(ctx.query)}`;
  },
  mount(root, ctx) {
    on(root, 'change', '[data-status]', async (e, el) => { try { await api.patch(`/api/tasks/${el.dataset.status}`, { status: el.value }); toast('Updated'); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'change', '#who', (e, el) => { location.hash = `#/tasks?${new URLSearchParams({ ...ctx.query, assignee: el.value })}`; });
    on(root, 'click', '[data-act="new"]', async () => {
      const ppl = await team();
      const r = await modal({ title: 'New task', body: html`<label class="field"><span>Task</span><input name="title" required></label><label class="field" style="margin-top:10px"><span>Details</span><textarea name="description"></textarea></label>
        <div class="form-grid" style="margin-top:10px"><label class="field"><span>Assign to</span><select name="assignee_id">${options(ppl.map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })), '', { blank: '—' })}</select></label><label class="field"><span>Priority</span><select name="priority">${options(['normal', 'high', 'low'])}</select></label><label class="field full"><span>Due</span><input name="due" type="datetime-local"></label></div>`,
        onSubmit: (f) => api.post('/api/tasks', { title: f.title, description: f.description, assignee_id: f.assignee_id ? Number(f.assignee_id) : null, priority: f.priority, due_at: fromLocalInput(f.due) }) });
      if (r) { toast('Task created — the person sees it in their app'); ctx.app.refresh(); }
    });
    on(root, 'click', '[data-reply]', async (e, el) => {
      const ppl = await team();
      const r = await modal({ title: 'Update ticket', body: html`<label class="field"><span>Reply to client (sent on WhatsApp)</span><textarea name="reply" placeholder="Optional"></textarea></label><div class="form-grid" style="margin-top:10px"><label class="field"><span>Status</span><select name="status">${options(['open', 'in_progress', 'waiting_client', 'resolved', 'closed'], 'in_progress')}</select></label><label class="field"><span>Assignee</span><select name="assignee_id">${options(ppl.map((u) => ({ value: u.id, label: u.name })), '', { blank: 'unchanged' })}</select></label></div>`,
        onSubmit: (f) => api.patch(`/api/tickets/${el.dataset.reply}`, { status: f.status, reply: f.reply || undefined, assignee_id: f.assignee_id ? Number(f.assignee_id) : undefined }) });
      if (r) { toast('Ticket updated'); ctx.app.refresh(); }
    });
  },
};
