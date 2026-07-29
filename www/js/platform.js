// platform.js — thin shim over Capacitor plugins with graceful browser fallbacks.
// On device (native) it uses the real plugins (Preferences, CapacitorHttp, Filesystem, App).
// In a plain browser it falls back to localStorage / fetch / no-op so the UI is testable.

function cap() { return (typeof window !== 'undefined') ? window.Capacitor : undefined; }
export const isNative = !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
function plugin(name) { const c = cap(); return c && c.Plugins ? c.Plugins[name] : null; }

/* ---------------- Preferences (persistent key/value) ---------------- */
export async function prefGet(key) {
  const P = plugin('Preferences');
  if (P) { const { value } = await P.get({ key }); return value ?? null; }
  try { return localStorage.getItem(key); } catch { return null; }
}
export async function prefSet(key, value) {
  const P = plugin('Preferences');
  if (P) return P.set({ key, value });
  try { localStorage.setItem(key, value); } catch {}
}
export async function prefRemove(key) {
  const P = plugin('Preferences');
  if (P) return P.remove({ key });
  try { localStorage.removeItem(key); } catch {}
}

/* ---------------- HTTP (native = CORS-exempt) ---------------- */
async function nativeRequest(url, responseType) {
  const CH = plugin('CapacitorHttp');
  const res = await CH.request({ method: 'GET', url, responseType });
  if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
  return res.data;
}
// Browser-only: hosts like Google block cross-origin fetch (CORS). When a direct fetch fails in a
// plain browser, retry through a public CORS proxy so the WEB PREVIEW can load remote lists.
// The installed app NEVER reaches this — it uses native CapacitorHttp above (no CORS).
const CORS_PROXIES = [
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u)
];
async function browserFetchText(url) {
  // 1) Direct (works when the host allows CORS, e.g. YouTube oEmbed).
  try { const r = await fetch(url); if (r.ok) return r.text(); } catch {}
  // 2) Same-origin dev proxy from dev-server.mjs — reliable, no CORS, no third party.
  try { const r = await fetch('/__proxy?url=' + encodeURIComponent(url)); if (r.ok) return r.text(); } catch {}
  // 3) Public CORS proxies (last resort, e.g. app served without the dev proxy).
  for (const make of CORS_PROXIES) { try { const r = await fetch(make(url)); if (r.ok) return r.text(); } catch {} }
  throw new Error('fetch-failed: ' + url);
}

/**
 * General HTTP primitive for Drive/Sheets/YouTube API calls.
 * Returns { status, headers, data } and NEVER throws on an HTTP status — callers need
 * the error body (Google APIs put the reason there). Network failure → status 0.
 *
 * ⚠ CapacitorHttp trap (verified in CapacitorHttpUrlConnection.setRequestBody): a
 * request body WITHOUT an explicit Content-Type header is silently discarded — a Drive
 * multipart upload would return 200 and create an EMPTY file. Always pass Content-Type
 * when body != null.
 */
export async function httpRequest({ method = 'GET', url, headers = {}, body = null, responseType = 'text' } = {}) {
  const CH = plugin('CapacitorHttp');
  if (CH) {
    try {
      const opts = { method, url, headers, responseType };
      if (body != null) opts.data = body;
      const res = await CH.request(opts);
      return { status: res.status || 0, headers: res.headers || {}, data: res.data };
    } catch (e) {
      return { status: 0, headers: {}, data: null, error: String((e && e.message) || e) };
    }
  }
  try {
    const r = await fetch(url, { method, headers, body: body ?? undefined });
    const data = responseType === 'json' ? await r.json().catch(() => null) : await r.text();
    const h = {};
    r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { status: r.status, headers: h, data };
  } catch (e) {
    return { status: 0, headers: {}, data: null, error: String((e && e.message) || e) };
  }
}

export async function httpGetText(url) {
  if (plugin('CapacitorHttp')) {
    const data = await nativeRequest(url, 'text');
    return typeof data === 'string' ? data : JSON.stringify(data);
  }
  return browserFetchText(url);
}
export async function httpGetJson(url) {
  if (plugin('CapacitorHttp')) {
    const data = await nativeRequest(url, 'json');
    return typeof data === 'string' ? JSON.parse(data) : data;
  }
  return JSON.parse(await browserFetchText(url));
}

/* ---------------- Filesystem (download + cache) ---------------- */
const DIRECTORY = 'DATA';
export const fsAvailable = () => !!plugin('Filesystem');

export function convertFileSrc(uri) {
  const c = cap();
  return c && c.convertFileSrc ? c.convertFileSrc(uri) : uri;
}
export async function fsDownload(url, path) {
  const FS = plugin('Filesystem');
  const res = await FS.downloadFile({ url, path, directory: DIRECTORY, recursive: true });
  return res.path || null; // native file URI
}
export async function fsStatUri(path) {
  const FS = plugin('Filesystem');
  if (!FS) return null;
  try { const st = await FS.stat({ path, directory: DIRECTORY }); return st.uri || null; }
  catch { return null; }
}
export async function fsRemoveDir(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.rmdir({ path, directory: DIRECTORY, recursive: true }); } catch {}
}

/* ---------- EXTERNAL dir (updater downloads; survives the unknown-sources detour) ---------- */
// ⚠ Filesystem.downloadFile IGNORES recursive:true on Android (verified in
// @capacitor/filesystem source) — mkdir first or the first download throws
// FileNotFoundException. This likely also affects the videos/ cache in media.js.
export async function fsMkdirExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.mkdir({ path, directory: 'EXTERNAL', recursive: true }); } catch {}
}
export async function fsStatExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return null;
  try { return await FS.stat({ path, directory: 'EXTERNAL' }); } catch { return null; }
}
export async function fsDeleteExternal(path) {
  const FS = plugin('Filesystem');
  if (!FS) return;
  try { await FS.deleteFile({ path, directory: 'EXTERNAL' }); } catch {}
}
export async function fsDownloadExternal(url, path, onProgress) {
  const FS = plugin('Filesystem');
  if (!FS) throw new Error('no-filesystem');
  let sub = null;
  if (onProgress && FS.addListener) {
    sub = await FS.addListener('progress', (p) => {
      if (p && p.url === url) { try { onProgress(p.bytes, p.contentLength); } catch {} }
    });
  }
  try {
    const res = await FS.downloadFile({ url, path, directory: 'EXTERNAL', progress: !!onProgress });
    return res.path || null; // bare absolute path — hand straight to installApk
  } finally {
    if (sub) try { sub.remove(); } catch {}
  }
}
export function appPlugin() { return plugin('App'); }

/* ---------------- App lifecycle (resume / back / exit) ---------------- */
export function onAppResume(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('appStateChange', (s) => { if (s && s.isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
}

/**
 * Android hardware back. NOTE: registering this listener disables Capacitor's default
 * back handling entirely — the handler MUST consume every case (nav.handleBack does).
 * Browser fallback: Escape key, for dev-preview testing.
 */
export function onBackButton(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('backButton', () => fn());
    return;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fn(); });
}

export function exitApp() {
  // Prefer the native KidsNative.exitApp: App.exitApp() only calls finish(), which on
  // real devices leaves the task in recents — "exit" looked like minimize (v1.0.4 fix).
  // finishAndRemoveTask() + delayed process kill actually closes the app.
  const kids = plugin('KidsNative');
  if (kids && kids.exitApp) { Promise.resolve(kids.exitApp()).catch(() => {}); return; }
  const App = plugin('App');
  if (App && App.exitApp) { App.exitApp(); return; }
  try { window.close(); } catch {}
}
