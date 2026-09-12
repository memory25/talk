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
the room id, the participants, the emoji sets, and the timing values for
presence and the typing indicator.

Pointing this at your own Firebase project means creating a Realtime Database,
enabling anonymous authentication, and pasting the resulting config object in.
The rules in [database.rules.json](database.rules.json) require an authenticated
session to read or write.

## Notes

The Firebase API key is public by design — it identifies the project rather than
authorising access, and it necessarily ships in any client-side Firebase app.
Access is governed by the database rules, not by keeping that value secret.
