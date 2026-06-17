// Scenic & attraction "sights" — baked static data, a view-only map layer
// (not engine stops). Mirrors js/rides.js.

export async function loadSights(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { sights: [] };
    return await res.json();
  } catch {
    return { sights: [] };
  }
}

export const SIGHT_CATS = ['waterfall', 'viewpoint', 'museum', 'historic', 'attraction', 'park'];

export const SIGHT_LABEL = {
  waterfall: 'Waterfall', viewpoint: 'Overlook', museum: 'Museum',
  historic: 'Historic', attraction: 'Attraction', park: 'Park',
};

export const SIGHT_GLYPHS = {
  waterfall: '<svg viewBox="0 0 24 24"><path d="M7 2v6c0 1 .5 2 1 3-1 1-1.5 2.2-1.5 3.5C6.5 17 8 19 8 21h2c0-2-1.5-4-1.5-6.5 0-1 .5-1.8 1.5-2.5 1 .7 1.5 1.5 1.5 2.5C11.5 17 10 19 10 21h2c0-2 1.5-4 1.5-6.5 0-1.3-.5-2.5-1.5-3.5.5-1 1-2 1-3V2H7z"/></svg>',
  viewpoint: '<svg viewBox="0 0 24 24"><path d="M12 5C6.5 5 2 12 2 12s4.5 7 10 7 10-7 10-7-4.5-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8zm0-6a2 2 0 100 4 2 2 0 000-4z"/></svg>',
  museum: '<svg viewBox="0 0 24 24"><path d="M12 2 2 7v2h20V7L12 2zM4 10v8H2v2h20v-2h-2v-8h-2v8h-3v-8h-2v8H8v-8H6v8H4v-8H4z"/></svg>',
  historic: '<svg viewBox="0 0 24 24"><path d="M4 21V10l8-6 8 6v11h-5v-7H9v7H4z"/></svg>',
  attraction: '<svg viewBox="0 0 24 24"><path d="m12 2 3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9 12 2z"/></svg>',
  park: '<svg viewBox="0 0 24 24"><path d="M12 2 5 13h4v3l-2 5h10l-2-5v-3h4L12 2z"/></svg>',
};

// Build the route-filtered, along-route-sorted sight list for a route (handles
// the reversed BRP return by mirroring miles, exactly like POIs).
export function indexSights(sightSet, route) {
  const key = route.reversedFrom || route.id;
  const reversed = !!route.reversedFrom;
  const total = route.cum[route.cum.length - 1];
  const out = [];
  for (const s of sightSet.sights || []) {
    const pr = s.routes?.[key];
    if (!pr) continue;
    const m = reversed ? Math.max(0, total - pr.m) : pr.m;
    out.push({ s, m: Math.round(m * 10) / 10, o: pr.o });
  }
  out.sort((a, b) => a.m - b.m);
  return out;
}
