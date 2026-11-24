# TempBox — Temporary Email Inbox

A disposable-email web app: generate an address, copy it, and watch the inbox update live.
Vanilla frontend (no bundler, no build step) on a small Express server — one npm dependency.

```
┌──────────────────────────────────────────────┐
│  TempBox UI (static, /public)               │
│    source switch · address · inbox · reader  │
└───────────────┬──────────────────────────────┘
                │ same-origin fetch /api/*
┌───────────────▼──────────────────────────────┐
│  Node server (server.js)                     │
│  proxy + domain cache + static host          │
└───────┬──────────────────────────┬───────────┘
        │ HTTPS (Bearer token)      │ IMAP4rev1 (TLS 993)
┌───────▼──────────────────┐  ┌────▼─────────────────────┐
│  mail.tm API             │  │  imap.gmail.com           │
│  (accounts · messages)   │  │  (your own Gmail account) │
└──────────────────────────┘  └──────────────────────────┘
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

## Real `@gmail.com` addresses — the Gmail mode

The display layer above fakes the *look* of a Gmail address. The **Gmail mode** is the real thing:
switch the source to **“My Gmail — real @gmail.com”** and TempBox mints genuine addresses off a Gmail
account you own.

### Why it works

Gmail ignores everything after a `+` in the local part and delivers that mail to the same inbox:

```
aze.131.989@gmail.com          ← your account
aze.131.989+shop@gmail.com     ← same inbox, a different address
aze.131.989+bank@gmail.com     ← same inbox, yet another address
```

So one Gmail account becomes an unlimited set of *distinct, real* `@gmail.com` addresses, all landing
in the one inbox. This is the same trick Emailnator uses — their own FAQ says it outright: *“Gmail
ignores dots … and everything after a `+` … Emailnator uses that to give you many different
addresses.”*

Each address gets its own inbox panel in TempBox. Mail is matched to an address by its recipient
headers (`Delivered-To`, `X-Original-To`, `To`, `Cc`), so `+shop` only ever shows mail addressed to
`+shop`, and the bare address only shows mail addressed to the bare address.

### Setup (once, on your Google account)

1. Open **Google Account → Security → 2-Step Verification** and turn it on.
2. In the same page open **App passwords** and create one named “TempBox” for **Mail**.
   Google gives you a 16-character password with spaces, e.g. `abcd efgh ijkl mnop`.
3. In TempBox pick the **My Gmail** tab, enter the Gmail address and that app password, press
   **Connect Gmail**.

### What the app does with the password

| Where | What is stored |
|---|---|
| Browser `sessionStorage` | the app password, so a server restart reconnects without asking again. Gone when the tab closes. |
| Server memory | the app password, inside the session. **Never written to disk**, never logged, dropped when the session expires (12 h) or you press *Switch account*. |
| Disk / Git | nothing. There is no `.env` file, no database, no credential in the repo. |

The server needs the password because it opens the IMAP connection itself — the browser cannot do
IMAP, and handing the password to the browser would mean handing it to the page. **Anyone who can
reach your deployed TempBox instance can therefore open a Gmail session.** That is why a dedicated
Google account is recommended, and why the app password should be revoked the moment you stop using
the feature.

### Requirements and limits

- The deployment host must be able to reach `imap.gmail.com:993`. Some container platforms block
  outbound IMAP — if the connection fails, the inbox says so instead of pretending to be empty.
- Google requires an app password (2-Step Verification) — a normal account password will not work.
- Aliases are limited by Gmail: the local part is capped at 64 characters.
- One IMAP connection is opened per poll and closed again; nothing is left running.


## Why there is a backend proxy

The mail provider does **not** send `Access-Control-Allow-Origin` headers, so a browser calling
`api.mail.tm` directly is blocked by CORS. `server.js` proxies every provider call through
`/api/*` (same origin), so the browser only ever talks to `localhost`.

Allowed upstream paths: `/domains`, `/token`, `/accounts`, `/accounts/:id`, `/messages`, `/messages/:id`.

## Features

- **Two sources, one inbox UI** — a disposable domain, or real `@gmail.com` addresses off your own
  Gmail account (see below).
- **Unlimited real aliases** — `you+shop@gmail.com`, `you+bank@gmail.com`, … each with its own
  inbox panel, all delivered to the one Gmail account.
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

### TempBox's own API

| Call | Purpose |
|---|---|
| `POST /api/gmail/login` | verify the app password over IMAP → session token |
| `POST /api/gmail/logout` | drop the session (and the stored password) |
| `GET /api/gmail/session` | is the session still alive? |
| `GET /api/gmail/messages?alias=` | list the mail addressed to one alias |
| `GET /api/gmail/messages/:uid` | full message (headers + body) |

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

### Why the dropdown often shows exactly one domain

This is a property of the provider, not a bug in TempBox. `GET /domains` returns whatever domains the
provider currently operates, and mail.tm currently answers with **one**: `euploading.com`
(`hydra:totalItems: 1`). There is nothing to rotate between — the app shows every domain the provider
offers, and that set is a single entry today.

It is also why the Gmail mode exists. A shared disposable domain is on every blocklist there is, and
the provider can retire it at any time, so an address built on it is a dead end for anything that
checks the domain. Two durable answers:

1. **Your own domain on the provider.** Add the domain to mail.tm with its MX records and it appears
   in the same dropdown — you own it, so nobody can retire it.
2. **Gmail mode.** A real `@gmail.com` address off your own account, which no site can blocklist.

Sites like Emailnator look like they have many domains because they *own* many domains and point
them all at their own mail server. Their `@gmail.com` option is not a different domain at all — it
is the Gmail plus-alias trick described above, running on an account they operate for you. That is
the part worth copying, and it is exactly what Gmail mode does with your own account.

## Offline development (mock provider)

`scripts/mock-provider.js` is a local stand-in for mail.tm with the same REST shape and two seeded
messages (one with a verification code). No network needed:

```bash
node scripts/mock-provider.js 4600
$env:MAIL_API_BASE = "http://127.0.0.1:4600"; $env:PORT = 4601
node server.js
# → http://localhost:4601
```

### Testing Gmail mode without a Google account

`scripts/fake-imap.js` is a local IMAP server that behaves like a Gmail mailbox for whichever
account logs in — it holds three messages (one for `<account>+shop@gmail.com`, one for the account
itself, one for a stranger) so alias filtering can be checked properly:

```bash
node scripts/fake-imap.js 4701
$env:IMAP_HOST = "127.0.0.1"; $env:IMAP_PORT = "4701"; $env:IMAP_SECURE = "false"
$env:PORT = 4611; node server.js
# → http://localhost:4611
```

Open the **My Gmail** tab, enter any address (e.g. `you@gmail.com`) with any password, and connect.
The aliases and the per-address inbox filtering then work exactly as they do against real Gmail —
only the transport is local.

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
lib/imap.js                IMAP4rev1 client + MIME parser (node:tls only, no dependency)
public/index.html          markup
public/styles.css          theme, layout, responsive rules
public/app.js              app logic (state, polling, rendering, events)
scripts/mock-provider.js   offline mail.tm-shaped provider
scripts/fake-imap.js       offline IMAP server for testing Gmail mode
scripts/selftest.js        create mailbox → read back → delete
scripts/send-test-mail.js  SMTP self-test helper
```

`lib/imap.js` is written by hand against `node:tls` / `node:net` so that **Express stays the only
dependency**. It speaks IMAP4rev1 (login, select, `UID SEARCH`, `UID FETCH`, literal-aware reads),
parses MIME (multipart, base64, quoted-printable, charsets) and matches a message to an alias by its
recipient headers.

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
- **Gmail mode** hands your Google app password to the TempBox server, because the server is the one
  that speaks IMAP. Use a dedicated Google account, and revoke the app password when you are done.
- **Gmail mode** needs outbound IMAP (`imap.gmail.com:993`). A host that blocks it cannot use that
  mode — the disposable mode keeps working.
- Gmail mode shows the **real** address. There is no display/real split there, so “Copy” and
  “Copy as shown” collapse into one button and the *Domain* / *Show as* fields are hidden.
