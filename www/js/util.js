// util.js — tiny pure helpers shared across modules. No I/O, node-testable.

/** FNV-1a 32-bit hash → 8-char hex. Used for library ids and sheet change detection. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Canonical identity of an input sheet: the spreadsheet id + gid, so /edit, /export,
 * ?usp=sharing etc. all map to the same library. Non-Google URLs canonicalize to
 * origin+path (query stripped, since export params vary).
 */
export function canonicalSheetKey(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  const gs = s.match(/docs\.google\.com\/spreadsheets\/d\/(e\/)?([A-Za-z0-9_-]+)/);
  if (gs) {
    const gid = (s.match(/[#?&]gid=([0-9]+)/) || [])[1];
    return 'gsheet:' + gs[2] + (gid ? ':' + gid : '');
  }
  const m = s.match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
  if (m) return 'url:' + m[1].toLowerCase() + m[2];
  return 'raw:' + s;
}

/** Stable id for the shared library derived from one input sheet (decision 20). */
export function libraryIdFor(sheetUrl) {
  const key = canonicalSheetKey(sheetUrl);
  return key ? 'lib:' + fnv1a(key) : null;
}

/**
 * Map with bounded concurrency. Never rejects as a whole: each result is
 * { ok:true, value } or { ok:false, error }. Preserves input order. Honors an
 * optional AbortSignal (pending items resolve { ok:false, error:'aborted' }).
 */
export async function mapWithConcurrency(items, limit, fn, { signal, onProgress } = {}) {
  const arr = Array.from(items);
  const out = new Array(arr.length);
  let next = 0;
  let done = 0;
  const n = Math.max(1, Math.min(limit || 1, arr.length || 1));

  async function worker() {
    while (true) {
      if (signal && signal.aborted) {
        while (next < arr.length) { out[next] = { ok: false, error: 'aborted' }; next += 1; }
        return;
      }
      const i = next;
      if (i >= arr.length) return;
      next += 1;
      try {
        out[i] = { ok: true, value: await fn(arr[i], i) };
      } catch (e) {
        out[i] = { ok: false, error: String((e && e.message) || e) };
      }
      done += 1;
      if (onProgress) { try { onProgress(done, arr.length); } catch {} }
    }
  }

  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
