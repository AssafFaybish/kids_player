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

/** handle -> channelId, cached FOREVER in meta (forHandle is not batchable). */
export async function resolveChannelRef(ref, key) {
  if (ref.by === 'id') return ref.value;
  const cacheKey = 'handleMap';
  const map = (await getMeta(cacheKey)) || {};
  const ck = ref.by + ':' + ref.value.toLowerCase();
  if (map[ck]) return map[ck];

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
  if (!channelId) {
    // Keyless (and /c/ custom URLs, which the API can't resolve): scrape the public
    // channel page for the canonical id. Zero quota; CapacitorHttp is CORS-free.
    const path = ref.by === 'handle' ? '@' + ref.value : (ref.by === 'user' ? 'user/' + ref.value : 'c/' + ref.value);
    try {
      const html = await httpGetText(`https://www.youtube.com/${encodeURI(path)}`);
      const m = String(html).match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/)
        || String(html).match(/channel\/(UC[A-Za-z0-9_-]{22})/);
      channelId = m ? m[1] : null;
    } catch { channelId = null; }
  }
  if (channelId) {
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
 * Keyless channel-logo fallback (v1.0.4): the avatar URL is not derivable from the
 * channelId, but the public channel page carries it as og:image. Zero quota;
 * CapacitorHttp is CORS-free on device, /__proxy covers the browser preview.
 */
export async function scrapeChannelLogo(channelId) {
  try {
    const html = String(await httpGetText(`https://www.youtube.com/channel/${channelId}`));
    const m = html.match(/<meta property="og:image" content="([^"]+)"/)
      || html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"\\]+)"/);
    return m ? m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : '';
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
  if (r.error) return { videos: [], nextPageToken: null, error: r.error };
  const videos = [];
  for (const item of r.data?.items || []) {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) continue;
    const th = item.snippet?.thumbnails || {};
    videos.push({
      videoId,
      title: item.snippet?.title || '',
      publishedAt: Date.parse(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '') || 0,
      thumbUrl: (th.standard || th.medium || th.high || th.default || {}).url || ''
    });
  }
  return { videos, nextPageToken: r.data?.nextPageToken || null };
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
