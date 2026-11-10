# Usage estimates and optional local voice transcription

## Cost controls

Open **Usage & costs** in the dashboard. Select a month to inspect activity within that calendar month in India time. Counts do not include the following month.

Managers, finance staff and the owner can enter the rates that apply to their provider account. There is no built-in WhatsApp tariff, free allowance or assumed tariff-change date. Blank rates mean **unpriced**, not free. Enter zero only when it is appropriate for that account. A fixed monthly amount can cover hosting, electricity or other operating expense. The dashboard estimates costs using the rates currently entered, including when displaying an earlier month; it is not a historical rate ledger or an accounting invoice.

The monthly budget creates a planning alert. It does not stop essential client messages. Estimates can differ from invoices because of taxes, discounts, provider billing rules and token usage. The AI and transcription rates are optional average costs per attempt. Failed attempts are included so repeated failures are visible.

Only the owner changes daily AI and transcription limits. The effective limit is the lower of the dashboard value and the server environment setting. Zero disables new compute. Attempts are reserved before a request, including requests that fail or time out. Limits reset by India calendar date; successful cached transcripts consume no new attempt. After the AI limit is reached, rule-based conversation handling continues.

```dotenv
AI_MODE=off
AI_MODEL=
AI_DAILY_LIMIT=200
TRANSCRIPTION_URL=
TRANSCRIPTION_TOKEN=
TRANSCRIPTION_TIMEOUT_MS=25000
TRANSCRIPTION_DAILY_LIMIT=25
```

Direct AI provider modes require an explicitly configured model name. No model is selected automatically. The optional voice feature does not use a paid cloud speech API.

## Configure a self-hosted speech backend

Transcription is disabled while `TRANSCRIPTION_URL` is blank. If wanted, run a separately managed [whisper.cpp HTTP server](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md). Use a multilingual model for Hindi or mixed Hindi/English speech; an English-only model is unsuitable for Hindi. The service needs local CPU/RAM or an appropriate GPU and storage for the selected model. Resource requirements and recognition quality depend on that model and hardware.

The application uploads audio to the configured `/inference` endpoint as multipart form data, requests JSON and asks for transcription rather than translation. For WhatsApp OGG and other compressed audio, configure the speech server with its conversion option and FFmpeg, as described in its documentation. Run that separate service without administrator privileges, keep it private to the application network, and secure any remote connection. If a reverse proxy requires a bearer token, configure `TRANSCRIPTION_TOKEN`; the stock server need not support that authentication itself.

For a backend on the same machine, an example endpoint is:

```dotenv
TRANSCRIPTION_URL=http://127.0.0.1:8080/inference
```

For containers, use the reachable private service address instead of the application's own loopback address. Restart the application after changing environment settings. The application does not download a model, install a speech service, or send audio to any service until configured and requested by a manager. Keep the URL blank if the feature is unnecessary.

## Use a transcript

1. Open an audio message in **WhatsApp inbox** and listen using the audio player.
2. Click **Transcribe locally**, choose Auto/Hinglish, Hindi or English, and submit. The original audio is sent only to the configured backend.
3. Review the displayed machine transcript against the audio. Correct names, dates, measurements and mixed-language words, then save the reviewed text.
4. Optionally copy reviewed text into a reply draft. This never sends a reply; the usual Send action remains separate.

The attachment must be audio and no larger than 8 MB. At most two requests run concurrently, and each request has a maximum 30-second timeout. Long notes or slower hardware can time out; listen manually or retry deliberately. No automatic retry or bot action is driven by transcript contents. Completed results are cached per attachment. The original generated text is retained alongside staff edits for review; normal personal-data erasure removes both. The original WhatsApp message stays unchanged.

## Verification limits

Automated tests exercise the multipart contract against a local mock server, caching, concurrency, authentication, review, file limits, timeout, caps and month boundaries. They do not establish speech-recognition accuracy or performance on the selected real model. Before enabling for staff, test representative Hindi, English and Hinglish voice notes on the actual self-hosted service.
