// Runs the whole test suite as if it were other times and dates: just after midnight,
// before opening, at closing time, a Sunday, month-end and year-end. Several real bugs
// only showed up at those moments (a visit dated tomorrow, a deadline in the night).
//   npm run test:times            all moments (about 40 seconds each)
//   npm run test:times -- quick   three moments
// Uses tests/clock-shift.mjs, which moves every clock in the test process.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IST_MIN = 330; // India time is UTC+5:30, no daylight saving
const now = new Date();
const istNow = new Date(now.getTime() + IST_MIN * 60_000); // read with getUTC* to get India wall-clock parts

/** The next India-time moment that matches, as a real Date. */
function next({ hm, dow, lastOfMonth, monthDay }) {
  const [h, m] = hm.split(':').map(Number);
  for (let add = 0; add < 400; add++) {
    const d = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + add, h, m));
    const tomorrow = new Date(d.getTime() + 86_400_000);
    if (dow !== undefined && d.getUTCDay() !== dow) continue;
    if (lastOfMonth && tomorrow.getUTCDate() !== 1) continue;
    if (monthDay && (d.getUTCMonth() + 1 !== monthDay[0] || d.getUTCDate() !== monthDay[1])) continue;
    const real = new Date(d.getTime() - IST_MIN * 60_000);
    if (real > now) return real;
  }
  throw new Error(`no date found for ${hm}`);
}

const MOMENTS = [
  ['just after midnight', { hm: '00:03' }, true],
  ['before the office opens', { hm: '08:45' }],
  ['closing time', { hm: '17:59' }, true],
  ['last minute of the day', { hm: '23:59' }],
  ['Sunday morning', { hm: '11:00', dow: 0 }, true],
  ['Saturday night', { hm: '23:59', dow: 6 }],
  ['month-end night', { hm: '23:50', lastOfMonth: true }],
  ['year-end night', { hm: '23:56', monthDay: [12, 31] }],
  ['New Year morning', { hm: '09:00', monthDay: [1, 1] }],
];
const quick = process.argv.includes('quick');
let failed = 0;
for (const [name, when, inQuick] of MOMENTS) {
  if (quick && !inQuick) continue;
  const target = next(when);
  const offset = Math.round((target - new Date()) / 60_000);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', './tests/clock-shift.mjs', '--test', '--test-concurrency=1', 'tests/*.test.js'],
    { cwd: ROOT, env: { ...process.env, NS_TEST_CLOCK_OFFSET_MIN: String(offset) }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] || 0);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] || 0);
  const ok = r.status === 0 && fail === 0 && pass > 0;
  if (!ok) failed += 1;
  const label = target.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${label.padEnd(28)} ${pass} passed${fail ? `, ${fail} failed` : ''}`);
  if (!ok) for (const line of out.split('\n').filter((l) => l.startsWith('not ok'))) console.log(`       ${line}`);
}
process.exit(failed ? 1 : 0);
