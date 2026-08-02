// yt.js — YouTube Data API v3 client + keyless fallbacks. Every call costs 1 unit
// (search.list is BANNED at 100). The API key resolves parent-override → baked-in
// default → '' (keyless mode: RSS + oEmbed + HTML handle-scrape still work).

import { httpRequest, httpGetText, prefGet } from './platform.js';
import { defaultYtApiKey } from './keys.js';
import { batchIds, uploadsPlaylistIdFor } from './quota.js';
import { getMeta, patchMeta } from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';

export async function getApiKey() {
  const override = await prefGet('yt:apiKey');
  if (override && override.trim()) return override.trim();
  return defaultYtApiKey();
}

/* ---------------- quota ledger (soft cap guard) ---------------- */
const dayKey = () => 'quota:' + new Date().toISOString().slice(0, 10);
export async function quotaSpentToday() { return (await getMeta(dayKey())) || 0; }
async function spend(units) {
  const k = dayKey();
  const cur = (await getMeta(k)) || 0;
  await patchMeta(k, undefined); // ensure record exists via putMeta below
  const { putMeta } = await import('./db.js');
  await putMeta(k, cur + units);
}

async function apiGet(path, params, key) {
  const q = new URLSearchParams({ ...params, key }).toString();
  const res = await httpRequest({ url: `${API}/${path}?${q}`, responseType: 'json' });
  await spend(1);
  if (res.status === 403) {
    const reason = JSON.stringify(res.data || '');
    const state = /quota/i.test(reason) ? 'quota' : 'invalid';
    const { prefSet } = await import('./platform.js');
    await prefSet('yt:apiKeyState', state);
    return { error: state };
  }
  if (res.status !== 200 || !res.data) return { error: 'http-' + res.status };
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return { data };
}

/* ---------------- handle / custom-url resolution ---------------- */

/**
 * The public channel page a ref resolves through when keyless. Pure, so the ENCODING
 * is test-pinned: a non-ASCII handle (`@חלומותחסידיים` — a real channel a parent tried
 * to add, v1.0.20) must be percent-encoded exactly ONCE and keep its literal '@'.
 * Note `encodeURI` also escapes '%', which is why parseChannelRef stores the DECODED
 * handle — feeding it `%D7%97…` here would produce `%25D7%2597…` and a 404.
 * Returns null for `by:'id'` (nothing to resolve) and for junk.
 */
export function channelPageUrl(ref) {
  const by = ref && ref.by;
  const value = String((ref && ref.value) || '');
  if (!value) return null;
  const path = by === 'handle' ? '@' + value
    : by === 'user' ? 'user/' + value
      : by === 'custom' ? 'c/' + value : null;
  return path ? 'https://www.youtube.com/' + encodeURI(path) : null;
}

/** handle -> channelId, cached FOREVER in meta (forHandle is not batchable). */
/**
 * PURE (v1.0.28) — the channel id out of a public channel page, ANCHORED matches only.
 *
 * FIELD BUG (@RabbiRosenblum): current channel pages no longer carry the
 * `"channelId":"UC…"` shape at all, so the old scrape fell to its second pattern —
 * the FIRST `channel/UC…` anywhere in ~1.2MB of HTML — and that is not necessarily
 * this channel (measured: a decoy UC id appears BEFORE the real one). The wrong id
 * was then cached forever, so the subscription was permanently empty ("הערוץ נוסף,
 * אבל אין בו סרטונים") — or worse, could have been someone else's channel entirely,
 * which for THIS app is a safety hole, not a cosmetic one.
 *
 * Only shapes that name THIS page's identity may match: `externalId` (present today),
 * the canonical link, and the legacy `channelId` (older cached pages). NO bare-UC
 * fallback — a resolve that occasionally fails beats one that occasionally answers
 * with a stranger's channel.
 */
export function extractChannelIdFromHtml(html) {
  const s = String(html || '');
  const m = s.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/)
    || s.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/)
    || s.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  return m ? m[1] : '';
}

export async function resolveChannelRef(ref, key) {
  if (ref.by === 'id') return ref.value;
  const cacheKey = 'handleMap';
  const map = (await getMeta(cacheKey)) || {};
  const ck = ref.by + ':' + ref.value.toLowerCase();

  // v1.0.29: a KEYLESS caller (per-video enrichment, `resolveChannelRef(ref, '')`) trusts
  // the cache first — it runs N times per sync and must not scrape the channel page N
  // times, and a slightly stale id there only affects GROUPING, never what reaches the
  // child. A KEYED caller (every ADD path) skips this: for it the cache is the LAST
  // resort, below both live resolutions, so a poisoned entry cannot survive the fix.
  if (!key && map[ck]) return map[ck];

  let channelId = null;
  if (key) {
    const params = { part: 'id' };
    if (ref.by === 'handle') params.forHandle = ref.value;
    else if (ref.by === 'user') params.forUsername = ref.value;
    if (params.forHandle || params.forUsername) {
      const r = await apiGet('channels', params, key);
      channelId = r.data?.items?.[0]?.id || null;
    }
  }
  // LIVE SCRAPE BEFORE THE CACHE (v1.0.29). v1.0.28 healed a poisoned entry only when the
  // API succeeded — but the built-in key's quota is SHARED by every family, so an
  // exhausted afternoon left `channelId` null and the old code then returned the poisoned
  // cache WITHOUT trying the scrape. The anchored extractor resolves the real id keylessly
  // (@BARDAK613: the page's own `"channelId"` is a DECOY, the real id is in `externalId`),
  // so scraping before the cache makes healing independent of the shared key's quota.
  if (!channelId) {
    // Keyless too (and /c/ custom URLs the API can't resolve). Zero quota; CORS-free.
    try {
      channelId = extractChannelIdFromHtml(await httpGetText(channelPageUrl(ref))) || null;
    } catch { channelId = null; }
  }
  // The cache is the offline last resort — only when BOTH live paths failed.
  if (!channelId) return map[ck] || null;

  if (map[ck] !== channelId) {
    map[ck] = channelId;
    const { putMeta } = await import('./db.js');
    await putMeta(cacheKey, map);
  }
  return channelId;
}

/* ---------------- channel metadata (batched, 1 unit per ≤50) ---------------- */

/** -> Map<channelId, {title, logoUrl, uploadsPlaylistId}> */
export async function fetchChannelMeta(channelIds, key) {
  const out = new Map();
  if (!key || !channelIds.length) {
    for (const id of channelIds) out.set(id, { title: '', logoUrl: '', uploadsPlaylistId: uploadsPlaylistIdFor(id) });
    return out;
  }
  for (const batch of batchIds(channelIds, 50)) {
    const r = await apiGet('channels', { part: 'snippet,contentDetails', id: batch.join(','), maxResults: 50 }, key);
    for (const item of r.data?.items || []) {
      const th = item.snippet?.thumbnails || {};
      out.set(item.id, {
        title: item.snippet?.title || '',
        logoUrl: (th.medium || th.default || th.high || {}).url || '',
        uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || uploadsPlaylistIdFor(item.id)
      });
    }
    if (r.error) for (const id of batch) if (!out.has(id)) out.set(id, { title: '', logoUrl: '', uploadsPlaylistId: uploadsPlaylistIdFor(id) });
  }
  return out;
}

/**
 * v1.0.26 — a standalone PLAYLIST's own title and cover, so its folder tile looks like a
 * channel's instead of an opaque `PL…` id. One `playlists.list` call, 1 quota unit, and
 * only ever for playlists the app has no title for yet.
 *
 * `notFound` is information, exactly as it is for `fetchUploadsPage`: a playlist that was
 * deleted or made private answers 404, and the parent should be told that rather than
 * watching an empty folder forever.
 */
export async function fetchPlaylistMeta(playlistIds, key) {
  const out = new Map();
  const ids = (playlistIds || []).filter(Boolean);
  if (!key || !ids.length) return out;
  for (const batch of batchIds(ids, 50)) {
    const r = await apiGet('playlists', { part: 'snippet', id: batch.join(','), maxResults: 50 }, key);
    for (const item of r.data?.items || []) {
      const th = item.snippet?.thumbnails || {};
      out.set(item.id, {
        title: item.snippet?.title || '',
        logoUrl: (th.medium || th.high || th.default || {}).url || '',
        ownerChannelId: item.snippet?.channelId || '',
        notFound: false
      });
    }
    // Anything the API did not return in a SUCCESSFUL response is gone (deleted/private).
    if (!r.error) for (const id of batch) if (!out.has(id)) out.set(id, { title: '', logoUrl: '', ownerChannelId: '', notFound: true });
  }
  return out;
}

/**
 * Keyless channel-logo fallback (v1.0.4): the avatar URL is not derivable from the
 * channelId, but the public channel page carries it as og:image. Zero quota;
 * CapacitorHttp is CORS-free on device, /__proxy covers the browser preview.
 * The extraction itself is pure and node-tested in ytrss.js.
 */
export async function scrapeChannelLogo(channelId) {
  try {
    const { extractChannelLogoFromHtml } = await import('./ytrss.js');
    return extractChannelLogoFromHtml(await httpGetText(`https://www.youtube.com/channel/${channelId}`));
  } catch { return ''; }
}

/* ---------------- uploads backfill (resumable) ---------------- */

/**
 * One PAGE of a channel's uploads playlist. Titles + thumbs + TRUE publish time
 * (contentDetails.videoPublishedAt — snippet.publishedAt is playlist-insert time)
 * ride along, so videos.list is never needed for channel content.
 * -> { videos: [{videoId,title,publishedAt,thumbUrl}], nextPageToken, error? }
 */
export async function fetchUploadsPage(uploadsPlaylistId, pageToken, key) {
  const params = { part: 'snippet,contentDetails', playlistId: uploadsPlaylistId, maxResults: 50 };
  if (pageToken) params.pageToken = pageToken;
  const r = await apiGet('playlistItems', params, key);
  // v1.0.21: a 404 on a DERIVED playlist (UULF…) is information, not a failure — the
  // variant does not exist when the channel has no content of that type. Told apart
  // from a real error so the caller can react instead of retrying forever.
  if (r.error) return { videos: [], nextPageToken: null, error: r.error, notFound: r.error === 'http-404' };
  const videos = [];
  for (const item of r.data?.items || []) {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) continue;
    const th = item.snippet?.thumbnails || {};
    videos.push({
      videoId,
      title: item.snippet?.title || '',
      publishedAt: Date.parse(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '') || 0,
      thumbUrl: (th.standard || th.medium || th.high || th.default || {}).url || '',
      // v1.0.21 — who UPLOADED it. Identical to the channel for its own uploads, but a
      // curated playlist can hold other channels' videos, and those must not enter a
      // library the parent built by subscribing to THIS channel.
      ownerChannelId: item.snippet?.videoOwnerChannelId || ''
    });
  }
  return { videos, nextPageToken: r.data?.nextPageToken || null };
}

/**
 * v1.0.21 — the channel's own PLAYLISTS ("playlists" tab). 1 unit/page, 50 per page.
 * `channelId` restricts the result to playlists that channel CREATED (not ones it
 * merely saved), so this cannot pull in a stranger's list wholesale.
 * -> { playlists: [{ id, title, itemCount }], nextPageToken, error? }
 */
export async function fetchChannelPlaylists(channelId, pageToken, key) {
  const params = { part: 'snippet,contentDetails', channelId, maxResults: 50 };
  if (pageToken) params.pageToken = pageToken;
  const r = await apiGet('playlists', params, key);
  if (r.error) return { playlists: [], nextPageToken: null, error: r.error };
  const playlists = [];
  for (const item of r.data?.items || []) {
    if (!item || typeof item.id !== 'string' || !item.id) continue;
    playlists.push({
      id: item.id,
      title: item.snippet?.title || '',
      // NOT a pagination oracle: itemCount counts Shorts and private/deleted entries
      // that playlistItems.list will never hand back.
      itemCount: Number(item.contentDetails?.itemCount) || 0
    });
  }
  return { playlists, nextPageToken: r.data?.nextPageToken || null };
}

/* ---------------- RSS incremental (keyless, 0 quota) ---------------- */

export async function fetchChannelRss(channelId) {
  try {
    const xml = await httpGetText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const { parseYouTubeRss } = await import('./ytrss.js');
    return parseYouTubeRss(xml);
  } catch { return []; }
}

/* ---------------- loose-link titles (batched with key, oEmbed without) ---------------- */

/**
 * v1.0.12 — ids -> Map<id, {title, channelId, channelTitle}>. The channel of a
 * loose link comes FOR FREE: videos.list(part=snippet) already carries channelId
 * and channelTitle (1 unit per 50, the same call titles use), and keyless oEmbed
 * carries author_name + author_url. Used to group singles of the same channel.
 */
export async function fetchVideoMeta(ids, key) {
  const out = new Map();
  if (!ids.length) return out;
  if (key) {
    for (const batch of batchIds(ids, 50)) {
      const r = await apiGet('videos', { part: 'snippet', id: batch.join(','), maxResults: 50 }, key);
      for (const item of r.data?.items || []) {
        const sn = item.snippet || {};
        out.set(item.id, { title: sn.title || '', channelId: sn.channelId || null, channelTitle: sn.channelTitle || '' });
      }
      if (r.error) break;
    }
    return out;
  }
  // keyless: oEmbed gives the channel as author_url (@handle or /channel/UC…)
  const { mapWithConcurrency } = await import('./util.js');
  const { parseChannelRef } = await import('./classify.js');
  const capped = ids.slice(0, 60); // bounded per run; the rest resolve next sync
  const results = await mapWithConcurrency(capped, 6, async (id) => {
    try {
      const inner = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
      const data = await httpRequest({ url: `https://www.youtube.com/oembed?url=${inner}&format=json`, responseType: 'json' });
      if (data.status !== 200 || !data.data) return null;
      const d = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
      const ref = d.author_url ? parseChannelRef(d.author_url) : null;
      const channelId = ref ? await resolveChannelRef(ref, '') : null; // cached forever
      return { title: d.title || '', channelId: channelId || null, channelTitle: d.author_name || '' };
    } catch { return null; }
  });
  results.forEach((r, i) => { if (r.ok && r.value) out.set(capped[i], r.value); });
  return out;
}

/** ids -> Map<id, title>. With a key: 1 unit per 50 (the fix for the 300-serial-fetch freeze). */
export async function fetchTitles(ids, key) {
  const out = new Map();
  if (!ids.length) return out;
  if (key) {
    for (const batch of batchIds(ids, 50)) {
      const r = await apiGet('videos', { part: 'snippet', id: batch.join(','), maxResults: 50 }, key);
      for (const item of r.data?.items || []) out.set(item.id, item.snippet?.title || '');
      if (r.error) break;
    }
    return out;
  }
  const { mapWithConcurrency } = await import('./util.js');
  const { fetchYouTubeTitle } = await import('./store.js');
  const capped = ids.slice(0, 150); // bounded worst case; the rest resolve next launch
  const results = await mapWithConcurrency(capped, 6, (id) => fetchYouTubeTitle(id));
  results.forEach((r, i) => { if (r.ok && r.value) out.set(capped[i], r.value); });
  return out;
}
