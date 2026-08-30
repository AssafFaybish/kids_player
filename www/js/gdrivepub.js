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

/**
 * Has the shared key been REFUSED for the Drive API in this session?
 *
 * Measured 2026-08-29: the real key is restricted to YouTube Data API v3, so every Drive
 * call answers `403 API_KEY_SERVICE_BLOCKED` — and the browser transport then walks its
 * whole fallback ladder (direct → dev proxy → two CORS proxies) before giving up, on every
 * file and every folder refresh. One refusal is enough to know; the keyless door is not a
 * degraded path here, it is the one that works until an operator adds the Drive API to the
 * key's own API restrictions (GOOGLE_CLOUD_SETUP שלב 5).
 *
 * Session-scoped ON PURPOSE: a parent who fixes the key gets the fast path back on the
 * next launch, and nothing durable is written about a state we only inferred.
 */
let driveKeyRefused = false;
export function noteDriveKeyRefused() { driveKeyRefused = true; }
export function driveKeyUsable() { return !driveKeyRefused; }

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

/* ---------------- folders ----------------
   A parent can share a whole folder of songs/videos. Two doors, and the KEYLESS one is
   the load-bearing one: `files.list` (and `files.get`) answer 403 API_KEY_SERVICE_BLOCKED
   unless the shared key has the Drive API in its own API restrictions — measured live
   2026-08-29 against the real key, which is still YouTube-only. So the embedded folder
   view is what actually works today, and the keyed path is the upgrade. */

export function folderListUrl(folderId, key, pageToken = '') {
  const q = `'${folderId}' in parents and trashed=false`;
  return `${PUB_API}/files?q=${encodeURIComponent(q)}` +
    '&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=200' +
    (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '') +
    '&key=' + encodeURIComponent(key);
}

/** The server-rendered listing of a public folder — no key, no OAuth. */
export function embeddedFolderUrl(folderId) {
  return `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
}

/** PURE + TOTAL: the keyed files.list answer → [{id,name,mimeType,size}] + nextPageToken. */
export function interpretDriveFolderList(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) return null;
  if (!Array.isArray(data.files)) return null;
  const files = [];
  for (const f of data.files) {
    if (!f || typeof f.id !== 'string' || !DRIVE_ID.test(f.id)) continue;
    const name = typeof f.name === 'string' ? f.name.trim() : '';
    if (!name) continue;
    const size = Number(f.size);
    files.push({
      id: f.id, name,
      mimeType: typeof f.mimeType === 'string' ? f.mimeType : null,
      size: Number.isFinite(size) && size >= 0 ? size : null
    });
  }
  return { files, nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : '' };
}

/**
 * PURE + TOTAL: the embedded folder view's HTML → the same shape. Parsed PER ENTRY BLOCK,
 * never by pairing three independent global matches: a single entry missing its title
 * would otherwise shift every later name onto the wrong file, silently.
 *
 * The markup (measured live against a real public folder):
 *   <div class="flip-entry" id="entry-<FILE_ID>"> …
 *     <div class="flip-entry-list-icon"><img src="…/16/type/<MIME>" …>
 *     <div class="flip-entry-title"><NAME></div>
 * The icon URL carrying the real mimeType is what makes the keyless door as good as the
 * keyed one — a SUBFOLDER is `application/vnd.google-apps.folder` and is skipped here.
 */
export function parseDriveFolderHtml(html) {
  const s = String(html || '');
  if (!s) return null;
  // the page's <title> IS the folder's own name (measured) — that is the folder tile's
  // title, and there is no other keyless source for it
  const tm = s.match(/<title>([^<]*)<\/title>/);
  const folderName = tm ? decodeEntities(tm[1]) : '';
  // AN EMPTY FOLDER AND AN UNREADABLE PAGE ARE DIFFERENT FACTS (interpretSheetResponse
  // doctrine). The container classes are what the page carries either way — measured live:
  // `flip-contents` / `flip-entries` wrap the list even when it holds nothing. Without a
  // marker like this, a sign-in interstitial and an empty folder both answer "no entries".
  const recognized = /flip-entries|flip-contents/.test(s);
  const blocks = s.split('<div class="flip-entry"').slice(1);
  if (!blocks.length) return recognized ? { files: [], nextPageToken: '', name: folderName } : null;
  const files = [];
  for (const b of blocks) {
    const idm = b.match(/id="entry-([A-Za-z0-9_-]+)"/) || b.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const nm = b.match(/<div class="flip-entry-title">([^<]*)<\/div>/);
    if (!idm || !nm || !DRIVE_ID.test(idm[1])) continue;
    const fileName = decodeEntities(nm[1]);
    if (!fileName) continue;
    const mm = b.match(/drive-thirdparty\.googleusercontent\.com\/\d+\/type\/([A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+)/);
    files.push({ id: idm[1], name: fileName, mimeType: mm ? mm[1] : null, size: null });
  }
  return { files, nextPageToken: '', name: folderName };
}

/** entity-decode one embedded-view label */
function decodeEntities(raw) {
  return String(raw || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // LAST: "&amp;lt;" must not become "<"
    .trim();
}

/**
 * List a public Drive folder. Returns { ok, files } — `ok:false` means we could NOT read
 * it, which is NEVER the same as an empty folder (the interpretSheetResponse doctrine:
 * an unreadable answer that reads as "empty" is how a sync deletes a family's content).
 * Keyed first when the key can actually do it, the public page always as the fallback.
 */
export async function fetchDriveFolder(folderId) {
  const id = String(folderId || '');
  if (!DRIVE_ID.test(id)) return { ok: false, files: [], error: 'bad-id' };
  const key = driveKeyUsable() ? await defaultYtApiKey().catch(() => '') : '';
  if (key) {
    try {
      const out = [];
      let token = '';
      for (let page = 0; page < 10; page++) { // bounded: 2000 files is far past sane
        const got = interpretDriveFolderList(await httpGetJson(folderListUrl(id, key, token)));
        if (!got) { noteDriveKeyRefused(); out.length = 0; break; } // blocked/changed shape
        out.push(...got.files);
        token = got.nextPageToken;
        // the keyed listing carries no folder NAME (files.list answers children only), so
        // the caller falls back to its own default — see importDriveFolder
        if (!token) return { ok: true, files: out, name: '' };
      }
      if (out.length) return { ok: true, files: out, name: '' };
    } catch { noteDriveKeyRefused(); /* fall through to the keyless door */ }
  }
  try {
    const got = parseDriveFolderHtml(await httpGetText(embeddedFolderUrl(id)));
    if (!got) return { ok: false, files: [], name: '', error: 'unreadable' };
    // `name` is the folder's own title — the tile has no other keyless source for it
    return { ok: true, files: got.files, name: got.name || '' };
  } catch {
    return { ok: false, files: [], name: '', error: 'network' };
  }
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
  const key = driveKeyUsable() ? await defaultYtApiKey().catch(() => '') : '';
  if (key) {
    try {
      const meta = interpretDriveFileMeta(await httpGetJson(driveFileMetaUrl(id, key)));
      if (meta) return meta;
      noteDriveKeyRefused(); // a null here is a blocked key far more often than a bad id
    } catch { noteDriveKeyRefused(); /* 403 blocked / 404 not shared / network */ }
  }
  try {
    return extractDriveFileMetaFromHtml(await httpGetText(`https://drive.google.com/file/d/${id}/view`));
  } catch { return null; }
}
