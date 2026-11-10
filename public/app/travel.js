import { html, api, on, toast, formData, badge, inr, options } from '/shared/ui.js';

export async function travelProfileCard() {
  try {
    const { profile: p, can_set_origin } = await api.get('/api/app/travel/profile');
    if (!can_set_origin) return '';
    return html`<div class="sec"><h2>Travel starting point</h2><form class="card stack" id="travel-profile">
      <p class="muted small">Choose your usual starting point for visit assignment. Your home pin is visible only to you and authorised managers. No background location tracking.</p>
      <label class="field"><span>Usually travel from</span><select name="default_origin">${options(['office', 'home'], p.default_origin)}</select></label>
      <div class="form-grid"><label class="field"><span>Home latitude</span><input name="home_lat" type="number" step="any" min="-90" max="90" value="${p.home_lat ?? ''}"></label><label class="field"><span>Home longitude</span><input name="home_lng" type="number" step="any" min="-180" max="180" value="${p.home_lng ?? ''}"></label></div>
      <label class="field"><span>Home label (optional)</span><input name="home_label" maxlength="120" value="${p.home_label || ''}" placeholder="e.g. Mansarovar"></label>
      <button class="btn" type="button" id="home-gps">Use my current location as home</button><button class="btn primary">Save starting point</button>
    </form></div>`;
  } catch { return html`<div class="sec"><div class="card muted small">Connect to edit your travel starting point.</div></div>`; }
}

export async function travelVisitCard(id) {
  try {
    const d = await api.get(`/api/app/visits/${id}/travel`), t = d.current;
    return html`<div class="sec"><h2>Visit travel allowance</h2><div class="card stack">
      ${d.message ? html`<p>${d.message}</p>` : ''}
      <p class="muted small">${d.policy.round_trip ? 'Return trip' : 'One-way trip'} · ${d.policy.rate_per_km === null ? 'Manager has not set a rate yet' : `${inr(d.policy.rate_per_km)} per km`}. The manager approves a fixed allowance before you claim it.</p>
      ${d.choices.map(c => html`<div class="row between"><div><b>From ${c.type}</b><div class="small muted">${c.unavailable || `${c.distance_km} km · ${c.source === 'estimated' ? 'estimated distance' : 'road route'} · ${c.amount === null ? 'rate not set' : inr(c.amount)}`}</div></div>${!c.unavailable && !t?.expense_id ? html`<button class="btn small" data-travel-select="${id}" data-origin="${c.type}" data-revision="${t?.revision || ''}">Choose ${c.type}</button>` : ''}</div>`)}
      ${t ? html`<div class="notice ${t.stale ? 'bad' : ''}"><b>${t.origin_type} → site${t.policy.round_trip ? ' → return' : ''}</b> · ${t.distance_km} km · ${t.amount === null ? 'Rate pending' : inr(t.amount)}<br>${badge(t.status)}${t.stale ? ' Visit changed — choose again' : ''}${t.expense_status ? ` · expense ${t.expense_status}` : ''}<div class="small">${t.note || ''}</div></div>` : ''}
      ${d.choices.some(c => c.source === 'estimated') ? html`<p class="muted small">Estimated distance is a straight-line calculation with a road allowance, not measured road travel. The manager can enter verified kilometres.</p>` : ''}
      ${t?.status === 'approved' && !t.stale && ['report_submitted', 'completed'].includes(d.visit_status) ? html`<button class="btn primary" data-travel-claim="${id}">Submit approved travel claim</button>` : ''}
    </div></div>`;
  } catch (e) { return html`<div class="sec"><div class="card muted small">Travel details unavailable: ${e.message}</div></div>`; }
}

export function bindTravel(root, { refresh }) {
  on(root, 'submit', '#travel-profile', async (e, f) => {
    e.preventDefault(); const b = f.querySelector('button:last-child'); b.disabled = true;
    try { const d = formData(f); await api.put('/api/app/travel/profile', { ...d, home_lat: d.home_lat === '' ? null : Number(d.home_lat), home_lng: d.home_lng === '' ? null : Number(d.home_lng) }); toast('Travel starting point saved'); refresh(); } catch (err) { toast(err.message, 'err'); } finally { b.disabled = false; }
  });
  on(root, 'click', '#home-gps', (e, el) => {
    if (!navigator.geolocation || !window.isSecureContext) { toast('GPS requires a secure HTTPS connection', 'err'); return; }
    el.disabled = true;
    navigator.geolocation.getCurrentPosition(p => { const f = root.querySelector('#travel-profile'); if (f) { f.home_lat.value = p.coords.latitude.toFixed(6); f.home_lng.value = p.coords.longitude.toFixed(6); } toast('Location filled. Save only if this is your home.'); el.disabled = false; }, () => { toast('Location unavailable. Enter your home map coordinates.', 'err'); el.disabled = false; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
  on(root, 'click', '[data-travel-select]', async (e, el) => {
    el.disabled = true;
    try { await api.post(`/api/app/visits/${el.dataset.travelSelect}/travel`, { origin_type: el.dataset.origin, expected_revision: el.dataset.revision ? Number(el.dataset.revision) : null }); toast('Starting point selected; waiting for manager approval'); refresh(); } catch (err) { toast(err.message, 'err'); el.disabled = false; }
  });
  on(root, 'click', '[data-travel-claim]', async (e, el) => {
    el.disabled = true;
    try { await api.post(`/api/app/visits/${el.dataset.travelClaim}/travel/claim`); toast('Travel expense submitted'); refresh(); } catch (err) { toast(err.message, 'err'); el.disabled = false; }
  });
}
