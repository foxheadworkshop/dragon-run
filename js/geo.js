// Pure geometry helpers shared by scripts/build-data.mjs (Node) and the app (browser).
// Distances are statute miles unless suffixed M (meters). Coords are [lat, lon].

const R_MI = 3958.7613;
const DEG = Math.PI / 180;
const MI_PER_DEG_LAT = 69.0934;

export function haversineMi(latA, lonA, latB, lonB) {
  const dLat = (latB - latA) * DEG;
  const dLon = (lonB - lonA) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * DEG) * Math.cos(latB * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function cumulativeMiles(coords) {
  const cum = new Array(coords.length);
  cum[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversineMi(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return cum;
}

// First index i where arr[i] >= x. arr ascending. Returns arr.length if all < x.
export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// route: { coords, cum }. Returns interpolated [lat, lon] at the given mile.
export function pointAtMile(route, mi) {
  const { coords, cum } = route;
  const total = cum[cum.length - 1];
  if (mi <= 0) return coords[0].slice();
  if (mi >= total) return coords[coords.length - 1].slice();
  let i = lowerBound(cum, mi);
  if (cum[i] === mi) return coords[i].slice();
  i = Math.max(1, i);
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (mi - cum[i - 1]) / span : 0;
  const [aLat, aLon] = coords[i - 1];
  const [bLat, bLon] = coords[i];
  return [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t];
}

// Per-span elevation summary from the parallel cum/ele arrays. Returns
// { minFt, maxFt, startFt, endFt, gainFt, points:[[mile,ft]] } or null.
export function elevationForSpan(route, mi0, mi1) {
  const { cum, ele } = route;
  if (!ele || !cum || ele.length !== cum.length) return null;
  const total = cum[cum.length - 1];
  mi0 = Math.max(0, Math.min(mi0, total));
  mi1 = Math.max(mi0, Math.min(mi1, total));
  const eleAtMile = (mi) => {
    if (mi <= 0) return ele[0];
    if (mi >= total) return ele[ele.length - 1];
    let i = lowerBound(cum, mi);
    if (cum[i] === mi) return ele[i];
    i = Math.max(1, i);
    const span = cum[i] - cum[i - 1];
    const t = span > 0 ? (mi - cum[i - 1]) / span : 0;
    return ele[i - 1] + (ele[i] - ele[i - 1]) * t;
  };
  const pts = [[mi0, eleAtMile(mi0)]];
  let i = lowerBound(cum, mi0);
  if (cum[i] === mi0) i++;
  for (; i < cum.length && cum[i] < mi1; i++) pts.push([cum[i], ele[i]]);
  pts.push([mi1, eleAtMile(mi1)]);
  if (pts.length < 2) return null;
  let minFt = Infinity, maxFt = -Infinity;
  for (const [, ft] of pts) { if (ft < minFt) minFt = ft; if (ft > maxFt) maxFt = ft; }
  // Cumulative climb with a hysteresis filter so 10-m DEM jitter between adjacent
  // sample points doesn't accumulate into a wildly inflated "gain".
  const THRESH = 40; // ft
  let gainFt = 0, ref = pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const ft = pts[k][1];
    if (ft >= ref + THRESH) { gainFt += ft - ref; ref = ft; }
    else if (ft < ref) { ref = ft; }
  }
  return {
    minFt: Math.round(minFt), maxFt: Math.round(maxFt),
    startFt: Math.round(pts[0][1]), endFt: Math.round(pts[pts.length - 1][1]),
    gainFt: Math.round(gainFt), points: pts,
  };
}

// Coords between two mile marks, with interpolated endpoints. mi0 < mi1.
export function sliceCoords(route, mi0, mi1) {
  const { coords, cum } = route;
  const total = cum[cum.length - 1];
  mi0 = Math.max(0, Math.min(mi0, total));
  mi1 = Math.max(mi0, Math.min(mi1, total));
  const out = [pointAtMile(route, mi0)];
  let i = lowerBound(cum, mi0);
  if (cum[i] === mi0) i++;
  for (; i < coords.length && cum[i] < mi1; i++) out.push(coords[i]);
  out.push(pointAtMile(route, mi1));
  return out;
}

// --- point-to-segment distance in a local flat frame (fine for offsets <= ~20 mi) ---

function pointSegDist(plat, plon, aLat, aLon, bLat, bLon) {
  const cosLat = Math.cos(plat * DEG);
  const ax = (aLon - plon) * cosLat * MI_PER_DEG_LAT;
  const ay = (aLat - plat) * MI_PER_DEG_LAT;
  const bx = (bLon - plon) * cosLat * MI_PER_DEG_LAT;
  const by = (bLat - plat) * MI_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  return { distMi: Math.sqrt(cx * cx + cy * cy), t };
}

// --- spatial grid over route segments, for fast nearest-point projection ---

export function buildGridIndex(coords, cellDeg = 0.05) {
  const cells = new Map(); // "ix|iy" -> segment index array
  for (let i = 0; i < coords.length - 1; i++) {
    const x0 = Math.floor(Math.min(coords[i][1], coords[i + 1][1]) / cellDeg);
    const x1 = Math.floor(Math.max(coords[i][1], coords[i + 1][1]) / cellDeg);
    const y0 = Math.floor(Math.min(coords[i][0], coords[i + 1][0]) / cellDeg);
    const y1 = Math.floor(Math.max(coords[i][0], coords[i + 1][0]) / cellDeg);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x + '|' + y;
        let arr = cells.get(key);
        if (!arr) cells.set(key, arr = []);
        arr.push(i);
      }
    }
  }
  return { cells, cellDeg, coords };
}

// Nearest point on the route to (lat, lon) within maxOffMi. Returns {mile, offMi} or null.
export function projectToRoute(idx, cum, lat, lon, maxOffMi = 5) {
  const { cells, cellDeg, coords } = idx;
  // Smallest cell dimension is longitude-scaled; size the search ring accordingly.
  const cellMi = cellDeg * MI_PER_DEG_LAT * Math.min(1, Math.cos(lat * DEG));
  const r = Math.max(1, Math.ceil(maxOffMi / cellMi));
  const cx = Math.floor(lon / cellDeg), cy = Math.floor(lat / cellDeg);
  const seen = new Set();
  let best = null;
  for (let x = cx - r; x <= cx + r; x++) {
    for (let y = cy - r; y <= cy + r; y++) {
      const segs = cells.get(x + '|' + y);
      if (!segs) continue;
      for (const i of segs) {
        if (seen.has(i)) continue;
        seen.add(i);
        const a = coords[i], b = coords[i + 1];
        const { distMi, t } = pointSegDist(lat, lon, a[0], a[1], b[0], b[1]);
        if (!best || distMi < best.distMi) best = { distMi, i, t };
      }
    }
  }
  if (!best || best.distMi > maxOffMi) return null;
  const mile = cum[best.i] + (cum[best.i + 1] - cum[best.i]) * best.t;
  return { mile, offMi: best.distMi };
}

// --- Douglas-Peucker simplification returning kept indices (always 0 and last) ---

function perpDistM(p, a, b) {
  // meters from p to chord a-b, local equirectangular
  const latRef = p[0] * DEG;
  const mPerDegLat = 111132;
  const mPerDegLon = 111320 * Math.cos(latRef);
  const ax = (a[1] - p[1]) * mPerDegLon, ay = (a[0] - p[0]) * mPerDegLat;
  const bx = (b[1] - p[1]) * mPerDegLon, by = (b[0] - p[0]) * mPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt(ax * ax + ay * ay);
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.sqrt(cx * cx + cy * cy);
}

export function simplifyIndices(coords, toleranceM, maxGapM = Infinity) {
  const n = coords.length;
  if (n <= 2) return coords.map((_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;
    let maxD = -1, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistM(coords[i], coords[s], coords[e]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > toleranceM) {
      keep[maxI] = 1;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  // Cap the along-line gap between kept points so interpolation stays accurate.
  if (maxGapM < Infinity) {
    const M_PER_MI = 1609.344;
    let last = 0, accM = 0;
    for (let i = 1; i < n; i++) {
      accM += haversineMi(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]) * M_PER_MI;
      if (keep[i]) { last = i; accM = 0; continue; }
      if (accM > maxGapM) { keep[i] = 1; last = i; accM = 0; }
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
