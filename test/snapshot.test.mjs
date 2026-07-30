// Snapshot IMPORT sanitising — the backup file is UNTRUSTED input (a parent can hand-edit
// it, or import a snapshot exported by another family). These tests pin the four rules that
// make that safe: the classifier rebuilds every link, a foreign scopeId can never write into
// a shared library, a pending row stays parked with a home to come back to, and no filesystem
// path from the file is trusted. Junk must never throw — the import loop has no per-row catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshotVideo } from '../www/js/snapshot.js';

const PROFILE = 'p1';
const PROF_SCOPE = 'prof:p1';
const LIB_SCOPE = 'lib:abc123';
const ctx = (extra = {}) => ({
  validScopes: new Set([PROF_SCOPE, LIB_SCOPE]), profileId: PROFILE, now: 5000, ...extra
});
const YT = 'https://www.youtube.com/watch?v=abcdefghijk';

// ── the safety boundary ─────────────────────────────────────────────────────────────────

test('an unsupported srcUrl is REJECTED — the classifier is the boundary', () => {
  const bad = [
    'javascript:alert(1)',
    'http://evil.example/movie.mp4',          // plain http: never accepted, even for a video file
    'https://example.com/some/page',          // an https page that is not a video file
    'file:///data/data/com.assaf.kidsplayer/x.mp4',
    'https://youtube.com/watch?v=tooshort',   // 11-char id required
    '',
    null
  ];
  for (const srcUrl of bad) {
    assert.equal(sanitizeSnapshotVideo({ srcUrl, title: 'x' }, ctx()), null, `accepted: ${srcUrl}`);
  }
});

test('a legit YouTube row survives with type/id/key intact', () => {
  const rec = sanitizeSnapshotVideo({ srcUrl: YT, title: 'שיר', origin: 'manual' }, ctx());
  assert.equal(rec.type, 'youtube');
  assert.equal(rec.id, 'abcdefghijk');
  assert.equal(rec.key, 'yt:abcdefghijk');
  assert.equal(rec.srcUrl, YT);
  assert.equal(rec.title, 'שיר');
  assert.equal(rec.normTitle, 'שיר');
  assert.equal(rec.state, 'live');
  assert.equal(rec.thumbId, null); // blobs never travel in a snapshot
});

test('a legit Drive file row survives and gets a playable url', () => {
  const rec = sanitizeSnapshotVideo(
    { srcUrl: 'https://drive.google.com/file/d/FILEID123/view' }, ctx()
  );
  assert.equal(rec.type, 'file');
  assert.equal(rec.driveId, 'FILEID123');
  assert.equal(rec.key, 'file:drive:FILEID123');
  assert.match(rec.url, /^https:\/\/drive\.google\.com\/uc\?export=download&id=FILEID123$/);
});

test('key/type/id are REBUILT from the link, never copied from the file', () => {
  // a hand-edited snapshot claiming to be something else must not be believed
  const rec = sanitizeSnapshotVideo(
    { srcUrl: YT, key: 'file:https://evil.example/x.mp4', type: 'file', id: 'spoofed', url: 'https://evil.example/x.mp4' },
    ctx()
  );
  assert.equal(rec.key, 'yt:abcdefghijk');
  assert.equal(rec.type, 'youtube');
  assert.equal(rec.id, 'abcdefghijk');
  assert.equal(rec.url, null);
});

// ── scoping ─────────────────────────────────────────────────────────────────────────────

test('an unknown scopeId falls back to the profile scope, never a foreign library', () => {
  for (const scopeId of ['lib:someoneelse', 'prof:otherchild', '', null, 42, { }]) {
    const rec = sanitizeSnapshotVideo({ srcUrl: YT, scopeId }, ctx());
    assert.equal(rec.scopeId, PROF_SCOPE);
  }
});

test('a scopeId this profile really uses is preserved', () => {
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, scopeId: LIB_SCOPE }, ctx()).scopeId, LIB_SCOPE);
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, scopeId: PROF_SCOPE }, ctx()).scopeId, PROF_SCOPE);
});

test('validScopes accepts the Set the importer builds or a plain array', () => {
  const asArray = { validScopes: [PROF_SCOPE, LIB_SCOPE], profileId: PROFILE, now: 5000 };
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, scopeId: LIB_SCOPE }, asArray).scopeId, LIB_SCOPE);
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, scopeId: 'lib:nope' }, asArray).scopeId, PROF_SCOPE);
  // no scope information at all still yields a record in the profile's own scope
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, scopeId: LIB_SCOPE }, { profileId: PROFILE }).scopeId, PROF_SCOPE);
});

// ── pending parking ─────────────────────────────────────────────────────────────────────

test('a PENDING row round-trips parked in ~pending and KEEPS its real home folder', () => {
  // exactly what exportProfileSnapshot writes for a parked share: folderId '~pending'
  // plus the folder approval must return it to
  const rec = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: 'sheet' }, ctx()
  );
  assert.equal(rec.state, 'pending');
  assert.equal(rec.folderId, '~pending');       // the kid-facing folder index must never see it
  // 'sheet' is also what marks the record sheet-backed after approval — losing it would
  // both misfile the video and stop its removal row from ever being written
  assert.equal(rec.homeFolderId, 'sheet');
});

test('a pending channel row keeps the channel folder it belongs to', () => {
  const rec = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: 'ch:UCaaaaaaaaaaaaaaaaaaaaaa' },
    ctx()
  );
  assert.equal(rec.homeFolderId, 'ch:UCaaaaaaaaaaaaaaaaaaaaaa');
});

test('a pending row with no usable home falls back to the folder it was filed under', () => {
  const noHome = sanitizeSnapshotVideo({ srcUrl: YT, state: 'pending', folderId: 'mine' }, ctx());
  assert.equal(noHome.folderId, '~pending');
  assert.equal(noHome.homeFolderId, 'mine');

  // '~pending' is a parking slot, never a home: a row carrying it in BOTH fields must
  // still come back somewhere real on approval
  const parkedTwice = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: '~pending' }, ctx()
  );
  assert.equal(parkedTwice.homeFolderId, 'mine');
});

test('a LIVE row is filed normally and is never parked', () => {
  const rec = sanitizeSnapshotVideo({ srcUrl: YT, state: 'live', folderId: 'sheet' }, ctx());
  assert.equal(rec.folderId, 'sheet');
  assert.equal(rec.homeFolderId, null);
  assert.equal(rec.state, 'live');

  // an unknown state is not a pass to be live-but-parked: '~pending' can only be reached
  // through the pending branch
  const junkFolder = sanitizeSnapshotVideo({ srcUrl: YT, state: 'live', folderId: '~pending' }, ctx());
  assert.equal(junkFolder.folderId, 'mine');
  const junkState = sanitizeSnapshotVideo({ srcUrl: YT, state: 'weird', folderId: 'sheet' }, ctx());
  assert.equal(junkState.state, 'live');
  assert.equal(junkState.folderId, 'sheet');
});

// ── untrusted paths and urls ────────────────────────────────────────────────────────────

test('a bad localPath is dropped rather than trusted', () => {
  const bad = [
    '/data/data/com.assaf.kidsplayer/files/videos/x.mp4', // absolute
    '../../etc/passwd',
    'videos/../../secret.mp4',
    'videos/x.mp4.exe',
    'videos/x.mkv',
    'file:///videos/x.mp4',
    'videos/名.mp4',                                       // outside the id charset we write
    { toString: () => 'videos/x.mp4' },                    // stringifies to a valid path…
    ['videos/x.mp4'],                                      // …and so does a 1-element array
    12345
  ];
  for (const localPath of bad) {
    assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, localPath }, ctx()).localPath, null,
      `trusted: ${String(localPath)}`);
  }
  // the one shape media.js actually writes survives
  assert.equal(
    sanitizeSnapshotVideo({ srcUrl: YT, localPath: 'videos/yt_abc-DEF_123.mp4' }, ctx()).localPath,
    'videos/yt_abc-DEF_123.mp4'
  );
});

test('thumbUrl must be https; anything else is dropped', () => {
  const keep = sanitizeSnapshotVideo({ srcUrl: YT, thumbUrl: 'https://i.ytimg.com/vi/x/hq.jpg' }, ctx());
  assert.equal(keep.thumbUrl, 'https://i.ytimg.com/vi/x/hq.jpg');
  for (const thumbUrl of ['http://i.ytimg.com/vi/x/hq.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAA', 7, {}]) {
    assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, thumbUrl }, ctx()).thumbUrl, null);
  }
});

// ── field hygiene ───────────────────────────────────────────────────────────────────────

test('timestamps come from the injected clock; an exported addedAt is preserved', () => {
  const fresh = sanitizeSnapshotVideo({ srcUrl: YT }, ctx({ now: 777 }));
  assert.equal(fresh.addedAt, 777);
  assert.equal(fresh.updatedAt, 777);
  const old = sanitizeSnapshotVideo({ srcUrl: YT, addedAt: 100 }, ctx({ now: 777 }));
  assert.equal(old.addedAt, 100);   // original age survives (merge policy prefers the older row)
  assert.equal(old.updatedAt, 777); // but the write itself is now
});

test('sortKey is kept when numeric and re-derived from the row otherwise', () => {
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, sortKey: 12345 }, ctx()).sortKey, 12345);
  const derived = sanitizeSnapshotVideo({ srcUrl: YT, origin: 'channel', publishedAt: 900 }, ctx());
  assert.equal(derived.sortKey, 900);
  assert.equal(derived.origin, 'channel');
});

test('a long title is capped and a non-string title becomes empty', () => {
  const long = sanitizeSnapshotVideo({ srcUrl: YT, title: 'א'.repeat(500) }, ctx());
  assert.equal(long.title.length, 300);
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, title: { evil: 1 } }, ctx()).title, '');
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, channelId: { }, }, ctx()).channelId, null);
});

test('junk in never throws — the import loop has no per-row try/catch', () => {
  const junk = [
    null, undefined, {}, [], 0, 'string', true,
    { srcUrl: {} }, { srcUrl: [] }, { srcUrl: YT, folderId: 5, homeFolderId: [], state: 9 },
    { srcUrl: YT, sortKey: 'nope', publishedAt: 'soon', rowIndex: 'x', addedAt: 'y', origin: 3 },
    { srcUrl: YT, title: Symbol('t') }
  ];
  for (const v of junk) {
    assert.doesNotThrow(() => sanitizeSnapshotVideo(v, ctx()), `threw on ${JSON.stringify(v) ?? v}`);
  }
  // and with no options at all (defaults must not blow up)
  assert.doesNotThrow(() => sanitizeSnapshotVideo({ srcUrl: YT }));
  assert.equal(sanitizeSnapshotVideo(null, ctx()), null);
  assert.equal(sanitizeSnapshotVideo({}, ctx()), null);
});
