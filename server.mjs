// Kick тоглуулагч — локал сервер. `npm start` → http://localhost:8080
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveChannel, parseManual, ResolveError, CHANNEL_RE } from './lib/resolve.mjs';
import { channelsInfo, chatHistory, importFollows, emotes } from './lib/kick.mjs';
import * as auth from './lib/auth.mjs';
import { handleMaster, handleMedia, handleSeg, getStats, setConfig, config, ProxyError } from './lib/proxy.mjs';
import { HttpError } from './lib/http.mjs';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const root = path.dirname(fileURLToPath(import.meta.url));

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/chat.js': ['public/chat.js', 'text/javascript; charset=utf-8'],
  '/channels.js': ['public/channels.js', 'text/javascript; charset=utf-8'],
  '/compose.js': ['public/compose.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/hls.min.js': ['node_modules/hls.js/dist/hls.min.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'content-length': buf.length,
    'cache-control': 'no-store',
    ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(buf);
}

function sendError(res, e) {
  if (e instanceof ResolveError) return send(res, e.status, { error: e.message, code: e.code, attempts: e.attempts });
  if (e instanceof ProxyError || e instanceof auth.AuthError) return send(res, e.status, { error: e.message, code: e.code });
  if (e.status && e.status >= 400 && e.status < 600 && !(e instanceof HttpError)) return send(res, e.status, { error: e.message });
  if (e instanceof HttpError) {
    // Pass token-expiry statuses through so the player knows to re-resolve.
    const status = [400, 403, 404, 410].includes(e.status) ? 410 : 502;
    return send(res, status, { error: `Upstream ${e.message}`, code: status === 410 ? 'expired' : 'upstream' });
  }
  console.error(e);
  send(res, 502, { error: e.message || String(e), code: 'upstream' });
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new ProxyError(413, 'Хэт том', 'too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const M3U8 = { 'content-type': 'application/vnd.apple.mpegurl' };

// Your own logo: drop public/logo.(svg|png|jpg|jpeg|webp) in and it replaces the "K" mark and the favicon.
const LOGO_TYPES = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
async function readLogo() {
  for (const [ext, type] of Object.entries(LOGO_TYPES)) {
    try {
      return { body: await readFile(path.join(root, 'public', `logo.${ext}`)), type };
    } catch {}
  }
  return null;
}

// Only this page may use the server: a Host check stops DNS-rebinding pages, and state-changing requests must carry
// a custom header (which forces a CORS preflight we never approve) from our own origin. This matters because the
// server can post to Kick chat as you.
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function allowed(req) {
  if (!LOCAL_HOSTS.has(req.headers.host)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOSTS.has(origin.replace(/^http:\/\//, ''))) return false;
  return req.headers['x-kick-player'] === '1';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function authPage(ok, message) {
  // Shown in the login popup: tell the player window, then close.
  return `<!doctype html><meta charset="utf-8"><title>Kick нэвтрэлт</title>
<body style="background:#0d0e11;color:#e9eaee;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><p style="font-size:40px;margin:0">${ok ? '✔' : '✖'}</p><p>${esc(message)}</p></div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(ok ? 'kick-auth-ok' : 'kick-auth-failed')},location.origin)}catch(e){}
${ok ? 'setTimeout(()=>window.close(),900)' : ''}</script>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  if (!allowed(req)) return send(res, 403, { error: 'Хориотой хүсэлт' });
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await readFile(path.join(root, file)), { 'content-type': type });
    }
    switch (url.pathname) {
      case '/logo': {
        const logo = await readLogo();
        return logo ? send(res, 200, logo.body, { 'content-type': logo.type }) : send(res, 404, { error: 'logo алга' });
      }
      case '/api/resolve': {
        const channel = (q.get('channel') || '').trim();
        return send(res, 200, await resolveChannel(channel));
      }
      case '/api/manual': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST хэрэгтэй' });
        return send(res, 200, parseManual(await readBody(req)));
      }
      case '/api/channels': {
        const slugs = [...new Set((q.get('slugs') || '').toLowerCase().split(',').map((x) => x.trim()))]
          .filter((x) => CHANNEL_RE.test(x))
          .slice(0, 100);
        return send(res, 200, await channelsInfo(slugs));
      }
      case '/api/chat/history': {
        const id = q.get('channelId');
        if (!/^\d{1,12}$/.test(id || '')) return send(res, 400, { error: 'channelId буруу' });
        return send(res, 200, await chatHistory(id));
      }
      case '/api/follows/import': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST хэрэгтэй' });
        const { token } = JSON.parse((await readBody(req)) || '{}');
        return send(res, 200, { slugs: await importFollows(token) });
      }
      case '/api/emotes': {
        const slug = (q.get('slug') || '').toLowerCase();
        if (!CHANNEL_RE.test(slug)) return send(res, 400, { error: 'slug буруу' });
        return send(res, 200, await emotes(slug));
      }
      case '/api/auth/status':
        return send(res, 200, auth.status(PORT));
      case '/api/auth/config': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST хэрэгтэй' });
        auth.setCredentials(JSON.parse((await readBody(req)) || '{}'));
        return send(res, 200, auth.status(PORT));
      }
      case '/api/auth/logout': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST хэрэгтэй' });
        auth.logout();
        return send(res, 200, auth.status(PORT));
      }
      case '/auth/login':
        res.writeHead(302, { location: auth.authorizeUrl(PORT), 'cache-control': 'no-store' });
        return res.end();
      case '/auth/callback':
        try {
          await auth.handleCallback(q, PORT);
          return send(res, 200, authPage(true, 'Kick-ээр нэвтэрлээ. Энэ цонх хаагдана.'), { 'content-type': 'text/html; charset=utf-8' });
        } catch (e) {
          return send(res, 400, authPage(false, e.message), { 'content-type': 'text/html; charset=utf-8' });
        }
      case '/api/chat/send': {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST хэрэгтэй' });
        return send(res, 200, await auth.sendChat(JSON.parse((await readBody(req, 16384)) || '{}')));
      }
      case '/api/stats':
        return send(res, 200, getStats());
      case '/api/config':
        if (req.method === 'POST') return send(res, 200, setConfig(JSON.parse((await readBody(req)) || '{}')));
        return send(res, 200, { concurrency: config.concurrency });
      case '/proxy/master.m3u8':
        return send(res, 200, await handleMaster(q), M3U8);
      case '/proxy/media.m3u8':
        return send(res, 200, await handleMedia(q), M3U8);
      case '/proxy/seg': {
        const { body, type, source } = await handleSeg(q);
        return send(res, 200, body, { 'content-type': type, 'x-proxy-cache': source });
      }
      default:
        return send(res, 404, { error: 'Олдсонгүй' });
    }
  } catch (e) {
    sendError(res, e);
  }
});

server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => {
  console.log(`\n  Kick тоглуулагч ажиллаж байна → http://localhost:${PORT}`);
  console.log(`  Зэрэгцээ татах: ${config.concurrency}, кэш: ${config.cacheBytes / 1024 / 1024}MB, DVR: ${config.dvrSeconds}с\n`);
});
