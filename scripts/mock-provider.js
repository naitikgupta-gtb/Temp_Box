'use strict';

/**
 * Mock mail provider — same JSON shape as mail.tm, for deterministic UI tests.
 *
 *   node scripts/mock-provider.js [port]
 *
 * Point the app at it:
 *   MAIL_API_BASE=http://127.0.0.1:4600 PORT=4601 node server.js
 *
 * It always returns two seeded messages so the inbox, the reader, the code
 * chip and the HTML view can be checked without depending on a real provider.
 */

const http = require('http');

const PORT = Number(process.argv[2] || 4600);
const DOMAIN = 'mock.test';

const messages = [
  {
    id: 'msg0000000000000000001',
    from: { address: 'no-reply@shop.example', name: 'Shop Verify' },
    to: [{ address: `someone@${DOMAIN}` }],
    subject: 'Your verification code',
    intro: 'Hi! Your verification code is 482913. It expires in 10 minutes.',
    seen: false,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    text: 'Hi!\n\nYour verification code is 482913.\nIt expires in 10 minutes.\n\n- Shop Verify',
    html: ['<html><body style="font-family:sans-serif"><h2>Your verification code</h2><p>Your code is <b>482913</b></p><p>It expires in 10 minutes.</p></body></html>'],
  },
  {
    id: 'msg0000000000000000002',
    from: { address: 'newsletter@blog.example', name: 'Daily Digest' },
    to: [{ address: `someone@${DOMAIN}` }],
    subject: 'Five things worth reading',
    intro: 'A quick digest for your reading list.',
    seen: true,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    text: 'Here are five things worth reading today.\n\n1. Something about types\n2. Something about mail\n3. Something else',
    html: [],
  },
];

const accounts = new Map();

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  let body = {};
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
  }

  if (path === '/domains') {
    return send(res, 200, { 'hydra:member': [{ id: 'dom1', domain: DOMAIN, isActive: true }] });
  }

  if (path === '/accounts' && req.method === 'POST') {
    const address = body.address || `box${Date.now()}@${DOMAIN}`;
    const id = 'acc' + Date.now();
    const token = 'tok' + Math.random().toString(36).slice(2);
    accounts.set(address, { id, token, password: body.password });
    return send(res, 201, { id, address, token, quota: 40000000, used: 0, isDisabled: false, isDeleted: false });
  }

  if (path === '/token' && req.method === 'POST') {
    const acc = accounts.get(body.address);
    if (!acc || acc.password !== body.password) {
      return send(res, 401, { 'hydra:title': 'Unauthorized', 'hydra:description': 'Invalid credentials' });
    }
    return send(res, 200, { token: acc.token, id: acc.id });
  }

  if (path === '/messages') {
    return send(res, 200, { 'hydra:member': messages.map((m) => ({
      id: m.id, from: m.from, to: m.to, subject: m.subject, intro: m.intro,
      seen: m.seen, isDeleted: false, createdAt: m.createdAt, updatedAt: m.createdAt,
    })) });
  }

  if (path.startsWith('/messages/')) {
    const id = path.split('/').pop();
    const msg = messages.find((m) => m.id === id);
    if (!msg) return send(res, 404, { 'hydra:title': 'Not Found', 'hydra:description': 'No such message' });
    return send(res, 200, msg);
  }

  if (path.startsWith('/accounts/') && req.method === 'DELETE') {
    return send(res, 204, {});
  }

  if (path.startsWith('/messages/') && req.method === 'DELETE') {
    return send(res, 204, {});
  }

  send(res, 404, { error: 'Not found', path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock provider on http://127.0.0.1:${PORT} (domain ${DOMAIN})`);
});
