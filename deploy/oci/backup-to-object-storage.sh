#!/usr/bin/env bash
# Copies the system's encrypted daily backups (.nsbackup, made at 02:00 IST) to an OCI
# Object Storage bucket, so a lost or reclaimed VM never means lost data.
# Uses the VM's own identity ("instance principal"): no keys are stored on the server.
#
# One-time setup (OCI console, see deploy/oci/README.md):
#   bucket "nirmaan-backups", dynamic group for this VM, and the policy
#   Allow dynamic-group nirmaan-vm to manage objects in compartment nirmaan where target.bucket.name='nirmaan-backups'
# then on the VM:
#   sudo bash /opt/nirmaan/deploy/oci/backup-to-object-storage.sh --install
#
# The backups are encrypted; the key (backup.key or BACKUP_PASSWORD) is NOT copied.
# Keep it with the owner, outside OCI.
set -euo pipefail

BUCKET="${NS_BACKUP_BUCKET:-nirmaan-backups}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE=/var/backups/nirmaan
OCI_BIN="${OCI_BIN:-/root/bin/oci}"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi

if [[ "${1:-}" == "--install" ]]; then
  if [[ ! -x "$OCI_BIN" ]]; then
    echo "Installing the OCI command-line tool (one time)…"
    apt-get install -y -q python3-venv >/dev/null || true
    curl -fsSL https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh -o /tmp/oci-install.sh
    bash /tmp/oci-install.sh --accept-all-defaults
  fi
  "$OCI_BIN" os ns get --auth instance_principal >/dev/null \
    || { echo "The VM cannot reach Object Storage yet: check the dynamic group and policy."; exit 1; }
  line="30 2 * * * root NS_BACKUP_BUCKET=$BUCKET bash $APP_DIR/deploy/oci/backup-to-object-storage.sh >> /var/log/nirmaan-offsite.log 2>&1"
  echo "CRON_TZ=Asia/Kolkata" > /etc/cron.d/nirmaan-offsite
  echo "$line" >> /etc/cron.d/nirmaan-offsite
  chmod 644 /etc/cron.d/nirmaan-offsite
  echo "Installed: runs daily at 02:30 India time (after the 02:00 backup). Running once now…"
fi

mkdir -p "$STAGE"
cd "$APP_DIR"
# Copy the app's backup folder out of the Docker volume.
rm -rf "$STAGE/backups"
docker compose cp app:/data/backups "$STAGE/backups"
count=$(find "$STAGE/backups" -name '*.nsbackup' | wc -l)
if [[ "$count" -eq 0 ]]; then echo "$(date -Is) no .nsbackup files found — is the app running?"; exit 1; fi
# Upload new archives only; older copies stay in the bucket until its lifecycle rule removes them.
"$OCI_BIN" os object sync --auth instance_principal --bucket-name "$BUCKET" \
  --src-dir "$STAGE/backups" --include '*.nsbackup' >/dev/null
echo "$(date -Is) synced $count backup archive(s) to bucket $BUCKET"
