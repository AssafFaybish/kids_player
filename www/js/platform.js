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

/* ---------------- App lifecycle (resume) ---------------- */
export function onAppResume(fn) {
  const App = plugin('App');
  if (App && App.addListener) {
    App.addListener('appStateChange', (s) => { if (s && s.isActive) fn(); });
    return;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fn(); });
}
