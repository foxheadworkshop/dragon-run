// node --test scripts/sun.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes } from '../js/sun.js';

test('mid-June Asheville: sunrise ~6:15a, sunset ~8:45p EDT', () => {
  const s = sunTimes(35.595, -82.551, '2026-06-13');
  assert.ok(s, 'expected sun times');
  assert.ok(s.riseMin >= 360 && s.riseMin <= 390, `rise ${s.riseMin} min (${Math.floor(s.riseMin / 60)}:${s.riseMin % 60})`);
  assert.ok(s.setMin >= 1230 && s.setMin <= 1262, `set ${s.setMin} min`);
});

test('winter solstice Fredericksburg: sunrise ~7:25a, sunset ~4:50p EST', () => {
  const s = sunTimes(38.303, -77.461, '2026-12-21');
  assert.ok(s.riseMin >= 425 && s.riseMin <= 465, `rise ${s.riseMin} min`);
  assert.ok(s.setMin >= 980 && s.setMin <= 1020, `set ${s.setMin} min`);
});

test('sunset is later at the western end of the route (Deals Gap vs Fredericksburg)', () => {
  const east = sunTimes(38.303, -77.461, '2026-06-13');
  const west = sunTimes(35.466, -83.922, '2026-06-13');
  assert.ok(west.setMin > east.setMin, `west ${west.setMin} should set after east ${east.setMin}`);
});

test('garbage date returns null', () => {
  assert.equal(sunTimes(35, -82, 'not-a-date'), null);
});
