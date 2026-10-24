// Service Worker: caché del juego para cargas rápidas y soporte offline básico (la partida en sí necesita conexión).
// - HTML, JS y CSS: red primero (siempre lo último si hay conexión) y caché si no la hay.
// - Iconos, imágenes y manifiesto: caché primero.
// - Nunca se intercepta Socket.io ni peticiones que no sean GET.
const CACHE = 'domino-v2';
const SHELL = ['/', '/style.css', '/client.js', '/social.js', '/audio.js', '/avatars.js', '/icons.js', '/layout.js', '/messages.js',
  '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const isStaticAsset = (url) => /\.(png|webp|jpg|svg|ico|json|woff2?)$/.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/socket.io/')) return;
  if (isStaticAsset(url)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
  );
});
