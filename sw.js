// JET7 2.0 — service worker simples: guarda só os ficheiros estáticos da página para abrir sem rede.
// Nunca guarda nem intercepta a API (/api, /client, /public/*, /ping): esses pedidos vão sempre direto ao servidor.
const CACHE = 'jet7-static-2.0.0';
const STATIC = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
const isApi = p => p.startsWith('/api') || p.startsWith('/client') || p.startsWith('/public/') || p === '/public' || p === '/ping' || p === '/sw.js';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isApi(url.pathname)) return;   // a API nunca passa pela cache
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (!STATIC.includes(key)) return;
  // rede primeiro (a página fica sempre atualizada); sem rede, a cópia guardada
  e.respondWith(fetch(req).then(r => {
    if (r && r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key).then(m => m || caches.match('/'))));
});
