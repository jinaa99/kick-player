'use strict';

// Read-only Kick chat over Kick's public Pusher websocket, with emotes, badges and optional delay-sync:
// the video runs 20–45 s behind live, so messages are held back by the player's current latency.
const KickChat = (() => {
  const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
  const MAX_MESSAGES = 300;
  const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
  const TEXT_BADGES = {
    broadcaster: ['📺', 'Стример'],
    moderator: ['MOD', 'Модератор'],
    vip: ['VIP', 'VIP'],
    og: ['OG', 'OG'],
    founder: ['F', 'Founder'],
    verified: ['✓', 'Баталгаажсан'],
    staff: ['K', 'Kick ажилтан'],
    sub_gifter: ['🎁', 'Sub бэлэглэгч'],
    subscriber: ['SUB', 'Захиалагч'],
  };

  let ws = null;
  let room = null; // { chatroomId, channelId, subBadges }
  let pending = []; // { data, at } waiting for delay-sync
  let latencyFn = () => 0;
  let sync = true;
  let backoff = 1000;
  let reconnectTimer = null;
  let pingTimer = null;
  let stuckToBottom = true;
  const localIds = new Set(); // messages we sent and already showed; skip their websocket echo

  const $ = (id) => document.getElementById(id);
  const list = () => $('chatList');

  // ---------------------------------------------------------------- rendering

  const isKickUrl = (u) => typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*kick\.com\//i.test(u);
  const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null);

  function appendContent(el, text) {
    let last = 0;
    for (const m of String(text || '').matchAll(EMOTE_RE)) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = `https://files.kick.com/emotes/${m[1]}/fullsize`;
      img.alt = img.title = m[2];
      img.loading = 'lazy';
      el.append(img);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  function badgeImg(src, title) {
    const img = document.createElement('img');
    img.className = 'badge';
    img.src = src;
    img.alt = img.title = title;
    return img;
  }

  function subBadgeFor(months) {
    let best = null;
    for (const b of room?.subBadges || []) if (b.months <= (months || 1) && (!best || b.months > best.months)) best = b;
    return best?.src;
  }

  function renderBadges(identity) {
    const wrap = document.createElement('span');
    wrap.className = 'badges';
    // badges_v2 carries image URLs, including the global level badges.
    const v2 = (identity?.badges_v2 || []).filter((b) => isKickUrl(b.image_url));
    const shownTypes = new Set();
    for (const b of v2) {
      wrap.append(badgeImg(b.image_url, b.name || b.badge_type || ''));
      shownTypes.add(b.name);
    }
    for (const b of identity?.badges || []) {
      if (shownTypes.has(b.type)) continue;
      const subSrc = b.type === 'subscriber' && subBadgeFor(b.count);
      if (subSrc && isKickUrl(subSrc)) {
        wrap.append(badgeImg(subSrc, `${b.text} (${b.count} сар)`));
        continue;
      }
      const [label, title] = TEXT_BADGES[b.type] || [];
      if (!label) continue;
      const s = document.createElement('span');
      s.className = `tbadge ${b.type}`;
      s.textContent = label;
      s.title = title;
      wrap.append(s);
    }
    return wrap;
  }

  function parseMeta(m) {
    if (!m) return {};
    if (typeof m === 'object') return m;
    try {
      return JSON.parse(m);
    } catch {
      return {};
    }
  }

  function renderMessage(d) {
    const el = document.createElement('div');
    el.className = 'msg';
    if (d.id) el.dataset.id = d.id;
    if (d.sender?.id != null) el.dataset.user = d.sender.id;

    const meta = parseMeta(d.metadata);
    if (d.type === 'reply' && meta.original_sender) {
      const r = document.createElement('div');
      r.className = 'reply';
      r.append(`↪ @${meta.original_sender.username || ''}: `);
      appendContent(r, String(meta.original_message?.content || '').slice(0, 120));
      el.append(r);
    }

    el.append(renderBadges(d.sender?.identity));
    const name = document.createElement('span');
    name.className = 'user';
    name.textContent = d.sender?.username || '?';
    const color = safeColor(d.sender?.identity?.color);
    if (color) name.style.color = color;
    el.append(name, document.createTextNode(': '));
    const body = document.createElement('span');
    body.className = 'text';
    appendContent(body, d.content || '');
    el.append(body);
    return el;
  }

  function addToList(nodes) {
    const l = list();
    if (!l || !nodes.length) return;
    l.append(...nodes);
    while (l.childElementCount > MAX_MESSAGES) l.firstElementChild.remove();
    if (stuckToBottom) l.scrollTop = l.scrollHeight;
    else $('chatMore').hidden = false;
  }

  function systemLine(text) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.textContent = text;
    addToList([el]);
  }

  // ---------------------------------------------------------------- delay-sync queue

  function delayMs() {
    if (!sync) return 0;
    const l = Number(latencyFn());
    return Number.isFinite(l) && l > 0 ? l * 1000 : 0;
  }

  function flush() {
    const cutoff = Date.now() - delayMs();
    const ready = [];
    while (pending.length && pending[0].at <= cutoff) ready.push(renderMessage(pending.shift().data));
    addToList(ready);
    const hint = $('chatDelay');
    if (hint) hint.textContent = sync && pending.length ? `${pending.length} мессеж видеог хүлээж байна` : '';
  }

  // ---------------------------------------------------------------- websocket

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connect() {
    const myRoom = room;
    ws = new WebSocket(PUSHER_URL);
    ws.onmessage = (ev) => {
      if (room !== myRoom) return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const data = typeof m.data === 'string' ? safeParse(m.data) : m.data;
      switch (m.event) {
        case 'pusher:connection_established':
          backoff = 1000;
          send({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${room.chatroomId}.v2` } });
          break;
        case 'pusher:ping':
          send({ event: 'pusher:pong', data: {} });
          break;
        case 'App\\Events\\ChatMessageEvent':
          if (data?.id && localIds.delete(data.id)) break;
          if (data) pending.push({ data, at: Date.now() });
          if (pending.length > 2000) pending.splice(0, pending.length - 2000);
          break;
        case 'App\\Events\\MessageDeletedEvent': {
          const id = data?.message?.id;
          if (id) {
            pending = pending.filter((p) => p.data.id !== id);
            list()?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('deleted');
          }
          break;
        }
        case 'App\\Events\\ChatroomClearEvent':
          pending = [];
          if (list()) list().textContent = '';
          systemLine('Чатыг модератор цэвэрлэлээ');
          break;
      }
    };
    ws.onclose = () => {
      if (room !== myRoom) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => room === myRoom && connect(), backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
  }

  function safeParse(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async function loadHistory(myRoom) {
    try {
      const res = await fetch(`/api/chat/history?channelId=${myRoom.channelId}`);
      if (!res.ok || room !== myRoom) return;
      const msgs = await res.json();
      // Newest-first from the API; show the ones old enough for the current video position.
      const older = msgs
        .slice()
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((d) => ({ data: d, at: Date.parse(d.created_at) || Date.now() }));
      pending = [...older, ...pending];
    } catch {}
  }

  // ---------------------------------------------------------------- public API

  function stop() {
    room = null;
    pending = [];
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  }

  function start(info) {
    if (!info?.chatroomId) return;
    if (room && room.chatroomId === info.chatroomId) return;
    stop();
    room = { chatroomId: info.chatroomId, channelId: info.channelId, subBadges: info.subBadges || [] };
    if (list()) list().textContent = '';
    stuckToBottom = true;
    $('chatMore').hidden = true;
    systemLine('Чатад холбогдлоо');
    if (room.channelId) loadHistory(room);
    connect();
  }

  function init({ getLatency }) {
    latencyFn = getLatency;
    try {
      sync = localStorage.getItem('chatSync') !== 'false';
    } catch {}
    const box = $('chatSync');
    box.checked = sync;
    box.addEventListener('change', () => {
      sync = box.checked;
      try {
        localStorage.setItem('chatSync', String(sync));
      } catch {}
    });
    const l = list();
    l.addEventListener('scroll', () => {
      stuckToBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
      if (stuckToBottom) $('chatMore').hidden = true;
    });
    $('chatMore').addEventListener('click', () => {
      l.scrollTop = l.scrollHeight;
      $('chatMore').hidden = true;
    });
    setInterval(flush, 250);
    // Keep the socket alive through idle proxies (Pusher's activity timeout is 120 s).
    pingTimer = setInterval(() => send({ event: 'pusher:ping', data: {} }), 60000);
  }

  /** Show a message we just sent right away (not delay-synced: it went out live). */
  function addLocal({ id, content, username }) {
    if (id) localIds.add(id);
    const el = renderMessage({ id, content, type: 'message', sender: { username, identity: { color: '#53fc18', badges: [] } } });
    el.classList.add('mine');
    stuckToBottom = true;
    addToList([el]);
  }

  return { init, start, stop, addLocal };
})();
