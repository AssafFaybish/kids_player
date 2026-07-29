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
