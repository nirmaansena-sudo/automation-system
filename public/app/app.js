// Employee / architect / supervisor app: check-in with GPS, visit offers,
// visit reports, daily site logs, tasks, leave and expenses. Works offline:
// actions are queued on the phone and synced when the connection returns.
import { html, raw, api, setToken, $, on, toast, modal, formData, dt, date, time, ago, inr, badge, empty, label, options, readImage, todayIst } from '/shared/ui.js';
import { IndexedStore, UserQueue } from '/app/offline.js';
import { travelVisitCard, travelProfileCard, bindTravel } from '/app/travel.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
let me = null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const offlineStore = new IndexedStore();
let userQueue = null;
let activeUser = null;
function setIdentity(user) {
  activeUser = user || null;
  if (!user || userQueue?.userId !== user.id) userQueue = user ? new UserQueue(offlineStore, user.id) : null;
  store.set('ns_user', user || null);
}
function clearLogin() { setToken(null); store.set('ns_token', null); setIdentity(null); me = null; }
async function appGet(path) {
  const owner = userQueue;
  try {
    const result = await api.get(path);
    if (path === '/api/app/me') setIdentity(result.user);
    const target = path === '/api/app/me' ? userQueue : owner;
    if (target && target.userId === userQueue?.userId) await target.cache(path, result).catch(() => {});
    return result;
  } catch (error) {
    if (error.status === 401) { clearLogin(); throw error; }
    if (error.offline && userQueue && owner?.userId === userQueue.userId) {
      const saved = await owner.cached(path).catch(() => null);
      if (saved) return saved.value;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- offline queue
async function enqueue(item) {
  if (!userQueue) throw new Error('Log in before saving offline work');
  try { await userQueue.add({ ...item, client_event_id: item.client_event_id || uid(), device_time: item.device_time || new Date().toISOString() }); }
  catch (error) { throw new Error(`Work was not saved: ${error.message}. Keep this form open and connect to the internet.`); }
  renderOfflineBar(); return true;
}
let syncing = false;
async function sync() {
  if (syncing || !navigator.onLine || !userQueue) return;
  const owner = userQueue;
  syncing = true;
  try {
    const identity = await api.get('/api/app/me');
    if (identity.user.id !== owner.userId || userQueue !== owner) return;
    const q = await owner.items();
    const batch = q.filter((x) => x.queue_status !== 'needs_review').slice(0, 2);
    if (!batch.length) return;
    const res = await api.post('/api/app/sync', { items: batch });
    await owner.applyResults(batch, res);
    const errors = res.filter((r) => r.error);
    if (userQueue !== owner) return;
    if (errors.length) toast(`${errors.length} saved item(s) need review. Open Saved work; your data has been kept.`, 'err');
    else toast(`Synced ${batch.length} saved item(s)`);
    renderOfflineBar();
    if ((await owner.items()).some((x) => x.queue_status !== 'needs_review')) setTimeout(sync, 500);
  } catch (e) { if (e.status === 401) { clearLogin(); render(); } else if (!e.offline) toast(e.message, 'err'); } finally { syncing = false; }
}
window.addEventListener('online', () => { renderOfflineBar(); sync(); });
window.addEventListener('offline', renderOfflineBar);
setInterval(sync, 30000);
async function renderOfflineBar() {
  const bar = $('#offbar'); if (!bar) return;
  const q = userQueue ? await userQueue.items().catch(() => []) : [];
  const n = q.length; const review = q.filter((x) => x.queue_status === 'needs_review').length;
  bar.className = !navigator.onLine || n ? 'offline' : 'hide';
  bar.innerHTML = String(html`${!navigator.onLine ? 'Offline — showing saved information. ' : ''}${n ? `${n} saved item(s), ${review} need review. ` : ''}<a href="#/saved">Saved work</a>`);
}
/** Try online; if the network fails, queue it. */
async function sendOrQueue(type, path, body) {
  if (!userQueue) throw new Error('Log in before saving work');
  const item = { type, ...body, owner_user_id: userQueue.userId, client_event_id: body.client_event_id || uid(), device_time: new Date().toISOString() };
  if (!navigator.onLine) { await enqueue(item); return { queued: true }; }
  try { return await api.post(path, item); } catch (e) { if (e.offline) { await enqueue(item); return { queued: true }; } throw e; }
}

async function savedScreen() {
  const items = await userQueue.items();
  return shell('me', html`<div class="sec"><h2>Saved work</h2><p class="muted">Items stay on this device until the server accepts them. Rejected items are kept for correction or review.</p>
    ${items.map((item) => html`<div class="card"><b>${label(item.type)} · ${dt(item.device_time)}</b><p>${item.queue_error || 'Waiting to send'}</p><div class="row"><button class="btn small" data-retry="${item.client_event_id}">Retry</button><button class="btn small" data-edit-saved="${item.client_event_id}">Correct note</button><button class="btn small" data-discard="${item.client_event_id}">Discard</button></div></div>`)}
    ${!items.length ? empty('No saved items') : ''}
    ${store.get('ns_queue', []).length ? html`<div class="notice warn">Older saved items cannot be safely matched to an employee. They have been kept; ask your manager to verify them.<button class="btn" id="legacy-export">Download recovery file</button></div>` : ''}</div>`);
}

// ---------------------------------------------------------------- GPS
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ error: 'This phone/browser has no location support' });
    if (!window.isSecureContext) return resolve({ error: 'Location needs a secure (https) link. Your check-in will be saved and reviewed by the manager.' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: Math.round(p.coords.accuracy) }),
      (err) => resolve({ error: err.code === 1 ? 'Location permission denied — allow location for this site' : 'Could not get location (try near a window)' }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

// ---------------------------------------------------------------- screens
function shell(active, body) {
  return html`<div class="appbar"><div class="brand" style="padding:0"><div class="mark">NS</div></div><div class="grow"><b>${me.user.name.split(' ')[0]}</b><div class="muted small">${label(me.user.role)}</div></div>
    <button class="icon-btn" id="refresh" aria-label="Refresh">⟳</button></div><div id="offbar" class="hide"></div>${body}
    <nav class="tabbar">${[['home', '🏠', 'Today'], ['tasks', '☑', 'Tasks'], ['sites', '🏗', 'Sites'], ['requests', '🗂', 'Requests'], ['me', '👤', 'Me']].map(([k, i, l]) => html`<a href="#/${k}" class="${active === k ? 'on' : ''}"><b>${i}</b>${l}</a>`)}</nav>`;
}

async function homeScreen() {
  me = await appGet('/api/app/me');
  const ev = me.events;
  return shell('home', html`<div class="sec">
    <div class="card"><div class="row between"><div><div class="muted small">${date(me.day)}</div><div style="font-size:18px;font-weight:700;margin-top:2px">${me.checkedIn ? '🟢 Checked in' : ev.length ? '⚪ Checked out' : '⚪ Not checked in'}</div>
      ${ev.length ? html`<div class="muted small">${ev.map((e) => `${e.kind === 'in' ? 'In' : 'Out'} ${time(e.at)}${e.place ? ` · ${e.place}` : ''}${e.validation === 'needs_review' ? ' (review)' : ''}`).join(' · ')}</div>` : ''}</div></div>
      <button class="btn primary big" style="margin-top:14px" id="punch" data-kind="${me.checkedIn ? 'out' : 'in'}">${me.checkedIn ? 'Check out' : 'Check in'}</button>
      <label class="check small" style="margin-top:10px"><input type="checkbox" id="selfie"> Add a selfie</label>
      <p class="muted small" style="margin-top:6px">Your GPS position is recorded only when you check in or out, post a site log or start a visit.</p></div></div>
    ${me.offers.length ? html`<div class="sec"><h2>Visit requests</h2>${me.offers.map((o) => html`<div class="card"><div class="row between"><b>${o.ref}</b><span class="badge warn">reply ${ago(o.expires_at)}</span></div><div style="margin-top:6px">🕒 <b>${dt(o.slot_start)}</b></div><div class="ink2">📍 ${o.place}</div><div class="ink2">🛠 ${o.services} · ${o.nature} · ${o.area}</div>
      <div class="row" style="margin-top:10px"><button class="btn primary" data-offer="${o.id}" data-rev="${o.revision}" data-acc="1">Accept</button><button class="btn" data-offer="${o.id}" data-rev="${o.revision}" data-acc="0">Decline</button></div></div>`)}</div>` : ''}
    ${me.visits.length ? html`<div class="sec"><h2>My visits</h2>${me.visits.map((v) => html`<a class="card" style="display:block;text-decoration:none" href="#/visit/${v.id}"><div class="row between"><b>${dt(v.start_at)}</b>${badge(v.status)}</div><div class="ink2">${v.client || ''} · ${v.place}</div><div class="muted small">${v.ref}</div></a>`)}</div>` : ''}
    <div class="sec"><h2>Today's tasks</h2>${me.tasks.length ? me.tasks.slice(0, 5).map(taskCard) : html`<div class="card muted">No open tasks 👍</div>`}${me.tasks.length > 5 ? html`<a class="link" href="#/tasks">All ${me.tasks.length} tasks</a>` : ''}</div>
    ${me.projects.length ? html`<div class="sec"><h2>My sites</h2>${me.projects.map((p) => html`<a class="card" style="display:block;text-decoration:none" href="#/site/${p.id}"><div class="row between"><b>${p.ref}</b>${badge(p.status)}</div><div class="ink2">${p.name}</div><div class="link small" style="margin-top:4px">＋ Post today's site log</div></a>`)}</div>` : ''}`);
}

function taskCard(t) {
  return html`<div class="card"><div class="row between"><b>${t.title}</b>${badge(t.priority)}</div>${t.description ? html`<div class="ink2 small pre" style="margin-top:4px">${t.description.slice(0, 300)}</div>` : ''}
    <div class="muted small" style="margin-top:4px">${t.due_at ? `Due ${dt(t.due_at)}` : ''} · ${label(t.status)}</div>
    <div class="row" style="margin-top:8px">${t.status !== 'in_progress' ? html`<button class="btn small" data-task="${t.id}" data-st="in_progress">Start</button>` : ''}<button class="btn small primary" data-task="${t.id}" data-st="done">Done</button><button class="btn small ghost" data-task="${t.id}" data-st="blocked">Blocked</button></div></div>`;
}

async function tasksScreen() { me = await appGet('/api/app/me'); return shell('tasks', html`<div class="sec"><h2>My tasks</h2>${me.tasks.length ? me.tasks.map(taskCard) : empty('No open tasks')}</div>`); }

async function sitesScreen() {
  me = await appGet('/api/app/me');
  return shell('sites', html`<div class="sec"><h2>My sites</h2>${me.projects.length ? me.projects.map((p) => html`<a class="card" style="display:block;text-decoration:none" href="#/site/${p.id}"><b>${p.ref}</b><div class="ink2">${p.name}</div></a>`) : empty('No sites assigned', 'Your manager assigns you to projects.')}</div>`);
}

async function siteScreen(id) {
  const d = await appGet(`/api/app/projects/${id}`);
  const open = d.milestones.filter((m) => ['in_progress', 'rework'].includes(m.status));
  return shell('sites', html`<div class="sec"><a class="link" href="#/sites">‹ Sites</a><h1 style="margin-top:6px">${d.project.ref}</h1><div class="ink2">${d.project.name}</div><a class="link small" target="_blank" rel="noopener" href="${d.project.maps}">📍 Open in Maps</a></div>
    <div class="sec"><h2>Today's site log</h2><form class="card stack" id="logform">
      <label class="field"><span>Work done today</span><textarea name="work_done" required placeholder="e.g. Brickwork on first floor east wall, 3 courses"></textarea></label>
      <div class="form-grid"><label class="field"><span>Stage</span><select name="milestone_id">${options(open.map((m) => ({ value: m.id, label: m.name })), open[0]?.id || '', { blank: '—' })}</select></label><label class="field"><span>Stage progress %</span><input name="progress" type="number" min="0" max="99" inputmode="numeric"></label></div>
      <div class="form-grid">${['mason', 'helper', 'carpenter', 'bar_bender', 'plumber', 'electrician'].map((k) => html`<label class="field"><span>${label(k)}s</span><input name="lab_${k}" type="number" min="0" inputmode="numeric"></label>`)}</div>
      <label class="field"><span>Materials received / used</span><input name="materials"></label>
      <label class="field"><span>Issues (alerts the manager)</span><input name="issues"></label>
      <label class="field"><span>Photos (up to 5)</span><input type="file" name="photos" accept="image/*" capture="environment" multiple></label>
      <label class="check"><input type="checkbox" name="client_visible" checked> Include in client's 7 PM update</label>
      <button class="btn primary">Save log</button></form></div>
    <div class="sec"><h2>Stages</h2>${d.milestones.map((m) => html`<div class="card"><div class="row between"><b>${m.seq}. ${m.name}</b>${badge(m.status)}</div>${m.review_note && m.status === 'rework' ? html`<div class="notice bad small" style="margin-top:6px">Rework: ${m.review_note}</div>` : ''}
      <div class="progress" style="margin-top:8px"><i style="width:${m.progress}%"></i></div>${['in_progress', 'rework'].includes(m.status) ? html`<button class="btn small" style="margin-top:8px" data-ready="${m.id}">Stage complete → request quality check</button>` : ''}</div>`)}</div>
    <div class="sec"><h2>Recent logs</h2>${d.logs.map((l) => html`<div class="card"><b>${date(l.log_date)}</b><div class="ink2 small pre">${l.work_done || ''}</div></div>`)}</div>`);
}

async function visitScreen(id) {
  const d = await appGet(`/api/app/visits/${id}`);
  const v = d.visit; const c = d.client;
  return shell('home', html`<div class="sec"><a class="link" href="#/home">‹ Today</a><h1 style="margin-top:6px">${v.ref}</h1><div class="ink2">${dt(v.start_at)} · ${badge(v.status)}</div></div>
    <div class="sec"><div class="card"><dl class="kv"><dt>Work</dt><dd>${d.lead.services} · ${d.lead.nature} · ${d.lead.area}</dd><dt>Area</dt><dd>${d.lead.place}</dd><dt>Notes</dt><dd>${d.lead.requirements || '—'}</dd></dl>
      ${c ? html`<div class="divider"></div><dl class="kv"><dt>Client</dt><dd><b>${c.name || ''}</b></dd><dt>Phone</dt><dd><a class="link" href="tel:+${c.tel}">${c.phone}</a></dd><dt>Address</dt><dd>${c.address || '—'}</dd></dl>
        <div class="row" style="margin-top:10px"><a class="btn primary" target="_blank" rel="noopener" href="${c.maps}">📍 Navigate</a><a class="btn" href="tel:+${c.tel}">📞 Call</a><a class="btn" target="_blank" rel="noopener" href="https://wa.me/${c.tel}">WhatsApp</a></div>` : html`<p class="muted small">Client details appear after the client confirms.</p>`}</div></div>
    ${v.status === 'confirmed' ? html`<div class="sec"><button class="btn primary big" id="vstart">I have reached the site — start visit</button><button class="btn big" style="margin-top:8px" id="vnoshow">Client not available</button></div>` : ''}
    ${['confirmed', 'in_progress'].includes(v.status) ? html`<div class="sec"><h2>Site report</h2><form class="card stack" id="report">
      <label class="field"><span>Measurements</span><textarea name="measurements" placeholder="Plot size, road width, facing, levels"></textarea></label>
      <label class="field"><span>Scope agreed</span><textarea name="scope" placeholder="e.g. G+1, 3 BHK, parking, terrace garden"></textarea></label>
      <label class="field"><span>Site constraints</span><input name="constraints" placeholder="Access, soil, neighbours, water"></label>
      <label class="field"><span>Recommendation</span><input name="recommendation" placeholder="e.g. Turnkey with material"></label>
      <div class="form-grid"><label class="field"><span>Budget range</span><input name="budget_range" placeholder="e.g. 40–45 L"></label><label class="field"><span>Client interest</span><select name="interest">${options(['high', 'medium', 'low'])}</select></label></div>
      <label class="field"><span>Notes</span><textarea name="notes"></textarea></label><label class="field"><span>Photos (up to 8)</span><input type="file" name="photos" accept="image/*" capture="environment" multiple></label>
      <button class="btn primary">Submit report</button></form></div>` : ''}
    ${v.report ? html`<div class="sec"><h2>Submitted report</h2><div class="card small"><pre class="pre" style="margin:0;font-family:inherit">${Object.entries(v.report).filter(([, x]) => x).map(([k, x]) => `${label(k)}: ${x}`).join('\n')}</pre></div></div>` : ''}${await travelVisitCard(id).catch(() => '')}`);
}

async function requestsScreen() {
  const d = await appGet('/api/app/requests');
  me = me || await appGet('/api/app/me');
  return shell('requests', html`<div class="sec"><div class="row"><button class="btn primary" id="leave">Apply for leave</button><button class="btn" id="expense">Claim expense</button></div></div>
    <div class="sec"><h2>Leave</h2>${d.leave.length ? d.leave.map((l) => html`<div class="card"><div class="row between"><b>${date(l.from_date)}${l.to_date !== l.from_date ? ` → ${date(l.to_date)}` : ''}</b>${badge(l.status)}</div><div class="muted small">${l.type}${l.reason ? ` · ${l.reason}` : ''}${l.decision_note ? ` · ${l.decision_note}` : ''}</div></div>`) : html`<div class="card muted">No leave requests</div>`}</div>
    <div class="sec"><h2>Expenses</h2>${d.expenses.length ? d.expenses.map((x) => html`<div class="card"><div class="row between"><b>${inr(x.amount)} · ${label(x.category)}</b>${badge(x.status)}</div><div class="muted small">${date(x.claim_date)}${x.description ? ` · ${x.description}` : ''}</div></div>`) : html`<div class="card muted">No expense claims</div>`}</div>`);
}

async function meScreen() {
  const a = await appGet('/api/app/attendance');
  const dashboardRole = ['owner', 'manager', 'finance'].includes(me.user.role);
  const CODE = { present: 'P', late: 'L', half_day: '½', absent: 'A', leave: 'LV', needs_review: '?', weekly_off: '–', holiday: 'H', not_checked_in: '·' };
  const TONE = { present: 'good', late: 'warn', half_day: 'warn', absent: 'bad', leave: 'info', needs_review: 'bad' };
  return shell('me', html`<div class="sec"><h2>Attendance · ${a.month}</h2><div class="card"><div class="row" style="gap:4px">${a.days.map((d) => html`<span class="reg"><span class="cell ${TONE[d.status] || 'muted'}" style="display:inline-grid" title="${d.day}: ${label(d.status)}">${CODE[d.status] || '?'}</span></span>`)}</div>
      <p class="muted small" style="margin-top:8px">P present · L late · ½ half day · A absent · LV leave · ? under review</p></div></div>
    <div class="sec"><h2>Change PIN</h2><form class="card stack" id="pin"><label class="field"><span>${dashboardRole ? 'Current password' : 'Current PIN'}</span><input name="${dashboardRole ? 'current_password' : 'current_pin'}" type="password" autocomplete="current-password" required></label><label class="field"><span>New PIN (4–8 digits)</span><input name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" required></label><label class="field"><span>Authenticator code (if enabled)</span><input name="mfa_code" inputmode="numeric" autocomplete="one-time-code"></label><button class="btn">Save PIN</button></form></div>
    ${await travelProfileCard().catch(() => '')}<div class="sec"><a class="btn" href="#/saved">Saved work and sync errors</a></div>
    <div class="sec"><button class="btn big" id="logout">Log out</button><p class="muted small" style="margin-top:10px">Tip: add this page to your home screen (browser menu → “Add to Home screen”) to use it like an app.</p></div>`);
}

function loginScreen(msg) {
  return html`<div class="auth-wrap"><form class="card auth-card stack" id="login"><div class="brand" style="padding:0"><div class="mark">NS</div><div><b>Nirmaan Sena</b><span>Team app</span></div></div>
    ${msg ? html`<div class="notice warn">${msg}</div>` : ''}<label class="field"><span>Your phone number</span><input name="phone" inputmode="tel" required autocomplete="tel" placeholder="98xxxxxxxx"></label>
    <label class="field"><span>PIN</span><input name="pin" type="password" inputmode="numeric" required autocomplete="current-password"></label><label class="field"><span>Authenticator code (if enabled)</span><input name="mfa_code" inputmode="numeric" autocomplete="one-time-code"></label><div class="form-error" role="alert"></div><button class="btn primary big">Log in</button>
    <p class="muted small">Your manager gives you the PIN. Managers use the dashboard at <a class="link" href="/admin/">/admin/</a>.</p></form></div>`;
}

// ---------------------------------------------------------------- router & actions
async function render() {
  const root = $('#root');
  const [name, id] = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  try {
    if (!store.get('ns_token', null)) { root.innerHTML = String(loginScreen()); return; }
    if (!me) me = await appGet('/api/app/me');
    const screens = { home: homeScreen, tasks: tasksScreen, sites: sitesScreen, site: () => siteScreen(id), visit: () => visitScreen(id), requests: requestsScreen, me: meScreen, saved: savedScreen };
    const out = await (screens[name] || homeScreen)();
    root.innerHTML = String(out);
    renderOfflineBar();
  } catch (e) {
    if (e.status === 401) { clearLogin(); root.innerHTML = String(loginScreen()); return; }
    if (e.offline && userQueue) { root.innerHTML = String(html`<div class="auth-wrap"><div class="card stack"><b>You are offline</b><p class="muted">This page has not been saved for offline use. You can record attendance for ${activeUser?.name || 'your account'}.</p><button class="btn primary big" id="punch" data-kind="in">Check in (offline)</button><button class="btn big" id="punchout" data-kind="out">Check out (offline)</button><a href="#/home">Saved home</a></div></div>`); return; }
    root.innerHTML = String(html`<div class="sec"><div class="notice bad">${e.message}</div></div>`);
  }
}

async function punch(kind) {
  const selfieWanted = $('#selfie')?.checked;
  toast('Getting your location…');
  const loc = await locate();
  let photo = null;
  if (selfieWanted) {
    photo = await new Promise((resolve) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'user';
      input.onchange = async () => { try { resolve(input.files[0] ? await readImage(input.files[0], 800, 0.7) : null); } catch { resolve(null); } };
      input.click();
    });
  }
  if (loc.error) toast(loc.error, 'err');
  const body = { kind, lat: loc.lat ?? null, lng: loc.lng ?? null, accuracy_m: loc.accuracy_m ?? null, photo };
  try {
    const r = await sendOrQueue('attendance', '/api/app/attendance', body);
    if (r.queued) toast('Saved on this phone — will be sent when online');
    else toast(r.validation === 'accepted' ? `${kind === 'in' ? 'Checked in' : 'Checked out'}${r.place ? ` at ${r.place}` : ''} ✅` : `Recorded — your manager will review (${r.reasons.join(', ')})`, r.validation === 'accepted' ? 'ok' : 'err');
  } catch (e) { toast(e.message, 'err'); }
  render();
}

async function photosFrom(input, max) { const out = []; for (const f of [...(input?.files || [])].slice(0, max)) out.push(await readImage(f, 1280, 0.72)); return out; }

function bind() {
  const root = $('#root');
  bindTravel(root, { refresh: render });
  on(root, 'submit', '#login', async (e, f) => {
    e.preventDefault(); const err = f.querySelector('.form-error'); err.textContent = '';
    try { const r = await api.post('/api/auth/app-login', formData(f)); setToken(r.token); store.set('ns_token', r.token); setIdentity(r.user); me = null; location.hash = '#/home'; await render(); sync(); } catch (ex) { err.textContent = ex.message; }
  });
  on(root, 'click', '#punch, #punchout', (e, el) => punch(el.dataset.kind));
  on(root, 'click', '#refresh', () => { sync(); render(); });
  on(root, 'click', '[data-offer]', async (e, el) => {
    const accept = el.dataset.acc === '1';
    let reason = null;
    if (!accept) { const r = await modal({ title: 'Decline visit', submit: 'Decline', body: html`<label class="field"><span>Reason (optional)</span><input name="reason" placeholder="e.g. Another site visit at that time"></label>` }); if (!r) return; reason = r.reason; }
    try { await api.post(`/api/app/offers/${el.dataset.offer}/respond`, { accept, revision: Number(el.dataset.rev), reason }); toast(accept ? 'Accepted — waiting for the client to confirm' : 'Declined'); } catch (err) { toast(err.message, 'err'); }
    render();
  });
  on(root, 'click', '[data-task]', async (e, el) => {
    let note = null;
    if (el.dataset.st !== 'in_progress') { const r = await modal({ title: el.dataset.st === 'done' ? 'Mark done' : 'Blocked', submit: 'Save', body: html`<label class="field"><span>Note (optional)</span><input name="note"></label>` }); if (!r) return; note = r.note; }
    const item = { type: 'task', id: Number(el.dataset.task), status: el.dataset.st, note };
    try {
      if (!navigator.onLine) { await enqueue(item); toast('Saved — will sync'); }
      else {
        try { await api.patch(`/api/app/tasks/${item.id}`, { status: item.status, note }); toast('Updated'); }
        catch (err) { if (err.offline) { await enqueue(item); toast('Saved — will sync'); } else throw err; }
      }
    } catch (err) { toast(err.message, 'err'); }
    render();
  });
  on(root, 'submit', '#logform', async (e, f) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      const d = formData(f);
      const labour = {}; for (const [k, v] of Object.entries(d)) if (k.startsWith('lab_') && Number(v) > 0) labour[k.slice(4)] = Number(v);
      const loc = await locate();
      const photos = await photosFrom(f.photos, 5);
      const id = location.hash.split('/')[2];
      const body = { project_id: Number(id), work_done: d.work_done, milestone_id: d.milestone_id ? Number(d.milestone_id) : null, progress: d.progress === '' ? null : Number(d.progress), labour, materials: d.materials, issues: d.issues, client_visible: d.client_visible, photos, lat: loc.lat ?? null, lng: loc.lng ?? null, log_date: todayIst() };
      const r = await sendOrQueue('site_log', `/api/app/projects/${id}/logs`, body);
      toast(r.queued ? 'Saved on this phone — will be sent when online' : 'Site log saved ✅');
      f.reset();
    } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
  });
  on(root, 'click', '[data-ready]', async (e, el) => {
    const r = await modal({ title: 'Stage complete?', submit: 'Request quality check', body: html`<p class="muted">Make sure today's log has photos of the finished work.</p><label class="field"><span>Note for the reviewer</span><textarea name="note"></textarea></label>` });
    if (!r) return;
    try { await api.post(`/api/app/milestones/${el.dataset.ready}/ready`, { note: r.note }); toast('Sent for quality check'); render(); } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'click', '#vstart', async () => {
    const id = location.hash.split('/')[2]; const loc = await locate();
    try { const r = await api.post(`/api/app/visits/${id}/checkin`, loc.error ? {} : loc); toast(r.distance_m !== null && r.distance_m !== undefined ? `Visit started — ${r.distance_m} m from the client's pin` : 'Visit started'); render(); } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'click', '#vnoshow', async () => {
    const id = location.hash.split('/')[2];
    const ok = await modal({ title: 'Client not available?', submit: 'Yes, inform client', danger: true, body: html`<p>The client gets a WhatsApp message to pick a new time and the manager gets a task.</p>` });
    if (!ok) return;
    try { await api.post(`/api/app/visits/${id}/no-show`); toast('Client informed'); render(); } catch (err) { toast(err.message, 'err'); }
  });
  on(root, 'submit', '#report', async (e, f) => {
    e.preventDefault(); const btn = f.querySelector('button[class*=primary]'); btn.disabled = true;
    try { const id = location.hash.split('/')[2]; const d = formData(f); const photos = await photosFrom(f.photos, 8); delete d.photos; await api.post(`/api/app/visits/${id}/report`, { ...d, photos }); toast('Report submitted ✅'); render(); } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });
  on(root, 'click', '#leave', async () => {
    const r = await modal({ title: 'Apply for leave', submit: 'Apply', body: html`<div class="form-grid"><label class="field"><span>From</span><input type="date" name="from_date" required value="${todayIst()}"></label><label class="field"><span>To</span><input type="date" name="to_date" required value="${todayIst()}"></label><label class="field"><span>Type</span><select name="type">${options(['casual', 'sick', 'earned', 'unpaid'])}</select></label><label class="field full"><span>Reason</span><input name="reason"></label></div>`, onSubmit: (d) => api.post('/api/app/leave', d) });
    if (r) { toast('Leave request sent'); render(); }
  });
  on(root, 'click', '#expense', async () => {
    const r = await modal({ title: 'Claim expense', submit: 'Submit', body: html`<div class="form-grid"><label class="field"><span>Category</span><select name="category">${options(['travel', 'fuel', 'material', 'food', 'tools', 'other'])}</select></label><label class="field"><span>Amount ₹</span><input name="amount" type="number" required inputmode="decimal"></label><label class="field"><span>Date</span><input type="date" name="claim_date" value="${todayIst()}"></label><label class="field"><span>Site</span><select name="project_id">${options((me?.projects || []).map((p) => ({ value: p.id, label: p.ref })), '', { blank: '—' })}</select></label><label class="field full"><span>Description</span><input name="description"></label><label class="field full"><span>Receipt photo</span><input type="file" name="receipt" accept="image/*,application/pdf" capture="environment"></label></div>`,
      onSubmit: async (d, form) => { const files = await photosFrom(form.receipt, 1); return api.post('/api/app/expenses', { category: d.category, amount: Number(d.amount), claim_date: d.claim_date, project_id: d.project_id ? Number(d.project_id) : null, description: d.description, receipt: files[0] || null }); } });
    if (r) { toast('Expense submitted'); render(); }
  });
  on(root, 'submit', '#pin', async (e, f) => { e.preventDefault(); try { await api.post('/api/me/password', formData(f)); clearLogin(); toast('PIN changed. Log in again.'); location.hash = ''; render(); } catch (err) { toast(err.message, 'err'); } });
  on(root, 'click', '#logout', async () => { try { await api.post('/api/auth/logout'); } catch { /* offline logout still removes local credentials */ } clearLogin(); location.hash = ''; render(); });
  on(root, 'click', '[data-retry]', async (e, el) => { try { await userQueue.retry(el.dataset.retry); await render(); sync(); } catch (err) { toast(err.message, 'err'); } });
  on(root, 'click', '[data-discard]', async (e, el) => {
    const owner = userQueue;
    const ok = await modal({ title: 'Discard saved work?', body: html`<p>This removes the unsent item from this phone. Download or copy anything you need first.</p>`, submit: 'Discard', danger: true, onSubmit: () => true });
    if (ok && owner === userQueue) { await owner.discard(el.dataset.discard); render(); }
  });
  on(root, 'click', '[data-edit-saved]', async (e, el) => {
    const owner = userQueue; const item = (await owner.items()).find((x) => x.client_event_id === el.dataset.editSaved);
    if (!item) return;
    const field = item.type === 'site_log' ? 'work_done' : 'note';
    const result = await modal({ title: 'Correct saved note', body: html`<label class="field"><span>Note / work done</span><textarea name="value">${item[field] || ''}</textarea></label><p class="muted">For GPS, date or assignment errors, ask your manager before retrying.</p>`, onSubmit: async (value) => { if (owner !== userQueue) throw new Error('Account changed'); await owner.add({ ...item, [field]: value.value }); return true; } });
    if (result) { render(); sync(); }
  });
  on(root, 'click', '#legacy-export', () => {
    const blob = new Blob([JSON.stringify(store.get('ns_queue', []), null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'legacy-offline-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
}

const saved = store.get('ns_token', null);
if (saved) { setToken(saved); const user = store.get('ns_user', null); if (user?.id) setIdentity(user); }
bind();
window.addEventListener('hashchange', render);
render().then(sync);
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
