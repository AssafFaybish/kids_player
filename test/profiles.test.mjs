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
