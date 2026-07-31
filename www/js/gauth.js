// gauth.js — JS side of KidsGoogleAuth (Play Services AuthorizationClient).
// The access token lives IN MEMORY ONLY (~55min): Play Services regenerates it for
// free, so persisting it would create a bearer credential at rest for nothing.

let cached = null; // { token, expiresAt }
let lastError = null; // why the last sign-in failed — feeds a SPECIFIC parent-facing message
let inFlight = null; // one authorize() at a time — two taps must not pop two system dialogs

/**
 * PURE (v1.0.22): is the cached token usable?
 * The 55-minute lifetime is OUR GUESS — `authorize()` returns no expiry — so the cache is
 * only ever an optimisation and callers must be able to invalidate it. Before this, a
 * token revoked in the parent's Google account (or rotated early by Play Services) kept
 * being handed out for up to 55 minutes: every Drive and Sheets call 401'd, and because
 * an unreadable remote used to be merged as "no remote", that was the most likely
 * real-world trigger for overwriting the family's whole backup.
 * `skewMs` retires it early so a call cannot start with 2 seconds of validity left.
 */
export function tokenCacheState(entry, now = Date.now(), { skewMs = 60 * 1000 } = {}) {
  if (!entry || !entry.token) return 'none';
  return now < Number(entry.expiresAt || 0) - skewMs ? 'fresh' : 'stale';
}

/** Drop the cached token. Callers MUST do this on a 401 — see tokenCacheState. */
export function invalidateToken(reason = '') {
  cached = null;
  if (reason) lastError = String(reason);
}

function plug() {
  const c = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return c && c.Plugins ? c.Plugins.KidsGoogleAuth : null;
}

export function gauthAvailable() { return !!plug(); }

/** 'no-plugin' | 'declined' | 'auth-unavailable:<code>' (10 = not registered in Google Cloud) */
export function lastAuthError() { return lastError; }

/**
 * interactive=false NEVER pops UI — background refresh must not interrupt a child.
 * Returns the access token string, or null (null + needsUi means "ask the parent").
 */
export async function getAccessToken({ interactive = false } = {}) {
  if (tokenCacheState(cached) === 'fresh') return cached.token;
  const p = plug();
  if (!p) { lastError = 'no-plugin'; return null; }
  // Share one authorize() between concurrent callers: the sync, the sheet flush and the
  // parent screen can all ask at once, and an interactive call pops a SYSTEM dialog.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await p.authorize({ interactive });
      if (r && r.granted && r.accessToken) {
        cached = { token: r.accessToken, expiresAt: Date.now() + 55 * 60 * 1000 };
        lastError = null;
        return r.accessToken;
      }
      lastError = 'declined'; // consent UI shown and dismissed/denied
    } catch (e) {
      lastError = String((e && e.message) || e); // e.g. auth-unavailable:10
    }
    return null;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Parent-screen sign-in: one system dialog, once, ever. */
export async function signIn() {
  cached = null;
  return (await getAccessToken({ interactive: true })) != null;
}

export function signOut() { cached = null; }
