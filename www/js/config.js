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
