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

/* ---------------- Drive FOLDERS (v1.0.56) ---------------- */

test('a Drive folder link is a SOURCE, and never a playable file', async () => {
  const { driveFolderId, classifySourceRow, classifyLink } = await import('../www/js/classify.js');
  assert.equal(driveFolderId('https://drive.google.com/drive/folders/1FYLaoscxWBV_BU5sFouf7XCrv7cKktBY'),
    '1FYLaoscxWBV_BU5sFouf7XCrv7cKktBY');
  // the /u/0/ form a signed-in parent copies
  assert.equal(driveFolderId('https://drive.google.com/drive/u/0/folders/ABC_123-xyz'), 'ABC_123-xyz');
  assert.equal(driveFolderId('https://drive.google.com/file/d/ABC/view'), null, 'a FILE is not a folder');
  assert.equal(driveFolderId('https://example.com/drive/folders/x'), null);

  // file and folder ids look identical — only the URL shape separates them, so the
  // playable classifier must refuse a folder outright
  assert.equal(classifyLink('https://drive.google.com/drive/folders/ABC_123-xyz'), null);
  assert.equal(classifySourceRow('https://drive.google.com/drive/folders/ABC_123-xyz').kind, 'drivefolder');
});

test('the keyless folder parser reads REAL embedded-view markup, per entry block', async () => {
  const { parseDriveFolderHtml } = await import('../www/js/gdrivepub.js');
  // shaped exactly like the live page (measured 2026-08-29)
  const entry = (id, name, mime) =>
    `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info">` +
    `<a href="https://drive.google.com/file/d/${id}/view?usp=drive_web">` +
    `<div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${mime}" alt=""/></div>` +
    `<div class="flip-entry-title">${name}</div></a></div></div>`;
  const html = '<!DOCTYPE html><html><head><title>שירי ערש</title></head><body>' +
    entry('1aaaaaaaaaaaaaaaaaaaa', 'פרק 10.mp3', 'audio/mpeg') +
    entry('1bbbbbbbbbbbbbbbbbbbb', 'Tom &amp; Jerry.mp4', 'video/mp4') +
    entry('1cccccccccccccccccccc', 'notes.pdf', 'application/pdf') +
    '</body></html>';
  const got = parseDriveFolderHtml(html);
  assert.equal(got.name, 'שירי ערש', 'the page <title> IS the folder name — the tile has no other source');
  assert.equal(got.files.length, 3, 'non-media is filtered LATER (planDriveFolderImport), not here');
  assert.deepEqual(got.files[0], { id: '1aaaaaaaaaaaaaaaaaaaa', name: 'פרק 10.mp3', mimeType: 'audio/mpeg', size: null });
  assert.equal(got.files[1].name, 'Tom & Jerry.mp4', 'entities are decoded');
  assert.equal(got.files[2].mimeType, 'application/pdf');

  // AN ENTRY MISSING ITS TITLE MUST NOT SHIFT EVERY LATER NAME ONTO THE WRONG FILE —
  // that is why this parses per block instead of zipping three global matches.
  const broken = '<html><head><title>f</title></head>' +
    '<div class="flip-entry" id="entry-1dddddddddddddddddddd"></div>' + entry('1eeeeeeeeeeeeeeeeeeee', 'real.mp3', 'audio/mpeg');
  const got2 = parseDriveFolderHtml(broken);
  assert.equal(got2.files.length, 1);
  assert.equal(got2.files[0].id, '1eeeeeeeeeeeeeeeeeeee', 'the surviving name landed on the wrong file');
});

test('both folder listers are TOTAL — unreadable is never "empty"', async () => {
  const { parseDriveFolderHtml, interpretDriveFolderList } = await import('../www/js/gdrivepub.js');
  for (const bad of [null, undefined, '', 0, {}, []]) {
    assert.equal(parseDriveFolderHtml(bad), null, 'the HTML parser invented a listing');
  }
  // a sign-in page has no entries and no marker: null, NOT an empty folder
  assert.equal(parseDriveFolderHtml('<html><body>Sign in to continue</body></html>'), null);
  // …but a genuinely EMPTY folder page IS empty, not unreadable. The two are told apart by
  // the container the real page always carries (`flip-entries`/`flip-contents`, measured) —
  // note "flip-entries" does NOT contain "flip-entry", which is what made the first version
  // of this parser answer null for an empty folder.
  const empty = parseDriveFolderHtml(
    '<html><head><title>ריק</title></head><body class="flip-embedded">' +
    '<div id="flip-contents" class="flip-contents flip-list-view"><div class="flip-entries"></div></div></body></html>');
  assert.deepEqual(empty.files, []);
  assert.equal(empty.name, 'ריק', 'an empty folder still names itself');

  for (const bad of [null, undefined, 'x', [], { error: { code: 403 } }, { files: 'nope' }]) {
    assert.equal(interpretDriveFolderList(bad), null, 'the API parser invented a listing');
  }
  const ok = interpretDriveFolderList({ files: [{ id: '1aaaaaaaaaaaaaaaaaaaa', name: 'a.mp3', mimeType: 'audio/mpeg', size: '12' }], nextPageToken: 't' });
  assert.deepEqual(ok.files[0], { id: '1aaaaaaaaaaaaaaaaaaaa', name: 'a.mp3', mimeType: 'audio/mpeg', size: 12 });
  assert.equal(ok.nextPageToken, 't');
});

test('a numbered album imports in HUMAN order, and only media', async () => {
  const { planDriveFolderImport, naturalCompare } = await import('../www/js/plan.js');
  assert.deepEqual(['פרק 10', 'פרק 2', 'פרק 1'].sort(naturalCompare), ['פרק 1', 'פרק 2', 'פרק 10']);
  assert.equal(naturalCompare(null, undefined), 0);

  const f = (id, name) => ({ id, name });
  const kind = (x) => (/\.mp3$/.test(x.name) ? 'audio' : /\.mp4$/.test(x.name) ? 'video' : null);
  const plan = planDriveFolderImport({
    files: [f('1a'.padEnd(20, 'a'), 'פרק 10.mp3'), f('1b'.padEnd(20, 'b'), 'פרק 2.mp3'),
      f('1c'.padEnd(20, 'c'), 'notes.pdf'), f('1d'.padEnd(20, 'd'), 'seen.mp4')],
    existingKeys: new Set(['file:drive:' + '1d'.padEnd(20, 'd')]),
    mediaKindOf: kind
  });
  assert.deepEqual(plan.add.map((a) => a.name), ['פרק 2.mp3', 'פרק 10.mp3']);
  assert.equal(plan.add[0].media, 'audio');
  assert.deepEqual(plan.skipped, { existing: 1, denied: 0, nonMedia: 1 });

  // a file the parent deleted here before must NOT walk back in on the next refresh
  const denied = planDriveFolderImport({
    files: [f('1e'.padEnd(20, 'e'), 'gone.mp3')],
    denyKeys: new Set(['file:drive:' + '1e'.padEnd(20, 'e')]), mediaKindOf: kind
  });
  assert.deepEqual(denied.add, []);
  assert.equal(denied.skipped.denied, 1);

  // junk in, no throw out
  assert.deepEqual(planDriveFolderImport({}).add, []);
  assert.deepEqual(planDriveFolderImport({ files: [null, {}, { id: '' }] }).add, []);
});

test('the folder outcome NAMES its zero — the v1.0.37 rule', async () => {
  const { driveFolderOutcome } = await import('../www/js/plan.js');
  assert.match(driveFolderOutcome({ ok: false }), /משותפת/, 'an unreadable folder must point at SHARING');
  assert.match(driveFolderOutcome({ added: 3 }), /3 קבצים/);
  assert.match(driveFolderOutcome({ added: 1 }), /קובץ אחד/);
  assert.match(driveFolderOutcome({ added: 2, first: false }), /חדשים/);
  // the four zeroes are four DIFFERENT facts and must not share a sentence
  const zeros = [
    driveFolderOutcome({ added: 0, skipped: { nonMedia: 2 } }),
    driveFolderOutcome({ added: 0, skipped: { denied: 1 } }),
    driveFolderOutcome({ added: 0, skipped: { existing: 5 } }),
    driveFolderOutcome({ added: 0, skipped: {} })
  ];
  assert.equal(new Set(zeros).size, 4, 'two different zeroes produced the same message');
  for (const z of zeros) assert.doesNotMatch(z, /undefined|NaN/);
});
