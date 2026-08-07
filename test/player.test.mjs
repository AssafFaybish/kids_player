// playerlogic.js — the pure decisions behind player.js (v1.0.22). Until now player.js had
// NO tests at all while carrying the longest hard-invariant block in CLAUDE.md, and every
// bug these cover was found by reading it, not by the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSeek, fractionFromX, formatTime, progressPct, shouldFinishNearEnd, tvKeyIntent,
  planAutoplay, nextInOrder, previewEmbedUrl, previewBubbleButtons,
  resumeStartAt, resumeSaveDecision, watchedFraction } from '../www/js/playerlogic.js';
import { SEEK_STEP, TAP_DOUBLE_MS, TAP_SINGLE_DELAY,
  AUTOPLAY_MAX_FAILURES, AUTOPLAY_COUNTDOWN_MS, AUTOPLAY_RETRY_MS,
  RESUME_REWIND_SEC, RESUME_MIN_POS_SEC, RESUME_TAIL_SEC } from '../www/js/config.js';

test('clampSeek never runs past the end — a forward seek must not EJECT the child', () => {
  // Every forward seek was `getTime() + SEEK_STEP` unbounded. Past the end YouTube fires
  // ENDED, which runs finish() -> onExit -> leaveWatch(), so pressing ⏩ near the end threw
  // the child out of the video instead of taking them to its last seconds.
  assert.equal(clampSeek(195, 200), 195);
  assert.equal(clampSeek(200, 200), 199.5, 'landed exactly on the end');
  assert.equal(clampSeek(1e9, 200), 199.5);
  assert.equal(clampSeek(-5, 200), 0, 'and never before the start');
  // an UNKNOWN duration (live stream, metadata not in yet) must not clamp to 0 —
  // that would silently rewind instead of seeking
  assert.equal(clampSeek(120, 0), 120);
  assert.equal(clampSeek(120, NaN), 120);
  assert.equal(clampSeek(120, undefined), 120);
  // junk never produces NaN, which would make seekTo() throw inside the player adapter
  for (const junk of [NaN, undefined, null, 'x', {}]) assert.equal(clampSeek(junk, 200), 0, String(junk));
  // a very short video still yields something inside it
  assert.ok(clampSeek(99, 1) >= 0 && clampSeek(99, 1) <= 1);
});

test('fractionFromX and progressPct are NaN-proof (a zero-width rect is real)', () => {
  assert.equal(fractionFromX(50, 0, 100), 0.5);
  assert.equal(fractionFromX(-10, 0, 100), 0);
  assert.equal(fractionFromX(999, 0, 100), 1);
  // the seek bar is measured while the HUD is hidden / mid-layout, where width is 0.
  // NaN here would propagate into seekTo() and into the CSS width of the fill.
  assert.equal(fractionFromX(50, 0, 0), 0);
  assert.equal(fractionFromX(50, 0, NaN), 0);
  assert.equal(progressPct(50, 100), 50);
  assert.equal(progressPct(0, 0), 0);
  assert.equal(progressPct(10, NaN), 0);
  assert.equal(progressPct(999, 100), 100, 'never exceeds 100% (a bar wider than its track)');
  assert.equal(progressPct(-5, 100), 0);
});

test('shouldFinishNearEnd: leaves at the tail, but NEVER right after a video swap', () => {
  const base = { duration: 180, current: 179, now: 100000, swapAt: 0 };
  assert.equal(shouldFinishNearEnd(base), true, 'a real tail must end the video');

  // THE bug this guards: after loadVideoById, getDuration() briefly still reports the OLD
  // video while getCurrentTime() is ~0. Naively that reads as "1.5s from the end" and the
  // child is bounced out of the video they just picked.
  assert.equal(shouldFinishNearEnd({ ...base, current: 0.2 }), false, 'no real progress yet');
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 99500 }), false, 'inside the swap grace');

  // the id check is the authoritative guard — a SLOW swap outlives the wall clock
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 98000, expectedId: 'B', reportedId: 'A' }), false,
    'the player is still reporting the previous video');
  assert.equal(shouldFinishNearEnd({ ...base, swapAt: 98000, expectedId: 'B', reportedId: 'B' }), true);
  // …and an unknown id must fall back to the clock, never block playback forever
  assert.equal(shouldFinishNearEnd({ ...base, expectedId: 'B', reportedId: null }), true);

  // a live stream / not-ready metadata reports duration 0 — ending there would kick the
  // child out the instant they opened it
  assert.equal(shouldFinishNearEnd({ ...base, duration: 0 }), false);
  assert.equal(shouldFinishNearEnd({ ...base, duration: NaN }), false);
  assert.equal(shouldFinishNearEnd({ ...base, current: NaN }), false);
  // mid-video is not the tail
  assert.equal(shouldFinishNearEnd({ ...base, current: 90 }), false);
  assert.equal(shouldFinishNearEnd({}), false, 'junk in never ends a video');
});

test('tvKeyIntent: a HELD remote key reveals, it does not scrub minutes', () => {
  // Android TV auto-repeats at ~30/s. Each event was a full ±10s seek, so one second on
  // the arrow jumped ~4 minutes — and running past the end ejected the child.
  assert.deepEqual(tvKeyIntent('fwd', { time: 10, duration: 200, repeat: true }), { kind: 'reveal' });
  assert.deepEqual(tvKeyIntent('back', { time: 10, duration: 200, repeat: true }), { kind: 'reveal' });
  assert.deepEqual(tvKeyIntent('toggle', { repeat: true }), { kind: 'reveal' });

  const fwd = tvKeyIntent('fwd', { time: 10, duration: 200 });
  assert.equal(fwd.kind, 'seek');
  assert.equal(fwd.to, 10 + SEEK_STEP);
  // clamped, exactly like the touch path
  assert.equal(tvKeyIntent('fwd', { time: 199, duration: 200 }).to, 199.5);
  assert.equal(tvKeyIntent('back', { time: 2, duration: 200 }).to, 0);
  assert.equal(tvKeyIntent('toggle', {}).kind, 'toggle');
  assert.equal(tvKeyIntent('reveal', {}).kind, 'reveal');
  // an unknown action must be IGNORED: dpad.js relies on a falsy handleTvKey() to leave
  // the key to the browser instead of preventDefault()ing it
  assert.equal(tvKeyIntent('nope', {}).kind, 'ignore');
  assert.equal(tvKeyIntent(undefined, {}).kind, 'ignore');
});

test('the tap constants still make a slow double-tap unambiguous', () => {
  // Pinned in config.test.mjs too, restated here because playerlogic/player.js is what
  // consumes them: if the single-tap delay were shorter than the double-tap window, a slow
  // double-tap would BOTH pause and seek.
  assert.ok(TAP_SINGLE_DELAY >= TAP_DOUBLE_MS, `${TAP_SINGLE_DELAY} < ${TAP_DOUBLE_MS}`);
  assert.ok(SEEK_STEP > 0);
});

/* ---------------- continuous play (v1.0.25) ---------------- */

const chain = (over = {}) => planAutoplay({ enabled: true, folderId: 'ch:UC1', ...over });

test('continuous play is OFF unless the parent turned it on', () => {
  // Default off is the whole safety position: a family that never opens the settings
  // screen keeps today's behaviour, where a video ending returns the child to the folder.
  assert.deepEqual(planAutoplay(), { action: 'stop', reason: 'disabled' });
  assert.deepEqual(planAutoplay({}), { action: 'stop', reason: 'disabled' });
  assert.equal(planAutoplay({ enabled: false, folderId: 'ch:UC1' }).action, 'stop');
  // …and being off outranks everything else, including a perfectly good next video
  assert.equal(planAutoplay({ enabled: false, hasNext: true, reason: 'ended' }).action, 'stop');
});

test('the 🎁 folder is NEVER chained, whatever the setting says', () => {
  // Unwrapping is one-way and permanent (unwrappedAt is min-merged forever, on every
  // device), so an unattended chain would open the child's whole queue of new videos in
  // one sitting with no way to put them back. Parent's decision, 2026-08-02.
  assert.deepEqual(chain({ folderId: 'new' }), { action: 'stop', reason: 'gift' });
  assert.equal(chain({ folderId: 'new', hasNext: true }).action, 'stop');
  assert.equal(chain({ folderId: 'new', reason: 'error' }).action, 'stop',
    'even a failure in the gift folder must not start a chain');
});

test('a chain STOPS at a wrapped gift, in any folder', () => {
  // Gift state lives per child on the video, so wrapped tiles appear inside channel
  // folders too — not only in 🎁. The first TAP on one unwraps it and deliberately does
  // NOT play. A chain that opened it would skip that ritual AND leave the tile wrapped
  // forever while its video had already been watched.
  assert.deepEqual(chain({ nextIsGift: true }), { action: 'stop', reason: 'next-is-gift' });
  // it outranks a failure too — a broken video must not "skip" INTO a gift
  assert.equal(chain({ nextIsGift: true, reason: 'error' }).action, 'stop');
  assert.equal(chain({ nextIsGift: true, reason: 'error', retriedCurrent: true }).action, 'stop');
  // and it is only consulted when there IS a next video
  assert.deepEqual(chain({ nextIsGift: true, hasNext: false }),
    { action: 'stop', reason: 'end-of-folder' });
  // an already-unwrapped video is a normal video
  assert.deepEqual(chain({ nextIsGift: false }), { action: 'next', reason: 'ended' });
});

test('a normal end plays the next video, and the last one stops', () => {
  assert.deepEqual(chain(), { action: 'next', reason: 'ended' });
  assert.deepEqual(chain({ hasNext: false }), { action: 'stop', reason: 'end-of-folder' });
});

test('a broken video is retried ONCE, then skipped', () => {
  // finish() fires for an embedding-disabled video too, so without this a chain skips
  // through dead content invisibly — the parent never learns the library has holes.
  assert.deepEqual(chain({ reason: 'error' }), { action: 'retry', reason: 'first-failure' });
  assert.deepEqual(chain({ reason: 'error', retriedCurrent: true }),
    { action: 'next', reason: 'skip-broken' });
  // a retried failure on the LAST video has nowhere to go
  assert.deepEqual(chain({ reason: 'error', retriedCurrent: true, hasNext: false }),
    { action: 'stop', reason: 'end-of-folder' });
});

test('a RUN of failures ends the chain — a black-screen loop is unrepresentable', () => {
  // THE ceiling. Without it a stretch of unplayable videos flips the screen forever.
  for (let f = 0; f < AUTOPLAY_MAX_FAILURES - 1; f++) {
    assert.notEqual(chain({ reason: 'error', failures: f, retriedCurrent: true }).action, 'stop',
      `gave up after only ${f} failures`);
  }
  assert.deepEqual(chain({ reason: 'error', failures: AUTOPLAY_MAX_FAILURES - 1, retriedCurrent: true }),
    { action: 'stop', reason: 'too-many-failures' });
  assert.equal(chain({ reason: 'error', failures: 99 }).action, 'stop');
  // the ceiling outranks the retry: at the limit we stop rather than retry forever
  assert.equal(chain({ reason: 'error', failures: AUTOPLAY_MAX_FAILURES - 1, retriedCurrent: false }).action,
    'stop', 'the retry branch let the chain past its own ceiling');
});

test('nextInOrder follows the ORDER THE CHILD SEES, and never wraps', () => {
  const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(nextInOrder(list, 'a').key, 'b');
  assert.equal(nextInOrder(list, 'b').key, 'c');
  // the last video has no next — a chain must END, not loop back to the start
  assert.equal(nextInOrder(list, 'c'), null);
  // a video that is not in the list (deleted mid-play, or a different folder)
  assert.equal(nextInOrder(list, 'zzz'), null);
  assert.equal(nextInOrder([], 'a'), null);
  assert.equal(nextInOrder(null, 'a'), null, 'must never throw on a missing list');
  assert.equal(nextInOrder(undefined, undefined), null);
  // junk entries are skipped rather than counted as videos
  assert.equal(nextInOrder([{ key: 'a' }, null, { key: 'b' }], 'a').key, 'b');
});

test('the continuous-play timings are sane relative to each other', () => {
  // The countdown is the child's ONLY visible way out of a chain (the 🏠 button lives
  // outside the player and is invisible in fullscreen), so it must not be a blink.
  assert.ok(AUTOPLAY_COUNTDOWN_MS >= 3000, 'too short for a 5-year-old to notice and react');
  assert.ok(AUTOPLAY_COUNTDOWN_MS <= 10000, 'long enough to read as the video having frozen');
  assert.ok(AUTOPLAY_RETRY_MS > 0);
  assert.ok(Number.isInteger(AUTOPLAY_MAX_FAILURES) && AUTOPLAY_MAX_FAILURES >= 2,
    'a ceiling below 2 would give up on the first hiccup');
});

/* ---------------- the parent's preview bubble (v1.0.26) ---------------- */

test('the preview embed is MUTED, scrubbable, and never shows related videos', () => {
  // All three are silent when wrong. controls=1 is the reason the bubble exists at all —
  // the kid HUD hides the timeline and turns a centre tap into play/pause, which is
  // exactly backwards for a parent jumping through a video to check it. mute=1 is the
  // parent's decision (a child in the room, and browsers block unmuted autoplay anyway).
  const url = previewEmbedUrl({ type: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.match(url, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(url, /(^|[?&])controls=1(&|$)/, 'no scrub bar — the parent cannot evaluate');
  assert.match(url, /(^|[?&])mute=1(&|$)/, 'it would blare in the room the child is in');
  assert.match(url, /(^|[?&])rel=0(&|$)/, "YouTube's related rail must never appear in-app");
  assert.match(url, /(^|[?&])autoplay=1(&|$)/);
  // the privacy host, like the kid player uses
  assert.ok(!url.includes('//www.youtube.com/'), 'the preview left the nocookie host');
});

test('previewBubbleButtons: the whole per-mode matrix, every cell load-bearing', () => {
  // v1.0.33 (review): the truth used to live in hand-ordered classList toggles inside
  // renderPreview — where the "live 🗑️ over a search result" bug was hand-avoided once
  // already. A wrong cell is a button that does nothing or destroys the wrong thing:
  //  - 'search' items have NO stored record → del there points at nothing;
  //  - approve/reject outside 'pending' would act on a record in the wrong state;
  //  - add outside 'search' would re-add something already stored.
  assert.deepEqual(previewBubbleButtons('pending'), { approve: true, reject: true, del: false, add: false });
  assert.deepEqual(previewBubbleButtons('library'), { approve: false, reject: false, del: true, add: false });
  assert.deepEqual(previewBubbleButtons('search'), { approve: false, reject: false, del: false, add: true });
  // an unknown mode must fail SAFE: nothing destructive, nothing additive
  assert.deepEqual(previewBubbleButtons('nonsense'), { approve: false, reject: false, del: false, add: false });
  assert.deepEqual(previewBubbleButtons(undefined), { approve: false, reject: false, del: false, add: false });
});

test('previewEmbedUrl refuses anything that is not a YouTube video', () => {
  // The caller falls back to a <video> element for a direct file, and must be able to
  // tell — a bogus embed URL is a permanently black box with no error.
  assert.equal(previewEmbedUrl({ type: 'file', url: 'https://x/a.mp4' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: '' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'too-short' }), null);
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'way-too-long-to-be-an-id' }), null);
  // an id carrying a query/fragment must never be pasted straight into the URL
  assert.equal(previewEmbedUrl({ type: 'youtube', id: 'abc&autoplay' }), null);
  assert.equal(previewEmbedUrl(null), null);
  assert.equal(previewEmbedUrl(), null);
});

/* ---------------- HUD time labels (v1.0.32) ---------------- */

test('formatTime renders m:ss below an hour and h:mm:ss above it', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(7), '0:07');
  assert.equal(formatTime(59.9), '0:59', 'floored — a second that has not finished must not show');
  assert.equal(formatTime(61), '1:01');
  assert.equal(formatTime(600), '10:00');
  assert.equal(formatTime(3599), '59:59');
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(7325), '2:02:05');
});

test('formatTime never leaks NaN/Infinity onto the child\'s screen', () => {
  // getDuration() answers 0 before metadata and Infinity for a live stream; getTime()
  // can answer NaN mid-teardown. Every one of those must read as the neutral 0:00.
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(undefined), '0:00');
  assert.equal(formatTime(null), '0:00');
  assert.equal(formatTime('90'), '1:30', 'numeric strings pass through Number()');
});

/* ---------------- Resume playback (v1.0.32) ---------------- */

test('resumeStartAt: rewinds a few seconds, and 0 whenever resuming makes no sense', () => {
  // The user's spec: re-entering a stopped video continues from RESUME_REWIND_SEC before
  // the stop point — a moment of context, like the YouTube app.
  assert.equal(resumeStartAt({ enabled: true, posSec: 60, durSec: 300 }), 60 - RESUME_REWIND_SEC);
  // OFF is the default and must behave exactly like today: always from the top.
  assert.equal(resumeStartAt({ enabled: false, posSec: 60, durSec: 300 }), 0);
  assert.equal(resumeStartAt({}), 0);
  // a stop too early to matter starts over (also mirrors what the save side refuses)
  assert.equal(resumeStartAt({ enabled: true, posSec: RESUME_MIN_POS_SEC - 1, durSec: 300 }), 0);
  // a STALE near-end position (app died before the 'ended' clear) must not drop the
  // child onto YouTube's end screen — start over instead
  assert.equal(resumeStartAt({ enabled: true, posSec: 295, durSec: 300 }), 0);
  // garbage never becomes a seek target
  assert.equal(resumeStartAt({ enabled: true, posSec: NaN, durSec: 300 }), 0);
  assert.equal(resumeStartAt({ enabled: true, posSec: undefined, durSec: undefined }), 0);
  // rewind can never produce a negative start
  assert.equal(resumeStartAt({ enabled: true, posSec: RESUME_MIN_POS_SEC, durSec: 300 }),
    Math.max(0, RESUME_MIN_POS_SEC - RESUME_REWIND_SEC));
});

test('resumeSaveDecision: save mid-video, clear in the tail, ignore the unusable', () => {
  assert.equal(resumeSaveDecision({ pos: 60, dur: 300 }), 'save');
  // inside the tail = effectively finished: clear, or every video "sticks" at its end
  assert.equal(resumeSaveDecision({ pos: 300 - RESUME_TAIL_SEC, dur: 300 }), 'clear');
  assert.equal(resumeSaveDecision({ pos: 299, dur: 300 }), 'clear');
  // a 2-second accidental tap must not throw away real progress -> ignore, not clear
  assert.equal(resumeSaveDecision({ pos: 2, dur: 300 }), 'ignore');
  // an unknown duration cannot tell the tail from the middle: never save a wrong point
  assert.equal(resumeSaveDecision({ pos: 60, dur: 0 }), 'ignore');
  assert.equal(resumeSaveDecision({ pos: 60, dur: Infinity }), 'ignore');
  assert.equal(resumeSaveDecision({ pos: NaN, dur: 300 }), 'ignore');
  assert.equal(resumeSaveDecision({}), 'ignore');
  // a SHORT video: the tail rule wins over the minimum, in both orders of magnitude
  assert.equal(resumeSaveDecision({ pos: 5, dur: 10 }), 'clear', 'a 10s clip is finished at 5s? no — inside the 12s tail');
});

test('watchedFraction: a bar only when both numbers are usable, clamped to [0,1]', () => {
  assert.equal(watchedFraction(150, 300), 0.5);
  assert.equal(watchedFraction(400, 300), 1, 'clamped — a stale over-long position');
  // mirrors the save floor: a position too small to resume never draws a sliver
  assert.equal(watchedFraction(RESUME_MIN_POS_SEC - 1, 300), null);
  assert.equal(watchedFraction(60, 0), null);
  assert.equal(watchedFraction(60, Infinity), null);
  assert.equal(watchedFraction(undefined, undefined), null);
});
