// playerlogic.js — the pure decisions behind player.js (v1.0.22). Until now player.js had
// NO tests at all while carrying the longest hard-invariant block in CLAUDE.md, and every
// bug these cover was found by reading it, not by the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSeek, fractionFromX, progressPct, shouldFinishNearEnd, tvKeyIntent } from '../www/js/playerlogic.js';
import { SEEK_STEP, TAP_DOUBLE_MS, TAP_SINGLE_DELAY } from '../www/js/config.js';

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
