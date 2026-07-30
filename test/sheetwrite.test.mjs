// Sheet write-back (v1.0.6) — pure parts: spreadsheet-id/gid extraction and the row
// convention (A=link, B=title, C=flag). The published /d/e/ form carries an opaque
// token, NOT the spreadsheet id — extraction must refuse it, never mis-extract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetId, extractGid, buildSheetRow, remainingAfterFlush, reconcileOps, SHEETS_FOLDER_NAME,
  starterRows, matchRowsForDeletion, sheetErrorMessage } from '../www/js/sheetwrite.js';
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
