# Architecture

For whoever maintains or extends the system. The business view is in [BLUEPRINT.md](BLUEPRINT.md).

## Principles

1. **One system of record.** Every business change (lead, offer, visit, quotation, stage, payment, attendance)
   happens in one database transaction together with its **audit entry** and the **outbox jobs** for the
   messages it causes. Nothing is "sent and hoped".
2. **Reliability is code, flexibility is n8n.** Deadlines, ordering, retries and WhatsApp rules live in the
   backend. Schedules, AI prompts and integrations live in n8n. If n8n is down, the backend covers for it.
3. **People decide, the system remembers.** One approval per decision, with SLA timers and a full timeline.
4. **Swappable edges.** WhatsApp provider (simulator / Meta Cloud API / 360dialog) and AI provider
   (off / Anthropic / OpenAI-compatible / n8n) are adapters behind one interface.
5. **Small dependency surface.** Node.js ≥ 22.13 built-ins plus one pinned open-source library, `h3-js`, for hexagonal spatial indexing. Install reproducibly with `npm ci`. Keep runtime and dependencies updated; use encrypted full backups rather than copying a live SQLite file.

## Components

```
                      ┌──────────────────────────── server/ (one Node.js process) ───────────────────────────┐
WhatsApp ──webhook──▶ │ whatsapp/webhook   verify signature → inbound_events (unique key) → 200 ACK          │
Website  ──form─────▶ │ api/public                                                                          │
                      │      │                                                                               │
                      │      ▼  core/workers  (per-contact FIFO, 3 attempts, then apology + alert)           │
                      │ bot/engine ── bot/nlu (rules EN/HI/Hinglish) ── bot/ai (optional, JSON only)        │
                      │      │                                                                               │
                      │      ▼  domain/*  leads · scheduling · visits · quotations · projects · staff ·     │
                      │                   support · approvals            (each change = one tx())           │
                      │      │                                                                               │
                      │      ├─▶ audit_log      ├─▶ timers (deadlines)      ├─▶ notifications (dashboard)    │
                      │      └─▶ outbox ──▶ core/outbox dispatcher ──▶ whatsapp/providers ──▶ WhatsApp API   │
                      │                          └──────────────▶ n8n events (X-NS-Secret)                  │
                      │ core/routines (daily/monthly, run keys)  ◀── n8n schedules (X-Automation-Key)        │
                      │ api/admin  → /admin/ dashboard     api/app → /app/ employee PWA (offline queue)      │
                      │ pages/public-pages → /q/ quotation, /p/ project, /v/ visit (private token links)     │
                      └─────────────────────────────── db/ SQLite (WAL) in DATA_DIR ─────────────────────────┘
```

## Life of a WhatsApp message

1. **Intake** (`whatsapp/webhook.js`): signature check (`X-Hub-Signature-256` HMAC with the app secret; 360dialog:
   secret key header/URL) → the raw event is stored in `inbound_events` with a unique key (`msg:<wamid>`,
   `st:<wamid>:<status>:<ts>`) → `200` only after the row is committed. Re-deliveries are ignored.
2. **Processing** (`core/workers.js`): status events first, then the oldest pending message **per contact**
   (never two messages of one person in parallel). Failure → retried with back-off; after 3 attempts the event is
   marked failed, the chat is flagged for a person, the client gets a short apology and the owner an alert
   (*Messages → Failed incoming → Process again*).
3. **Understanding** (`bot/engine.js`): global commands (STOP/START, "talk to a person", EMERGENCY), stale-button
   check (every button carries the entity revision), human takeover, then the current flow step. Button ids map to
   exact actions; free text goes to the AI adapter if enabled, else keyword rules; low confidence → menu.
4. **Business change** (`domain/*`): inside `tx()` — state change + audit + outbox jobs + timers. Nested calls
   use savepoints, so a failing step rolls back only its own part and never leaves half a change.
5. **Dispatch** (`core/outbox.js`): due jobs, oldest first **per recipient**, leased for 3 minutes. Before sending
   it re-checks the *guard* (is the offer still open? same revision?), opt-out, and the 24-hour window
   (with a 10-minute margin) → free-form message, approved template, or an operator task.
6. **Send** with `biz_opaque_callback_data = ob:<job id>`. Results:
   * accepted → `sent`, wamid stored;
   * transient (429, 5xx, 131000, 131016, 130429, 131056…) → back-off 0.5, 2, 10, 30, 120, 360 min;
   * 131047 (window closed) → immediately re-routed to the template;
   * timeout / connection cut → **unknown**: no blind resend; waits for a status webhook carrying the callback
     data, otherwise re-checks later;
   * permanent → `failed`; essential messages create a task for a named person.
7. **Status webhooks** update `messages` (sent → delivered → read / failed) and reconcile unknown jobs.

## Data model (SQLite, `server/db/001_init.sql`)

| Group | Tables |
|---|---|
| People & config | `users` (roles: owner, manager, finance, architect, engineer, supervisor, staff), `sessions`, `settings`, `zones`, `holidays`, `faqs`, `counters`, `system_state` |
| WhatsApp | `contacts`, `conversations`, `messages`, `media`, `inbound_events`, `outbox`, `wa_templates` |
| Sales | `leads`, `approvals`, `visit_offers`, `calendar_holds`, `visits`, `quotations` |
| Delivery | `projects`, `milestones`, `site_logs`, `invoices`, `payments`, `change_requests`, `tickets` |
| Team | `tasks`, `attendance_events` (immutable originals), `attendance_days` (computed), `leave_requests`, `expense_claims` |
| Engine | `timers`, `routine_runs`, `notifications`, `audit_log` |

IDs shown to people come from `counters`, per year: `NS-JPR-2026-0007` (lead), `NS-VIS-…`, `NS-QT-…`,
`NS-PRJ-2026-001`, `NS-INV-…`, `NS-CR-…`, `NS-TKT-…`. A website reference number is reused as the Lead ID.
Amounts are whole rupees; GST is applied on the quotation subtotal. Quotations, the project baseline and change
requests are versioned, never overwritten.

## Deadlines and routines

**Timers** (`core/timers.js`) are rows with a due time and the entity revision they were created for; when they fire
they check the entity is still in that state, so a cancelled or rescheduled visit never gets a stale reminder:
`offer_expiry`, `client_confirm_reminder`, `client_confirm_deadline`, `visit_reminder`, `visit_noshow_check`,
`visit_report_due`, `approval_sla`, `human_sla`, `human_release`, `milestone_client_deadline`, `ticket_sla`.

**Routines** (`core/routines.js`): morning brief 08:30, missing check-in attendance checks hourly at :15, payment reminders 10:30, lead follow-ups
11:00, client digest 19:00 (setting), attendance 21:00, backup 02:00, monthly summary (1st, 09:00), housekeeping
hourly. Each run inserts a **run key** for its period (`name:2026-11-02`), so n8n + backend fallback + a manual click
can never run it twice. `ROUTINES_MODE=n8n`: n8n triggers them; the backend runs any routine n8n missed by
`ROUTINE_FALLBACK_MIN` (20 min). Daily routines older than 6 hours are not "caught up" after a PC was off (except backup).

## Security

* Passwords and PINs: scrypt with a random salt per secret. Sessions: random tokens, `HttpOnly; SameSite=Lax` cookies
  (`Secure` with `COOKIE_SECURE=true`); employee app uses a bearer token so it works offline-first.
* Every state-changing browser request needs the `X-NS: 1` header (blocks cross-site form posts).
* Roles are checked on every endpoint; employees can only reach `/api/app/*` and only their own visits, sites,
  tasks and requests. Owner-only: secrets, backups, erasing personal data.
* Webhooks: Meta signature (app secret) or 360dialog secret key; website form: `X-Website-Secret`;
  n8n → backend: `X-Automation-Key`; backend → n8n: `X-NS-Secret`. All compared in constant time.
* First-time setup on an `https://` address needs the one-time code printed in the server log.
* Client links (`/q/`, `/p/`, `/v/`) are long random tokens; photos and files are served only to logged-in users
  or, for a project's client-visible photos, through that project's link. Architects see client contact details only after acceptance **and** client confirmation.
* Privacy (DPDP): consent stored per contact; STOP/START opt-out register; *Erase personal data* removes name,
  messages, address and photos and keeps anonymous numbers; GPS only at check-in/out and visits; audit log of
  every change.

## AI boundary

`bot/ai.js` sends the message, the current step and what is already known, and gets back **JSON only**
(intent, service, locality, area, timeline, language, confidence). `sanitize()` validates every field against the
known catalog and zones. The AI **never writes text that goes to a client**: clients receive fixed bilingual
messages, approved FAQ answers and real data. Timeout 9 s → rules take over; AI errors never block a conversation.
Modes: `anthropic` and `openai` require an explicit `AI_MODEL` (the latter can use a compatible API via `AI_BASE_URL`),
`n8n` (workflow 01 decides which model).

## n8n contract

| Direction | Endpoint | Auth |
|---|---|---|
| n8n → backend | `GET /api/automation/health`, `GET /api/automation/summary`, `GET /api/automation/routines`, `POST /api/automation/routines/:name/run`, `POST /api/automation/alerts`, `POST /api/automation/ping` | `X-Automation-Key` |
| backend → n8n | `POST {N8N_BASE_URL}/webhook/ns-events` (business events via the outbox, retried), `POST …/webhook/ns-ai-understand` | `X-NS-Secret` |

Events: `lead.submitted`, `visit.confirmed`, `visit.cancelled_by_client`, `visit.report_submitted`, `quotation.sent`,
`project.created`, `invoice.issued`, `payment.recorded`, `milestone.accepted`, `project.handover`, `expense.approved`,
`ticket.created`, `brief.morning`, `payroll.summary` — each with `event`, `at` and `data`.
Workflow JSON is generated by `scripts/build-n8n.py` and validated by `npm run check`.

## Extending

| To add… | Do this |
|---|---|
| A WhatsApp provider (e.g. an Indian BSP with its own API) | New adapter in `whatsapp/providers.js` returning `{ok, wamid}` / `{ok:false, code, transient, window, unknown}`; map its webhook to the Cloud API shape in `whatsapp/webhook.js` |
| A database change | New file `server/db/002_<name>.sql`; applied once at start (`schema_migrations`) |
| A message template | `whatsapp/templates.js`, then `node scripts/build-templates-doc.js` to refresh TEMPLATES.md |
| A routine | Entry in `ROUTINES` (`core/routines.js`) and, for n8n mode, a schedule in `scripts/build-n8n.py` |
| An approval type | `createApproval({kind})` in the domain module + a `case` in `domain/approvals.js` + a card in `public/admin/views/approvals.js` |
| A bot answer | No code: *Settings → FAQ answers* |

## Limits and scaling

One process with SQLite (WAL) comfortably handles a firm of this size: thousands of messages and hundreds of
check-ins per day, a few dozen dashboard users. Background loops: inbound (event-driven), outbox dispatcher,
timers every 15 s, scheduler every 30 s. If Nirmaan Sena grows to several branches, the `db/` layer is small enough
to move to PostgreSQL without touching the flows.

## Code map

```
server/
  main.js, index.js        start, routes, background loops
  config.js                .env + auto-generated secrets (DATA_DIR/secrets.json)
  db/                      SQLite, migrations, tx() with savepoints, backups
  lib/                     http router, auth, utilities (IST time, phone, money)
  whatsapp/                webhook intake, providers, message formats, templates
  bot/                     conversation engine, rules (nlu), AI adapter, texts (i18n), service catalog
  domain/                  business rules: leads, scheduling, visits, quotations, projects, staff, support, approvals
  core/                    outbox, timers, routines, workers, audit/notify/settings
  api/                     admin (dashboard), app (employees), public (webhooks, setup, n8n, simulator)
  pages/                   client pages (quotation, project, visit)
  seed/                    demo data
public/admin  public/app  public/shared   dashboard, employee PWA, shared UI
n8n/workflows               5 importable workflows
tests/                      end-to-end tests (npm test)
```

## Tests

`npm test` boots the real server on a temporary database and drives it like WhatsApp would:
`flow.test.js` (enquiry → approval → offer → confirmation → visit details with pin → report → quotation → project →
stages → handover, Hindi/Hinglish), `reliability.test.js` (signatures, dedupe, 24-hour window, retries, unknown
outcomes, FIFO, guards — against a mock Cloud API), `dialog360.test.js`, `staff.test.js` (attendance, leave,
expenses, roles) and `n8n.test.js` (workflow logic). `npm run check` validates the n8n files.
