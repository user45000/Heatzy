const CACHE_NAME = 'heatzy-v2';
const STATIC_ASSETS = [
  './',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './fonts/inter-latin.woff2',
  './fonts/inter-latin-ext.woff2',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

// Install : cache les assets statiques
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate : supprime les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch : network-first, fallback cache (pour toujours avoir la derniere version)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls : toujours reseau, pas de cache
  if (url.pathname.includes('/api/')) {
    return event.respondWith(fetch(event.request));
  }

  // Tout le reste : network-first, fallback cache (offline)
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});
