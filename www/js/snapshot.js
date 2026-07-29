// snapshot.js — FULL-state export/import per profile. This is the only backup that
// works with zero Google sign-in, and the hard prerequisite for the one-time
// debug→release signing switchover (uninstall wipes everything).
//
// SECURITY: import treats the file as UNTRUSTED (like the sheet): every video is
// re-classified from its srcUrl through classifyLink — the one legacy path that
// bypassed the safety boundary (old importJson) is closed. localPath is validated
// against the cache-file shape. Import MERGES, never overwrites.

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
    const c = classifyLink(v && v.srcUrl);         // THE safety boundary — rebuilt, not trusted
    if (!c) { rejected += 1; continue; }
    const scopeId = validScopes.has(v.scopeId) ? v.scopeId : profScope(profileId);
    const rec = {
      scopeId, key: c.key, type: c.type, id: c.id ?? null, url: c.url ?? null,
      srcUrl: c.srcUrl, driveId: c.driveId ?? null,
      title: typeof v.title === 'string' ? v.title.slice(0, 300) : '',
      titleSource: v.titleSource || null,
      normTitle: normalizeTitle(v.title),
      folderId: typeof v.folderId === 'string' && v.folderId !== '~pending' ? v.folderId : 'mine',
      homeFolderId: v.homeFolderId,
      channelId: typeof v.channelId === 'string' ? v.channelId : null,
      sortKey: typeof v.sortKey === 'number' ? v.sortKey
        : sortKeyFor({ origin: v.origin || 'manual', publishedAt: v.publishedAt, rowIndex: v.rowIndex, addedAt: v.addedAt }),
      publishedAt: v.publishedAt ?? null, rowIndex: v.rowIndex ?? null,
      origin: v.origin || 'manual',
      state: v.state === 'pending' ? 'pending' : 'live',
      addedAt: v.addedAt || Date.now(), approvedAt: v.approvedAt ?? null,
      thumbId: null, // blobs don't travel in the snapshot
      thumbUrl: typeof v.thumbUrl === 'string' && /^https:/.test(v.thumbUrl) ? v.thumbUrl : null,
      localPath: LOCALPATH_RE.test(v.localPath || '') ? v.localPath : null,
      updatedAt: Date.now()
    };
    if (rec.state === 'pending') { rec.homeFolderId = rec.folderId; rec.folderId = '~pending'; }
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
