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
// NOTE for operators: the shared API key must list the Google Drive API in its own API
// restrictions — see GOOGLE_CLOUD_SETUP.md שלב 5. Done on the project key 2026-08-30 and
// verified live (files.get on a bogus id answers 404 "File not found" rather than 403
// API_KEY_SERVICE_BLOCKED, and files.list returns real children). A key that is NOT
// widened still works: it answers 403, one refusal sets the session memo, and everything
// falls through to the public-page scrape — degraded, never broken. Keyless builds
// (keys.local.js is gitignored) live on that same path permanently.

import { httpGetJson, httpGetText } from './platform.js';
import { defaultYtApiKey } from './keys.js';
import { DRIVE_TREE_MAX_FOLDERS, DRIVE_TREE_MAX_FILES } from './config.js';

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

/**
 * v1.0.58 — the one name for "this entry is a FOLDER". Both doors report it: `files.list`
 * says so in `mimeType`, and the public page says so in the row's href (see
 * parseDriveFolderHtml). Everything downstream — the tree walk, the media filter — asks
 * this and never re-derives it.
 */
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
export const isDriveFolderEntry = (f) => !!f && f.mimeType === DRIVE_FOLDER_MIME;

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
   A parent can share a whole folder of songs/videos. TWO DOORS, and which one runs depends
   on the shipped key's own API restrictions:
     - KEYED (`files.list`): live since the project key was widened to include the Drive
       API (2026-08-30, verified: 200 with real children, sizes included, ~650ms). It
       paginates, so a folder of hundreds of files works.
     - KEYLESS (`embeddedfolderview`): the fallback, and the ONLY path for a build with no
       key at all. Measured to carry more than expected — the page <title> is the folder's
       own name and each row's icon URL carries the real mimeType.
   ⚠ `files.list` answers the CHILDREN only — never the folder's name — so the keyed path
   fetches that separately (keyedFolderName). Without it a folder imported through the API
   would lose the name the parent gave it in Drive. */

/** The FOLDER's own metadata — `files.list` answers children only, never the folder name. */
export function folderMetaUrl(folderId, key) {
  return `${PUB_API}/files/${folderId}?fields=name,mimeType&key=${encodeURIComponent(key)}`;
}

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
    // v1.0.58 — A SUBFOLDER IS TOLD BY ITS LINK, exactly as classify.driveFolderId tells a
    // pasted folder from a pasted file: the two id spaces are identical and ONLY the URL
    // shape separates them (`/drive/folders/<id>` vs `/file/d/<id>`). Measured on the real
    // page: a folder row carries no `/type/<mime>` icon at all, so the icon-only reading
    // this parser used to do returned `mimeType: null` for every subfolder — which is why
    // the header comment's claim that folders are "skipped here" was never actually true,
    // and why a folder of folders could not be walked.
    const isFolder = /\/drive\/folders\/[A-Za-z0-9_-]+/.test(b);
    const mm = b.match(/drive-thirdparty\.googleusercontent\.com\/\d+\/type\/([A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+)/);
    files.push({
      id: idm[1], name: fileName,
      mimeType: isFolder ? DRIVE_FOLDER_MIME : (mm ? mm[1] : null),
      size: null
    });
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
        if (!token) break;
      }
      if (out.length) return { ok: true, files: out, name: await keyedFolderName(id, key) };
      // ⚠️ v1.0.58 — AN EMPTY ANSWER FROM THIS DOOR IS NOT PROOF THAT THE FOLDER IS EMPTY,
      // and the old code returned `{ok:true, files:[]}` right here, inside the pagination
      // loop, the moment there was no nextPageToken. `files.list` answers 200 with an EMPTY
      // list — not an error — when the API key is not allowed to see into a folder that is
      // shared "anyone with the link", so a family in that state was told "התיקיה ריקה"
      // about a folder full of songs, and the public page that CAN read it was never tried.
      // The interpretSheetResponse doctrine, one level deeper: emptiness may only be
      // reported by a door that actually saw the folder's contents.
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
 * v1.0.58 — WALK A FOLDER TREE (user request: "התיקיה מכילה תיקיות של שירים… צריך לתמוך
 * בתיקיה מקוננת"). Returns every folder that holds media, each with its own files:
 *   { ok, folders: [{ id, name, depth, parentId, files }], truncated, partial, error }
 *
 * BREADTH-FIRST, and that is not a style choice: the caps below cut the walk off, and a
 * depth-first walk would spend them on one deep branch while the parent's top-level discs
 * went missing. Breadth-first means a truncated walk still holds the top of the tree —
 * the part the parent actually pasted.
 *
 * THE ROOT'S FAILURE AND A CHILD'S FAILURE ARE DIFFERENT FACTS. An unreadable ROOT is
 * `ok:false` (the parent is told to check the sharing); an unreadable CHILD sets `partial`
 * and the walk carries on, because the import is ADDITIVE — the v1.0.56 rule — so the
 * folders we could read are still worth having, and nothing is ever deleted for absence.
 *
 * `seen` is a cycle guard, not an optimisation: a Drive SHORTCUT can point at an ancestor,
 * and without it the walk would spin until the caps stopped it.
 *
 * Fetched in small WAVES rather than one at a time: 33 folders × ~650ms serial is 20
 * seconds of the parent staring at a spinner, and one at a time is the only reason it
 * would be. The width is deliberately small — this is an unauthenticated public endpoint
 * and a burst of parallel requests is how a family earns a 429.
 */
export async function fetchDriveFolderTree(rootId, {
  maxFolders = DRIVE_TREE_MAX_FOLDERS, maxFiles = DRIVE_TREE_MAX_FILES, wave = 3, onProgress = null
} = {}) {
  const root = String(rootId || '');
  if (!DRIVE_ID.test(root)) return { ok: false, folders: [], truncated: false, partial: false, error: 'bad-id' };

  const folders = [];
  const seen = new Set([root]);
  let queue = [{ id: root, name: '', depth: 0, parentId: null }];
  let fileCount = 0;
  let truncated = false;
  let partial = false;
  let rootFailed = false;

  // ⚠️ THE WALK IS BOUNDED BY LISTINGS PERFORMED, not only by the `seen` set. `seen` is the
  // cycle guard, but a guard is a thing that can break: planting its removal made this loop
  // run FOREVER (a shortcut pointing at an ancestor re-queues an id that never grows `seen`,
  // so the folder cap below is never reached) — a frozen app on a family's tablet, which is
  // a far worse failure than importing less than the folder holds. With this counter the
  // worst a broken identity check can do is truncate, and the parent is told that.
  let listed = 0;
  while (queue.length && listed < maxFolders) {
    const batch = queue.splice(0, Math.min(Math.max(1, wave), maxFolders - listed));
    listed += batch.length;
    if (queue.length) truncated = truncated || listed >= maxFolders;
    const listings = await Promise.all(batch.map((n) => fetchDriveFolder(n.id).catch(() => ({ ok: false, files: [] }))));
    for (let i = 0; i < batch.length; i++) {
      const node = batch[i];
      const listing = listings[i];
      if (!listing || !listing.ok) {
        if (node.depth === 0) rootFailed = true; else partial = true;
        continue;
      }
      const own = [];
      for (const entry of listing.files) {
        if (isDriveFolderEntry(entry)) {
          if (seen.has(entry.id) || !DRIVE_ID.test(String(entry.id || ''))) continue;
          if (seen.size >= maxFolders) { truncated = true; continue; }
          seen.add(entry.id);
          queue.push({ id: entry.id, name: entry.name, depth: node.depth + 1, parentId: node.id });
          continue;
        }
        if (fileCount >= maxFiles) { truncated = true; continue; }
        fileCount += 1;
        own.push(entry);
      }
      folders.push({
        id: node.id, name: listing.name || node.name || '',
        depth: node.depth, parentId: node.parentId, files: own
      });
      if (typeof onProgress === 'function') { try { onProgress(folders.length, seen.size); } catch {} }
    }
  }

  if (rootFailed) return { ok: false, folders: [], truncated: false, partial: false, error: 'unreadable' };
  return { ok: true, folders, truncated, partial };
}

/**
 * The folder's OWN name on the keyed path. `files.list` answers the children and nothing
 * else, so without this a folder imported through the API would be titled by the caller's
 * generic fallback instead of what the parent named it in Drive — the user's requirement
 * is that the app's folder carries the DRIVE folder's name. Best-effort: a failure here
 * degrades to that same fallback and never costs the listing.
 */
async function keyedFolderName(folderId, key) {
  try {
    const meta = interpretDriveFileMeta(await httpGetJson(folderMetaUrl(folderId, key)));
    return meta && meta.name ? meta.name : '';
  } catch { return ''; }
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
