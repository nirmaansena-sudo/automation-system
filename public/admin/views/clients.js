import { html, api, on, toast, modal, dt, ago, badge, empty, label, phone, options, confirmBox } from '/shared/ui.js';

async function list(query, directory) {
  const kind = directory ? query.kind || 'all' : 'client';
  const base = directory ? 'contacts' : 'clients';
  const rows = await api.get(`/api/contacts?q=${encodeURIComponent(query.q || '')}&kind=${kind}`);
  return html`<div class="page-head"><div><h1>${directory ? 'Contact directory' : 'Clients'}</h1><div class="sub">${directory ? 'All WhatsApp contacts, grouped by their relationship with your company. Employee records and attendance are under Team.' : 'Client enquiries and customer records. Employees are managed separately under Team.'}</div></div>
    <div class="row"><input class="search" type="search" aria-label="Search" id="cq" placeholder="Search" value="${query.q || ''}"></div></div>
    ${directory ? html`<div class="chips" style="margin-bottom:12px">${[['all', 'All contacts'], ['client', 'Clients'], ['vendor', 'Vendors'], ['job_seeker', 'Job seekers'], ['staff', 'Staff'], ['spam', 'Spam']].map(([k, l]) => html`<a class="chip ${kind === k ? 'on' : ''}" href="#/contacts?kind=${k}">${l}</a>`)}</div>` : ''}
    <div class="card flush"><div class="table-wrap">${rows.length ? html`<table class="t"><thead><tr><th>Name</th><th>WhatsApp</th><th>Type</th><th>Language</th><th class="r">Leads</th><th class="r">Projects</th><th>Last message</th><th></th></tr></thead><tbody>
      ${rows.map((c) => html`<tr class="click" data-href="#/${base}/${c.id}"><td><b>${c.name || c.profile_name || '—'}</b>${c.erased_at ? html` <span class="badge muted">erased</span>` : ''}</td><td class="nowrap">${phone(c.wa_id)}</td><td>${label(c.kind)}</td><td>${c.language === 'hi' ? 'हिंदी' : 'English'}</td><td class="r num">${c.leads}</td><td class="r num">${c.projects}</td><td class="muted nowrap">${ago(c.last_inbound_at)}</td><td>${c.opted_out ? html`<span class="badge bad">opted out</span>` : ''}</td></tr>`)}
    </tbody></table>` : empty(directory ? 'No contacts found' : 'No clients found')}</div></div>${rows.length === 500 ? html`<p class="muted small">Showing the latest 500 matching records. Narrow the search or download all records under Reports & exports.</p>` : ''}`;
}

async function detail(id, user, directory) {
  const d = await api.get(`/api/contacts/${id}`);
  const c = d.contact;
  directory ||= c.kind !== 'client' || !!c.user_id;
  return html`<div class="page-head"><div><div class="muted small"><a class="link" href="#/${directory ? 'contacts' : 'clients'}">${directory ? 'Contact directory' : 'Clients'}</a> / ${c.name || phone(c.wa_id)}</div><h1>${c.name || c.profile_name || phone(c.wa_id)}</h1>
    <div class="sub">${phone(c.wa_id)} · ${label(c.kind)} · first seen ${dt(c.created_at)}${c.consent_at ? ` · consent ${dt(c.consent_at)}` : ''}</div></div>
    <div class="row"><a class="btn" href="#/inbox/${c.id}">💬 Open chat</a><button class="btn" data-act="edit">Edit</button>${user.role === 'owner' && !c.erased_at ? html`<button class="btn ghost" data-act="erase">Erase personal data</button>` : ''}</div></div>
    <div class="grid g2">
      ${c.user_id ? html`<section class="card"><h2>Employee contact</h2><p>This is the WhatsApp contact record. Attendance, access role, department and employment details belong to the employee profile.</p><a class="btn" href="#/team/person/${c.user_id}">Open employee profile</a></section>` : ''}
      <section class="card"><header><h2>Profile</h2></header><dl class="kv"><dt>WhatsApp name</dt><dd>${c.profile_name || '—'}</dd><dt>Email</dt><dd>${c.email || '—'}</dd><dt>Language</dt><dd>${c.language === 'hi' ? 'Hindi' : 'English'}</dd><dt>Updates</dt><dd>${c.opted_out ? html`<span class="badge bad">opted out ${dt(c.opted_out_at)}</span>` : html`<span class="badge good">subscribed</span>`}</dd><dt>Tags</dt><dd>${c.tags.map((t) => html`<span class="tag">${t}</span> `)}</dd><dt>Notes</dt><dd class="pre">${c.notes || '—'}</dd></dl></section>
      <section class="card"><header><h2>Leads & projects</h2></header>
        ${d.leads.length || d.projects.length ? html`<div class="list">${d.leads.map((l) => html`<a class="item" style="text-decoration:none" href="#/leads/${l.id}"><div class="grow"><div class="title">${l.ref}</div><div class="muted small">${dt(l.created_at)}</div></div>${badge(l.status)}</a>`)}${d.projects.map((p) => html`<a class="item" style="text-decoration:none" href="#/projects/${p.id}"><div class="grow"><div class="title">🏗 ${p.ref}</div><div class="muted small">${p.name}</div></div>${badge(p.status)}</a>`)}</div>` : empty('No leads yet')}
      </section>
      <section class="card"><header><h2>Tickets</h2></header>${d.tickets.length ? html`<div class="list">${d.tickets.map((t) => html`<div class="item"><div class="grow"><div class="title">${t.ref} · ${t.subject}</div><div class="muted small">${dt(t.created_at)}</div></div>${badge(t.status)}</div>`)}</div>` : empty('No tickets')}</section>
      <section class="card"><header><h2>History</h2></header><div class="timeline">${d.timeline.map((a) => html`<div class="ev"><b>${label(a.action.replace(/\./g, ' '))}</b> <span class="muted small">${a.actor} · ${dt(a.at)}</span></div>`)}</div></section>
    </div>`;
}

export default {
  title: (ctx) => ctx.name === 'contacts' ? 'Contact directory' : 'Clients',
  topics: ['leads', 'projects'],
  render(ctx) { return ctx.params[0] ? detail(ctx.params[0], ctx.user, ctx.name === 'contacts') : list(ctx.query, ctx.name === 'contacts'); },
  mount(root, ctx) {
    on(root, 'click', 'tr[data-href]', (e, el) => { location.hash = el.dataset.href; });
    let t; on(root, 'input', '#cq', (e, el) => { clearTimeout(t); t = setTimeout(() => { location.hash = `#/${ctx.name}?${new URLSearchParams({ ...ctx.query, q: el.value })}`; }, 400); });
    on(root, 'click', '[data-act]', async (e, el) => {
      const id = ctx.params[0];
      try {
        if (el.dataset.act === 'edit') {
          const { contact: c } = await api.get(`/api/contacts/${id}`);
          await modal({ title: 'Edit contact', body: html`<div class="form-grid"><label class="field"><span>Name</span><input name="name" value="${c.name || ''}"></label><label class="field"><span>Email</span><input name="email" value="${c.email || ''}"></label>
            <label class="field"><span>Type</span><select name="kind">${options(c.user_id ? ['staff'] : ['client', 'vendor', 'job_seeker', 'spam'], c.user_id ? 'staff' : c.kind)}</select></label><label class="field"><span>Language</span><select name="language">${options([{ value: 'en', label: 'English' }, { value: 'hi', label: 'Hindi' }], c.language)}</select></label>
            <label class="field full"><span>Tags (comma separated)</span><input name="tags" value="${c.tags.join(', ')}"></label><label class="field full"><span>Notes</span><textarea name="notes">${c.notes || ''}</textarea></label>
            <label class="check full"><input type="checkbox" name="opted_out" ${c.opted_out ? 'checked' : ''}> Opted out of updates</label></div>`,
            onSubmit: (f) => api.patch(`/api/contacts/${id}`, { ...f, tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean) }) });
        } else if (el.dataset.act === 'erase') {
          const ok = await confirmBox('Erase personal data?', 'Name, messages, address and photos for this person are removed permanently (DPDP request). Leads keep only anonymous numbers for reporting. This cannot be undone.', { submit: 'Erase', danger: true });
          if (ok) { await api.post(`/api/contacts/${id}/erase`); toast('Personal data erased'); }
        }
        ctx.app.refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
  },
};
