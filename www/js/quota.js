// quota.js — YouTube Data API quota discipline. Pure, node-tested.
// THE rule: never call search.list (100 units). Everything here costs 1 unit/call.

/** Split ids into API-batch chunks (videos.list / channels.list take up to 50). */
export function batchIds(ids, size = 50) {
  const uniq = [...new Set(ids)];
  const out = [];
  for (let i = 0; i < uniq.length; i += size) out.push(uniq.slice(i, i + size));
  return out;
}

/**
 * Predicted unit cost of a sync plan — pinned by an executable assertion in tests
 * (10 channels × 500 videos === 111).
 */
export function quotaCostFor({ handleResolves = 0, channelBatches = 0, backfillPages = 0, titleBatches = 0 } = {}) {
  return handleResolves + channelBatches + backfillPages + titleBatches;
}

export function shouldThrottle(spentToday, planned, softCap = 8000) {
  return spentToday + planned > softCap;
}

/** Uploads playlist derived from the channel id — verified against the API when a key exists. */
export function uploadsPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UU' + channelId.slice(2) : null;
}

/**
 * What to do for one channel this run. Truth table (tested):
 *   no uploadsPlaylistId              -> resolve
 *   !backfillDone && hasKey           -> backfill (resume from cursor)
 *   !backfillDone && !hasKey          -> rss
 *   backfillDone && rss stale (>30m)  -> rss
 *   else                              -> skip
 */
export function planChannelFetch(channel, now = Date.now(), hasKey = false) {
  if (!channel.uploadsPlaylistId) return 'resolve';
  if (!channel.backfillDone) return hasKey ? 'backfill' : 'rss';
  if (now - (channel.lastRssCheckedAt || 0) > 30 * 60 * 1000) return 'rss';
  return 'skip';
}
