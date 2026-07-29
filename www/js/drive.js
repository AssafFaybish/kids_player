// drive.js — cross-device sync via a Google Drive DB file (decision 20).
// The DB JSON is modeled per-LIBRARY: everyone using the same input sheet (on the
// same Google account) shares videos, deny-list and channel subscriptions; gift
// state stays per profile. A Sheet mirror gives the parent a readable view.
//
// The pure parts (serializeDb / parseDb / mergeDbFiles) are node-tested. The merge is
// a small CRDT — grow-only deny-list, min/max lattices, LWW-by-updatedAt fields —
// commutative and idempotent, so two devices converge without a server.
//
// Files are tagged appProperties{kpApp:'kids-player'} and re-found by search after a
// reinstall; meta['drive'].dbFileId is only a cache (a 404 falls back to search).
// ⚠ Every mutating call sets an explicit Content-Type — CapacitorHttp silently drops
// a body without one (verified in Capacitor source).

import { httpRequest } from './platform.js';
import { getAccessToken } from './gauth.js';
import { libraryIdFor } from './util.js';
import { normalizeTitle, mergeVideoRecord } from './normalize.js';
import {
  openDb, getMeta, putMeta, getSources, putSources, loadMergeIndex, putVideos,
  listLibraryChannels, putLibraryChannel, getChannel, putChannel,
  loadDenyRecords, denyActive, tx, profScope, putVideoStates
} from './db.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/* =================== PURE: serialize / parse / merge =================== */

export function parseDb(text) {
  try {
    const d = JSON.parse(text);
    if (!d || d.kind !== 'kids-player-db' || typeof d.libraries !== 'object') return null;
    return d;
  } catch { return null; }
}

/**
 * Build the Drive DB document. NEVER includes: localPath (device-local URI),
 * thumb blobs, backfill cursors, or the YouTube API key (explicit refusal list).
 * profileSources (v1.0.4, additive — old readers ignore it) maps profile→sheetUrl
 * so a fresh device restoring the backup can rebuild each profile's sources record.
 */
export function serializeDb({ profiles, libraries, profileState, profileSources }) {
  const clean = {};
  for (const [libId, lib] of Object.entries(libraries || {})) {
    clean[libId] = {
      sheetUrl: lib.sheetUrl || null,
      videos: (lib.videos || []).map(({ localPath, thumbId, ...v }) => v),
      denylist: lib.denylist || [],
      channels: (lib.channels || []).map(({ backfillCursor, ...c }) => c),
      libraryChannels: lib.libraryChannels || []
    };
  }
  return JSON.stringify({
    kind: 'kids-player-db', schema: 1, exportedAt: Date.now(),
    profiles: profiles || [], libraries: clean, profileState: profileState || {},
    profileSources: profileSources || {}
  });
}

const lww = (a, b) => ((b && b.updatedAt) || 0) > ((a && a.updatedAt) || 0) ? b : a;

/**
 * v1.0.10: deny entries evolved from a grow-only set to an LWW-element set — an
 * entry may be REVOKED (removedAt >= at; see db.denyActive) when the sheet re-adds
 * a key. Merge rule: the entry whose LAST EVENT (deny or revoke) is later wins;
 * on a tie the revoked one wins (converges with "the sheet wins" semantics).
 */
const denyLastEvent = (d) => Math.max((d && d.at) || 0, (d && d.removedAt) || 0);
export function mergeDenyRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ea = denyLastEvent(a);
  const eb = denyLastEvent(b);
  if (ea !== eb) return ea > eb ? a : b;
  return denyActive(a) ? b : a; // tie → prefer the revoked entry
}

/** Commutative + idempotent (tested): merge(a,b) ≡ merge(b,a); merge(a,a) ≡ a. */
export function mergeDbFiles(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { kind: 'kids-player-db', schema: 1, exportedAt: Math.max(a.exportedAt || 0, b.exportedAt || 0) };

  const profById = new Map();
  for (const p of [...(a.profiles || []), ...(b.profiles || [])]) {
    if (!p || !p.id) continue;
    profById.set(p.id, profById.has(p.id) ? lww(profById.get(p.id), p) : p);
  }
  out.profiles = [...profById.values()];

  out.libraries = {};
  const libIds = new Set([...Object.keys(a.libraries || {}), ...Object.keys(b.libraries || {})]);
  for (const id of libIds) {
    const la = (a.libraries || {})[id];
    const lb = (b.libraries || {})[id];
    if (!la || !lb) { out.libraries[id] = la || lb; continue; }

    const vids = new Map();
    for (const v of la.videos || []) vids.set(v.key, v);
    for (const v of lb.videos || []) vids.set(v.key, vids.has(v.key) ? mergeVideoRecord(vids.get(v.key), v) : v);

    // deny-list: LWW-element union (v1.0.10) — entries never vanish, but a revoked
    // entry (sheet re-add) is inert. Only ACTIVE winners drop videos.
    const deny = new Map();
    for (const d of [...(la.denylist || []), ...(lb.denylist || [])]) {
      deny.set(d.key, mergeDenyRecord(deny.get(d.key), d));
    }
    for (const [key, d] of deny) { if (denyActive(d)) vids.delete(key); }

    const chans = new Map();
    for (const c of [...(la.channels || []), ...(lb.channels || [])]) {
      chans.set(c.channelId, chans.has(c.channelId) ? lww(chans.get(c.channelId), c) : c);
    }
    const libCh = new Map();
    for (const c of [...(la.libraryChannels || []), ...(lb.libraryChannels || [])]) {
      libCh.set(c.channelId, libCh.has(c.channelId) ? lww(libCh.get(c.channelId), c) : c);
    }

    out.libraries[id] = {
      sheetUrl: la.sheetUrl || lb.sheetUrl || null,
      videos: [...vids.values()],
      denylist: [...deny.values()],
      channels: [...chans.values()],
      libraryChannels: [...libCh.values()]
    };
  }

  // profile→sheet mapping (v1.0.4): LWW by updatedAt, same as profiles
  out.profileSources = {};
  const spids = new Set([...Object.keys(a.profileSources || {}), ...Object.keys(b.profileSources || {})]);
  for (const pid of spids) {
    const sa = (a.profileSources || {})[pid];
    const sb = (b.profileSources || {})[pid];
    out.profileSources[pid] = sa && sb ? lww(sa, sb) : (sa || sb);
  }

  // per-profile gift state: unwrappedAt takes MIN (once unwrapped anywhere, forever)
  out.profileState = {};
  const pids = new Set([...Object.keys(a.profileState || {}), ...Object.keys(b.profileState || {})]);
  for (const pid of pids) {
    const sa = (a.profileState || {})[pid] || {};
    const sb = (b.profileState || {})[pid] || {};
    const keys = new Set([...Object.keys(sa), ...Object.keys(sb)]);
    const merged = {};
    for (const k of keys) {
      const ua = sa[k] && sa[k].unwrappedAt;
      const ub = sb[k] && sb[k].unwrappedAt;
      if (ua || ub) merged[k] = { unwrappedAt: Math.min(ua || Infinity, ub || Infinity) };
      else merged[k] = sa[k] || sb[k];
    }
    out.profileState[pid] = merged;
  }
  return out;
}

/* =================== I/O: Drive API =================== */

async function api(token, opts) {
  return httpRequest({ ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
}

async function findDbFile(token) {
  const q = encodeURIComponent("appProperties has { key='kpApp' and value='kids-player' } and trashed=false");
  const res = await api(token, { url: `${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name,version,appProperties)`, responseType: 'json' });
  if (res.status !== 200) return null;
  const files = (res.data && res.data.files) || [];
  return files.find((f) => f.appProperties && f.appProperties.kpKind === 'db') || null;
}

async function createDbFile(token, content) {
  const meta = { name: 'kids-player-db.json', appProperties: { kpApp: 'kids-player', kpKind: 'db', kpSchema: '1' } };
  const body =
    '--kpb\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--kpb\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--kpb--';
  const res = await api(token, {
    method: 'POST', url: `${UPLOAD}/files?uploadType=multipart&fields=id,version`,
    headers: { 'Content-Type': 'multipart/related; boundary=kpb' }, body, responseType: 'json'
  });
  return res.status === 200 ? res.data : null;
}

async function updateDbFile(token, fileId, content) {
  const res = await api(token, {
    method: 'PATCH', url: `${UPLOAD}/files/${fileId}?uploadType=media&fields=id,version`,
    headers: { 'Content-Type': 'application/json' }, body: content, responseType: 'json'
  });
  return res.status === 200 ? res.data : null;
}

async function readDbFile(token, fileId) {
  const res = await api(token, { url: `${DRIVE}/files/${fileId}?alt=media`, responseType: 'text' });
  return res.status === 200 ? parseDb(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)) : null;
}

/* =================== local <-> document =================== */

async function buildLocalDoc(profiles) {
  const libraries = {};
  const profileState = {};
  const profileSources = {};
  for (const p of profiles) {
    const src = await getSources(p.id);
    if (src && src.sheetUrl) {
      profileSources[p.id] = { sheetUrl: src.sheetUrl, updatedAt: src.updatedAt || 0 };
    }
    const lib = src && src.libraryId;
    if (lib && !libraries[lib]) {
      const vids = [...(await loadMergeIndex(lib)).values()];
      const libCh = await listLibraryChannels(lib);
      const chans = [];
      for (const lc of libCh) { const c = await getChannel(lc.channelId); if (c) chans.push(c); }
      libraries[lib] = {
        sheetUrl: src.sheetUrl || null, videos: vids,
        // FULL deny rows (v1.0.10) incl. revoked ones — real timestamps, so the
        // LWW merge is meaningful (the old code stamped Date.now() on every push)
        denylist: await loadDenyRecords(lib),
        channels: chans, libraryChannels: libCh
      };
    }
    // profile-scope manual items ride inside a pseudo-library keyed by the prof scope
    const pScope = profScope(p.id);
    const pv = [...(await loadMergeIndex(pScope)).values()];
    if (pv.length) {
      libraries[pScope] = {
        sheetUrl: null, videos: pv,
        denylist: await loadDenyRecords(pScope),
        channels: [], libraryChannels: []
      };
    }
    const states = {};
    const db = await openDb();
    await new Promise((resolve) => {
      const range = IDBKeyRange.bound([p.id, ''], [p.id, '￿']);
      const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve();
        const v = cur.value;
        states[v.key] = v.unwrappedAt ? { unwrappedAt: v.unwrappedAt } : { giftRank: v.giftRank };
        cur.continue();
      };
      req.onerror = () => resolve();
    });
    profileState[p.id] = states;
  }
  return { profiles, libraries, profileState, profileSources };
}

async function applyRemoteDoc(doc) {
  for (const [libId, lib] of Object.entries(doc.libraries || {})) {
    const existing = await loadMergeIndex(libId);
    // v1.0.10: merge remote deny rows with local ones (LWW per key) — a local
    // revoke must not be resurrected by a stale active deny from an old doc.
    const mergedDeny = new Map((await loadDenyRecords(libId)).map((d) => [d.key, d]));
    for (const d of lib.denylist || []) {
      if (!d || !d.key) continue;
      const remote = { scopeId: libId, key: d.key, at: d.at || 0, removedAt: d.removedAt, reason: d.reason || 'drive-sync' };
      mergedDeny.set(d.key, mergeDenyRecord(mergedDeny.get(d.key), remote));
    }
    const activeDenied = new Set([...mergedDeny.values()].filter(denyActive).map((d) => d.key));

    const puts = [];
    for (const v of lib.videos || []) {
      if (!v || !v.key || activeDenied.has(v.key)) continue;
      const mine = existing.get(v.key);
      const rec = mine ? mergeVideoRecord(mine, { ...v, scopeId: libId }) : { ...v, scopeId: libId, localPath: null, thumbId: null };
      rec.normTitle = normalizeTitle(rec.title);
      puts.push(rec);
    }
    await putVideos(puts);
    await tx(['denylist'], 'readwrite', (deny) => {
      for (const d of mergedDeny.values()) deny.put(d);
    });
    await tx(['videos'], 'readwrite', (videos) => { // enforce ACTIVE tombstones only
      for (const key of activeDenied) videos.delete([libId, key]);
    });
    for (const c of lib.channels || []) {
      const prev = await getChannel(c.channelId);
      await putChannel(prev ? { ...prev, ...c, backfillCursor: prev.backfillCursor } : c);
    }
    for (const lc of lib.libraryChannels || []) await putLibraryChannel({ ...lc, libraryId: libId });
  }
  // Rebuild sources for restored profiles (v1.0.4): a fresh device knows the
  // library data but not WHICH sheet each profile follows. Local records win —
  // this only fills the gap for profiles that have none.
  for (const [pid, ps] of Object.entries(doc.profileSources || {})) {
    if (!ps || !ps.sheetUrl) continue;
    if (await getSources(pid)) continue;
    await putSources({
      profileId: pid, schema: 1, sheetUrl: ps.sheetUrl, libraryId: libraryIdFor(ps.sheetUrl),
      sheetHash: null, // force a full parse on the first sync
      shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
      maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: true }, updatedAt: Date.now()
    });
  }

  // unwrappedAt states apply for EVERY profile in the doc (v1.0.4): a fresh device
  // restoring the backup must not re-gift videos the children already opened.
  // giftRank states deliberately stay remote-only — local gift assignment wins.
  for (const [pid, st] of Object.entries(doc.profileState || {})) {
    const puts = [];
    for (const [key, v] of Object.entries(st || {})) {
      if (v && v.unwrappedAt) puts.push({ profileId: pid, key, unwrappedAt: v.unwrappedAt });
    }
    if (puts.length) await putVideoStates(puts);
  }
}

/* =================== public: push / pull =================== */

let pushTimer = null;

/** Debounced background push — call after any local mutation worth syncing. */
export function schedulePush(profiles) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushDrive(profiles).catch(() => {}); }, 60 * 1000);
}

export async function pushDrive(profiles) {
  const token = await getAccessToken({ interactive: false });
  if (!token) { await patchDriveMeta({ pendingPush: true }); return { ok: false, error: 'no-token' }; }

  const meta = (await getMeta('drive')) || {};
  const localDoc = parseDb(serializeDb(await buildLocalDoc(profiles)));

  let fileId = meta.dbFileId;
  let remoteVersion = null;
  if (fileId) {
    const probe = await api(token, { url: `${DRIVE}/files/${fileId}?fields=id,version`, responseType: 'json' });
    if (probe.status === 404) fileId = null; // parent deleted it in Drive — fall through
    else if (probe.status === 200) remoteVersion = probe.data.version;
  }
  if (!fileId) {
    const found = await findDbFile(token);
    if (found) { fileId = found.id; remoteVersion = found.version; }
  }

  let content;
  if (fileId && String(remoteVersion) !== String(meta.lastRemoteVersion || '')) {
    const remote = await readDbFile(token, fileId); // changed since our last write: merge first
    const merged = mergeDbFiles(localDoc, remote);
    await applyRemoteDoc(merged);
    content = JSON.stringify(merged);
  } else {
    content = JSON.stringify(localDoc);
  }

  const res = fileId ? await updateDbFile(token, fileId, content) : await createDbFile(token, content);
  if (!res) { await patchDriveMeta({ pendingPush: true }); return { ok: false, error: 'upload-failed' }; }
  await patchDriveMeta({ enabled: true, dbFileId: res.id, lastRemoteVersion: res.version, lastPushAt: Date.now(), pendingPush: false });
  return { ok: true };
}

/** On sign-in / new device: pull the remote DB and merge it into local state. */
export async function pullDrive(myProfileId) {
  const token = await getAccessToken({ interactive: false });
  if (!token) return { ok: false, error: 'no-token' };
  const meta = (await getMeta('drive')) || {};
  let fileId = meta.dbFileId;
  if (!fileId) {
    const found = await findDbFile(token);
    if (!found) return { ok: true, empty: true };
    fileId = found.id;
  }
  const doc = await readDbFile(token, fileId);
  if (!doc) return { ok: false, error: 'read-failed' };
  await applyRemoteDoc(doc);
  // Restore profiles from the backup (v1.0.4): on a fresh device the local list is
  // empty — without this, a connected backup restored the library but no profiles.
  let profilesRestored = 0;
  try {
    const { mergeRestoredProfiles } = await import('./store.js');
    profilesRestored = await mergeRestoredProfiles(doc.profiles);
  } catch {}
  await patchDriveMeta({ enabled: true, dbFileId: fileId, myProfileId });
  return { ok: true, profiles: doc.profiles || [], profilesRestored };
}

async function patchDriveMeta(patch) {
  const cur = (await getMeta('drive')) || {};
  await putMeta('drive', { ...cur, ...patch });
}
