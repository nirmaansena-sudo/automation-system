import { html, raw, api, on, toast, modal, ago, dt, inr, badge, empty, label, options, toLocalInput, fromLocalInput, phone } from '/shared/ui.js';

const KIND_ORDER = ['lead_assignment', 'lead_review', 'visit_report', 'quotation', 'milestone', 'change_request', 'handover', 'attendance_exception', 'leave', 'expense', 'payroll'];

function leadBlock(a) {
  const l = a.lead || {}; const s = a.data.suggestion; const lt = a.leadText || {};
  return html`<dl class="kv small"><dt>Client</dt><dd>${l.name || '—'} · ${phone(l.phone)}</dd><dt>Need</dt><dd>${lt.services || '—'} · ${lt.nature || '—'} · ${lt.area || '—'}</dd>
    <dt>Where</dt><dd>${lt.place || '—'}${l.address ? ` · ${l.address}` : ''}${l.site_lat ? html` · <a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${l.site_lat},${l.site_lng}">map pin</a>` : ''}</dd>
    <dt>Start</dt><dd>${label(l.execution_window)}</dd>${l.requirements ? html`<dt>Notes</dt><dd class="pre">${l.requirements}</dd>` : ''}</dl>
    ${s ? html`<div class="notice good small" style="margin-top:8px">Suggested: <b>${s.architect}</b> on <b>${dt(s.slot)}</b>${s.alternatives?.length ? html` · alternatives: ${s.alternatives.map((x) => x.name).join(', ')}` : ''}</div>` : html`<div class="notice warn small" style="margin-top:8px">No architect is free at the client's time. Choose another time.</div>`}`;
}

function card(a) {
  const due = a.due_at ? html`<span class="muted small">due ${ago(a.due_at)}</span>` : '';
  let body = ''; let actions = '';
  switch (a.kind) {
    case 'lead_assignment':
      body = leadBlock(a);
      actions = html`${a.data.suggestion ? html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve & send offer</button>` : ''}<button class="btn" data-do="assign" data-id="${a.id}" data-lead="${a.entity_id}">Choose architect / time</button><button class="btn" data-do="need_info" data-id="${a.id}">Ask client</button><button class="btn ghost" data-do="call" data-id="${a.id}">Call instead</button><button class="btn ghost" data-do="reject" data-id="${a.id}">Reject</button>`;
      break;
    case 'lead_review':
      body = html`<p class="ink2">${a.summary}</p>`;
      actions = html`<button class="btn primary" data-do="accept_outside" data-id="${a.id}">Accept — treat as Jaipur</button><button class="btn" data-do="call" data-id="${a.id}">Call instead</button><button class="btn ghost" data-do="reject" data-id="${a.id}">Decline politely</button>`;
      break;
    case 'visit_report': {
      const r = a.visit?.report || {};
      body = html`<dl class="kv small"><dt>Measurements</dt><dd>${r.measurements || '—'}</dd><dt>Scope</dt><dd>${r.scope || '—'}</dd><dt>Constraints</dt><dd>${r.constraints || '—'}</dd><dt>Recommendation</dt><dd>${r.recommendation || '—'}</dd><dt>Budget</dt><dd>${r.budget_range || '—'}</dd><dt>Interest</dt><dd>${r.interest || '—'}</dd><dt>Notes</dt><dd>${r.notes || '—'}</dd></dl>${a.visit ? html`<a class="link small" href="#/leads/${a.visit.lead_id}">Open lead & photos</a>` : ''}`;
      actions = html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve → prepare quotation</button><button class="btn" data-do="revisit" data-id="${a.id}">Needs another visit</button><button class="btn ghost" data-do="close" data-id="${a.id}">Close lead</button>`;
      break;
    }
    case 'quotation': {
      const q = a.quote || {};
      body = html`<table class="t dense small"><tbody>${(q.items || []).map((i) => html`<tr><td>${i.desc}</td><td class="r num">${i.qty} ${i.unit}</td><td class="r num">${inr(i.rate)}</td><td class="r num">${inr(i.amount)}</td></tr>`)}
        <tr><td colspan="3">Total incl. GST ${q.gst_pct}%</td><td class="r num"><b>${inr(q.total)}</b></td></tr></tbody></table>
        <div class="muted small" style="margin-top:6px">Payment stages: ${(q.payment_schedule || []).map((m) => `${m.name} ${m.pct}%`).join(' · ')}</div>`;
      actions = html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve & send to client</button><button class="btn" data-do="return" data-id="${a.id}">Return with note</button>`;
      break;
    }
    case 'milestone':
      body = html`<p class="ink2">${a.summary}</p><a class="link small" href="#/projects/${a.data.projectId}">Open project, site logs and photos</a>`;
      actions = html`<button class="btn primary" data-do="pass" data-id="${a.id}">Quality OK → ask client to sign off</button><button class="btn" data-do="rework" data-id="${a.id}">Rework needed</button>`;
      break;
    case 'attendance_exception': {
      const e = a.event || {};
      body = html`<dl class="kv small"><dt>When</dt><dd>${dt(e.effective_time)}${e.offline ? ' (recorded offline)' : ''}</dd><dt>Where</dt><dd>${e.place_name || '—'}${e.distance_m !== null && e.distance_m !== undefined ? ` · ${Math.round(e.distance_m)} m away` : ''}${e.lat ? html` · <a class="link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}">map</a>` : ''}</dd><dt>GPS accuracy</dt><dd>${e.accuracy_m ? `${Math.round(e.accuracy_m)} m` : '—'}</dd><dt>Why</dt><dd>${a.summary}</dd>${e.note ? html`<dt>Note</dt><dd>${e.note}</dd>` : ''}</dl>
        ${e.photo_media_id ? html`<img src="/media/${e.photo_media_id}" alt="Check-in photo" style="max-width:160px;border-radius:8px;margin-top:6px">` : ''}`;
      actions = html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve</button><button class="btn" data-do="approve_time" data-id="${a.id}" data-time="${e.effective_time}">Approve with corrected time</button><button class="btn ghost" data-do="reject_note" data-id="${a.id}">Reject</button>`;
      break;
    }
    case 'payroll':
      body = html`<p class="ink2">${a.summary}</p><a class="link small" href="/api/payroll/export.csv?month=${a.data.month}">Download CSV for ${a.data.month}</a>`;
      actions = html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve</button><button class="btn ghost" data-do="reject_note" data-id="${a.id}">Reject</button>`;
      break;
    default:
      body = html`<p class="ink2">${a.summary || ''}</p>`;
      actions = html`<button class="btn primary" data-do="approve" data-id="${a.id}">Approve</button><button class="btn ghost" data-do="reject_note" data-id="${a.id}">Reject</button>`;
  }
  return html`<article class="card"><header><div><span class="badge ${a.escalated ? 'bad' : 'warn'}">${a.label}</span> <b style="margin-left:6px">${a.title}</b></div><div class="row">${due}<span class="muted small">${ago(a.created_at)}</span></div></header>${body}<div class="row" style="margin-top:12px">${actions}</div></article>`;
}

async function decide(id, body) { await api.post(`/api/approvals/${id}/decide`, body); toast('Done'); }

export default {
  title: 'Approvals',
  topics: ['approvals'],
  async render({ query }) {
    const status = query.status || 'pending';
    const rows = await api.get(`/api/approvals?status=${status}`);
    rows.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
    return html`<div class="page-head"><div><h1>Approvals</h1><div class="sub">Every human decision in one place. Each enquiry needs only one approval before the architect is offered the visit.</div></div>
      <div class="chips">${['pending', 'approved', 'rejected', 'done', 'cancelled'].map((s) => html`<a class="chip ${s === status ? 'on' : ''}" href="#/approvals?status=${s}">${s}</a>`)}</div></div>
      ${status === 'pending' ? (rows.length ? html`<div class="stack">${rows.map(card)}</div>` : empty('All caught up 🎉', 'New decisions will appear here and in the notification bell.'))
        : html`<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Type</th><th>Title</th><th>Decision</th><th>Note</th><th>When</th></tr></thead><tbody>${rows.map((a) => html`<tr><td>${a.label}</td><td>${a.title}</td><td>${badge(a.decision || a.status)}</td><td class="muted">${a.decision_note || ''}</td><td class="nowrap">${dt(a.decided_at || a.created_at)}</td></tr>`)}</tbody></table></div></div>`}`;
  },
  mount(root, ctx) {
    on(root, 'click', '[data-do]', async (e, el) => {
      const id = Number(el.dataset.id); const act = el.dataset.do;
      try {
        if (act === 'approve' || act === 'pass' || act === 'accept_outside') { el.disabled = true; await decide(id, { decision: act === 'pass' ? 'pass' : act }); }
        else if (act === 'assign') {
          const slots = await api.get(`/api/leads/${el.dataset.lead}/slots`);
          const r = await modal({ title: 'Choose architect and time', submit: 'Send offer', body: html`<label class="field"><span>Time slot</span><select name="slot" id="slotSel">${options(slots.map((s) => ({ value: s.start, label: `${s.label} — ${s.architects.length ? s.architects.map((a) => a.name).join(', ') : 'nobody free'}` })))}</select></label>
            <label class="field" style="margin-top:10px"><span>Architect</span><select name="architectId" id="archSel"></select><span class="hint">Only architects free at that time (calendar, leave, daily cap) are listed, best match first.</span></label>`,
            onMount: (dlg) => { const fill = () => { const s = slots.find((x) => x.start === dlg.querySelector('#slotSel').value); dlg.querySelector('#archSel').innerHTML = String(options((s?.architects || []).map((a) => ({ value: a.id, label: a.name })), '', { blank: s?.architects?.length ? undefined : 'Nobody free at this time' })); }; dlg.querySelector('#slotSel').addEventListener('change', fill); fill(); },
            onSubmit: (d) => { if (!d.architectId) throw new Error('Pick a time with a free architect'); return api.post(`/api/approvals/${id}/decide`, { decision: 'approve', architectId: Number(d.architectId), slotStart: d.slot }); } });
          if (r) toast('Offer sent to the architect');
        } else if (act === 'need_info') {
          await modal({ title: 'Ask the client', submit: 'Send on WhatsApp', body: html`<label class="field"><span>Your question</span><textarea name="note" required placeholder="e.g. Could you share the plot dimensions and a photo of the site?"></textarea></label>`, onSubmit: (d) => decide(id, { decision: 'need_info', note: d.note }) });
        } else if (['reject', 'call', 'revisit', 'close', 'return', 'rework', 'reject_note'].includes(act)) {
          const map = { reject: 'reject', call: 'call', revisit: 'revisit', close: 'close', return: 'return', rework: 'rework', reject_note: 'reject' };
          const titles = { reject: 'Reject enquiry', call: 'Call the client instead', revisit: 'Another visit needed', close: 'Close this lead', return: 'Return quotation', rework: 'Rework needed', reject_note: 'Reject' };
          await modal({ title: titles[act], submit: 'Confirm', danger: ['reject', 'close', 'reject_note'].includes(act), body: html`<label class="field"><span>Note ${act === 'reject' ? '(sent politely to the client)' : ''}</span><textarea name="note" placeholder="Reason / instructions"></textarea></label>`, onSubmit: (d) => decide(id, { decision: map[act], note: d.note }) });
        } else if (act === 'approve_time') {
          await modal({ title: 'Approve with corrected time', submit: 'Approve', body: html`<label class="field"><span>Actual time</span><input type="datetime-local" name="t" value="${toLocalInput(el.dataset.time)}" required></label><label class="field" style="margin-top:10px"><span>Note</span><input name="note" placeholder="e.g. Confirmed by phone"></label>`, onSubmit: (d) => decide(id, { decision: 'approve', corrected_time: fromLocalInput(d.t), note: d.note }) });
        }
        ctx.app.refresh();
      } catch (err) { toast(err.message, 'err'); el.disabled = false; }
    });
  },
};
