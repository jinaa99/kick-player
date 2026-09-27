// Upstream HTTP client with keep-alive agents (so parallel segment downloads reuse warm TLS connections).
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const agentOpts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 32, maxFreeSockets: 16, scheduling: 'lifo' };
const httpsAgent = new https.Agent(agentOpts);
const httpAgent = new http.Agent(agentOpts);
// For bulk video downloads: a new TCP connection per request (TLS sessions are still resumed).
// On a lossy long-RTT path a reused connection keeps the low congestion threshold it hit after its first
// packet loss; measured Mongolia → Kick CDN: ~1.5 Mbit/s on a reused socket vs ~13 Mbit/s on a fresh one.
const freshHttpsAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity, maxCachedSessions: 200 });
const freshHttpAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * GET a URL and buffer the (decompressed) body.
 * Resolves with { status, headers, body, url } for any status; rejects only on network errors/timeouts.
 */
export function httpGet(url, { headers = {}, timeoutMs = 15000, maxRedirects = 5, fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttp = u.protocol === 'http:';
    const req = (isHttp ? http : https).request(
      u,
      {
        method: 'GET',
        agent: fresh ? (isHttp ? freshHttpAgent : freshHttpsAgent) : isHttp ? httpAgent : httpsAgent,
        headers: { 'user-agent': BROWSER_UA, accept: '*/*', ...headers },
      },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && maxRedirects > 0) {
          res.resume();
          resolve(httpGet(new URL(loc, u).href, { headers, timeoutMs, maxRedirects: maxRedirects - 1, fresh }));
          return;
        }
        let stream = res;
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: u.href }));
        stream.on('error', reject);
        res.on('error', reject);
      },
    );
    // Idle-socket timeout: fires if no bytes arrive for timeoutMs.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
