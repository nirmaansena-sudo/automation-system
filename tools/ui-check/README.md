# Screen checks (optional, for developers)

These three scripts open the real screens in a browser and look for the kinds of
problems people notice but automated tests miss. They are **not** needed to run the
system and are not part of `npm test`. They need Playwright (`npm i -D playwright`
then `npx playwright install chromium`) on the developer's computer.

Run them against a **demo copy** (`npm run demo`), never the live system: two of them
create test data.

| Script | What it does | Writes data? |
|---|---|---|
| `crawl.cjs` | Opens every dashboard page and tab at desktop, tablet and phone width. Reports script errors, failed requests, sideways scrolling, tables whose headings do not line up, buttons without a name, boxes without a label. Saves a screenshot of each. | No |
| `journey.cjs` | A manager on a touch phone and on a desktop: menu, card tables, new lead, inbox, approvals, losing and regaining the connection, double-click. | Yes (one lead, one approval) |
| `team-app.cjs` | An employee on a phone with slow GPS: check-in button state, a double tap, where the message appears. | Yes (one check-in) |

```
BASE=http://localhost:3000 LOGIN=owner@example.com PASS=... node tools/ui-check/crawl.cjs out
BASE=http://localhost:3000 LOGIN=owner@example.com PASS=... node tools/ui-check/journey.cjs out
BASE=http://localhost:3000 PHONE=9800000101 PIN=1234 node tools/ui-check/team-app.cjs out
```

Useful switches for `crawl.cjs`: `SCHEME=dark`, `VPS="phone:390x844"`, `ROUTES="leads,inbox"`.
A clean crawl prints one line per page with nothing after the height.
