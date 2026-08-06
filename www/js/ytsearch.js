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

// The youtubei literals (invariant: exactly one module carries ANY youtubei endpoint).
// NOT exported (review finding, 2026-08-06): an exported endpoint constant is a drift
// hole — `import { SEARCH_ENDPOINT }` elsewhere plus a hand-appended key parameter
// would trip none of the guards, because the key ban is scoped to THIS module and the
// importer carries no youtubei literal of its own.
const SEARCH_ENDPOINT = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const BROWSE_ENDPOINT = 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false';

// The Videos-tab selector for a channel browse — the same protobuf youtube.com sends
// when the user opens the tab. Videos-tab-only is a POLICY match, not a shortcut:
// Shorts live in their own tab, so what the parent browses here is exactly what a
// subscription would import (the UULF rule, in browse form). Verified live.
const CHANNEL_VIDEOS_TAB = 'EgZ2aWRlb3PyBgQKAjoA';

// A date-stamped client version. YouTube tolerates a stale one; bumping it is always
// safe. If search ever starts answering 'parse', try bumping this first.
const CLIENT_VERSION = '2.20250801.00.00';

// Typed result filters — the `params` protobufs youtube.com itself sends when the
// user picks a filter chip. Filtering at the SOURCE beats guessing renderer types.
const FILTER_PARAMS = { all: null, video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };

/**
 * The suggestions endpoint (keyless GET; `client=firefox` answers clean JSON).
 * `oe=utf-8` is LOAD-BEARING: without it a Hebrew query is answered in
 * windows-1255 (measured live) and every suggestion renders as ����.
 */
export function suggestUrl(query) {
  return 'https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=he&oe=utf-8&q='
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
  // own-property lookup: a hostile/garbage filter string must fall to "unfiltered",
  // never to something inherited off Object.prototype
  const params = (Object.hasOwn(FILTER_PARAMS, filter) && FILTER_PARAMS[filter]) || null;
  if (params) body.params = params;
  return body;
}

/**
 * The POST body for browsing INSIDE one search result (v1.0.33): a channel's Videos
 * tab, or a playlist's contents. Same key-free/continuation rules as buildSearchBody
 * (both pinned). A playlist's browse id is its id behind the `VL` prefix — that is
 * how youtube.com itself addresses a playlist page.
 */
export function buildBrowseBody(target, { continuation = null } = {}) {
  const context = { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'he', gl: 'IL' } };
  if (continuation) return { context, continuation };
  const kind = target && target.kind;
  const id = String((target && target.id) || '');
  if (kind === 'channel') return { context, browseId: id, params: CHANNEL_VIDEOS_TAB };
  return { context, browseId: 'VL' + id };
}

/* ---------------- pure: response parsing ---------------- */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
// aligned with classify.js's playlist rule ({10,} of the URL-safe class), capped for
// sanity — an unvalidated id was the one identifier class the parser let through
// (review finding: a hostile id containing `"]` would throw inside ytsMarkRow's
// querySelector AFTER a successful add)
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/** Every list the endpoint may hand us — tolerate the array→keyed-object churn
    innertube is known for. THE PARSERS MUST BE TOTAL (review finding: a truthy
    non-array here used to THROW, and the caller reported "בדקו את החיבור" over
    working Wi-Fi instead of the shape-changed alarm). */
function list(x) { return Array.isArray(x) ? x : []; }

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
  for (const o of list(v.thumbnailOverlays)) {
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
    if (!PLAYLIST_ID.test(id) || /^RD/.test(id)) return null;
    return { type: 'playlist', id, url: 'https://www.youtube.com/playlist?list=' + id, title, subText: '', thumbUrl };
  }
  if (kind === 'LOCKUP_CONTENT_TYPE_VIDEO') {
    if (!VIDEO_ID.test(id)) return null;
    // a lockup video's tap target names /shorts/ when it is one — and parity with
    // isShortVideo: a reelWatchEndpoint anywhere in the lockup is the same signal
    // even when no url string spells it out
    const urls = [];
    collectKey(l, 'url', urls);
    if (urls.some((u) => typeof u === 'string' && u.includes('/shorts/'))) return null;
    const reels = [];
    collectKey(l, 'reelWatchEndpoint', reels);
    if (reels.length) return null;
    // the duration rides the thumbnail's corner badge (thumbnailBadgeViewModel.text,
    // measured live in browse responses) — the only time-shaped badge text there
    const badges = [];
    collectKey(l.contentImage || {}, 'thumbnailBadgeViewModel', badges);
    const durationText = badges.map((b) => String((b && b.text) || ''))
      .find((t) => /^\d+:\d\d(?::\d\d)?$/.test(t)) || '';
    // metadata rows carry views/age for browse lockups ("406K צפיות", "לפני חודשיים")
    const parts = [];
    collectKey((meta && meta.metadata) || {}, 'text', parts);
    const texts = parts.map(textOf).filter(Boolean);
    return {
      type: 'video', id, url: 'https://www.youtube.com/watch?v=' + id, title,
      channelTitle: '', durationText,
      publishedText: texts.find((t) => /לפני|ago/.test(t)) || '',
      viewCountText: texts.find((t) => /צפיות|views/.test(t)) || '',
      thumbUrl
    };
  }
  return null;
}

/** The LEGACY playlist-contents item shape (playlistVideoRenderer) — kept for older
    documents; current pages answer lockupViewModel (measured 2026-08-06). */
function playlistVideoItem(p) {
  const id = String(p.videoId || '');
  if (!VIDEO_ID.test(id) || isShortVideo(p)) return null;
  // (title/byline/thumb below all go through the total textOf/bestThumb helpers)
  return {
    type: 'video', id, url: 'https://www.youtube.com/watch?v=' + id,
    title: textOf(p.title),
    channelTitle: textOf(p.shortBylineText),
    durationText: textOf(p.lengthText),
    publishedText: '', viewCountText: '',
    thumbUrl: bestThumb(p.thumbnail && p.thumbnail.thumbnails)
  };
}

function playlistRendererItem(p) {
  const id = String(p.playlistId || '');
  if (!PLAYLIST_ID.test(id) || /^RD/.test(id)) return null;
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
    for (const it of list(node.itemSectionRenderer.contents)) collectNode(it, state);
    return;
  }
  // browse wrappers (v1.0.33): a channel's Videos tab wraps each lockup in a
  // richItemRenderer; older playlist documents wrap items in playlistVideoListRenderer
  if (node.richItemRenderer) {
    collectNode(node.richItemRenderer.content, state);
    return;
  }
  if (node.playlistVideoListRenderer) {
    for (const it of list(node.playlistVideoListRenderer.contents)) collectNode(it, state);
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
    const items = (content.verticalListRenderer && content.verticalListRenderer.items)
      || (content.horizontalListRenderer && content.horizontalListRenderer.items);
    for (const it of list(items)) collectNode(it, state);
    return;
  }
  let item = null;
  if (node.videoRenderer) item = videoItem(node.videoRenderer);
  else if (node.playlistVideoRenderer) item = playlistVideoItem(node.playlistVideoRenderer);
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
/** A continuation page's item list — search answers onResponseReceivedCommands,
    browse answers onResponseReceivedActions (both measured live). */
function continuationSections(json) {
  const groups = [
    ...list(json && json.onResponseReceivedCommands),
    ...list(json && json.onResponseReceivedActions)
  ];
  for (const c of groups) {
    const items = c && c.appendContinuationItemsAction && c.appendContinuationItemsAction.continuationItems;
    if (Array.isArray(items)) return items;
  }
  return null;
}

function walkSections(sections) {
  const state = { items: [], continuation: null, seen: new Set() };
  for (const s of sections) collectNode(s, state);
  return { items: state.items, continuation: state.continuation };
}

export function parseSearchResponse(json) {
  const first = json && json.contents && json.contents.twoColumnSearchResultsRenderer
    && json.contents.twoColumnSearchResultsRenderer.primaryContents
    && json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
    && json.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
  const sections = Array.isArray(first) ? first : continuationSections(json);
  if (!sections) return null;
  return walkSections(sections);
}

/**
 * -> { items, continuation } | null, same contract as parseSearchResponse.
 * First-page shapes (both measured live 2026-08-06): a channel answers
 * tabs[] where ONLY the requested tab carries content — a richGridRenderer of
 * richItemRenderer-wrapped video lockups; a playlist answers a sectionListRenderer
 * whose itemSection holds the lockups directly. Continuation pages ride
 * onResponseReceivedActions.
 */
export function parseBrowseResponse(json) {
  let sections = null;
  const tabs = json && json.contents && json.contents.twoColumnBrowseResultsRenderer
    && json.contents.twoColumnBrowseResultsRenderer.tabs;
  for (const t of list(tabs)) {
    const content = t && t.tabRenderer && t.tabRenderer.content;
    const list = (content && content.richGridRenderer && content.richGridRenderer.contents)
      || (content && content.sectionListRenderer && content.sectionListRenderer.contents);
    if (Array.isArray(list)) { sections = list; break; }
  }
  if (!sections) sections = continuationSections(json);
  if (!sections) return null;
  return walkSections(sections);
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
    case 'browse': return 'טוענים את הסרטונים…';
    case 'more': return 'טוענים עוד תוצאות…';
    case 'empty': return 'לא נמצאו תוצאות עבור "' + q + '"';
    case 'network': return 'החיפוש לא הצליח — בדקו את החיבור לאינטרנט ונסו שוב';
    case 'parse': return 'החיפוש לא זמין כרגע (יוטיוב שינה משהו בצד שלו) — אפשר עדיין להדביק קישור';
    // NOTE: no 'added'/'exists' stages here — the add outcome text comes from
    // addClassifiedRow's own message (one add path = one voice; review-caught dead code)
    default: return '';
  }
}

/* ---------------- network (thin; the logic above is what's tested) ---------------- */

async function postAndParse(endpoint, body, parse, { endOnUnparsed = false } = {}) {
  const res = await httpPostJson(endpoint, body);
  if (res.status !== 200 || !res.data) throw new Error('network');
  let data = res.data;
  if (typeof data === 'string') {
    // A 200 whose body is not JSON is a consent/captcha interstitial or similar
    // transport weirdness — 'network' (try again), NOT the shape-changed alarm.
    // Review-caught: this used to throw 'parse' here, so the same interstitial read
    // as "update the app" on device and as 'network' in the browser (whose fetch
    // path nulls a non-JSON body) — two transports disagreeing about one fact.
    try { data = JSON.parse(data); } catch { throw new Error('network'); }
  }
  // The parsers aim to be TOTAL, but the caller must not bet the error message on
  // that: a throw on some future shape must read exactly like "unrecognized",
  // or the parent gets "בדקו את החיבור" over working Wi-Fi (review-caught).
  let parsed = null;
  try { parsed = parse(data); } catch { parsed = null; }
  if (!parsed) {
    // A CONTINUATION that parses to nothing means "no more pages", never the
    // shape-changed alarm: measured live — a playlist delivered whole on page one
    // still carries a token, and asking for it answers a document with nothing but
    // trackingParams. The FIRST page already proved the shapes are recognized, so
    // only first-page requests may raise 'parse'.
    if (endOnUnparsed) return { items: [], continuation: null };
    throw new Error('parse');
  }
  return parsed;
}

/** One search (or continuation page). Throws Error('network') / Error('parse'). */
export async function searchYouTube(query, opts = {}) {
  return postAndParse(SEARCH_ENDPOINT, buildSearchBody(query, opts), parseSearchResponse,
    { endOnUnparsed: !!opts.continuation });
}

/** One browse page inside a channel/playlist result. Same error contract. */
export async function browseYouTube(target, opts = {}) {
  return postAndParse(BROWSE_ENDPOINT, buildBrowseBody(target, opts), parseBrowseResponse,
    { endOnUnparsed: !!opts.continuation });
}

/** Best-effort suggestions; never throws (an offline dropdown is just absent). */
export async function fetchSuggestions(query) {
  try { return parseSuggestions(await httpGetText(suggestUrl(query))); } catch { return []; }
}
