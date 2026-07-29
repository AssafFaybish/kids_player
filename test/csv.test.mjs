// CSV tokenizer tests — including the live-bug regression: a quoted Hebrew title
// containing a comma must survive intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../www/js/csv.js';
import { parseList } from '../www/js/sync.js';

test('quoted field with a comma survives (Hebrew title regression)', () => {
  const rows = parseCsv('https://x,"פרפרים, חלק 2",');
  assert.deepEqual(rows, [['https://x', 'פרפרים, חלק 2', '']]);
});

test('parseList end-to-end keeps the quoted Hebrew title', () => {
  const rows = parseList('https://www.youtube.com/watch?v=dQw4w9WgXcQ,"פרפרים, חלק 2",');
  assert.equal(rows[0].title, 'פרפרים, חלק 2');
});

test('doubled quotes escape a quote', () => {
  assert.deepEqual(parseCsv('"say ""hi""",b'), [['say "hi"', 'b']]);
});

test('newline inside quotes is literal', () => {
  assert.deepEqual(parseCsv('"line1\nline2",b'), [['line1\nline2', 'b']]);
});

test('CRLF rows and trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('UTF-8 BOM from Google Sheets export is stripped', () => {
  assert.deepEqual(parseCsv('﻿a,b'), [['a', 'b']]);
});

test('tab-separated fallback for comma-less rows', () => {
  assert.deepEqual(parseCsv('a\tb\tc'), [['a', 'b', 'c']]);
});

test('empty and blank input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv('\n'), [['']]);
});
