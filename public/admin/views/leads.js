import { html, raw, api, on, toast, modal, ago, dt, date, inr, badge, empty, label, options, phone, $, formData } from '/shared/ui.js';

const STATUSES = ['capturing', 'awaiting_approval', 'scheduling', 'visit_confirmed', 'visit_done', 'quoting', 'quote_sent', 'needs_followup', 'out_of_area', 'won', 'lost', 'stale'];
let catalog = null;
async function getCatalog() { if (!catalog) { const s = await api.get('/api/settings'); catalog = { ...s.catalog, zones: s.zones }; } return catalog; }

async function listView(query) {
  const st = query.status || '';
  const rows = await api.get(`/api/leads?status=${st}&q=${encodeURIComponent(query.q || '')}`);
  return html`<div class="page-head"><div><h1>Leads</h1><div class="sub">Every enquiry from WhatsApp, the website and phone calls — one Lead ID each.</div></div>
    <div class="row"><input class="search" id="lq" placeholder="Search name, ref, phone, area" value="${query.q || ''}"><button class="btn primary" id="newlead">＋ New lead</button></div></div>
    <div class="chips" style="margin-bottom:12px"><a class="chip ${!st ? 'on' : ''}" href="#/leads">All</a>${STATUSES.map((s) => html`<a class="chip ${s === st ? 'on' : ''}" href="#/leads?status=${s}">${label(s)}</a>`)}</div>
    <div class="card flush"><div class="table-wrap">${rows.length ? html`<table class="t"><thead><tr><th>Ref</th><th>Client</th><th>Need</th><th>Area</th><th>Source</th><th>Status</th><th>Created</th></tr></thead><tbody>
      ${rows.map((l) => html`<tr class="click" data-href="#/leads/${l.id}"><td class="nowrap"><b>${l.ref}</b></td><td>${l.name || '—'}<div class="muted small">${phone(l.phone)}</div></td><td>${l.services.map(label).join(', ') || '—'}<div class="muted small">${label(l.project_nature)}${l.area_sqft ? ` · ${l.area_sqft} sq ft` : ''}</div></td><td>${[l.locality, label(l.zone)].filter(Boolean).join(', ') || '—'}</td><td>${label(l.source)}</td><td>${badge(l.status)}</td><td class="nowrap muted">${ago(l.created_at)}</td></tr>`)}
    </tbody></table>` : empty('No leads here yet')}</div></div>`;
}

async function detailView(id) {
  const d = await api.get(`/api/leads/${id}`);
  const l = d.lead; const c = d.contact || {};
  const open = !['won', 'lost', 'stale'].includes(l.status);
  return html`<div class="page-head"><div><div class="muted small"><a class="link" href="#/leads">Leads</a> / ${l.ref}</div><h1>${l.name || 'Unnamed lead'} ${badge(l.status)}</h1>
      <div class="sub">${phone(l.phone)} · ${label(l.source)} · created ${dt(l.created_at)}${l.lost_reason ? ` · ${l.lost_reason}` : ''}</div></div>
    <div class="row"><a class="btn" href="#/inbox/${l.contact_id}">💬 Chat</a>${open ? html`<button class="btn" data-act="assign">📍 Assign / reschedule visit</button><button class="btn primary" data-act="quote">📄 New quotation</button><button class="btn ghost" data-act="lost">Mark lost</button>` : ''}${l.status === 'capturing' ? html`<button class="btn" data-act="submit">Submit for approval</button>` : ''}</div></div>
  <div class="grid g2">
    <section class="card"><header><h2>Requirement</h2><button class="btn small" data-act="edit">Edit</button></header>
      <dl class="kv"><dt>Services</dt><dd>${l.services.map(label).join(', ') || '—'}</dd><dt>Project type</dt><dd>${label(l.project_nature) || '—'}</dd><dt>Area</dt><dd>${l.area_sqft ? `${l.area_sqft} sq ft` : ''} ${l.area_text ? `(${l.area_text})` : ''}</dd>
      <dt>Location</dt><dd>${[l.address, l.locality, label(l.zone)].filter(Boolean).join(', ') || '—'}${l.site_lat ? html` · <a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${l.site_lat},${l.site_lng}">📍 map pin</a>` : ''}</dd>
      <dt>Start</dt><dd>${label(l.execution_window) || '—'}</dd><dt>Preferred visit</dt><dd>${l.preferred_slots.length ? dt(l.preferred_slots[0]) : '—'}</dd><dt>Notes</dt><dd class="pre">${l.requirements || '—'}</dd>${l.ai_summary ? html`<dt>AI summary</dt><dd>${l.ai_summary}</dd>` : ''}
      <dt>Language</dt><dd>${c.language === 'hi' ? 'Hindi' : 'English'}</dd></dl>
      ${d.suggestion ? html`<div class="notice good small" style="margin-top:10px">Best match now: <b>${d.suggestion.architect}</b> · ${dt(d.suggestion.slot)}</div>` : ''}
    </section>
    <section class="card"><header><h2>Visit offers & visits</h2></header>
      ${d.visits.length ? html`<div class="list">${d.visits.map((v) => html`<div class="item"><div class="grow"><div class="title">${v.ref} · ${dt(v.start_at)}</div><div class="muted small">${v.architect}${v.checkin_distance_m !== null && v.checkin_distance_m !== undefined ? ` · checked in ${Math.round(v.checkin_distance_m)} m from site` : ''}</div>${v.report ? html`<div class="small ink2" style="margin-top:4px">${v.report.recommendation || ''} · budget ${v.report.budget_range || '—'}</div>` : ''}</div>${badge(v.status)}${['confirmed', 'in_progress'].includes(v.status) ? html`<button class="btn small ghost" data-cancel="${v.id}">Cancel</button>` : ''}</div>`)}</div>` : ''}
      ${d.offers.length ? html`<table class="t dense small" style="margin-top:8px"><thead><tr><th>Rev</th><th>Architect</th><th>Time</th><th>Status</th></tr></thead><tbody>${d.offers.map((o) => html`<tr><td>${o.revision}.${o.attempt}</td><td>${o.architect}</td><td class="nowrap">${dt(o.slot_start)}</td><td>${badge(o.status)}${o.decline_reason ? html`<div class="muted">${o.decline_reason}</div>` : ''}</td></tr>`)}</tbody></table>` : empty('No offers yet')}
    </section>
    <section class="card"><header><h2>Quotations</h2></header>
      ${d.quotations.length ? html`<div class="list">${d.quotations.map((q) => html`<div class="item"><div class="grow"><div class="title">${q.ref} v${q.version} · ${inr(q.total)}</div><div class="muted small">${label(q.service_type)} · ${label(q.commercial_model)} · valid till ${date(q.valid_until)}${q.client_note ? html` · client asked: “${q.client_note}”` : ''}</div></div>${badge(q.status)}${q.link ? html`<a class="btn small ghost" target="_blank" rel="noopener" href="${q.link}">View</a>` : ''}${q.status === 'draft' ? html`<button class="btn small" data-submitq="${q.id}">Submit</button>` : ''}</div>`)}</div>` : empty('No quotation yet', 'Create one after the site report is approved.')}
    </section>
    <section class="card"><header><h2>Photos & files</h2></header>
      ${d.media.length ? html`<div class="thumbs">${d.media.map((m) => html`<a href="/media/${m.id}" target="_blank" rel="noopener">${m.mime?.startsWith('image/') ? html`<img src="/media/${m.id}" alt="${m.caption || 'photo'}" loading="lazy">` : html`<span class="tag">📄 ${m.mime}</span>`}</a>`)}</div>` : empty('Nothing shared yet')}
    </section>
    <section class="card span2"><header><h2>History</h2></header>
      <div class="timeline">${d.timeline.map((a) => html`<div class="ev"><b>${label(a.action.replace(/\./g, ' '))}</b> <span class="muted small">by ${a.actor} · ${dt(a.at)}</span></div>`)}</div>
    </section>
  </div>`;
}

async function leadForm(l = {}) {
  const cat = await getCatalog();
  return html`<div class="form-grid">
    ${l.id ? '' : html`<label class="field"><span>Phone / WhatsApp</span><input name="phone" required placeholder="98xxxxxxxx"></label>`}
    <label class="field"><span>Name</span><input name="name" value="${l.name || ''}"></label>
    <div class="field full"><span>Services</span><div class="checks">${cat.services.map((s) => html`<label class="check"><input type="checkbox" name="services" data-multi="1" value="${s.code}" ${(l.services || []).includes(s.code) ? 'checked' : ''}> ${s.en}</label>`)}</div></div>
    <label class="field"><span>Area (zone)</span><select name="zone">${options(cat.zones.map((z) => ({ value: z.code, label: z.name })), l.zone, { blank: '—' })}</select></label>
    <label class="field"><span>Colony / locality</span><input name="locality" value="${l.locality || ''}"></label>
    <label class="field full"><span>Address</span><input name="address" value="${l.address || ''}"></label>
    <label class="field"><span>Project type</span><select name="project_nature">${options(cat.natures.map((n) => ({ value: n.code, label: n.en })), l.project_nature, { blank: '—' })}</select></label>
    <label class="field"><span>Area (sq ft)</span><input name="area_sqft" type="number" min="0" value="${l.area_sqft || ''}"></label>
    <label class="field"><span>Start</span><select name="execution_window">${options(cat.windows.map((w) => ({ value: w.code, label: w.en })), l.execution_window, { blank: '—' })}</select></label>
    <label class="field"><span>Priority</span><select name="priority">${options(['normal', 'high', 'low'], l.priority || 'normal')}</select></label>
    <label class="field full"><span>Notes</span><textarea name="requirements">${l.requirements || ''}</textarea></label>
    ${l.id ? '' : html`<label class="check full"><input type="checkbox" name="submit" checked> Submit for approval now (client gets a WhatsApp confirmation)</label>`}</div>`;
}

async function quoteModal(leadId) {
  const def = await api.get('/api/quote-defaults');
  const sched = (m) => (def.schedules[m] || def.schedules.with_material);
  const rowHtml = (i = {}) => `<tr><td><input name="desc" value="${i.desc || ''}" placeholder="e.g. Turnkey construction G+1"></td><td><input name="qty" type="number" step="any" value="${i.qty || ''}" style="width:90px"></td><td><input name="unit" value="${i.unit || 'sq ft'}" style="width:80px"></td><td><input name="rate" type="number" step="any" value="${i.rate || ''}" style="width:110px"></td><td><button type="button" class="icon-btn" data-delrow>✕</button></td></tr>`;
  const schedHtml = (list) => list.map((m) => `<tr><td><input name="sname" value="${m.name}"></td><td><input name="spct" type="number" step="any" value="${m.pct}" style="width:80px"></td><td><label class="check"><input type="checkbox" name="ssite" ${m.site === false ? '' : 'checked'}> site work</label></td></tr>`).join('');
  return modal({
    title: 'New quotation', wide: true, submit: 'Save & submit for approval',
    body: html`<div class="form-grid"><label class="field"><span>Service type</span><select name="service_type">${options(Object.entries(def.types).map(([v, l]) => ({ value: v, label: l })), 'construction')}</select></label>
      <label class="field"><span>Commercial model</span><select name="commercial_model" id="cm">${options(Object.entries(def.models).map(([v, l]) => ({ value: v, label: l })), 'turnkey')}</select></label></div>
      <h3 style="margin:14px 0 6px">Line items (BOQ)</h3><table class="t dense"><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate ₹</th><th></th></tr></thead><tbody id="items">${raw(rowHtml())}</tbody></table>
      <button type="button" class="btn small" id="addrow" style="margin-top:6px">＋ Add line</button>
      <div class="form-grid" style="margin-top:12px"><label class="field"><span>GST %</span><input name="gst_pct" type="number" step="any" value="${def.gst}"></label><label class="field"><span>Valid for (days)</span><input name="valid_days" type="number" value="15"></label></div>
      <h3 style="margin:14px 0 6px">Payment schedule (must add up to 100%)</h3><table class="t dense"><tbody id="sched">${raw(schedHtml(sched('turnkey')))}</tbody></table>
      <label class="field" style="margin-top:12px"><span>Notes for the client</span><textarea name="notes" placeholder="Inclusions, exclusions, brands, timeline"></textarea></label>
      <div class="muted small" id="qtotal" style="margin-top:8px"></div>`,
    onMount: (dlg) => {
      const total = () => { let s = 0; dlg.querySelectorAll('#items tr').forEach((tr) => { s += (Number(tr.querySelector('[name=qty]').value) || 0) * (Number(tr.querySelector('[name=rate]').value) || 0); }); const g = Number(dlg.querySelector('[name=gst_pct]').value) || 0; dlg.querySelector('#qtotal').textContent = `Subtotal ${inr(s)} · Total incl. GST ${inr(s * (1 + g / 100))}`; };
      dlg.querySelector('#addrow').addEventListener('click', () => { dlg.querySelector('#items').insertAdjacentHTML('beforeend', rowHtml()); });
      dlg.addEventListener('click', (e) => { if (e.target.closest('[data-delrow]') && dlg.querySelectorAll('#items tr').length > 1) { e.target.closest('tr').remove(); total(); } });
      dlg.addEventListener('input', total);
      dlg.querySelector('#cm').addEventListener('change', (e) => { dlg.querySelector('#sched').innerHTML = schedHtml(sched(e.target.value)); });
    },
    onSubmit: (_, form) => {
      const items = [...form.querySelectorAll('#items tr')].map((tr) => ({ desc: tr.querySelector('[name=desc]').value, qty: tr.querySelector('[name=qty]').value, unit: tr.querySelector('[name=unit]').value, rate: tr.querySelector('[name=rate]').value })).filter((i) => i.desc);
      const payment_schedule = [...form.querySelectorAll('#sched tr')].map((tr) => ({ name: tr.querySelector('[name=sname]').value, pct: Number(tr.querySelector('[name=spct]').value), site: tr.querySelector('[name=ssite]').checked }));
      return api.post(`/api/leads/${leadId}/quotations`, { service_type: form.service_type.value, commercial_model: form.commercial_model.value, items, gst_pct: Number(form.gst_pct.value), valid_days: Number(form.valid_days.value), payment_schedule, notes: form.notes.value, submit: true });
    },
  });
}

export default {
  title: (ctx) => (ctx.params[0] ? 'Lead' : 'Leads'),
  topics: ['leads', 'visits'],
  render(ctx) { return ctx.params[0] ? detailView(ctx.params[0]) : listView(ctx.query); },
  mount(root, ctx) {
    const id = ctx.params[0];
    on(root, 'click', 'tr[data-href]', (e, el) => { location.hash = el.dataset.href; });
    let t; on(root, 'input', '#lq', (e, el) => { clearTimeout(t); t = setTimeout(() => { location.hash = `#/leads?${new URLSearchParams({ ...ctx.query, q: el.value })}`; }, 400); });
    on(root, 'click', '#newlead', async () => {
      const r = await modal({ title: 'New lead (phone call, walk-in, referral)', wide: true, submit: 'Create lead', body: await leadForm(), onSubmit: (d) => api.post('/api/leads', { ...d, source: 'manual' }) });
      if (r?.id) { toast(`Lead ${r.ref} created`); location.hash = `#/leads/${r.id}`; }
    });
    on(root, 'click', '[data-act]', async (e, el) => {
      const act = el.dataset.act;
      try {
        if (act === 'edit') {
          const d = await api.get(`/api/leads/${id}`);
          await modal({ title: 'Edit requirement', wide: true, body: await leadForm(d.lead), onSubmit: (f) => api.patch(`/api/leads/${id}`, f) });
        } else if (act === 'assign') {
          const slots = await api.get(`/api/leads/${id}/slots`);
          await modal({ title: 'Assign or reschedule the visit', submit: 'Send offer to architect', body: html`<p class="muted small">A new offer replaces any pending one. The old architect is told it's no longer needed.</p><label class="field"><span>Time slot</span><select name="slot" id="slotSel">${options(slots.map((s) => ({ value: s.start, label: `${s.label} — ${s.architects.length ? s.architects.map((a) => a.name).join(', ') : 'nobody free'}` })))}</select></label><label class="field" style="margin-top:10px"><span>Architect</span><select name="architectId" id="archSel"></select></label>`,
            onMount: (dlg) => { const fill = () => { const s = slots.find((x) => x.start === dlg.querySelector('#slotSel').value); dlg.querySelector('#archSel').innerHTML = String(options((s?.architects || []).map((a) => ({ value: a.id, label: a.name })), '', { blank: s?.architects?.length ? undefined : 'Nobody free' })); }; dlg.querySelector('#slotSel').addEventListener('change', fill); fill(); },
            onSubmit: (f) => { if (!f.architectId) throw new Error('Pick a time with a free architect'); return api.post(`/api/leads/${id}/offer`, { architectId: Number(f.architectId), slotStart: f.slot }); } });
        } else if (act === 'quote') { const r = await quoteModal(id); if (r) toast('Quotation sent for approval'); }
        else if (act === 'lost') { await modal({ title: 'Mark lead as lost', danger: true, submit: 'Mark lost', body: html`<label class="field"><span>Reason</span><input name="lost_reason" required placeholder="e.g. Budget mismatch, chose another builder"></label>`, onSubmit: (f) => api.patch(`/api/leads/${id}`, { status: 'lost', lost_reason: f.lost_reason }) }); }
        else if (act === 'submit') { await api.post(`/api/leads/${id}/submit`); toast('Submitted for approval'); }
        ctx.app.refresh();
      } catch (err) { toast(err.message, 'err'); }
    });
    on(root, 'click', '[data-submitq]', async (e, el) => { try { await api.post(`/api/quotations/${el.dataset.submitq}/submit`); toast('Sent for approval'); ctx.app.refresh(); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'click', '[data-cancel]', async (e, el) => {
      const r = await modal({ title: 'Cancel this visit?', danger: true, submit: 'Cancel visit', body: html`<label class="field"><span>Reason</span><input name="reason" required></label><label class="check" style="margin-top:10px"><input type="checkbox" name="reslot" checked> Ask the client to pick a new time</label>`, onSubmit: (f) => api.post(`/api/visits/${el.dataset.cancel}/cancel`, f) });
      if (r) { toast('Visit cancelled'); ctx.app.refresh(); }
    });
  },
};
