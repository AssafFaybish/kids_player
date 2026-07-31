// Quota math — the 111-unit figure is an executable assertion, not a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchIds, quotaCostFor, shouldThrottle, uploadsPlaylistIdFor, longFormPlaylistIdFor,
  shortsPlaylistIdFor, planChannelFetch } from '../www/js/quota.js';

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

test('v1.0.18: rearming the cursor on unsubscribe restores a full backfill', () => {
  const now = Date.now();
  // The state db.deleteLibraryChannel leaves behind once no library subscribes.
  // Before the fix the record kept backfillDone:true, so a re-subscribe planned
  // 'rss' and only the ~15 videos in the feed window ever returned — the rest of
  // the channel's back catalogue was unreachable forever.
  const exhausted = { uploadsPlaylistId: 'UUx', backfillDone: true, backfillCursor: 'CAUQAA', lastRssCheckedAt: now };
  assert.equal(planChannelFetch(exhausted, now, true), 'skip');

  const rearmed = { ...exhausted, backfillDone: false, backfillCursor: null };
  assert.equal(planChannelFetch(rearmed, now, true), 'backfill');
  // keyless installs still fall back to the free RSS path
  assert.equal(planChannelFetch(rearmed, now, false), 'rss');
  // the playlist id is deliberately KEPT, so re-subscribing costs no resolve call
  assert.notEqual(planChannelFetch(rearmed, now, true), 'resolve');
});

test('the LONG-FORM and SHORTS sibling playlists are derived from the channel id', () => {
  // v1.0.21 — this is the whole Shorts-exclusion mechanism: `UULF…` is the channel's
  // "Videos" tab and `UUSH…` its Shorts, both reachable with the SAME
  // playlistItems.list call and zero extra quota. Measured 2026-07-31 on Cocomelon /
  // Blippi / Super Simple Songs: UULF ∪ UUSH == UU, no overlap, no leftovers.
  const CH = 'UCabcdefghijklmnopqrstuv';
  assert.equal(longFormPlaylistIdFor(CH), 'UULFabcdefghijklmnopqrstuv');
  assert.equal(shortsPlaylistIdFor(CH), 'UUSHabcdefghijklmnopqrstuv');
  // all three variants keep the channel's 22-char tail, so they address one channel
  const tail = CH.slice(2);
  for (const id of [uploadsPlaylistIdFor(CH), longFormPlaylistIdFor(CH), shortsPlaylistIdFor(CH)]) {
    assert.ok(id.endsWith(tail), id);
  }
  assert.notEqual(longFormPlaylistIdFor(CH), uploadsPlaylistIdFor(CH));
  // same strict guard as the uploads id — junk in must never become a playlist id
  for (const junk of ['PLwhatever', '', null, undefined, 'UCshort', 'UUabcdefghijklmnopqrstuv', 42]) {
    assert.equal(longFormPlaylistIdFor(junk), null, String(junk));
    assert.equal(shortsPlaylistIdFor(junk), null, String(junk));
  }
});
