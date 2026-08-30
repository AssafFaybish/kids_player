// media.js — direct video-file playback support (hybrid: stream, then download + cache on failure).
import {
  fsAvailable, fsDownload, fsStatUri, fsRemoveDir, convertFileSrc, fsDeleteFile, fsListDir
} from './platform.js';
import { loadItems, saveItems, setItemLocalPath } from './store.js';

const CACHE_DIR = 'videos';

/**
 * v1.0.56 — the cached file's extension, now that audio exists. Android's media stack
 * guesses the MIME from the extension of a file:// src, so a `.mp4` suffix on an mp3
 * (the old hardcode) is a decode gamble. PURE + exported for tests. Precedence:
 * the source URL's own real extension (direct files carry one) → the media kind
 * (Drive files have no extension anywhere) → the legacy `.mp4`.
 * Existing caches are untouched: records that already hold a localPath keep playing it.
 */
const CACHE_EXT = /\.(mp4|webm|m4v|mov|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac)(?:\?|#|$)/i;
export function cacheExtFor(item) {
  const m = String((item && item.url) || '').match(CACHE_EXT);
  if (m) return m[1].toLowerCase();
  return item && item.media === 'audio' ? 'mp3' : 'mp4';
}

export function cacheName(item) {
  const base = String(item.key || item.url).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90);
  return `${CACHE_DIR}/${base}.${cacheExtFor(item)}`;
}

/** v1.0.58 — the BARE file name (no directory), which is what fsListDir answers with. The
 *  sweep matches what is on disk against what the records own, and the two must speak the
 *  same alphabet or every file would look like an orphan and be deleted. */
export const cacheBaseName = (item) => cacheName(item).slice(CACHE_DIR.length + 1);
export const CACHE_DIR_NAME = CACHE_DIR;

// The Drive "download" host with a confirm token bypasses the virus-scan interstitial for large files.
function downloadUrlFor(item) {
  if (item.driveId) {
    return `https://drive.usercontent.google.com/download?id=${item.driveId}&export=download&confirm=t`;
  }
  return item.url;
}

// Returns { src, local }. If a cached local copy exists, uses it (works offline).
export async function prepareStreamSrc(item) {
  if (item.localPath && fsAvailable()) {
    const uri = await fsStatUri(item.localPath);
    // v1.0.58 — THE CACHE POLICY'S ONLY HONEST CLOCK. The eviction keeps what is used and
    // deletes what was forgotten (the user's decision over a blanket monthly wipe), and this
    // is the one place that knows a cached copy was actually played. DEVICE-LOCAL like
    // localPath itself: it describes a file on this tablet, so it never travels.
    if (uri) { touchLocalUse(item); return { src: convertFileSrc(uri), local: true }; }
  }
  return { src: item.url, local: false };
}

function touchLocalUse(item) {
  if (!item || !item.scopeId || !item.key) return;
  import('./db.js')
    .then((db) => db.setVideoFields(item.scopeId, item.key, { localUsedAt: Date.now() }))
    .catch(() => {});
}

// Downloads the file once to the app data dir and returns a local src. Throws if unsupported.
export async function downloadAndCache(item) {
  if (!fsAvailable()) throw new Error('download-unsupported');
  const path = cacheName(item);
  const uri = await fsDownload(downloadUrlFor(item), path);
  // Persist where prepareStreamSrc actually LOOKS. `setItemLocalPath` writes the legacy
  // Preferences blob, but `item` is an IndexedDB record — so the write matched nothing and
  // `item.localPath` stayed null, meaning every single playback re-downloaded the whole
  // file on a metered tablet connection. Kept as well, harmlessly, for pre-migration data.
  if (item.scopeId && item.key) {
    try {
      const { setVideoFields } = await import('./db.js');
      await setVideoFields(item.scopeId, item.key, { localPath: path, localUsedAt: Date.now() });
    } catch {}
  }
  await setItemLocalPath(item.key, path);
  const playable = uri ? convertFileSrc(uri) : convertFileSrc((await fsStatUri(path)) || path);
  return { src: playable, local: true };
}

// Best-effort frame grab for a thumbnail (used when a file has no parent-supplied thumb).
// v1.0.56 — NO fallback dimensions: an AUDIO file reports videoWidth 0, and the old
// `|| 320` painted nothing onto a 320×180 canvas and persisted a solid-black JPEG as the
// tile's PERMANENT thumbnail (persistThumb never retries a record that has one). No
// video track ⇒ no frame ⇒ null, and the tile keeps its placeholder + 🎵 badge.
export function captureFrame(video) {
  try {
    if (!video.videoWidth || !video.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

// Remove all downloaded files and clear localPath references.
// Removes downloaded video files and clears localPath references. Returns how many were cleared.
export async function clearCache() {
  await fsRemoveDir(CACHE_DIR);
  let count = 0;
  // IndexedDB is where localPath actually lives (see downloadAndCache). Counting only the
  // legacy Preferences list made this return 0 forever, so the parent was told
  // "אין מה לנקות" immediately after the files had in fact been deleted — and any record
  // still holding a localPath would then resolve to a file that no longer exists.
  try {
    const { openDb, setVideoFields } = await import('./db.js');
    const idb = await openDb();
    const req = idb.transaction('videos').objectStore('videos').getAll();
    const all = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    for (const rec of all || []) {
      if (!rec || !rec.localPath) continue;
      await setVideoFields(rec.scopeId, rec.key, { localPath: null });
      count += 1;
    }
  } catch {}
  const items = await loadItems();
  for (const it of items) { if (it.localPath) { delete it.localPath; count++; } }
  if (items.some((it) => !it.localPath)) await saveItems(items);
  return count;
}

/* ---------------- v1.0.58: the cache as a thing that can be measured and pruned ----------------
   Until now the only operation was `clearCache()` — all or nothing — so a video deleted from
   the app left its downloaded copy on the tablet forever, and nothing ever expired. These are
   PRIMITIVES ONLY: what to delete is decided by pure `plan.planCacheSweep`, and app.js applies
   it. Same split as db.js — I/O here, judgement there. */

/** What is actually on disk: [{ name, size, mtime }]. Empty when there is no Filesystem. */
export async function listCacheFiles() {
  if (!fsAvailable()) return [];
  return fsListDir(CACHE_DIR);
}

/** Total size of the cache, for the parent's "how much space is this" line. */
export async function cacheUsage() {
  const files = await listCacheFiles();
  return { files: files.length, bytes: files.reduce((n, f) => n + (Number(f.size) || 0), 0) };
}

/** Delete cached files BY NAME (the sweep's output). Returns how many actually went. */
export async function deleteCacheFiles(names) {
  if (!fsAvailable()) return 0;
  let n = 0;
  for (const name of names || []) {
    if (!name || String(name).includes('/')) continue; // bare names only — never a path
    if (await fsDeleteFile(`${CACHE_DIR}/${name}`)) n += 1;
  }
  return n;
}

/**
 * v1.0.58 — delete the downloaded copies of specific RECORDS and forget them (the user's
 * request: deleting a video from the app may delete it from the device too).
 *
 * It clears `localPath` even when the file was already gone: a record pointing at a file
 * that does not exist makes `prepareStreamSrc` stat a dead path on every single play.
 * Google Drive is NEVER touched — this is the tablet's copy only.
 */
export async function deleteLocalFiles(records) {
  const list = (records || []).filter((r) => r && r.localPath);
  if (!list.length) return { deleted: 0, bytes: 0 };
  const sizes = new Map((await listCacheFiles()).map((f) => [f.name, Number(f.size) || 0]));
  let deleted = 0;
  let bytes = 0;
  const { setVideoFields } = await import('./db.js');
  for (const rec of list) {
    const name = String(rec.localPath).slice(CACHE_DIR.length + 1);
    if (await fsDeleteFile(rec.localPath)) { deleted += 1; bytes += sizes.get(name) || 0; }
    try { await setVideoFields(rec.scopeId, rec.key, { localPath: null, localUsedAt: null }); } catch {}
  }
  return { deleted, bytes };
}
