// Employee app on a phone: login, slow GPS check-in (button state, double tap), toast position.
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000'; const OUT = process.argv[2] || 'ui-check-output'; require('fs').mkdirSync(OUT, { recursive: true });
if (!process.env.PHONE || !process.env.PIN) { console.error('Set PHONE and PIN of a DEMO employee (never the live system: this records a check-in).'); process.exit(1); }
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: 26.9124, longitude: 75.7873 }, permissions: ['geolocation'] });
  const page = await ctx.newPage(); const errors = []; const posts = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/app/attendance')) posts.push(r.url()); });
  // slow GPS: answer after 1.5 s
  await page.addInitScript(() => { const g = navigator.geolocation; const orig = g.getCurrentPosition.bind(g); g.getCurrentPosition = (ok, err, opt) => setTimeout(() => orig(ok, err, opt), 1500); });
  await page.goto(`${BASE}/app/`); await page.waitForSelector('#login');
  await page.fill('#login [name=phone]', process.env.PHONE).catch(async () => { console.log(await page.content()); });
  await page.fill('#login [name=pin], #login [name=password]', process.env.PIN);
  await page.click('#login button'); await page.waitForSelector('#punch'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/app-home.png`, fullPage: true });
  const before = await page.textContent('#punch');
  await page.click('#punch'); await page.click('#punch', { force: true }).catch(() => {}); await page.waitForTimeout(400);
  const during = await page.evaluate(() => { const b = document.querySelector('#punch'); return { text: b.textContent, disabled: b.disabled, busy: b.classList.contains('busy'), color: getComputedStyle(b).color }; });
  await page.screenshot({ path: `${OUT}/app-punching.png` });
  await page.waitForTimeout(2600);
  const toast = await page.evaluate(() => { const t = document.querySelector('#toasts .toast'); const bar = document.querySelector('.tabbar'); if (!t) return null; const r = t.getBoundingClientRect(); const b = bar.getBoundingClientRect(); return { text: t.textContent, toastBottom: Math.round(r.bottom), tabbarTop: Math.round(b.top), clear: r.bottom <= b.top }; });
  await page.screenshot({ path: `${OUT}/app-punched.png` });
  const after = await page.textContent('#punch');
  console.log(JSON.stringify({ before, during, toast, after, attendancePosts: posts.length, errors }, null, 1));
  for (const tab of ['tasks', 'sites', 'requests', 'me']) { await page.goto(`${BASE}/app/#/${tab}`); await page.waitForTimeout(700); await page.screenshot({ path: `${OUT}/app-${tab}.png`, fullPage: true }); }
  console.log('errors after tabs', JSON.stringify(errors));
  await browser.close();
})();
