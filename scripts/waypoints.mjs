// Landmark anchors along the Blue Ridge Parkway (milepost, name, approximate coords).
// Used for MP labels in the app, leg-audit checkpoints, and as fallback routing pins
// if the OSM relation stitch ever fails. Coordinates are best-effort and get snapped
// to the route geometry — never used directly as OSRM waypoints.

export const BRP_ANCHORS = [
  { mp: 0,     name: 'Rockfish Gap (Afton)',            lat: 38.0290, lon: -78.8575 },
  { mp: 5.8,   name: 'Humpback Rocks',                  lat: 37.9690, lon: -78.8990 },
  { mp: 63.8,  name: 'James River Visitor Center',      lat: 37.5575, lon: -79.3654 },
  { mp: 86,    name: 'Peaks of Otter',                  lat: 37.4445, lon: -79.6080 },
  { mp: 120.4, name: 'Roanoke Mountain',                lat: 37.2280, lon: -79.9320 },
  { mp: 176.1, name: 'Mabry Mill',                      lat: 36.7507, lon: -80.4036 },
  { mp: 199.4, name: 'Fancy Gap (US-52)',               lat: 36.6637, lon: -80.7034 },
  { mp: 217.5, name: 'Cumberland Knob (VA/NC line)',    lat: 36.5540, lon: -80.9070 },
  { mp: 238.5, name: 'Doughton Park',                   lat: 36.4380, lon: -81.1790 },
  { mp: 272,   name: 'E.B. Jeffress Park',              lat: 36.2480, lon: -81.4530 },
  { mp: 291.9, name: 'Blowing Rock (US-221/321)',       lat: 36.1450, lon: -81.6850 },
  { mp: 304.4, name: 'Linn Cove Viaduct',               lat: 36.0936, lon: -81.8117 },
  { mp: 316.4, name: 'Linville Falls',                  lat: 35.9547, lon: -81.9276 },
  { mp: 331,   name: 'Museum of NC Minerals',           lat: 35.9094, lon: -82.0517 },
  { mp: 355.4, name: 'Mount Mitchell entrance',         lat: 35.7440, lon: -82.2740 },
  { mp: 364.6, name: 'Craggy Gardens',                  lat: 35.6995, lon: -82.3795 },
  { mp: 382,   name: 'Folk Art Center (Asheville)',     lat: 35.6253, lon: -82.4905 },
  { mp: 408.6, name: 'Mount Pisgah',                    lat: 35.4030, lon: -82.7510 },
  { mp: 422.4, name: "Devil's Courthouse",              lat: 35.3060, lon: -82.8990 },
  { mp: 431,   name: 'Richland Balsam (highest point)', lat: 35.3680, lon: -82.9900 },
  { mp: 451.2, name: 'Waterrock Knob',                  lat: 35.4604, lon: -83.1407 },
  { mp: 469.1, name: 'Southern terminus (Cherokee)',    lat: 35.5030, lon: -83.3055 },
];

// Fixed route endpoints / connector pins ([lat, lon]).
export const POINTS = {
  fredericksburg: [38.3032, -77.4605],
  brysonCity:     [35.4279, -83.4470],
  nc28Stecoah:    [35.4338, -83.8137],
  dealsGap:       [35.4661, -83.9220],
  // 561 Deals Gap Rd, Robbinsville NC 28771 — the group's rented base camp
  // (US Census geocoder match, overlooks Cheoah Lake ~0.5 mi from the junction)
  baseCamp:       [35.46879, -83.91759],
  // return-fast pins (US-129 N → I-40 → I-81 → I-64)
  chilhowee:      [35.5560, -84.0210],
  maryville:      [35.7565, -83.9705],
  knoxville:      [35.9606, -83.9207],
  dandridge:      [36.0103, -83.2502],
  bristol:        [36.5951, -82.1887],
  wytheville:     [36.9485, -81.0848],
  roanoke:        [37.2710, -79.9414],
  staunton:       [38.1496, -79.0717],
  charlottesville:[38.0293, -78.4767],
};

// Official NPS full closures as of 2026-06-10
// (https://www.nps.gov/blri/planyourvisit/roadclosures.htm). The 294.6–296.4 and
// 298.5–305.1 project closures are merged across their 2-mile open pocket — no
// point riding in and back out. Empirical OSRM probing may add more spans.
export const CLOSURES = [
  { fromMp: 105.8, toMp: 112.4, note: 'NPS: road construction — trail use only' },
  { fromMp: 294.6, toMp: 305.1, note: 'NPS: Cone Manor / Rough Ridge–Linn Cove projects, signed detour' },
  // Helene core closure is MP 317.5–355.3, but the open Craggy stretch beyond it
  // (MP 365–382) is a dead-end spur only reachable from Asheville — a through-ride
  // rejoins the parkway at Asheville, so the through-route treats the whole span
  // as a detour. Riders can still do Craggy as an out-and-back from town.
  { fromMp: 317.5, toMp: 382, note: 'NPS: Hurricane Helene closures (MP 317.5–355.3) — through-route rejoins at Asheville. Open Craggy Gardens stretch (MP 365–382) is an out-and-back side trip.' },
  { fromMp: 421, toMp: 423.2, note: 'NPS: Devil’s Courthouse landslide — long-term closure' },
];

export const ADVISORIES = [];

export const RETURN_FAST_ANCHORS = [
  { name: 'Base camp — 561 Deals Gap Rd', key: 'baseCamp' },
  { name: 'Deals Gap',       key: 'dealsGap' },
  { name: 'Maryville',       key: 'maryville' },
  { name: 'Knoxville',       key: 'knoxville' },
  { name: 'Bristol',         key: 'bristol' },
  { name: 'Wytheville',      key: 'wytheville' },
  { name: 'Roanoke',         key: 'roanoke' },
  { name: 'Staunton',        key: 'staunton' },
  { name: 'Charlottesville', key: 'charlottesville' },
  { name: 'Fredericksburg',  key: 'fredericksburg' },
];
