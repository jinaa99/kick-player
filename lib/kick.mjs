// kick.com internal JSON API access. Cloudflare usually rejects Node's TLS fingerprint (403) but lets the system
// curl through, so try Node first and fall back to curl; after a 403 go straight to curl for a while.
import { execFile } from 'node:child_process';
import { httpGet, BROWSER_UA } from './http.mjs';

const baseHeaders = (referer) => ({
  'user-agent': BROWSER_UA,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  referer,
});

let nodeBlockedUntil = 0;

function curlGet(url, headers) {
  const args = ['-sS', '--compressed', '--max-time', '15', '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout: 20000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl: ${String(stderr).trim() || err.message}`));
      const i = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(i + 1)), text: stdout.slice(0, i) });
    });
  });
}

/** GET https://kick.com{path}. Resolves { status, json, via } where via is 'api' (Node) or 'api-curl'. */
export async function kickGet(path, { referer = 'https://kick.com/', headers = {} } = {}) {
  const url = `https://kick.com${path}`;
  const h = { ...baseHeaders(referer), ...headers };
  if (Date.now() > nodeBlockedUntil) {
    try {
      const r = await httpGet(url, { headers: { ...h, 'accept-encoding': 'gzip, deflate, br' }, timeoutMs: 12000 });
      if (r.status !== 403) return { status: r.status, json: parseJson(r.body.toString('utf8')), via: 'api' };
      nodeBlockedUntil = Date.now() + 10 * 60 * 1000;
    } catch {
      // network error: let curl try
    }
  }
  const r = await curlGet(url, h);
  return { status: r.status, json: parseJson(r.text), via: 'api-curl' };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- channel info (for the favourites list)

const infoCache = new Map(); // slug -> { at, data }
const INFO_TTL = 45000;

export function channelSummary(d) {
  const ls = d?.livestream;
  return {
    slug: d?.slug,
    username: d?.user?.username || d?.slug,
    avatar: d?.user?.profile_pic || null,
    live: !!ls && ls.is_live !== false,
    title: ls?.session_title || null,
    viewers: ls?.viewer_count ?? null,
    category: ls?.categories?.[0]?.name || null,
    thumbnail: ls?.thumbnail?.url || null,
    // Kick sends "YYYY-MM-DD HH:MM:SS" in UTC.
    startTime: ls?.start_time ? `${ls.start_time.replace(' ', 'T')}Z` : null,
    channelId: d?.id ?? null,
    chatroomId: d?.chatroom?.id ?? null,
    subBadges: (d?.subscriber_badges || [])
      .map((b) => ({ months: b.months, src: b.badge_image?.src }))
      .filter((b) => b.src),
  };
}

async function channelInfo(slug) {
  const hit = infoCache.get(slug);
  if (hit && Date.now() - hit.at < INFO_TTL) return hit.data;
  const r = await kickGet(`/api/v2/channels/${slug}`, { referer: `https://kick.com/${slug}` });
  const data = r.status === 200 && r.json ? channelSummary(r.json) : { slug, missing: r.status === 404, error: r.status !== 404 ? `HTTP ${r.status}` : null };
  infoCache.set(slug, { at: Date.now(), data });
  return data;
}

/** Info for many channels, 4 requests at a time. */
export async function channelsInfo(slugs) {
  const out = new Array(slugs.length);
  let next = 0;
  const worker = async () => {
    while (next < slugs.length) {
      const i = next++;
      try {
        out[i] = await channelInfo(slugs[i]);
      } catch (e) {
        out[i] = { slug: slugs[i], error: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, slugs.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- chat history

export async function chatHistory(channelId) {
  const r = await kickGet(`/api/v2/channels/${channelId}/messages`);
  if (r.status !== 200) throw Object.assign(new Error(`Kick HTTP ${r.status}`), { status: 502 });
  return r.json?.data?.messages || [];
}

// ---------------------------------------------------------------- follows import (unofficial)

/** Collect channel slugs from whatever shape the followed-channels response has. */
function collectSlugs(node, out) {
  if (Array.isArray(node)) {
    for (const x of node) collectSlugs(x, out);
  } else if (node && typeof node === 'object') {
    const slug = node.channel_slug || (node.slug && (node.user_id != null || node.playback_url !== undefined || node.chatroom) ? node.slug : null);
    if (typeof slug === 'string') out.add(slug.toLowerCase());
    for (const v of Object.values(node)) if (v && typeof v === 'object') collectSlugs(v, out);
  }
}

/**
 * Import the user's followed channels with their kick.com session token (the `session_token` cookie).
 * The token is used for these requests only and never stored.
 */
export async function importFollows(rawToken) {
  let token = String(rawToken || '').trim().replace(/^session_token=/, '').replace(/^Bearer\s+/i, '');
  try {
    token = decodeURIComponent(token);
  } catch {}
  if (token.length < 20) throw Object.assign(new Error('Токен хэт богино байна'), { status: 400 });
  const headers = { authorization: `Bearer ${token}`, cookie: `session_token=${encodeURIComponent(token)}` };
  const slugs = new Set();
  for (const base of ['/api/v2/channels/followed-page', '/api/v2/channels/followed']) {
    let cursor = 0;
    for (let page = 0; page < 40; page++) {
      const r = await kickGet(`${base}?cursor=${cursor}`, { headers });
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error('Kick токеныг хүлээж авсангүй (буруу эсвэл хугацаа нь дууссан)'), { status: 401 });
      }
      if (r.status === 404) break;
      if (r.status !== 200 || !r.json) throw Object.assign(new Error(`Kick HTTP ${r.status}`), { status: 502 });
      const before = slugs.size;
      collectSlugs(r.json, slugs);
      const nextCursor = r.json.nextCursor ?? r.json.next_cursor ?? null;
      if (nextCursor == null || nextCursor === cursor || slugs.size === before) break;
      cursor = nextCursor;
    }
    if (slugs.size) break;
  }
  return [...slugs];
}
