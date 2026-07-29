// Quota math — the 111-unit figure is an executable assertion, not a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchIds, quotaCostFor, shouldThrottle, uploadsPlaylistIdFor, planChannelFetch } from '../www/js/quota.js';

test('batchIds: sizes, dedupe, order', () => {
  assert.deepEqual(batchIds([]), []);
  assert.equal(batchIds(Array.from({ length: 50 }, (_, i) => 'v' + i)).length, 1);
  const two = batchIds(Array.from({ length: 51 }, (_, i) => 'v' + i));
  assert.equal(two.length, 2);
  assert.equal(two[0].length, 50);
  assert.equal(two[1].length, 1);
  assert.deepEqual(batchIds(['a', 'b', 'a']), [['a', 'b']]);
});

test('10 channels × 500 videos costs exactly 111 units (1.1% of the daily quota)', () => {
  const cost = quotaCostFor({
    handleResolves: 10,                        // worst case, one-time ever (cached forever)
    channelBatches: 1,                         // 10 ids in ONE channels.list call
    backfillPages: 10 * Math.ceil(500 / 50),   // playlistItems.list, 50/page
    titleBatches: 0                            // titles ride along in playlistItems.snippet
  });
  assert.equal(cost, 111);
});

test('shouldThrottle boundary at the soft cap', () => {
  assert.equal(shouldThrottle(7999, 1), false);
  assert.equal(shouldThrottle(7999, 2), true);
  assert.equal(shouldThrottle(8001, 0), true);
});

test('uploads playlist derivation: UC->UU, rejects non-UC', () => {
  assert.equal(uploadsPlaylistIdFor('UCabcdefghijklmnopqrstuv'), 'UUabcdefghijklmnopqrstuv');
  assert.equal(uploadsPlaylistIdFor('PLwhatever'), null);
  assert.equal(uploadsPlaylistIdFor(''), null);
});

test('planChannelFetch truth table', () => {
  const now = 1000 * 60 * 60; // 1h
  assert.equal(planChannelFetch({}, now, true), 'resolve');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx' }, now, true), 'backfill');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx' }, now, false), 'rss');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx', backfillDone: true, lastRssCheckedAt: now - 31 * 60 * 1000 }, now, true), 'rss');
  assert.equal(planChannelFetch({ uploadsPlaylistId: 'UUx', backfillDone: true, lastRssCheckedAt: now - 5 * 60 * 1000 }, now, true), 'skip');
});
