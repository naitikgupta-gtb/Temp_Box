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
  try {
    const upstream = await fetch(new URL('/domains', API_BASE), {
      headers: { Accept: 'application/ld+json, application/json', 'User-Agent': 'temp-mail-web/1.0' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    if (upstream.ok) {
      domainsCache.at = Date.now();
      domainsCache.body = text;
    }
    res.status(upstream.status).set('Cache-Control', 'no-store').type('application/json').send(text);
  } catch (err) {
    res.status(502).json({
      error: 'Cannot reach mail provider',
      detail: (err && err.message) || String(err),
    });
  }
});

// Everything else under /api is proxied to the provider.
app.use('/api', async (req, res) => {
  const original = req.originalUrl || req.url; // e.g. /api/messages?page=1
  const q = original.indexOf('?');
  const upstreamPath = q === -1 ? original.slice(4) : original.slice(4, q);
  const query = q === -1 ? '' : original.slice(q);

  if (!ALLOWED.some((re) => re.test(upstreamPath))) {
    res.status(404).json({ error: 'Unknown endpoint' });
    return;
  }

  const headers = {
    Accept: 'application/ld+json, application/json',
    'User-Agent': 'temp-mail-web/1.0',
  };
  if (req.headers.authorization) headers.Authorization = req.headers.authorization;

  let body;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (req.body && Object.keys(req.body).length) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  try {
    const upstream = await fetch(new URL(upstreamPath + query, API_BASE), {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.status(upstream.status).set('Cache-Control', 'no-store').type('application/json').send(text);
  } catch (err) {
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
