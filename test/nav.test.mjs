// Hardware-back decision core — a dead back button is the worst possible regression,
// so the precedence chain is pinned here: fullscreen → modal → view → pop → swallow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveBack } from '../www/js/nav.js';

test('fullscreen wins over everything', () => {
  assert.equal(resolveBack({ depth: 3, fullscreen: true, modal: true, viewConsumesBack: true }), 'exit-fullscreen');
});

test('an open modal closes before any navigation', () => {
  assert.equal(resolveBack({ depth: 3, modal: true, viewConsumesBack: true }), 'close-modal');
});

test('the current view gets a say before the stack pops', () => {
  assert.equal(resolveBack({ depth: 2, viewConsumesBack: true }), 'view');
});

test('deep stack pops', () => {
  assert.equal(resolveBack({ depth: 2 }), 'pop');
  assert.equal(resolveBack({ depth: 5 }), 'pop');
});

test('root with no view handler swallows — NEVER falls through to app exit', () => {
  assert.equal(resolveBack({ depth: 1 }), 'swallow');
  assert.equal(resolveBack({ depth: 0 }), 'swallow');
});

test('handleBack DELEGATES to resolveBack — the tested chain is the live one', async () => {
  // These tests pinned `resolveBack` while the live handler re-implemented the chain
  // inline, so `resolveBack` had ZERO callers: reordering the modal/fullscreen checks or
  // deleting the final swallow (the thing that stops Android's default back from exiting
  // the app under a 5-year-old) left all of them green. Pin the wiring itself.
  const src = readFileSync(new URL('../www/js/nav.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function handleBack'));
  assert.match(fn, /resolveBack\(/, 'handleBack no longer uses the tested decision core');
  // and every branch resolveBack can return must be handled, or a case silently no-ops
  for (const action of ['exit-fullscreen', 'close-modal', 'view', 'pop']) {
    assert.ok(fn.includes(`'${action}'`), `handleBack ignores the '${action}' decision`);
  }
  assert.match(fn, /return true;\s*\/\/ swallow/, 'the catch-all swallow is gone');
});

test('resolveBack: the view is asked LAZILY, and only when it is its turn', () => {
  // onBack has side effects (askExit, the profiles-screen guard), so it must not run while
  // fullscreen or a modal is still open — that would pop an exit dialog behind a modal.
  let asked = 0;
  const askView = () => { asked += 1; return true; };
  assert.equal(resolveBack({ depth: 2, fullscreen: true, askView }), 'exit-fullscreen');
  assert.equal(asked, 0, 'the view was asked while still fullscreen');
  assert.equal(resolveBack({ depth: 2, modal: true, askView }), 'close-modal');
  assert.equal(asked, 0, 'the view was asked with a modal open');
  assert.equal(resolveBack({ depth: 2, askView }), 'view');
  assert.equal(asked, 1);
  // a view that declines falls through to the stack, then to the swallow
  assert.equal(resolveBack({ depth: 2, askView: () => false }), 'pop');
  assert.equal(resolveBack({ depth: 1, askView: () => false }), 'swallow');
  // the plain boolean form still works (that is what the other tests here use)
  assert.equal(resolveBack({ depth: 2, viewConsumesBack: true }), 'view');
});
