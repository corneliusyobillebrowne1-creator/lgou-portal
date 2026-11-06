// Service worker: caches ONLY public static files (styles, icons, scripts) so the app opens fast.
// It never stores pages, student data, forms or anything from /portal, /admin or /teacher.
const CACHE = 'lgoc-static-v1';
const STATIC = ['/style.css', '/logo.png', '/icon-192.png', '/filter.js', '/print.js', '/pwa.js', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Pages: always go to the network (fresh, private). If offline, show a friendly page.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Static files only: serve from cache, refresh in the background.
  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => {
      const net = fetch(req).then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone())); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
