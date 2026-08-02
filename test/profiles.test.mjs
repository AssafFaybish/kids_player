// Restored-profile merge tests (v1.0.4 first-launch Google connect): a Drive backup's
// profile list folds into the local one — union by id, LOCAL always wins, remote
// entries sanitized to the local shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfileLists, mergeDeletedProfiles } from '../www/js/store.js';
import { planProfilePurge } from '../www/js/plan.js';

const local = [{ id: 'p1', name: 'דני', avatar: '🦁', color: '#ffd166' }];

test('remote-only profiles are added, existing ids keep the LOCAL record', () => {
  const remote = [
    { id: 'p1', name: 'דני-מהגיבוי', avatar: '🐸', color: '#000' }, // conflict: local wins
    { id: 'p2', name: 'נועה', avatar: '🦊', color: '#f4a261' }
  ];
  const { list, added } = mergeProfileLists(local, remote);
  assert.equal(added, 1);
  assert.equal(list.length, 2);
  assert.equal(list.find((p) => p.id === 'p1').name, 'דני');
  assert.equal(list.find((p) => p.id === 'p2').name, 'נועה');
});

test('remote entries are sanitized: missing fields get defaults, junk is skipped', () => {
  const remote = [
    { id: 'p3' },                    // bare id — gets default name/avatar/color
    { name: 'בלי מזהה' },            // no id — skipped
    null, undefined, 'garbage',      // junk — skipped
    { id: 'p3', name: 'כפול' }       // duplicate WITHIN remote — first one wins
  ];
  const { list, added } = mergeProfileLists(local, remote);
  assert.equal(added, 1);
  const p3 = list.find((p) => p.id === 'p3');
  assert.equal(p3.name, 'ילד/ה');
  assert.ok(p3.avatar && p3.color);
});

test('empty/absent inputs: nothing added, local list unchanged and NOT mutated', () => {
  for (const remote of [[], null, undefined]) {
    const { list, added } = mergeProfileLists(local, remote);
    assert.equal(added, 0);
    assert.deepEqual(list, local);
  }
  const before = JSON.stringify(local);
  mergeProfileLists(local, [{ id: 'p9' }]);
  assert.equal(JSON.stringify(local), before, 'input array must not be mutated');
});

test('fresh device: empty local + full remote restores everything', () => {
  const remote = [{ id: 'a', name: 'א' }, { id: 'b', name: 'ב' }];
  const { list, added } = mergeProfileLists([], remote);
  assert.equal(added, 2);
  assert.deepEqual(list.map((p) => p.id), ['a', 'b']);
});

/* ---------------- unique profile names (v1.0.8) ---------------- */

test('profileNameExists: trims + collapses whitespace; empty never matches', async () => {
  const { profileNameExists } = await import('../www/js/store.js');
  const list = [{ id: 'p1', name: 'דני' }, { id: 'p2', name: 'נועה  לוי' }];
  assert.equal(profileNameExists(list, 'דני'), true);
  assert.equal(profileNameExists(list, '  דני  '), true);
  assert.equal(profileNameExists(list, 'נועה לוי'), true);   // collapsed inner whitespace
  assert.equal(profileNameExists(list, 'דן'), false);
  assert.equal(profileNameExists(list, ''), false);
  assert.equal(profileNameExists(list, '   '), false);
  assert.equal(profileNameExists([], 'דני'), false);
  assert.equal(profileNameExists(null, 'דני'), false);
});

test('profileNameConflict: a name taken on ANOTHER device blocks creation too', async () => {
  const { profileNameConflict } = await import('../www/js/store.js');
  const mine = [{ id: 'p1', name: 'דני' }];
  // the other device's "נועם" arrives via the Drive pull, so it is in `merged` but was
  // not in `localBefore`. That distinction only picks the MESSAGE — both block.
  const merged = [...mine, { id: 'p2', name: 'נועם' }];

  assert.equal(profileNameConflict(mine, merged, 'נועם'), 'remote');
  assert.equal(profileNameConflict(mine, merged, 'דני'), 'local');
  assert.equal(profileNameConflict(mine, merged, 'שירה'), null, 'a free name must not be blocked');

  // Why this exists: createProfile mints the id LOCALLY and both merge paths union by ID,
  // so two devices on one Google account could each create "נועם" and BOTH survive —
  // splitting that child's gift progress (profileVideoState is keyed by profileId), their
  // personal videos (prof:<id>) and, with no sheet, their entire library (lib:p:<id>).
  assert.equal(profileNameConflict(mine, merged, '  נועם  '), 'remote', 'trimming must not defeat it');
  assert.equal(profileNameConflict(mine, merged, 'נועם'), 'remote');

  // an offline creation falls back to localBefore === merged: still blocks a local clash
  assert.equal(profileNameConflict(mine, mine, 'דני'), 'local');
  assert.equal(profileNameConflict(mine, mine, 'נועם'), null);
  // junk is never a conflict (an empty name is rejected earlier by its own check)
  for (const junk of ['', '   ', null, undefined]) {
    assert.equal(profileNameConflict(mine, merged, junk), null, String(junk));
  }
  assert.equal(profileNameConflict(null, null, 'דני'), null);
});

test('duplicateProfileNames: reports collisions the parent has to resolve', async () => {
  const { duplicateProfileNames } = await import('../www/js/store.js');
  assert.deepEqual(duplicateProfileNames([{ id: 'p1', name: 'דני' }, { id: 'p2', name: 'נועם' }]), []);
  // the case blocking cannot prevent: both devices offline, both mint the same name
  assert.deepEqual(
    duplicateProfileNames([{ id: 'p1', name: 'נועם' }, { id: 'p2', name: ' נועם ' }, { id: 'p3', name: 'דני' }]),
    [{ name: 'נועם', ids: ['p1', 'p2'] }],
    'whitespace variants are the SAME name on screen and must be reported'
  );
  // three-way, and a second colliding name at once
  const three = duplicateProfileNames([
    { id: 'a', name: 'נועם' }, { id: 'b', name: 'נועם' }, { id: 'c', name: 'נועם' },
    { id: 'd', name: 'דני' }, { id: 'e', name: 'דני' }
  ]);
  assert.equal(three.length, 2);
  assert.deepEqual(three.find((x) => x.name === 'נועם').ids, ['a', 'b', 'c']);
  // an unnamed or id-less row must never invent a collision
  assert.deepEqual(duplicateProfileNames([{ id: 'p1', name: '' }, { id: 'p2', name: '  ' }, { name: 'נועם' }]), []);
  for (const junk of [null, undefined, []]) assert.deepEqual(duplicateProfileNames(junk), [], String(junk));
});

/* ---------------- deleting a profile actually deletes it (v1.0.25) ---------------- */

test('a DELETED profile is not resurrected by the next Drive pull', () => {
  // THE bug. mergeProfileLists unions by id and nothing filtered the remote side, so
  // "delete נועם" on the tablet lasted exactly until the next pull put it back — while
  // the confirm dialog says the action cannot be undone.
  const remote = [{ id: 'p1', name: 'דני' }, { id: 'p2', name: 'נועם' }];
  const gone = { p2: 1000 };
  const { list } = mergeProfileLists([{ id: 'p1', name: 'דני' }], remote, gone);
  assert.deepEqual(list.map((p) => p.id), ['p1'], 'the deleted profile came back from Drive');

  // it is also removed from the LOCAL list — that is how a peer's deletion reaches us
  const fromPeer = mergeProfileLists([{ id: 'p1' }, { id: 'p2' }], [], gone);
  assert.deepEqual(fromPeer.list.map((p) => p.id), ['p1']);
  assert.equal(fromPeer.added, 0);

  // no tombstones ⇒ exactly the old behaviour (this argument is optional everywhere)
  assert.equal(mergeProfileLists([{ id: 'p1' }], remote).list.length, 2);
  assert.equal(mergeProfileLists([{ id: 'p1' }], remote, {}).list.length, 2);
  assert.equal(mergeProfileLists([{ id: 'p1' }], remote, null).list.length, 2);
  // a Set is accepted too (the shape the merged doc hands back)
  assert.deepEqual(mergeProfileLists([], remote, new Set(['p1'])).list.map((p) => p.id), ['p2']);
});

test('tombstones union, and the union does not depend on order', () => {
  const a = { p1: 500 };
  const b = { p1: 900, p2: 100 };
  assert.deepEqual(mergeDeletedProfiles(a, b), mergeDeletedProfiles(b, a));
  // earliest wins: it is the timestamp the other devices already saw
  assert.equal(mergeDeletedProfiles(a, b).p1, 500);
  assert.equal(mergeDeletedProfiles(a, b).p2, 100);
  // grow-only, and junk-proof — a profile id is random and never reused, so there is no
  // "revoke" case to model (unlike the video deny-list)
  assert.deepEqual(mergeDeletedProfiles({}, {}), {});
  assert.deepEqual(mergeDeletedProfiles(null, undefined), {});
  assert.deepEqual(mergeDeletedProfiles({ p1: 'junk' }, null), { p1: 0 });
});

test('planProfilePurge never erases a library a SIBLING still reads', () => {
  // A sheet-less profile owns lib:p:<id> outright — that is where its content lives, and
  // leaving it behind is what made the old delete a no-op for most families.
  assert.deepEqual(planProfilePurge('p1', 'lib:p:p1', []),
    { scopes: ['prof:p1', 'lib:p:p1'], sharedWith: [] });

  // A SHARED sheet scope must survive: erasing it would take the sibling's whole library.
  const others = [{ profileId: 'p2', libraryId: 'lib:abc' }];
  assert.deepEqual(planProfilePurge('p1', 'lib:abc', others),
    { scopes: ['prof:p1'], sharedWith: ['p2'] });

  // …but only while the sibling is really there
  assert.deepEqual(planProfilePurge('p1', 'lib:abc', [{ profileId: 'p2', libraryId: 'lib:other' }]),
    { scopes: ['prof:p1', 'lib:abc'], sharedWith: [] });
  // the profile's own entry in `others` must not count as a sibling
  assert.deepEqual(planProfilePurge('p1', 'lib:abc', [{ profileId: 'p1', libraryId: 'lib:abc' }]).scopes,
    ['prof:p1', 'lib:abc']);

  // no library yet (deleted before the first sync) → personal scope only
  assert.deepEqual(planProfilePurge('p1', null, others), { scopes: ['prof:p1'], sharedWith: [] });
  // junk never throws and never proposes erasing anything unnamed
  assert.deepEqual(planProfilePurge(), { scopes: [], sharedWith: [] });
  assert.deepEqual(planProfilePurge('p1', 'lib:abc', [null, {}]).scopes, ['prof:p1', 'lib:abc']);
});
