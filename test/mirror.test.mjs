// Sheet mirroring (v1.0.10) — pure planner tests, PRESENCE-based: the sheet is the
// single source of truth judged fresh on every parse. This shape (vs a remembered
// diff baseline) is what makes Drive-doc resurrections die on the next sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSheetMirror } from '../www/js/plan.js';

const base = {
  sheetBackedKeys: ['yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa2', 'yt:aaaaaaaaaa3'],
  localChannelIds: ['UCchan111111111111111111', 'UCchan222222222222222222']
};

test('missing from the sheet → delete; present → keep', () => {
  const m = planSheetMirror({
    ...base,
    currentVideoKeys: ['yt:aaaaaaaaaa1', 'yt:aaaaaaaaaa3'],
    currentChannelIds: ['UCchan111111111111111111']
  });
  assert.deepEqual(m.deleteVideoKeys, ['yt:aaaaaaaaaa2']);
  assert.deepEqual(m.deleteChannelIds, ['UCchan222222222222222222']);
  assert.equal(m.valve, false);
});

test('Drive-doc resurrection dies: a re-imported record missing from the sheet is re-deleted', () => {
  // the record exists locally again (stale doc merge) but the sheet does NOT list it —
  // presence-based planning deletes it on EVERY pass, not only on a remembered diff
  const m = planSheetMirror({
    sheetBackedKeys: ['yt:resurrected'], localChannelIds: [],
    currentVideoKeys: [], currentChannelIds: []
  });
  assert.deepEqual(m.deleteVideoKeys, ['yt:resurrected']);
});

test('queued-but-unflushed APPENDS are lag, not deletions', () => {
  const m = planSheetMirror({
    sheetBackedKeys: ['yt:justadded'], localChannelIds: ['UCnewchan111111111111111'],
    currentVideoKeys: [], currentChannelIds: [],
    pendingAppendKeys: ['yt:justadded', 'ch:UCnewchan111111111111111']
  });
  assert.deepEqual(m.deleteVideoKeys, []);
  assert.deepEqual(m.deleteChannelIds, []);
});

test('a DENIED key the sheet lists revives (sheet wins) — unless its removal is still queued', () => {
  const m = planSheetMirror({
    sheetBackedKeys: [], localChannelIds: [],
    currentVideoKeys: ['yt:readded', 'yt:beingdeleted'],
    currentChannelIds: [],
    deniedKeys: new Set(['yt:readded', 'yt:beingdeleted', 'yt:gone']),
    pendingDeleteKeys: ['yt:beingdeleted'] // our own row-removal still in flight
  });
  assert.deepEqual(m.unDenyKeys, ['yt:readded']);
});

test('SAFETY VALVE: mass deletion stops everything; small cleanups never ask', () => {
  const many = Array.from({ length: 400 }, (_, i) => 'yt:v' + i);
  const big = planSheetMirror({
    sheetBackedKeys: many, localChannelIds: [],
    currentVideoKeys: many.slice(0, 300), currentChannelIds: []
  });
  assert.equal(big.valve, true);   // 100 gone > max(10, 5% of 400 = 20)
  assert.equal(big.disappeared, 100);

  const routine = planSheetMirror({
    sheetBackedKeys: many, localChannelIds: [],
    currentVideoKeys: many.slice(8), currentChannelIds: []
  });
  assert.equal(routine.valve, false); // 8 gone ≤ 20 → silently mirrored

  const small = planSheetMirror({
    sheetBackedKeys: ['yt:a', 'yt:b', 'yt:c'], localChannelIds: [],
    currentVideoKeys: [], currentChannelIds: []
  });
  assert.equal(small.valve, false); // 3 ≤ absolute minimum 10 — tiny libraries never valve
});

test('empty local state never deletes and never valves (fresh install)', () => {
  const m = planSheetMirror({
    sheetBackedKeys: [], localChannelIds: [],
    currentVideoKeys: ['yt:aaaaaaaaaa1'], currentChannelIds: []
  });
  assert.deepEqual(m.deleteVideoKeys, []);
  assert.equal(m.valve, false);
});
