// v1.0.56 — PUBLIC Drive metadata: the two TOTAL parsers, plus the media-kind helpers
// and the cache-extension rule that audio support hangs on.
//
// Why the parsers are pinned as TOTAL (the v1.0.33 ytsearch lesson): Google answers this
// endpoint with an error ENVELOPE on a 200 through a proxy, and with an HTML sign-in page
// when a file is not shared. Either one becoming a "name" would put Google's markup on a
// child's tile, forever — persistTitle-style fields are only written once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretDriveFileMeta, extractDriveFileMetaFromHtml, driveFileMetaUrl
} from '../www/js/gdrivepub.js';
import { cacheExtFor } from '../www/js/media.js';
import { mediaKindFromMime, mediaKindFromName, titleFromFileName, titleFromFileUrl, classifyLink }
  from '../www/js/classify.js';

test('interpretDriveFileMeta accepts exactly one shape', () => {
  assert.deepEqual(
    interpretDriveFileMeta({ name: 'שיר ערש.mp3', mimeType: 'audio/mpeg', size: '4096' }),
    { name: 'שיר ערש.mp3', mimeType: 'audio/mpeg', size: 4096 }
  );
  // a name with no mime/size is still usable — the kind falls back to the filename
  assert.deepEqual(interpretDriveFileMeta({ name: 'a.mp4' }), { name: 'a.mp4', mimeType: null, size: null });
});

test('interpretDriveFileMeta is TOTAL — every failure shape answers null, never a throw', () => {
  for (const bad of [
    null, undefined, '', 0, 'a string', ['name'],
    { error: { code: 403, message: 'quota' } },
    { error: { code: 404 }, name: 'leaked.mp3' },   // an envelope is never proof, even beside a name
    { name: '' }, { name: '   ' }, { name: 42 }, {}
  ]) {
    assert.equal(interpretDriveFileMeta(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('extractDriveFileMetaFromHtml reads ANCHORED shapes only', () => {
  const og = '<html><head><meta property="og:title" content="שיר ערש.mp3">' +
    '<title>שיר ערש.mp3 - Google Drive</title>{"mimeType":"audio/mpeg"}</head></html>';
  assert.deepEqual(extractDriveFileMetaFromHtml(og), { name: 'שיר ערש.mp3', mimeType: 'audio/mpeg', size: null });

  // no og/twitter meta → the <title>, minus the Google Drive suffix
  const t = '<html><head><title>Baby Shark.mp4 - Google Drive</title></head></html>';
  assert.deepEqual(extractDriveFileMetaFromHtml(t), { name: 'Baby Shark.mp4', mimeType: null, size: null });

  // entities in the name survive readably
  assert.equal(
    extractDriveFileMetaFromHtml('<meta property="og:title" content="Tom &amp; Jerry.mp4">').name,
    'Tom & Jerry.mp4'
  );
});

test('extractDriveFileMetaFromHtml is TOTAL, and never invents a name', () => {
  for (const bad of [null, undefined, '', 0, {}, [], '<html><body>no title here</body></html>']) {
    assert.equal(extractDriveFileMetaFromHtml(bad), null);
  }
  // a sign-in interstitial has a <title>, but not the file's — it must not become a caption
  const signin = '<html><head><title>Google Drive - Sign in</title></head></html>';
  const got = extractDriveFileMetaFromHtml(signin);
  assert.equal(got.name, 'Google Drive - Sign in');
  // …which is why the CALLER only reaches the scrape after the API, and why a name that
  // arrives here is still just a display string — it can never route or authorize anything.
});

test('the metadata URL is built with an encoded key and the id in the path', () => {
  const u = driveFileMetaUrl('1AbC_dEf-123', 'k e/y');
  assert.match(u, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/1AbC_dEf-123\?/);
  assert.match(u, /fields=name,mimeType,size/);
  assert.match(u, /key=k%20e%2Fy/, 'the key must be URL-encoded');
});

test('media kind: mime wins, filename is the fallback, unknown is null', () => {
  assert.equal(mediaKindFromMime('audio/mpeg'), 'audio');
  assert.equal(mediaKindFromMime('video/mp4'), 'video');
  assert.equal(mediaKindFromMime('application/pdf'), null);
  assert.equal(mediaKindFromMime(null), null);
  assert.equal(mediaKindFromName('שיר.mp3'), 'audio');
  assert.equal(mediaKindFromName('a.MP4?x=1'), 'video');
  // .ogg is treated as AUDIO (it is an audio container in practice); .ogv stays video
  assert.equal(mediaKindFromName('a.ogg'), 'audio');
  assert.equal(mediaKindFromName('a.ogv'), 'video');
  assert.equal(mediaKindFromName('notes.txt'), null);
});

test('classifyLink accepts https AUDIO files and tags the kind — key format unchanged', () => {
  const mp3 = classifyLink('https://cdn.example.com/songs/lullaby.mp3');
  assert.equal(mp3.type, 'file');
  assert.equal(mp3.media, 'audio');
  assert.equal(mp3.key, 'file:https://cdn.example.com/songs/lullaby.mp3');

  const mp4 = classifyLink('https://cdn.example.com/movies/a.mp4');
  assert.equal(mp4.media, 'video');
  assert.equal(mp4.key, 'file:https://cdn.example.com/movies/a.mp4', 'the key format must not drift');

  // the safety boundary is unchanged: http is still refused for audio too
  assert.equal(classifyLink('http://cdn.example.com/songs/lullaby.mp3'), null);
  assert.equal(classifyLink('https://cdn.example.com/readme.txt'), null);

  // a Drive link has no filename, so the kind is unknown HERE and filled in by the fetch
  const drv = classifyLink('https://drive.google.com/file/d/1AbC_dEf/view');
  assert.equal(drv.media, null);
  assert.equal(drv.key, 'file:drive:1AbC_dEf');
});

test('titleFromFileUrl answers EMPTY for a Drive link instead of the path segment', () => {
  // the bug this pins: "/file/d/<id>/view" used to caption the child's tile "view"
  assert.equal(titleFromFileUrl('https://drive.google.com/file/d/1AbC_dEf/view'), '');
  assert.equal(titleFromFileUrl('https://drive.google.com/uc?export=download&id=1AbC_dEf'), '');
  // a real direct link is unaffected
  assert.equal(titleFromFileUrl('https://cdn.example.com/songs/butterfly_song.mp3'), 'butterfly song');
});

test('titleFromFileName handles an API name (already decoded) and an encoded segment', () => {
  assert.equal(titleFromFileName('שיר ערש.mp3'), 'שיר ערש');
  assert.equal(titleFromFileName('%D7%A9%D7%99%D7%A8.mp3'), 'שיר');
  assert.equal(titleFromFileName('baby_shark-final.mp4'), 'baby shark final');
  assert.equal(titleFromFileName(''), '');
  assert.equal(titleFromFileName(null), '');
});

test('the cache extension follows the real file, not a hardcoded .mp4', () => {
  // Android guesses a file:// src MIME from its extension, so an mp3 cached as .mp4 is a
  // decode gamble — that hardcode is what this replaces.
  assert.equal(cacheExtFor({ url: 'https://x/a.mp3' }), 'mp3');
  assert.equal(cacheExtFor({ url: 'https://x/a.MP4?t=1' }), 'mp4');
  assert.equal(cacheExtFor({ url: 'https://x/a.webm#f' }), 'webm');
  // a Drive URL carries no extension: the record's media kind decides
  const drive = 'https://drive.google.com/uc?export=download&id=1AbC';
  assert.equal(cacheExtFor({ url: drive, media: 'audio' }), 'mp3');
  assert.equal(cacheExtFor({ url: drive, media: 'video' }), 'mp4');
  assert.equal(cacheExtFor({ url: drive }), 'mp4', 'unknown stays the legacy default');
  assert.equal(cacheExtFor({}), 'mp4');
});
