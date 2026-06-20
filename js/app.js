// Bootstrap + orchestration. The only module with side effects at import time.

import { createStore, normalizePicks, normalizeExpenses, normalizeProgress, ensureSelfInRoster, effectiveFuelRange, riderColor, randomId } from './state.js';
import { loadRoute, reverseRoute, mileToBrpMp } from './route.js';
import { loadRides, DIFF_LABEL, milesFromBase } from './rides.js';
import { loadSights, indexSights, SIGHT_LABEL } from './sights.js';
import { loadPois, indexForRoute, refreshFromOverpass, CAT_LABEL, CATS, TIER_LABEL } from './poi.js';
import { computePlan, classifyPoiSlot, minToTime } from './engine.js';
import { rosterFor, computeBalances, simplifyDebts } from './split.js';
import { createMap } from './map.js';
import { createUI, showToast } from './ui.js';
import { createLocator } from './locate.js';
import { createSync } from './sync.js';
import { encodeStateHash, decodeHash } from './share.js';
import { buildGpx, downloadGpx } from './gpx.js';
import { buildGridIndex, projectToRoute, pointAtMile, elevationForSpan, bearingDeg, compass16 } from './geo.js';
import { sunTimes } from './sun.js';
import { dayWeather } from './weather.js';
import { initPwa } from './pwa.js';

const DATA_V = '2026-06-20-1'; // bumped on data redeploys to bust the Pages CDN cache
const HIGH_FT = 4500;          // elevation that triggers the cold/fog "pack layers" warning

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#eee;background:#14171d;height:100vh">
    <h2>Dragon Run failed to start</h2><p>${String(e.message || e)}</p>
    <p>Check your connection and reload.</p></div>`;
});

async function boot() {
  const hash = await decodeHash(location.hash);
  const store = createStore();
  const S = store.state;

  if (hash?.state) {
    Object.assign(S.cfg, hash.state.cfg || {});
    Object.assign(S.toggles, hash.state.toggles || {});
    S.picks = normalizePicks(hash.state.picks);
    showToast('Loaded a shared plan');
  }
  if (hash?.tripId) S.tripId = hash.tripId;

  const [outRoute, retFastRoute, poiSet, rideSet, sightSet] = await Promise.all([
    loadRoute(`./data/route-outbound.json?v=${DATA_V}`),
    loadRoute(`./data/route-return-fast.json?v=${DATA_V}`),
    loadPois(`./data/pois.json?v=${DATA_V}`),
    loadRides(`./data/rides.json?v=${DATA_V}`),
    loadSights(`./data/sights.json?v=${DATA_V}`),
  ]);
  const rides = (rideSet.rides || []).sort((a, b) => milesFromBase(a) - milesFromBase(b));
  const rideById = new Map(rides.map((r) => [r.id, r]));
  const sightById = new Map((sightSet.sights || []).map((s) => [s.id, s]));
  const sightCache = new Map();
  const sightsFor = (rk) => sightCache.has(rk) ? sightCache.get(rk) : sightCache.set(rk, indexSights(sightSet, routes[rk])).get(rk);
  const routes = {
    out: outRoute,
    retBrp: reverseRoute(outRoute, 'Return — Blue Ridge Parkway'),
    retFast: retFastRoute,
  };

  let idxCache = new Map();
  const idxFor = (rk) => {
    if (!idxCache.has(rk)) idxCache.set(rk, indexForRoute(poiSet, routes[rk]));
    return idxCache.get(rk);
  };
  const routeGrids = new Map();
  const gridFor = (rk) => {
    if (!routeGrids.has(rk)) routeGrids.set(rk, buildGridIndex(routes[rk].coords));
    return routeGrids.get(rk);
  };

  let current = { plan: null, idx: null, route: null, rk: null };
  let sync = null;
  let applyingRemote = false;

  // ---------- map ----------

  const mapApi = createMap(document.getElementById('map'), {
    popupHtml: (entry) => popupHtml(entry),
    onPopupAction: (act, poiId) => {
      if (act === 'vote') void toggleVote(poiId);
      else if (act === 'pick') applyPickToggle(poiId);
      mapApi.refreshOpenPopup();
    },
    ridePopupHtml: (ride) => ridePopupHtml(ride),
    sightPopupHtml: (s) => sightPopupHtml(s),
    onLocate: () => onLocate(),
    onAheadStep: (dir) => stepAhead(dir),
    onAheadFocus: () => { if (loc.point) mapApi.focusAhead(loc.point); },
    onFrameRoute: () => frameMeAndRoute(),
    onMapDrag: () => {
      // A manual pan opts out of follow — including during acquisition, so the first
      // fix doesn't yank the viewport back to the dot.
      if (loc.state === 'follow') { loc.state = 'on'; loc.follow = false; mapApi.setLocateState('on'); }
      else if (loc.state === 'locating') { loc.follow = false; }
    },
  });

  // ---------- live location & "ride ahead" ----------
  // All ephemeral (never persisted/synced): a GPS fix, the locate button's state,
  // the projected forward point, and the chosen look-ahead duration.
  const AHEAD_STEPS = [30, 45, 60, 90, 120, 180, 240, 300]; // minutes (up to 5 h)
  const REJOIN_OFF_MI = 1.5; // show the "rejoin the route" connector once you're this far off the line
  const LOC_ERR = {
    denied: 'Location permission denied — enable it in your browser to see yourself.',
    unavailable: "Couldn't get a location fix — no GPS signal?",
    timeout: 'Location is taking a while — still trying…',
    unsupported: "This device can't share its location.",
    insecure: 'Live location needs the https site (it won\'t work opening the file directly).',
  };
  const loc = { fix: null, state: 'off', follow: false, min: 60, point: null, targetMile: null, errToast: false, rejoin: null };

  const locator = createLocator({
    onUpdate(fix) {
      loc.fix = fix;
      mapApi.setUserLocation(fix, { follow: loc.follow });
      if (loc.state === 'locating') loc.state = loc.follow ? 'follow' : 'on';
      mapApi.setLocateState(loc.state);
      updateAhead();
    },
    onError(e) {
      // PERMISSION_DENIED (and unsupported/insecure) are permanent — tear the watch down
      // so a later tap starts a fresh one instead of hitting watchPosition's no-op guard.
      // POSITION_UNAVAILABLE / TIMEOUT can be transient: keep the watch alive (it may still
      // deliver a fix) and keep the button in 'locating' so a second tap cancels it cleanly.
      if (e.code === 'denied' || e.code === 'unsupported' || e.code === 'insecure') resetLocate();
      if (e.code !== 'timeout' && !loc.errToast) { showToast(LOC_ERR[e.code] || 'Location unavailable'); loc.errToast = true; }
    },
  });

  // Full teardown: stop the watch and reset all locate/ahead state + UI.
  function resetLocate() {
    locator.stop();
    loc.fix = null; loc.follow = false; loc.state = 'off'; loc.point = null; loc.targetMile = null; loc.rejoin = null;
    mapApi.setLocateState('off');
    mapApi.clearUserLocation();
    mapApi.setAhead({ visible: false });
    mapApi.setRejoin(null);
    ui.renderAhead(null);
  }

  function onLocate() {
    if (loc.state === 'off') {
      loc.follow = true; loc.state = 'locating'; loc.errToast = false;
      mapApi.setLocateState('locating');
      showToast('Finding you…');
      if (!locator.start()) { loc.state = 'off'; mapApi.setLocateState('off'); }
    } else if (loc.state === 'follow') {
      loc.follow = false; loc.state = 'on'; mapApi.setLocateState('on'); // stop chasing, keep the dot
    } else { // 'on' or 'locating' → turn off
      resetLocate();
    }
  }

  function stepAhead(dir) {
    let i = AHEAD_STEPS.indexOf(loc.min);
    if (i < 0) i = 2;
    loc.min = AHEAD_STEPS[Math.max(0, Math.min(AHEAD_STEPS.length - 1, i + dir))];
    updateAhead();
  }

  // "Frame me + route" is an explicit "show me the whole route" action, so it must opt out
  // of follow — otherwise the next GPS fix recenters on the dot and the frame snaps back.
  function frameMeAndRoute() {
    if (loc.state === 'follow') { loc.state = 'on'; mapApi.setLocateState('on'); }
    loc.follow = false;
    mapApi.frameMeAndRoute(loc.fix, current.route);
  }

  // Project the GPS fix onto the active route, ride forward avgMph × duration, and
  // gather the nearest stops (in the toggled-on categories) around that point.
  function updateAhead() {
    if (loc.state === 'off' || !loc.fix || !current.route) { loc.point = null; loc.rejoin = null; mapApi.setRejoin(null); ui.renderAhead(null); return; }
    const { route, rk, idx } = current;
    const total = route.cum[route.cum.length - 1];
    // On-route fixes snap within a mile or two; allow up to 20 mi (a parallel road /
    // a fuel detour into town) and still project. Beyond that, treat as "not near this
    // route" — most likely the wrong direction tab is selected.
    const pr = projectToRoute(gridFor(rk), route.cum, loc.fix.lat, loc.fix.lon, 8)
      || projectToRoute(gridFor(rk), route.cum, loc.fix.lat, loc.fix.lon, 20);
    if (!pr) {
      loc.point = null; loc.rejoin = null;
      mapApi.setAhead({ visible: false, minutes: loc.min, note: 'not near route' });
      mapApi.setRejoin(null);
      ui.renderAhead({ tracking: true, min: loc.min, offRoute: true, note: "You're not near the planned route — make sure the right direction (Outbound / Return) is selected, or get closer." });
      return;
    }
    const offRoute = pr.offMi > 8;
    // Rejoin connector: nearest point on the route + bearing/distance. Shown whenever the
    // rider is more than REJOIN_OFF_MI off the line (decoupled from the 8-mi off-route gate,
    // so the 2-8 mi "I pulled off to a hotel" case actually gets guidance).
    const rejoinPt = pointAtMile(route, pr.mile);
    const rejoin = pr.offMi > REJOIN_OFF_MI
      ? { from: [loc.fix.lat, loc.fix.lon], to: rejoinPt, distMi: pr.offMi,
          bearing: compass16(bearingDeg(loc.fix.lat, loc.fix.lon, rejoinPt[0], rejoinPt[1])),
          mp: mileToBrpMp(route, pr.mile), mile: pr.mile }
      : null;
    loc.rejoin = rejoin;
    const distAhead = (S.cfg.avgMph || 45) * (loc.min / 60);
    const targetMile = Math.min(total, pr.mile + distAhead);
    const point = pointAtMile(route, targetMile);
    loc.point = point; loc.targetMile = targetMile;

    // window: ±30 min of riding around the projected point (min 10 mi)
    const W = Math.max(10, (S.cfg.avgMph || 45) * 0.5);
    const cats = CATS.filter((c) => S.toggles[c]); // fuel / food / lodging / camping
    const tierOk = (e) => e.poi.cat !== 'lodging' || !S.cfg.maxTier || !e.tier || e.tier <= S.cfg.maxTier;
    const found = [];
    for (const c of cats) {
      for (const e of idx.byCat[c] || []) {
        if (e.m < targetMile - W || e.m > targetMile + W) continue;
        if (!tierOk(e)) continue;
        found.push({ e, d: e.m - targetMile });
      }
    }
    found.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const results = found.slice(0, 12).map((r) => ({ ...r.e, dAhead: r.d }));

    const mp = mileToBrpMp(route, targetMile);
    const now = new Date();
    const etaText = minToTime(now.getHours() * 60 + now.getMinutes() + loc.min);
    const atEnd = targetMile >= total - 0.5;

    mapApi.setAhead({ visible: true, minutes: loc.min, point, mp, targetMile, count: results.length, offRoute });
    mapApi.setRejoin(rejoin);
    ui.renderAhead({
      tracking: true, min: loc.min, mp, targetMile, etaText, offRoute, offMi: Math.round(pr.offMi), atEnd,
      fromMile: pr.mile, results, rejoin,
    });
  }

  async function refreshAhead() {
    if (loc.targetMile == null) return;
    showToast('Pulling fresh places near that spot…');
    try {
      const n = await refreshFromOverpass(poiSet, [routes.out, routes.retFast], current.route, loc.targetMile);
      idxCache = new Map();
      recompute({ markers: true }); // re-renders markers and re-runs updateAhead()
      showToast(n ? `${n} new place${n > 1 ? 's' : ''} added near your route ahead` : 'No new places found there');
    } catch (e) {
      console.warn(e);
      showToast('Overpass is busy — try again in a minute');
    }
  }

  function sightPopupHtml(s) {
    const t = s.tags || {};
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
    const wiki = t.wikipedia ? `https://en.wikipedia.org/wiki/${encodeURIComponent(String(t.wikipedia).replace(/^[a-z]{2}:/, ''))}` : null;
    return `<div class="popup">
      <div class="cat sight sight-${s.cat}">${SIGHT_LABEL[s.cat] || 'Sight'}${s.sub && s.sub !== s.cat ? ' · ' + escq(String(s.sub).replace(/_/g, ' ')) : ''}</div>
      <h3>${escq(s.name || SIGHT_LABEL[s.cat] || 'Sight')}</h3>
      ${t.description ? `<div class="meta">${escq(t.description)}</div>` : ''}
      ${s.nearDealsGapMi != null ? `<div class="meta">${s.nearDealsGapMi < 1 ? 'At Deals Gap' : Math.round(s.nearDealsGapMi) + ' mi from base camp'}</div>` : ''}
      <div class="pacts">
        ${t.website ? `<a href="${escq(t.website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
        ${wiki ? `<a href="${wiki}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
        <a href="${nav}" target="_blank" rel="noopener">Navigate ↗</a>
      </div>
    </div>`;
  }

  function ridePopupHtml(ride) {
    const closed = ride.currentlyRideable === false;
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${ride.a.lat},${ride.a.lon}`;
    const stats = [
      `<span><b>${Math.round(ride.lengthMi)}</b> mi</span>`,
      ride.curves ? `<span><b>${ride.curves}</b> curves</span>` : '',
      `<span><b>${DIFF_LABEL[ride.difficulty] || ride.difficulty}</b></span>`,
    ].join('');
    return `<div class="popup">
      <div class="cat ride">Legendary ride · ${escq(ride.road)}</div>
      <h3>${escq(ride.name)}</h3>
      <div class="ride-stats">${stats}</div>
      <div class="meta">${escq(ride.blurb)}</div>
      <div class="meta"${closed ? ' style="color:var(--danger)"' : ''}>${closed ? '⚠ ' : ''}${escq(ride.status)}</div>
      <div class="pacts">
        <a href="${nav}" target="_blank" rel="noopener">Ride it — navigate ↗</a>
      </div>
    </div>`;
  }

  function popupHtml(entry) {
    const { poi } = entry;
    const mp = mileToBrpMp(current.route, entry.m);
    const v = S.votes[poi.id];
    const slotPick = isPicked(poi.id);
    const t = poi.tags || {};
    const meta = [
      `<div>${mp != null ? `BRP MP ${Math.round(mp)} · ` : ''}route mile ${Math.round(entry.m)} · ${entry.o.toFixed(1)} mi off route</div>`,
      t.opening_hours ? `<div>🕒 ${escq(t.opening_hours)}</div>` : '',
      t.phone ? `<div>📞 ${escq(t.phone)}</div>` : '',
      t.cuisine ? `<div>🍽 ${escq(String(t.cuisine).replaceAll(';', ', '))}</div>` : '',
    ].join('');
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lon}`;
    let rates = '';
    if (poi.cat === 'lodging') {
      const slot = classifyPoiSlot(current.plan, current.idx, poi.id);
      const checkin = (slot && current.plan.days[slot.dayIdx]?.dateISO) || S.cfg.startDate;
      const url = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(poi.name || 'hotel')}&checkin=${checkin}&checkout=${addDays(checkin, 1)}`;
      rates = `<a href="${url}" target="_blank" rel="noopener">Rates ↗</a>`;
    }
    const tier = entry.tier ? ` · <span class="tier">${TIER_LABEL[entry.tier]}</span>` : '';
    return `<div class="popup">
      <div class="cat ${poi.cat}">${CAT_LABEL[poi.cat]}${poi.sub && poi.sub !== poi.cat ? ' · ' + escq(poi.sub.replace('_', ' ')) : ''}${tier}</div>
      <h3>${escq(poi.name || CAT_LABEL[poi.cat])}</h3>
      <div class="meta">${meta}</div>
      <div class="pacts">
        <button data-act="vote" class="${v?.mine ? 'active' : ''}">👍 ${v?.count || ''}</button>
        <button data-act="pick" class="${slotPick ? 'active' : ''}">${slotPick ? '★ Group stop' : 'Set as stop'}</button>
        ${rates}
        <a href="${nav}" target="_blank" rel="noopener">Navigate ↗</a>
      </div>
    </div>`;
  }

  // ---------- recompute & render ----------

  function activeRouteKey() {
    return S.dir === 'out' ? 'out' : (S.cfg.returnPreset === 'fast' ? 'retFast' : 'retBrp');
  }

  function recompute({ markers = false } = {}) {
    const rk = activeRouteKey();
    const route = routes[rk];
    const idx = idxFor(rk);
    const { range: effFuel, source: fuelSource, bike: fuelBike } = effectiveFuelRange(S);

    // Trip progress is OUTBOUND-only: replan the REMAINING route from prog.fromMile.
    const prog = (S.dir === 'out' && S.progress) ? S.progress : null;
    const fromMile = prog ? prog.fromMile : 0;
    const engCfg = { ...S.cfg, tankRangeMi: effFuel, includeCamping: S.toggles.camping, fromMile };

    // dayBase = trip days already completed, DERIVED from fromMile (not completedDays.length)
    // so "start from here" alone renumbers + redates the remaining days correctly. Count the
    // full-plan day boundaries that fall at/before the resume point.
    let dayBase = 0;
    if (fromMile > 0) {
      const fullDays = computePlan({ ...engCfg, fromMile: 0 }, idx, S.picks[S.dir]).days;
      dayBase = fullDays.filter((d) => d.endMile <= fromMile + 1e-6).length;
    }

    // Picks are stored under ABSOLUTE trip-day keys; the engine sees them relative (shifted
    // down by dayBase, completed days dropped). See shiftPicksForEngine / liftSlotToAbsolute.
    const plan = computePlan(engCfg, idx, shiftPicksForEngine(S.picks[S.dir], dayBase));

    // Return-leg date offset needs the WHOLE outbound day count — force fromMile:0 for that probe.
    const outDays = S.dir === 'ret'
      ? computePlan({ ...engCfg, fromMile: 0 }, idxFor('out'), S.picks.out).days.length
      : plan.days.length;
    const dateOffsets = (S.dir === 'out' ? 0 : outDays + (S.cfg.stayDays || 0)) + dayBase;

    decoratePlan(rk, route, plan, dateOffsets, dayBase);

    const routeChanged = rk !== current.rk;
    const firstLoad = current.rk === null;
    current = { plan, idx, route, rk, dateOffsets, dayBase, fromMile };
    if (routeChanged) {
      mapApi.setBase(route);
      mapApi.fitRoute(route, !firstLoad); // animate to the new route, except on first paint
      if (!firstLoad) mapApi.flashRoute(route); // bright pulse so the switch is unmistakable
      mapApi.setSights(sightsFor(rk));
    }
    mapApi.renderPlan(route, plan, { fromMile, completedDays: prog?.completedDays || [] });
    if (markers || routeChanged) mapApi.setMarkers(visibleEntries(idx));
    ui.render({ state: S, route, plan, dateOffsets, dayBase, progress: prog,
      fromMp: prog ? mileToBrpMp(route, prog.fromMile) : null,
      rides, effFuel, fuelSource, fuelBike, costs: costView() });
    scheduleWeather(rk, route, plan);
    if (loc.state !== 'off' && loc.fix) updateAhead(); // keep the projection in step with route/toggle changes
  }

  // The settle-up view for the cost panel (recomputed each render).
  function costView() {
    const roster = rosterFor(S);
    const uids = roster.map((r) => r.uid);
    const balances = computeBalances(S.expenses || {}, uids);
    const transfers = simplifyDebts(balances);
    return { roster, balances, transfers, myBalance: balances.get(S.rider.uid) || 0 };
  }

  // Sun times, dark-arrival warnings (replacing the engine's fixed 19:30 rule),
  // and any already-fetched weather, attached per day.
  function decoratePlan(rk, route, plan, dateOffsets, dayBase = 0) {
    plan.warnings = plan.warnings.filter((w) => w.code !== 'LATE_ARRIVAL' && w.code !== 'HIGH_ELEVATION');
    for (const day of plan.days) {
      day.absIdx = dayBase + day.idx;       // absolute trip-day index (0-based)
      day.tripDay = dayBase + day.idx + 1;  // human "Day N" across the whole trip
      day.dateISO = addDays(S.cfg.startDate, dateOffsets + day.idx);
      const [sLat, sLon] = pointAtMile(route, day.startMile);
      const [eLat, eLon] = pointAtMile(route, day.endMile);
      const rise = sunTimes(sLat, sLon, day.dateISO);
      const set = sunTimes(eLat, eLon, day.dateISO);
      day.sun = rise && set ? { riseMin: rise.riseMin, setMin: set.setMin } : null;
      day.elev = elevationForSpan(route, day.startMile, day.endMile);
      if (day.elev && day.elev.maxFt >= HIGH_FT) {
        plan.warnings.push({
          code: 'HIGH_ELEVATION', dayIdx: day.idx,
          msg: `Day ${day.tripDay} tops ${day.elev.maxFt.toLocaleString()} ft — expect cold, wind and fog up high. Pack layers and mind ice on shaded bends.`,
        });
      }
      if (day.sun && day.arriveMin > day.sun.setMin - 30) {
        const after = day.arriveMin > day.sun.setMin;
        plan.warnings.push({
          code: 'DARK_ARRIVAL', dayIdx: day.idx,
          msg: `Day ${day.tripDay} arrives ~${minToTime(day.arriveMin)}, ${after ? 'after' : 'right at'} sunset (${minToTime(day.sun.setMin)}). Deer o'clock — start earlier or trim hours.`,
        });
      }
      day.wx = wxCache.get(wxKey(rk, day)) || null;
    }
  }

  // ---------- weather ----------

  const wxCache = new Map();
  const wxInFlight = new Set();
  let wxTimer = null;

  function wxKey(rk, day) {
    // re-fetch when the day's span moves meaningfully (>25 mi bucket)
    return `${rk}:${day.idx}:${day.dateISO}:${Math.round(day.endMile / 25)}`;
  }

  function scheduleWeather(rk, route, plan) {
    clearTimeout(wxTimer);
    wxTimer = setTimeout(async () => {
      const missing = plan.days.filter((d) => {
        const k = wxKey(rk, d);
        return !wxCache.has(k) && !wxInFlight.has(k);
      });
      if (!missing.length) return;
      await Promise.all(missing.map(async (day) => {
        const k = wxKey(rk, day);
        wxInFlight.add(k);
        try {
          wxCache.set(k, await dayWeather(route, day, day.dateISO));
        } catch { wxCache.set(k, []); }
        finally { wxInFlight.delete(k); }
      }));
      if (current.rk === rk) recompute(); // cache hit now — no fetch loop
    }, 700);
  }

  function addDays(iso, n) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00') : new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function visibleEntries(idx) {
    const out = [];
    for (const cat of CATS) {
      if (!S.toggles[cat]) continue;
      out.push(...idx.byCat[cat]);
    }
    return out;
  }

  // ---------- picks & votes ----------

  // Picks are STORED under absolute trip-day keys (Day 1 = key 0, forever). The engine sees
  // them shifted to the REMAINING plan: lodging/lunch keys lowered by dayBase, completed days
  // dropped. Fuel is mile-keyed (the engine ignores fuel behind fromMile itself), so untouched.
  function shiftPicksForEngine(p, dayBase) {
    if (!dayBase) return p;
    const lower = (m) => {
      const o = {};
      for (const [k, v] of Object.entries(m || {})) { const nk = Number(k) - dayBase; if (nk >= 0) o[nk] = v; }
      return o;
    };
    return { fuel: p.fuel, lodging: lower(p.lodging), lunch: lower(p.lunch) };
  }
  // Raise a classifyPoiSlot result (dayIdx relative to the live remaining plan) to its absolute key.
  function liftSlotToAbsolute(slot, dayBase) {
    if (!slot || slot.kind === 'fuel' || !dayBase) return slot;
    return { ...slot, dayIdx: slot.dayIdx + dayBase };
  }

  function isPicked(poiId) {
    const p = S.picks[S.dir];
    const picked = p.fuel.includes(poiId) ||
      Object.values(p.lodging).includes(poiId) ||
      Object.values(p.lunch).includes(poiId);
    // A pick behind the resume point stays in storage (so Clear restores it) but isn't ACTIVE
    // — the engine skips it — so don't badge it as picked while progress is set.
    if (picked && (current.fromMile || 0) > 0) {
      const e = current.idx?.byId.get(poiId);
      if (e && e.m < current.fromMile - 1e-6) return false;
    }
    return picked;
  }

  function applyPickToggle(poiId, explicit = null) {
    const p = S.picks[S.dir];
    const dayBase = current.dayBase || 0;
    const fromMile = current.fromMile || 0;
    // Once progress is set, a lodging/lunch stop physically behind the resume point can't be
    // (re)assigned — classifyPoiSlot would otherwise snap it onto today's remaining day.
    if (fromMile > 0) {
      const e = current.idx.byId.get(poiId);
      if (e && e.poi.cat !== 'fuel' && e.m < fromMile - 1e-6) { showToast('That stop is behind you — already ridden'); return; }
    }
    // Explicit slots (from a day card's data-daykey) are already ABSOLUTE; classified slots are
    // relative to the remaining plan and must be lifted up by dayBase before storing.
    const slot = explicit || liftSlotToAbsolute(classifyPoiSlot(current.plan, current.idx, poiId), dayBase);
    if (!slot) return;
    if (slot.kind === 'fuel') {
      const i = p.fuel.indexOf(poiId);
      if (i >= 0) p.fuel.splice(i, 1); else p.fuel.push(poiId);
    } else {
      const m = p[slot.kind];
      if (m[slot.dayIdx] === poiId) delete m[slot.dayIdx];
      else m[slot.dayIdx] = poiId;
    }
    store.update('picks', {});
    sync?.savePicks(S.dir, S.picks[S.dir]);
    recompute();
    mapApi.refreshOpenPopup();
  }

  // Project the local GPS fix onto the OUTBOUND route (progress is outbound-only) -> mile | null.
  function projectFixToOutbound() {
    if (!loc.fix) return null;
    const pr = projectToRoute(gridFor('out'), routes.out.cum, loc.fix.lat, loc.fix.lon, 8)
      || projectToRoute(gridFor('out'), routes.out.cum, loc.fix.lat, loc.fix.lon, 30);
    return pr ? pr.mile : null;
  }

  // Set/clear the group resume anchor. Rides inside the synced trip config (like staging).
  function setProgress(next) {
    S.progress = normalizeProgress(next);
    store.update({ progress: S.progress });
    if (!applyingRemote) sync?.saveConfig({ progress: S.progress });
    recompute({ markers: true });
  }

  async function toggleVote(poiId) {
    const v = S.votes[poiId] || { count: 0, mine: false, names: [] };
    if (sync && sync.mode === 'firebase') {
      const ok = await sync.toggleVote(poiId, v.mine);
      if (!ok) showToast('Vote failed — are you online?');
      return; // listener updates state
    }
    // local mode: just my own vote
    S.votes[poiId] = v.mine
      ? { count: Math.max(0, v.count - 1), mine: false, names: [] }
      : { count: v.count + 1, mine: true, names: [S.rider.name || 'me'] };
    recompute();
    mapApi.refreshOpenPopup();
  }

  function pickRider(r) {
    return { name: r.name || 'rider', color: r.color, bike: r.bike || '', tankRangeMi: Number(r.tankRangeMi) || 130, rsvp: r.rsvp || 'in' };
  }

  function commitExpense(exp) {
    if (sync && sync.mode === 'firebase') { sync.saveExpense(exp); return; } // listener updates state
    S.expenses[exp.id] = exp;
    store.update({});
    recompute();
  }
  function removeExpense(id) {
    if (sync && sync.mode === 'firebase') { void sync.deleteExpense(id); return; }
    delete S.expenses[id];
    store.update({});
    recompute();
  }

  // ---------- UI ----------

  const debounces = new Map();
  function debounced(key, fn, ms = 400) {
    clearTimeout(debounces.get(key));
    debounces.set(key, setTimeout(fn, ms));
  }

  const ui = createUI({
    onCfg(partial) {
      // The fuel slider edits MY bike and drops manual override (min-across-roster resumes).
      if ('tankRangeMi' in partial) {
        partial = { ...partial, fuelOverride: false };
        const me = S.roster.find((r) => r.uid === S.rider.uid);
        if (me) { me.tankRangeMi = partial.tankRangeMi; if (!applyingRemote) sync?.pushRider({ tankRangeMi: me.tankRangeMi }); }
      }
      store.update('cfg', partial);
      recompute();
      if ('returnPreset' in partial && !applyingRemote) {
        const label = partial.returnPreset === 'fast' ? 'Fast — I-81' : 'Blue Ridge Parkway';
        showToast(`Return route: ${label} · ${Math.round(current.route.totalMi)} mi`);
      }
      if (!applyingRemote) {
        const sp = { ...partial }; delete sp.fuelOverride; // override is local-only, never synced
        if (Object.keys(sp).length) debounced('cfg', () => sync?.saveConfig(sp));
      }
    },
    onFuelOverride(on) {
      S.cfg.fuelOverride = on;
      store.update('cfg', {});
      recompute();
    },
    onToggle(cat) {
      S.toggles[cat] = !S.toggles[cat];
      store.update('toggles', {});
      if (cat === 'radar') {
        mapApi.setRadar(S.toggles.radar);
        recompute();
        return;
      }
      if (cat === 'rides') {
        mapApi.toggleRides(S.toggles.rides);
        ui.setRidesVisible(S.toggles.rides);
        return;
      }
      if (cat === 'sights') {
        mapApi.toggleSights(S.toggles.sights);
        ui.setSightsVisible(S.toggles.sights);
        return;
      }
      recompute({ markers: true });
      if (cat === 'camping' && !applyingRemote) debounced('cfg', () => sync?.saveConfig({}));
    },
    onDir(dir) {
      store.update({ dir });
      recompute({ markers: true });
    },
    onPick(kind, daykey, poiId, isActive) {
      if (kind === 'fuel') applyPickToggle(poiId, { kind: 'fuel' });
      else applyPickToggle(poiId, { kind, dayIdx: Number(daykey) });
    },
    onVote(poiId) { void toggleVote(poiId); },
    onFocusStop(mile, poiId) {
      const entry = poiId && current.idx.byId.get(poiId);
      if (entry) { mapApi.focusEntry(entry, 12); mapApi.pulse(entry); }
      else mapApi.focusMile(current.route, mile, 11);
    },
    onFocusPoi(poiId) {
      const entry = current.idx.byId.get(poiId);
      if (entry) { mapApi.focusEntry(entry, 13); mapApi.pulse(entry); }
    },
    onFocusRide(rideId) {
      const ride = rideById.get(rideId);
      if (!ride) return;
      if (!S.toggles.rides) { S.toggles.rides = true; store.update('toggles', {}); mapApi.toggleRides(true); ui.setRidesVisible(true); }
      mapApi.focusRide(ride);
    },
    onFocusSight(id) {
      const s = sightById.get(id);
      if (!s) return;
      if (!S.toggles.sights) { S.toggles.sights = true; store.update('toggles', {}); mapApi.toggleSights(true); ui.setSightsVisible(true); }
      mapApi.focusSight(s);
    },
    // ---- roster ----
    onRiderAdd() {
      const uid = 'r_' + randomId(8);
      S.roster.push({ uid, name: '', bike: '', tankRangeMi: S.cfg.tankRangeMi, color: riderColor(uid), rsvp: 'in' });
      store.update({ roster: S.roster });
      recompute();
    },
    onRiderEdit(uid, patch) {
      const r = S.roster.find((x) => x.uid === uid);
      if (!r) return;
      Object.assign(r, patch);
      if (uid === S.rider.uid) {
        if (patch.name) { S.rider.name = patch.name; store.update('rider', { name: patch.name }); }
        if (patch.tankRangeMi != null) { S.cfg.tankRangeMi = patch.tankRangeMi; S.cfg.fuelOverride = false; }
        if (!applyingRemote) sync?.pushRider(pickRider(r));
      }
      store.update({ roster: S.roster });
      recompute();
    },
    onRiderRsvp(uid, rsvp) {
      const r = S.roster.find((x) => x.uid === uid);
      if (!r) return;
      r.rsvp = rsvp;
      if (uid === S.rider.uid && !applyingRemote) sync?.pushRider({ rsvp });
      store.update({ roster: S.roster });
      recompute();
    },
    onRiderRemove(uid) {
      if (uid === S.rider.uid) return; // can't remove yourself
      S.roster = S.roster.filter((x) => x.uid !== uid);
      store.update({ roster: S.roster });
      recompute();
    },
    onStagingSet(patch) {
      S.staging = { ...(S.staging || {}), ...patch };
      if (!S.staging.label && !S.staging.lat) S.staging = null;
      store.update({ staging: S.staging });
      if (!applyingRemote) sync?.saveConfig({ staging: S.staging });
      mapApi.setStaging(S.staging);
      recompute();
    },
    onStagingPin() {
      showToast('Tap the map to drop the meetup pin');
      if (window.innerWidth <= 860) ui.setSheetState('min'); // get the sheet out of the way (also calls mapApi.invalidate)
      mapApi.pickPoint((latlng) => {
        S.staging = { ...(S.staging || {}), lat: +latlng.lat.toFixed(5), lon: +latlng.lng.toFixed(5) };
        store.update({ staging: S.staging });
        if (!applyingRemote) sync?.saveConfig({ staging: S.staging });
        mapApi.setStaging(S.staging);
        recompute();
        showToast('Meetup pin set 📍');
      });
    },
    // ---- trip progress (outbound resume anchor) ----
    onProgressStartHere() {
      const mile = projectFixToOutbound();
      if (mile == null) { showToast(loc.fix ? "You're not near the outbound route" : 'Tap the ⌖ locate button first so I know where you are'); return; }
      setProgress({ ...(S.progress || {}), fromMile: Math.round(mile) });
      showToast(`Resuming from mile ${Math.round(mile)} — remaining plan updated`);
    },
    onProgressMarkStop() {
      // Log last night's stop: capture current GPS (or the existing resume point) as a completed day.
      const mile = projectFixToOutbound() ?? (S.progress?.fromMile ?? null);
      if (mile == null) { showToast('Tap locate first, or use "Start today from my location"'); return; }
      const prog = S.progress || { completedDays: [] };
      const days = prog.completedDays || [];
      if (days.some((d) => Math.abs(d.endMile - mile) < 5)) { showToast('That stop is already logged'); return; }
      const entry = { dayNum: days.length + 1, endMile: Math.round(mile), label: '', lat: loc.fix?.lat ?? null, lon: loc.fix?.lon ?? null, dateISO: null };
      setProgress({ ...prog, fromMile: Math.round(mile), completedDays: [...days, entry] });
      showToast(`Logged last night's stop at mile ${Math.round(mile)}`);
    },
    onProgressClear() {
      if (!S.progress) return;
      S.progress = null;
      store.update({ progress: null });
      if (!applyingRemote) sync?.saveConfig({ progress: null });
      recompute({ markers: true });
      showToast('Trip progress cleared — full plan restored');
    },
    // ---- cost split ----
    onAddExpense(partial) {
      const now = Date.now();
      const payerName = rosterFor(S).find((r) => r.uid === partial.payer)?.name || S.rider.name || '';
      commitExpense({
        id: 'e_' + randomId(12),
        title: partial.title, amountCents: partial.amountCents,
        payer: partial.payer, payerName,
        sharers: partial.sharers,
        createdBy: S.rider.uid, createdAt: now, updatedAt: now,
      });
    },
    onToggleSharer(expId, uid) {
      const e = S.expenses[expId];
      if (!e) return;
      const sharers = e.sharers.includes(uid) ? e.sharers.filter((u) => u !== uid) : [...e.sharers, uid];
      if (!sharers.length) { showToast('An expense needs at least one person'); return; }
      commitExpense({ ...e, sharers, updatedAt: Date.now() });
    },
    onDeleteExpense(id) { removeExpense(id); },
    onAheadLocate() { onLocate(); },
    onAheadRefresh() { void refreshAhead(); },
    onFrameRoute() { frameMeAndRoute(); },
    onRerender() { recompute(); },
    async onShare() {
      if (sync && sync.mode !== 'local') {
        let id = sync.tripId;
        if (!id) {
          id = await sync.createSharedTrip();
          store.update({ tripId: id });
          history.replaceState(null, '', '#t=' + id);
          // local→live: upload any expenses entered while offline, then hand them to Firestore.
          const local = Object.values(S.expenses || {});
          if (local.length) { for (const e of local) sync.saveExpense(e); S.expenses = {}; store.update({ syncMode: sync.mode }); }
        }
        await copy(location.href.split('#')[0] + '#t=' + id);
        showToast('Live trip link copied — send it to the group 🏍');
      } else {
        const h = await encodeStateHash({ cfg: S.cfg, toggles: S.toggles, picks: S.picks });
        await copy(location.href.split('#')[0] + h);
        showToast('Plan link copied (snapshot). Live sync needs Firebase — see README.');
      }
    },
    onGpx() {
      const engCfg = { ...S.cfg, tankRangeMi: effectiveFuelRange(S).range, includeCamping: S.toggles.camping };
      const retKey = S.cfg.returnPreset === 'fast' ? 'retFast' : 'retBrp';
      const xml = buildGpx('Dragon Run', [
        { label: 'OUT', route: routes.out, plan: computePlan(engCfg, idxFor('out'), S.picks.out) },
        { label: 'RET', route: routes[retKey], plan: computePlan(engCfg, idxFor(retKey), S.picks.ret) },
      ], rides);
      downloadGpx('dragon-run.gpx', xml);
      showToast('GPX saved — load it in your GPS app');
    },
    async onRefresh() {
      showToast('Pulling fresh places from OpenStreetMap…');
      try {
        const c = mapApi.map.getCenter();
        const pr = projectToRoute(gridFor(current.rk), current.route.cum, c.lat, c.lng, 60);
        const mile = pr ? pr.mile : current.route.cum[current.route.cum.length - 1] / 2;
        const n = await refreshFromOverpass(poiSet, [routes.out, routes.retFast], current.route, mile);
        idxCache = new Map();
        recompute({ markers: true });
        showToast(n ? `${n} new place${n > 1 ? 's' : ''} added near the map view` : 'No new places found — snapshot is current');
      } catch (e) {
        console.warn(e);
        showToast('Overpass is busy — try again in a minute');
      }
    },
    async onName() {
      const name = await ui.askName(S.rider.name);
      if (name) {
        store.update('rider', { name });
        sync?.heartbeat();
        recompute();
      }
    },
    onSheetToggle() { mapApi.invalidate(); },
  });

  // Merge synced riders' bikes into the roster (keep local manual entries, never
  // stomp the local self entry from a remote echo of our own write).
  function reconcileRoster(synced) {
    for (const r of synced) {
      if (r.uid === S.rider.uid) continue;
      const existing = S.roster.find((x) => x.uid === r.uid);
      if (existing) Object.assign(existing, { name: r.name || existing.name, color: r.color || existing.color, bike: r.bike ?? existing.bike, tankRangeMi: r.tankRangeMi ?? existing.tankRangeMi, rsvp: r.rsvp || existing.rsvp });
      else S.roster.push({ uid: r.uid, name: r.name || 'rider', bike: r.bike || '', tankRangeMi: Number(r.tankRangeMi) || 130, color: r.color || riderColor(r.uid), rsvp: r.rsvp || 'in' });
    }
    ensureSelfInRoster(S);
  }

  // ---------- sync ----------

  async function initSync() {
    try {
      sync = await createSync({
        tripId: S.tripId,
        rider: S.rider,
        getSnapshot: () => { const cfg = { ...S.cfg, progress: S.progress }; delete cfg.fuelOverride; return { cfg, picks: S.picks }; },
        getRider: () => { const me = S.roster.find((r) => r.uid === S.rider.uid); return me ? pickRider(me) : { name: S.rider.name, color: S.rider.color, bike: '', tankRangeMi: S.cfg.tankRangeMi, rsvp: 'in' }; },
        onRemote(patch) {
          applyingRemote = true;
          try {
            if (patch.config) {
              const cfg = { ...patch.config };
              delete cfg.fuelOverride; // never accept a remote override
              if (cfg.staging !== undefined) { S.staging = cfg.staging; delete cfg.staging; mapApi.setStaging(S.staging); }
              // Pull progress OUT before Object.assign — else it leaks into S.cfg and gets
              // spread into engCfg. (null on Clear is honored: null !== undefined.)
              if (cfg.progress !== undefined) { S.progress = normalizeProgress(cfg.progress); delete cfg.progress; }
              if (ui.isDragging()) {
                for (const k of ['tankRangeMi', 'hoursPerDay', 'avgMph']) delete cfg[k];
              }
              Object.assign(S.cfg, cfg);
            }
            if (patch.picks) S.picks = normalizePicks(patch.picks);
            if (patch.votes) S.votes = patch.votes;
            if (patch.riders) { S.riders = patch.riders; reconcileRoster(patch.riders); }
            if (patch.expenses) S.expenses = normalizeExpenses(patch.expenses);
            store.update({}, {});
            recompute();
            mapApi.refreshOpenPopup();
          } finally {
            applyingRemote = false;
          }
        },
      });
      store.update({ syncMode: sync.mode });
      if (sync.mode === 'firebase') showToast('Live sync on — riders see changes instantly');
    } catch (e) {
      console.warn('sync init failed, running local', e);
      sync = null;
    }
  }

  // ---------- go ----------

  ensureSelfInRoster(S);
  const panelSights = [...(sightSet.sights || [])].sort((a, b) => (a.nearDealsGapMi ?? 1e9) - (b.nearDealsGapMi ?? 1e9));

  mapApi.setRides(rides);
  mapApi.toggleRides(S.toggles.rides);
  mapApi.setSights(sightsFor(activeRouteKey()));
  mapApi.toggleSights(S.toggles.sights);
  if (S.staging) mapApi.setStaging(S.staging);
  ui.mountRides(rides);
  ui.setRidesVisible(S.toggles.rides);
  ui.mountSights(panelSights);
  ui.setSightsVisible(S.toggles.sights);
  ui.renderAhead(null); // mount the "Ride ahead" section with its locate CTA
  recompute({ markers: true });
  if (S.toggles.radar) mapApi.setRadar(true);
  await initSync();
  recompute();

  // ---------- offline / PWA ----------
  const pwa = initPwa({
    onUpdateReady: () => { store.update({ swUpdate: true }, {}); recompute(); showToast('Update ready — tap "Update now" in Offline & install'); },
    onOnlineChange: (online) => { store.update({ offline: !online }, {}); recompute(); },
    onInstallAvailable: () => recompute(),
  });
  ui.setPwa({
    get installable() { return pwa.installable; },
    get updateReady() { return pwa.updateReady; },
    isStandalone: pwa.isStandalone,
    install: () => pwa.promptInstall(),
    update: () => pwa.applyUpdate(),
    clearTiles: async () => { const ok = await pwa.clearTiles(); showToast(ok ? 'Cached map tiles cleared' : 'Nothing to clear'); },
  });
  recompute();

  // Console/debug handle (also used by automated verification).
  window.DR = { mapApi, routes, store, idxFor, rides, sights: sightSet, pwa, get current() { return current; }, recompute };

  if (!S.rider.name) {
    const name = await ui.askName('');
    if (name) { store.update('rider', { name }); ensureSelfInRoster(S); sync?.heartbeat(); recompute(); }
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function escq(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
