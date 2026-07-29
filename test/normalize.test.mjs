// Hebrew-aware normalization + merge policy tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, mergeVideoRecord } from '../www/js/normalize.js';

test('niqqud strips: שָׁלוֹם == שלום', () => {
  assert.equal(normalizeTitle('שָׁלוֹם יְלָדִים'), normalizeTitle('שלום ילדים'));
});

test('bidi controls (the Google Sheets RTL/LTR case) are invisible duplicates', () => {
  assert.equal(normalizeTitle('רחלי ‏The Way‎ פרק 1'), normalizeTitle('רחלי The Way פרק 1'));
});

test('emoji, skin tones and ZWJ sequences are stripped', () => {
  assert.equal(normalizeTitle('שיר החיות 🦁🐼'), normalizeTitle('שיר החיות'));
  assert.equal(normalizeTitle('משפחה 👨‍👩‍👧‍👦 שלי'), normalizeTitle('משפחה שלי'));
  assert.equal(normalizeTitle('אגודל 👍🏽'), normalizeTitle('אגודל'));
});

test('Hebrew punctuation ״ ׳ and dashes fold to spaces', () => {
  assert.equal(normalizeTitle('צה״ל — פרק 2!!!'), normalizeTitle('צה ל פרק 2'));
});

test('case folds for Latin substrings', () => {
  assert.equal(normalizeTitle('The Rachelli WAY'), normalizeTitle('the rachelli way'));
});

test('episode markers are KEPT (different episodes stay different)', () => {
  assert.notEqual(normalizeTitle('פרק 1'), normalizeTitle('פרק 2'));
});

test('emoji-only input normalizes to empty (and empty must never dedupe)', () => {
  assert.equal(normalizeTitle('🎈🎈'), '');
});

test('idempotence: f(f(x)) === f(x)', () => {
  const x = 'שָׁלוֹם 🎈 The WAY — פרק 3!!';
  assert.equal(normalizeTitle(normalizeTitle(x)), normalizeTitle(x));
});

test('mergeVideoRecord: localPath beats newer-but-pathless; addedAt takes min', () => {
  const a = { key: 'yt:a', addedAt: 100, localPath: null, title: 'א', titleSource: 'sheet', state: 'live' };
  const b = { key: 'yt:a', addedAt: 200, localPath: 'videos/x.mp4', title: 'א', titleSource: 'sheet', state: 'live' };
  const m = mergeVideoRecord(a, b);
  assert.equal(m.localPath, 'videos/x.mp4');
  assert.equal(m.addedAt, 100);
});

test('mergeVideoRecord: live beats pending; better titleSource wins', () => {
  const a = { key: 'yt:a', addedAt: 100, state: 'pending', title: 'קצר', titleSource: 'oembed' };
  const b = { key: 'yt:a', addedAt: 200, state: 'live', title: 'כותרת מלאה מהאיי-פי-איי', titleSource: 'api' };
  const m = mergeVideoRecord(a, b);
  assert.equal(m.state, 'live');
  assert.equal(m.titleSource, 'api');
  assert.equal(m.title, 'כותרת מלאה מהאיי-פי-איי');
});

test('mergeVideoRecord: mergedFrom accumulates the loser key, never undefined-clobbers', () => {
  const a = { key: 'yt:a', addedAt: 100, title: 'א', localPath: 'videos/a.mp4', mergedFrom: ['yt:old'] };
  const b = { key: 'yt:b', addedAt: 200, title: 'א' };
  const m = mergeVideoRecord(a, b);
  assert.equal(m.key, 'yt:a');
  assert.ok(m.mergedFrom.includes('yt:old'));
  assert.ok(m.mergedFrom.includes('yt:b'));
  assert.equal(m.localPath, 'videos/a.mp4');
});
