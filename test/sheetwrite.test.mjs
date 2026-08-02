// Sheet write-back (v1.0.6) — pure parts: spreadsheet-id/gid extraction and the row
// convention (A=link, B=title, C=flag). The published /d/e/ form carries an opaque
// token, NOT the spreadsheet id — extraction must refuse it, never mis-extract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetId, extractGid, buildSheetRow, remainingAfterFlush, reconcileOps, SHEETS_FOLDER_NAME,
  starterRows, matchRowsForDeletion, sheetErrorMessage, interpretSheetResponse, interpretWriteResponse,
  planQueue, flushSheetQueue, sheetWriteState } from '../www/js/sheetwrite.js';
import { classifySourceRow, parseRemovalRow } from '../www/js/classify.js';
import { parseSourceRows } from '../www/js/sync2.js';

const ID = '1AbC_dEf-9xYz0123456789abcdefghijklmnopqrst';

test('extractSpreadsheetId: edit/share/export links → the id', () => {
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`), ID);
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), ID);
  assert.equal(extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=42`), ID);
  assert.equal(extractSpreadsheetId(`docs.google.com/spreadsheets/d/${ID}`), ID);
});

test('extractSpreadsheetId: published /d/e/ links and garbage → null (cannot write)', () => {
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/e/2PACX-1vTtoken/pub?output=csv'), null);
  assert.equal(extractSpreadsheetId('https://example.com/spreadsheets/d/abc'), null);
  assert.equal(extractSpreadsheetId('not a url'), null);
  assert.equal(extractSpreadsheetId(''), null);
  assert.equal(extractSpreadsheetId(null), null);
});

test('extractGid: explicit gid wins, absent → 0 (the original first tab)', () => {
  assert.equal(extractGid(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1774707986`), 1774707986);
  assert.equal(extractGid(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=42`), 42);
  assert.equal(extractGid(`https://docs.google.com/spreadsheets/d/${ID}/edit`), 0);
  assert.equal(extractGid(null), 0);
});

test('buildSheetRow: always 3 columns, missing fields become empty strings', () => {
  assert.deepEqual(
    buildSheetRow({ srcUrl: 'https://youtu.be/x', title: 'שיר, עם פסיק', flag: '' }),
    ['https://youtu.be/x', 'שיר, עם פסיק', '']
  );
  assert.deepEqual(buildSheetRow({ srcUrl: 'https://youtu.be/x' }), ['https://youtu.be/x', '', '']);
  assert.deepEqual(
    buildSheetRow({ srcUrl: 'https://www.youtube.com/channel/UCabc', flag: 'manual' }),
    ['https://www.youtube.com/channel/UCabc', '', 'manual']
  );
  assert.deepEqual(buildSheetRow({ srcUrl: null, title: null, flag: null }), ['', '', '']);
});

/* ---------------- v1.0.8: wizard helpers ---------------- */

// (The old single-row starterRows test lived here. v1.0.19 turned that one crammed
// sentence into a real column header plus instructions, so `rows.length === 1` no
// longer holds; the block at the end of this file supersedes it and checks more.)

/* ---------------- v1.0.10: deletion ops ---------------- */

test('reconcileOps: latest intent per identity wins; legacy entries normalize to appends', async () => {
  const { reconcileOps } = await import('../www/js/sheetwrite.js');
  const q = [
    { key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 10 },              // legacy (pre-v1.0.10) append
    { op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 20 },                  // then deleted → delete wins
    { op: 'delchannel', channelId: 'UCx', at: 10 },
    { op: 'append', key: 'ch:UCx', row: ['u2', '', 'manual'], at: 30 }, // channel re-added → append wins
    { op: 'append', key: 'yt:bbbbbbbbbb1', row: ['u3', '', ''], at: 5 }
  ];
  const out = reconcileOps(q);
  const byId = Object.fromEntries(out.map((o) => [(o.op === 'delchannel' ? 'ch:' + o.channelId : o.key), o.op]));
  assert.equal(byId['yt:aaaaaaaaaa1'], 'delvideo');
  assert.equal(byId['ch:UCx'], 'append');
  assert.equal(byId['yt:bbbbbbbbbb1'], 'append');
  assert.equal(out.length, 3);
});

test('matchRowsForDeletion: keys match across URL variants, channels via handleMap, DESC order', async () => {
  const { matchRowsForDeletion } = await import('../www/js/sheetwrite.js');
  const colA = [
    '# הערה',
    'https://youtu.be/aaaaaaaaaa1?si=xyz',                       // 1 — video (short link)
    'https://www.youtube.com/watch?v=aaaaaaaaaa1',               // 2 — SAME video, other form
    'https://www.youtube.com/@somekids',                         // 3 — channel by handle
    'https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz',  // 4 — channel by id
    'https://youtu.be/keepmmmmmm1'                               // 5 — unrelated, stays
  ];
  const ops = [
    { op: 'delvideo', key: 'yt:aaaaaaaaaa1' },
    { op: 'delchannel', channelId: 'UCyyyyyyyyyyyyyyyyyyyyyy' },
    { op: 'delchannel', channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz' }
  ];
  const handleMap = { 'handle:somekids': 'UCyyyyyyyyyyyyyyyyyyyyyy' };
  assert.deepEqual(matchRowsForDeletion(colA, ops, handleMap), [4, 3, 2, 1]);
  // unresolvable handle without the map → that row is left alone
  assert.deepEqual(matchRowsForDeletion(colA, [ops[1]], {}), []);
});

/* ---------------- v1.0.12: removal rows + per-profile sheet name ---------------- */

test('buildRemovalRow: a comment row old versions skip and new ones read back', async () => {
  const { buildRemovalRow } = await import('../www/js/sheetwrite.js');
  const { classifySourceRow } = await import('../www/js/classify.js');
  const row = buildRemovalRow({ srcUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'שיר' });
  assert.equal(row.length, 3);
  assert.ok(row[0].startsWith('#'));
  const parsed = classifySourceRow(row[0]);
  assert.equal(parsed.kind, 'removed');
  assert.equal(parsed.key, 'yt:dQw4w9WgXcQ');
  // titleless form still round-trips
  assert.equal(classifySourceRow(buildRemovalRow({ srcUrl: 'https://youtu.be/dQw4w9WgXcQ' })[0]).key, 'yt:dQw4w9WgXcQ');
});

test('sheetNameFor: "<profile>_רשימת סרטונים", whitespace-normalized, never empty', async () => {
  const { sheetNameFor } = await import('../www/js/sheetwrite.js');
  assert.equal(sheetNameFor('דני'), 'דני_רשימת סרטונים');
  assert.equal(sheetNameFor('  נועה   לוי '), 'נועה לוי_רשימת סרטונים');
  assert.equal(sheetNameFor(''), 'ילד/ה_רשימת סרטונים');
  assert.equal(sheetNameFor(null), 'ילד/ה_רשימת סרטונים');
});

test('a removal row that cannot round-trip is REFUSED before it reaches the queue', async () => {
  const { enqueueSheetRemovalRow, buildRemovalRow } = await import('../www/js/sheetwrite.js');
  // Both are rejected purely (no DB touched): a record with no usable link, and a
  // key that would not parse back — either would leave a dead row in the sheet.
  assert.equal((await enqueueSheetRemovalRow('p1', { key: 'yt:dQw4w9WgXcQ', srcUrl: '' })).error, 'unrepresentable');
  assert.equal((await enqueueSheetRemovalRow('p1', { key: 'yt:MISMATCHKEY', srcUrl: 'https://youtu.be/dQw4w9WgXcQ' })).error, 'unrepresentable');
  // the accepted shape (verified purely — the enqueue itself needs IndexedDB):
  const { classifySourceRow } = await import('../www/js/classify.js');
  const ok = classifySourceRow(buildRemovalRow({ srcUrl: 'https://x.com/a.mp4' })[0]);
  assert.equal(ok.kind, 'removed');
  assert.equal(ok.key, 'file:https://x.com/a.mp4', 'direct-file links round-trip too');
});

/* ---- v1.0.18: a flush must clear ONLY what it wrote ---- */

test('remainingAfterFlush keeps ops enqueued while the flush was in the air', () => {
  // THE BUG: flush#1 snapshots [A], goes to the network; the parent deletes a
  // video so the queue becomes [A,B]; flush#1 finishes and used to set the queue
  // to []. B was destroyed — its row survived in the sheet, the next mirror pass
  // read that as presence, revoked the tombstone, and the deleted video came back
  // on every device.
  const A = { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 100 };
  const B = { op: 'delvideo', key: 'yt:bbbbbbbbbb2', at: 200 };
  assert.deepEqual(remainingAfterFlush([A, B], [A]), [B]);
});

test('remainingAfterFlush drops exactly the flushed ops', () => {
  const A = { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 100 };
  const B = { op: 'delchannel', channelId: 'UCchan111111111111111111', at: 150 };
  assert.deepEqual(remainingAfterFlush([A, B], [A, B]), []);
  assert.deepEqual(remainingAfterFlush([], [A]), []);
});

test('remainingAfterFlush: a NEWER intent for a flushed key survives', () => {
  // Parent adds a video, flush starts, parent deletes it before the flush lands.
  // The delete must outlive the flush or the row stays in the sheet forever.
  const add = { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 100 };
  const del = { op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 300 };
  assert.deepEqual(remainingAfterFlush([add, del], [add]), [del]);
  // ...but a re-delivery of the SAME op (same identity, same at) is not kept
  assert.deepEqual(remainingAfterFlush([add], [add]), []);
});

test('remainingAfterFlush tolerates junk and legacy op-less rows', () => {
  const legacy = { key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 50 }; // pre-op-field
  assert.deepEqual(remainingAfterFlush([legacy], [legacy]), []);   // normalized to 'append'
  assert.deepEqual(remainingAfterFlush([null, undefined], []), []);
  assert.deepEqual(remainingAfterFlush(null, null), []);
});

test('reconcileOps collapses per entity, so the 200-op cap counts ENTITIES', () => {
  // enqueueOp reconciles BEFORE slice(-CAP). Without that, re-editing one video
  // 300 times pushed 300 entries and evicted 100 unrelated ops off the head —
  // and slice() drops the OLDEST, i.e. the parent's earliest deletions.
  const churn = Array.from({ length: 300 }, (_, i) => ({ op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: i }));
  const older = { op: 'delvideo', key: 'yt:bbbbbbbbbb2', at: -1 };
  const out = reconcileOps([older, ...churn]);
  assert.equal(out.length, 2, 'one op per entity');
  assert.ok(out.some((o) => o.key === 'yt:bbbbbbbbbb2'), 'the old deletion is not evicted');
  assert.equal(out.find((o) => o.key === 'yt:aaaaaaaaaa1').at, 299, 'latest intent wins');
});

/* ---- v1.0.19: drive.file only — the app writes solely to sheets it created ---- */

test('the Drive folder name is the one users are told to look for', () => {
  // Named in the onboarding guide, the sources panel and the docs. If this string
  // changes, ensureSheetsFolder creates a SECOND folder and the parent's existing
  // lists appear to vanish from where they were told to find them.
  assert.equal(SHEETS_FOLDER_NAME, 'רשימת השמעה לאפליקציה הסרטונים שלי');
});

test('extractSpreadsheetId still refuses the published /d/e/ form', () => {
  // Reads are authenticated now and go through this id. A published link carries an
  // opaque token, NOT a spreadsheet id — extracting it would build a bogus API call.
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/e/2PACX-1vABC/pubhtml'), null);
  assert.equal(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit#gid=0'), '1AbC_dEf-123');
});

/* ---- v1.0.19: the starter header must be invisible to the parser ---- */

test('starterRows: every row is a comment the parser skips', () => {
  const rows = starterRows();
  assert.ok(rows.length >= 2, 'a header row plus at least one instruction');
  for (const [a] of rows) {
    assert.ok(String(a).startsWith('#'),
      `column A must start with '#' or the header becomes content: ${a}`);
    assert.equal(classifySourceRow(a).kind, 'comment', `not skipped: ${a}`);
  }
});

test('starterRows: the header row captions all THREE columns', () => {
  // The point of the v1.0.19 rewrite: captions sit UNDER the columns they describe
  // instead of one long sentence crammed into A.
  const [header] = starterRows();
  assert.equal(header.length, 3);
  assert.ok(/A/.test(header[0]) && /לינק/.test(header[0]), 'A = the link column');
  assert.ok(/B/.test(header[1]) && /שם/.test(header[1]), 'B = display name');
  assert.ok(/C/.test(header[2]) && /auto/.test(header[2]), 'C = the auto/manual flag');
});

test('starterRows: NO row may look like a removal — it would deny a real key', () => {
  // parseRemovalRow turns "# הוסר: <link>" into a tombstone for every device on the
  // sheet. The instructions contain an example youtu.be link, so if any line ever
  // picked up a removal marker it would permanently deny that video id.
  for (const [a] of starterRows()) {
    assert.equal(parseRemovalRow(a), null, `reads as a removal row: ${a}`);
    assert.doesNotMatch(a, /\b(הוסר|הוסרו|removed|remove|deleted)\b/i);
  }
});

test('starterRows: the header never shifts video ordinals', () => {
  // rowIndex feeds sortKey. If comments counted, adding a header line to a new
  // sheet would renumber every video and reshuffle the child's home screen.
  const sheet = [...starterRows(), ['https://youtu.be/aaaaaaaaaa1', 'ראשון', ''],
    ['https://youtu.be/bbbbbbbbbb2', 'שני', '']];
  const out = parseSourceRows(sheet);
  assert.equal(out.videoRows.length, 2);
  assert.deepEqual(out.videoRows.map((r) => r.rowIndex), [0, 1]);
  assert.equal(out.channelRows.length, 0);
  assert.equal(out.removedKeys.length, 0);
});

test('starterRows: the example links are never imported as content', () => {
  // The instruction row shows a youtu.be URL. It must stay a comment — otherwise a
  // brand-new sheet would import a placeholder "VIDEO_ID" video for the child.
  const out = parseSourceRows(starterRows());
  assert.deepEqual(out.videoRows, []);
  assert.deepEqual(out.channelRows, []);
  assert.deepEqual(out.removedKeys, []);
});

test('starterRows: a deletion pass cannot match the header rows', () => {
  const colA = starterRows().map(([a]) => a);
  const ops = [{ op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 1 },
    { op: 'delchannel', channelId: 'UCchan111111111111111111', at: 2 }];
  assert.deepEqual(matchRowsForDeletion(colA, ops, {}), [], 'header rows are never deleted');
});

/* ---- v1.0.19: a failed sheet read must reach the parent, with a next step ---- */

test('sheetErrorMessage: every failure mode names an action the parent can take', () => {
  // The bug this closes: reads need a token now, so revoking the app freezes the
  // library forever — and the sources tab used to answer "עודכן ✅" regardless.
  const cases = ['sheet-no-token', 'sheet-http-401', 'sheet-http-403', 'sheet-http-404',
    'sheet-bad-url', 'sheet-http-500', 'sheet-failed', '', null, undefined];
  for (const c of cases) {
    const m = sheetErrorMessage(c);
    assert.ok(m && m.length > 20, `no message for ${c}`);
    assert.doesNotMatch(m, /✅/, `a failure must never render as success: ${c}`);
  }
});

test('sheetErrorMessage: a revoked grant points at reconnecting', () => {
  for (const c of ['sheet-no-token', 'sheet-http-401']) {
    assert.match(sheetErrorMessage(c), /התחברו מחדש/);
  }
});

test('sheetErrorMessage: 403/404 points at creating a new list, not at pasting', () => {
  // This is the pre-v1.0.19 pasted-sheet case. The old copy told parents to paste
  // the edit link — an instruction they cannot follow, since that field is gone.
  for (const c of ['sheet-http-403', 'sheet-http-404']) {
    const m = sheetErrorMessage(c);
    assert.match(m, /צרו רשימה חדשה/);
    assert.doesNotMatch(m, /הדביקו/, 'must not tell them to paste — there is no paste field');
  }
});

test('sheetErrorMessage: an offline read reassures that nothing was lost', () => {
  assert.match(sheetErrorMessage('sheet-http-0'), /התוכן הקיים נשמר/);
});

/* ---- the READ path: an unreadable sheet must NEVER look like an emptied one ----
 *
 * interpretSheetResponse is the single gate between an HTTP response and rows. The
 * caller turns its throw into "leave sheetParsed false", and the presence-mirror
 * deletes content only on a successful parse — so any [] it returns by mistake reads
 * as "the parent emptied the sheet" and tombstones the whole library. These tests
 * exist to keep exactly ONE input capable of producing []. */

/** The thrown error, or null when the call unexpectedly returned. */
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e; } };

test('interpretSheetResponse: EVERY non-200 throws, and the code survives into sheetErrorMessage', () => {
  const rows = { values: [['https://youtu.be/aaaaaaaaaa1', 'שיר', '']] };
  for (const status of [401, 403, 404, 429, 500, 0]) {
    const e = thrown(() => interpretSheetResponse(status, rows));
    assert.ok(e, `status ${status} must throw — returning [] would delete the library`);
    assert.match(e.message, new RegExp(`^sheet-http-${status}$`), 'the status must ride in the message');
    const m = sheetErrorMessage(e.message);
    assert.ok(m && m.length > 20, `no parent-facing message for ${status}`);
    assert.doesNotMatch(m, /✅/, 'a failed read must never render as success');
  }
  // and the specific statuses stay specific instead of falling to the generic copy
  assert.match(sheetErrorMessage(thrown(() => interpretSheetResponse(401, rows)).message), /התחברו מחדש/);
  assert.match(sheetErrorMessage(thrown(() => interpretSheetResponse(403, rows)).message), /צרו רשימה חדשה/);
  assert.match(sheetErrorMessage(thrown(() => interpretSheetResponse(404, rows)).message), /צרו רשימה חדשה/);
});

test('interpretSheetResponse: a 200 with no `values` is the ONLY empty result', () => {
  // The Sheets API omits the key entirely for an empty range. THAT is an empty sheet,
  // and the mirror's total-disappearance valve is what asks the parent about it.
  assert.deepEqual(interpretSheetResponse(200, { range: "'גיליון1'!A1:C1000", majorDimension: 'ROWS' }), []);
  assert.deepEqual(interpretSheetResponse(200, { values: [] }), []);
  assert.deepEqual(interpretSheetResponse(200, '{"range":"A:C","majorDimension":"ROWS"}'), []);
});

test('interpretSheetResponse: an HTML permission page wearing a 200 is a FAILURE, not an empty sheet', () => {
  // THE BUG THIS CLOSES (v1.0.18, via the CSV reader): losing the grant does not fail
  // the request — Google answers 200 with a sign-in / "request access" page. Parsing
  // that as "the parent emptied the sheet" deleted whole libraries.
  const pages = [
    '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head><body>…',
    '<html lang="en"><body>Request access</body></html>',
    '\n  \t<!doctype HTML>\n<html>',
    '﻿<!DOCTYPE html>',                 // BOM-prefixed
    '<?xml version="1.0"?><Error/>'
  ];
  for (const page of pages) {
    const e = thrown(() => interpretSheetResponse(200, page));
    assert.ok(e, `treated markup as rows: ${page.slice(0, 30)}`);
    const m = sheetErrorMessage(e.message);
    assert.match(m, /התחברו מחדש/, 'the parent needs a next step, not a shrug');
    assert.match(m, /התוכן הקיים נשמר/, 'nothing was deleted — say so');
  }
  // The browser path never even sees the HTML: fetch().json() yields null on a 200.
  assert.ok(thrown(() => interpretSheetResponse(200, null)), 'a bodyless 200 is a failure too');
});

test('interpretSheetResponse: a JSON error envelope on a 200 keeps its code', () => {
  // A proxy (or a flattening client) can hand back Google's {error:{…}} with the
  // status lost. It has no `values`, so it would otherwise read as an empty sheet.
  const perm = thrown(() => interpretSheetResponse(200, {
    error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' }
  }));
  assert.ok(perm);
  assert.match(sheetErrorMessage(perm.message), /צרו רשימה חדשה/);
  const auth = thrown(() => interpretSheetResponse(200, { error: { code: 401, status: 'UNAUTHENTICATED' } }));
  assert.match(sheetErrorMessage(auth.message), /התחברו מחדש/);
  // an envelope WITH rows is still rows (a partial-warning shape must not delete)
  assert.deepEqual(interpretSheetResponse(200, { error: { code: 0 }, values: [['a']] }), [['a']]);
});

test('interpretSheetResponse: an error envelope can never produce the EMPTY answer', () => {
  // Emptiness is the one answer that can destroy data (the presence-mirror reads it as
  // "the parent emptied the sheet"). Gating the error branch on a MISSING `values` let
  // an envelope carrying `values: []` slip through and return [] — a second source of
  // emptiness, against this function's whole contract.
  for (const payload of [
    { error: { code: 403, status: 'PERMISSION_DENIED' }, values: [] },
    { error: { code: 500 }, values: [] },
    { error: 'invalid_grant', values: [] }
  ]) {
    assert.ok(thrown(() => interpretSheetResponse(200, payload)),
      `an error envelope returned []: ${JSON.stringify(payload)}`);
  }
  // a clean 200 with no `values` key stays the ONE input that legitimately means empty
  assert.deepEqual(interpretSheetResponse(200, {}), []);
});

test('interpretSheetResponse: every failure lands on a message with a NEXT STEP', () => {
  // 'sheet-http-200' / 'sheet-api-error' matched no sheetErrorMessage branch and fell
  // through to "maybe no internet" — i.e. "do nothing" — for failures only reconnecting
  // fixes. A bodyless 200 IS the browser's view of the sign-in interstitial
  // (platform.httpRequest does r.json().catch(() => null)), so it must route like one.
  const reconnect = /התחברו מחדש/;
  for (const [payload, want] of [
    [null, reconnect],                                        // browser: HTML became null
    ['', reconnect],
    [{ error: 'invalid_grant' }, reconnect],                  // OAuth, bare string
    [{ error: { status: 'UNAUTHENTICATED' } }, reconnect],    // no numeric code
    [{ error: { status: 'PERMISSION_DENIED' } }, /צרו רשימה חדשה/],
    [{ error: { status: 'NOT_FOUND' } }, /צרו רשימה חדשה/]
  ]) {
    const e = thrown(() => interpretSheetResponse(200, payload));
    assert.ok(e, `did not throw: ${JSON.stringify(payload)}`);
    assert.match(sheetErrorMessage(e.message), want, `misrouted: ${JSON.stringify(payload)} -> ${e.message}`);
  }
});

test('interpretSheetResponse: ragged rows survive untouched (the API omits trailing cells)', () => {
  const values = [
    ['# עמודה A · לינק', 'שם', 'auto/manual'],
    ['https://youtu.be/aaaaaaaaaa1', 'שיר'],          // C omitted
    ['https://youtu.be/bbbbbbbbbb2'],                 // B and C omitted
    [],                                               // a blank line
    ['https://www.youtube.com/@somekids', '', 'auto']
  ];
  const rows = interpretSheetResponse(200, { values });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[2], ['https://youtu.be/bbbbbbbbbb2']);
  assert.deepEqual(rows[3], []);
  // and the downstream parser tolerates the same raggedness
  const out = parseSourceRows(rows);
  assert.equal(out.videoRows.length, 2);
  assert.equal(out.channelRows.length, 1);
  // a non-array row becomes an empty row rather than throwing mid-parse
  assert.deepEqual(interpretSheetResponse(200, { values: ['nope', null, 7] }), [[], [], []]);
});

test('interpretSheetResponse: an unparseable payload refuses to guess []', () => {
  // Guessing "empty" is the single answer that can destroy data, so anything we do
  // not recognize throws: garbage strings, non-objects, and a values of the wrong type.
  for (const junk of ['not json at all', '{"values":', 42, true, [], [['a']], { values: 'oops' }, { values: 5 }]) {
    assert.ok(thrown(() => interpretSheetResponse(200, junk)), `silently accepted: ${JSON.stringify(junk)}`);
  }
  // the native path (CapacitorHttp returns a STRING when responseType:'json' fails to
  // parse for it) still reads real JSON correctly
  assert.deepEqual(
    interpretSheetResponse(200, '{"values":[["https://youtu.be/aaaaaaaaaa1","שיר",""]]}'),
    [['https://youtu.be/aaaaaaaaaa1', 'שיר', '']]
  );
});

/* ---- the WRITE queue: the cap must not eat un-sent deletes ---- */

test('planQueue: 300 DISTINCT deletes against a cap of 200 keep the OLDEST intents', () => {
  // THE BUG: `slice(-cap)` drops the HEAD, and the head is the parent's EARLIEST
  // deletions. An offline bulk cleanup of 300 videos discarded the first 100
  // delvideo ops; their rows stayed in the sheet, the next mirror pass read that
  // presence as a deliberate re-add, revoked the tombstones, and every deleted
  // video came back on every device. FIFO: what is queued stays queued.
  const existing = Array.from({ length: 299 }, (_, i) => ({
    op: 'delvideo', key: 'yt:v' + String(i).padStart(9, '0'), at: i + 1
  }));
  const newest = { op: 'delvideo', key: 'yt:v000000299', at: 300 };
  const { queue, overflow } = planQueue(existing, newest, 200);
  assert.equal(queue.length, 200);
  assert.equal(overflow, true, 'overflow is data loss — the parent must be told');
  assert.equal(queue[0].key, 'yt:v000000000', 'the earliest delete is never evicted');
  assert.equal(queue[199].key, 'yt:v000000199');
  assert.equal(new Set(queue.map((o) => o.key)).size, 200, 'no identity kept twice');
});

test('planQueue: two ops for the SAME entity collapse and consume ONE slot', () => {
  // Reconcile BEFORE capping: re-editing one video 300 times must not push anything
  // else out of the queue.
  const churn = Array.from({ length: 300 }, (_, i) => ({ op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: i }));
  const older = { op: 'delvideo', key: 'yt:bbbbbbbbbb2', at: -1 };
  const { queue, overflow } = planQueue([older, ...churn], { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u2', '', ''], at: 1000 }, 200);
  assert.equal(queue.length, 2, 'one slot per ENTITY, not per op');
  assert.equal(overflow, false);
  assert.ok(queue.some((o) => o.key === 'yt:bbbbbbbbbb2'), 'the old deletion survives the churn');
  assert.equal(queue.find((o) => o.key === 'yt:aaaaaaaaaa1').row[0], 'u2', 'latest intent wins');
});

test('planQueue: at capacity, an update to an ALREADY-queued entity still lands', () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ op: 'append', key: 'yt:k' + i, row: ['u' + i, '', ''], at: i + 1 }));
  const { queue, overflow } = planQueue(full, { op: 'delvideo', key: 'yt:k7', at: 9999 }, 200);
  assert.equal(overflow, false, 'no new slot was needed');
  assert.equal(queue.length, 200);
  assert.equal(queue.find((o) => o.key === 'yt:k7').op, 'delvideo');
});

test('planQueue: append-then-delete and delete-then-append both resolve to the latest intent', () => {
  const add = { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 100 };
  const del = { op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 200 };
  assert.deepEqual(planQueue([add], del, 200).queue, [del], 'the delete is what the sheet must see');
  const readd = planQueue([del], { ...add, at: 300 }, 200).queue;
  assert.equal(readd.length, 1);
  assert.equal(readd[0].op, 'append', 're-adding after a delete keeps the row');
  // a channel is ONE entity across both op shapes (delchannel carries channelId, the
  // append carries key 'ch:<id>') — otherwise it would consume two slots and the
  // superseded op would still reach the sheet.
  const chDel = { op: 'delchannel', channelId: 'UCchan111111111111111111', at: 10 };
  const chAdd = { op: 'append', key: 'ch:UCchan111111111111111111', row: ['u', '', 'manual'], at: 20 };
  const out = planQueue([chDel], chAdd, 200).queue;
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'append');
  const chGone = { ...chDel, at: 30 }; // the parent removed it AFTER re-adding it
  assert.deepEqual(planQueue([chAdd], chGone, 200).queue, [chGone], 'and the reverse order too');
});

test('planQueue: junk never throws — the queue is durable storage an older version wrote', () => {
  assert.deepEqual(planQueue(null, null, 200), { queue: [], overflow: false });
  assert.deepEqual(planQueue(undefined, undefined), { queue: [], overflow: false });
  const legacy = { key: 'yt:aaaaaaaaaa1', row: ['u', '', ''], at: 50 }; // pre-op-field entry
  const r = planQueue([null, legacy, undefined], null, 200);
  assert.equal(r.queue.length, 1);
  assert.equal(r.queue[0].op, 'append', 'legacy entries normalize to appends');
  assert.equal(planQueue([{}], {}, 200).queue.length, 1, 'shapeless ops collapse instead of throwing');
  // A nonsense cap must fall back to the real one — never empty the queue.
  for (const cap of [0, -5, NaN, null, 'many', undefined]) {
    assert.equal(planQueue([legacy], null, cap).queue.length, 1, `cap ${cap} emptied the queue`);
  }
});

/* ---------------- playlist rows in the write-back queue (v1.0.27) ---------------- */

test('matchRowsForDeletion: a PLAYLIST row is matched by its playlist id', async () => {
  const { matchRowsForDeletion } = await import('../www/js/sheetwrite.js');
  const colA = [
    '# הוראות',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'https://www.youtube.com/playlist?list=PLmix1234567890',
    'https://www.youtube.com/channel/UCchan111111111111111111'
  ];
  // v1.0.26: this matched NOTHING for a playlist — the row stayed, clearFlushed dropped
  // the op, and the next sync re-subscribed the playlist the parent had just deleted,
  // while the confirm dialog promised removal "מקובץ המקורות".
  const ops = [{ op: 'delchannel', channelId: 'PLmix1234567890', kind: 'playlist', at: 1 }];
  assert.deepEqual(matchRowsForDeletion(colA, ops, {}), [2]);
  // and it must not over-match: a channel delete still touches only the channel row
  assert.deepEqual(
    matchRowsForDeletion(colA, [{ op: 'delchannel', channelId: 'UCchan111111111111111111', at: 1 }], {}),
    [3]);
});

test('reconcileOps: a playlist ADD and its DELETE share one identity', async () => {
  const { reconcileOps } = await import('../www/js/sheetwrite.js');
  // The add travels as key 'pl:<id>'; the delete used to reconcile under 'ch:<id>', so
  // the two NEVER collapsed and the flush re-appended the row right after deleting it.
  const add = { op: 'append', key: 'pl:PLmix1234567890', row: ['x'], at: 1 };
  const del = { op: 'delchannel', channelId: 'PLmix1234567890', kind: 'playlist', at: 2 };
  const out = reconcileOps([add, del]);
  assert.equal(out.length, 1, 'add+delete of one playlist must collapse to the later intent');
  assert.equal(out[0].op, 'delchannel');
  // the other order too — later intent wins regardless
  const out2 = reconcileOps([del, { ...add, at: 3 }]);
  assert.equal(out2.length, 1);
  assert.equal(out2[0].op, 'append');
  // a CHANNEL delete keeps its own identity — no cross-kind collision
  const ch = reconcileOps([add, { op: 'delchannel', channelId: 'PLmix1234567890', at: 2 }]);
  assert.equal(ch.length, 2, "without kind:'playlist' the identities differ — the old bug, kept visible");
});

/* ---- the WRITE gate (v1.0.26): a write must be PROVEN, not merely not-refused ----
 *
 * THE BUG THIS CLOSES: both write calls in doFlush gated on `res.status !== 200`
 * alone. platform.httpRequest does `r.json().catch(() => null)`, so the sign-in
 * interstitial (a lost grant answering 200 + HTML — the exact case
 * interpretSheetResponse exists for) arrived as {status: 200, data: null} and was
 * counted a SUCCESSFUL write. clearFlushed then dropped the append whose row never
 * landed → the record was live + sheet-backed + rowless + absent from
 * pendingAppendKeys → the next presence-mirror pass tombstone-deleted the video on
 * every device. One lost append of a 50-video library stays under the max(10, 5%)
 * valve, so no parent was ever asked. */

test('interpretWriteResponse: EVERY non-200 throws, for both kinds', () => {
  for (const status of [401, 403, 404, 429, 500, 0]) {
    for (const kind of ['append', 'batchUpdate']) {
      const e = thrown(() => interpretWriteResponse(status, { updates: {}, spreadsheetId: ID, replies: [{}] }, kind));
      assert.ok(e, `status ${status} passed as a landed ${kind}`);
      assert.match(e.message, new RegExp(`^sheet-http-${status}$`), 'the status must ride in the message');
    }
  }
});

test('interpretWriteResponse: a 200 the client could not parse is NOT a landed write', () => {
  // {status:200, data:null} is exactly how the browser path delivers the HTML
  // interstitial; the string forms are the native (CapacitorHttp) view of the same.
  for (const body of [null, undefined, '', '<!DOCTYPE html><html><body>Sign in</body></html>',
    '\n <!doctype HTML>', 'not json at all', '{"updates":', 42, true, [], [['a']]]) {
    for (const kind of ['append', 'batchUpdate']) {
      const e = thrown(() => interpretWriteResponse(200, body, kind));
      assert.ok(e, `200 + ${JSON.stringify(body)} passed as a landed ${kind}`);
      assert.match(e.message, /^sheet-(html|not-json)$/);
    }
  }
});

test('interpretWriteResponse: an error envelope on a 200 is NEVER proof — even beside a marker', () => {
  // Unlike the read gate there are no "actual rows" that could ride along: a write
  // Google reports an error for is a write we cannot count on, and retrying is
  // idempotent (a landed delete matches no row, a landed append dedupes by presence).
  assert.match(thrown(() => interpretWriteResponse(200,
    { error: { code: 403, status: 'PERMISSION_DENIED' } }, 'batchUpdate')).message, /^sheet-api-403$/);
  assert.match(thrown(() => interpretWriteResponse(200,
    { error: 'invalid_grant', updates: { updatedRows: 1 } }, 'append')).message, /^sheet-api-invalid_grant$/);
  assert.match(thrown(() => interpretWriteResponse(200,
    { error: { code: 500 }, spreadsheetId: ID, replies: [{}] }, 'batchUpdate')).message, /^sheet-api-500$/);
});

test('interpretWriteResponse: success has exactly ONE shape per operation', () => {
  // values.append answers {spreadsheetId, tableRange, updates:{…}} — the
  // AppendValuesResponse wrapper is the marker (createSourceSheet already relies on
  // this API family answering typed objects, e.g. spreadsheetId on create).
  const appendOk = { spreadsheetId: ID, tableRange: "'גיליון1'!A1:C4",
    updates: { spreadsheetId: ID, updatedRange: "'גיליון1'!A5:C5", updatedRows: 1, updatedColumns: 3, updatedCells: 3 } };
  assert.equal(interpretWriteResponse(200, appendOk, 'append'), appendOk);
  // the native path hands back a STRING when responseType:'json' fails to parse for it
  assert.ok(interpretWriteResponse(200, '{"updates":{"updatedRows":1}}', 'append'));
  // spreadsheets.batchUpdate answers {spreadsheetId, replies:[…]} — deleteDimension
  // replies are EMPTY objects, so only the array's existence (or the id) is a marker.
  assert.ok(interpretWriteResponse(200, { spreadsheetId: ID, replies: [{}] }, 'batchUpdate'));
  assert.ok(interpretWriteResponse(200, { spreadsheetId: ID }, 'batchUpdate'));
  assert.ok(interpretWriteResponse(200, { replies: [] }, 'batchUpdate'));
  // a marker-less 200 ({} = "OK" from a well-meaning proxy) proves nothing
  assert.match(thrown(() => interpretWriteResponse(200, {}, 'append')).message, /^sheet-write-unproven-append$/);
  assert.match(thrown(() => interpretWriteResponse(200, {}, 'batchUpdate')).message, /^sheet-write-unproven-batchUpdate$/);
  // the kind is LOAD-BEARING: each operation's marker proves only its own write
  assert.ok(thrown(() => interpretWriteResponse(200, { spreadsheetId: ID, replies: [{}] }, 'append')),
    'a batchUpdate shape must not prove an append');
  assert.ok(thrown(() => interpretWriteResponse(200, { updates: { updatedRows: 1 } }, 'batchUpdate')),
    'an append shape must not prove a batchUpdate');
  assert.ok(thrown(() => interpretWriteResponse(200, { ...appendOk, replies: [{}] }, 'delete')),
    'an unknown kind fails CLOSED, whatever the payload carries');
});

/* ---- BEHAVIORAL: the real flushSheetQueue against a scripted network ----
 *
 * flushSheetQueue is db + token + network, so the three LEAF seams are stubbed at
 * the global boundary (node --test runs each file in its own process, nothing leaks):
 *  - indexedDB: a minimal in-memory shim covering exactly what getMeta/putMeta/
 *    getSources/tx touch — hand-rolled here, NOT fake-indexeddb, so the suite stays
 *    dependency-free (docs/TESTING.md).
 *  - window.Capacitor.Plugins.KidsGoogleAuth: authorize() hands back a token.
 *  - fetch: platform.httpRequest falls back to fetch off-device; jsonResponse
 *    reproduces its exact behaviour — an unparseable body → data:null. */

function installIdbShim() {
  const stores = new Map(); // name -> { keyPath, data: Map }
  const keyOf = (keyPath, rec) =>
    JSON.stringify(Array.isArray(keyPath) ? keyPath.map((k) => rec[k]) : rec[keyPath]);
  const request = (fn) => {
    const r = {};
    queueMicrotask(() => {
      try { r.result = fn(); if (r.onsuccess) r.onsuccess(); }
      catch (e) { r.error = e; if (r.onerror) r.onerror(); }
    });
    return r;
  };
  const db = {
    close() {},
    createObjectStore(name, { keyPath } = {}) {
      const s = { keyPath, data: new Map(), createIndex() { return {}; } };
      stores.set(name, s);
      return s;
    },
    transaction(names, _mode) {
      const t = {
        abort() {},
        objectStore(n) {
          const s = stores.get(n);
          return {
            get: (key) => request(() => s.data.get(JSON.stringify(key))),
            put: (rec) => request(() => { s.data.set(keyOf(s.keyPath, rec), rec); })
          };
        }
      };
      setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 0);
      return t;
    }
  };
  globalThis.indexedDB = {
    open() {
      const req = { result: db };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
      });
      return req;
    }
  };
}
installIdbShim();
globalThis.window = {
  Capacitor: { Plugins: { KidsGoogleAuth: { authorize: async () => ({ granted: true, accessToken: 'test-token' }) } } }
};

/** Response-shaped like what platform.httpRequest's fetch path consumes.
    body === undefined ⇒ r.json() rejects ⇒ httpRequest delivers data:null —
    exactly how a 200 + HTML interstitial reaches doFlush in the browser. */
const jsonResponse = (status, body) => ({
  status,
  headers: new Map(),
  text: async () => '',
  json: async () => { if (body === undefined) throw new Error('unparseable'); return body; }
});

const TAB = { status: 200, body: { sheets: [{ properties: { sheetId: 0, title: 'גיליון1' } }] } };
let netScript = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  const pick =
    u.includes(':batchUpdate') ? netScript.batchUpdate :
    u.includes(':append') ? netScript.append :
    u.includes('/values/') ? netScript.read : netScript.tab;
  if (!pick) throw new Error('unexpected request: ' + u);
  return jsonResponse(pick.status, pick.body);
};

async function seedSheet(profileId, lib, queue) {
  const { putSources, putMeta } = await import('../www/js/db.js');
  await putSources({ profileId, sheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`, libraryId: lib });
  await putMeta('sheetq:' + lib, queue);
}

test('flushSheetQueue: a 200+null append leaves the op in the queue and does NOT report written', async () => {
  // The exact field shape: mid-flush the grant dies, Google answers the append with
  // a sign-in page, fetch json() yields null. The old status-only check called this
  // a success, cleared the op, and the mirror later tombstoned the rowless video.
  const { getMeta } = await import('../www/js/db.js');
  const op = { op: 'append', key: 'yt:aaaaaaaaaa1', row: ['https://youtu.be/aaaaaaaaaa1', 'שיר', ''], at: 100 };
  await seedSheet('p-nullbody', 'lib:wnull', [op]);
  netScript = { tab: TAB, read: { status: 200, body: { values: [['# הערה']] } }, append: { status: 200, body: undefined } };
  const res = await flushSheetQueue('p-nullbody');
  assert.equal(res.ok, false, 'an unproven write must not report success');
  assert.equal(res.written, undefined, 'must not report written');
  assert.equal(res.error, 'sheet-not-json');
  const left = await getMeta('sheetq:lib:wnull');
  assert.equal(left.length, 1, 'the op must survive to retry');
  assert.equal(left[0].key, 'yt:aaaaaaaaaa1');
  const st = await sheetWriteState('lib:wnull');
  assert.equal(st.pending, 1, 'the sources tab must keep saying a row is waiting');
  assert.equal(st.error, 'sheet-not-json');
});

test('flushSheetQueue: a 200+error-envelope batchUpdate aborts with the delete still queued', async () => {
  // The delete half: dropping an un-landed delvideo is how deleted videos resurrect
  // (its row stays in the sheet; the next mirror pass reads presence as a re-add).
  const { getMeta } = await import('../www/js/db.js');
  const op = { op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 100 };
  await seedSheet('p-envelope', 'lib:wenv', [op]);
  netScript = {
    tab: TAB,
    read: { status: 200, body: { values: [['# הערה'], ['https://youtu.be/aaaaaaaaaa1']] } },
    batchUpdate: { status: 200, body: { error: { code: 403, status: 'PERMISSION_DENIED' } } }
  };
  const res = await flushSheetQueue('p-envelope');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sheet-api-403');
  const left = await getMeta('sheetq:lib:wenv');
  assert.equal(left.length, 1, 'the delete op must survive to retry');
  const st = await sheetWriteState('lib:wenv');
  assert.equal(st.error, 'no-edit-permission', 'a 403 envelope routes like a 403 status: permanent');
});

test('flushSheetQueue: REAL Google success shapes still flush and clear the queue', async () => {
  // The gate must not be so strict that a genuine write stops counting — that would
  // re-append the same rows forever.
  const { getMeta } = await import('../www/js/db.js');
  await seedSheet('p-success', 'lib:wok', [
    { op: 'delvideo', key: 'yt:aaaaaaaaaa1', at: 100 },
    { op: 'append', key: 'yt:bbbbbbbbbb2', row: ['https://youtu.be/bbbbbbbbbb2', 'שני', ''], at: 200 }
  ]);
  netScript = {
    tab: TAB,
    read: { status: 200, body: { values: [['# הערה'], ['https://youtu.be/aaaaaaaaaa1']] } },
    batchUpdate: { status: 200, body: { spreadsheetId: ID, replies: [{}] } },
    append: { status: 200, body: { spreadsheetId: ID, updates: { updatedRange: "'גיליון1'!A3:C3", updatedRows: 1 } } }
  };
  const res = await flushSheetQueue('p-success');
  assert.equal(res.ok, true);
  assert.equal(res.written, 2);
  assert.equal(res.deletedRows, 1);
  assert.deepEqual(await getMeta('sheetq:lib:wok'), [], 'a proven flush clears its ops');
  const st = await sheetWriteState('lib:wok');
  assert.equal(st.error, null);
  assert.equal(st.pending, 0);
});
