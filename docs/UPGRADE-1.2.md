# Manager workspace and WhatsApp workflows

This update separates business contacts from employees, adds a dedicated attendance dashboard and portable exports, and expands the existing WhatsApp workflows. The preview uses sample data and the simulator; it is not a live Meta connection.

## Find the right records

- **Clients** shows customers only. Linked employee contacts are excluded even if a legacy record has the wrong category.
- **Team** manages employee accounts, departments, job titles, shifts and work modes. An IT employee uses the `staff` access role with department `IT`; a designer who handles visits uses `architect` with a suitable title/department. Department labels never grant permissions.
- **Contact directory** is a separate manager view for all WhatsApp contacts, with client, staff, vendor and job-enquiry filters.
- **Attendance dashboard**, **Reports & exports** and **WhatsApp automation** are available to the owner and managers. The employee app remains limited to the signed-in employee's permitted work.

## Attendance and office presence

Employees tap Check in / Check out in the employee app. Each event records time, phone location and GPS accuracy. The server checks the location against the configured office and the employee's assigned sites, including a bounded accuracy allowance. Lateness is based on the employee's shift start plus their editable grace period. The selfie option is supporting evidence, not biometric identification.

Missing/poor GPS, an outside location or suspicious/offline timestamps are retained for manager review. Original evidence remains in the audit trail. A check-in is evidence of a reported arrival; it does not prove continuous presence or prevent all GPS/device spoofing. No continuous location tracking, face recognition or physical attendance device is installed.

The new dashboard shows all active non-owner employees by default, including office staff and field staff. Owners and inactive historical records can be included explicitly. Filter by date, employee, department, access role, work mode or status; inspect evidence and download the daily/monthly CSV. Today's lack of a check-in is shown as **not checked in**, rather than inventing an absence before the day ends. Holidays, weekly off and approved leave are considered.

The manager sees changes after online submission or offline synchronization. Exceptions enter Approvals. The hourly check at :15 produces missing-check-in notifications after the employee's shift start, grace and configured reminder delay. It covers all active non-owner roles and avoids duplicate daily reminders. Messages to employee phones require the live WhatsApp provider and any required templates; simulator messages remain in the preview. See [ATTENDANCE.md](ATTENDANCE.md) for timing, evidence rules and limitations.

For real phone testing, deploy over HTTPS and allow browser location access. A loopback preview URL works only on this computer. A device without location permission can submit an exception for review; it must not be presented as verified office attendance.

## Download data for analysis or storage

**Reports & exports** offers a consistent snapshot of all included business records, without the dashboard's row limits:

- ZIP of UTF-8 CSV files, with a manifest and column dictionary for Excel or other analysis tools.
- JSON preserving structured fields, values and relationships.

Choose a download folder, external drive or synchronized folder through the browser, or upload the downloaded file yourself. The application does not automatically connect a Drive account. Exports contain business/private information and should be shared only with intended recipients.

Analysis files omit authentication secrets, staff home coordinates, raw integration payloads and private access links. Every omitted table/column is listed. Original media files and complete internal data are available in the owner's **Database & backups → Backups** encrypted recovery bundle. Keep its separate key/password. See [EXPORTS.md](EXPORTS.md) and [RECOVERY.md](RECOVERY.md).

## WhatsApp for architects and designers

The manager registers the employee's current WhatsApp number in Team. Active recognized employees receive a work menu when they send a message. Their menu includes assigned visits, pending offers, tasks, project details and help from the manager. Guided visit reports and site updates require confirmation before submission. Travel uses the existing home/office choices, manager-set allowance and one-time claim controls. See [WHATSAPP-STAFF.md](WHATSAPP-STAFF.md) for the full flow and supported attachments.

Client details originate from the customer's enquiry, website form or manager-entered record. After the assigned architect accepts and the client confirms, the system sends the visit time, client name/phone, address, requirements and map link. A location pin is sent when available; an address without a pin is not an exact GPS location. Only the assigned employee may retrieve that visit's details.

Attendance remains in the employee app. Manager approval of money, quotations, staffing and other administrative actions remains on the dashboard. Employee WhatsApp replies do not gain dashboard privileges. Deactivated accounts and stale registered numbers cannot access work data.

## Customer automation and human support

The customer bot already supports bilingual service menus, enquiry collection, location sharing, visit confirmation, approved FAQ answers and authorized project/payment status. The new **WhatsApp automation** screen shows connection/configuration status, editable handover thresholds, answer management and a dry-run answer check that sends no messages and makes no AI calls.

Optional AI helps interpret language and extract enquiry fields. It does not invent a customer-facing price, promise or general answer: replies use approved FAQ text, guided prompts or verified records. Low-confidence AI output is not applied. With AI off, local menus and keyword rules continue to work.

Requests for a person, repeated unanswered questions and reply-limit events enter the manager inbox. Old chat buttons do not bypass human takeover. Explicit escalations remain with the team until **Give back to bot** is selected. Automatic resumption defaults to off; when enabled, it applies only to an answered, manually taken-over conversation without a pending explicit human request.

Review all FAQ answers before live use. Tune the reply limit high enough to complete a guided enquiry; existing custom settings are preserved. The default for a new installation is 40 replies per chat per hour, two unanswered attempts before handover and a 0.75 AI understanding threshold. AI provider credentials/model and daily usage limits remain separate settings.

## Real Meta connection

The code supports Meta WhatsApp Cloud API, but a Meta login alone does not activate this installation. Configure the business number and server-side credentials, publish the HTTPS webhook, subscribe the appropriate events, and verify inbound messages, outbound delivery receipts and required templates in a controlled pilot. Keep credentials in server configuration, not in chat or browser code. Do not switch the preview to real messaging for testing.

Meta's current policy permits free-form replies within its customer-service window and requires approved templates outside it; automated conversations need a clear path to human support. Verify current terms and approvals when connecting the account. [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/), [official developer setup](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started).

## Upgrade

Stop the old server before replacing code. Keep the source snapshot and your data/secrets. Startup creates a verified encrypted backup before applying pending migrations; migration 008 adds employee department/work-mode metadata without changing access roles. Restart, check your employee roster and office pin, then pilot the new flows with sample records. Existing live credentials and data are not replaced by this update.

For existing n8n installations, update and publish the revised scheduled-routines workflow to use hourly attendance checks; copying these files does not publish an external workflow. The preview uses the internal scheduler.

## Validation for this release

113 automated tests passed with no failures or skipped tests. Syntax checks passed for 105 JavaScript files, and all five n8n workflow files passed structural checks. Local browser checks covered client/staff separation, attendance search and mobile navigation, CSV ZIP downloading and approved-answer testing. Live Meta delivery and real-phone GPS still require the deployment pilot described above.
