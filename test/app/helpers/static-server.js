// 試験用の静的サーバー。リポジトリの直下を配る（/app/ と /core/ を同じオリジンで配るため）。
// 届いた要求をすべて記録する（通信の点検：POST/PUT をしていないこと、外部ドメインがないこと）。
// 手で動かすとき：node test/app/helpers/static-server.js 8100  → http://127.0.0.1:8100/app/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

export function startStaticServer({ root = REPO_ROOT, port, host = '127.0.0.1' } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, at: Date.now(), status: 0, bodyBytes: 0, host: req.headers.host };
    log.push(entry);
    let bodyBytes = 0;
    req.on('data', (c) => { bodyBytes += c.length; });
    req.on('end', () => { entry.bodyBytes = bodyBytes; });
    const done = (status, headers, body) => {
      entry.status = status;
      res.writeHead(status, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.resume();
      return done(405, { Allow: 'GET, HEAD' }, 'method not allowed');
    }
    const u = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/') return done(302, { Location: '/app/' }, '');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) && file !== root) return done(403, {}, 'forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return done(404, {}, 'not found');
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      if (req.method === 'HEAD') return done(200, { 'Content-Type': type, 'Content-Length': st.size }, '');
      fs.readFile(file, (e2, data) => (e2 ? done(500, {}, 'error') : done(200, { 'Content-Type': type }, data)));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        origin: `http://${host}:${actual}`,
        log,
        mark: () => log.length,
        since: (i) => log.slice(i),
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8100);
  const s = await startStaticServer({ port });
  console.log(`serving ${REPO_ROOT} at ${s.origin}/app/ (Ctrl+C to stop)`);
}
