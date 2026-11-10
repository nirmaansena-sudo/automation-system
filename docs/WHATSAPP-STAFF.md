# Staff work on WhatsApp

Architects, designers and other assigned staff can use the business WhatsApp number for their work. Send **MENU** from the active phone number saved in Team. Replies and buttons are available in English and Hindi; send **English** or **हिंदी** to switch.

The same deterministic menu works with the simulator, Meta Cloud API and 360dialog. It does not require AI or transcription. This release was tested with local simulator messages; enabling a live provider still requires the normal verified provider configuration.

## Available work

- **My visits:** upcoming assigned visits and reports from the last 30 days, confirmed client contact/site details, map directions, visit report and travel options.
- **Visit offers:** accept or decline pending offers. Existing offer buttons and template replies still work. A plain yes/no answer acts on an offer only when exactly one is pending and no work draft is active.
- **Visit report:** guided scope, measurements, concerns, recommendation and optional photos. Measurements and concerns can be skipped. Review the draft and explicitly confirm before submission. Existing manager report approval remains required.
- **My tasks:** assigned open tasks, full work brief and due time. Choose in progress, blocked or done, add an optional note, then confirm. A task changed by someone else must be reopened before saving.
- **My projects:** assigned active project details, milestone progress and latest site update. Submit a guided work update, optional issues and photos. The final confirmation chooses **Internal team only** or **Share with client**. Internal entries remain visible to authorized project staff and dashboard users; the client option exposes the entry and its photos on the client project page.
- **Travel:** compare home and office estimates for an assigned visit, choose an available origin and confirm it. Save or edit home/office locations in the employee app or dashboard first. A manager must verify distance and approve the amount; an estimated route is identified as an estimate. After the visit report is submitted, confirm the approved reimbursement claim. Finance review remains part of the existing expense workflow. Approval or payment cannot be performed through this menu.

Attendance continues in the employee app. This WhatsApp menu does not clock staff in or out, create attendance evidence or change attendance records. Quotation approval, payment recording and manager-only decisions are also unavailable here.

## Drafts, photos and recovery

**MENU** or **CANCEL** discards the current draft and opens the work menu. Work can also be opened with **visits**, **tasks** or **projects** when no draft is active. Drafts expire after two hours; an expired, reassigned, cancelled or changed item must be reopened. Lists paginate and never exceed ten options.

At the photo step, send up to eight JPG, PNG or WEBP images, each at most 8 MB, then choose **Review**. Files are initially stored privately against the incoming staff message. They are attached to a visit or site update only after successful confirmation and assignment checks. Cancelling a draft does not publish its files; the private inbox attachment remains available to authorized internal users. Documents, audio and video are not accepted as report photos.

Repeated webhook deliveries and confirmation buttons cannot create duplicate report submissions, site logs or claims. Changed assignments, visit revisions, task state, travel rates, origins and distance estimates are checked again before writing. A changed travel estimate requires a new confirmation.

Send **HELP** or choose **Ask my manager** for human assistance. Managers receive a dashboard notification linked to the staff conversation. Work automation pauses, including old work buttons, until the manager explicitly releases the conversation to the bot in Inbox. Further questions go to the human inbox.

## Access rules

The current active Team phone number identifies the staff member. Disabled staff and contacts still linked to an old staff number receive a generic access-unavailable reply instead of entering a previous customer conversation. Unknown numbers cannot use staff actions.

Every action checks the assigned staff ID, even if the sender has an owner or manager dashboard role. Guessing another visit, task or project ID grants no access. Assignment, account and human-mode checks also run before queued work responses are delivered. Travel messages show costs and origin type, not precise home coordinates. Home inputs are compared through a hash in the conversation draft.

## Verification

Run `node --disable-warning=ExperimentalWarning --test tests/staff-whatsapp.test.js tests/flow.test.js tests/security-dispatch.test.js` from the system folder. Tests use an isolated temporary database, local server, fake photos and WhatsApp simulator. They cover successful work flows, explicit confirmation, media visibility, replay, expiry/reassignment, travel approval and amount caps, routing races, human takeover, disabled/changed phone numbers and queued delivery guards.
