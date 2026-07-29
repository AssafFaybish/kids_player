// gauth.js — JS side of KidsGoogleAuth (Play Services AuthorizationClient).
// The access token lives IN MEMORY ONLY (~55min): Play Services regenerates it for
// free, so persisting it would create a bearer credential at rest for nothing.

let cached = null; // { token, expiresAt }

function plug() {
  const c = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return c && c.Plugins ? c.Plugins.KidsGoogleAuth : null;
}

export function gauthAvailable() { return !!plug(); }

/**
 * interactive=false NEVER pops UI — background refresh must not interrupt a child.
 * Returns the access token string, or null (null + needsUi means "ask the parent").
 */
export async function getAccessToken({ interactive = false } = {}) {
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const p = plug();
  if (!p) return null;
  try {
    const r = await p.authorize({ interactive });
    if (r && r.granted && r.accessToken) {
      cached = { token: r.accessToken, expiresAt: Date.now() + 55 * 60 * 1000 };
      return r.accessToken;
    }
  } catch {}
  return null;
}

/** Parent-screen sign-in: one system dialog, once, ever. */
export async function signIn() {
  cached = null;
  return (await getAccessToken({ interactive: true })) != null;
}

export function signOut() { cached = null; }
