import { html, api, on, toast, modal, dt, day, time, badge, empty, label, phone, ago } from '/shared/ui.js';

export default {
  title: 'Site visits',
  topics: ['visits'],
  async render() {
    const d = await api.get('/api/visits');
    const byDay = {};
    for (const v of d.visits) { const k = day(v.start_at); (byDay[k] ||= []).push(v); }
    return html`<div class="page-head"><div><h1>Site visits</h1><div class="sub">Confirmed visits for the next two weeks, offers waiting for an architect or client, and who is on leave.</div></div></div>
      <div class="grid g2" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)">
        <section class="card"><header><h2>Agenda</h2></header>
          ${Object.keys(byDay).length ? Object.entries(byDay).map(([k, list]) => html`<div class="agenda-day">${k}</div>${list.map((v) => html`<div class="slot-card">
            <div><b class="num">${time(v.start_at)}</b><div class="muted small">${v.ref}</div></div>
            <div><div><b>${v.client || '—'}</b> · ${[v.locality, label(v.zone)].filter(Boolean).join(', ')}</div><div class="muted small">👷 ${v.architect} · ${phone(v.phone)} · <a class="link" href="#/leads/${v.lead_id}">${v.lead_ref}</a></div></div>
            <div class="row">${badge(v.status)}${['confirmed', 'in_progress'].includes(v.status) ? html`<button class="btn small" data-resched="${v.id}">Reschedule</button><button class="btn small ghost" data-cancel="${v.id}">Cancel</button>` : ''}</div></div>`)}`) : empty('No visits scheduled', 'Approve an enquiry to offer a visit to an architect.')}
        </section>
        <div class="stack">
          <section class="card"><header><h2>Offers in flight</h2></header>
            ${d.offers.length ? html`<div class="list">${d.offers.map((o) => html`<div class="item"><div class="grow"><div class="title">${o.client || o.lead_ref} · ${dt(o.slot_start)}</div><div class="muted small">👷 ${o.architect} · ${o.status === 'pending' ? `architect must reply ${ago(o.expires_at)}` : `waiting for client ${o.client_deadline ? ago(o.client_deadline) : ''}`}</div></div>${badge(o.status === 'pending' ? 'pending' : 'accepted', { accepted: 'info' })}</div>`)}</div>` : empty('No pending offers')}
          </section>
          <section class="card"><header><h2>Architects</h2></header>
            <div class="list">${d.architects.map((a) => html`<div class="item"><div class="grow"><div class="title">${a.name}</div><div class="muted small">${a.zones.length ? a.zones.map(label).join(', ') : 'all zones'}</div></div></div>`)}</div>
          </section>
          <section class="card"><header><h2>Leave & blocks</h2></header>
            ${d.leaves.length ? html`<div class="list">${d.leaves.map((h) => html`<div class="item"><div class="grow"><div class="title">${h.name}</div><div class="muted small">${dt(h.start_at)} → ${dt(h.end_at)}</div></div><span class="tag">${h.kind}</span></div>`)}</div>` : empty('Nobody on leave')}
          </section>
        </div>
      </div>`;
  },
  mount(root, ctx) {
    const go = async (id, reslot) => {
      const r = await modal({ title: reslot ? 'Reschedule visit' : 'Cancel visit', danger: !reslot, submit: reslot ? 'Ask client for a new time' : 'Cancel visit', body: html`<p class="muted small">${reslot ? 'The architect is told the visit moved; the client receives a list of free times on WhatsApp.' : 'The architect and client are informed on WhatsApp.'}</p><label class="field"><span>Reason</span><input name="reason" required></label>`, onSubmit: (f) => api.post(`/api/visits/${id}/cancel`, { reason: f.reason, reslot }) });
      if (r) { toast('Done'); ctx.app.refresh(); }
    };
    on(root, 'click', '[data-resched]', (e, el) => go(el.dataset.resched, true).catch((err) => toast(err.message, 'err')));
    on(root, 'click', '[data-cancel]', (e, el) => go(el.dataset.cancel, false).catch((err) => toast(err.message, 'err')));
  },
};
