// csv.js — RFC 4180-ish CSV parsing for remote lists. Replaces the naive
// line.split(/[\t,]/) that destroyed Hebrew titles containing commas
// (e.g. `https://x,"פרפרים, חלק 2",` lost everything after the inner comma).
// Handles: quoted fields, "" escapes, newlines inside quotes, CRLF, the UTF-8 BOM
// that Google Sheets' CSV export prepends, and a tab-separated fallback per row.

/**
 * v1.0.18 — is this body actually a CSV export, or an HTML page wearing a 200?
 *
 * THE BUG THIS CLOSES: when a source sheet loses "anyone with the link", Google's
 * CSV-export URL does not fail — it 302s to a sign-in / "request access" page and
 * CapacitorHttp follows the redirect, so the app receives a perfectly successful
 * HTTP 200 full of HTML. parseSourceSheet finds no rows in it, and the v1.0.10
 * presence-mirror concludes the parent emptied the sheet and deletes the library.
 * A revoked share must read as a FETCH FAILURE (keep what we have), never as an
 * instruction to delete.
 *
 * Deliberately narrow: it only rejects a body that opens like a markup document.
 * A genuinely empty sheet still parses (and is then caught by the mirror's valve,
 * which asks the parent) — silence and emptiness must stay distinguishable.
 */
export function looksLikeHtml(text) {
  let t = String(text ?? '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const head = t.trimStart().slice(0, 400).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') ||
    head.startsWith('<?xml') || /^<(head|body|meta|title|script)\b/.test(head);
}

/** Parse CSV text into rows of raw string fields. Never throws. */
export function parseCsv(text) {
  let t = String(text ?? '');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // Google Sheets export BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else {
        field += c; // commas and newlines inside quotes are literal
      }
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; continue; } // opening quote only at field start
    if (c === ',') { endField(); continue; }
    if (c === '\r') { if (t[i + 1] === '\n') i += 1; endRow(); continue; }
    if (c === '\n') { endRow(); continue; }
    field += c;
  }
  if (field !== '' || row.length > 0) endRow();

  // Tab-separated fallback: a line with no commas parses as one field — split it on tabs.
  return rows.map((r) => (r.length === 1 && r[0].includes('\t') ? r[0].split('\t') : r));
}
