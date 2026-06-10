// Route loading, reversal, and BRP milepost mapping.

export async function loadRoute(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  return res.json();
}

// Mirror a route end-for-end. POI projections are mirrored in poi.js the same way.
export function reverseRoute(route, name) {
  const n = route.coords.length;
  const total = route.cum[n - 1];
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    id: route.id + 'Rev',
    reversedFrom: route.id,
    name: name || `Return — ${route.name.replace(/^Outbound — /, '')}`,
    totalMi: route.totalMi,
    builtAt: route.builtAt,
    coords: [...route.coords].reverse(),
    cum: route.cum.map((c) => total - c).reverse(),
    brp: route.brp
      ? { startMile: r1(total - route.brp.endMile), endMile: r1(total - route.brp.startMile) }
      : null,
    anchors: route.anchors.map((a) => ({ ...a, mile: r1(total - a.mile) })).reverse(),
  };
}

// Route mile -> official BRP milepost, piecewise-linear through the milepost anchors.
// Works for reversed routes too (anchors stay (mile asc, MP desc) and lerp doesn't care).
export function mileToBrpMp(route, mile) {
  if (!route.brp) return null;
  if (mile < route.brp.startMile - 1.5 || mile > route.brp.endMile + 1.5) return null;
  const pts = route.anchors.filter((a) => a.brpMp != null);
  if (pts.length < 2) return null;
  if (mile <= pts[0].mile) return pts[0].brpMp;
  for (let i = 1; i < pts.length; i++) {
    if (mile <= pts[i].mile) {
      const span = pts[i].mile - pts[i - 1].mile;
      const t = span > 0 ? (mile - pts[i - 1].mile) / span : 0;
      return pts[i - 1].brpMp + (pts[i].brpMp - pts[i - 1].brpMp) * t;
    }
  }
  return pts[pts.length - 1].brpMp;
}
