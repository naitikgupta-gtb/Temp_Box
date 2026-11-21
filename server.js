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
 *   PORT          default 4599
 *   HOST          default 0.0.0.0
 *   MAIL_API_BASE default https://api.mail.tm
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4599);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE = (process.env.MAIL_API_BASE || 'https://api.mail.tm').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

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
// Never let a stalled provider hold a browser request open forever.
const UPSTREAM_TIMEOUT_MS = 20000;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function proxyToProvider(req, res, upstreamPath) {
  const target = new URL(upstreamPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''), API_BASE);

  const headers = {
    Accept: 'application/ld+json, application/json',
    'User-Agent': 'temp-mail-web/1.0',
  };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (req.headers['authorization']) headers.Authorization = req.headers.authorization;

  let body;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    body = await readBody(req);
    if (body === null) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    headers['Content-Type'] = 'application/json';
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: 'Upstream returned a non-JSON response', detail: text.slice(0, 400) };
    }

    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  } catch (err) {
    sendJson(res, 502, {
      error: 'Cannot reach mail provider',
      detail: (err && err.message) || String(err),
    });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, provider: API_BASE, time: new Date().toISOString() });
    return;
  }

  if (pathname.startsWith('/api/')) {
    const upstreamPath = pathname.slice('/api'.length);

    if (!ALLOWED.some((re) => re.test(upstreamPath))) {
      sendJson(res, 404, { error: 'Unknown endpoint' });
      return;
    }

    if (upstreamPath === '/domains' && req.method === 'GET') {
      if (Date.now() - domainsCache.at < DOMAIN_TTL && domainsCache.body) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(domainsCache.body);
        return;
      }
      // This one used to be able to hang forever: an unhandled rejection here
      // left the browser waiting with no response at all.
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
        res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(text);
      } catch (err) {
        sendJson(res, 502, {
          error: 'Cannot reach mail provider',
          detail: (err && err.message) || String(err),
        });
      }
      return;
    }

    await proxyToProvider(req, res, upstreamPath);
    return;
  }

  serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    console.error(`\n  Port ${PORT} is not available (${err.code}).`);
    console.error(`  Start on another port, for example:  PORT=4600 node server.js\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Temp Mail running on http://localhost:${PORT}`);
  console.log(`Mail provider: ${API_BASE}`);
});
