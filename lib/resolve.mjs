// Resolve a Kick channel name to its HLS master playlist URL.
// Order: (a) Kick API via Node https, then via system curl (different TLS fingerprint, often passes Cloudflare),
//        (b) streamlink, (c) a structured error so the UI can offer manual paste.
import { execFile } from 'node:child_process';
import { kickGet, channelSummary } from './kick.mjs';

export const CHANNEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class ResolveError extends Error {
  constructor(message, { code, attempts, status = 502 } = {}) {
    super(message);
    this.code = code;
    this.attempts = attempts;
    this.status = status;
  }
}

/** Interpret the /api/v2/channels JSON: playback URL plus what the favourites list and chat need. */
export function parseChannelJson(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const info = channelSummary(data);
  return {
    url: data?.playback_url || null,
    live: info.live,
    slug: info.slug || null,
    title: info.title,
    startTime: info.startTime,
    chat: { channelId: info.channelId, userId: info.userId, chatroomId: info.chatroomId, subBadges: info.subBadges },
  };
}

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} суулгаагүй байна`), { notInstalled: true }));
      resolve({ err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Node https first, system curl if Cloudflare blocks it (see lib/kick.mjs); `via` says which one answered.
async function viaApi(channel) {
  const r = await kickGet(`/api/v2/channels/${channel}`, { referer: `https://kick.com/${channel}` });
  if (r.status !== 200 || !r.json) throw Object.assign(new Error(`Kick API (${r.via}) HTTP ${r.status}`), { status: r.status });
  return { ...parseChannelJson(r.json), method: r.via };
}

async function viaStreamlink(channel) {
  const { err, stdout, stderr } = await runFile('streamlink', ['--json', `https://kick.com/${channel}`, 'best'], 45000);
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error(`streamlink: ${(stderr || err?.message || 'хоосон хариу').trim().slice(0, 300)}`);
  }
  if (json.error) throw Object.assign(new Error(`streamlink: ${json.error}`), { offline: /no playable streams/i.test(json.error) });
  // Prefer the master playlist so every quality is selectable.
  const url = json.master || json.url;
  if (!url) throw new Error('streamlink: URL олдсонгүй');
  return { url, live: true };
}

const inflight = new Map();

/** Resolve a channel. Concurrent calls for the same channel share one attempt. */
export function resolveChannel(channel) {
  channel = channel.toLowerCase();
  if (!CHANNEL_RE.test(channel)) {
    return Promise.reject(new ResolveError('Сувгийн нэр буруу байна', { code: 'bad_channel', status: 400, attempts: [] }));
  }
  if (inflight.has(channel)) return inflight.get(channel);
  const p = doResolve(channel).finally(() => inflight.delete(channel));
  inflight.set(channel, p);
  return p;
}

async function doResolve(channel) {
  const attempts = [];
  const methods = [
    ['api', viaApi],
    ['streamlink', viaStreamlink],
  ];
  for (const [method, fn] of methods) {
    const t0 = Date.now();
    try {
      const r = await fn(channel);
      const used = r.method || method;
      attempts.push({ method: used, ok: true, ms: Date.now() - t0 });
      console.log(`[resolve] ${channel}: ${used} OK (${Date.now() - t0}ms) live=${r.live}`);
      return { channel, method: used, live: r.live, url: r.url, title: r.title || null, startTime: r.startTime || null, chat: r.chat || null, attempts };
    } catch (e) {
      attempts.push({ method, ok: false, ms: Date.now() - t0, error: e.message });
      console.log(`[resolve] ${channel}: ${method} failed: ${e.message}`);
      if (e.status === 404) {
        throw new ResolveError('Ийм суваг олдсонгүй', { code: 'not_found', status: 404, attempts });
      }
      if (e.offline) return { channel, method, live: false, url: null, attempts };
      // A 403 from the Node client is exactly what the curl attempt is for; anything else falls through too.
    }
  }
  throw new ResolveError('Сувгийг автоматаар олж чадсангүй. m3u8 холбоос эсвэл API JSON-г гараар буулгана уу.', {
    code: 'resolve_failed',
    attempts,
  });
}

/** Parse user-pasted text: a raw m3u8 URL or the JSON from kick.com/api/v2/channels/NAME. */
export function parseManual(text) {
  const t = String(text || '').trim();
  if (!t) throw new ResolveError('Хоосон байна', { code: 'empty', status: 400 });
  if (t.startsWith('{')) {
    let r;
    try {
      r = parseChannelJson(t);
    } catch {
      throw new ResolveError('JSON-г уншиж чадсангүй', { code: 'bad_json', status: 400 });
    }
    if (!r.url) throw new ResolveError('JSON дотор playback_url алга', { code: 'no_url', status: 400 });
    return { method: 'manual-json', url: r.url, live: r.live, channel: r.slug, chat: r.chat };
  }
  const m = t.replace(/\\\//g, '/').match(/https?:\/\/[^\s"'<>]+/);
  if (!m) throw new ResolveError('m3u8 холбоос олдсонгүй', { code: 'no_url', status: 400 });
  return { method: 'manual-url', url: m[0], live: true, channel: null };
}
