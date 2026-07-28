// dev-server.mjs — local dev server for browser testing ONLY.
// - Serves www/ with `Cache-Control: no-store` so you always get the latest code (no stale modules).
// - Provides a same-origin `/__proxy?url=` endpoint that fetches remote lists server-side, so the
//   browser never hits a CORS wall when loading a Google Sheet / Drive file.
// The installed Android app NEVER uses this — it fetches natively via CapacitorHttp.
//
// Hardening: binds to 127.0.0.1 only (not reachable from the LAN), the proxy refuses private/loopback
// targets (no SSRF to internal services), and static paths can't escape www/.
//
// Run: `npm run serve`  (or `node dev-server.mjs`). Needs Node 18+ (global fetch). Then open
// http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'www');
const PORT = process.env.PORT || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

// Block SSRF to internal targets even if the proxy is somehow reached.
function isBlockedHost(h) {
  if (!h) return true;
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    // Same-origin proxy for remote lists (dev only).
    if (u.pathname === '/__proxy') {
      const target = u.searchParams.get('url');
      if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }
      let host = '';
      try { host = new URL(target).hostname; } catch { res.writeHead(400); return res.end('bad url'); }
      if (isBlockedHost(host)) { res.writeHead(403); return res.end('blocked host'); }
      const upstream = await fetch(target, { redirect: 'follow' });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      return res.end(body);
    }

    // Static files from www/ (path cannot escape ROOT).
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const filePath = normalize(join(ROOT, p));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) { res.writeHead(403); return res.end('forbidden'); }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch (e) {
    res.writeHead(e && e.code === 'ENOENT' ? 404 : 500);
    res.end(String((e && e.message) || e));
  }
});

// Fail loudly if the port is taken — never silently switch ports, so the address stays fixed.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} is already in use. Stop the other process (or run: PORT=xxxx npm run serve).`);
    process.exit(1);
  }
  throw e;
});
// Bind to localhost only (not 0.0.0.0) so the dev server + proxy aren't exposed on the network.
server.listen(PORT, '127.0.0.1', () => console.log(`kids-player dev server → http://localhost:${PORT}`));
