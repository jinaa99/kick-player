// HLS proxy: playlist rewriting, parallel segment prefetch into an in-memory LRU cache,
// and a server-side DVR window so the player can sit further behind live than Kick's ~28 s playlists allow.
import { httpGet, sleep, HttpError } from './http.mjs';
import { resolveChannel } from './resolve.mjs';

const MB = 1024 * 1024;

export const config = {
  concurrency: clampInt(process.env.PREFETCH_CONCURRENCY, 4, 1, 16),
  cacheBytes: clampInt(process.env.CACHE_MB, 300, 50, 4096) * MB,
  dvrSeconds: clampInt(process.env.DVR_SECONDS, 150, 30, 900),
  prefetchWindowSec: clampInt(process.env.PREFETCH_WINDOW, 60, 4, 600),
  // Each segment is itself split into byte ranges fetched over this many connections.
  segmentParts: clampInt(process.env.SEGMENT_PARTS, 4, 1, 8),
  // Each chunk opens a new connection (see lib/http.mjs), so chunks are big enough to amortise the handshake.
  chunkBytes: clampInt(process.env.CHUNK_KB, 1024, 64, 8192) * 1024,
  // How often the server polls the upstream playlist itself while someone is watching.
  pollMs: clampInt(process.env.POLL_MS, 2000, 500, 10000),
  maxTries: 5,
  logSegments: process.env.LOG_SEGMENTS !== '0',
};

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'live-video.net,kick.com,ttvnw.net,cloudfront.net,akamaized.net')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export class ProxyError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Only proxy http(s) URLs on known video CDNs so this can't be used as an open proxy. */
export function checkUpstream(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new ProxyError(400, 'Буруу URL', 'bad_url');
  }
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || !ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) {
    throw new ProxyError(403, `Зөвшөөрөгдөөгүй хост: ${host} (ALLOWED_HOSTS-д нэмнэ үү)`, 'host_not_allowed');
  }
  return url.href;
}

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

// ---------------------------------------------------------------- LRU cache

class LRU {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.map = new Map();
    this.bytes = 0;
  }
  has(k) {
    return this.map.has(k);
  }
  delete(k) {
    const v = this.map.get(k);
    if (v) {
      this.bytes -= v.body.length;
      this.map.delete(k);
    }
  }
  get(k) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k, v) {
    const old = this.map.get(k);
    if (old) {
      this.bytes -= old.body.length;
      this.map.delete(k);
    }
    this.map.set(k, v);
    this.bytes += v.body.length;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const [ok, ov] = this.map.entries().next().value;
      this.map.delete(ok);
      this.bytes -= ov.body.length;
      stats.evictions++;
    }
  }
}

const cache = new LRU(config.cacheBytes);
const inflight = new Map(); // url -> Promise<entry>
const labels = new Map(); // url -> "1080p #1234" for logs

// ---------------------------------------------------------------- stats

const stats = {
  hits: 0,
  inflightJoins: 0,
  misses: 0,
  prefetchStarted: 0,
  prefetchDone: 0,
  prefetchSkipped: 0,
  failed: 0,
  retries: 0,
  reResolves: 0,
  evictions: 0,
  directSegments: 0,
  peakParallel: 0,
};
let activeDownloads = 0;
let activePrefetch = 0;
const recent = []; // { t, bytes, ms, kind }

function record(bytes, ms, kind) {
  recent.push({ t: Date.now(), bytes, ms, kind });
  if (recent.length > 300) recent.shift();
}

export function getStats() {
  const now = Date.now();
  const win = recent.filter((r) => now - r.t < 10000);
  const last = recent.slice(-30);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    ...stats,
    activeDownloads,
    activeConnections,
    activePrefetch,
    queued: queue.length,
    throughputMbps: +((win.reduce((a, r) => a + r.bytes, 0) * 8) / 10 / 1e6).toFixed(2),
    avgSegmentMs: Math.round(mean(last.map((r) => r.ms))),
    avgSegmentMbps: +mean(last.map((r) => (r.bytes * 8) / Math.max(r.ms, 1) / 1000)).toFixed(2),
    cache: { entries: cache.map.size, mb: +(cache.bytes / MB).toFixed(1), maxMb: Math.round(config.cacheBytes / MB) },
    config: {
      concurrency: config.concurrency,
      segmentParts: config.segmentParts,
      dvrSeconds: config.dvrSeconds,
      prefetchWindowSec: config.prefetchWindowSec,
    },
    streams: [...streams.values()]
      .filter((s) => now - s.lastRequested < 30000)
      .map((s) => ({
        name: s.name,
        mode: s.mode,
        channel: s.channel,
        segments: s.history.length,
        dvrSec: Math.round(s.history.reduce((a, x) => a + x.dur, 0)),
        upstreamWindowSec: s.upstreamWindowSec,
        lastSeq: s.history.at(-1)?.seq ?? null,
      })),
  };
}

export function setConfig({ concurrency }) {
  if (concurrency != null) {
    config.concurrency = clampInt(concurrency, config.concurrency, 1, 16);
    log(`[config] prefetch concurrency = ${config.concurrency}`);
    pump();
  }
  return { concurrency: config.concurrency };
}

// ---------------------------------------------------------------- segment download

const SEG_HEADERS = { origin: 'https://kick.com', referer: 'https://kick.com/', 'accept-encoding': 'identity' };
const FATAL_STATUSES = new Set([400, 401, 403, 410]);
let activeConnections = 0;

async function getRange(url, start, end) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    activeConnections++;
    try {
      const r = await httpGet(url, { headers: { ...SEG_HEADERS, range: `bytes=${start}-${end}` }, timeoutMs: 15000, fresh: true });
      if (r.status === 200 || r.status === 206 || r.status === 416 || FATAL_STATUSES.has(r.status)) return r;
      lastErr = new HttpError(r.status, url);
    } catch (e) {
      lastErr = e;
    } finally {
      activeConnections--;
    }
    stats.retries++;
    await sleep(300 * attempt);
  }
  throw lastErr;
}

/**
 * Download one segment as fixed-size byte ranges over several connections at once.
 * The CDN answers "Content-Range: bytes a-b/*" (total unknown), so the first short chunk (or a 416) marks the end.
 * Resolves like httpGet: { status, headers, body }.
 */
async function fetchSplit(url) {
  const C = config.chunkBytes;
  const chunks = [];
  let next = 0;
  let end = Infinity;
  let whole = null;
  let failure = null;
  const worker = async () => {
    while (!whole && !failure && next < end) {
      const i = next++;
      const r = await getRange(url, i * C, (i + 1) * C - 1);
      if (r.status === 200) {
        whole = r; // server ignored Range: it sent the whole thing
      } else if (r.status === 416) {
        end = Math.min(end, i);
      } else if (r.status !== 206) {
        failure = r;
      } else {
        chunks[i] = r;
        if (r.body.length < C) end = Math.min(end, i + 1);
      }
    }
  };
  await Promise.all(Array.from({ length: config.segmentParts }, worker));
  if (whole) return whole;
  if (failure) return failure;
  if (!Number.isFinite(end) || end === 0) throw new Error('сегментийн төгсгөл олдсонгүй');
  const parts = chunks.slice(0, end);
  if (parts.length < end || parts.some((c) => !c)) throw new Error('сегментийн хэсэг дутуу');
  return { status: 200, headers: parts[0].headers, body: Buffer.concat(parts.map((c) => c.body)) };
}

async function download(url, kind, tries = config.maxTries) {
  const label = labels.get(url) || 'segment';
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const t0 = Date.now();
    activeDownloads++;
    stats.peakParallel = Math.max(stats.peakParallel, activeDownloads);
    if (config.logSegments) log(`[seg] ▶ ${label} (${kind}${attempt > 1 ? `, оролдлого ${attempt}` : ''}) active=${activeDownloads}`);
    let r;
    try {
      // Direct mode mimics a browser: one reused keep-alive connection, whole segment, so the comparison stays meaningful.
      if (kind === 'direct') r = await httpGet(url, { headers: SEG_HEADERS, timeoutMs: 15000 });
      else if (config.segmentParts === 1) r = await httpGet(url, { headers: SEG_HEADERS, timeoutMs: 15000, fresh: true });
      else r = await fetchSplit(url);
    } catch (e) {
      lastErr = e;
    } finally {
      activeDownloads--;
    }
    if (r) {
      if (r.status === 200) {
        const ms = Date.now() - t0;
        record(r.body.length, ms, kind);
        if (config.logSegments) {
          const mbps = ((r.body.length * 8) / Math.max(ms, 1) / 1000).toFixed(1);
          log(`[seg] ✔ ${label} ${(r.body.length / MB).toFixed(2)}MB ${ms}ms ${mbps}Mbps active=${activeDownloads} холболт=${activeConnections}`);
        }
        const type = r.headers['content-type'];
        return { body: r.body, type: !type || type === 'application/octet-stream' ? 'video/mp2t' : type };
      }
      lastErr = new HttpError(r.status, url);
      if (FATAL_STATUSES.has(r.status)) break; // expired token — retrying the same URL is pointless
    }
    if (attempt < tries) {
      stats.retries++;
      const wait = Math.min(250 * 2 ** (attempt - 1), 4000);
      log(`[seg] ⟳ ${label} алдаа (${lastErr.message}), ${wait}ms дараа дахин`);
      await sleep(wait);
    }
  }
  stats.failed++;
  log(`[seg] ✖ ${label} амжилтгүй: ${lastErr?.message}`);
  throw lastErr;
}

/** Cached entry, joined in-flight download, or a new download (which becomes in-flight). */
function getSegment(url, kind) {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(url)) return inflight.get(url);
  const p = download(url, kind)
    .then((e) => {
      cache.set(url, e);
      return e;
    })
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

const isAvailable = (url) => cache.has(url) || inflight.has(url);

// ---------------------------------------------------------------- prefetch queue

const queue = []; // { url, stream }
const queued = new Set();

function enqueue(url, stream) {
  if (isAvailable(url) || queued.has(url)) return;
  queue.push({ url, stream });
  queued.add(url);
}

function dequeue(url) {
  if (!queued.delete(url)) return;
  const i = queue.findIndex((q) => q.url === url);
  if (i >= 0) queue.splice(i, 1);
}

function pump() {
  while (activePrefetch < config.concurrency && queue.length) {
    const { url, stream } = queue.shift();
    queued.delete(url);
    // Player switched quality or stopped watching: don't waste bandwidth on this variant.
    if (Date.now() - stream.lastRequested > 20000) {
      stats.prefetchSkipped++;
      continue;
    }
    if (isAvailable(url)) continue;
    activePrefetch++;
    stats.prefetchStarted++;
    getSegment(url, `prefetch ${activePrefetch}/${config.concurrency}`)
      .then(
        () => stats.prefetchDone++,
        () => {},
      )
      .finally(() => {
        activePrefetch--;
        pump();
      });
  }
}

// ---------------------------------------------------------------- playlist parsing / rendering

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

const tagName = (line) => {
  const i = line.indexOf(':');
  return i < 0 ? line : line.slice(0, i);
};
const tagValue = (line) => {
  const i = line.indexOf(':');
  return i < 0 ? '' : line.slice(i + 1);
};
const mapUri = (line, fn) => line.replace(/URI="([^"]*)"/, (_, u) => `URI="${fn(u)}"`);

const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

const segUrl = (u, mode) => `/proxy/seg?${qs({ d: mode === 'direct' ? '1' : null, u })}`;
const mediaUrl = (u, { channel, mode }, key, name) => `/proxy/media.m3u8?${qs({ c: channel, v: key, n: name, m: mode, u })}`;

/** Rewrite a master playlist. Returns { body, variants: [{ key, name, url, bandwidth, height }] }. */
function rewriteMaster(text, base, ctx) {
  const out = [];
  const variants = [];
  const groupNames = {};
  let inf = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const name = tagName(line);
      // SESSION-DATA is IVS telemetry (includes your IP); I-frame playlists aren't needed.
      if (name === '#EXT-X-SESSION-DATA' || name === '#EXT-X-I-FRAME-STREAM-INF') continue;
      if (name === '#EXT-X-MEDIA') {
        const a = parseAttrs(tagValue(line));
        if (a.TYPE === 'VIDEO' && a.NAME) groupNames[a['GROUP-ID']] = a.NAME;
        if (a.URI) {
          const key = `media:${a.TYPE}:${a['GROUP-ID']}:${a.NAME}`;
          out.push(mapUri(line, (u) => mediaUrl(new URL(u, base).href, ctx, key, a.NAME)));
          continue;
        }
      }
      if (name === '#EXT-X-STREAM-INF') inf = parseAttrs(tagValue(line));
      out.push(line);
      continue;
    }
    const abs = new URL(line, base).href;
    const a = inf || {};
    const height = Number((a.RESOLUTION || '').split('x')[1]) || 0;
    const key = a.VIDEO || `${a.RESOLUTION || 'v'}@${a.BANDWIDTH || variants.length}`;
    const name = groupNames[a.VIDEO] || (height ? `${height}p` : key);
    variants.push({ key, name, url: abs, bandwidth: Number(a.BANDWIDTH) || 0, height });
    out.push(mediaUrl(abs, ctx, key, name));
    inf = null;
  }
  return { body: out.join('\n') + '\n', variants };
}

// Upstream-window-specific or low-latency tags that would confuse a DVR playlist / non-LL player.
const DROP_TAG = /^#EXT-X-(PREFETCH|NET-LIVE-VIDEO|TWITCH|DATERANGE|PRELOAD-HINT|PART|PART-INF|SERVER-CONTROL|RENDITION-REPORT|SKIP|START)\b/;

function parseMedia(text, base) {
  const r = { version: 3, target: 0, mediaSeq: 0, discSeq: 0, endList: false, independent: false, segs: [] };
  let tags = [];
  let extinf = null;
  let dur = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === '#EXTM3U') continue;
    if (line[0] !== '#') {
      r.segs.push({ seq: r.mediaSeq + r.segs.length, dur, extinf: extinf || `#EXTINF:${dur},`, tags, uri: new URL(line, base).href });
      tags = [];
      extinf = null;
      dur = 0;
      continue;
    }
    const name = tagName(line);
    const val = tagValue(line);
    if (name === '#EXT-X-VERSION') r.version = Number(val) || 3;
    else if (name === '#EXT-X-TARGETDURATION') r.target = Number(val) || 0;
    else if (name === '#EXT-X-MEDIA-SEQUENCE') r.mediaSeq = Number(val) || 0;
    else if (name === '#EXT-X-DISCONTINUITY-SEQUENCE') r.discSeq = Number(val) || 0;
    else if (name === '#EXT-X-ENDLIST') r.endList = true;
    else if (name === '#EXT-X-INDEPENDENT-SEGMENTS') r.independent = true;
    else if (name === '#EXT-X-PLAYLIST-TYPE') continue;
    else if (name === '#EXTINF') {
      extinf = line;
      dur = parseFloat(val) || 0;
    } else if (DROP_TAG.test(line)) continue;
    else if (name === '#EXT-X-MAP' || name === '#EXT-X-KEY') tags.push(mapUri(line, (u) => new URL(u, base).href));
    else tags.push(line);
  }
  return r;
}

function renderMedia({ version, target, mediaSeq, discSeq, independent, endList }, segs, mode) {
  const maxDur = segs.reduce((m, s) => Math.max(m, s.dur), 0);
  const lines = [
    '#EXTM3U',
    `#EXT-X-VERSION:${version}`,
    `#EXT-X-TARGETDURATION:${Math.max(target, Math.ceil(maxDur))}`,
    `#EXT-X-MEDIA-SEQUENCE:${mediaSeq}`,
  ];
  if (discSeq) lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${discSeq}`);
  if (independent) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  for (const s of segs) {
    for (const t of s.tags) lines.push(/^#EXT-X-(MAP|KEY)/.test(t) ? mapUri(t, (u) => segUrl(u, mode)) : t);
    lines.push(s.extinf, segUrl(s.uri, mode));
  }
  if (endList) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- upstream playlist fetch + re-resolve

// IVS answers a bad/expired playlist token with 400 or 403; 404/410 once the session is gone.
const EXPIRED = new Set([400, 403, 404, 410]);

async function fetchPlaylist(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await httpGet(url, { timeoutMs: 10000, headers: { origin: 'https://kick.com', referer: 'https://kick.com/' } });
      if (r.status === 200) return r.body.toString('utf8');
      lastErr = new HttpError(r.status, url);
      if (EXPIRED.has(r.status)) throw lastErr;
    } catch (e) {
      if (e instanceof HttpError && EXPIRED.has(e.status)) throw e;
      lastErr = e;
    }
    await sleep(300 * attempt);
  }
  throw lastErr;
}

const channels = new Map(); // channel -> { masterUrl, variants, at, promise }

/** Re-resolve a channel and fetch its fresh master. Deduplicated and rate-limited (5 s). */
function refreshChannel(channel) {
  let st = channels.get(channel);
  if (!st) channels.set(channel, (st = {}));
  if (st.promise) return st.promise;
  if (st.at && Date.now() - st.at < 5000) return Promise.resolve(st);
  st.promise = (async () => {
    const r = await resolveChannel(channel);
    if (!r.live || !r.url) throw new ProxyError(404, 'Суваг эфирт алга', 'offline');
    const url = checkUpstream(r.url);
    const text = await fetchPlaylist(url);
    st.variants = text.includes('#EXT-X-STREAM-INF')
      ? rewriteMaster(text, url, { channel, mode: 'proxy' }).variants
      : [{ key: 'main', name: 'main', url, bandwidth: 0, height: 0 }];
    st.masterUrl = url;
    st.at = Date.now();
    stats.reResolves++;
    log(`[resolve] ${channel}: шинэ токен авлаа (${r.method})`);
    return st;
  })().finally(() => {
    st.promise = null;
  });
  return st.promise;
}

// ---------------------------------------------------------------- streams (one per variant being watched)

const streams = new Map();

function getStream(key, init) {
  let s = streams.get(key);
  if (!s) {
    s = { key, history: [], discSeq: 0, lastQueuedSeq: -1, lastRequested: 0, upstreamWindowSec: 0, fetching: null, fetchedAt: 0, parsed: null, ...init };
    streams.set(key, s);
  }
  return s;
}

async function reResolveStream(s) {
  const st = await refreshChannel(s.channel);
  const v = st.variants.find((x) => x.key === s.variantKey) || [...st.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  if (!v) throw new ProxyError(502, 'Шинэ playlist-д хувилбар олдсонгүй', 'no_variant');
  log(`[media] ${s.name}: токен дууссан → шинэ URL руу шилжлээ`);
  s.upstreamUrl = v.url;
}

function refreshStream(s) {
  if (s.fetching) return s.fetching;
  if (s.parsed && Date.now() - s.fetchedAt < 500) return Promise.resolve(s.parsed);
  s.fetching = (async () => {
    let text;
    try {
      text = await fetchPlaylist(s.upstreamUrl);
    } catch (e) {
      if (!(e instanceof HttpError && EXPIRED.has(e.status) && s.channel)) throw e;
      await reResolveStream(s);
      text = await fetchPlaylist(s.upstreamUrl);
    }
    s.parsed = parseMedia(text, s.upstreamUrl);
    s.fetchedAt = Date.now();
    s.upstreamWindowSec = Math.round(s.parsed.segs.reduce((a, x) => a + x.dur, 0));
    return s.parsed;
  })().finally(() => {
    s.fetching = null;
  });
  return s.fetching;
}

function merge(s, p) {
  if (!p.segs.length) return;
  const h = s.history;
  const last = h.length ? h.at(-1).seq : -1;
  if (!h.length || p.segs[0].seq > last + 1 || p.segs.at(-1).seq < h[0].seq) {
    if (h.length) log(`[media] ${s.name}: дарааллын зөрүү (${last} → ${p.segs[0].seq}), түүхийг шинэчиллээ`);
    s.history = p.segs.slice();
    s.discSeq = p.discSeq;
    s.lastQueuedSeq = -1;
  } else {
    for (const x of p.segs) {
      if (x.seq > last) {
        h.push(x);
        continue;
      }
      // Same segment under a fresh token (after re-resolve): swap in the new URL unless we already hold the old one.
      const i = x.seq - h[0].seq;
      if (i >= 0 && h[i].uri !== x.uri && !isAvailable(h[i].uri)) h[i] = x;
    }
  }
  let total = s.history.reduce((a, x) => a + x.dur, 0);
  while (s.history.length > 1 && total - s.history[0].dur >= config.dvrSeconds) {
    const x = s.history.shift();
    total -= x.dur;
    labels.delete(x.uri);
    cache.delete(x.uri);
    if (x.tags.includes('#EXT-X-DISCONTINUITY')) s.discSeq++;
  }
}

function schedulePrefetch(s, p) {
  if (!p.segs.length) return;
  // Newest segments covering the prefetch window, queued oldest-first so the ones the player needs next finish first.
  let acc = 0;
  let from = p.segs.length;
  while (from > 0 && acc < config.prefetchWindowSec) acc += p.segs[--from].dur;
  const firstSeq = p.segs[from].seq;
  let n = 0;
  for (const x of s.history) {
    if (x.seq < firstSeq || x.seq <= s.lastQueuedSeq) continue;
    labels.set(x.uri, `${s.name} #${x.seq}`);
    enqueue(x.uri, s);
    s.lastQueuedSeq = x.seq;
    n++;
  }
  if (n && config.logSegments) log(`[prefetch] ${s.name}: ${n} шинэ сегмент дараалалд (зэрэгцээ ${config.concurrency}, дараалал ${queue.length})`);
  pump();
}

function renderDvr(s, p) {
  const h = s.history;
  const upFirst = p.segs.length ? p.segs[0].seq : Infinity;
  let start = h.findIndex((x) => x.seq >= upFirst);
  if (start < 0) start = h.length;
  // Extend backwards only through a contiguous run of segments we can actually serve.
  while (start > 0 && isAvailable(h[start - 1].uri)) start--;
  let disc = s.discSeq;
  for (let i = 0; i < start; i++) if (h[i].tags.includes('#EXT-X-DISCONTINUITY')) disc++;
  const segs = h.slice(start);
  return renderMedia({ ...p, mediaSeq: segs[0]?.seq ?? p.mediaSeq, discSeq: disc }, segs, 'proxy');
}

// ---------------------------------------------------------------- request handlers

const modeOf = (q) => (q.get('m') === 'direct' ? 'direct' : 'proxy');

export async function handleMaster(q) {
  const channel = q.get('c') || null;
  const mode = modeOf(q);
  let url = q.get('u') ? checkUpstream(q.get('u')) : null;
  if (!url) {
    if (!channel) throw new ProxyError(400, 'u эсвэл c параметр хэрэгтэй', 'bad_request');
    url = (await refreshChannel(channel)).masterUrl;
  }
  let text;
  try {
    text = await fetchPlaylist(url);
  } catch (e) {
    if (!(e instanceof HttpError && EXPIRED.has(e.status) && channel)) throw e;
    url = (await refreshChannel(channel)).masterUrl;
    text = await fetchPlaylist(url);
  }
  if (!text.includes('#EXT-X-STREAM-INF')) {
    // Already a media playlist (e.g. streamlink without master): serve it as one.
    return handleMedia(new URLSearchParams({ u: url, c: channel || '', v: 'main', n: 'main', m: mode }));
  }
  const { body, variants } = rewriteMaster(text, url, { channel, mode });
  if (channel) {
    const st = channels.get(channel) || {};
    Object.assign(st, { masterUrl: url, variants, at: st.at || Date.now() });
    channels.set(channel, st);
  }
  log(`[master] ${channel || 'manual'} (${mode}): ${variants.map((v) => v.name).join(', ')}`);
  return body;
}

export async function handleMedia(q) {
  const u = checkUpstream(q.get('u'));
  const channel = q.get('c') || null;
  const variantKey = q.get('v') || 'main';
  const mode = modeOf(q);
  const key = channel ? `${channel}|${variantKey}|${mode}` : `${u}|${mode}`;
  const s = getStream(key, { channel, variantKey, name: q.get('n') || variantKey, upstreamUrl: u, mode });
  s.lastRequested = Date.now();
  const p = await refreshStream(s);
  if (mode === 'direct') return renderMedia(p, p.segs, 'direct');
  merge(s, p);
  schedulePrefetch(s, p);
  startPolling(s);
  return renderDvr(s, p);
}

// The player only reloads the playlist every TARGETDURATION (6 s on Kick). Poll upstream ourselves so each new
// segment starts downloading as soon as it's published, not up to 6 s later.
function startPolling(s) {
  if (s.pollTimer) return;
  s.pollTimer = setInterval(async () => {
    if (Date.now() - s.lastRequested > 20000) {
      clearInterval(s.pollTimer);
      s.pollTimer = null;
      return;
    }
    try {
      const p = await refreshStream(s);
      merge(s, p);
      schedulePrefetch(s, p);
    } catch {
      // The player's own playlist request will surface (and recover from) persistent errors.
    }
  }, config.pollMs);
  s.pollTimer.unref();
}

/** Returns { body, type, source } where source is hit | wait | miss | direct. */
export async function handleSeg(q) {
  const url = checkUpstream(q.get('u'));
  if (q.get('d') === '1') {
    stats.directSegments++;
    const e = await download(url, 'direct', 1);
    return { ...e, source: 'direct' };
  }
  let source;
  if (cache.has(url)) {
    stats.hits++;
    source = 'hit';
  } else if (inflight.has(url)) {
    stats.inflightJoins++;
    source = 'wait';
  } else {
    stats.misses++;
    source = 'miss';
    dequeue(url);
  }
  const e = await getSegment(url, 'player');
  return { ...e, source };
}

// Forget variants nobody has asked for in 2 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of streams) {
    if (now - s.lastRequested > 120000) {
      for (const x of s.history) labels.delete(x.uri);
      clearInterval(s.pollTimer);
      streams.delete(k);
    }
  }
}, 30000).unref();
