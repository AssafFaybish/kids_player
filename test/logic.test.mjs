// Unit tests for the pure logic (no browser/storage needed).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeId, driveFileId, classifyLink, listForDisplay
} from '../www/js/store.js';

test('extractYouTubeId handles the common URL forms', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ&t=5s'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://example.com/not-youtube'), null);
});

test('driveFileId extracts the id from Drive link shapes', () => {
  assert.equal(driveFileId('https://drive.google.com/file/d/ABC_123-xyz/view?usp=sharing'), 'ABC_123-xyz');
  assert.equal(driveFileId('https://drive.google.com/open?id=XYZ789'), 'XYZ789');
  assert.equal(driveFileId('https://drive.google.com/uc?export=download&id=ID42'), 'ID42');
  assert.equal(driveFileId('https://example.com/x'), null);
});

test('classifyLink accepts YouTube, Drive files, and https video files', () => {
  assert.equal(classifyLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ').type, 'youtube');
  assert.equal(classifyLink('https://youtu.be/dQw4w9WgXcQ').key, 'yt:dQw4w9WgXcQ');

  const drive = classifyLink('https://drive.google.com/file/d/FILE123/view?usp=sharing');
  assert.equal(drive.type, 'file');
  assert.equal(drive.driveId, 'FILE123');
  assert.equal(drive.url, 'https://drive.google.com/uc?export=download&id=FILE123');

  const mp4 = classifyLink('https://cdn.example.com/movies/a.mp4');
  assert.equal(mp4.type, 'file');
  assert.equal(mp4.key, 'file:https://cdn.example.com/movies/a.mp4');
});

test('classifyLink rejects everything else (the safety boundary)', () => {
  assert.equal(classifyLink('http://cdn.example.com/a.mp4'), null); // not https
  assert.equal(classifyLink('https://example.com/page'), null);     // not a video / not youtube
  assert.equal(classifyLink('javascript:alert(1)'), null);
  assert.equal(classifyLink('file:///etc/passwd'), null);
  assert.equal(classifyLink(''), null);
  assert.equal(classifyLink(null), null);
});

/* v1.0.38: the resolveListUrl / parseList tests lived here. sync.js — the public-CSV
 * sheet reader, dead in production since v1.0.19 — was deleted with the sheet, and its
 * one load-bearing regression (a quoted Hebrew title with a comma) moved to
 * csv.test.mjs against the live links-file path. */

test('listForDisplay orders correctly per mode', () => {
  const items = [
    { key: 'a', addedAt: 1 },
    { key: 'b', addedAt: 3 },
    { key: 'c', addedAt: 2 }
  ];
  // manual: newest addedAt first
  assert.deepEqual(listForDisplay(items, { mode: 'manual' }).map((i) => i.key), ['b', 'c', 'a']);
  // remote: preserve file order (input order)
  assert.deepEqual(listForDisplay(items, { mode: 'remote' }).map((i) => i.key), ['a', 'b', 'c']);
  // does not mutate the input
  assert.deepEqual(items.map((i) => i.key), ['a', 'b', 'c']);
});

