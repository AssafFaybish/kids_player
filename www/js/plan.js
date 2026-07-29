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
      // an existing record keeps its curation: state/addedAt/approvedAt/localPath win
      merged.state = prior.state === 'pending' && base.state === 'live' && prior.origin !== undefined
        ? prior.state : merged.state;
      if (!existing.has(key) || changed(existing.get(key), merged)) puts.set(key, merged);
      continue;
    }

    // Brand-new record: caps, then approval routing.
    const chCount = (perChannel.get(c.channelId) || 0);
    if (c.channelId && chCount >= maxPerChannel) { dropsCapped += 1; continue; }
    if (total >= maxTotal) { dropsCapped += 1; continue; }

    if (quarantine || !c.autoApprove) {
      base.state = 'pending';
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
  const giftable = (r) => !!(r.thumbId || r.thumbUrl || r.type === 'youtube');

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
