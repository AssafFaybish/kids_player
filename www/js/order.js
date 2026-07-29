// order.js — display ordering. One numeric sortKey per item, rendered DESC everywhere
// (an IndexedDB 'prev' cursor over by_folder_sort). Folders are separate index ranges,
// so each origin can use its own ordering domain without collisions:
//
//   channel   → publishedAt (epoch ms)          — newest upload first
//   sheet-row → SHEET_BASE + rowIndex           — LAST sheet row shown FIRST (the
//               user-requested reversal falls out of the DESC cursor for free)
//   manual/share → MANUAL_BASE + addedAt/1e6    — always above sheet rows
//
// CRITICAL INVARIANT (tested): a sortKey depends only on the row's own ordinal /
// timestamps — appending row N+1 never renumbers rows 1..N.

export const SHEET_BASE = 4e12;            // ~year 2096: far above any real epoch-ms
export const MANUAL_BASE = SHEET_BASE + 1e6;

export function sortKeyFor({ origin, publishedAt, rowIndex, addedAt }) {
  if (origin === 'channel') return publishedAt || 0;
  if (origin === 'sheet-row') return SHEET_BASE + (rowIndex || 0);
  return MANUAL_BASE + ((addedAt || 0) / 1e6);
}

/** Total order for display: sortKey DESC, then primary key ASC (deterministic ties). */
export function compareForDisplay(a, b) {
  const d = (b.sortKey || 0) - (a.sortKey || 0);
  if (d !== 0) return d;
  return String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0;
}
