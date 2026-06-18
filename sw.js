// Dragon Run service worker — makes the planner work with zero cell signal
// (Deals Gap & the Cherohala have none).
//
// VERSION MUST equal DATA_V in js/app.js. Bumping both together rolls the cache.
//
// Tile policy: OSM tiles are cached ONLY after the user views them (cache-on-visit),
// never bulk-prefetched — that's what the OSM tile usage policy permits. Do NOT add
// a "download region" button that loops tile requests; that would violate the policy.

const VERSION = '2026-06-17-4';
const SHELL = `dr-shell-${VERSION}`;
const TILES = 'dr-tiles-v1';        // not version-scoped — tiles are long-lived
const RUNTIME = `dr-runtime-${VERSION}`;
const TILE_MAX = 1500;

const SHELL_ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/style.css',
  './js/app.js', './js/state.js', './js/route.js', './js/rides.js', './js/sights.js',
  './js/poi.js', './js/engine.js', './js/split.js', './js/map.js', './js/ui.js',
  './js/sync.js', './js/share.js', './js/gpx.js', './js/geo.js', './js/sun.js',
  './js/weather.js', './js/firebase-config.js', './js/pwa.js',
  `./data/route-outbound.json?v=${VERSION}`,
  `./data/route-return-fast.json?v=${VERSION}`,
  `./data/pois.json?v=${VERSION}`,
  `./data/rides.json?v=${VERSION}`,
  `./data/sights.json?v=${VERSION}`,
  './icons/icon-192.png', './icons/icon-512.png',
];

// Live data the SW must NEVER serve from cache (stale = wrong).
const BYPASS = [
  'mesonet.agron.iastate.edu',         // radar
  'firestore.googleapis.com', 'firebaseio.com', 'identitytoolkit.googleapis.com',
  'www.gstatic.com',                   // firebase SDK (let the browser/HTTP cache handle it)
  'api.weather.gov', 'epqs.nationalmap.gov',
  'router.project-osrm.org', 'routing.openstreetmap.de',
  'overpass-api.de', 'overpass.kumi.systems', 'maps.mail.ru',
];

self.addEventListener('install', (event) => {
  // Resilient precache: add each asset individually so one missing file (e.g.
  // sights.json before it's built) doesn't abort the whole install.
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_ASSETS.map((u) => cache.add(u)));
  })());
  // Do NOT skipWaiting — let the client trigger the controlled update.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, TILES, RUNTIME]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('dr-') && !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (BYPASS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) return; // live → network

  if (url.hostname === 'tile.openstreetmap.org') { event.respondWith(tileCacheFirst(req)); return; }

  if (url.origin === self.location.origin) { event.respondWith(cacheFirst(req, SHELL)); return; }

  if (['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME)); return;
  }
  // default: passthrough
});

async function tileCacheFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) { cache.put(req, res.clone()).then(() => trimCache(TILES, TILE_MAX)); }
    return res;
  } catch {
    return hit || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(req, res.clone());
    return res;
  } catch {
    // offline & uncached — for navigations, fall back to the cached shell
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // FIFO/LRU-ish
}
