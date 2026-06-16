// Famous named motorcycle rides — loaded from the baked rides.json snapshot.

export async function loadRides(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { rides: [] };
    return await res.json();
  } catch {
    return { rides: [] };
  }
}

export const DIFF_LABEL = { easy: 'Easy', moderate: 'Moderate', challenging: 'Challenging', expert: 'Expert' };
export const DIFF_COLOR = { easy: '#58c98a', moderate: '#9ccc65', challenging: '#ffb02e', expert: '#ff5d3b' };

// Straight-line miles from the base camp at Deals Gap, for sorting "what's near".
export function milesFromBase(ride, baseLat = 35.4688, baseLon = -83.9176) {
  const m = ride.mid || (ride.coords && ride.coords[Math.floor(ride.coords.length / 2)]);
  if (!m) return ride.nearDealsGapMi ?? Infinity;
  const R = 3958.76, DEG = Math.PI / 180;
  const dLat = (m[0] - baseLat) * DEG, dLon = (m[1] - baseLon) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(baseLat * DEG) * Math.cos(m[0] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
