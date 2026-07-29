// wake.js — keep the screen on while media plays (F7). Ref-counted by tag so the
// player, a Drive-fallback download, and the updater can hold it independently; only
// the 0→1 / 1→0 transitions touch native.
//
// Engage chain: KidsNative.keepAwake (our plugin, window-level FLAG_KEEP_SCREEN_ON —
// survives the native-fullscreen view swap, needs NO permission, auto-scoped to window
// visibility) → community KeepAwake (plan B, same flag) → navigator.wakeLock (browser
// preview only; not available in Android WebView) → no-op.
//
// NOTE: we cannot change the system screen-timeout (needs WRITE_SETTINGS) — and don't
// need to: the window flag overrides it while held, and releasing restores normal
// timeout behavior, which is exactly the requested UX.

const holders = new Set();
let sentinel = null; // browser Screen Wake Lock sentinel

function plugin(name) {
  const c = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return c && c.Plugins ? c.Plugins[name] : null;
}

async function engage() {
  const kids = plugin('KidsNative');
  if (kids && kids.keepAwake) { try { await kids.keepAwake(); return; } catch {} }
  const ka = plugin('KeepAwake');
  if (ka && ka.keepAwake) { try { await ka.keepAwake(); return; } catch {} }
  try {
    if (navigator.wakeLock && !sentinel) {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    }
  } catch {}
}

async function disengage() {
  const kids = plugin('KidsNative');
  if (kids && kids.allowSleep) { try { await kids.allowSleep(); } catch {} }
  const ka = plugin('KeepAwake');
  if (ka && ka.allowSleep) { try { await ka.allowSleep(); } catch {} }
  try { if (sentinel) { await sentinel.release(); sentinel = null; } } catch {}
}

export async function acquire(tag) {
  if (holders.has(tag)) return;
  holders.add(tag);
  if (holders.size === 1) await engage();
}

export async function release(tag) {
  if (!holders.delete(tag)) return;
  if (holders.size === 0) await disengage();
}

/** Idempotent and cheap — safe to call from a 250ms heartbeat. */
export function set(tag, on) { return on ? acquire(tag) : release(tag); }

/** Safety net (called from goGallery): whatever happened, let the screen sleep. */
export async function releaseAll() {
  holders.clear();
  await disengage();
}
