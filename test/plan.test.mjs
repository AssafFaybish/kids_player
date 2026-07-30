// planMutations/planGifts — the sync brain. The most valuable assertion in the whole
// suite: running the plan twice yields an EMPTY second diff (no churn, no re-gifting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planMutations, planGifts, shouldFlattenHome, shouldRecordGiftBaseline
} from '../www/js/plan.js';

const CH = 'UCabcdefghijklmnopqrstuv';
const cand = (over = {}) => ({
  scopeId: 'lib:1', key: 'yt:' + (over.id || 'aaaaaaaaaaa'), type: 'youtube',
  id: over.id || 'aaaaaaaaaaa', srcUrl: 'https://youtu.be/x', title: 'שיר',
  titleSource: 'rss', thumbUrl: 'https://i.ytimg.com/x.jpg', channelId: CH,
  folderId: 'ch:' + CH, origin: 'channel', publishedAt: 1000, autoApprove: true,
  ...over
});

test('denied keys are dropped and STAY dropped (defect-4 regression, 5 rounds)', () => {
  const deny = new Set(['yt:aaaaaaaaaaa']);
  let existing = new Map();
  for (let round = 0; round < 5; round++) {
    const plan = planMutations({ candidates: [cand()], existing, denySet: deny, now: 5000 });
    assert.equal(plan.puts.length, 0, `round ${round}`);
    assert.equal(plan.counts.denied, 1);
  }
});

test('autoApprove=false routes new videos to pending; approval survives re-sync', () => {
  const c = cand({ autoApprove: false });
  const p1 = planMutations({ candidates: [c], existing: new Map(), denySet: new Set(), now: 1 });
  assert.equal(p1.puts[0].state, 'pending');
  assert.deepEqual(p1.pendingKeys, ['yt:aaaaaaaaaaa']);

  // parent approved it since (existing shows live); re-sync must NOT flip it back
  const existing = new Map([[c.key, { ...p1.puts[0], state: 'live', approvedAt: 2 }]]);
  const p2 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 3 });
  const put = p2.puts.find((p) => p.key === c.key);
  assert.ok(!put || put.state === 'live');
});

test('quarantine forces pending regardless of autoApprove (post-migration first sync)', () => {
  const p = planMutations({ candidates: [cand({ autoApprove: true })], existing: new Map(), denySet: new Set(), quarantine: true });
  assert.equal(p.puts[0].state, 'pending');
});

test('title dedupe within a channel; NOT across channels; empty normTitle never dedupes', () => {
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שיר הבוקר' });
  const sameChannelTwin = cand({ id: 'bbbbbbbbbbb', title: 'שיר, הבוקר!' }); // same after normalize
  const otherChannel = cand({ id: 'ccccccccccc', title: 'שיר הבוקר', channelId: 'UCother0000000000000000', folderId: 'ch:other' });
  const untitled1 = cand({ id: 'ddddddddddd', title: '' });
  const untitled2 = cand({ id: 'eeeeeeeeeee', title: '' });

  const p = planMutations({ candidates: [a, sameChannelTwin, otherChannel, untitled1, untitled2], existing: new Map(), denySet: new Set() });
  const keys = p.puts.map((x) => x.key).sort();
  assert.ok(!keys.includes('yt:bbbbbbbbbbb'), 'twin merged into survivor');
  assert.ok(keys.includes('yt:ccccccccccc'), 'cross-channel twin kept');
  assert.ok(keys.includes('yt:ddddddddddd') && keys.includes('yt:eeeeeeeeeee'), 'untitled never dedupe');
  assert.equal(p.mergeReport.length, 1);
  const survivor = p.puts.find((x) => x.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor.mergedFrom.includes('yt:bbbbbbbbbbb'));
});

test('a reappearing merged-away link resolves to its survivor, not a new record', () => {
  const existing = new Map([['yt:aaaaaaaaaaa', {
    key: 'yt:aaaaaaaaaaa', channelId: CH, normTitle: 'שיר', state: 'live',
    title: 'שיר', titleSource: 'rss', addedAt: 1, sortKey: 1000, origin: 'channel',
    folderId: 'ch:' + CH, publishedAt: 1000, rowIndex: null, thumbUrl: 'x', thumbId: null,
    localPath: null, srcUrl: '', url: null, mergedFrom: ['yt:bbbbbbbbbbb']
  }]]);
  const p = planMutations({ candidates: [cand({ id: 'bbbbbbbbbbb' })], existing, denySet: new Set() });
  assert.ok(!p.puts.some((x) => x.key === 'yt:bbbbbbbbbbb'), 'loser did not resurrect');
});

test('caps: per-channel and total', () => {
  const many = Array.from({ length: 30 }, (_, i) => cand({ id: String(i).padStart(11, 'x'), title: 't' + i }));
  const p = planMutations({ candidates: many, existing: new Map(), denySet: new Set(), caps: { maxPerChannel: 10, maxTotal: 100 } });
  assert.equal(p.puts.length, 10);
  assert.equal(p.counts.capped, 20);
});

test('THE assertion: second run over the same inputs yields an empty diff', () => {
  const candidates = [
    cand({ id: 'aaaaaaaaaaa', title: 'שיר 1' }),
    cand({ id: 'bbbbbbbbbbb', title: 'שיר 2' }),
    cand({ id: 'ccccccccccc', title: 'שיר, 1' }) // dedupes into aaaa
  ];
  const p1 = planMutations({ candidates, existing: new Map(), denySet: new Set(), now: 100 });
  const existing = new Map(p1.puts.map((r) => [r.key, r]));
  const p2 = planMutations({ candidates, existing, denySet: new Set(), now: 200 });
  assert.equal(p2.puts.length, 0, 'no churn on identical inputs');
  assert.equal(p2.newLiveKeys.length, 0, 'nothing re-gifts');
});

test('planGifts baseline: exactly the newest 12 become gifts, the rest are pre-unwrapped', () => {
  const live = Array.from({ length: 20 }, (_, i) => ({
    key: 'yt:' + String(i).padStart(11, 'v'), sortKey: 1000 + i, thumbUrl: 'x', type: 'youtube'
  }));
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: [], existingStates: new Map(), firstSync: true, now: 5 });
  const gifts = puts.filter((s) => s.giftRank);
  const unwrapped = puts.filter((s) => s.unwrappedAt);
  assert.equal(gifts.length, 12);
  assert.equal(unwrapped.length, 8);
  assert.deepEqual(gifts.map((g) => g.giftRank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // rank 1 = the newest (highest sortKey)
  assert.equal(gifts[0].key, live[19].key);
});

test('planGifts incremental: only NEW live keys gift; unwrapped never re-gifts; ranks continue', () => {
  const live = [
    { key: 'yt:old00000000', sortKey: 1, thumbUrl: 'x' },
    { key: 'yt:new00000000', sortKey: 2, thumbUrl: 'x' },
    { key: 'yt:seen0000000', sortKey: 3, thumbUrl: 'x' }
  ];
  const states = new Map([
    ['yt:old00000000', { giftRank: 4 }],
    ['yt:seen0000000', { unwrappedAt: 10 }]
  ]);
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: ['yt:new00000000', 'yt:seen0000000'], existingStates: states, firstSync: false });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, 'yt:new00000000');
  assert.equal(puts[0].giftRank, 5); // continues after the existing max
});

/* ---- v1.0.20 FIELD BUGS: the home flattened a lone channel, and the gift baseline
        was spent on an empty library ---- */

test('shouldFlattenHome: only the LOOSE list may render flat — a channel keeps its tile', () => {
  // Reported live: the parent added one channel and the child's home became a
  // hundred-page flat wall of its backfill, with no 📺 tile and no channel logo.
  assert.equal(shouldFlattenHome([{ id: 'ch:UCabcdefghijklmnopqrstuv', count: 300 }]), false);
  assert.equal(shouldFlattenHome([{ id: 'grp:UCabcdefghijklmnopqrstuv', count: 4, grouped: true }]), false);
  // the case the rule exists for: the shared loose list as the ONLY folder
  assert.equal(shouldFlattenHome([{ id: 'sheet', count: 12 }]), true);
  assert.equal(shouldFlattenHome([{ id: 'mine', count: 3 }]), true, 'legacy profile-scope list too');
});

test('shouldFlattenHome: never flattens when there is something to organize', () => {
  assert.equal(shouldFlattenHome([{ id: 'sheet' }, { id: 'ch:UC1' }]), false);
  // 🎁 is a view over other folders — alone it must not become the whole home, and
  // next to the loose list it means there ARE two tiles to show
  assert.equal(shouldFlattenHome([{ id: 'new', isNew: true, count: 5 }]), false);
  assert.equal(shouldFlattenHome([{ id: 'new', isNew: true }, { id: 'sheet' }]), false);
  // junk in, no crash out (an empty home renders its empty state, not a flat page)
  for (const junk of [[], null, undefined, [null], [{}]]) {
    assert.equal(shouldFlattenHome(junk), false, JSON.stringify(junk));
  }
});

test('shouldRecordGiftBaseline: an EMPTY first sync must not spend the baseline', () => {
  // Adding a channel syncs while every video is still pending, so liveRecords is empty.
  // Spending the flag there gave the child no gifts after approval, and made the NEXT
  // sync gift the entire backfill at once.
  assert.equal(shouldRecordGiftBaseline(true, 0), false);
  assert.equal(shouldRecordGiftBaseline(true, 1), true);
  assert.equal(shouldRecordGiftBaseline(true, 2000), true);
  assert.equal(shouldRecordGiftBaseline(false, 0), false, 'already baselined stays baselined');
  assert.equal(shouldRecordGiftBaseline(false, 50), false);
  for (const junk of [undefined, null, NaN, 'x']) assert.equal(shouldRecordGiftBaseline(true, junk), false);
});

test('the gift baseline still works the moment content becomes live', () => {
  // End-to-end of the fix: sync #1 (all pending) records nothing, sync #2 after the
  // parent approves takes the BASELINE path — newest 12 gifted, the rest never gift.
  const live = Array.from({ length: 30 }, (_, i) => ({ key: 'yt:k' + i, sortKey: i, thumbUrl: 'x' }));
  assert.equal(shouldRecordGiftBaseline(true, 0), false);
  const puts = planGifts({ profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key), existingStates: new Map(), firstSync: true });
  assert.equal(puts.filter((p) => p.giftRank).length, 12, 'twelve gifts, not thirty');
  assert.equal(puts.filter((p) => p.unwrappedAt).length, 18);
  assert.equal(shouldRecordGiftBaseline(true, live.length), true);
});
