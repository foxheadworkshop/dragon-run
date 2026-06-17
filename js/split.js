// Pure cost-split / settle-up math. Money is integer cents end-to-end (no float drift).
// No DOM, no I/O — unit-tested under node --test.

import { riderColor } from './state.js';

export function formatUsd(cents) {
  const neg = cents < 0;
  const v = Math.abs(Math.round(cents));
  return (neg ? '-$' : '$') + (v / 100).toFixed(2);
}

// "24", "24.5", "$24.50", "1,200" -> 2400 / 2450 / 120000 cents; null if invalid / <= 0.
export function parseUsd(str) {
  const cleaned = String(str ?? '').replace(/[^0-9.]/g, '');
  if (!cleaned || !/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

// The set of people who can pay/share: current rider + roster + live riders + anyone
// referenced by an expense. Returns [{uid, name, color}], deduped, me first.
export function rosterFor(state) {
  const map = new Map();
  const add = (uid, name, color) => {
    if (!uid) return;
    const cur = map.get(uid) || {};
    map.set(uid, { uid, name: name || cur.name || '', color: color || cur.color || riderColor(uid) });
  };
  add(state.rider.uid, state.rider.name, state.rider.color);
  for (const r of state.roster || []) add(r.uid, r.name, r.color);
  for (const r of state.riders || []) add(r.uid, r.name, r.color);
  for (const e of Object.values(state.expenses || {})) {
    add(e.payer, e.payerName, null);
    for (const u of e.sharers) add(u, null, null);
  }
  return [...map.values()];
}

// Net balance per uid in integer cents. Positive = owed money; negative = owes.
// Equal split with remainder distributed deterministically so the books sum to 0.
export function computeBalances(expenses, uids) {
  const bal = new Map(uids.map((u) => [u, 0]));
  for (const e of Object.values(expenses)) {
    const sharers = e.sharers.filter((u) => bal.has(u));
    if (!sharers.length) continue;
    const n = sharers.length;
    const base = Math.floor(e.amountCents / n);
    const rem = e.amountCents - base * n; // 0..n-1 leftover cents
    if (bal.has(e.payer)) bal.set(e.payer, bal.get(e.payer) + e.amountCents);
    const ordered = [...sharers].sort();
    ordered.forEach((u, i) => bal.set(u, bal.get(u) - (base + (i < rem ? 1 : 0))));
  }
  return bal;
}

// Min-cash-flow: greedy max-debtor/max-creditor matching → [{from, to, amountCents}].
export function simplifyDebts(balances) {
  const creditors = [], debtors = [];
  for (const [uid, c] of balances) {
    if (c > 0) creditors.push({ uid, amt: c });
    else if (c < 0) debtors.push({ uid, amt: -c });
  }
  const cmp = (a, b) => b.amt - a.amt || (a.uid < b.uid ? -1 : 1);
  creditors.sort(cmp); debtors.sort(cmp);
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const cr = creditors[ci], db = debtors[di];
    const pay = Math.min(cr.amt, db.amt);
    if (pay > 0) transfers.push({ from: db.uid, to: cr.uid, amountCents: pay });
    cr.amt -= pay; db.amt -= pay;
    if (cr.amt === 0) ci++;
    if (db.amt === 0) di++;
  }
  return transfers;
}

// What one rider sees: who they owe, who owes them.
export function mySettlement(transfers, myUid) {
  return {
    iOwe: transfers.filter((t) => t.from === myUid).map((t) => ({ uid: t.to, amountCents: t.amountCents })),
    owedToMe: transfers.filter((t) => t.to === myUid).map((t) => ({ uid: t.from, amountCents: t.amountCents })),
  };
}
