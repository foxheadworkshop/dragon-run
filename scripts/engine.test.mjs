// node --test scripts/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePlan, classifyPoiSlot } from '../js/engine.js';

function makeIdx(totalMi, pois) {
  const byCat = { fuel: [], food: [], lodging: [], camping: [] };
  const byId = new Map();
  for (const p of pois) {
    const entry = {
      poi: { id: p.id, cat: p.cat, name: p.name || p.id, lat: 0, lon: 0, sub: null, tags: {} },
      m: p.m,
      o: p.o ?? 0.2,
      tier: p.tier ?? 0,
    };
    byCat[p.cat].push(entry);
    byId.set(p.id, entry);
  }
  for (const c of Object.keys(byCat)) byCat[c].sort((a, b) => a.m - b.m);
  const byCatMiles = Object.fromEntries(Object.entries(byCat).map(([c, l]) => [c, l.map((e) => e.m)]));
  return { route: { cum: [0, totalMi], coords: [[38, -78], [36, -80]], totalMi }, byCat, byCatMiles, byId };
}

const CFG = { tankRangeMi: 130, reservePct: 15, hoursPerDay: 8, avgMph: 45, departTime: '08:00', includeCamping: true };
const EFF = 130 * 0.85; // 110.5

function gasEvery(spacing, total) {
  const out = [];
  for (let m = spacing; m < total; m += spacing) out.push({ id: `g${m}`, cat: 'fuel', m });
  return out;
}
function lodgingAt(...miles) {
  return miles.map((m) => ({ id: `h${m}`, cat: 'lodging', m }));
}
function foodEvery(spacing, total) {
  const out = [];
  for (let m = spacing; m < total; m += spacing) out.push({ id: `f${m}`, cat: 'food', m });
  return out;
}

test('defaults give 2 riding days on a 646-mile route, day 1 ends near 360', () => {
  const idx = makeIdx(646.5, [...gasEvery(40, 646.5), ...lodgingAt(180, 350, 365, 540, 640), ...foodEvery(60, 646.5)]);
  const plan = computePlan(CFG, idx, {});
  assert.equal(plan.days.length, 2);
  assert.ok(Math.abs(plan.days[0].endMile - 360) < 45, `day 1 ends at ${plan.days[0].endMile}`);
  assert.ok(plan.days[1].endMile > 646.4);
});

test('every fuel leg stays within effective range', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640)]);
  const plan = computePlan(CFG, idx, {});
  let last = 0;
  for (const leg of plan.fuelLegs) {
    assert.ok(leg.mile - last <= EFF + 1e-6, `leg ${last}->${leg.mile} exceeds ${EFF}`);
    last = leg.mile;
  }
  assert.ok(idx.route.totalMi - last <= EFF + 1e-6, 'final stretch exceeds range');
  assert.equal(plan.warnings.filter((w) => w.code === 'FUEL_GAP').length, 0);
});

test('fuel desert produces FUEL_GAP warning but plan continues', () => {
  const pois = [
    { id: 'g80', cat: 'fuel', m: 80 },
    { id: 'g260', cat: 'fuel', m: 260 }, // 180-mile gap > 110.5
    ...lodgingAt(355),
  ];
  const plan = computePlan(CFG, makeIdx(400, pois), {});
  const gaps = plan.warnings.filter((w) => w.code === 'FUEL_GAP');
  assert.ok(gaps.length >= 1, 'expected a FUEL_GAP warning');
  assert.ok(plan.fuelLegs.some((l) => l.chosen.poi.id === 'g260'), 'plan still routes through g260');
});

test('an early fuel pick cascades the downstream windows', () => {
  const idx = makeIdx(646.5, [...gasEvery(35, 646.5), ...lodgingAt(355, 640)]);
  const auto = computePlan(CFG, idx, {});
  const picked = computePlan(CFG, idx, { fuel: ['g70'] });
  assert.equal(picked.fuelLegs[0].chosen.poi.id, 'g70');
  assert.ok(picked.fuelLegs[0].isPick);
  // next window must start from mile 70
  assert.ok(Math.abs(picked.fuelLegs[1].window[1] - (70 + EFF)) < 1e-6);
  assert.notEqual(auto.fuelLegs[0].chosen.poi.id, 'g70', 'auto would have gone farther');
});

test('short final day skips lunch', () => {
  const idx = makeIdx(380, [...gasEvery(50, 380), ...lodgingAt(355, 375), ...foodEvery(30, 380)]);
  const plan = computePlan(CFG, idx, {});
  assert.equal(plan.days.length, 2);
  const day2 = plan.days[1];
  assert.ok(day2.ridingHrs < 3.5);
  assert.ok(!day2.stops.some((s) => s.type === 'lunch'), 'no lunch on a sub-3.5h day');
});

test('trailing sliver is absorbed into the previous day', () => {
  // 365 total at 360/day -> 5-mile "day 2" would be silly
  const idx = makeIdx(365, [...gasEvery(50, 365), ...lodgingAt(180, 360)]);
  const plan = computePlan(CFG, idx, {});
  assert.equal(plan.days.length, 1);
});

test('lodging window widens to find rural options', () => {
  // nothing within ±12% of 360 (317-403), but something at 314 (within ±20% -> 288-432? yes 314)
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(286, 640)]);
  const plan = computePlan(CFG, idx, {});
  const night = plan.days[0].stops.find((s) => s.type === 'lodging');
  assert.equal(night.chosen?.poi.id, 'h286');
  assert.ok(Math.abs(plan.days[0].endMile - 286) < 1e-6, 'day end snaps to the chosen lodging');
});

test('NO_LODGING warning when there is nothing near the boundary', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(640)]);
  const plan = computePlan(CFG, idx, {});
  assert.ok(plan.warnings.some((w) => w.code === 'NO_LODGING'));
});

test('camping toggle controls overnight candidates', () => {
  const pois = [...gasEvery(45, 646.5), { id: 'c350', cat: 'camping', m: 350 }, ...lodgingAt(640)];
  const planWith = computePlan({ ...CFG, includeCamping: true }, makeIdx(646.5, pois), {});
  const planWithout = computePlan({ ...CFG, includeCamping: false }, makeIdx(646.5, pois), {});
  assert.equal(planWith.days[0].stops.find((s) => s.type === 'lodging').chosen?.poi.id, 'c350');
  assert.notEqual(planWithout.days[0].stops.find((s) => s.type === 'lodging').chosen?.poi.id, 'c350');
});

test('mirrored index produces a valid plan (direction-agnostic engine)', () => {
  const total = 646.5;
  const pois = [...gasEvery(45, total), ...lodgingAt(180, 290, 355, 540, 640), ...foodEvery(60, total)];
  const fwd = computePlan(CFG, makeIdx(total, pois), {});
  const mirrored = pois.map((p) => ({ ...p, m: Math.round((total - p.m) * 10) / 10 }));
  const rev = computePlan(CFG, makeIdx(total, mirrored), {});
  assert.equal(rev.days.length, fwd.days.length);
  let last = 0;
  for (const leg of rev.fuelLegs) {
    assert.ok(leg.mile - last <= EFF + 1e-6);
    last = leg.mile;
  }
});

test('stale picks are dropped with a warning, not a crash', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640)]);
  const plan = computePlan(CFG, idx, { fuel: ['nope'], lodging: { 0: 'alsoNope' }, lunch: {} });
  assert.ok(plan.days.length >= 2);
  assert.ok(plan.warnings.some((w) => w.code === 'STALE_PICK' || w.code === 'DROPPED_PICK'));
});

test('ETAs walk forward with dwell times', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640), ...foodEvery(60, 646.5)]);
  const plan = computePlan(CFG, idx, {});
  const day = plan.days[0];
  let lastEtd = day.departMin;
  for (const s of day.stops) {
    if (s.type === 'lodging') continue;
    assert.ok(s.etaMin >= lastEtd - 1e-9, `${s.type}@${s.mile} eta before previous etd`);
    lastEtd = s.etdMin;
  }
  assert.ok(day.arriveMin > day.departMin + (day.miles / CFG.avgMph) * 60 - 1e-9);
});

test('maxTier budget cap steers lodging suggestions; unknown tiers always pass', () => {
  const pois = [
    ...gasEvery(45, 646.5),
    { id: 'hilton350', cat: 'lodging', m: 350, tier: 3 },
    { id: 'motel290', cat: 'lodging', m: 290, tier: 1 },
    { id: 'indie640', cat: 'lodging', m: 640, tier: 0 },
  ];
  const any = computePlan({ ...CFG, maxTier: 0 }, makeIdx(646.5, pois), {});
  const cheap = computePlan({ ...CFG, maxTier: 1 }, makeIdx(646.5, pois), {});
  assert.equal(any.days[0].stops.find((s) => s.type === 'lodging').chosen?.poi.id, 'hilton350');
  assert.equal(cheap.days[0].stops.find((s) => s.type === 'lodging').chosen?.poi.id, 'motel290');
  // unknown-tier independent still suggested for base camp under a $ cap
  const base = cheap.days[cheap.days.length - 1].stops.find((s) => s.type === 'lodging');
  assert.equal(base.chosen?.poi.id, 'indie640');
});

test('priceTier classifies brands into bands', async () => {
  const { priceTier } = await import('../js/poi.js');
  const t = (name, cat = 'lodging', sub = null, brand = null) =>
    priceTier({ cat, sub, name, tags: { brand } });
  assert.equal(t('Motel 6 Wytheville'), 1);
  assert.equal(t('Econo Lodge near BRP'), 1);
  assert.equal(t('Hampton Inn & Suites by Hilton'), 2); // sub-brand outranks the parent token
  assert.equal(t('Tru by Hilton Asheville'), 2);
  assert.equal(t('Holiday Inn Express'), 2);
  assert.equal(t('DoubleTree by Hilton Asheville'), 3);
  assert.equal(t('Courtyard Knoxville'), 3);
  assert.equal(t('Fontana Village Resort'), 0);   // independent: unknown
  assert.equal(t('Anywhere', 'camping'), 1);      // campgrounds are budget by nature
  assert.equal(t('Backpackers place', 'lodging', 'hostel'), 1);
});

// ---- cfg.fromMile: "continue from here" replanning of the remaining route ----

test('fromMile defaults to 0 and is byte-identical to a whole-trip plan', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640), ...foodEvery(60, 646.5)]);
  const plan = computePlan(CFG, idx, {});
  assert.equal(plan.totals.fromMile, 0);
  assert.equal(plan.totals.miles, plan.totals.totalMiles);    // remaining == whole on a full plan
  assert.equal(plan.totals.totalMiles, 646.5);
  assert.equal(plan.totals.rideHrs, 646.5 / CFG.avgMph);
});

test('fromMile mid-route plans only the remaining miles, nothing before the resume point', () => {
  const idx = makeIdx(646.5, [...gasEvery(40, 646.5), ...lodgingAt(180, 350, 540, 640), ...foodEvery(60, 646.5)]);
  const M = 200;
  const plan = computePlan({ ...CFG, fromMile: M }, idx, {});
  assert.equal(plan.totals.fromMile, M);
  assert.equal(plan.totals.totalMiles, 646.5);
  assert.ok(Math.abs(plan.totals.miles - (646.5 - M)) < 1e-9, 'totals.miles is REMAINING');
  assert.ok(Math.abs(plan.totals.rideHrs - (646.5 - M) / CFG.avgMph) < 1e-9);
  assert.ok(plan.days.length >= 1);
  assert.ok(Math.abs(plan.days[0].startMile - M) < 1e-6, `first day starts at ${plan.days[0].startMile}`);
  for (const day of plan.days) assert.ok(day.startMile >= M - 1e-6, 'no day starts before fromMile');
  for (const leg of plan.fuelLegs) assert.ok(leg.mile > M - 1e-6, 'no fuel leg before fromMile');
});

test('fromMile === total (already at base camp) yields an empty plan, no throw', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640)]);
  const plan = computePlan({ ...CFG, fromMile: 646.5 }, idx, {});
  assert.equal(plan.days.length, 0);
  assert.equal(plan.fuelLegs.length, 0);
  assert.equal(plan.totals.miles, 0);
  assert.equal(plan.totals.fromMile, 646.5);
});

test('fromMile clamps negative / overshoot / NaN', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640)]);
  assert.equal(computePlan({ ...CFG, fromMile: -50 }, idx, {}).totals.fromMile, 0);
  assert.equal(computePlan({ ...CFG, fromMile: 999 }, idx, {}).totals.fromMile, 646.5);
  assert.equal(computePlan({ ...CFG, fromMile: 'nope' }, idx, {}).totals.fromMile, 0);
  assert.equal(computePlan({ ...CFG, fromMile: NaN }, idx, {}).totals.fromMile, 0);
});

test('fuel picks behind fromMile are skipped; picks ahead still honored', () => {
  const idx = makeIdx(646.5, [...gasEvery(35, 646.5), ...lodgingAt(540, 640)]);
  const plan = computePlan({ ...CFG, fromMile: 200 }, idx, { fuel: ['g70', 'g315'] });
  assert.ok(!plan.fuelLegs.some((l) => l.chosen.poi.id === 'g70'), 'g70 (behind 200) is not a leg');
  assert.ok(plan.fuelLegs.some((l) => l.chosen.poi.id === 'g315' && l.isPick), 'g315 (ahead) still picked');
});

test('classifyPoiSlot maps categories to the right slot', () => {
  const idx = makeIdx(646.5, [...gasEvery(45, 646.5), ...lodgingAt(355, 640), ...foodEvery(60, 646.5)]);
  const plan = computePlan(CFG, idx, {});
  assert.deepEqual(classifyPoiSlot(plan, idx, 'g90'), { kind: 'fuel' });
  assert.equal(classifyPoiSlot(plan, idx, 'h355').kind, 'lodging');
  assert.equal(classifyPoiSlot(plan, idx, 'h355').dayIdx, 0);
  const lunch = classifyPoiSlot(plan, idx, 'f180');
  assert.equal(lunch.kind, 'lunch');
  assert.equal(lunch.dayIdx, 0);
});
