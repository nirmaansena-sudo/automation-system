import { html, api, on, toast } from '/shared/ui.js';
const labels = { service: 'WhatsApp free-form message', utility: 'Utility template', marketing: 'Marketing template', authentication: 'Authentication template', unknown: 'Unclassified template', ai_call: 'Average AI attempt', transcription: 'Average local transcription attempt' };
const money = (value) => value === null ? 'Not configured' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export async function renderCostUsage(month) {
  const data = await api.get(`/api/costs${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  const p = data.policy;
  return html`<div class="page-head"><div><h1>Usage & cost estimates</h1><div class="sub">Recorded activity for ${data.month}. Enter your own provider rates; there are no assumed free allowances.</div></div><input type="month" id="cost-month" value="${data.month}" aria-label="Usage month"></div>
    <div class="grid g3" style="margin-bottom:14px"><div class="stat"><div class="stat-label">Known estimated cost</div><div class="stat-value">${money(data.knownEstimate)}</div><div class="stat-sub">${data.completeEstimate ? 'All recorded activity priced' : data.unpricedEvents === 0 ? 'Fixed monthly cost is not configured' : `${data.unpricedEvents} events have no rate; estimate is incomplete`}</div></div><div class="stat"><div class="stat-label">Monthly budget</div><div class="stat-value">${money(p.monthlyBudget)}</div><div class="stat-sub">${data.budgetExceeded ? 'Known estimate exceeds budget' : 'Planning alert; essential messages continue'}</div></div><div class="stat"><div class="stat-label">Today’s compute attempts</div><div class="stat-value">${data.today.ai} / ${data.today.aiLimit}</div><div class="stat-sub">AI · transcription ${data.today.transcription} / ${data.today.transcriptionLimit}</div></div></div>
    ${data.budgetExceeded ? html`<div class="notice warn">Review message volume, rates and budget. The displayed estimate already exceeds the configured monthly budget.</div>` : ''}
    <section class="card flush"><table class="t"><thead><tr><th>Activity</th><th>Count</th><th>Configured rate</th><th>Estimate</th></tr></thead><tbody>${data.lines.map((line) => html`<tr><td>${line.label}</td><td>${line.count}</td><td>${line.rate === null ? 'Unpriced' : `₹${line.rate}`}</td><td>${line.estimate === null ? 'Unpriced' : money(line.estimate)}</td></tr>`)}</tbody></table></section>
    <p class="muted small" style="margin:10px 0">Counts use the selected calendar month in India time. Estimates use the rates currently configured below, not a historical rate ledger. Provider invoices may include taxes, discounts, conversation rules or token-based charges. AI/transcription estimates include failed attempts; actual compute expense can differ.</p>
    <form id="cost-policy" class="card stack"><h2>Rates and budget (INR)</h2><p class="muted small">Leave a rate blank if unknown. Enter zero only when you have verified that the category has no charge. Include hosting or electricity in the fixed monthly cost for local services.</p><div class="form-grid">${Object.entries(labels).map(([key, title]) => html`<label class="field"><span>${title} ₹</span><input type="number" min="0" step="any" name="rate_${key}" value="${p.rates[key] ?? ''}"></label>`)}<label class="field"><span>Fixed monthly cost ₹</span><input name="fixedMonthlyCost" type="number" min="0" step="0.01" value="${p.fixedMonthlyCost ?? ''}"></label><label class="field"><span>Monthly budget ₹</span><input name="monthlyBudget" type="number" min="0" step="0.01" value="${p.monthlyBudget ?? ''}"></label></div>
    ${data.canEditLimits ? html`<h3>Daily compute limits</h3><p class="muted small">Zero disables new compute. Server configuration sets an additional ceiling. When the AI cap is reached the bot continues using its rules.</p><div class="form-grid"><label class="field"><span>AI attempts per day</span><input name="aiDailyLimit" type="number" min="0" max="100000" step="1" value="${p.aiDailyLimit}"></label><label class="field"><span>Manual voice transcriptions per day</span><input name="transcriptionDailyLimit" type="number" min="0" max="100000" step="1" value="${p.transcriptionDailyLimit}"></label></div>` : ''}<button class="btn primary">Save rates and budget</button><div class="form-error"></div></form>`;
}
export default {
  title: 'Usage & costs',
  render(ctx) { return renderCostUsage(ctx.query.month); },
  mount(root, ctx) {
    on(root, 'change', '#cost-month', (event, el) => { location.hash = `#/costs?month=${encodeURIComponent(el.value)}`; });
    on(root, 'submit', '#cost-policy', async (event, form) => {
      event.preventDefault(); const button = form.querySelector('button'); const error = form.querySelector('.form-error'); button.disabled = true; error.textContent = '';
      const data = { rates: {}, monthlyBudget: form.monthlyBudget.value, fixedMonthlyCost: form.fixedMonthlyCost.value };
      for (const key of Object.keys(labels)) data.rates[key] = form.elements[`rate_${key}`].value;
      for (const key of ['aiDailyLimit', 'transcriptionDailyLimit']) if (form.elements[key]) data[key] = Number(form.elements[key].value);
      try { await api.patch('/api/costs/policy', data); toast('Rates and budget saved'); ctx.app.refresh(); } catch (e) { error.textContent = e.message; } finally { button.disabled = false; }
    });
  },
};
