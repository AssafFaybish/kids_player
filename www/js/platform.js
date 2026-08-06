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
/**
 * v1.0.18 — mkdir FIRST. `downloadFile` ignores `recursive:true` on Android (see
 * the note under the EXTERNAL helpers below), and nothing ever created DATA/videos,
 * so media.js's whole stream→download→cache fallback threw FileNotFoundException on
 * every device, on every fresh install, for every direct-file video. It survived
 * this long because fsAvailable() is false in the browser preview, where the path
 * is never exercised. Doing it here rather than in media.js also covers clearCache()
 * removing the directory mid-session.
 */
export async function fsMkdir(path) {
  const FS = plugin('Filesystem');
  if (!FS || !path) return;
  try { await FS.mkdir({ path, directory: DIRECTORY, recursive: true }); } catch {} // exists → throws
}
export async function fsDownload(url, path) {
  const FS = plugin('Filesystem');
  const dir = String(path || '').replace(/\/[^/]*$/, '');
  if (dir && dir !== path) await fsMkdir(dir);
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
// FileNotFoundException. It DID also affect the videos/ cache in media.js; fixed
// in v1.0.18 by making fsDownload above mkdir its own parent directory.
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
 * v1.0.32 — the other half of the lifecycle, which NOTHING listened to until now.
 * Fires when the activity loses the foreground: the physical screen-off button, HOME,
 * the app switcher. Android does NOT pause the WebView, so a playing video kept its
 * soundtrack running behind a dark screen — the field report this exists for.
 * Browser fallback: hidden visibility (a background tab), for dev-preview testing.
 */
export function onAppPause(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('appStateChange', (s) => { if (s && !s.isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) fn(); });
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

/**
 * Share plain text via the OS share sheet (v1.0.5). Fallback chain: native chooser →
 * Web Share API → clipboard. Returns how it was delivered ('native' | 'web' |
 * 'clipboard' | 'none') so the caller can phrase its confirmation message.
 * A Web-Share cancel still returns 'web' — the user SAW the sheet; falling through
 * to the clipboard after an intentional cancel would be wrong.
 */
export async function shareText(text, subject = '') {
  const kids = plugin('KidsNative');
  if (kids && kids.shareText) {
    try { await kids.shareText({ text, subject }); return 'native'; } catch {}
  }
  if (typeof navigator !== 'undefined' && navigator.share) {
    try { await navigator.share({ text }); } catch { /* user cancelled */ }
    return 'web';
  }
  try { await navigator.clipboard.writeText(text); return 'clipboard'; } catch {}
  return 'none';
}

/**
 * Android TV / Google TV detection (v1.0.9) — drives the 10-foot layout and the
 * D-pad focus mode. Cached (the mode can't change mid-session). Browser preview:
 * `localStorage['tv'] = '1'` forces TV mode for keyboard-arrow testing.
 */
let tvCached = null;
export async function isTv() {
  if (tvCached !== null) return tvCached;
  try { if (localStorage.getItem('tv') === '1') { tvCached = true; return true; } } catch {}
  const kids = plugin('KidsNative');
  if (kids && kids.isTv) {
    try { tvCached = (await kids.isTv()).value === true; return tvCached; } catch {}
  }
  tvCached = false;
  return tvCached;
}

/**
 * Open an https link OUTSIDE the app (v1.0.14) — the WebView blocks external
 * navigation/popups by design, so parent-facing links need the native intent.
 * Returns true when something actually opened.
 */
export async function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  const kids = plugin('KidsNative');
  if (kids && kids.openUrl) {
    try { await kids.openUrl({ url }); return true; } catch { return false; }
  }
  try { return !!window.open(url, '_blank', 'noopener'); } catch { return false; }
}

/* ---------------- exit lock / screen pinning (v1.0.11) ---------------- */
// Kiosk mode: HOME cannot be intercepted by apps — OS lock-task is the mechanism.
// All three are graceful no-ops in the browser preview / without the plugin.
export async function lockTask() {
  const kids = plugin('KidsNative');
  if (kids && kids.lockTask) { try { await kids.lockTask(); return true; } catch {} }
  return false;
}
export async function unlockTask() {
  const kids = plugin('KidsNative');
  if (kids && kids.unlockTask) { try { await kids.unlockTask(); } catch {} }
}
export async function isTaskLocked() {
  const kids = plugin('KidsNative');
  if (kids && kids.isTaskLocked) {
    try { return (await kids.isTaskLocked()).value === true; } catch {}
  }
  return false;
}

/* ---------------- device credential (v1.0.26, parent-code recovery) ---------------- */
// The FAST path for a parent who forgot the app's code: fingerprint, or the device's own
// lock PIN. BOTH of these fail CLOSED and SILENT — in the browser preview, on an APK built
// before the plugin method existed, or on a device with no lock screen, they simply report
// "not available" and the 24-hour wait in recovery.js carries the whole feature. A thrown
// error here must never read as a successful authentication, and must never remove the
// only other way back in.

/** Can this device prove an adult is present? -> boolean. Never throws. */
export async function canDeviceAuth() {
  const kids = plugin('KidsNative');
  if (!kids || !kids.canDeviceAuth) return false;
  try { return (await kids.canDeviceAuth()).available === true; } catch { return false; }
}

/**
 * Show the prompt. -> boolean, and ONLY an explicit `ok === true` counts.
 * A cancel, a lockout, a missing plugin and a thrown bridge error are all just `false`.
 */
export async function deviceAuth(title, subtitle = '') {
  const kids = plugin('KidsNative');
  if (!kids || !kids.deviceAuth) return false;
  try { return (await kids.deviceAuth({ title, subtitle })).ok === true; } catch { return false; }
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
