// sw.js — cache the app shell + Google Fonts so it works offline after first load.
const CACHE = 'liftlog-v12';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/parser.js',
  './js/store.js',
  './js/bell.js',
  './js/session.js',
  './js/history.js',
  './js/settings.js',
  './js/timer-worker.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the browser HTTP cache (GitHub Pages sends
  // max-age=600). Without it, a deploy within 10 min of a visit filled the new
  // cache with the OLD files, so the update never showed up.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for shell + fonts; network fallback fills the cache on first hit.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const url = new URL(req.url);
        const cacheable = url.origin === location.origin ||
          url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com';
        if (cacheable && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit || offlineResponse(req));
    })
  );
});

// A cache miss plus a failed fetch used to resolve to `undefined`, which makes
// the request fail SILENTLY — a <script> that never loads produces no console
// error, so the module's global is simply missing and the feature it powers
// looks like a dead button. Fail loudly instead. Navigations fall back to the
// cached shell so the app still opens offline.
function offlineResponse(req) {
  if (req.mode === 'navigate') {
    return caches.match('./index.html').then((shell) => shell || errorResponse(req));
  }
  return errorResponse(req);
}
function errorResponse(req) {
  return new Response('LIFTLOG offline: not cached and unreachable — ' + req.url,
    { status: 503, statusText: 'Offline and not cached', headers: { 'Content-Type': 'text/plain' } });
}
