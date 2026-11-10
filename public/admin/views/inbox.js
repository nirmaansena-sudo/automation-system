import { html, raw, api, $, on, toast, modal, ago, dt, phone, badge, empty, label, options } from '/shared/ui.js';

let state = { filter: 'all', q: '', contactId: null };
let voice = { enabled: false, transcripts: [] };

function renderBubble(m) {
  const who = m.direction === 'in' ? null : m.sender === 'bot' ? '🤖 Bot' : m.sender === 'system' ? '⚙ System' : m.sender === 'app' ? '📱 WhatsApp app' : m.sender?.startsWith('user:') ? '👤 Staff' : null;
  const img = m.media_id ? m.type === 'audio' ? html`<audio controls preload="none" src="/media/${m.media_id}" style="max-width:100%"></audio>` : html`<a href="/media/${m.media_id}" target="_blank" rel="noopener"><img src="/media/${m.media_id}" alt="Attachment" loading="lazy"></a>` : '';
  const transcript = voice.transcripts.find((x) => x.media_id === m.media_id);
  const speech = m.type === 'audio' && m.media_id ? html`<div style="margin-top:8px">${transcript?.status === 'complete' ? html`<div class="notice small"><b>${transcript.reviewed_at ? 'Staff-reviewed transcript' : 'Machine transcript — review before use'}</b><p class="pre">${transcript.text}</p><button class="btn small" data-voice-review="${m.media_id}">Review / edit</button>${transcript.reviewed_at ? html` <button class="btn small" data-voice-draft="${m.media_id}">Copy to reply draft</button>` : ''}</div>` : voice.enabled ? html`<button class="btn small" data-transcribe="${m.media_id}">${transcript?.status === 'processing' ? 'Check transcription' : 'Transcribe locally'}</button>${transcript?.error ? html`<p class="small">${transcript.error}</p>` : ''}` : ''}</div>` : '';
  return html`<div class="bubble ${m.direction} ${m.sender === 'bot' || m.sender === 'system' ? 'bot' : ''}">${who ? html`<div class="who">${who}</div>` : ''}${img}${speech}<div class="txt">${m.body || ''}</div>${m.error ? html`<div class="err">⚠ ${m.error}</div>` : ''}<div class="meta"><span>${dt(m.created_at)}</span>${m.direction === 'out' ? html`<span>${label(m.status)}${m.route === 'template' ? ' · template' : ''}</span>` : ''}</div></div>`;
}

async function listHtml() {
  const rows = await api.get(`/api/inbox?filter=${state.filter}&q=${encodeURIComponent(state.q)}`);
  if (!rows.length) return empty('No conversations', state.filter === 'all' ? 'Messages from WhatsApp appear here.' : 'Nothing in this filter.');
  return html`${rows.map((c) => html`<div class="conv ${c.contact_id === state.contactId ? 'on' : ''}" data-open="${c.contact_id}">
    <div class="avatar">${(c.name || c.profile_name || '#').slice(0, 1).toUpperCase()}</div>
    <div class="grow"><div class="name">${c.name || c.profile_name || phone(c.wa_id)}${c.needs_attention ? html`<span class="pill-dot" title="Needs a person"></span>` : ''}${c.mode === 'human' ? html`<span class="tag">human</span>` : ''}</div>
    <div class="prev">${c.last_message_preview || ''}</div><div class="muted small">${[c.lead_ref, c.project_ref].filter(Boolean).join(' · ')}</div></div>
    <div class="muted small nowrap">${ago(c.last_message_at)}${c.unread ? html`<div><span class="badge info">${c.unread}</span></div>` : ''}</div></div>`)}`;
}

async function chatHtml() {
  if (!state.contactId) return html`<div class="empty" style="padding-top:80px"><div class="empty-title">Select a conversation</div><div class="muted">The bot answers automatically. Take over any chat to reply yourself — the bot pauses until you release it or 2 hours pass without activity.</div></div>`;
  const d = await api.get(`/api/inbox/${state.contactId}`);
  voice = d.messages.some((m) => m.type === 'audio') ? await api.get(`/api/voice/contact/${state.contactId}`).catch(() => ({ enabled: false, transcripts: [] })) : { enabled: false, transcripts: [] };
  const c = d.contact; const conv = d.conversation || {};
  const human = conv.mode === 'human';
  return html`<div style="display:flex;flex-direction:column;height:100%">
    <div class="row between" style="padding:10px 14px;border-bottom:1px solid var(--line);background:var(--surface)">
      <div><div style="font-weight:700">${c.name || c.profile_name || phone(c.wa_id)} <span class="muted small">${phone(c.wa_id)}</span></div>
        <div class="row small" style="gap:6px;margin-top:3px">${badge(conv.mode || 'bot')}${c.opted_out ? html`<span class="badge bad">opted out</span>` : ''}<span class="badge ${d.windowOpen ? 'good' : 'muted'}" title="Free-form replies are possible for 24 h after the client's last message">${d.windowOpen ? '24 h window open' : 'window closed — templates only'}</span>
        <span class="tag">${c.language === 'hi' ? 'हिंदी' : 'English'}</span>${conv.owner ? html`<span class="tag">owner: ${conv.owner.name}</span>` : ''}${conv.attention_reason ? html`<span class="tag">⚠ ${conv.attention_reason}</span>` : ''}</div></div>
      <div class="row">${human ? html`<button class="btn small" data-act="release">Give back to bot</button>` : html`<button class="btn small" data-act="takeover">Take over</button>`}
        ${conv.needs_attention ? html`<button class="btn small" data-act="resolve">Mark handled</button>` : ''}<a class="btn small ghost" href="#/${c.user_id || c.kind !== 'client' ? 'contacts' : 'clients'}/${c.id}">${c.user_id || c.kind !== 'client' ? 'Contact profile' : 'Client profile'}</a></div>
    </div>
    <div class="chat" id="chat" style="flex:1">${d.messages.length ? d.messages.map(renderBubble) : html`<div class="day-sep">No messages yet</div>`}</div>
    <div style="padding:10px;border-top:1px solid var(--line);background:var(--surface)">
      ${d.windowOpen ? html`<form id="reply" class="row" style="align-items:flex-end"><textarea name="text" rows="2" placeholder="Type a reply… (sending takes over the chat from the bot)" style="flex:1"></textarea><button class="btn primary">Send</button></form>`
        : html`<form id="tpl" class="stack"><div class="notice small">The client has not messaged in the last 24 hours, so WhatsApp only allows an approved template.</div>
          <div class="row"><select name="name" style="max-width:260px">${options([...new Set(d.templates.map((t) => t.name))], 'ns_client_update')}</select><input name="p1" placeholder="Parameter 1" style="flex:1"><input name="p2" placeholder="Parameter 2" style="flex:1"><button class="btn primary">Send template</button></div></form>`}
      <div class="row small muted" style="margin-top:6px">${d.leads.map((l) => html`<a class="link" href="#/leads/${l.id}">${l.ref} (${label(l.status)})</a>`)}${d.projects.map((p) => html`<a class="link" href="#/projects/${p.id}">${p.ref}</a>`)}${d.tickets.map((t) => html`<span>${t.ref}: ${label(t.status)}</span>`)}</div>
    </div></div>`;
}

async function refreshList(root) { const el = $('#convs', root); if (el) el.innerHTML = String(await listHtml()); }
async function refreshChat(root) {
  const el = $('#chatpane', root); if (!el) return;
  const typing = $('#reply textarea', root)?.value;
  el.innerHTML = String(await chatHtml());
  if (typing) { const ta = $('#reply textarea', root); if (ta) ta.value = typing; }
  const chat = $('#chat', root); if (chat) chat.scrollTop = chat.scrollHeight;
}

let rootRef = null;
export default {
  title: 'WhatsApp inbox',
  async render({ params, query }) {
    state.contactId = params[0] ? Number(params[0]) : null;
    if (query.filter) state.filter = query.filter;
    return html`<div class="split" style="margin:-20px -22px -60px">
      <div class="pane"><div style="padding:10px;border-bottom:1px solid var(--line)" class="stack">
        <div class="row"><input class="search" id="q" placeholder="Search name or number" value="${state.q}" style="max-width:none;flex:1"><button class="btn small" id="newchat" title="Start a chat">＋</button></div>
        <div class="chips">${[['all', 'All'], ['attention', 'Needs person'], ['human', 'Human mode'], ['unread', 'Unread'], ['mine', 'Mine']].map(([k, l]) => html`<span class="chip ${state.filter === k ? 'on' : ''}" data-filter="${k}">${l}</span>`)}</div></div>
        <div id="convs">${raw(String(await listHtml()))}</div></div>
      <div class="pane" id="chatpane" style="background:var(--chat-bg)">${raw(String(await chatHtml()))}</div></div>`;
  },
  mount(root) {
    rootRef = root;
    on(root, 'click', '[data-transcribe]', async (e, el) => {
      const contactId = state.contactId;
      const result = await modal({ title: 'Transcribe this voice note', submit: 'Transcribe', body: html`<p>Send this audio to your configured self-hosted speech service. The result stays in the inbox for staff review; no reply is sent.</p><label class="field"><span>Spoken language</span><select name="language">${options([{ value: 'auto', label: 'Auto / Hinglish' }, { value: 'hi', label: 'Hindi' }, { value: 'en', label: 'English' }])}</select></label><p class="muted small">Up to 8 MB. Reopening a completed transcript uses its saved result.</p>`, onSubmit: (data) => api.post(`/api/voice/${el.dataset.transcribe}/transcribe`, data) });
      if (result && contactId === state.contactId) { toast('Transcript ready for review'); await refreshChat(root); }
    });
    on(root, 'click', '[data-voice-review]', async (e, el) => {
      const transcript = voice.transcripts.find((x) => x.media_id === Number(el.dataset.voiceReview));
      if (!transcript) return;
      const result = await modal({ title: 'Review the transcript', submit: 'Save reviewed transcript', body: html`<p>Listen to the voice note and correct names, measurements and mixed-language words.</p><label class="field"><span>Transcript</span><textarea name="text" rows="10" maxlength="20000" required>${transcript.text}</textarea></label>`, onSubmit: (data) => api.patch(`/api/voice/${transcript.media_id}/review`, data) });
      if (result) { toast('Review saved'); await refreshChat(root); }
    });
    on(root, 'click', '[data-voice-draft]', (e, el) => {
      const transcript = voice.transcripts.find((x) => x.media_id === Number(el.dataset.voiceDraft));
      const input = $('#reply textarea', root);
      if (!input) return toast('A free-form reply is unavailable outside the messaging window.', 'err');
      if (!transcript?.reviewed_at) return;
      input.value = [input.value, transcript.text].filter(Boolean).join('\n'); input.focus(); toast('Copied to your draft. Review it before sending.');
    });
    const chat = $('#chat', root); if (chat) chat.scrollTop = chat.scrollHeight;
    if (state.contactId) api.post(`/api/inbox/${state.contactId}/read`).catch(() => {});
    on(root, 'click', '[data-open]', (e, el) => { location.hash = `#/inbox/${el.dataset.open}`; });
    on(root, 'click', '[data-filter]', (e, el) => { state.filter = el.dataset.filter; root.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === el)); refreshList(root); });
    let t; on(root, 'input', '#q', (e, el) => { clearTimeout(t); t = setTimeout(() => { state.q = el.value; refreshList(root); }, 250); });
    on(root, 'click', '#newchat', async () => {
      const r = await modal({ title: 'Open a chat', submit: 'Open', body: html`<label class="field"><span>WhatsApp number</span><input name="phone" required placeholder="98xxxxxxxx"></label><label class="field" style="margin-top:10px"><span>Name (optional)</span><input name="name"></label><p class="muted small" style="margin-top:8px">If this person has not messaged you in 24 hours, only an approved template can be sent.</p>`, onSubmit: (d) => api.post('/api/inbox/new', d) });
      if (r?.contactId) location.hash = `#/inbox/${r.contactId}`;
    });
    on(root, 'click', '[data-act]', async (e, el) => {
      const act = el.dataset.act;
      try { await api.post(`/api/inbox/${state.contactId}/${act}`); toast(act === 'takeover' ? 'You own this chat. The bot is paused.' : act === 'release' ? 'The bot is answering again.' : 'Marked as handled'); refreshChat(root); refreshList(root); } catch (err) { toast(err.message, 'err'); }
    });
    on(root, 'submit', '#reply', async (e, form) => {
      e.preventDefault();
      const text = form.text.value.trim(); if (!text) return;
      form.querySelector('button').disabled = true;
      try { await api.post(`/api/inbox/${state.contactId}/reply`, { text }); form.text.value = ''; await refreshChat(root); } catch (err) { toast(err.message, 'err'); }
      finally { const b = form.querySelector('button'); if (b) b.disabled = false; }
    });
    on(root, 'keydown', '#reply textarea', (e, ta) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.form.requestSubmit(); } });
    on(root, 'submit', '#tpl', async (e, form) => {
      e.preventDefault();
      try { await api.post(`/api/inbox/${state.contactId}/template`, { name: form.name.value, params: [form.p1.value, form.p2.value].filter(Boolean) }); toast('Template queued'); refreshChat(root); } catch (err) { toast(err.message, 'err'); }
    });
  },
  onTopics(topics) {
    if (!rootRef || !document.body.contains(rootRef)) return;
    if (topics.includes('inbox')) { clearTimeout(this._t); this._t = setTimeout(() => { refreshList(rootRef); if (state.contactId) refreshChat(rootRef); }, 300); }
  },
};
