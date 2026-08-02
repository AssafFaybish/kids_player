// Snapshot IMPORT sanitising — the backup file is UNTRUSTED input (a parent can hand-edit
// it, or import a snapshot exported by another family). These tests pin the rules that
// make that safe: the classifier rebuilds every link, a foreign scopeId can never write into
// a shared library, a PARKED row (pending OR rejected) stays parked with a home to come back
// to, no filesystem path from the file is trusted, and deny rows MERGE by the LWW rule
// instead of clobbering local state. Junk must never throw — the import loop has no
// per-row catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshotVideo, planDenyImport } from '../www/js/snapshot.js';
import { mergeDenyRecord } from '../www/js/drive.js';
import { denyActive } from '../www/js/db.js';

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

// ── rejected parking (v1.0.26) ──────────────────────────────────────────────────────────

test('a REJECTED row round-trips rejected + parked — NEVER live (the child-safety rule)', () => {
  // 'rejected' used to fall into the live branch (`pending ? 'pending' : 'live'`), so a
  // restore put every video the parent threw out back on the child's home — and giftable.
  const rec = sanitizeSnapshotVideo({
    srcUrl: YT, state: 'rejected', folderId: '~rejected',
    homeFolderId: 'ch:UCaaaaaaaaaaaaaaaaaaaaaa', rejectedAt: 1700000000000, approvedAt: 123
  }, ctx());
  assert.equal(rec.state, 'rejected');
  assert.equal(rec.folderId, '~rejected');  // the kid-facing folder index must never see it
  assert.equal(rec.homeFolderId, 'ch:UCaaaaaaaaaaaaaaaaaaaaaa'); // restore knows where to go
  // the ORIGINAL stamp: planRejectedPurge's 30-day clock reads this field, and a fresh
  // import stamp would restart the countdown on every restore
  assert.equal(rec.rejectedAt, 1700000000000);
  assert.equal(rec.approvedAt, null); // a rejected record never carries an approval
});

test('a rejected row with no rejectedAt imports with NONE — never a fresh stamp', () => {
  // rows written before v1.0.26 existed, or exported by an older app: planRejectedPurge
  // never auto-purges a record without rejectedAt, and inventing one here would put the
  // whole restored archive on a synchronized 30-day fuse.
  const rec = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'rejected', folderId: '~rejected', homeFolderId: 'mine' }, ctx({ now: 777 })
  );
  assert.equal(rec.rejectedAt, null);
  // junk is none too — num() sanitizes it like every other ordering input
  const junk = sanitizeSnapshotVideo({ srcUrl: YT, state: 'rejected', rejectedAt: 'yesterday' }, ctx({ now: 777 }));
  assert.equal(junk.rejectedAt, null);
});

test('a rejected row falls back to a real home exactly like pending does', () => {
  const rec = sanitizeSnapshotVideo({ srcUrl: YT, state: 'rejected', folderId: 'sheet' }, ctx());
  assert.equal(rec.folderId, '~rejected');
  assert.equal(rec.homeFolderId, 'sheet');
  // '~rejected' is a parking slot, never a home: a row carrying it in BOTH fields must
  // still come back somewhere real on restore
  const parkedTwice = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'rejected', folderId: '~rejected', homeFolderId: '~rejected' }, ctx()
  );
  assert.equal(parkedTwice.folderId, '~rejected');
  assert.equal(parkedTwice.homeFolderId, 'mine');
});

test('a rejected row whose library scope was rejected gets the same sheet→mine downgrade as pending', () => {
  const rec = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'rejected', folderId: '~rejected', homeFolderId: 'sheet', scopeId: 'lib:foreign' },
    ctx()
  );
  assert.equal(rec.scopeId, PROF_SCOPE);
  assert.equal(rec.folderId, '~rejected');
  assert.equal(rec.homeFolderId, 'mine', 'restore would file it into a folder that does not exist');
});

test("live and pending rows never carry rejectedAt, and '~rejected' is unreachable outside the rejected branch", () => {
  const live = sanitizeSnapshotVideo({ srcUrl: YT, state: 'live', folderId: '~rejected', rejectedAt: 123 }, ctx());
  assert.equal(live.state, 'live');
  assert.equal(live.folderId, 'mine'); // parking can only be reached through its state
  assert.equal(live.rejectedAt, null);
  const pending = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: '~rejected', rejectedAt: 123 }, ctx()
  );
  assert.equal(pending.homeFolderId, 'mine');
  assert.equal(pending.rejectedAt, null);
});

// ── deny-list import (v1.0.26) ──────────────────────────────────────────────────────────

test('a REVOKED deny row (removedAt >= at) stays INERT after import — at AND removedAt travel', () => {
  // the old code stamped `at: d.at || Date.now()` and dropped removedAt, so the sheet's
  // one deliberate undeny path imported as an ACTIVE-and-newest tombstone: the video was
  // deleted again on this device and the restamped row then won every Drive merge.
  const puts = planDenyImport(
    [], [{ scopeId: LIB_SCOPE, key: 'yt:x', at: 50, removedAt: 90, reason: 'sheet-mirror' }], ctx()
  );
  assert.equal(puts.length, 1);
  assert.equal(puts[0].scopeId, LIB_SCOPE);
  assert.equal(puts[0].at, 50);
  assert.equal(puts[0].removedAt, 90);
  assert.equal(denyActive(puts[0]), false, 'a revoked tombstone imported ACTIVE — the video is deleted again');
});

test('an import never clobbers a local REVOKED row with an active one', () => {
  const local = { scopeId: LIB_SCOPE, key: 'yt:x', at: 50, removedAt: 90, reason: 'manual' };
  // an old-format snapshot row ({scopeId,key} only, exported while the deny was active on
  // the source device) is exactly the shape that used to be restamped with Date.now()
  const puts = planDenyImport([local], [{ scopeId: LIB_SCOPE, key: 'yt:x' }], ctx());
  assert.equal(puts.length, 1);
  assert.equal(denyActive(puts[0]), false, 'the local revocation was clobbered back to active');
  assert.equal(puts[0].removedAt, 90);
  // a genuinely NEWER deny in the snapshot still wins — later event, later decision
  const newer = planDenyImport([local], [{ scopeId: LIB_SCOPE, key: 'yt:x', at: 120 }], ctx());
  assert.equal(denyActive(newer[0]), true);
  assert.equal(newer[0].at, 120);
});

test('the deny merge is COMMUTATIVE — merge(A,B) === merge(B,A), tie → revoked', () => {
  const A = { scopeId: LIB_SCOPE, key: 'yt:x', at: 50, removedAt: 90 };
  const B = { scopeId: LIB_SCOPE, key: 'yt:x', at: 120 };
  assert.deepEqual(mergeDenyRecord(A, B), mergeDenyRecord(B, A));
  assert.equal(denyActive(mergeDenyRecord(A, B)), true); // 120 > 90: the later deny wins
  // an exact tie between a deny and a revocation resolves to REVOKED — converges with
  // "the sheet wins" semantics, same direction in both argument orders
  const tieA = { scopeId: LIB_SCOPE, key: 'yt:x', at: 100 };
  const tieB = { scopeId: LIB_SCOPE, key: 'yt:x', at: 60, removedAt: 100 };
  assert.deepEqual(mergeDenyRecord(tieA, tieB), mergeDenyRecord(tieB, tieA));
  assert.equal(denyActive(mergeDenyRecord(tieA, tieB)), false);
});

test('deny scoping and junk: foreign scope falls back, junk is skipped, a missing at is 0 — never now', () => {
  const before = Date.now();
  const puts = planDenyImport([], [
    { scopeId: 'lib:foreign', key: 'yt:x', at: 5 },   // a foreign library must not be written into
    { key: 'yt:y' },                                   // old export format: no scope, no times
    null, {}, 'x', { scopeId: LIB_SCOPE, key: 7 }, { scopeId: LIB_SCOPE, key: 'yt:z', at: 'soon' }
  ], ctx());
  const by = new Map(puts.map((p) => [p.key, p]));
  assert.equal(by.get('yt:x').scopeId, PROF_SCOPE);
  assert.equal(by.get('yt:y').scopeId, PROF_SCOPE);
  // a timeless row must never be stamped with the import time — that is what made the
  // resurrected tombstone win on every device (db.copyDenies learned this in v1.0.22)
  assert.equal(by.get('yt:y').at, 0);
  assert.ok(by.get('yt:y').at < before);
  assert.equal(by.get('yt:z').at, 0);
  assert.equal(puts.length, 3, 'junk rows leaked through');
  // duplicates inside ONE snapshot merge against each other, not last-write-wins
  const dup = planDenyImport([], [
    { scopeId: LIB_SCOPE, key: 'yt:x', at: 50, removedAt: 90 },
    { scopeId: LIB_SCOPE, key: 'yt:x', at: 50 }
  ], ctx());
  assert.equal(dup.length, 1);
  assert.equal(denyActive(dup[0]), false);
  // and with no options at all (defaults must not blow up)
  assert.doesNotThrow(() => planDenyImport(null, [{ key: 'yt:q' }]));
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

// ── the fields and shapes an import must not quietly lose ──────────────────────────────

test('a record can never be imported with an UNINDEXABLE sortKey', () => {
  // sortKeyFor happily returns NaN for a junk addedAt and a STRING for a junk
  // publishedAt. Both store fine and then index NOWHERE: the by_folder_sort index
  // takes no NaN key, and a string sorts outside folderRange's numeric bounds. The row
  // counted as "imported", the parent was told it worked, and the child never saw it.
  for (const v of [
    { srcUrl: YT, addedAt: 'y' },
    { srcUrl: YT, origin: 'channel', publishedAt: 'soon' },
    { srcUrl: YT, origin: 'sheet-row', rowIndex: 'x' },
    { srcUrl: YT, sortKey: 'nope' },
    { srcUrl: YT, sortKey: NaN },
    { srcUrl: YT, addedAt: {}, publishedAt: [], rowIndex: Symbol ? undefined : 0 }
  ]) {
    const rec = sanitizeSnapshotVideo(v, ctx());
    assert.equal(typeof rec.sortKey, 'number', `non-numeric sortKey for ${JSON.stringify(v)}`);
    assert.ok(Number.isFinite(rec.sortKey), `unindexable sortKey for ${JSON.stringify(v)}`);
  }
  // the stored ordering inputs are sanitized too — a junk value must not survive on the record
  const junk = sanitizeSnapshotVideo({ srcUrl: YT, publishedAt: 'soon', rowIndex: 'x', addedAt: 'y' }, ctx());
  assert.equal(junk.publishedAt, null);
  assert.equal(junk.rowIndex, null);
  assert.equal(typeof junk.addedAt, 'number');
});

test('the 🎞️ collection fields survive the round trip', () => {
  // groupSinglesByChannel keys off srcChannelId. Dropping it turned every restored
  // library's collections back into one flat list, and dropping srcChannelTriedAt
  // restarted the weekly re-enrichment throttle on top of it.
  const rec = sanitizeSnapshotVideo({
    srcUrl: YT, srcChannelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', srcChannelTitle: 'ערוץ ילדים',
    srcChannelTriedAt: 1700000000000
  }, ctx());
  assert.equal(rec.srcChannelId, 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(rec.srcChannelTitle, 'ערוץ ילדים');
  assert.equal(rec.srcChannelTriedAt, 1700000000000);
  // …and are still sanitized like every other untrusted field
  const bad = sanitizeSnapshotVideo({ srcUrl: YT, srcChannelId: {}, srcChannelTitle: 5, srcChannelTriedAt: 'x' }, ctx());
  assert.equal(bad.srcChannelId, null);
  assert.equal(bad.srcChannelTitle, null);
  assert.equal(bad.srcChannelTriedAt, null);
});

test('normTitle is derived from the SANITIZED title, never the raw one', () => {
  // `{}` was rejected for `title` and then stringified into normTitle, so the kid's
  // search found a nameless tile under "object".
  const rec = sanitizeSnapshotVideo({ srcUrl: YT, title: { evil: 1 } }, ctx());
  assert.equal(rec.title, '');
  assert.equal(rec.normTitle, '', 'normTitle leaked the raw value');
  assert.equal(sanitizeSnapshotVideo({ srcUrl: YT, title: 5 }, ctx()).normTitle, '');
});

test('a REJECTED library scope takes the sheet folder down with it', () => {
  // 'sheet' is a folder buildFolders only ever raises for the LIBRARY scope, and
  // absorbMineIntoShared only rescues 'mine'. A row whose lib scope was rejected and
  // downgraded to prof: therefore landed in NO folder — stored, approvable, invisible.
  const rejected = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: 'sheet', scopeId: 'lib:foreign' },
    ctx()
  );
  assert.equal(rejected.scopeId, PROF_SCOPE);
  assert.equal(rejected.homeFolderId, 'mine', 'approval would file it into a folder that does not exist');

  const liveRejected = sanitizeSnapshotVideo({ srcUrl: YT, state: 'live', folderId: 'sheet', scopeId: 'lib:foreign' }, ctx());
  assert.equal(liveRejected.folderId, 'mine');

  // an ACCEPTED library scope keeps 'sheet' — that is the whole point of the v1.0.20 fix
  const kept = sanitizeSnapshotVideo(
    { srcUrl: YT, state: 'pending', folderId: '~pending', homeFolderId: 'sheet', scopeId: LIB_SCOPE }, ctx()
  );
  assert.equal(kept.scopeId, LIB_SCOPE);
  assert.equal(kept.homeFolderId, 'sheet');
  // a channel folder is unaffected either way
  assert.equal(
    sanitizeSnapshotVideo({ srcUrl: YT, folderId: 'ch:UCaaaaaaaaaaaaaaaaaaaaaa', scopeId: 'lib:foreign' }, ctx()).folderId,
    'ch:UCaaaaaaaaaaaaaaaaaaaaaa'
  );
});
