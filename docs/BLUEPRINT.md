# Nirmaan Sena — Workflow Blueprint v2 (corrected)

This is the corrected version of the 6-page workflow design ("Business automation overview",
"WhatsApp enquiries and support", "Architect assignment and site visits", "Quotation, project
delivery and aftercare", "Employee attendance and manager supervision", "Shared messaging,
delivery and recovery").

**What did not change (your core vision):**

- WhatsApp Business is the front door for enquiries and support, with automation.
- Architects are appointed through WhatsApp and receive the client's details **and site location**.
- Managers get one dashboard for clients, leads, projects, employees, attendance and tasks.
- One reliable backend: every change goes through the API into one database with an audit
  history and a transactional outbox (from the original design, kept as-is).
- A database and project-profile dashboard.

**Hybrid = three layers working together**

| Layer | What it does | Where |
|---|---|---|
| Coded core (the "engine") | WhatsApp webhook, conversation flows, leads, offers, visits, projects, attendance, outbox, timers, audit | `server/` |
| n8n (visual, editable) | AI understanding, scheduled routines, notifications to email/Sheets, error alerts, watchdog | `n8n/workflows/` |
| People (approvals) | One manager approval per lead, report review, quotation terms, milestone quality, HR/finance | Dashboard → Approvals |

If n8n is stopped, the core keeps working: the backend runs every routine itself as a fallback
(each routine has a run key per period, so a double trigger never runs it twice).

---

## Bugs found in the original design and how v2 fixes them

| # | Page | Bug | Fix in v2 |
|---|---|---|---|
| 1 | 1, 2, 3 | **Double approval.** A lead is approved twice: "Admin qualification" (page 2) and again "Approve assignment" (page 3). Slows the "< 15 min response" promise from the website. | **One** manager gate: *Approve & send offer*. The system pre-picks the best architect and slot; the manager confirms with one click. Optional auto-approve for complete, in-area leads (Settings). |
| 2 | 2 | "Human owns chat?" → Yes has **no timeout**. If staff never reply, the client waits forever and the bot stays muted permanently. | Takeover has an SLA timer (default 15 min, business hours): escalates to the manager and sends the client one holding message. Ownership **auto-releases** after 2 h of inactivity. |
| 3 | 2 | "Ask missing details" is a **dead end**: no reminder, no expiry. | Conversation state remembers what is being asked. One nudge after 24 h (template if the 24 h window closed). After 72 h with no reply the lead is marked *stale* with a reason. |
| 4 | 2 | "Identify request" outputs a confidence score but **no branch uses it**. | Low-confidence messages fall back to the button menu; still unclear → "Talk to team" hand-off. |
| 5 | 2 | No route for **job-seekers, labour, vendors, spam, voice notes, STOP/opt-out**. Common in construction. | Separate intents: job/vendor → HR/purchase task (not a lead); STOP/START → opt-out register; voice notes → staff; per-chat bot message cap (cost + loop protection). |
| 6 | 2 | "Verify project access" has **no "not authorised" branch**. | Unknown number asking about a project → no data revealed, a verification ticket is opened for staff. |
| 7 | 2 | "Admin qualification" has only an **Approved** branch. | Decisions: Approve & send offer · Need more info (asks client) · Sales call instead of visit · Reject (polite close with reason). Out-of-Jaipur enquiries go to the manager instead of being auto-rejected. |
| 8 | 3 | "Find eligible architect" has **no branch when nobody is free**. | Tries up to 3 architects automatically; then a manager task "No architect available" with the next free slots. |
| 9 | 3 | Slot reserved **after** the architect accepts → two offers can collide. | A short **hold** is placed on the architect's calendar when the offer is created (same database transaction). Expiry releases it. |
| 10 | 3 | Client "No / expired" path **leaves the slot held**. | Every exit path (decline, expiry, client timeout, cancel, reschedule) releases the hold in the same transaction. |
| 11 | 3 | Architect gets only a minimal summary + link; **your requirement was client details with location**. | Two-step: the offer shows locality, scope and time only (privacy). After the architect accepts **and** the client confirms, the architect receives client name, phone, address, a **WhatsApp location pin** and a Google Maps link. |
| 12 | 3 | **No-show** is mentioned in notes but has no node. Missing site report has no reminder. | Timer at start + 30 min: no architect check-in → manager alert. Architect can mark "client not available" → reschedule buttons sent to client. Report overdue reminders at +6 h / +24 h. |
| 13 | 3 | "Review visit report" has only **Approved**. | Approve → quotation · Revisit · Close lead (lost reason). |
| 14 | 4 | "Client accepts version" has **no revision or rejection branch** although its output says "revision request". | Accept → project · Request changes → new quotation version → manager approval → resend · No reply by validity date → follow-up then *expired*. |
| 15 | 4 | **Invoice → straight to handover**: the project ends after the first milestone. | Milestone **loop**: each milestone goes through work → quality review → client sign-off → invoice → payment → next milestone. Only the last one leads to snags + handover. |
| 16 | 4 | "Quality + milestone review" **rework branch missing**. | Rework sends the milestone back to the site team with notes. |
| 17 | 4 | Website promises **daily WhatsApp progress updates**; design had no schedule for it. | Daily site digest (7 PM): one message per active project summarising the supervisor's site log, with a photo page link. |
| 18 | 4 | Project started before any **advance payment**. | Project is created on acceptance with status *awaiting advance*; it becomes *active* when the booking payment is recorded. |
| 19 | 5 | **Missed check-out / no check-in** never detected. | Morning sweep (no check-in by shift start + grace) and evening sweep (open sessions closed as *missing checkout*, sent to review). |
| 20 | 5 | Leave/claim "Manager decision" has **no rejection branch**; approved leave did not affect scheduling. | Reject path notifies the employee. Approved leave blocks the person's calendar, so architects on leave are never offered visits. |
| 21 | 6 | "Reconcile current evidence" had nothing to match on when a send times out (no message id). | Every send carries `biz_opaque_callback_data = outbox job id`, which WhatsApp echoes in status webhooks. Reconciliation waits for that echo before any resend. |
| 22 | 6 | Window error (131047) treated like a generic failure. | Re-routed immediately to the approved template; if none is approved → operator task. |
| 23 | 6 | A fixed free-message allowance or dated tariff assumption can misstate costs. | Usage is bounded to the selected month. Managers configure rates and budgets; unknown rates remain unpriced. Daily AI and manual transcription caps limit compute attempts. |
| 24 | all | Messages to one person could arrive **out of order** (details before the location pin). | Outbox is FIFO per recipient; inbound events are processed FIFO per contact. |
| 25 | 1 | Website form (OTP-verified, reference `NS-JPR-YYYY-XXXX`) and WhatsApp created **separate records**. | Website form posts into the same intake; the website's reference becomes the Lead ID; the client is then asked on WhatsApp only for what is missing (site pin, visit time). |

---

## v2 flows (as implemented)

### 1. Overview

```
WhatsApp / website ─▶ Reliable intake (verify, store, dedupe, ACK) ─▶ Process per contact (FIFO)
   ├─ New enquiry ─▶ Guided capture (buttons + AI) ─▶ Lead ─▶ ONE manager approval ─▶ Architect offer
   │                    ─▶ Client confirms ─▶ Visit (details + location pin to architect) ─▶ Report
   │                    ─▶ Quotation versions ─▶ Project (advance) ─▶ Milestone loop ─▶ Handover ─▶ Warranty
   ├─ Existing client ─▶ Status / talk to site team / payments / raise issue (tickets with SLA)
   ├─ Human request / takeover ─▶ Staff in dashboard inbox (SLA + auto-release)
   └─ Job / vendor / spam / STOP ─▶ Routed away from the sales pipeline
Employee app ─▶ Attendance (GPS evidence, offline sync) + tasks + site logs + visit reports
Everything ─▶ Business API + one database + audit log + outbox ─▶ Messaging & recovery ─▶ WhatsApp
Timers (deadlines) + Routines (daily/monthly) ─▶ n8n schedules, backend fallback
```

### 2. WhatsApp enquiries and support

1. Webhook → verify `X-Hub-Signature-256` → store raw event (unique WhatsApp message id = dedupe)
   → **then** 200 ACK. Duplicates get ACK without repeating actions.
2. Processor takes the oldest pending event for each contact (per-contact order).
3. Global checks first: STOP/START, human request, EMERGENCY (after hours), stale button
   (old revision → "this request is no longer active").
4. Takeover active? → log + notify owner; SLA timer; no bot reply.
5. Understand: button/list id → exact action. Free text → AI (if on) else keyword rules (EN/HI/Hinglish).
   Low confidence → menu.
6. New enquiry → ask only missing fields: service, area (zone), project type, plot/built area
   (accepts sq ft, gaj, 30x40), timeline, name, **site location pin**, preferred visit slot
   (only slots where an architect is free) → summary → confirm.
7. Confirm → dedupe with open lead (merge) → out-of-area check → approval card for manager
   (or auto-approve) → client gets reference + expectation.
8. Existing client → project menu. Unknown number + project id → verification ticket (no data shown).
9. FAQ answers come only from the approved FAQ list. AI drafts go to staff, never straight to clients.

### 3. Architect assignment and site visits

1. Manager approves → eligible architects ranked (zone, skills, free calendar incl. buffer,
   not on leave, under daily cap, not tried before for this lead).
2. Offer revision + calendar hold in **one transaction** → WhatsApp offer (Accept / Decline) → expiry timer.
3. Decline / expiry → hold released → next architect (max 3) → else manager task.
4. Accept (only if the offer is still current) → client asked to confirm (Confirm / Another time / Cancel)
   with deadline + one reminder.
5. Confirm → Visit ID, hold becomes booking → architect gets **details + location pin + maps link**;
   reminders queued (client 24 h & 2 h, architect 2 h).
6. Another time → slot list → new offer revision (old revision invalidated, reminders become no-ops).
7. Visit day → architect checks in at site (GPS distance recorded) → no check-in by +30 min → manager alert.
8. Report (app) → manager: Approve → quotation · Revisit · Close. Overdue report reminders.

### 4. Quotation, project delivery and aftercare

1. Quotation version (service type and commercial model are separate fields; BOQ lines; GST;
   payment schedule; validity) → manager approval → client link + Accept / Request changes.
2. Request changes → new version → approval → resend. Expired → follow-up.
3. Accept → Project ID + milestones from the payment schedule → advance invoice → payment recorded → active.
4. Milestone loop: work + daily site logs → ready for review → quality pass / rework → client sign-off
   (Approve / Raise concern) → invoice → payment → next milestone.
5. Change request → cost/time impact → manager (+ client) approval → new baseline version. Never silent overwrite.
6. Last milestone → snags + handover approval → warranty (10-year structural) → aftercare tickets.
7. Daily digest to client at 7 PM; payment reminders; project status page via private link.
   Public portfolio needs separate consent; only locality-level info.

### 5. Employee attendance and manager supervision

1. Check-in/out from the app with GPS + accuracy + device time; offline events are queued on the
   phone and synced later (device time and server time both kept; originals immutable).
2. Validation: geofence (office, project site or visit site), accuracy, time skew, shift/late flags.
   Accepted or *needs review* — poor GPS is evidence, not automatic absence.
3. Manager review → approved correction / rejection → register recalculated.
4. Sweeps: morning (no check-in) and evening (missing checkout).
5. Tasks, visits, site logs and reports feed the team board (who is where, what is done, what is late).
6. Leave → manager → approved blocks calendar / rejected notifies. Expenses → manager → finance → paid.
7. Monthly summary → HR approval → CSV export for payroll.

### 6. Shared messaging, delivery and recovery

1. Every outgoing message is an outbox job written in the same transaction as the business change.
2. Dispatcher: oldest due job per recipient → reload state (guard: entity status + revision) →
   opt-out → 24 h window → free-form or approved template → else operator task.
3. Send with `biz_opaque_callback_data = ob:<job id>`.
4. Outcome: accepted → wait for status webhooks; transient (429/5xx/131000/131016/130429/131056)
   → bounded backoff; window error 131047 → template route; permanent → escalate to owner;
   timeout → *unknown* → reconcile via callback echo before resend.
5. Status webhooks (sent/delivered/read/failed) update the message log; failures of essential
   messages create a task for a named owner.
6. Error trigger in n8n + health watchdog alert the owner if anything stops.
