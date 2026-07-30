// db.js — the IndexedDB access layer. I/O ONLY: no business logic lives here.
// Merging/dedupe/gifting decisions are made by pure functions (planMutations,
// mergeVideoRecord…) BEFORE calling the write functions below — that split is what
// keeps the interesting logic node-testable.
//
// CONTRACTS:
//  1. tx() resolves on transaction.oncomplete — never on the last request's onsuccess
//     (the classic IDB lie: "saved" before the txn actually commits).
//  2. putVideos() is a BLIND bulk upsert. Do not add read-modify-write logic here.
//  3. Read functions resolve null/[] for "not found"; they reject only on structural errors.
//  4. deleteVideo() writes videos+denylist+opLog in ONE transaction — the deletion and
//     its tombstone are atomic or neither happens.
//
// SCOPING (decision 20): content is keyed by scopeId, the first component of every key.
//   'lib:<fnv1a(sheet)>'  — shared library content (sheet rows + channel videos):
//                           identical across every profile/device using the same sheet.
//   'prof:<profileId>'    — per-profile content ("הסרטונים שלי": manual adds, shares).
// Per-child gift/unwrap state lives in profileVideoState, NOT on the video record, so
// one child's unwrapping never affects a sibling sharing the same library.
//
// GIFT INDEX TRICK (load-bearing): profileVideoState's by_gift index has keyPath
// ['profileId','giftRank']. IndexedDB omits a record from a compound index when any
// component is missing — so `delete rec.giftRank` on unwrap removes it from the index
// automatically. The "חדשים 🎁" folder is a pure range scan, no filtering.

export const DB_NAME = 'kidsplayer';
export const DB_VERSION = 1;

export const profScope = (profileId) => 'prof:' + profileId;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      const videos = db.createObjectStore('videos', { keyPath: ['scopeId', 'key'] });
      videos.createIndex('by_folder_sort', ['scopeId', 'folderId', 'sortKey']);
      videos.createIndex('by_state', ['scopeId', 'state', 'sortKey']);
      videos.createIndex('by_channel_title', ['scopeId', 'channelId', 'normTitle']);
      videos.createIndex('by_key', 'key'); // non-unique: same video in several scopes

      const pvs = db.createObjectStore('profileVideoState', { keyPath: ['profileId', 'key'] });
      pvs.createIndex('by_gift', ['profileId', 'giftRank']); // sparse — see header

      db.createObjectStore('channels', { keyPath: 'channelId' });

      const libCh = db.createObjectStore('libraryChannels', { keyPath: ['libraryId', 'channelId'] });
      libCh.createIndex('by_library', ['libraryId', 'order']);

      const thumbs = db.createObjectStore('thumbs', { keyPath: 'id' });
      thumbs.createIndex('by_lastUsed', 'lastUsed');

      db.createObjectStore('denylist', { keyPath: ['scopeId', 'key'] });
      db.createObjectStore('sources', { keyPath: 'profileId' });
      db.createObjectStore('meta', { keyPath: 'id' });

      const ops = db.createObjectStore('opLog', { keyPath: 'seq', autoIncrement: true });
      ops.createIndex('by_scope', 'scopeId');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('db-blocked'));
  });
  return dbPromise;
}

/** Run fn(stores…) inside one transaction; resolves on oncomplete (contract #1). */
export async function tx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = storeNames.map((n) => t.objectStore(n));
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('tx-aborted'));
    try {
      const r = fn(...stores);
      if (r && typeof r.then === 'function') r.then((v) => { result = v; }).catch((e) => { try { t.abort(); } catch {} reject(e); });
      else result = r;
    } catch (e) { try { t.abort(); } catch {} reject(e); }
  });
}

/* Promisify one IDBRequest (for reads outside tx()). */
const preq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const CHUNK = 200;

/* ---------------- videos ---------------- */

export async function getVideo(scopeId, key) {
  const db = await openDb();
  const r = await preq(db.transaction('videos').objectStore('videos').get([scopeId, key]));
  return r || null;
}

/** Blind bulk upsert, chunked so one huge sync can't hold a write txn for seconds. */
export async function putVideos(recs) {
  for (let i = 0; i < recs.length; i += CHUNK) {
    const slice = recs.slice(i, i + CHUNK);
    await tx(['videos'], 'readwrite', (videos) => { for (const r of slice) videos.put(r); });
  }
}

const folderRange = (scopeId, folderId) =>
  IDBKeyRange.bound([scopeId, folderId, -Infinity], [scopeId, folderId, Infinity]);

export async function countFolder(scopeId, folderId) {
  const db = await openDb();
  return preq(db.transaction('videos').objectStore('videos').index('by_folder_sort').count(folderRange(scopeId, folderId)));
}

/**
 * Page one folder, newest (highest sortKey) first.
 *  - keyset (preferred): { after: {sortKey, key} } → O(limit) at any depth
 *  - offset (pager UI):  { offset } → cursor.advance(offset)
 * Returns { items, total }.
 */
export async function pageFolder(scopeId, folderId, { after = null, offset = 0, limit = 15 } = {}) {
  const db = await openDb();
  const idx = db.transaction('videos').objectStore('videos').index('by_folder_sort');
  const range = after
    ? IDBKeyRange.bound([scopeId, folderId, -Infinity], [scopeId, folderId, after.sortKey], false, true)
    : folderRange(scopeId, folderId);
  const total = await preq(idx.count(folderRange(scopeId, folderId)));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = after ? true : offset === 0; // keyset ranges need no advance
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

/** Pending-approval queue for a scope, newest first. */
export async function pagePending(scopeId, { offset = 0, limit = 50 } = {}) {
  const db = await openDb();
  const idx = db.transaction('videos').objectStore('videos').index('by_state');
  const range = IDBKeyRange.bound([scopeId, 'pending', -Infinity], [scopeId, 'pending', Infinity]);
  const total = await preq(idx.count(range));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = offset === 0;
    const req = idx.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

/**
 * Find a LIVE record by key in ANY scope (by_key index) — keys are content-addressed
 * (yt:<id>), so the same video under a drifted library id is still the same video.
 * Preference: the passed scopes first, then anything live.
 */
export async function findLiveByKey(key, preferScopes = []) {
  const db = await openDb();
  const all = await preq(db.transaction('videos').objectStore('videos').index('by_key').getAll(key));
  const live = (all || []).filter((r) => r.state === 'live');
  if (!live.length) return null;
  for (const s of preferScopes) {
    const hit = live.find((r) => r.scopeId === s);
    if (hit) return hit;
  }
  return live[0];
}

export async function findByNormTitleInChannel(scopeId, channelId, normTitle) {
  if (!normTitle) return null; // empty normTitle never dedupes
  const db = await openDb();
  const r = await preq(db.transaction('videos').objectStore('videos')
    .index('by_channel_title').get([scopeId, channelId, normTitle]));
  return r || null;
}

/**
 * The whole scope as Map<key, record> for the pure merge planner. FULL records, not a
 * projection: mergeVideoRecord clones the survivor, so a partial projection would
 * silently strip type/id/url from merged records (a real bug caught in verification —
 * a merged record lost its video type). Records are ~400B now (no inline base64), so
 * 5000 records ≈ 2MB, well off the render path.
 */
export async function loadMergeIndex(scopeId) {
  const db = await openDb();
  const map = new Map();
  await new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([scopeId, ''], [scopeId, '￿']);
    const req = db.transaction('videos').objectStore('videos').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      map.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return map;
}

export async function setVideoFields(scopeId, key, patch) {
  await tx(['videos'], 'readwrite', (videos) => {
    const r = videos.get([scopeId, key]);
    r.onsuccess = () => { if (r.result) videos.put({ ...r.result, ...patch, updatedAt: Date.now() }); };
  });
}

/** Delete + tombstone + oplog atomically (contract #4). Durable across all future syncs. */
export async function deleteVideo(scopeId, key, reason = 'parent-delete') {
  const now = Date.now();
  await tx(['videos', 'denylist', 'opLog'], 'readwrite', (videos, deny, ops) => {
    videos.delete([scopeId, key]);
    deny.put({ scopeId, key, at: now, reason });
    ops.add({ scopeId, op: 'deny', key, at: now });
  });
}

export async function approvePending(scopeId, keys) {
  const now = Date.now();
  await tx(['videos'], 'readwrite', (videos) => {
    for (const key of keys) {
      const r = videos.get([scopeId, key]);
      r.onsuccess = () => {
        if (r.result && r.result.state === 'pending') {
          videos.put({
            ...r.result, state: 'live', approvedAt: now, updatedAt: now,
            folderId: r.result.homeFolderId || r.result.folderId // un-park (see plan.js)
          });
        }
      };
    }
  });
}

/** Remove WITHOUT a tombstone (e.g. a legacy record that migrated into the library scope). */
export async function deleteVideoRaw(scopeId, key) {
  await tx(['videos'], 'readwrite', (videos) => { videos.delete([scopeId, key]); });
}

export async function rejectPending(scopeId, keys) {
  for (const key of keys) await deleteVideo(scopeId, key, 'parent-reject');
}

/* ---------------- per-profile gift/unwrap state ---------------- */

export async function getVideoState(profileId, key) {
  const db = await openDb();
  const r = await preq(db.transaction('profileVideoState').objectStore('profileVideoState').get([profileId, key]));
  return r || null;
}

export async function putVideoStates(recs) {
  for (let i = 0; i < recs.length; i += CHUNK) {
    const slice = recs.slice(i, i + CHUNK);
    await tx(['profileVideoState'], 'readwrite', (s) => { for (const r of slice) s.put(r); });
  }
}

/** Gift folder ("חדשים 🎁"): range scan over the sparse by_gift index, rank ASC. */
export async function pageGifts(profileId, { offset = 0, limit = 15 } = {}) {
  const db = await openDb();
  const idx = db.transaction('profileVideoState').objectStore('profileVideoState').index('by_gift');
  const range = IDBKeyRange.bound([profileId, -Infinity], [profileId, Infinity]);
  const total = await preq(idx.count(range));
  const items = await new Promise((resolve, reject) => {
    const out = [];
    let advanced = offset === 0;
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) return resolve(out);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return { items, total };
}

export async function countGifts(profileId) {
  const db = await openDb();
  return preq(db.transaction('profileVideoState').objectStore('profileVideoState')
    .index('by_gift').count(IDBKeyRange.bound([profileId, -Infinity], [profileId, Infinity])));
}

/** Remove an orphaned gift/unwrap state row (its video no longer exists anywhere). */
export async function deleteVideoState(profileId, key) {
  await tx(['profileVideoState'], 'readwrite', (s) => { s.delete([profileId, key]); });
}

/** Unwrap: set unwrappedAt, DELETE giftRank (drops out of by_gift automatically). */
export async function unwrapGift(profileId, key) {
  await tx(['profileVideoState', 'opLog'], 'readwrite', (s, ops) => {
    const r = s.get([profileId, key]);
    r.onsuccess = () => {
      const rec = r.result || { profileId, key };
      rec.unwrappedAt = rec.unwrappedAt || Date.now();
      delete rec.giftRank;
      s.put(rec);
    };
    ops.add({ scopeId: profScope(profileId), op: 'unwrap', key, at: Date.now() });
  });
}

/* ---------------- channels ---------------- */

export async function getChannel(channelId) {
  const db = await openDb();
  const r = await preq(db.transaction('channels').objectStore('channels').get(channelId));
  return r || null;
}
export async function putChannel(rec) {
  await tx(['channels'], 'readwrite', (c) => { c.put(rec); });
}
export async function listLibraryChannels(libraryId) {
  const db = await openDb();
  const idx = db.transaction('libraryChannels').objectStore('libraryChannels').index('by_library');
  const r = await preq(idx.getAll(IDBKeyRange.bound([libraryId, -Infinity], [libraryId, Infinity])));
  return r || [];
}
export async function putLibraryChannel(rec) {
  await tx(['libraryChannels'], 'readwrite', (s) => { s.put(rec); });
}
export async function deleteLibraryChannel(libraryId, channelId) {
  await tx(['libraryChannels'], 'readwrite', (s) => { s.delete([libraryId, channelId]); });
  // v1.0.18 — REARM THE BACKFILL. Unsubscribing removes the libraryChannels row,
  // but the GLOBAL channels record survives with `backfillDone: true`, so on a
  // re-subscribe planChannelFetch (quota.js) returns 'rss' and only the ~15 videos
  // in the feed window ever come back — the whole back catalogue is gone for good,
  // while the confirm dialog explicitly promises "אפשר להוסיף אותו שוב בעתיד".
  // Only rearm once NO library still subscribes: another profile's sheet may share
  // this channel, and re-backfilling a live subscription burns YouTube quota.
  const db = await openDb();
  const rows = await preq(db.transaction('libraryChannels').objectStore('libraryChannels').getAll());
  if ((rows || []).some((r) => r.channelId === channelId)) return;
  const ch = await getChannel(channelId);
  // uploadsPlaylistId and the logo are kept — they cost a lookup/scrape to rebuild
  // and never go stale; only the cursor is state that must not outlive the sub.
  if (ch) await putChannel({ ...ch, backfillCursor: null, backfillDone: false });
}

/* ---------------- thumbs (Blob cache) ---------------- */

export async function getThumbBlob(id) {
  const db = await openDb();
  const r = await preq(db.transaction('thumbs').objectStore('thumbs').get(id));
  return r ? r.blob : null;
}
export async function putThumb(id, blob, meta = {}) {
  await tx(['thumbs'], 'readwrite', (t) => {
    t.put({ id, blob, bytes: blob && blob.size || 0, lastUsed: Date.now(), ...meta });
  });
}
/** Batched LRU bump — one transaction per RENDER, not per <img>. */
export async function touchThumbs(ids) {
  if (!ids || !ids.length) return;
  const now = Date.now();
  await tx(['thumbs'], 'readwrite', (t) => {
    for (const id of ids) {
      const r = t.get(id);
      r.onsuccess = () => { if (r.result) { r.result.lastUsed = now; t.put(r.result); } };
    }
  });
}
export async function evictThumbs({ maxBytes = 120 * 1024 * 1024, maxCount = 6000, pinned = new Set() } = {}) {
  const db = await openDb();
  const all = await preq(db.transaction('thumbs').objectStore('thumbs').index('by_lastUsed').getAllKeys());
  // stats maintained lazily: count via keys, bytes via meta record
  const stats = (await getMeta('thumbStats')) || { bytes: 0 };
  if (all.length <= maxCount && stats.bytes <= maxBytes) return 0;
  const target = Math.floor(Math.min(maxCount, all.length) * 0.8);
  let removed = 0;
  await tx(['thumbs'], 'readwrite', (t) => {
    const req = t.index('by_lastUsed').openCursor(); // oldest first
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (all.length - removed > target && !pinned.has(cur.value.id)) {
        cur.delete(); removed += 1;
      }
      if (all.length - removed > target) cur.continue();
    };
  });
  return removed;
}

/* ---------------- denylist ---------------- */

/**
 * v1.0.10: a deny entry can be REVOKED (removedAt >= at) — the sheet re-adding a key
 * is the one deliberate undeny path ("the sheet wins"). Revoked entries stay stored
 * (they must travel through Drive merges to defeat stale denies on other devices)
 * but are INERT: loadDenySet exposes only the active ones.
 */
export const denyActive = (d) => !!d && !(d.removedAt >= (d.at || 0));

export async function loadDenySet(scopeId) {
  const recs = await loadDenyRecords(scopeId);
  return new Set(recs.filter(denyActive).map((d) => d.key));
}

/** FULL deny rows (active + revoked) — the Drive doc must carry both. */
export async function loadDenyRecords(scopeId) {
  const db = await openDb();
  const range = IDBKeyRange.bound([scopeId, ''], [scopeId, '￿']);
  return (await preq(db.transaction('denylist').objectStore('denylist').getAll(range))) || [];
}
/**
 * Union tombstones from one scope into another (v1.0.6 mine→shared absorb):
 * only keys MISSING in the target are written, so repeated runs are no-ops and the
 * original deny timestamps in the target are never overwritten.
 */
export async function copyDenies(fromScope, toScope) {
  const from = await loadDenySet(fromScope);
  if (!from.size) return 0;
  const have = await loadDenySet(toScope);
  const missing = [...from].filter((k) => !have.has(k));
  if (!missing.length) return 0;
  await tx(['denylist'], 'readwrite', (deny) => {
    for (const key of missing) deny.put({ scopeId: toScope, key, at: Date.now(), reason: 'scope-merge' });
  });
  return missing.length;
}

/**
 * v1.0.10: unDeny REVOKES instead of deleting — the inert marker (removedAt) must
 * out-merge stale active denies still sitting in Drive docs of other devices.
 */
/**
 * v1.0.17 — move an ENTIRE library scope's content to another scope.
 * Needed because the library id is derived from the SHEET URL: connecting (or
 * changing) a sheet changes the scope, and everything the parent had already
 * added lived in the old one — it stayed in IndexedDB but vanished from the UI.
 * Videos and channel subscriptions move; tombstones are unioned (never dropped).
 * Idempotent: re-running finds an empty source scope and does nothing.
 * Returns WHAT moved (not just counts) — the caller registers exactly those in the
 * sheet; enqueueing the whole target scope could overflow the write queue and drop
 * the genuinely-new rows.
 * -> { videoKeys: [], channelIds: [] }
 */
export async function moveScope(fromScope, toScope) {
  if (!fromScope || !toScope || fromScope === toScope) return { videoKeys: [], channelIds: [] };
  const recs = [...(await loadMergeIndex(fromScope)).values()];
  const puts = [];
  for (const rec of recs) {
    // a key already present in the target wins (it came from the real sheet)
    if (await getVideo(toScope, rec.key)) continue;
    puts.push({ ...rec, scopeId: toScope, updatedAt: Date.now() });
  }
  if (puts.length) await putVideos(puts);
  // v1.0.18 — TOMBSTONES FIRST. This used to run after the delete below, so a crash
  // or reload in between lost the old scope's deny-list for good: adoptLibraryScope
  // only fires on a scope CHANGE and src.libraryId is already rewritten by then, so
  // nothing ever retries, and every deleted video came back on the next sheet parse.
  // A union is idempotent, so doing it first is safe to repeat and safe to interrupt.
  await copyDenies(fromScope, toScope);
  await tx(['videos'], 'readwrite', (videos) => {
    for (const rec of recs) videos.delete([fromScope, rec.key]);
  });

  const movedChannels = [];
  const targetChannels = new Set((await listLibraryChannels(toScope)).map((c) => c.channelId));
  for (const lc of await listLibraryChannels(fromScope)) {
    if (!targetChannels.has(lc.channelId)) {
      await putLibraryChannel({ ...lc, libraryId: toScope });
      movedChannels.push(lc.channelId);
    }
    await deleteLibraryChannel(fromScope, lc.channelId);
  }
  return { videoKeys: puts.map((r) => r.key), channelIds: movedChannels };
}

export async function unDeny(scopeId, key) {
  const db = await openDb();
  const prev = await preq(db.transaction('denylist').objectStore('denylist').get([scopeId, key]));
  await tx(['denylist', 'opLog'], 'readwrite', (deny, ops) => {
    deny.put({ ...(prev || { scopeId, key, at: 0 }), removedAt: Date.now() });
    ops.add({ scopeId, op: 'undeny', key, at: Date.now() });
  });
}

/* ---------------- sources / meta / oplog ---------------- */

export async function getSources(profileId) {
  const db = await openDb();
  const r = await preq(db.transaction('sources').objectStore('sources').get(profileId));
  return r || null;
}
export async function putSources(rec) {
  await tx(['sources'], 'readwrite', (s) => { s.put(rec); });
}

export async function getMeta(id) {
  const db = await openDb();
  const r = await preq(db.transaction('meta').objectStore('meta').get(id));
  return r ? r.v : null;
}
export async function putMeta(id, v) {
  await tx(['meta'], 'readwrite', (m) => { m.put({ id, v }); });
}
export async function patchMeta(id, patch) {
  await tx(['meta'], 'readwrite', (m) => {
    const r = m.get(id);
    r.onsuccess = () => { m.put({ id, v: { ...(r.result && r.result.v || {}), ...patch } }); };
  });
}

export async function appendOp(op) {
  await tx(['opLog'], 'readwrite', (ops) => { ops.add({ ...op, at: op.at || Date.now() }); });
}
export async function listOpsSince(seq = 0) {
  const db = await openDb();
  const r = await preq(db.transaction('opLog').objectStore('opLog').getAll(IDBKeyRange.lowerBound(seq, true)));
  return r || [];
}
export async function compactOpsThrough(seq) {
  await tx(['opLog'], 'readwrite', (ops) => { ops.delete(IDBKeyRange.upperBound(seq)); });
}

/* ---------------- profile lifecycle ---------------- */

/** Remove a profile's OWN data (its prof: scope + gift state + sources). Shared library content stays. */
export async function purgeProfile(profileId) {
  const scope = profScope(profileId);
  await tx(['videos', 'denylist', 'profileVideoState', 'sources', 'opLog'], 'readwrite',
    (videos, deny, pvs, sources, ops) => {
      videos.delete(IDBKeyRange.bound([scope, ''], [scope, '￿']));
      deny.delete(IDBKeyRange.bound([scope, ''], [scope, '￿']));
      pvs.delete(IDBKeyRange.bound([profileId, ''], [profileId, '￿']));
      sources.delete(profileId);
      ops.add({ scopeId: scope, op: 'purge-profile', at: Date.now() });
    });
}
