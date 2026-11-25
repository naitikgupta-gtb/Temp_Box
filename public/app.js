/* TempBox — temporary email web client
 * Talks to /api/* (same-origin proxy) so the provider's CORS policy never
 * blocks the browser.
 */
(() => {
  'use strict';

  const STORE_KEY = 'tmpmail.state.v1';
  const POLL_MS = 3000;
  const IDLE_POLL_EVERY = 5; // poll other inboxes every Nth tick
  const RATE_LIMIT_BACKOFF_MS = 12000; // pause polling after an HTTP 429
  const MAX_BACKOFF_MS = 45000; // ... but not forever on a shared IP
  const EMPTY_FORCE_FRESH_MS = 20000; // bypass the server cache after this long empty

  const $ = (id) => document.getElementById(id);

  const ADJ = ['swift','brave','calm','deft','eager','frost','glide','hazel','ivory','jolly','keen','lunar','mellow','noble','prime','quiet','rapid','solar','tidal','urban','vivid','warm','zesty','amber','bold'];
  const NOUN = ['falcon','ember','otter','pixel','raven','comet','harbor','lagoon','meadow','quartz','signal','summit','tunnel','violet','willow','zenith','anchor','breeze','canyon','delta','echo','flint','glacier','thunder'];

  const state = {
    boxes: [],
    activeId: null,
    selectedId: null,
    domains: [],
    domain: null,
    displayAs: 'gmail.com',
    auto: true,
    sound: false,
    htmlView: false,
    tickCount: 0,
    busy: false,
    backoffUntil: 0,
    forceFresh: false,
    // The last failed poll, so the inbox can say what went wrong instead of
    // looking empty while the mail is actually sitting in the provider.
    lastError: null,
    consec429: 0,
    lastCheckAt: 0,
    // Which backend the inbox reads from: a disposable domain (mail.tm) or
    // real @gmail.com aliases minted off the user's own Gmail account.
    source: 'mailtm',
    gmail: { token: '', user: '', domain: '', forceClear: false },
    // Ids of inboxes that were deleted on purpose. Kept so that merging the
    // saved state cannot resurrect a deleted inbox.
    deleted: new Set(),
  };

  // Signatures of what is currently rendered, so the 3s poll does not rebuild
  // the DOM (and reset reader scroll / reload the HTML iframe) needlessly.
  let lastListSig = null;
  let lastReaderSig = null;
  let lastBoxSig = null;
  const detailAttempted = new Set();

  /* ── storage ─────────────────────────────────────────────── */
  /**
   * Persist the state.
   *
   * The state is merged with what is already stored instead of overwriting
   * it: another tab of this app (or a tab that lost its session) must never
   * be able to wipe the inbox list or the Gmail token of the whole app.
   */
  function save() {
    try {
      let stored = {};
      try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) {}

      const merged = new Map();
      (stored.boxes || []).forEach((b) => { if (b && b.id) merged.set(b.id, b); });
      state.boxes.forEach((b) => merged.set(b.id, {
        id: b.id, address: b.address, password: b.password, token: b.token,
        createdAt: b.createdAt, knownIds: Array.from(b.knownIds || []),
        provider: b.provider || 'mailtm', gmailToken: b.gmailToken || null,
      }));

      const deleted = new Set([...(stored.deleted || []), ...(state.deleted || [])]);
      const boxes = [...merged.values()].filter((b) => !deleted.has(b.id));

      let gmail = stored.gmail || { token: '', user: '', domain: '' };
      if (state.gmail.forceClear) {
        // The user asked to forget the account on purpose.
        gmail = { token: '', user: '', domain: '' };
        state.gmail.forceClear = false;
      } else if (state.gmail.token) {
        gmail = { token: state.gmail.token, user: state.gmail.user, domain: state.gmail.domain };
      }

      localStorage.setItem(STORE_KEY, JSON.stringify({
        boxes,
        deleted: [...deleted],
        activeId: state.activeId,
        selectedId: state.selectedId,
        domain: state.domain,
        displayAs: state.displayAs,
        auto: state.auto,
        sound: state.sound,
        source: state.source,
        gmail,
      }));
    } catch (_) { /* storage may be unavailable */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state.deleted = new Set(data.deleted || []);
      state.boxes = (data.boxes || [])
        .filter((b) => b && !state.deleted.has(b.id))
        .map((b) => ({
          ...b, messages: [], knownIds: new Set(b.knownIds || []), unread: 0,
        }));
      state.activeId = data.activeId && state.boxes.some((b) => b.id === data.activeId)
        ? data.activeId
        : (state.boxes[0] && state.boxes[0].id) || null;
      state.selectedId = data.selectedId || null;
      state.domain = data.domain || null;
      state.displayAs = data.displayAs || 'gmail.com';
      state.auto = data.auto !== false;
      state.sound = !!data.sound;
      state.source = data.source === 'gmail' ? 'gmail' : 'mailtm';
      if (data.gmail) {
        state.gmail.token = data.gmail.token || '';
        state.gmail.user = data.gmail.user || '';
        state.gmail.domain = data.gmail.domain || '';
      }
    } catch (_) { /* ignore corrupt state */ }
  }

  /* ── api ─────────────────────────────────────────────────── */
  const API_TIMEOUT_MS = 15000;

  async function api(path, opts = {}) {
    const { method = 'GET', body = null, token = null, fresh = false } = opts;
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    // An explicit refresh must reach the provider instead of the server cache.
    if (fresh) headers['X-TempBox-Fresh'] = '1';

    // A request that never comes back would leave the UI stuck on "loading…"
    // forever, so every call gets a deadline.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch('/api' + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const e = new Error(err && err.name === 'AbortError' ? 'request timed out' : 'service unreachable');
      e.status = 0;
      throw e;
    }
    clearTimeout(timer);

    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }

    if (!res.ok) {
      const msg = (data && (data['hydra:description'] || data.error || data.message || data['hydra:title'])) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      if (data && data.detail) err.detail = data.detail;
      if (data && data.hint) err.hint = data.hint;
      throw err;
    }
    return data;
  }

  /* ── helpers ─────────────────────────────────────────────── */
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[rand(arr.length)];

  function genLocalPart() {
    return `${pick(ADJ)}${pick(NOUN)}${100 + rand(900)}`;
  }

  function genPassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
    let out = '';
    for (let i = 0; i < 16; i++) out += chars[rand(chars.length)];
    return out;
  }

  function sanitizeLocal(v) {
    return (v || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 40);
  }

  function activeBox() {
    return state.boxes.find((b) => b.id === state.activeId) || null;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(() => el.remove(), 320);
    }, 2800);
  }

  function setStatus(stateName) {
    const dot = $('statusDot');
    dot.className = 'status-dot' + (stateName === 'ok' ? ' ok' : stateName === 'bad' ? ' bad' : stateName === 'busy' ? ' busy' : '');
    dot.title = stateName === 'ok' ? 'Mail service connected'
      : stateName === 'bad' ? 'Mail service unreachable'
      : stateName === 'busy' ? 'Rate limited — retrying shortly'
      : 'Connecting…';
  }

  function beep() {
    if (!state.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1180, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.start(); osc.stop(ctx.currentTime + 0.34);
      setTimeout(() => ctx.close(), 600);
    } catch (_) { /* audio blocked */ }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (__) { return false; }
    }
  }

  /* ── inbox plumbing ──────────────────────────────────────── */
  function normalizeMessage(m) {
    return {
      id: m.id,
      from: (m.from && (m.from.address || m.from.name)) || 'unknown',
      fromName: (m.from && m.from.name) || '',
      to: Array.isArray(m.to) ? (m.to[0] && m.to[0].address) || '' : (m.to && m.to.address) || '',
      subject: m.subject || '(no subject)',
      intro: m.intro || '',
      seen: !!m.seen,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt || m.createdAt || '',
      html: m.html || [],
      text: m.text || '',
      attachments: m.attachments || [],
    };
  }

  /** Provider tokens expire (mail.tm: ~1 hour). Renew it from the stored password. */
  async function refreshToken(box) {
    if (!box || !box.password) return null;
    try {
      const t = await api('/token', { method: 'POST', body: { address: box.address, password: box.password } });
      if (t && t.token) {
        box.token = t.token;
        save();
        return t.token;
      }
    } catch (_) { /* fall through — caller keeps the original error */ }
    return null;
  }

  async function pull(box, { announce = true, fresh = false } = {}) {
    let data;
    const isGmail = box.provider === 'gmail';
    const listUrl = isGmail
      ? '/gmail/messages?alias=' + encodeURIComponent(box.address)
      : '/messages?page=1';
    const listToken = isGmail ? (box.gmailToken || state.gmail.token) : box.token;
    try {
      data = await api(listUrl, { token: listToken, fresh });
    } catch (err) {
      // Token expired or was invalidated -> refresh it with the stored password, retry once.
      if (isGmail) {
        // The Gmail session died (server restart, or the app password changed).
        // Re-login with the stored app password before giving up — dropping the
        // token here would throw away the only way back in.
        if (err.status === 401) {
          const back = await restoreGmailSession();
          if (!back) {
            // The server says this session is gone — drop it for good.
            state.gmail.token = '';
            state.gmail.forceClear = true;
            save();
            renderSource();
            throw err;
          }
          const newToken = state.gmail.token;
          state.boxes.forEach((b) => { if (b.provider === 'gmail') b.gmailToken = newToken; });
          data = await api(listUrl, { token: newToken, fresh });
        } else {
          throw err;
        }
      }
      if ((err.status === 401 || err.status === 404) && box.password) {
        const newToken = await refreshToken(box);
        if (!newToken) throw err;
        data = await api(listUrl, { token: box.token, fresh });
      } else {
        throw err;
      }
    }

    const raw = Array.isArray(data) ? data : (data['hydra:member'] || []);
    const prevById = new Map((box.messages || []).map((m) => [m.id, m]));
    const list = raw.map(normalizeMessage).sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    ).map((m) => {
      // The list endpoint never returns the message body, so a plain replace
      // would wipe the body we already fetched on every 3s poll.
      const prev = prevById.get(m.id);
      if (!prev) return m;
      const merged = { ...m, seen: prev.seen || m.seen };
      if (prev.text) {
        // Keep the body unless the provider says the message itself changed.
        const changed = prev.bodyUpdatedAt && prev.bodyUpdatedAt !== m.updatedAt;
        if (!changed) {
          merged.text = prev.text;
          merged.html = prev.html;
          merged.attachments = prev.attachments;
        }
      }
      return merged;
    });

    const known = box.knownIds || (box.knownIds = new Set());
    const isFirstSync = known.size === 0 && box.messages.length === 0;
    const newMessages = list.filter((m) => !known.has(m.id));

    list.forEach((m) => known.add(m.id));
    box.messages = list;
    box.unread = list.filter((m) => !m.seen).length;
    // Remember how long this inbox has been empty. The provider delivers the
    // first mail to a brand-new address slowly (seconds to a few minutes), so
    // after a while we stop trusting the server cache and ask the provider
    // directly.
    box.emptySince = list.length ? 0 : (box.emptySince || Date.now());

    if (announce && !isFirstSync && newMessages.length) {
      toast(`${newMessages.length} new mail${newMessages.length > 1 ? 's' : ''} received`, 'ok');
      beep();
    }
    return fresh;
  }

  async function openMessage(id) {
    const box = activeBox();
    if (!box) return;
    state.selectedId = id;
    lastReaderSig = null;
    save();
    renderList();
    const m = box.messages.find((x) => x.id === id);
    if (m) {
      m.seen = true;
      box.unread = box.messages.filter((x) => !x.seen).length;
    }
    renderReader(m);

    try {
      let full;
      const isGmail = box.provider === 'gmail';
      const detailUrl = isGmail ? '/gmail/messages/' + id : '/messages/' + id;
      const detailToken = isGmail ? (box.gmailToken || state.gmail.token) : box.token;
      try {
        full = await api(detailUrl, { token: detailToken });
      } catch (err) {
        // The token may have expired since the list was loaded — renew and retry once
        // so the reader never gets stuck on the preview line.
        if (!isGmail && (err.status === 401 || err.status === 404) && box.password) {
          const fresh = await refreshToken(box);
          if (!fresh) throw err;
          full = await api(detailUrl, { token: box.token });
        } else {
          throw err;
        }
      }
      const detail = normalizeMessage(full);
      const idx = box.messages.findIndex((x) => x.id === id);
      if (idx >= 0) {
        // Remember the list's version stamp so the next poll can tell whether
        // this body is still current.
        const prev = box.messages[idx];
        const stamped = prev.updatedAt || detail.updatedAt;
        const merged = { ...prev, ...detail, seen: true, bodyUpdatedAt: stamped };
        // A detail payload that only carries the body must never wipe the
        // sender, subject or intro that the list already knows.
        if (!detail.from || detail.from === 'unknown') merged.from = prev.from;
        if (!detail.fromName) merged.fromName = prev.fromName;
        if (!detail.subject || detail.subject === '(no subject)') merged.subject = prev.subject;
        if (!detail.intro) merged.intro = prev.intro;
        if (!detail.to) merged.to = prev.to;
        if (!detail.createdAt) merged.createdAt = prev.createdAt;
        if (!detail.updatedAt) merged.updatedAt = prev.updatedAt;
        box.messages[idx] = merged;
      }
      // Fall back to the freshly fetched detail if the list does not know
      // this message (yet) — the reader should never stay blank.
      renderReader(idx >= 0 ? box.messages[idx] : detail);
      renderList();
    } catch (err) {
      console.warn('Could not load message body:', err);
      toast('Could not load message: ' + err.message, 'err');
    }
  }

  /* ── box lifecycle ───────────────────────────────────────── */
  async function loadDomains() {
    try {
      const data = await api('/domains?page=1');
      const list = (data['hydra:member'] || []).map((d) => d.domain).filter(Boolean);
      state.domains = list;
      if (!state.domain || !list.includes(state.domain)) state.domain = list[0] || null;
      const sel = $('domainSelect');
      sel.innerHTML = '';
      list.forEach((d) => {
        const o = document.createElement('option');
        o.value = d; o.textContent = '@' + d;
        sel.appendChild(o);
      });
      if (state.domain) sel.value = state.domain;
      setStatus('ok');
    } catch (err) {
      setStatus('bad');
      toast('Cannot load domains: ' + err.message, 'err');
    }
  }

  /* ── Gmail mode ───────────────────────────────────────────── */
  /**
   * Mint a real @gmail.com address off the connected Gmail account.
   * An empty tag uses the account address itself; a tag creates an alias
   * with Gmail's plus-addressing rule (you+shop@gmail.com).
   */
  function gmailAliasFor(tag) {
    const user = (state.gmail.user || '').toLowerCase();
    const base = user.split('@')[0];
    const domain = state.gmail.domain || user.split('@')[1] || 'gmail.com';
    if (!base) return '';
    const clean = String(tag || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!clean) return base + '@' + domain;
    // Gmail caps the local part at 64 characters.
    const room = Math.max(1, 64 - base.length - 1);
    return `${base}+${clean.slice(0, room)}@${domain}`;
  }

  async function createGmailBox(tag) {
    if (!state.gmail.token) throw new Error('Connect your Gmail account first');
    const address = gmailAliasFor(tag);
    if (!address) throw new Error('Gmail is not connected');
    const box = {
      id: 'gmail:' + address,
      address,
      provider: 'gmail',
      gmailToken: state.gmail.token,
      password: null,
      token: null,
      createdAt: Date.now(),
      messages: [],
      knownIds: new Set(),
      unread: 0,
    };
    state.boxes.unshift(box);
    state.activeId = box.id;
    state.selectedId = null;
    save();
    await pull(box, { announce: false });
    renderAll();
    toast('New address ready: ' + address, 'ok');
    return box;
  }

  async function connectGmail(user, password) {
    const res = await api('/gmail/login', { method: 'POST', body: { user, password } });
    state.gmail.token = res.token;
    state.gmail.user = res.user;
    state.gmail.domain = res.domain || 'gmail.com';
    save();
    // Keep the app password in sessionStorage only (gone when the tab closes)
    // so a server restart can be recovered without asking again.
    try { sessionStorage.setItem('tmpmail.gmailPass', password); } catch (_) { /* ignore */ }
    renderSource();
    return res;
  }

  /**
   * Is the server still holding our Gmail session? Re-login if not.
   *
   * A saved token is only a shortcut: the stored app password can always mint
   * a fresh one, even when the token itself was already dropped.
   */
  async function restoreGmailSession() {
    if (state.gmail.token) {
      try {
        const res = await api('/gmail/session', { token: state.gmail.token });
        if (res && res.ok) return true;
      } catch (_) { /* server not reachable right now */ }
    }
    let pass = '';
    try { pass = sessionStorage.getItem('tmpmail.gmailPass') || ''; } catch (_) { /* ignore */ }
    if (pass && state.gmail.user) {
      try {
        const again = await api('/gmail/login', {
          method: 'POST', body: { user: state.gmail.user, password: pass },
        });
        state.gmail.token = again.token;
        state.gmail.user = again.user;
        state.gmail.domain = again.domain;
        save();
        return true;
      } catch (_) { /* fall through */ }
    }
    if (state.gmail.token) {
      state.gmail.token = '';
      save();
    }
    return false;
  }

  /**
   * Forget the connected Gmail account: drop the server session, the app
   * password and every alias minted off it, so another account can be used.
   */
  async function disconnectGmail() {
    const token = state.gmail.token;
    if (token) {
      try { await api('/gmail/logout', { method: 'POST', token }); } catch (_) { /* already gone */ }
    }
    state.gmail = { token: '', user: '', domain: '', forceClear: true };
    state.boxes.filter((b) => b.provider === 'gmail').forEach((b) => state.deleted.add(b.id));
    state.boxes = state.boxes.filter((b) => b.provider !== 'gmail');
    if (!state.boxes.some((b) => b.id === state.activeId)) {
      state.activeId = state.boxes.length ? state.boxes[0].id : null;
    }
    state.selectedId = null;
    try { sessionStorage.removeItem('tmpmail.gmailPass'); } catch (_) { /* ignore */ }
    save();
    renderSource();
    renderAll();
    toast('Gmail disconnected', 'ok');
  }

  function renderSource() {
    const gmail = state.source === 'gmail';
    $('sourceSeg').querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.source === state.source);
    });
    const connected = gmail && !!state.gmail.token;
    $('gmailPanel').hidden = !gmail || connected;
    $('domainField').hidden = gmail;
    $('showAsField').hidden = gmail;
    $('copyShownBtn').hidden = gmail;
    $('sourceNote').textContent = gmail
      ? (connected
        ? 'Connected as ' + state.gmail.user + ' — every address below is a real @gmail.com one.'
        : 'Connect one Gmail account to mint real @gmail.com addresses.')
      : 'Fast, free, anonymous — but disposable domains get rejected by some sites.';
    $('localInput').placeholder = gmail ? 'alias tag (optional)' : 'random';
    $('newAddrBtn').disabled = gmail && !connected;
    $('gmailDisconnectBtn').hidden = !connected;
    if (gmail && state.gmail.user) $('gmailUser').value = state.gmail.user;
  }

  async function setSource(src) {
    state.source = src === 'gmail' ? 'gmail' : 'mailtm';
    save();
    renderSource();
    if (state.source === 'gmail') {
      await restoreGmailSession();
      renderSource();
      if (state.gmail.token && !state.boxes.some((b) => b.provider === 'gmail')) {
        try { await createBox($('localInput').value); } catch (err) { toast(err.message, 'err'); }
      }
    } else {
      loadDomains();
      if (!state.boxes.length) {
        try { await createBox(genLocalPart(), state.domain); } catch (err) { toast(err.message, 'err'); }
      }
    }
    renderAll();
  }

  async function createBox(localPart, domain) {
    if (state.source === 'gmail') return createGmailBox(localPart);
    const name = sanitizeLocal(localPart) || genLocalPart();
    const dom = domain || state.domain || state.domains[0];
    if (!dom) throw new Error('No mail domain available');

    const address = `${name}@${dom}`;
    const password = genPassword();

    const created = await api('/accounts', { method: 'POST', body: { address, password } });
    let token = created.token;
    if (!token) {
      const t = await api('/token', { method: 'POST', body: { address, password } });
      token = t.token;
    }

    const box = {
      id: created.id || address,
      address,
      password,
      token,
      createdAt: Date.now(),
      messages: [],
      knownIds: new Set(),
      unread: 0,
    };
    state.boxes.unshift(box);
    state.activeId = box.id;
    state.selectedId = null;
    save();
    await pull(box, { announce: false });
    renderAll();
    toast('New address ready: ' + address, 'ok');
    return box;
  }

  async function importBox(address, password) {
    const addr = (address || '').trim().toLowerCase();
    if (!addr.includes('@')) throw new Error('Enter a full email address');
    const t = await api('/token', { method: 'POST', body: { address: addr, password } });
    if (!t.token) throw new Error('Could not get a token for that inbox');

    const existing = state.boxes.find((b) => b.address === addr);
    if (existing) {
      existing.token = t.token;
      existing.password = password;
      state.activeId = existing.id;
    } else {
      const box = {
        id: addr,
        address: addr,
        password,
        token: t.token,
        createdAt: Date.now(),
        messages: [],
        knownIds: new Set(),
        unread: 0,
      };
      state.boxes.unshift(box);
      state.activeId = box.id;
    }
    state.selectedId = null;
    save();
    await pull(activeBox(), { announce: false });
    renderAll();
    toast('Inbox imported: ' + addr, 'ok');
  }

  async function deleteBox(box) {
    if (!box) return;
    try {
      await api(`/accounts/${box.id}`, { method: 'DELETE', token: box.token });
    } catch (_) { /* best effort */ }
    state.boxes = state.boxes.filter((b) => b.id !== box.id);
    state.deleted.add(box.id);
    if (state.activeId === box.id) {
      state.activeId = state.boxes[0] ? state.boxes[0].id : null;
      state.selectedId = null;
    }
    save();
    renderAll();
  }

  async function deleteMessage(id) {
    const box = activeBox();
    if (!box) return;
    try {
      await api(`/messages/${id}`, { method: 'DELETE', token: box.token });
    } catch (_) { /* best effort */ }
    box.knownIds.delete(id);
    box.messages = box.messages.filter((m) => m.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    lastListSig = null;
    lastReaderSig = null;
    save();
    renderAll();
    toast('Message deleted');
  }

  /* ── rendering ───────────────────────────────────────────── */
  /** The address as it is *shown* to the user (may be a look-alike domain). */
  function displayAddress(box) {
    if (!box) return '';
    // A Gmail alias is already a real @gmail.com address — there is nothing
    // to disguise and nothing to "unmask".
    if (box.provider === 'gmail') return box.address;
    const local = box.address.split('@')[0];
    const domain = state.displayAs === 'real'
      ? box.address.split('@')[1]
      : state.displayAs;
    return `${local}@${domain}`;
  }

  function renderAddress() {
    const box = activeBox();
    const shown = displayAddress(box);
    $('addrText').textContent = shown || 'no active inbox';

    // Always keep the routable address visible when the display differs from it.
    const real = box ? box.address : '';
    if (box && box.provider === 'gmail') {
      $('addrReal').textContent = `real @gmail.com — delivered to ${state.gmail.user || 'your Gmail'}`;
    } else {
      $('addrReal').textContent = (box && shown !== real) ? `delivers to ${real}` : '';
    }

    const pill = $('expiryPill');
    if (box) {
      const mins = Math.floor((Date.now() - box.createdAt) / 60000);
      // Keep the age readable once it passes an hour / a day.
      pill.textContent = mins < 1 ? 'active'
        : mins < 60 ? `active · ${mins}m`
        : mins < 1440 ? `active · ${Math.floor(mins / 60)}h`
        : `active · ${Math.floor(mins / 1440)}d`;
    } else {
      pill.textContent = 'idle';
    }
  }

  function renderSidebar() {
    const list = $('boxList');
    const sig = state.activeId + '|' + state.boxes.map((b) => `${b.id}:${b.unread}:${b.address}`).join('|');
    if (sig === lastBoxSig) return;
    lastBoxSig = sig;

    list.innerHTML = '';
    if (!state.boxes.length) {
      list.innerHTML = '<li class="empty">No inboxes yet.<br>Create one to get started.</li>';
      return;
    }
    state.boxes.forEach((box) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'box-item' + (box.id === state.activeId ? ' active' : '');
      const local = box.address.split('@')[0];
      btn.innerHTML =
        `<span class="box-avatar">${escapeHtml(local[0].toUpperCase())}</span>` +
        `<span class="box-meta"><span class="box-name">${escapeHtml(local)}</span>` +
        `<span class="box-sub">@${escapeHtml(box.address.split('@')[1] || '')}</span></span>` +
        (box.unread ? `<span class="badge">${box.unread}</span>` : '');
      btn.addEventListener('click', async () => {
        state.activeId = box.id;
        state.selectedId = null;
        lastListSig = null;
        lastReaderSig = null;
        renderAll();
        try { await pull(box, { announce: false }); renderAll(); } catch (_) {}
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  function renderList() {
    const list = $('msgList');
    const box = activeBox();
    const q = $('searchInput').value.trim().toLowerCase();

    if (!box) {
      list.innerHTML = '<li class="empty">Create an address to start receiving mail.</li>';
      $('msgCount').textContent = '0';
      lastListSig = null;
      return;
    }

    const items = box.messages.filter((m) =>
      !q || (m.subject + ' ' + m.from + ' ' + m.intro).toLowerCase().includes(q)
    );
    $('msgCount').textContent = String(items.length);

    // Skip the DOM rebuild when nothing changed — polling runs every 3s and a
    // rebuild would reset the reader scroll and reload the HTML iframe.
    const throttled = state.backoffUntil > Date.now();
    const errStatus = state.lastError ? state.lastError.status : '';
    // The waiting message counts up, so it has to be part of the signature —
    // otherwise the DOM is never rebuilt and the counter stays frozen.
    const waited = box.emptySince ? Math.floor((Date.now() - box.emptySince) / 10000) : 0;
    const checkBucket = state.lastCheckAt ? Math.floor((Date.now() - state.lastCheckAt) / 10000) : 0;
    const sig = q + '|' + (throttled ? 'rl' : '') + '|' + errStatus + '|' + waited + '|' + checkBucket + '|' +
      items.map((m) => `${m.id}:${m.seen}:${m.subject}:${m.from}`).join('|');
    if (sig === lastListSig) return;
    lastListSig = sig;
    list.innerHTML = '';

    if (!items.length) {
      const wait = Math.max(1, Math.ceil((state.backoffUntil - Date.now()) / 1000));
      // While the provider is throttling us the inbox looks empty even though
      // the mail may already have arrived — say so instead of looking broken.
      let note;
      if (throttled) {
        note = `Mail service is rate limiting us — retrying in ${wait}s…`;
      } else if (state.lastError) {
        const why = state.lastError.status
          ? `HTTP ${state.lastError.status}`
          : 'no connection';
        const ago = state.lastCheckAt ? Math.round((Date.now() - state.lastCheckAt) / 1000) : 0;
        note = `Cannot reach the mail service (${why}). Last check ${ago}s ago — retrying automatically…`;
      } else if (box.messages.length) {
        note = 'No mail matches your search.';
      } else {
        // The first mail to a brand-new address regularly takes a minute or
        // two to arrive, so say that instead of leaving a silent empty list.
        const secs = box.emptySince ? Math.round((Date.now() - box.emptySince) / 1000) : 0;
        note = secs < 20
          ? 'Waiting for the first message…'
          : `Waiting for the first message… (${secs}s so far — the first mail to a new address can take 1–3 minutes)`;
      }
      list.innerHTML = `<li class="empty"><span class="spinner"></span><span>${note}</span></li>`;
      return;
    }

    items.forEach((m) => {
      const li = document.createElement('li');
      li.className = 'msg-item' + (m.seen ? ' read' : '') + (m.id === state.selectedId ? ' active' : '');
      li.dataset.id = m.id;
      li.innerHTML =
        `<div class="msg-row"><span class="unread-dot"></span>` +
        `<span class="msg-from">${escapeHtml(m.fromName || m.from)}</span>` +
        `<span class="msg-time">${escapeHtml(fmtTime(m.createdAt))}</span></div>` +
        `<div class="msg-subject">${escapeHtml(m.subject)}</div>` +
        `<div class="msg-intro">${escapeHtml(m.intro)}</div>`;
      li.addEventListener('click', () => openMessage(m.id));
      list.appendChild(li);
    });
  }

  function extractCode(text) {
    if (!text) return null;
    const six = text.match(/\b(\d{6})\b/);
    if (six) return six[1];
    const near = text.match(/(?:code|otp|pin|verification)\D{0,12}\b([A-Z0-9]{6,8})\b/i);
    if (near) return near[1];
    const digits = text.match(/\b(\d{4,8})\b/);
    if (digits) return digits[1];
    return null;
  }

  function sanitizeHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta,base').forEach((n) => n.remove());
      doc.querySelectorAll('*').forEach((el) => {
        Array.from(el.attributes).forEach((a) => {
          const name = a.name.toLowerCase();
          const val = (a.value || '').toLowerCase().trim();
          if (name.startsWith('on')) el.removeAttribute(a.name);
          if ((name === 'href' || name === 'src') && val.startsWith('javascript:')) el.removeAttribute(a.name);
        });
      });
      return doc.body.innerHTML;
    } catch (_) {
      return escapeHtml(html);
    }
  }

  function renderReader(m) {
    const empty = $('readerEmpty');
    const body = $('readerBody');
    if (!m) {
      empty.hidden = false;
      body.hidden = true;
      lastReaderSig = null;
      return;
    }

    // Re-render only when the shown message actually changed.
    const sig = `${m.id}:${state.htmlView}:${(m.text || '').length}:${(m.html && m.html[0] || '').length}`;
    if (sig === lastReaderSig && !body.hidden) return;
    lastReaderSig = sig;

    empty.hidden = true;
    body.hidden = false;

    $('mSubject').textContent = m.subject || '(no subject)';
    const name = m.fromName || m.from;
    $('mFrom').textContent = name + (m.fromName && m.from ? ` <${m.from}>` : '');
    $('mTo').textContent = m.to ? `to ${m.to}` : '';
    $('mDate').textContent = fmtDate(m.createdAt);
    $('mAvatar').textContent = (name || '?').trim()[0].toUpperCase();

    const attach = $('mAttach');
    if (m.attachments && m.attachments.length) {
      attach.hidden = false;
      attach.innerHTML = m.attachments
        .map((a) => `<span class="attach-chip">📎 ${escapeHtml(a.filename || a.name || 'attachment')}</span>`)
        .join('');
    } else {
      attach.hidden = true;
      attach.innerHTML = '';
    }

    const html = (m.html && m.html[0]) || '';
    const text = m.text || '';
    const target = $('mBody');
    target.innerHTML = '';

    const code = extractCode(text) || extractCode(stripTags(html));
    if (code) {
      const chip = document.createElement('div');
      chip.className = 'code-chip';
      chip.textContent = code;
      chip.title = 'Click to copy';
      chip.addEventListener('click', async () => {
        if (await copyText(code)) toast('Code copied: ' + code, 'ok');
      });
      target.appendChild(chip);
      target.appendChild(document.createElement('br'));
    }

    if (state.htmlView && html) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
      frame.setAttribute('srcdoc', `<html><body style="margin:0;font-family:system-ui,sans-serif;font-size:14px;color:#111;">${sanitizeHtml(html)}</body></html>`);
      target.appendChild(frame);
    } else if (text.trim()) {
      const pre = document.createElement('pre');
      pre.textContent = text;
      target.appendChild(pre);
    } else if (html) {
      const div = document.createElement('div');
      div.innerHTML = sanitizeHtml(html);
      target.appendChild(div);
    } else if (m.intro) {
      // The provider sometimes has no body part for a message — fall back to the
      // preview line instead of showing nothing at all.
      const pre = document.createElement('pre');
      pre.textContent = m.intro;
      target.appendChild(pre);
    } else {
      target.innerHTML = '<p style="color:var(--txt-faint)">This message has no readable body.</p>';
    }
  }

  function stripTags(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent || '').trim();
  }

  function renderAll() {
    renderAddress();
    renderSidebar();
    renderList();
    const box = activeBox();
    const m = box ? box.messages.find((x) => x.id === state.selectedId) : null;
    renderReader(m || null);
  }

  /* ── polling ─────────────────────────────────────────────── */
  async function tick() {
    if (!state.auto || state.busy || document.hidden) return;
    // The provider throttles bursts (HTTP 429). Stay quiet for a while instead
    // of hammering it every 3 seconds.
    if (Date.now() < state.backoffUntil) return;
    state.busy = true;
    try {
      if (!state.boxes.length) {
        // The provider may have been unreachable when the page loaded — try
        // again instead of leaving the app empty forever.
        // (In Gmail mode the user has to connect their account first.)
        if (state.source !== 'gmail') {
          await createBox(genLocalPart(), state.domain);
        }
        return;
      }
      const box = activeBox();
      if (box) {
        const forceFresh = state.forceFresh;
        state.forceFresh = false;
        // An inbox that has been empty for a while may be hiding a message
        // behind the server cache — ask the provider directly.
        const staleEmpty = box.emptySince && (Date.now() - box.emptySince) > EMPTY_FORCE_FRESH_MS;
        await pull(box, { fresh: forceFresh || staleEmpty });
        state.lastError = null;
        state.consec429 = 0;
        state.lastCheckAt = Date.now();
        renderAll();
        setStatus('ok');
        // Keep the open message loaded (also re-opens it after a reload or in
        // a second tab that shares the same inbox).
        const sel = box.messages.find((x) => x.id === state.selectedId);
        if (sel && !sel.text && !detailAttempted.has(sel.id)) {
          detailAttempted.add(sel.id);
          openMessage(state.selectedId);
        }
      }
      state.tickCount++;
      if (state.tickCount % IDLE_POLL_EVERY === 0) {
        for (const b of state.boxes) {
          if (b.id === state.activeId) continue;
          try { await pull(b, { announce: false }); } catch (_) {}
        }
        renderSidebar();
      }
    } catch (err) {
      state.lastCheckAt = Date.now();
      if (err && err.status === 429) {
        // Provider is throttling us — back off instead of retrying every 3s.
        // Repeated throttles mean we are on a shared, heavily used IP, so the
        // pause grows instead of hammering the same limit.
        state.consec429++;
        const wait = Math.min(MAX_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * state.consec429);
        state.backoffUntil = Date.now() + wait;
        setStatus('busy');
        // Re-render so the inbox says what is going on instead of looking
        // empty while the mail is actually sitting in the provider.
        renderList();
        toast('Mail service is rate limiting us — retrying shortly', 'err');
      } else {
        // A blocked or unreachable provider is just as confusing as an empty
        // inbox, so say it in the inbox itself.
        state.lastError = {
          status: (err && err.status) || 0,
          message: (err && err.message) || 'service unreachable',
        };
        setStatus('bad');
        renderList();
      }
    } finally {
      state.busy = false;
    }
  }

  /* ── events ──────────────────────────────────────────────── */
  function bind() {
    $('sourceSeg').addEventListener('click', (e) => {
      const btn = e.target.closest ? e.target.closest('.seg-btn') : null;
      if (!btn || btn.dataset.source === state.source) return;
      setSource(btn.dataset.source);
    });

    $('gmailPanel').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('gmailConnectBtn');
      const user = $('gmailUser').value.trim();
      const pass = $('gmailPass').value.replace(/\s+/g, '');
      if (!user || !pass) {
        toast('Enter your Gmail address and the app password', 'err');
        return;
      }
      btn.disabled = true;
      try {
        await connectGmail(user, pass);
        $('gmailPass').value = '';
        toast('Gmail connected: ' + state.gmail.user, 'ok');
        if (!state.boxes.some((b) => b.provider === 'gmail')) {
          await createBox($('localInput').value);
        }
      } catch (err) {
        const hint = err.hint ? ' — ' + err.hint : '';
        toast('Cannot connect Gmail: ' + err.message + hint, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('gmailDisconnectBtn').addEventListener('click', async () => {
      await disconnectGmail();
    });

    $('copyBtn').addEventListener('click', async () => {
      const box = activeBox();
      if (!box) return;
      const btn = $('copyBtn');
      if (await copyText(box.address)) {
        btn.classList.add('done');
        btn.querySelector('span').textContent = 'Copied';
        setTimeout(() => { btn.classList.remove('done'); btn.querySelector('span').textContent = 'Copy'; }, 1600);
        toast('Copied real address: ' + box.address, 'ok');
      }
    });

    $('copyShownBtn').addEventListener('click', async () => {
      const box = activeBox();
      if (!box) return;
      const shown = displayAddress(box);
      const btn = $('copyShownBtn');
      if (await copyText(shown)) {
        btn.classList.add('done');
        setTimeout(() => btn.classList.remove('done'), 1600);
        if (shown !== box.address) {
          // This button copies the look, not a working address — say so loudly
          // so nobody waits for mail that can never arrive.
          toast('Copied the look only — mail does NOT arrive here. Real inbox: ' + box.address, 'err');
        } else {
          toast('Copied: ' + shown, 'ok');
        }
      }
    });

    $('displaySelect').addEventListener('change', (e) => {
      state.displayAs = e.target.value;
      save();
      renderAddress();
    });

    $('addrText').addEventListener('click', () => $('copyBtn').click());

    $('newAddrBtn').addEventListener('click', async () => {
      const btn = $('newAddrBtn');
      btn.disabled = true;
      try {
        await createBox($('localInput').value, $('domainSelect').value);
        $('localInput').value = '';
      } catch (err) {
        toast('Could not create address: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('addBoxBtn').addEventListener('click', async () => {
      try { await createBox(genLocalPart(), state.domain); } catch (err) { toast(err.message, 'err'); }
    });

    $('importBtn').addEventListener('click', () => {
      const form = $('importForm');
      form.hidden = !form.hidden;
      if (!form.hidden) $('importAddr').focus();
    });

    $('importCancel').addEventListener('click', () => { $('importForm').hidden = true; });

    $('importForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('importSubmit');
      btn.disabled = true;
      try {
        await importBox($('importAddr').value, $('importPass').value);
        $('importForm').hidden = true;
        $('importAddr').value = '';
        $('importPass').value = '';
      } catch (err) {
        toast('Import failed: ' + err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    $('delBoxBtn').addEventListener('click', async () => {
      const box = activeBox();
      if (!box) return;
      if (!confirm('Delete this inbox and its messages?\n\n' + box.address)) return;
      await deleteBox(box);
      toast('Inbox deleted');
    });

    $('delMsgBtn').addEventListener('click', () => {
      if (state.selectedId) deleteMessage(state.selectedId);
    });

    $('htmlToggle').addEventListener('click', () => {
      state.htmlView = !state.htmlView;
      $('htmlToggle').textContent = state.htmlView ? 'Plain view' : 'HTML view';
      const box = activeBox();
      const m = box && box.messages.find((x) => x.id === state.selectedId);
      if (m) renderReader(m);
    });

    $('refreshBtn').addEventListener('click', () => { state.forceFresh = true; tick(); });
    // Another tab of this app can open a message — follow along.
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY || !e.newValue) return;
      try {
        const data = JSON.parse(e.newValue);
        if (data.selectedId && data.selectedId !== state.selectedId) {
          state.selectedId = data.selectedId;
          lastReaderSig = null;
          renderAll();
          detailAttempted.delete(data.selectedId);
          openMessage(data.selectedId);
        }
      } catch (_) {}
    });
    $('searchInput').addEventListener('input', renderList);
    $('backBtn').addEventListener('click', () => {
      state.selectedId = null;
      renderAll();
    });

    $('autoToggle').addEventListener('change', (e) => {
      state.auto = e.target.checked;
      save();
      $('nextPoll').textContent = state.auto ? 'every 3s' : 'paused';
    });

    $('soundToggle').addEventListener('click', () => {
      state.sound = !state.sound;
      $('soundToggle').setAttribute('aria-pressed', String(state.sound));
      save();
      toast(state.sound ? 'New-mail sound on' : 'New-mail sound off');
    });

    $('themeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem('tmpmail.theme', next); } catch (_) {}
    });

    $('domainSelect').addEventListener('change', (e) => {
      state.domain = e.target.value;
      save();
    });

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); $('searchInput').focus(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c') { e.preventDefault(); $('copyBtn').click(); }
      else if (e.key === 'n') { e.preventDefault(); $('newAddrBtn').click(); }
      else if (e.key === 'r') { e.preventDefault(); state.forceFresh = true; tick(); }
      else if (e.key === 'Escape') { state.selectedId = null; renderAll(); }
    });
  }

  /* ── boot ────────────────────────────────────────────────── */
  async function boot() {
    try {
      const theme = localStorage.getItem('tmpmail.theme');
      if (theme) document.documentElement.dataset.theme = theme;
    } catch (_) {}

    load();
    $('autoToggle').checked = state.auto;
    $('displaySelect').value = state.displayAs;
    $('soundToggle').setAttribute('aria-pressed', String(state.sound));
    $('nextPoll').textContent = state.auto ? 'every 3s' : 'paused';

    bind();
    renderSource();
    await loadDomains();

    if (state.source === 'gmail') {
      // The Gmail session lives in the server's memory, so a restart means
      // reconnecting — try the stored app password first.
      await restoreGmailSession();
      renderSource();
      renderAll();
      if (state.gmail.token && !state.boxes.length) {
        try {
          await createBox($('localInput').value);
        } catch (err) {
          toast('Setup failed: ' + err.message, 'err');
        }
      } else if (!state.boxes.length) {
        $('addrText').textContent = 'connect your Gmail';
        $('addrReal').textContent = 'then every address is a real @gmail.com one';
      }
    } else if (!state.boxes.length) {
      try {
        await createBox(genLocalPart(), state.domain);
      } catch (err) {
        toast('Setup failed: ' + err.message, 'err');
        $('addrText').textContent = 'service unavailable';
        $('addrReal').textContent = 'press r or reload to retry';
      }
    } else {
      renderAll();
      for (const b of state.boxes) {
        try {
          await pull(b, { announce: false });
        } catch (err) {
          if (err.status === 401 || err.status === 404) {
            state.boxes = state.boxes.filter((x) => x.id !== b.id);
            save();
            toast('Inbox ' + b.address + ' expired and was removed', 'err');
          } else {
            // Say what went wrong instead of showing a silent empty inbox.
            state.lastError = {
              status: (err && err.status) || 0,
              message: (err && err.message) || 'service unreachable',
            };
            state.lastCheckAt = Date.now();
          }
        }
      }
      renderAll();
    }

    setInterval(tick, POLL_MS);
    setInterval(renderAddress, 30000);
  }

  boot();
})();
