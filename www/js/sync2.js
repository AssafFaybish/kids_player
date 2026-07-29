// sync2.js — the staged sync pipeline (replaces the old mirror-everything sync).
// RULE: the UI hydrates from IndexedDB instantly; this whole pipeline runs in the
// background and reports progress — it must NEVER block rendering, and a network
// failure at any stage leaves the cached library intact.
//
// Stages: sheet(+hash skip) → resolveChannels → rss (incremental, keyless) →
// backfill (budgeted, resumable, API) → planMutations (pure) → persist →
// titles (batched; persist twice) → gifts (per profile) → [pushDrive hook].

import { httpGetText, prefGet } from './platform.js';
import { parseCsv } from './csv.js';
import { classifySourceRow } from './classify.js';
import { resolveListUrl } from './sync.js';
import { fnv1a, libraryIdFor, mapWithConcurrency } from './util.js';
import { planMutations, planGifts, planSheetMirror } from './plan.js';
import { pendingChannelDeletes, pendingAppendKeys } from './sheetwrite.js';
import { normalizeTitle } from './normalize.js';
import { planChannelFetch, shouldThrottle } from './quota.js';
import { QUOTA_DAILY_SOFT_CAP } from './config.js';
import * as yt from './yt.js';
import {
  getSources, putSources, getChannel, putChannel,
  listLibraryChannels, putLibraryChannel, deleteLibraryChannel,
  loadDenySet, loadMergeIndex, putVideos, setVideoFields, deleteVideoRaw,
  getVideo, unDeny,
  putVideoStates, getMeta, putMeta, profScope, countFolder, pageFolder
} from './db.js';

const BACKFILL_PAGE_BUDGET = 40; // ~2000 videos per run; continues next launch

/**
 * PURE: typed rows from the raw sheet text. rowIndex counts VIDEO rows only, so
 * comments/blank lines/channels never reshuffle video ordinals (tested).
 */
export function parseSourceSheet(text) {
  const videoRows = [];
  const channelRows = [];
  const invalid = [];
  let videoOrdinal = 0;
  for (const fields of parseCsv(text)) {
    const parts = fields.map((s) => String(s ?? '').trim().replace(/^"+|"+$/g, ''));
    const row = classifySourceRow(parts[0] || '');
    if (row.kind === 'blank' || row.kind === 'comment') continue;
    if (row.kind === 'video') {
      videoRows.push({ ...row, title: parts[1] || '', thumbUrl: parts[2] || '', rowIndex: videoOrdinal });
      videoOrdinal += 1;
    } else if (row.kind === 'channel') {
      channelRows.push({ ref: row.channelRef, title: parts[1] || '', flag: (parts[2] || '').toLowerCase() });
    } else if (row.kind === 'playlist') {
      // playlists ride the same pipe as channels via their playlistId later; skipped for now
      invalid.push({ raw: row.playlistId, kind: 'playlist-unsupported-yet' });
    } else {
      invalid.push(row);
    }
  }
  return { videoRows, channelRows, invalid };
}

const inFlight = new Map(); // profileId -> Promise

export function syncLibrary(profileId, opts = {}) {
  if (inFlight.has(profileId)) return inFlight.get(profileId);
  const p = doSync(profileId, opts).finally(() => inFlight.delete(profileId));
  inFlight.set(profileId, p);
  return p;
}

async function doSync(profileId, { onProgress = () => {}, signal, force = false } = {}) {
  const report = (stage, pct, label) => { try { onProgress({ stage, pct, label }); } catch {} };
  const aborted = () => signal && signal.aborted;

  const src = (await getSources(profileId)) || {
    profileId, schema: 1, sheetUrl: null, libraryId: null,
    shareIntent: { enabled: true, requireApproval: true },
    defaultAutoApprove: false, maxItemsPerChannel: 500, maxItemsTotal: 5000,
    drive: { enabled: false }, updatedAt: Date.now()
  };
  // A stable library even without a sheet (channels added from the parent UI).
  if (!src.libraryId) {
    src.libraryId = src.sheetUrl ? libraryIdFor(src.sheetUrl) : 'lib:p:' + profileId;
    await putSources(src);
  }
  const lib = src.libraryId;
  const key = await yt.getApiKey();

  /* ---------- stage: sheet ---------- */
  let videoRows = [];
  let channelRows = [];
  let sheetChanged = false;
  let sheetParsed = false; // v1.0.10: mirroring may run ONLY on a successful fetch
  if (src.sheetUrl) {
    report('sheet', 5, 'מביאים את הרשימה…');
    try {
      const text = await httpGetText(resolveListUrl(src.sheetUrl));
      const hash = fnv1a(text);
      sheetChanged = force || hash !== src.sheetHash;
      const parsed = parseSourceSheet(text);
      videoRows = parsed.videoRows;
      channelRows = parsed.channelRows;
      sheetParsed = true;
      if (sheetChanged) await putSources({ ...src, sheetHash: hash, sheetFetchedAt: Date.now() });
    } catch (e) {
      report('sheet', 5, ''); // offline: proceed with known channels
    }
  }
  if (aborted()) return { ok: false, error: 'aborted' };

  /* ---------- stage: resolve channels ---------- */
  report('channels', 12, 'מזהים ערוצים…');
  const known = await listLibraryChannels(lib);
  const knownIds = new Set(known.map((c) => c.channelId));
  // v1.0.10: a channel whose sheet-row deletion is still queued must not be
  // re-subscribed from the still-present row (deleted channels used to resurrect)
  const pendingDel = await pendingChannelDeletes(lib);
  const sheetChannelIds = new Set(); // every RESOLVED channel the sheet contains now
  for (const row of channelRows) {
    if (aborted()) return { ok: false, error: 'aborted' };
    try {
      const channelId = await yt.resolveChannelRef(row.ref, key);
      if (!channelId) continue;
      sheetChannelIds.add(channelId);
      if (knownIds.has(channelId) || pendingDel.has(channelId)) continue;
      knownIds.add(channelId);
      await putLibraryChannel({
        libraryId: lib, channelId,
        autoApprove: row.flag === 'auto' ? true : row.flag === 'manual' ? false : !!src.defaultAutoApprove,
        autoApproveSource: row.flag ? 'sheet' : 'default',
        order: knownIds.size, addedAt: Date.now(), hidden: false, sourceRow: true,
        titleOverride: row.title || ''
      });
    } catch { /* one bad ref must not kill sync */ }
  }

  /* ---------- stage: mirror (v1.0.10 — the sheet is the truth BOTH ways) ---------- */
  if (sheetParsed) {
    try {
      const mirror = planSheetMirror({
        prevSeen: await getMeta('sheetSeen:' + lib),
        currentVideoKeys: videoRows.map((r) => r.key),
        currentChannelIds: [...sheetChannelIds],
        pendingAppendKeys: await pendingAppendKeys(lib),
        deniedKeys: await loadDenySet(lib)
      });
      // a key that LEFT and CAME BACK = deliberate re-add → the old deny yields
      for (const k of mirror.unDenyKeys) await unDeny(lib, k);
      if (mirror.valve) {
        // SAFETY VALVE: too many rows vanished at once (truncated read / accidental
        // range delete). Nothing is deleted; the parent decides in the sources tab.
        await putMeta('sheetMirrorAlert:' + lib, {
          deleteVideoKeys: mirror.deleteVideoKeys, deleteChannelIds: mirror.deleteChannelIds,
          disappeared: mirror.disappeared, at: Date.now()
        });
      } else {
        await putMeta('sheetMirrorAlert:' + lib, null);
        await applySheetMirror(lib, mirror);
        await putMeta('sheetSeen:' + lib, {
          videoKeys: videoRows.map((r) => r.key), channelIds: [...sheetChannelIds]
        });
      }
    } catch { /* mirroring must never kill the sync */ }
  }

  const libChannels = await listLibraryChannels(lib);

  // Channel metadata (title/logo/uploads) — one batched call for the missing ones.
  const needMeta = [];
  for (const lc of libChannels) {
    const ch = await getChannel(lc.channelId);
    if (!ch || !ch.uploadsPlaylistId || (!ch.title && key) || (!ch.logoUrl && key && !ch.logoTriedAt)) needMeta.push(lc.channelId);
  }
  if (needMeta.length) {
    const metaMap = await yt.fetchChannelMeta(needMeta, key);
    for (const [channelId, m] of metaMap) {
      const prev = (await getChannel(channelId)) || { channelId };
      await putChannel({
        ...prev, channelId,
        title: m.title || prev.title || '',
        logoUrl: m.logoUrl || prev.logoUrl || '',
        logoTriedAt: Date.now(),
        uploadsPlaylistId: m.uploadsPlaylistId || prev.uploadsPlaylistId || null
      });
    }
  }

  // Logo fallback (v1.0.4): keyless mode (and API misses) left channels logo-less on
  // the tablet — folder tiles fell back to the 📺 emoji and read like videos. Scrape
  // the public channel page (0 quota), retry weekly so a transient failure heals.
  const LOGO_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
  for (const lc of libChannels) {
    if (aborted()) return { ok: false, error: 'aborted' };
    const ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
    if (ch.logoUrl) continue;
    if (ch.logoTriedAt && Date.now() - ch.logoTriedAt < LOGO_RETRY_MS) continue;
    const logoUrl = await yt.scrapeChannelLogo(lc.channelId);
    await putChannel({ ...ch, logoUrl: logoUrl || '', logoTriedAt: Date.now() });
  }

  /* ---------- stages: rss + backfill → candidates ---------- */
  const candidates = [];
  const scope = lib; // library scope: shared across profiles/devices on this sheet

  for (const row of videoRows) {
    candidates.push({
      scopeId: scope, key: row.key, type: row.type, id: row.id ?? null,
      url: row.url ?? null, srcUrl: row.srcUrl, driveId: row.driveId ?? null,
      title: row.title, titleSource: row.title ? 'sheet' : null, thumbUrl: row.thumbUrl || null,
      channelId: null, folderId: 'sheet', origin: 'sheet-row', rowIndex: row.rowIndex,
      publishedAt: null, autoApprove: true // individually curated by the parent
    });
  }

  report('rss', 30, 'בודקים סרטונים חדשים…');
  const rssResults = await mapWithConcurrency(libChannels, 4, async (lc) => {
    const ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
    const action = planChannelFetch(ch, Date.now(), !!key);
    if (action === 'skip' && !force) return { channelId: lc.channelId, videos: [] };
    if (action === 'backfill') return { channelId: lc.channelId, videos: [], backfill: true };
    const feed = await yt.fetchChannelRss(lc.channelId);
    await putChannel({ ...ch, lastRssCheckedAt: Date.now(), title: ch.title || feed[0]?.channelTitle || '' });
    return { channelId: lc.channelId, videos: feed };
  }, { signal });

  let backfillPages = 0;
  for (const r of rssResults) {
    if (!r.ok) continue;
    const { channelId, videos, backfill } = r.value;
    const lc = libChannels.find((c) => c.channelId === channelId);
    for (const v of videos) {
      candidates.push({
        scopeId: scope, key: 'yt:' + v.videoId, type: 'youtube', id: v.videoId,
        url: null, srcUrl: 'https://www.youtube.com/watch?v=' + v.videoId, driveId: null,
        title: v.title, titleSource: 'rss', thumbUrl: v.thumbUrl || null,
        channelId, folderId: 'ch:' + channelId, origin: 'channel',
        publishedAt: v.publishedAt, rowIndex: null, autoApprove: !!lc?.autoApprove
      });
    }
    if (backfill && key) {
      report('backfill', 45, 'מושכים את כל הסרטונים…');
      let ch = await getChannel(channelId);
      let token = ch.backfillCursor || null;
      while (backfillPages < BACKFILL_PAGE_BUDGET && !aborted()) {
        if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
        const page = await yt.fetchUploadsPage(ch.uploadsPlaylistId, token, key);
        backfillPages += 1;
        if (page.error) break;
        for (const v of page.videos) {
          candidates.push({
            scopeId: scope, key: 'yt:' + v.videoId, type: 'youtube', id: v.videoId,
            url: null, srcUrl: 'https://www.youtube.com/watch?v=' + v.videoId, driveId: null,
            title: v.title, titleSource: 'api', thumbUrl: v.thumbUrl || null,
            channelId, folderId: 'ch:' + channelId, origin: 'channel',
            publishedAt: v.publishedAt, rowIndex: null, autoApprove: !!lc?.autoApprove
          });
        }
        token = page.nextPageToken;
        ch = { ...ch, backfillCursor: token, backfillDone: !token };
        await putChannel(ch); // cursor persisted per page — resumable across kills
        if (!token) break;
      }
    }
  }
  if (aborted()) return { ok: false, error: 'aborted' };

  /* ---------- stage: plan + persist ---------- */
  report('plan', 70, 'מסדרים את הסרטונים…');
  const denySet = await loadDenySet(scope);
  const existing = await loadMergeIndex(scope);

  // Quarantine (first new-model sync of a migrated profile): legacy deletions are
  // unrecoverable, so ONLY sheet keys the old curated list already had stay live —
  // they also migrate from the prof scope into the shared library scope (carrying
  // localPath). Unknown sheet keys arrive as pending: one bulk parent decision
  // instead of silently resurrecting whatever was deleted in the old app.
  const quarantineFlag = 'sync:' + lib + ':quarantineDone';
  const quarantine = !!src.legacySheetMigrated && !(await getMeta(quarantineFlag));
  const legacyMoves = [];
  if (quarantine) {
    const legacy = await loadMergeIndex(profScope(profileId));
    for (const c of candidates) {
      if (c.origin !== 'sheet-row') continue;
      const leg = legacy.get(c.key);
      c.autoApprove = !!leg;
      if (leg) legacyMoves.push({ key: c.key, localPath: leg.localPath || null, addedAt: leg.addedAt });
    }
  }

  const plan = planMutations({
    candidates, existing, denySet,
    caps: { maxPerChannel: src.maxItemsPerChannel, maxTotal: src.maxItemsTotal }
  });
  await putVideos(plan.puts);
  for (const mv of legacyMoves) {
    if (mv.localPath) await setVideoFields(scope, mv.key, { localPath: mv.localPath });
    await deleteVideoRaw(profScope(profileId), mv.key); // moved into the library
  }
  if (quarantine) await putMeta(quarantineFlag, Date.now());
  if (plan.mergeReport.length) {
    const prevReport = (await getMeta('dedupe:' + lib)) || [];
    await putMeta('dedupe:' + lib, [...plan.mergeReport, ...prevReport].slice(0, 200));
  }

  /* ---------- stage: titles (persist twice) ---------- */
  const untitled = plan.puts.filter((p) => p.type === 'youtube' && !p.title).map((p) => p.id);
  if (untitled.length) {
    report('titles', 80, 'משלימים שמות…');
    const titles = await yt.fetchTitles(untitled, key);
    for (const [id, title] of titles) {
      if (title) await setVideoFields(scope, 'yt:' + id, { title, titleSource: key ? 'api' : 'oembed', normTitle: normalizeTitle(title) });
    }
  }

  /* ---------- stage: folder-image fallback (v1.0.6) ---------- */
  // A channel with no obtainable logo gets a PERSISTED fallback image: the thumbnail
  // of its OLDEST live video — deterministic, never changes as new uploads arrive, so
  // every channel folder stays visually distinct for a non-reading child.
  for (const lc of libChannels) {
    if (aborted()) break;
    const ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
    if (ch.logoUrl || ch.fallbackThumbUrl) continue;
    const fid = 'ch:' + lc.channelId;
    const total = await countFolder(scope, fid);
    if (!total) continue;
    const oldest = await pageFolder(scope, fid, { offset: total - 1, limit: 1 });
    const thumb = oldest.items[0] && oldest.items[0].thumbUrl;
    if (thumb) await putChannel({ ...ch, fallbackThumbUrl: thumb });
  }

  /* ---------- stage: gifts (per calling profile) ---------- */
  report('gifts', 90, 'עוטפים הפתעות…');
  await planProfileGifts(profileId, scope, lib);

  await putMeta('sync:' + lib + ':lastFullSyncAt', Date.now());
  report('done', 100, '');

  // v1.0.6: opportunistic sheet write-back — quiet no-op without a queue/token.
  try {
    const { flushSheetQueue } = await import('./sheetwrite.js');
    await flushSheetQueue(profileId);
  } catch {}

  return { ok: true, added: plan.newLiveKeys.length, pending: plan.pendingKeys.length, merged: plan.mergeReport.length };
}

/**
 * v1.0.10: apply mirror deletions — RAW deletes (no tombstone), so a wrongly
 * removed row heals itself the moment the sheet has it back. Video keys are
 * removed only when the local record is sheet-backed (channelId == null) —
 * channel content is governed by its channel, not by rows. A deleted channel
 * takes its imported videos with it (user decision: full cleanup everywhere).
 * Also used by the parent-screen safety-valve "apply" button and by the UI
 * channel-remove flow.
 */
export async function applySheetMirror(lib, { deleteVideoKeys = [], deleteChannelIds = [] } = {}) {
  for (const key of deleteVideoKeys) {
    const rec = await getVideo(lib, key);
    if (rec && rec.channelId == null) await deleteVideoRaw(lib, key);
  }
  for (const id of deleteChannelIds) {
    await deleteLibraryChannel(lib, id);
    for (const rec of (await loadMergeIndex(lib)).values()) {
      if (rec.channelId === id) await deleteVideoRaw(lib, rec.key);
    }
  }
}

/** Baseline (newest 12) on a profile's first sync of this library; incremental after. */
export async function planProfileGifts(profileId, scope, lib) {
  const flag = 'gift:' + profileId + ':' + lib + ':baselineDone';
  const firstSync = !(await getMeta(flag));

  // live records of the library scope (bounded: caps already applied)
  const { items: liveRecords } = await pageFolderAll(scope);
  const existingStates = new Map();
  const { openDb } = await import('./db.js');
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([profileId, ''], [profileId, '￿']);
    const req = db.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      existingStates.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const newLiveKeys = liveRecords.filter((r) => !existingStates.has(r.key)).map((r) => r.key);
  const statePuts = planGifts({ profileId, liveRecords, newLiveKeys, existingStates, firstSync });
  if (statePuts.length) await putVideoStates(statePuts.map((s) => ({ ...existingStates.get(s.key), ...s })));
  if (firstSync) await putMeta(flag, Date.now());
}

/** All live records of a scope (every folder), lightweight fields via merge index. */
async function pageFolderAll(scope) {
  const idx = await loadMergeIndex(scope);
  const items = [...idx.values()].filter((r) => r.state === 'live');
  return { items };
}

/** Should the app resync now? (launch/resume/home-entry guard)
    v1.0.7: 3 minutes — home entry triggers a sync too, and the child bounces
    home↔video constantly; the sheet hash-skip keeps a no-change run cheap. */
export async function shouldSync(profileId) {
  const src = await getSources(profileId);
  if (!src || !src.libraryId) return true;
  const last = (await getMeta('sync:' + src.libraryId + ':lastFullSyncAt')) || 0;
  return Date.now() - last > 3 * 60 * 1000;
}
