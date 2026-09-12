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
- Emoji reactions, plus a quick-pick row and a categorised picker
- Typing indicator and a sound on incoming messages
- Message text is escaped before rendering; URLs are linkified

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
