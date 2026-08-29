// gdrivepub.js — PUBLIC Google Drive access (v1.0.56): metadata for files a parent
// shared "כל מי שיש לו הקישור". ONE module on purpose, like ytsearch.js is for youtubei:
// every `key=`-authenticated Drive endpoint lives here and nowhere else, so the blast
// radius of Google changing anything is one file.
//
// THE RULES OF THIS MODULE, each load-bearing:
//  - NO OAuth. It never imports gauth.js and never attaches an Authorization header.
//    The app's only OAuth scope is `drive.file` (v1.0.19 — it must never grow), which
//    cannot read a parent's own files anyway; everything here works ONLY because the
//    parent shared the file publicly, which playback on the child's device already
//    requires. An invariants test pins the no-gauth rule.
//  - The API key is OPTIONAL. A keyless build (keys.local.js is gitignored) falls back
//    to scraping the file's public HTML page — the resolveChannelRef doctrine: the API
//    outranks the scrape when a key exists, and the scrape keeps keyless installs alive.
//  - Parsers are TOTAL (the v1.0.33 rule): any unrecognized/error/HTML answer is null,
//    never a throw and never a fabricated name.
//
// NOTE for operators: the shared API key must have the Google Drive API enabled in its
// API restrictions (it used to be YouTube-only) — see GOOGLE_CLOUD_SETUP.md. A key still
// restricted to YouTube answers 403 here, which reads as "no meta" and falls back to the
// scrape: degraded, never broken.

import { httpGetJson, httpGetText } from './platform.js';
import { defaultYtApiKey } from './keys.js';

const PUB_API = 'https://www.googleapis.com/drive/v3';

/** Drive ids are opaque [A-Za-z0-9_-]; anything else must never reach a URL we build. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,80}$/;

export function driveFileMetaUrl(fileId, key) {
  return `${PUB_API}/files/${fileId}?fields=name,mimeType,size&key=${encodeURIComponent(key)}`;
}

/**
 * PURE + TOTAL: interpret a files.get metadata answer. Success has exactly one shape —
 * a plain object with a non-empty string `name` and no `error` envelope. Everything
 * else (proxied error envelope, HTML that slipped through as a string, null, arrays)
 * answers null: a fabricated name on a child's tile is worse than no name.
 */
export function interpretDriveFileMeta(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.error) return null;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name) return null;
  const mimeType = typeof data.mimeType === 'string' ? data.mimeType : null;
  const size = Number(data.size);
  return { name, mimeType, size: Number.isFinite(size) && size >= 0 ? size : null };
}

/**
 * PURE + TOTAL: the keyless fallback — the file's public /view page. ANCHORED shapes
 * only (the v1.0.28 lesson: a loose match on 1MB of Google HTML finds a decoy):
 * og:title / twitter:title metas, else the <title> tag minus its " - Google Drive"
 * suffix. mimeType comes from the page's own config JSON when present; a wrong kind
 * is cosmetic (the player re-detects audio at runtime), a wrong NAME is not, so the
 * name anchors stay strict.
 */
export function extractDriveFileMetaFromHtml(html) {
  const s = String(html || '');
  if (!s) return null;
  const unescape = (t) => t
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  let name = '';
  let m = s.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
    || s.match(/<meta\s+name="twitter:title"\s+content="([^"]+)"/i);
  if (m) name = unescape(m[1]).trim();
  if (!name) {
    m = s.match(/<title>([^<]+)<\/title>/i);
    if (m) name = unescape(m[1]).replace(/\s*[-–—]\s*Google\s*Drive\s*$/i, '').trim();
  }
  if (!name) return null;
  m = s.match(/"mimeType"\s*:\s*"((?:audio|video)\/[A-Za-z0-9.+-]+)"/);
  return { name, mimeType: m ? m[1] : null, size: null };
}

/**
 * Fetch a public Drive file's { name, mimeType, size } — null when unreadable (not
 * shared, offline, Google changed something). Never throws. Keyed API first, keyless
 * page scrape second; a null here is also the add flow's honest signal that the file
 * is probably NOT link-shared, which the parent must fix for playback to work at all.
 */
export async function fetchDriveFileMeta(fileId) {
  const id = String(fileId || '');
  if (!DRIVE_ID.test(id)) return null;
  const key = await defaultYtApiKey().catch(() => '');
  if (key) {
    try {
      const meta = interpretDriveFileMeta(await httpGetJson(driveFileMetaUrl(id, key)));
      if (meta) return meta;
    } catch { /* 403 (key not enabled for Drive) / 404 (not shared) / network — fall through */ }
  }
  try {
    return extractDriveFileMetaFromHtml(await httpGetText(`https://drive.google.com/file/d/${id}/view`));
  } catch { return null; }
}
