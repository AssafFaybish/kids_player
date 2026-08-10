// sync2.js — the staged sync pipeline (replaces the old mirror-everything sync).
// RULE: the UI hydrates from IndexedDB instantly; this whole pipeline runs in the
// background and reports progress — it must NEVER block rendering, and a network
// failure at any stage leaves the cached library intact.
//
// Stages: sheet(+hash skip) → resolveChannels → rss (incremental, keyless) →
// backfill (budgeted, resumable, API) → playlists tab (budgeted, resumable, API) →
// planMutations (pure) → persist → titles (batched; persist twice) →
// gifts (per profile) → [pushDrive hook].
//
// A channel contributes its "Videos" tab and its "playlists" tab, and NOTHING else:
// Shorts and live streams are excluded (v1.0.21). See quota.longFormPlaylistIdFor.

import { prefGet } from './platform.js';
// v1.0.19: reads moved to the authenticated Sheets API, so the CSV-export fetch
// (httpGetText + resolveListUrl) and its HTML-error-page guard are gone from this
// path. parseCsv still backs parseSourceSheet, which is TEST-ONLY (no production
// caller) — see the note on that function.
import { parseCsv } from './csv.js';
import { parseSourceRows } from './linksfile.js';
import { fnv1a, libraryIdFor, mapWithConcurrency } from './util.js';
import {
  planMutations, planGifts, planSheetMirror, shouldRecordGiftBaseline, sheetBackedKeysOf,
  acceptRssEntry, acceptPlaylistItem, planPlaylistAdvance, planNoLongForm, planLongFormOutage,
  planChannelLogo, planSyncDispatch, playlistVideoFolder, planRejectedPurge,
  planOrphanGC, effectiveCaps, orphanSweepValve } from './plan.js';
import { pendingChannelDeletes, pendingAppendKeys, pendingDeleteKeys } from './sheetwrite.js';
import { normalizeTitle } from './normalize.js';
import { planChannelFetch, shouldThrottle, shortsPlaylistIdFor, planBackfillPlaylist } from './quota.js';
import { QUOTA_DAILY_SOFT_CAP, REJECTED_TTL_DAYS } from './config.js';
import * as yt from './yt.js';
import {
  getSources, putSources, getChannel, putChannel,
  listLibraryChannels, putLibraryChannel, deleteLibraryChannel,
  loadDenySet, loadMergeIndex, putVideos, setVideoFields, deleteVideoRaw, deleteVideo,
  getVideo, unDeny,
  putVideoStates, getMeta, putMeta, profScope, countFolder, pageFolder,
  getLogoFailedAt, setLogoFailedAt, pageRejected
} from './db.js';

const BACKFILL_PAGE_BUDGET = 40; // ~2000 videos per run; continues next launch
// v1.0.21 — the channel's "playlists" tab, walked AFTER its uploads backfill finishes.
// Its own budget so it can never starve the uploads pass (which is what the child
// actually sees) and can never surprise the daily quota. EVERY request in the stage —
// enumeration, the UUSH probe and the item pages alike — counts against
// PLAYLIST_PAGE_BUDGET, so that number IS the per-run ceiling in quota units.
const PLAYLIST_PAGE_BUDGET = 20;
const PLAYLIST_SOURCE_BUDGET = 20; // v1.0.26: pages per run for STANDALONE playlists
const PLAYLIST_LIST_PAGES = 2;  // ≤100 playlists per channel is plenty
const SHORTS_PAGE_CAP = 6;      // ≤300 known Shorts per channel, for filtering playlists

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
 * v1.0.38 — the row grammar MOVED to linksfile.js and is re-exported here so its existing
 * importers keep working. It had to move: this module's sheet stage and the whole sunset
 * migration are scheduled for deletion, and the grammar is not — the links file uses it.
 * A local import, not `export … from`: `parseSourceSheet` above calls it, and a bare
 * re-export creates no local binding.
 */
export { parseSourceRows };

const inFlight = new Map();   // profileId -> entry that is EXECUTING (has already read)
const queuedRuns = new Map(); // profileId -> entry waiting to start (has read NOTHING yet)

/** entry = { force, listeners:Set<onProgress>, promise } */
function newEntry(opts) {
  const entry = { force: !!opts.force, listeners: new Set(), promise: null };
  if (typeof opts.onProgress === 'function') entry.listeners.add(opts.onProgress);
  return entry;
}

/** Ride an existing run, and hear its progress while doing so. */
function attach(entry, opts) {
  if (typeof opts.onProgress === 'function') entry.listeners.add(opts.onProgress);
  return entry.promise;
}

function beginRun(profileId, entry, opts) {
  if (queuedRuns.get(profileId) === entry) queuedRuns.delete(profileId);
  inFlight.set(profileId, entry);
  // Progress fans out to EVERY caller this run serves. A joined caller used to lose its
  // onProgress entirely, so the add-a-channel loading screen sat frozen on its first step
  // for the whole run while the bar underneath it never moved.
  const fanOut = (p) => { for (const fn of entry.listeners) { try { fn(p); } catch {} } };
  return doSync(profileId, { ...opts, onProgress: fanOut })
    .finally(() => { if (inFlight.get(profileId) === entry) inFlight.delete(profileId); });
}

/**
 * One run per profile at a time. The join-or-queue decision is pure `planSyncDispatch`
 * (plan.js) — read its comment for the field bug: a forced caller must never ride a run
 * that has already read the library, and the launch sync is forced and slow, so that
 * collision was routine rather than rare.
 */
export function syncLibrary(profileId, opts = {}) {
  const running = inFlight.get(profileId) || null;
  const queued = queuedRuns.get(profileId) || null;
  const action = planSyncDispatch({ running: !!running, queued: !!queued, force: !!opts.force });

  if (action === 'join-running') return attach(running, opts);
  if (action === 'join-queued') return attach(queued, opts);

  const entry = newEntry(opts);
  if (action === 'queue') {
    // Registered as queued BEFORE the chain is built, so a second forced caller arriving
    // in the meantime joins this one instead of queueing a third full sweep.
    queuedRuns.set(profileId, entry);
    entry.promise = running.promise.catch(() => {}).then(() => beginRun(profileId, entry, opts));
    return entry.promise;
  }
  entry.promise = beginRun(profileId, entry, opts); // 'start'
  return entry.promise;
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
  let playlistRows = [];
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
      playlistRows = parsed.playlistRows || [];
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
        // v1.0.32: an explicit auto/manual column IS the sync decision — the row skips
        // the "ערוצים חדשים" section. A flagless row waits for the parent's answer.
        decidedAt: row.flag ? Date.now() : null,
        order: knownIds.size, addedAt: Date.now(), hidden: false, sourceRow: true,
        titleOverride: row.title || ''
      });
    } catch { /* one bad ref must not kill sync */ }
  }
  // v1.0.26 — playlist rows need no resolution: the id IS in the link.
  for (const row of playlistRows) {
    const plId = row.playlistId;
    if (!plId || knownIds.has(plId) || pendingDel.has(plId)) { sheetChannelIds.add(plId); continue; }
    sheetChannelIds.add(plId);
    knownIds.add(plId);
    await putLibraryChannel({
      libraryId: lib, channelId: plId, kind: 'playlist',
      autoApprove: row.flag === 'auto' ? true : row.flag === 'manual' ? false : !!src.defaultAutoApprove,
      autoApproveSource: row.flag ? 'sheet' : 'default',
      decidedAt: row.flag ? Date.now() : null, // v1.0.32 — same rule as channel rows above
      order: knownIds.size, addedAt: Date.now(), hidden: false, sourceRow: true,
      titleOverride: row.title || ''
    });
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
      // Read once and keep it CURRENT: the loop below writes tombstones, so a snapshot
      // goes stale against its own work. Two devices can each append a '# הוסר' row for
      // the same video (and youtu.be/X and watch?v=X are the same key), and removedKeys
      // is not deduplicated — without the add() the duplicate re-ran deleteVideo,
      // restamping the tombstone's `at` (the LWW tiebreaker) and pushing a second opLog
      // row to Drive. Reused below for planSheetMirror instead of a second full getAll.
      const denied = await loadDenySet(lib);
      for (const key of removedKeys) {
        if (denied.has(key) && !(await getVideo(lib, key))) continue;
        await deleteVideo(lib, key, 'sheet-removed');
        denied.add(key);
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
        deniedKeys: denied // kept current by the loop above — a second getAll read the same set
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

  // v1.0.26 — a standalone PLAYLIST is a subscription too, stored in the SAME table with
  // `kind:'playlist'` (no schema change, so it inherits Drive sync, deletion, the parent's
  // list and the auto-approve flag for free). Split them here so every channel stage below
  // — channels.list, the logo scrape, RSS, the UULF backfill — keeps seeing only real
  // channels. Those stages derive ids with `'UU' + id.slice(2)`, which is meaningless for
  // a PL id; quota.js already guards with /^UC/ and answers null, so the split is belt and
  // braces rather than the only line of defence.
  const allSubs = await listLibraryChannels(lib);
  const libChannels = allSubs.filter((c) => c.kind !== 'playlist');
  const libPlaylists = allSubs.filter((c) => c.kind === 'playlist');

  /* ---------- stage: orphan GC (v1.0.38 — UNCONDITIONAL) ---------- */
  // Sweeps content whose channel nobody subscribes to any more. It used to run only inside
  // the sheet mirror, i.e. only for a profile WITH a readable sheet — so a subscription
  // deleted on another device left its videos on this one forever (see gcOrphans). Placed
  // here, after the subscription list is known and before any fetch, so the stages below
  // never spend network on a channel that is about to be swept.
  report('gc', 10, 'מנקים תוכן של ערוצים שהוסרו…');
  try { await gcOrphans(lib); } catch { /* housekeeping must never take the sync down */ }

  // Channel metadata (title/logo/uploads) — one batched call for the missing ones.
  const needMeta = [];
  for (const lc of libChannels) {
    const ch = await getChannel(lc.channelId);
    // v1.0.24: the logo half of this condition is `planChannelLogo(...).api` — see the
    // helper for the two defects that made a missing avatar permanent.
    const failedAt = await getLogoFailedAt(lc.channelId);
    if (!ch || !ch.uploadsPlaylistId || (!ch.title && key)
      || planChannelLogo(ch, { hasKey: !!key, failedAt }).api) needMeta.push(lc.channelId);
  }
  if (needMeta.length) {
    const metaMap = await yt.fetchChannelMeta(needMeta, key);
    for (const [channelId, m] of metaMap) {
      const prev = (await getChannel(channelId)) || { channelId };
      // NEVER stamp a "we tried" marker for an attempt that did not happen: with no key
      // fetchChannelMeta answers with empty logos WITHOUT making a request, and the
      // page-scrape below is gated on `logoTriedAt` — which is how one keyless sync used
      // to suppress the working fallback for a week. `logoTriedAt` belongs to the scrape;
      // this path owns `logoApiTriedAt`, and only a real URL updates `logoFetchedAt`.
      const rec = {
        ...prev, channelId,
        title: m.title || prev.title || '',
        logoUrl: m.logoUrl || prev.logoUrl || '',
        uploadsPlaylistId: m.uploadsPlaylistId || prev.uploadsPlaylistId || null
      };
      if (key) rec.logoApiTriedAt = Date.now();
      if (m.logoUrl) rec.logoFetchedAt = Date.now();
      await putChannel(rec);
      // a fresh URL answers the recorded load failure; leaving it set would re-fetch forever
      if (m.logoUrl) await setLogoFailedAt(channelId, 0);
    }
  }

  // Logo fallback (v1.0.4): keyless mode (and API misses) left channels logo-less on
  // the tablet — folder tiles fell back to the 📺 emoji and read like videos. Scrape
  // the public channel page (0 quota), retry weekly so a transient failure heals.
  // Each scrape is a full page fetch, one channel at a time, and this loop sits
  // between pct 12 and pct 30 — on a fresh library it can dominate the whole run.
  // Reporting per channel is what stops it from looking like a hang (v1.0.18).
  let logoDone = 0;
  for (const lc of libChannels) {
    if (aborted()) return { ok: false, error: 'aborted' };
    const ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
    logoDone += 1;
    if (!planChannelLogo(ch, { failedAt: await getLogoFailedAt(lc.channelId) }).scrape) continue;
    report('logos', 12 + Math.round((logoDone / Math.max(1, libChannels.length)) * 16),
      `מביאים תמונות ערוצים… ${logoDone}/${libChannels.length}`);
    const logoUrl = await yt.scrapeChannelLogo(lc.channelId);
    // The scrape is the LAST resort, so it owns the weekly retry clock — stamped whether it
    // found anything or not. Re-read: the scrape is a full page fetch and other stages write
    // this same record while it runs, so the snapshot from before it is already stale.
    const fresh = (await getChannel(lc.channelId)) || ch;
    const rec = { ...fresh, logoUrl: logoUrl || fresh.logoUrl || '', logoTriedAt: Date.now() };
    if (logoUrl) rec.logoFetchedAt = Date.now();
    await putChannel(rec);
    if (logoUrl) await setLogoFailedAt(lc.channelId, 0);
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
  const longFormProbe = []; // [{channelId, notFound}] — fed to the outage valve below
  for (const r of rssResults) {
    if (!r.ok) continue;
    const { channelId, videos, backfill } = r.value;
    const lc = libChannels.find((c) => c.channelId === channelId);
    for (const v of videos) {
      // v1.0.21 — Shorts and live streams never enter a child's library. The RSS feed
      // interleaves all three kinds and carries no duration, but every entry's
      // `<link rel="alternate">` is `/shorts/…` vs `/watch?v=…` (ytrss.altLinkKind) —
      // free, keyless, and the only Shorts signal the INCREMENTAL path can have, since
      // the UULF playlist trick below only covers the backfill.
      if (!acceptRssEntry(v)) continue;
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
      // v1.0.21 — page the LONG-FORM playlist (UULF…), i.e. exactly the channel's
      // "Videos" tab: no Shorts, no live streams, at no extra quota cost. `resetCursor`
      // guards the upgrade: a token earned against UU… is meaningless against UULF….
      const { playlistId: longForm, resetCursor } = planBackfillPlaylist(ch);
      if (resetCursor) {
        ch = { ...ch, backfillCursor: null, backfillDone: false };
        await putChannel(ch);
      }
      let token = ch.backfillCursor || null;
      // playlistId null ⇒ no long-form id could be derived. Skipping is deliberate:
      // falling back to UU… would import the very Shorts we are excluding.
      while (longForm && backfillPages < BACKFILL_PAGE_BUDGET && !aborted()) {
        if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
        const page = await yt.fetchUploadsPage(longForm, token, key);
        backfillPages += 1;
        // A 404 on the FIRST page means the variant playlist does not exist — the channel
        // publishes no long-form video at all. Only a first-page 404 says that; a 404
        // deeper in, or any other error, must never close the backfill (planNoLongForm).
        // The decision is DEFERRED to after the loop, because a whole-population 404 is a
        // YouTube outage rather than a fact about the channels (planLongFormOutage).
        const verdict = planNoLongForm({ notFound: page.notFound, isFirstPage: !token, derived: true });
        if (verdict.closeBackfill) {
          longFormProbe.push({ channelId, notFound: true });
          break;
        }
        if (!page.error) longFormProbe.push({ channelId, notFound: false });
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
        // the playlist the cursor was earned against travels WITH it, so the next
        // release cannot resume a UULF token against some other playlist
        ch = { ...ch, backfillCursor: token, backfillDone: !token, backfillPlaylistId: longForm };
        await putChannel(ch); // cursor persisted per page — resumable across kills
        if (!token) break;
      }
    }
  }
  if (aborted()) return { ok: false, error: 'aborted' };

  // v1.0.21 — SAFETY VALVE for an undocumented dependency. A 404 from every channel at
  // once is YouTube retiring the UULF alias, not every channel becoming Shorts-only:
  // acting on it would close every backfill in every library in one sync and tell each
  // parent something false. Refuse to act; the next release can fix the mechanism.
  {
    const { outage } = planLongFormOutage(longFormProbe);
    for (const p of longFormProbe) {
      const ch = await getChannel(p.channelId);
      if (!ch) continue;
      if (p.notFound && !outage) {
        // genuinely Shorts-only: close the backfill and let the parent screen say so
        await putChannel({ ...ch, noLongForm: true, backfillCursor: null, backfillDone: true });
      } else if (!p.notFound && ch.noLongForm) {
        // long-form arrived after all (or the alias came back) — retract the note
        await putChannel({ ...ch, noLongForm: false });
      }
    }
    if (outage) console.warn('long-form playlist 404 for EVERY channel — treating as an outage, not closing backfills');
  }

  /* ---------- stage: the channel's PLAYLISTS tab (v1.0.21, budgeted + resumable) ---------- */
  if (key) {
    let plPages = 0;
    // The bar must MOVE across the stage's ~20 sequential requests. A constant pct is
    // the freeze the v1.0.18 backfill fix exists to prevent (a parent force-quits and
    // the in-progress cursor work is lost).
    const reportPl = (n) => report('backfill', 66 + Math.round((n / PLAYLIST_PAGE_BUDGET) * 4),
      `מוסיפים סרטונים מרשימות ההשמעה… ${candidates.length}`);
    for (const lc of libChannels) {
      if (plPages >= PLAYLIST_PAGE_BUDGET || aborted()) break;
      let ch = (await getChannel(lc.channelId)) || { channelId: lc.channelId };
      // uploads first: the Videos tab is what the child actually came for, and walking
      // playlists before it finishes would spend the budget on the redundant half.
      if (!ch.backfillDone || ch.playlistsDone) continue;

      // 1) the playlist LIST, once per channel (queue persisted → resumable). The
      //    ENUMERATION MUST BE COMPLETE before its emptiness may mean "done": an empty
      //    queue from a throttled or errored call used to persist playlistsDone=true and
      //    disable this source for the channel forever (nothing rearms it).
      if (!Array.isArray(ch.playlistQueue)) {
        const queue = [];
        let tok = null;
        let listComplete = false;
        for (let i = 0; i < PLAYLIST_LIST_PAGES; i += 1) {
          if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
          const r = await yt.fetchChannelPlaylists(lc.channelId, tok, key);
          plPages += 1;
          reportPl(plPages);
          if (r.error) break;
          for (const p of r.playlists) {
            // A playlist the channel itself calls "Shorts" is the one place a curated
            // list is guaranteed to be full of them — skip it by name, cheaply.
            if (/\bshorts?\b/i.test(p.title)) continue;
            queue.push(p.id);
          }
          tok = r.nextPageToken;
          if (!tok) { listComplete = true; break; }
          if (i === PLAYLIST_LIST_PAGES - 1) listComplete = true; // capped on purpose
        }
        if (!listComplete && !queue.length) continue; // retry the enumeration next run
        ch = { ...ch, playlistQueue: queue, ...planPlaylistAdvance({ playlistQueue: queue }, { listComplete }) };
        await putChannel(ch);
        if (ch.playlistsDone) continue;
      }

      // 2) the channel's own Shorts, so a Short sitting inside a curated playlist is
      //    still excluded. playlistItems exposes no Shorts flag, so UUSH membership is
      //    the only exact test. A 404 (no Shorts at all) is a REAL empty set and is
      //    cached; any other failure must NOT be, or one throttled page would memoize
      //    "no Shorts" and let a curated list import every one of them.
      let shortIds = null;
      const loadShortIds = async () => {
        if (shortIds) return shortIds;
        const found = new Set();
        let tok = null;
        let complete = false;
        for (let i = 0; i < SHORTS_PAGE_CAP; i += 1) {
          if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
          const r = await yt.fetchUploadsPage(shortsPlaylistIdFor(lc.channelId), tok, key);
          plPages += 1;
          reportPl(plPages);
          if (r.notFound) { complete = true; break; } // this channel has posted no Shorts
          if (r.error) break;                          // transient — do not cache
          for (const v of r.videos) found.add(v.videoId);
          tok = r.nextPageToken;
          if (!tok || i === SHORTS_PAGE_CAP - 1) { complete = true; break; }
        }
        if (complete || found.size) shortIds = found;
        return found;
      };

      // 3) walk one playlist at a time, resuming mid-playlist across runs
      while (ch.playlistQueue.length && plPages < PLAYLIST_PAGE_BUDGET && !aborted()) {
        if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
        const plId = ch.playlistQueue[0];
        const page = await yt.fetchUploadsPage(plId, ch.playlistCursor || null, key);
        plPages += 1;
        reportPl(plPages);
        if (page.error) { // a private/deleted playlist must not wedge the queue
          ch = { ...ch, ...planPlaylistAdvance(ch, { pageError: page.error }) };
          await putChannel(ch);
          continue;
        }
        const shorts = await loadShortIds();
        for (const v of page.videos) {
          // The child-safety boundary, as a tested predicate: own uploads only (a
          // curated playlist may hold other channels' videos), no known Shorts, and a
          // MISSING uploader is rejected — that is what private/deleted entries look
          // like, and they render as an untappable "Private video" tile.
          if (!acceptPlaylistItem(v, { channelId: lc.channelId, shortIds: shorts })) continue;
          candidates.push({
            scopeId: scope, key: 'yt:' + v.videoId, type: 'youtube', id: v.videoId,
            url: null, srcUrl: 'https://www.youtube.com/watch?v=' + v.videoId, driveId: null,
            title: v.title, titleSource: 'api', thumbUrl: v.thumbUrl || null,
            // the channel's own folder, NOT a folder per playlist (user decision): a
            // playlist is a SOURCE here. Duplicates with the Videos tab collapse in
            // planMutations, which keys on 'yt:<id>'.
            channelId: lc.channelId, folderId: 'ch:' + lc.channelId, origin: 'channel',
            publishedAt: v.publishedAt, rowIndex: null, autoApprove: !!lc.autoApprove
          });
        }
        ch = { ...ch, ...planPlaylistAdvance(ch, { nextPageToken: page.nextPageToken }) };
        await putChannel(ch); // resumable at page granularity, like the uploads cursor
      }
    }
  }
  if (aborted()) return { ok: false, error: 'aborted' };

  /* ---------- stage: standalone PLAYLISTS (v1.0.26) ----------
   * The parent pasted a playlist link. `playlistItems.list` pages ANY playlist, so this
   * reuses fetchUploadsPage — the same call the channel backfill makes, at the same 1 unit
   * per page. Its own budget so it can never starve the channel passes.
   *
   * Unlike the channel's own playlists tab (v1.0.21), FOREIGN VIDEOS ARE THE POINT here:
   * a curated playlist mixes creators, and dropping them would empty most playlists. And
   * Shorts cannot be told apart — there is no UUSH sibling for an arbitrary playlist — so
   * they are INCLUDED, per the standing rule that an unknown signal means include (a
   * wrongly hidden video is a bug the parent cannot explain; a leaked Short is cosmetic).
   */
  if (libPlaylists.length && key) {
    const subscribedChannelIds = new Set(libChannels.map((c) => c.channelId));
    // Titles/covers for playlists we have never named — one batched call, 1 unit.
    const needMeta = [];
    for (const lp of libPlaylists) {
      const rec = await getChannel(lp.channelId);
      if (!rec || !rec.title) needMeta.push(lp.channelId);
    }
    if (needMeta.length) {
      const metaMap = await yt.fetchPlaylistMeta(needMeta, key);
      for (const [plId, m] of metaMap) {
        const prev = (await getChannel(plId)) || { channelId: plId };
        await putChannel({
          ...prev, channelId: plId, kind: 'playlist',
          title: m.title || prev.title || '',
          logoUrl: m.logoUrl || prev.logoUrl || '',
          ownerChannelId: m.ownerChannelId || prev.ownerChannelId || '',
          playlistMissing: !!m.notFound,
          logoFetchedAt: m.logoUrl ? Date.now() : prev.logoFetchedAt
        });
      }
    }

    let plPages = 0;
    for (const lp of libPlaylists) {
      if (aborted()) return { ok: false, error: 'aborted' };
      let rec = (await getChannel(lp.channelId)) || { channelId: lp.channelId };
      if (rec.playlistMissing) continue;             // deleted or private — stop asking
      if (rec.backfillDone && Date.now() - (rec.lastRssCheckedAt || 0) < 30 * 60 * 1000 && !force) continue;
      let token = rec.backfillCursor || null;
      while (plPages < PLAYLIST_SOURCE_BUDGET && !aborted()) {
        if (shouldThrottle(await yt.quotaSpentToday(), 1, QUOTA_DAILY_SOFT_CAP)) break;
        const page = await yt.fetchUploadsPage(lp.channelId, token, key);
        plPages += 1;
        report('backfill', 60, `מושכים סרטונים מרשימת ההשמעה… ${candidates.length}`);
        if (page.notFound) {
          // Re-read: this loop makes network calls and other stages write the same record.
          await putChannel({ ...((await getChannel(lp.channelId)) || rec), playlistMissing: true });
          break;
        }
        if (page.error) break;
        for (const v of page.videos) {
          // Same gate as the channel stage, minus the owner check (foreign videos are
          // the POINT of a standalone playlist) and minus shortIds (no UUSH sibling
          // exists here): a malformed id or a MISSING owner is a private/deleted entry,
          // which used to reach the child as an untappable "Private video" tile.
          if (!acceptPlaylistItem(v, {})) continue;
          const folderId = playlistVideoFolder({
            ownerChannelId: v.ownerChannelId, playlistId: lp.channelId, subscribedChannelIds
          });
          candidates.push({
            scopeId: scope, key: 'yt:' + v.videoId, type: 'youtube', id: v.videoId,
            url: null, srcUrl: 'https://www.youtube.com/watch?v=' + v.videoId, driveId: null,
            title: v.title, titleSource: 'api', thumbUrl: v.thumbUrl || null,
            // channelId stays the OWNER even when the video sits in a playlist folder:
            // it is what the approval dialog and the title-dedupe index key on.
            channelId: v.ownerChannelId || null, folderId, origin: 'playlist',
            publishedAt: v.publishedAt, rowIndex: null, autoApprove: !!lp.autoApprove
          });
        }
        token = page.nextPageToken;
        rec = { ...((await getChannel(lp.channelId)) || rec), backfillCursor: token, backfillDone: !token, lastRssCheckedAt: Date.now() };
        await putChannel(rec);
        if (!token) break;
      }
    }
  }

  /* ---------- stage: expire the rejected archive (v1.0.26) ----------
   * A rejection is PARKED so the parent can undo it, which means the archive only grows —
   * and a channel re-offers its catalogue every 30 minutes, so it grows fast. After the
   * window the record is purged for real (delete + deny tombstone, the same thing
   * "מחק לצמיתות" does), which is also what stops the video returning on the next sync.
   *
   * Here rather than in the parent screen because it must happen whether or not anyone
   * opens that screen — and ONE place, so the two can never disagree about the deadline.
   * Both scopes: a rejection can be parked in the shared library or in the personal one.
   */
  try {
    for (const s2 of new Set([scope, profScope(profileId)])) {
      const { items } = await pageRejected(s2, { limit: 5000 });
      const { expired } = planRejectedPurge(items, { days: REJECTED_TTL_DAYS });
      for (const k of expired) await deleteVideo(s2, k, 'rejected-expired');
    }
  } catch { /* housekeeping must never take the sync down with it */ }

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
    // v1.0.37 — the caps come from config through effectiveCaps, NOT from `src` directly.
    // The stored fields froze at creation (5000), nothing could raise them, and a library
    // that reached the ceiling silently imported nothing from every new channel forever.
    caps: effectiveCaps(src)
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
    merged: plan.mergeReport.length, sheetError,
    // v1.0.37: the run's DROPS, attributed per source. Computed since the overhaul and
    // discarded here, which is why an import that dropped everything still reported a
    // bare success and the parent was told the channel was empty.
    drops: plan.drops
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

  await gcOrphans(lib);
}

/**
 * v1.0.38 — the orphan sweep, now its own function and a STAGE of every sync rather than a
 * consequence of a successful sheet parse.
 *
 * THE BUG THIS FIXES. `planOrphanGC` only ever ran inside `applySheetMirror`, gated on
 * `if (sheetParsed)` — so a profile with NO sheet never swept at all (the normal case since
 * v1.0.32, and the ONLY case after this release). When a peer deletes a subscription, the
 * v1.0.36 `deletedChannels` tombstone arrives over the Drive doc, `applyRemoteDoc` deletes
 * the row, and NOTHING deleted the videos: the child kept a folder full of a channel nobody
 * subscribes to, forever. `plan.groupLibraryByFolder` even has a branch for it ("an
 * unsubscribed leftover — group it, never lose it"), which is why nobody noticed.
 *
 * THE DECISION IS PURE (plan.planOrphanGC) because the inline one-liner it replaced deleted
 * every standalone-playlist video on every pass: a playlist video keeps its OWNER in
 * channelId, so membership must be judged by the FOLDER too.
 *
 * ONE sweep site (the v1.0.33 "one teardown path" rule) — do NOT add a second call inside
 * drive.js: the pull is followed by the sync in the same entryRefresh pipeline.
 * -> number swept (0 when the valve parked it)
 */
export async function gcOrphans(lib) {
  const index = await loadMergeIndex(lib);
  const records = [...index.values()];
  const orphans = planOrphanGC(records, await listLibraryChannels(lib));
  const live = records.filter((r) => r && r.state === 'live').length;
  const valve = orphanSweepValve({ orphanCount: orphans.length, liveTotal: live });
  if (!valve.sweep) {
    // Parked: record it for the sources tab and do nothing. Failing toward the old behaviour
    // is safe here in a way it is not for the sheet mirror — nobody but the parent's folder
    // list can tell the difference.
    if (valve.parked) await putMeta('gcAlert:' + lib, { count: valve.count, at: Date.now() });
    return 0;
  }
  await putMeta('gcAlert:' + lib, null);
  for (const key of orphans) await deleteVideoRaw(lib, key);
  return orphans.length;
}

/**
 * v1.0.38 — the parent removed a subscription (the channel half of applySheetMirror, which
 * is going away with the sheet). Unsubscribe — `db.deleteLibraryChannel` writes the v1.0.36
 * deletedChannels tombstone, which is what carries the removal to every device — then sweep
 * what it just orphaned.
 */
export async function removeSubscription(lib, channelId) {
  await deleteLibraryChannel(lib, channelId);
  return gcOrphans(lib);
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
