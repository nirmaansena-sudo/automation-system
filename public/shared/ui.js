// Tiny UI toolkit shared by the dashboard and the employee app (no dependencies).
// html`` escapes every interpolation unless wrapped in raw().

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
function part(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// ---------------------------------------------------------------- API
let authToken = null;
export function setToken(t) { authToken = t; }
export async function api(method, path, body) {
  const headers = { 'x-ns': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  let res;
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { const e = new Error('Cannot reach the server. Is it running?'); e.offline = true; throw e; }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const e = new Error((data && data.error) || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
api.get = (p) => api('GET', p);
api.post = (p, b = {}) => api('POST', p, b);
api.patch = (p, b = {}) => api('PATCH', p, b);
api.put = (p, b = {}) => api('PUT', p, b);
api.del = (p) => api('DELETE', p);

// ---------------------------------------------------------------- formatting (India time)
const TZ = 'Asia/Kolkata';
const f = (o) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...o });
const fDT = f({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
const fD = f({ day: 'numeric', month: 'short', year: 'numeric' });
const fDS = f({ weekday: 'short', day: 'numeric', month: 'short' });
const fT = f({ hour: 'numeric', minute: '2-digit', hour12: true });
const ok = (d) => d && !Number.isNaN(new Date(d).getTime());
export const dt = (d) => (ok(d) ? fDT.format(new Date(d)) : '—');
export const date = (d) => (ok(d) ? fD.format(new Date(d.length === 10 ? d + 'T12:00:00+05:30' : d)) : '—');
export const day = (d) => (ok(d) ? fDS.format(new Date(d.length === 10 ? d + 'T12:00:00+05:30' : d)) : '—');
export const time = (d) => (ok(d) ? fT.format(new Date(d)) : '—');
export function ago(d) {
  if (!ok(d)) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 0) { const m = -s / 60; return m < 60 ? `in ${Math.round(m)} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`; }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const inr = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));
export function compact(n) {
  n = Number(n || 0);
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + ' Cr';
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(n >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' L';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
export const phone = (wa) => { const s = String(wa || ''); return s.length === 12 && s.startsWith('91') ? `+91 ${s.slice(2, 7)} ${s.slice(7)}` : s ? '+' + s : ''; };
export const label = (s) => String(s || '').replace(/_/g, ' ');
export const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
export function toLocalInput(iso) { if (!ok(iso)) return ''; const d = new Date(new Date(iso).getTime() + 330 * 60000); return d.toISOString().slice(0, 16); }
export function fromLocalInput(v) { return v ? new Date(v + ':00+05:30').toISOString() : null; }

// ---------------------------------------------------------------- DOM helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  });
}
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'file') continue;
    if (el.type === 'checkbox') { if (el.dataset.multi) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); } else out[el.name] = el.checked; }
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.tagName === 'SELECT' && el.multiple) out[el.name] = [...el.selectedOptions].map((o) => o.value);
    else out[el.name] = el.value;
  }
  return out;
}

// ---------------------------------------------------------------- toasts, dialogs
export function toast(msg, kind = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'err' ? 6000 : 3200);
}

/** Modal with a form. onSubmit(data) may return false/throw to keep it open. */
export function modal({ title, body, submit = 'Save', cancel = 'Cancel', danger = false, wide = false, onSubmit, onMount }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = `modal${wide ? ' wide' : ''}`;
    dlg.innerHTML = String(html`<form method="dialog" class="modal-form">
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="modal-body">${raw(String(body || ''))}</div>
      <div class="form-error" role="alert"></div>
      <footer>${cancel ? html`<button type="button" class="btn ghost" data-close>${cancel}</button>` : ''}${submit ? html`<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submit}</button>` : ''}</footer>
    </form>`);
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => close(null)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      const errBox = form.querySelector('.form-error');
      errBox.textContent = '';
      if (btn) btn.disabled = true;
      try {
        const data = formData(form);
        const r = onSubmit ? await onSubmit(data, form) : data;
        if (r === false) { if (btn) btn.disabled = false; return; }
        close(r === undefined ? data : r);
      } catch (err) { errBox.textContent = err.message; if (btn) btn.disabled = false; }
    });
    dlg.showModal();
    if (onMount) onMount(dlg);
    const first = form.querySelector('input:not([type=hidden]),select,textarea');
    if (first) first.focus();
  });
}
export const confirmBox = (title, message, { submit = 'Confirm', danger = false } = {}) => modal({ title, body: html`<p>${message}</p>`, submit, danger, onSubmit: () => true });

// ---------------------------------------------------------------- small widgets
export function badge(status, map = {}) {
  const tone = map[status] || TONES[status] || 'neutral';
  return html`<span class="badge ${tone}">${label(status)}</span>`;
}
const TONES = {
  pending: 'warn', awaiting_approval: 'warn', capturing: 'neutral', scheduling: 'info', visit_confirmed: 'info', visit_done: 'info', quoting: 'info', quote_sent: 'info',
  won: 'good', lost: 'muted', stale: 'muted', out_of_area: 'warn', needs_followup: 'warn', confirmed: 'info', in_progress: 'info', completed: 'good', cancelled: 'muted',
  report_submitted: 'warn', no_show_client: 'bad', no_show_architect: 'bad', active: 'good', awaiting_advance: 'warn', on_hold: 'warn', handover: 'info', warranty: 'good', closed: 'muted',
  planned: 'neutral', ready_for_review: 'warn', rework: 'bad', client_review: 'warn', accepted: 'good', invoiced: 'info', paid: 'good', issued: 'warn', partially_paid: 'warn',
  sent: 'good', delivered: 'good', read: 'good', failed: 'bad', queued: 'neutral', retrying: 'warn', unknown: 'warn', needs_operator: 'bad', received: 'neutral',
  approved: 'good', rejected: 'bad', done: 'good', todo: 'neutral', blocked: 'bad', open: 'warn', resolved: 'good', draft: 'neutral', submitted: 'info',
  present: 'good', late: 'warn', half_day: 'warn', absent: 'bad', leave: 'info', needs_review: 'bad', weekly_off: 'muted', holiday: 'muted', not_checked_in: 'neutral',
  pending_manager: 'warn', pending_finance: 'warn', pending_client: 'warn', applied: 'good', high: 'bad', normal: 'neutral', low: 'muted', bot: 'info', human: 'warn',
};
export function empty(text, sub = '') { return html`<div class="empty"><div class="empty-title">${text}</div>${sub ? html`<div class="muted">${sub}</div>` : ''}</div>`; }
export function stat(labelText, value, sub = '', tone = '') {
  return html`<div class="stat ${tone}"><div class="stat-label">${labelText}</div><div class="stat-value">${value}</div>${sub ? html`<div class="stat-sub">${sub}</div>` : ''}</div>`;
}
export function options(list, selected, { blank } = {}) {
  return raw((blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') + list.map((o) => {
    const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o;
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(l)}</option>`;
  }).join(''));
}

// ---------------------------------------------------------------- charts (single-series, accessible)
/** Column chart: data [{label, value, title}] → SVG string with hover targets. */
export function columnChart(data, { height = 180, unit = '' } = {}) {
  if (!data.length) return raw('');
  const W = Math.max(320, data.length * 34); const H = height; const padL = 34; const padB = 26; const padT = 12;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = niceStep(max); const top = Math.ceil(max / step) * step;
  const bw = Math.min(24, ((W - padL) / data.length) * 0.62);
  const x = (i) => padL + ((W - padL) / data.length) * (i + 0.5);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let grid = '';
  for (let v = 0; v <= top; v += step) grid += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const bars = data.map((d, i) => {
    const h = Math.max(0, y(0) - y(d.value)); const bx = x(i) - bw / 2; const r = Math.min(4, h / 2, bw / 2);
    const path = h > 0 ? `M${bx},${y(0)} V${y(d.value) + r} Q${bx},${y(d.value)} ${bx + r},${y(d.value)} H${bx + bw - r} Q${bx + bw},${y(d.value)} ${bx + bw},${y(d.value) + r} V${y(0)} Z` : '';
    const showLabel = i % Math.ceil(data.length / 7) === 0 || i === data.length - 1;
    return `<g class="col" data-tip="${esc(d.title || d.label)}: ${esc(d.value)}${esc(unit)}"><rect class="hit" x="${x(i) - ((W - padL) / data.length) / 2}" y="${padT}" width="${(W - padL) / data.length}" height="${H - padT - padB}"/>${path ? `<path class="bar" d="${path}"/>` : ''}${showLabel ? `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>` : ''}</g>`;
  }).join('');
  return raw(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Column chart">${grid}<line class="axis" x1="${padL}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${bars}</svg>`);
}
/** Horizontal bars: [{label, value}] → HTML (value at bar tip). */
export function barList(data, { fmt = (v) => v } = {}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return html`<div class="barlist">${data.map((d) => html`<div class="barrow" data-tip="${d.label}: ${fmt(d.value)}"><div class="barlabel">${d.label}</div><div class="bartrack"><i style="width:${Math.max(2, (d.value / max) * 100)}%"></i></div><div class="barval">${fmt(d.value)}</div></div>`)}</div>`;
}
function niceStep(max) { const raw0 = max / 4; const p = 10 ** Math.floor(Math.log10(raw0 || 1)); const n = raw0 / p; return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p); }

/** One floating tooltip for every [data-tip] element. */
export function installTooltips() {
  if (document.getElementById('tip')) return;
  const tip = document.createElement('div'); tip.id = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip);
  const show = (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) { tip.style.display = 'none'; return; }
    tip.textContent = el.dataset.tip; tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 12; let y = e.clientY - r.height - 10;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12;
    if (y < 8) y = e.clientY + 16;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  };
  document.addEventListener('mousemove', show);
  document.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

/** Resize a photo in the browser before upload (keeps uploads small). */
export function readImage(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    if (file.type === 'application/pdf') { const fr = new FileReader(); fr.onload = () => resolve({ data: fr.result, mime: 'application/pdf' }); fr.onerror = reject; fr.readAsDataURL(file); return; }
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ data: c.toDataURL('image/jpeg', quality), mime: 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image')); };
    img.src = url;
  });
}

/** Live updates from the server (Server-Sent Events). */
export function subscribe(onTopics) {
  let es; let retry = 1000;
  const connect = () => {
    es = new EventSource('/api/stream');
    es.addEventListener('change', (e) => { retry = 1000; try { onTopics(JSON.parse(e.data).topics || []); } catch { /* ignore */ } });
    es.onerror = () => { es.close(); setTimeout(connect, retry); retry = Math.min(retry * 2, 30000); };
  };
  connect();
  return () => es && es.close();
}
