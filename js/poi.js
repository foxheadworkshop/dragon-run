// POI loading, per-route indexes, and the runtime Overpass "refresh places" path.

import { buildGridIndex, projectToRoute } from './geo.js';

export const CATS = ['fuel', 'food', 'lodging', 'camping'];

export const CAT_LABEL = { fuel: 'Gas', food: 'Food', lodging: 'Lodging', camping: 'Camping' };

const REFRESH_LS_KEY = 'dragon-run-poi-refresh-v1';
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

export async function loadPois(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  const data = await res.json();
  mergeRefreshCache(data);
  return data;
}

// Build the per-direction index the engine consumes.
// route is either a base route ('out' / 'retFast') or a reversed one (reversedFrom set).
export function indexForRoute(poiSet, route) {
  const key = route.reversedFrom || route.id;
  const reversed = !!route.reversedFrom;
  const total = route.cum[route.cum.length - 1];
  const byCat = Object.fromEntries(CATS.map((c) => [c, []]));
  const byId = new Map();
  for (const poi of poiSet.pois) {
    const pr = poi.routes[key];
    if (!pr || !byCat[poi.cat]) continue;
    const m = reversed ? Math.max(0, total - pr.m) : pr.m;
    const entry = { poi, m: Math.round(m * 10) / 10, o: pr.o };
    byCat[poi.cat].push(entry);
    byId.set(poi.id, entry);
  }
  for (const c of CATS) byCat[c].sort((a, b) => a.m - b.m);
  const byCatMiles = Object.fromEntries(CATS.map((c) => [c, byCat[c].map((e) => e.m)]));
  return { route, byCat, byCatMiles, byId };
}

// ---- runtime Overpass refresh (used when the baked snapshot feels stale) ----

const OVERPASS_HOSTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const LODGING_RE = /^(hotel|motel|guest_house|hostel|chalet)$/;
const CAMPING_RE = /^(camp_site|caravan_site)$/;
const FOOD_RE = /^(restaurant|fast_food|cafe)$/;

function catFor(tags = {}) {
  if (tags.amenity === 'fuel') return 'fuel';
  if (LODGING_RE.test(tags.tourism || '')) return 'lodging';
  if (CAMPING_RE.test(tags.tourism || '')) return 'camping';
  if (FOOD_RE.test(tags.amenity || '')) return 'food';
  return null;
}

// Fetch fresh POIs around [mi0, mi1] of `baseRoutes` (the two non-reversed routes),
// merge into poiSet, and persist the additions to localStorage (24 h TTL).
export async function refreshFromOverpass(poiSet, baseRoutes, activeRoute, miCenter, miSpan = 40) {
  const baseKey = activeRoute.reversedFrom || activeRoute.id;
  const base = baseRoutes.find((r) => r.id === baseKey);
  const total = base.cum[base.cum.length - 1];
  const center = activeRoute.reversedFrom ? total - miCenter : miCenter;
  const m0 = Math.max(0, center - miSpan), m1 = Math.min(total, center + miSpan);

  // corridor line: every ~1.5 mi along the span
  const pts = [];
  for (let m = m0; m <= m1; m += 1.5) {
    let i = 0;
    while (i < base.cum.length - 1 && base.cum[i + 1] < m) i++;
    pts.push(base.coords[i]);
  }
  const LINE = pts.map((p) => `${p[0]},${p[1]}`).join(',');
  const ql = `[out:json][timeout:60];(
nwr['amenity'='fuel'](around:8047,${LINE});
nwr['tourism'~'^(hotel|motel|guest_house|hostel|chalet|camp_site|caravan_site)$'](around:8047,${LINE});
nwr['amenity'~'^(restaurant|fast_food|cafe)$'](around:8047,${LINE});
);out center qt;`;

  let json = null, lastErr = null;
  for (const host of OVERPASS_HOSTS) {
    try {
      const res = await fetch(host, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: AbortSignal.timeout(70_000),
      });
      if (res.ok) { json = await res.json(); break; }
      lastErr = new Error(`Overpass HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  if (!json) throw lastErr || new Error('Overpass unreachable');

  const fresh = [];
  const indexes = baseRoutes.map((r) => ({ id: r.id, gi: buildGridIndex(r.coords), cum: r.cum }));
  for (const el of json.elements || []) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const cat = catFor(el.tags);
    if (!cat) continue;
    const id = el.type[0] + el.id;
    if (poiSet.pois.some((p) => p.id === id)) continue;
    const routes = {};
    for (const ri of indexes) {
      const pr = projectToRoute(ri.gi, ri.cum, lat, lon, 5);
      if (pr) routes[ri.id] = { m: Math.round(pr.mile * 10) / 10, o: Math.round(pr.offMi * 100) / 100 };
    }
    if (!Object.keys(routes).length) continue;
    const t = el.tags || {};
    fresh.push({
      id, cat,
      name: t.name || t.brand || null,
      sub: t.tourism || t.amenity || null,
      lat, lon,
      tags: Object.fromEntries(['brand', 'opening_hours', 'phone', 'website', 'cuisine'].filter((k) => t[k]).map((k) => [k, t[k]])),
      routes,
    });
  }
  poiSet.pois.push(...fresh);
  saveRefreshCache(fresh);
  return fresh.length;
}

function saveRefreshCache(fresh) {
  try {
    const cur = JSON.parse(localStorage.getItem(REFRESH_LS_KEY) || 'null') || { at: Date.now(), pois: [] };
    const ids = new Set(cur.pois.map((p) => p.id));
    cur.pois.push(...fresh.filter((p) => !ids.has(p.id)));
    cur.at = Date.now();
    localStorage.setItem(REFRESH_LS_KEY, JSON.stringify(cur));
  } catch { /* storage full or unavailable — refresh just won't persist */ }
}

function mergeRefreshCache(poiSet) {
  try {
    const cur = JSON.parse(localStorage.getItem(REFRESH_LS_KEY) || 'null');
    if (!cur || Date.now() - cur.at > REFRESH_TTL_MS) return;
    const ids = new Set(poiSet.pois.map((p) => p.id));
    poiSet.pois.push(...cur.pois.filter((p) => !ids.has(p.id)));
  } catch { /* ignore */ }
}
