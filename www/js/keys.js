// keys.js — resolves the baked-in default YouTube API key WITHOUT committing it to
// source (the GitHub repo is public; a committed key would be world-readable).
// The real key lives in www/js/keys.local.js — gitignored, but still shipped inside
// the APK: `cap copy` copies www/ wholesale and does not consult .gitignore.
// Missing file (fresh clone) → '' → the app runs in keyless RSS-only mode, by design.

let cached = null;

export async function defaultYtApiKey() {
  if (cached !== null) return cached;
  try {
    const m = await import('./keys.local.js');
    cached = m.DEFAULT_YT_API_KEY || '';
  } catch {
    cached = '';
  }
  return cached;
}
