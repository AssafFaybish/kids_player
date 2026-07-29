// Ordering tests — the reversal requirement and the append-stability invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortKeyFor, compareForDisplay, SHEET_BASE, MANUAL_BASE } from '../www/js/order.js';

const disp = (items) => items.slice().sort(compareForDisplay).map((i) => i.key);

test('sheet rows display REVERSED: last row in the file is shown first', () => {
  const rows = [0, 1, 2].map((rowIndex) => ({
    key: 'r' + rowIndex, sortKey: sortKeyFor({ origin: 'sheet-row', rowIndex })
  }));
  assert.deepEqual(disp(rows), ['r2', 'r1', 'r0']);
});

test('channel videos order by publishedAt, newest first', () => {
  const vids = [
    { key: 'old', sortKey: sortKeyFor({ origin: 'channel', publishedAt: 1000 }) },
    { key: 'new', sortKey: sortKeyFor({ origin: 'channel', publishedAt: 2000 }) }
  ];
  assert.deepEqual(disp(vids), ['new', 'old']);
});

test('manual/share items always sort above sheet rows', () => {
  const sheetTop = sortKeyFor({ origin: 'sheet-row', rowIndex: 999999 });
  const manual = sortKeyFor({ origin: 'manual', addedAt: Date.now() });
  assert.ok(manual > sheetTop);
  assert.ok(sheetTop > SHEET_BASE);
  assert.ok(manual > MANUAL_BASE);
});

test('KEY INVARIANT: appending a row never renumbers existing rows', () => {
  const before = [0, 1, 2].map((i) => sortKeyFor({ origin: 'sheet-row', rowIndex: i }));
  // a 4th row appears in the sheet
  const after = [0, 1, 2, 3].map((i) => sortKeyFor({ origin: 'sheet-row', rowIndex: i }));
  assert.deepEqual(after.slice(0, 3), before);
});

test('compareForDisplay is a deterministic total order (key tiebreak)', () => {
  const a = { key: 'a', sortKey: 5 };
  const b = { key: 'b', sortKey: 5 };
  assert.ok(compareForDisplay(a, b) < 0);
  assert.ok(compareForDisplay(b, a) > 0);
  assert.equal(compareForDisplay(a, a), 0);
});
