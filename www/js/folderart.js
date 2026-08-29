// folderart.js — candidate PICTURES for a parent-created folder, searched by its name.
// Pure URL builders + TOTAL parsers; the one network function never throws.
//
// THE SAFETY MODEL IS THE PARENT, NOT THE FILTER (user decision 2026-08-29). An arbitrary
// image search on a 5-year-old's tablet cannot be made safe by a query parameter, so this
// never installs a picture by itself: it PROPOSES up to `ART_CANDIDATES` thumbnails and a
// human chooses one. No result, no network, or nothing the parent likes ⇒ the emoji
// picker, which is always offered beside it. Nothing here is ever shown to the CHILD —
// the candidates live in the parent screen, behind the PIN.
//
// PROVIDER ORDER IS A MEASUREMENT, not a preference (2026-08-29, live):
//   Wikimedia Commons resolves the CONCEPT across languages — "דינוזאורים" returned
//   Dinosaur-plateau / Dinosaur Pinata / Dinosaur cake, "חיות" returned real animals.
//   Openverse matched only Hebrew-language METADATA — "דינוזאורים" returned Israeli
//   archive photos of Haifa, "מכוניות" naive paintings of Luna Park. So Commons leads
//   and Openverse only tops up the row. Re-measure before reordering these.
//
// Both are keyless and CORS-enabled (verified direct AND through the dev proxy).

import { httpGetJson } from './platform.js';

export const ART_CANDIDATES = 6;
/** Commons thumbnails at this width: ~20-40KB, the same budget as a channel logo. */
export const ART_THUMB_W = 320;

export function commonsSearchUrl(query, limit = ART_CANDIDATES) {
  // `filetype:bitmap` keeps SVGs and PDFs out (an <img> can render an SVG, but Commons
  // SVGs are frequently diagrams/flags, not pictures a child reads as a folder).
  const q = 'filetype:bitmap ' + String(query || '');
  return 'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
    '&gsrnamespace=6&gsrsearch=' + encodeURIComponent(q) +
    '&gsrlimit=' + Math.max(1, limit | 0) +
    '&prop=imageinfo&iiprop=url&iiurlwidth=' + ART_THUMB_W +
    '&format=json&origin=*';
}

export function openverseSearchUrl(query, limit = ART_CANDIDATES) {
  return 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(String(query || '')) +
    '&page_size=' + Math.max(1, limit | 0) + '&mature=false';
}

const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

/**
 * PURE + TOTAL: Commons `generator=search` answers a PAGES OBJECT keyed by page id (not an
 * array), and omits `query` entirely when nothing matched. Anything unrecognized answers
 * [] — never a throw, and never a non-https url (a mixed-content thumbnail is a broken
 * picture the parent would pick and never see again).
 */
export function parseCommonsImages(data) {
  const pages = data && data.query && data.query.pages;
  if (!pages || typeof pages !== 'object') return [];
  const out = [];
  for (const p of Object.values(pages)) {
    const info = p && Array.isArray(p.imageinfo) ? p.imageinfo[0] : null;
    const thumb = httpsOnly(info && info.thumburl);
    if (!thumb) continue;
    out.push({
      thumbUrl: thumb,
      title: String((p.title || '')).replace(/^File:/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 80),
      source: 'commons'
    });
  }
  return out;
}

/** PURE + TOTAL: Openverse answers `{results:[{thumbnail,url,title}]}`. */
export function parseOpenverseImages(data) {
  const rows = data && Array.isArray(data.results) ? data.results : null;
  if (!rows) return [];
  const out = [];
  for (const r of rows) {
    const thumb = httpsOnly(r && (r.thumbnail || r.url));
    if (!thumb) continue;
    out.push({ thumbUrl: thumb, title: String((r && r.title) || '').slice(0, 80), source: 'openverse' });
  }
  return out;
}

/** PURE: merge provider rows in order, dedupe by thumbnail, cap at `limit`. */
export function mergeArtCandidates(lists, limit = ART_CANDIDATES) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const row of list || []) {
      if (!row || !row.thumbUrl || seen.has(row.thumbUrl)) continue;
      seen.add(row.thumbUrl);
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Candidate pictures for a folder name. Returns [] for anything unusable — no network,
 * no results, a provider outage, a changed shape. NEVER throws: this runs inside a
 * dialog the parent is already looking at, and an empty row simply means "pick an emoji".
 */
export async function fetchArtCandidates(query, limit = ART_CANDIDATES) {
  const q = String(query || '').trim();
  if (!q) return [];
  const lists = [];
  try { lists.push(parseCommonsImages(await httpGetJson(commonsSearchUrl(q, limit)))); } catch {}
  if (mergeArtCandidates(lists, limit).length < limit) {
    try { lists.push(parseOpenverseImages(await httpGetJson(openverseSearchUrl(q, limit)))); } catch {}
  }
  return mergeArtCandidates(lists, limit);
}
