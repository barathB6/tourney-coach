// Service worker for the volunteer app.
//
// Scope is deliberately narrow: the app shell and static assets are cached so
// /v/<token> still opens in a dead zone. API responses are NOT cached here —
// the volunteer's own data lives in localStorage (lib/dayof/offlineCache),
// which is synchronous and therefore paints on the first render rather than
// after a promise resolves. On one bar of signal that difference is the point.
const CACHE = 'tc-volunteer-v1';
const SHELL = ['/volunteer-sw.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never serve a stale API response — the app has its own, better cache for
  // that, and a stale checklist that looks live is worse than an obvious one.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/v'))),
  );
});
