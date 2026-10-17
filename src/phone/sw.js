// The phone app's service worker. It keeps the app shell so the installed
// app opens instantly, and offline shows its own "can't reach your Mac" state
// instead of the browser's error page. It never stores anything from /api/:
// session data stays on the Mac and in the open page's memory.
const SHELL = 'switchboard-shell-v1';
const FILES = [
  './',
  'index.html',
  'main.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'fonts/Figtree-Regular.ttf',
  'fonts/EBGaramond-Regular.ttf',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a new build reaches the phone on its next open; the
// cached shell only when the Mac cannot be reached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((hit) => hit || (event.request.mode === 'navigate' ? caches.match('index.html') : undefined))
          .then((hit) => hit || Response.error()),
      ),
  );
});
