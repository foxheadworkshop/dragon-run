# 🐉 Dragon Run

Group motorcycle trip planner: **Fredericksburg, VA → Blue Ridge Parkway → Tail of the Dragon (Deals Gap)** and back.

A static web app — no build step, no API keys. Move three sliders (fuel range, saddle hours, average pace) and the plan recomputes live: riding days, overnight stops, fuel windows, lunch stops, with real hotels / gas stations / restaurants / campgrounds along the route to pick from and vote on with your riding group.

## Features

- **Route** pinned to the parkway using the BRP's own OpenStreetMap geometry (relation 55450), with **real NPS closures** (Hurricane Helene damage and construction, June 2026) detoured and flagged on the map — about 89 of the parkway's 469 miles are currently closed.
- **Sliders** → instant recompute. Example: 130 mi/tank, 8 h/day, 45 mph → ~360 mi/day, 2 riding days each way.
- **Fuel windows** shaded on the map: fill up anywhere in the amber band and the next band shifts accordingly. Pick a specific station and everything downstream recalculates.
- **Overnight + lunch suggestions** with alternates, ETAs, and off-route distance (gas on the parkway means a short detour into town — the app shows how far).
- **Group mode**: share one link; everyone sees the same plan live, votes 👍 on stops, claims picks, and shows up in the riders list. Powered by Firebase (free tier) — without it the app still works solo with snapshot share links.
- **Legendary rides layer**: 20 famous named motorcycle roads near the trip (Tail of the Dragon, Cherohala Skyway, Moonshiner 28, Devil's Triangle, The Snake, Back of the Dragon, North Georgia's Six Gap, and more) drawn as highlighted magenta lines with a browsable list — each with length, curve count, difficulty, a vivid blurb, and **current 2026 status** (Hurricane Helene closures researched and verified per road). Tap a ride to fly to it; rides also export as their own GPX tracks. Sorted by distance from base camp. Data lives in `data/rides.json`, built from `scripts/rides.mjs` via `--step rides`.
- **Sunrise/sunset per riding day** (computed locally — no API) with smart after-dark arrival warnings based on the actual sunset where that day ends, not a fixed clock time.
- **Weather along the route**: National Weather Service forecasts (free, no key) sampled at each day's departure / midpoint / arrival — temperature, precip chance, conditions — plus a toggleable **live NEXRAD radar overlay** on the map (Iowa Environmental Mesonet tiles).
- **GPX export** (route track + chosen stops) for Garmin / REVER / OsmAnd — cell service at Deals Gap is famously nonexistent.
- **Offline-friendly**: route and places data are baked in; Firestore queues writes offline and syncs later.

## Run locally

```powershell
cd dragon-run
npx serve .          # or: python -m http.server 8000
```

Open the printed URL. (Opening `index.html` directly via `file://` mostly works, but a local server is more faithful.)

## Tests

```powershell
node --test scripts/engine.test.mjs
```

## Rebuild route & places data

Data snapshots live in `data/` and are committed. To refresh (new closures, new businesses):

```powershell
node scripts/build-data.mjs --step all     # relation -> routes -> pois -> rides, with audits
```

Famous rides are curated in `scripts/rides.mjs` (name, road, stats, status, and endpoint coords) and OSRM-routed to real geometry by `--step rides`. The build prints a length-drift CHECK if a routed ride is wildly longer than its stated length — usually a sign an endpoint snapped to the wrong road. Verify suspect rides by routing the endpoints (a detour factor of routed÷straight-line above ~3 on a point-to-point ride means it left its road).

The builder probes every 5-mile parkway leg against OSRM, merges unroutable legs with the official NPS closure list (`scripts/waypoints.mjs` → `CLOSURES` — update these from [nps.gov road closures](https://www.nps.gov/blri/planyourvisit/roadclosures.htm)), and self-heals until every long leg is a declared detour. Responses are cached in `scripts/.cache/`.

After rebuilding, bump `DATA_V` in `js/app.js` so the GitHub Pages CDN serves the new files.

## Turn on live group sync (one-time, ~5 minutes)

The app runs in local mode until a Firebase project exists. To enable live sync:

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it `dragon-run` → turn **off** Google Analytics → Create.
2. Build → **Authentication** → Get started → Sign-in method → enable **Anonymous** → Save.
3. Authentication → Settings → **Authorized domains** → Add `foxheadworkshop.github.io` (and `localhost` is already there).
4. Build → **Firestore Database** → Create database → **Production mode** → location `nam5 (United States)` → Enable.
5. Firestore → **Rules** tab → replace everything with the rules below → **Publish**.
6. Project settings (gear) → Your apps → **Web** (`</>`) → nickname `dragon-run` → don't tick hosting → Register → copy the `firebaseConfig = { ... }` object.
7. Paste that object into `js/firebase-config.js` (replace `export default null` with `export default { ... }`), commit, push.

### Firestore security rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /trips/{tripId} {
      allow get: if request.auth != null;
      allow list: if false;
      allow create, update: if request.auth != null
        && request.resource.data.keys().hasOnly(['meta', 'config', 'picks']);
      allow delete: if false;

      match /votes/{voteId} {
        allow read: if request.auth != null;
        allow create, update: if request.auth != null
          && voteId.matches('.*_' + request.auth.uid)
          && request.resource.data.keys().hasOnly(['poiId', 'uid', 'at', 'name'])
          && request.resource.data.uid == request.auth.uid;
        allow delete: if request.auth != null && voteId.matches('.*_' + request.auth.uid);
      }

      match /riders/{uid} {
        allow read: if request.auth != null;
        allow write: if request.auth != null && request.auth.uid == uid
          && request.resource.data.keys().hasOnly(['name', 'color', 'lastSeen'])
          && request.resource.data.name is string
          && request.resource.data.name.size() <= 40;
      }
    }
  }
}
```

Trips are reachable only by their unguessable 16-character id (the `#t=` link) — `list` is denied, so nobody can enumerate trips. Anyone with the link can edit the plan; votes and presence are writable only by their owner.

## Data & licenses

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Routing by [OSRM](https://project-osrm.org) (demo server, build-time only). Places via [Overpass API](https://overpass-api.de).
- Parkway closure info: [NPS Blue Ridge Parkway road status](https://www.nps.gov/blri/planyourvisit/roadclosures.htm). **Always obey posted signs and barricades** — conditions change; this app is a planning aid, not ground truth.
