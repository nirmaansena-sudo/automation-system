# Version 1.1 validation record

Verified on 4 November 2026 with Node.js 24.13.1 on Windows. All business tests used temporary SQLite databases and test accounts. No company records, real messages, payments or external integrations were used.

- `npm test`: 83 passed, 0 failed, 0 skipped. Coverage includes original business flows, authentication and MFA, authorization, malformed inputs, unknown message outcomes, timer/routine recovery, encrypted backup restore/tampering, populated version 1 database migrations, duplicate payments/refunds, offline queue ownership, travel approvals/claims, H3 assignment, materials and mocked voice transcription.
- `npm run check`: all 5 bundled n8n workflows passed structural/code checks. This does not validate production credentials or third-party receivers.
- JavaScript syntax checks: all 93 application/script/test JavaScript files passed, including the two final presentation-only changes. The installed copy also loaded the pinned H3 library and generated a Jaipur cell successfully.
- The pinned `h3-js` 4.5.0 dependency installed successfully; the installation audit reported no vulnerabilities. The final lockfile passed an offline `npm ci --dry-run` check.
- Browser checks covered admin travel rates, Jaipur hex coverage at desktop/mobile widths, materials/cost screens, usage settings, and the architect visit screen. The isolated travel fixture selected home, received manager approval for 5.5 km at INR 8/km, displayed INR 44, and submitted a single claim into the pending-manager expense flow. These fixture values are not company defaults.
- No browser console errors were recorded during the final travel and costs walkthrough. Final review corrected the offline-support description, Docker prerequisites, fresh-install backup-key sequence, finance review-button visibility and the unset fixed-cost explanation.
- Independent final security review found no release blocker or populated secret/runtime database in the release tree.

The original source snapshot is retained separately from this release. The release copy is checked with SHA-256 hashes, and existing configuration/data are excluded from replacement. Startup creates and verifies an encrypted backup before migrating an existing database with pending schema changes.

## Remaining integration validation

Use a controlled pilot for the real WhatsApp provider/webhooks, optional n8n receivers, a road-routing service and a real speech model. Default distances are labelled estimates; the service region is configurable and is not an official Jaipur municipal boundary. Browser offline/network interruption behavior should also be exercised on the actual staff phones before rollout. Automated tests do not prove that every possible defect is absent.
