# Delivery, job recovery and complete backups

## Unknown WhatsApp delivery

A timeout is not proof that a message failed. The queue waits for the provider's
receipt and **never automatically resends an unknown delivery**. After five
minutes it creates a delivery-verification task. Later messages to the same
recipient remain held, preserving their order.

In Messages, check the provider console or contact the recipient. Record the
evidence and choose sent, confirmed not sent (permits another attempt), or cancel.
A delayed delivery receipt resolves the held message automatically. The ordinary
Retry button cannot resend an unknown delivery.

## Routine and timer recovery

Routine business changes and the completion marker now commit in the same
transaction. Failed attempts roll back their effects and retry after 1, 5, 15,
then 60 minutes, with a maximum of five attempts. A run interrupted by a restart
is eligible for recovery after ten minutes. Recovery automatically covers the
current period; interrupted older periods appear in health warnings and need
review before a manual run because their data may depend on the date.

Timer effects are also transactional and follow the same retry schedule. Missing
handlers fail visibly. First failures and exhausted retries alert the owner;
failed/retrying timers appear in system health. Review the cause before manually
retrying an exhausted timer. Manual forced routine runs intentionally create a
new run and can repeat a previously completed routine.

## Encrypted backups

When an existing database has pending schema migrations, server startup creates
and verifies a full encrypted **pre-upgrade** backup before applying them. If the
backup fails, startup stops without applying migrations. Already-current or new
databases skip this step. The backup filename is printed during startup; retain
that bundle and its separate key/password before deploying an upgrade. Stop the
old server before starting a new version against the same data directory.

The nightly backup is a `.nsbackup` bundle containing a consistent SQLite
snapshot, media, generated secrets, the `.env` file if present, and the effective
runtime configuration. Each file has a SHA-256 checksum. The bundle is protected
with AES-256-GCM; passwords use scrypt. Backup creation validates authentication
and checksums before retaining a file. The latest fourteen local bundles are kept.
Old `.db` files are database-only snapshots and are not full backups.

Choose either:

- Set `BACKUP_PASSWORD` to a unique password of at least 16 characters and retain
  it in a password manager. Keep it out of command history and source control.
- Leave it unset and retain **a separate copy of `DATA_DIR/backup.key`**. This key
  is generated on the first backup and is intentionally excluded from the bundle.

Losing the key/password makes recovery impossible. Downloading a bundle alone
does not preserve its key. Keep the key and backup in separately protected places.
The encryption protects the copied backup; anyone with access to both the local
key and local bundle can decrypt it.

Set `BACKUP_OFFSITE_DIR` to a mounted backup drive or protected sync destination
to copy every successful encrypted backup there. The copy is checksum-verified.
Copy failures fail the routine and raise an alert while preserving the local
bundle. A folder on the same physical disk is not disaster protection. The app
does not configure a cloud account or verify that a sync provider uploaded the
copy. Offsite retention is managed by the destination.

The implementation streams files with bounded memory. It pauses the single
backend process while creating its consistent snapshot; schedule it outside
business hours and monitor duration as photo storage grows.

## Validate and restore without overwriting live data

With `BACKUP_PASSWORD` supplied in the environment, omit `--key-file`. Otherwise:

```text
node scripts/backup.js validate C:\backups\nirmaan-....nsbackup --key-file C:\secure\backup.key
node scripts/backup.js restore C:\backups\nirmaan-....nsbackup C:\NirmaanRestored --key-file C:\secure\backup.key
```

Restore requires a **new directory**, authenticates/decrypts the bundle, verifies
all paths and checksums, and runs SQLite integrity and foreign-key checks. It
never overwrites an existing installation. The CLI exits unsuccessfully on bad
keys, tampering, incomplete data or database errors. Do not use a directory from
an unsuccessful restore.

After a successful restore, review `configuration/.env` and
`configuration/runtime.json` inside the restored directory. Restore the required
environment settings (including provider tokens that came from the environment),
adjust paths/host URL for the target machine, stop the old server, and set
`DATA_DIR` to the restored directory before starting it. Copy the separately
retained backup key there if you continue using key-file encryption. Existing
live sessions may be retained by the recovered database; invalidate them when
recovering from a suspected compromise.

Practice this on an isolated machine with workers disabled and WhatsApp set to
simulator before relying on it for an emergency.

## n8n integration delivery

Business-event webhooks now respond after enabled workflow steps finish. Errors
cause the backend to retry. Every new event has a stable `eventId`, also sent as
`Idempotency-Key`, preserved across retries. The example Sheets/CRM request
includes this ID. The recipient must store it with a unique constraint and apply
its business update in the same transaction; repeated IDs should return success
without repeating the action.

Delivery is at least once. A timeout or partial workflow failure can replay an
earlier step. Email/CRM/Sheets credentials and the example endpoint still need
configuration; the examples remain disabled until then. For a non-idempotent
action such as email, use a delivery service supporting an idempotency key or
accept possible duplicate notifications. Never claim exactly-once external
delivery based only on a successful HTTP response.

The workflow JSON passes structural/code checks; production n8n credentials and
external integrations must be exercised in a staging n8n instance before enabling.
