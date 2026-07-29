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
