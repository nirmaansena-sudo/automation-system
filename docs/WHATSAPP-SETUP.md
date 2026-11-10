# Connecting real WhatsApp

Until you do this the system runs in **simulator mode**: everything works, but messages only appear
in the dashboard's *WhatsApp simulator*. Do this once you are happy with the flows.

## 1. Decide two things first

**A. Which connection**

| Option | Set in `.env` | Good for | Cost |
|---|---|---|---|
| **Meta Cloud API, direct** (recommended) | `WHATSAPP_PROVIDER=cloud` | Full control, no middle-man, all features this system uses | Only Meta's per-message charges |
| **360dialog** (Meta partner) | `WHATSAPP_PROVIDER=dialog360` | Guided onboarding and support | Meta charges + 360dialog monthly fee |
| Other Indian providers (AiSensy, Interakt, WATI, Gupshup…) | — | Their own inbox/broadcast tools | They use their own APIs: a small adapter must be added in `server/whatsapp/providers.js` |

**B. Which number**

* **A new number for the system** (simplest). Keep using your current number on the WhatsApp Business app
  for personal follow-ups, or retire it.
* **Your current WhatsApp Business app number (coexistence).** You keep using the app on the office phone and
  the same number works with this system. See section 6.

> A number that is already registered on WhatsApp (normal or Business app) cannot be added to the API
> directly unless you use coexistence or delete that WhatsApp account first.

## 2. Before you start (one-time, 1–3 days)

1. **Meta Business portfolio** at <https://business.facebook.com> in the company's legal name.
2. **Business verification**: *Business settings → Security centre → Start verification*. Keep a document
   that shows the legal name and address ready (for example the GST certificate or Udyam registration).
3. **Display name** "Nirmaan Sena" (it must match the business/website; Meta reviews it).
4. A phone that can receive the **OTP** (SMS or voice call) for the number you will connect.
5. A **payment method** in WhatsApp Manager (needed for template messages). Indian accounts must be billed
   in INR by 31 Dec 2026, so add it in INR.
6. A **public HTTPS address** for the webhook: your server (see [GO-LIVE.md](GO-LIVE.md)), or a tunnel while
   testing on your PC (section 4).

## 3. Meta Cloud API (direct) — step by step

1. **Create the app.** <https://developers.facebook.com> → *My Apps → Create app* → choose the WhatsApp use case
   (or type *Business* and then add the *WhatsApp* product) → link it to your business portfolio.
2. **Add the phone number.** App → *WhatsApp → API Setup* → *Add phone number* → display name, category
   (*Professional services*), verify by OTP. Write down:
   * **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   * **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
3. **Permanent access token** (the token shown on *API Setup* expires in 24 hours — do not use it):
   *Business settings → Users → System users → Add* (role *Admin*) → *Assign assets*: your **app** (full control)
   and your **WhatsApp account** (full control) → *Generate new token* → choose the app → expiry **Never** →
   permissions `whatsapp_business_messaging` and `whatsapp_business_management` → copy → `WHATSAPP_TOKEN`.
4. **App secret**: App → *App settings → Basic → App secret → Show* → `WHATSAPP_APP_SECRET`
   (the system uses it to check that every webhook really comes from Meta).
5. **Fill `.env`** (in the main folder) and restart the system:

   ```
   WHATSAPP_PROVIDER=cloud
   WHATSAPP_TOKEN=EAAG...
   WHATSAPP_PHONE_NUMBER_ID=1234567890
   WHATSAPP_BUSINESS_ACCOUNT_ID=9876543210
   WHATSAPP_APP_SECRET=abc123...
   PUBLIC_URL=https://ops.nirmaansena.com      # or your tunnel address while testing
   COOKIE_SECURE=true                          # when PUBLIC_URL is https
   ```

6. **Webhook.** Dashboard → *Settings → Connections* shows the **Webhook callback URL** and the **Verify token**
   (owner only). In the Meta app: *WhatsApp → Configuration → Webhook → Edit* → paste both → *Verify and save*.
   Then under *Webhook fields* click **Subscribe** for `messages`
   (and `smb_message_echoes` only if you use coexistence).
7. **Register the number** (only if *API Setup* says the number is not registered). Choose a 6-digit
   two-step verification PIN and keep it safe:

   ```
   curl -X POST "https://graph.facebook.com/v24.0/<PHONE_NUMBER_ID>/register" \
     -H "Authorization: Bearer <WHATSAPP_TOKEN>" -H "Content-Type: application/json" \
     -d "{\"messaging_product\":\"whatsapp\",\"pin\":\"123456\"}"
   ```

8. **Messages reach Meta but not the dashboard?** Subscribe the app to your WhatsApp account once:

   ```
   curl -X POST "https://graph.facebook.com/v24.0/<WHATSAPP_BUSINESS_ACCOUNT_ID>/subscribed_apps" \
     -H "Authorization: Bearer <WHATSAPP_TOKEN>"
   ```

9. **App mode Live**: *App settings → Basic* needs a Privacy Policy URL (your website's privacy page); then switch
   the app to **Live**. In development mode Meta may deliver only test webhooks.
10. **Templates**: submit the 17 templates in [TEMPLATES.md](TEMPLATES.md) (English and Hindi). When Meta approves
    one, set it to *approved* in *Messages → Templates*. Until then the system creates a "send manually" task
    instead of failing silently.
11. **Test**: *Settings → Connections → Send test message* to your own WhatsApp. Then message the business number
    from your phone: "Hi". You should see the chat in *WhatsApp inbox* within seconds and the bot's reply on your phone.

**Graph API version.** The system uses `v24.0` by default. Meta supports each version for about two years; to move
to a newer one later, set `WHATSAPP_GRAPH_VERSION` (for example `v26.0`), restart and send a test message.

**Sending limits.** Replies to people who wrote to you are not limited. Messages that *you* start with a template
(reminders, offers to architects outside 24 h) are limited per day for new accounts; the limit rises automatically
when message quality stays good. Architects and staff should message the business number once (for example "Hi")
so offers can go as normal messages inside the 24-hour window.

## 4. Testing real WhatsApp on your Windows PC (tunnel)

Meta needs a public HTTPS address. A free Cloudflare quick tunnel gives one for testing:

1. Install once (PowerShell): `winget install --id Cloudflare.cloudflared`
2. Start the system (`start-windows.bat`), then in a new PowerShell window:
   `cloudflared tunnel --url http://localhost:3000`
3. It prints an address like `https://quiet-river-1234.trycloudflare.com`. Put it in `.env` as `PUBLIC_URL`,
   restart the system, and use `https://quiet-river-1234.trycloudflare.com/webhooks/whatsapp` as the callback URL in Meta.
4. Because `PUBLIC_URL` is now public, the first-time setup asks for the **setup code** printed in the system window.

The quick-tunnel address changes every time you start it (update Meta and `.env` each time), and messages only
flow while the PC is on and awake. For anything longer than testing, move to a server ([GO-LIVE.md](GO-LIVE.md)).

## 5. 360dialog

1. Sign up at 360dialog and connect your number through their signup (Meta business verification still applies).
2. Create an **API key** for the number in the 360dialog hub.
3. `.env`:

   ```
   WHATSAPP_PROVIDER=dialog360
   DIALOG360_API_KEY=<your key>
   # DIALOG360_BASE_URL=https://waba-v2.360dialog.io   (default)
   ```

4. 360dialog does **not sign** webhooks, so the system checks a secret key instead. Register the webhook with the
   verify token from *Settings → Connections* as a header:

   ```
   curl -X POST "https://waba-v2.360dialog.io/v1/configs/webhook" \
     -H "D360-API-KEY: <your key>" -H "Content-Type: application/json" \
     -d "{\"url\":\"https://ops.nirmaansena.com/webhooks/whatsapp\",\"headers\":{\"X-NS-Webhook-Key\":\"<verify token>\"}}"
   ```

   (Alternative: the owner sees a callback URL ending in `?key=…` in *Settings → Connections*; that works too.)
   360dialog does not accept a port number or an underscore in the webhook address, and **creating a new API key
   removes the webhook** — run the command again after changing keys.
5. Submit the templates in the 360dialog hub (or WhatsApp Manager) and mark them *approved* in the dashboard.

## 6. Keeping the WhatsApp Business app (coexistence)

Coexistence connects the number you already use in the WhatsApp Business app to this system, so the office phone
keeps working. It is set up through a Meta partner's signup flow that supports coexistence (for example 360dialog
or Indian providers that advertise it); you confirm the link from the WhatsApp Business app on the phone.

After linking:

* Set `WHATSAPP_COEXISTENCE=true` and subscribe the `smb_message_echoes` webhook field (Meta app → Configuration).
* Replies you type on the phone appear in the dashboard inbox as "sent from the app", and **the bot pauses in that
  chat for 2 hours** so it never talks over you.
* Some app features stop working on a linked number and throughput is lower than a dedicated API number. Meta shows
  the current list during signup — read it before you confirm.

## 7. Troubleshooting

| What you see | Cause and fix |
|---|---|
| Meta says "The callback URL or verify token couldn't be validated" | The system is not reachable at that HTTPS address, or the verify token differs. Open `https://<address>/health` in a browser — it must show `{"ok":true…}`. Copy the token again from *Settings → Connections*. |
| Messages appear in Meta's test tool but not in the dashboard | Field `messages` not subscribed, app not *Live*, or step 8 (`subscribed_apps`) missing. |
| *System health* says "webhooks with a bad signature" | `WHATSAPP_APP_SECRET` is wrong (it is the **app** secret, not the token). |
| Error **131047** in *Messages → Outbox* | More than 24 h since the person last wrote. Handled automatically: the system switches to the approved template; approve the templates. |
| Error **132001** | Template name or language does not exist / not approved. Names must match [TEMPLATES.md](TEMPLATES.md) exactly. |
| Error **131026** | Undeliverable (number not on WhatsApp, or the person blocked you). |
| Error **130429** / **131056** | Sending too fast; retried automatically. |
| Error **190** | Token expired → create the system-user token with expiry *Never* (step 3). |
| Error **131030** | You are still on Meta's *test number*, which only reaches numbers on its allowed list. Add your own number (step 2). |
| Error **133010** | Number not registered → step 7. |
| Error **368** | Meta temporarily restricted the number for policy reasons. Check WhatsApp Manager → *Account quality*. |

If the server is down, Meta keeps retrying webhooks for several days, and the system processes them in order
when it comes back — duplicates are ignored.
