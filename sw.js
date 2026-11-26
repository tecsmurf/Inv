// Keeps the app opening without internet. Data sync is handled by Firestore itself.
const CACHE = 'hisaab-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/calc.js', 'js/db.js', 'js/config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];
const SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  const own = url.startsWith(self.registration.scope);
  if (!own && !url.startsWith(SDK)) return; // Firestore traffic goes straight to the network
  // Network first for our files (so updates show), cache as fallback when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
