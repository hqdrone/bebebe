/* Повторялка — офлайн. Оболочка кешируется при установке, шрифты — при первом открытии. */
const VERSION = 'povt-v1';
const FONTS = 'povt-fonts';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'sprites.js', 'vad.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // своё: отдаём из кеша сразу, в фоне обновляем
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }));
});
