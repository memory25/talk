# talk

A minimal two-person chat room. Static HTML, no build step, no framework.

## Stack

- Vanilla JS (ES modules, loaded straight from the browser)
- Firebase Realtime Database for storage and live sync
- GitHub Pages for hosting

No bundler, no `npm install`, no dependencies to keep up to date.

## Features

- Real-time messaging with optimistic rendering and retry on failure
- Reply to a specific message, with a quoted snapshot of the original
- Retract your own messages two ways, with the original text kept in the database
- Send photos that expire an hour after the other person has actually seen them
- Record voice messages, which expire two hours after they have been heard
- Optionally share a precise location, shown in the other person's device panel
- Emoji reactions, plus a quick-pick row and a categorised picker
- Typing indicator and a sound on incoming messages
- Message text is escaped before rendering; URLs are linkified
- Confirmations and notices are in-page, not browser dialogs

## Running locally

```bash
npx serve .
# or
python -m http.server 8000
```

Then open `http://localhost:8000`.

Opening `index.html` directly will not work — ES modules are blocked over the
`file://` protocol, so it has to be served over HTTP.

To see both sides of a conversation, open it in two different browsers, or one
normal window and one private window.

## Deploying

Pushing to `main` triggers the workflow in `.github/workflows/`, which publishes
the repository root to GitHub Pages. There is no build step — the files are
served as they are.

## Layout

```
.
├── index.html    markup for both screens
├── style.css     all styling
├── app.js        application logic
└── config.js     configuration
```

## Configuration

Everything adjustable lives in [config.js](config.js): the Firebase connection,
the room id, the participants, the emoji sets, the wording of the two retract
actions, and the timing values for presence and the typing indicator.

Pointing this at your own Firebase project means creating a Realtime Database,
enabling anonymous authentication, and pasting the resulting config object in.
The rules in [database.rules.json](database.rules.json) require an authenticated
session to read or write.

## Device info

The panel behind the header shows what the other person is on. Everything in it
is symmetrical — both people see the same fields about each other — and all of
it is read without asking for a permission prompt.

Phone models are a special case, because the two platforms give away very
different amounts:

- **Android** puts the real model in its User-Agent (`SM-S918B`, `Pixel 7 Pro`),
  so it is shown as 機型. Recent Chrome versions replace it with a bare `K` to
  frustrate fingerprinting; that and similar placeholders are treated as a miss.
- **iOS** never does. Every iPhone sends the same `iPhone` token, deliberately,
  so the model has to be inferred from the screen size and pixel ratio. Several
  generations share a size, so the best that can be done is a short list of
  candidates, shown as 可能機型 and styled to read as a guess rather than a fact.

The lookup table lives in [config.js](config.js) as `IPHONE_MODELS`; add a row
when a new size appears. An unrecognised size simply omits the field.

Battery is only available on Chrome and Edge — Firefox and Safari removed the
API — and the approximate location comes from a free IP service that may be
blocked or rate-limited. Either one is skipped when unavailable.

## Photos

Photos are deliberately short-lived. They are stored as compressed JPEG data
in the database itself — no third-party image host is involved — so the same
rules that protect the messages protect them, and only the two people in the
room can load them.

Send one by clicking the camera button, pasting from the clipboard, or dragging
a file onto the window. The image is resized and re-encoded in the browser
before it is uploaded, which also sidesteps HEIC: anything the browser can draw
comes back out as JPEG.

**Expiry** is driven by whether the photo was actually seen, not by a fixed
timer from when it was sent:

- Once the other person has genuinely seen it, it is deleted an hour later.
- If nobody ever sees it, it is deleted after 24 hours as a backstop.
- Either way the message stays in the conversation, showing a dim
  "photo expired" line in place of the image.

"Seen" requires three things at once — the other person's tab is in the
foreground, the image has scrolled into view, and it has stayed there for a
second and a half. Scrolling straight past does not count, and your own photos
never mark themselves as seen. The sweep that performs the deletion runs in
whichever client is online; both running it is harmless.

The photo body lives under `rooms/<room>/photos/<id>` and the message only
carries that id, so pulling message history does not re-download every image.

## Voice messages

Hold the microphone button to record and release to send, or tap it once to
start and again to stop. Recording caps at 60 seconds and sends itself at the
limit, so a forgotten finger does not produce a ten-minute message; anything
under a second is discarded as a mis-tap.

Browsers differ on what they can record — iOS Safari only gained WebM in 18.4
— so the format is chosen at runtime, preferring `audio/mp4` because it is the
one both sides are most likely to play. No compression code is needed: what
MediaRecorder produces is already compressed, and 30 seconds comes to about
117 KB, smaller than a photo.

Expiry follows the same shape as photos, keyed on whether the message was
actually heard: two hours after it has been played at least halfway, or 24
hours if nobody plays it. Voice gets longer than a photo because wanting to
replay something is common.

## Precise location

The device panel normally shows only the city that an IP lookup returns. A few
seconds after entering — not immediately, which would be jarring — the app
requests a position, which is what raises the browser's own permission prompt.
There is no confirmation of our own in front of it: that would ask the same
question twice. Declining is remembered, so later visits do not raise the
prompt again.

When sharing is on, coordinates are written under the sharer's presence node
every ten minutes and appear as an extra row, linked to a map. The write is an
`update` touching only that one field, and a failed fix writes nothing at all,
so losing signal or revoking the permission leaves the last known position in
place rather than blanking it.

Coordinates are rounded to four decimal places, roughly 11 metres.

## Quota

Firebase only reports real usage in its console, not to clients, so the app
keeps its own tally: every photo upload adds its byte count to a per-month
counter at `rooms/<room>/usage/<YYYY-MM>`. When the estimate crosses 75% of the
free tier's 10 GB, the camera button is disabled and says why.

Only photos and voice messages are counted — text and presence traffic are
negligible beside them — and the total is inflated by 15% as a margin, so the
cutoff lands around 6.5 GB of real use. Media already sent keeps working; only
new uploads stop. Both numbers are in [config.js](config.js) under `QUOTA`.

Entering with the `...` suffix adds a meter to the top of the 🗂 panel showing
where the month stands, with a tick marking the cutoff, so it can be watched
before it becomes a problem. The counter lives at `rooms/<room>/usage/<YYYY-MM>`
and a new month simply starts a new key.

## Retracting messages

Long-press (or right-click) one of your own messages and the action menu offers
two ways to take it back:

- **收回** — the bubble is replaced by a dim "message retracted" line, so both
  people can see that something was taken back.
- **刪除** — the bubble disappears entirely, as if it had never been sent.

You can only retract your own messages, and there is no time limit.

Neither one erases anything. The original text stays where it was, and a second
copy is written to a separate audit node, so a retracted conversation can still
be reconstructed later:

```
rooms/<room>/messages/<key>
  text         the original text, untouched
  from, at     unchanged
  retracted    "recall" | "remove"
  retractedAt  server timestamp
  retractedBy  user id

rooms/<room>/retractions/<key>
  text         snapshot of the original text
  from         who wrote it
  mode         "recall" | "remove"
  at           when it was originally sent
  retractedAt  server timestamp
  retractedBy  user id
```

Entering with `...` after your key (the same suffix that reveals the device
panel) also adds a 🗂 button to the header, which opens a live list of every
retraction — who took what back, which way, and when. It reads the same
`retractions` node, so it is a window onto the audit trail rather than a
separate record, and it saves a trip to the Firebase console.

The `retractions` node is the one to read when pulling a history together — it
is a flat log of every retraction, and it does not need the message list to be
walked to find them. The rules in [database.rules.json](database.rules.json)
reject any write that would change an existing message's `text` or `from`, so
the audit trail cannot be quietly rewritten from the client.

Retracting also clears the reactions on that message, so nothing is left
pointing at a message that is no longer shown.

## Notes

The Firebase API key is public by design — it identifies the project rather than
authorising access, and it necessarily ships in any client-side Firebase app.
Access is governed by the database rules, not by keeping that value secret.
