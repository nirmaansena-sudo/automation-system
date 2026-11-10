# Going live

Your Windows PC is perfect for trying the system. For real clients it has to run **24×7** with a
fixed HTTPS address, so it moves to a small cloud server. Plan about half a day.

## The four stages

| Stage | Where | WhatsApp | Who uses it |
|---|---|---|---|
| 1. Try the flows | Your PC | Simulator | You |
| 2. Real-phone test | Your PC + tunnel ([WHATSAPP-SETUP.md §4](WHATSAPP-SETUP.md#4-testing-real-whatsapp-on-your-windows-pc-tunnel)) | Real number, your own phones | You + 1 architect + 1 supervisor |
| 3. Go live | Server (this guide) | Real number | Whole team, real clients |
| 4. First two weeks | Server | — | Check the list at the end every day |

## 1. Server and domain

* **Server**: any VPS with Ubuntu 24.04 LTS, 2 vCPU, 2–4 GB RAM, 40 GB SSD, preferably in an Indian region
  (Mumbai/Bengaluru) for speed. Typical cost ₹500–1,500 per month.
* **Domain**: create one DNS **A record** pointing to the server's IP address:
  `ops.nirmaansena.com` (dashboard, employee app, WhatsApp webhook). n8n is not put on the internet.
* HTTPS certificates are created automatically (Caddy) — nothing to buy.

## 2. Install

On the server (SSH as root or a sudo user):

```sh
curl -fsSL https://get.docker.com | sh                   # Docker + Compose
ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable  # firewall: only SSH and web
mkdir -p /opt/nirmaan && cd /opt/nirmaan
```

From your Windows PC (PowerShell, in the folder that contains `nirmaan-sena-system`):

```powershell
scp -r .\nirmaan-sena-system\* root@<SERVER-IP>:/opt/nirmaan/
```

(Do **not** copy the `data` folder — the server starts with its own clean database.)

## 3. Settings (`/opt/nirmaan/.env`)

```sh
cd /opt/nirmaan && cp .env.example .env && nano .env
```

Set at least:

```
DOMAIN=ops.nirmaansena.com
PUBLIC_URL=https://ops.nirmaansena.com
COOKIE_SECURE=true

WHATSAPP_PROVIDER=cloud
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=<any long random text>

SESSION_SECRET=<random>
AUTOMATION_API_KEY=<random>
N8N_SHARED_SECRET=<random>
WEBSITE_FORM_SECRET=<random>
```

Make each `<random>` value with `openssl rand -hex 24` (run it four times).

On the server all four secrets **must** be set in `.env`: n8n reads the same values from it.

## 4. Start

```sh
docker compose up -d --build
docker compose ps                    # app, n8n and caddy should be "running" / "healthy"
docker compose logs app | grep -i "setup code"
```

Open `https://ops.nirmaansena.com/admin/` **straight away** and create the owner account with the
**setup code** from the log. Leave *Load demo data* unticked on the live server.

Then, in the dashboard:

1. *Settings → Business & hours*: hours, office location and radius, visit slots, digest time.
2. *Settings → Zones*: your service areas (with map coordinates for distance checks).
3. *Settings → FAQ answers*: the only answers the bot may give — check prices and wording.
4. *Settings → Holidays*.
5. *Team & attendance → Add person* for every manager, architect, engineer, supervisor and staff member
   (role, zones, skills, shift, weekly off). Give each person their PIN.
6. Connect WhatsApp — [WHATSAPP-SETUP.md](WHATSAPP-SETUP.md) — with the webhook
   `https://ops.nirmaansena.com/webhooks/whatsapp`.

## 5. n8n (optional, recommended)

1. Set `N8N_BASE_URL=http://n8n:5678` and run `docker compose --profile automation up -d --build`.
   n8n listens only on the server itself. Open it from your PC through an SSH tunnel:
   `ssh -L 5678:127.0.0.1:5678 root@<SERVER-IP>`, then browse to <http://localhost:5678>, create the n8n
   owner account straight away and turn on two-factor login (*Settings → Personal*). n8n workflows can read
   the automation key, so only the owner should have an n8n login.
2. Import the five files from `n8n/workflows` and publish them ([n8n/README.md](../n8n/README.md)).
3. In `.env` set `ROUTINES_MODE=n8n` (and `AI_MODE=n8n` if you use workflow 01), then `docker compose up -d`.
4. *Settings → Connections* should show n8n as **connected** within 15 minutes.

## 6. Connect the website enquiry form

The OTP-verified form on nirmaansena.com should also send each enquiry here, so website and WhatsApp
enquiries become **one** lead with the website's reference number as the Lead ID.

```
POST https://ops.nirmaansena.com/api/public/website-enquiry
Header  X-Website-Secret: <WEBSITE_FORM_SECRET>
Header  Content-Type: application/json

{
  "reference_id": "NS-JPR-2026-0142",
  "name": "Rohit Sharma",
  "mobile": "9876543210",
  "whatsapp": "9876543210",
  "services": ["Turnkey construction"],
  "project_nature": "New construction",
  "locality": "Vaishali Nagar",
  "area": "150 gaj",
  "execution_window": "Within 3 months",
  "requirements": "G+1 house, 3 BHK",
  "consent": true
}
```

The client then gets a WhatsApp message asking only for what is missing (site location pin and a visit time).
Send it from the website's **server** (never from the browser, or the secret becomes public).

## 7. Backups

Version 1.1 creates encrypted `.nsbackup` archives containing the database, media and configuration.
The latest 14 archives are retained locally. Configure `BACKUP_OFFSITE_DIR` for an independent copy
(the path must be mounted into the container when using Docker).

Keep the separate `backup.key` or `BACKUP_PASSWORD` outside the server. The owner can download the generated
key from Database → Backups. Losing the server and its only key makes the backup unusable.

Use the validation/restore CLI described in [RECOVERY.md](RECOVERY.md). Restore creates a **new directory**,
checks integrity, and refuses to overwrite an existing installation. Stop the app and point `DATA_DIR` at the
verified restored data only after reviewing the restored configuration. Never restore over a running database.
Old `.db` backups contain no photos or configuration and are not equivalent to a complete restore.
## 8. Updates

Copy the new files over the old ones (keep `.env`), then `docker compose up -d --build`. Database changes are
applied automatically at start. Take a manual backup first (*Database → Backups → Back up now*).

## 9. Monitoring

* *Settings → Connections → System health* lists anything that needs attention: messages overdue or waiting for a
  manual send, incoming events stuck or failed, webhooks with a bad signature, no webhook received yet, no backup in
  36 hours, n8n not seen, failed routines, and background loops that stopped.
* n8n workflow 05 checks the system every 15 minutes and emails you if it is down (enable its email node).
* Add a free external uptime check (for example UptimeRobot) on `https://ops.nirmaansena.com/health`, so you hear
  about it even if the whole server is down.
* If the server is down, Meta keeps retrying webhooks for several days; when it is back, messages are processed
  in order and duplicates are ignored.

## 10. Security and privacy checklist

- [ ] Owner password is long and unique; every staff member has their own login (no shared PINs).
- [ ] `COOKIE_SECURE=true`, all four secrets set, `WHATSAPP_APP_SECRET` set (webhook signatures are checked).
- [ ] Firewall allows only SSH, 80 and 443; SSH with a key, not a password.
- [ ] n8n owner account has two-factor login, and n8n is reached only through the SSH tunnel.
- [ ] Owner, managers and finance have two-step verification on (*My security*).
- [ ] *Settings → Connections → System health* shows no proxy warning (Docker sets `TRUSTED_PROXY_IPS` for
      Caddy automatically; if you use another proxy, set its address there).
- [ ] No demo accounts are active (the health panel warns if any are).
- [ ] The backup key has been downloaded and stored off the server (the health panel reminds you until it is).
- [ ] Website form shows a privacy notice and a WhatsApp consent tick box (sent as `consent`).
- [ ] Staff know: a client can type **STOP** to stop messages; a request to delete their data is done with
      *Clients → (client) → Erase personal data* (owner) — the audit log keeps only that it happened.
- [ ] GPS is recorded only at check-in/out and site visits, never tracked continuously. Tell staff this in writing.
- [ ] Off-server backup copy at least weekly.

## 11. First two weeks — daily 10-minute check

1. **Approvals** — nothing older than 30 minutes during working hours.
2. **WhatsApp inbox** — chats marked *needs attention*.
3. **Messages → Outbox** — any *failed* or *needs manual send*; **Messages → Templates** — all approved.
4. **Team & attendance** — check-ins needing review; who did not check in.
5. **Site visits** — reports overdue.
6. Read 5 random bot conversations and improve the *FAQ answers* where the bot was unsure.

After two weeks, turn on *Settings → Automation rules → Auto-approve complete Jaipur enquiries* if the manager
approved almost every lead unchanged.
