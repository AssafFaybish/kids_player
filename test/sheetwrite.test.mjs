// Sheet write-back (v1.0.6) — pure parts: spreadsheet-id/gid extraction and the row
// convention (A=link, B=title, C=flag). The published /d/e/ form carries an opaque
// token, NOT the spreadsheet id — extraction must refuse it, never mis-extract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSpreadsheetId, extractGid, buildSheetRow } from '../www/js/sheetwrite.js';

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

test('isSheetsUrl: sheets links pass (incl. published), everything else fails', async () => {
  const { isSheetsUrl } = await import('../www/js/sheetwrite.js');
  assert.equal(isSheetsUrl('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0'), true);
  assert.equal(isSheetsUrl('https://docs.google.com/spreadsheets/d/e/2PACX-x/pub?output=csv'), true);
  assert.equal(isSheetsUrl('https://drive.google.com/file/d/abc/view'), false);
  assert.equal(isSheetsUrl('https://example.com'), false);
  assert.equal(isSheetsUrl(''), false);
  assert.equal(isSheetsUrl(null), false);
});

test('starterRows: one 3-column # comment row the parser will skip', async () => {
  const { starterRows } = await import('../www/js/sheetwrite.js');
  const rows = starterRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, 3);
  assert.ok(rows[0][0].startsWith('#'));
  const { classifySourceRow } = await import('../www/js/classify.js');
  assert.equal(classifySourceRow(rows[0][0]).kind, 'comment');
});

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
