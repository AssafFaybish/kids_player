// playerlogic.js — the PURE decisions behind player.js (v1.0.22).
//
// player.js is 400 lines of DOM, timers and two vendor adapters, so it had no tests at
// all while carrying the longest hard-invariant block in CLAUDE.md. The arithmetic and the
// exit decision are the parts that misbehave on a real device, and they are pure — so they
// live here and are node-tested. Exactly the same split as spatial.js ← ui/dpad.js.
//
// Imports NOTHING but config.js (which imports nothing), so this sits safely in the
// `store/classify/csv/util` band and can be imported by player.js and ui/dpad.js alike.
import { SEEK_STEP, AUTOPLAY_MAX_FAILURES } from './config.js';

/**
 * Clamp a seek target into the video.
 *
 * WHY: every forward seek was `getTime() + SEEK_STEP` with no upper bound. Seeking past
 * the end makes YouTube fire ENDED, which runs `finish()` → `onExit` → `leaveWatch()`, so
 * a child pressing ⏩ near the end was EJECTED from the video instead of arriving at its
 * last seconds. `endGuard` stops just short so the player does not treat the seek itself
 * as "finished".
 *
 * A non-finite or unknown duration (live stream, metadata not in yet) means "no upper
 * bound known" — clamp at 0 below and leave the target alone above.
 */
export function clampSeek(target, duration, { endGuard = 0.5 } = {}) {
  const t = Number(target);
  if (!Number.isFinite(t)) return 0;
  const lo = Math.max(0, t);
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return lo;
  return Math.min(lo, Math.max(0, d - endGuard));
}

/** Fraction along the seek bar for a pointer x. Zero-width rect ⇒ 0, never NaN. */
export function fractionFromX(clientX, rectLeft, rectWidth) {
  const w = Number(rectWidth);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const f = (Number(clientX) - Number(rectLeft)) / w;
  if (!Number.isFinite(f)) return 0;
  return Math.max(0, Math.min(1, f));
}

/** Progress percentage for the HUD fill. Unknown duration ⇒ 0. */
export function progressPct(time, duration) {
  const d = Number(duration);
  const t = Number(time);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(100, (t / d) * 100));
}

/**
 * Should the near-end poll end this video and return the child to where they came from?
 *
 * The point is to leave BEFORE YouTube's end-screen recommendations — the app exists to
 * keep the child away from those. The hard part is the YouTube→YouTube reuse path: right
 * after `loadVideoById`, `getDuration()` briefly still reports the PREVIOUS video while
 * `getCurrentTime()` is ~0, so a naive tail check fires instantly and bounces the child
 * out of the video they just chose.
 *
 * Two independent guards, because the wall clock alone is a bet on network latency:
 *  - `now - swapAt > graceMs` — a swap that just happened is never trusted;
 *  - `reportedId === expectedId` — when the player can tell us WHICH video it is playing,
 *    that is authoritative and a slow swap can no longer be mistaken for a tail. Unknown
 *    ids fall back to the clock rather than blocking playback forever.
 */
export function shouldFinishNearEnd({
  duration, current, now, swapAt = 0, expectedId = null, reportedId = null,
  graceMs = 1200, tailSec = 1.5, minProgressSec = 0.5
} = {}) {
  const d = Number(duration);
  const c = Number(current);
  if (!Number.isFinite(d) || d <= 0) return false;   // live stream / metadata not ready
  if (!Number.isFinite(c) || c <= minProgressSec) return false; // no real progress yet
  if (d - c > tailSec) return false;                 // not in the tail
  if (expectedId && reportedId && expectedId !== reportedId) return false; // stale swap
  return Number(now) - Number(swapAt || 0) > graceMs;
}

/**
 * v1.0.25 — PURE: a video just ended. Play the next one, retry this one, or stop?
 *
 * Continuous play is OFF by default and set per child, because "one more video" is a
 * parenting decision and not a device preference.
 *
 * THE 🎁 RULE. The gift folder is never chained, whatever the setting says. Opening a
 * gift is a one-way, permanent act (`unwrappedAt` is min-merged forever, across every
 * device), so an unattended chain would unwrap the child's entire queue of new videos in
 * one sitting with no way to put them back. The parent's decision, 2026-08-02.
 *
 * FAILURE HANDLING. `finish()` fires for a broken video too, so a naive chain skips
 * through dead content invisibly. One retry of the same video absorbs a blip; after that
 * we move on; and a RUN of failures ends the chain rather than flipping through black
 * screens. `failures` counts CONSECUTIVE failures — a video that plays resets it.
 *
 * @param enabled        the profile's continuous-play setting
 * @param folderId       the folder the under-player grid is paging ('new' is 🎁)
 * @param reason         'ended' | 'error', straight from player.js
 * @param failures       consecutive failures so far in this chain
 * @param retriedCurrent has this video already been retried once?
 * @param hasNext        is there another video after this one in the folder?
 * @param nextIsGift     is the next video still a WRAPPED gift?
 */
export function planAutoplay({
  enabled = false, folderId = null, reason = 'ended',
  failures = 0, retriedCurrent = false, hasNext = true, nextIsGift = false
} = {}) {
  if (!enabled) return { action: 'stop', reason: 'disabled' };
  if (folderId === 'new') return { action: 'stop', reason: 'gift' };
  // A wrapped gift can sit in ANY folder, not just 🎁 — the gift state lives per child on
  // the video, so a channel folder shows wrapped tiles too. The first TAP on one unwraps
  // it and deliberately does not play; a chain that just played it would both skip the
  // ritual and leave the tile wrapped forever while its video had already been watched.
  // Stopping hands the choice back to the child, which is what a gift is for.
  if (hasNext && nextIsGift) return { action: 'stop', reason: 'next-is-gift' };
  if (reason === 'error') {
    const n = Number(failures) || 0;
    if (n + 1 >= AUTOPLAY_MAX_FAILURES) return { action: 'stop', reason: 'too-many-failures' };
    if (!retriedCurrent) return { action: 'retry', reason: 'first-failure' };
    if (!hasNext) return { action: 'stop', reason: 'end-of-folder' };
    return { action: 'next', reason: 'skip-broken' };
  }
  if (!hasNext) return { action: 'stop', reason: 'end-of-folder' };
  return { action: 'next', reason: 'ended' };
}

/**
 * PURE: the video after `key` in the order the child is actually looking at.
 * The grid renders newest-first, so "next" is the tile that follows on screen — any other
 * order would make the chain disagree with what the child can see.
 * A key that is not in the list (deleted mid-play, or a different folder) has no next.
 */
export function nextInOrder(items, key) {
  const list = Array.isArray(items) ? items.filter((v) => v && v.key) : [];
  const i = list.findIndex((v) => v.key === key);
  if (i < 0 || i + 1 >= list.length) return null;
  return list[i + 1];
}

/**
 * The TV remote's intent for one key press. Kept here so the repeat rule and the seek
 * clamp cannot drift between the touch and remote paths.
 * A HELD key auto-repeats at ~30/s on Android TV; scrubbing on every one of those jumped
 * minutes per second and could run past the end (see clampSeek), so a repeat only reveals.
 */
export function tvKeyIntent(action, { time = 0, duration = 0, repeat = false } = {}) {
  if (repeat) return { kind: 'reveal' };
  if (action === 'toggle') return { kind: 'toggle' };
  if (action === 'reveal') return { kind: 'reveal' };
  if (action === 'back') {
    return { kind: 'seek', to: clampSeek(Number(time) - SEEK_STEP, duration), flash: '⏪ ' + SEEK_STEP };
  }
  if (action === 'fwd') {
    return { kind: 'seek', to: clampSeek(Number(time) + SEEK_STEP, duration), flash: SEEK_STEP + ' ⏩' };
  }
  return { kind: 'ignore' }; // dpad relies on a falsy result to NOT preventDefault
}
