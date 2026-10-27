// Service worker: instant opens for the Home Screen app, and push notifications.
//
// Caching (this site's own files, plus Google Fonts):
//   - pages, scripts, styles, manifest: network first, so a deploy shows up on the next open; the
//     saved copy only when the network fails or takes longer than WAIT_MS (a stadium dead spot).
//   - images (icons, bowl logos) and fonts: the saved copy at once, refreshed in the background.
//   - everything else (ESPN, Firebase, the notification Worker) goes straight to the network.
//
// Notifications: the Worker (worker/src/index.js) sends them; this shows them, and a tap opens
// (or focuses) the site on the page the notification is about.

const CACHE = 'bowlpool-v2';
const WAIT_MS = 2500;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const CORE = ['./', 'index.html', 'css/styles.css', 'js/app.js', 'js/config.js', 'js/espn.js', 'js/store.js',
  'js/race.js', 'js/bowl-logos.js', 'js/install.js', 'js/push.js', 'site.webmanifest?v=2', 'icons/icon-192.png?v=2', 'icons/apple-touch-icon.png?v=2'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(cache => Promise.all(CORE.map(path =>
    cache.add(new Request(new URL(path, self.registration.scope), { cache: 'no-cache' })).catch(() => {})))));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function save(req, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  await (await caches.open(CACHE)).put(req, res);
}

// Pages are saved by path alone: index.html?season=2025 opens from the same copy as index.html.
const keyFor = req => (req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req);

function networkFirst(e) {
  const key = keyFor(e.request);
  const net = fetch(e.request).then(res => { e.waitUntil(save(key, res.clone())); return res; });
  e.waitUntil(net.catch(() => {}));
  return new Promise(resolve => {
    let done = false;
    const fallback = async () => {
      const hit = await caches.match(key, { ignoreSearch: e.request.mode === 'navigate' });
      if (hit && !done) { done = true; resolve(hit); }
      return hit;
    };
    const timer = setTimeout(fallback, WAIT_MS);
    net.then(res => { clearTimeout(timer); if (!done) { done = true; resolve(res); } })
      .catch(async () => { clearTimeout(timer); if (!(await fallback()) && !done) { done = true; resolve(Response.error()); } });
  });
}

async function cacheFirst(e) {
  const hit = await caches.match(e.request);
  const net = fetch(e.request).then(res => { e.waitUntil(save(e.request, res.clone())); return res; });
  if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONTS.test(req.url)) return e.respondWith(cacheFirst(e));
  if (url.origin !== self.location.origin) return;
  if (/\.(png|jpe?g|webp|svg|gif|ico)$/i.test(url.pathname)) return e.respondWith(cacheFirst(e));
  e.respondWith(networkFirst(e));
});

/* ---------- Push notifications ---------- */

self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch { msg = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'CFB Bowl Pickems', {
    body: msg.body || '',
    icon: new URL('icons/icon-192.png?v=2', self.registration.scope).href,
    tag: msg.tag,
    renotify: !!msg.tag,
    data: { url: new URL(msg.url || './', self.registration.scope).href },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = open.find(c => c.url.startsWith(self.registration.scope));
    if (tab) {
      await tab.focus();
      return tab.navigate(target).catch(() => {});
    }
    return self.clients.openWindow(target);
  })());
});
