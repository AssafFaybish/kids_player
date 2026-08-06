// ytsearch.js — KEYLESS YouTube search for the parent's add tab (v1.0.33).
//
// THE QUOTA RULE STANDS. The official Data API `search.list` costs 100 units per call
// on a key every family shares — ~80 searches a day would freeze sync for everyone —
// which is why it is BANNED (see quota.js and the invariants test). This module uses
// the endpoint YouTube's own results page is fed from instead: a keyless POST that
// costs 0 quota, needs no login, and returns the same results the parent would see on
// youtube.com — verified live (2026-08-06) with the native layer's Dalvik user-agent
// too, so the v1.0.32 mobile-page trap does not apply (this is an API, not a page
// that redirects to m.youtube.com).
//
// THE PRICE is that the endpoint is UNDOCUMENTED: YouTube may change its shapes.
// parseSearchResponse therefore answers `null` only for "I do not recognize this
// document at all" — the caller turns that into a DISTINCT message ("YouTube changed
// something"), never confusable with "no results". If this breaks in the field, only
// the search screen degrades; pasting a link keeps working.
//
// INVARIANTS (pinned in invariants.test.mjs):
//  - The youtubei endpoint literal lives in THIS module only.
//  - No API key ever reaches it: buildSearchBody is pinned key-free, and this module
//    must never import getApiKey/keys — the search must not tie the family's shared
//    quota (or the parent's own key) to an endpoint that never needs one.
//  - Imports ⊆ { platform.js, util.js } (the yt.js tier); app.js reaches this module
//    only via `await import()`.
//  - Shorts and RD-mixes are filtered IN THE PURE PARSER (the parent decided: no
//    Shorts anywhere in this app, and a mix is an auto-generated endless list that
//    cannot be imported) — both pinned with planted fixtures.

import { httpPostJson, httpGetText } from './platform.js';

/* ---------------- the sanctioned endpoints ---------------- */

// The ONE youtubei literal (invariant: exactly one module carries it).
export const SEARCH_ENDPOINT = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';

// A date-stamped client version. YouTube tolerates a stale one; bumping it is always
// safe. If search ever starts answering 'parse', try bumping this first.
const CLIENT_VERSION = '2.20250801.00.00';

// Typed result filters — the `params` protobufs youtube.com itself sends when the
// user picks a filter chip. Filtering at the SOURCE beats guessing renderer types.
const FILTER_PARAMS = { all: null, video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };

/** The suggestions endpoint (keyless GET; `client=firefox` answers clean JSON). */
export function suggestUrl(query) {
  return 'https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=he&q='
    + encodeURIComponent(String(query || ''));
}

/* ---------------- pure: request body ---------------- */

/**
 * The POST body for one search (or one continuation page). PURE and test-pinned:
 * the serialized body must never contain an API key, `hl=he` keeps the result texts
 * (durations, "subscribers") in the UI's language, and a continuation body carries
 * ONLY {context, continuation} — resending query/params alongside a token confuses
 * the endpoint into restarting from page one.
 */
export function buildSearchBody(query, { filter = 'all', continuation = null } = {}) {
  const context = { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'he', gl: 'IL' } };
  if (continuation) return { context, continuation };
  const body = { context, query: String(query || '') };
  const params = FILTER_PARAMS[filter] || null;
  if (params) body.params = params;
  return body;
}

/* ---------------- pure: response parsing ---------------- */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** Every text shape the endpoint uses: 'x' | {simpleText} | {content} | {runs:[{text}]}. */
function textOf(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (typeof t.content === 'string') return t.content;
  if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
  return '';
}

/** Largest thumbnail, protocol-relative `//yt3…` normalized to https. */
function bestThumb(thumbnails) {
  const arr = Array.isArray(thumbnails) ? thumbnails : [];
  const last = arr[arr.length - 1];
  let u = String((last && last.url) || '');
  if (u.startsWith('//')) u = 'https:' + u;
  return /^https:\/\//.test(u) ? u : '';
}

/** Deep-collect values of one key (used only on SMALL subtrees, never the whole doc). */
function collectKey(node, key, out) {
  if (Array.isArray(node)) { for (const v of node) collectKey(v, key, out); return; }
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    if (k === key) out.push(node[k]);
    collectKey(node[k], key, out);
  }
}

/**
 * Is this videoRenderer a Short? Two independent signals, either suffices (the
 * parent's decision: filter every IDENTIFIED Short; per the repo rule an UNKNOWN
 * signal means include — a wrongly hidden video is a bug the parent cannot explain).
 */
function isShortVideo(v) {
  for (const o of v.thumbnailOverlays || []) {
    if (o && o.thumbnailOverlayTimeStatusRenderer
      && String(o.thumbnailOverlayTimeStatusRenderer.style || '') === 'SHORTS') return true;
  }
  const nav = v.navigationEndpoint || {};
  if (nav.reelWatchEndpoint) return true;
  const url = nav.commandMetadata && nav.commandMetadata.webCommandMetadata
    && nav.commandMetadata.webCommandMetadata.url;
  if (typeof url === 'string' && url.includes('/shorts/')) return true;
  return false;
}

function videoItem(v) {
  const id = String(v.videoId || '');
  if (!VIDEO_ID.test(id) || isShortVideo(v)) return null;
  return {
    type: 'video',
    id,
    url: 'https://www.youtube.com/watch?v=' + id,
    title: textOf(v.title),
    channelTitle: textOf(v.ownerText) || textOf(v.longBylineText) || textOf(v.shortBylineText),
    durationText: textOf(v.lengthText),
    publishedText: textOf(v.publishedTimeText),
    viewCountText: textOf(v.shortViewCountText) || textOf(v.viewCountText),
    thumbUrl: bestThumb(v.thumbnail && v.thumbnail.thumbnails)
  };
}

function channelItem(c) {
  const id = String(c.channelId || '');
  if (!CHANNEL_ID.test(id)) return null;
  return {
    type: 'channel',
    id,
    url: 'https://www.youtube.com/channel/' + id,
    title: textOf(c.title),
    // current pages put the subscriber text in videoCountText; older ones in
    // subscriberCountText — both real shapes, take whichever exists
    subText: textOf(c.videoCountText) || textOf(c.subscriberCountText),
    thumbUrl: bestThumb(c.thumbnail && c.thumbnail.thumbnails)
  };
}

/**
 * The official-artist card (Cocomelon-class channels appear ONLY as this in the
 * mixed view — measured live). ANCHORING RULE: identity is read from the card's
 * HEADER subtree only, and only when every UC id in it agrees. The `contents`
 * subtree carries FOREIGN related-channel ids (measured), and "take the first UC
 * you see" is exactly the decoy class that once subscribed a family to a
 * stranger's channel (@RabbiRosenblum, v1.0.28). Ambiguous card ⇒ skipped; the
 * ערוצים chip still finds the real channelRenderer.
 */
function officialCardItem(card) {
  const header = card && card.header;
  if (!header) return null;
  const endpoints = [];
  collectKey(header, 'browseEndpoint', endpoints);
  const ids = [...new Set(endpoints.map((b) => String((b && b.browseId) || '')).filter((x) => CHANNEL_ID.test(x)))];
  if (ids.length !== 1) return null;
  const ph = header.pageHeaderViewModel || {};
  const title = textOf(ph.title && ph.title.dynamicTextViewModel && ph.title.dynamicTextViewModel.text);
  if (!title) return null;
  const sources = [];
  collectKey(header, 'sources', sources);
  let thumbUrl = '';
  for (const grp of sources) {
    const u = Array.isArray(grp) && grp[0] && String(grp[0].url || '');
    if (u && /^https:\/\//.test(u)) { thumbUrl = u; break; }
  }
  const parts = [];
  collectKey(ph.metadata || {}, 'text', parts);
  const subText = parts.map(textOf).find((t) => /מנוי|subscriber/i.test(t)) || '';
  return { type: 'channel', id: ids[0], url: 'https://www.youtube.com/channel/' + ids[0], title, subText, thumbUrl };
}

function lockupItem(l) {
  const kind = String(l.contentType || '');
  const id = String(l.contentId || '');
  const meta = l.metadata && l.metadata.lockupMetadataViewModel;
  const title = textOf(meta && meta.title);
  const sources = [];
  collectKey(l.contentImage || {}, 'sources', sources);
  let thumbUrl = '';
  for (const grp of sources) {
    if (Array.isArray(grp) && grp.length) { thumbUrl = bestThumb(grp); if (thumbUrl) break; }
  }
  if (kind === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
    // RD… = an auto-generated MIX: an endless radio, not a real list — importing it
    // is meaningless and its id would sit in libraryChannels forever. Filtered.
    if (!id || /^RD/.test(id)) return null;
    return { type: 'playlist', id, url: 'https://www.youtube.com/playlist?list=' + id, title, subText: '', thumbUrl };
  }
  if (kind === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    if (!VIDEO_ID.test(id)) return null;
    // a lockup video's tap target names /shorts/ when it is one
    const urls = [];
    collectKey(l, 'url', urls);
    if (urls.some((u) => typeof u === 'string' && u.includes('/shorts/'))) return null;
    return {
      type: 'video', id, url: 'https://www.youtube.com/watch?v=' + id, title,
      channelTitle: '', durationText: '', publishedText: '', viewCountText: '', thumbUrl
    };
  }
  return null;
}

function playlistRendererItem(p) {
  const id = String(p.playlistId || '');
  if (!id || /^RD/.test(id)) return null;
  const first = Array.isArray(p.thumbnails) ? p.thumbnails[0] : null;
  return {
    type: 'playlist',
    id,
    url: 'https://www.youtube.com/playlist?list=' + id,
    title: textOf(p.title),
    subText: textOf(p.videoCountText) || (p.videoCount ? String(p.videoCount) : ''),
    thumbUrl: bestThumb(first && first.thumbnails)
  };
}

function collectNode(node, state) {
  if (!node || typeof node !== 'object') return;
  if (node.itemSectionRenderer) {
    for (const it of node.itemSectionRenderer.contents || []) collectNode(it, state);
    return;
  }
  if (node.continuationItemRenderer) {
    const tok = node.continuationItemRenderer.continuationEndpoint
      && node.continuationItemRenderer.continuationEndpoint.continuationCommand
      && node.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (tok && !state.continuation) state.continuation = String(tok);
    return;
  }
  // a Shorts SHELF is dropped wholesale — that is the one unambiguous Shorts signal
  if (node.reelShelfRenderer) return;
  if (node.shelfRenderer) {
    const content = node.shelfRenderer.content || {};
    const list = (content.verticalListRenderer && content.verticalListRenderer.items)
      || (content.horizontalListRenderer && content.horizontalListRenderer.items) || [];
    for (const it of list) collectNode(it, state);
    return;
  }
  let item = null;
  if (node.videoRenderer) item = videoItem(node.videoRenderer);
  else if (node.channelRenderer) item = channelItem(node.channelRenderer);
  else if (node.playlistRenderer) item = playlistRendererItem(node.playlistRenderer);
  else if (node.lockupViewModel) item = lockupItem(node.lockupViewModel);
  else if (node.officialCardViewModel) item = officialCardItem(node.officialCardViewModel);
  // every other renderer (ads, horizontal cards, did-you-mean…) is skipped silently
  if (!item) return;
  const key = item.type + ':' + item.id;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.items.push(item);
}

/**
 * -> { items, continuation } | null.
 * `null` means NEITHER recognized top-level shape exists — the "YouTube changed
 * something" alarm. A recognized document with zero usable results answers
 * { items: [] } — a different fact ("no results") that gets a different message.
 * Handles both the first-page shape and the continuation shape.
 */
export function parseSearchResponse(json) {
  const first = json && json.contents && json.contents.twoColumnSearchResultsRenderer
    && json.contents.twoColumnSearchResultsRenderer.primaryContents
    && json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
    && json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
  let sections = Array.isArray(first) ? first : null;
  if (!sections) {
    for (const c of (json && json.onResponseReceivedCommands) || []) {
      const items = c && c.appendContinuationItemsAction && c.appendContinuationItemsAction.continuationItems;
      if (Array.isArray(items)) { sections = items; break; }
    }
  }
  if (!sections) return null;
  const state = { items: [], continuation: null, seen: new Set() };
  for (const s of sections) collectNode(s, state);
  return { items: state.items, continuation: state.continuation };
}

/**
 * Suggestion list out of the endpoint's answer. Tolerates BOTH the firefox-client
 * clean JSON (`["q",["s1","s2",…]]`) and the JSONP wrapper other clients answer
 * (`window.google.ac.h(["q",[["s1",0],…]])`). Junk -> [] — suggestions are a
 * convenience and must never take the search input down with them.
 */
export function parseSuggestions(text) {
  const s = String(text || '');
  const open = s.indexOf('[');
  const close = s.lastIndexOf(']');
  if (open < 0 || close <= open) return [];
  try {
    const arr = JSON.parse(s.slice(open, close + 1));
    const list = Array.isArray(arr) && Array.isArray(arr[1]) ? arr[1] : [];
    const out = [];
    for (const e of list) {
      const v = typeof e === 'string' ? e : (Array.isArray(e) ? e[0] : '');
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
      if (out.length >= 10) break;
    }
    return out;
  } catch { return []; }
}

/* ---------------- pure: user-facing texts ---------------- */

/**
 * The words ARE the feature (the v1.0.27 rule): a search that fails must say WHICH
 * failure — "יוטיוב שינה משהו" is an update-the-app alarm, "בדקו את החיבור" is a
 * try-again, and "אין תוצאות" is neither. Stages are test-pinned: all distinct,
 * none empty, the query appears in 'empty', and nothing may leak undefined/NaN.
 */
export function searchMessage(stage, { query = '' } = {}) {
  const q = String(query || '').trim();
  switch (stage) {
    case 'searching': return 'מחפשים ביוטיוב…';
    case 'more': return 'טוענים עוד תוצאות…';
    case 'empty': return 'לא נמצאו תוצאות עבור "' + q + '"';
    case 'network': return 'החיפוש לא הצליח — בדקו את החיבור לאינטרנט ונסו שוב';
    case 'parse': return 'החיפוש לא זמין כרגע (יוטיוב שינה משהו בצד שלו) — אפשר עדיין להדביק קישור';
    case 'added': return 'נוסף! ✅';
    case 'exists': return 'כבר נמצא בספרייה';
    default: return '';
  }
}

/* ---------------- network (thin; the logic above is what's tested) ---------------- */

/** One search (or continuation page). Throws Error('network') / Error('parse'). */
export async function searchYouTube(query, opts = {}) {
  const res = await httpPostJson(SEARCH_ENDPOINT, buildSearchBody(query, opts));
  if (res.status !== 200 || !res.data) throw new Error('network');
  let data = res.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { throw new Error('parse'); }
  }
  const parsed = parseSearchResponse(data);
  if (!parsed) throw new Error('parse');
  return parsed;
}

/** Best-effort suggestions; never throws (an offline dropdown is just absent). */
export async function fetchSuggestions(query) {
  try { return parseSuggestions(await httpGetText(suggestUrl(query))); } catch { return []; }
}
