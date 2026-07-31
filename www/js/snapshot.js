// snapshot.js — FULL-state export/import per profile. This is the only backup that
// works with zero Google sign-in, and the hard prerequisite for the one-time
// debug→release signing switchover (uninstall wipes everything).
//
// SECURITY: import treats the file as UNTRUSTED (like the sheet): every video is
// re-classified from its srcUrl through classifyLink — the one legacy path that
// bypassed the safety boundary (old importJson) is closed. localPath is validated
// against the cache-file shape. Import MERGES, never overwrites. Those per-row rules live
// in the PURE sanitizeSnapshotVideo below precisely so they can be pinned by tests — this
// module talks to IndexedDB, and an untested safety boundary is not a boundary.

import { classifyLink } from './classify.js';
import { normalizeTitle } from './normalize.js';
import { sortKeyFor } from './order.js';
import {
  openDb, getSources, putSources, loadMergeIndex, putVideos,
  listLibraryChannels, putLibraryChannel, getChannel, putChannel,
  loadDenySet, tx, profScope, putVideoStates
} from './db.js';

const LOCALPATH_RE = /^videos\/[A-Za-z0-9_-]{1,90}\.mp4$/;

export async function exportProfileSnapshot(profileId, profileMeta = null) {
  const sources = await getSources(profileId);
  const lib = sources && sources.libraryId;
  const scopes = [profScope(profileId), ...(lib ? [lib] : [])];

  const videos = [];
  for (const s of scopes) videos.push(...(await loadMergeIndex(s)).values());

  const denylist = [];
  for (const s of scopes) for (const key of await loadDenySet(s)) denylist.push({ scopeId: s, key });

  const channels = [];
  const libraryChannels = lib ? await listLibraryChannels(lib) : [];
  for (const lc of libraryChannels) {
    const ch = await getChannel(lc.channelId);
    if (ch) {
      // NEVER export cursors/keys — and the API key must never reach a shareable file
      const { backfillCursor, ...safe } = ch;
      channels.push(safe);
    }
  }

  const states = [];
  const db = await openDb();
  await new Promise((resolve) => {
    const range = IDBKeyRange.bound([profileId, ''], [profileId, '￿']);
    const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      states.push(cur.value);
      cur.continue();
    };
    req.onerror = () => resolve();
  });

  return JSON.stringify({
    schema: 2, kind: 'kids-player-snapshot', exportedAt: Date.now(),
    profile: profileMeta, profileId, sources, videos, denylist, channels, libraryChannels, states
  });
}

const inScope = (validScopes, id) => Array.isArray(validScopes)
  ? validScopes.includes(id)
  : !!(validScopes && typeof validScopes.has === 'function' && validScopes.has(id));

/**
 * Sanitize ONE exported video row into a storable record. Pure on purpose: the rules
 * below are the whole security value of the import path, and they are only worth
 * anything if they can be pinned by a test without an IndexedDB.
 *
 *  - classifyLink(srcUrl) is THE safety boundary: key/type/id/url are REBUILT from the
 *    link, never copied out of the file. A hand-edited snapshot therefore cannot smuggle
 *    in a `javascript:` url, an arbitrary web page, or a key that lies about its url.
 *    null back = the caller counts the row as rejected.
 *  - scopeId is honoured only when it names one of THIS profile's scopes; anything else
 *    falls back to the profile scope. A snapshot from another family must never write
 *    into a `lib:` library that other profiles on this device share.
 *  - a PENDING row stays PARKED in '~pending' (the kid-facing folder index has no state
 *    component, so an unparked pending record would be visible to the child) and keeps
 *    the homeFolderId it was exported with — that is the folder approval returns it to,
 *    and `homeFolderId === 'sheet'` is also what marks a record sheet-backed later on.
 *  - localPath must match the cache-file shape we write ourselves: a path from the file
 *    is untrusted input and must never point the player outside the cache directory.
 *  - thumbId is dropped (blobs don't travel) and thumbUrl must be https — an http
 *    thumbnail is both a mixed-content failure and an unverifiable source.
 */
export function sanitizeSnapshotVideo(v, { validScopes, profileId, now = Date.now() } = {}) {
  const c = classifyLink(v && v.srcUrl);
  if (!c) return null;

  const scopeOk = inScope(validScopes, v.scopeId);
  const scopeId = scopeOk ? v.scopeId : profScope(profileId);
  // A record whose LIBRARY scope was rejected falls back to the profile scope — where the
  // shared 'sheet' folder does not exist (buildFolders raises that tile only for libScope,
  // and absorbMineIntoShared only ever picks up 'mine'). Left as-is the row is stored,
  // approved, and then in NO folder on any screen, forever. Remap it to the profile
  // scope's own loose list.
  // Only when the row NAMED a scope we rejected — a row with no scopeId at all is simply
  // unscoped and keeps whatever folder it declared (pinned by the round-trip tests).
  const scopeRejected = v && v.scopeId != null && !scopeOk;
  const reFolder = (f) => (scopeRejected && f === 'sheet' ? 'mine' : f);
  // '~pending' is a parking slot, never a folder to return to
  const folderId = typeof v.folderId === 'string' && v.folderId !== '~pending' ? v.folderId : 'mine';
  const homeFolderId = typeof v.homeFolderId === 'string' && v.homeFolderId !== '~pending'
    ? v.homeFolderId : null;
  const pending = v.state === 'pending';
  const title = typeof v.title === 'string' ? v.title.slice(0, 300) : '';

  // Ordering inputs are sanitized BEFORE they reach sortKeyFor, and its result is checked:
  // a junk publishedAt/addedAt produced a string or NaN sortKey, which stores fine and then
  // indexes NOWHERE (by_folder_sort rejects a NaN key; a string sorts outside folderRange's
  // numeric bounds). The row counted as imported and was invisible to the child forever.
  const num = (x) => {
    if (x === null || x === undefined || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const origin = v.origin || 'manual';
  const publishedAt = num(v.publishedAt);
  const rowIndex = num(v.rowIndex);
  const addedAt = num(v.addedAt) || now;
  const rawSort = num(v.sortKey) ?? sortKeyFor({ origin, publishedAt, rowIndex, addedAt });
  const sortKey = Number.isFinite(rawSort) ? rawSort : sortKeyFor({ origin: 'manual', addedAt: now });

  return {
    scopeId, key: c.key, type: c.type, id: c.id ?? null, url: c.url ?? null,
    srcUrl: c.srcUrl, driveId: c.driveId ?? null,
    title,
    titleSource: v.titleSource || null,
    normTitle: normalizeTitle(title), // from the SANITIZED title — `{}` used to normalize
    folderId: pending ? '~pending' : reFolder(folderId),
    // an exported pending row already carries its real home; only a row that was never
    // parked (or lost its home) falls back to the folder it was filed under
    homeFolderId: reFolder(pending ? (homeFolderId || folderId) : homeFolderId),
    channelId: typeof v.channelId === 'string' ? v.channelId : null,
    // v1.0.12 grouping fields: without them every 🎞️ collection dissolves into the flat
    // list on import, and the weekly re-enrichment throttle restarts from scratch.
    srcChannelId: typeof v.srcChannelId === 'string' ? v.srcChannelId : null,
    srcChannelTitle: typeof v.srcChannelTitle === 'string' ? v.srcChannelTitle.slice(0, 300) : null,
    srcChannelTriedAt: num(v.srcChannelTriedAt),
    sortKey,
    publishedAt, rowIndex,
    origin,
    state: pending ? 'pending' : 'live',
    addedAt, approvedAt: v.approvedAt ?? null,
    thumbId: null, // blobs don't travel in the snapshot
    thumbUrl: typeof v.thumbUrl === 'string' && /^https:/.test(v.thumbUrl) ? v.thumbUrl : null,
    // typeof FIRST: RegExp.test stringifies, so `["videos/x.mp4"]` used to pass the shape
    // check and then be STORED as an array — the record must hold a string or nothing
    localPath: typeof v.localPath === 'string' && LOCALPATH_RE.test(v.localPath) ? v.localPath : null,
    updatedAt: now
  };
}

/** Merge an exported snapshot into (possibly fresh) local state. Never throws on bad rows. */
export async function importProfileSnapshot(profileId, text) {
  let snap;
  try { snap = JSON.parse(text); } catch { return { ok: false, error: 'bad-json' }; }
  if (!snap || snap.kind !== 'kids-player-snapshot' || !Array.isArray(snap.videos)) {
    return { ok: false, error: 'bad-format' };
  }

  // sources: adopt the snapshot's sheet/library if we have none
  const mySrc = await getSources(profileId);
  if (!mySrc && snap.sources) await putSources({ ...snap.sources, profileId });
  const src = await getSources(profileId);
  const lib = src && src.libraryId;
  const validScopes = new Set([profScope(profileId), ...(lib ? [lib] : [])]);

  let imported = 0;
  let rejected = 0;
  const puts = [];
  for (const v of snap.videos) {
    const rec = sanitizeSnapshotVideo(v, { validScopes, profileId }); // THE safety boundary
    if (!rec) { rejected += 1; continue; }
    puts.push(rec);
    imported += 1;
  }
  await putVideos(puts);

  // deny-list: union, never shrink (deletion durability crosses devices)
  const denies = Array.isArray(snap.denylist) ? snap.denylist : [];
  await tx(['denylist'], 'readwrite', (deny) => {
    for (const d of denies) {
      if (!d || typeof d.key !== 'string') continue;
      const scopeId = validScopes.has(d.scopeId) ? d.scopeId : profScope(profileId);
      deny.put({ scopeId, key: d.key, at: d.at || Date.now(), reason: 'import' });
    }
  });

  if (lib && Array.isArray(snap.libraryChannels)) {
    for (const lc of snap.libraryChannels) {
      if (!lc || !/^UC[A-Za-z0-9_-]{22}$/.test(lc.channelId || '')) continue;
      await putLibraryChannel({ ...lc, libraryId: lib });
    }
  }
  if (Array.isArray(snap.channels)) {
    for (const ch of snap.channels) {
      if (!ch || !/^UC[A-Za-z0-9_-]{22}$/.test(ch.channelId || '')) continue;
      const prev = await getChannel(ch.channelId);
      if (!prev) await putChannel({ ...ch, backfillCursor: null });
    }
  }

  // unwrap state: min(unwrappedAt) semantics — once unwrapped, never re-gifted
  if (Array.isArray(snap.states)) {
    const statePuts = [];
    for (const st of snap.states) {
      if (!st || typeof st.key !== 'string') continue;
      const rec = { profileId, key: st.key };
      if (st.unwrappedAt) rec.unwrappedAt = st.unwrappedAt;
      else if (st.giftRank) rec.giftRank = st.giftRank;
      statePuts.push(rec);
    }
    if (statePuts.length) await putVideoStates(statePuts);
  }

  return { ok: true, imported, rejected };
}
