// One-time data builder for Dragon Run.
//   node scripts/build-data.mjs --step relation|routes|pois|rides|all [--audit]
//
// Fetches the Blue Ridge Parkway geometry (OSM relation 55450), samples routing
// pins every ~5 mi, builds OSRM routes (outbound via BRP + interstate return),
// then sweeps Overpass for fuel/lodging/food POIs in a 5-mile corridor.
// Every HTTP response is cached in scripts/.cache so reruns don't re-hit servers.
// Zero npm dependencies (Node 22 global fetch).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  haversineMi, cumulativeMiles, pointAtMile, simplifyIndices,
  buildGridIndex, projectToRoute,
} from '../js/geo.js';
import { BRP_ANCHORS, POINTS, RETURN_FAST_ANCHORS, CLOSURES, ADVISORIES, DEALS_GAP_BBOX, DEALS_GAP_SIGHTS } from './waypoints.mjs';
import { RIDES } from './rides.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');
const DATA_DIR = path.join(ROOT, 'data');
const UA = 'dragon-run-data-build/0.1 (foxheadworkshop@gmail.com)';

const OSRM_HOSTS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const OVERPASS_HOSTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const PIN_SPACING_MI = 5;
const CORRIDOR_M = 8047; // 5 mi
const SIGHT_CORRIDOR_M = 4828; // 3 mi — tighter than POIs to keep the sights file lean

// Elevation: USGS 3DEP 10m via OpenTopoData (free, no key, US). 100 loc/req, 1/s, 1000/day.
const M_PER_FT = 0.3048;
const ELEV_HOST = 'https://api.opentopodata.org';
const ELEV_DATASET = 'ned10m';
const ELEV_BATCH = 100;
const ELEV_GAP_MS = 1100;
const ELEV_SOURCE = 'USGS 3DEP 10m via OpenTopoData (ned10m) · public domain';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- cached HTTP ----------

let lastReqAt = 0;
async function throttled(gapMs) {
  const wait = lastReqAt + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}

function cachePath(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

async function cachedJson(key, doFetch, isValid = () => true) {
  const file = cachePath(key);
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isValid(cached)) return cached;
    console.log('  cached response failed validation — refetching');
  }
  const json = await doFetch();
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

async function osrm(pathAndQuery) {
  return cachedJson('osrm:' + pathAndQuery, async () => {
    let lastErr;
    for (const host of OSRM_HOSTS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await throttled(1000);
        try {
          const res = await fetch(host + pathAndQuery, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(60_000),
          });
          const json = await res.json().catch(() => null);
          if (res.ok && json?.code === 'Ok') return json;
          const code = json?.code || `HTTP ${res.status}`;
          // Deterministic request errors: don't burn retries, try next host once.
          if (['NoSegment', 'NoRoute', 'InvalidQuery', 'TooBig'].includes(code)) {
            lastErr = new Error(`OSRM ${code} @ ${host}: ${json?.message || ''}`);
            lastErr.osrmCode = code;
            break;
          }
          lastErr = new Error(`OSRM ${code} @ ${host}`);
        } catch (e) {
          lastErr = e;
        }
        await sleep(2000 * (attempt + 1));
      }
    }
    throw lastErr;
  });
}

// A 200 with a `remark` and no elements is a disguised timeout/abort — retryable.
function overpassLooksValid(json) {
  if (!json || !Array.isArray(json.elements)) return false;
  if (json.remark && json.elements.length === 0) return false;
  return true;
}

async function overpass(ql, label, { allowEmpty = false } = {}) {
  const isValid = (j) => overpassLooksValid(j) && (allowEmpty || j.elements.length > 0);
  return cachedJson('overpass:' + ql, async () => {
    let lastErr;
    for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      console.log(`  all mirrors busy (${label}) — cooling down 90s (pass ${pass + 1}/3)`);
      await sleep(90_000);
    }
    for (const host of OVERPASS_HOSTS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await throttled(4000);
        try {
          const res = await fetch(host, {
            method: 'POST',
            headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(ql),
            signal: AbortSignal.timeout(190_000),
          });
          if (res.status === 429 || res.status === 504) {
            const ra = Number(res.headers.get('retry-after')) || 15 * (attempt + 1);
            console.log(`  overpass ${res.status} (${label}) — backing off ${ra}s`);
            await sleep(ra * 1000);
            lastErr = new Error(`Overpass HTTP ${res.status}`);
            continue;
          }
          if (!res.ok) { lastErr = new Error(`Overpass HTTP ${res.status} @ ${host}`); break; }
          const json = await res.json();
          if (!isValid(json)) {
            lastErr = new Error(`Overpass returned ${json?.elements?.length ?? 'no'} elements${json?.remark ? ` (remark: ${json.remark})` : ''} @ ${host} (${label})`);
            console.log('  ' + lastErr.message + ' — retrying');
            continue;
          }
          return json;
        } catch (e) {
          lastErr = e;
          await sleep(5000 * (attempt + 1));
        }
      }
    }
    }
    throw lastErr;
  }, isValid);
}

// ---------- step: relation (BRP chain + pins) ----------

function coordKey(lat, lon) { return lat.toFixed(7) + ',' + lon.toFixed(7); }

function wayLengthMi(geom) {
  let mi = 0;
  for (let i = 1; i < geom.length; i++) {
    mi += haversineMi(geom[i - 1].lat, geom[i - 1].lon, geom[i].lat, geom[i].lon);
  }
  return mi;
}

// Greedy lookahead: how far can we ride starting into `way` from `fromKey`?
function lookaheadMi(way, fromKey, adj, used, limitMi) {
  let total = 0;
  let cur = way, curFrom = fromKey;
  const localUsed = new Set();
  while (cur && total < limitMi) {
    localUsed.add(cur.id);
    total += cur.lenMi;
    const farKey = cur.k0 === curFrom ? cur.k1 : cur.k0;
    const nexts = (adj.get(farKey) || []).filter(
      (w) => w.id !== cur.id && !used.has(w.id) && !localUsed.has(w.id)
    );
    if (!nexts.length) break;
    nexts.sort((a, b) => b.lenMi - a.lenMi);
    cur = nexts[0];
    curFrom = farKey;
  }
  return total;
}

async function stepRelation() {
  console.log('== step: relation — fetching BRP relation 55450');
  const res = await overpass("[out:json][timeout:180];relation(55450);way(r);out geom;", 'brp-relation');
  const raw = res.elements.filter((e) => e.type === 'way' && e.geometry?.length > 1);
  const ways = [...new Map(raw.map((w) => [w.id, w])).values()].map((w) => ({
    id: w.id,
    geom: w.geometry,
    lenMi: wayLengthMi(w.geometry),
    k0: coordKey(w.geometry[0].lat, w.geometry[0].lon),
    k1: coordKey(w.geometry[w.geometry.length - 1].lat, w.geometry[w.geometry.length - 1].lon),
  }));
  console.log(`  ${ways.length} member ways, ${round(ways.reduce((s, w) => s + w.lenMi, 0), 1)} mi of way geometry`);

  const adj = new Map();
  for (const w of ways) {
    for (const k of [w.k0, w.k1]) {
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(w);
    }
  }
  const termini = [...adj.entries()].filter(([, ws]) => ws.length === 1);
  console.log(`  ${termini.length} degree-1 termini`);

  // Start from the terminus nearest Rockfish Gap.
  const rg = BRP_ANCHORS[0];
  let startKey = null, bestD = Infinity;
  for (const [k] of termini) {
    const [lat, lon] = k.split(',').map(Number);
    const d = haversineMi(lat, lon, rg.lat, rg.lon);
    if (d < bestD) { bestD = d; startKey = k; }
  }
  if (bestD > 5) throw new Error(`No relation terminus near Rockfish Gap (nearest ${round(bestD, 1)} mi)`);

  // Walk the chain, preferring the branch with the longest greedy continuation.
  const used = new Set();
  const chain = [];
  let curKey = startKey;
  while (true) {
    const candidates = (adj.get(curKey) || []).filter((w) => !used.has(w.id));
    if (!candidates.length) break;
    let next = candidates[0];
    if (candidates.length > 1) {
      let best = -1;
      for (const c of candidates) {
        const la = lookaheadMi(c, curKey, adj, used, 30);
        if (la > best) { best = la; next = c; }
      }
    }
    used.add(next.id);
    const fwd = next.k0 === curKey;
    const g = fwd ? next.geom : [...next.geom].reverse();
    const startAt = chain.length ? 1 : 0; // drop duplicated joint vertex
    for (let i = startAt; i < g.length; i++) chain.push([g[i].lat, g[i].lon]);
    curKey = fwd ? next.k1 : next.k0;
  }

  const cum = cumulativeMiles(chain);
  const totalMi = cum[cum.length - 1];
  const end = chain[chain.length - 1];
  const endsAtCherokee = haversineMi(end[0], end[1], 35.503, -83.3055) < 5;
  console.log(`  stitched chain: ${chain.length} pts, ${round(totalMi, 1)} mi, ends near Cherokee: ${endsAtCherokee}`);
  if (totalMi < 469 * 0.97 || totalMi > 469 * 1.03 || !endsAtCherokee) {
    throw new Error(`BRP chain failed validation (${round(totalMi, 1)} mi) — fall back to anchor pins`);
  }

  const route = { coords: chain, cum };
  const pins = [];
  for (let m = 0; m < totalMi; m += PIN_SPACING_MI) pins.push(pointAtMile(route, m));
  pins.push(chain[chain.length - 1]);
  fs.writeFileSync(path.join(CACHE_DIR, 'brp-pins.json'), JSON.stringify({ totalMi, pins }));
  console.log(`  sampled ${pins.length} pins @ ${PIN_SPACING_MI} mi — saved to .cache/brp-pins.json`);
  return { totalMi, pins };
}

// ---------- step: routes ----------

function coordStr(pts) { return pts.map((p) => `${round(p[1], 6)},${round(p[0], 6)}`).join(';'); }

async function osrmRoute(pts, { radiuses = null } = {}) {
  let q = '?overview=full&geometries=geojson&annotations=distance&continue_straight=true&steps=false';
  if (radiuses) q += '&radiuses=' + pts.map(() => radiuses).join(';');
  const json = await osrm(`/route/v1/driving/${coordStr(pts)}${q}`);
  const r = json.routes[0];
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  let dists = r.legs.flatMap((l) => l.annotation.distance);
  if (dists.length !== coords.length - 1) {
    console.log(`  ! annotation mismatch (${dists.length} vs ${coords.length - 1} pairs) — recomputing`);
    dists = [];
    for (let i = 1; i < coords.length; i++) {
      dists.push(haversineMi(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) * 1609.344);
    }
  }
  return { coords, dists, legDistancesM: r.legs.map((l) => l.distance), totalM: r.distance };
}

function stitch(phases) {
  const coords = [...phases[0].coords];
  const dists = [...phases[0].dists];
  const joints = [];
  for (let p = 1; p < phases.length; p++) {
    const ph = phases[p];
    joints.push(coords.length - 1);
    const last = coords[coords.length - 1];
    const gapMi = haversineMi(last[0], last[1], ph.coords[0][0], ph.coords[0][1]);
    if (gapMi < 0.05) {
      coords.push(...ph.coords.slice(1));
      dists.push(...ph.dists);
    } else {
      console.log(`  ! phase joint gap ${round(gapMi, 3)} mi — bridging`);
      coords.push(...ph.coords);
      dists.push(gapMi * 1609.344, ...ph.dists);
    }
  }
  return { coords, dists, joints };
}

// Sample integer-feet elevation at each coord (kept vertices), batched + cached.
async function sampleElevationsFt(coords, label) {
  const out = new Array(coords.length).fill(null);
  for (let s = 0; s < coords.length; s += ELEV_BATCH) {
    const batch = coords.slice(s, s + ELEV_BATCH);
    const locs = batch.map(([lat, lon]) => `${round(lat, 6)},${round(lon, 6)}`).join('|');
    const url = `${ELEV_HOST}/v1/${ELEV_DATASET}?locations=${encodeURIComponent(locs)}`;
    const json = await cachedJson('elev:' + url, async () => {
      await throttled(ELEV_GAP_MS);
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
      const j = await res.json().catch(() => null);
      if (!res.ok || j?.status !== 'OK') throw new Error(`OpenTopoData ${j?.status || res.status} (${label})`);
      return j;
    }, (j) => j?.status === 'OK' && Array.isArray(j.results) && j.results.length === batch.length);
    json.results.forEach((r, i) => { out[s + i] = r.elevation == null ? null : Math.round(r.elevation / M_PER_FT); });
    console.log(`    elev ${label}: ${Math.min(s + ELEV_BATCH, coords.length)}/${coords.length}`);
  }
  fillNulls(out);
  return out;
}

function fillNulls(arr) {
  let last = null;
  for (let i = 0; i < arr.length; i++) if (arr[i] != null) { last = arr[i]; break; }
  if (last == null) return false; // all null — caller drops `ele`
  for (let i = 0; i < arr.length; i++) { if (arr[i] == null) arr[i] = last; else last = arr[i]; }
  return true;
}

async function finalizeRoute({ id, name, coords, dists, jointMiles, anchors, spanMarkers }) {
  const cum = [0];
  for (let i = 0; i < dists.length; i++) cum.push(cum[i] + dists[i] / 1609.344);
  const totalMi = cum[cum.length - 1];

  // Project anchors on full-res geometry.
  const gi = buildGridIndex(coords);
  const outAnchors = [];
  for (const a of anchors) {
    // MP anchors sit ON the parkway: require a tight projection so they never
    // latch onto a nearby detour highway. City anchors may be miles off-route.
    const maxOff = a.mp != null ? 0.35 : 4;
    const pr = projectToRoute(gi, cum, a.lat, a.lon, maxOff);
    if (pr) outAnchors.push({ name: a.name, mile: round(pr.mile, 1), ...(a.mp != null ? { brpMp: a.mp } : {}) });
    else console.log(`  - anchor "${a.name}" not on ridden route (skipped)`);
  }
  outAnchors.sort((x, y) => x.mile - y.mile);

  // Detour / advisory spans: project their entry/exit points to route miles.
  const projectSpans = (list) => (list || []).flatMap((s) => {
    const a = projectToRoute(gi, cum, s.entry[0], s.entry[1], 2);
    const b = projectToRoute(gi, cum, s.exit[0], s.exit[1], 2);
    if (!a || !b) { console.log(`  ! span MP ${s.fromMp}-${s.toMp} did not project`); return []; }
    return [{ startMile: round(a.mile, 1), endMile: round(b.mile, 1), fromMp: s.fromMp, toMp: s.toMp, note: s.note }];
  });

  const keep = simplifyIndices(coords, 15, 250);
  const keptCoords = keep.map((i) => [round(coords[i][0], 5), round(coords[i][1], 5)]);
  let ele = null;
  try {
    ele = await sampleElevationsFt(keptCoords, id);
    if (ele.length !== keptCoords.length) throw new Error('elevation length mismatch');
  } catch (e) {
    console.log(`  ! elevation sampling failed for ${id}: ${e.message} — route ships without ele`);
    ele = null;
  }
  const json = {
    id, name,
    totalMi: round(totalMi, 1),
    builtAt: new Date().toISOString().slice(0, 10),
    source: 'router.project-osrm.org + OSM relation 55450 · © OpenStreetMap contributors (ODbL)',
    brp: jointMiles ? { startMile: round(jointMiles[0], 1), endMile: round(jointMiles[1], 1) } : null,
    detours: projectSpans(spanMarkers?.detours),
    advisories: projectSpans(spanMarkers?.advisories),
    anchors: outAnchors,
    coords: keptCoords,
    cum: keep.map((i) => round(cum[i], 3)),
    ...(ele ? { ele, eleSource: ELEV_SOURCE } : {}),
  };
  const file = path.join(DATA_DIR, `route-${id === 'out' ? 'outbound' : 'return-fast'}.json`);
  fs.writeFileSync(file, JSON.stringify(json));
  console.log(`  wrote ${path.basename(file)}: ${json.coords.length} pts (from ${coords.length}), ${json.totalMi} mi, ${Math.round(fs.statSync(file).size / 1024)} KB`);
  return json;
}

// Probe every adjacent pin pair; legs OSRM can't ride on-parkway mark closed spans.
// Union with the official NPS closure list, merge spans separated by pockets < 8 mi.
async function detectClosedSpans(pins) {
  console.log(`  probing ${pins.length - 1} BRP legs for closures (cached after first run)`);
  const badLegs = [];
  for (let i = 0; i < pins.length - 1; i++) {
    const spacing = haversineMi(pins[i][0], pins[i][1], pins[i + 1][0], pins[i + 1][1]);
    let ratio;
    try {
      const leg = await osrmRoute([pins[i], pins[i + 1]], { radiuses: 120 });
      // compare against straight-line: on-parkway legs are ~5 mi for ~3-4 mi crow-flies
      ratio = leg.totalM / 1609.344 / Math.max(spacing, PIN_SPACING_MI * 0.5);
    } catch (e) {
      if (!['NoSegment', 'NoRoute'].includes(e.osrmCode)) throw e;
      ratio = Infinity;
    }
    if (ratio > 2.2) badLegs.push(i);
  }
  // pin i sits at chain mile i*5 — convert bad legs + NPS closures to mile spans
  const spans = badLegs.map((i) => ({
    fromMp: i * PIN_SPACING_MI,
    toMp: (i + 1) * PIN_SPACING_MI,
    note: 'OSM/OSRM reports this section unroutable (likely closed) — verify locally',
  }));
  for (const c of CLOSURES) spans.push({ ...c });
  const merged = mergeSpans(spans);
  for (const m of merged) console.log(`    closed span: MP ${round(m.fromMp, 1)}-${round(m.toMp, 1)} (${m.note})`);
  return merged;
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.fromMp - b.fromMp);
  const merged = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.fromMp - last.toMp < 8) {
      last.toMp = Math.max(last.toMp, s.toMp);
      if (s.note.startsWith('NPS')) last.note = s.note;
    } else merged.push({ ...s });
  }
  return merged;
}

async function stepRoutes() {
  console.log('== step: routes');
  const pinsFile = path.join(CACHE_DIR, 'brp-pins.json');
  if (!fs.existsSync(pinsFile)) await stepRelation();
  const { pins } = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));

  console.log(`  phase A: Fredericksburg -> Rockfish Gap`);
  const A = await osrmRoute([POINTS.fredericksburg, pins[0]]);
  console.log(`    ${round(A.totalM / 1609.344, 1)} mi`);

  let closedSpans = await detectClosedSpans(pins);
  const mpOf = (i) => i * PIN_SPACING_MI;

  // Build the BRP phase; self-heal by widening spans until every long leg is a
  // declared detour (handles rejoin pins that sit on still-closed pavement).
  let B, legAudit, keptIdx;
  for (let iter = 0; iter < 5; iter++) {
    keptIdx = pins
      .map((_, i) => i)
      .filter((i) => !closedSpans.some((s) => mpOf(i) > s.fromMp && mpOf(i) < s.toMp));
    const keptPins = keptIdx.map((i) => pins[i]);
    console.log(`  phase B (pass ${iter + 1}): ${keptPins.length}/${pins.length} pins, radiuses=120`);
    const CHUNK = 48;
    const chunks = [];
    for (let s = 0; s < keptPins.length - 1; s += CHUNK - 1) {
      chunks.push(keptPins.slice(s, Math.min(s + CHUNK, keptPins.length)));
    }
    const bParts = [];
    legAudit = [];
    for (const [ci, chunk] of chunks.entries()) {
      const part = await osrmRoute(chunk, { radiuses: 120 });
      bParts.push(part);
      part.legDistancesM.forEach((m, i) => legAudit.push({ chunk: ci, leg: i, mi: m / 1609.344 }));
      console.log(`    chunk ${ci + 1}/${chunks.length}: ${round(part.totalM / 1609.344, 1)} mi`);
    }
    B = stitch(bParts);

    // Flattened legs map 1:1 onto consecutive kept pins (chunks share joint pins).
    const widen = [];
    legAudit.forEach((l, k) => {
      const a = mpOf(keptIdx[k]), b = mpOf(keptIdx[k + 1]);
      const expected = Math.max(b - a, PIN_SPACING_MI);
      const explained = closedSpans.some(
        (s) => (a >= s.fromMp - 0.1 && b <= s.toMp + 0.1) || (s.fromMp >= a - 0.1 && s.toMp <= b + 0.1)
      );
      if (l.mi > expected * 2.2 && !explained) {
        widen.push({ fromMp: a, toMp: b, note: 'OSM/OSRM unroutable in context — verify locally' });
        console.log(`    widening: leg MP ${a}-${b} rode ${round(l.mi, 1)} mi — treating as closed`);
      }
    });
    if (!widen.length) break;
    closedSpans = mergeSpans([...closedSpans, ...widen]);
  }
  const bTotalMi = B.dists.reduce((s, d) => s + d, 0) / 1609.344;
  const closedMi = closedSpans.reduce((s, c) => s + (c.toMp - c.fromMp), 0);
  console.log(`    BRP segment total: ${round(bTotalMi, 1)} mi (parkway ~469, minus ${round(closedMi, 1)} closed, plus detours)`);

  console.log(`  phase C: Cherokee -> Bryson City -> NC-28 -> Deals Gap -> base camp`);
  const C = await osrmRoute([pins[pins.length - 1], POINTS.brysonCity, POINTS.nc28Stecoah, POINTS.dealsGap, POINTS.baseCamp]);
  console.log(`    ${round(C.totalM / 1609.344, 1)} mi`);

  const out = stitch([A, B, C]);
  const outCum = [0];
  for (const d of out.dists) outCum.push(outCum[outCum.length - 1] + d / 1609.344);
  const jointMiles = out.joints.map((j) => outCum[j]);

  // Entry/exit pins for each closed span and advisory range (chain mile i*5 ≈ MP).
  const detourMarkers = closedSpans.flatMap((s) => {
    const entryI = [...keptIdx].reverse().find((i) => mpOf(i) <= s.fromMp);
    const exitI = keptIdx.find((i) => mpOf(i) >= s.toMp);
    if (entryI == null || exitI == null) return [];
    return [{ entry: pins[entryI], exit: pins[exitI], fromMp: round(s.fromMp, 1), toMp: round(s.toMp, 1), note: s.note }];
  });
  // Advisory endpoints must land on ridden pavement — snap to the nearest kept pin.
  const keptPinAtMp = (mp) => {
    const i = keptIdx.reduce((best, k) => (Math.abs(mpOf(k) - mp) < Math.abs(mpOf(best) - mp) ? k : best), keptIdx[0]);
    return pins[i];
  };
  const advisoryMarkers = ADVISORIES.map((a) => ({
    entry: keptPinAtMp(a.fromMp), exit: keptPinAtMp(a.toMp), fromMp: a.fromMp, toMp: a.toMp, note: a.note,
  }));
  // Anchors sitting on closed pavement would project onto detour roads — drop them.
  const openAnchors = BRP_ANCHORS.filter(
    (a) => !closedSpans.some((s) => a.mp >= s.fromMp - 1 && a.mp <= s.toMp + 1)
  );

  const outJson = await finalizeRoute({
    id: 'out',
    name: 'Outbound — Blue Ridge Parkway',
    coords: out.coords,
    dists: out.dists,
    jointMiles,
    spanMarkers: { detours: detourMarkers, advisories: advisoryMarkers },
    anchors: [
      { name: 'Fredericksburg', lat: POINTS.fredericksburg[0], lon: POINTS.fredericksburg[1] },
      ...openAnchors,
      { name: 'Bryson City', lat: POINTS.brysonCity[0], lon: POINTS.brysonCity[1] },
      { name: 'Deals Gap — Tail of the Dragon', lat: POINTS.dealsGap[0], lon: POINTS.dealsGap[1] },
      { name: 'Base camp — 561 Deals Gap Rd', lat: POINTS.baseCamp[0], lon: POINTS.baseCamp[1] },
    ],
  });

  console.log('  return-fast: base camp -> US-129 -> I-40/I-81/I-64 -> Fredericksburg');
  const R = await osrmRoute([
    POINTS.baseCamp, POINTS.chilhowee, POINTS.maryville, POINTS.knoxville, POINTS.dandridge,
    POINTS.bristol, POINTS.wytheville, POINTS.roanoke, POINTS.staunton, POINTS.charlottesville,
    POINTS.fredericksburg,
  ]);
  console.log(`    ${round(R.totalM / 1609.344, 1)} mi`);
  const retJson = await finalizeRoute({
    id: 'retFast',
    name: 'Return — fastest (I-81)',
    coords: R.coords,
    dists: R.dists,
    jointMiles: null,
    anchors: RETURN_FAST_ANCHORS.map((a) => ({ name: a.name, lat: POINTS[a.key][0], lon: POINTS[a.key][1] })),
  });

  audit(outJson, legAudit);
  return { outJson, retJson };
}

function audit(outJson, legAudit = []) {
  console.log('== audit');
  const brpLen = outJson.brp.endMile - outJson.brp.startMile;
  console.log(`  phases: A=${outJson.brp.startMile} mi, BRP segment=${round(brpLen, 1)} mi, C=${round(outJson.totalMi - outJson.brp.endMile, 1)} mi, total=${outJson.totalMi} mi`);
  let detourMi = 0, closedMi = 0;
  for (const d of outJson.detours || []) {
    detourMi += d.endMile - d.startMile;
    closedMi += d.toMp - d.fromMp;
    console.log(`  detour around MP ${d.fromMp}-${d.toMp}: route mi ${d.startMile}-${d.endMile} (${round(d.endMile - d.startMile, 1)} mi leg) — ${d.note}`);
  }
  console.log(`  parkway closed ~${round(closedMi, 1)} mi, detour legs ${round(detourMi, 1)} mi, BRP segment ${round(brpLen, 1)} mi (469 if fully open)`);

  // Long legs that are NOT explained by a declared detour.
  if (legAudit.length) {
    const longLegs = legAudit.filter((l) => l.mi > PIN_SPACING_MI * 2.2);
    const nDetours = (outJson.detours || []).length;
    console.log(`  long BRP legs: ${longLegs.length} (declared detours: ${nDetours}) ${longLegs.length <= nDetours ? 'PASS' : 'CHECK'}`);
    longLegs.forEach((l) => console.log(`    chunk ${l.chunk} leg ${l.leg}: ${round(l.mi, 1)} mi`));
  }

  // Anchor-gap check: between consecutive milepost anchors with no closure between
  // them, route miles should advance by about the MP gap.
  const inDetour = (mp) => (outJson.detours || []).some((d) => mp >= d.fromMp - 1 && mp <= d.toMp + 1);
  const mps = outJson.anchors.filter((a) => a.brpMp != null && !inDetour(a.brpMp));
  let worst = 0;
  for (let i = 1; i < mps.length; i++) {
    const a = mps[i - 1], b = mps[i];
    const crossesClosure = (outJson.detours || []).some((d) => d.fromMp < b.brpMp && d.toMp > a.brpMp);
    if (crossesClosure) continue;
    const delta = (b.mile - a.mile) - (b.brpMp - a.brpMp);
    if (Math.abs(delta) > 3) console.log(`    ! gap ${a.name} -> ${b.name}: MP gap ${round(b.brpMp - a.brpMp, 1)} vs route gap ${round(b.mile - a.mile, 1)}`);
    worst = Math.max(worst, Math.abs(delta));
  }
  console.log(`  anchor-gap check (closure-free stretches): worst ${round(worst, 2)} mi ${worst <= 3 ? 'PASS' : 'FAIL'}`);
}

// ---------- step: pois ----------

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

async function stepPois() {
  console.log('== step: pois');
  const routes = ['route-outbound.json', 'route-return-fast.json'].map((f) =>
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
  );

  const elements = new Map();
  for (const route of routes) {
    const keepIdx = simplifyIndices(route.coords, 800, Infinity);
    const line = keepIdx.map((i) => route.coords[i]);
    // Small chunks: corridor queries through metro areas (Knoxville, Roanoke)
    // time out when a single around-line covers hundreds of miles.
    const chunks = [];
    for (let s = 0; s < line.length - 1; s += 29) chunks.push(line.slice(s, Math.min(s + 30, line.length)));
    console.log(`  ${route.id}: corridor ${line.length} pts -> ${chunks.length} chunks`);
    for (const [ci, chunk] of chunks.entries()) {
      const LINE = chunk.map((p) => `${p[0]},${p[1]}`).join(',');
      const ql = `[out:json][timeout:180];(
nwr['amenity'='fuel'](around:${CORRIDOR_M},${LINE});
nwr['tourism'~'^(hotel|motel|guest_house|hostel|chalet|camp_site|caravan_site)$'](around:${CORRIDOR_M},${LINE});
nwr['amenity'~'^(restaurant|fast_food|cafe)$'](around:${CORRIDOR_M},${LINE});
);out center qt;`;
      const res = await overpass(ql, `${route.id} chunk ${ci + 1}/${chunks.length}`);
      for (const el of res.elements || []) elements.set(el.type[0] + el.id, el);
      console.log(`    chunk ${ci + 1}/${chunks.length}: ${res.elements?.length ?? 0} elements (running total ${elements.size})`);
    }
  }

  // Project every element onto each route.
  const routeIdx = routes.map((r) => ({ id: r.id, gi: buildGridIndex(r.coords), cum: r.cum }));
  const pois = [];
  for (const [key, el] of elements) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const cat = catFor(el.tags);
    if (!cat) continue;
    const projections = {};
    for (const ri of routeIdx) {
      const pr = projectToRoute(ri.gi, ri.cum, lat, lon, 5);
      if (pr) projections[ri.id] = { m: round(pr.mile, 1), o: round(pr.offMi, 2) };
    }
    if (!Object.keys(projections).length) continue;
    const t = el.tags || {};
    pois.push({
      id: key,
      name: t.name || t.brand || null,
      cat,
      sub: t.tourism || t.amenity || null,
      lat: round(lat, 5), lon: round(lon, 5),
      tags: Object.fromEntries(
        ['brand', 'opening_hours', 'phone', 'website', 'cuisine']
          .filter((k) => t[k]).map((k) => [k, String(t[k]).slice(0, 120)])
      ),
      routes: projections,
    });
  }
  console.log(`  ${pois.length} POIs within 5 mi of a route (from ${elements.size} elements)`);

  // Thin dense buckets so the file stays light; fuel is never thinned.
  const keepIds = new Set();
  for (const ri of routeIdx) {
    const byBucket = new Map();
    for (const p of pois) {
      const pr = p.routes[ri.id];
      if (!pr) continue;
      const bucket = `${p.cat}:${Math.floor(pr.m / 5)}`;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(p);
    }
    for (const [bucket, list] of byBucket) {
      const cat = bucket.split(':')[0];
      let kept = list;
      if (cat !== 'fuel') {
        const cap = cat === 'food' ? 10 : 12;
        kept = list.sort((a, b) =>
          (b.name ? 1 : 0) - (a.name ? 1 : 0) || a.routes[ri.id].o - b.routes[ri.id].o
        ).slice(0, cap);
      }
      kept.forEach((p) => keepIds.add(p.id));
    }
  }
  const finalPois = pois.filter((p) => keepIds.has(p.id));

  const counts = {};
  for (const p of finalPois) counts[p.cat] = (counts[p.cat] || 0) + 1;
  console.log(`  kept ${finalPois.length}:`, counts);
  console.log(`  Deals Gap Motorcycle Resort present: ${finalPois.some((p) => p.id === 'n516981991')}`);

  const file = path.join(DATA_DIR, 'pois.json');
  fs.writeFileSync(file, JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), pois: finalPois }));
  console.log(`  wrote pois.json: ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

// ---------- step: rides (famous named motorcycle roads) ----------

async function stepRides() {
  console.log(`== step: rides (${RIDES.length} curated)`);
  const out = [];
  for (const r of RIDES) {
    const pts = [r.endpointA, ...(r.via || []), r.endpointB].map((p) => [p.lat, p.lon]);
    let route;
    try {
      route = await osrmRoute(pts);
    } catch (e) {
      console.log(`  ! ${r.id}: OSRM failed (${e.osrmCode || e.message}) — skipped`);
      continue;
    }
    const coords = route.coords;
    const cum = [0];
    for (const d of route.dists) cum.push(cum[cum.length - 1] + d / 1609.344);
    const lengthMi = cum[cum.length - 1];
    const mid = pointAtMile({ coords, cum }, lengthMi / 2);
    const keep = simplifyIndices(coords, 10, 400);

    // Sanity: routed length should be near the stated famous length.
    const drift = r.lengthMi ? Math.abs(lengthMi - r.lengthMi) / r.lengthMi : 0;
    const flag = drift > 0.4 ? `  <-- CHECK: routed ${round(lengthMi, 1)} vs stated ${r.lengthMi} mi` : '';

    out.push({
      id: r.id, name: r.name, road: r.road, region: r.region,
      difficulty: r.difficulty, curves: r.curves ?? null,
      lengthMi: round(lengthMi, 1), statedLengthMi: r.lengthMi ?? null,
      blurb: r.blurb, status: r.status || 'Open.',
      currentlyRideable: r.currentlyRideable !== false,
      nearDealsGapMi: r.nearDealsGapMi ?? null,
      a: r.endpointA, b: r.endpointB,
      mid: [round(mid[0], 5), round(mid[1], 5)],
      coords: keep.map((i) => [round(coords[i][0], 5), round(coords[i][1], 5)]),
    });
    console.log(`  ${r.id}: ${round(lengthMi, 1)} mi, ${coords.length}->${keep.length} pts${flag}`);
  }
  out.sort((a, b) => (a.nearDealsGapMi ?? 1e9) - (b.nearDealsGapMi ?? 1e9));
  const file = path.join(DATA_DIR, 'rides.json');
  fs.writeFileSync(file, JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), rides: out }));
  console.log(`  wrote rides.json: ${out.length} rides, ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

// ---------- step: elevation (cheap re-sample of existing route JSON) ----------

async function stepElevation() {
  console.log('== step: elevation');
  for (const f of ['route-outbound.json', 'route-return-fast.json']) {
    const p = path.join(DATA_DIR, f);
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ele = await sampleElevationsFt(r.coords, r.id);
    if (ele.length !== r.coords.length) { console.log(`  ! ${f}: length mismatch — skipped`); continue; }
    r.ele = ele;
    r.eleSource = ELEV_SOURCE;
    fs.writeFileSync(p, JSON.stringify(r));
    const lo = Math.min(...ele), hi = Math.max(...ele);
    console.log(`  ${f}: ${ele.length} elevations, ${lo}–${hi} ft`);
  }
}

// ---------- step: sights (scenic & attraction POIs) ----------

const SIGHT_CATS = ['waterfall', 'viewpoint', 'museum', 'historic', 'attraction', 'park'];

function sightCatFor(tags = {}) {
  const { tourism, historic, natural, waterway, leisure, man_made, boundary } = tags;
  if (natural === 'waterfall' || waterway === 'waterfall') return 'waterfall';
  if (tourism === 'viewpoint') return 'viewpoint';
  if (tourism === 'museum') return 'museum';
  if (historic && !['no', 'tomb', 'boundary_stone', 'milestone'].includes(historic)) return 'historic';
  if (tourism === 'attraction' || tourism === 'artwork' || man_made === 'tower' || man_made === 'lighthouse') return 'attraction';
  if (leisure === 'park' || leisure === 'nature_reserve' || boundary === 'national_park') return 'park';
  return null;
}

async function stepSights() {
  console.log('== step: sights');
  const routes = ['route-outbound.json', 'route-return-fast.json'].map((f) =>
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'))
  );
  const elements = new Map();

  // exact-match historic values (index-backed, fast — regex over the broad
  // `historic` key is what timed out on dense corridor chunks).
  const HISTORIC_VALS = ['memorial', 'monument', 'ruins', 'castle', 'fort', 'battlefield', 'aircraft', 'locomotive', 'ship'];
  // Corridor: only the cheap, high-value scenic tags (no historic — too dense/slow
  // along 600 mi). Node-only; sights render as points.
  const CORRIDOR_QL = (LINE) => `[out:json][timeout:50];(
node['tourism'~'^(viewpoint|attraction|museum)$'](around:${SIGHT_CORRIDOR_M},${LINE});
node['natural'='waterfall'](around:${SIGHT_CORRIDOR_M},${LINE});
);out qt;`;
  // Deals Gap area: the full set incl. historic (one bounded query).
  const BBOX_QL = (BB) => `[out:json][timeout:90];(
node['tourism'~'^(viewpoint|attraction|museum|artwork)$'](${BB});
node['natural'='waterfall'](${BB});
${HISTORIC_VALS.map((v) => `node['historic'='${v}']['name'](${BB});`).join('\n')}
);out qt;`;

  // 1) corridor sweep — small chunks; skip any chunk that won't come back.
  for (const route of routes) {
    const keepIdx = simplifyIndices(route.coords, 800, Infinity);
    const line = keepIdx.map((i) => route.coords[i]);
    const chunks = [];
    for (let s = 0; s < line.length - 1; s += 7) chunks.push(line.slice(s, Math.min(s + 8, line.length)));
    console.log(`  ${route.id}: corridor ${line.length} pts -> ${chunks.length} chunks`);
    for (const [ci, chunk] of chunks.entries()) {
      const LINE = chunk.map((p) => `${p[0]},${p[1]}`).join(',');
      try {
        const res = await overpass(CORRIDOR_QL(LINE), `sights ${route.id} ${ci + 1}/${chunks.length}`, { allowEmpty: true });
        for (const el of res.elements || []) elements.set(el.type[0] + el.id, el);
        console.log(`    chunk ${ci + 1}/${chunks.length}: ${res.elements?.length ?? 0} (total ${elements.size})`);
      } catch (e) {
        console.log(`    chunk ${ci + 1}/${chunks.length}: SKIPPED (${e.message})`);
      }
    }
  }
  // 2) Deals Gap area bbox sweep (off-corridor landmarks + historic)
  const bb = DEALS_GAP_BBOX.join(',');
  try {
    const bres = await overpass(BBOX_QL(bb), 'sights deals-gap bbox', { allowEmpty: true });
    for (const el of bres.elements || []) elements.set(el.type[0] + el.id, el);
    console.log(`  deals-gap bbox: ${bres.elements?.length ?? 0} (total ${elements.size})`);
  } catch (e) {
    console.log(`  deals-gap bbox: SKIPPED (${e.message})`);
  }

  // project + classify
  const routeIdx = routes.map((r) => ({ id: r.id, gi: buildGridIndex(r.coords), cum: r.cum }));
  const baseLat = 35.4688, baseLon = -83.9176;
  const sights = [];
  for (const [key, el] of elements) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const cat = sightCatFor(el.tags);
    if (!cat) continue;
    const t = el.tags || {};
    if ((cat === 'historic' || cat === 'park') && !t.name) continue;
    const routesProj = {};
    for (const ri of routeIdx) {
      const pr = projectToRoute(ri.gi, ri.cum, lat, lon, 5);
      if (pr) routesProj[ri.id] = { m: round(pr.mile, 1), o: round(pr.offMi, 2) };
    }
    const near = haversineMi(lat, lon, baseLat, baseLon);
    const nearDealsGapMi = near <= 30 ? round(near, 1) : null;
    if (!Object.keys(routesProj).length && nearDealsGapMi == null) continue;
    sights.push({
      id: key,
      name: t.name || null,
      cat,
      sub: t.tourism || t.historic || t.natural || t.leisure || cat,
      lat: round(lat, 5), lon: round(lon, 5),
      routes: routesProj,
      nearDealsGapMi,
      tags: Object.fromEntries(
        ['website', 'wikipedia', 'description', 'fee', 'opening_hours']
          .filter((k) => t[k]).map((k) => [k, String(t[k]).slice(0, 200)])
      ),
    });
  }
  // merge curated Deals Gap landmarks (win on proximity dedupe)
  for (const c of DEALS_GAP_SIGHTS) {
    const dup = sights.find((s) => haversineMi(s.lat, s.lon, c.lat, c.lon) < 0.12);
    if (dup) sights.splice(sights.indexOf(dup), 1);
    const routesProj = {};
    for (const ri of routeIdx) {
      const pr = projectToRoute(ri.gi, ri.cum, c.lat, c.lon, 5);
      if (pr) routesProj[ri.id] = { m: round(pr.mile, 1), o: round(pr.offMi, 2) };
    }
    sights.push({ ...c, routes: routesProj, nearDealsGapMi: round(haversineMi(c.lat, c.lon, baseLat, baseLon), 1), tags: c.tags || {} });
  }
  console.log(`  ${sights.length} sights classified`);

  // thin: always keep Deals Gap area; cap corridor buckets by notability
  const anchorPts = BRP_ANCHORS.map((a) => [a.lat, a.lon]);
  const score = (s) => (s.tags?.wikipedia ? 2 : 0) + (s.tags?.website ? 1 : 0) +
    (anchorPts.some((p) => haversineMi(s.lat, s.lon, p[0], p[1]) < 0.5) ? 1 : 0) +
    (String(s.id).startsWith('cur-') ? 5 : 0);
  const keep = new Set();
  for (const c of DEALS_GAP_SIGHTS) keep.add(c.id); // curated landmarks always show
  for (const s of sights) if (s.nearDealsGapMi != null && s.nearDealsGapMi <= 25) keep.add(s.id);
  for (const ri of routeIdx) {
    const buckets = new Map();
    for (const s of sights) {
      const pr = s.routes[ri.id]; if (!pr) continue;
      const b = `${s.cat}:${Math.floor(pr.m / 10)}`;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(s);
    }
    for (const [b, list] of buckets) {
      const cap = b.startsWith('viewpoint') ? 4 : b.startsWith('waterfall') ? 5 : 3;
      list.sort((a, c) => score(c) - score(a) || (c.name ? 1 : 0) - (a.name ? 1 : 0) || a.routes[ri.id].o - c.routes[ri.id].o);
      list.slice(0, cap).forEach((s) => keep.add(s.id));
    }
  }
  const finalSights = sights.filter((s) => keep.has(s.id));
  const counts = {};
  for (const s of finalSights) counts[s.cat] = (counts[s.cat] || 0) + 1;
  console.log(`  kept ${finalSights.length}:`, counts);
  console.log(`  Tree of Shame present: ${finalSights.some((s) => s.id === 'cur-tree-of-shame')}`);

  const file = path.join(DATA_DIR, 'sights.json');
  fs.writeFileSync(file, JSON.stringify({
    builtAt: new Date().toISOString().slice(0, 10),
    source: 'Overpass / OSM corridor · © OpenStreetMap contributors (ODbL)',
    sights: finalSights,
  }));
  console.log(`  wrote sights.json: ${finalSights.length} sights, ${Math.round(fs.statSync(file).size / 1024)} KB`);
}

// ---------- CLI ----------

const args = process.argv.slice(2);
const step = args.includes('--step') ? args[args.indexOf('--step') + 1] : 'all';

try {
  if (step === 'relation' || step === 'all') await stepRelation();
  if (step === 'routes' || step === 'all') await stepRoutes();
  if (step === 'pois' || step === 'all') await stepPois();
  if (step === 'rides' || step === 'all') await stepRides();
  if (step === 'sights' || step === 'all') await stepSights();
  if (step === 'elevation') await stepElevation();
  if (args.includes('--audit') && !['routes', 'all'].includes(step)) {
    audit(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'route-outbound.json'), 'utf8')));
  }
  console.log('done.');
} catch (e) {
  console.error('BUILD FAILED:', e.message);
  process.exit(1);
}
