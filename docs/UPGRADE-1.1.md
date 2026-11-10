# Nirmaan Sena 1.1 — upgrade and operating guide

## What changed

This release hardens the existing enquiry → visit → quotation → project workflow and adds travel planning, H3 coverage, cost controls and materials management. Existing data is upgraded using numbered database migrations. No external integration is enabled automatically.

### Security and reliability

- Managers cannot reset owner credentials. Changing your own secret requires the current secret and ends existing sessions. Optional authenticator-based MFA and one-use recovery codes are available in **My security**.
- Attachment access follows project/visit assignments. Home pins and MFA material are excluded from generic database exports.
- Malformed cookies and invalid inputs return controlled errors. Login throttling uses normalized accounts and trusts forwarded IPs only from explicitly configured proxies.
- Uncertain WhatsApp deliveries wait for a receipt or an audited human decision; they are never blindly resent. **Messages → Unknown outcome → Verify delivery** records the evidence.
- Failed routines and deadlines retry with limits. **Messages → Failed deadlines** lets a manager retry after fixing the underlying problem.
- Personal-data erasure covers raw webhook payloads, conversations, client links, media, travel snapshots and related free text. Financial amounts/relationships remain. Historical backups are not rewritten; their retention must be managed separately.
- Full backups are encrypted and include the database, media and configuration. See [RECOVERY.md](RECOVERY.md) for the key, offsite copy, verification and restore procedure. An offsite folder is only effective if it is on independent storage or actually synchronized elsewhere.

### Architect travel

1. Open **Travel & dispatch → Rates & settings**. The manager enters the rate per kilometre, any fixed amount, minimum/maximum allowance, rounding and whether return travel is included. The real system starts with **no reimbursement rate**, not an invented company rate.
2. Confirm the real office pin in **Settings → Business & hours**. Existing coordinates are installation defaults and must be checked.
3. Architects use **Team app → Me → Travel starting point** to save a home pin and a normal home/office preference. A manager can maintain these under **Hex coverage**. No continuous GPS tracking is added.
4. Once a visit is confirmed, its employee screen offers **From home** and **From office**, with distance and allowance. The architect chooses the actual starting point.
5. The manager reviews the trip in **Travel approvals**. They may enter a verified total road distance and override the per-km rate for that trip. Approval fixes the rate and amount in an auditable snapshot.
6. After submitting the visit report, the architect can submit the approved travel expense **once**. It continues through the existing expense approval/payment flow. A cancelled visit cannot create a new claim.

The calculation is `fixed amount + reimbursable km × manager rate`, subject to the minimum, rounding increment and maximum. For return trips, reimbursable kilometres include both legs. Rate changes apply to new estimates and do not silently change already approved allowances.

**Distance accuracy:** with no routing service configured, distance is straight-line distance multiplied by an editable road allowance. This is clearly labelled as an estimate, not a measured route. The manager must explicitly accept it or replace it with verified kilometres. `OSRM_BASE_URL` can point to an approved/self-hosted OSRM service; road routes are cached for 30 days and include both directions for return journeys. A routing outage falls back to a labelled estimate. Actual traffic and GPS journey tracking are not implemented.

### Jaipur hex coverage and assignment

- H3 resolution 7 is the default: a configurable 25 km service radius around Jaipur produces approximately 380 cells. This is a planning area, **not an official municipal boundary**.
- The map generates connected territories for active architects/engineers with visit capacity. Territory size is balanced using daily capacity; adding or deactivating staff recalculates the plan. Already confirmed visits are not reassigned.
- Assignment first checks skills, shifts, leave, holidays, calendar conflicts, daily limits and feasible travel time between visits. Eligible candidates are ranked by estimated distance, workload and a small territory preference.
- A neighbouring available architect can receive a visit across a territory boundary. Territory ownership is a preference, not a barrier that leaves a client unserved.
- **Assignment preview** shows the ranking before the existing offer/accept/client-confirm process. Manual assignment cannot bypass core availability checks.
- Homes remain private. The coverage diagram shows territories, not staff home pins.

H3 is an open-source local index, not a paid map API. See the [H3 documentation](https://h3geo.org/docs/) and [OSRM route API](https://project-osrm.org/docs/v26.6.1/http) for the underlying interfaces. This implementation uses these building blocks; it does not reproduce Uber’s proprietary dispatch system or live traffic service.

### Money, materials and offline work

- Payments use request keys/reference checks to prevent duplicate recording. Input arithmetic uses integer paise, and quotation stages allocate the exact contract total.
- Scope reductions create credit records and reduce unbilled milestones/invoices; refunds are bounded by available credit. Paid invoices cannot simply be cancelled.
- The project money screen provides reconciliation, CSV export and an optional payment-clearance requirement before handover.
- **Materials & costs** supports purchase orders, receipts, stock consumption, external costs and project budgets. It separates used-material cost from remaining commitments and avoids counting linked reimbursements twice.
- These are operational estimates, not a full statutory accounting, tax filing or payroll system. Export and reconcile with your accounting system; no bank or payment gateway is connected automatically.
- Attendance, site logs and task updates can queue offline; their entries and visited screen data are stored per account in IndexedDB. Failed queued submissions remain available to review, edit or retry. Unidentified legacy offline entries are quarantined for recovery, never submitted under a different employee.
- Offline forms must have been opened online on that device first. Visit reports, leave requests, expense forms, travel, visit offers, MFA and financial actions still require a connection. Clear or manage device storage after staff/device changes.

### Keep operating costs controlled

- Start with internal routines and `AI_MODE=off`; the button/rule bot continues to work. n8n is now an optional Docker `automation` profile, so unused n8n does not consume server memory.
- **Usage & costs** uses rates entered by your manager/accounts team. Unknown rates remain unpriced. It does not assume a fixed WhatsApp free tier or fabricate a tariff.
- The owner can cap daily AI and transcription attempts. Reaching the AI limit falls back to rules; essential business messages continue.
- Voice transcription is optional and self-hosted, initiated by a manager in the inbox. Staff review/correct the transcript; it never sends a reply automatically. Hosting the speech model still consumes CPU/RAM/electricity. See [COSTS-VOICE.md](COSTS-VOICE.md).
- Use the existing CSV exports before paying for accounting integrations. n8n examples require credentials and activation; external receivers must deduplicate event IDs.

## Install or upgrade

1. Stop the existing process before replacing its code. Keep a backup of the existing data directory, media and secrets/configuration. Never put the live SQLite database in OneDrive.
2. Keep your existing `.env` and `DATA_DIR`. Replace application files and keep the `package-lock.json`. The Windows/Linux launchers install the single pinned `h3-js` dependency if missing; Docker installs it during the image build.
3. Start the application. Before changing an existing database, startup creates and verifies an encrypted pre-upgrade backup; a failure stops the upgrade. Existing databases then receive migrations 002–007 automatically. First-time installations require the setup code printed in the server window, including on HTTP/LAN.
4. Verify staff, projects, outstanding balances and a test visit. Configure your actual office/home pins and manager travel policy. Enable MFA. Run **Database → Backups → Back up now**, then download and retain the separate backup key (or retain your configured backup password).
5. For Docker, first follow [GO-LIVE.md](GO-LIVE.md): point your domain's DNS to the server, allow ports 80/443 for Caddy HTTPS, and set `DOMAIN=ops.yourdomain.com`, `PUBLIC_URL=https://ops.yourdomain.com`, `COOKIE_SECURE=true` and explicit secrets in `.env`. Then use `docker compose up -d --build` without n8n. To enable configured n8n, also point `n8n.ops.yourdomain.com` to the server, set `N8N_BASE_URL=http://n8n:5678`, then run `docker compose --profile automation up -d --build`. Only set `ROUTINES_MODE=n8n` after importing and activating the workflows.

New optional environment settings: `BACKUP_PASSWORD`, `BACKUP_OFFSITE_DIR`, `TRUSTED_PROXY_IPS`, `OSRM_BASE_URL`, `TRANSCRIPTION_URL`, `TRANSCRIPTION_TOKEN`, `TRANSCRIPTION_DAILY_LIMIT`, `TRANSCRIPTION_TIMEOUT_MS`, `AI_DAILY_LIMIT`. See `.env.example` for defaults. Never put credentials in the browser or in a public repository.

## Verification and limits

`npm test` exercises end-to-end business flows, security, MFA, delivery recovery, backup restoration, finances, offline queue logic, H3 dispatch, travel approval, materials and mock transcription. `npm run check` validates n8n exports. Regression tests use temporary databases and local mocks, not company data.

Browser checks cover the travel settings/hex view, employee app and operations interfaces. A live WhatsApp provider, real road-routing dataset, real speech model and external accounting service still need a controlled integration pilot. There is no claim that automated tests prove the absence of every defect.
