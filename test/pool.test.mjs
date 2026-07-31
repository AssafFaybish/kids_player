// mapWithConcurrency tests — the workhorse of the sync pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency, fnv1a, canonicalSheetKey, libraryIdFor } from '../www/js/util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('never exceeds the concurrency limit', async () => {
  let running = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    running += 1; peak = Math.max(peak, running);
    await sleep(5);
    running -= 1;
  });
  assert.ok(peak <= 4, `peak was ${peak}`);
});

test('preserves input order in the output', async () => {
  const out = await mapWithConcurrency([3, 1, 2], 3, async (x) => { await sleep(x * 5); return x * 10; });
  assert.deepEqual(out.map((r) => r.value), [30, 10, 20]);
});

test('one rejection does not kill the rest', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error('boom');
    return x;
  });
  assert.deepEqual(out.map((r) => r.ok), [true, false, true]);
  assert.equal(out[1].error, 'boom');
});

test('honors AbortSignal mid-flight', async () => {
  const ctl = new AbortController();
  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (x) => {
    if (x === 2) ctl.abort();
    return x;
  }, { signal: ctl.signal });
  assert.ok(out.some((r) => r.ok === false && r.error === 'aborted'));
  assert.ok(out.filter((r) => r.ok).length <= 2);
});

test('edge cases: limit > length, empty input, onProgress count', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async (x) => x), []);
  let calls = 0;
  const out = await mapWithConcurrency([1, 2], 99, async (x) => x, { onProgress: () => { calls += 1; } });
  assert.equal(out.length, 2);
  assert.equal(calls, 2);
});

test('fnv1a is stable and hex-shaped; libraryIdFor canonicalizes sheet variants together', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.match(fnv1a('abc'), /^[0-9a-f]{8}$/);
  const a = libraryIdFor('https://docs.google.com/spreadsheets/d/SHEET/edit#gid=0');
  const b = libraryIdFor('https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=0');
  assert.equal(a, b); // /edit and /export of the same sheet+gid = same library
  // gid=0 IS the default first tab — a bare link must be the SAME library (real bug:
  // re-saving the URL in a different form orphaned the whole library + gift states)
  assert.equal(libraryIdFor('https://docs.google.com/spreadsheets/d/SHEET/edit'), a);
  assert.notEqual(libraryIdFor('https://docs.google.com/spreadsheets/d/SHEET/edit#gid=123'), a);
  const c = libraryIdFor('https://docs.google.com/spreadsheets/d/OTHER/edit');
  assert.notEqual(a, c);
  assert.equal(canonicalSheetKey(''), '');
  assert.equal(libraryIdFor(''), null);
});

/* ---------------- v1.0.17: WHY a scope migration is needed ---------------- */

test('libraryIdFor: the scope IS the sheet identity — changing sheets changes scope', () => {
  const a = libraryIdFor('https://docs.google.com/spreadsheets/d/AAA/edit');
  const b = libraryIdFor('https://docs.google.com/spreadsheets/d/BBB/edit');
  assert.notEqual(a, b, 'two sheets must never share a library scope');
  // …and a profile with no sheet gets a scope that no sheet can ever produce, which is
  // exactly why connecting a sheet later MUST move the content (db.moveScope):
  assert.equal(libraryIdFor(''), null);
  assert.equal(libraryIdFor(null), null);
  assert.ok(!String(a).startsWith('lib:p:'), 'sheet scopes never collide with lib:p:<profile>');
});

test('fnv1a is pinned to LITERAL values — it is persisted cross-device identity', () => {
  // Why a literal and not `f(x) === f(x)`: this hash is not an implementation detail. It
  // is the `scopeId` component of every IndexedDB primary key, every key in the Drive
  // doc's `libraries` map, and the sheet-change signature. Swapping the algorithm (or
  // "tidying" the >>> 0, the seed, or the char iteration) would orphan every install's
  // library and gift state on upgrade — silently, since nothing would throw. The old
  // stability test could not tell: any hash function passes `f(x) === f(x)`.
  assert.equal(fnv1a('abc'), '1a47e90b');
  assert.equal(fnv1a('שיר'), '03c103dd', 'non-ASCII must hash by code unit, unchanged');
  assert.equal(fnv1a(''), '811c9dc5', 'the empty string is the bare FNV offset basis');
  assert.equal(libraryIdFor('https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0'), 'lib:930dc871');
  // …and the shape contract the rest of the app relies on
  assert.match(fnv1a('anything'), /^[0-9a-f]{8}$/);
});
