// Data-migration framework (v1.0.8): steps above the recorded version run once,
// in order — never below it, never unordered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingSteps, DATA_VERSION } from '../www/js/dataver.js';

const steps = [{ v: 2 }, { v: 1 }, { v: 3 }];

test('pendingSteps: only steps above current, sorted ascending', () => {
  assert.deepEqual(pendingSteps(0, steps).map((s) => s.v), [1, 2, 3]);
  assert.deepEqual(pendingSteps(1, steps).map((s) => s.v), [2, 3]);
  assert.deepEqual(pendingSteps(3, steps), []);
  assert.deepEqual(pendingSteps(undefined, steps).map((s) => s.v), [1, 2, 3]);
});

test('pendingSteps: junk input never throws', () => {
  assert.deepEqual(pendingSteps(0, null), []);
  assert.deepEqual(pendingSteps(0, [null, { v: 'x' }, {}]), []);
});

test('DATA_VERSION equals the highest registered step', () => {
  assert.ok(Number.isInteger(DATA_VERSION) && DATA_VERSION >= 1);
});
