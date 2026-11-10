# Nirmaan Sena 1.2.1 — Hybrid Automation System

**1.2.1 security update:** fixes from a two-round red-team review — client buttons tied to their owner,
no stored scripts, owner-only control of manager/finance accounts, PIN logins limited to employee rights,
real visitor addresses behind the proxy, two-person expense approval, private n8n. Read
[SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md) and do its four upgrade steps.

**New in 1.2:** separate client and employee records; manager attendance for every department;
downloadable CSV/JSON business data; architect WhatsApp work menus; stronger customer handover.
Read the [manager workspace and WhatsApp guide](docs/UPGRADE-1.2.md),
[export guide](docs/EXPORTS.md) and [staff WhatsApp guide](docs/WHATSAPP-STAFF.md).

**New in 1.1:** security and recovery fixes; manager-set travel allowances from home or office;
Jaipur H3 hex coverage and distance/workload assignment; materials, inventory and project budgets;
credits/refunds, safer offline work, optional MFA and local voice transcription.

Start with the [upgrade and operating guide](docs/UPGRADE-1.1.md). Existing company rates are not assumed:
set reimbursement under **Travel & dispatch → Rates & settings**.

WhatsApp enquiries and support, architect site visits (with client details and location pin),
quotations and project delivery, employee attendance and tasks, and manager dashboards —
on one reliable backend, with n8n for the parts you want to change visually.

```
WhatsApp / website ──▶ Reliable intake ──▶ Bot (buttons + optional AI, English/Hindi)
                                              │
              ┌───────────────────────────────┼─────────────────────────────────┐
              ▼                               ▼                                 ▼
   ONE manager approval ──▶ Architect offer ──▶ Client confirms ──▶ Visit: details + 📍 pin to architect
              │                                                                 │
              ▼                                                                 ▼
   Quotation versions ──▶ Project ID ──▶ Stage loop (work → quality → client OK → invoice) ──▶ Handover ──▶ Warranty
Employee app ──▶ GPS check-in, tasks, site logs, visit reports, leave, expenses (works offline)
Everything ──▶ one database + audit history + outbox ──▶ WhatsApp (retries, templates, recovery)
n8n ──▶ AI understanding · daily/monthly schedule · email/Sheets/CRM · error alerts · watchdog
```

## Try it on your Windows PC (10 minutes)

1. Install **Node.js 22.13+** from <https://nodejs.org>. The start script installs the pinned `h3-js` library on first use if it is missing; this requires internet once.
2. Double-click **`start-windows.bat`**. The dashboard opens at <http://localhost:3000/admin/>.
3. Enter the setup code printed in the server window, create the owner account and tick **Load demo data** only when testing.
4. Open **WhatsApp simulator** (left menu) and follow the *Try these* steps: chat as a new client in
   English, Hindi or Hinglish, approve the visit, accept it as the architect, confirm as the client —
   the architect receives the client's name, phone, address and location pin.
5. Open **<http://localhost:3000/app/>** for the employee app (demo staff log in with phone
   `9800000101` … `9800000106`, PIN `1234`).

Nothing reaches real phones until you switch `WHATSAPP_PROVIDER` from `simulator` to `cloud`
(see [docs/WHATSAPP-SETUP.md](docs/WHATSAPP-SETUP.md)).

> **OneDrive note:** this folder is inside OneDrive. The start script automatically keeps the
> database in `%LOCALAPPDATA%\NirmaanSena\data` so OneDrive sync can never lock or damage it.
> Back it up from *Database → Backups*.

## What is inside

| Part | Where | What it does |
|---|---|---|
| Backend (Node.js, built-in SQLite) | `server/` | WhatsApp webhook, bot, leads, offers, visits, quotations, projects, attendance, outbox, timers, routines, audit |
| Manager dashboard | `/admin/` | Overview, WhatsApp inbox (take over any chat), approvals, leads, site visits, projects, clients, team & attendance, tasks & tickets, messages, database, settings, simulator |
| Employee app (mobile, offline) | `/app/` | Check-in/out with GPS, visit offers, visit check-in & report, daily site log with photos, stage “ready for review”, tasks, leave, expenses |
| Client pages (private links) | `/q/…` `/p/…` | Quotation page; project page with stages, daily photos, payments |
| n8n workflows | `n8n/workflows/` | 5 importable workflows — see [n8n/README.md](n8n/README.md) |
| Docs | `docs/` | [Interactive blueprint](docs/blueprint.html) (open in a browser) · [Blueprint v2 (bugs fixed)](docs/BLUEPRINT.md) · [WhatsApp setup](docs/WHATSAPP-SETUP.md) · [Templates](docs/TEMPLATES.md) · [Go live](docs/GO-LIVE.md) · [User guide](docs/USER-GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) |

## Why "hybrid"

* **Code where reliability matters** — every business change is one database transaction with an audit
  entry and, if a message must go out, an outbox job. Messages are rechecked before sending, retried
  safely, never sent out of order, and reconciled with WhatsApp's delivery receipts.
* **n8n where you want flexibility** — schedules, AI prompts and integrations are visual and editable.
  If n8n stops, the backend runs any missed routine itself.
* **People where judgement matters** — one approval per enquiry, quality checks, quotations, leave,
  expenses and attendance exceptions, all in *Approvals*. Staff can take over any chat; the bot
  steps back and returns after 2 hours of inactivity.

## Costs to plan for

* WhatsApp: enter the applicable provider rates in **Usage & costs**. The system does not assume a
  free-message allowance or a tariff change date. Recorded usage and estimates are not a provider invoice.
* Hosting: budget for your selected machine or hosting plan, backups and any local compute resources.
  See [docs/GO-LIVE.md](docs/GO-LIVE.md) for deployment and [docs/COSTS-VOICE.md](docs/COSTS-VOICE.md) for estimates.
* AI and voice transcription are optional. Direct AI modes need an explicit model; daily caps limit
  attempts. Voice transcription is off until a self-hosted backend is configured and a manager requests it.

## Commands

```
start-windows.bat          start the system (Windows)
start-n8n-windows.bat      start n8n locally (optional)
./start.sh  |  ./start.sh n8n     same on Mac/Linux
npm test                   business, security, recovery, travel and cost-control regressions
npm run check              validate the n8n workflow files
```

Requirements: Node.js 22.13+ and the single pinned open-source dependency `h3-js` (`npm ci`).
SQLite, HTTP, encryption and backup logic use Node built-ins. Maps, AI and speech services are optional;
the default installation makes no paid map or speech API calls.
