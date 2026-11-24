'use strict';

/**
 * Temp Mail server
 * ----------------
 * Serves the static frontend from /public and proxies every mail-provider
 * call through /api/* so the browser never talks to the provider directly
 * (the provider does not send CORS headers, so a direct browser call would
 * be blocked).
 *
 * Env:
 *   PORT          explicit port; when unset the server listens on 3000
 *                 (container default) and 4599 (local default)
 *   HOST          default 0.0.0.0
 *   MAIL_API_BASE default https://api.mail.tm
 */

const express = require('express');
const path = require('path');
const { URL } = require('url');

const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = (process.env.MAIL_API_BASE || 'https://api.mail.tm').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Container platforms (Deplox, Render, Fly, Heroku…) forward traffic to a fixed
// container port and often do not set PORT, so the app has to listen on 3000.
// Locally we prefer 4599, and we open both so neither setup is a dead end.
const EXPLICIT_PORT = Number(process.env.PORT || 0);
const PORTS = EXPLICIT_PORT ? [EXPLICIT_PORT] : [3000, 4599];

// Never let a stalled provider hold a browser request open forever.
const UPSTREAM_TIMEOUT_MS = 20000;

// Only these upstream paths may be reached through the proxy.
const ALLOWED = [
  /^\/domains$/,
  /^\/token$/,
  /^\/accounts$/,
  /^\/accounts\/[A-Za-z0-9]+$/,
  /^\/messages$/,
  /^\/messages\/[A-Za-z0-9]+$/,
];

const domainsCache = { at: 0, body: null };
const DOMAIN_TTL = 5 * 60 * 1000;

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    provider: API_BASE,
    time: new Date().toISOString(),
  });
});

// Some platforms health-check /health instead of /api/health.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    provider: API_BASE,
    time: new Date().toISOString(),
  });
});

app.get('/api/domains', async (req, res) => {
  if (Date.now() - domainsCache.at < DOMAIN_TTL && domainsCache.body) {
    res.set('Cache-Control', 'no-store').type('application/json').send(domainsCache.body);
    return;
  }
  const headers = upstreamHeaders(null);
  try {
    let upstream = null;
    for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, UPSTREAM_RETRY_DELAYS[attempt - 1] || 1000));
        headers['User-Agent'] = UPSTREAM_USER_AGENTS[attempt % UPSTREAM_USER_AGENTS.length];
      }
      const res2 = await fetch(new URL('/domains', API_BASE), {
        headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await res2.text();
      upstream = { status: res2.status, ok: res2.ok, text };
      if (!UPSTREAM_RETRY_STATUSES.includes(res2.status)) break;
    }
    if (upstream.ok) {
      domainsCache.at = Date.now();
      domainsCache.body = upstream.text;
    } else if (domainsCache.body) {
      // The provider is having a moment, but a known domain list is still
      // good enough to create an address.
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .set('X-TempBox-Cache', 'stale')
        .type('application/json')
        .send(domainsCache.body);
      return;
    }
    res
      .status(upstream.status)
      .set('Cache-Control', 'no-store')
      .type('application/json')
      .send(errorPayload(upstream.status, upstream.text));
  } catch (err) {
    res.status(502).json({
      error: 'Cannot reach mail provider',
      detail: (err && err.message) || String(err),
    });
  }
});

// Everything else under /api is proxied to the provider.
//
// The message endpoints are cached briefly on the server. On a shared host
// (Deplox) every visitor talks to the provider from the same outbound IP, and
// the provider throttles that IP hard — a 3s poll from the browser turned into
// a 429 every few requests. A short TTL collapses those polls into one
// upstream call, and a stale copy is served instead of a 429 when the
// provider is already throttling.
const LIST_TTL_MS = 8000;
const DETAIL_TTL_MS = 30000;
const STALE_MAX_MS = 60000;
const CACHE_MAX = 300;
// 429 = the provider throttles this IP, 403/5xx = its edge (Cloudflare)
// rejected the request. Both are worth another try, because a throttled
// window usually clears after a short pause and a blocked request goes out
// again with a different client signature.
const UPSTREAM_RETRIES = 2;
const UPSTREAM_RETRY_DELAYS = [700, 2000];
const UPSTREAM_RETRY_STATUSES = [403, 429, 502, 503, 504];
// The provider sits behind a bot filter. A plain script signature gets
// rejected with "error code: 1010", which used to leave the inbox silently
// empty. Send an ordinary browser signature, and rotate it on every retry so
// one blocked signature cannot turn into a dead inbox.
const UPSTREAM_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function upstreamHeaders(authorization) {
  const headers = {
    Accept: 'application/ld+json, application/json',
    'User-Agent': UPSTREAM_USER_AGENTS[0],
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (authorization) headers.Authorization = authorization;
  return headers;
}

const msgCache = new Map();

/**
 * The provider's edge answers a blocked request with HTML ("error code:
 * 1010"). The browser needs a JSON error it can show, not a wall of markup.
 */
function errorPayload(status, text) {
  try {
    JSON.parse(text);
    return text;
  } catch (_) { /* not JSON */ }
  const detail = String(text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
  let error = 'The mail provider returned an error.';
  if (status === 403) error = 'The mail provider blocked this request (bot filter). Retrying with a different signature.';
  else if (status === 429) error = 'The mail provider is rate limiting us.';
  else if (status >= 500) error = 'The mail provider is having trouble right now.';
  return JSON.stringify({ error, status, detail });
}

function cacheKeyFor(upstreamPath, query, req) {
  // The bearer token is the identity of a mailbox, so it is a safe cache key.
  return `${upstreamPath}${query}|${req.headers.authorization || ''}`;
}

function cacheGet(key) {
  return msgCache.get(key) || null;
}

function cacheSet(key, status, body) {
  if (msgCache.size >= CACHE_MAX) {
    const oldest = msgCache.keys().next().value;
    if (oldest !== undefined) msgCache.delete(oldest);
  }
  // Remember whether this copy actually holds something: an empty stale list
  // is worse than an honest error, because the inbox would look empty even
  // though the mail has already arrived.
  let hasItems = true;
  try {
    const parsed = JSON.parse(body);
    const members = parsed['hydra:member'];
    if (Array.isArray(members)) hasItems = members.length > 0;
  } catch (_) {
    hasItems = true; // not a list -> treat it as content
  }
  msgCache.set(key, { at: Date.now(), status, body, hasItems });
}

app.use('/api', async (req, res) => {
  const original = req.originalUrl || req.url; // e.g. /api/messages?page=1
  const q = original.indexOf('?');
  const upstreamPath = q === -1 ? original.slice(4) : original.slice(4, q);
  const query = q === -1 ? '' : original.slice(q);

  if (!ALLOWED.some((re) => re.test(upstreamPath))) {
    res.status(404).json({ error: 'Unknown endpoint' });
    return;
  }

  const headers = upstreamHeaders(req.headers.authorization);

  let body;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (req.body && Object.keys(req.body).length) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  // Only the read-only message endpoints are cached, never account mutations.
  const isList = upstreamPath === '/messages';
  const isDetail = /^\/messages\/[A-Za-z0-9]+$/.test(upstreamPath);
  const cacheable = req.method === 'GET' && (isList || isDetail);
  const ttl = isDetail ? DETAIL_TTL_MS : LIST_TTL_MS;
  // An explicit refresh from the user must not be answered from the cache.
  const forceFresh = req.headers['x-tempbox-fresh'] === '1';
  const key = cacheable ? cacheKeyFor(upstreamPath, query, req) : null;
  const cached = key && !forceFresh ? cacheGet(key) : null;

  if (cached && Date.now() - cached.at < ttl) {
    res
      .status(cached.status)
      .set('Cache-Control', 'no-store')
      .set('X-TempBox-Cache', 'hit')
      .type('application/json')
      .send(cached.body);
    return;
  }

  const sendStale = (reason) => {
    if (!cached || Date.now() - cached.at > STALE_MAX_MS) return false;
    // Never answer with an empty list: the client would keep showing an empty
    // inbox even though the mail is sitting in the provider. Let it see the
    // throttle instead and retry.
    if (!cached.hasItems) return false;
    res
      .status(200)
      .set('Cache-Control', 'no-store')
      .set('X-TempBox-Cache', 'stale')
      .set('X-TempBox-Cache-Reason', reason)
      .type('application/json')
      .send(cached.body);
    return true;
  };

  try {
    const url = new URL(upstreamPath + query, API_BASE);

    // A 429 from the provider is worth one more try: the limiter is burst
    // based, so waiting a moment usually gets the real answer through.
    // A 403 is the provider's bot filter: the same request goes out again
    // with a different client signature. Only reads are retried — replaying
    // a POST could create a duplicate.
    let upstream = null;
    const attempts = cacheable ? UPSTREAM_RETRIES + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, UPSTREAM_RETRY_DELAYS[attempt - 1] || 1000));
        headers['User-Agent'] = UPSTREAM_USER_AGENTS[attempt % UPSTREAM_USER_AGENTS.length];
      }
      const res = await fetch(url, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const text = await res.text();
      upstream = { status: res.status, ok: res.ok, text };
      if (!UPSTREAM_RETRY_STATUSES.includes(res.status)) break;
    }

    if (cacheable && upstream.ok) {
      cacheSet(key, upstream.status, upstream.text);
    } else if (cacheable && !upstream.ok) {
      // The provider is throttling us — keep the UI working with the last
      // good copy instead of handing the browser an empty inbox.
      if (sendStale('upstream-' + upstream.status)) return;
    }

    res
      .status(upstream.status)
      .set('Cache-Control', 'no-store')
      .type('application/json')
      .send(upstream.ok ? upstream.text : errorPayload(upstream.status, upstream.text));
  } catch (err) {
    if (cacheable && sendStale('network-error')) return;
    res.status(502).json({
      error: 'Cannot reach mail provider',
      detail: (err && err.message) || String(err),
    });
  }
});

// Malformed JSON body -> a clear 400 instead of an HTML stack trace.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  next(err);
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

// Bind the first free port from PORTS and keep any alias ports alive too.
// Container platforms (Deplox, Render, Fly, Heroku…) forward to a fixed
// container port and frequently do not set PORT, so 3000 has to be open.
const listeners = [];
let lastError = null;

function tryListen(port) {
  return new Promise((resolve) => {
    const srv = app.listen(port, HOST);

    const onError = (err) => {
      srv.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        console.error(`  Port ${port} is not available (${err.code}), trying next...`);
        lastError = err;
        resolve(false);
        return;
      }
      console.error('Server error:', err.message);
      process.exit(1);
    };

    const onListening = () => {
      srv.removeListener('error', onError);
      srv.on('error', (err) => console.error('Server error:', err.message));
      console.log(`Temp Mail running on http://localhost:${port}`);
      listeners.push(srv);
      resolve(true);
    };

    srv.once('error', onError);
    srv.once('listening', onListening);
  });
}

(async () => {
  for (const port of PORTS) {
    await tryListen(port);
  }

  console.log(`Mail provider: ${API_BASE}`);

  if (!listeners.length) {
    console.error('\n  Could not bind any port.');
    console.error(`  Start on another port, for example:  PORT=4600 node server.js\n`);
    if (lastError) console.error(`  Last error: ${lastError.code || lastError.message}\n`);
    process.exit(1);
  }
})();
