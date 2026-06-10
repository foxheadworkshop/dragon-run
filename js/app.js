// Bootstrap + orchestration. The only module with side effects at import time.

import { createStore, normalizePicks } from './state.js';
import { loadRoute, reverseRoute, mileToBrpMp } from './route.js';
import { loadPois, indexForRoute, refreshFromOverpass, CAT_LABEL, CATS } from './poi.js';
import { computePlan, classifyPoiSlot, minToTime } from './engine.js';
import { createMap } from './map.js';
import { createUI, showToast } from './ui.js';
import { createSync } from './sync.js';
import { encodeStateHash, decodeHash } from './share.js';
import { buildGpx, downloadGpx } from './gpx.js';
import { buildGridIndex, projectToRoute, pointAtMile } from './geo.js';
import { sunTimes } from './sun.js';
import { dayWeather } from './weather.js';

const DATA_V = '2026-06-10-1'; // bumped on data redeploys to bust the Pages CDN cache

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

  const [outRoute, retFastRoute, poiSet] = await Promise.all([
    loadRoute(`./data/route-outbound.json?v=${DATA_V}`),
    loadRoute(`./data/route-return-fast.json?v=${DATA_V}`),
    loadPois(`./data/pois.json?v=${DATA_V}`),
  ]);
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
  });

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
    return `<div class="popup">
      <div class="cat ${poi.cat}">${CAT_LABEL[poi.cat]}${poi.sub && poi.sub !== poi.cat ? ' · ' + escq(poi.sub.replace('_', ' ')) : ''}</div>
      <h3>${escq(poi.name || CAT_LABEL[poi.cat])}</h3>
      <div class="meta">${meta}</div>
      <div class="pacts">
        <button data-act="vote" class="${v?.mine ? 'active' : ''}">👍 ${v?.count || ''}</button>
        <button data-act="pick" class="${slotPick ? 'active' : ''}">${slotPick ? '★ Group stop' : 'Set as stop'}</button>
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
    const engCfg = { ...S.cfg, includeCamping: S.toggles.camping };
    const plan = computePlan(engCfg, idx, S.picks[S.dir]);

    let outDays = plan.days.length;
    if (S.dir === 'ret') outDays = computePlan(engCfg, idxFor('out'), S.picks.out).days.length;
    const dateOffsets = S.dir === 'out' ? 0 : outDays + (S.cfg.stayDays || 0);

    decoratePlan(rk, route, plan, dateOffsets);

    const routeChanged = rk !== current.rk;
    current = { plan, idx, route, rk, dateOffsets };
    if (routeChanged) mapApi.setBase(route);
    mapApi.renderPlan(route, plan);
    if (markers || routeChanged) mapApi.setMarkers(visibleEntries(idx));
    ui.render({ state: S, route, plan, dateOffsets });
    scheduleWeather(rk, route, plan);
  }

  // Sun times, dark-arrival warnings (replacing the engine's fixed 19:30 rule),
  // and any already-fetched weather, attached per day.
  function decoratePlan(rk, route, plan, dateOffsets) {
    plan.warnings = plan.warnings.filter((w) => w.code !== 'LATE_ARRIVAL');
    for (const day of plan.days) {
      day.dateISO = addDays(S.cfg.startDate, dateOffsets + day.idx);
      const [sLat, sLon] = pointAtMile(route, day.startMile);
      const [eLat, eLon] = pointAtMile(route, day.endMile);
      const rise = sunTimes(sLat, sLon, day.dateISO);
      const set = sunTimes(eLat, eLon, day.dateISO);
      day.sun = rise && set ? { riseMin: rise.riseMin, setMin: set.setMin } : null;
      if (day.sun && day.arriveMin > day.sun.setMin - 30) {
        const after = day.arriveMin > day.sun.setMin;
        plan.warnings.push({
          code: 'DARK_ARRIVAL', dayIdx: day.idx,
          msg: `Day ${day.idx + 1} arrives ~${minToTime(day.arriveMin)}, ${after ? 'after' : 'right at'} sunset (${minToTime(day.sun.setMin)}). Deer o'clock — start earlier or trim hours.`,
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

  function isPicked(poiId) {
    const p = S.picks[S.dir];
    return p.fuel.includes(poiId) ||
      Object.values(p.lodging).includes(poiId) ||
      Object.values(p.lunch).includes(poiId);
  }

  function applyPickToggle(poiId, explicit = null) {
    const p = S.picks[S.dir];
    const slot = explicit || classifyPoiSlot(current.plan, current.idx, poiId);
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

  // ---------- UI ----------

  const debounces = new Map();
  function debounced(key, fn, ms = 400) {
    clearTimeout(debounces.get(key));
    debounces.set(key, setTimeout(fn, ms));
  }

  const ui = createUI({
    onCfg(partial) {
      store.update('cfg', partial);
      recompute();
      if (!applyingRemote) debounced('cfg', () => sync?.saveConfig(partial));
    },
    onToggle(cat) {
      S.toggles[cat] = !S.toggles[cat];
      store.update('toggles', {});
      if (cat === 'radar') {
        mapApi.setRadar(S.toggles.radar);
        recompute();
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
    onRerender() { recompute(); },
    async onShare() {
      if (sync && sync.mode !== 'local') {
        let id = sync.tripId;
        if (!id) {
          id = await sync.createSharedTrip();
          store.update({ tripId: id });
          history.replaceState(null, '', '#t=' + id);
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
      const engCfg = { ...S.cfg, includeCamping: S.toggles.camping };
      const retKey = S.cfg.returnPreset === 'fast' ? 'retFast' : 'retBrp';
      const xml = buildGpx('Dragon Run', [
        { label: 'OUT', route: routes.out, plan: computePlan(engCfg, idxFor('out'), S.picks.out) },
        { label: 'RET', route: routes[retKey], plan: computePlan(engCfg, idxFor(retKey), S.picks.ret) },
      ]);
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

  // ---------- sync ----------

  async function initSync() {
    try {
      sync = await createSync({
        tripId: S.tripId,
        rider: S.rider,
        getSnapshot: () => ({ cfg: S.cfg, picks: S.picks }),
        onRemote(patch) {
          applyingRemote = true;
          try {
            if (patch.config) {
              const cfg = { ...patch.config };
              if (ui.isDragging()) {
                for (const k of ['tankRangeMi', 'hoursPerDay', 'avgMph']) delete cfg[k];
              }
              Object.assign(S.cfg, cfg);
            }
            if (patch.picks) S.picks = normalizePicks(patch.picks);
            if (patch.votes) S.votes = patch.votes;
            if (patch.riders) S.riders = patch.riders;
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

  recompute({ markers: true });
  if (S.toggles.radar) mapApi.setRadar(true);
  await initSync();
  recompute();

  // Console/debug handle (also used by automated verification).
  window.DR = { mapApi, routes, store, idxFor, get current() { return current; }, recompute };

  if (!S.rider.name) {
    const name = await ui.askName('');
    if (name) { store.update('rider', { name }); sync?.heartbeat(); recompute(); }
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
