# Portable business reports

Owners and managers can open **Reports & exports** and download all reviewed
business data in either format:

- **CSV ZIP:** one UTF-8 CSV per table, `manifest.json`, `schema.json` and
  `README.txt`. Extract the ZIP before importing the files into Excel or another
  analysis tool. ZIP uses the standard stored method, without compression or
  additional dependencies. The archive limit is 4 GiB; if exceeded, the request
  fails explicitly and recommends JSON. No truncated archive is delivered.
- **JSON:** a single file with `manifest`, `schema`, `readme` and `tables`.
  Tables contain arrays of records, SQL NULL is `null`, and recognized structured
  business fields are arrays/objects rather than encoded JSON strings. Invalid
  historical JSON is retained as text. There is no format-level 4 GiB limit.

There are **no row limits and no date filters**. Empty tables are included with
their column schema (CSV headers or empty JSON arrays). The download's manifest
records the exact row counts, included fields, omitted fields/tables, application
version, applied migration names and snapshot timestamp. Counts on the report
screen can change before download because the business is still running.

The package covers clients and leads, communication text/status, quotations and
projects, visits, stages and site logs, invoices/payments/credits/refunds,
reconciliations, staff/attendance/leave/expenses, travel allowances, material
orders/receipts/use, budgets and costs, transcripts, media metadata, approvals,
support/tasks, audit metadata, automation history, usage and reference tables.
Use IDs and related `*_id` fields to connect these records.

## Amounts, quantities and spreadsheet imports

Values are exported without presentation rounding or currency symbols. Ordinary
money fields are INR rupees. Fields ending `_paise` are integer paise (divide by
100); quantities ending `_milli` are thousandths of the stated material unit
(divide by 1,000). Dates/timestamps retain their stored values; no time-zone
conversion or date regrouping is performed.

CSV is comma-delimited, uses CRLF, quotes/escapes all cells and starts with a UTF-8
BOM for Hindi-compatible spreadsheet imports. SQL NULL is an empty CSV cell.
Text beginning with formula characters (`=`, `+`, `-`, `@`, including after
whitespace/control characters) is prefixed with an apostrophe. Numeric negative
values remain numeric. JSON does not add spreadsheet apostrophes.

Import phone numbers, account/reference strings and other identifiers as **Text**
to prevent spreadsheet automatic number/date conversion. For large tables, use
an analysis tool that supports the manifest's row count. The file itself is not
cut down to fit a worksheet. JSON preserves the original value types.

## Intentional privacy and credential exclusions

Exports use explicit table and column allowlists. New database columns/tables
are not automatically exposed: the manifest lists anything omitted. Analysis
files exclude:

- Password/PIN hashes, sessions, MFA/recovery material and runtime secrets.
- Staff home profiles, precise route endpoints, raw attendance/media GPS and
  route caches. Client project/site coordinates remain available in lead/project
  records; travel distances, policy amounts and payment references remain.
- Raw provider/webhook/job payloads and arbitrary audit/approval/state JSON;
  diagnostic errors that may contain tokens or internal configuration.
- Public quotation/project/visit access tokens and payment links. Recognizable
  private access URLs (including media `?t=` access), bearer credentials and
  sensitive URL query parameters appearing in text are redacted. Nested business
  JSON, including visit reports, omits secret-like and private home/origin keys.
- Original photo/audio/file bytes and their local paths. Their metadata and
  transcripts are included, allowing analysis and linkage by media ID.

Names, phone numbers, messages, business notes and financial details are included.
These analysis packages are **not encrypted**. Manually entered business prose
cannot be guaranteed free of sensitive information; review before sharing.

## Full recovery backup is a separate download

Use **Database → Backups** as owner for a complete encrypted `.nsbackup` archive.
That archive includes the database, original media and configuration, with a
separate key/password needed for restoration. Analysis ZIP/JSON is not intended
to restore the running system and deliberately omits its authentication state.
See [RECOVERY.md](RECOVERY.md) for verification and restoration.

## Save anywhere

The browser downloads a normal file. Choose a destination with its Save As
setting, move the file to any local/external drive or synced folder, or manually
upload it to the storage service you choose. The app requires no cloud account
and does not upload anything automatically. The response includes an
`X-Export-SHA256` checksum for programs that want to verify the downloaded bytes.

## Consistency and temporary files

The server first creates a consistent SQLite snapshot, then a worker thread
iterates all selected rows and streams the sanitized file with bounded memory.
The database snapshot briefly pauses the main process; the longer CSV/JSON
generation runs outside it. Only one report can be prepared/downloaded at once
to bound disk and CPU use. A second concurrent request receives HTTP 429.

Protected files are kept under `DATA_DIR/export-tmp/job-*`. The raw snapshot is
deleted immediately after report generation. The sanitized file is removed
after successful download, failure or disconnection. A process/OS crash can leave
an abandoned directory; app startup and the next export clean app-owned jobs
older than 24 hours. The manifest is checked against the actual written row
counts before the report is served. No partially generated report is delivered.

HTTP routes (authenticated owner/manager only):

```text
GET /api/exports/inventory
GET /api/exports/business.zip
GET /api/exports/business.json
```

Finance and employee accounts cannot use the all-business-data endpoints. Export
requests are recorded in the audit trail. No paid service or extra npm package is
required.
