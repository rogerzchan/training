const C = 'tr-v1';
const F = ['./','./index.html','./app.css','./app.js','./program.json','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c=>c.addAll(F)).then(()=>self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k=>
  Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const isProgram = e.request.url.includes('program.json');
  if(isProgram){                                   // network-first: picks up pushed program changes
    e.respondWith(fetch(e.request).then(r => { caches.open(C).then(c=>c.put(e.request, r.clone())); return r; })
      .catch(()=>caches.match(e.request, {ignoreSearch:true})));
  } else {                                         // cache-first: works offline in the gym
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
