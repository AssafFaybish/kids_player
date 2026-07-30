// CSV tokenizer tests — including the live-bug regression: a quoted Hebrew title
// containing a comma must survive intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, looksLikeHtml } from '../www/js/csv.js';
import { parseList } from '../www/js/sync.js';

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
