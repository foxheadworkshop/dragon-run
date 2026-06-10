// App state: one store, pub/sub, localStorage persistence for the durable parts.

const LS_KEY = 'dragon-run-v1';

export const DEFAULTS = {
  cfg: {
    tankRangeMi: 130,
    reservePct: 15,
    hoursPerDay: 8,
    avgMph: 45,
    departTime: '08:00',
    startDate: nextSaturday(),
    stayDays: 2,
    returnPreset: 'brp', // 'brp' | 'fast'
    includeCamping: true,
  },
  toggles: { fuel: true, food: true, lodging: true, camping: true },
  picks: {
    out: { fuel: [], lodging: {}, lunch: {} },
    ret: { fuel: [], lodging: {}, lunch: {} },
  },
  rider: { uid: null, name: null, color: null },
  tripId: null,
  dir: 'out', // 'out' | 'ret'
};

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

export function createStore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { /* corrupted — start fresh */ }

  const state = {
    cfg: { ...DEFAULTS.cfg, ...(saved?.cfg || {}) },
    toggles: { ...DEFAULTS.toggles, ...(saved?.toggles || {}) },
    picks: normalizePicks(saved?.picks),
    rider: { ...DEFAULTS.rider, ...(saved?.rider || {}) },
    tripId: saved?.tripId || null,
    dir: 'out',
    // volatile (not persisted):
    votes: {},   // poiId -> { count, mine, names[] }
    riders: [],  // [{ uid, name, color, lastSeen }]
    syncMode: 'local',
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
        const { cfg, toggles, picks, rider, tripId } = state;
        localStorage.setItem(LS_KEY, JSON.stringify({ cfg, toggles, picks, rider, tripId }));
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
