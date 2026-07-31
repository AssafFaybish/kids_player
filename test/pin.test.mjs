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

test('a NUMERIC pin is hashed like its digits, not collapsed to one constant', async () => {
  // The djb2 fallback (insecure contexts — no crypto.subtle) iterated `str.length`.
  // A number has none, so the loop never ran and EVERY number hashed to the same
  // constant: setPin(1234) then verifyPin(9999) opened the parent gate. The suite only
  // ever exercised the crypto.subtle branch, so the fallback was asserted-safe by the
  // test above and untested in fact. Force the fallback and pin the real behavior.
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    // getter-only on globalThis in node, hence defineProperty rather than assignment
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const fresh = await import('../www/js/pin.js?nocrypto=1');
    store.clear();
    await fresh.setPin(1234);
    assert.equal(await fresh.verifyPin(9999), false, 'ANY 4-digit number opened the gate');
    assert.equal(await fresh.verifyPin(1234), true);
    assert.equal(await fresh.verifyPin('1234'), true, 'the number and its digits are one PIN');
    const stored = [...store.values()].join('|');
    assert.ok(stored.startsWith('djb2:'), 'this test did not reach the fallback: ' + stored);
    assert.ok(!stored.includes('1234'), 'the plaintext PIN is in storage: ' + stored);
  } finally {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  }
});
