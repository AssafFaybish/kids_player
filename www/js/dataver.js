// dataver.js — one-shot DATA migrations after an app update (v1.0.8, user request:
// "when a release changes the folder/data structure, old installs must catch up").
//
// How it works: meta['dataVersion'] records the highest applied step. On boot,
// every step ABOVE it runs once, in order, then the version is bumped. Steps must
// be idempotent (a crash between step and bump reruns it) and must never destroy
// data — prefer "force a rebuild" (hash resets) over in-place rewrites.
//
// This complements the existing continuous self-healers (absorbMineIntoShared,
// gift-state repair) — those run every activation; steps here are for one-time
// structure changes that would be wasteful to re-check forever.

import { getMeta, putMeta, getSources, putSources } from './db.js';
import { getProfiles } from './store.js';

/** PURE (node-tested): which steps still need to run, in order. */
export function pendingSteps(current, steps) {
  return (steps || [])
    .filter((s) => s && typeof s.v === 'number' && s.v > (current || 0))
    .sort((a, b) => a.v - b.v);
}

/* ---------------- the steps ---------------- */

/**
 * v1: force a FULL sheet re-parse on the next sync of every profile.
 * The sheet hash-skip is a performance cache — after an update that changes how
 * rows are interpreted (folders, thumbs, flags), the cache must not mask the
 * new interpretation.
 */
async function forceSheetReparse() {
  for (const p of await getProfiles()) {
    const src = await getSources(p.id);
    if (src && src.sheetHash) await putSources({ ...src, sheetHash: null, updatedAt: Date.now() });
  }
}

/**
 * v2 (v1.0.20): retire a runaway 🎁 folder.
 *
 * Before the baseline fix, adding a channel spent the "gifts baselined" flag on a
 * library where everything was still pending, and the following sync gifted the whole
 * backfill — devices in the field now show a "חדשים" folder holding their entire
 * library. `planGiftRunawayRepair` keeps the newest 12 and retires the rest, which is
 * what the first sync should have done. Idempotent: once repaired the pile is small,
 * so a rerun decides to do nothing.
 */
async function retireRunawayGifts() {
  const { planGiftRunawayRepair } = await import('./plan.js');
  const { openDb, putVideoStates, getSources, loadMergeIndex, profScope } = await import('./db.js');
  const db = await openDb();
  for (const p of await getProfiles()) {
    const states = [];
    await new Promise((resolve, reject) => {
      const range = IDBKeyRange.bound([p.id, ''], [p.id, '￿']);
      const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        states.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    // Recency comes from the VIDEO records, never from giftRank: the runaway piles this
    // step repairs were ranked in IndexedDB key order (alphabetical), so ranking by
    // giftRank retired the newest videos and kept an arbitrary dozen — permanently.
    const src = await getSources(p.id);
    const sortKeyOf = new Map();
    for (const scope of [src && src.libraryId, profScope(p.id)].filter(Boolean)) {
      for (const rec of (await loadMergeIndex(scope)).values()) {
        if (rec && typeof rec.sortKey === 'number') sortKeyOf.set(rec.key, rec.sortKey);
      }
    }
    const { retire } = planGiftRunawayRepair(states, { sortKeyOf });
    if (!retire.length) continue;
    const byKey = new Map(states.map((s) => [s.key, s]));
    const now = Date.now();
    // giftRank must be DELETED, not zeroed: profileVideoState's compound by_gift index
    // drops a record when a component is missing — that is what makes the 🎁 folder a
    // pure range scan (db.js "GIFT INDEX TRICK").
    const puts = retire.map((key) => {
      const rec = { ...byKey.get(key), profileId: p.id, key, unwrappedAt: now };
      delete rec.giftRank;
      return rec;
    });
    await putVideoStates(puts);
  }
}

const STEPS = [
  { v: 1, run: forceSheetReparse },
  { v: 2, run: retireRunawayGifts }
];

export const DATA_VERSION = STEPS.length ? Math.max(...STEPS.map((s) => s.v)) : 0;

/** Run on boot (after the Preferences→IDB migration). Failures keep the old
    version so the next boot retries — a failed step must never brick startup. */
export async function runDataMigrations() {
  try {
    const current = (await getMeta('dataVersion')) || 0;
    for (const step of pendingSteps(current, STEPS)) {
      await step.run();
      await putMeta('dataVersion', step.v);
    }
  } catch (e) {
    console.warn('data migration failed (will retry next boot)', e);
  }
}
