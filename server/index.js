// Nirmaan Sena automation system — server entry point.
import os from 'node:os';
import { exec } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { Router, createServer, serveStatic, HttpError } from './lib/http.js';
import { sessionUser, requireRoles, DASHBOARD_ROLES } from './lib/auth.js';
import { safeEqual, nowIso } from './lib/util.js';
import { seedBase, seedDemo } from './seed/seed.js';
import { getSettings, setState } from './core/base.js';
import { setSimulatorHooks } from './whatsapp/providers.js';
import { ingest, fakeWebhook } from './whatsapp/webhook.js';
import { kickInbound, startWorkers } from './core/workers.js';
import { registerAdmin } from './api/admin.js';
import { registerApp } from './api/app.js';
import { registerDispatch } from './api/dispatch.js';
import { registerFinance } from './api/finance.js';
import { registerOperations } from './api/operations.js';
import { registerCosts } from './api/costs.js';
import { registerTranscription } from './api/transcription.js';
import { registerAutomationDashboard } from './api/automation-dashboard.js';
import { registerAttendance } from './api/attendance.js';
import { registerExports } from './api/exports.js';
import { registerPublic, setupCodeForLog } from './api/public.js';
import { one } from './db/index.js';
import { backupBeforeUpgrade } from './lib/backups.js';

export function buildServer() {
  const beforeUpgrade = backupBeforeUpgrade();
  if (beforeUpgrade) console.log(`Pre-upgrade encrypted backup saved: ${beforeUpgrade.file}. Keep DATA_DIR/backup.key or BACKUP_PASSWORD separately.`);
  openDb(config.dbFile);
  seedBase();
  if (config.demo && !one('SELECT 1 FROM users LIMIT 1')) {
    console.log('Demo mode: open the dashboard and choose "Explore with demo data" on the first screen.');
  }

  // Simulator: echo "delivered" status webhooks back through the real pipeline.
  setSimulatorHooks({
    failRate: () => getSettings().sim_fail_rate || 0,
    onSent: ({ wamid, to, callbackData }) => {
      try {
        ingest(fakeWebhook({ statuses: [{ id: wamid, status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to, biz_opaque_callback_data: callbackData }, { id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000) + 1), recipient_id: to, biz_opaque_callback_data: callbackData }] }), 'simulator');
        kickInbound();
      } catch (e) { console.error('sim status', e.message); }
    },
  });

  const router = new Router();
  registerPublic(router);
  registerAdmin(router);
  registerApp(router);
  registerDispatch(router);
  registerFinance(router);
  registerOperations(router);
  registerCosts(router);
  registerTranscription(router);
  registerAutomationDashboard(router);
  registerAttendance(router);
  registerExports(router);

  const publicDir = path.join(config.root, 'public');
  const before = (ctx, opts) => {
    const auth = opts.auth || 'dashboard';
    if (auth === 'none') return;
    if (auth === 'automation') {
      const key = ctx.req.headers['x-automation-key'];
      if (!key || !safeEqual(key, config.automationKey)) throw new HttpError(401, 'Bad automation key');
      return;
    }
    const kind = auth === 'optional' || auth === 'any' ? 'any' : auth;
    ctx.user = sessionUser(ctx, kind);
    // An employee-app login uses a phone + PIN. Even for an owner, manager or finance
    // person it only gives employee rights (their own visits, sites, tasks, photos);
    // everything else needs the dashboard login with password and two-step code.
    if (ctx.user && ctx.sessionKind === 'app' && DASHBOARD_ROLES.includes(ctx.user.role)) ctx.user = { ...ctx.user, role: 'staff', dashboard_role: ctx.user.role };
    if (auth === 'optional') return;
    requireRoles(ctx.user, opts.roles);
    // CSRF protection for cookie sessions: our pages always send this header.
    const usesBearer = /^Bearer /.test(ctx.req.headers.authorization || '');
    if (!['GET', 'HEAD'].includes(ctx.method) && !usesBearer && ctx.req.headers['x-ns'] !== '1') throw new HttpError(403, 'Missing request header');
  };
  const fallback = (ctx) => {
    if (ctx.method !== 'GET') throw new HttpError(404, 'Not found');
    const p = ctx.path;
    if (p === '/' || p === '') return ctx.redirect('/admin/');
    if (p === '/admin') return ctx.redirect('/admin/');
    if (p === '/app') return ctx.redirect('/app/');
    if (p.startsWith('/admin/')) return serveStatic(ctx, path.join(publicDir, 'admin'), p.slice(7) || 'index.html', { spaFallback: 'index.html' });
    if (p.startsWith('/app/')) return serveStatic(ctx, path.join(publicDir, 'app'), p.slice(5) || 'index.html', { spaFallback: 'index.html' });
    if (p.startsWith('/shared/')) return serveStatic(ctx, path.join(publicDir, 'shared'), p.slice(8));
    if (p === '/favicon.ico' || p === '/favicon.svg') return serveStatic(ctx, path.join(publicDir, 'shared'), 'favicon.svg');
    throw new HttpError(404, 'Not found');
  };
  return createServer({ router, before, fallback, trustedProxies: config.trustedProxies, onError: (e, ctx) => console.error(`[${nowIso()}] ${ctx.method} ${ctx.path}:`, e) });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

export function startServer() {
  const server = buildServer();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`\n  Port ${config.port} is already in use. Is the system already running in another window?\n  Close it, or set PORT=3001 in the .env file.\n`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    startWorkers();
    setState('server_started', nowIso());
    const lan = lanAddresses();
    console.log('\n  Nirmaan Sena automation system is running');
    console.log('  ─────────────────────────────────────────');
    console.log(`  Manager dashboard : http://localhost:${config.port}/admin/`);
    console.log(`  Employee app      : http://localhost:${config.port}/app/`);
    for (const ip of lan) console.log(`  On your Wi-Fi     : http://${ip}:${config.port}/app/  (phones on the same network)`);
    console.log(`  WhatsApp mode     : ${config.whatsapp.provider}${config.whatsapp.provider === 'simulator' ? ' (nothing is sent to real phones — use the Simulator page)' : ''}`);
    console.log(`  Data folder       : ${config.dataDir}`);
    const code = setupCodeForLog();
    if (code) console.log(`  First-time setup code: ${code}  (type it once when you create the owner account)`);
    console.log('  Stop with Ctrl+C\n');
    if (process.argv.includes('--open')) openBrowser(`http://localhost:${config.port}/admin/`);
  });
  const stop = () => { console.log('Stopping…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
