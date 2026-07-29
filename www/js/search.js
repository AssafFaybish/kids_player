// search.js — PURE search ranking for the home-screen search bar (v1.0.7).
// Matching runs over normalizeTitle output on BOTH sides, so niqqud/bidi/emoji/case
// differences never hide a result. Node-tested; no DOM, no IDB.
//
// Score model (higher = better, 0 = no match):
//   100 exact title  |  80 title starts with query  |  60 a WORD starts with query
//   40 substring anywhere — minus a small position penalty so earlier matches win;
//   ties break by shorter title (more of it matched), then stable by key.

import { normalizeTitle } from './normalize.js';

export function scoreMatch(normQuery, normTitle) {
  if (!normQuery || !normTitle) return 0;
  if (normTitle === normQuery) return 100;
  if (normTitle.startsWith(normQuery + ' ') || normTitle.startsWith(normQuery)) return 80;
  const idx = normTitle.indexOf(normQuery);
  if (idx < 0) return 0;
  if (normTitle[idx - 1] === ' ') return 60;
  return Math.max(1, 40 - Math.min(20, idx)); // substring: earlier is better
}

/**
 * Rank items against a query. Each item needs { key, normTitle } (video records have
 * normTitle persisted; folder entries pass a normalized channel title).
 * -> [{ item, score }] sorted best-first; empty array for a blank/too-short query.
 */
export function rankItems(query, items, { minLength = 2, limit = 24 } = {}) {
  const q = normalizeTitle(query);
  if (q.length < minLength) return [];
  const out = [];
  for (const item of items || []) {
    const score = scoreMatch(q, item.normTitle || '');
    if (score > 0) out.push({ item, score });
  }
  out.sort((a, b) =>
    (b.score - a.score)
    || ((a.item.normTitle || '').length - (b.item.normTitle || '').length)
    || (String(a.item.key) < String(b.item.key) ? -1 : 1));
  return out.slice(0, limit);
}
