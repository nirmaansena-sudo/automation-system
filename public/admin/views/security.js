import { html, api, on, modal, formData, toast } from '/shared/ui.js';

const passwordField = () => html`<label class="field"><span>Current password</span><input type="password" name="current_password" required maxlength="128" autocomplete="current-password"></label>`;
const factorField = () => html`<label class="field"><span>Authenticator or recovery code</span><input name="mfa_code" required autocomplete="one-time-code" spellcheck="false"></label>`;

export default {
  title: 'My security',
  async render(ctx) {
    const security = await api.get('/api/me/security'); ctx.security = security;
    return html`<div class="page-head"><div><h1>My security</h1><div class="sub">Protect access to your account.</div></div></div>
      <div class="grid g2">
        <form class="card stack" id="security-password"><h2>Change password</h2>${passwordField()}
          <label class="field"><span>New password (8–128 characters)</span><input type="password" name="password" minlength="8" maxlength="128" required autocomplete="new-password"></label>
          ${security.enabled ? factorField() : ''}<p class="muted small">Changing your password signs out every device, including this one.</p><button class="btn primary">Change password</button></form>
        <section class="card stack"><h2>Two-step verification</h2>
          <p>${security.enabled ? 'Enabled. Sign-in requires your password and an authenticator or recovery code.' : 'Add a code from an authenticator app when you sign in.'}</p>
          ${security.enabled ? html`<p class="muted">${security.recovery_codes_remaining} recovery codes remaining. Keep these in a safe place. Each works once.</p><button class="btn" id="disable-mfa">Turn off two-step verification</button>` : html`<button class="btn primary" id="setup-mfa">Set up authenticator</button>`}
        </section>
      </div>`;
  },
  mount(root, ctx) {
    on(root, 'submit', '#security-password', async (event, form) => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try { await api.post('/api/me/password', formData(form)); location.reload(); }
      catch (error) { toast(error.message, 'err'); button.disabled = false; }
    });
    on(root, 'click', '#setup-mfa', async () => {
      try {
        const setup = await modal({ title: 'Set up authenticator', body: html`<p>Confirm your password to create an authenticator key.</p>${passwordField()}`, submit: 'Continue', onSubmit: (data) => api.post('/api/me/mfa/setup', data) });
        if (!setup) return;
        const result = await modal({ title: 'Add this account to your authenticator', submit: 'Enable verification', body: html`<div class="stack"><p>In your authenticator app, add a time-based account with this setup key:</p><input aria-label="Authenticator setup key" readonly value="${setup.secret}" spellcheck="false"><p class="muted small">Account: Nirmaan Sena · 6 digits · changes every 30 seconds. Setup expires in 10 minutes. Keep the key private.</p><a class="link" href="${setup.uri}">Open in an authenticator app</a>${passwordField()}${factorField()}</div>`, onSubmit: (data) => api.post('/api/me/mfa/enable', data) });
        if (!result) return;
        await modal({ title: 'Save your recovery codes', submit: 'I have saved the codes', cancel: null, body: html`<div class="stack"><p>Each code can sign you in once if you lose access to your authenticator. Save them before closing; they are shown only now.</p><textarea readonly rows="8" aria-label="Recovery codes">${result.recovery_codes.join('\n')}</textarea><p class="muted small">Use the next authenticator code for your next sign-in; the setup code has already been used.</p></div>` });
        ctx.app.refresh();
      } catch (error) { toast(error.message, 'err'); }
    });
    on(root, 'click', '#disable-mfa', async () => {
      try {
        const result = await modal({ title: 'Turn off two-step verification', submit: 'Turn off', danger: true, body: html`<div class="stack">${passwordField()}${factorField()}<p>Other devices will be signed out and recovery codes will stop working.</p></div>`, onSubmit: (data) => api.post('/api/me/mfa/disable', data) });
        if (result) ctx.app.refresh();
      } catch (error) { toast(error.message, 'err'); }
    });
  },
};
