// Kick OAuth 2.1 (authorization code + PKCE) for sending chat messages through the official public API.
// The user creates their own Kick app once (kick.com/settings/developer) and pastes its client id/secret.
// Credentials and tokens live in ~/.kick-player/config.json (mode 0600), never in the project folder.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { httpGet } from './http.mjs';
import https from 'node:https';

const dir = path.join(homedir(), '.kick-player');
const file = path.join(dir, 'config.json');
const SCOPES = 'user:read chat:write';

export class AuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function load() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function save(cfg) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

let cfg = load();

export const redirectUri = (port) => `http://localhost:${port}/auth/callback`;

export function status(port) {
  return {
    configured: !!(cfg.clientId && cfg.clientSecret),
    loggedIn: !!cfg.tokens?.refresh_token,
    user: cfg.user || null,
    redirectUri: redirectUri(port),
  };
}

export function setCredentials({ clientId, clientSecret }) {
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!/^[\w-]{8,200}$/.test(clientId) || !/^[\w-]{8,300}$/.test(clientSecret)) {
    throw new AuthError(400, 'Client ID эсвэл Client Secret буруу хэлбэртэй байна', 'bad_credentials');
  }
  cfg = { clientId, clientSecret }; // new app → old tokens are meaningless
  save(cfg);
}

export function logout() {
  delete cfg.tokens;
  delete cfg.user;
  save(cfg);
}

// ---------------------------------------------------------------- authorize / callback

const pendingLogins = new Map(); // state -> { verifier, at }
const b64url = (buf) => buf.toString('base64url');

export function authorizeUrl(port) {
  if (!cfg.clientId) throw new AuthError(400, 'Эхлээд Kick app-ын Client ID/Secret-ээ оруулна уу', 'not_configured');
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  for (const [k, v] of pendingLogins) if (Date.now() - v.at > 10 * 60 * 1000) pendingLogins.delete(k);
  pendingLogins.set(state, { verifier, at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(port),
    scope: SCOPES,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
  });
  // Space-separated scopes as %20 (the docs' form), not URLSearchParams' "+".
  return `https://id.kick.com/oauth/authorize?${q.toString().replace(/\+/g, '%20')}`;
}

function postForm(url, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body), accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function tokenRequest(form) {
  const r = await postForm('https://id.kick.com/oauth/token', { client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form });
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {}
  if (r.status !== 200 || !json?.access_token) {
    throw new AuthError(401, `Kick токен олгосонгүй (HTTP ${r.status}${json?.error ? `: ${json.error}` : ''})`, 'token_failed');
  }
  cfg.tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token || cfg.tokens?.refresh_token,
    expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
  save(cfg);
}

export async function handleCallback(q, port) {
  const pending = pendingLogins.get(q.get('state') || '');
  if (!pending) throw new AuthError(400, 'Нэвтрэх хүсэлт хүчингүй эсвэл хугацаа нь дууссан байна. Дахин оролдоно уу.', 'bad_state');
  pendingLogins.delete(q.get('state'));
  if (q.get('error')) throw new AuthError(400, `Kick: ${q.get('error_description') || q.get('error')}`, 'denied');
  await tokenRequest({ grant_type: 'authorization_code', code: q.get('code') || '', redirect_uri: redirectUri(port), code_verifier: pending.verifier });
  const me = await api('GET', '/public/v1/users');
  const u = Array.isArray(me?.data) ? me.data[0] : null;
  cfg.user = u ? { id: u.user_id, name: u.name, avatar: u.profile_picture || null } : null;
  save(cfg);
}

// ---------------------------------------------------------------- API calls

let refreshing = null;
async function accessToken() {
  if (!cfg.tokens?.refresh_token) throw new AuthError(401, 'Kick-ээр нэвтрээгүй байна', 'not_logged_in');
  if (Date.now() < cfg.tokens.expires_at - 60000) return cfg.tokens.access_token;
  refreshing ||= tokenRequest({ grant_type: 'refresh_token', refresh_token: cfg.tokens.refresh_token })
    .catch((e) => {
      logout(); // refresh token rejected: make the UI ask for a fresh login
      throw new AuthError(401, 'Нэвтрэлтийн хугацаа дууссан, дахин нэвтэрнэ үү', 'not_logged_in');
    })
    .finally(() => (refreshing = null));
  await refreshing;
  return cfg.tokens.access_token;
}

async function api(method, p, body) {
  const doCall = async (token) => {
    if (method === 'GET') {
      const r = await httpGet(`https://api.kick.com${p}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      return { status: r.status, text: r.body.toString('utf8') };
    }
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        `https://api.kick.com${p}`,
        {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'application/json' },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(data);
    });
  };
  let r = await doCall(await accessToken());
  if (r.status === 401) {
    cfg.tokens.expires_at = 0; // force a refresh and retry once
    r = await doCall(await accessToken());
  }
  let json = null;
  try {
    json = JSON.parse(r.text);
  } catch {}
  if (r.status < 200 || r.status >= 300) {
    const msg = json?.message || json?.error || `HTTP ${r.status}`;
    throw new AuthError(r.status === 401 ? 401 : r.status === 429 ? 429 : 502, `Kick: ${msg}`, 'api_error');
  }
  return json;
}

export async function sendChat({ broadcasterUserId, content, replyTo }) {
  const text = String(content || '').trim();
  if (!text) throw new AuthError(400, 'Хоосон мессеж', 'empty');
  if ([...new Intl.Segmenter().segment(text)].length > 500) throw new AuthError(400, 'Мессеж 500 тэмдэгтээс урт байна', 'too_long');
  if (!Number.isInteger(broadcasterUserId)) throw new AuthError(400, 'Сувгийн ID алга', 'no_channel');
  const body = { broadcaster_user_id: broadcasterUserId, content: text, type: 'user' };
  if (replyTo) body.reply_to_message_id = replyTo;
  const r = await api('POST', '/public/v1/chat', body);
  if (r?.data?.is_sent === false) throw new AuthError(400, 'Kick мессежийг хүлээж авсангүй (slow mode, followers-only эсвэл хориг байж магадгүй)', 'not_sent');
  return { messageId: r?.data?.message_id || null };
}
