// Hardware-back decision core — a dead back button is the worst possible regression,
// so the precedence chain is pinned here: fullscreen → modal → view → pop → swallow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
