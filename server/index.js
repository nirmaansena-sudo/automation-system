// Nirmaan Sena automation system — server entry point.
import os from 'node:os';
import { exec } from 'node:child_process';
import path from 'node:path';
import { config, configProblems } from './config.js';
import { openDb, closeDb, quickCheck } from './db/index.js';
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

// Exit codes the launchers understand: 78 = fix a setting (restarting will not help),
// anything else non-zero = unexpected stop (restart automatically).
const EXIT_CONFIG = 78;
function stopWith(lines) {
  console.error('\n  The system did not start:');
  for (const l of lines) console.error(`   • ${l}`);
  console.error('\n  Fix this and start again. (Settings are in the .env file in this folder.)\n');
  process.exit(EXIT_CONFIG);
}

export function startServer() {
  const problems = configProblems();
  if (problems.errors.length) stopWith(problems.errors);
  let server;
  try { server = buildServer(); }
  catch (e) {
    // A database that cannot be opened is the one start-up failure a restart cannot cure.
    if (/malformed|not a database|file is encrypted|disk image|SQLITE_(CORRUPT|NOTADB)|Migration .* failed/i.test(String(e?.message))) {
      console.error(e);
      stopWith([`The database could not be opened (${String(e.message).slice(0, 140)}).`, `Data folder: ${config.dataDir}`, 'Do not delete anything. Restore the latest backup into a new folder: see docs/RECOVERY.md ("Validate and restore").']);
    }
    throw e;
  }
  const integrity = quickCheck();
  if (integrity !== 'ok') stopWith([`The database reported damage (${integrity.slice(0, 160)}).`, `Data folder: ${config.dataDir}`, 'Stop using this copy and restore the latest backup into a new folder: see docs/RECOVERY.md ("Validate and restore").']);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`\n  Port ${config.port} is already in use. Is the system already running in another window?\n  Close it, or set PORT=3001 in the .env file.\n`); process.exit(EXIT_CONFIG); }
    if (e.code === 'EACCES') { console.error(`\n  This computer does not allow port ${config.port}. Set another PORT (for example 3000) in the .env file.\n`); process.exit(EXIT_CONFIG); }
    console.error(e);
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
    if (problems.warnings.length) { console.log('\n  Please check these settings:'); for (const w of problems.warnings) console.log(`   • ${w}`); }
    console.log('  Stop with Ctrl+C\n');
    if (process.argv.includes('--open')) openBrowser(`http://localhost:${config.port}/admin/`);
  });
  // Stop cleanly: finish what is in flight, close the database, then exit. Live-update
  // connections never end by themselves, so they are closed after a short grace period.
  let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return; stopping = true;
    console.log('Stopping…');
    const finish = () => { try { closeDb(); } catch { /* already closed */ } process.exit(code); };
    server.close(finish);
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 1200).unref();
    setTimeout(finish, 3500).unref();
  };
  process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
  // One failed background promise must not take the business offline: log it, show it in
  // the health panel and keep serving.
  process.on('unhandledRejection', (reason) => {
    console.error(`[${nowIso()}] Unexpected background error (the system keeps running):`, reason);
    try { setState('last_unexpected_error', { at: nowIso(), message: String(reason?.message || reason).slice(0, 300) }); } catch { /* database not available */ }
  });
  // A thrown error nobody caught leaves the program in an unknown state. Stop cleanly;
  // the launcher (start-windows.bat, start.sh, Docker) starts it again within seconds.
  process.on('uncaughtException', (err) => {
    console.error(`[${nowIso()}] Unexpected error — restarting to stay safe:`, err);
    try { setState('last_unexpected_error', { at: nowIso(), message: String(err?.message || err).slice(0, 300), restarted: true }); } catch { /* database not available */ }
    stop(1);
  });
  return server;
}
