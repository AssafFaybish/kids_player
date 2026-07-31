// Restored-profile merge tests (v1.0.4 first-launch Google connect): a Drive backup's
// profile list folds into the local one — union by id, LOCAL always wins, remote
// entries sanitized to the local shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProfileLists } from '../www/js/store.js';

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
