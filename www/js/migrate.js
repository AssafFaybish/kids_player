// migrate.js — one-time, idempotent, resumable migration of the legacy Preferences
// blobs (videos:<profileId> / source:<profileId>) into IndexedDB.
//
// NON-DESTRUCTIVE: the Preferences blobs are NEVER deleted — a few hundred KB is a
// cheap permanent safety net. The completion flag lives in IDB meta('migration:v1'),
// deliberately NOT in Preferences: if IndexedDB is ever wiped, the flag disappears
// with it and the app re-migrates from the surviving blob automatically.
//
// planMigration() is PURE (node-tested); runMigrationIfNeeded() is the I/O wrapper.

import { prefGet } from './platform.js';
import { MANUAL_BASE } from './order.js';
import { fnv1a, libraryIdFor } from './util.js';
import {
  openDb, getMeta, patchMeta, putVideos, putThumb, putSources, profScope
} from './db.js';

/** data:<mime>;base64,<payload> → { mime, bytes } | null. Never throws. */
export function dataUrlToBytes(dataUrl) {
  try {
    const m = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    if (!m[2]) return { mime, bytes: new TextEncoder().encode(decodeURIComponent(m[3])) };
    const bin = typeof atob === 'function' ? atob(m[3]) : Buffer.from(m[3], 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, bytes };
  } catch { return null; }
}

/** Legacy display order (mirrors the old store.listForDisplay, kept local so this stays pure). */
function legacyDisplayOrder(items, source) {
  if (source && source.mode === 'remote') return items.slice();
  return items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/**
 * PURE migration plan for one profile.
 * Invariants (tested):
 *  - display order is PRESERVED (descending sortKeys follow the old on-screen order);
 *    the sheet-order reversal applies only to FUTURE syncs, which re-merge by key.
 *  - no legacy item is ever gift-wrapped (origin 'legacy' + no profileVideoState entry;
 *    gifts are only assigned by planMutations to newly-discovered library content).
 *  - localPath / addedAt / title carried verbatim; base64 thumbs split into thumb jobs.
 */
export function planMigration({ profileId, items, source, now = Date.now() }) {
  const scopeId = profScope(profileId);
  const ordered = legacyDisplayOrder(Array.isArray(items) ? items : [], source);
  const N = ordered.length;
  const videos = [];
  const thumbs = [];

  ordered.forEach((it, i) => {
    if (!it || !it.key) return;
    let thumbId = null;
    let thumbUrl = null;
    if (typeof it.thumb === 'string' && it.thumb.startsWith('data:')) {
      thumbId = 'file:' + fnv1a(it.key);
      thumbs.push({ id: thumbId, dataUrl: it.thumb });
    } else if (typeof it.thumb === 'string' && it.thumb) {
      thumbUrl = it.thumb;
    }
    videos.push({
      scopeId,
      key: it.key,
      type: it.type,
      id: it.id ?? null,
      url: it.url ?? null,
      srcUrl: it.srcUrl || it.url || '',
      driveId: it.driveId ?? null,
      title: it.title || '',
      normTitle: '',
      titleSource: it.title ? 'legacy' : null,
      folderId: 'mine',
      channelId: null,
      // index 0 = shown first = highest key; stays below future manual adds
      // (MANUAL_BASE + addedAt/1e6 ≈ MANUAL_BASE + 1.7e6 ≫ MANUAL_BASE + N)
      sortKey: MANUAL_BASE + (N - i),
      publishedAt: null,
      rowIndex: null,
      origin: 'legacy',
      state: 'live',
      addedAt: it.addedAt || now,
      approvedAt: it.addedAt || now,
      thumbId,
      thumbUrl,
      localPath: it.localPath ?? null,
      updatedAt: now
    });
  });

  const sources = {
    profileId,
    schema: 1,
    // ⏳ v1.0.38: these three fields are the SUNSET MIGRATION'S INPUT — a pre-IndexedDB
    // install's `source.mode === 'remote'` row is the only pointer it has to that family's
    // sheet. Do NOT clean them up before sunset.js goes (2026-09-10); migrate.test.mjs
    // pins them, and test/sunset.test.mjs's checklist names this file.
    sheetUrl: (source && source.mode === 'remote' && source.url) ? source.url : null,
    libraryId: (source && source.mode === 'remote' && source.url) ? libraryIdFor(source.url) : null,
    sheetHash: null,
    sheetFetchedAt: null,
    shareIntent: { enabled: true, requireApproval: true },
    defaultAutoApprove: false,
    maxItemsPerChannel: 500,
    maxItemsTotal: 5000,
    drive: { enabled: false },
    // legacy-remote items live in 'mine' until the first new-model sheet sync
    // re-merges them by key (quarantine mode: unknown keys arrive as pending).
    legacySheetMigrated: !!(source && source.mode === 'remote' && source.url),
    updatedAt: now
  };

  return { scopeId, videos, thumbs, sources };
}

const CHUNK = 100;

/** Idempotent + resumable. Safe to call on every boot; no-op once completed. */
export async function runMigrationIfNeeded() {
  await openDb();
  const state = (await getMeta('migration:v1')) || { profiles: {} };
  if (state.done) return { migrated: false };

  let profiles = [];
  try { profiles = JSON.parse((await prefGet('profiles')) || '[]'); } catch {}
  if (!Array.isArray(profiles)) profiles = [];

  let migratedAny = false;
  for (const p of profiles) {
    const st = state.profiles[p.id];
    if (st && st.done) continue;

    let items = [];
    let source = { mode: 'manual', url: '' };
    try { items = JSON.parse((await prefGet('videos:' + p.id)) || '[]'); } catch {}
    try { source = JSON.parse((await prefGet('source:' + p.id)) || 'null') || source; } catch {}
    if (!Array.isArray(items)) items = [];

    const plan = planMigration({ profileId: p.id, items, source });

    for (let i = st && st.videosDone ? st.videosDone : 0; i < plan.videos.length; i += CHUNK) {
      await putVideos(plan.videos.slice(i, i + CHUNK));
      state.profiles[p.id] = { videosDone: Math.min(i + CHUNK, plan.videos.length) };
      await patchMeta('migration:v1', { profiles: state.profiles });
    }
    for (const t of plan.thumbs) {
      const dec = dataUrlToBytes(t.dataUrl);
      if (!dec) continue; // dropped silently; captureFrame re-creates it on next play
      try { await putThumb(t.id, new Blob([dec.bytes], { type: dec.mime }), { origin: 'legacy' }); } catch {}
    }
    await putSources(plan.sources);

    state.profiles[p.id] = { done: true, count: plan.videos.length, at: Date.now() };
    await patchMeta('migration:v1', { profiles: state.profiles });
    migratedAny = true;
  }

  await patchMeta('migration:v1', { done: true, at: Date.now() });
  return { migrated: migratedAny };
}
