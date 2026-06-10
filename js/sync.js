// Group sync. One interface, two modes:
//   firebase — Firestore live sync (loaded dynamically ONLY when a config exists)
//   local    — no backend; state lives in localStorage, sharing via #s= links
//
// The Firebase web config is public by design; security lives in Firestore rules.

import firebaseConfig from './firebase-config.js';
import { randomId } from './state.js';

const FB = 'https://www.gstatic.com/firebasejs/11.6.1';
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export async function createSync({ tripId, rider, onRemote, getSnapshot }) {
  if (!firebaseConfig) {
    return {
      mode: 'local', tripId: null, uid: rider.uid,
      saveConfig() {}, savePicks() {},
      async toggleVote() { return false; },
      heartbeat() {},
      async createSharedTrip() { return null; },
      dispose() {},
    };
  }

  const [{ initializeApp }, authMod, fsMod] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const {
    getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField,
    collection, onSnapshot, serverTimestamp,
  } = fsMod;

  const app = initializeApp(firebaseConfig);
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    db = getFirestore(app); // cache init can fail (e.g. private mode) — sync still works
  }
  const auth = authMod.getAuth(app);
  await authMod.signInAnonymously(auth);
  const uid = auth.currentUser.uid;

  const unsubs = [];
  let hbTimer = null;

  async function attach(id) {
    const tripRef = doc(db, 'trips', id);
    const snap = await getDoc(tripRef);
    if (!snap.exists()) {
      const s = getSnapshot();
      await setDoc(tripRef, {
        meta: { name: 'Dragon Run', createdAt: Date.now(), updatedBy: uid },
        config: s.cfg,
        picks: s.picks,
      });
    }
    unsubs.push(onSnapshot(tripRef, (ds) => {
      if (ds.metadata.hasPendingWrites || !ds.exists()) return;
      const d = ds.data();
      onRemote({ config: d.config, picks: d.picks });
    }, (e) => console.warn('trip listener', e)));

    unsubs.push(onSnapshot(collection(db, 'trips', id, 'votes'), (qs) => {
      const votes = {};
      qs.forEach((vd) => {
        const v = vd.data();
        if (!v?.poiId) return;
        const slot = votes[v.poiId] || (votes[v.poiId] = { count: 0, mine: false, names: [] });
        slot.count++;
        if (v.uid === uid) slot.mine = true;
        if (v.name) slot.names.push(v.name);
      });
      onRemote({ votes });
    }, (e) => console.warn('votes listener', e)));

    unsubs.push(onSnapshot(collection(db, 'trips', id, 'riders'), (qs) => {
      const now = Date.now();
      const riders = [];
      qs.forEach((rd) => {
        const r = rd.data();
        const seen = r.lastSeen?.toMillis?.() ?? now; // pending serverTimestamp -> treat as now
        if (now - seen < ONLINE_WINDOW_MS) riders.push({ uid: rd.id, name: r.name, color: r.color, lastSeen: seen });
      });
      onRemote({ riders });
    }, (e) => console.warn('riders listener', e)));

    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      setDoc(doc(db, 'trips', id, 'riders', uid), {
        name: rider.name || 'rider',
        color: rider.color || '#9aa1ac',
        lastSeen: serverTimestamp(),
      }).catch(() => {});
    };
    beat();
    hbTimer = setInterval(beat, 60_000);
    document.addEventListener('visibilitychange', beat);
    api.heartbeat = beat;
  }

  const api = {
    mode: tripId ? 'firebase' : 'firebase-standby',
    tripId: tripId || null,
    uid,

    saveConfig(partial) {
      if (!api.tripId) return;
      const patch = {};
      for (const [k, v] of Object.entries(partial)) patch[`config.${k}`] = v;
      updateDoc(doc(db, 'trips', api.tripId), patch).catch((e) => console.warn('saveConfig', e));
    },

    savePicks(dir, picksForDir) {
      if (!api.tripId) return;
      updateDoc(doc(db, 'trips', api.tripId), { [`picks.${dir}`]: picksForDir })
        .catch((e) => console.warn('savePicks', e));
    },

    async toggleVote(poiId, mine) {
      if (!api.tripId) return false;
      const ref = doc(db, 'trips', api.tripId, 'votes', `${poiId}_${uid}`);
      try {
        if (mine) await deleteDoc(ref);
        else await setDoc(ref, { poiId, uid, name: rider.name || 'rider', at: Date.now() });
        return true;
      } catch (e) { console.warn('vote', e); return false; }
    },

    heartbeat() {},

    async createSharedTrip() {
      const id = randomId(16);
      api.tripId = id;
      api.mode = 'firebase';
      await attach(id);
      return id;
    },

    dispose() {
      unsubs.forEach((u) => u());
      clearInterval(hbTimer);
    },
  };

  if (tripId) await attach(tripId);
  return api;
}
