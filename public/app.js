'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const state = {
  channel: null, // null when playing a manually pasted URL with no known channel
  upstream: null,
  method: null,
  mode: store.get('mode', 'proxy'),
  delay: store.get('delay', 20),
  quality: store.get('quality', 'max'), // 'max' | 'auto' | height (number)
  hls: null,
  chatInfo: null, // { channelId, chatroomId, subBadges } for the native chat
  startTime: null, // stream start (ms since epoch) for the elapsed-time display
  stalls: 0,
  stalled: false,
  started: false,
  netErrs: 0,
  mediaErrAt: 0,
  reResolving: false,
  manualReloads: 0,
  lastTime: 0,
  frozenSec: 0,
};

const METHOD_LABELS = {
  api: 'Kick API',
  'api-curl': 'Kick API (curl)',
  streamlink: 'streamlink',
  'manual-json': 'Гараар (JSON)',
  'manual-url': 'Гараар (URL)',
};

// ------------------------------------------------------------------ status line

let statusTimer;
function setStatus(text, kind = 'info', autoHideMs = 0) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = false;
  if (autoHideMs) statusTimer = setTimeout(() => (el.hidden = true), autoHideMs);
}

// ------------------------------------------------------------------ recent channels

function renderRecent() {
  const nav = $('recent');
  nav.textContent = '';
  for (const ch of store.get('recent', [])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (ch === state.channel ? ' active' : '');
    b.textContent = ch;
    b.onclick = () => {
      $('channel').value = ch;
      watch(ch);
    };
    nav.append(b);
  }
}

function addRecent(ch) {
  store.set('recent', [ch, ...store.get('recent', []).filter((x) => x !== ch)].slice(0, 8));
  renderRecent();
}

// ------------------------------------------------------------------ resolve + load

function normalizeChannel(s) {
  s = String(s || '').trim();
  const m = s.match(/kick\.com\/(?:popout\/)?([A-Za-z0-9_-]+)/i);
  if (m) s = m[1];
  return s.replace(/^@/, '').toLowerCase();
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

async function watch(name) {
  const ch = normalizeChannel(name);
  if (!/^[a-z0-9_-]{1,64}$/.test(ch)) return setStatus('Сувгийн нэр буруу байна', 'error', 4000);
  state.channel = ch;
  state.stalls = 0;
  state.chatInfo = null;
  addRecent(ch);
  Channels.setCurrent(ch);
  history.replaceState(null, '', `#${ch}`);
  hideManual();
  setChat(ch);
  setStatus(`«${ch}» сувгийг хайж байна…`);
  let r;
  try {
    r = await fetchJson(`/api/resolve?channel=${encodeURIComponent(ch)}`);
  } catch (e) {
    destroy();
    setStatus(e.message, 'error');
    const tried = (e.data?.attempts || []).map((a) => `${a.method}: ${a.error || 'OK'}`).join(' · ');
    if (e.data?.code !== 'not_found') showManual(`${e.message}${tried ? ` (${tried})` : ''}`);
    return;
  }
  state.method = r.method;
  $('sMethod').textContent = METHOD_LABELS[r.method] || r.method;
  state.chatInfo = r.chat?.chatroomId ? r.chat : null;
  state.startTime = r.startTime ? Date.parse(r.startTime) || null : null;
  startChat();
  if (!r.live) {
    destroy();
    setStatus(`«${ch}» одоогоор эфирт гараагүй байна.`, 'warn');
    return;
  }
  state.upstream = r.url;
  load();
}

function sourceUrl() {
  const p = new URLSearchParams();
  if (state.channel) p.set('c', state.channel);
  p.set('m', state.mode);
  p.set('u', state.upstream);
  return `/proxy/master.m3u8?${p}`;
}

function hlsConfig(delay) {
  const retry = (n) => ({ maxNumRetry: n, retryDelayMs: 1000, maxRetryDelayMs: 8000, backoff: 'exponential' });
  const policy = (ttfb, total, n) => ({
    default: { maxTimeToFirstByteMs: ttfb, maxLoadTimeMs: total, timeoutRetry: retry(n), errorRetry: retry(n) },
  });
  return {
    lowLatencyMode: false,
    liveSyncDuration: delay,
    liveMaxLatencyDuration: delay * 2 + 10,
    maxLiveSyncPlaybackRate: 1,
    maxBufferLength: 90,
    maxMaxBufferLength: 180,
    backBufferLength: 30,
    maxBufferHole: 1,
    abrEwmaDefaultEstimate: 8_000_000,
    capLevelToPlayerSize: false,
    startFragPrefetch: true,
    manifestLoadPolicy: policy(15000, 30000, 6),
    playlistLoadPolicy: policy(15000, 30000, 8),
    fragLoadPolicy: policy(20000, 60000, 10),
  };
}

function destroy() {
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.removeAttribute('src');
  video.load();
}

function load() {
  destroy();
  state.netErrs = 0;
  state.stalled = false;
  state.started = false;
  state.frozenSec = 0;
  $('proxyStats').classList.toggle('off', state.mode !== 'proxy');
  const url = sourceUrl();
  setStatus('Ачаалж байна…');

  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls(hlsConfig(state.delay));
    state.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      buildQualityMenu();
      applyQuality(true);
      prebufferThenPlay(hls);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      state.netErrs = 0;
      state.manualReloads = 0;
    });
    hls.on(Hls.Events.ERROR, (_, d) => onHlsError(hls, d));
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; // native HLS fallback (e.g. iOS)
    video.play().catch(() => {});
  } else {
    setStatus('Энэ хөтөч HLS тоглуулах боломжгүй', 'error');
  }
}

// Kick's playlists only hold ~28 s, so hls.js starts closer to live than the chosen delay and never slows down
// to catch up. Stay paused while the buffer fills until latency reaches the target, then start playing.
function prebufferThenPlay(hls) {
  const t0 = Date.now();
  const check = () => {
    if (state.hls !== hls) return;
    const ahead = bufferAhead();
    const ready = ahead >= 4 && (hls.latency || 0) >= state.delay - 2;
    if (ready || Date.now() - t0 > 30000) {
      setStatus('');
      playWithSoundFallback();
      return;
    }
    setStatus(`Буфер хуримтлуулж байна… ${ahead.toFixed(0)} / ${state.delay} сек`);
    setTimeout(check, 500);
  };
  check();
}

// ------------------------------------------------------------------ error recovery

function onHlsError(hls, d) {
  if (hls !== state.hls) return;
  if (!d.fatal) return;
  const code = d.response?.code;
  console.warn('[hls fatal]', d.type, d.details, code);

  if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
    state.netErrs++;
    const manifestFailed = d.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || d.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
    if (code === 410 || code === 403 || manifestFailed || state.netErrs >= 4) {
      reResolve('Холболт тасарлаа — дахин холбогдож байна…');
      return;
    }
    const wait = 1500 * state.netErrs;
    setStatus(`Сүлжээний алдаа, ${Math.round(wait / 1000)} сек дараа дахин оролдоно…`, 'warn');
    setTimeout(() => {
      if (state.hls === hls) hls.startLoad();
    }, wait);
  } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
    const now = Date.now();
    if (now - state.mediaErrAt < 5000) hls.swapAudioCodec();
    state.mediaErrAt = now;
    setStatus('Видео алдаа — сэргээж байна…', 'warn', 3000);
    hls.recoverMediaError();
  } else {
    reResolve('Тоглуулагч алдаа гарлаа — дахин ачаалж байна…');
  }
}

async function reResolve(msg) {
  if (state.reResolving) return;
  state.reResolving = true;
  setStatus(msg, 'warn');
  try {
    if (state.channel) {
      const r = await fetchJson(`/api/resolve?channel=${encodeURIComponent(state.channel)}`);
      if (!r.live || !r.url) throw new Error('Суваг эфирээс гарсан байна');
      state.upstream = r.url;
      load();
    } else if (state.manualReloads++ < 2) {
      load(); // pasted URL, no channel to re-resolve: try the same URL again
    } else {
      destroy();
      setStatus('Холбоосны хугацаа дууссан бололтой', 'error');
      showManual('Гараар оруулсан холбоосны хугацаа дууссан. Шинээр хуулж буулгана уу.');
    }
  } catch (e) {
    setStatus(`${e.message} — 10 сек дараа дахин оролдоно`, 'error');
    setTimeout(() => state.channel && reResolve(msg), 10000);
  } finally {
    state.reResolving = false;
  }
}

// ------------------------------------------------------------------ quality

function levelLabel(l) {
  const fps = Math.round(l.frameRate || 0);
  return l.height ? `${l.height}p${fps > 30 ? fps : ''}` : `${Math.round(l.bitrate / 1000)} kbps`;
}

function sortedLevels() {
  return state.hls.levels.map((l, i) => ({ l, i })).sort((a, b) => b.l.height - a.l.height || b.l.bitrate - a.l.bitrate);
}

function buildQualityMenu() {
  const sel = $('quality');
  sel.textContent = '';
  const add = (value, text) => sel.append(new Option(text, value));
  const levels = sortedLevels();
  add('max', `Хамгийн өндөр (${levelLabel(levels[0].l)})`);
  add('auto', 'Автомат');
  const seen = new Set();
  for (const { l } of levels) {
    if (!l.height || seen.has(l.height)) continue;
    seen.add(l.height);
    add(String(l.height), levelLabel(l));
  }
  sel.value = [...sel.options].some((o) => o.value === String(state.quality)) ? String(state.quality) : 'max';
}

function applyQuality(initial) {
  const hls = state.hls;
  if (!hls || !hls.levels.length) return;
  const q = state.quality;
  if (q === 'auto') {
    if (initial) hls.startLevel = -1;
    else hls.nextLevel = -1;
    return;
  }
  const levels = sortedLevels();
  const pick = (q === 'max' ? levels[0] : levels.find((x) => x.l.height === Number(q)) || levels[0]).i;
  if (initial) {
    hls.startLevel = pick;
    hls.loadLevel = pick;
  } else {
    hls.currentLevel = pick;
  }
}

// ------------------------------------------------------------------ meters & stats

function bufferAhead() {
  const b = video.buffered;
  const t = video.currentTime;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.25 && b.end(i) >= t) return b.end(i) - t;
  return 0;
}

const fmtSec = (s) => (Number.isFinite(s) ? `${s.toFixed(1)} сек` : '—');

function tick() {
  const hls = state.hls;
  const ahead = bufferAhead();
  $('bufSec').textContent = ahead.toFixed(1);
  $('bufTarget').textContent = state.delay;
  $('bufFill').style.width = `${Math.min(100, (ahead / state.delay) * 100)}%`;
  $('meter').classList.toggle('low', !!hls && ahead < 3);
  updateControlsClock();

  if (hls) {
    const lvl = hls.levels[hls.currentLevel];
    $('sQuality').textContent = lvl ? `${levelLabel(lvl)}${hls.autoLevelEnabled ? ' (авто)' : ''}` : '—';
    $('sBw').textContent = hls.bandwidthEstimate ? `${(hls.bandwidthEstimate / 1e6).toFixed(1)} Мбит/с` : '—';
    $('sLatency').textContent = fmtSec(hls.latency);
  }
  $('sStalls').textContent = state.stalls;

  // Watchdog: playing but the clock hasn't moved for 20 s → reload without waiting for the user.
  if (hls && !video.paused && !video.seeking) {
    state.frozenSec = video.currentTime === state.lastTime ? state.frozenSec + 1 : 0;
    if (state.frozenSec >= 20) {
      state.frozenSec = 0;
      reResolve('Тоглуулалт гацсан — дахин ачаалж байна…');
    }
  }
  state.lastTime = video.currentTime;
}

async function pollProxyStats() {
  try {
    const s = await fetchJson('/api/stats');
    $('pHits').textContent = `${s.hits} / ${s.inflightJoins} / ${s.misses}`;
    $('pSeg').textContent = s.avgSegmentMs ? `${s.avgSegmentMs} мс · ${s.avgSegmentMbps} Мбит/с` : '—';
    $('pThroughput').textContent = `${s.throughputMbps} Мбит/с`;
    $('pActive').textContent = `${s.activeDownloads} (дараалал ${s.queued})`;
    const st = s.streams.find((x) => x.mode === 'proxy' && (!state.channel || x.channel === state.channel));
    $('pDvr').textContent = `${st ? `${st.dvrSec} сек` : '—'} · ${s.cache.mb}/${s.cache.maxMb} MB`;
    $('concurrency').value = String(s.config.concurrency);
  } catch {}
}

video.addEventListener('playing', () => {
  state.started = true;
  state.stalled = false;
  setStatus('');
});
video.addEventListener('waiting', () => {
  if (state.stalled || video.seeking || !state.hls || !state.started) return;
  state.stalled = true;
  state.stalls++;
  setStatus('Буфер дүүргэж байна…', 'warn');
});

// ------------------------------------------------------------------ manual paste

function showManual(reason) {
  $('manualReason').textContent = reason || '';
  $('apiLink').href = `https://kick.com/api/v2/channels/${state.channel || ''}`;
  $('manual').hidden = false;
}
function hideManual() {
  $('manual').hidden = true;
}

async function loadManual() {
  const text = $('manualText').value;
  try {
    const r = await fetchJson('/api/manual', { method: 'POST', body: text });
    state.channel = r.channel || null;
    state.upstream = r.url;
    state.method = r.method;
    state.manualReloads = 0;
    $('sMethod').textContent = METHOD_LABELS[r.method];
    state.chatInfo = r.chat?.chatroomId ? r.chat : null;
    if (r.channel) {
      addRecent(r.channel);
      Channels.setCurrent(r.channel);
      setChat(r.channel);
    }
    startChat();
    if (!r.live) setStatus('JSON-оос харахад суваг эфирт алга байна, гэхдээ оролдоод үзье…', 'warn');
    hideManual();
    load();
  } catch (e) {
    $('manualReason').textContent = e.message;
  }
}

// ------------------------------------------------------------------ chat

const chatOpen = () => !$('chat').hidden;
const kickTabActive = () => $('tabKick').getAttribute('aria-selected') === 'true';

/** Native (read-only) chat: needs the chatroom id; streamlink/URL-only resolves don't include it, so look it up. */
async function startChat() {
  if (!chatOpen() || !state.channel) return;
  if (!state.chatInfo) {
    const ch = state.channel;
    try {
      const [info] = await fetchJson(`/api/channels?slugs=${encodeURIComponent(ch)}`);
      if (state.channel !== ch || !info?.chatroomId) return;
      state.chatInfo = { channelId: info.channelId, chatroomId: info.chatroomId, subBadges: info.subBadges };
    } catch {
      return;
    }
  }
  KickChat.start(state.chatInfo);
}

let chatTimer;
function setChat(ch) {
  $('chatPopout').href = `https://kick.com/popout/${ch}/chat`;
  if (chatOpen() && kickTabActive()) loadChat();
}

function loadChat() {
  const ch = state.channel;
  const frame = $('chatFrame');
  if (!ch) return;
  const src = `https://kick.com/popout/${ch}/chat`;
  if (frame.dataset.src === src) return;
  frame.dataset.src = src;
  frame.hidden = false;
  $('chatBlocked').hidden = true;
  clearTimeout(chatTimer);
  let loaded = false;
  frame.onload = () => (loaded = true);
  frame.src = src;
  // If the embed is blocked it never finishes loading: hide it and point to the pop-out link.
  chatTimer = setTimeout(() => {
    if (!loaded) {
      frame.hidden = true;
      $('chatBlocked').hidden = false;
    }
  }, 15000);
}

function selectChatTab(kick) {
  $('tabNative').setAttribute('aria-selected', String(!kick));
  $('tabKick').setAttribute('aria-selected', String(kick));
  $('paneNative').hidden = kick;
  $('paneKick').hidden = !kick;
  store.set('chatTab', kick ? 'kick' : 'native');
  if (kick) loadChat();
}

function toggleChat() {
  const aside = $('chat');
  aside.hidden = !aside.hidden;
  $('chatToggle').setAttribute('aria-pressed', String(!aside.hidden));
  store.set('chat', !aside.hidden);
  syncControls();
  if (aside.hidden) {
    KickChat.stop();
  } else {
    startChat();
    if (kickTabActive()) loadChat();
  }
}

// ------------------------------------------------------------------ fullscreen & keys

// The whole layout goes fullscreen (not just the video) so T can bring the chat in next to it.
function toggleFullscreen() {
  const stage = document.querySelector('.layout');
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else if (stage.requestFullscreen) stage.requestFullscreen();
  else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
}

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t.closest?.('input, textarea, select') || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
  // e.code is layout-independent, so this also works with the Mongolian keyboard layout.
  if (e.code === 'KeyF') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'KeyT') {
    e.preventDefault();
    toggleTheater();
  } else if (e.code === 'KeyM') {
    e.preventDefault();
    toggleMute();
  } else if (e.code === 'KeyC') {
    e.preventDefault();
    toggleChat();
  } else if (e.code === 'Escape' && document.body.classList.contains('theater') && !document.fullscreenElement) {
    toggleTheater();
  }
  showControls();
});

video.addEventListener('click', () => {
  if (!$('pcMenu').hidden) return closeMenu();
  togglePlay();
});
video.addEventListener('dblclick', toggleFullscreen);

// ------------------------------------------------------------------ player controls

const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>'),
  vol: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  volLow: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
  muted: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  chat: svg('<path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z"/>'),
  theater: svg('<rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M15.5 5.5v13"/>'),
  pip: svg('<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none"/>'),
  full: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  exitFull: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5" stroke-width="3.5" stroke-dasharray="2.6 3.3"/>'),
};

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

/** Browsers block autoplay with sound when there was no click (e.g. opening a #channel link). Fall back to muted. */
function playWithSoundFallback() {
  video.play().catch(() => {
    video.muted = true;
    video
      .play()
      .then(() => setStatus('Дуу хаалттай эхэллээ — M дарж нээнэ үү', 'info', 5000))
      .catch(() => setStatus('Тоглуулахын тулд видео дээр дарна уу'));
  });
}

function toggleMute() {
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = 0.5;
  } else {
    video.muted = true;
  }
}

function toggleTheater() {
  const on = document.body.classList.toggle('theater');
  store.set('theater', on);
  // Theater mode is about video + chat side by side, so make sure the chat is actually showing.
  if (on && $('chat').hidden) toggleChat();
  syncControls();
}

function closeMenu() {
  $('pcMenu').hidden = true;
  $('pcSettings').setAttribute('aria-expanded', 'false');
}

function syncControls() {
  $('pcPlay').innerHTML = video.paused ? ICONS.play : ICONS.pause;
  const silent = video.muted || video.volume === 0;
  $('pcMute').innerHTML = silent ? ICONS.muted : video.volume < 0.5 ? ICONS.volLow : ICONS.vol;
  $('pcVolume').value = silent ? 0 : video.volume;
  const fs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  $('pcFull').innerHTML = fs ? ICONS.exitFull : ICONS.full;
  $('pcTheater').setAttribute('aria-pressed', String(document.body.classList.contains('theater')));
  $('pcChat').setAttribute('aria-pressed', String(!$('chat').hidden));
}

const fmtClock = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Called from tick(): elapsed stream time at the playhead, latency, and the thin buffer bar. */
function updateControlsClock() {
  const lat = state.hls?.latency;
  const hasLat = Number.isFinite(lat) && lat > 0;
  $('pcTime').textContent = state.startTime ? fmtClock(Date.now() - state.startTime - (hasLat ? lat * 1000 : 0)) : '';
  $('pcLatency').textContent = hasLat ? `−${Math.round(lat)} сек` : '';
  $('pcLive').classList.toggle('behind', hasLat && lat > state.delay + 10);
  $('pcLive').title = hasLat ? `Шууд эфирээс ${lat.toFixed(1)} сек хоцорч байна` : '';
}

let idleTimer;
function showControls() {
  const stage = $('stage');
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && $('pcMenu').hidden) stage.classList.add('idle');
  }, 2500);
}

$('stage').addEventListener('mousemove', showControls);
$('stage').addEventListener('mouseleave', () => {
  if (!video.paused && $('pcMenu').hidden) $('stage').classList.add('idle');
});
$('pcPlay').addEventListener('click', togglePlay);
$('pcMute').addEventListener('click', toggleMute);
$('pcVolume').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  video.volume = v;
  video.muted = v === 0;
});
$('pcChat').addEventListener('click', () => toggleChat());
$('pcTheater').addEventListener('click', toggleTheater);
$('pcFull').addEventListener('click', toggleFullscreen);
$('pcSettings').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('pcMenu');
  menu.hidden = !menu.hidden;
  $('pcSettings').setAttribute('aria-expanded', String(!menu.hidden));
  showControls();
});
document.addEventListener('click', (e) => {
  if (!$('pcMenu').hidden && !e.target.closest('.pc-settings')) closeMenu();
});
if (document.pictureInPictureEnabled) {
  $('pcPip').addEventListener('click', () =>
    (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {}),
  );
} else {
  $('pcPip').hidden = true;
}
for (const ev of ['play', 'pause', 'volumechange']) video.addEventListener(ev, syncControls);
video.addEventListener('pause', showControls);
video.addEventListener('volumechange', () => store.set('volume', video.muted ? 0 : video.volume));
document.addEventListener('fullscreenchange', syncControls);
document.addEventListener('webkitfullscreenchange', syncControls);

$('pcSettings').innerHTML = ICONS.gear;
$('pcChat').innerHTML = ICONS.chat;
$('pcTheater').innerHTML = ICONS.theater;
$('pcPip').innerHTML = ICONS.pip;
{
  const v = Number(store.get('volume', 1));
  video.volume = Number.isFinite(v) && v > 0 ? Math.min(1, v) : 1;
  video.muted = v === 0;
}
if (store.get('theater', false)) document.body.classList.add('theater');

// ------------------------------------------------------------------ controls wiring

$('watchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  watch($('channel').value);
});

$('delay').value = String(state.delay);
$('delay').addEventListener('change', (e) => {
  state.delay = Number(e.target.value);
  store.set('delay', state.delay);
  if (state.upstream) load();
});

$('quality').addEventListener('change', (e) => {
  const v = e.target.value;
  state.quality = v === 'max' || v === 'auto' ? v : Number(v);
  store.set('quality', state.quality);
  applyQuality(false);
});

$('mode').value = state.mode;
$('mode').addEventListener('change', (e) => {
  state.mode = e.target.value;
  store.set('mode', state.mode);
  if (state.upstream) load();
});

$('concurrency').addEventListener('change', (e) => {
  fetchJson('/api/config', { method: 'POST', body: JSON.stringify({ concurrency: Number(e.target.value) }) }).catch(() => {});
});

$('manualToggle').addEventListener('click', () => ($('manual').hidden ? showManual('') : hideManual()));
$('manualLoad').addEventListener('click', loadManual);
$('manualClose').addEventListener('click', hideManual);
$('chatToggle').addEventListener('click', toggleChat);
$('tabNative').addEventListener('click', () => selectChatTab(false));
$('tabKick').addEventListener('click', () => selectChatTab(true));
$('chatPopout').addEventListener('click', (e) => {
  // A small separate window: kick.com's own chat, logged in with your browser session, so you can type and use emotes.
  if (!state.channel) return;
  e.preventDefault();
  window.open($('chatPopout').href, 'kick-chat', 'width=420,height=760');
});

KickChat.init({ getLatency: () => state.hls?.latency });
Channels.init({
  watch: (slug) => {
    $('channel').value = slug;
    watch(slug);
  },
});

syncControls();
showControls();
renderRecent();
setInterval(tick, 1000);
setInterval(pollProxyStats, 2000);
pollProxyStats();

const initial = normalizeChannel(decodeURIComponent(location.hash.slice(1)));
if (store.get('chat', true)) {
  $('chat').hidden = false;
  $('chatToggle').setAttribute('aria-pressed', 'true');
}
selectChatTab(store.get('chatTab', 'native') === 'kick');
syncControls();
if (initial) {
  $('channel').value = initial;
  watch(initial);
} else {
  $('channel').focus();
}
