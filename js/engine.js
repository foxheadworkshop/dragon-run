// The stop-planning engine. Pure and synchronous — no DOM, no I/O — so it runs
// on every slider input and under `node --test`.
//
// Inputs:
//   cfg   { tankRangeMi, reservePct, hoursPerDay, avgMph, departTime 'HH:MM',
//           includeCamping }
//   idx   RoutePoiIndex from poi.js: { route:{cum,...}, byCat:{cat:[{poi,m,o}]}, byId }
//   picks { fuel:[poiId...], lodging:{dayIdx:poiId}, lunch:{dayIdx:poiId} }
//
// Output Plan:
//   { days:[{ idx, startMile, endMile, miles, ridingHrs, departMin, arriveMin,
//             stops:[Stop] }],
//     totals:{ miles, ridingDays, fuelStops, rideHrs, milesPerDay, effRange },
//     warnings:[{ code, dayIdx?, mile?, msg }] }
//   Stop: { type:'fuel'|'lunch'|'lodging', mile, etaMin, etdMin, window:[m0,m1],
//           chosen:{poi,m,o}|null, candidates:[{poi,m,o}], isPick, baseCamp? }

export const DWELL_MIN = { fuel: 15, lunch: 45, lodging: 0 };

export function timeToMin(hhmm) {
  const [h, m] = (hhmm || '08:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minToTime(min) {
  min = Math.round(min);
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function entriesInWindow(idx, cats, m0, m1, maxOff) {
  const out = [];
  for (const cat of cats) {
    const arr = idx.byCat[cat] || [];
    const miles = idx.byCatMiles[cat] || [];
    let i = lowerBound(miles, m0);
    for (; i < arr.length && arr[i].m <= m1; i++) {
      if (arr[i].o <= maxOff) out.push(arr[i]);
    }
  }
  out.sort((a, b) => a.m - b.m);
  return out;
}

function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function nextEntryAfter(idx, cats, mile) {
  let best = null;
  for (const cat of cats) {
    const arr = idx.byCat[cat] || [];
    const miles = idx.byCatMiles[cat] || [];
    const i = lowerBound(miles, mile + 1e-6);
    if (i < arr.length && (!best || arr[i].m < best.m)) best = arr[i];
  }
  return best;
}

function nearestEntry(idx, cats, mile) {
  let best = null, bestD = Infinity;
  for (const cat of cats) {
    for (const e of idx.byCat[cat] || []) {
      const d = Math.abs(e.m - mile);
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  return best;
}

export function computePlan(cfg, idx, picks = {}) {
  const warnings = [];
  const effRange = cfg.tankRangeMi * (1 - cfg.reservePct / 100);
  const milesPerDay = cfg.hoursPerDay * cfg.avgMph;
  const cum = idx.route.cum;
  const total = cum[cum.length - 1];
  // Resume point for "continue from here": plan only the REMAINING route from here.
  // Defaults to 0 (whole trip). Clamped so a stale/garbage value can never misplan.
  const fromMile = Math.min(Math.max(Number(cfg.fromMile) || 0, 0), total);
  const remaining = total - fromMile;
  const lodgingCats = cfg.includeCamping ? ['lodging', 'camping'] : ['lodging'];
  // Budget cap: keep lodging at or under cfg.maxTier ($=1, $$=2). Unknown-tier
  // independents (0) always pass — no rate data is not the same as expensive.
  const tierOk = (e) => !cfg.maxTier || !e.tier || e.tier <= cfg.maxTier;

  // ---- 1. day boundaries + overnight lodging ----
  const days = [];
  let startMile = fromMile, d = 0;
  while (startMile < total - 1e-6 && d < 14) {
    let targetEnd = Math.min(startMile + milesPerDay, total);
    if (total - targetEnd <= 0.05 * milesPerDay) targetEnd = total; // absorb trailing sliver
    const day = { idx: d, startMile, endMile: targetEnd, stops: [] };
    const isFinal = targetEnd >= total - 1e-6;

    let window, candidates = [];
    if (isFinal) {
      // base camp: lodging near the destination
      window = [Math.max(0, total - 12), total];
      candidates = entriesInWindow(idx, lodgingCats, window[0], window[1], 8).filter(tierOk);
    } else {
      for (const widen of [0.12, 0.2, 0.3]) {
        const w0 = Math.max(startMile + 0.4 * milesPerDay, targetEnd - widen * milesPerDay);
        const w1 = Math.min(total, targetEnd + widen * milesPerDay);
        window = [w0, w1];
        candidates = entriesInWindow(idx, lodgingCats, w0, w1, 5).filter(tierOk);
        if (candidates.length) break;
      }
    }

    let chosen = null, isPick = false;
    const pickId = picks.lodging?.[d];
    if (pickId != null) {
      const e = idx.byId.get(pickId);
      const fits = e && lodgingCats.includes(e.poi.cat) &&
        (isFinal ? e.m >= window[0] : Math.abs(e.m - targetEnd) <= 0.35 * milesPerDay);
      if (fits) { chosen = e; isPick = true; }
      else warnings.push({ code: 'DROPPED_PICK', dayIdx: d, msg: `Day ${d + 1} lodging pick no longer fits the plan — using a suggestion instead.` });
    }
    if (!chosen && candidates.length) {
      chosen = candidates.reduce((best, e) => {
        const ref = isFinal ? total : targetEnd;
        const score = Math.abs(e.m - ref) + 2 * e.o;
        return !best || score < best.score ? { e, score } : best;
      }, null).e;
    }
    if (!isFinal) {
      if (chosen) day.endMile = Math.min(total, Math.max(chosen.m, startMile + 0.3 * milesPerDay));
      else {
        const near = nearestEntry(idx, lodgingCats, targetEnd);
        warnings.push({
          code: 'NO_LODGING', dayIdx: d, mile: targetEnd,
          msg: `No lodging found near mile ${Math.round(targetEnd)}${near ? ` — closest is "${near.poi.name || 'unnamed'}" at mile ${Math.round(near.m)}` : ''}. Consider adjusting hours/speed.`,
        });
      }
    }
    day.stops.push({
      type: 'lodging', mile: day.endMile, window, chosen, isPick,
      baseCamp: isFinal,
      candidates: rankCandidates(candidates, isFinal ? total : day.endMile, 12),
    });
    days.push(day);
    startMile = day.endMile;
    d++;
  }

  // ---- 2. fuel: greedy over the whole route (tanks don't care about bedtimes) ----
  const fuelLegs = [];
  const pickQueue = (picks.fuel || [])
    .map((id) => idx.byId.get(id))
    .filter((e) => e && e.poi.cat === 'fuel')
    .sort((a, b) => a.m - b.m);
  if ((picks.fuel || []).length > pickQueue.length) {
    warnings.push({ code: 'STALE_PICK', msg: 'Some fuel picks no longer exist in the data and were ignored.' });
  }
  let lastFill = fromMile, pq = 0, guard = 0; // resume assumes a full tank at fromMile
  while (lastFill + effRange < total - 1e-6 && guard++ < 40) {
    const limit = lastFill + effRange;
    while (pq < pickQueue.length && pickQueue[pq].m <= lastFill + 1e-6) pq++;

    let window = [lastFill + 0.55 * effRange, limit];
    let candidates = entriesInWindow(idx, ['fuel'], window[0], window[1], 3);
    if (!candidates.length) candidates = entriesInWindow(idx, ['fuel'], lastFill + 0.25 * effRange, limit, 5);
    if (!candidates.length) candidates = entriesInWindow(idx, ['fuel'], lastFill + 1e-6, limit, 5);

    let chosen = null, isPick = false;
    if (pq < pickQueue.length && pickQueue[pq].m <= limit) {
      chosen = pickQueue[pq++];
      isPick = true;
    } else if (candidates.length) {
      chosen = candidates.reduce((b, e) => (!b || e.m - 2 * e.o > b.m - 2 * b.o ? e : b), null);
    } else {
      const after = nextEntryAfter(idx, ['fuel'], limit);
      warnings.push({
        code: 'FUEL_GAP', mile: lastFill,
        msg: `Fuel gap: no gas within ${Math.round(effRange)} mi after mile ${Math.round(lastFill)}` +
          (after ? ` — next pump is at mile ${Math.round(after.m)}, a ${Math.round(after.m - lastFill)} mi leg.` : ' — and none after that. Carry fuel.'),
      });
      if (!after) break;
      chosen = after;
    }
    if (pq < pickQueue.length && pickQueue[pq].poi.id === chosen.poi.id) { isPick = true; pq++; }
    if (chosen.m <= lastFill + 1e-6) break; // no forward progress — bail safely
    fuelLegs.push({
      type: 'fuel', mile: chosen.m, window, chosen, isPick,
      candidates: rankCandidates(candidates.length ? candidates : [chosen], limit, 8, true),
    });
    lastFill = chosen.m;
  }

  // ---- 3. lunch per day ----
  for (const day of days) {
    const ridingHrs = (day.endMile - day.startMile) / cfg.avgMph;
    if (ridingHrs < 3.5) continue;
    const mid = (day.startMile + day.endMile) / 2;
    const span = (40 / 60) * cfg.avgMph;
    const window = [Math.max(day.startMile, mid - span), Math.min(day.endMile, mid + span)];
    const candidates = entriesInWindow(idx, ['food'], window[0], window[1], 3);
    let chosen = null, isPick = false;
    const pickId = picks.lunch?.[day.idx];
    if (pickId != null) {
      const e = idx.byId.get(pickId);
      if (e && e.poi.cat === 'food' && e.m >= mid - 2 * span && e.m <= mid + 2 * span) { chosen = e; isPick = true; }
      else warnings.push({ code: 'DROPPED_PICK', dayIdx: day.idx, msg: `Day ${day.idx + 1} lunch pick no longer fits — using a suggestion.` });
    }
    if (!chosen && candidates.length) {
      chosen = candidates.reduce((best, e) => {
        const score = 2 * e.o + Math.abs(e.m - mid) / 10;
        return !best || score < best.score ? { e, score } : best;
      }, null).e;
    }
    if (!chosen && !candidates.length) {
      warnings.push({ code: 'NO_LUNCH', dayIdx: day.idx, msg: `Day ${day.idx + 1}: no restaurants near the midpoint — pack food or shift the window.` });
    }
    day.stops.push({
      type: 'lunch', mile: chosen ? chosen.m : mid, window, chosen, isPick,
      candidates: rankCandidates(candidates, mid, 10),
    });
  }

  // ---- 4. merge fuel into days + ETA clock walk ----
  for (const day of days) {
    const dayFuel = fuelLegs.filter((f) => f.mile > day.startMile + 1e-6 && f.mile <= day.endMile + 1e-6);
    const lodging = day.stops.filter((s) => s.type === 'lodging');
    const rest = day.stops.filter((s) => s.type !== 'lodging');
    day.stops = [...rest, ...dayFuel].sort((a, b) => a.mile - b.mile);

    let clock = timeToMin(cfg.departTime);
    day.departMin = clock;
    let prevMile = day.startMile;
    for (const s of day.stops) {
      s.etaMin = clock + ((s.mile - prevMile) / cfg.avgMph) * 60;
      s.etdMin = s.etaMin + DWELL_MIN[s.type];
      clock = s.etdMin;
      prevMile = s.mile;
    }
    day.arriveMin = clock + ((day.endMile - prevMile) / cfg.avgMph) * 60;
    for (const l of lodging) { l.etaMin = day.arriveMin; l.etdMin = day.arriveMin; }
    day.stops.push(...lodging);
    day.miles = day.endMile - day.startMile;
    day.ridingHrs = day.miles / cfg.avgMph;
    if (day.arriveMin > 19.5 * 60) {
      warnings.push({ code: 'LATE_ARRIVAL', dayIdx: day.idx, msg: `Day ${day.idx + 1} arrives around ${minToTime(day.arriveMin)} — consider an earlier start or fewer hours.` });
    }
  }

  return {
    days,
    fuelLegs,
    totals: {
      miles: remaining,    // REMAINING distance from fromMile (== total on a full plan)
      totalMiles: total,   // absolute route length (use this for "whole trip" displays)
      fromMile,            // resume point (0 on a full plan)
      ridingDays: days.length,
      fuelStops: fuelLegs.length,
      rideHrs: remaining / cfg.avgMph,
      milesPerDay,
      effRange,
    },
    warnings,
  };
}

function rankCandidates(list, refMile, cap, fuelStyle = false) {
  const scored = list.map((e) => ({
    e,
    score: fuelStyle ? -(e.m - 2 * e.o) : Math.abs(e.m - refMile) + 2 * e.o,
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, cap).map((s) => s.e);
}

// Which pick slot does this POI belong to, given the current plan?
// Returns { kind:'fuel' } | { kind:'lodging'|'lunch', dayIdx } | null.
export function classifyPoiSlot(plan, idx, poiId) {
  const e = idx.byId.get(poiId);
  if (!e) return null;
  if (e.poi.cat === 'fuel') return { kind: 'fuel' };
  if (!plan.days.length) return null; // empty remaining plan (at base camp) — nothing to assign
  if (e.poi.cat === 'food') {
    const day = plan.days.find((d) => e.m >= d.startMile - 1e-6 && e.m <= d.endMile + 1e-6) || plan.days[plan.days.length - 1];
    return { kind: 'lunch', dayIdx: day.idx };
  }
  // lodging / camping → nearest day boundary
  let best = null, bestD = Infinity;
  for (const d of plan.days) {
    const dd = Math.abs(d.endMile - e.m);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best ? { kind: 'lodging', dayIdx: best.idx } : null;
}
