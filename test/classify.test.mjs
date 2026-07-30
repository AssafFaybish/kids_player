// Classifier tests: channel refs, source-row disambiguation, time-hint stripping,
// share-intent extraction. classifyLink's safety boundary is regression-covered in
// logic.test.mjs; here we only assert the NEW entry points keep funneling through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelRef, classifySourceRow, stripTimeHints, classifyFromSharedText, classifyLink
} from '../www/js/classify.js';

test('parseChannelRef handles all channel URL shapes', () => {
  assert.deepEqual(parseChannelRef('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'),
    { by: 'id', value: 'UCabcdefghijklmnopqrstuv' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@HebrewKids'), { by: 'handle', value: 'HebrewKids' });
  assert.deepEqual(parseChannelRef('https://youtube.com/@HebrewKids/videos'), { by: 'handle', value: 'HebrewKids' });
  assert.deepEqual(parseChannelRef('https://m.youtube.com/@HebrewKids?si=x'), { by: 'handle', value: 'HebrewKids' });
  assert.deepEqual(parseChannelRef('@HebrewKids'), { by: 'handle', value: 'HebrewKids' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/c/SomeName'), { by: 'custom', value: 'SomeName' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/user/OldUser'), { by: 'user', value: 'OldUser' });
});

test('parseChannelRef rejects invalid UC ids and non-channels', () => {
  assert.equal(parseChannelRef('https://www.youtube.com/channel/UCshort'), null);
  assert.equal(parseChannelRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseChannelRef('https://example.com/@notyt'), null);
  assert.equal(parseChannelRef(''), null);
});

test('classifySourceRow: watch link with &list= is a VIDEO (the watch link wins)', () => {
  const r = classifySourceRow('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefgh1234567890');
  assert.equal(r.kind, 'video');
  assert.equal(r.key, 'yt:dQw4w9WgXcQ');
});

test('classifySourceRow: bare playlist link is a playlist', () => {
  const r = classifySourceRow('https://www.youtube.com/playlist?list=PLabcdefgh1234567890');
  assert.equal(r.kind, 'playlist');
  assert.equal(r.playlistId, 'PLabcdefgh1234567890');
});

test('classifySourceRow: channel / comment / blank / invalid', () => {
  assert.equal(classifySourceRow('https://www.youtube.com/@HebrewKids').kind, 'channel');
  assert.equal(classifySourceRow('# הערה').kind, 'comment');
  assert.equal(classifySourceRow('').kind, 'blank');
  assert.equal(classifySourceRow('https://drive.google.com/drive/folders/XYZ').kind, 'invalid');
});

test('stripTimeHints removes t/start fragments and params (F3)', () => {
  assert.equal(stripTimeHints('https://cdn.example.com/a.mp4#t=30'), 'https://cdn.example.com/a.mp4');
  assert.equal(stripTimeHints('https://cdn.example.com/a.mp4?t=10'), 'https://cdn.example.com/a.mp4');
  assert.equal(stripTimeHints('https://cdn.example.com/a.mp4?t=10&x=1'), 'https://cdn.example.com/a.mp4?x=1');
  assert.equal(stripTimeHints('https://cdn.example.com/a.mp4?x=1&start=90'), 'https://cdn.example.com/a.mp4?x=1');
  assert.equal(stripTimeHints('https://cdn.example.com/a.mp4'), 'https://cdn.example.com/a.mp4');
});

test('classifyFromSharedText extracts the URL from share-sheet free text (F12b)', () => {
  const a = classifyFromSharedText('Baby Shark https://youtu.be/dQw4w9WgXcQ?si=xyz');
  assert.equal(a.key, 'yt:dQw4w9WgXcQ');
  assert.equal(a.title, 'Baby Shark');

  const b = classifyFromSharedText('כותרת בעברית\n\nhttps://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.equal(b.key, 'yt:dQw4w9WgXcQ');
  assert.equal(b.title, 'כותרת בעברית');

  const c = classifyFromSharedText('Cool https://cdn.example.com/a.mp4');
  assert.equal(c.type, 'file'); // plain classifyLink would reject "Cool https://…" — extraction fixes it

  const d = classifyFromSharedText('צפו: (https://youtu.be/dQw4w9WgXcQ).', 'שיר');
  assert.equal(d.key, 'yt:dQw4w9WgXcQ'); // trailing punctuation stripped
  assert.equal(d.title, 'שיר');          // EXTRA_SUBJECT wins

  assert.equal(classifyFromSharedText('סתם טקסט בלי לינק'), null);
  assert.equal(classifyFromSharedText('http://cdn.example.com/a.mp4'), null); // https-only boundary holds
});

test('classifyLink still rejects the dangerous stuff (boundary regression)', () => {
  assert.equal(classifyLink('javascript:alert(1)'), null);
  assert.equal(classifyLink('file:///etc/passwd'), null);
  assert.equal(classifyLink('http://cdn.example.com/a.mp4'), null);
});

/* ---------------- classifyShared (v1.0.7): videos AND channels from share text ---------------- */

test('classifyShared: a video link wins, channel recognized only without one', async () => {
  const { classifyShared } = await import('../www/js/classify.js');
  const vid = classifyShared('תראו! https://youtu.be/dQw4w9WgXcQ?si=abc', 'שיר מגניב');
  assert.equal(vid.kind, 'video');
  assert.equal(vid.id, 'dQw4w9WgXcQ');
  assert.equal(vid.title, 'שיר מגניב');

  const ch = classifyShared('הערוץ המומלץ https://www.youtube.com/@SomeKidsChannel?si=xyz', '');
  assert.equal(ch.kind, 'channel');
  assert.deepEqual(ch.channelRef, { by: 'handle', value: 'SomeKidsChannel' });
  assert.equal(ch.title, 'הערוץ המומלץ');

  const chId = classifyShared('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv', '');
  assert.equal(chId.kind, 'channel');
  assert.deepEqual(chId.channelRef, { by: 'id', value: 'UCabcdefghijklmnopqrstuv' });

  // watch-link + channel link in the same text → the VIDEO wins (same rule as sheet rows)
  const both = classifyShared('https://www.youtube.com/@x123 וגם https://youtu.be/dQw4w9WgXcQ', '');
  assert.equal(both.kind, 'video');
});

test('classifyShared: the safety boundary holds — junk is rejected', async () => {
  const { classifyShared } = await import('../www/js/classify.js');
  assert.equal(classifyShared('סתם טקסט בלי לינק', ''), null);
  assert.equal(classifyShared('https://example.com/not-youtube', ''), null);
  assert.equal(classifyShared('', ''), null);
  assert.equal(classifyShared(null, null), null);
});

/* ---------------- v1.0.12: removal rows ('# הוסר: <link>') ---------------- */

test('a removal row yields a KEY TO DENY and never playable content', async () => {
  const { classifySourceRow, parseRemovalRow } = await import('../www/js/classify.js');
  for (const raw of [
    '# הוסר: https://youtu.be/dQw4w9WgXcQ — שיר',
    '#הוסר https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    '# removed: https://youtu.be/dQw4w9WgXcQ',
    '# deleted - https://youtu.be/dQw4w9WgXcQ'
  ]) {
    const row = classifySourceRow(raw);
    assert.equal(row.kind, 'removed', raw);
    assert.equal(row.key, 'yt:dQw4w9WgXcQ', raw);
    assert.equal(row.type, undefined, 'a removal row must not look like a video');
    assert.equal(row.srcUrl, undefined);
  }
  assert.equal(parseRemovalRow('# הוסר: https://youtu.be/dQw4w9WgXcQ').key, 'yt:dQw4w9WgXcQ');
});

test('ordinary comments stay comments; a bare link stays a video', async () => {
  const { classifySourceRow, parseRemovalRow } = await import('../www/js/classify.js');
  assert.equal(classifySourceRow('# רשימת הסרטונים של דני').kind, 'comment');
  assert.equal(classifySourceRow('# הוסר: בלי לינק בכלל').kind, 'comment'); // no key → not a removal
  assert.equal(parseRemovalRow('# just a note'), null);
  assert.equal(parseRemovalRow('https://youtu.be/dQw4w9WgXcQ'), null); // not a comment row
  assert.equal(classifySourceRow('https://youtu.be/dQw4w9WgXcQ').kind, 'video');
});

test('parseSourceSheet: removal rows are collected AND win over a video row of the same key', async () => {
  const { parseSourceSheet } = await import('../www/js/sync2.js');
  const sheet = [
    'https://youtu.be/aaaaaaaaaaa,שיר א',
    'https://youtu.be/bbbbbbbbbbb,שיר ב',
    '# הוסר: https://youtu.be/bbbbbbbbbbb — שיר ב',
    'https://www.youtube.com/@somechannel,ערוץ,manual'
  ].join('\n');
  const p = parseSourceSheet(sheet);
  assert.deepEqual(p.removedKeys, ['yt:bbbbbbbbbbb']);
  assert.deepEqual(p.videoRows.map((r) => r.key), ['yt:aaaaaaaaaaa']); // b filtered out
  assert.equal(p.channelRows.length, 1);
});
