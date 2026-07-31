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
export function quotaCostFor({
  handleResolves = 0, channelBatches = 0, backfillPages = 0, titleBatches = 0,
  playlistPages = 0 // v1.0.21: the playlists tab — enumeration + item pages + UUSH probe
} = {}) {
  return handleResolves + channelBatches + backfillPages + titleBatches + playlistPages;
}

export function shouldThrottle(spentToday, planned, softCap = 8000) {
  return spentToday + planned > softCap;
}

/** Uploads playlist derived from the channel id — verified against the API when a key exists. */
export function uploadsPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UU' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — the channel's LONG-FORM uploads playlist: exactly its "Videos" tab.
 *
 * YouTube auto-generates sibling playlists next to `UU…` (all uploads), addressable by
 * swapping the prefix: `UULF…` long-form only, `UUSH…` Shorts only, `UULV…` live. This
 * is how Shorts and live streams are kept out of a child's library, and it costs NOTHING
 * — it is the same `playlistItems.list` call against a different id.
 *
 * ⚠️ UNDOCUMENTED by Google (community-discovered; measured 2026-07-31 on Cocomelon,
 * Blippi and Super Simple Songs: `UULF ∪ UUSH = UU` exactly, no overlap, no leftovers).
 * Two consequences the callers must honour:
 *  - a variant playlist DOES NOT EXIST when the channel has no content of that type, so
 *    a Shorts-only channel answers `404 playlistNotFound`. That is information, not an
 *    error — see sync2's backfill stage.
 *  - the ONLY reliable filter is which playlist a video is in. There is no `isShort`
 *    field anywhere in the Data API, and DURATION IS NOT A SUBSTITUTE: a Short is
 *    "≤3 minutes AND square-or-taller", the API cannot see aspect ratio, and ~30% of
 *    recent Super Simple Songs / Cocomelon LONG-FORM uploads are under 3 minutes. A
 *    length rule would delete real nursery rhymes. Never add one.
 */
export function longFormPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UULF' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — the channel's SHORTS-only playlist (sibling of the above). Not used to
 * import anything: it is read to build the exclusion set for the "playlists" tab, where
 * `playlistItems` exposes no Shorts flag and membership is the only exact test.
 * 404s (via `fetchUploadsPage(...).notFound`) when the channel has posted no Shorts.
 */
export function shortsPlaylistIdFor(channelId) {
  return /^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || '')) ? 'UUSH' + channelId.slice(2) : null;
}

/**
 * v1.0.21 — PURE: which playlist does this channel's backfill page, and is the persisted
 * cursor still valid for it?
 *
 * TWO bugs this closes:
 *  - `backfillCursor` is a POSITIONAL page token that belongs to ONE playlist. A device
 *    upgrading mid-backfill held a `UU…` token; reusing it against `UULF…` either
 *    resumed at a meaningless offset (silently skipping a slice of the back catalogue
 *    and then latching backfillDone) or was rejected, writing the bad token back so the
 *    channel returned 'backfill' forever and never delivered another video. The playlist
 *    the cursor was earned against is therefore recorded alongside it, and a mismatch
 *    RESETS the cursor instead of trusting it.
 *  - falling back to `UU…` when no long-form id can be derived would import the very
 *    Shorts this release exists to exclude. `playlistId: null` means SKIP, and the caller
 *    must honour it — never substitute the uploads playlist.
 *
 * @returns { playlistId, resetCursor } — playlistId null ⇒ do not backfill this channel
 */
export function planBackfillPlaylist(channel = {}) {
  const playlistId = longFormPlaylistIdFor(channel.channelId);
  if (!playlistId) return { playlistId: null, resetCursor: false };
  const earnedOn = channel.backfillPlaylistId || null;
  const hasCursor = !!channel.backfillCursor;
  return { playlistId, resetCursor: hasCursor && earnedOn !== playlistId };
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
