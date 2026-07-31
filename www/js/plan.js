// plan.js — the architectural centerpiece of sync: ONE pure function decides which
// records are written, merged, gifted, denied, or routed to parental approval.
// db.js only executes the returned plan. Everything here is node-tested; the single
// most important assertion in the suite is that running planMutations twice yields an
// EMPTY second diff (sync never churns the DB or re-gifts on every launch).

import { normalizeTitle, mergeVideoRecord } from './normalize.js';
import { sortKeyFor, compareForDisplay } from './order.js';

/** Fields that constitute "the record changed" (put emitted only when one differs). */
const DIFF_FIELDS = [
  'title', 'titleSource', 'normTitle', 'folderId', 'channelId', 'sortKey', 'state',
  'thumbUrl', 'thumbId', 'localPath', 'publishedAt', 'rowIndex', 'origin', 'url', 'srcUrl'
];
const changed = (a, b) => DIFF_FIELDS.some((f) => (a[f] ?? null) !== (b[f] ?? null));

/**
 * @param candidates  enriched candidate records for ONE scope:
 *   { scopeId,key,type,id,url,srcUrl,driveId, title,titleSource,thumbUrl,
 *     channelId,folderId,origin,publishedAt,rowIndex, autoApprove }
 * @param existing    Map<key, lightProjection> (db.loadMergeIndex)
 * @param denySet     Set<key> — tombstones; denied candidates are dropped, period.
 * @param caps        { maxPerChannel, maxTotal }
 * @param quarantine  first sync after migration: unknown keys arrive as 'pending'
 *                    regardless of autoApprove (legacy deletions are unrecoverable —
 *                    one bulk parent decision instead of silent resurrection).
 * @returns { puts, newLiveKeys, pendingKeys, mergeReport, counts }
 */
export function planMutations({ candidates, existing, denySet, now = Date.now(), caps = {}, quarantine = false }) {
  const maxPerChannel = caps.maxPerChannel || 500;
  const maxTotal = caps.maxTotal || 5000;

  const puts = new Map();          // key -> record
  const newLiveKeys = [];
  const pendingKeys = [];
  const mergeReport = [];
  const perChannel = new Map();
  let dropsDenied = 0;
  let dropsCapped = 0;

  // Title-dedupe index over EXISTING records: channelId -> normTitle -> key.
  // Scoped per channel only — cross-channel same-name videos are legitimate.
  const titleIndex = new Map();
  for (const [key, rec] of existing) {
    if (!rec.channelId || !rec.normTitle) continue;
    if (!titleIndex.has(rec.channelId)) titleIndex.set(rec.channelId, new Map());
    const m = titleIndex.get(rec.channelId);
    if (!m.has(rec.normTitle)) m.set(rec.normTitle, key);
  }
  // Reappearing merged-away links resolve to their survivor instead of resurrecting.
  const mergedFromIndex = new Map();
  for (const [key, rec] of existing) {
    for (const lost of rec.mergedFrom || []) mergedFromIndex.set(lost, key);
  }

  let total = existing.size;

  for (const c of candidates) {
    if (!c || !c.key) continue;
    const key = mergedFromIndex.get(c.key) || c.key;
    if (denySet.has(key) || denySet.has(c.key)) { dropsDenied += 1; continue; }

    const normTitle = normalizeTitle(c.title);
    const base = {
      scopeId: c.scopeId,
      key,
      type: c.type, id: c.id ?? null, url: c.url ?? null, srcUrl: c.srcUrl || '',
      driveId: c.driveId ?? null,
      title: c.title || '', normTitle, titleSource: c.title ? (c.titleSource || 'sheet') : null,
      folderId: c.folderId, channelId: c.channelId ?? null,
      sortKey: sortKeyFor(c),
      publishedAt: c.publishedAt ?? null, rowIndex: c.rowIndex ?? null,
      origin: c.origin,
      state: 'live',
      addedAt: now, approvedAt: null,
      thumbId: null, thumbUrl: c.thumbUrl || null, localPath: null,
      updatedAt: now
    };

    const prior = puts.get(key) || existing.get(key) || null;

    // Intra-channel title dedupe (only for channel/sheet content with a real title).
    let titleTwin = null;
    if (!prior && c.channelId && normTitle) {
      const twinKey = titleIndex.get(c.channelId)?.get(normTitle);
      if (twinKey && twinKey !== key) titleTwin = puts.get(twinKey) || existing.get(twinKey) || null;
    }

    if (titleTwin) {
      const merged = mergeVideoRecord({ ...titleTwin, scopeId: c.scopeId }, base);
      mergeReport.push({
        survivorKey: merged.key, survivorTitle: merged.title,
        mergedKeys: [key], channelId: c.channelId, normTitle
      });
      if (!existing.has(merged.key) || changed(existing.get(merged.key), merged)) puts.set(merged.key, merged);
      continue;
    }

    if (prior) {
      const merged = mergeVideoRecord({ ...prior, scopeId: c.scopeId, key }, base);
      // an existing record keeps its curation: a pending item stays pending (parked)
      if (prior.state === 'pending') {
        merged.state = 'pending';
        merged.homeFolderId = prior.homeFolderId || base.folderId;
        merged.folderId = '~pending';
      } else if (merged.folderId === '~pending') {
        merged.folderId = merged.homeFolderId || base.folderId; // approved elsewhere
      }
      if (!existing.has(key) || changed(existing.get(key), merged)) puts.set(key, merged);
      continue;
    }

    // Brand-new record: caps, then approval routing.
    const chCount = (perChannel.get(c.channelId) || 0);
    if (c.channelId && chCount >= maxPerChannel) { dropsCapped += 1; continue; }
    if (total >= maxTotal) { dropsCapped += 1; continue; }

    if (quarantine || !c.autoApprove) {
      // Pending records are PARKED in '~pending' so the kid-facing folder index
      // (by_folder_sort has no state component) can never surface them; approval
      // restores homeFolderId.
      base.state = 'pending';
      base.homeFolderId = base.folderId;
      base.folderId = '~pending';
      pendingKeys.push(key);
    } else {
      base.approvedAt = now;
      newLiveKeys.push(key);
    }
    puts.set(key, base);
    total += 1;
    if (c.channelId) perChannel.set(c.channelId, chCount + 1);
    if (c.channelId && normTitle) {
      if (!titleIndex.has(c.channelId)) titleIndex.set(c.channelId, new Map());
      titleIndex.get(c.channelId).set(normTitle, key);
    }
  }

  return {
    puts: [...puts.values()],
    newLiveKeys, pendingKeys, mergeReport,
    counts: { candidates: candidates.length, puts: puts.size, denied: dropsDenied, capped: dropsCapped }
  };
}

/**
 * Per-PROFILE gift planning (F9). Gift state lives in profileVideoState, not on the
 * shared video record — one child's unwrapping never affects a sibling.
 *
 * firstSync=true (baseline): only the newest `baseline` live records become gifts
 * (rank 1..N); every OTHER live record gets unwrappedAt so it can never gift later.
 * firstSync=false: every newly-live key without prior state becomes a gift.
 * An item with unwrappedAt anywhere NEVER receives a rank (tested invariant).
 * Ranks are gated on having some thumbnail (a gift must reveal a picture).
 */
export function planGifts({ profileId, liveRecords, newLiveKeys, existingStates, firstSync, baseline = 12, now = Date.now() }) {
  const statePuts = [];
  const stateOf = (key) => existingStates.get(key) || null;
  // A gift must reveal a picture. YouTube always has one (hqdefault is guaranteed) —
  // the key-prefix fallback keeps this true even over partial projections.
  const giftable = (r) => !!(r.thumbId || r.thumbUrl || r.type === 'youtube' || String(r.key).startsWith('yt:'));

  if (firstSync) {
    const sorted = liveRecords.slice().sort(compareForDisplay);
    let rank = 1;
    for (const r of sorted) {
      const st = stateOf(r.key);
      if (st && (st.unwrappedAt || st.giftRank)) continue; // never re-gift / re-rank
      if (rank <= baseline && giftable(r)) {
        statePuts.push({ profileId, key: r.key, giftRank: rank });
        rank += 1;
      } else {
        statePuts.push({ profileId, key: r.key, unwrappedAt: now });
      }
    }
    return statePuts;
  }

  let maxRank = 0;
  for (const st of existingStates.values()) if (st.giftRank) maxRank = Math.max(maxRank, st.giftRank);
  const byKey = new Map(liveRecords.map((r) => [r.key, r]));
  for (const key of newLiveKeys) {
    const st = stateOf(key);
    if (st && (st.unwrappedAt || st.giftRank)) continue;
    const rec = byKey.get(key);
    if (!rec || !giftable(rec)) continue;
    maxRank += 1;
    statePuts.push({ profileId, key, giftRank: maxRank });
  }
  return statePuts;
}


/**
 * v1.0.10 — PURE mirror planner, PRESENCE-based: the sheet is the single source of
 * truth in BOTH directions, judged fresh on EVERY successful parse (not as a diff
 * against a remembered baseline — a diff forgets, and content resurrected later by
 * a stale Drive-doc merge would silently stay forever).
 *
 *  - sheet-backed local videos missing from the sheet → delete (WITH tombstone: a
 *    stale Drive doc must not re-import them; the tombstone is revoked the moment
 *    the sheet lists the key again — self-healing both ways);
 *  - locally-denied keys PRESENT in the sheet → unDeny (a deliberate re-add wins),
 *    unless our own row-removal for that key is still queued (lag, not intent);
 *  - subscribed channels missing from the sheet → unsubscribe + purge;
 *  - SAFETY VALVE: too many deletions at once (truncated read / accidental range
 *    delete) parks everything behind a parent decision. Deliberately LOW pct:
 *    a parent's routine cleanup (≤10 rows) never asks.
 *
 * @param sheetBackedKeys   keys of LOCAL records that live in the shared 'sheet'
 *                          folder (rows are their only representation)
 * @param localChannelIds   currently subscribed channel ids (all of them)
 * @param currentVideoKeys  video keys parsed from the sheet NOW
 * @param currentChannelIds resolved channel ids in the sheet NOW
 * @param pendingAppendKeys queued-but-unflushed adds ('yt:…' / 'ch:<id>') — absence is lag
 * @param pendingDeleteKeys queued-but-unflushed removals — presence is lag
 * @param deniedKeys        locally ACTIVE denies (Set) — for re-add revival
 */
export function planSheetMirror({
  sheetBackedKeys = [], localChannelIds = [],
  currentVideoKeys = [], currentChannelIds = [],
  pendingAppendKeys = [], pendingDeleteKeys = [],
  deniedKeys = new Set(),
  valveMin = 10, valvePct = 0.05
} = {}) {
  const curV = new Set(currentVideoKeys);
  const curC = new Set(currentChannelIds);
  const pendingAdd = new Set(pendingAppendKeys);
  const pendingDel = new Set(pendingDeleteKeys);
  const denied = deniedKeys instanceof Set ? deniedKeys : new Set(deniedKeys || []);

  const deleteVideoKeys = sheetBackedKeys.filter((k) => !curV.has(k) && !pendingAdd.has(k));
  const deleteChannelIds = localChannelIds.filter((id) => !curC.has(id) && !pendingAdd.has('ch:' + id));
  const unDenyKeys = [...denied].filter((k) => curV.has(k) && !pendingDel.has(k));

  const localTotal = sheetBackedKeys.length + localChannelIds.length;
  const disappeared = deleteVideoKeys.length + deleteChannelIds.length;
  // v1.0.18: a TOTAL disappearance always asks, however small the library. The
  // >max(10, 5%) rule meant a child with ≤10 items — the common case for a
  // five-year-old — had their whole library wiped without the parent ever being
  // asked. Losing everything is exactly the case a safety valve exists for.
  const valve = localTotal > 0 &&
    (disappeared === localTotal || disappeared > Math.max(valveMin, Math.ceil(localTotal * valvePct)));

  return { deleteVideoKeys, deleteChannelIds, unDenyKeys, valve, disappeared, localTotal };
}

/**
 * PURE (extracted v1.0.20): which of a library's records does the SHEET account for?
 *
 * The presence-mirror deletes sheet-backed records the sheet no longer lists, so this
 * filter is a safety boundary, not a convenience:
 *  - `state === 'live'` — a PENDING share is parked with `homeFolderId:'sheet'` but gets
 *    its row only at APPROVAL. Including it tombstones the share before the parent has
 *    even seen the request (a real bug, caught in the v1.0.10 audit).
 *  - the folder test reads `homeFolderId` FIRST, because a parked record's `folderId` is
 *    '~pending' and its real home is the field behind it.
 * Channel videos are deliberately absent: they have no row of their own (the channel row
 * represents them), so the sheet can never "not list" them.
 */
export function isSheetBacked(r) {
  if (!r || r.state !== 'live') return false;
  return (r.homeFolderId || r.folderId) === 'sheet';
}

/** Keys of the sheet-backed records in `records`. Same boundary, list form. */
export function sheetBackedKeysOf(records) {
  const out = [];
  for (const r of records || []) if (isSheetBacked(r)) out.push(r.key);
  return out;
}

/**
 * PURE (extracted v1.0.20): what should connecting/changing a sheet do to the old scope?
 *
 * `lib:<fnv1a(sheet)>` is SHARED by every profile reading that sheet, and `moveScope`
 * MOVES — it deletes the source. So migrating one child's library while a sibling still
 * points at the old scope carried the whole family library away: a blank home for the
 * sibling and their pending shares surfacing in this child's approval list.
 *
 * @param others [{ profileId, libraryId }] — the OTHER profiles' sources
 * @returns { action: 'none'|'move', sharedWith: string[] }
 */
export function planScopeAdoption(profileId, oldLib, newLib, others = []) {
  if (!oldLib || !newLib || oldLib === newLib) return { action: 'none', sharedWith: [] };
  const sharedWith = [];
  for (const o of others || []) {
    if (!o || o.profileId === profileId) continue;
    if (o.libraryId && o.libraryId === oldLib) sharedWith.push(o.profileId);
  }
  // Someone else still lives there: the content is sheet-derived from the OLD sheet and
  // stays with the profiles still reading it. This profile just starts from its new one.
  if (sharedWith.length) return { action: 'none', sharedWith };
  return { action: 'move', sharedWith: [] };
}

/**
 * v1.0.20 — PURE: may this sync spend the "gifts baselined" flag?
 *
 * The baseline records what already existed before a child started, so the newest 12
 * become gifts and the rest never do. Spending the flag on an EMPTY library is a bug
 * with two visible halves: adding a channel runs a sync where every candidate is still
 * pending (in-app adds require approval), so nothing is live yet — and then approving
 * produced no gifts at all, while the sync after that took the incremental path and
 * gifted the ENTIRE backfill at once.
 */
export function shouldRecordGiftBaseline(firstSync, liveCount) {
  return !!firstSync && Number(liveCount || 0) > 0;
}

/**
 * v1.0.20 — PURE: repair a 🎁 folder that the burned-baseline bug inflated.
 *
 * On devices that added a channel before the fix, the baseline flag was spent on an
 * empty library and the next sync gifted the ENTIRE backfill: a "חדשים" folder holding
 * the whole library, which the child would have to tap through one by one. This decides
 * the repair — keep the `baseline` NEWEST, retire the rest — which is exactly the state
 * the first sync should have produced.
 *
 * ⚠️ RANK IS NOT RECENCY on the piles this repairs. `planGifts` sorts by
 * `compareForDisplay` only on its BASELINE branch; the INCREMENTAL branch (the one that
 * actually creates a runaway) stamps `maxRank+1` while walking `newLiveKeys`, which comes
 * from `loadMergeIndex` — a cursor over the `[scopeId, key]` primary key, i.e. ALPHABETICAL
 * by video id. Ranking by giftRank therefore kept an arbitrary alphabetical dozen and
 * retired the genuinely newest videos, permanently (`unwrappedAt` is min-merged forever).
 * So the caller passes `sortKeyOf`; giftRank is only the tie-break / last-resort fallback.
 *
 * Deliberately conservative: a child who simply never opens gifts accumulates ranks
 * legitimately, so only an implausible pile is touched.
 *
 * @param states iterable of profileVideoState records for ONE profile
 * @param sortKeyOf Map|function key -> sortKey (the video's own recency). Omit only when
 *                  the records are unavailable; ordering then degrades to giftRank.
 * @returns { keep: string[], retire: string[] } — retire = give up its rank
 */
export function planGiftRunawayRepair(states, { baseline = 12, floor = 60, sortKeyOf = null } = {}) {
  const ranked = [];
  for (const st of states || []) if (st && st.giftRank && !st.unwrappedAt) ranked.push(st);
  if (ranked.length <= Math.max(floor, baseline)) return { keep: [], retire: [] };
  const recency = sortKeyOf == null ? null
    : typeof sortKeyOf === 'function' ? sortKeyOf
      : (k) => (sortKeyOf.get ? sortKeyOf.get(k) : sortKeyOf[k]);
  ranked.sort((a, b) => {
    if (recency) {
      const ra = Number(recency(a.key));
      const rb = Number(recency(b.key));
      const fa = Number.isFinite(ra);
      const fb = Number.isFinite(rb);
      // a record we can date always outranks one we cannot — never retire a video
      // just because its sortKey went missing
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && rb !== ra) return rb - ra; // newest first
    }
    return a.giftRank - b.giftRank;
  });
  return {
    keep: ranked.slice(0, baseline).map((s) => s.key),
    retire: ranked.slice(baseline).map((s) => s.key)
  };
}

/** Folder ids that are just "everything loose" — no identity of their own. */
const FLAT_FOLDER_IDS = new Set(['sheet', 'mine']);

/**
 * v1.0.20 — PURE: may the home render its ONE folder's videos flat, with no tile?
 *
 * The rule exists for the sheet-only setup: when the only folder is the shared
 * "סרטונים נוספים" list, making the child tap into it first is a pointless step, so
 * the home shows the videos directly.
 *
 * FIELD BUG it fixes: the old test was "exactly one folder, whatever it is", so a
 * library whose only content was ONE subscribed channel flattened too — the parent
 * added a channel and got a 100-page flat wall of its backfill instead of the 📺
 * folder with the channel's logo, which is the whole point of subscribing. A channel
 * (or a 🎞️ collection) has an IDENTITY the child navigates by; it always gets a tile.
 *
 * @param folders the built folder list (`{ id, isNew }` is all this needs)
 */
export function shouldFlattenHome(folders) {
  const list = Array.isArray(folders) ? folders : [];
  if (list.length !== 1) return false;
  const only = list[0];
  // 🎁 "חדשים" is a view over other folders' videos, never the home in its own right
  if (!only || only.isNew) return false;
  return FLAT_FOLDER_IDS.has(only.id);
}

/**
 * v1.0.12 — PURE: group loose single links by their SOURCE channel.
 * Singles (manual adds / sheet rows / shares — records with no channelId) that come
 * from the same YouTube channel are collected into one virtual folder so the child's
 * home stays tidy; a channel with only ONE single stays in the flat list, which also
 * means deleting down to one video un-groups it automatically (no migration).
 *
 * A single whose channel is ALREADY subscribed is NOT grouped separately (user
 * decision): its id is returned under `absorb` so the UI can show it inside that
 * channel's existing folder — one folder per channel, never two with the same name.
 *
 * @param singles      [{ key, srcChannelId, srcChannelTitle }] — live, sheet-folder records
 * @param subscribedChannelIds Set/array of channel ids the library subscribes to
 * @param min          how many singles make a group (2 = "a pair or more")
 * @returns { groups: [{ channelId, title, keys }], absorb: Map<channelId, keys[]>, loose: keys[] }
 */
export function groupSinglesByChannel(singles, subscribedChannelIds = [], min = 2) {
  const subscribed = subscribedChannelIds instanceof Set
    ? subscribedChannelIds : new Set(subscribedChannelIds || []);
  const byChannel = new Map();
  const loose = [];
  for (const s of singles || []) {
    if (!s || !s.key) continue;
    if (!s.srcChannelId) { loose.push(s.key); continue; }
    if (!byChannel.has(s.srcChannelId)) byChannel.set(s.srcChannelId, []);
    byChannel.get(s.srcChannelId).push(s);
  }
  const groups = [];
  const absorb = new Map();
  for (const [channelId, list] of byChannel) {
    if (subscribed.has(channelId)) { absorb.set(channelId, list.map((s) => s.key)); continue; }
    if (list.length >= min) {
      const titled = list.find((s) => s.srcChannelTitle);
      groups.push({
        channelId,
        title: (titled && titled.srcChannelTitle) || 'ערוץ',
        keys: list.map((s) => s.key)
      });
    } else {
      for (const s of list) loose.push(s.key);
    }
  }
  groups.sort((a, b) => (b.keys.length - a.keys.length) || (a.channelId < b.channelId ? -1 : 1));
  return { groups, absorb, loose };
}
