// Onboarding decks (v1.0.18). The bounds arithmetic used to be copy-pasted into
// four places in app.js (renderer, next handler, prev handler, hardware-back), so
// a deck of a different length could disagree with itself. It is one pure function
// now, and these tests are what keep the four call sites honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUR_SLIDES, ADD_GUIDE_SLIDES, nextIndex, slideState, backAction
} from '../www/js/tour.js';

test('nextIndex clamps at both ends — never off the deck', () => {
  assert.equal(nextIndex(0, 6, 1), 1);
  assert.equal(nextIndex(5, 6, 1), 5, 'past the last slide stays on the last');
  assert.equal(nextIndex(0, 6, -1), 0, 'before the first stays on the first');
  assert.equal(nextIndex(3, 6, -1), 2);
});

test('nextIndex survives junk input (a deck that failed to load)', () => {
  assert.equal(nextIndex(0, 0, 1), 0, 'an empty deck has nowhere to go');
  assert.equal(nextIndex(undefined, undefined, undefined), 0);
  assert.equal(nextIndex(99, 6, 1), 5, 'an index past the end lands on the last');
  // A junk index is treated as position 0, so a forward step still advances by one
  // rather than getting stuck; what matters is that the result is always a valid,
  // in-range integer and never NaN.
  assert.equal(nextIndex(NaN, 6, 1), 1);
  for (const [i, len, d] of [[NaN, 6, 1], [undefined, 6, -1], ['x', 6, 1], [null, 0, 1]]) {
    const r = nextIndex(i, len, d);
    assert.ok(Number.isInteger(r) && r >= 0 && r <= Math.max(0, (len || 0) - 1),
      `nextIndex(${i}, ${len}, ${d}) = ${r} must be a valid in-range index`);
  }
});

test('slideState drives the chrome: label, prev-disabled, dots', () => {
  const first = slideState(0, 6);
  assert.equal(first.isFirst, true);
  assert.equal(first.isLast, false);
  assert.equal(first.prevDisabled, true);
  assert.equal(first.nextLabel, '◀', 'RTL: ◀ is FORWARD');
  assert.deepEqual(first.dots, [true, false, false, false, false, false]);

  const last = slideState(5, 6);
  assert.equal(last.isLast, true);
  assert.equal(last.prevDisabled, false);
  assert.equal(last.nextLabel, '✔', 'the last slide finishes instead of advancing');
  assert.equal(last.dots.filter(Boolean).length, 1);
});

test('slideState clamps an out-of-range index instead of rendering nothing', () => {
  // Guards the deck-swap path: switching from the 6-slide tour to the 9-slide
  // guide (or back) must never leave the renderer pointing past the end.
  assert.equal(slideState(20, 6).index, 5);
  assert.equal(slideState(20, 6).isLast, true);
  assert.equal(slideState(-3, 6).index, 0);
  const empty = slideState(0, 0);
  assert.deepEqual(empty.dots, []);
  assert.equal(empty.isLast, false, 'an empty deck has no "last" slide to finish on');
});

test('exactly one dot is lit for every slide of both decks', () => {
  for (const deck of [TOUR_SLIDES, ADD_GUIDE_SLIDES]) {
    for (let i = 0; i < deck.length; i++) {
      const st = slideState(i, deck.length);
      assert.equal(st.dots.length, deck.length);
      assert.equal(st.dots.filter(Boolean).length, 1);
      assert.equal(st.dots[i], true);
    }
  }
});

test('hardware back steps back, and FINISHES on the first slide', () => {
  // Back must never fall through to "exit the app" from inside the tour.
  assert.equal(backAction(0), 'finish');
  assert.equal(backAction(1), 'prev');
  assert.equal(backAction(8), 'prev');
  assert.equal(backAction(undefined), 'finish');
});

test('walking a deck forward reaches the last slide and stops', () => {
  const len = ADD_GUIDE_SLIDES.length;
  let i = 0;
  for (let n = 0; n < len + 5; n++) i = nextIndex(i, len, 1);
  assert.equal(i, len - 1);
  assert.equal(slideState(i, len).isLast, true);
});

/* ---- deck content: a broken slide is a blank screen for a new parent ---- */

test('every slide in both decks has an image, a title and body text', () => {
  for (const [name, deck] of [['TOUR_SLIDES', TOUR_SLIDES], ['ADD_GUIDE_SLIDES', ADD_GUIDE_SLIDES]]) {
    assert.ok(deck.length > 0, name + ' must not be empty');
    deck.forEach((s, i) => {
      assert.ok(s.img && typeof s.img === 'string', `${name}[${i}] needs an img`);
      assert.ok(/^assets\/(tour|guide)\/[\w.-]+\.(jpg|png|svg)$/.test(s.img),
        `${name}[${i}] img must be a repo-relative asset path, got: ${s.img}`);
      assert.ok(s.title && s.title.trim().length > 0, `${name}[${i}] needs a title`);
      assert.ok(s.text && s.text.trim().length > 20, `${name}[${i}] needs real body text`);
    });
  }
});

test('the onboarding deck OPENS with the landing page, not a screen tour', () => {
  // The whole point of the v1.0.18 restructure: a parent sees what the app is
  // for before being shown its screens.
  assert.ok(/ברוכים הבאים/.test(TOUR_SLIDES[0].title));
  assert.ok(TOUR_SLIDES.length >= 6, 'landing page + the five screen slides');
});

test('the guide covers all three ways to add content', () => {
  const all = ADD_GUIDE_SLIDES.map((s) => s.title + ' ' + s.text).join(' ');
  assert.ok(/שיתוף מיוטיוב/.test(all), 'sharing from the YouTube app');
  assert.ok(/הדבקת לינק בתוך האפליקציה/.test(all), 'pasting inside the app');
  assert.ok(/גיליון/.test(all), 'the Google Sheet');
  // and it must say what happens after — approval is the step parents miss
  assert.ok(/אישור|מאשרים/.test(all), 'the approval step');
});

test('the first-run deck stays short enough that nobody skips it', () => {
  // Rationale, not trivia: a long forced tour gets "דלג"-ed wholesale, which is
  // why the add-videos material is a SEPARATE deck reached on demand.
  assert.ok(TOUR_SLIDES.length <= 7, `first-run deck is ${TOUR_SLIDES.length} slides — keep it skimmable`);
});
