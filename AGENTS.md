# Kick player

Plain Node.js (ESM, no framework, no build step) local server plus a static single-page frontend.
Not a Next.js project — the original create-next-app scaffold was removed.

- `npm start` → `node server.mjs`, serves http://localhost:8080 (bound to 127.0.0.1).
- Only runtime dependency: `hls.js`, served from `node_modules/hls.js/dist/hls.min.js` at `/vendor/hls.min.js`.
- `lib/proxy.mjs` is the core: playlist rewriting, parallel segment prefetch into an LRU cache, and a server-side
  DVR window (Kick/IVS media playlists only hold ~28 s, so delays > ~25 s depend on it).
- Kick's API is behind Cloudflare: Node's TLS fingerprint usually gets 403, system `curl` usually gets 200.
- UI text and README are in Mongolian (Cyrillic).
