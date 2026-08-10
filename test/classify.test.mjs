// Classifier tests: channel refs, source-row disambiguation, time-hint stripping,
// share-intent extraction. classifyLink's safety boundary is regression-covered in
// logic.test.mjs; here we only assert the NEW entry points keep funneling through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinksFile } from '../www/js/linksfile.js';
import {
  parseChannelRef, classifySourceRow, stripTimeHints, classifyFromSharedText, classifyLink,
  classifyShared, titleFromFileUrl
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
  assert.equal(parseChannelRef('https://www.youtube.com/@ab'), null, 'handles are 3+ chars');
  assert.equal(parseChannelRef('https://www.youtube.com/@' + 'a'.repeat(31)), null, 'and at most 30');
});

/* ---- v1.0.20 FIELD BUG: a Hebrew channel handle was rejected as "unsupported" ---- */

test('parseChannelRef accepts a NON-ASCII handle, percent-encoded or not', () => {
  // What the YouTube app actually puts on the clipboard for @חלומותחסידיים. The old
  // ASCII-only character class matched neither form, so classifySourceRow returned
  // kind:'invalid' and the parent was told the link is not supported (reported live).
  const encoded = 'https://m.youtube.com/@%D7%97%D7%9C%D7%95%D7%9E%D7%95%D7%AA%D7%97%D7%A1%D7%99%D7%93%D7%99%D7%99%D7%9D';
  const pretty = 'https://m.youtube.com/@חלומותחסידיים';
  for (const url of [encoded, pretty, decodeURIComponent(encoded)]) {
    assert.deepEqual(parseChannelRef(url), { by: 'handle', value: 'חלומותחסידיים' }, url);
  }
  // the DECODED value is what gets stored/resolved — never the %D7%97… soup, which
  // would be double-encoded into the resolution URL and cached under a junk key
  assert.deepEqual(parseChannelRef('@חלומותחסידיים'), { by: 'handle', value: 'חלומותחסידיים' });
  // and the row-level entry points must agree, or the add still gets rejected
  assert.deepEqual(classifySourceRow(encoded), { kind: 'channel', channelRef: { by: 'handle', value: 'חלומותחסידיים' } });
  const shared = classifyShared('תראו איזה ערוץ ' + encoded);
  assert.equal(shared.kind, 'channel');
  assert.deepEqual(shared.channelRef, { by: 'handle', value: 'חלומותחסידיים' });
});

test('a video link still WINS over the channel it lives on, encoded or not', () => {
  // The safety boundary must not shift with the handle fix: a watch URL is a video.
  const r = classifySourceRow('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(r.kind, 'video');
  assert.equal(classifyShared('https://youtu.be/dQw4w9WgXcQ https://m.youtube.com/@חלומותחסידיים').kind, 'video');
  // a non-YouTube host with an @path stays rejected even with Unicode
  assert.equal(parseChannelRef('https://example.com/@חלומותחסידיים'), null);
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

test('a removal row is collected AND wins over a video row of the same key', () => {
  // v1.0.38: this used to run through sync2.parseSourceSheet (the CSV front door, deleted
  // with the sheet reader). Same grammar, same rule, now against the LIVE links-file path.
  const file = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ,שיר',
    'https://www.youtube.com/watch?v=sFU5TdYp8u8,אחר',
    '# הוסר: https://youtu.be/dQw4w9WgXcQ — נמחק'
  ].join('\n');
  const p = parseLinksFile(file);
  assert.deepEqual(p.removedKeys, ['yt:dQw4w9WgXcQ']);
  // the removal wins: safety-first, so bringing it back means deleting the removal line
  assert.deepEqual(p.videos.map((v) => v.key), ['yt:sFU5TdYp8u8']);
});

test('every shape of playlist link a parent can paste is recognised', async () => {
  const { classifySourceRow } = await import('../www/js/classify.js');
  const ID = 'PLEs_hxq8IYwlNwIf_RUNUnHp38YGR1W7P'; // the exact link from the field report
  const shapes = [
    'https://m.youtube.com/playlist?list=' + ID,        // the MOBILE domain — what a phone shares
    'https://www.youtube.com/playlist?list=' + ID,
    'https://youtube.com/playlist?list=' + ID,
    'http://www.youtube.com/playlist?list=' + ID,
    '  https://m.youtube.com/playlist?list=' + ID + '  ',
    'https://m.youtube.com/playlist?list=' + ID + '&si=abc123'
  ];
  for (const raw of shapes) {
    const row = classifySourceRow(raw);
    assert.equal(row.kind, 'playlist', 'not recognised as a playlist: ' + raw);
    assert.equal(row.playlistId, ID, 'wrong playlist id for: ' + raw);
  }
});

test('a WATCH link that merely carries &list= is still a VIDEO, not a playlist', () => {
  // The trap on the other side: YouTube appends &list= to a video opened from a playlist.
  // Treating that as "subscribe to the playlist" would import hundreds of videos when the
  // parent asked for one.
  const row = classifySourceRow('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123');
  assert.equal(row.kind, 'video');
  assert.equal(row.id, 'dQw4w9WgXcQ');
});

test('a playlist SHARED from YouTube is recognised, like a pasted one (v1.0.26)', async () => {
  // classifySourceRow understood playlists since v1.0.12 but classifyShared never did, so
  // sharing a playlist answered "unsupported" while pasting the identical link worked.
  const { classifyShared } = await import('../www/js/classify.js');
  const ID = 'PLEs_hxq8IYwlNwIf_RUNUnHp38YGR1W7P';
  for (const u of [
    'https://m.youtube.com/playlist?list=' + ID,
    'https://youtube.com/playlist?list=' + ID + '&si=abc123',
    'רשימת שירים\n\nhttps://www.youtube.com/playlist?list=' + ID
  ]) {
    const r = classifyShared(u, '');
    assert.equal(r && r.kind, 'playlist', 'not recognised: ' + u);
    assert.equal(r.playlistId, ID);
  }
});

test('a shared WATCH link carrying &list= stays a VIDEO', () => {
  // The trap on the other side: YouTube appends &list= when a video is opened from a
  // playlist. Treating that as "subscribe to the playlist" would import hundreds of videos
  // when the parent shared one.
  const r = classifyShared('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc1234567', '');
  assert.equal(r.kind, 'video');
  assert.equal(r.id, 'dQw4w9WgXcQ');
});

test('the YouTube app share shapes all classify (v1.0.26 regression net)', () => {
  // Exactly what the Android YouTube app puts on the clipboard, including the ?si=
  // tracking parameter it started appending.
  const cases = [
    ['https://youtu.be/dQw4w9WgXcQ?si=Ab3xYz9', 'video'],
    ['שיר ילדים\n\nhttps://youtu.be/dQw4w9WgXcQ?si=Ab3xYz9', 'video'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&si=Ab3', 'video'],
    ['https://www.youtube.com/@rotemama4kids?si=Ab3xYz9', 'channel'],
    ['https://m.youtube.com/channel/UCWF5vshm5UfF59-rtvsE5WA?si=x', 'channel']
  ];
  for (const [text, kind] of cases) {
    const r = classifyShared(text, '');
    assert.equal(r && r.kind, kind, 'wrong kind for: ' + text);
  }
});

/* ---------------- titleFromFileUrl (v1.0.32) ---------------- */

test('titleFromFileUrl: the filename becomes the display name — Hebrew included', () => {
  // the manual name field is gone from the add form; a direct file's name is derived
  assert.equal(titleFromFileUrl('https://x.example/media/butterfly_song.mp4'), 'butterfly song');
  assert.equal(titleFromFileUrl('https://x.example/a/%D7%A4%D7%A8%D7%A4%D7%A8%D7%99%D7%9D.mp4'),
    'פרפרים', 'percent-encoded Hebrew filenames are the normal case');
  assert.equal(titleFromFileUrl('https://x.example/dl/my-video.webm?token=abc#t'), 'my video',
    'query/fragment are not part of the name');
  assert.equal(titleFromFileUrl('https://x.example/clip'), 'clip', 'no extension is fine');
  assert.equal(titleFromFileUrl('relative/שיר+ילדים.mp4'), 'שיר ילדים', 'plus opens into a space');
});

test('titleFromFileUrl answers "" for anything unusable — no caption beats garbage', () => {
  assert.equal(titleFromFileUrl('https://x.example/'), '');
  assert.equal(titleFromFileUrl(''), '');
  assert.equal(titleFromFileUrl(null), '');
  assert.equal(titleFromFileUrl(undefined), '');
  assert.equal(titleFromFileUrl(42), '');
  // a malformed %-escape must not throw (decodeURIComponent does) — keep the raw name
  assert.equal(titleFromFileUrl('https://x.example/bad%2.mp4'), 'bad%2');
  // absurdly long names are capped like shared-text titles
  assert.equal(titleFromFileUrl('https://x.example/' + 'א'.repeat(300) + '.mp4').length, 120);
});
