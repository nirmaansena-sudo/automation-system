# Security review — version 1.2.1 (10 November 2026)

Version 1.2.0 was attacked on a test copy in two rounds: first by hand, then with a code-wide
sweep for similar problems. Each attack below worked against 1.2.0. In 1.2.1 each one fails, and
a regression test proves it (`tests/security-review.test.js`, `tests/security-review-2.test.js`).
All 134 automated tests pass.

Severity is our own rating for this business: who can do it, and what they get.

## Fixed — round 1 (attacks that were demonstrated)

| # | Severity | Problem in 1.2.0 | Fix in 1.2.1 |
|---|---|---|---|
| 1 | High | A manager's phone + 6-digit app PIN gave a 30-day login that could download the full business export (every client's name, phone and address). | Exports need the dashboard login (password and two-step code). App (PIN) logins never carry owner/manager/finance rights anywhere (see 13). |
| 2 | High (once live) | Behind the Docker/Caddy proxy every visitor shared Caddy's address. 30 wrong passwords from anyone locked the whole team out, repeatably, and the audit log showed only Caddy. | `TRUSTED_PROXY_IPS` accepts ranges (`172.30.97.0/24`). Docker gives Caddy a fixed address and sets it automatically. The health panel warns when requests come through an unconfigured proxy. |
| 3 | Medium | A manager could set another manager's or finance user's password, reset their PIN, change their phone/email or promote anyone to manager, and log in as them. | Only the owner creates manager/finance accounts or changes their login details, role, status or PIN. Managers still edit shifts, zones and field staff. The person and the owner are notified of every such change made by someone else. |
| 4 | Medium-low | Login took ~1 ms for an unknown phone/email and ~30 ms for a real one, revealing who is on the staff. | Unknown accounts are checked against a throwaway hash; both now take the same time. |
| 5 | Low-medium | Architects could move their own home pin before claiming travel; only "pin set" was logged. | Each move records when, how far (km) and who; managers are notified; trips from a home pin the architect moved in the last 30 days need an explicit "I checked the home location" on approval. Coordinates stay private. |
| 6 | Low | Website form secret was also accepted in the URL (ends up in logs). | Header only (`X-Website-Secret`). |
| 7 | Low | Finance could open every photo, including client chat photos and attendance selfies. | Finance sees bills and project/site photos only. |
| 8 | Low | The backup key sits beside the backups; if the server is lost without a copy of the key, the off-site backups cannot be restored. | The health panel reminds the owner until the key is downloaded. |

## Fixed — round 2 (code-wide sweep, each lead verified)

| # | Severity | Problem in 1.2.0 | Fix in 1.2.1 |
|---|---|---|---|
| 9 | High | **Stored XSS → owner takeover.** A manager could save script text as a stage's "progress"; it ran when anyone opened the client project page (same site as the dashboard). | Stage name, dates and progress are validated (progress 0–100). The client pages render numbers defensively and send a strict Content-Security-Policy (no scripts at all). |
| 10 | High | **Stored XSS in the quotation dialog** through payment-stage names in Settings. | Values are escaped; stage names cannot contain `<` or `>`. The dashboard and app now send a Content-Security-Policy that allows only the site's own scripts. |
| 11 | High | **Client buttons were not tied to the client.** A modified WhatsApp app (or the simulator URL) could send another client's button ids to accept their quotation, sign off or reject their stage, apply a change request, or confirm/cancel their visit. | Every quotation, stage, change-request and visit button checks that the record belongs to the person pressing it; rejected attempts are audited. |
| 12 | High | In simulator mode the webhook URL accepted any message without a key — on a tunnel or server anyone could impersonate any client or employee. | The URL needs the key in simulator mode too (the simulator itself never uses it). |
| 13 | Medium | An owner/manager/finance person logged into the employee app with a PIN kept full rights there (all photos, any visit's travel). The owner's PIN was the setup password and stayed valid after a password change. | App logins act as an employee: own visits, sites, tasks and claims only. New owners get no PIN; existing owner PINs are cleared (set one under *My security* if you use the app). New PINs are 6–8 digits. |
| 14 | Medium | Anonymous requests could make the server buffer up to 40 MB each before being refused (memory exhaustion). | Logins are checked before the body is read; login/setup bodies are limited to 16 KB, the website form to 64 KB. |
| 15 | Medium | An employee could back-date attendance by marking a live check-in as "offline" (accepted without review, up to 48 h back). A missing GPS accuracy gave a free 50 m. | Live check-ins always use the server clock. Queued (offline) items older than the time-skew limit go to manager review. Missing accuracy counts as weak GPS. |
| 16 | Medium | Expense approval was not tied to roles or people: one manager or finance user could submit, approve both stages and mark a claim paid; anyone could approve their own leave or attendance. | Nobody decides their own expense, leave or attendance (the owner excepted). Expenses need a manager, then a different person from finance. |
| 17 | Medium | Any manager could force repeated backups, pushing older backups out of the 14 kept. | Starting a backup is owner-only and limited to once per 10 minutes. |
| 18 | Medium | n8n was published on the internet; the first visitor could create its owner account and read the automation key. | n8n is no longer published. It listens on the server only; open it through an SSH tunnel. |
| 19 | Low-medium | Site logs accepted any date, any stage id and any progress text (could break the client page); event ids were global, so one person's id could swallow another's log. | Dates within the last 7 days, stage must belong to the project, progress 0–100, labour counts checked, no logs on closed projects, event ids scoped to their author. |
| 20 | Low-medium | The same bank reference could be recorded twice under different methods; extra invoices had no double-submit guard or cap; expenses accepted sub-paise amounts and any date. | One reference per project; identical extra invoices within 10 minutes are blocked and an extra invoice cannot exceed the contract value; expenses use whole paise, up to ₹10,00,000, dated within the last 90 days. |
| 21 | Low | Upload files were written before validation; no daily limit; client WhatsApp media had no size cap. | Duplicates and invalid check-ins are rejected before saving; 300 MB per person per day; WhatsApp media above 25 MB is not downloaded. |
| 22 | Low | Employees received manager-written HR notes in their own profile; finance could read raw GPS of check-ins; demo accounts with published passwords could stay active on a live system; logout had no cross-site check; the verify token was compared in variable time. | Fixed each; the health panel warns about active demo accounts on a live system. |

## Known limitations (not changed)

- **GPS is reported by the phone.** A determined person can fake a location; the system keeps evidence and
  sends doubtful cases to review, but cannot prove physical presence.
- **Client links (`/q/`, `/p/`) do not expire.** Anyone with a link can view that quotation or project.
  Ask before adding expiry/rotation, because clients reuse these links.
- **Staff can see client links** (projects, quotations) because they send them to clients.
- **The verify token is also the 360dialog/simulator webhook key.** Keep it private; a separate key can be
  added if you use 360dialog.
- **Finance can switch off the "payment before handover" check** for a project (a reason is required and it
  is audited). Change the role rules if you want this to be owner-only.
- **Simulator mode is for testing.** Its clock control and test tools must not be used with real clients.

## After upgrading to 1.2.1

1. Owner: open *My security* and turn on two-step verification; ask managers and finance to do the same.
2. If you used the employee app as the owner, set a new 6–8 digit PIN under *My security*.
3. Docker: run `docker compose up -d --build` (Caddy now has a fixed internal address; n8n is no longer public —
   remove the `n8n.` DNS record and use the SSH tunnel in [GO-LIVE.md](GO-LIVE.md#5-n8n-optional-recommended)).
4. Check *Settings → Connections → System health*: no proxy, demo-account or backup-key warnings.
