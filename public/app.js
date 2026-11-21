/* TempBox — temporary email web client
 * Talks to /api/* (same-origin proxy) so the provider's CORS policy never
 * blocks the browser.
 */
(() => {
  'use strict';

  const STORE_KEY = 'tmpmail.state.v1';
  const POLL_MS = 3000;
  const IDLE_POLL_EVERY = 5; // poll other inboxes every Nth tick
  const RATE_LIMIT_BACKOFF_MS = 30000; // pause polling after an HTTP 429

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
  };

  // Signatures of what is currently rendered, so the 3s poll does not rebuild
  // the DOM (and reset reader scroll / reload the HTML iframe) needlessly.
  let lastListSig = null;
  let lastReaderSig = null;
  let lastBoxSig = null;
  const detailAttempted = new Set();

  /* ── storage ─────────────────────────────────────────────── */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        boxes: state.boxes.map((b) => ({
          id: b.id, address: b.address, password: b.password, token: b.token,
          createdAt: b.createdAt, knownIds: Array.from(b.knownIds || []),
        })),
        activeId: state.activeId,
        selectedId: state.selectedId,
        domain: state.domain,
        displayAs: state.displayAs,
        auto: state.auto,
        sound: state.sound,
      }));
    } catch (_) { /* storage may be unavailable */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state.boxes = (data.boxes || []).map((b) => ({
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
    } catch (_) { /* ignore corrupt state */ }
  }

  /* ── api ─────────────────────────────────────────────────── */
  const API_TIMEOUT_MS = 15000;

  async function api(path, opts = {}) {
    const { method = 'GET', body = null, token = null } = opts;
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;

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

  async function pull(box, { announce = true } = {}) {
    let data;
    try {
      data = await api('/messages?page=1', { token: box.token });
    } catch (err) {
      // Token expired or was invalidated -> refresh it with the stored password, retry once.
      if ((err.status === 401 || err.status === 404) && box.password) {
        const fresh = await refreshToken(box);
        if (!fresh) throw err;
        data = await api('/messages?page=1', { token: box.token });
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
    const fresh = list.filter((m) => !known.has(m.id));

    list.forEach((m) => known.add(m.id));
    box.messages = list;
    box.unread = list.filter((m) => !m.seen).length;

    if (announce && !isFirstSync && fresh.length) {
      toast(`${fresh.length} new mail${fresh.length > 1 ? 's' : ''} received`, 'ok');
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
      try {
        full = await api(`/messages/${id}`, { token: box.token });
      } catch (err) {
        // The token may have expired since the list was loaded — renew and retry once
        // so the reader never gets stuck on the preview line.
        if ((err.status === 401 || err.status === 404) && box.password) {
          const fresh = await refreshToken(box);
          if (!fresh) throw err;
          full = await api(`/messages/${id}`, { token: box.token });
        } else {
          throw err;
        }
      }
      const detail = normalizeMessage(full);
      const idx = box.messages.findIndex((x) => x.id === id);
      if (idx >= 0) {
        // Remember the list's version stamp so the next poll can tell whether
        // this body is still current.
        const stamped = box.messages[idx].updatedAt || detail.updatedAt;
        box.messages[idx] = { ...box.messages[idx], ...detail, seen: true, bodyUpdatedAt: stamped };
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

  async function createBox(localPart, domain) {
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
    $('addrReal').textContent = (box && shown !== real) ? `delivers to ${real}` : '';

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
    const sig = q + '|' + items.map((m) => `${m.id}:${m.seen}:${m.subject}:${m.from}`).join('|');
    if (sig === lastListSig) return;
    lastListSig = sig;
    list.innerHTML = '';

    if (!items.length) {
      list.innerHTML = `<li class="empty"><span class="spinner"></span><span>${
        box.messages.length ? 'No mail matches your search.' : 'Waiting for the first message…'
      }</span></li>`;
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
        await createBox(genLocalPart(), state.domain);
        return;
      }
      const box = activeBox();
      if (box) {
        await pull(box);
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
      if (err && err.status === 429) {
        // Provider is throttling us — back off instead of retrying every 3s.
        state.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        setStatus('busy');
        toast('Mail service is rate limiting us — retrying shortly', 'err');
      } else {
        setStatus('bad');
      }
    } finally {
      state.busy = false;
    }
  }

  /* ── events ──────────────────────────────────────────────── */
  function bind() {
    $('copyBtn').addEventListener('click', async () => {
      const box = activeBox();
      if (!box) return;
      const btn = $('copyBtn');
      if (await copyText(box.address)) {
        btn.classList.add('done');
        btn.querySelector('span').textContent = 'Copied';
        setTimeout(() => { btn.classList.remove('done'); btn.querySelector('span').textContent = 'Copy'; }, 1600);
        toast('Copied: ' + box.address, 'ok');
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
          toast('Copied: ' + shown + ' — note: mail is delivered to ' + box.address, '');
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

    $('refreshBtn').addEventListener('click', () => tick());
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
      else if (e.key === 'r') { e.preventDefault(); tick(); }
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
    await loadDomains();

    if (!state.boxes.length) {
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
