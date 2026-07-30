// sync2.js — the staged sync pipeline (replaces the old mirror-everything sync).
// RULE: the UI hydrates from IndexedDB instantly; this whole pipeline runs in the
// background and reports progress — it must NEVER block rendering, and a network
// failure at any stage leaves the cached library intact.
//
// Stages: sheet(+hash skip) → resolveChannels → rss (incremental, keyless) →
// backfill (budgeted, resumable, API) → planMutations (pure) → persist →
// titles (batched; persist twice) → gifts (per profile) → [pushDrive hook].

import { prefGet } from './platform.js';
// v1.0.19: reads moved to the authenticated Sheets API, so the CSV-export fetch
// (httpGetText + resolveListUrl) and its HTML-error-page guard are gone from this
// path. parseCsv still backs parseSourceSheet, which is TEST-ONLY (no production
// caller) — see the note on that function.
import { parseCsv } from './csv.js';
import { classifySourceRow } from './classify.js';
import { fnv1a, libraryIdFor, mapWithConcurrency } from './util.js';
import {
  planMutations, planGifts, planSheetMirror, shouldRecordGiftBaseline, sheetBackedKeysOf
} from './plan.js';
import { pendingChannelDeletes, pendingAppendKeys, pendingDeleteKeys } from './sheetwrite.js';
import { normalizeTitle } from './normalize.js';
import { planChannelFetch, shouldThrottle } from './quota.js';
import { QUOTA_DAILY_SOFT_CAP } from './config.js';
import * as yt from './yt.js';
import {
  getSources, putSources, getChannel, putChannel,
  listLibraryChannels, putLibraryChannel, deleteLibraryChannel,
  loadDenySet, loadMergeIndex, putVideos, setVideoFields, deleteVideoRaw, deleteVideo,
  getVideo, unDeny,
  putVideoStates, getMeta, putMeta, profScope, countFolder, pageFolder
} from './db.js';

const BACKFILL_PAGE_BUDGET = 40; // ~2000 videos per run; continues next launch

/**
 * PURE: typed rows from raw CSV TEXT.
 *
 * ⚠️ v1.0.19: this has NO production caller. Reads go through the authenticated
 * Sheets API and land in `parseSourceRows` below; nothing in the app fetches CSV
 * any more. It is retained only because the tests use it to exercise the tokenizer
 * and the row classifier together. Do NOT wire it back to a network fetch — a CSV
 * export URL only works on a publicly shared sheet, which is exactly the property
 * v1.0.19 removed.
 */
export function parseSourceSheet(text) {
  return parseSourceRows(parseCsv(text));
}

/**
 * v1.0.19 — the same parser over ALREADY-TOKENIZED rows (array of arrays), which is
 * what the authenticated Sheets API returns. Reads used to go through a public CSV
 * export, which forced every family's playlist to be shared "anyone with the link".
 * `parseSourceSheet` stays as the CSV front door so the tokenizer keeps its tests.
 */
export function parseSourceRows(rows) {
  const videoRows = [];
  const channelRows = [];
  const removedKeys = []; // v1.0.12: '# הוסר: <link>' rows — deny these for everyone
  const invalid = [];
  let videoOrdinal = 0;
  for (const fields of (Array.isArray(rows) ? rows : [])) {
    // The Sheets API omits trailing empty cells, so rows arrive ragged — and a
    // malformed payload can hand us a non-array row. Neither may throw here: this
    // runs inside the try that decides `sheetParsed`, and a throw would be read as
    // "the sheet is unreadable" on input that is merely untidy.
    const parts = (Array.isArray(fields) ? fields : []).map((s) => String(s ?? '').trim().replace(/^"+|"+$/g, ''));
    const row = classifySourceRow(parts[0] || '');
    if (row.kind === 'removed') { removedKeys.push(row.key); continue; }
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
  // a removal row always wins over a video row for the same key in the SAME sheet:
  // safety-first — to bring a video back the parent deletes the removal row.
  const removed = new Set(removedKeys);
  return { videoRows: videoRows.filter((r) => !removed.has(r.key)), channelRows, removedKeys, invalid };
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
  let removedKeys = [];
  let sheetChanged = false;
  let sheetParsed = false; // v1.0.10: mirroring may run ONLY on a successful fetch
  let sheetError = null;   // v1.0.19: WHY it failed — the caller must be able to say so
  if (src.sheetUrl) {
    report('sheet', 5, 'מביאים את הרשימה…');
    try {
      // v1.0.19: AUTHENTICATED read. The sheet is the app's own file (drive.file)
      // and is no longer shared publicly, so it is fetched with the parent's token.
      // readSourceSheet THROWS on any non-200 — which is what we want: a failure
      // must leave sheetParsed false so the presence-mirror never reads "unreadable"
      // as "the parent emptied the sheet" and deletes the library.
      const { readSourceSheet } = await import('./sheetwrite.js');
      const rows = await readSourceSheet(src.sheetUrl);
      const hash = fnv1a(JSON.stringify(rows));
      sheetChanged = force || hash !== src.sheetHash;
      const parsed = parseSourceRows(rows);
      videoRows = parsed.videoRows;
      channelRows = parsed.channelRows;
      removedKeys = parsed.removedKeys || [];
      sheetParsed = true;
      if (sheetChanged) await putSources({ ...src, sheetHash: hash, sheetFetchedAt: Date.now() });
    } catch (e) {
      // v1.0.19 — REPORT IT. Keeping the cached library is right, but swallowing the
      // reason was not: reads now need a token where the old CSV read needed none, so
      // a revoked grant or a dead refresh freezes the library FOREVER — and the
      // sources tab used to answer every 🔄 with "עודכן ✅" while nothing synced.
      sheetError = (e && e.message) || 'sheet-failed';
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
  // PRESENCE-based on every successful parse (never diff-vs-baseline: a baseline
  // forgets, and content resurrected by a stale Drive-doc merge would stay forever).
  if (sheetParsed) {
    report('mirror', 8, 'משווים מול הגיליון…');
    try {
      // v1.0.12: '# הוסר' rows deny their key for EVERY participant — that is how a
      // deletion of a video INSIDE a channel travels (it has no row of its own).
      // The deny set is read ONCE, not per key: it is a full getAll over the scope's
      // tombstones, it only grows as parents delete things, and the branch below is
      // taken exactly for keys that are already gone (v1.0.20 — it was quadratic).
      const denied = removedKeys.length ? await loadDenySet(lib) : null;
      for (const key of removedKeys) {
        if (await getVideo(lib, key)) await deleteVideo(lib, key, 'sheet-removed');
        else if (!denied.has(key)) await deleteVideo(lib, key, 'sheet-removed');
      }
      const libIndex = await loadMergeIndex(lib);
      // LIVE records only — see sheetBackedKeysOf: a PENDING share is parked with
      // homeFolderId 'sheet' but gets its row at APPROVAL time, and mirroring it
      // would tombstone the share before the parent ever saw the request.
      const sheetBackedKeys = sheetBackedKeysOf(libIndex.values());
      const mirror = planSheetMirror({
        sheetBackedKeys,
        localChannelIds: (await listLibraryChannels(lib)).map((c) => c.channelId),
        currentVideoKeys: videoRows.map((r) => r.key),
        currentChannelIds: [...sheetChannelIds],
        pendingAppendKeys: await pendingAppendKeys(lib),
        // a key with a '# הוסר' row must never be un-denied by presence, and neither
        // must one whose own row-removal is still queued
        pendingDeleteKeys: [...(await pendingDeleteKeys(lib)), ...removedKeys],
        deniedKeys: await loadDenySet(lib)
      });
      // a denied key the sheet LISTS = deliberate re-add → the tombstone yields
      for (const k of mirror.unDenyKeys) await unDeny(lib, k);
      if (mirror.valve) {
        // SAFETY VALVE: too many deletions at once (truncated read / accidental range
        // delete). Nothing is deleted; the parent decides in the sources tab. The
        // signature keeps an "ignore" answer from re-alerting on the SAME divergence.
        const sig = fnv1a(JSON.stringify([mirror.deleteVideoKeys.slice().sort(), mirror.deleteChannelIds.slice().sort()]));
        if ((await getMeta('sheetMirrorIgnoredSig:' + lib)) !== sig) {
          await putMeta('sheetMirrorAlert:' + lib, {
            deleteVideoKeys: mirror.deleteVideoKeys, deleteChannelIds: mirror.deleteChannelIds,
            disappeared: mirror.disappeared, sig, at: Date.now()
          });
        }
      } else {
        await putMeta('sheetMirrorAlert:' + lib, null);
        await putMeta('sheetMirrorIgnoredSig:' + lib, null);
        await applySheetMirror(lib, mirror);
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
  // Each scrape is a full page fetch, one channel at a time, and this loop sits
  // between pct 12 and pct 30 — on a fresh library it can dominate the whole run.
  // Reporting per channel is what stops it from looking like a hang (v1.0.18).
  const LOGO_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
  let logoDone = 0;
  for (const lc of libChannels) {
    if (aborted()) return { ok: false, error: 'aborted' };
    const ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
    logoDone += 1;
    if (ch.logoUrl) continue;
    if (ch.logoTriedAt && Date.now() - ch.logoTriedAt < LOGO_RETRY_MS) continue;
    report('logos', 12 + Math.round((logoDone / Math.max(1, libChannels.length)) * 16),
      `מביאים תמונות ערוצים… ${logoDone}/${libChannels.length}`);
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
        // Up to BACKFILL_PAGE_BUDGET (40) network round-trips reported ONCE before
        // the loop used to read as a freeze; count the pages instead (v1.0.18).
        report('backfill', 45 + Math.round((backfillPages / BACKFILL_PAGE_BUDGET) * 20),
          `מושכים את כל הסרטונים… ${candidates.length}`);
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

  /* ---------- stage: source-channel enrichment (v1.0.12) ---------- */
  // Loose single links learn WHICH channel they came from, so 2+ from the same
  // channel can be grouped into one folder. Free: the channel rides along in the
  // same videos.list(snippet) call titles use (or in keyless oEmbed's author_url).
  // Bounded per run + weekly retry, and idempotent (only untried records).
  try {
    const SRC_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
    const need = [];
    for (const rec of (await loadMergeIndex(scope)).values()) {
      if (rec.state !== 'live' || rec.type !== 'youtube' || rec.channelId) continue;
      if ((rec.homeFolderId || rec.folderId) !== 'sheet') continue;
      if (rec.srcChannelId) continue;
      if (rec.srcChannelTriedAt && Date.now() - rec.srcChannelTriedAt < SRC_RETRY_MS) continue;
      need.push(rec.id);
      if (need.length >= 100) break; // ≤2 quota units per sync
    }
    if (need.length) {
      report('titles', 85, 'מזהים ערוצים של סרטונים…');
      const meta = await yt.fetchVideoMeta(need, key);
      for (const id of need) {
        const m = meta.get(id);
        await setVideoFields(scope, 'yt:' + id, {
          srcChannelId: (m && m.channelId) || null,
          srcChannelTitle: (m && m.channelTitle) || '',
          srcChannelTriedAt: Date.now()
        });
      }
    }
  } catch { /* enrichment is cosmetic — never break a sync over it */ }

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

  // v1.0.6: opportunistic sheet write-back — quiet no-op without a queue/token.
  // Reported BEFORE 'done': this is real network work, and announcing 100% while
  // it still runs is precisely what made the app look hung at the finish line.
  report('write', 95, 'רושמים בגיליון…');
  try {
    const { flushSheetQueue } = await import('./sheetwrite.js');
    await flushSheetQueue(profileId);
  } catch {}
  report('done', 100, '');

  // `ok` still means "the pipeline ran" — the cached library is intact either way.
  // `sheetError` is separate on purpose: the sync succeeded, but the SHEET was not
  // read, and the parent has to be told or they will never know it stopped syncing.
  return {
    ok: true, added: plan.newLiveKeys.length, pending: plan.pendingKeys.length,
    merged: plan.mergeReport.length, sheetError
  };
}

/**
 * v1.0.10: apply mirror deletions.
 * Videos: delete WITH a tombstone ('sheet-mirror') — a stale Drive doc from a
 * not-yet-synced device must not resurrect them; the tombstone is revoked the
 * moment the sheet lists the key again (unDenyKeys), so wrong reads self-heal.
 * Channels: unsubscribe + purge imported videos (raw — presence re-purges), then
 * ORPHAN GC: any leftover channel-content record whose channel is no longer
 * subscribed (e.g. resurrected by a Drive merge) is swept on every mirror pass.
 * Also used by the safety-valve "apply" button and the UI channel-remove flow.
 */
export async function applySheetMirror(lib, { deleteVideoKeys = [], deleteChannelIds = [] } = {}) {
  for (const key of deleteVideoKeys) {
    const rec = await getVideo(lib, key);
    if (rec && rec.channelId == null) await deleteVideo(lib, key, 'sheet-mirror');
  }
  for (const id of deleteChannelIds) await deleteLibraryChannel(lib, id);

  // orphan GC — one pass covers both the just-deleted channels and doc-resurrected dregs
  const subscribed = new Set((await listLibraryChannels(lib)).map((c) => c.channelId));
  for (const rec of (await loadMergeIndex(lib)).values()) {
    if (rec.channelId && !subscribed.has(rec.channelId)) await deleteVideoRaw(lib, rec.key);
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
  // v1.0.20: burn the baseline flag only if there was something to baseline. Adding a
  // channel runs a sync where EVERYTHING is still pending (in-app adds default to
  // approval-required), so liveRecords was empty — the flag got spent on nothing, and
  // the next sync took the incremental path and gifted every single approved video at
  // once (a "חדשים" folder with the whole backfill in it, and no gifts right after
  // the parent approved). An empty library has no "before I arrived" to record.
  if (shouldRecordGiftBaseline(firstSync, liveRecords.length)) await putMeta(flag, Date.now());
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
