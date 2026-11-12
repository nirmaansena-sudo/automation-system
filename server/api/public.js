// Setup & login, WhatsApp webhooks, website form, private pages, media,
// n8n automation endpoints and the WhatsApp simulator.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, one, run, tx, insert } from '../db/index.js';
import { nowIso, normPhone, safeEqual, hashSecret, jparse, advanceClock, nowIso as _now } from '../lib/util.js';
import { bad, notFound, forbidden, HttpError, sseHandler, contentType } from '../lib/http.js';
import { config } from '../config.js';
import { audit, notify, setState, getSettings } from '../core/base.js';
import { kickDispatcher } from '../core/outbox.js';
import { runRoutine, healthReport, ROUTINES } from '../core/routines.js';
import { loginDashboard, loginApp, logout, createSession, DASHBOARD_ROLES, reauthenticate, revokeSessions, validatePassword } from '../lib/auth.js';
import { mfaStatus, beginMfa, enableMfa, disableMfa } from '../lib/mfa.js';
import { verifySubscription, verifySignature, ingest, ingestWebsiteForm, fakeWebhook, cleanWebsiteForm } from '../whatsapp/webhook.js';
import { kickInbound, drain } from '../core/workers.js';
import { quotePage, projectPage, visitPage } from '../pages/public-pages.js';
import { seedDemo } from '../seed/seed.js';
import { publicUser, selfUser } from '../domain/staff.js';
import { ensureContact } from '../domain/common.js';
import { renderTemplateBody } from '../whatsapp/format.js';

// Every real first-time setup needs a code from the server console. The server
// may bind to all LAN interfaces even when PUBLIC_URL says localhost.
let setupCode = null;
const setupCodeRequired = () => !config.testMode;
export function setupCodeForLog() {
  if (!setupCodeRequired() || one('SELECT 1 FROM users LIMIT 1')) return null;
  if (!setupCode) setupCode = crypto.randomBytes(8).toString('hex').toUpperCase();
  return setupCode;
}

function assignedProject(userId, projectId) {
  return !!one('SELECT 1 FROM projects WHERE id=? AND (supervisor_id=? OR engineer_id=? OR architect_id=? OR manager_id=?)', projectId, userId, userId, userId, userId);
}
export function canReadMedia(user, media) {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'manager') return true;
  // Finance needs bills and project documents, not client chat photos, staff
  // messages or attendance selfies.
  if (user.role === 'finance' && ['expense', 'project', 'site_log'].includes(media.owner_type)) return true;
  const id = user.id;
  if (media.owner_type === 'project') return assignedProject(id, media.owner_id);
  if (media.owner_type === 'site_log') {
    const log = one('SELECT project_id FROM site_logs WHERE id=?', media.owner_id);
    return !!log && assignedProject(id, log.project_id);
  }
  if (media.owner_type === 'visit') return !!one('SELECT 1 FROM visits WHERE id=? AND architect_id=?', media.owner_id, id);
  if (media.owner_type === 'lead') {
    if (one('SELECT 1 FROM leads WHERE id=? AND owner_id=?', media.owner_id, id)) return true;
    if (one("SELECT 1 FROM visits WHERE lead_id=? AND architect_id=? AND status!='cancelled'", media.owner_id, id)) return true;
    return !!one('SELECT 1 FROM projects WHERE lead_id=? AND (supervisor_id=? OR engineer_id=? OR architect_id=? OR manager_id=?)', media.owner_id, id, id, id, id);
  }
  if (media.owner_type === 'attendance') return media.owner_id === id;
  if (media.owner_type === 'expense') return !!one('SELECT 1 FROM expense_claims WHERE id=? AND user_id=?', media.owner_id, id);
  return media.uploaded_by === `user:${id}`;
}

export function registerPublic(r) {
  // ---------------- setup & auth
  r.get('/api/setup/status', { auth: 'none' }, () => {
    const needsSetup = !one('SELECT 1 FROM users LIMIT 1');
    return { needsSetup, needsCode: needsSetup && setupCodeRequired(), provider: config.whatsapp.provider };
  });
  r.post('/api/setup', { auth: 'none', limit: 16 * 1024 }, (ctx) => tx(() => {
    if (one('SELECT 1 FROM users LIMIT 1')) throw forbidden('Setup is already complete');
    const b = ctx.body || {};
    if (setupCodeRequired()) {
      const code = setupCodeForLog();
      if (!b.setup_code || !safeEqual(String(b.setup_code).trim().toUpperCase(), code)) {
        console.log(`  First-time setup code: ${code}`);
        throw bad('Enter the setup code shown in the server window (or: docker compose logs app)');
      }
    }
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120 || typeof b.email !== 'string' || b.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim())) throw bad('A name and valid email are required');
    validatePassword(b.password);
    const phone = b.phone ? normPhone(b.phone) : null;
    if (b.phone && (!phone || !/^\d{11,15}$/.test(phone))) throw bad('Enter a valid phone number');
    const id = insert('users', { name: b.name, email: String(b.email).toLowerCase().trim(), phone, role: 'owner', title: 'Owner', password_hash: hashSecret(b.password), pin_hash: null, zones: '[]', skills: '[]', weekly_off: '[0]', active: 1, created_at: nowIso(), updated_at: nowIso() });
    if (phone) ensureContact(phone, { userId: id, name: b.name });
    audit(`user:${id}`, 'setup.owner_created', 'user', id);
    let demo = null;
    if (b.demo) demo = seedDemo();
    createSession(id, 'dashboard', ctx);
    return { ok: true, demo };
  }));
  r.post('/api/auth/login', { auth: 'none', limit: 16 * 1024 }, (ctx) => { const u = loginDashboard(ctx, ctx.body?.login, ctx.body?.password, ctx.body?.mfa_code); audit(`user:${u.id}`, 'auth.login', 'user', u.id); return { user: selfUser(u) }; });
  r.post('/api/auth/app-login', { auth: 'none', limit: 16 * 1024 }, (ctx) => { const { user, token } = loginApp(ctx, ctx.body?.phone, ctx.body?.pin, ctx.body?.mfa_code); audit(`user:${user.id}`, 'auth.app_login', 'user', user.id); return { user: selfUser(user), token }; });
  r.post('/api/auth/logout', { auth: 'none', limit: 16 * 1024 }, (ctx) => {
    // Same cross-site check as other state changes (our pages always send it).
    if (ctx.req.headers['x-ns'] !== '1' && !/^Bearer /.test(ctx.req.headers.authorization || '')) throw new HttpError(403, 'Missing request header');
    logout(ctx); return { ok: true };
  });
  r.get('/api/me', { auth: 'any' }, (ctx) => ({ user: selfUser(ctx.user), dashboard: DASHBOARD_ROLES.includes(ctx.user.role), provider: config.whatsapp.provider, publicUrl: config.publicUrl }));
  r.post('/api/me/password', { auth: 'any' }, (ctx) => tx(() => {
    const b = ctx.body || {};
    const hasPassword = Object.hasOwn(b, 'password'); const hasPin = Object.hasOwn(b, 'pin');
    if (!hasPassword && !hasPin) throw bad('Enter a new password or PIN');
    if (hasPassword) validatePassword(b.password);
    if (hasPin && (typeof b.pin !== 'string' || !/^\d{6,8}$/.test(b.pin))) throw bad('PIN must be 6–8 digits');
    reauthenticate(ctx, b, { allowPin: !hasPassword });
    if (hasPin) run('UPDATE users SET pin_hash=? WHERE id=?', hashSecret(b.pin), ctx.user.id);
    if (hasPassword) run('UPDATE users SET password_hash=? WHERE id=?', hashSecret(b.password), ctx.user.id);
    revokeSessions(ctx.user.id, ctx);
    audit(`user:${ctx.user.id}`, 'auth.secret_changed', 'user', ctx.user.id);
    return { ok: true, reauthenticate: true };
  }));
  const security = { auth: 'dashboard', roles: DASHBOARD_ROLES };
  r.get('/api/me/security', security, (ctx) => mfaStatus(ctx.user.id));
  r.post('/api/me/mfa/setup', security, (ctx) => { reauthenticate(ctx, ctx.body); return beginMfa(ctx.user); });
  r.post('/api/me/mfa/enable', security, (ctx) => tx(() => {
    reauthenticate(ctx, ctx.body);
    const result = enableMfa(ctx.user.id, ctx.body?.mfa_code);
    // Keep only this newly authenticated session. Previous sessions must log in
    // with MFA; rotating this session lets the recovery-code screen finish.
    revokeSessions(ctx.user.id, ctx); createSession(ctx.user.id, 'dashboard', ctx);
    audit(`user:${ctx.user.id}`, 'auth.mfa_enabled', 'user', ctx.user.id);
    return { ok: true, ...result };
  }));
  r.post('/api/me/mfa/disable', security, (ctx) => tx(() => {
    reauthenticate(ctx, ctx.body); disableMfa(ctx.user.id); revokeSessions(ctx.user.id, ctx); createSession(ctx.user.id, 'dashboard', ctx);
    audit(`user:${ctx.user.id}`, 'auth.mfa_disabled', 'user', ctx.user.id);
    return { ok: true };
  }));
  r.get('/api/stream', { auth: 'any' }, (ctx) => sseHandler(ctx));

  // ---------------- WhatsApp webhooks (Meta Cloud API / 360dialog)
  r.get('/webhooks/whatsapp', { auth: 'none' }, (ctx) => {
    const ch = verifySubscription(ctx.query);
    if (ch === null) { ctx.text('Forbidden', 403); return; }
    ctx.text(String(ch));
  });
  r.post('/webhooks/whatsapp', { auth: 'none', limit: 5 * 1024 * 1024 }, (ctx) => {
    if (!verifySignature(ctx.rawBody, ctx.req.headers, ctx.query)) {
      setState('webhook_bad_signature', nowIso());
      ctx.text('Invalid signature', 401); return;
    }
    const res = ingest(ctx.body || {}, config.whatsapp.provider); // durable before ACK
    ctx.json({ ok: true, ...res });
    kickInbound();
  });

  // ---------------- website enquiry form (already OTP-verified on nirmaansena.com)
  r.post('/api/public/website-enquiry', { auth: 'none', limit: 64 * 1024 }, (ctx) => {
    // Header only: a secret in the URL ends up in proxy and browser logs.
    const secret = ctx.req.headers['x-website-secret'];
    if (!secret || !safeEqual(secret, config.websiteSecret)) throw new HttpError(401, 'Bad secret');
    const form = cleanWebsiteForm(ctx.body || {});
    const res = tx(() => ingestWebsiteForm(form));
    kickInbound();
    return { ok: true, ...res, duplicate: res.stored === 0 };
  });

  // ---------------- private pages and media
  r.get('/q/:token', { auth: 'none' }, (ctx) => { const h = quotePage(ctx.params.token); if (!h) throw notFound('Link not found'); ctx.html(h); });
  r.get('/p/:token', { auth: 'none' }, (ctx) => { const h = projectPage(ctx.params.token); if (!h) throw notFound('Link not found'); ctx.html(h); });
  r.get('/v/:token', { auth: 'none' }, (ctx) => { const h = visitPage(ctx.params.token); if (!h) throw notFound('This link has expired. Open the visit in the app.'); ctx.html(h); });
  r.get('/media/:id', { auth: 'optional' }, (ctx) => {
    const m = one('SELECT * FROM media WHERE id=?', Number(ctx.params.id));
    if (!m || !m.file_path) throw notFound();
    let allowed = canReadMedia(ctx.user, m);
    if (!allowed && ctx.query.t) {
      const p = one('SELECT id FROM projects WHERE public_token=?', String(ctx.query.t));
      if (p) {
        if (m.owner_type === 'project' && m.owner_id === p.id) allowed = true;
        if (m.owner_type === 'site_log' && one('SELECT 1 FROM site_logs WHERE id=? AND project_id=? AND client_visible=1', m.owner_id, p.id)) allowed = true;
      }
    }
    if (!allowed) throw forbidden();
    const full = path.resolve(config.mediaDir, m.file_path);
    const relative = path.relative(config.mediaDir, full);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(full)) throw notFound();
    ctx.send(fs.readFileSync(full), m.mime || contentType(full), { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
  });
  r.get('/health', { auth: 'none' }, () => ({ ok: true, at: nowIso() }));

  // ---------------- n8n automation API (X-Automation-Key)
  const A = { auth: 'automation' };
  r.get('/api/automation/health', A, () => { setState('n8n_last_seen', nowIso()); return healthReport(); });
  r.post('/api/automation/ping', A, () => { setState('n8n_last_seen', nowIso()); return { ok: true }; });
  r.get('/api/automation/routines', A, () => Object.entries(ROUTINES).map(([name, x]) => ({ name, label: x.label, when: x.when() })));
  r.post('/api/automation/routines/:name/run', A, (ctx) => { setState('n8n_last_seen', nowIso()); const res = runRoutine(ctx.params.name, 'n8n'); kickDispatcher(); return res; });
  r.post('/api/automation/alerts', A, (ctx) => tx(() => {
    const b = ctx.body || {};
    notify({ audience: b.audience === 'managers' ? 'managers' : 'owner', title: `⚙️ ${String(b.title || 'Automation alert').slice(0, 120)}`, body: String(b.body || '').slice(0, 500), link: '#/settings', level: ['info', 'warn', 'error'].includes(b.level) ? b.level : 'warn' });
    audit('n8n', 'automation.alert', 'system', null, b);
    return { ok: true };
  }));
  r.get('/api/automation/summary', A, () => {
    const h = healthReport();
    return { at: nowIso(), health: h, pendingApprovals: one("SELECT COUNT(*) n FROM approvals WHERE status='pending'").n, openLeads: one("SELECT COUNT(*) n FROM leads WHERE status IN ('capturing','awaiting_approval','scheduling','visit_confirmed','quoting','quote_sent','needs_followup')").n };
  });

  // ---------------- WhatsApp simulator (dashboard, simulator mode only)
  const S = { auth: 'dashboard', roles: ['owner', 'manager'] };
  const simOnly = () => { if (config.whatsapp.provider !== 'simulator') throw bad('The simulator works only when WHATSAPP_PROVIDER=simulator'); };
  r.get('/api/sim/phones', S, () => ({
    clients: all("SELECT id, wa_id, name, profile_name, kind, language FROM contacts WHERE kind != 'staff' AND erased_at IS NULL ORDER BY COALESCE(last_inbound_at, created_at) DESC LIMIT 50"),
    staff: all("SELECT u.id, u.name, u.role, u.phone FROM users u WHERE u.active=1 AND u.phone IS NOT NULL AND u.role IN ('architect','engineer','supervisor','manager','owner') ORDER BY u.role, u.name"),
  }));
  r.get('/api/sim/thread/:wa', S, (ctx) => {
    const c = one('SELECT * FROM contacts WHERE wa_id=?', normPhone(ctx.params.wa));
    if (!c) return { contact: null, messages: [] };
    const msgs = all('SELECT * FROM (SELECT * FROM messages WHERE contact_id=? ORDER BY id DESC LIMIT 120) ORDER BY id', c.id).map((m) => {
      const payload = jparse(m.payload, null);
      let display = payload;
      if (m.route === 'template' && m.outbox_id) {
        const ob = one('SELECT template FROM outbox WHERE id=?', m.outbox_id); const tpl = jparse(ob?.template, null);
        const row = tpl ? one('SELECT body, buttons FROM wa_templates WHERE name=? AND language=?', tpl.name, c.language || 'en') || one('SELECT body, buttons FROM wa_templates WHERE name=? LIMIT 1', tpl.name) : null;
        if (row) display = { type: 'template', name: tpl.name, text: renderTemplateBody(row.body, tpl.params), buttons: jparse(row.buttons, []).map((b, i) => ({ id: tpl.buttons?.[i]?.payload || '', title: b.text })) };
      }
      return { id: m.id, direction: m.direction, type: m.type, body: m.body, status: m.status, route: m.route, sender: m.sender, created_at: m.created_at, error: m.error, media_id: m.media_id, display };
    });
    return { contact: c, messages: msgs };
  });
  r.post('/api/sim/send', { ...S, limit: 12 * 1024 * 1024 }, async (ctx) => {
    simOnly();
    const b = ctx.body || {};
    const from = normPhone(b.from);
    if (!from || from.length < 11) throw bad('Enter a valid phone number for the simulated person');
    let message;
    if (b.buttonId) message = b.template ? { type: 'button', button: { payload: b.buttonId, text: b.buttonTitle || '' } } : { type: 'interactive', interactive: b.list ? { type: 'list_reply', list_reply: { id: b.buttonId, title: b.buttonTitle || '' } } : { type: 'button_reply', button_reply: { id: b.buttonId, title: b.buttonTitle || '' } } };
    else if (b.location) message = { type: 'location', location: { latitude: Number(b.location.lat), longitude: Number(b.location.lng), name: b.location.name || undefined, address: b.location.address || undefined } };
    else if (b.image) message = { type: b.image.mime === 'application/pdf' ? 'document' : 'image', [b.image.mime === 'application/pdf' ? 'document' : 'image']: { id: 'sim-media', mime_type: b.image.mime || 'image/jpeg', caption: b.image.caption || undefined, _sim_data: String(b.image.data || '').replace(/^data:[^,]+,/, '') } };
    else if (b.audio) message = { type: 'audio', audio: { id: 'sim-audio', mime_type: 'audio/ogg', voice: true } };
    else if (b.text) message = { type: 'text', text: { body: String(b.text).slice(0, 4096) } };
    else throw bad('Nothing to send');
    const res = ingest(fakeWebhook({ from, name: b.name || null, message }), 'simulator');
    await drain(40);
    return { ok: true, ...res };
  });
  r.post('/api/sim/website-form', S, async (ctx) => {
    simOnly();
    const res = tx(() => ingestWebsiteForm(cleanWebsiteForm({ ...(ctx.body || {}), submitted_at: nowIso() })));
    await drain(20);
    return { ok: true, ...res };
  });
  r.post('/api/sim/fast-forward', S, async (ctx) => {
    simOnly();
    const minutes = Math.max(1, Math.min(7 * 24 * 60, Number(ctx.body?.minutes || 30)));
    advanceClock(minutes * 60000);
    audit(`user:${ctx.user.id}`, 'sim.fast_forward', 'system', null, { minutes });
    await drain(40);
    return { ok: true, now: nowIso() };
  });
  r.post('/api/sim/drain', S, async () => { await drain(40); return { ok: true }; });
}
