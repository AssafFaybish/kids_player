// csv.js — RFC 4180-ish CSV parsing for remote lists. Replaces the naive
// line.split(/[\t,]/) that destroyed Hebrew titles containing commas
// (e.g. `https://x,"פרפרים, חלק 2",` lost everything after the inner comma).
// Handles: quoted fields, "" escapes, newlines inside quotes, CRLF, the UTF-8 BOM
// that Google Sheets' CSV export prepends, and a tab-separated fallback per row.

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
