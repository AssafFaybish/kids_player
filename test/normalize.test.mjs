// Hebrew-aware normalization + merge policy tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, mergeVideoRecord, resolveCuration, settleCuration, PARKED } from '../www/js/normalize.js';

/* ---------------- v1.0.23: the third curation state ---------------- */

test('resolveCuration: the LATER parental decision wins, in both argument orders', () => {
  const rejected = { state: 'rejected', rejectedAt: 200 };
  const approved = { state: 'live', approvedAt: 100 };
  assert.equal(resolveCuration(rejected, approved).state, 'rejected', 'newer rejection wins');
  assert.equal(resolveCuration(approved, rejected).state, 'rejected', 'and it is commutative');

  const laterApproval = { state: 'live', approvedAt: 300 };
  assert.equal(resolveCuration(rejected, laterApproval).state, 'live', 'the parent changed their mind');
  assert.equal(resolveCuration(laterApproval, rejected).state, 'live');
});

test('resolveCuration: pending is not a decision, and a tie hides rather than shows', () => {
  const pending = { state: 'pending' };
  assert.equal(resolveCuration(pending, { state: 'live', approvedAt: 5 }).state, 'live');
  assert.equal(resolveCuration(pending, { state: 'rejected', rejectedAt: 5 }).state, 'rejected');
  assert.equal(resolveCuration(pending, { state: 'pending' }).state, 'pending');
  // same instant, opposite decisions: showing a rejected video is the worse failure
  assert.equal(resolveCuration({ state: 'live', approvedAt: 7 }, { state: 'rejected', rejectedAt: 7 }).state, 'rejected');
});

test('a rejected record is NOT revived by a peer\'s stale approval (v1.0.23)', () => {
  // The cross-device case: the parent rejected it on the tablet at t=200; the phone still
  // holds the copy it approved at t=100 and pushes it. Before resolveCuration, the merge
  // rule was "a live loser promotes a pending survivor" — it had no answer for 'rejected'.
  const mine = { key: 'yt:a', state: 'rejected', rejectedAt: 200, approvedAt: null, folderId: '~rejected', homeFolderId: 'ch:UC1', title: 'x', addedAt: 10 };
  const peer = { key: 'yt:a', state: 'live', approvedAt: 100, folderId: 'ch:UC1', title: 'x', addedAt: 10 };
  const out = settleCuration(mergeVideoRecord(mine, peer), 'ch:UC1', 900);
  assert.equal(out.state, 'rejected');
  assert.equal(out.folderId, PARKED.rejected, 'stays out of every folder the child can open');
  assert.equal(out.approvedAt, null, 'and it no longer claims to be approved');
});

test('settleCuration is IDEMPOTENT for all three states', () => {
  // It runs on every sync merge AND on every Drive apply, so a value that drifts each pass
  // (a restamped timestamp, a homeFolderId overwritten with the parking slot) would rewrite
  // the whole library on every sync and re-push it to Drive forever.
  const cases = [
    { key: 'a', state: 'live', folderId: 'ch:UC1', approvedAt: 100 },
    { key: 'b', state: 'pending', folderId: 'ch:UC1' },
    { key: 'c', state: 'rejected', folderId: 'ch:UC1' }
  ];
  for (const start of cases) {
    const once = settleCuration({ ...start }, 'sheet', 500);
    const twice = settleCuration({ ...once }, 'sheet', 900); // a LATER "now" must change nothing
    assert.deepEqual(twice, once, `settleCuration drifted for state=${start.state}`);
    // and the parked ones never lose the home they must be restored to
    if (start.state !== 'live') assert.equal(twice.homeFolderId, 'ch:UC1');
  }
});

test('settleCuration parks a rejection and REMEMBERS where it belongs', () => {
  const rec = settleCuration({ key: 'yt:a', state: 'rejected', folderId: 'ch:UC1' }, 'sheet', 500);
  assert.equal(rec.folderId, PARKED.rejected);
  assert.equal(rec.homeFolderId, 'ch:UC1', 'without this a restore has nowhere to put it back');
  assert.equal(rec.rejectedAt, 500, 'stamped, because resolveCuration compares it');

  // restoring to live un-parks to the remembered home, not to the fallback
  const back = settleCuration({ ...rec, state: 'live', approvedAt: null, rejectedAt: 500 }, 'sheet', 900);
  assert.equal(back.folderId, 'ch:UC1');
  assert.equal(back.rejectedAt, null, 'a live record must not still carry a rejection');
  assert.equal(back.approvedAt, 900);
});

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

test('keepForever is GROW-ONLY through the merge, in both directions (v1.0.39)', () => {
  // The parent marked this video as one the rolling window may never delete. `out = {...s}`
  // keeps it only when the LOCAL copy happens to win — and it does not always: a peer whose
  // `addedAt` is older becomes the survivor, and the fresh sync candidate carries no flag at
  // all. Losing it turns a protected favourite back into a deletion candidate, silently.
  const base = {
    key: 'yt:a', scopeId: 'lib:1', type: 'youtube', id: 'a', title: 'שיר',
    titleSource: 'api', state: 'live', addedAt: 500, updatedAt: 500, folderId: 'ch:UC1'
  };
  const marked = { ...base, keepForever: true, addedAt: 900 };  // protected, but NEWER
  const plain = { ...base, addedAt: 100 };                      // unmarked, and OLDER → survivor
  assert.equal(mergeVideoRecord(marked, plain).keepForever, true,
    'the protection was dropped when the other copy won the merge');
  assert.equal(mergeVideoRecord(plain, marked).keepForever, true, 'and it must be commutative');
  // a sync candidate (no flag) merging over a protected prior — the every-30-minutes path
  assert.equal(mergeVideoRecord({ ...base, keepForever: true }, { ...base, addedAt: 999 }).keepForever, true);
  // and it is never INVENTED: two unmarked copies stay unmarked (otherwise nothing is prunable)
  assert.equal(mergeVideoRecord(plain, { ...base, addedAt: 700 }).keepForever, undefined);
});
