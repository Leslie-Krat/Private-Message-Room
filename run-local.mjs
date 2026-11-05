// ZEROROOM local launcher: starts the relay (:8888) and serves the web app (:3000).
// Usage:  node run-local.mjs     then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(root, 'Zero-Room.web');
const netDir = path.join(root, 'Zero-Room.net');
const PORT = Number(process.env.WEB_PORT || 3000);

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

const relay = spawn(process.execPath, ['src/server.js'], {
  cwd: netDir, stdio: 'inherit',
  env: { ...process.env, PORT: process.env.RELAY_PORT || '8888' },
});
relay.on('exit', (c) => { console.log('relay exited', c); process.exit(c || 0); });

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(webDir, p));
  if (!file.startsWith(webDir + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nZEROROOM running -> http://localhost:${PORT}\nOpen it in two windows (one normal, one private) to try a chat. Ctrl+C to stop.\n`);
});
process.on('SIGINT', () => { relay.kill(); process.exit(0); });
