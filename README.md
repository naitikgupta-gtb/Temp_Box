# TempBox — Temporary Email Inbox

A disposable-email web app: generate an address, copy it, and watch the inbox update live.
Vanilla frontend (no bundler, no build step) on a small Express server — one npm dependency.

```
┌──────────────────────────────────────────────┐
│  TempBox UI (static, /public)               │
│    address generator · inbox · reader        │
└───────────────┬──────────────────────────────┘
                │ same-origin fetch /api/*
┌───────────────▼──────────────────────────────┐
│  Node server (server.js)                     │
│  proxy + domain cache + static host          │
└───────────────┬──────────────────────────────┘
                │ HTTPS (Bearer token)
┌───────────────▼──────────────────────────────┐
│  mail.tm API  (accounts · messages)          │
└──────────────────────────────────────────────┘
```

## Run it

```bash
npm install                # one dependency: express
node server.js
# → http://localhost:3000  and  http://localhost:4599
```

With no `PORT` set the server listens on **3000** (the port container platforms
like Deplox/Render/Fly forward to) **and 4599** (the local default), so the same
checkout works locally and in a container. If `PORT` is set, only that port is
opened.

`HOST` can be overridden too:

```bash
PORT=8080 node server.js          # PowerShell: $env:PORT=8080; node server.js
```

There is no build step and no bundler — `npm start` is an alias for `node server.js`.

## The `@gmail.com` look

A real `@gmail.com` mailbox cannot be handed out without a Google account, so the address is a
**two-layer** thing:

| Layer | What you see | What it does |
|---|---|---|
| Display | `calmanchor296@gmail.com` | the big address, looks like Gmail |
| Real | `delivers to calmanchor296@fldubai.com` | the address that actually receives mail |

- **Copy** copies the *real* address, so the mail lands in the inbox.
- **Copy as shown** copies the *displayed* address (cosmetic only — nobody can receive mail there).
- **Show as** switches the look: `@gmail.com` (default), `@outlook.com`, `@yahoo.com`,
  `@hotmail.com`, `@icloud.com`, `@proton.me`, `@zoho.com`, or **Real domain**.
- The real address is never hidden — it stays visible under the big one the whole time.

## Why there is a backend proxy

The mail provider does **not** send `Access-Control-Allow-Origin` headers, so a browser calling
`api.mail.tm` directly is blocked by CORS. `server.js` proxies every provider call through
`/api/*` (same origin), so the browser only ever talks to `localhost`.

Allowed upstream paths: `/domains`, `/token`, `/accounts`, `/accounts/:id`, `/messages`, `/messages/:id`.

## Features

- **One-click address** — random readable local part (`glidefalcon659@maxxspace.com`), or type your own.
- **Gmail-style display** — shows `@gmail.com` (or 6 other looks) while the real domain still delivers.
- **Two copy buttons** — the working address, or the address exactly as displayed.
- **Live inbox** — polls every 3 s, pauses when the tab is hidden, manual refresh with `r`.
- **Reader pane** — sender, subject, date, body, attachments; plain-text and sandboxed-HTML views.
- **Code extraction** — a verification code in the body is detected and shown as a click-to-copy chip.
- **Multiple inboxes** — keep several addresses side by side, switch with one click.
- **Persistence** — inboxes, tokens and the open message survive a page reload via `localStorage`.
- **Import an existing inbox** — paste address + password and the app reconnects to it.
- **Cross-tab sync** — open a message in one tab, the other tab follows along.
- **Search** — filter the current inbox by sender, subject or preview.
- **Sound + toast** — optional new-mail sound and a toast notification.
- **Themes** — dark / light, remembered across reloads.
- **Keyboard** — `c` copy address · `n` new address · `r` refresh · `/` search · `Esc` close reader.

## API used

| Call | Purpose |
|---|---|
| `GET /domains` | available domains (cached 5 min server-side) |
| `POST /accounts` | create a mailbox → account id |
| `POST /token` | exchange address + password for a Bearer token |
| `GET /messages` | list inbox (cached 8 s server-side) |
| `GET /messages/:id` | full message body (`text` + `html[]`) (cached 30 s server-side) |
| `DELETE /messages/:id`, `DELETE /accounts/:id` | delete message / inbox |

### Why the message list is cached

The provider throttles per **outbound IP**. On a shared host (Deplox, and any cloud runner) every
visitor reaches the provider from the same address, so a 3-second poll from the browser turned into
`429 Too Many Requests` every few requests — the inbox would look empty while the mail had arrived.

So the server keeps the last good copy of the message list for 8 s (message bodies for 30 s) and
serves it to the browser:

| Response header | Meaning |
|---|---|
| `X-TempBox-Cache: hit` | served from the server cache, no provider call |
| `X-TempBox-Cache: stale` | provider returned an error, last good copy served instead (up to 60 s old) |

A stale copy is only served when it actually contains mail. An **empty** stale list is never
returned — that would show an empty inbox even though the message has arrived — so the throttle is
passed through to the browser and the inbox says it is rate limited.

A throttled or blocked read is retried twice (700 ms, 2000 ms) before giving up, because the
provider's limit is burst based and a short pause usually clears it. `403` is retried too: the
provider's edge (Cloudflare) answers a request it does not like with `error code: 1010`, and the
retry goes out with a **different browser signature** — the upstream request carries an ordinary
browser `User-Agent` + `Accept-Language` instead of a script one, and each retry rotates through a
small pool of them. A blocked signature therefore cannot turn into a dead inbox.

Sending `X-TempBox-Fresh: 1` skips the cache — that is what the manual refresh button uses, and the
app also sends it by itself once an inbox has been empty for 20 s, so a message that arrived during a
throttle is not hidden behind the cache.

Account creation, token exchange and deletes are **never** cached. The cache key is the mailbox's
bearer token, so one mailbox can never see another's mail.

## The inbox always says what is happening

An empty inbox is the worst possible answer: the user cannot tell "no mail yet" from "the mail
service is broken". So the inbox itself carries the state:

| State | What the inbox shows |
|---|---|
| healthy, no mail | `Waiting for the first message… (30s so far — the first mail to a new address can take 1–3 minutes)` |
| provider throttling | `Mail service is rate limiting us — retrying in 24s…` |
| provider blocked / unreachable | `Cannot reach the mail service (HTTP 403). Last check 12s ago — retrying automatically…` |
| search with no hit | `No mail matches your search.` |

Two things drive that honesty:

- **The first mail to a brand-new address is slow.** The receiving MX takes anywhere from a few
  seconds to about three minutes to hand a first message over — measured against live mail.tm
  accounts, not guessed. The waiting message says so, and counts up, instead of sitting there
  looking broken.
- **Repeated throttles back off further.** A shared outbound IP means the provider throttles us
  sooner; the pause grows 12 s → 24 s → 45 s (cap) instead of hammering the same limit every 3 s.

A failed read also keeps the last known messages on screen: the server serves the last good copy of
a **non-empty** list, and the browser merges it into what it already had.

## Swapping the provider or domain

The server talks to `MAIL_API_BASE` (default `https://api.mail.tm`). Any provider with the same
REST shape can be used by pointing it elsewhere:

```bash
$env:MAIL_API_BASE = "https://api.example.com"
node server.js
```

Domains are read from the provider at runtime, so a new provider domain appears in the dropdown
automatically. For a **custom domain of your own**, add its MX records to the provider and it will
show up in the same dropdown.

## Offline development (mock provider)

`scripts/mock-provider.js` is a local stand-in for mail.tm with the same REST shape and two seeded
messages (one with a verification code). No network needed:

```bash
node scripts/mock-provider.js 4600
$env:MAIL_API_BASE = "http://127.0.0.1:4600"; $env:PORT = 4601
node server.js
# → http://localhost:4601
```

## End-to-end self-test

`scripts/selftest.js` creates a mailbox against a running app and reads it back:

```bash
node scripts/selftest.js http://localhost:4599
```

`scripts/send-test-mail.js` sends a real email through the domain's MX server so the inbox
pipeline can be verified without a human sender:

```bash
node scripts/send-test-mail.js someone@maxxspace.com "Your code" "Your code is 482913"
```

It resolves MX automatically and speaks plain SMTP (port 25) — note that many networks and
mail servers block outbound port 25, in which case this step fails while everything else works.

## Project layout

```
server.js                  Express server: static host + provider proxy
public/index.html          markup
public/styles.css          theme, layout, responsive rules
public/app.js              app logic (state, polling, rendering, events)
scripts/mock-provider.js   offline mail.tm-shaped provider
scripts/selftest.js        create mailbox → read back → delete
scripts/send-test-mail.js  SMTP self-test helper
```

## Deploying

Any Node host works — the app is a plain `npm start` process that binds `0.0.0.0`. Set
`MAIL_API_BASE` to point at a different provider, or leave it for mail.tm.

```
Build command : (none)
Start command : npm start
Port          : 3000 by default; 4599 is opened as an alias when $PORT is unset
```

If the platform *does* set `$PORT`, the server listens on that port only. `GET /health` and
`GET /api/health` both return `{"ok":true,...}` for platform health checks.

Because the provider does not allow browser CORS calls, the **server must stay in front of the
frontend** — a static-only host cannot serve this app as-is.

## Notes & limits

- Addresses are disposable by design — do not use them for banking or important account recovery.
- The provider decides how long a mailbox lives; the "active · Nm" pill shows the age of the
  current inbox.
- The provider rotates its own domains over time. An address keeps the domain it was created with;
  the dropdown always shows the domains that are live *right now*.
- Raw SMTP sending (self-test) can be blocked or throttled by the receiving MX / your network.
- Provider access tokens expire (mail.tm: about an hour). The app renews them automatically from the
  stored mailbox password, so a tab left open keeps working.
- The provider throttles bursts and answers `429 Too Many Requests`, and its edge can answer
  `403` with `error code: 1010` when it does not like the request signature. Both are retried, and
  the inbox says which one is happening instead of just looking empty.
