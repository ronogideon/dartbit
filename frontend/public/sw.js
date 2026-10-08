// Dartbit service worker. Deliberately minimal: it makes the app installable and shows a friendly
// page when there is no connection. It NEVER caches account data — balances, expiry dates and
// session state always come from the network, so nobody ever sees a stale "active" status.
const VERSION = 'dartbit-sw-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Only page navigations are handled. Everything else — API calls (a different origin anyway),
  // scripts, images — goes straight to the network untouched.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
  );
});
