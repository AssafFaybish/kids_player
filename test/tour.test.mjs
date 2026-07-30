// Onboarding decks (v1.0.18). The bounds arithmetic used to be copy-pasted into
// four places in app.js (renderer, next handler, prev handler, hardware-back), so
// a deck of a different length could disagree with itself. It is one pure function
// now, and these tests are what keep the four call sites honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  TOUR_SLIDES, ADD_GUIDE_SLIDES, nextIndex, slideState, backAction,
  deckChrome, chapters, DOTS_MAX
} from '../www/js/tour.js';

const WWW = join(dirname(fileURLToPath(import.meta.url)), '..', 'www');

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
  const all = ADD_GUIDE_SLIDES.map((s) => (s.chapter || '') + ' ' + s.title + ' ' + s.text).join(' ');
  assert.ok(/שיתוף מיוטיוב/.test(all), 'sharing from the YouTube app');
  assert.ok(/מדביקים לינק|הדבקת לינק/.test(all), 'pasting inside the app');
  assert.ok(/דרייב|קובץ הרשימה/.test(all), 'the Google Sheet list');
  // and it must say what happens after — approval and deletion are the steps parents
  // ask about the day AFTER they add something.
  assert.ok(/אישור|מאשרים/.test(all), 'the approval step');
  assert.ok(/מוחקים|מחיקה/.test(all), 'how to remove something again');
});

/* ---- assets: a slide whose image 404s is a blank white card on the tablet ---- */

test('every slide image in both decks EXISTS in www/', () => {
  for (const [name, deck] of [['TOUR_SLIDES', TOUR_SLIDES], ['ADD_GUIDE_SLIDES', ADD_GUIDE_SLIDES]]) {
    deck.forEach((s, i) => {
      assert.ok(existsSync(join(WWW, s.img)),
        `${name}[${i}] points at a missing asset: www/${s.img}`);
    });
  }
});

test('every guide illustration is 1280x800, like the screenshots next to it', () => {
  // The slide CSS caps the image by viewport height and letterboxes with object-fit;
  // a drawing with a different ratio would sit in a visibly different frame than the
  // photographed slides it is mixed with.
  const svgs = [...TOUR_SLIDES, ...ADD_GUIDE_SLIDES].map((s) => s.img).filter((p) => /\.svg$/.test(p));
  assert.ok(svgs.length > 0);
  for (const p of new Set(svgs)) {
    const body = readFileSync(join(WWW, p), 'utf8');
    assert.match(body, /viewBox="0 0 1280 800"/, `${p} must use viewBox="0 0 1280 800"`);
  }
});

test('the guide shows REAL app screenshots for app screens', () => {
  // Decision (v1.0.20): only what is not ours — YouTube, Android, the spreadsheet,
  // the Drive folder — may be a drawing. A drawn "parent screen" sends parents
  // looking for a button that does not look like that.
  const jpgs = ADD_GUIDE_SLIDES.filter((s) => /\.jpg$/.test(s.img));
  assert.ok(jpgs.length >= 10, `expected the app steps to be photographed, got ${jpgs.length}`);
  const svgs = ADD_GUIDE_SLIDES.filter((s) => /\.svg$/.test(s.img));
  for (const s of svgs) {
    assert.ok(/map-|share-0[123]|sheet-/.test(s.img),
      `${s.img} is a drawing of something the app itself renders — screenshot it`);
  }
});

/* ---- long-deck chrome (v1.0.20) ---- */

test('deckChrome: a long deck counts steps, a short one keeps its dots', () => {
  const long = deckChrome(ADD_GUIDE_SLIDES, 3);
  assert.equal(long.useDots, false, `${ADD_GUIDE_SLIDES.length} dots are not countable`);
  assert.equal(long.stepLabel, `שלב 4 מתוך ${ADD_GUIDE_SLIDES.length}`);
  assert.ok(long.chapter.length > 0, 'a long deck labels its chapters');

  const short = deckChrome(TOUR_SLIDES, 0);
  assert.equal(short.useDots, true, 'the first-run deck must look exactly as before');
  assert.equal(short.chapter, '', 'no chapter chip on the onboarding deck');
});

test('deckChrome clamps and survives junk like the rest of the arithmetic', () => {
  assert.equal(deckChrome(ADD_GUIDE_SLIDES, 999).stepLabel,
    `שלב ${ADD_GUIDE_SLIDES.length} מתוך ${ADD_GUIDE_SLIDES.length}`);
  assert.equal(deckChrome(ADD_GUIDE_SLIDES, -5).stepLabel, `שלב 1 מתוך ${ADD_GUIDE_SLIDES.length}`);
  const none = deckChrome([], 0);
  assert.deepEqual([none.chapter, none.stepLabel, none.useDots], ['', '', false]);
  assert.equal(deckChrome(undefined, NaN).useDots, false);
});

test('the guide is long enough to be detailed and every slide has a chapter', () => {
  assert.ok(ADD_GUIDE_SLIDES.length > DOTS_MAX,
    'the counter chrome only exists because this deck is long — keep it that way');
  assert.ok(ADD_GUIDE_SLIDES.length >= 14 && ADD_GUIDE_SLIDES.length <= 20,
    `guide is ${ADD_GUIDE_SLIDES.length} slides — detailed, but still finishable in one sitting`);
  ADD_GUIDE_SLIDES.forEach((s, i) => {
    assert.ok(s.chapter && s.chapter.trim().length > 0,
      `ADD_GUIDE_SLIDES[${i}] has no chapter — its chip would render empty`);
  });
});

test('chapters() partitions the guide into contiguous, covering chapters', () => {
  const ch = chapters(ADD_GUIDE_SLIDES);
  assert.ok(ch.length >= 4, `expected the map + three methods + approval, got ${ch.length}`);
  assert.equal(ch[0].from, 0);
  assert.equal(ch[ch.length - 1].to, ADD_GUIDE_SLIDES.length - 1);
  let expected = 0;
  for (const c of ch) {
    assert.equal(c.from, expected, `chapter "${c.title}" must start where the previous ended`);
    assert.equal(c.count, c.to - c.from + 1);
    expected = c.to + 1;
  }
  assert.equal(expected, ADD_GUIDE_SLIDES.length, 'every slide belongs to a chapter');
  // A chapter title must not repeat later in the deck — the chip would lie about
  // where the parent is (and chapters() would split it in two).
  const titles = ch.map((c) => c.title);
  assert.equal(new Set(titles).size, titles.length, 'chapter titles must be unique: ' + titles);
  assert.deepEqual(chapters(TOUR_SLIDES), [], 'the onboarding deck has no chapters');
});

test('the first-run deck stays short enough that nobody skips it', () => {
  // Rationale, not trivia: a long forced tour gets "דלג"-ed wholesale, which is
  // why the add-videos material is a SEPARATE deck reached on demand.
  assert.ok(TOUR_SLIDES.length <= 7, `first-run deck is ${TOUR_SLIDES.length} slides — keep it skimmable`);
});
