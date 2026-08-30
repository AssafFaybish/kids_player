// snapshot.js — FULL-state export/import per profile. This is the only backup that
// works with zero Google sign-in, and the hard prerequisite for the one-time
// debug→release signing switchover (uninstall wipes everything).
//
// SECURITY: import treats the file as UNTRUSTED (like the sheet): every video is
// re-classified from its srcUrl through classifyLink — the one legacy path that
// bypassed the safety boundary (old importJson) is closed. localPath is validated
// against the cache-file shape. Import MERGES, never overwrites. Those per-row rules live
// in the PURE sanitizeSnapshotVideo / planDenyImport below precisely so they can be pinned
// by tests — this module talks to IndexedDB, and an untested safety boundary is not a
// boundary.

import { classifyLink } from './classify.js';
import { normalizeTitle, PARKED, isParkedFolder } from './normalize.js';
import { sortKeyFor } from './order.js';
// Layer note: snapshot.js is consumed only by app.js (dynamically), so it sits ABOVE the
// plan/sync2/drive tier — importing the deny LWW merge from drive.js creates no cycle
// (drive.js never imports this module; the invariants cycle test pins the graph).
// Replicating the rule here instead would be the drift CLAUDE.md bans.
import { mergeDenyRecord, mergeSiteEntry, planSiteApply, mergeCustomFolder, planCustomFolderApply } from './drive.js';
import { canonicalSitePrefix, ruleIdFor, shortcutIdFor } from './weblock.js';
import { isCustomFolder as isCustomFolderId, normalizeFolderTitle } from './plan.js';
import {
  openDb, getSources, putSources, loadMergeIndex, putVideos,
  listLibraryChannels, putLibraryChannel, getChannel, putChannel,
  listSiteEntries, putSiteEntry, deleteSiteEntry,
  listCustomFolders, putCustomFolder, deleteCustomFolder,
  getDeletedCustomFolders, putDeletedCustomFolders,
  getDeletedSiteEntries, putDeletedSiteEntries,
  loadDenyRecords, tx, profScope, putVideoStates, loadVideoStates
} from './db.js';

// v1.0.56 — audio joined the cache (media.cacheExtFor), so the accepted extensions widen
// in lockstep. Still an ANCHORED whitelist of shapes we write ourselves: an imported path
// must never point the player outside the cache directory (traversal/exe pinned by tests).
const LOCALPATH_RE = /^videos\/[A-Za-z0-9_-]{1,90}\.(mp4|webm|m4v|mov|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/;
// v1.0.61 — a Drive id out of an untrusted file. The same shape gdrivepub's DRIVE_ID uses;
// it is written into a row the refresh then LISTS over the network, so it is validated here
// rather than trusted.
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export async function exportProfileSnapshot(profileId, profileMeta = null) {
  const sources = await getSources(profileId);
  const lib = sources && sources.libraryId;
  const scopes = [profScope(profileId), ...(lib ? [lib] : [])];

  const videos = [];
  for (const s of scopes) videos.push(...(await loadMergeIndex(s)).values());

  const denylist = [];
  // FULL rows, active AND revoked (loadDenyRecords, never loadDenySet): a revocation is
  // an EVENT that must travel — exporting only the active keys meant a restore left a
  // peer's stale ACTIVE tombstone standing and the video stayed deleted on that device
  // forever. Same presence-not-activity rule as db.copyDenies (the v1.0.22 lesson).
  for (const s of scopes) denylist.push(...(await loadDenyRecords(s)));

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

  // v1.0.45 — approved websites. The TOMBSTONES travel from day one: `deletedChannels`
  // was left out of the snapshot when it was introduced, so a restore can still resurrect
  // a deleted subscription locally and then push it, and there is no reason to repeat that.
  const pScope = profScope(profileId);
  const siteEntries = await listSiteEntries(pScope);
  const deletedSiteEntries = await getDeletedSiteEntries(pScope);
  // v1.0.56 — the parent's folders, with their tombstones for the same reason. Without
  // them a restore puts every video back under a `cf:` folder whose NAME is gone: the
  // child's home would show nothing for them (buildFolders renders only folders it has a
  // row for) while the records sat in the database — the v1.0.38 empty-home shape.
  const customFolders = lib ? await listCustomFolders(lib) : [];
  const deletedCustomFolders = lib ? await getDeletedCustomFolders(lib) : {};

  return JSON.stringify({
    schema: 2, kind: 'kids-player-snapshot', exportedAt: Date.now(),
    profile: profileMeta, profileId, sources, videos, denylist, channels, libraryChannels, states,
    siteEntries, deletedSiteEntries, customFolders, deletedCustomFolders
  });
}

/**
 * PURE: sanitize ONE exported site entry.
 *
 * The safety boundary is re-run, never trusted: a rule's host/port/segments are REBUILT
 * from its own display string with `canonicalSitePrefix`, exactly as sanitizeSnapshotVideo
 * rebuilds a video's key from its link. A file that has been hand-edited (or written by a
 * future build) must not be able to inject a rule the current parser would refuse.
 *
 * `order` goes through the same Number.isFinite gate as sortKey: a string or NaN stores
 * fine and then appears in NO range scan over `by_scope`, i.e. a row that exists and is
 * invisible forever.
 */
export function sanitizeSnapshotSite(row, { scopeId, now = Date.now() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const entryId = typeof row.entryId === 'string' ? row.entryId : '';
  if (!entryId) return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  const order = num(row.order) ?? 0;
  const addedAt = num(row.addedAt) ?? now;
  const updatedAt = num(row.updatedAt) ?? addedAt;
  const base = { scopeId, entryId, order, addedAt, updatedAt };

  if (row.kind === 'rule') {
    const canon = canonicalSitePrefix(row.display);
    if (!canon.ok) return null;
    if (ruleIdFor(canon) !== entryId) return null; // the id must match what it permits
    return {
      ...base, kind: 'rule', display: canon.display, host: canon.host,
      port: canon.port, segments: canon.segments, allowExternal: !!row.allowExternal
    };
  }
  if (row.kind === 'shortcut') {
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!canonicalSitePrefix(url).ok) return null;
    if (shortcutIdFor(url) !== entryId) return null;
    const title = typeof row.title === 'string' ? row.title.slice(0, 120) : '';
    return { ...base, kind: 'shortcut', url, title };
  }
  return null; // an unknown kind is not a thing this app knows how to show
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
 *  - a REJECTED row stays PARKED in '~rejected', by the identical mechanism. It used to
 *    fall into the live branch (`pending ? 'pending' : 'live'`), so a restore put every
 *    video the parent threw out BACK ON THE CHILD'S HOME. Its `rejectedAt` is the
 *    ORIGINAL stamp, never a fresh one: `planRejectedPurge`'s 30-day clock reads that
 *    field, so restamping would restart the countdown on every restore — and a row
 *    exported without one imports without one (no rejectedAt = never auto-purged).
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
  // '~pending'/'~rejected' are parking slots, never folders to return to
  const folderId = typeof v.folderId === 'string' && !isParkedFolder(v.folderId) ? v.folderId : 'mine';
  const homeFolderId = typeof v.homeFolderId === 'string' && !isParkedFolder(v.homeFolderId)
    ? v.homeFolderId : null;
  // ALL THREE curation states survive the round trip ("'rejected' IS NOT A DELETION",
  // v1.0.23). Anything unrecognised is 'live' (the legacy states), never a fourth state.
  const state = v.state === 'pending' ? 'pending' : v.state === 'rejected' ? 'rejected' : 'live';
  const parked = state !== 'live';
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
    // v1.0.56 — 'audio'|'video' or nothing (untrusted input: anything else reads as
    // unknown, and the player's runtime detection covers unknown anyway)
    media: v.media === 'audio' || v.media === 'video' ? v.media : null,
    title,
    titleSource: v.titleSource || null,
    normTitle: normalizeTitle(title), // from the SANITIZED title — `{}` used to normalize
    folderId: parked ? PARKED[state] : reFolder(folderId),
    // an exported parked row already carries its real home; only a row that was never
    // parked (or lost its home) falls back to the folder it was filed under
    homeFolderId: reFolder(parked ? (homeFolderId || folderId) : homeFolderId),
    channelId: typeof v.channelId === 'string' ? v.channelId : null,
    // v1.0.12 grouping fields: without them every 🎞️ collection dissolves into the flat
    // list on import, and the weekly re-enrichment throttle restarts from scratch.
    srcChannelId: typeof v.srcChannelId === 'string' ? v.srcChannelId : null,
    srcChannelTitle: typeof v.srcChannelTitle === 'string' ? v.srcChannelTitle.slice(0, 300) : null,
    srcChannelTriedAt: num(v.srcChannelTriedAt),
    sortKey,
    publishedAt, rowIndex,
    origin,
    state,
    addedAt, approvedAt: state === 'rejected' ? null : (v.approvedAt ?? null),
    // the ORIGINAL rejection time (or none) — see the rules block above
    rejectedAt: state === 'rejected' ? num(v.rejectedAt) : null,
    // v1.0.39 — the parent's "never delete this one" mark. The export carries it (full
    // records), and dropping it HERE meant a restore silently unprotected every favourite,
    // so the next rolling-window review proposed them again. Same class as the srcChannel*
    // fields above. Sparse on purpose: only ever written when true, exactly as
    // normalize.mergeVideoRecord sets it.
    ...(v.keepForever === true ? { keepForever: true } : {}),
    thumbId: null, // blobs don't travel in the snapshot
    thumbUrl: typeof v.thumbUrl === 'string' && /^https:/.test(v.thumbUrl) ? v.thumbUrl : null,
    // typeof FIRST: RegExp.test stringifies, so `["videos/x.mp4"]` used to pass the shape
    // check and then be STORED as an array — the record must hold a string or nothing
    localPath: typeof v.localPath === 'string' && LOCALPATH_RE.test(v.localPath) ? v.localPath : null,
    updatedAt: now
  };
}

/**
 * PURE: the deny rows one import may write. The deny-list is an LWW-element set
 * (v1.0.10): an entry with `removedAt >= at` is REVOKED — the sheet re-adding the key,
 * the one deliberate undeny path. Two rules, both the v1.0.22 `copyDenies` bug replayed
 * here verbatim until v1.0.26:
 *  - a row carries ITS OWN event times. The old code stamped `at: d.at || Date.now()`
 *    and dropped `removedAt`, so a revoked tombstone imported as ACTIVE **and newest**,
 *    won every later Drive merge, and re-deleted the video on this device and then on
 *    every other one.
 *  - never a blind put: an existing local row is merged via `mergeDenyRecord` (later
 *    event wins, tie → revoked), so a stale snapshot cannot clobber a local revocation.
 * A row with no usable `at` gets 0, never "now": a timeless entry must lose to any real
 * event on the other side.
 */
export function planDenyImport(existingRows, snapRows, { validScopes, profileId } = {}) {
  const have = new Map();
  for (const r of existingRows || []) {
    if (r && typeof r.key === 'string') have.set(r.scopeId + '\0' + r.key, r);
  }
  const puts = new Map();
  for (const d of Array.isArray(snapRows) ? snapRows : []) {
    if (!d || typeof d.key !== 'string') continue;
    const scopeId = inScope(validScopes, d.scopeId) ? d.scopeId : profScope(profileId);
    const at = Number(d.at) || 0;
    const removedAt = Number(d.removedAt) || 0;
    const row = {
      scopeId, key: d.key, at,
      ...(removedAt ? { removedAt } : {}),
      reason: (typeof d.reason === 'string' && d.reason) || 'import'
    };
    const k = scopeId + '\0' + d.key;
    const merged = mergeDenyRecord(have.get(k), row);
    have.set(k, merged); // duplicates inside one snapshot must merge against the winner
    puts.set(k, merged);
  }
  return [...puts.values()];
}

/** Merge an exported snapshot into (possibly fresh) local state. Never throws on bad rows. */
export async function importProfileSnapshot(profileId, text) {
  let snap;
  try { snap = JSON.parse(text); } catch { return { ok: false, error: 'bad-json' }; }
  if (!snap || snap.kind !== 'kids-player-snapshot' || !Array.isArray(snap.videos)) {
    return { ok: false, error: 'bad-format' };
  }

  // sources: adopt the snapshot's LIBRARY SCOPE if we have none — that is what puts the
  // imported records where this profile will look for them.
  //
  // v1.0.38: the three sheet fields are STRIPPED. An old snapshot still carries them, and
  // adopting one wholesale re-introduced a `sheetUrl` after the migration had already
  // forgotten it — inert (nothing reads a sheet any more) but able to outlive the migration
  // code itself, which is precisely what the sunset's deadline branch exists to prevent.
  // `libraryId` is deliberately KEPT: it is the one field that must survive a restore.
  const mySrc = await getSources(profileId);
  if (!mySrc && snap.sources) {
    const { sheetUrl, sheetHash, sheetFolderId, sheetFetchedAt, ...clean } = snap.sources;
    await putSources({ ...clean, profileId });
  }
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

  // deny-list: union, never shrink (deletion durability crosses devices) — but MERGED,
  // never blind-put: since v1.0.10 an entry can be REVOKED, and both the snapshot
  // revocation's survival and the local row's are decided in pure planDenyImport above.
  const existingDenies = [];
  for (const s of validScopes) existingDenies.push(...(await loadDenyRecords(s)));
  const denyPuts = planDenyImport(existingDenies, snap.denylist, { validScopes, profileId });
  if (denyPuts.length) {
    await tx(['denylist'], 'readwrite', (deny) => { for (const r of denyPuts) deny.put(r); });
  }

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

  // v1.0.45 — approved websites. MERGED, never blind-put: the same lesson as the deny
  // rows above. A snapshot is one device's old copy, so a stale entry must not clobber a
  // newer local one, and a site the parent has since REMOVED must not walk back in — the
  // tombstones are applied first, through the same pure planner the Drive pull uses.
  {
    const pScope = profScope(profileId);
    const snapRows = [];
    for (const row of Array.isArray(snap.siteEntries) ? snap.siteEntries : []) {
      const clean = sanitizeSnapshotSite(row, { scopeId: pScope });
      if (clean) snapRows.push(clean);
    }
    const remoteTombs = (snap.deletedSiteEntries && typeof snap.deletedSiteEntries === 'object'
      && !Array.isArray(snap.deletedSiteEntries)) ? snap.deletedSiteEntries : {};
    if (snapRows.length || Object.keys(remoteTombs).length) {
      const localRows = await listSiteEntries(pScope);
      const plan = planSiteApply({
        localRows, remoteRows: snapRows,
        localTombs: await getDeletedSiteEntries(pScope), remoteTombs
      });
      await putDeletedSiteEntries(pScope, plan.tombs);
      for (const entryId of plan.deletes) await deleteSiteEntry(pScope, entryId, { tombstone: false });
      const byId = new Map(localRows.map((r) => [r.entryId, r]));
      for (const e of plan.puts) {
        // LWW against what is already here, so an older snapshot cannot undo a newer edit.
        await putSiteEntry(mergeSiteEntry(byId.get(e.entryId), e), { preserveTimestamp: true });
      }
    }
  }

  // v1.0.56 — the parent's folders, through the same merge-never-blind-put treatment as
  // the sites above, on the LIBRARY scope (that is where they live, because that is where
  // the videos filed into them live). Titles are re-sanitized like every other imported
  // string; `artThumbId` is DROPPED — it names a blob in the exporting device's thumbs
  // store, which does not travel, and a dangling id renders nothing. artSrcUrl survives
  // so a later render can re-fetch the picture.
  {
    // `lib` is the library scope resolved at the top of this function
    const snapRows = [];
    for (const row of Array.isArray(snap.customFolders) ? snap.customFolders : []) {
      if (!row || typeof row.folderId !== 'string' || !isCustomFolderId(row.folderId)) continue;
      const title = normalizeFolderTitle(row.title);
      if (!title) continue;
      snapRows.push({
        scopeId: lib, folderId: row.folderId, title,
        emoji: typeof row.emoji === 'string' ? row.emoji.slice(0, 8) : '📁',
        artThumbId: null,
        artSrcUrl: typeof row.artSrcUrl === 'string' && /^https:/.test(row.artSrcUrl) ? row.artSrcUrl : null,
        // v1.0.61 — THE SHAPE OF THE TREE TRAVELS, or a restore flattens a 32-disc
        // collection back onto the home screen. These three were already being dropped by
        // this whitelist before nesting made it visible: without driveFolderId the restored
        // folder never refreshes again, and without driveRootId the refresh re-lists every
        // descendant separately. parentFolderId is validated as a folder id — it is an
        // untrusted string from a file, and the ancestry walk follows it.
        driveFolderId: typeof row.driveFolderId === 'string' && DRIVE_ID_RE.test(row.driveFolderId) ? row.driveFolderId : null,
        driveRootId: typeof row.driveRootId === 'string' && DRIVE_ID_RE.test(row.driveRootId) ? row.driveRootId : null,
        parentFolderId: (typeof row.parentFolderId === 'string' && isCustomFolderId(row.parentFolderId)
          && row.parentFolderId !== row.folderId) ? row.parentFolderId : null,
        order: Number.isFinite(Number(row.order)) ? Number(row.order) : 0,
        createdAt: Number.isFinite(Number(row.createdAt)) ? Number(row.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : 0
      });
    }
    const remoteTombs = (snap.deletedCustomFolders && typeof snap.deletedCustomFolders === 'object'
      && !Array.isArray(snap.deletedCustomFolders)) ? snap.deletedCustomFolders : {};
    if (lib && (snapRows.length || Object.keys(remoteTombs).length)) {
      const localRows = await listCustomFolders(lib);
      const plan = planCustomFolderApply({
        localRows, remoteRows: snapRows,
        localTombs: await getDeletedCustomFolders(lib), remoteTombs
      });
      await putDeletedCustomFolders(lib, plan.tombs);
      for (const fid of plan.deletes) await deleteCustomFolder(lib, fid, { tombstone: false });
      const byId = new Map(localRows.map((r) => [r.folderId, r]));
      for (const e of plan.puts) {
        await putCustomFolder(mergeCustomFolder(byId.get(e.folderId), e), { preserveTimestamp: true });
      }
    }
  }

  // unwrap state: min(unwrappedAt) semantics — once unwrapped, never re-gifted
  //
  // ⚠️ v1.0.57 — THIS USED TO BLIND-PUT A TWO-FIELD RECORD OVER A LIVE ROW. `profileVideoState`
  // is ONE row per (child, video) shared by every per-child feature, and this loop rebuilt it
  // from scratch: importing a snapshot onto a profile that was already in use erased the
  // child's ⭐ (v1.0.40), their resume position (v1.0.32) and now their 🕒 stamp — silently,
  // for every video the snapshot mentioned. Exactly the class of bug `drive.mergeAppliedState`
  // exists to prevent on the sync path, on the path nobody looked at. The local row is now
  // read first and the snapshot's two fields are folded ON TOP of it.
  //
  // The DEVICE-LOCAL fields are deliberately NOT taken from the file (the export carries
  // whole rows): a position and a watch stamp describe the device that made them, which is
  // the same rule the Drive document follows. Keeping the LOCAL ones is not the same act as
  // importing someone else's.
  if (Array.isArray(snap.states)) {
    const existing = await loadVideoStates(profileId).catch(() => new Map());
    const statePuts = [];
    for (const st of snap.states) {
      if (!st || typeof st.key !== 'string') continue;
      const rec = { ...(existing.get(st.key) || {}), profileId, key: st.key };
      if (st.unwrappedAt) { rec.unwrappedAt = st.unwrappedAt; delete rec.giftRank; }
      else if (st.giftRank) rec.giftRank = st.giftRank;
      statePuts.push(rec);
    }
    if (statePuts.length) await putVideoStates(statePuts);
  }

  return { ok: true, imported, rejected };
}
