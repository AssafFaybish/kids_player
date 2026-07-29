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

const STEPS = [
  { v: 1, run: forceSheetReparse }
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
