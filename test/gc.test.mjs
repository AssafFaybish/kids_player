// Orphan sweep + loose-single grouping.
//
// v1.0.38: the presence-mirror tests that gave this file its name are gone with the mirror
// (the sheet no longer deletes anything). What survives is the machinery the mirror USED to
// carry and that now stands on its own: planOrphanGC — which for the first time runs for
// every profile, not only sheet-backed ones — its new valve, and groupSinglesByChannel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSinglesByChannel } from '../www/js/plan.js';

const s = (key, srcChannelId, srcChannelTitle = '') => ({ key, srcChannelId, srcChannelTitle });

test('2+ singles of one channel group; a lone single stays loose', () => {
  const g = groupSinglesByChannel([
    s('yt:a1', 'UCkids', 'ערוץ הילדים'),
    s('yt:a2', 'UCkids', 'ערוץ הילדים'),
    s('yt:b1', 'UCsolo', 'ערוץ בודד'),
    s('yt:c1', null)
  ], []);
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].channelId, 'UCkids');
  assert.equal(g.groups[0].title, 'ערוץ הילדים');
  assert.deepEqual(g.groups[0].keys.sort(), ['yt:a1', 'yt:a2']);
  assert.deepEqual(g.loose.sort(), ['yt:b1', 'yt:c1']); // lone single + unknown channel
});

test('deleting down to ONE un-groups automatically (no migration)', () => {
  const before = groupSinglesByChannel([s('yt:a1', 'UCk'), s('yt:a2', 'UCk')], []);
  assert.equal(before.groups.length, 1);
  const after = groupSinglesByChannel([s('yt:a1', 'UCk')], []); // one was deleted
  assert.equal(after.groups.length, 0);
  assert.deepEqual(after.loose, ['yt:a1']);
});

test('singles of an ALREADY-SUBSCRIBED channel are absorbed, never a second folder', () => {
  const g = groupSinglesByChannel(
    [s('yt:a1', 'UCsub'), s('yt:a2', 'UCsub'), s('yt:z1', 'UCfree'), s('yt:z2', 'UCfree')],
    ['UCsub']
  );
  assert.deepEqual(g.groups.map((x) => x.channelId), ['UCfree']);
  assert.deepEqual(g.absorb.get('UCsub').sort(), ['yt:a1', 'yt:a2']);
  // even ONE single of a subscribed channel is absorbed (it belongs in that folder)
  const one = groupSinglesByChannel([s('yt:a1', 'UCsub')], ['UCsub']);
  assert.deepEqual(one.absorb.get('UCsub'), ['yt:a1']);
  assert.deepEqual(one.loose, []);
});

test('grouping is deterministic and junk-safe', () => {
  const g1 = groupSinglesByChannel([s('yt:a', 'UC1'), s('yt:b', 'UC1'), s('yt:c', 'UC2'), s('yt:d', 'UC2'), s('yt:e', 'UC2')], []);
  const g2 = groupSinglesByChannel([s('yt:e', 'UC2'), s('yt:d', 'UC2'), s('yt:b', 'UC1'), s('yt:c', 'UC2'), s('yt:a', 'UC1')], []);
  assert.deepEqual(g1.groups.map((x) => x.channelId), g2.groups.map((x) => x.channelId)); // biggest first
  assert.equal(g1.groups[0].channelId, 'UC2');
  const junk = groupSinglesByChannel([null, undefined, {}, s(null, 'UC1')], []);
  assert.deepEqual(junk.groups, []);
  assert.deepEqual(junk.loose, []);
  assert.deepEqual(groupSinglesByChannel(null, null).groups, []);
});

/* ---- v1.0.18: a TOTAL disappearance always asks the parent ---- */

test('planOrphanGC: a standalone playlist\'s videos are NOT orphans', async () => {
  const { planOrphanGC } = await import('../www/js/plan.js');
  // THE BUG (shipped in v1.0.26, review-caught): the playlist subscription carries
  // `PL…` in channelId while its videos carry their OWNER (`UC…`) — deliberately — so
  // the old one-line predicate deleted every foreign-owner playlist video on every
  // mirror pass: imported, wiped, re-imported pending, with every approval AND every
  // rejection undone in a 30-minute loop, and no tombstone written.
  const subs = [
    { channelId: 'UCsub111111111111111111', kind: 'channel' },
    { channelId: 'PLmix1234567890', kind: 'playlist' }
  ];
  const recs = [
    // playlist video, FOREIGN owner — the exact record the old GC deleted
    { key: 'yt:pl000000001', channelId: 'UCforeign000000000000000', folderId: 'pl:PLmix1234567890' },
    // playlist video whose owner is also subscribed → unify rule put it in ch: — safe by channelId
    { key: 'yt:pl000000002', channelId: 'UCsub111111111111111111', folderId: 'ch:UCsub111111111111111111' },
    // ordinary subscribed-channel video
    { key: 'yt:ch000000001', channelId: 'UCsub111111111111111111', folderId: 'ch:UCsub111111111111111111' },
    // a REAL orphan: its channel is not subscribed and no playlist folder claims it
    { key: 'yt:orphan00001', channelId: 'UCgone000000000000000000', folderId: 'ch:UCgone000000000000000000' },
    // no channelId at all (manual/direct-file) — the GC has never had an opinion
    { key: 'file:abc', channelId: null, folderId: 'sheet' }
  ];
  assert.deepEqual(planOrphanGC(recs, subs), ['yt:orphan00001']);
});

test('planOrphanGC: PARKED playlist videos are judged by the folder they return to', async () => {
  const { planOrphanGC } = await import('../www/js/plan.js');
  const subs = [{ channelId: 'PLmix1234567890', kind: 'playlist' }];
  const recs = [
    { key: 'yt:pending0001', channelId: 'UCforeign000000000000000', folderId: '~pending', homeFolderId: 'pl:PLmix1234567890' },
    { key: 'yt:reject00001', channelId: 'UCforeign000000000000000', folderId: '~rejected', homeFolderId: 'pl:PLmix1234567890' },
    // parked, but its home is a playlist nobody subscribes to any more → real orphan
    { key: 'yt:stale000001', channelId: 'UCforeign000000000000000', folderId: '~pending', homeFolderId: 'pl:PLgone000000000' }
  ];
  assert.deepEqual(planOrphanGC(recs, subs), ['yt:stale000001']);
});

test('planOrphanGC: deleting the playlist subscription DOES orphan its videos', async () => {
  const { planOrphanGC } = await import('../www/js/plan.js');
  // The GC's legitimate job must survive the fix: remove the playlist and its foreign
  // videos are homeless (owner not subscribed, folder no longer claimed) → deleted.
  const recs = [
    { key: 'yt:pl000000001', channelId: 'UCforeign000000000000000', folderId: 'pl:PLmix1234567890' }
  ];
  assert.deepEqual(planOrphanGC(recs, []), ['yt:pl000000001']);
  // …but an owner that IS subscribed keeps the video (the unify rule will re-home it)
  assert.deepEqual(planOrphanGC(recs, [{ channelId: 'UCforeign000000000000000', kind: 'channel' }]), []);
  // junk never throws
  assert.deepEqual(planOrphanGC(null, null), []);
  assert.deepEqual(planOrphanGC([null, {}], [null]), []);
});

test('orphanSweepValve: a routine cleanup sweeps, an implausible one is PARKED', async () => {
  const { orphanSweepValve } = await import('../www/js/plan.js');
  // WHY THIS EXISTS: planOrphanGC only ever ran inside the sheet mirror, so a sheet-less
  // profile never swept at all. Making it unconditional is a bug fix, but the FIRST pass on
  // an old install can find months of accumulated orphans, and deleteVideoRaw writes no
  // tombstone — a mass sweep churns against the Drive doc (deleted here, re-unioned there).
  assert.deepEqual(orphanSweepValve({ orphanCount: 3, liveTotal: 500 }), { sweep: true, parked: false, count: 3 });
  assert.deepEqual(orphanSweepValve({ orphanCount: 0, liveTotal: 500 }), { sweep: false, parked: false, count: 0 });
  // above max(10, 5%) -> parked
  assert.equal(orphanSweepValve({ orphanCount: 30, liveTotal: 500 }).parked, true);
  assert.equal(orphanSweepValve({ orphanCount: 25, liveTotal: 500 }).sweep, true, '5% of 500 is 25 — at the ceiling, not above it');
  // the 10-item floor: a small library's routine cleanup must not ask
  assert.equal(orphanSweepValve({ orphanCount: 8, liveTotal: 40 }).sweep, true);
  assert.equal(orphanSweepValve({ orphanCount: 11, liveTotal: 40 }).parked, true);
});

test('orphanSweepValve: taking EVERYTHING is parked whatever the percentage says', async () => {
  const { orphanSweepValve } = await import('../www/js/plan.js');
  // The v1.0.18 rule, ported: the percentage floor alone silently wiped a child who owned
  // ≤10 things. A sweep that leaves nothing is never routine.
  assert.equal(orphanSweepValve({ orphanCount: 4, liveTotal: 4 }).parked, true);
  assert.equal(orphanSweepValve({ orphanCount: 1, liveTotal: 1 }).parked, true);
  assert.equal(orphanSweepValve({ orphanCount: 5, liveTotal: 4 }).parked, true, 'more orphans than live records is still everything');
  // a fresh install has nothing to lose and must not alarm
  assert.deepEqual(orphanSweepValve({ orphanCount: 0, liveTotal: 0 }), { sweep: false, parked: false, count: 0 });
  // unknown total (0 live but orphans exist — parked rows only) falls back to the floor
  assert.equal(orphanSweepValve({ orphanCount: 3, liveTotal: 0 }).sweep, true);
});

test('orphanSweepValve never throws on junk', async () => {
  const { orphanSweepValve } = await import('../www/js/plan.js');
  for (const bad of [undefined, {}, null, { orphanCount: 'x', liveTotal: 'y' }, { orphanCount: -5, liveTotal: -1 },
    { orphanCount: NaN, liveTotal: NaN }]) {
    const r = orphanSweepValve(bad);
    assert.equal(typeof r.sweep, 'boolean');
    assert.equal(typeof r.parked, 'boolean');
  }
});
