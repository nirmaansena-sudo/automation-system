// Crawl every dashboard route at several widths; record errors, overflow, a11y basics; save screenshots.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.argv[2] || 'ui-check-output';
const LOGIN = process.env.LOGIN; const PASS = process.env.PASS;
if (!LOGIN || !PASS) { console.error('Set LOGIN and PASS to a dashboard owner or manager (read-only: this only opens pages).'); process.exit(1); }
const VIEWPORTS = (process.env.VPS || 'desktop:1440x900,tablet:820x1180,phone:390x844').split(',').map((s) => { const [n, d] = s.split(':'); const [w, h] = d.split('x').map(Number); return { name: n, width: w, height: h }; });
const ROUTES = (process.env.ROUTES || 'overview,inbox,approvals,leads,visits,travel,projects,operations,clients,attendance,team,tasks,automation,contacts,messages,simulator,reports,costs,settings,security,data').split(',');
const settle = async (page, ms = 600) => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms); };
(async () => {
  const browser = await chromium.launch();
  const report = [];
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, colorScheme: process.env.SCHEME || 'light' });
    const page = await ctx.newPage();
    let cur = { errors: [], failed: [] };
    page.on('console', (m) => { if (m.type() === 'error') cur.errors.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => cur.errors.push('PAGEERROR ' + e.message.slice(0, 300)));
    page.on('response', (r) => { if (r.status() >= 400) cur.failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
    await page.goto(`${BASE}/admin/`); await page.waitForSelector('#login');
    await page.fill('#login [name=login]', LOGIN); await page.fill('#login [name=password]', PASS);
    await page.click('#login button.primary'); await page.waitForSelector('#login', { state: 'detached' }); await settle(page);
    const dlg = await page.$('dialog[open] [data-close]'); if (dlg) await dlg.click();
    fs.mkdirSync(`${OUT}/${vp.name}`, { recursive: true });
    const queue = ROUTES.map((r) => `#/${r}`); const seen = new Set();
    while (queue.length) {
      const hash = queue.shift(); if (seen.has(hash)) continue; seen.add(hash);
      cur = { errors: [], failed: [] };
      const t0 = Date.now();
      await page.goto(`${BASE}/admin/${hash}`); await settle(page);
      const info = await page.evaluate(() => {
        const vw = window.innerWidth; const de = document.documentElement;
        const wide = [];
        for (const el of document.querySelectorAll('#content *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > vw + 2 && !el.closest('.table-wrap, .tabs, svg, .chat, .reg-wrap, [style*="overflow"]')) { wide.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')}@${Math.round(r.right - vw)}`); if (wide.length > 6) break; }
        }
        const noName = [...document.querySelectorAll('#root button, #root a')].filter((el) => !(el.innerText || '').trim() && !el.getAttribute('aria-label') && !el.title).length;
        const noLabel = [...document.querySelectorAll('#content input:not([type=hidden]):not([type=checkbox]):not([type=radio]), #content select, #content textarea')].filter((el) => !el.closest('label') && !el.getAttribute('aria-label') && !el.placeholder && !(el.id && document.querySelector(`label[for="${el.id}"]`))).length;
        const small = [...document.querySelectorAll('#content button, #content a.btn, #content .chip')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 30); }).length;
        // tables: on wide screens the heading cells must sit exactly above their columns
        const badTables = [...document.querySelectorAll('#content table')].filter((t) => { if (!t.tHead || !t.tBodies[0]?.rows[0] || t.getBoundingClientRect().width === 0) return false; const th = [...t.tHead.rows[0].cells]; const row = [...t.tBodies[0].rows].find((r) => r.cells.length === th.length && ![...r.cells].some((c) => c.colSpan > 1)); if (!row) return false; if (vw <= 700 && t.classList.contains('rowcards')) return getComputedStyle(row.cells[0]).display !== 'block'; return getComputedStyle(t).display !== 'table' || th.some((h, i) => Math.abs(h.getBoundingClientRect().left - row.cells[i].getBoundingClientRect().left) > 2); }).length;
        const tabs = [...document.querySelectorAll('#content nav.tabs a[href^="#/"]')].map((a) => a.getAttribute('href'));
        const links = [...document.querySelectorAll('#content a[href^="#/"]')].map((a) => a.getAttribute('href'));
        const title = document.querySelector('#title')?.textContent || '';
        const bad = document.querySelector('#content .notice.bad')?.innerText || '';
        const text = (document.querySelector('#content')?.innerText || '').length;
        return { badTables, hOverflow: de.scrollWidth - vw, wide, noName, noLabel, small, tabs, links, title, bad, text, height: de.scrollHeight };
      });
      const file = `${OUT}/${vp.name}/${hash.replace(/[#/?=&]+/g, '_').replace(/^_/, '')}.png`;
      await page.screenshot({ path: file, fullPage: vp.name !== 'desktop' ? true : false });
      report.push({ vp: vp.name, hash, ms: Date.now() - t0, ...info, errors: cur.errors, failed: cur.failed, links: undefined, tabs: undefined });
      if (vp === VIEWPORTS[0]) {
        for (const t of info.tabs) if (!seen.has(t)) queue.push(t);
        // first detail link of each kind (e.g. #/leads/3, #/projects/1)
        const kinds = new Set();
        for (const l of info.links) { const m = /^#\/([a-z]+)\/(\d+)/.exec(l); if (m && !kinds.has(m[1]) && ![...seen].some((s) => s.startsWith(`#/${m[1]}/`)) && !queue.some((q) => q.startsWith(`#/${m[1]}/`))) { kinds.add(m[1]); queue.push(l); } }
      }
    }
    if (vp === VIEWPORTS[0]) ROUTES.splice(0, ROUTES.length, ...[...seen].map((h) => h.slice(2)));
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  for (const r of report) {
    const flags = [];
    if (r.errors.length) flags.push(`ERR:${r.errors.length}`);
    if (r.failed.length) flags.push(`HTTP:${r.failed.join('|')}`);
    if (r.hOverflow > 2) flags.push(`OVERFLOW:${r.hOverflow}px ${r.wide.slice(0, 3).join(',')}`);
    if (r.badTables) flags.push(`TABLE:${r.badTables}`);
    if (r.bad) flags.push(`BAD:${r.bad.slice(0, 80)}`);
    if (r.noName) flags.push(`noName:${r.noName}`);
    if (r.noLabel) flags.push(`noLabel:${r.noLabel}`);
    if (r.vp === 'phone' && r.small) flags.push(`small:${r.small}`);
    console.log(`${r.vp.padEnd(7)} ${r.hash.padEnd(34)} ${String(r.ms).padStart(5)}ms h=${String(r.height).padStart(5)} ${flags.join('  ')}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
