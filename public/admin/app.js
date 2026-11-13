// Manager dashboard — shell, auth screens, router and live updates.
import { html, raw, api, $, on, toast, modal, formData, installTooltips, subscribe, ago, esc, label, watchTables, installDoubleTapGuard, isOnline } from '/shared/ui.js';

const NAV = [
  ['Run the business', [
    ['overview', '◎', 'Overview'], ['inbox', '💬', 'WhatsApp inbox', 'attention'], ['approvals', '✔', 'Approvals', 'approvals'],
    ['leads', '◆', 'Leads'], ['visits', '📍', 'Site visits'], ['travel', '⬡', 'Travel & dispatch'], ['projects', '🏗', 'Projects'], ['operations', '▦', 'Materials & costs'], ['clients', '👥', 'Clients'],
  ]],
  ['People', [['attendance', '◷', 'Attendance dashboard'], ['team', '👷', 'Team'], ['tasks', '☑', 'Tasks & tickets']]],
  ['WhatsApp', [['automation', '⚡', 'WhatsApp automation'], ['contacts', '☷', 'Contact directory'], ['messages', '✉', 'Messages'], ['simulator', '📱', 'WhatsApp simulator']]],
  ['Management', [['reports', '↧', 'Reports & exports'], ['costs', '₹', 'Usage & costs'], ['settings', '⚙', 'Settings'], ['security', '🔒', 'My security'], ['data', '🗄', 'Database & backups']]],
];
const VIEWS = {
  overview: (v = '') => import(`./views/overview.js${v}`), inbox: (v = '') => import(`./views/inbox.js${v}`), approvals: (v = '') => import(`./views/approvals.js${v}`),
  leads: (v = '') => import(`./views/leads.js${v}`), visits: (v = '') => import(`./views/visits.js${v}`), projects: (v = '') => import(`./views/projects.js${v}`),
  clients: (v = '') => import(`./views/clients.js${v}`), team: (v = '') => import(`./views/team.js${v}`), tasks: (v = '') => import(`./views/tasks.js${v}`),
  contacts: (v = '') => import(`./views/clients.js${v}`), attendance: (v = '') => import(`./views/attendance.js${v}`), reports: (v = '') => import(`./views/reports.js${v}`), automation: (v = '') => import(`./views/automation.js${v}`),
  messages: (v = '') => import(`./views/messages.js${v}`), data: (v = '') => import(`./views/data.js${v}`), settings: (v = '') => import(`./views/settings.js${v}`),
  simulator: (v = '') => import(`./views/simulator.js${v}`),
  travel: (v = '') => import(`./views/travel.js${v}`), operations: (v = '') => import(`./views/operations.js${v}`),
  costs: (v = '') => import(`./views/costs.js${v}`),
  security: (v = '') => import(`./views/security.js${v}`),
};

const app = { user: null, provider: 'simulator', view: null, route: null, counts: {}, pendingRefresh: false };
window.nsApp = app;

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '') || 'overview';
  const [pathPart, qs] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  return { name: parts[0] || 'overview', params: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export function go(path) { location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`; }
app.go = go;

// ---------------------------------------------------------------- auth screens
function renderSetup(st = {}) {
  $('#root').innerHTML = String(html`<div class="auth-wrap"><form class="card auth-card stack" id="setup">
    <div class="brand" style="padding:0"><div class="mark">NS</div><div><b>Nirmaan Sena</b><span>First-time setup</span></div></div>
    <p class="ink2">Create the owner account. You can add managers, architects and supervisors after this.</p>
    ${st.needsCode ? html`<label class="field"><span>Setup code <span class="hint">(shown in the server window / <code>docker compose logs app</code>)</span></span><input name="setup_code" required autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>` : ''}
    <label class="field"><span>Your name</span><input name="name" required autocomplete="name"></label>
    <label class="field"><span>Email (used to log in)</span><input name="email" type="email" required autocomplete="email"></label>
    <label class="field"><span>WhatsApp number <span class="hint">(for alerts; optional)</span></span><input name="phone" inputmode="tel" placeholder="98xxxxxxxx"></label>
    <label class="field"><span>Password <span class="hint">(at least 8 characters)</span></span><input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <label class="check"><input type="checkbox" name="demo" ${st.needsCode ? '' : 'checked'}> Load demo data (sample architects, supervisors, clients and a running project) so you can try everything</label>
    <div class="form-error" role="alert"></div>
    <button class="btn primary" type="submit">Create account and open dashboard</button>
  </form></div>`);
  $('#setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setup .form-error'); err.textContent = '';
    try {
      const r = await api.post('/api/setup', formData(e.target));
      if (r.demo?.pin) sessionStorageSafe('ns_demo_note', JSON.stringify(r.demo));
      boot();
    } catch (ex) { err.textContent = ex.message; }
  });
}
function sessionStorageSafe(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } return null; }

function renderLogin(msg = '') {
  $('#root').innerHTML = String(html`<div class="auth-wrap"><form class="card auth-card stack" id="login">
    <div class="brand" style="padding:0"><div class="mark">NS</div><div><b>Nirmaan Sena</b><span>Manager dashboard</span></div></div>
    ${msg ? html`<div class="notice warn">${msg}</div>` : ''}
    <label class="field"><span>Email or phone</span><input name="login" required autocomplete="username"></label>
    <label class="field"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
    <label class="field"><span>Authenticator or recovery code <span class="hint">(if enabled)</span></span><input name="mfa_code" autocomplete="one-time-code" spellcheck="false"></label>
    <div class="form-error" role="alert"></div>
    <button class="btn primary" type="submit">Log in</button>
    <p class="muted small">Architects, engineers and supervisors use the employee app at <a class="link" href="/app/">/app/</a>.</p>
  </form></div>`);
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login .form-error'); err.textContent = '';
    try { await api.post('/api/auth/login', formData(e.target)); boot(); } catch (ex) { err.textContent = ex.message; }
  });
}

// ---------------------------------------------------------------- shell
function renderShell() {
  const u = app.user;
  $('#root').innerHTML = String(html`<a class="skip" href="#content">Skip to content</a><div class="backdrop" id="backdrop"></div><div class="shell">
    <aside class="side" id="side" aria-label="Main menu">
      <div class="brand"><div class="mark">NS</div><div><b>Nirmaan Sena</b><span>Automation system</span></div></div>
      ${NAV.map(([group, items]) => html`<div class="nav-group">${group}</div><nav class="nav">${items.filter(([id]) => !(id === 'simulator' && app.provider !== 'simulator') && !(u.role === 'finance' && ['inbox', 'simulator', 'data', 'messages', 'contacts', 'automation', 'attendance', 'reports'].includes(id))).map(([id, ico, text, count]) => html`<a href="#/${id}" data-nav="${id}"><span class="ico" aria-hidden="true">${ico}</span>${text}${count ? html`<span class="count hide" data-count="${count}"></span>` : ''}</a>`)}</nav>`)}
      <div class="foot"><div class="who" title="${u.email || ''}">${u.name} · ${label(u.role)}</div><div class="row"><button class="btn small" id="theme" type="button" title="Switch between light, dark and automatic">◐ Theme</button><button class="btn small" id="logout" type="button">Log out</button></div></div>
    </aside>
    <div class="main">
      <div class="netbar" role="alert"><span>⚠ Cannot reach the system. Trying again…</span><button class="btn small" id="retry-net" type="button">Try now</button></div>
      <div class="top"><button class="icon-btn menu-btn" id="menu" aria-label="Open menu" aria-controls="side" aria-expanded="false">☰</button><div class="title" id="title"></div><div class="grow"></div>
        ${app.provider === 'simulator' ? html`<a class="badge warn" href="#/simulator" title="WhatsApp is in simulator mode — nothing reaches real phones">Simulator mode</a>` : html`<span class="badge good">WhatsApp live</span>`}
        <button class="icon-btn" id="bell" aria-label="Notifications">🔔<span class="dot hide" id="bell-dot"></span></button></div>
      <main class="content" id="content" tabindex="-1">${raw(skeleton())}</main>
    </div>
  </div>`);
  const setMenu = (open) => { document.body.classList.toggle('nav-open', open); $('#menu').setAttribute('aria-expanded', String(open)); };
  app.closeMenu = () => setMenu(false);
  $('#menu').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
  $('#backdrop').addEventListener('click', () => setMenu(false));
  $('#side').addEventListener('click', (e) => { if (e.target.closest('a[data-nav]')) setMenu(false); });
  $('#logout').addEventListener('click', async () => { try { await api.post('/api/auth/logout'); } catch { /* signed out locally anyway */ } location.reload(); });
  $('#theme').addEventListener('click', () => cycleTheme());
  $('#retry-net').addEventListener('click', () => checkConnection(true));
  watchTables($('#content'));
  $('#bell').addEventListener('click', openNotifications);
  const note = sessionStorageSafe('ns_demo_note');
  if (note) { try { sessionStorage.removeItem('ns_demo_note'); } catch { /* ignore */ } const d = JSON.parse(note); setTimeout(() => modal({ title: 'Demo data loaded', submit: 'Got it', cancel: null, body: html`<p>Sample architects, supervisors, clients, a running project and a pending approval were created.</p><ul><li>Manager login: <code>priya@demo.local</code> / <code>demo1234</code></li><li>Finance login: <code>neha@demo.local</code> / <code>demo1234</code></li><li>Employee app PIN for every demo staff member: <code>${d.pin}</code> (e.g. Rahul Mehta, phone 9800000101)</li></ul><p class="muted">Start with <b>WhatsApp simulator</b>: chat as a new client and watch the lead, approval, architect offer and visit happen. Delete demo users before going live.</p>`, onSubmit: () => true }), 300); }
}
/** Grey placeholders while the first page loads. */
function skeleton() { return '<div class="skeleton" style="height:28px;width:220px;margin-bottom:18px"></div><div class="grid g3"><div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:92px"></div></div><div class="skeleton" style="height:240px;margin-top:14px"></div>'; }

function cycleTheme() {
  const cur = document.documentElement.dataset.theme || 'auto';
  const next = cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto';
  if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ns_theme', next); } catch { /* ignore */ }
  toast(`Theme: ${next}`);
}
try { const t = localStorage.getItem('ns_theme'); if (t && t !== 'auto') document.documentElement.dataset.theme = t; } catch { /* ignore */ }

async function openNotifications() {
  const r = await api.get('/api/notifications');
  await api.post('/api/notifications/read');
  $('#bell-dot').classList.add('hide');
  modal({ title: 'Notifications', submit: null, cancel: 'Close', body: r.items.length ? html`<div class="list">${r.items.map((n) => html`<div class="item"><span class="badge ${n.level === 'error' ? 'bad' : n.level === 'warn' ? 'warn' : 'info'}">${n.level}</span><div class="grow"><div class="title">${n.title}</div>${n.body ? html`<div class="ink2 pre">${n.body}</div>` : ''}<div class="muted small">${ago(n.created_at)}${n.link ? html` · <a class="link" href="${n.link.startsWith('#') ? n.link : '#/overview'}" data-close>Open</a>` : ''}</div></div></div>`)}</div>` : html`<p class="muted">No notifications yet.</p>`,
    onMount: (dlg) => dlg.querySelectorAll('a[data-close]').forEach((a) => a.addEventListener('click', () => { dlg.close(); dlg.remove(); })) });
}

async function refreshCounts() {
  try {
    const [n, ov] = await Promise.all([api.get('/api/notifications'), api.get('/api/approvals')]);
    $('#bell-dot')?.classList.toggle('hide', !n.unread);
    if ($('#bell-dot')) $('#bell-dot').textContent = n.unread > 9 ? '9+' : n.unread;
    setCount('approvals', ov.length);
    if (app.user.role !== 'finance') { const inbox = await api.get('/api/inbox?filter=attention'); setCount('attention', inbox.length); }
  } catch { /* offline or logged out */ }
}
function setCount(key, n) { const el = document.querySelector(`[data-count="${key}"]`); if (!el) return; el.textContent = n; el.classList.toggle('hide', !n); }

// ---------------------------------------------------------------- router
let renderSeq = 0;
// A page's own code is fetched the first time it is opened. If that fetch fails (the
// connection dropped, or the system is restarting) say so plainly, raise the "cannot
// reach" banner and let the automatic re-check bring the page back.
let viewRetry = 0;
async function loadView(loader) {
  try { return (await loader()).default; } catch { /* try once more below */ }
  viewRetry += 1;
  try { return (await loader(`?retry=${viewRetry}`)).default; } catch { /* find out why */ }
  await api.get('/api/me'); // throws "cannot reach the system" (and shows the banner) when that is the reason
  throw new Error('This page could not be opened. Refresh the browser and try again.');
}

async function render(navigated = false) {
  const route = parseRoute();
  app.route = route;
  document.querySelectorAll('[data-nav]').forEach((a) => { const on = a.dataset.nav === route.name; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const loader = VIEWS[route.name];
  const content = $('#content');
  if (!content) return;
  if (!loader) { content.innerHTML = '<div class="empty"><div class="empty-title">Page not found</div><div class="muted">This address does not exist. <a class="link" href="#/overview">Go to the overview</a></div></div>'; return; }
  const seq = ++renderSeq;
  try {
    const mod = await loadView(loader);
    app.view = mod;
    const ctx = { ...route, user: app.user, app };
    const out = await mod.render(ctx);
    if (seq !== renderSeq) return;
    $('#title').textContent = typeof mod.title === 'function' ? mod.title(ctx) : mod.title;
    document.title = `${$('#title').textContent} · Nirmaan Sena`;
    const el = document.createElement('div');
    el.innerHTML = String(out);
    content.replaceChildren(el);
    if (mod.mount) mod.mount(el, ctx);
    // After a click on a menu or link, start at the top of the new page (also for keyboard and screen-reader users).
    if (navigated) { window.scrollTo(0, 0); content.focus({ preventScroll: true }); }
  } catch (e) {
    if (seq !== renderSeq) return;
    if (e.status === 401) return renderLogin('Your session ended. Please log in again.');
    if (e.offline && content.children.length && !navigated) return; // keep what is on screen; the banner explains
    content.innerHTML = String(html`<div class="notice bad" role="alert"><b>Could not load this page.</b> ${e.message}<div style="margin-top:10px"><button class="btn small" id="retry-page" type="button">Try again</button></div></div>`);
    $('#retry-page')?.addEventListener('click', () => render(true));
  }
}
app.refresh = () => render();

// ---------------------------------------------------------------- connection lost / back
let netTimer = null;
async function checkConnection(manual = false) {
  try { const r = await fetch('/health', { cache: 'no-store' }); if (!r.ok) throw new Error('down'); await api.get('/api/me'); }
  catch (e) { if (e.status === 401) return renderLogin('Your session ended. Please log in again.'); if (manual) toast('Still cannot reach the system.', 'err'); }
}
window.addEventListener('ns:offline', () => { clearInterval(netTimer); netTimer = setInterval(checkConnection, 5000); });
window.addEventListener('ns:online', () => { clearInterval(netTimer); netTimer = null; if (app.user && $('#content')) { toast('Connected again'); render(); refreshCounts(); } });
window.addEventListener('online', () => { if (!isOnline()) checkConnection(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('nav-open') && !document.querySelector('dialog[open]')) app.closeMenu?.(); });

function liveUpdate(topics) {
  const v = app.view;
  if (topics.includes('notifications') || topics.includes('approvals') || topics.includes('inbox')) refreshCounts();
  if (!v) return;
  if (v.onTopics) { v.onTopics(topics); return; }
  if (!v.topics || !topics.some((t) => v.topics.includes(t))) return;
  const busy = () => document.querySelector('dialog[open]') || (document.activeElement && document.activeElement.closest?.('#content') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
  if (busy()) { app.pendingRefresh = true; return; }
  clearTimeout(app._t); app._t = setTimeout(render, 350);
}
document.addEventListener('focusout', () => { if (app.pendingRefresh) setTimeout(() => { if (app.pendingRefresh && !document.querySelector('dialog[open]')) { app.pendingRefresh = false; render(); } }, 400); });

async function boot() {
  installTooltips();
  installDoubleTapGuard();
  try {
    const st = await api.get('/api/setup/status');
    if (st.needsSetup) return renderSetup(st);
    const me = await api.get('/api/me');
    if (!me.dashboard) return renderLogin('This account is for the employee app. Open /app/ on your phone.');
    app.user = me.user; app.provider = me.provider; app.publicUrl = me.publicUrl;
    renderShell();
    render();
    refreshCounts();
    if (!app.booted) {
      app.booted = true;
      window.addEventListener('hashchange', () => { app.closeMenu?.(); render(true); });
      setInterval(refreshCounts, 60000);
      subscribe(liveUpdate);
    }
  } catch (e) {
    if (e.status === 401) return renderLogin();
    $('#root').innerHTML = String(html`<div class="auth-wrap"><div class="notice bad">${e.message}</div></div>`);
  }
}
boot();
export { app };
export const util = { esc, raw, on };
