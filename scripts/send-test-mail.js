'use strict';

/**
 * Self-test helper: sends a real email to a temporary address via plain SMTP
 * so the inbox pipeline can be verified end-to-end (mail.tm does not allow
 * sending through its API).
 *
 * Usage:
 *   node scripts/send-test-mail.js <recipient@domain> ["subject"] ["body"]
 *
 * The MX record of the target domain is resolved automatically.
 */

const net = require('net');
const dns = require('dns/promises');

const [, , recipient, subject = 'TempBox verification code', body = 'Your verification code is 482913. It expires in 10 minutes.'] = process.argv;

if (!recipient) {
  console.error('Usage: node scripts/send-test-mail.js <recipient@domain> [subject] [body]');
  process.exit(1);
}

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.waiters = [];
    this.pending = [];
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed by server')));
    socket.on('end', () => this.fail(new Error('SMTP connection ended by server')));
  }

  fail(err) {
    const w = this.waiters.shift();
    if (w) w.reject(err);
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);

      if (/^\d{3}-/.test(line)) continue;          // continuation line
      if (!/^\d{3} /.test(line)) continue;          // not a status line

      const waiter = this.waiters.shift();
      if (!waiter) {
        this.pending.push(line);   // arrived before a waiter was registered
        continue;
      }
      waiter.resolve(line);
    }
  }

  expect(codes) {
    const queued = this.pending.shift();
    if (queued) {
      const code = parseInt(queued.slice(0, 3), 10);
      if (codes.includes(code)) return Promise.resolve(queued);
      return Promise.reject(new Error('Unexpected SMTP code ' + code + ': ' + queued.trim()));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP timeout waiting for ' + codes.join('/'))), 15000);
      this.waiters.push({
        resolve: (line) => { clearTimeout(timer); resolve(line); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  async cmd(line, codes) {
    this.socket.write(line + '\r\n');
    return this.expect(codes);
  }

  /** Sends a command and aborts on any unexpected reply code. */
  async cmdOrFail(line, codes) {
    const reply = await this.cmd(line, codes);
    const code = parseInt(reply.slice(0, 3), 10);
    if (!codes.includes(code)) throw new Error('SMTP rejected ' + line.split(' ')[0] + ': ' + reply.trim());
    return reply;
  }
}

(async () => {
  const domain = recipient.split('@')[1];
  const mx = await dns.resolveMx(domain);
  if (!mx.length) throw new Error('No MX record for ' + domain);
  const host = mx.sort((a, b) => a.priority - b.priority)[0].exchange;
  console.log(`MX for ${domain}: ${host}`);

  const socket = net.connect({ host, port: 25 });
  socket.setTimeout(20000);
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', resolve);
  });

  const smtp = new Smtp(socket);
  console.log('S:', await smtp.expect([220]));
  console.log('C:', await smtp.cmdOrFail('EHLO tempbox.test', [250]));
  console.log('C:', await smtp.cmdOrFail('MAIL FROM:<verify@tempbox.test>', [250]));
  console.log('C:', await smtp.cmdOrFail(`RCPT TO:<${recipient}>`, [250, 251]));
  console.log('C:', await smtp.cmdOrFail('DATA', [354]));

  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@tempbox.test>`;
  const payload = [
    `From: TempBox Verify <verify@tempbox.test>`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  socket.write(payload + '\r\n.\r\n');
  console.log('C:', await smtp.expect([250]));
  socket.write('QUIT\r\n');
  socket.end();
  console.log('Sent OK ->', recipient, '| Message-ID:', msgId);
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', (err && err.message) || err || 'unknown error');
  if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
