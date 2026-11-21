'use strict';

/**
 * End-to-end self test.
 *
 * Creates a mailbox through the local proxy, sends it a real email over SMTP,
 * then reads it back through the proxy and prints the raw API shapes.
 *
 * Usage:  node scripts/selftest.js [baseUrl] [domain]
 *   baseUrl  default http://localhost:4599
 *   domain   default: first domain reported by the provider
 */

const { execFileSync } = require('child_process');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:4599').replace(/\/+$/, '');
const PASSWORD = 'Temp@Pass12345';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, opts = {}) {
  const { method = 'GET', body = null, token = null } = opts;
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + pathname, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    const msg = (data && (data['hydra:description'] || data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

(async () => {
  const domains = await api('/api/domains?page=1');
  const list = domains['hydra:member'] || [];
  const domain = process.argv[3] || (list[0] && list[0].domain);
  if (!domain) throw new Error('No domain available from the provider');

  const address = `selftest${Date.now()}@${domain}`;
  console.log('1) creating mailbox', address);

  const account = await api('/api/accounts', { method: 'POST', body: { address, password: PASSWORD } });
  let token = account.token;
  if (!token) {
    const t = await api('/api/token', { method: 'POST', body: { address, password: PASSWORD } });
    token = t.token;
  }
  if (!token) throw new Error('Could not obtain a token');
  console.log('   token acquired:', token ? 'yes' : 'no');

  console.log('2) sending a real email over SMTP…');
  let sent = false;
  for (let attempt = 1; attempt <= 4 && !sent; attempt++) {
    try {
      execFileSync(process.execPath, [
        path.join(__dirname, 'send-test-mail.js'),
        address,
        'TempBox self test',
        'Your verification code is 482913. It expires in 10 minutes.',
      ], { stdio: attempt === 1 ? 'inherit' : 'ignore' });
      sent = true;
    } catch (err) {
      // The MX may need a moment to provision a new mailbox, or it may throttle
      // repeated connections from one IP — both are temporary.
      console.log(`   send attempt ${attempt} failed, retrying in 20s…`);
      await sleep(20000);
    }
  }
  if (!sent) {
    console.error('FAIL: SMTP send kept failing');
    process.exit(1);
  }

  console.log('3) waiting for delivery…');
  let messages = [];
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const data = await api('/api/messages?page=1', { token });
    messages = data['hydra:member'] || [];
    if (messages.length) break;
    console.log(`   ...${(i + 1) * 5}s, still nothing`);
  }

  if (!messages.length) {
    console.error('FAIL: no message arrived');
    process.exit(1);
  }

  const msg = messages[0];
  console.log('4) message arrived');
  console.log('   subject :', msg.subject);
  console.log('   from    :', msg.from && msg.from.address);
  console.log('   intro   :', JSON.stringify(msg.intro));
  console.log('   list keys:', Object.keys(msg).join(', '));

  const detail = await api(`/api/messages/${msg.id}`, { token });
  console.log('5) detail fetched');
  console.log('   detail keys:', Object.keys(detail).join(', '));
  console.log('   text       :', JSON.stringify(detail.text));
  console.log('   html parts :', (detail.html || []).length);
  console.log('   intro      :', JSON.stringify(detail.intro));
  console.log('   retention  :', JSON.stringify(detail.retention));

  const body = detail.text || (detail.html && detail.html[0]) || '';
  if (!body) {
    console.error('FAIL: detail response has no readable body');
    process.exit(1);
  }
  console.log('\nPASS: mail delivered and readable end to end');
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
