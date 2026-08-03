// config.js — app-wide constants. No imports, no I/O.

/* Page sizes (grid layouts are 3 columns) */
export const PAGE_FOLDERS = 6;   // home: 3×2, must never scroll
export const PAGE_VIDEOS = 15;   // folder grid: 3×5 (matches the original gallery)
export const PAGE_WATCH = 6;     // under the player: 3×2, one flick to see all

/* Player HUD (F1) */
export const HUD_HIDE_MS = 3000;     // controls auto-hide after 3s while playing
export const SEEK_STEP = 10;         // double-tap seek, seconds (YouTube muscle memory)
// INVARIANT: TAP_SINGLE_DELAY >= TAP_DOUBLE_MS, or a slow double-tap both pauses AND seeks.
export const TAP_DOUBLE_MS = 260;
export const TAP_SINGLE_DELAY = 280;

/* Continuous play (v1.0.25) — OFF by default, per profile, synced.
   The countdown is the child's only visible way out of a chain: it must be long enough
   for a 5-year-old to notice the screen changed and reach the stop button, and short
   enough not to feel like the video froze. */
export const AUTOPLAY_COUNTDOWN_MS = 5000;
export const AUTOPLAY_RETRY_MS = 4000;   // one retry of the SAME video before moving on
// INVARIANT: a chain must be able to END. Without a ceiling, a library with a run of
// unplayable videos would flip through black screens indefinitely.
export const AUTOPLAY_MAX_FAILURES = 5;

/* Rejected archive (v1.0.26) — a rejection is recoverable for this long, then the record
   is permanently deleted (delete + deny tombstone, exactly what "מחק לצמיתות" does).
   Long enough that a parent who changes their mind has a real window; short enough that
   the archive does not become a second library nobody prunes. */
export const REJECTED_TTL_DAYS = 30;

// v1.0.26 — how long a parent who forgot the code waits before it can be reset.
// Long enough that a child will not sit through it, short enough that a locked-out parent
// gets back in the next day. The wait is the UNIVERSAL path: it needs no device lock, no
// permission and no network, so it also covers Android TV and the many children's tablets
// that have no lock screen at all.
export const PIN_RECOVERY_DELAY_HOURS = 24;

// v1.0.31 — scheduled per-profile lock ("time to do something else"). Both are PER PROFILE
// and SYNCED. `AFTER` 0 = the feature is off for that child (the default). A nonsense
// DURATION falls back to this default rather than to 0 (a 0 would unlock instantly).
export const SCHED_LOCK_DEFAULT_DURATION_MIN = 20;


/* Sync */
export const MAX_ITEMS_PER_CHANNEL = 500;
export const MAX_ITEMS_TOTAL = 5000;
export const QUOTA_DAILY_SOFT_CAP = 8000; // pause backfill before a hard 403

/*
 * Hybrid YouTube Data API key (decision 23): a baked-in default ships in the APK so
 * the family gets full channel history with zero setup; the parent screen can override
 * it (Preferences 'yt:apiKey' wins). The key itself is NOT committed — the repo is
 * public. It lives in the gitignored www/js/keys.local.js, resolved via keys.js.
 * NEVER serialize it into the Drive DB or the Sheet mirror.
 */

/* Profile avatars (moved from app.js) */
export const AVATARS = [
  { e: '🦁', c: '#ffd166' }, { e: '🐼', c: '#cdd6ea' }, { e: '🐰', c: '#ffc9de' },
  { e: '🦊', c: '#ffb37a' }, { e: '🐸', c: '#b8e994' }, { e: '🐵', c: '#e6c79c' },
  { e: '🐯', c: '#ffcf6b' }, { e: '🦄', c: '#e4c1f9' }, { e: '🐙', c: '#ff9aa2' },
  { e: '🐧', c: '#a0c4ff' }, { e: '🐨', c: '#d7d7d7' }, { e: '🐬', c: '#8fd0e0' }
];
