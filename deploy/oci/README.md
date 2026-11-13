# Hosting on Oracle Cloud (OCI)

One Arm VM in the Mumbai region runs the same Docker setup as any server (`docker-compose.yml`:
app + Caddy for HTTPS + optional n8n). Sized for OCI's Always Free allowance (2 OCPUs, 12 GB).
The full plan, with costs, risks and the go-live checklist, is the team's
"Nirmaan Sena — hosting plan on Oracle Cloud (OCI)" document.

## In the OCI console

1. Home region **India West (Mumbai)**; upgrade to Pay As You Go; a budget alert for any spend.
2. Compartment `nirmaan`; VCN wizard "Create VCN with Internet Connectivity".
3. Public subnet security list: ingress TCP 80 and 443 from `0.0.0.0/0`; TCP 22 only from the office IP.
4. Instance: Ubuntu 24.04 (aarch64), `VM.Standard.A1.Flex` 2 OCPU / 12 GB, 50 GB boot volume,
   public IPv4, your SSH public key. Change its public IP to a **reserved** IP.
5. DNS A record `ops.nirmaansena.com` → the reserved IP.

## On the VM (SSH as `ubuntu`)

```sh
sudo git clone https://github.com/nirmaansena-sudo/automation-system.git /opt/nirmaan
sudo bash /opt/nirmaan/deploy/oci/setup-server.sh ops.nirmaansena.com
```

`setup-server.sh` installs updates and Docker, opens 80/443 in Ubuntu's own iptables rules
(Oracle's images reject them even when the security list allows them; do not enable `ufw`),
creates `.env` with four random secrets (never overwrites an existing one) and starts everything.
Then open `https://ops.nirmaansena.com/admin/` and create the owner with the printed setup code.
Continue with `docs/GO-LIVE.md` from section 4 (business settings, WhatsApp, website form).

## Off-site backups (Object Storage)

1. Bucket `nirmaan-backups` (private, Standard) in `nirmaan`; lifecycle rule: delete after 60 days.
2. Dynamic group `nirmaan-vm`: `instance.id = '<the VM OCID>'`.
3. Policy (root compartment):
   ```
   Allow dynamic-group nirmaan-vm to manage objects in compartment nirmaan where target.bucket.name='nirmaan-backups'
   Allow dynamic-group nirmaan-vm to read buckets in compartment nirmaan
   ```
4. `sudo bash /opt/nirmaan/deploy/oci/backup-to-object-storage.sh --install`
   (copies once now, then daily at 02:30 IST; log: `/var/log/nirmaan-offsite.log`).

The archives are encrypted. The owner keeps `backup.key` (Database → Backups) outside OCI.

## Updating

Back up first (Database → Backups → Back up now), then:

```sh
cd /opt/nirmaan && sudo git pull && sudo docker compose up -d --build && sudo docker compose ps
```
