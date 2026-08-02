// CSV tokenizer tests — including the live-bug regression: a quoted Hebrew title
// containing a comma must survive intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, looksLikeHtml } from '../www/js/csv.js';
import { parseList } from '../www/js/sync.js';
import { parseSourceRows } from '../www/js/sync2.js';

test('quoted field with a comma survives (Hebrew title regression)', () => {
  const rows = parseCsv('https://x,"פרפרים, חלק 2",');
  assert.deepEqual(rows, [['https://x', 'פרפרים, חלק 2', '']]);
});

test('parseList end-to-end keeps the quoted Hebrew title', () => {
  const rows = parseList('https://www.youtube.com/watch?v=dQw4w9WgXcQ,"פרפרים, חלק 2",');
  assert.equal(rows[0].title, 'פרפרים, חלק 2');
});

test('doubled quotes escape a quote', () => {
  assert.deepEqual(parseCsv('"say ""hi""",b'), [['say "hi"', 'b']]);
});

test('newline inside quotes is literal', () => {
  assert.deepEqual(parseCsv('"line1\nline2",b'), [['line1\nline2', 'b']]);
});

test('CRLF rows and trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('UTF-8 BOM from Google Sheets export is stripped', () => {
  assert.deepEqual(parseCsv('﻿a,b'), [['a', 'b']]);
});

test('tab-separated fallback for comma-less rows', () => {
  assert.deepEqual(parseCsv('a\tb\tc'), [['a', 'b', 'c']]);
});

test('empty and blank input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv(null), []);
  assert.deepEqual(parseCsv('\n'), [['']]);
});

/* ---- v1.0.18: a revoked share must not read as an empty sheet ---- */

test('looksLikeHtml: Google\'s permission page (HTTP 200) is not a CSV', () => {
  // The real shape: a sheet that lost "anyone with the link" 302s to a sign-in
  // page, CapacitorHttp follows it, and the app gets 200 + HTML. Parsing that as
  // an empty sheet let the presence-mirror delete the whole library.
  assert.equal(looksLikeHtml('<!DOCTYPE html><html><head><title>Sign in</title>'), true);
  assert.equal(looksLikeHtml('<html lang="en"><body>Request access</body></html>'), true);
  assert.equal(looksLikeHtml('\n  \t<!doctype HTML>\n<html>'), true); // leading whitespace + case
  assert.equal(looksLikeHtml('﻿<!DOCTYPE html>'), true);         // BOM-prefixed
  assert.equal(looksLikeHtml('<?xml version="1.0"?><Error/>'), true); // GCS-style error body
});

test('looksLikeHtml: real sheet exports are never rejected', () => {
  assert.equal(looksLikeHtml('https://youtu.be/aaaaaaaaaa1,שיר,\n'), false);
  assert.equal(looksLikeHtml('﻿link,title\nhttps://x,y'), false);
  assert.equal(looksLikeHtml('# הוסר: https://youtu.be/aaaaaaaaaa1 — שיר'), false);
  // an EMPTY sheet still parses — emptiness is a real state the valve asks about,
  // and must stay distinguishable from a failed read
  assert.equal(looksLikeHtml(''), false);
  assert.equal(looksLikeHtml(null), false);
  assert.equal(looksLikeHtml('\n\n'), false);
  // a title that merely CONTAINS markup-ish text is still a CSV
  assert.equal(looksLikeHtml('https://youtu.be/aaaaaaaaaa1,"<b>bold</b> song",'), false);
});

test('v1.0.19: parseSourceRows reads Sheets-API rows, not just CSV text', () => {
  // The authenticated reader returns array-of-arrays with ragged rows (the API
  // omits trailing empty cells entirely). The parser must survive that.
  const rows = [
    ['https://youtu.be/aaaaaaaaaa1', 'שיר ראשון', ''],
    ['https://www.youtube.com/channel/UCchan111111111111111111'], // 1 cell only
    [],                                                           // wholly empty row
    ['# הערה'],
    ['https://youtu.be/bbbbbbbbbb2', 'שיר שני']
  ];
  const out = parseSourceRows(rows);
  assert.equal(out.videoRows.length, 2);
  assert.equal(out.channelRows.length, 1);
  assert.deepEqual(out.videoRows.map((r) => r.rowIndex), [0, 1], 'ordinals count VIDEO rows only');
  assert.equal(out.videoRows[0].title, 'שיר ראשון');
  assert.equal(out.videoRows[1].thumbUrl, '', 'a missing third cell is not undefined');
});

test('v1.0.19: parseSourceRows never throws on junk', () => {
  for (const junk of [null, undefined, 'a string', 42, [null], [undefined], [[null, undefined]]]) {
    const r = parseSourceRows(junk);
    assert.ok(Array.isArray(r.videoRows) && Array.isArray(r.channelRows));
  }
});

test('a playlist row in the SHEET becomes a subscription, not junk (v1.0.26)', async () => {
  // parseSourceRows used to push playlist rows into `invalid` tagged
  // 'playlist-unsupported-yet' — so a parent who put a playlist in their sheet got
  // silence. Column B is its display name and C the auto/manual flag, exactly like a
  // channel row.
  const { parseSourceRows } = await import('../www/js/sync2.js');
  const out = parseSourceRows([
    ['https://m.youtube.com/playlist?list=PLEs_hxq8IYwlNwIf_RUNUnHp38YGR1W7P', 'שירי בוקר', 'auto'],
    ['https://www.youtube.com/playlist?list=PLsecondPlaylist9'],  // no title/flag columns
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'סרטון']
  ]);
  assert.equal(out.playlistRows.length, 2, 'playlist rows were dropped again');
  assert.equal(out.playlistRows[0].playlistId, 'PLEs_hxq8IYwlNwIf_RUNUnHp38YGR1W7P');
  assert.equal(out.playlistRows[0].title, 'שירי בוקר');
  assert.equal(out.playlistRows[0].flag, 'auto');
  // a ragged row (the Sheets API omits trailing empties) must not throw or lose the id
  assert.equal(out.playlistRows[1].playlistId, 'PLsecondPlaylist9');
  assert.equal(out.playlistRows[1].flag, '');
  // and nothing was quietly binned
  assert.equal(out.invalid.length, 0, 'a playlist row still lands in `invalid`: ' + JSON.stringify(out.invalid));
  assert.equal(out.videoRows.length, 1, 'the video row must be unaffected');
});
