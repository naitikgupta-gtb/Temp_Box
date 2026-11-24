/**
 * Fake IMAP4rev1 server for testing TempBox's Gmail mode — no Gmail account,
 * no network, no TLS certificate.
 *
 * It behaves like a Gmail mailbox for whichever account logs in:
 *   uid 1 -> To: <account>+shop@gmail.com   (a plus-addressed alias)
 *   uid 2 -> To: <account>@gmail.com         (the account itself)
 *   uid 3 -> To: someone.else@gmail.com     (somebody else — must not leak)
 *
 * Plain TCP, so run the app with IMAP_SECURE=false:
 *
 *   node scripts/fake-imap.js 4701
 *   $env:IMAP_HOST='127.0.0.1'; $env:IMAP_PORT='4701'; $env:IMAP_SECURE='false'
 *   $env:PORT='4611'; node server.js
 */
const net = require('node:net');

const PORT = Number(process.argv[2] || process.env.IMAP_PORT || 4701);
const SENDER = 'Shop Verify <no-reply@shop.test>';

function buildMessages(user) {
  const base = String(user || '').trim().toLowerCase();
  const at = base.indexOf('@');
  const local = at === -1 ? base : base.slice(0, at);
  const domain = at === -1 ? 'gmail.com' : base.slice(at + 1);
  const alias = `${local}+shop@${domain}`;
  return {
    1: {
      headers:
        `From: ${SENDER}\r\n` +
        `To: ${alias}\r\n` +
        `Delivered-To: ${alias}\r\n` +
        'Subject: Shop Verify code 482913\r\n' +
        'Date: Tue, 24 Nov 2026 10:15:00 +0530\r\n' +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n',
      body: 'Your verification code is 482913. It expires in 10 minutes.',
    },
    2: {
      headers:
        'From: GitHub <noreply@github.com>\r\n' +
        `To: ${base}\r\n` +
        `Delivered-To: ${base}\r\n` +
        'Subject: Your GitHub verification code\r\n' +
        'Date: Tue, 24 Nov 2026 11:02:00 +0530\r\n' +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n',
      body: 'Your verification code is 663311.',
    },
    3: {
      headers:
        'From: Someone Else <hi@other.test>\r\n' +
        'To: someone.else@gmail.com\r\n' +
        'Subject: Not yours\r\n' +
        'Date: Tue, 24 Nov 2026 09:00:00 +0530\r\n' +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n',
      body: 'This message belongs to a different inbox.',
    },
  };
}

const server = net.createServer((sock) => {
  let user = 'you@gmail.com';
  let messages = buildMessages(user);
  let buf = '';

  sock.write('* OK [CAPABILITY IMAP4rev1] fake imap ready\r\n');

  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const sp = line.indexOf(' ');
      const tag = sp === -1 ? line : line.slice(0, sp);
      const rest = sp === -1 ? '' : line.slice(sp + 1);
      const cmd = (rest.split(' ')[0] || '').toUpperCase();
      const parts = rest.split(' ');

      if (cmd === 'LOGIN') {
        if (parts[1]) {
          user = parts[1].replace(/^"|"$/g, '');
          messages = buildMessages(user);
        }
        sock.write(`${tag} OK LOGIN completed\r\n`);
      } else if (cmd === 'SELECT') {
        sock.write(
          `* ${Object.keys(messages).length} EXISTS\r\n` +
          '* 0 RECENT\r\n' +
          '* OK [UIDVALIDITY 1] UIDs valid\r\n' +
          `${tag} OK [READ-WRITE] SELECT completed\r\n`
        );
      } else if (cmd === 'UID' && (parts[1] || '').toUpperCase() === 'SEARCH') {
        const uids = Object.keys(messages).map(Number).sort((a, b) => a - b);
        sock.write(`* SEARCH ${uids.join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (cmd === 'UID' && (parts[1] || '').toUpperCase() === 'FETCH') {
        const spec = parts[3] || '';
        const wanted = [];
        for (const part of (parts[2] || '').split(',')) {
          if (part.includes(':')) {
            const [a, b] = part.split(':').map(Number);
            for (let u = a; u <= b; u++) wanted.push(u);
          } else if (/^\d+$/.test(part)) {
            wanted.push(Number(part));
          }
        }
        for (const uid of [...new Set(wanted)].sort((a, b) => a - b)) {
          if (!messages[uid]) continue;
          const raw = messages[uid].headers + '\r\n' + messages[uid].body + '\r\n';
          const buf2 = Buffer.from(raw, 'utf8');
          const label = spec.toUpperCase().includes('HEADER') ? 'BODY[HEADER]' : 'BODY[]';
          sock.write(`* ${uid} FETCH (${label} {${buf2.length}}\r\n`);
          sock.write(buf2);
          sock.write(')\r\n');
        }
        sock.write(`${tag} OK FETCH completed\r\n`);
      } else if (cmd === 'LOGOUT') {
        sock.write(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);
        sock.end();
      } else {
        sock.write(`${tag} OK done\r\n`);
      }
    }
  });

  sock.on('error', () => { /* client went away */ });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake imap on 127.0.0.1:${PORT}`);
});
