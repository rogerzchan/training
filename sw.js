/* Cache strategy, deliberately split:
   - app shell (html/js/css/program): NETWORK-FIRST, fall back to cache.
     A deploy lands on the next load, and it still works offline.
   - fonts + icons: CACHE-FIRST. They are immutable; never re-fetch.
   The previous version was cache-first for everything, which meant a deploy
   was invisible until the cache name happened to change. */
const C = 'tr-v3';
const SHELL = ['./','./index.html','./app.css','./app.js','./program.json'];
const IMMUTABLE = ['./manifest.webmanifest','./icon.svg',
  './fonts/barlow-400.woff2','./fonts/barlow-600.woff2','./fonts/barlow-700.woff2',
  './fonts/barlow-condensed-600.woff2','./fonts/barlow-condensed-700.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(C)
    .then(c => c.addAll([...SHELL, ...IMMUTABLE]))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x))))
    .then(() => self.clients.claim()));
});

const isImmutable = url => /\/fonts\/|icon\.svg|manifest\.webmanifest/.test(url);

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = e.request.url;

  if(isImmutable(url)){                                  // cache-first
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(C).then(c => c.put(e.request, copy)); return res;
    })));
    return;
  }
  // network-first for everything else, cache as a fallback
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(C).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(e.request, {ignoreSearch:true})
      .then(r => r || caches.match('./index.html')))
  );
});
