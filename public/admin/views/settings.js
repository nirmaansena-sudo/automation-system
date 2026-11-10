import { html, raw, api, on, toast, modal, dt, ago, badge, empty, label, options, formData } from '/shared/ui.js';

const TABS = [['connections', 'Connections'], ['business', 'Business & hours'], ['automation', 'Automation rules'], ['zones', 'Zones'], ['faqs', 'FAQ answers'], ['holidays', 'Holidays'], ['routines', 'Routines'], ['account', 'My account']];

function copyField(lbl, value) {
  return html`<label class="field"><span>${lbl}</span><div class="row" style="flex-wrap:nowrap"><input readonly value="${value || ''}"><button type="button" class="btn small" data-copy="${value || ''}">Copy</button></div></label>`;
}

function connections(d, user) {
  const s = d.system;
  const w = s.whatsapp; const ai = s.ai;
  return html`<div class="grid g2">
    <section class="card"><header><h2>WhatsApp</h2>${w.provider === 'simulator' ? badge('simulator', { simulator: 'warn' }) : w.ready ? badge('connected', { connected: 'good' }) : badge('setup needed', { 'setup needed': 'bad' })}</header>
      <dl class="kv"><dt>Mode</dt><dd>${w.provider}${w.provider === 'cloud' ? ` · Graph ${w.graphVersion}` : ''}${w.coexistence ? ' · coexistence on' : ''}</dd>${w.missing.length ? html`<dt>Missing</dt><dd>${w.missing.join(', ')}</dd>` : ''}</dl>
      <div class="stack" style="margin-top:12px">${copyField('Webhook callback URL (paste in Meta → WhatsApp → Configuration)', s.webhookUrl)}${user.role === 'owner' ? copyField('Verify token', s.secrets?.verifyToken) : ''}</div>
      <p class="muted small" style="margin-top:8px">To go live: set <code>WHATSAPP_PROVIDER=cloud</code> and the token, phone number ID and app secret in the <code>.env</code> file, then restart. Step-by-step: <code>docs/WHATSAPP-SETUP.md</code>. The webhook URL must be public HTTPS (a server, or a tunnel when testing on this PC).</p>
      <form id="testwa" class="row" style="margin-top:8px"><input name="to" placeholder="Your WhatsApp number" style="max-width:220px"><button class="btn small">Send test message</button></form></section>
    <section class="card"><header><h2>AI understanding</h2>${ai.enabled ? badge('on', { on: 'good' }) : badge('off', { off: 'muted' })}</header>
      <dl class="kv"><dt>Mode</dt><dd>${ai.mode}${ai.model ? ` · ${ai.model}` : ''}</dd>${ai.problems.length ? html`<dt>Problem</dt><dd>${ai.problems.join(', ')}</dd>` : ''}</dl>
      <p class="muted small" style="margin-top:8px">AI only reads messages (intent, area, plot size, Hindi/Hinglish). Clients only ever receive fixed messages, your FAQ answers and real data. Set <code>AI_MODE=anthropic</code> (or <code>openai</code> / <code>n8n</code>) and <code>AI_API_KEY</code> in <code>.env</code>. With AI off, button menus and approved keyword answers still work; unanswered questions are handed to the team.</p></section>
    <section class="card"><header><h2>n8n (visual automations)</h2>${s.n8n.lastSeen ? badge('connected', { connected: 'good' }) : badge('not connected', { 'not connected': 'muted' })}</header>
      <dl class="kv"><dt>n8n URL</dt><dd>${s.n8n.baseUrl || 'not set'}</dd><dt>Last seen</dt><dd>${s.n8n.lastSeen ? ago(s.n8n.lastSeen) : 'never'}</dd><dt>Routines run by</dt><dd>${s.routinesMode === 'n8n' ? 'n8n (backend runs them if n8n misses one)' : 'this backend'}</dd></dl>
      ${user.role === 'owner' ? html`<div class="stack" style="margin-top:12px">${copyField('Automation key (n8n → header X-Automation-Key)', s.secrets?.automationKey)}${copyField('Shared secret (backend → n8n, header X-NS-Secret)', s.secrets?.n8nSecret)}</div>` : ''}
      <p class="muted small" style="margin-top:8px">Import the workflows from the <code>n8n/workflows</code> folder. Guide: <code>n8n/README.md</code>.</p></section>
    <section class="card"><header><h2>Website enquiry form</h2></header>
      <div class="stack">${copyField('Form endpoint (POST JSON)', s.websiteFormUrl)}${user.role === 'owner' ? copyField('Header X-Website-Secret', s.secrets?.websiteSecret) : ''}</div>
      <p class="muted small" style="margin-top:8px">Send the OTP-verified form from nirmaansena.com here. The website's reference (NS-JPR-YYYY-XXXX) becomes the Lead ID and the client is greeted on WhatsApp to share location and pick a visit time.</p></section>
    <section class="card span2"><header><h2>System health</h2></header>${s.health.ok ? html`<div class="notice good">✅ Everything is running.</div>` : html`<div class="notice warn"><ul style="margin:0 0 0 18px;padding:0">${s.health.warnings.map((x) => html`<li>${x}</li>`)}</ul></div>`}
      <dl class="kv" style="margin-top:10px"><dt>Public URL</dt><dd>${s.publicUrl}</dd><dt>Data folder</dt><dd><code>${s.dataDir}</code></dd><dt>Last webhook</dt><dd>${s.health.lastWebhook ? ago(s.health.lastWebhook) : '—'}</dd><dt>Last backup</dt><dd>${s.health.lastBackup ? `${ago(s.health.lastBackup.at)} (${s.health.lastBackup.file})` : '—'}</dd></dl></section>
  </div>`;
}

function business(st) {
  return html`<form class="card stack" id="bizform"><div class="form-grid">
    <label class="field"><span>Office opens</span><input type="time" name="open" value="${st.business_hours.open}"></label><label class="field"><span>Office closes</span><input type="time" name="close" value="${st.business_hours.close}"></label>
    <label class="field full"><span>Office name / address</span><input name="office_name" value="${st.office.name}"></label>
    <label class="field"><span>Office latitude</span><input type="number" step="any" name="office_lat" value="${st.office.lat}"></label><label class="field"><span>Office longitude</span><input type="number" step="any" name="office_lng" value="${st.office.lng}"></label>
    <label class="field"><span>Office check-in radius (m)</span><input type="number" name="office_radius" value="${st.office.radius_m}"></label><label class="field"><span>GST % (default)</span><input type="number" step="any" name="gst_pct" value="${st.gst_pct}"></label>
    <label class="field"><span>Payment terms (days)</span><input type="number" name="payment_terms_days" value="${st.payment_terms_days}"></label><label class="field"><span>Structural warranty (years)</span><input type="number" name="warranty_years" value="${st.warranty_years}"></label>
    <label class="field full"><span>Payment instructions shown to clients</span><textarea name="payment_instructions">${st.payment_instructions}</textarea></label>
    <label class="check full"><input type="checkbox" name="owner_whatsapp_alerts" ${st.owner_whatsapp_alerts ? 'checked' : ''}> Send me the morning brief on WhatsApp too (costs a template message per day)</label></div>
    <div><button class="btn primary">Save</button></div></form>`;
}

function automation(st) {
  return html`<form class="card stack" id="autoform"><div class="form-grid">
    <div class="field full"><span>Visit start times offered to clients</span><input name="visit_slots" value="${st.visit_slots.join(', ')}"><span class="hint">24-hour times, comma separated, e.g. 10:00, 12:00, 15:00, 17:00</span></div>
    <label class="field"><span>Visit length (min)</span><input type="number" name="visit_duration_min" value="${st.visit_duration_min}"></label><label class="field"><span>Travel buffer between visits (min)</span><input type="number" name="visit_buffer_min" value="${st.visit_buffer_min}"></label>
    <label class="field"><span>Days ahead offered</span><input type="number" name="slot_days_ahead" value="${st.slot_days_ahead}"></label><label class="field"><span>Earliest slot from now (min)</span><input type="number" name="min_lead_time_min" value="${st.min_lead_time_min}"></label>
    <label class="field"><span>Architect must reply within (min)</span><input type="number" name="offer_timeout_min" value="${st.offer_timeout_min}"></label><label class="field"><span>Client must confirm within (min)</span><input type="number" name="client_confirm_timeout_min" value="${st.client_confirm_timeout_min}"></label>
    <label class="field"><span>Architects tried automatically</span><input type="number" name="max_offer_attempts" value="${st.max_offer_attempts}"></label><label class="field"><span>Approval reminder after (min)</span><input type="number" name="approval_sla_min" value="${st.approval_sla_min}"></label>
    <label class="field"><span>Staff must answer a taken-over chat within (min)</span><input type="number" name="human_sla_min" value="${st.human_sla_min}"></label><label class="field"><span>Inactivity delay if automatic resumption is enabled (min)</span><input type="number" name="human_release_min" value="${st.human_release_min}"></label>
    <label class="field"><span>Max bot replies per chat per hour</span><input type="number" name="bot_max_per_hour" value="${st.bot_max_per_hour}"></label><label class="field"><span>Daily client update time</span><input type="time" name="digest_time" value="${st.digest_time}"></label>
    <label class="field"><span>Nudge unfinished enquiry after (h)</span><input type="number" name="lead_nudge_after_h" value="${st.lead_nudge_after_h}"></label><label class="field"><span>Close unfinished enquiry after (h)</span><input type="number" name="lead_stale_after_h" value="${st.lead_stale_after_h}"></label>
    <label class="field"><span>Site report due after visit (h)</span><input type="number" name="report_due_h" value="${st.report_due_h}"></label><label class="field"><span>Quotation valid (days)</span><input type="number" name="quote_validity_days" value="${st.quote_validity_days}"></label>
    <label class="check full"><input type="checkbox" name="auto_approve_leads" ${st.auto_approve_leads ? 'checked' : ''}> Auto-approve complete Jaipur enquiries (the best architect is offered the visit immediately; incomplete or out-of-area ones still come to you)</label>
    <label class="field"><span>Simulator: random failure rate (0–0.5)</span><input type="number" step="0.05" min="0" max="0.5" name="sim_fail_rate" value="${st.sim_fail_rate}"><span class="hint">Tests retries & recovery in simulator mode only</span></label></div>
    <div><button class="btn primary">Save</button></div></form>`;
}

function zones(d) {
  return html`<form class="card" id="zoneform"><table class="t dense"><thead><tr><th>Code</th><th>Name</th><th>Hindi</th><th>Lat</th><th>Lng</th><th>Active</th></tr></thead><tbody id="zrows">${d.zones.map((z) => html`<tr><td><input name="code" value="${z.code}" ${['other_jaipur', 'outside'].includes(z.code) ? 'readonly' : ''}></td><td><input name="name" value="${z.name}"></td><td><input name="name_hi" value="${z.name_hi || ''}"></td><td><input name="lat" type="number" step="any" value="${z.lat ?? ''}"></td><td><input name="lng" type="number" step="any" value="${z.lng ?? ''}"></td><td><input type="checkbox" name="active" ${z.active ? 'checked' : ''}></td></tr>`)}</tbody></table>
    <div class="row" style="margin-top:10px"><button type="button" class="btn" id="addzone">＋ Add zone</button><button class="btn primary">Save zones</button></div><p class="muted small" style="margin-top:8px">The WhatsApp list shows the first 9 active zones plus “Other / outside Jaipur”. Architects are matched to zones in Team → People.</p></form>`;
}

function faqs(d) {
  return html`<div class="row between" style="margin-bottom:10px"><span class="muted">The bot sends only these approved answers. Keywords (comma separated) help match questions when AI is off. Please check every answer before going live.</span><button class="btn primary" data-faq="new">＋ Add answer</button></div>
    <div class="stack">${d.faqs.map((f) => html`<article class="card"><header><b>${f.question}</b><div class="row">${f.active ? badge('active') : html`<span class="badge muted">off</span>`}<button class="btn small" data-faq="${f.id}">Edit</button></div></header><p>${f.answer_en}</p>${f.answer_hi ? html`<p class="ink2">${f.answer_hi}</p>` : ''}<div class="muted small">Keywords: ${f.keywords}</div></article>`)}</div>`;
}

function holidays(d) {
  return html`<form class="card row" id="holform"><input type="date" name="day" required style="max-width:200px"><input name="name" placeholder="e.g. Diwali" style="max-width:260px"><button class="btn primary">Add holiday</button></form>
    <div class="card flush" style="margin-top:12px">${d.holidays.length ? html`<table class="t"><tbody>${d.holidays.map((h) => html`<tr><td>${h.day}</td><td>${h.name}</td><td class="r"><button class="btn small ghost" data-delhol="${h.day}">Remove</button></td></tr>`)}</tbody></table>` : empty('No holidays added', 'No visits are offered and attendance is not expected on holidays.')}</div>`;
}

function routines(d) {
  return html`<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Routine</th><th>When (IST)</th><th>Last run</th><th>Result</th><th></th></tr></thead><tbody>${d.system.routines.map((r) => html`<tr><td><b>${r.label}</b><div class="muted small"><code>${r.name}</code></div></td><td>${r.when.type === 'daily' ? `daily ${r.when.time}` : r.when.type === 'monthly' ? `monthly, day ${r.when.day} ${r.when.time}` : `hourly at :${String(r.when.minute).padStart(2, '0')}`}</td><td>${r.last ? html`${dt(r.last.started_at)} <span class="muted small">(${r.last.trigger})</span>` : 'never'}</td><td>${r.last ? html`${badge(r.last.status, { done: 'good', failed: 'bad', running: 'warn' })}<div class="muted small">${JSON.stringify(r.last.result || {}).slice(0, 120)}</div>` : ''}</td><td><button class="btn small" data-run="${r.name}">Run now</button></td></tr>`)}</tbody></table></div></div>
    <p class="muted small" style="margin-top:8px">With <code>ROUTINES_MODE=n8n</code>, n8n triggers these on its schedule and the backend steps in ${'20'} minutes later if n8n missed one. “Run now” always runs immediately.</p>`;
}

function account(user) {
  return html`<section class="card stack"><h2>Account security</h2><p>Change your password and manage authenticator verification and recovery codes.</p><a class="btn primary" href="#/security">Open my security settings</a></section>`;
}

export default {
  title: 'Settings',
  topics: ['settings'],
  async render(ctx) {
    const tab = ctx.query.tab || 'connections';
    const d = await api.get('/api/settings');
    const st = d.settings;
    const body = { connections: () => connections(d, ctx.user), business: () => business(st), automation: () => automation(st), zones: () => zones(d), faqs: () => faqs(d), holidays: () => holidays(d), routines: () => routines(d), account: () => account(ctx.user) }[tab]();
    return html`<div class="page-head"><div><h1>Settings</h1><div class="sub">Connections, business rules and the bot's approved answers.</div></div></div>
      <nav class="tabs">${TABS.map(([k, l]) => html`<a class="${k === tab ? 'on' : ''}" href="#/settings?tab=${k}">${l}</a>`)}</nav>${body}`;
  },
  mount(root, ctx) {
    const save = async (patch) => { await api.patch('/api/settings', patch); toast('Saved'); };
    const fail = (e) => toast(e.message, 'err');
    on(root, 'click', '[data-copy]', (e, el) => { navigator.clipboard?.writeText(el.dataset.copy).then(() => toast('Copied'), () => toast('Copy failed', 'err')); });
    on(root, 'submit', '#testwa', async (e, f) => { e.preventDefault(); try { await api.post('/api/settings/test-whatsapp', { to: f.to.value }); toast('Test message queued — check Messages'); } catch (err) { fail(err); } });
    on(root, 'submit', '#bizform', async (e, f) => {
      e.preventDefault(); const d = formData(f);
      try { await save({ business_hours: { open: d.open, close: d.close, days: [0, 1, 2, 3, 4, 5, 6] }, office: { name: d.office_name, lat: Number(d.office_lat), lng: Number(d.office_lng), radius_m: Number(d.office_radius) }, gst_pct: Number(d.gst_pct), payment_terms_days: Number(d.payment_terms_days), warranty_years: Number(d.warranty_years), payment_instructions: d.payment_instructions, owner_whatsapp_alerts: d.owner_whatsapp_alerts }); } catch (err) { fail(err); }
    });
    on(root, 'submit', '#autoform', async (e, f) => {
      e.preventDefault(); const d = formData(f);
      const nums = ['visit_duration_min', 'visit_buffer_min', 'slot_days_ahead', 'min_lead_time_min', 'offer_timeout_min', 'client_confirm_timeout_min', 'max_offer_attempts', 'approval_sla_min', 'human_sla_min', 'human_release_min', 'bot_max_per_hour', 'lead_nudge_after_h', 'lead_stale_after_h', 'report_due_h', 'quote_validity_days', 'sim_fail_rate'];
      const patch = { visit_slots: d.visit_slots.split(',').map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x)).map((x) => x.padStart(5, '0')), digest_time: d.digest_time, auto_approve_leads: d.auto_approve_leads };
      for (const k of nums) patch[k] = Number(d[k]);
      try { await save(patch); } catch (err) { fail(err); }
    });
    on(root, 'click', '#addzone', () => { root.querySelector('#zrows').insertAdjacentHTML('beforeend', '<tr><td><input name="code" placeholder="e.g. bani_park"></td><td><input name="name"></td><td><input name="name_hi"></td><td><input name="lat" type="number" step="any"></td><td><input name="lng" type="number" step="any"></td><td><input type="checkbox" name="active" checked></td></tr>'); });
    on(root, 'submit', '#zoneform', async (e, f) => {
      e.preventDefault();
      const zones = [...f.querySelectorAll('#zrows tr')].map((tr) => ({ code: tr.querySelector('[name=code]').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'), name: tr.querySelector('[name=name]').value.trim(), name_hi: tr.querySelector('[name=name_hi]').value.trim(), lat: tr.querySelector('[name=lat]').value === '' ? null : Number(tr.querySelector('[name=lat]').value), lng: tr.querySelector('[name=lng]').value === '' ? null : Number(tr.querySelector('[name=lng]').value), active: tr.querySelector('[name=active]').checked })).filter((z) => z.code && z.name);
      try { await api.put('/api/zones', { zones }); toast('Zones saved'); ctx.app.refresh(); } catch (err) { fail(err); }
    });
    on(root, 'click', '[data-faq]', async (e, el) => {
      const d = await api.get('/api/settings');
      const f = el.dataset.faq === 'new' ? {} : d.faqs.find((x) => String(x.id) === el.dataset.faq);
      try {
        await modal({ title: f.id ? 'Edit answer' : 'New answer', wide: true, body: html`<label class="field"><span>Question</span><input name="question" required value="${f.question || ''}"></label><label class="field" style="margin-top:10px"><span>Answer (English)</span><textarea name="answer_en" required>${f.answer_en || ''}</textarea></label><label class="field" style="margin-top:10px"><span>Answer (Hindi)</span><textarea name="answer_hi">${f.answer_hi || ''}</textarea></label><label class="field" style="margin-top:10px"><span>Keywords</span><input name="keywords" value="${f.keywords || ''}" placeholder="rate, price, kitna"></label><label class="check" style="margin-top:10px"><input type="checkbox" name="active" ${f.id ? (f.active ? 'checked' : '') : 'checked'}> Active</label>`,
          onSubmit: (v) => (f.id ? api.patch(`/api/faqs/${f.id}`, v) : api.post('/api/faqs', v)) });
        ctx.app.refresh();
      } catch (err) { fail(err); }
    });
    on(root, 'submit', '#holform', async (e, f) => { e.preventDefault(); try { await api.post('/api/holidays', formData(f)); ctx.app.refresh(); } catch (err) { fail(err); } });
    on(root, 'click', '[data-delhol]', async (e, el) => { try { await api.del(`/api/holidays/${el.dataset.delhol}`); ctx.app.refresh(); } catch (err) { fail(err); } });
    on(root, 'click', '[data-run]', async (e, el) => { el.disabled = true; try { const r = await api.post(`/api/routines/${el.dataset.run}/run`, { force: true }); toast(r.ok ? 'Done' : r.error || r.reason || 'Skipped', r.ok ? 'ok' : 'err'); ctx.app.refresh(); } catch (err) { fail(err); el.disabled = false; } });
  },
};
