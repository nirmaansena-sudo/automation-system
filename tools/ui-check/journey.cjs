// Manager journeys on a touch phone and a desktop: menu, card tables, new lead, inbox panes, approval, offline banner.
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000'; const OUT = process.argv[2] || 'ui-check-output';
const LOGIN = process.env.LOGIN; const PASS = process.env.PASS;
if (!LOGIN || !PASS) { console.error('Set LOGIN and PASS to a dashboard owner or manager of a DEMO copy (never the live system: this creates a test lead).'); process.exit(1); } const fs = require('fs'); fs.mkdirSync(OUT, { recursive: true });
const results = []; const ok = (name, pass, extra = '') => { results.push({ name, pass: !!pass, extra }); };
async function login(page) {
  await page.goto(`${BASE}/admin/`); await page.waitForSelector('#login'); await page.fill('#login [name=login]', LOGIN); await page.fill('#login [name=password]', PASS);
  await page.click('#login button.primary'); await page.waitForSelector('#login', { state: 'detached' }); await page.waitForTimeout(500);
  const dlg = await page.$('dialog[open] [data-close]'); if (dlg) await dlg.click();
}
(async () => {
  const browser = await chromium.launch(); const errors = [];
  const watch = (page, tag) => { page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(`${tag} ${m.text().slice(0, 200)}`); }); page.on('pageerror', (e) => errors.push(`${tag} PAGEERROR ${e.message}`)); };
  // ---------------- phone with touch
  const ctx = await browser.newContext({ ...devices['Pixel 7'] }); const page = await ctx.newPage(); watch(page, 'phone');
  await login(page);
  await page.tap('#menu'); await page.waitForTimeout(350);
  ok('menu opens with a backdrop', await page.evaluate(() => getComputedStyle(document.querySelector('#backdrop')).display !== 'none' && document.querySelector('#menu').getAttribute('aria-expanded') === 'true'));
  await page.screenshot({ path: `${OUT}/phone-menu.png` });
  await page.tap('.side a[href="#/leads"]'); await page.waitForSelector('table.t.rowcards'); await page.waitForTimeout(400);
  ok('menu closes after choosing a page', await page.evaluate(() => document.querySelector('#menu').getAttribute('aria-expanded') === 'false'));
  const small = await page.evaluate(() => [...document.querySelectorAll('#content button, #content a.btn, #content .chip, .top button')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 36; }).map((el) => `${el.tagName}.${el.className}:${Math.round(el.getBoundingClientRect().height)}`));
  ok('touch targets on Leads are at least 36 px tall', small.length === 0, small.slice(0, 5).join(' '));
  await page.tap('table.t.rowcards tbody tr:first-child'); await page.waitForFunction(() => /^#\/leads\/\d+/.test(location.hash)); await page.waitForTimeout(500);
  ok('tapping a lead card opens the lead', true); await page.screenshot({ path: `${OUT}/phone-lead.png`, fullPage: true });
  await page.goto(`${BASE}/admin/#/leads`); await page.waitForSelector('#newlead'); await page.tap('#newlead'); await page.waitForSelector('dialog[open]'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/phone-newlead.png` });
  const sheet = await page.evaluate(() => { const d = document.querySelector('dialog[open]'); const r = d.getBoundingClientRect(); return { w: Math.round(r.width), bottomGap: Math.round(innerHeight - r.bottom), names: [...d.querySelectorAll('[name]')].map((e) => e.name) }; });
  ok('dialog is a full-width sheet on the phone', sheet.w >= 400 && Math.abs(sheet.bottomGap) <= 1, JSON.stringify(sheet));
  await page.fill('dialog[open] [name=name]', 'Journey Test'); await page.fill('dialog[open] [name=phone]', '9812345678');
  if (sheet.names.includes('locality')) await page.fill('dialog[open] [name=locality]', 'Vaishali Nagar');
  await page.locator('dialog[open] button.primary').tap();
  const created = await page.waitForFunction(() => /^#\/leads\/\d+/.test(location.hash), null, { timeout: 5000 }).then(() => true).catch(() => false);
  ok('new lead is created from the phone', created, created ? '' : await page.evaluate(() => document.querySelector('dialog[open] .form-error')?.textContent || 'no error text'));
  // inbox single pane
  await page.goto(`${BASE}/admin/#/inbox`); await page.waitForSelector('.conv'); await page.waitForTimeout(300);
  ok('inbox shows only the chat list first', await page.evaluate(() => { const c = document.querySelector('.pane.chat-pane'); return !c || getComputedStyle(c).display === 'none'; }));
  await page.tap('.conv'); await page.waitForFunction(() => /^#\/inbox\/\d+/.test(location.hash)); await page.waitForTimeout(500);
  ok('opening a chat shows the chat alone with a way back', await page.evaluate(() => getComputedStyle(document.querySelector('.pane.list')).display === 'none' && !!document.querySelector('.back-link') && getComputedStyle(document.querySelector('.back-link')).display !== 'none'));
  await page.screenshot({ path: `${OUT}/phone-chat.png` });
  await page.tap('.back-link'); await page.waitForFunction(() => location.hash === '#/inbox'); ok('back link returns to the chat list', true);
  // offline banner
  await page.goto(`${BASE}/admin/#/overview`); await page.waitForTimeout(600);
  await ctx.setOffline(true); await page.evaluate(() => { location.hash = '#/tasks'; }); await page.waitForTimeout(1500);
  const off = await page.evaluate(() => ({ banner: getComputedStyle(document.querySelector('.netbar')).display !== 'none', text: document.querySelector('#content').innerText.slice(0, 120) }));
  ok('losing the connection shows a banner, not a blank page', off.banner && off.text.length > 10, JSON.stringify(off)); await page.screenshot({ path: `${OUT}/phone-offline.png` });
  await ctx.setOffline(false); await page.waitForFunction(() => getComputedStyle(document.querySelector('.netbar')).display === 'none', null, { timeout: 12000 }).then(() => ok('banner clears by itself when the connection returns', true)).catch(() => ok('banner clears by itself when the connection returns', false));
  await page.waitForTimeout(800); ok('the page that failed loads after reconnecting', await page.evaluate(() => !document.querySelector('#content .notice.bad') && /task/i.test(document.querySelector('#title').textContent) && document.querySelector('#content').innerText.length > 40), await page.evaluate(() => document.querySelector('#content').innerText.slice(0, 160)));
  await ctx.close();
  // ---------------- desktop
  const d = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await d.newPage(); watch(p, 'desktop'); await login(p);
  await p.goto(`${BASE}/admin/#/approvals`); await p.waitForTimeout(800);
  const btn = p.locator('[data-do="approve"]').first();
  if (await btn.count()) { await btn.dblclick(); await p.waitForTimeout(1200); const toasts = await p.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => `${t.className}: ${t.textContent}`)); ok('double-click on Approve acts once', toasts.filter((t) => t.includes('err')).length === 0, toasts.join(' | ')); }
  await p.keyboard.press('Tab'); ok('skip link is the first Tab stop', await p.evaluate(() => document.activeElement?.classList.contains('skip') || document.activeElement?.tagName !== 'BODY'));
  await p.goto(`${BASE}/admin/#/tasks`); await p.waitForTimeout(600); await p.click('#theme'); await p.waitForTimeout(200);
  ok('theme button switches the look', await p.evaluate(() => !!document.documentElement.dataset.theme)); await p.screenshot({ path: `${OUT}/desktop-theme.png` });
  await d.close(); await browser.close();
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.extra && !r.pass ? '  → ' + r.extra : ''}`);
  console.log('console errors:', JSON.stringify(errors));
})().catch((e) => { for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.extra}`); console.error(e); process.exit(1); });
