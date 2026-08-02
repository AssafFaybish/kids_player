// settings.js — the synced settings channel (v1.0.25). Before it, the only setting that
// travelled between a family's devices was libraryChannels.autoApprove, and THAT field is
// the cautionary tale this file exists to prevent repeating: nobody stamped its timestamp,
// so the merge compared 0 > 0, the first document always won, and merge(A,B) !== merge(B,A)
// — the documented commutativity invariant was provably false. The suite missed it because
// the fixtures carried timestamps: it pinned the fixture, not the production path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear()
};

const {
  getSetting, putSetting, getAllSettings, putAllSettings, mergeSettings, mergeSettingEntry, ACCOUNT
} = await import('../www/js/settings.js');

const e = (v, at) => ({ v, at });

/* ---------------- storage ---------------- */

test('a setting round-trips per profile and per account, without colliding', async () => {
  store.clear();
  await putSetting('p1', 'exitLock', true);
  await putSetting('p2', 'exitLock', false);
  await putSetting(ACCOUNT, 'pin', 'hash-abc');

  assert.equal(await getSetting('p1', 'exitLock', false), true);
  assert.equal(await getSetting('p2', 'exitLock', false), false, 'one child leaked into the other');
  assert.equal(await getSetting(ACCOUNT, 'pin', ''), 'hash-abc');
  // a profile that never wrote gets the default, not the sibling's answer
  assert.equal(await getSetting('p3', 'exitLock', false), false);
});

test('an explicit FALSE is an answer, not an absence', async () => {
  // The whole point of the fallback contract. If a written `false` fell back to the
  // default, turning the exit lock (default off) or share-approval (default ON) off would
  // silently turn it back on at the next read — the parent would flip a switch that
  // refuses to stay flipped.
  store.clear();
  await putSetting('p1', 'shareApproval', false);
  assert.equal(await getSetting('p1', 'shareApproval', true), false);
  await putSetting(ACCOUNT, 'pin', ''); // a CLEARED pin
  assert.equal(await getSetting(ACCOUNT, 'pin', 'legacy-hash'), '',
    "a cleared PIN must not fall back to a stale hash");
});

test('the timestamp is stamped by the writer, never by the caller', async () => {
  // The v1.0.22 lesson from putLibraryChannel: nine call sites were each supposed to set
  // updatedAt and none did, so every comparison was 0 > 0.
  store.clear();
  const before = Date.now();
  await putSetting('p1', 'autoplay', true);
  const all = await getAllSettings();
  const at = all.profiles.p1.autoplay.at;
  assert.ok(at >= before && at <= Date.now(), 'no usable timestamp was written: ' + at);
});

test('a corrupt or absent document reads as empty rather than throwing', async () => {
  store.clear();
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
  store.set('settings', '{not json');
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
  assert.equal(await getSetting('p1', 'exitLock', false), false);
  store.set('settings', 'null');
  assert.deepEqual(await getAllSettings(), { account: {}, profiles: {} });
});

/* ---------------- merge ---------------- */

test('the later write wins, per key', () => {
  assert.deepEqual(mergeSettingEntry('exitLock', e(true, 100), e(false, 200)), e(false, 200));
  assert.deepEqual(mergeSettingEntry('exitLock', e(false, 200), e(true, 100)), e(false, 200));
  // one side missing entirely
  assert.deepEqual(mergeSettingEntry('exitLock', null, e(true, 5)), e(true, 5));
  assert.deepEqual(mergeSettingEntry('exitLock', e(true, 5), null), e(true, 5));
  assert.equal(mergeSettingEntry('exitLock', null, null), null);
  // junk that is not an entry must not be mistaken for one
  assert.deepEqual(mergeSettingEntry('exitLock', {}, e(true, 5)), e(true, 5));
  assert.deepEqual(mergeSettingEntry('exitLock', 'nope', e(true, 5)), e(true, 5));
});

test('an exact tie resolves the SAFE way, and never by argument order', () => {
  // Two devices, same millisecond, opposite answers. Whatever we choose must be the same
  // choice in both orders, or the pair ping-pongs forever.
  assert.equal(mergeSettingEntry('exitLock', e(true, 7), e(false, 7)).v, true, 'stay locked');
  assert.equal(mergeSettingEntry('exitLock', e(false, 7), e(true, 7)).v, true);
  assert.equal(mergeSettingEntry('shareApproval', e(false, 7), e(true, 7)).v, true, 'keep asking');
  assert.equal(mergeSettingEntry('shareApproval', e(true, 7), e(false, 7)).v, true);
  assert.equal(mergeSettingEntry('autoplay', e(true, 7), e(false, 7)).v, false, 'stop playing');
  assert.equal(mergeSettingEntry('autoplay', e(false, 7), e(true, 7)).v, false);
  // no safe direction (an opaque PIN hash): deterministic by value, still order-free
  const a = mergeSettingEntry('pin', e('aaa', 7), e('bbb', 7));
  const b = mergeSettingEntry('pin', e('bbb', 7), e('aaa', 7));
  assert.deepEqual(a, b);
  // an unknown future setting must not throw or become order-dependent either
  assert.deepEqual(mergeSettingEntry('somethingNew', e(1, 7), e(2, 7)),
    mergeSettingEntry('somethingNew', e(2, 7), e(1, 7)));
});

test('mergeSettings(A,B) === mergeSettings(B,A) — the invariant that broke in v1.0.22', () => {
  const A = {
    account: { pin: e('hash-A', 500) },
    profiles: {
      kid1: { exitLock: e(true, 100), shareApproval: e(false, 900) },
      kid2: { autoplay: e(true, 42) }
    }
  };
  const B = {
    account: { pin: e('hash-B', 400) },
    profiles: {
      kid1: { exitLock: e(false, 300) },
      kid3: { exitLock: e(true, 7) }
    }
  };
  const ab = mergeSettings(A, B);
  const ba = mergeSettings(B, A);
  assert.deepEqual(ab, ba, 'the merge is order-dependent — two devices will never converge');

  // and it is actually correct, not merely symmetric
  assert.equal(ab.account.pin.v, 'hash-A', 'the later PIN (500 > 400) must win');
  assert.equal(ab.profiles.kid1.exitLock.v, false, 'the later lock write (300 > 100) must win');
  assert.equal(ab.profiles.kid1.shareApproval.v, false, 'a key only A had must survive');
  assert.equal(ab.profiles.kid2.autoplay.v, true, 'a profile only A had must survive');
  assert.equal(ab.profiles.kid3.exitLock.v, true, 'a profile only B had must survive');

  // IDEMPOTENT: merging the result back in changes nothing (a push/pull loop must settle)
  assert.deepEqual(mergeSettings(ab, A), ab);
  assert.deepEqual(mergeSettings(ab, B), ab);
  assert.deepEqual(mergeSettings(ab, ab), ab);
});

test('a document from an OLDER app (no settings key) never erases ours', () => {
  // Additive rollout: a device still on v1.0.24 writes a doc with no `settings` at all.
  // Treating that as "the family cleared every setting" would unlock a locked tablet.
  const mine = { account: { pin: e('h', 9) }, profiles: { k: { exitLock: e(true, 9) } } };
  assert.deepEqual(mergeSettings(mine, undefined), mine);
  assert.deepEqual(mergeSettings(undefined, mine), mine);
  assert.deepEqual(mergeSettings(mine, {}), mine);
  assert.deepEqual(mergeSettings({}, {}), { account: {}, profiles: {} });
  assert.deepEqual(mergeSettings(null, null), { account: {}, profiles: {} });
});

test('applying a merged document does NOT restamp it', async () => {
  // Restamping an applied remote record makes it instantly newer than the peer's, and the
  // two devices then ping-pong forever — the reason mergeChannelForApply exists.
  store.clear();
  const remote = { account: {}, profiles: { k: { exitLock: e(true, 1234) } } };
  await putAllSettings(mergeSettings(await getAllSettings(), remote));
  const all = await getAllSettings();
  assert.equal(all.profiles.k.exitLock.at, 1234, 'the applied entry was restamped');
  assert.equal(await getSetting('k', 'exitLock', false), true);
});

test('a local change made since the last push survives applying an older remote doc', async () => {
  store.clear();
  await putSetting('k', 'exitLock', false);              // the parent just unlocked it here
  const stale = { account: {}, profiles: { k: { exitLock: e(true, 1) } } }; // ancient peer
  await putAllSettings(mergeSettings(await getAllSettings(), stale));
  assert.equal(await getSetting('k', 'exitLock', true), false,
    'a stale peer re-locked a tablet the parent had just unlocked');
});
