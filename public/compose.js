'use strict';

// Writing to chat: Kick login (official OAuth, in a popup so the video keeps playing), message box, emote picker
// with a "frequently used" set that is remembered in this browser.
const Compose = (() => {
  const QUICK_COUNT = 9;
  let authState = { configured: false, loggedIn: false, user: null, redirectUri: '' };
  let getTarget = () => null; // () => { slug, userId }
  let emoteSets = null; // [{ name, emotes: [{ id, name, subOnly }] }] for the current channel
  let emoteSlug = null;
  let emoteByName = new Map();
  let sending = false;

  const $ = (id) => document.getElementById(id);

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-kick-player': '1', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code });
    return data;
  }

  function note(text, kind = 'muted') {
    const el = $('composeMsg');
    el.textContent = text || '';
    el.className = `compose-msg ${kind}`;
  }

  // ---------------------------------------------------------------- frequently used (localStorage)

  function loadUsage() {
    try {
      return JSON.parse(localStorage.getItem('emoteUsage') || '{}');
    } catch {
      return {};
    }
  }

  /** Count every [emote:ID:NAME] in a sent message. */
  function recordUsage(content) {
    const usage = loadUsage();
    for (const m of content.matchAll(/\[emote:(\d+):([^\]]*)\]/g)) {
      const u = (usage[m[1]] ||= { id: Number(m[1]), name: m[2], count: 0, last: 0 });
      u.count++;
      u.last = Date.now();
    }
    try {
      localStorage.setItem('emoteUsage', JSON.stringify(usage));
    } catch {}
  }

  /** Most used first, with recent use breaking ties (a use today counts a bit more than one last month). */
  function frequent(limit = 40) {
    const now = Date.now();
    return Object.values(loadUsage())
      .map((u) => ({ ...u, score: u.count + Math.max(0, 7 - (now - u.last) / 86400000) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ id, name }) => ({ id, name, subOnly: false }));
  }

  // ---------------------------------------------------------------- auth

  async function refreshAuth() {
    try {
      authState = await (await fetch('/api/auth/status')).json();
    } catch {}
    render();
  }

  function render() {
    const { loggedIn, user } = authState;
    const input = $('composeInput');
    input.disabled = !loggedIn;
    input.placeholder = loggedIn ? 'Мессеж бичих…' : 'Бичихийн тулд Kick-ээр нэвтэрнэ үү';
    $('composeSend').textContent = loggedIn ? 'Чат' : 'Нэвтрэх';
    $('emoteBtn').hidden = !loggedIn;
    $('accountBox').hidden = !loggedIn;
    $('accountName').textContent = user?.name ? `@${user.name}` : '';
    const av = $('composeAvatar');
    av.textContent = '';
    av.hidden = !loggedIn;
    if (loggedIn && user?.avatar && /^https:\/\/([a-z0-9-]+\.)*kick\.com\//i.test(user.avatar)) {
      const img = document.createElement('img');
      img.src = user.avatar;
      img.alt = '';
      img.onerror = () => img.remove();
      av.append(img);
    }
    av.dataset.initial = (user?.name || '?')[0].toUpperCase();
    $('authRedirect').textContent = authState.redirectUri || `${location.origin}/auth/callback`;
    renderQuick();
  }

  function openLogin() {
    if (!authState.configured) {
      $('authMsg').textContent = '';
      $('authDialog').showModal();
      return;
    }
    const w = window.open('/auth/login', 'kick-login', 'width=520,height=780');
    if (!w) note('Popup цонх хаагдсан байна — хөтчийн popup зөвшөөрлийг асаана уу', 'err');
  }

  async function saveCredentials() {
    const msg = $('authMsg');
    try {
      authState = await post('/api/auth/config', { clientId: $('authClientId').value, clientSecret: $('authClientSecret').value });
      $('authClientSecret').value = '';
      $('authDialog').close();
      render();
      openLogin();
    } catch (e) {
      msg.className = 'err';
      msg.textContent = e.message;
    }
  }

  async function logout() {
    try {
      authState = await post('/api/auth/logout');
    } catch {}
    closeSettings();
    render();
  }

  // ---------------------------------------------------------------- emotes

  function rebuildIndex() {
    emoteByName = new Map();
    for (const e of frequent(200)) emoteByName.set(e.name, e);
    for (const set of emoteSets || []) for (const e of set.emotes) emoteByName.set(e.name, e); // current channel wins
  }

  async function loadEmotes(slug) {
    if (!slug || slug === emoteSlug) return;
    emoteSlug = slug;
    emoteSets = null;
    rebuildIndex();
    renderQuick();
    try {
      const res = await fetch(`/api/emotes?slug=${encodeURIComponent(slug)}`);
      if (!res.ok || emoteSlug !== slug) return;
      emoteSets = await res.json();
      rebuildIndex();
      renderQuick();
      if (!$('emotePicker').hidden) renderPicker(0);
    } catch {}
  }

  function emoteButton(e, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className + (e.subOnly ? ' sub' : '');
    b.title = e.subOnly ? `${e.name} (зөвхөн subscriber)` : e.name;
    const img = document.createElement('img');
    img.src = `https://files.kick.com/emotes/${e.id}/fullsize`;
    img.alt = e.name;
    img.loading = 'lazy';
    b.append(img);
    b.onclick = () => insertAtCursor(`${e.name} `);
    return b;
  }

  /** The row above the input: your most used emotes, or this channel's + global ones until you have history. */
  function renderQuick() {
    const row = $('quickEmotes');
    row.textContent = '';
    const picks = [];
    const seen = new Set();
    const add = (e) => {
      if (picks.length < QUICK_COUNT && !seen.has(e.id) && !e.subOnly) {
        seen.add(e.id);
        picks.push(e);
      }
    };
    frequent(QUICK_COUNT).forEach(add);
    for (const set of emoteSets || []) set.emotes.forEach(add);
    row.hidden = !authState.loggedIn || !picks.length;
    for (const e of picks) row.append(emoteButton(e, 'quick-emote'));
  }

  function pickerSets() {
    const fav = frequent();
    return [...(fav.length ? [{ name: 'Байнга ашигладаг', emotes: fav }] : []), ...(emoteSets || [])];
  }

  function renderPicker(tab) {
    const tabs = $('emoteTabs');
    const grid = $('emoteGrid');
    tabs.textContent = '';
    grid.textContent = '';
    const sets = pickerSets();
    if (!sets.length) {
      grid.textContent = 'Emote ачаалж байна…';
      return;
    }
    tab = Math.min(tab, sets.length - 1);
    sets.forEach((set, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emote-tab' + (i === tab ? ' active' : '');
      b.textContent = set.name;
      b.onclick = () => renderPicker(i);
      tabs.append(b);
    });
    for (const e of sets[tab].emotes) grid.append(emoteButton(e, 'emote-cell'));
  }

  function insertAtCursor(text) {
    const input = $('composeInput');
    if (input.disabled) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + pad + text + input.value.slice(end);
    const pos = start + pad.length + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  function togglePicker(force) {
    const p = $('emotePicker');
    p.hidden = force === undefined ? !p.hidden : !force;
    if (!p.hidden) {
      loadEmotes(getTarget()?.slug);
      renderPicker(0);
    }
  }

  /** Emote names typed (or picked) as whole words become Kick's [emote:ID:NAME] tokens. */
  function toKickContent(text) {
    return text.replace(/(^|\s)([^\s]+)(?=\s|$)/g, (m, sp, word) => {
      const e = emoteByName.get(word);
      return e ? `${sp}[emote:${e.id}:${e.name}]` : m;
    });
  }

  // ---------------------------------------------------------------- settings popover

  function closeSettings() {
    $('chatSettings').hidden = true;
    $('chatSettingsBtn').setAttribute('aria-expanded', 'false');
  }

  // ---------------------------------------------------------------- send

  async function send(e) {
    e.preventDefault();
    if (!authState.loggedIn) return openLogin();
    if (sending) return;
    const input = $('composeInput');
    const raw = input.value.trim();
    const target = getTarget();
    if (!raw) return;
    if (!target?.userId) return note('Эхлээд суваг нээнэ үү', 'err');
    const content = toKickContent(raw);
    sending = true;
    $('composeSend').disabled = true;
    note('');
    try {
      const r = await post('/api/chat/send', { broadcasterUserId: target.userId, content });
      input.value = '';
      togglePicker(false);
      recordUsage(content);
      rebuildIndex();
      renderQuick();
      KickChat.addLocal({ id: r.messageId, content, username: authState.user?.name || 'Би' });
    } catch (err) {
      note(err.message, 'err');
      if (err.status === 401) refreshAuth();
    } finally {
      sending = false;
      $('composeSend').disabled = false;
      input.focus();
    }
  }

  function init({ target }) {
    getTarget = target;
    $('logoutBtn').addEventListener('click', logout);
    $('authSave').addEventListener('click', saveCredentials);
    $('authClose').addEventListener('click', () => {
      $('authClientSecret').value = '';
      $('authDialog').close();
    });
    $('authCopy').addEventListener('click', () => navigator.clipboard?.writeText($('authRedirect').textContent).catch(() => {}));
    $('composeForm').addEventListener('submit', send);
    $('composeInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') togglePicker(false);
      else if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        $('composeForm').requestSubmit();
      }
    });
    $('emoteBtn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePicker();
    });
    $('chatSettingsBtn').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const menu = $('chatSettings');
      menu.hidden = !menu.hidden;
      $('chatSettingsBtn').setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', (ev) => {
      // composedPath() still lists the picker when the clicked tab was just re-rendered out of the DOM.
      const path = ev.composedPath();
      if (!$('emotePicker').hidden && !path.some((el) => el.id === 'emotePicker' || el.id === 'emoteBtn')) togglePicker(false);
      if (!$('chatSettings').hidden && !path.some((el) => el.classList?.contains('chat-settings'))) closeSettings();
    });
    window.addEventListener('message', (ev) => {
      if (ev.origin !== location.origin) return;
      if (ev.data === 'kick-auth-ok') {
        refreshAuth();
        note('Нэвтэрлээ — одоо бичиж болно', 'ok');
      } else if (ev.data === 'kick-auth-failed') {
        note('Нэвтрэлт амжилтгүй боллоо', 'err');
      }
    });
    refreshAuth();
  }

  /** The watched channel changed: preload its emotes so the quick row and typed emote names work. */
  function setChannel(slug) {
    loadEmotes(slug);
    note('');
  }

  return { init, setChannel };
})();
