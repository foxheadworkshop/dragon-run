// App state: one store, pub/sub, localStorage persistence for the durable parts.

const LS_KEY = 'dragon-run-v1';

// The group's planned departure. Stored snapshots older than CFG_V are migrated
// onto this date so everyone's app moves together when the plan changes.
const TRIP_START = '2026-06-19';
const CFG_V = 4; // v3→v4: added state.progress (group resume anchor)

export const DEFAULTS = {
  cfg: {
    tankRangeMi: 130,
    reservePct: 15,
    hoursPerDay: 8,
    avgMph: 45,
    departTime: '08:00',
    startDate: TRIP_START,
    stayDays: 2,
    returnPreset: 'brp', // 'brp' | 'fast'
    includeCamping: true,
    maxTier: 0, // lodging budget cap: 0 = any, 1 = $, 2 = $$
    fuelOverride: false, // when true, use the slider tank value instead of the roster minimum (local-only, never synced)
  },
  toggles: { fuel: true, food: true, lodging: true, camping: true, rides: true, sights: true, radar: false },
  picks: {
    out: { fuel: [], lodging: {}, lunch: {} },
    ret: { fuel: [], lodging: {}, lunch: {} },
  },
  rider: { uid: null, name: null, color: null },
  tripId: null,
  dir: 'out', // 'out' | 'ret'
};

export const FUEL_MIN = 60, FUEL_MAX = 300;

export function createStore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* corrupted — start fresh */ }
  if (saved && (saved.v || 1) < CFG_V && saved.cfg) {
    saved.cfg.startDate = TRIP_START; // plan moved — carry every saved browser with it
  }

  const state = {
    cfg: { ...DEFAULTS.cfg, ...(saved?.cfg || {}) },
    toggles: { ...DEFAULTS.toggles, ...(saved?.toggles || {}) },
    picks: normalizePicks(saved?.picks),
    rider: { ...DEFAULTS.rider, ...(saved?.rider || {}) },
    tripId: saved?.tripId || null,
    dir: 'out',
    // durable additions:
    roster: Array.isArray(saved?.roster) ? saved.roster : [],   // [{uid,name,bike,tankRangeMi,color,rsvp}]
    staging: saved?.staging || null,                            // {label, lat?, lon?, time?}
    progress: normalizeProgress(saved?.progress),               // {fromMile, completedDays[], startedAt} | null — group resume anchor
    expenses: normalizeExpenses(saved?.expenses),               // {id: Expense} — persisted only in local mode
    // volatile (not persisted):
    votes: {},   // poiId -> { count, mine, names[] }
    riders: [],  // [{ uid, name, color, lastSeen }]
    syncMode: 'local',
    offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    swUpdate: false,
  };
  if (!state.rider.uid) {
    state.rider.uid = randomId(12);
    state.rider.color = riderColor(state.rider.uid);
  }

  const subs = new Set();
  let saveTimer = null;

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const { cfg, toggles, picks, rider, tripId, roster, staging, progress, expenses, syncMode } = state;
        // progress persists in ALL modes: it's the group's last-known position and SHOULD
        // survive an offline reload at Deals Gap, then yield to the remote snapshot when it
        // arrives. (Expenses, by contrast, are excluded in firebase mode below.)
        const base = { v: CFG_V, cfg, toggles, picks, rider, tripId, roster, staging, progress };
        // Expenses live in Firestore when synced; only persist them locally in treasurer mode
        // so a Firebase trip doesn't carry a stale copy that fights the live snapshot.
        if (syncMode !== 'firebase') base.expenses = expenses;
        localStorage.setItem(LS_KEY, JSON.stringify(base));
      } catch { /* private mode / quota — in-memory state still works */ }
    }, 250);
  }

  return {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    // update('cfg', {avgMph: 50}) or update({dir: 'ret'}) for top-level keys
    update(sectionOrPatch, patch, meta = {}) {
      if (typeof sectionOrPatch === 'string') {
        Object.assign(state[sectionOrPatch], patch);
      } else {
        Object.assign(state, sectionOrPatch);
        meta = patch || {};
      }
      persist();
      for (const fn of subs) fn(state, meta);
    },
    replacePicks(dir, kind, value, meta = {}) {
      state.picks[dir][kind] = value;
      persist();
      for (const fn of subs) fn(state, meta);
    },
  };
}

export function normalizePicks(picks) {
  const empty = () => ({ fuel: [], lodging: {}, lunch: {} });
  return {
    out: { ...empty(), ...(picks?.out || {}) },
    ret: { ...empty(), ...(picks?.ret || {}) },
  };
}

// Sanitize a saved/synced expense map into the canonical shape. Money is integer cents.
export function normalizeExpenses(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [id, e] of Object.entries(raw)) {
      if (!e || typeof e !== 'object') continue;
      const amountCents = Math.round(Number(e.amountCents) || 0);
      const sharers = Array.isArray(e.sharers) ? [...new Set(e.sharers.filter(Boolean))] : [];
      if (amountCents <= 0 || !e.payer || !sharers.length) continue;
      out[id] = {
        id,
        title: String(e.title || '').slice(0, 60),
        amountCents,
        payer: String(e.payer),
        payerName: String(e.payerName || '').slice(0, 40),
        sharers,
        createdBy: String(e.createdBy || e.payer),
        createdAt: Number(e.createdAt) || Date.now(),
        updatedAt: Number(e.updatedAt) || Number(e.createdAt) || Date.now(),
      };
    }
  }
  return out;
}

// Sanitize a saved/synced progress anchor. Returns null (no progress) for junk.
// Shape: { fromMile, completedDays:[{dayNum,endMile,label,lat,lon,dateISO}], startedAt }.
export function normalizeProgress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fromMile = Number(raw.fromMile);
  if (!Number.isFinite(fromMile) || fromMile < 0) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const days = Array.isArray(raw.completedDays) ? raw.completedDays : [];
  const completedDays = days.map((d, i) => ({
    dayNum: Number.isFinite(Number(d?.dayNum)) ? Math.max(1, Math.round(Number(d.dayNum))) : i + 1,
    endMile: Number.isFinite(Number(d?.endMile)) ? Number(d.endMile) : fromMile,
    label: String(d?.label || '').slice(0, 80),
    lat: num(d?.lat), lon: num(d?.lon),
    dateISO: /^\d{4}-\d{2}-\d{2}$/.test(d?.dateISO || '') ? d.dateISO : null,
  })).filter((d) => d.endMile >= 0).slice(0, 14);
  return { fromMile, completedDays, startedAt: Number(raw.startedAt) || Date.now() };
}

// Ensure the local rider has a roster entry (so they appear and their bike counts).
export function ensureSelfInRoster(state) {
  const me = state.rider;
  if (!me?.uid) return false;
  let entry = state.roster.find((r) => r.uid === me.uid);
  if (!entry) {
    entry = { uid: me.uid, name: me.name || 'Me', bike: '', tankRangeMi: state.cfg.tankRangeMi, color: me.color, rsvp: 'in' };
    state.roster.push(entry);
    return true;
  }
  if (me.name && entry.name !== me.name) { entry.name = me.name; return true; }
  return false;
}

// Effective fuel range for planning: the thirstiest (smallest) tank in the roster,
// unless the local rider has flipped the manual override (then use the slider value).
export function effectiveFuelRange(state) {
  const slider = state.cfg.tankRangeMi;
  if (state.cfg.fuelOverride) return { range: slider, source: 'slider', bike: null };
  const tanks = (state.roster || [])
    .map((r) => ({ t: Number(r.tankRangeMi), r }))
    .filter((x) => x.t >= FUEL_MIN && x.t <= FUEL_MAX);
  if (!tanks.length) return { range: slider, source: 'slider', bike: null };
  const min = tanks.reduce((a, b) => (b.t < a.t ? b : a));
  return { range: min.t, source: 'roster', bike: min.r };
}

export function randomId(len = 16) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; // base58
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

const RIDER_COLORS = ['#ff5d3b', '#ffb02e', '#41c7a6', '#5fa8ff', '#c792ea', '#ff7ab2', '#9ccc65', '#ffd54f'];
export function riderColor(uid) {
  let h = 0;
  for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return RIDER_COLORS[h % RIDER_COLORS.length];
}
