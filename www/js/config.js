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

/* Resume playback (v1.0.32) — OFF by default, per profile, synced. The POSITION itself is
   DEVICE-LOCAL and never serialized to Drive: it changes every few seconds of watching,
   and pushing that churn would rewrite the family document on every pause (the giftRank
   lesson — see drive.serializeStateEntry). */
export const RESUME_REWIND_SEC = 3;   // resume this much before the stop point (user-specified)
export const RESUME_MIN_POS_SEC = 8;  // a stop earlier than this is not worth resuming
export const RESUME_TAIL_SEC = 12;    // a stop this close to the end = finished → start over
export const RESUME_SAVE_MS = 5000;   // periodic save while playing (survives a process kill)

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

// v1.0.34 — idle screen-off. After this many minutes with NO touch/key while a video
// plays, the "עדיין צופים?" prompt shows; unanswered, the video pauses and keep-awake is
// released so the DEVICE's own display timeout can turn the screen off (an app cannot do
// that itself). DEFAULT IS ON at 10 (the user's decision — protects the panel and the
// battery when a child falls asleep mid-video); an explicit 0 = never, today's behavior.
export const SCREEN_OFF_DEFAULT_MIN = 10;
export const SCREEN_OFF_PROMPT_SEC = 45;


/* v1.0.39 — ROLLING WINDOW: keep only the newest N videos per channel.
   0 = OFF, and OFF IS THE DEFAULT. This is the only feature in the app that deletes the
   CHILD'S content, so it may never arrive with an update: a family that never opens the
   settings screen keeps every video it has. When it IS on, the sync still deletes nothing
   on its own — it only proposes, and the parent reviews per channel (the user's decision
   2026-08-09: "tell me which channel, let me mark what not to delete, or wipe it and keep
   only new ones"). */
export const KEEP_NEWEST_OFF = 0;
export const KEEP_NEWEST_SUGGESTED = 200; // what the settings field offers when turned on
// The review screen renders at most this many rows. A channel 4000 videos over the window
// would otherwise build 4000 thumbnails and read as a frozen app; the rows shown are the
// NEWEST of those proposed, i.e. the ones a parent is most likely to want to keep.
export const PRUNE_REVIEW_CAP = 200;

/* Sync */
// v1.0.37 — THESE ARE THE LIVE CAPS NOW. They existed here since the overhaul with
// ZERO consumers: the binding values were literals frozen into each profile's `sources`
// row at creation, so editing this file changed nothing and no parent could ever raise
// them. `plan.effectiveCaps` reads them as the FLOOR, which is what heals the profiles
// already carrying the old 5000.
export const MAX_ITEMS_PER_CHANNEL = 500;
// Raised 5000 → 12000 on a MEASUREMENT (2026-08-08, browser, real records): the only
// cost that grows with library size is `loadMergeIndex` — 114ms @5000, 229ms @10000,
// 468ms @20000 — and it is paid once per write-generation, not per render (the
// buildFolders cache, v1.0.20). Paging stayed FLAT (2.8ms → 7.2ms) because it is
// index-ranged. 12000 holds ~24 channels at the per-channel cap with headroom, and
// stays near a second even on a tablet several times slower than the measuring machine.
// The parent had 16 channels and a silent ceiling; that is the bug this number fixes.
export const MAX_ITEMS_TOTAL = 12000;
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
