// TV D-pad spatial navigation (v1.0.9) — pure geometry. The promise: focus moves the
// way a remote user expects — straight-line neighbors beat closer-but-diagonal ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNextIndex, pickFirstIndex } from '../www/js/spatial.js';

const r = (left, top, width = 100, height = 100) => ({ left, top, width, height });

// a 3×2 tile grid:      idx: 0 1 2
//                            3 4 5
const grid = [
  r(0, 0), r(120, 0), r(240, 0),
  r(0, 120), r(120, 120), r(240, 120)
];

test('cardinal moves land on the straight-line neighbor', () => {
  assert.equal(pickNextIndex(grid, 0, 'right'), 1);
  assert.equal(pickNextIndex(grid, 1, 'right'), 2);
  assert.equal(pickNextIndex(grid, 1, 'left'), 0);
  assert.equal(pickNextIndex(grid, 1, 'down'), 4);
  assert.equal(pickNextIndex(grid, 4, 'up'), 1);
});

test('edges return -1 (no wrap-around — TV focus never teleports)', () => {
  assert.equal(pickNextIndex(grid, 0, 'left'), -1);
  assert.equal(pickNextIndex(grid, 2, 'right'), -1);
  assert.equal(pickNextIndex(grid, 0, 'up'), -1);
  assert.equal(pickNextIndex(grid, 3, 'down'), -1);
});

test('orthogonal drift is penalized: directly-below beats closer-but-diagonal', () => {
  // from 0 going down: 4 is nearer in pure distance terms when shifted, but 3 is straight below
  assert.equal(pickNextIndex(grid, 0, 'down'), 3);
  // a row of two + one far item straight below the first
  const rects = [r(0, 0), r(120, 0), r(0, 300)];
  assert.equal(pickNextIndex(rects, 0, 'down'), 2);
});

test('zero-size (hidden) rects are never picked; junk input is safe', () => {
  const rects = [r(0, 0), { left: 0, top: 120, width: 0, height: 0 }, r(0, 240)];
  assert.equal(pickNextIndex(rects, 0, 'down'), 2);
  assert.equal(pickNextIndex(rects, 9, 'down'), -1); // bad fromIdx
  assert.equal(pickNextIndex(rects, 0, 'sideways'), -1); // bad dir
});

test('pickFirstIndex: top row wins; RTL prefers the right-most tile', () => {
  assert.equal(pickFirstIndex(grid), 2); // top-right in RTL
  assert.equal(pickFirstIndex(grid, { rtl: false }), 0);
  assert.equal(pickFirstIndex([{ left: 0, top: 0, width: 0, height: 0 }]), -1);
});
