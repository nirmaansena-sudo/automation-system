// WhatsApp simulator: chat as any client or staff member and watch the real
// pipeline (webhook → bot → outbox → "WhatsApp") respond. Nothing leaves the PC.
import { html, raw, api, $, on, toast, modal, time, phone, label, options, readImage, esc } from '/shared/ui.js';

const PRESETS = [
  { name: 'Plot in Vaishali Nagar', lat: 26.9131, lng: 75.7425 }, { name: 'Flat in Mansarovar', lat: 26.8547, lng: 75.7651 },
  { name: 'House in Jagatpura', lat: 26.8262, lng: 75.8261 }, { name: 'Shop in Malviya Nagar', lat: 26.8562, lng: 75.8221 },
  { name: 'Plot on Ajmer Road', lat: 26.8791, lng: 75.6781 }, { name: 'Site near Jhotwara', lat: 26.9541, lng: 75.7372 },
];
let state = { wa: '', name: '' };
try { const s = JSON.parse(localStorage.getItem('ns_sim') || 'null'); if (s?.wa) state = s; } catch { /* ignore */ }
const remember = () => { try { localStorage.setItem('ns_sim', JSON.stringify(state)); } catch { /* ignore */ } };

function bubble(m) {
  const d = m.display || {};
  if (m.direction === 'in') {
    const img = m.media_id ? html`<img src="/media/${m.media_id}" alt="sent photo">` : '';
    return html`<div class="bubble out">${img}<div class="txt">${m.body}</div><div class="meta">${time(m.created_at)} ✓✓</div></div>`;
  }
  let inner = esc(m.body || ''); let acts = '';
  if (d.type === 'buttons' || d.type === 'template') {
    inner = esc(d.text || m.body || '');
    if (d.buttons?.length) acts = html`<div class="acts">${d.buttons.map((b) => html`<button data-btn="${b.id}" data-title="${b.title}" data-template="${d.type === 'template' ? 1 : ''}" ${b.id ? '' : 'disabled'}>${b.title}</button>`)}</div>`;
  } else if (d.type === 'list') {
    inner = esc(d.text || '');
    acts = html`<div class="acts"><button data-list="${m.id}">☰ ${d.button || 'Choose'}</button></div>`;
  } else if (d.type === 'location_request') {
    inner = esc(d.text || '');
    acts = html`<div class="acts"><button data-locreq="1">📍 Send location</button></div>`;
  } else if (d.type === 'cta_url') {
    inner = esc(d.text || ''); acts = html`<div class="acts"><a class="act" target="_blank" rel="noopener" href="${d.url}">🔗 ${d.display}</a></div>`;
  } else if (d.type === 'location') {
    inner = esc(`📍 ${d.name || 'Location'}\n${d.address || ''}`);
    acts = html`<div class="acts"><a class="act" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}">Open map</a></div>`;
  } else if (d.type === 'text') inner = esc(d.text || m.body || '');
  inner = inner.replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const st = m.status === 'needs_operator' ? '⚠ not sent (needs template)' : m.status === 'cancelled' ? '⦸ cancelled' : m.status === 'queued' || m.status === 'retrying' ? '🕓' : '';
  return html`<div class="bubble in ${m.sender === 'bot' ? '' : ''}">${m.sender && m.sender !== 'bot' && m.sender !== 'system' ? html`<div class="who">${m.sender.startsWith('user:') ? 'Staff' : m.sender}</div>` : ''}<div class="txt">${raw(inner)}</div>${m.route === 'template' ? html`<div class="muted small" style="margin-top:4px">template message</div>` : ''}${acts}<div class="meta">${time(m.created_at)} ${st}</div>${m.error && m.status !== 'sent' ? html`<div class="err">${m.error}</div>` : ''}</div>`;
}

let lastMsgs = [];
async function thread() {
  if (!state.wa) return html`<div class="empty" style="margin-top:60px"><div class="empty-title">Choose who you are</div><div class="muted">Pick a demo client or staff member on the left, or type any new number to act as a new client.</div></div>`;
  const d = await api.get(`/api/sim/thread/${state.wa}`);
  lastMsgs = d.messages;
  return d.messages.length ? html`${d.messages.map(bubble)}` : html`<div class="day-sep">Say “Hi”, or describe your project in English or Hindi</div>`;
}

async function send(body, root) {
  if (!state.wa) { toast('Choose a phone first', 'err'); return; }
  const chat = $('#simchat', root);
  chat?.insertAdjacentHTML('beforeend', '<div class="day-sep">sending…</div>'); if (chat) chat.scrollTop = chat.scrollHeight;
  try { await api.post('/api/sim/send', { from: state.wa, name: state.name || undefined, ...body }); } catch (e) { toast(e.message, 'err'); }
  await refresh(root);
}
async function refresh(root) {
  const chat = $('#simchat', root); if (!chat) return;
  chat.innerHTML = String(await thread());
  chat.scrollTop = chat.scrollHeight;
}

export default {
  title: 'WhatsApp simulator',
  async render() {
    const p = await api.get('/api/sim/phones');
    return html`<div class="page-head"><div><h1>WhatsApp simulator</h1><div class="sub">Test the complete journey on this PC — every message goes through the same webhook, bot, outbox and timers as real WhatsApp.</div></div>
      <div class="row"><button class="btn" data-ff="30">⏩ +30 min</button><button class="btn" data-ff="120">⏩ +2 h</button><button class="btn" data-ff="1440">⏩ +1 day</button><button class="btn" id="webform">🌐 Website enquiry</button></div></div>
      <div class="grid sim-grid">
        <section class="card"><header><h2>Act as</h2></header>
          <form id="newnum" class="stack"><label class="field"><span>New client number</span><input name="wa" placeholder="e.g. 98765 43210" value="${state.wa && !p.staff.some((s) => s.phone === state.wa) ? state.wa.slice(2) : ''}"></label><label class="field"><span>WhatsApp profile name</span><input name="name" placeholder="e.g. Deepak Saini" value="${state.name || ''}"></label><button class="btn primary">Use this number</button></form>
          <div class="nav-group" style="padding-left:0">Clients</div><div class="chips">${p.clients.map((c) => html`<span class="chip ${c.wa_id === state.wa ? 'on' : ''}" data-wa="${c.wa_id}" data-name="${c.name || c.profile_name || ''}">${c.name || c.profile_name || phone(c.wa_id)}</span>`)}</div>
          <div class="nav-group" style="padding-left:0">Staff (architects receive visit offers here)</div><div class="chips">${p.staff.map((s) => html`<span class="chip ${s.phone === state.wa ? 'on' : ''}" data-wa="${s.phone}" data-name="${s.name}">${s.name} · ${label(s.role)}</span>`)}</div>
        </section>
        <div class="phone-mock"><div class="phone-head"><div class="avatar">NS</div><div><b>Nirmaan Sena</b><div class="small" style="opacity:.8">${state.wa ? `you are ${state.name || phone(state.wa)}` : 'pick a phone'}</div></div></div>
          <div class="chat" id="simchat" style="flex:1">${raw(String(await thread()))}</div>
          <form class="phone-compose" id="compose"><div class="drop" id="attach"><button type="button" class="btn round" id="attachbtn" aria-label="Attach">＋</button><div class="drop-menu">
            ${PRESETS.map((x, i) => html`<button type="button" data-preset="${i}">📍 ${x.name}</button>`)}<button type="button" id="photo">📷 Photo…</button><button type="button" id="voice">🎙 Voice note</button></div></div>
            <textarea name="text" placeholder="Message" rows="1"></textarea><button class="btn primary round" aria-label="Send">➤</button></form>
          <input type="file" id="photofile" accept="image/*,application/pdf" class="hide" aria-label="Photo or PDF to send" tabindex="-1"></div>
        <section class="card"><header><h2>Try these</h2></header><ol class="ink2" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
          <li>As a <b>new client</b>, type <i>“Hi”</i> — or <i>“mujhe Vaishali Nagar me 150 gaj plot pe ghar banwana hai”</i>.</li>
          <li>Answer with the buttons, share a 📍 location from ＋, pick a visit time, confirm.</li>
          <li>Open <a class="link" href="#/approvals">Approvals</a> → <b>Approve & send offer</b>.</li>
          <li>Switch to the <b>architect</b> (e.g. Rahul Mehta) → press <b>Accept</b>.</li>
          <li>Switch back to the client → <b>Confirm</b>. The architect now receives the client's details and the location pin.</li>
          <li>Use <b>⏩</b> to jump ahead: reminders, expired offers and no-show checks fire on time.</li>
          <li>Type <i>“talk to someone”</i> to see the hand-off, or <i>“STOP”</i> to opt out.</li></ol>
          <p class="muted small" style="margin-top:12px">⏩ moves the system clock forward for this test run only (restart the server to reset it). Template messages appear when the person has not written in the last 24 hours.</p></section>
      </div>`;
  },
  mount(root, ctx) {
    const chat = $('#simchat', root); if (chat) chat.scrollTop = chat.scrollHeight;
    on(root, 'click', '[data-wa]', (e, el) => { state = { wa: el.dataset.wa, name: el.dataset.name }; remember(); ctx.app.refresh(); });
    on(root, 'submit', '#newnum', (e, f) => { e.preventDefault(); let wa = f.wa.value.replace(/\D/g, ''); if (wa.length === 10) wa = '91' + wa; if (wa.length < 11) { toast('Enter a 10-digit number', 'err'); return; } state = { wa, name: f.name.value.trim() }; remember(); ctx.app.refresh(); });
    on(root, 'submit', '#compose', (e, f) => { e.preventDefault(); const text = f.text.value.trim(); if (!text) return; f.text.value = ''; send({ text }, root); });
    on(root, 'keydown', '#compose textarea', (e, ta) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.form.requestSubmit(); } });
    on(root, 'click', '[data-btn]', (e, el) => send({ buttonId: el.dataset.btn, buttonTitle: el.dataset.title, template: !!el.dataset.template }, root));
    on(root, 'click', '[data-list]', async (e, el) => {
      const m = lastMsgs.find((x) => String(x.id) === el.dataset.list); const d = m?.display || {};
      const rows = (d.sections || []).flatMap((s) => s.rows);
      const pick = await modal({ title: d.button || 'Choose', submit: null, cancel: 'Close', body: html`<div class="list">${rows.map((r) => html`<button type="button" class="item btn ghost" style="justify-content:flex-start;text-align:left;width:100%" data-row="${r.id}" data-title="${r.title}"><div><div class="title">${r.title}</div>${r.description ? html`<div class="muted small">${r.description}</div>` : ''}</div></button>`)}</div>`,
        onMount: (dlg) => dlg.querySelectorAll('[data-row]').forEach((b) => b.addEventListener('click', () => { dlg.close(); dlg.remove(); send({ buttonId: b.dataset.row, buttonTitle: b.dataset.title, list: true }, root); })) });
      return pick;
    });
    const attach = $('#attach', root);
    on(root, 'click', '#attachbtn', () => attach.classList.toggle('open'));
    on(root, 'click', '[data-preset]', (e, el) => { attach.classList.remove('open'); const x = PRESETS[Number(el.dataset.preset)]; send({ location: { lat: x.lat, lng: x.lng, name: x.name, address: `${x.name}, Jaipur` } }, root); });
    on(root, 'click', '[data-locreq]', async () => {
      await modal({ title: 'Share location', submit: 'Send', body: html`<label class="field"><span>Place</span><select name="p">${options(PRESETS.map((x, i) => ({ value: i, label: x.name })))}</select></label>`, onSubmit: (f) => { const x = PRESETS[Number(f.p)]; send({ location: { lat: x.lat, lng: x.lng, name: x.name, address: `${x.name}, Jaipur` } }, root); return true; } });
    });
    on(root, 'click', '#photo', () => { attach.classList.remove('open'); $('#photofile', root).click(); });
    on(root, 'change', '#photofile', async (e, input) => { const file = input.files[0]; if (!file) return; try { const img = await readImage(file); send({ image: { ...img, caption: '' } }, root); } catch (err) { toast(err.message, 'err'); } input.value = ''; });
    on(root, 'click', '#voice', () => { attach.classList.remove('open'); send({ audio: true }, root); });
    on(root, 'click', '[data-ff]', async (e, el) => { try { const r = await api.post('/api/sim/fast-forward', { minutes: Number(el.dataset.ff) }); toast(`Clock moved to ${new Date(r.now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`); refresh(root); } catch (err) { toast(err.message, 'err'); } });
    on(root, 'click', '#webform', async () => {
      const r = await modal({ title: 'Simulate a website enquiry (nirmaansena.com form)', submit: 'Submit form', body: html`<div class="form-grid"><label class="field"><span>Full name</span><input name="name" required value="Neeraj Gupta"></label><label class="field"><span>Mobile (OTP verified)</span><input name="mobile" required value="9876501234"></label>
        <label class="field"><span>Jaipur locality</span><input name="locality" value="Malviya Nagar"></label><label class="field"><span>Services</span><input name="services" value="Architect & 3D Design, Full Turnkey"></label>
        <label class="field"><span>Project nature</span><input name="project_nature" value="New villa"></label><label class="field"><span>Area (sq ft)</span><input name="area" value="2400"></label>
        <label class="field"><span>Execution window</span><input name="execution_window" value="Within 15 days"></label><label class="field"><span>Reference ID</span><input name="reference_id" value="NS-JPR-2026-${String(Math.floor(Math.random() * 9000) + 1000)}"></label>
        <label class="field full"><span>Requirements</span><textarea name="requirements">G+1 villa with basement parking, Vastu compliant</textarea></label></div>`,
        onSubmit: async (f) => { await api.post('/api/sim/website-form', { ...f, consent: true, services: f.services.split(',').map((x) => x.trim()) }); return { mobile: f.mobile, name: f.name }; } });
      if (r) { state = { wa: '91' + String(r.mobile).replace(/\D/g, '').slice(-10), name: r.name }; remember(); toast('Form received — the client got a WhatsApp greeting'); ctx.app.refresh(); }
    });
  },
  onTopics(topics) {
    if (topics.includes('inbox')) { const root = document.querySelector('#content > div'); if (root && $('#simchat', root) && !document.querySelector('dialog[open]')) { clearTimeout(this._t); this._t = setTimeout(() => refresh(root), 500); } }
  },
};
