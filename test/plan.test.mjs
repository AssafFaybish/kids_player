// planMutations/planGifts — the sync brain. The most valuable assertion in the whole
// suite: running the plan twice yields an EMPTY second diff (no churn, no re-gifting).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planMutations, planGifts, shouldFlattenHome, shouldRecordGiftBaseline,
  sheetBackedKeysOf, isSheetBacked, planScopeAdoption, planGiftRunawayRepair,
  acceptRssEntry, acceptPlaylistItem, planPlaylistAdvance, planNoLongForm, planLongFormOutage,
  shouldAskShareProfile,
  attentionDot, parentLandingTab, pendingBulkAction, PARENT_TAB_IDS,
  resolveWatchContext
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
  const existing = new Map([[c.key, { ...p1.puts[0], state: 'live', approvedAt: 2, folderId: '~pending' }]]);
  const p2 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 3 });
  const put = p2.puts.find((p) => p.key === c.key);
  // `!put || put.state === 'live'` used to be the whole assertion — a disjunction that
  // PASSES WHEN NOTHING IS EMITTED. Deleting the un-park branch entirely left p2.puts
  // empty and the test green, while the real consequence is a record that is live,
  // approved, in the parent's list, and invisible to the child forever (by_folder_sort has
  // no state component, so nothing ever surfaces '~pending').
  assert.ok(put, 'an approved-but-parked record must be re-emitted so it can be un-parked');
  assert.equal(put.state, 'live');
  assert.notEqual(put.folderId, '~pending', 'the record was left parked — invisible to the child');
  assert.equal(put.folderId, 'ch:' + CH);
});

test('a REJECTED record survives every later sync (v1.0.23)', () => {
  // THE guard for the rejected list. A channel video is re-offered by the RSS pass every
  // 30 minutes and by every backfill page, so if the `prior` branch did not pin 'rejected'
  // the way it pins 'pending', each sync would quietly hand the child back everything the
  // parent threw out — and the parent would have no idea why.
  const c = cand({ autoApprove: true }); // even an auto-approving channel must not revive it
  const existing = new Map([[c.key, {
    ...cand(), key: c.key, state: 'rejected', rejectedAt: 500, approvedAt: null,
    folderId: '~rejected', homeFolderId: 'ch:' + CH, normTitle: 'שיר', addedAt: 10,
    sortKey: 1000, title: 'שיר', titleSource: 'rss', thumbUrl: 'x', thumbId: null,
    localPath: null, url: null, srcUrl: '', publishedAt: 1000, rowIndex: null, origin: 'channel'
  }]]);
  for (let round = 0; round < 3; round++) {
    const p = planMutations({ candidates: [c], existing, denySet: new Set(), now: 1000 + round });
    for (const put of p.puts) {
      assert.equal(put.state, 'rejected', `round ${round}: the sync revived a rejected video`);
      assert.equal(put.folderId, '~rejected', `round ${round}: it left the parking slot`);
      existing.set(put.key, put);
    }
    assert.ok(!p.newLiveKeys.includes(c.key), `round ${round}: counted as newly live`);
  }
});

test('shouldAskShareProfile: only when the answer changes where the video lands', () => {
  const A = { profileId: 'p1', scope: 'lib:aaa' };
  const B = { profileId: 'p2', scope: 'lib:bbb' };
  const sameSheet = { profileId: 'p2', scope: 'lib:aaa' };

  assert.equal(shouldAskShareProfile([A, B]), true, 'different libraries → the choice matters');
  assert.equal(shouldAskShareProfile([A]), false, 'one profile → nothing to ask');
  assert.equal(shouldAskShareProfile([]), false);
  assert.equal(shouldAskShareProfile(null), false, 'never throws on a missing list');
  // THE case this helper exists for: two children on ONE family sheet share the library
  // scope, so the video is the same row either way. Asking would train the parent to tap
  // through the dialog without reading it.
  assert.equal(shouldAskShareProfile([A, sameSheet]), false, 'same sheet ⇒ same destination');
  // three profiles, two sheets → still a real choice
  assert.equal(shouldAskShareProfile([A, sameSheet, B]), true);
  // a profile with no sources yet is its own destination, so it counts as distinct
  assert.equal(shouldAskShareProfile([A, { profileId: 'p3' }]), true);
  assert.equal(shouldAskShareProfile([{ profileId: 'p1' }, { profileId: 'p2' }]), true);
  // junk entries are ignored rather than counted as profiles
  assert.equal(shouldAskShareProfile([A, null, {}]), false);
});

test('attentionDot: CONTENT wins the dot, and the colour names the errand (v1.0.24)', () => {
  // One red dot used to mean both "videos are waiting for you" and "an app update is
  // ready". The parent could not tell them apart, so the routine errand — a manual-approval
  // channel published something the child cannot see yet — looked like the rare one.
  assert.equal(attentionDot({ pending: 3, updateReady: false }), 'info', 'content → blue');
  assert.equal(attentionDot({ pending: 0, updateReady: true }), 'alert', 'update only → red');
  assert.equal(attentionDot({ pending: 0, updateReady: false }), null, 'nothing → no dot');
  // A TIE goes to the content: a child is waiting at the other end of it, and the update
  // keeps its own dot on the אודות tab either way.
  assert.equal(attentionDot({ pending: 1, updateReady: true }), 'info');
  // never throws on a missing/partial attention object — this runs on every home render
  assert.equal(attentionDot(), null);
  assert.equal(attentionDot({}), null);
  assert.equal(attentionDot({ pending: 2 }), 'info');
});

test('parentLandingTab: a waiting queue overrides the sticky tab, EVERY visit (v1.0.24)', () => {
  assert.equal(parentLandingTab('about', 4), 'approve', 'pending → land on the queue');
  assert.equal(parentLandingTab('settings', 1), 'approve', 'the override beats stickiness');
  // …and it is not a one-shot: the same parent coming back to a still-full queue lands
  // there again. The queue is the only tab whose content is blocking a child.
  assert.equal(parentLandingTab('approve', 1), 'approve');
  // Empty queue ⇒ the sticky tab is restored, so the override can never strand a parent
  // who lives in הגדרות.
  assert.equal(parentLandingTab('settings', 0), 'settings');
  assert.equal(parentLandingTab('about', 0), 'about', 'v1.0.14 default survives');
  // A sticky value that is not a real tab would hide every panel (setParentTab matches by
  // name), so it falls back to the first tab rather than rendering an empty screen.
  assert.equal(parentLandingTab('nope', 0), PARENT_TAB_IDS[0]);
  assert.equal(parentLandingTab(null, 0), 'about');
  assert.equal(parentLandingTab(undefined, 0), 'about');
  // the tab list is the one app.js renders from — a second hand-kept copy could name a
  // tab that does not exist
  assert.ok(PARENT_TAB_IDS.includes('approve'));
  assert.deepEqual(PARENT_TAB_IDS, ['about', 'approve', 'add', 'sources', 'settings']);
});

test('pendingBulkAction: the button SAYS what it is about to act on (v1.0.24)', () => {
  // Nothing ticked ⇒ the buttons keep their original whole-queue meaning, which is also
  // the only way to reach rows past the 200-row display cap.
  const none = pendingBulkAction(0, 30);
  assert.equal(none.scope, 'all');
  assert.equal(none.count, 30);
  assert.match(none.approve, /הכול/);
  assert.match(none.reject, /הכול/);

  // One tick narrows BOTH buttons. This is the whole point: "דחיית הכול" pressed while
  // three rows are ticked must not throw out thirty.
  const some = pendingBulkAction(3, 30);
  assert.equal(some.scope, 'selected');
  assert.equal(some.count, 3);
  assert.match(some.approve, /3/);
  assert.match(some.reject, /3/);
  assert.ok(!some.approve.includes('הכול'), 'a narrowed action must not read as "all"');
  assert.ok(!some.reject.includes('הכול'));

  // Selecting every row is still a SELECTION, not the whole queue: with 250 pending and
  // 200 rendered rows, ticking all 200 must not silently act on 250.
  const capped = pendingBulkAction(200, 250);
  assert.equal(capped.scope, 'selected');
  assert.equal(capped.count, 200);

  // garbage in never produces a whole-queue action by accident
  assert.equal(pendingBulkAction(-5, 10).scope, 'all');
  assert.equal(pendingBulkAction().scope, 'all');
  assert.equal(pendingBulkAction().count, 0);
});

test('THE CHURN INVARIANT holds for rejected records too (v1.0.23)', () => {
  // The most valuable assertion in this suite is "run the plan twice ⇒ empty second diff",
  // and a third curation state is exactly the kind of change that quietly breaks it. What
  // this pins is that `state` and `folderId` SETTLE: if a re-seen rejected candidate flipped
  // between 'rejected' and something else, or between '~rejected' and its home, every sync
  // would rewrite every rejected row and re-push the whole library to Drive.
  // NOTE, measured: a drifting `rejectedAt` does NOT churn here — it is not in DIFF_FIELDS,
  // so `changed()` never sees it. That drift is caught by settleCuration's own idempotence
  // test in normalize.test.mjs; do not expect this test to cover it.
  const c = cand({ autoApprove: true });
  const existing = new Map();
  const p1 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 1000 });
  for (const put of p1.puts) existing.set(put.key, put);
  // the parent rejects it (what db.rejectPending writes)
  const rec = existing.get(c.key);
  existing.set(c.key, {
    ...rec, state: 'rejected', rejectedAt: 2000, approvedAt: null,
    homeFolderId: rec.folderId, folderId: '~rejected'
  });
  const p2 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 3000 });
  for (const put of p2.puts) existing.set(put.key, put);
  const p3 = planMutations({ candidates: [c], existing, denySet: new Set(), now: 4000 });
  assert.deepEqual(p3.puts, [], 'a re-seen REJECTED video rewrote its record (churn)');
  assert.equal(existing.get(c.key).state, 'rejected');
  assert.equal(existing.get(c.key).rejectedAt, 2000, 'the decision timestamp must not drift');
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

test('a same-titled twin can NEVER auto-approve its survivor (v1.0.22 safety hole)', () => {
  // The bug, measured on a real channel (@rotemama4kids, 109 long-form videos added from
  // the parent screen ⇒ autoApprove:false): `base.state` defaulted to 'live' and the
  // approval routing lived only in the brand-new branch, so the titleTwin branch
  // short-circuited past it. mergeVideoRecord promotes a pending survivor when the LOSER
  // is live — so the 2 same-titled pairs in that backfill became live in the child's
  // folder with approvedAt still null, and they were the ONLY 2 videos the child could
  // see. Unapproved content reaching a 5-year-old is the worst failure this app has.
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שמח, עצוב או כועס?', autoApprove: false });
  const twin = cand({ id: 'bbbbbbbbbbb', title: 'שמח עצוב או כועס!', autoApprove: false });
  const p = planMutations({ candidates: [a, twin], existing: new Map(), denySet: new Set(), now: 7 });

  assert.equal(p.puts.length, 1, 'the twin still merges — dedupe is not what changed');
  const survivor = p.puts[0];
  assert.equal(survivor.state, 'pending', 'a merge must never approve what the parent has not seen');
  assert.equal(survivor.folderId, '~pending', 'and it must stay parked out of the child folder');
  assert.ok(survivor.mergedFrom.includes('yt:bbbbbbbbbbb'));
  assert.ok(!p.newLiveKeys.length, 'nothing became live');
});

test('quarantine also survives the twin-merge path', () => {
  const a = cand({ id: 'aaaaaaaaaaa', title: 'שיר', autoApprove: true });
  const twin = cand({ id: 'bbbbbbbbbbb', title: 'שיר!', autoApprove: true });
  const p = planMutations({ candidates: [a, twin], existing: new Map(), denySet: new Set(), quarantine: true });
  assert.equal(p.puts.length, 1);
  assert.equal(p.puts[0].state, 'pending', 'post-migration quarantine outranks autoApprove everywhere');
  assert.equal(p.puts[0].folderId, '~pending');
});

test('a twin merge that DOES go live is never left parked (mirror of the leak)', () => {
  // The legitimate direction: the parent has since switched the channel to auto-approve,
  // so an incoming candidate really is approved and promoting the waiting twin is right.
  // mergeVideoRecord flips state but never folderId, and a live record still parked in
  // '~pending' is invisible in the child's folder AND gone from the approval queue.
  const existing = new Map([['yt:aaaaaaaaaaa', {
    key: 'yt:aaaaaaaaaaa', channelId: CH, normTitle: 'שיר', state: 'pending',
    title: 'שיר', titleSource: 'rss', addedAt: 1, sortKey: 1000, origin: 'channel',
    folderId: '~pending', homeFolderId: 'ch:' + CH, publishedAt: 1000, rowIndex: null,
    thumbUrl: 'x', thumbId: null, localPath: null, srcUrl: '', url: null, approvedAt: null
  }]]);
  const p = planMutations({
    candidates: [cand({ id: 'bbbbbbbbbbb', title: 'שיר!', autoApprove: true })],
    existing, denySet: new Set(), now: 99
  });
  const survivor = p.puts.find((x) => x.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor, 'the promotion must be emitted');
  assert.equal(survivor.state, 'live');
  assert.equal(survivor.folderId, 'ch:' + CH, 'un-parked, or the child can never reach it');
  assert.equal(survivor.approvedAt, 99, 'it became live now — the record must say so');
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

  // maxTotal was never actually exercised: with maxPerChannel:10 the total never reached
  // 100, so `if (total >= maxTotal)` never ran and the 5000-record library ceiling could
  // have been deleted with the suite green — one large sheet then imports without bound
  // onto a tablet. Bind it explicitly, and across TWO channels so it is the total that caps.
  const twoChannels = [
    ...Array.from({ length: 5 }, (_, i) => cand({ id: 'a' + String(i).padStart(10, '0'), title: 'a' + i })),
    ...Array.from({ length: 5 }, (_, i) => cand({ id: 'b' + String(i).padStart(10, '0'), title: 'b' + i, channelId: 'UCother0000000000000000', folderId: 'ch:other' }))
  ];
  const capped = planMutations({
    candidates: twoChannels, existing: new Map(), denySet: new Set(),
    caps: { maxPerChannel: 99, maxTotal: 4 }
  });
  assert.equal(capped.puts.length, 4, 'maxTotal did not bind');
  assert.equal(capped.counts.capped, 6);
  // and EXISTING records count toward the total, or the cap resets every sync
  const nearFull = new Map(Array.from({ length: 4 }, (_, i) => ['yt:pre' + i, { key: 'yt:pre' + i, state: 'live' }]));
  const full = planMutations({
    candidates: twoChannels, existing: nearFull, denySet: new Set(), caps: { maxPerChannel: 99, maxTotal: 4 }
  });
  assert.equal(full.puts.length, 0, 'a library already at the cap kept importing');
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

/* ---- the two extracted safety boundaries (v1.0.20) ---- */

test('sheetBackedKeysOf: a PENDING share is NEVER sheet-backed', () => {
  // The mirror deletes sheet-backed records the sheet no longer lists. A share waiting
  // for approval is parked with homeFolderId 'sheet' but has no row yet — counting it
  // tombstones the share before the parent ever sees the request.
  const recs = [
    { key: 'yt:live0000000', state: 'live', folderId: 'sheet' },
    { key: 'yt:parked00000', state: 'pending', folderId: '~pending', homeFolderId: 'sheet' },
    { key: 'yt:chvideo0000', state: 'live', folderId: 'ch:UCabcdefghijklmnopqrstuv' },
    { key: 'yt:approved000', state: 'live', folderId: '~pending', homeFolderId: 'sheet' }
  ];
  assert.deepEqual(sheetBackedKeysOf(recs), ['yt:live0000000', 'yt:approved000']);
  // channel videos have no row of their own, so the sheet can never "not list" them
  assert.ok(!sheetBackedKeysOf(recs).includes('yt:chvideo0000'));
  // works straight off a Map's values (that is how sync2 calls it) and survives junk
  assert.deepEqual(sheetBackedKeysOf(new Map([['a', recs[0]]]).values()), ['yt:live0000000']);
  assert.deepEqual(sheetBackedKeysOf([null, undefined, {}, 0]), []);
  assert.deepEqual(sheetBackedKeysOf(null), []);
  // ONE predicate behind both forms: buildFolders needs the records, sync2 needs the
  // keys, and the two used to hand-inline the same rule and could drift apart.
  assert.deepEqual(recs.filter(isSheetBacked).map((r) => r.key), sheetBackedKeysOf(recs));
  for (const junk of [null, undefined, {}, 0, 'x']) assert.equal(isSheetBacked(junk), false);
});

test('planScopeAdoption refuses to move a scope a SIBLING still reads', () => {
  const LIB_A = 'lib:aaaa', LIB_B = 'lib:bbbb';
  // the bug this prevents: moveScope DELETES the source scope, so migrating one child
  // used to carry the shared family library away from the other one
  const shared = planScopeAdoption('kid1', LIB_A, LIB_B, [
    { profileId: 'kid2', libraryId: LIB_A },
    { profileId: 'kid3', libraryId: 'lib:zzzz' }
  ]);
  assert.equal(shared.action, 'none');
  assert.deepEqual(shared.sharedWith, ['kid2']);

  // nobody left behind -> migrate, so the parent's content follows the profile
  const alone = planScopeAdoption('kid1', LIB_A, LIB_B, [{ profileId: 'kid3', libraryId: 'lib:zzzz' }]);
  assert.equal(alone.action, 'move');
  assert.deepEqual(alone.sharedWith, []);
  assert.equal(planScopeAdoption('kid1', LIB_A, LIB_B, []).action, 'move');
  // this profile's OWN entry must never count as another owner
  assert.equal(planScopeAdoption('kid1', LIB_A, LIB_B, [{ profileId: 'kid1', libraryId: LIB_A }]).action, 'move');
});

test('planScopeAdoption: nothing to do is never a move', () => {
  for (const [a, b] of [[null, 'lib:b'], ['lib:a', null], ['lib:a', 'lib:a'], [undefined, undefined]]) {
    const r = planScopeAdoption('kid1', a, b, [{ profileId: 'kid2', libraryId: a }]);
    assert.equal(r.action, 'none', `${a} -> ${b}`);
  }
  // junk in the others list must not crash the decision
  assert.equal(planScopeAdoption('kid1', 'lib:a', 'lib:b', [null, {}, { profileId: 'x' }]).action, 'move');
});

test('planGiftRunawayRepair keeps the newest 12 and retires an implausible pile', () => {
  // The state devices are in after the burned-baseline bug: the whole library gifted.
  // giftRank here IS recency only because this fixture says so — see the next test.
  const states = Array.from({ length: 1020 }, (_, i) => ({ profileId: 'p1', key: 'yt:k' + i, giftRank: i + 1 }));
  const { keep, retire } = planGiftRunawayRepair(states);
  assert.equal(keep.length, 12);
  assert.equal(retire.length, 1008);
  assert.deepEqual(keep.slice(0, 3), ['yt:k0', 'yt:k1', 'yt:k2'], 'no recency data: rank order is the fallback');
  assert.equal(new Set([...keep, ...retire]).size, 1020, 'every ranked gift is accounted for exactly once');
});

test('planGiftRunawayRepair ranks by the VIDEOS’ recency, not by giftRank', () => {
  // THE bug this signature exists for: a runaway pile is created by planGifts'
  // INCREMENTAL branch, which stamps maxRank+1 while walking loadMergeIndex — a cursor
  // over the [scopeId,key] primary key, i.e. ALPHABETICAL. So giftRank is uncorrelated
  // with recency exactly on the piles this repairs, and retiring is PERMANENT
  // (unwrappedAt is min-merged forever). Here rank order is the REVERSE of recency.
  const n = 100;
  const states = Array.from({ length: n }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
  const sortKeyOf = new Map(states.map((s, i) => [s.key, i])); // k99 newest, k0 oldest
  const { keep, retire } = planGiftRunawayRepair(states, { sortKeyOf });
  assert.equal(keep.length, 12);
  assert.deepEqual(keep.slice(0, 3), ['yt:k99', 'yt:k98', 'yt:k97'], 'newest first');
  assert.ok(!keep.includes('yt:k0'), 'the oldest video must not survive as a gift');
  assert.ok(retire.includes('yt:k0'));
  assert.equal(new Set([...keep, ...retire]).size, n);

  // a plain object and a function are accepted too (the caller builds whatever it has)
  assert.deepEqual(planGiftRunawayRepair(states, { sortKeyOf: (k) => Number(k.slice(4)) }).keep[0], 'yt:k99');

  // a video we cannot date must never be retired just for missing a sortKey: datable
  // records sort first, and the undatable ones fall back to rank among themselves
  const partial = new Map([['yt:k5', 1000]]);
  const res = planGiftRunawayRepair(states, { sortKeyOf: partial });
  assert.equal(res.keep[0], 'yt:k5');
  assert.equal(res.keep.length, 12);
});

test('planGiftRunawayRepair leaves a plausible gift pile completely alone', () => {
  // A child who simply has not opened their gifts must not be "repaired".
  for (const n of [0, 1, 12, 13, 40, 60]) {
    const states = Array.from({ length: n }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
    assert.deepEqual(planGiftRunawayRepair(states), { keep: [], retire: [] }, `${n} gifts`);
  }
  // already-unwrapped items are not gifts and never count toward the pile
  const mixed = Array.from({ length: 300 }, (_, i) => ({ key: 'yt:u' + i, giftRank: i + 1, unwrappedAt: 5 }));
  assert.deepEqual(planGiftRunawayRepair(mixed), { keep: [], retire: [] });
  for (const junk of [null, undefined, [], [null, {}, 0]]) {
    assert.deepEqual(planGiftRunawayRepair(junk), { keep: [], retire: [] }, JSON.stringify(junk));
  }
});

test('planGiftRunawayRepair is idempotent — the repaired state repairs to nothing', () => {
  const states = Array.from({ length: 500 }, (_, i) => ({ key: 'yt:k' + i, giftRank: i + 1 }));
  const first = planGiftRunawayRepair(states);
  const after = states
    .filter((s) => first.keep.includes(s.key))
    .concat(states.filter((s) => first.retire.includes(s.key)).map((s) => ({ key: s.key, unwrappedAt: 9 })));
  assert.deepEqual(planGiftRunawayRepair(after), { keep: [], retire: [] });
});

test('the Videos tab and a PLAYLIST holding the same video yield ONE record', () => {
  // v1.0.21 — a channel's playlists are pulled as an extra SOURCE, and they mostly
  // contain videos the Videos tab already gave us, so the same id arrives twice in a
  // single run. Both arrivals must collapse: two records would mean two tiles of the
  // same video in the child's folder, and two gifts.
  // The two arrivals must DIFFER the way the real sources do, or the test proves nothing:
  // `snippet.publishedAt` on a playlist item is when it was ADDED TO THE PLAYLIST, so the
  // same video can reach us with a different date and a different title revision.
  const dup = [
    cand({ id: 'vvvvvvvvvvv', titleSource: 'api', publishedAt: 1000, title: 'שיר הבוקר' }),
    cand({ id: 'vvvvvvvvvvv', titleSource: 'api', publishedAt: 7777, title: 'שיר הבוקר (מתוך אוסף)' })
  ];
  const plan = planMutations({ candidates: dup, existing: new Map(), denySet: new Set(), now: 5000 });
  // `puts` is a Map keyed by key, so its LENGTH is structurally guaranteed and proves
  // nothing. What matters is that the video is gifted ONCE and gets ONE sortKey.
  assert.equal(plan.newLiveKeys.filter((k) => k === 'yt:vvvvvvvvvvv').length, 1,
    'one video became two gifts');
  assert.equal(plan.puts.length, 1);
  assert.equal(plan.puts[0].key, 'yt:vvvvvvvvvvv');
  assert.equal(typeof plan.puts[0].sortKey, 'number');

  // and again against an ALREADY-STORED copy (the steady state: uploads imported last
  // run, the playlists stage reaches the same video this run)
  const existing = new Map(plan.puts.map((r) => [r.key, r]));
  const second = planMutations({
    candidates: [cand({ id: 'vvvvvvvvvvv', titleSource: 'api' })],
    existing, denySet: new Set(), now: 6000
  });
  assert.deepEqual(second.puts, [], 'a re-seen video rewrote its record (churn)');
  assert.deepEqual(second.newLiveKeys, [], 'a re-seen video was gifted a second time');
});

/* ---- v1.0.21: Shorts/live exclusion and the playlists-tab source ---- */

const OWN = 'UCabcdefghijklmnopqrstuv';
const OTHER = 'UCzzzzzzzzzzzzzzzzzzzzzz';
const item = (over = {}) => ({ videoId: 'aaaaaaaaaaa', ownerChannelId: OWN, ...over });

test('acceptRssEntry: Shorts and live streams never enter, normal videos do', () => {
  // A grep for the word "isShort" passed for `if (!v.isShort) continue`, which imports
  // ONLY Shorts — the maximally-bad inversion in a child-safety app. A predicate cannot
  // be inverted without failing here.
  assert.equal(acceptRssEntry({ isShort: false, isLive: false }), true);
  assert.equal(acceptRssEntry({ isShort: true, isLive: false }), false);
  assert.equal(acceptRssEntry({ isShort: false, isLive: true }), false);
  assert.equal(acceptRssEntry({ isShort: true, isLive: true }), false);
  // unknown = INCLUDE: everything here rests on undocumented feed behaviour, and a
  // wrongly hidden video is a bug the parent cannot explain
  assert.equal(acceptRssEntry({}), true);
  for (const junk of [null, undefined, 0, '']) assert.equal(acceptRssEntry(junk), false, String(junk));
});

test('acceptPlaylistItem: own uploads only, no Shorts, and PRIVATE entries rejected', () => {
  const shortIds = new Set(['sssssssssss']);
  // the happy path
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN, shortIds }), true);
  // a curated playlist routinely holds OTHER channels' videos — the parent subscribed to
  // this channel, not to whatever it collected
  assert.equal(acceptPlaylistItem(item({ ownerChannelId: OTHER }), { channelId: OWN, shortIds }), false);
  // a Short of this channel, caught by UUSH membership (playlistItems has no flag)
  assert.equal(acceptPlaylistItem(item({ videoId: 'sssssssssss' }), { channelId: OWN, shortIds }), false);
  // PRIVATE / DELETED entries come back with no uploader at all, and rendered as an
  // untappable "Private video" tile for the child. Unlike RSS, unknown here fails CLOSED.
  assert.equal(acceptPlaylistItem(item({ ownerChannelId: '' }), { channelId: OWN, shortIds }), false);
  assert.equal(acceptPlaylistItem({ videoId: 'aaaaaaaaaaa' }, { channelId: OWN, shortIds }), false);
  // junk ids never become records
  for (const bad of ['', 'short', null, undefined, 42, 'aaaaaaaaaaaa']) {
    assert.equal(acceptPlaylistItem(item({ videoId: bad }), { channelId: OWN, shortIds }), false, String(bad));
  }
  // an EMPTY shorts set only ever leaks (documented) — it must not hide own uploads
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN, shortIds: new Set() }), true);
  assert.equal(acceptPlaylistItem(item(), { channelId: OWN }), true);
});

test('planPlaylistAdvance: an INCOMPLETE enumeration never marks the walk done', () => {
  // THE wedge: `playlistsDone` used to be "the queue is empty", which is also true when
  // the enumeration was throttled or errored. One quota blip on the first pass disabled
  // the playlists source for that channel for the life of the install — nothing rearms it.
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: [] }, { listComplete: false }),
    { playlistQueue: [], playlistCursor: null, playlistsDone: false });
  // a COMPLETE enumeration that genuinely found nothing IS done
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: [] }, { listComplete: true }),
    { playlistQueue: [], playlistCursor: null, playlistsDone: true });
  assert.equal(planPlaylistAdvance({ playlistQueue: ['PL1'] }, { listComplete: true }).playlistsDone, false);
});

test('planPlaylistAdvance: pages, playlist hand-off, and a broken playlist', () => {
  // more pages of the head playlist
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'], playlistCursor: null }, { nextPageToken: 'T1' }),
    { playlistQueue: ['A', 'B'], playlistCursor: 'T1', playlistsDone: false });
  // last page of A → move to B, cursor cleared (a stale cursor against B would page
  // from the wrong offset)
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'], playlistCursor: 'T1' }, { nextPageToken: null }),
    { playlistQueue: ['B'], playlistCursor: null, playlistsDone: false });
  // last page of the last playlist → done
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['B'], playlistCursor: 'T9' }, {}),
    { playlistQueue: [], playlistCursor: null, playlistsDone: true });
  // a private/deleted playlist is DROPPED, never retried forever
  assert.deepEqual(planPlaylistAdvance({ playlistQueue: ['A', 'B'] }, { pageError: 'http-404' }),
    { playlistQueue: ['B'], playlistCursor: null, playlistsDone: false });
  // feeding the result back in is a fixed point (the repo's idempotence convention)
  const done = planPlaylistAdvance({ playlistQueue: ['B'] }, {});
  assert.deepEqual(planPlaylistAdvance(done, {}), done);
  for (const junk of [undefined, {}, { playlistQueue: null }]) {
    assert.doesNotThrow(() => planPlaylistAdvance(junk, {}), JSON.stringify(junk));
  }
});

test('planNoLongForm: only a FIRST-page 404 means "this channel posts only Shorts"', () => {
  assert.deepEqual(planNoLongForm({ notFound: true, isFirstPage: true, derived: true }),
    { noLongForm: true, closeBackfill: true });
  // deeper in the walk a 404 is not a verdict about the channel
  assert.equal(planNoLongForm({ notFound: true, isFirstPage: false, derived: true }).noLongForm, false);
  // and a 403 / quota / network failure must NEVER close a backfill
  assert.equal(planNoLongForm({ notFound: false, isFirstPage: true, derived: true }).closeBackfill, false);
  assert.equal(planNoLongForm({}).noLongForm, false);
});

test('planLongFormOutage: every channel 404ing is an OUTAGE, not a fact about them', () => {
  // UULF is undocumented. If YouTube retires it, page 1 answers 404 for EVERY channel at
  // once; acting on that would close every backfill in every family's library in one sync
  // and tell each parent something false. Same spirit as the sheet-mirror valve.
  const all404 = [{ channelId: 'a', notFound: true }, { channelId: 'b', notFound: true }, { channelId: 'c', notFound: true }];
  assert.equal(planLongFormOutage(all404).outage, true);
  // a genuinely Shorts-only channel among healthy ones is NOT an outage
  const mixed = [{ channelId: 'a', notFound: true }, { channelId: 'b', notFound: false }];
  assert.equal(planLongFormOutage(mixed).outage, false);
  assert.equal(planLongFormOutage(mixed).notFoundCount, 1);
  // a single channel can never establish an outage (too small a sample to act on)
  assert.equal(planLongFormOutage([{ channelId: 'a', notFound: true }]).outage, false);
  assert.equal(planLongFormOutage([]).outage, false);
  assert.equal(planLongFormOutage().outage, false);
});

test('planGifts caps the OUTSTANDING gifts, so a bulk arrival is never a wall', () => {
  // v1.0.21. The incremental branch had no ceiling, so approve-all, a channel backfill
  // going live, or a baseline spent on a nearly-empty library gifted EVERYTHING — the
  // v1.0.20 field bug (a "חדשים" folder holding the whole library). Now unrepresentable
  // rather than repairable.
  const live = Array.from({ length: 300 }, (_, i) => ({
    key: 'yt:' + String(i).padStart(11, 'v'), sortKey: 1000 + i, thumbUrl: 'x', type: 'youtube'
  }));
  const puts = planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: new Map(), firstSync: false
  });
  assert.equal(puts.length, 12, 'a 300-video bulk approval produced ' + puts.length + ' gifts');
  // and the NEWEST are the ones that got them
  assert.equal(puts[0].key, live[299].key);
  assert.ok(puts.every((p) => p.giftRank));

  // already-outstanding gifts count against the cap
  const states = new Map(Array.from({ length: 10 }, (_, i) => ['yt:old' + i, { giftRank: i + 1 }]));
  const some = planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: states, firstSync: false
  });
  assert.equal(some.length, 2, 'the cap ignored the 10 gifts already waiting');
  // an OPENED gift frees a slot again, so the folder keeps refilling over time
  const opened = new Map(Array.from({ length: 10 }, (_, i) => ['yt:old' + i, { giftRank: i + 1, unwrappedAt: 5 }]));
  assert.equal(planGifts({
    profileId: 'p1', liveRecords: live, newLiveKeys: live.map((r) => r.key),
    existingStates: opened, firstSync: false
  }).length, 12);
});

test('a same-titled DIFFERENT video from a playlist merges — and stays merged', () => {
  // The playlists tab is exactly the source that multiplies same-title/different-id pairs
  // (an alt mix or re-upload of a song the Videos tab already has), and both tabs feed the
  // SAME run, so this is the realistic shape. planMutations merges them per channel and
  // records the loser in `mergedFrom`, which PERMANENTLY resolves to the survivor — the
  // second video can never be imported again. Pinned so the trade-off is visible.
  const plan = planMutations({
    candidates: [
      cand({ id: 'aaaaaaaaaaa', title: 'Baby Shark', publishedAt: 1000 }),   // Videos tab
      cand({ id: 'bbbbbbbbbbb', title: 'Baby Shark!', publishedAt: 7777 })   // a playlist
    ],
    existing: new Map(), denySet: new Set(), now: 1
  });
  const survivor = plan.puts.find((r) => r.key === 'yt:aaaaaaaaaaa');
  assert.ok(survivor, 'the survivor was not written');
  assert.ok((survivor.mergedFrom || []).includes('yt:bbbbbbbbbbb'), 'the loser was not recorded');
  assert.ok(!plan.puts.some((r) => r.key === 'yt:bbbbbbbbbbb'), 'a duplicate record was created');
  assert.equal(plan.newLiveKeys.length, 1, 'the twin was gifted as a second video');
  assert.equal(plan.mergeReport.length, 1);

  // …and the loser does not resurrect on a later run: mergedFromIndex resolves it back
  const third = planMutations({
    candidates: [cand({ id: 'bbbbbbbbbbb', title: 'Baby Shark!' })],
    existing: new Map(plan.puts.map((r) => [r.key, r])), denySet: new Set(), now: 3
  });
  assert.ok(!third.puts.some((r) => r.key === 'yt:bbbbbbbbbbb'), 'the merged-away id came back');
  assert.deepEqual(third.newLiveKeys, [], 'the merged-away id was gifted again');
});

test('resolveWatchContext: 🎁 is a VIEW, so a gift browses where the video really lives', () => {
  // The under-player grid is how the child reaches the next video, so an empty one is a
  // dead end. Opening a gift UNWRAPS it, which removes it from the sparse by_gift index —
  // so paging 'new' returned fewer items than the child could see, and NOTHING at all when
  // it was the last gift.
  const gift = { key: 'yt:aaaaaaaaaaa', scopeId: 'lib:1', folderId: 'ch:' + CH };
  const fromGift = resolveWatchContext({ item: gift, folderViewId: 'new', libScope: 'lib:1', profileScope: 'prof:p1' });
  assert.equal(fromGift.folderId, 'ch:' + CH, "the gift folder was paged instead of the video's own");
  assert.equal(fromGift.scope, 'lib:1');

  // a REAL folder view still wins over the record: a virtual 🎞️ group folder is not
  // stored on the record, so item.folderId cannot express it (v1.0.12)
  assert.equal(resolveWatchContext({ item: gift, folderViewId: 'grp:' + CH, libScope: 'lib:1' }).folderId, 'grp:' + CH);
  assert.equal(resolveWatchContext({ item: gift, folderViewId: 'sheet', libScope: 'lib:1' }).folderId, 'sheet');

  // video→video from the under-player grid keeps the context it already had
  assert.equal(resolveWatchContext({
    item: { key: 'yt:bbbbbbbbbbb', scopeId: 'lib:1', folderId: 'sheet' },
    isWatching: true, prevFolderId: 'grp:' + CH, libScope: 'lib:1'
  }).folderId, 'grp:' + CH);

  // '~pending' is a parking slot and must NEVER be browsed — it is in no index
  const parked = { key: 'yt:ccccccccccc', scopeId: 'lib:1', folderId: '~pending', homeFolderId: 'sheet' };
  assert.equal(resolveWatchContext({ item: parked, libScope: 'lib:1' }).folderId, 'sheet');
  assert.equal(resolveWatchContext({ item: { ...parked, homeFolderId: '~pending' }, libScope: 'lib:1' }).folderId, null);

  // opened from SEARCH (no folder view): the record's own folder
  assert.equal(resolveWatchContext({ item: gift, folderViewId: null, libScope: 'lib:1' }).folderId, 'ch:' + CH);
  // 'mine' resolves against the PROFILE scope, not the library
  assert.equal(resolveWatchContext({
    item: { key: 'yt:ddddddddddd', folderId: 'mine' }, libScope: 'lib:1', profileScope: 'prof:p1'
  }).scope, 'prof:p1');
  assert.doesNotThrow(() => resolveWatchContext({}));
  assert.doesNotThrow(() => resolveWatchContext());
});
