// node --test scripts/split.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, parseUsd, computeBalances, simplifyDebts, mySettlement } from '../js/split.js';

const exp = (id, amountCents, payer, sharers) => ({ id, amountCents, payer, sharers });

test('parseUsd handles formats and rejects junk', () => {
  assert.equal(parseUsd('24'), 2400);
  assert.equal(parseUsd('24.5'), 2450);
  assert.equal(parseUsd('$24.50'), 2450);
  assert.equal(parseUsd('1,200.00'), 120000);
  assert.equal(parseUsd(''), null);
  assert.equal(parseUsd('0'), null);
  assert.equal(parseUsd('abc'), null);
  assert.equal(parseUsd('1.234'), null);
});

test('formatUsd', () => {
  assert.equal(formatUsd(2400), '$24.00');
  assert.equal(formatUsd(-833), '-$8.33');
  assert.equal(formatUsd(0), '$0.00');
});

test('balances sum to zero and split is exact (remainder distributed)', () => {
  // $10.00 split 3 ways = 333/333/334
  const expenses = { e1: exp('e1', 1000, 'a', ['a', 'b', 'c']) };
  const bal = computeBalances(expenses, ['a', 'b', 'c']);
  const sum = [...bal.values()].reduce((s, c) => s + c, 0);
  assert.equal(sum, 0, 'books must sum to zero — no penny leak');
  // a paid 1000, owes own 334 share -> +666; b,c owe 333 each
  assert.equal(bal.get('a'), 1000 - 334);
  assert.equal(bal.get('b'), -333);
  assert.equal(bal.get('c'), -333);
});

test('the hotel-then-dinner scenario settles correctly', () => {
  // A covers $240 hotel (4 share), B covers $80 dinner (4 share)
  const expenses = {
    h: exp('h', 24000, 'a', ['a', 'b', 'c', 'd']),
    d: exp('d', 8000, 'b', ['a', 'b', 'c', 'd']),
  };
  const uids = ['a', 'b', 'c', 'd'];
  const bal = computeBalances(expenses, uids);
  assert.equal([...bal.values()].reduce((s, c) => s + c, 0), 0);
  // each person's fair share = (240+80)/4 = $80. a paid 240 -> +160; b paid 80 -> 0; c,d -> -80
  assert.equal(bal.get('a'), 16000);
  assert.equal(bal.get('b'), 0);
  assert.equal(bal.get('c'), -8000);
  assert.equal(bal.get('d'), -8000);
  const transfers = simplifyDebts(bal);
  // c and d each pay a 80 -> a is owed 160 total
  assert.equal(transfers.reduce((s, t) => s + t.amountCents, 0), 16000);
  for (const t of transfers) assert.equal(t.to, 'a');
});

test('payer can opt out of their own expense (covers it for others)', () => {
  // A pays $100 dinner but isn't eating — splits among b,c only
  const expenses = { x: exp('x', 10000, 'a', ['b', 'c']) };
  const bal = computeBalances(expenses, ['a', 'b', 'c']);
  assert.equal(bal.get('a'), 10000);
  assert.equal(bal.get('b'), -5000);
  assert.equal(bal.get('c'), -5000);
});

test('simplifyDebts produces minimal, correct transfers', () => {
  const bal = new Map([['a', 16000], ['b', 0], ['c', -8000], ['d', -8000]]);
  const t = simplifyDebts(bal);
  assert.ok(t.length <= 3);
  // reconstruct balances from transfers — must invert exactly
  const recon = new Map([...bal.keys()].map((u) => [u, 0]));
  for (const x of t) { recon.set(x.from, recon.get(x.from) - x.amountCents); recon.set(x.to, recon.get(x.to) + x.amountCents); }
  for (const [u, c] of bal) assert.equal(recon.get(u), c);
});

test('mySettlement filters to one rider', () => {
  const transfers = [
    { from: 'c', to: 'a', amountCents: 8000 },
    { from: 'd', to: 'a', amountCents: 8000 },
  ];
  const mine = mySettlement(transfers, 'c');
  assert.equal(mine.iOwe.length, 1);
  assert.equal(mine.iOwe[0].uid, 'a');
  assert.equal(mine.iOwe[0].amountCents, 8000);
  assert.equal(mine.owedToMe.length, 0);
  const aView = mySettlement(transfers, 'a');
  assert.equal(aView.owedToMe.length, 2);
  assert.equal(aView.iOwe.length, 0);
});

test('orphaned sharer (left roster) is skipped without crashing', () => {
  const expenses = { e: exp('e', 9000, 'a', ['a', 'b', 'ghost']) };
  const bal = computeBalances(expenses, ['a', 'b']); // ghost not in uids
  // split among a,b only (ghost filtered) -> 4500 each
  assert.equal(bal.get('a'), 9000 - 4500);
  assert.equal(bal.get('b'), -4500);
});
