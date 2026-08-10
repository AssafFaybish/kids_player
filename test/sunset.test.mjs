// The one-time migration off the Google-Sheets sources list (v1.0.38).
//
// ⚠️ THIS FILE AND EVERYTHING IT TESTS IS SCHEDULED FOR DELETION. The last test in here is a
// dated tripwire that FAILS after 2026-09-10 and carries the removal checklist.
//
// Two of these tests guard irrecoverable loss and are worth reading before touching the code:
//   - a channel with a deletion tombstone must NEVER be re-subscribed by the final read (a
//     sheet row has no timestamp, and putLibraryChannel's fresh updatedAt beats the tombstone
//     by design — so one last read would resurrect every subscription the parent threw out);
//   - a failed read must never reach the forget, because the file delete that follows bypasses
//     Drive's trash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSheetSunset, planSheetFold, SUNSET_DEADLINE } from '../www/js/plan.js';
import { extractSpreadsheetId, extractGid, interpretSheetResponse } from '../www/js/sunset.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/SHEET123/edit#gid=0';
const CH_A = 'UCbCmjCuTUZos6Inko4u57UQ';
const CH_B = 'UCWF5vshm5UfF59-rtvsE5WA';
const PL_A = 'PLBCF2DAC6FFB574DE';
const withSheet = { sheetUrl: SHEET, libraryId: 'lib:abc' };
const BEFORE = SUNSET_DEADLINE - 86400000;   // one day before the deadline

/* ==================== the state machine ==================== */

test('planSheetSunset: nothing to do is a skip, forever and idempotently', () => {
  assert.equal(planSheetSunset({ src: null, state: null, now: BEFORE, hasToken: true }).action, 'skip');
  assert.equal(planSheetSunset({ src: {}, state: {}, now: BEFORE, hasToken: true }).reason, 'no-sheet');
  const done = planSheetSunset({ src: withSheet, state: { phase: 'done' }, now: BEFORE, hasToken: true });
  assert.equal(done.action, 'skip');
  assert.equal(done.reason, 'done');
  // a finished profile must not be re-read even with a sheetUrl still lying around
  assert.equal(planSheetSunset({ src: withSheet, state: { phase: 'done', spreadsheetId: 'S', deletedFileAt: 5 }, now: BEFORE, hasToken: true }).action, 'skip');
});

test('planSheetSunset: NO TOKEN skips WITHOUT burning an attempt', () => {
  // A family that never connected Google — or whose grant lapsed — would otherwise exhaust
  // its three tries on launches that never reached the network, and their rows were
  // unreadable anyway (a drive.file read needs the grant).
  for (const attempts of [0, 1, 2]) {
    const r = planSheetSunset({ src: withSheet, state: { attempts }, now: BEFORE, hasToken: false });
    assert.equal(r.action, 'skip', `attempts=${attempts}`);
    assert.equal(r.reason, 'no-token');
    assert.equal(r.attempt, attempts, 'a tokenless launch consumed an attempt');
  }
});

test('planSheetSunset: three read attempts, then it forgets anyway', () => {
  for (const attempts of [0, 1, 2]) {
    const r = planSheetSunset({ src: withSheet, state: { attempts }, now: BEFORE, hasToken: true });
    assert.equal(r.action, 'read', `attempts=${attempts} should still read`);
    assert.equal(r.attempt, attempts + 1, 'the attempt counter must advance');
  }
  const gave = planSheetSunset({ src: withSheet, state: { attempts: 3 }, now: BEFORE, hasToken: true });
  assert.equal(gave.action, 'forget');
  assert.equal(gave.reason, 'gave-up');
  assert.equal(planSheetSunset({ src: withSheet, state: { attempts: 9 }, now: BEFORE, hasToken: true }).action, 'forget');
});

test('planSheetSunset: a crash between the FOLD and the FORGET never re-reads', () => {
  // Load-bearing beyond idempotence: between the two launches the parent may have deleted
  // something in the app, and a still-present sheet row must not undo it.
  const r = planSheetSunset({ src: withSheet, state: { phase: 'folded', attempts: 1, spreadsheetId: 'S' }, now: BEFORE, hasToken: true });
  assert.equal(r.action, 'forget');
  assert.equal(r.reason, 'resume');
  assert.equal(r.spreadsheetId, 'S');
  // even with a token and attempts left
  assert.equal(planSheetSunset({ src: withSheet, state: { phase: 'folded', attempts: 0 }, now: BEFORE, hasToken: true }).action, 'forget');
});

test('planSheetSunset: a crash between the FORGET and the DELETE still deletes, from the snapshot', () => {
  // After the forget there is no sheetUrl left to derive the id from — which is the entire
  // reason the id is snapshotted at read time.
  const r = planSheetSunset({ src: null, state: { phase: 'forgotten', spreadsheetId: 'S1' }, now: BEFORE, hasToken: true });
  assert.equal(r.action, 'delete-file');
  assert.equal(r.spreadsheetId, 'S1');
  assert.equal(r.attempt, 1);
  // no token: wait, do not give up on the file
  assert.equal(planSheetSunset({ src: null, state: { phase: 'forgotten', spreadsheetId: 'S1' }, now: BEFORE, hasToken: false }).reason, 'no-token');
  // already deleted, or out of delete attempts -> done, never an infinite retry loop
  assert.equal(planSheetSunset({ src: null, state: { phase: 'forgotten', spreadsheetId: 'S1', deletedFileAt: 9 }, now: BEFORE, hasToken: true }).reason, 'done');
  assert.equal(planSheetSunset({ src: null, state: { phase: 'forgotten', spreadsheetId: 'S1', deleteAttempts: 3 }, now: BEFORE, hasToken: true }).reason, 'done');
  // a forgotten sheet with no id to delete is simply finished
  assert.equal(planSheetSunset({ src: null, state: { phase: 'forgotten' }, now: BEFORE, hasToken: true }).reason, 'done');
});

test('planSheetSunset: past the DEADLINE everything forgets — with no token, at any attempt', () => {
  // This branch is what makes the code deletable: it guarantees no device is left holding an
  // inert sheetUrl that outlives the module which clears it.
  for (const state of [{}, { attempts: 0 }, { attempts: 2 }, { attempts: 3 }]) {
    const r = planSheetSunset({ src: withSheet, state, now: SUNSET_DEADLINE, hasToken: false });
    assert.equal(r.action, 'forget', JSON.stringify(state));
  }
  assert.equal(planSheetSunset({ src: withSheet, state: {}, now: SUNSET_DEADLINE + 1e9, hasToken: false }).reason, 'deadline');
  // and it must NOT fire early
  assert.equal(planSheetSunset({ src: withSheet, state: {}, now: BEFORE, hasToken: true }).action, 'read');
});

test('planSheetSunset never throws on junk', () => {
  for (const bad of [undefined, null, {}, { src: 'x' }, { state: 'x' }, { src: {}, state: [] },
    { src: withSheet, state: { attempts: -3 } }, { src: withSheet, state: { attempts: 'x' } }]) {
    const r = planSheetSunset(bad);
    assert.ok(['skip', 'read', 'forget', 'delete-file'].includes(r.action), JSON.stringify(bad));
  }
});

/* ==================== the fold ==================== */

const parsedFixture = {
  videoRows: [
    { key: 'yt:dQw4w9WgXcQ', type: 'youtube', id: 'dQw4w9WgXcQ', srcUrl: 'https://youtu.be/dQw4w9WgXcQ', title: 'שיר', thumbUrl: '', rowIndex: 0 },
    { key: 'yt:sFU5TdYp8u8', type: 'youtube', id: 'sFU5TdYp8u8', srcUrl: 'https://youtu.be/sFU5TdYp8u8', title: '', thumbUrl: '', rowIndex: 1 }
  ],
  channelRows: [
    { ref: { by: 'id', value: CH_A }, title: 'ערוץ א', flag: 'auto' },
    { ref: { by: 'handle', value: 'SuperSimpleSongs' }, title: '', flag: '' }
  ],
  playlistRows: [{ playlistId: PL_A, title: 'רשימה', flag: 'manual' }],
  removedKeys: ['yt:zzzzzzzzzzz'],
  invalid: []
};

test('planSheetFold: rows become the same candidates and subscriptions the sheet stage built', () => {
  const out = planSheetFold({
    parsed: parsedFixture,
    resolved: new Map([['handle:SuperSimpleSongs', CH_B]]),
    knownChannelIds: new Set(), deletedChannels: {}, libraryId: 'lib:abc', now: 5
  });
  assert.equal(out.candidates.length, 2);
  assert.equal(out.candidates[0].folderId, 'sheet');
  assert.equal(out.candidates[0].origin, 'sheet-row');
  assert.equal(out.candidates[0].titleSource, 'sheet');
  assert.equal(out.candidates[1].titleSource, null, 'an empty column B must leave the title unset');
  assert.deepEqual(out.candidates.map((c) => c.rowIndex), [0, 1]);
  assert.ok(out.candidates.every((c) => c.autoApprove === true), 'individually curated rows are approved');

  assert.equal(out.channelPuts.length, 3);
  const byId = new Map(out.channelPuts.map((c) => [c.channelId, c]));
  assert.equal(byId.get(CH_A).autoApprove, true);
  assert.equal(byId.get(CH_A).decidedAt, 5, 'an explicit flag IS the decision');
  assert.equal(byId.get(CH_B).autoApprove, false);
  assert.equal(byId.get(CH_B).decidedAt, null, 'a flagless row must wait in "ערוצים חדשים"');
  assert.equal(byId.get(PL_A).kind, 'playlist');
  assert.deepEqual(out.removedKeys, ['yt:zzzzzzzzzzz']);
});

test('planSheetFold: a channel with a DELETION TOMBSTONE is never re-subscribed', () => {
  // THE DATA-SAFETY TEST OF THE WHOLE MIGRATION. A sheet row carries no timestamp, and
  // putLibraryChannel stamps a FRESH updatedAt that beats the v1.0.36 tombstone by design
  // (channelOutlivesTombstone) — so without this branch one final read hands the family back
  // every subscription the parent ever removed.
  const out = planSheetFold({
    parsed: parsedFixture,
    resolved: new Map([['handle:SuperSimpleSongs', CH_B]]),
    knownChannelIds: new Set(),
    deletedChannels: { [CH_A]: 1000, [PL_A]: 2000 },
    libraryId: 'lib:abc', now: 5
  });
  const ids = out.channelPuts.map((c) => c.channelId);
  assert.ok(!ids.includes(CH_A), 'a deleted CHANNEL came back');
  assert.ok(!ids.includes(PL_A), 'a deleted PLAYLIST came back');
  assert.deepEqual(out.skippedChannelIds.sort(), [CH_A, PL_A].sort());
  assert.deepEqual(ids, [CH_B], 'and the channels the parent never deleted still arrive');
});

test('planSheetFold: an already-subscribed channel is NOT re-put', () => {
  // A fresh updatedAt would beat a peer's row, and a fresh decidedAt would silently clear the
  // row out of "ערוצים חדשים" before the parent answered.
  const out = planSheetFold({
    parsed: parsedFixture, resolved: new Map([['handle:SuperSimpleSongs', CH_B]]),
    knownChannelIds: new Set([CH_A, CH_B, PL_A]), deletedChannels: {}, libraryId: 'lib:abc'
  });
  assert.deepEqual(out.channelPuts, []);
});

test('planSheetFold: an UNRESOLVED handle is dropped, not guessed', () => {
  const out = planSheetFold({
    parsed: parsedFixture, resolved: new Map(), // resolution failed
    knownChannelIds: new Set(), deletedChannels: {}, libraryId: 'lib:abc'
  });
  const ids = out.channelPuts.map((c) => c.channelId);
  assert.deepEqual(ids.sort(), [CH_A, PL_A].sort(), 'only the rows whose id is known');
  assert.ok(ids.every((id) => id), 'a null id must never reach a subscription record');
});

test('planSheetFold has NO revocation surface — the migration cannot revive a deletion', () => {
  const out = planSheetFold({ parsed: parsedFixture, resolved: new Map(), knownChannelIds: new Set(),
    deletedChannels: {}, libraryId: 'lib:abc' });
  // planSheetMirror.unDenyKeys is deliberately not ported. Its absence is the guarantee: no
  // key list here can be handed to db.unDeny.
  assert.deepEqual(Object.keys(out).sort(), ['candidates', 'channelPuts', 'removedKeys', 'skippedChannelIds']);
  assert.ok(!('unDenyKeys' in out));
  const json = JSON.stringify(out);
  assert.ok(!/unDeny|undeny|revive/i.test(json));
});

test('planSheetFold: the moved quarantine still gates a legacy list, and never throws', () => {
  const withLegacy = planSheetFold({ parsed: parsedFixture, resolved: new Map(), knownChannelIds: new Set(),
    deletedChannels: {}, libraryId: 'lib:abc', legacyIndex: new Set(['yt:dQw4w9WgXcQ']) });
  assert.equal(withLegacy.candidates[0].autoApprove, true, 'a key the legacy list had is approved');
  assert.equal(withLegacy.candidates[1].autoApprove, false, 'a key it did not have waits for the parent');
  for (const bad of [undefined, null, {}, { parsed: 'x' }, { parsed: { videoRows: 'x' } }]) {
    const r = planSheetFold(bad);
    assert.ok(Array.isArray(r.candidates) && Array.isArray(r.channelPuts), JSON.stringify(bad));
  }
});

/* ==================== the read gate (moved from sheetwrite.js) ==================== */

test('extractSpreadsheetId / extractGid survive the move', () => {
  assert.equal(extractSpreadsheetId(SHEET), 'SHEET123');
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml'), null,
    'a published /d/e/ link cannot be read or deleted — it is not our file');
  assert.equal(extractSpreadsheetId('nonsense'), null);
  assert.equal(extractGid(SHEET), 0);
  assert.equal(extractGid('https://docs.google.com/spreadsheets/d/S/edit#gid=42'), 42);
  assert.equal(extractGid('https://docs.google.com/spreadsheets/d/S/edit'), 0);
});

test('interpretSheetResponse: EMPTINESS may come from exactly one input', () => {
  // v1.0.38 — the REASON changed and the gate did not. There is no presence-mirror left to
  // mistake [] for "the parent emptied the sheet", but a wrong [] now makes the sunset fold
  // NOTHING, forget the sheet, and then PERMANENTLY DELETE a file full of rows.
  assert.deepEqual(interpretSheetResponse(200, { range: 'A:C' }), [], 'a clean 200 with no values IS empty');
  assert.deepEqual(interpretSheetResponse(200, { values: [['a'], []] }), [['a'], []], 'ragged rows are normal');
  for (const [status, data, code] of [
    [500, {}, /sheet-http-500/],
    [0, {}, /sheet-http-0/],
    [401, {}, /sheet-http-401/],
    [200, null, /sheet-not-json/],
    [200, '<!DOCTYPE html><html>sign in</html>', /sheet-html/],
    [200, { error: { code: 403 } }, /sheet-api-403/],
    [200, { error: { status: 'PERMISSION_DENIED' } }, /sheet-api-PERMISSION_DENIED/],
    [200, { error: {}, values: [] }, /sheet-api/],
    [200, { values: 'nope' }, /sheet-not-json/],
    [200, [1, 2], /sheet-not-json/],
    [200, 'not json at all', /sheet-not-json/]
  ]) {
    assert.throws(() => interpretSheetResponse(status, data), code, `status=${status} data=${JSON.stringify(data)}`);
  }
  // an error envelope may ride along with ACTUAL rows (a partial-warning shape)
  assert.deepEqual(interpretSheetResponse(200, { error: { code: 1 }, values: [['a']] }), [['a']]);
});

/* ==================== the tripwire ==================== */

test('the sheet-sunset migration is REMOVABLE, and this test says when', () => {
  // After 2026-09-10 every device in the field has either migrated or given up (three
  // attempts, one per launch), and planSheetSunset answers 'forget' for everything past the
  // deadline regardless of token or attempts. All that is left is a sheet-reading path
  // carrying a Drive DELETE.
  //
  // REMOVAL CHECKLIST:
  //   1. delete www/js/sunset.js
  //   2. delete the runSheetSunset() call + its dynamic import in app.js entryRefresh
  //   3. delete plan.planSheetSunset, plan.planSheetFold, plan.SUNSET_DEADLINE
  //   4. delete migrate.planMigration's sheetUrl / sheetHash / legacySheetMigrated fields
  //      and the migrate.test.mjs assertions that pin them as the sunset's input
  //   5. delete the sunset guards in test/invariants.test.mjs, and this file
  //   6. drop the 'sunset:' meta keys from db.purgeProfile's metaKeys list
  //   7. remove the dated migration clause from docs/privacy.html
  const DEADLINE = Date.parse('2026-09-10T00:00:00Z');
  assert.equal(SUNSET_DEADLINE, DEADLINE,
    'the deadline the CODE enforces and the one this test guards have drifted — one of them is wrong');
  assert.ok(Date.now() < DEADLINE,
    'THE SHEET-SUNSET DEADLINE HAS PASSED. Delete the migration — the checklist is in the comment above this assertion.');
});
