/**
 * ZEROROOM service worker.
 * Purpose: let the site open when installed as an app. It caches ONLY the public static files of this site
 * (pages, scripts, styles, icons). It never touches WebSocket traffic, and nothing about rooms, people or
 * messages is ever stored: those live in memory in the page and disappear with it.
 * Strategy: network first (so a new deploy is picked up at once), cached copy only when offline.
 */
const CACHE = 'zr-shell-v8';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css?v=6.2',
  'vendor/qrcode.js',
  'fonts/fraunces-latin-wght-normal.woff2',
  'fonts/figtree-latin-wght-normal.woff2',
  'fonts/dm-mono-latin-400-normal.woff2',
  'fonts/dm-mono-latin-500-normal.woff2',
  'js/app.js?v=6.2',
  'js/ui.js?v=6.2',
  'js/socket.js?v=6.2',
  'js/crypto.js?v=6.2',
  'js/files.js?v=6.2',
  'js/pow.js?v=6.2',
  'js/pow-core.js?v=6.2',
  'js/pow-worker.js?v=6.2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === '/ws' || url.pathname === '/health') return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});
