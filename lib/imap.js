'use strict';

/**
 * Minimal IMAP4rev1 client — just enough to read one mailbox over TLS.
 *
 * No dependencies: node:tls only. Supports exactly what TempBox needs:
 *   LOGIN · SELECT INBOX · UID SEARCH · UID FETCH (headers / body) · LOGOUT
 *
 * Why this exists: a Gmail address can only receive mail if somebody owns
 * that exact Gmail account. Gmail's own alias rules (plus-addressing and
 * the dot trick) let one account answer to many addresses, and reading those
 * aliases means reading the account over IMAP.
 */

const tls = require('tls');

class ImapError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ImapError';
    this.code = code || 'imap';
  }
}

/** Quote a string for the IMAP command line. */
function quote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Split a raw message into headers + body, then decode the body. */
function parseHeaders(head) {
  const headers = {};
  const lines = head.split(/\r?\n/);
  let lastKey = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line) && lastKey) {
      headers[lastKey] += ' ' + line.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    lastKey = line.slice(0, idx).trim().toLowerCase();
    headers[lastKey] = line.slice(idx + 1).trim();
  }
  return headers;
}

function decodeQuotedPrintable(str) {
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBody(body, encoding) {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (_) {
      return body;
    }
  }
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/** Pull `charset=` out of a Content-Type header. */
function charsetOf(contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return (m ? m[1] : 'utf-8').toLowerCase();
}

/**
 * Turn a raw MIME message into { headers, text, html }.
 * Picks text/plain when it exists, otherwise the first text/html part.
 */
function parseMessage(raw) {
  const source = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const sep = source.indexOf('\r\n\r\n');
  const cut = sep === -1 ? source.indexOf('\n\n') : sep;
  const head = cut === -1 ? source : source.slice(0, cut);
  const body = cut === -1 ? '' : source.slice(cut + (sep === -1 ? 2 : 4));

  const headers = parseHeaders(head);
  const contentType = headers['content-type'] || 'text/plain';

  // multipart? -> find the parts and pick the best one
  if (/^multipart\//i.test(contentType)) {
    const bMatch = /boundary=["']?([^"';]+)/i.exec(contentType);
    if (bMatch) {
      const boundary = '--' + bMatch[1].trim();
      const chunks = body.split(boundary);
      let plain = null;
      let html = null;
      for (const chunk of chunks) {
        if (!chunk || chunk === '--' || /^\s*--/.test(chunk)) continue;
        const part = parseMessage(chunk.replace(/^\r?\n/, ''));
        const type = (part.headers['content-type'] || '').toLowerCase();
        if (type.startsWith('text/plain') && !plain) plain = part;
        else if (type.startsWith('text/html') && !html) html = part;
      }
      const picked = plain || html;
      if (picked) {
        return {
          headers,
          text: picked.text || '',
          html: picked.html || (plain ? [] : [picked.text || '']),
        };
      }
    }
  }

  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  const charset = charsetOf(contentType);
  let out = decoded;
  if (charset && !/utf-?8|us-ascii/i.test(charset)) {
    try {
      out = Buffer.from(decoded, 'latin1').toString('utf8');
    } catch (_) { /* keep as-is */ }
  }

  if (/^text\/html/i.test(contentType)) return { headers, text: '', html: [out] };
  return { headers, text: out, html: [] };
}

/** Pull the display name and address out of an address header. */
function parseAddress(value) {
  const raw = (value || '').trim();
  if (!raw) return { name: '', address: '' };
  const angled = /<([^>]+)>/.exec(raw);
  const address = angled ? angled[1].trim() : raw;
  const name = angled ? raw.slice(0, angled.index).trim().replace(/^"|"$/g, '') : '';
  return { name, address };
}

/** Every address in a header value (To:, Cc:, …). */
function parseAddressList(value) {
  return String(value || '')
    .split(/,(?![^<]*>)/)
    .map((s) => parseAddress(s))
    .filter((a) => a.address);
}

class ImapConnection {
  constructor(opts = {}) {
    this.host = opts.host || 'imap.gmail.com';
    this.port = opts.port || 993;
    this.user = opts.user || '';
    this.password = opts.password || '';
    this.timeout = opts.timeout || 20000;
    // Implicit TLS is the default (Gmail: 993). Plain TCP is used for
    // STARTTLS-style servers and for local testing.
    this.secure = opts.secure !== false;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.pendingLiteral = null;
    this.waiters = [];
    this.tag = 0;
    this.capabilities = '';
  }

  /* ── socket plumbing ─────────────────────────────────────── */

  connect() {
    return new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({
          host: this.host,
          port: this.port,
          servername: this.host,
          timeout: this.timeout,
        })
        : require('net').connect({ host: this.host, port: this.port, timeout: this.timeout });
      const onError = (err) => {
        cleanup();
        reject(new ImapError('Cannot reach the mail server (' + this.host + '): ' + err.message, 'connect'));
      };
      const onTimeout = () => {
        cleanup();
        try { socket.destroy(); } catch (_) { /* ignore */ }
        reject(new ImapError('The mail server did not answer in time', 'timeout'));
      };
      const cleanup = () => {
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
      };
      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      // TLS emits 'secureConnect' once the handshake is done; plain TCP emits
      // 'connect'.
      socket.once(this.secure ? 'secureConnect' : 'connect', () => {
        cleanup();
        socket.setTimeout(0);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', () => this._fail(new ImapError('Connection lost', 'network')));
        socket.on('close', () => this._fail(new ImapError('Connection closed by the mail server', 'network')));
        this._readResponse().then((greeting) => {
          const caps = /\[CAPABILITY ([^\]]+)\]/i.exec(greeting.text || '');
          this.capabilities = caps ? caps[1] : '';
          resolve(this);
        }).catch(reject);
      });
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
  }

  _fail(err) {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  /**
   * Take the next line or literal out of the buffer, if one is complete.
   *
   * A line that ends with "{123}" announces a literal: the line itself is
   * still delivered first, and the literal follows as the next item.
   */
  _peekItem() {
    if (this.pendingLiteral) {
      const n = this.pendingLiteral;
      if (this.buf.length < n) return null;
      this.pendingLiteral = null;
      return { kind: 'literal', value: this.buf.slice(0, n), consumed: n };
    }
    const idx = this.buf.indexOf('\r\n');
    if (idx === -1) return null;
    const line = this.buf.slice(0, idx).toString('utf8');
    const lit = /\{(\d+)\+?\}$/.exec(line);
    if (lit) {
      this.pendingLiteral = parseInt(lit[1], 10);
      return { kind: 'line', value: line, consumed: idx + 2 };
    }
    return { kind: 'line', value: line, consumed: idx + 2 };
  }

  _drain() {
    while (this.waiters.length) {
      const item = this._peekItem();
      if (!item) break;
      this.buf = this.buf.slice(item.consumed);
      this.waiters.shift().resolve(item);
    }
  }

  _next() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this._drain();
    });
  }

  /**
   * Read one server response: a tagged line, or an untagged block that may
   * contain literals (header/body payloads).
   */
  async _readResponse() {
    const lines = [];
    const literals = [];
    let depth = 0;
    for (;;) {
      const item = await this._next();
      if (item.kind === 'literal') {
        literals.push(item.value);
        continue;
      }
      const line = item.value;
      lines.push(line);
      // A tagged reply looks like "A001 OK …". Untagged ones start with "*"
      // and must never end the command ("* OK [UIDVALIDITY …] UIDs valid").
      if (/^(?!\*)\S+\s+(OK|NO|BAD)\b/i.test(line)) {
        return { lines, literals, text: lines.join('\n'), tagged: true };
      }
      // Untagged: count parentheses to know when the block is complete.
      for (const ch of line) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
      if (depth <= 0) {
        return { lines, literals, text: lines.join('\n'), tagged: false };
      }
    }
  }

  /** Send one command and collect its responses. */
  async _command(text) {
    if (!this.socket) throw new ImapError('Not connected to the mail server', 'state');
    const tag = 'A' + String(++this.tag).padStart(3, '0');
    this._write(tag + ' ' + text);
    const lines = [];
    const literals = [];
    for (;;) {
      const res = await this._readResponse();
      lines.push(...res.lines);
      literals.push(...res.literals);
      const last = res.lines[res.lines.length - 1] || '';
      if (res.tagged) {
        const status = /^(?!\*)\S+\s+(OK|NO|BAD)\b/i.exec(last);
        const code = status ? status[1].toUpperCase() : 'BAD';
        if (code !== 'OK') {
          const reason = last.replace(/^\S+\s+(OK|NO|BAD)\s*/i, '').trim();
          throw new ImapError(reason || 'The mail server refused the command', code.toLowerCase());
        }
        return { lines, literals, text: lines.join('\n') };
      }
    }
  }

  _write(text) {
    this.socket.write(text + '\r\n');
  }

  /* ── commands ─────────────────────────────────────────────── */

  async login() {
    await this._command('LOGIN ' + quote(this.user) + ' ' + quote(this.password));
    return true;
  }

  async selectInbox() {
    await this._command('SELECT INBOX');
    return true;
  }

  /** All UIDs in the mailbox, newest last. */
  async uidSearchAll() {
    const res = await this._command('UID SEARCH ALL');
    const uids = [];
    for (const line of res.lines) {
      if (!/^\*\s+SEARCH\b/i.test(line)) continue;
      for (const tok of line.replace(/^\*\s+SEARCH\s*/i, '').split(/\s+/)) {
        if (/^\d+$/.test(tok)) uids.push(parseInt(tok, 10));
      }
    }
    return uids;
  }

  /**
   * Fetch headers for the given UIDs.
   * Returns [{ uid, headers }] — one entry per message.
   *
   * Each FETCH response carries exactly one literal (the header block) and
   * the responses come back in the same order as the literals, so they can be
   * paired by position.
   */
  async uidFetchHeaders(uids) {
    if (!uids.length) return [];
    const list = uids.join(',');
    const res = await this._command('UID FETCH ' + list + ' (BODY.PEEK[HEADER])');
    const out = [];
    for (const line of res.lines) {
      const m = /^\*\s+(\d+)\s+FETCH\b/i.exec(line);
      if (!m) continue;
      const raw = res.literals[out.length] || Buffer.alloc(0);
      out.push({ uid: parseInt(m[1], 10), headers: parseHeaders(raw.toString('utf8')) });
    }
    return out;
  }

  /** The full raw message for one UID. */
  async uidFetchBody(uid) {
    const res = await this._command('UID FETCH ' + uid + ' (BODY.PEEK[])');
    const raw = res.literals[res.literals.length - 1] || Buffer.alloc(0);
    return raw.toString('utf8');
  }

  async logout() {
    try {
      await this._command('LOGOUT');
    } catch (_) { /* the server may drop the connection right after */ }
    this.close();
  }

  close() {
    if (this.socket) {
      try { this.socket.end(); } catch (_) { /* ignore */ }
      try { this.socket.destroy(); } catch (_) { /* ignore */ }
      this.socket = null;
    }
  }
}

/** Headers that carry the real recipient of a message. */
const RECIPIENT_FIELDS = [
  'delivered-to',
  'x-original-to',
  'x-google-original-to',
  'envelope-to',
  'to',
  'cc',
];

/** Does this message belong to that alias? */
function headerMatchesAlias(headers, alias) {
  const needle = String(alias || '').trim().toLowerCase();
  if (!needle) return false;
  for (const field of RECIPIENT_FIELDS) {
    const value = headers[field];
    if (!value) continue;
    if (String(value).toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Read every message of one alias out of a mailbox.
 *
 * One short-lived TLS connection per call: log in, read the header of the
 * recent messages, keep the ones addressed to `alias`, then fetch the body
 * of just those. The account password never leaves the server.
 */
async function readAliasMessages({ host, port, user, password, alias, limit = 40, timeout = 20000, secure }) {
  const conn = new ImapConnection({ host, port, user, password, timeout, secure });
  try {
    await conn.connect();
    await conn.login();
    await conn.selectInbox();
    const uids = await conn.uidSearchAll();
    const headers = await conn.uidFetchHeaders(uids.slice(-limit));
    const matched = headers.filter((entry) => headerMatchesAlias(entry.headers, alias));
    const out = [];
    for (const entry of matched) {
      const raw = await conn.uidFetchBody(entry.uid);
      out.push({ uid: entry.uid, headers: entry.headers, message: parseMessage(raw) });
    }
    return out;
  } finally {
    conn.close();
  }
}

/** Read one message (headers + body) by UID. */
async function readMessage({ host, port, user, password, uid, timeout = 20000, secure }) {
  const conn = new ImapConnection({ host, port, user, password, timeout, secure });
  try {
    await conn.connect();
    await conn.login();
    await conn.selectInbox();
    const raw = await conn.uidFetchBody(uid);
    return parseMessage(raw);
  } finally {
    conn.close();
  }
}

module.exports = {
  ImapConnection,
  ImapError,
  parseMessage,
  parseHeaders,
  parseAddress,
  parseAddressList,
  headerMatchesAlias,
  readAliasMessages,
  readMessage,
};
