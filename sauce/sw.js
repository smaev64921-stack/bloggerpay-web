/* Санчоус — service worker: быстрый повторный запуск и работа офлайн */
const VERSION = 'sanchous-v1';
const CORE = [
  './',
  './index.html',
  './css/style.css',
  './css/ui.css',
  './js/main.js',
  './manifest.webmanifest',
  './img/logo-round.png',
  './img/icon-192.png',
  './img/hero-1000.webp',
  './img/title-304.webp'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // отдельные промахи не должны ронять установку
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // шрифты и Telegram — мимо кэша

  // HTML — сначала сеть, чтобы правки сайта подхватывались сразу
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // статика — сначала кэш
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
