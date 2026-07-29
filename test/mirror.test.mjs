// Sheet mirroring (v1.0.10) — pure planner tests. The sheet is the single source of
// truth in both directions; the safety valve must make a truncated read harmless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSheetMirror } from '../www/js/plan.js';

const prevSeen = {
  videoKeys: ['yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', 'yt:aaaaaaaaaa3'],
  channelIds: ['UCchan111111111111111111', 'UCchan222222222222222222']
};

test('a removed row deletes; a still-present row does not', () => {
  const m = planSheetMirror({
    prevSeen,
    currentVideoKeys: ['yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa3'],
    currentChannelIds: ['UCchan111111111111111111']
  });
  assert.deepEqual(m.deleteVideoKeys, ['yt:aaaaaaaaaa2']);
  assert.deepEqual(m.deleteChannelIds, ['UCchan222222222222222222']);
  assert.equal(m.valve, false);
});

test('queued-but-unflushed appends are lag, not deletions', () => {
  const m = planSheetMirror({
    prevSeen: { videoKeys: ['yt:aaaaaaaaaa1'], channelIds: ['UCchan111111111111111111'] },
    currentVideoKeys: [], currentChannelIds: [],
    pendingAppendKeys: ['yt:aaaaaaaaaa1', 'ch:UCchan111111111111111111']
  });
  assert.deepEqual(m.deleteVideoKeys, []);
  assert.deepEqual(m.deleteChannelIds, []);
});

test('re-added key that is locally denied → unDeny (sheet wins over an old delete)', () => {
  const m = planSheetMirror({
    prevSeen: { videoKeys: ['yt:aaaaaaaaaa1'], channelIds: [] },
    currentVideoKeys: ['yt:aaaaaaaaaa1', 'yt:bbbbbbbbbb1', 'yt:cccccccccc1'],
    currentChannelIds: [],
    deniedKeys: new Set(['yt:bbbbbbbbbb1'])
  });
  assert.deepEqual(m.unDenyKeys, ['yt:bbbbbbbbbb1']); // re-added + denied
  // ccc is new but not denied; aaa was already present — neither un-denies
});

test('SAFETY VALVE: a mass disappearance stops all mirroring', () => {
  const many = { videoKeys: Array.from({ length: 40 }, (_, i) => 'yt:v' + i), channelIds: [] };
  const m = planSheetMirror({ prevSeen: many, currentVideoKeys: many.videoKeys.slice(0, 10), currentChannelIds: [] });
  assert.equal(m.valve, true);
  assert.equal(m.disappeared, 30);
  // small libraries: even 3 missing of 5 is below the absolute minimum of 10 → no valve
  const small = planSheetMirror({ prevSeen: { videoKeys: ['a','b','c','d','e'].map(x=>'yt:'+x), channelIds: [] }, currentVideoKeys: ['yt:a','yt:b'], currentChannelIds: [] });
  assert.equal(small.valve, false);
});

test('first sync (empty prevSeen) never deletes and never trips the valve', () => {
  const m = planSheetMirror({ prevSeen: null, currentVideoKeys: ['yt:aaaaaaaaaa1'], currentChannelIds: [] });
  assert.deepEqual(m.deleteVideoKeys, []);
  assert.equal(m.valve, false);
});
