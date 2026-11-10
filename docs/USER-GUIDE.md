# User guide

Two apps, one system:

| Who | Opens | Logs in with |
|---|---|---|
| Owner, managers, finance | **Dashboard** — `/admin/` on a computer | Email + password |
| Architects, engineers, supervisors, staff | **Employee app** — `/app/` on the phone (*Add to Home screen*) | Phone number + PIN |
| Clients | Nothing to install — WhatsApp, plus private links for quotations and their project page | — |

Add people in *Team & attendance → ＋ Add person* (role, zones, skills, shift, weekly off, visits per day).
The PIN is shown once; *Reset PIN* makes a new one. Finance users see projects, invoices, expenses and payroll
but not chats.

---

## 1. What runs by itself every day

| Time (IST) | What happens |
|---|---|
| 08:30 | Morning brief to managers: yesterday's leads, today's visits, approvals waiting, overdue tasks, payments due this week |
| Hourly at :15 | Attendance check for all active non-owner employees after shift start + grace + configured reminder delay; one missing-check-in reminder per employee per day |
| 10:30 | Payment reminders to clients for due invoices |
| 11:00 | One nudge to enquiries waiting 24 h for details; *stale* after 72 h; expired quotations |
| 19:00 | Daily site update to every client with an active project (from the supervisor's site log) |
| 21:00 | Missing check-outs closed and sent for review |
| 02:00 | Database backup (last 14 kept) |
| 1st of month, 09:00 | Attendance & expense summary for payroll approval |

Deadlines are watched all the time: architect offers (30 min), client confirmation (4 h, one reminder),
visit reminders (24 h and 2 h before), architect not checked in by +30 min, visit report due (+6 h, +24 h),
approvals waiting more than 30 min, staff not answering a taken-over chat in 15 min.

---

## 2. The journey of one enquiry — what you click

**1. Client writes on WhatsApp** (English, Hindi or Hinglish — "mujhe Vaishali Nagar me 150 gaj plot pe ghar
banwana hai" works). The bot asks only what is missing: service, area, plot size, timeline, name, **site location
pin** and a visit time (only times when an architect is free). It shows a summary; the client confirms.

**2. Approvals → the lead card.** The system has already picked the best architect and slot.

* **Approve & send offer** — the usual click.
* *Choose architect / time* — change the pick first.
* *Ask client* — the bot asks the client for what you need.
* *Call instead* — creates a call task instead of a visit.
* *Decline politely* — closes with a reason. Out-of-Jaipur enquiries: *Accept — treat as Jaipur* or decline.

**3. Architect gets the offer** on WhatsApp and in the app (locality, scope, time — no client details yet):
Accept or Decline within 30 minutes. No answer → the next architect (up to 3) → else a task for you.

**4. Client confirms** the time (or picks *Another time* / *Cancel*).

**5. Architect receives the client's name, phone, address, the WhatsApp location pin and a Google Maps link.**
Reminders go to both automatically.

**6. Visit day.** The architect checks in at the site in the app (GPS distance is recorded) and submits the
report with photos. *Approvals → visit report*: **Approve → prepare quotation** · *Needs another visit* · *Close lead*.

**7. Quotation.** *Leads → (lead) → 📄 New quotation*: BOQ lines, GST, payment schedule (defaults per service),
validity → *Submit for approval* → *Approvals* → **Approve & send to client**. The client gets a private link with
**Accept** / **Request changes**. Changes → new version → approval → resent.

**8. Project.** On acceptance a Project ID is created with its stages and an advance invoice. *Record payment*
when the advance arrives → the project becomes **active**.

**9. Stages (loop).** The supervisor posts a daily site log with photos (app) → marks a stage *Ready for review* →
*Approvals*: **Quality OK → ask client to sign off** or *Rework needed* → client taps **Approve** (or *Raise concern*)
→ stage invoice → *Record payment* → next stage. A change in scope: *＋ Change request* (cost and time impact,
client approves) — nothing is overwritten silently.

**10. Handover.** After the last stage: snag list and handover approval → warranty starts → later problems come in
as tickets with an SLA.

You can also start manually: *Leads → ＋ New lead* (walk-in or phone call) → *Submit for approval*.

---

## 3. WhatsApp inbox

* Every chat is listed; red marks need attention (client asked for a person, voice note, emergency, bot reply
  limit reached, new message while a person owns the chat).
* **Take over** — the bot stops in that chat and you type. If nobody replies within 15 minutes (office hours) the
  manager is alerted and the client gets one "we'll get back to you" message.
* **Give back to bot** — or it happens by itself after 2 hours without staff messages.
* **Send template** — WhatsApp allows free text only within 24 hours of the client's last message; after that
  choose an approved template.
* **Mark handled** clears the attention flag.
* The bot answers questions only from *Settings → FAQ answers*, so keep that list correct (prices, areas, timings).
  Clients can type **STOP** to stop messages and **START** to resume.

---

## 4. Team & attendance

* **Check-in / check-out** in the app records GPS position and accuracy. Inside the office radius (200 m), a project
  site or the visit location → accepted. Poor GPS, far away or wrong phone time → *needs review* — **not** absent.
* **Review** in *Approvals → attendance*: *Approve*, *Approve with corrected time*, or *Reject*. The register
  recalculates.
* No internet at site? The app saves check-ins and logs on the phone and sends them later (up to 48 hours).
* **Leave**: app → *Requests* → manager approves or rejects in *Approvals*. Approved leave blocks the calendar, so
  nobody on leave is offered a visit.
* **Expenses**: app → *Requests* (photo of the bill) → manager → finance → *Mark paid*.
* **Payroll**: on the 1st, approve the monthly summary in *Approvals*, then *Team & attendance → Download CSV*.
* The team board shows recorded locations, open tasks, visits and late items. *Check missing attendance* runs the
  attendance check immediately.

## 5. Employee app (for staff)

| Tab | What you do there |
|---|---|
| **Today** | Check in / out · visit offers (Accept / Decline) · today's visits · tasks · your sites |
| **Tasks** | Open tasks — update or finish them |
| **Sites** | Post today's site log with photos · mark a stage *ready for review* · see rework notes |
| **Requests** | Apply for leave · submit an expense with the bill photo |
| **Me** | Your attendance this month · change PIN |

Visits: open the visit → *📍 Navigate* → **I have reached the site — start visit** → after the meeting fill the
**site report** (measurements, scope agreed, site constraints, recommendation, budget range, client interest,
up to 8 photos) → *Submit report*. If the client is not there, tap *Client not available* — the client gets buttons
to pick a new time.

## 6. Other pages

* **Overview** — key numbers, *Needs your decision*, *Site visits today*, new leads per day, the lead pipeline,
  *Chats needing a person* and system health.
* **Leads / Site visits / Projects / Clients** — search, open the profile, timeline (every change with who/when),
  chat, documents and photos. *Open client's project page* shows exactly what the client sees.
* **Tasks & tickets** — everything assigned to people; client issues with priority and SLA.
* **Messages** — *Outgoing queue*: every WhatsApp message and its status (queued, sent, unknown outcome, failed);
  *Retry* a failed one. *Templates*: mark each as approved after Meta approves it. *Usage & cost*: monthly
  messages by category (for the WhatsApp bill). *Failed incoming*: *Process again*.
* **Database** — browse any table, *Export CSV*, the *Audit history*, *Back up now* and backup downloads (owner).
* **Settings** — Connections (WhatsApp, AI, n8n, website form, system health) · Business & hours · Automation
  rules (visit times, offer timeout, auto-approve, daily update time, bot limits) · Zones · FAQ answers · Holidays ·
  Routines (last runs, *Run now*) · My account.
* **WhatsApp simulator** (only in simulator mode) — chat as any client, architect or supervisor to train new staff
  or try a change safely. The *+30 min* / *+2 h* buttons move the clock forward to test reminders and deadlines.

## 7. Privacy

* Architects get a client's phone and address **only after** they accept and the client confirms.
* Client pages use private links; staff see only their own visits and sites in the app.
* Erase a person's data on request: *Clients → (client) → Erase personal data* (owner only, cannot be undone).
* Every change is in the audit history (*Database → Audit history*).

## 8. Quick fixes

| Problem | Where to look |
|---|---|
| "Client didn't get my message" | *Messages* — status and error; *failed* → *Retry*; "needs manual send" → template not approved yet |
| Architect didn't get the offer | *Approvals* / *Site visits* — offer status; architect should message the business number once |
| Bot gave a wrong answer | *Settings → FAQ answers* — fix the answer or its keywords |
| Someone's check-in shows *needs review* | *Approvals → attendance* — it is evidence, decide with the photo/location |
| A daily update or reminder did not go | *Settings → Routines* — last run and result; *Run now* |
| Anything red in *System health* | *Settings → Connections*; see [GO-LIVE.md §9](GO-LIVE.md#9-monitoring) |
