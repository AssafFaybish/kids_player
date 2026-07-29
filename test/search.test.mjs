// Home-search ranking (v1.0.7) — pure. The promise to the user: results ordered by
// match accuracy (exact > starts-with > word-start > substring), Hebrew-normalized
// on both sides so niqqud/emoji/punctuation never hide a match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch, rankItems } from '../www/js/search.js';

const rec = (key, title) => ({ key, normTitle: title });

test('scoreMatch tiers: exact > starts-with > word-start > substring > none', () => {
  const exact = scoreMatch('בובספוג', 'בובספוג');
  const starts = scoreMatch('בוב', 'בובספוג מכנס מרובע');
  const word = scoreMatch('מכנס', 'בובספוג מכנס מרובע');
  const sub = scoreMatch('כנס', 'בובספוג מכנס מרובע');
  assert.ok(exact > starts && starts > word && word > sub && sub > 0);
  assert.equal(scoreMatch('פיקאצ׳ו', 'בובספוג מכנס מרובע'), 0);
});

test('rankItems: accuracy order, Hebrew normalization on the query side', () => {
  const items = [
    rec('a', 'שיר הפרפרים'),
    rec('b', 'פרפרים בגינה'),
    rec('c', 'הרפתקאות עם פרפרים ועוד'),
    rec('d', 'חתולים')
  ];
  // query carries niqqud + emoji — must still match the normalized titles.
  // order: starts-with (b) > word-start (c) > substring "הפרפרים" (a)
  const out = rankItems('פַּרְפָּרִים 🦋', items);
  assert.deepEqual(out.map((r) => r.item.key), ['b', 'c', 'a']);
});

test('rankItems: partial word matches, earlier substring wins, ties by shorter title', () => {
  const items = [rec('long', 'שיר ארוך מאוד על פרח'), rec('short', 'שיר על פרח')];
  const out = rankItems('פרח', items);
  assert.equal(out.length, 2);
  assert.equal(out[0].item.key, 'short'); // same tier — shorter title first
});

test('rankItems: guards — short/blank queries return nothing, limit respected', () => {
  const many = Array.from({ length: 40 }, (_, i) => rec('k' + i, 'סרטון מספר ' + i));
  assert.deepEqual(rankItems('', many), []);
  assert.deepEqual(rankItems('ס', many), []); // below minLength
  assert.equal(rankItems('סרטון', many).length, 24); // default cap
  assert.equal(rankItems('סרטון', many, { limit: 5 }).length, 5);
  assert.deepEqual(rankItems('סרטון', null), []);
});
