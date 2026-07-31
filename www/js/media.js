// media.js — direct video-file playback support (hybrid: stream, then download + cache on failure).
import {
  fsAvailable, fsDownload, fsStatUri, fsRemoveDir, convertFileSrc
} from './platform.js';
import { loadItems, saveItems, setItemLocalPath } from './store.js';

const CACHE_DIR = 'videos';

function cacheName(item) {
  const base = String(item.key || item.url).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90);
  return `${CACHE_DIR}/${base}.mp4`;
}

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
    if (uri) return { src: convertFileSrc(uri), local: true };
  }
  return { src: item.url, local: false };
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
      await setVideoFields(item.scopeId, item.key, { localPath: path });
    } catch {}
  }
  await setItemLocalPath(item.key, path);
  const playable = uri ? convertFileSrc(uri) : convertFileSrc((await fsStatUri(path)) || path);
  return { src: playable, local: true };
}

// Best-effort frame grab for a thumbnail (used when a file has no parent-supplied thumb).
export function captureFrame(video) {
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 320;
    c.height = video.videoHeight || 180;
    if (!c.width || !c.height) return null;
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
