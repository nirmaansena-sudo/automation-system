// Keeps the system running on a PC or plain server: starts server/main.js and starts it
// again if it stops unexpectedly. (Docker does the same job with "restart: unless-stopped".)
//   node server/supervisor.js [--open]
// Exit codes of main.js: 0 = stopped on purpose, 78 = a setting must be fixed (no restart),
// anything else = unexpected stop (restart after a short wait).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));
const QUICK_MS = 60_000;   // a run shorter than this counts as "failed to start"
const MAX_QUICK = 5;       // stop trying after this many failed starts in a row
const args = process.argv.slice(2);
let child = null; let stopping = false; let quick = 0; let timer = null;

function start(first) {
  const startedAt = Date.now();
  // Open the browser only on the first start, not after every automatic restart.
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...(first ? args : args.filter((a) => a !== '--open'))], { stdio: 'inherit' });
  child.on('error', (e) => { console.error('  Could not start the system:', e.message); process.exit(1); });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping || code === 0) process.exit(0);
    if (code === 78) process.exit(78);
    quick = Date.now() - startedAt < QUICK_MS ? quick + 1 : 0;
    if (quick >= MAX_QUICK) {
      console.error(`\n  The system stopped ${MAX_QUICK} times in a row right after starting, so it will not be started again automatically.`);
      console.error('  The error is shown above. Your data is safe in the data folder. See docs/RECOVERY.md, or start again after fixing the cause.\n');
      process.exit(1);
    }
    const wait = Math.min(30, 3 * (quick + 1));
    console.error(`\n  The system stopped unexpectedly (${signal || `code ${code}`}). Starting it again in ${wait} seconds…  Press Ctrl+C to stop.\n`);
    timer = setTimeout(() => start(false), wait * 1000);
  });
}

function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (!child) process.exit(0);
  // On Windows Ctrl+C already reaches the child; elsewhere pass the request on.
  if (process.platform !== 'win32') { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
start(true);
