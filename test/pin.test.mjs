// pin.js — the parent gate. Unpinned until v1.0.20, which is uncomfortable for the one
// check standing between a 5-year-old and "delete everything" / "exit the app" / "install
// an update". The threat model is a child, not an attacker, but the CODE still has to
// behave: store a hash and not the digits, accept only the right PIN, and forget it on
// clear. platform.js falls back to localStorage off-device, so a stub is all we need.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear()
};

const pin = await import('../www/js/pin.js');

test('a fresh install has no PIN, and verify refuses everything', async () => {
  store.clear();
  assert.equal(await pin.hasPin(), false);
  // load-bearing: with no PIN stored, verify must not accept '' / undefined and hand a
  // child the parent screen
  for (const attempt of ['', '0000', '1234', undefined, null]) {
    assert.equal(await pin.verifyPin(attempt), false, JSON.stringify(attempt));
  }
});

test('the PIN round-trips, and the digits are NOT what gets stored', async () => {
  store.clear();
  await pin.setPin('1234');
  assert.equal(await pin.hasPin(), true);
  assert.equal(await pin.verifyPin('1234'), true);

  const stored = [...store.values()].join('|');
  assert.ok(!stored.includes('1234'), 'the plaintext PIN is in storage: ' + stored);
  assert.ok(stored.length >= 16, 'stored value looks too short to be a digest: ' + stored);
});

test('a wrong PIN is refused — including near-misses and junk', async () => {
  store.clear();
  await pin.setPin('1234');
  for (const attempt of ['1235', '123', '12345', '4321', ' 1234', '1234 ', '', null, undefined]) {
    assert.equal(await pin.verifyPin(attempt), false, JSON.stringify(attempt));
  }
  // Documented, harmless: the digits are hashed as a string, so the NUMBER 1234 is the
  // same PIN. The keypad only ever produces strings; this is not a bypass, and pinning
  // it here means a future "tighten the input" change has to be deliberate.
  assert.equal(await pin.verifyPin(1234), true);
});

test('changing the PIN invalidates the old one; clearing removes the gate', async () => {
  store.clear();
  await pin.setPin('1111');
  await pin.setPin('2222');
  assert.equal(await pin.verifyPin('1111'), false, 'the OLD pin still opens the gate');
  assert.equal(await pin.verifyPin('2222'), true);

  await pin.clearPin();
  assert.equal(await pin.hasPin(), false);
  assert.equal(await pin.verifyPin('2222'), false);
});

test('the same PIN always hashes to the same value (verify is not luck)', async () => {
  store.clear();
  await pin.setPin('9876');
  const first = [...store.values()].join('|');
  await pin.setPin('9876');
  assert.equal([...store.values()].join('|'), first, 'hashing is not deterministic');
  assert.equal(await pin.verifyPin('9876'), true);
});
