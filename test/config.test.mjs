// Config invariants — constants whose RELATIONSHIP is load-bearing. These are pinned
// in CLAUDE.md as hard invariants but were never test-enforced until now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as config from '../www/js/config.js';

test('TAP_SINGLE_DELAY >= TAP_DOUBLE_MS — or a slow double-tap both pauses AND seeks', () => {
  // The single-tap timer must not fire before the double-tap window closes: a child
  // double-tapping slowly would otherwise trigger play/pause AND a seek together.
  assert.ok(config.TAP_SINGLE_DELAY >= config.TAP_DOUBLE_MS,
    `TAP_SINGLE_DELAY (${config.TAP_SINGLE_DELAY}) must be >= TAP_DOUBLE_MS (${config.TAP_DOUBLE_MS})`);
});

test('player timing constants are sane', () => {
  assert.ok(config.SEEK_STEP > 0 && config.SEEK_STEP <= 60, 'seek step is a small positive number of seconds');
  assert.ok(config.HUD_HIDE_MS >= 1000, 'the HUD must stay visible long enough to be usable');
});

test('TAP_SLOP_PX tells a wobbly tap from a deliberate swipe (v1.0.52)', () => {
  // Too small and a child's normal finger-rock kills every tap (the HUD looks dead);
  // too large and a short scroll-swipe over the player reads as a tap and PAUSES the
  // video — the exact bug the slop exists to prevent.
  assert.ok(config.TAP_SLOP_PX >= 6, `TAP_SLOP_PX=${config.TAP_SLOP_PX} — a normal tap wobbles a few px`);
  assert.ok(config.TAP_SLOP_PX <= 30, `TAP_SLOP_PX=${config.TAP_SLOP_PX} — a swipe would read as a tap`);
});

test('page sizes are positive (pagination never divides by zero)', () => {
  for (const k of ['PAGE_VIDEOS', 'PAGE_WATCH', 'PAGE_FOLDERS']) {
    assert.ok(Number.isInteger(config[k]) && config[k] > 0, `${k} must be a positive integer`);
  }
});

test('quota soft-cap leaves real headroom under the 10k daily budget', () => {
  assert.ok(config.QUOTA_DAILY_SOFT_CAP > 0 && config.QUOTA_DAILY_SOFT_CAP < 10000);
});
