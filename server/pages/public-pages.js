// Server-rendered private pages opened from WhatsApp links:
//   /q/:token  quotation (client)      /p/:token  project status (client)
//   /v/:token  visit details (architect, signed & expiring)
import { all, one } from '../db/index.js';
import { jparse, inr, fmtDateLong, fmtSlot, prettyPhone, mapsLink, verifyToken } from '../lib/util.js';
import { config } from '../config.js';
import { financeSummary } from '../domain/finance.js';
import { allocateAmounts } from '../lib/money.js';
import { COMMERCIAL_MODELS, SERVICE_TYPES } from '../bot/catalog.js';
import { servicesText, natureText, areaText, leadPlace, fullAddress } from '../domain/common.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16202e;--muted:#5d6b7c;--line:#e3e7ec;--brand:#c2410c;--ok:#15803d;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0f141b;--card:#18202b;--ink:#e8edf3;--muted:#9aa8b8;--line:#2a3542;--brand:#fb923c;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Nirmala UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.logo{width:36px;height:36px;border-radius:9px;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:800}
h1{font-size:22px;margin:0}h2{font-size:16px;margin:22px 0 8px}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:10px 0}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.num{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:700;border-bottom:none}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--brand)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}.grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
a.btn{display:inline-block;padding:10px 16px;border-radius:10px;background:var(--brand);color:#fff;text-decoration:none;font-weight:600}
.row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}@media print{a.btn{display:none}body{background:#fff}}
</style></head><body><main><header><div class="logo">NS</div><div><div style="font-weight:700">Nirmaan Sena</div><div class="muted" style="font-size:13px">Jaipur · contact@nirmaansena.com</div></div></header>${body}
<p class="muted" style="font-size:12px;margin-top:28px">This is a private link shared with you on WhatsApp. Please don't forward it.</p></main></body></html>`;
}

export function quotePage(token) {
  const q = one('SELECT * FROM quotations WHERE public_token=?', token);
  if (!q) return null;
  const lead = one('SELECT * FROM leads WHERE id=?', q.lead_id);
  const items = jparse(q.items, []); const sched = jparse(q.payment_schedule, []);
  let scheduleAmounts; try { scheduleAmounts = allocateAmounts(q.total, sched); } catch { scheduleAmounts = sched.map(m => Math.round(q.total * m.pct) / 100); }
  const latest = one('SELECT MAX(version) v FROM quotations WHERE lead_id=?', q.lead_id).v;
  const stale = q.version !== latest || ['superseded', 'expired'].includes(q.status);
  const body = `<h1>Quotation ${esc(q.ref)} <span class="pill">v${q.version}</span></h1>
<p class="muted">For ${esc(lead?.name || 'client')} · ${esc(leadPlace(lead || {}))} · Valid till ${esc(fmtDateLong(q.valid_until))}</p>
${stale ? '<div class="card" style="border-color:var(--warn)"><b>This version is no longer current.</b> Please check the latest quotation we sent on WhatsApp.</div>' : ''}
<div class="card"><div class="row"><div><b>${esc(SERVICE_TYPES[q.service_type] || q.service_type)}</b> · ${esc(COMMERCIAL_MODELS[q.commercial_model] || q.commercial_model)}</div><div class="pill">${esc(q.status.replace(/_/g, ' '))}</div></div>
<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
${items.map((i) => `<tr><td>${esc(i.desc)}</td><td class="num">${esc(i.qty)} ${esc(i.unit)}</td><td class="num">${inr(i.rate)}</td><td class="num">${inr(i.amount)}</td></tr>`).join('')}
<tr><td colspan="3">Subtotal</td><td class="num">${inr(q.subtotal)}</td></tr><tr><td colspan="3">GST ${esc(q.gst_pct)}%</td><td class="num">${inr(q.total - q.subtotal)}</td></tr>
<tr class="total"><td colspan="3">Total</td><td class="num">${inr(q.total)}</td></tr></tbody></table></div>
${sched.length ? `<h2>Payment schedule (linked to verified stages)</h2><div class="card"><table><tbody>${sched.map((m, i) => `<tr><td>${esc(m.name)}</td><td class="num">${esc(m.pct)}%</td><td class="num">${inr(scheduleAmounts[i])}</td></tr>`).join('')}</tbody></table></div>` : ''}
${q.notes ? `<h2>Notes</h2><div class="card">${esc(q.notes).replace(/\n/g, '<br>')}</div>` : ''}
<p class="muted">To accept or ask for changes, use the buttons in the WhatsApp message, or reply there. <a href="javascript:print()">Print / save as PDF</a></p>`;
  return page(`Quotation ${q.ref}`, body);
}

export function projectPage(token) {
  const p = one('SELECT * FROM projects WHERE public_token=?', token);
  if (!p) return null;
  const ms = all('SELECT * FROM milestones WHERE project_id=? ORDER BY seq', p.id);
  const logs = all('SELECT * FROM site_logs WHERE project_id=? AND client_visible=1 ORDER BY log_date DESC, id DESC LIMIT 14', p.id);
  const inv = all("SELECT * FROM invoices WHERE project_id=? AND status!='cancelled' ORDER BY id", p.id);
  const financials = financeSummary(p.id), paid = financials.netReceived;
  const photos = (logId) => all("SELECT id, caption FROM media WHERE owner_type='site_log' AND owner_id=? AND file_path IS NOT NULL ORDER BY id LIMIT 8", logId);
  const done = ms.filter((m) => ['accepted', 'invoiced', 'paid'].includes(m.status)).length;
  const body = `<h1>${esc(p.ref)}</h1><p class="muted">${esc(p.name || '')}</p>
<div class="card"><div class="row"><div><b>Status:</b> ${esc(p.status.replace(/_/g, ' '))}</div><div>${done}/${ms.length} stages done</div></div>
<div class="bar" style="margin-top:10px"><i style="width:${ms.length ? Math.round((done / ms.length) * 100) : 0}%"></i></div></div>
<h2>Stages</h2><div class="card"><table><tbody>${ms.map((m) => `<tr><td>${m.seq}. ${esc(m.name)}</td><td>${esc(m.status.replace(/_/g, ' '))}${m.status === 'in_progress' ? ` · ${m.progress}%` : ''}</td><td class="num">${m.planned_end ? esc(fmtDateLong(m.planned_end)) : ''}</td></tr>`).join('')}</tbody></table></div>
<h2>Daily site updates</h2>${logs.length ? logs.map((l) => { const ph = photos(l.id); const lab = jparse(l.labour, {}); const workers = Object.values(lab).reduce((a, b) => a + Number(b || 0), 0); return `<div class="card"><div class="row"><b>${esc(fmtDateLong(l.log_date))}</b>${workers ? `<span class="muted">👷 ${workers} on site</span>` : ''}</div><p>${esc(l.work_done || '')}</p>${ph.length ? `<div class="grid">${ph.map((m) => `<a href="/media/${m.id}?t=${encodeURIComponent(token)}"><img loading="lazy" src="/media/${m.id}?t=${encodeURIComponent(token)}" alt="${esc(m.caption || 'Site photo')}"></a>`).join('')}</div>` : ''}</div>`; }).join('') : '<p class="muted">Updates will appear here once work starts.</p>'}
<h2>Payments</h2><div class="card"><div class="row"><div>Contract value <b>${inr(p.contract_value)}</b></div><div>Net paid <b>${inr(paid)}</b>${financials.refunded ? ` · refunded ${inr(financials.refunded)}` : ''}</div></div>
<table><tbody>${inv.map((i) => `<tr><td>${esc(i.ref)} · ${esc(i.title)}</td><td>${esc(i.status.replace(/_/g, ' '))}</td><td class="num">${inr(i.amount)}</td></tr>`).join('')}</tbody></table></div>
${p.warranty_until ? `<div class="card">🔑 Handed over ${esc(fmtDateLong(p.handover_at))} · Structural warranty till <b>${esc(fmtDateLong(p.warranty_until))}</b></div>` : ''}`;
  return page(`Project ${p.ref}`, body);
}

export function visitPage(token) {
  const data = verifyToken(config.sessionSecret, token);
  if (!data?.v) return null;
  const v = one('SELECT * FROM visits WHERE id=?', data.v);
  if (!v) return null;
  const l = one('SELECT * FROM leads WHERE id=?', v.lead_id);
  const arch = one('SELECT name FROM users WHERE id=?', v.architect_id);
  const active = ['confirmed', 'in_progress', 'report_submitted', 'completed'].includes(v.status);
  const maps = mapsLink(l.site_lat, l.site_lng, l.address || leadPlace(l));
  const body = `<h1>Site visit ${esc(v.ref)}</h1><p class="muted">${esc(fmtSlot(v.start_at))} · ${esc(arch?.name || '')} · <span class="pill">${esc(v.status.replace(/_/g, ' '))}</span></p>
${active ? `<div class="card"><table><tbody>
<tr><td>Client</td><td><b>${esc(l.name || '')}</b></td></tr>
<tr><td>Phone</td><td><a href="tel:+${esc(l.phone)}">${esc(prettyPhone(l.phone))}</a></td></tr>
<tr><td>Address</td><td>${esc(fullAddress(l))}</td></tr>
<tr><td>Work</td><td>${esc(servicesText(l.services))} · ${esc(natureText(l))} · ${esc(areaText(l))}</td></tr>
<tr><td>Notes</td><td>${esc(l.requirements || '—')}</td></tr></tbody></table></div>
<p><a class="btn" href="${esc(maps)}">Open in Google Maps</a> &nbsp; <a class="btn" style="background:#334155" href="${esc(config.publicUrl)}/app/#/visit/${v.id}">Open in app (check-in &amp; report)</a></p>`
    : '<div class="card">This visit is no longer active. No action needed.</div>'}`;
  return page(`Visit ${v.ref}`, body);
}
