// Service worker del mando (lo registra mando/app.js; el navegador solo lo deja en https o en localhost). Una sola cosa:
// si al abrir el mando la red no llega a la pantalla (fuera de casa, el servidor caído), en vez de la página de error del
// navegador sale offline.html, con la marca y un «Reintentar». No guarda el mando ni la API: todo lo demás va a la red
// tal cual (el mando cambia con cada versión y lo de la tele tiene que ser de ahora).
const CACHE = 'mando-offline-1';
const OFFLINE = '/offline.html';
const KEEP = [OFFLINE, '/mando/theme.js', '/shared/fonts.css', '/shared/tokens-mando.css', '/mando/styles/mando.css',
  '/fonts/fraunces-latin-opsz-normal.woff2', '/fonts/inter-latin-wght-normal.woff2', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(KEEP)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  if (r.mode === 'navigate') {
    // siempre a la red; solo si no hay red, la página sin conexión
    e.respondWith(fetch(r).catch(() => caches.match(OFFLINE)));
  } else if (KEEP.includes(u.pathname)) {
    // lo que usa offline.html: de la red, y de la copia si no hay
    e.respondWith(fetch(r).catch(() => caches.match(u.pathname)));
  }
});
