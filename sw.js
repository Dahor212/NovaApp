const CACHE = 'splittimer-clean-v18';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // remove old caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE) ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith((async () => {
    const url = new URL(req.url);
    const cache = await caches.open(CACHE);

    // network-first for HTML/navigation
    const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
    if (isNav) {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('./index.html')) || new Response('Offline', {status: 200, headers: {'Content-Type':'text/plain'}});
      }
    }

    // cache-first for assets
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch {
      return new Response('Offline', {status: 200, headers: {'Content-Type':'text/plain'}});
    }
  })());
});
