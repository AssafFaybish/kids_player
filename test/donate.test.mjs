// Voluntary support (v1.0.14) — pure logic. Two promises to the user: nothing is
// offered unless a real link is configured, and the gentle reminder appears ONCE,
// only after a month of use, and never after it was dismissed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  donateOptions, donateAvailable, shouldShowDonateNudge, NUDGE_AFTER_MS, DONATE_LINKS
} from '../www/js/donate.js';

test('ships with NO links configured → nothing is offered anywhere', () => {
  assert.deepEqual(donateOptions(DONATE_LINKS), []);
  assert.equal(donateAvailable(DONATE_LINKS), false);
  assert.equal(shouldShowDonateNudge({ firstSeenAt: 1, now: 1 + NUDGE_AFTER_MS }), false);
});

test('donateOptions: only http(s) links count, PayBox first, junk rejected', () => {
  const both = donateOptions({ paybox: 'https://payboxapp.com/x', paypal: 'https://paypal.me/y' });
  assert.deepEqual(both.map((o) => o.id), ['paybox', 'paypal']);
  assert.ok(both.every((o) => o.label && o.hint), 'each option carries a Hebrew label + hint');

  assert.deepEqual(donateOptions({ paypal: 'https://paypal.me/y' }).map((o) => o.id), ['paypal']);
  for (const bad of [{ paybox: '' }, { paybox: '   ' }, { paybox: 'payboxapp.com/x' },
    { paybox: 'javascript:alert(1)' }, { paybox: null }, {}, null]) {
    assert.deepEqual(donateOptions(bad), [], JSON.stringify(bad));
  }
  // whitespace around a real link is tolerated
  assert.equal(donateOptions({ paybox: '  https://payboxapp.com/x  ' })[0].url, 'https://payboxapp.com/x');
});

test('the nudge waits a full month, fires once, and respects a dismissal', () => {
  const links = { paybox: 'https://payboxapp.com/x' };
  const first = 1_700_000_000_000;
  const opts = (over) => ({ firstSeenAt: first, links, ...over });

  assert.equal(shouldShowDonateNudge(opts({ now: first + NUDGE_AFTER_MS - 1 })), false, 'a day early → silent');
  assert.equal(shouldShowDonateNudge(opts({ now: first + NUDGE_AFTER_MS })), true, 'exactly a month → shown');
  assert.equal(shouldShowDonateNudge(opts({ now: first + 10 * NUDGE_AFTER_MS })), true);
  assert.equal(shouldShowDonateNudge(opts({ now: first + NUDGE_AFTER_MS, dismissed: true })), false, 'dismissed forever');
});

test('the nudge never fires on unknown/garbage//future install stamps', () => {
  const links = { paybox: 'https://payboxapp.com/x' };
  const now = 1_800_000_000_000;
  for (const firstSeenAt of [undefined, null, 0, -5, NaN, 'abc', now + 1000]) {
    assert.equal(shouldShowDonateNudge({ firstSeenAt, now, links }), false, String(firstSeenAt));
  }
  assert.equal(shouldShowDonateNudge(), false); // no args at all
});

test('no link configured → no nudge even after years of use', () => {
  const first = 1_600_000_000_000;
  assert.equal(shouldShowDonateNudge({ firstSeenAt: first, now: first + 40 * NUDGE_AFTER_MS, links: { paybox: '', paypal: '' } }), false);
});
