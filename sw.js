// sw.js — cache the app shell + Google Fonts so it works offline after first load.
const CACHE = 'liftlog-v6';
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
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
      }).catch(() => hit);
    })
  );
});
