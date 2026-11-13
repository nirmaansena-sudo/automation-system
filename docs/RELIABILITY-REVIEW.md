# Reliability review — version 1.3.0 (13 November 2026)

Version 1.2.1 was tested the way a sceptic would use it: awkward WhatsApp messages in
English and Hindi, enquiries at midnight and on Sundays, wrong settings, a computer that
is switched off, broken input sent to every address, and every screen opened on a phone,
a tablet and a desktop. Everything below went wrong in 1.2.1 and is fixed in 1.3.0.
Nothing about what the features do was changed: the same enquiry → approval → architect
→ client → visit journey, the same screens, the same data.

Each fix has a regression test (`tests/devils-advocate.test.js`). All 163 automated tests
pass, also when the whole suite is run as if it were midnight, closing time, a Sunday,
month-end and year-end (`npm run test:times`).

## 1. The WhatsApp bot misread ordinary messages

| # | What a client wrote | What 1.2.1 did | 1.3.0 |
|---|---|---|---|
| 1 | "Stop work at my site" / "kaam band karo" | Unsubscribed the client from all messages. | Only an exact "STOP" style message unsubscribes. A client with a running project is passed to a person at once. |
| 2 | "STOP" from a client with a live enquiry or project | Unsubscribed silently. | Still unsubscribes (it must), and managers are told so somebody can phone. |
| 3 | "We need fire safety work", "free fire" | Treated as an emergency. | Not an emergency. Real ones ("fire at site", "aag lag gayi") still are. |
| 4 | "House for a 4 person family", "staff quarters" | Handed the chat to a person. | Carries on with the enquiry. "Talk to a person" still hands over. |
| 5 | "Hi, I want to build a house in Vaishali Nagar" | Replied with the menu and ignored the rest. | Starts the enquiry with what was said. |
| 6 | "3 BHK on 200 gaj", "30 feet road, 1500 sq ft", a PIN code | Took the first number as the plot size. | Reads the number that has an area unit; ignores road width, room counts and PIN codes. Hindi numerals (१५०) are understood. |
| 7 | A location pin sent before the area question | Asked for the area anyway. | The pin answers it (nearest service zone; far-away pins are not guessed). |
| 8 | A pin in a different zone from the area the client chose | Nothing. | The approval card warns the manager. |

## 2. Time: nights, Sundays and deadlines

| # | Situation | What 1.2.1 did | 1.3.0 |
|---|---|---|---|
| 9 | Enquiry auto-approved at 11 pm | The architect got 30 minutes to answer at night, the offer expired, the next architect was woken, and so on. | Reply times count office hours. An offer made by the system outside office hours is delivered at opening time. A manager's own offer still goes at once. |
| 10 | Client asked to confirm in the evening | The 4-hour limit ran out overnight and the visit was released. | The limit counts office hours; the reminder is never sent at night. |
| 11 | Visit only a few hours away | The reply deadline could fall after the visit had started. | Deadlines always end before the visit; accepting or confirming after the start time is refused with a clear message. |
| 12 | Architect files a travel claim for tomorrow's visit | Refused ("date in the future") — only late in the evening. | Dated today. |
| 13 | Office hours "until 23:59" | The last minute of the day counted as closed. | Open until midnight. |
| 14 | Computer switched off at 9 pm | That day's missing check-outs were never closed. | Caught up when the system next starts. |
| 15 | Demo data loaded on a Saturday | The sample visit landed on Sunday (a day off). | Skips to Monday. |

## 3. Bad input and wrong settings

| # | Situation | What 1.2.1 did | 1.3.0 |
|---|---|---|---|
| 16 | A malformed web address (`/api/leads/%E0%A4%A`) | "Something went wrong" (server error). | "That address is not valid." |
| 17 | A form sent in the wrong shape, an unknown lead, task, chat or project | Server errors, or silently "saved" nothing. | A plain message saying what is wrong. 18,309 deliberately broken requests to all 187 addresses now produce no server error. |
| 18 | An upload that is too large | The connection was cut with no explanation. | "That upload is too large." |
| 19 | The website form sent twice, or with an impossible phone number | Two leads; or a failure later, out of sight. | One enquiry; a bad number is refused immediately so the website can show it. |
| 20 | A mistake in `.env` (`WHATSAPP_PROVIDER=mata`, `PORT=abc`, a file saved by Notepad as "Unicode") | Started in the wrong mode, or crashed with a programmer's error. | Stops before starting and says what to fix. Smaller doubts (a misspelt setting name, a line without `=`, WhatsApp chosen but its keys empty) start normally and are listed at start-up and under *System health*. |
| 21 | Port already in use, damaged database | A long error trace. | One plain sentence saying what to do. |

## 4. Healing itself

| # | Situation | What 1.2.1 did | 1.3.0 |
|---|---|---|---|
| 22 | The system stops unexpectedly | Stayed down until somebody noticed. | A small supervisor (`server/supervisor.js`, used by `start-windows.bat` and `start.sh`) restarts it within seconds. It gives up after five quick failures so a real fault is not hidden, and never restarts after a settings error. |
| 23 | WhatsApp's servers accept a connection but never answer | Incoming or outgoing messages could wait for ever. | Every network answer has a time limit. A worker stuck for 10 minutes is abandoned and restarted, and the owner is notified. |
| 24 | An unexpected error in a background job | Could stop the whole system. | Logged and shown under *System health*. The system carries on, or restarts itself if it has to. |
| 25 | Stopping the system (Ctrl+C, restart) | The database was not closed cleanly. | Closes cleanly; every start runs a quick integrity check first. |

## 5. Screens

| # | Situation | What 1.2.1 did | 1.3.0 |
|---|---|---|---|
| 26 | Dashboard on a phone | Tables ran off the right edge with the action buttons hidden; inbox, simulator, costs and lead pages scrolled sideways. | Tables become labelled cards; the inbox shows one pane at a time; nothing scrolls sideways. |
| 27 | Connection lost, or the system restarting | Blank page or a technical error. | A banner says so, what is on screen stays, and the page returns by itself. |
| 28 | A double tap on a button | Could send the action twice. | The second tap is ignored; buttons show that they are working. |
| 29 | Check-in with slow GPS | No sign anything was happening; with *Add a selfie* ticked, a slow GPS or a closed camera lost the check-in without a word. | The button says "Getting your location…"; the camera opens at once; closing it checks in without a photo. |
| 30 | Check-in sent for review | A red error: `outside_geofence, late`. | An amber note: "Check-in recorded. Your manager will review it: not at a known site or office, after your shift start." |
| 31 | Keyboard and screen-reader use | Unnamed boxes and buttons, no way past the menu, low-contrast grey text. | Every control has a name, a skip link, focus moves to the new page, text contrast raised. |

## Not changed — know about these

- **A message whose delivery is unknown holds the later messages to that person** until a manager checks
  *Messages → Needs attention*. This is deliberate: it prevents a client receiving the same message twice.
- **The bot does not understand free-text times** ("kal subah 11 baje"). It offers time buttons; after two
  unclear answers the chat goes to a person.
- **In Docker a settings error makes the app container restart in a loop.** `docker compose ps` shows
  *restarting*; `docker compose logs app` ends with the line to fix.
- **`start-windows.bat` now starts the system through the supervisor.** It was checked on the office PC on
  13 November 2026: the usual "is running" lines appear and the dashboard opens.

## After upgrading to 1.3.0

1. Stop the system, copy the new files over the old ones (keep `.env` and the data folder), start it again.
   The database needs no changes.
2. Open *Settings → Connections → System health*. Any new line there is a settings doubt found by the
   start-up check.
3. Check *Settings → Business & hours*: architect and client reply limits now count these hours.
4. Staff: open the team app once while online so the phone picks up the new version.
