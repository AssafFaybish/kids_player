// Drive DB pure-merge tests — the two properties that make server-free convergence
// safe: commutativity and idempotence. Plus the serialization refusal list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretDriveDoc, interpretDriveList, decidePush, mergeChannelForApply, stripPerDeviceChannel, serializeDb, parseDb, mergeDbFiles, mergeLibraryChannel, serializeStateEntry, mergeAppliedState } from '../www/js/drive.js';
import { mergeSettings } from '../www/js/settings.js';
import { mergeVideoRecord, settleCuration } from '../www/js/normalize.js';

const vid = (key, over = {}) => ({
  key, type: 'youtube', id: key.slice(3), srcUrl: 'https://youtu.be/' + key.slice(3),
  title: 'שיר', titleSource: 'rss', normTitle: 'שיר', folderId: 'sheet', channelId: null,
  sortKey: 1, publishedAt: null, rowIndex: 0, origin: 'sheet-row', state: 'live',
  addedAt: 100, updatedAt: 100, ...over
});

const docA = {
  kind: 'kids-player-db', schema: 1, exportedAt: 1000,
  profiles: [{ id: 'p1', name: 'דני', updatedAt: 10 }],
  libraries: {
    'lib:x': {
      sheetUrl: 'https://sheet', videos: [vid('yt:aaaaaaaaaaa'), vid('yt:bbbbbbbbbbb')],
      denylist: [{ key: 'yt:ddddddddddd', at: 5 }],
      channels: [{ channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', updatedAt: 10 }],
      libraryChannels: [{ channelId: 'UCabcdefghijklmnopqrstuv', autoApprove: false, updatedAt: 10 }]
    }
  },
  profileState: { p1: { 'yt:aaaaaaaaaaa': { unwrappedAt: 50 } } }
};
const docB = {
  kind: 'kids-player-db', schema: 1, exportedAt: 2000,
  profiles: [{ id: 'p1', name: 'דני!', updatedAt: 20 }],
  libraries: {
    'lib:x': {
      sheetUrl: 'https://sheet',
      videos: [vid('yt:bbbbbbbbbbb', { state: 'pending', addedAt: 50 }), vid('yt:ccccccccccc')],
      denylist: [{ key: 'yt:eeeeeeeeeee', at: 7 }, { key: 'yt:bbbbbbbbbbb', at: 9 }],
      channels: [{ channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ חדש', updatedAt: 20 }],
      libraryChannels: [{ channelId: 'UCabcdefghijklmnopqrstuv', autoApprove: true, updatedAt: 20 }]
    }
  },
  profileState: { p1: { 'yt:aaaaaaaaaaa': { unwrappedAt: 30 }, 'yt:ccccccccccc': { giftRank: 1 } } }
};

const canon = (d) => JSON.parse(JSON.stringify(d, (k, v) => k === 'exportedAt' ? 0 : v,));
const sortAll = (d) => {
  for (const lib of Object.values(d.libraries)) {
    lib.videos.sort((x, y) => x.key < y.key ? -1 : 1);
    lib.denylist.sort((x, y) => x.key < y.key ? -1 : 1);
  }
  d.profiles.sort((x, y) => x.id < y.id ? -1 : 1);
  return d;
};

test('merge is commutative: merge(a,b) ≡ merge(b,a)', () => {
  const ab = sortAll(canon(mergeDbFiles(docA, docB)));
  const ba = sortAll(canon(mergeDbFiles(docB, docA)));
  assert.deepEqual(ab, ba);
});

test('merge is idempotent: merge(a,a) keeps a\'s content', () => {
  const aa = sortAll(canon(mergeDbFiles(docA, docA)));
  const a1 = sortAll(canon(mergeDbFiles(docA, JSON.parse(JSON.stringify(docA)))));
  assert.deepEqual(aa, a1);
  assert.equal(aa.libraries['lib:x'].videos.length, 2); // aaaa+bbbb kept (only dddd is denied in A)
});

test('deny-list is a union and denied videos never travel', () => {
  const m = mergeDbFiles(docA, docB);
  const deniedKeys = m.libraries['lib:x'].denylist.map((d) => d.key).sort();
  assert.deepEqual(deniedKeys, ['yt:bbbbbbbbbbb', 'yt:ddddddddddd', 'yt:eeeeeeeeeee']);
  assert.ok(!m.libraries['lib:x'].videos.some((v) => v.key === 'yt:bbbbbbbbbbb'),
    'a video denied on EITHER device is gone from the merged doc');
});

test('unwrappedAt takes MIN — once unwrapped anywhere, never re-gifted', () => {
  const m = mergeDbFiles(docA, docB);
  assert.equal(m.profileState.p1['yt:aaaaaaaaaaa'].unwrappedAt, 30);
});

test('LWW by updatedAt for profiles and channel toggles', () => {
  const m = mergeDbFiles(docA, docB);
  assert.equal(m.profiles[0].name, 'דני!');
  assert.equal(m.libraries['lib:x'].libraryChannels[0].autoApprove, true);
});

test('autoApprove CONVERGES even when neither row carries a timestamp (v1.0.22)', () => {
  // The real production shape until v1.0.22: no writer set `updatedAt` on a
  // libraryChannels row, so `lww` compared 0 > 0 → false → the FIRST argument won and
  // "I approved this channel" resolved by merge order. The suite missed it because the
  // fixtures above DO carry timestamps — it pinned the fixture, not the app.
  const lib = (autoApprove) => ({
    kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { videos: [], denylist: [], channels: [], libraryChannels: [{ channelId: 'UC1', autoApprove }] } }
  });
  const on = lib(true);
  const off = lib(false);
  const pick = (d) => mergeDbFiles(...d).libraries['lib:x'].libraryChannels[0].autoApprove;
  assert.equal(pick([on, off]), pick([off, on]), 'merge must not depend on argument order');
  // and the tie resolves the SAFE way: still requires the parent to approve
  assert.equal(pick([on, off]), false);
});

test('mergeLibraryChannel: recency wins, a timestamp beats a legacy row, tie is safe', () => {
  const a = { channelId: 'UC1', autoApprove: false, updatedAt: 10 };
  const b = { channelId: 'UC1', autoApprove: true, updatedAt: 20 };
  assert.equal(mergeLibraryChannel(a, b).autoApprove, true, 'newer wins');
  assert.equal(mergeLibraryChannel(b, a).autoApprove, true, 'and it is commutative');
  const legacy = { channelId: 'UC1', autoApprove: false };
  assert.equal(mergeLibraryChannel(legacy, b).autoApprove, true, 'a real timestamp beats no timestamp');
  assert.equal(mergeLibraryChannel(b, legacy).autoApprove, true);
  assert.equal(mergeLibraryChannel(null, a), a);
  assert.equal(mergeLibraryChannel(a, null), a);
});

test('a peer\'s approval arrives REACHABLE, not parked (v1.0.22)', () => {
  // The applyRemoteDoc composition: local record is waiting for approval, the remote one
  // was approved on another device. mergeVideoRecord promotes the state and never touches
  // folderId, so this used to yield live + '~pending' — invisible in the child's folder
  // AND absent from the approval queue.
  const mine = {
    key: 'yt:aaaaaaaaaaa', state: 'pending', folderId: '~pending', homeFolderId: 'ch:UC1',
    title: 'שיר', titleSource: 'rss', addedAt: 100, approvedAt: null
  };
  const remote = {
    key: 'yt:aaaaaaaaaaa', state: 'live', folderId: 'ch:UC1',
    title: 'שיר', titleSource: 'rss', addedAt: 100, approvedAt: 500
  };
  const rec = settleCuration(mergeVideoRecord(mine, remote), remote.homeFolderId || remote.folderId, 900);
  assert.equal(rec.state, 'live');
  assert.equal(rec.folderId, 'ch:UC1', 'un-parked, or the child can never reach it');
  assert.equal(rec.approvedAt, 500, 'the peer\'s approval time survives');

  // The other direction must NOT leak: a remote record still pending stays parked.
  const stillWaiting = settleCuration(
    mergeVideoRecord({ ...mine }, { ...remote, state: 'pending', folderId: '~pending', approvedAt: null }),
    'ch:UC1', 900
  );
  assert.equal(stillWaiting.state, 'pending');
  assert.equal(stillWaiting.folderId, '~pending');
});

test('a REJECTION travels through the Drive doc, and the merge stays order-independent (v1.0.23)', () => {
  // The cross-device half of the rejected list. Device A rejected the video at t=900;
  // device B still holds the copy it approved at t=100 and pushes it. Whichever order the
  // two documents meet in, the child must not get it back.
  const doc = (over) => ({
    kind: 'kids-player-db', schema: 1, exportedAt: 1, profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { sheetUrl: null, denylist: [], channels: [], libraryChannels: [], videos: [vid('yt:aaaaaaaaaaa', over)] } }
  });
  const rejectedOnA = doc({ state: 'rejected', rejectedAt: 900, approvedAt: null, folderId: '~rejected', homeFolderId: 'ch:UC1' });
  const liveOnB = doc({ state: 'live', approvedAt: 100, folderId: 'ch:UC1' });
  const pick = (x, y) => mergeDbFiles(x, y).libraries['lib:x'].videos[0];

  for (const [name, m] of [['A,B', pick(rejectedOnA, liveOnB)], ['B,A', pick(liveOnB, rejectedOnA)]]) {
    assert.equal(m.state, 'rejected', `merge(${name}) revived a rejected video`);
    assert.equal(m.approvedAt, null, `merge(${name}) still claims it is approved`);
  }
  // and the mirror image: an approval made LATER than the rejection must win
  const laterApproval = doc({ state: 'live', approvedAt: 5000, folderId: 'ch:UC1' });
  assert.equal(pick(rejectedOnA, laterApproval).state, 'live', 'the parent changed their mind');
  assert.equal(pick(laterApproval, rejectedOnA).state, 'live');
  // idempotence: merging a doc with itself must not disturb the decision
  assert.equal(pick(rejectedOnA, rejectedOnA).state, 'rejected');
  assert.equal(pick(rejectedOnA, rejectedOnA).rejectedAt, 900);
});

test('serializeDb round-trips the rejected shape (v1.0.23)', () => {
  // If `rejectedAt` or the '~rejected' parking slot did not survive serialization, the
  // rejection would arrive on the peer as an undated one — and resolveCuration compares
  // exactly that timestamp, so any live copy would then outrank it.
  const doc = {
    profiles: [], profileState: {}, profileSources: {},
    libraries: { 'lib:x': { sheetUrl: null, denylist: [], channels: [], libraryChannels: [],
      videos: [vid('yt:aaaaaaaaaaa', { state: 'rejected', rejectedAt: 4242, approvedAt: null, folderId: '~rejected', homeFolderId: 'ch:UC1' })] } }
  };
  const back = parseDb(serializeDb(doc));
  const v = back.libraries['lib:x'].videos[0];
  assert.equal(v.state, 'rejected');
  assert.equal(v.rejectedAt, 4242, 'the decision timestamp must survive the round trip');
  assert.equal(v.folderId, '~rejected');
  assert.equal(v.homeFolderId, 'ch:UC1', 'without this the peer cannot restore it anywhere');
});

test('serializeDb refusal list: no localPath, no thumbId, no backfillCursor', () => {
  const json = serializeDb({
    profiles: [],
    libraries: {
      'lib:x': {
        videos: [vid('yt:aaaaaaaaaaa', { localPath: 'videos/x.mp4', thumbId: 'file:abc' })],
        channels: [{
          channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', logoUrl: 'https://x/y.jpg',
          backfillCursor: 'PAGE_TOKEN', backfillPlaylistId: 'UULFabcdefghijklmnopqrstuv',
          playlistCursor: 'PL_TOKEN', playlistQueue: ['PLaaa'], playlistsDone: true, noLongForm: true
        }],
        denylist: [], libraryChannels: []
      }
    },
    profileState: {}
  });
  assert.ok(!json.includes('localPath'));
  assert.ok(!json.includes('thumbId'));
  assert.ok(!json.includes('backfillCursor'));
  assert.ok(!json.includes('PAGE_TOKEN'));
  // v1.0.21 — PAGING STATE IS PER DEVICE. A page token means nothing in another device's
  // paging position, and `playlistsDone`/`noLongForm` arriving from a peer would make this
  // device skip work it never did: device B would pull "playlists finished" from device A
  // and never walk them in its OWN scope, losing that content permanently if B follows a
  // different sheet.
  for (const leak of ['playlistCursor', 'PL_TOKEN', 'playlistQueue', 'PLaaa', 'playlistsDone', 'noLongForm', 'backfillPlaylistId']) {
    assert.ok(!json.includes(leak), `${leak} leaked into the Drive backup`);
  }
  // …while the fields that DO belong to every device still travel
  assert.ok(json.includes('logoUrl') && json.includes('ערוץ'), 'shared channel fields were dropped');
});

test('parseDb: round-trip works; garbage and truncated input → null, never throws', () => {
  const json = serializeDb({ profiles: [], libraries: {}, profileState: {} });
  assert.ok(parseDb(json));
  assert.equal(parseDb(json.slice(0, 30)), null);
  assert.equal(parseDb('{"kind":"other"}'), null);
  assert.equal(parseDb(null), null);
});

/* ---------------- profileSources (v1.0.4: profile→sheet mapping in the doc) ---------------- */

test('profileSources: LWW by updatedAt, one-sided entries survive, commutative', () => {
  const a2 = { ...docA, profileSources: { p1: { sheetUrl: 'https://old', updatedAt: 10 }, p2: { sheetUrl: 'https://only-a', updatedAt: 5 } } };
  const b2 = { ...docB, profileSources: { p1: { sheetUrl: 'https://new', updatedAt: 20 } } };
  const ab = mergeDbFiles(a2, b2);
  const ba = mergeDbFiles(b2, a2);
  assert.equal(ab.profileSources.p1.sheetUrl, 'https://new');
  assert.equal(ab.profileSources.p2.sheetUrl, 'https://only-a');
  assert.deepEqual(ab.profileSources, ba.profileSources);
});

test('profileSources: docs WITHOUT the field (pre-v1.0.4 backups) merge cleanly', () => {
  const m = mergeDbFiles(docA, docB); // neither doc carries profileSources
  assert.deepEqual(m.profileSources, {});
  const mixed = mergeDbFiles(docA, { ...docB, profileSources: { p1: { sheetUrl: 'https://s', updatedAt: 1 } } });
  assert.equal(mixed.profileSources.p1.sheetUrl, 'https://s');
});

test('serializeDb round-trips profileSources; omitted -> {}', () => {
  const json = serializeDb({
    profiles: [], libraries: {}, profileState: {},
    profileSources: { p1: { sheetUrl: 'https://sheet', updatedAt: 7 } }
  });
  assert.equal(parseDb(json).profileSources.p1.sheetUrl, 'https://sheet');
  assert.deepEqual(parseDb(serializeDb({ profiles: [], libraries: {}, profileState: {} })).profileSources, {});
});

/* ---------------- v1.0.10: deny LWW with revocation (sheet-wins undeny) ---------------- */

test('a LATER revoke defeats an older deny — the video travels again', async () => {
  const { mergeDenyRecord } = await import('../www/js/drive.js');
  const a2 = { ...docA, libraries: { 'lib:x': { ...docA.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 50 }] } } };
  const b2 = { ...docB, libraries: { 'lib:x': { ...docB.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 50, removedAt: 90 }] } } };
  const m = mergeDbFiles(a2, b2);
  const entry = m.libraries['lib:x'].denylist.find((d) => d.key === 'yt:aaaaaaaaaaa');
  assert.equal(entry.removedAt, 90, 'the revoked entry wins the merge');
  assert.ok(m.libraries['lib:x'].videos.some((v) => v.key === 'yt:aaaaaaaaaaa'),
    'a revoked deny no longer drops the video');
  // direct rule checks: later re-deny beats older revoke
  const reDenied = mergeDenyRecord({ key: 'k', at: 50, removedAt: 90 }, { key: 'k', at: 120 });
  assert.equal(reDenied.at, 120);
  assert.equal(reDenied.removedAt, undefined);
});

test('deny LWW merge stays commutative and idempotent', () => {
  const a2 = { ...docA, libraries: { 'lib:x': { ...docA.libraries['lib:x'],
    denylist: [{ key: 'yt:ddddddddddd', at: 5 }, { key: 'yt:aaaaaaaaaaa', at: 40, removedAt: 60 }] } } };
  const b2 = { ...docB, libraries: { 'lib:x': { ...docB.libraries['lib:x'],
    denylist: [{ key: 'yt:aaaaaaaaaaa', at: 70 }] } } };
  const ab = sortAll(canon(mergeDbFiles(a2, b2)));
  const ba = sortAll(canon(mergeDbFiles(b2, a2)));
  assert.deepEqual(ab, ba);
  const aa = sortAll(canon(mergeDbFiles(a2, a2)));
  assert.deepEqual(aa, sortAll(canon(mergeDbFiles(a2, JSON.parse(JSON.stringify(a2))))));
  // at 70 > removedAt 60 → the re-deny wins → video dropped
  assert.ok(!ab.libraries['lib:x'].videos.some((v) => v.key === 'yt:aaaaaaaaaaa'));
});

/* ---- the READ side of the deny list (v1.0.20) ---- */

test('denyActive: the read gate agrees with the merge rule, tie → revoked', async () => {
  // The merge rule above decides which deny record survives; this one-liner decides
  // whether a surviving record still BLOCKS. If they ever disagree, deleted videos come
  // back (too lenient) or a sheet re-add can never revive anything (too strict).
  const { denyActive } = await import('../www/js/db.js');
  assert.equal(denyActive({ key: 'yt:a', at: 5 }), true, 'a plain tombstone blocks');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 4 }), true, 'an OLDER revoke loses');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 6 }), false, 'a LATER revoke wins');
  assert.equal(denyActive({ key: 'yt:a', at: 5, removedAt: 5 }), false, 'a TIE goes to revoked');
  // junk must read as "not blocking" — a corrupt row may not silently hide content
  for (const junk of [null, undefined, 0, '', false]) assert.equal(denyActive(junk), false, String(junk));
  // a record with no timestamp at all still blocks (at||0 = 0, no removedAt)
  assert.equal(denyActive({ key: 'yt:a' }), true);
});

/* ---- v1.0.22: the Drive I/O gates. The pure half of the merge was always tested; the
        decision to WRITE was not, and that is the side that can lose a family's data. ---- */

test('interpretDriveDoc: only a 404 may mean "no document"', () => {
  const doc = JSON.stringify({ kind: 'kids-player-db', schema: 1, libraries: {}, profiles: [] });
  assert.equal(interpretDriveDoc(404, ''), null, 'a real 404 is the ONE empty answer');
  assert.equal(interpretDriveDoc(200, doc).kind, 'kids-player-db');

  // Everything else THROWS. This is the whole point: readDbFile used to answer `null` for
  // all of these, mergeDbFiles(local, null) returns local, and pushDrive then PATCHed
  // local over the remote — in the branch that exists to protect the peer's changes.
  for (const [status, body, why] of [
    [401, '', 'stale token'],
    [500, '', 'server error'],
    [0, '', 'network drop'],
    [200, '', 'empty body'],
    [200, '<!DOCTYPE html><html>sign in</html>', 'a lost grant answers 200 + HTML'],
    [200, '{"kind":"something-else"}', 'not our document'],
    [200, 'not json at all', 'garbage'],
    [200, '{"kind":"kids-player-db"}', 'no libraries map']
  ]) {
    assert.throws(() => interpretDriveDoc(status, body), undefined, `${status} (${why}) did not throw`);
  }
});

test('interpretDriveList: "couldn’t ask" is not "nothing there"', () => {
  // Conflating them told the parent "no backup exists" AND sent pushDrive down the create
  // branch, producing a SECOND db file that permanently shadows the family's real one.
  assert.deepEqual(interpretDriveList(200, { files: [] }), []);
  assert.equal(interpretDriveList(200, { files: [{ id: 'a' }] }).length, 1);
  for (const [status, data] of [[401, null], [500, null], [0, null], [200, {}], [200, { files: 'x' }], [200, null]]) {
    assert.throws(() => interpretDriveList(status, data), undefined, `status ${status} did not throw`);
  }
});

test('decidePush: an UNREADABLE remote aborts — it never writes', () => {
  // Aborting costs one deferred push (pendingPush retries). Guessing costs the backup.
  assert.equal(decidePush({ fileId: null }).action, 'create', 'no file yet ⇒ create');
  assert.equal(decidePush({ fileId: 'f', remoteVersion: '7', lastRemoteVersion: '7' }).action, 'write',
    'unchanged since our own write ⇒ safe to overwrite');

  const changed = { fileId: 'f', remoteVersion: '9', lastRemoteVersion: '7' };
  assert.equal(decidePush({ ...changed, remoteRead: { ok: false, error: 'drive-401' } }).action, 'abort');
  assert.equal(decidePush({ ...changed, remoteRead: null }).action, 'abort', 'not even attempted ⇒ abort');
  const merged = decidePush({ ...changed, remoteRead: { ok: true, doc: { kind: 'kids-player-db', libraries: {} } } });
  assert.equal(merged.action, 'write');
  assert.equal(merged.useRemote, true, 'a readable remote MUST be merged in before writing');

  // an unknown version is a mismatch, not a match: a failed probe must not look "unchanged"
  assert.equal(decidePush({ fileId: 'f', remoteVersion: null, lastRemoteVersion: '7', remoteRead: { ok: false } }).action, 'abort');
  // …and a first-ever push (no lastRemoteVersion) against an existing file still merges
  assert.equal(decidePush({ fileId: 'f', remoteVersion: '1', lastRemoteVersion: '', remoteRead: { ok: true, doc: {} } }).useRemote, true);
});

test('per-device channel progress never travels, in EITHER direction', () => {
  const remote = {
    channelId: 'UCabcdefghijklmnopqrstuv', title: 'ערוץ', logoUrl: 'https://x/y.jpg',
    backfillCursor: 'THEIRS', backfillPlaylistId: 'UULFtheirs', backfillDone: true,
    lastRssCheckedAt: 999, playlistCursor: 'THEIRS2', playlistQueue: ['PL1'],
    playlistsDone: true, noLongForm: true
  };
  // A channel this device has NEVER seen must adopt the shared facts only. Writing the
  // peer's record verbatim handed it `backfillDone:true`, so planChannelFetch returned
  // 'rss' forever and the child only ever got the ~15-video feed window.
  const fresh = mergeChannelForApply(null, remote);
  assert.equal(fresh.title, 'ערוץ');
  assert.equal(fresh.logoUrl, 'https://x/y.jpg');
  for (const f of ['backfillCursor', 'backfillPlaylistId', 'backfillDone', 'lastRssCheckedAt',
    'playlistCursor', 'playlistQueue', 'playlistsDone', 'noLongForm']) {
    assert.ok(!(f in fresh), `${f} was adopted from a peer`);
  }
  // where we DO have local progress, ours wins and the shared facts still update
  const prev = { channelId: remote.channelId, title: 'old', backfillCursor: 'MINE', backfillDone: false, playlistsDone: false };
  const merged = mergeChannelForApply(prev, remote);
  assert.equal(merged.title, 'ערוץ', 'shared facts must still be adopted');
  assert.equal(merged.backfillCursor, 'MINE');
  assert.equal(merged.backfillDone, false, "a peer's 'finished' must not skip our backfill");
  assert.equal(merged.playlistsDone, false);
  // stripPerDeviceChannel is what serializeDb uses, so the two halves cannot drift
  assert.deepEqual(Object.keys(stripPerDeviceChannel(remote)).sort(), ['channelId', 'logoUrl', 'title']);
});

test('denyRowToWrite: a REVOKED tombstone in the target is never overwritten', async () => {
  const { denyRowToWrite, denyActive } = await import('../www/js/db.js');
  const active = { key: 'yt:aaaaaaaaaaa', at: 500, reason: 'watch-delete' };

  // The bug: "is it missing?" was answered with loadDenySet, which exposes ACTIVE entries
  // only — so a REVOKED row read as absent, got put over, and lost its `removedAt`. That
  // silently undid the one deliberate undeny path ("the sheet wins"), and because the
  // replacement was stamped Date.now() it always won Drive's last-event comparison, so the
  // resurrected tombstone propagated and re-deleted the video on EVERY device.
  const revokedTarget = { key: 'yt:aaaaaaaaaaa', at: 500, removedAt: 900 };
  assert.equal(denyRowToWrite(revokedTarget, active, 'lib:x'), null, 'a revocation was clobbered');
  // an ACTIVE target is likewise left alone (its own timestamp must survive)
  assert.equal(denyRowToWrite({ key: 'yt:aaaaaaaaaaa', at: 700 }, active, 'lib:x'), null);

  // genuinely missing ⇒ copy, carrying the SOURCE's timestamp, not "now"
  const row = denyRowToWrite(undefined, active, 'lib:x');
  assert.equal(row.scopeId, 'lib:x');
  assert.equal(row.key, 'yt:aaaaaaaaaaa');
  assert.equal(row.at, 500, 'the tombstone was re-stamped, which wins the Drive LWW wrongly');
  // a revoked SOURCE copies as revoked — it must not arrive active in the new scope
  const revokedSource = denyRowToWrite(undefined, { key: 'yt:bbbbbbbbbbb', at: 100, removedAt: 200 }, 'lib:x');
  assert.equal(revokedSource.removedAt, 200);
  assert.equal(denyActive(revokedSource), false, 'a revoked entry arrived ACTIVE in the target');
  for (const junk of [null, undefined, {}, { at: 1 }]) assert.equal(denyRowToWrite(undefined, junk, 'lib:x'), null, String(junk));
});

/* ---------------- synced settings ON THE WIRE (v1.0.25) ----------------
 * settings.test.mjs proves mergeSettings converges. These prove the settings actually
 * TRAVEL: deleting one line from serializeDb would leave that whole file green while the
 * PIN silently stopped syncing — the "pinned the fixture, not the production path"
 * failure this repo has already been bitten by twice.
 */

const doc = (settings) => parseDb(serializeDb({
  profiles: [{ id: 'p1', name: 'נועם' }], libraries: {}, profileState: {}, profileSources: {}, settings
}));

test('settings survive serialize → parse (they are really on the wire)', () => {
  const s = { account: { pin: { v: 'hash', at: 7 } }, profiles: { p1: { exitLock: { v: true, at: 9 } } } };
  const d = doc(s);
  assert.ok(d, 'the document did not even parse');
  assert.deepEqual(d.settings, s, 'settings never reached the Drive document');
});

test('serializeDb emits an EMPTY settings object rather than nothing', () => {
  // A missing key and an empty one behave differently on the merge side, and every push
  // from a device that has changed no setting takes this path.
  const d = doc(undefined);
  assert.deepEqual(d.settings, { account: {}, profiles: {} });
});

test('mergeDbFiles merges settings — not first-wins, not dropped', () => {
  const A = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'old', at: 100 } }, profiles: { p1: { exitLock: { v: false, at: 100 } } } } });
  const B = serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'new', at: 200 } }, profiles: { p1: { autoplay: { v: true, at: 50 } } } } });
  const ab = mergeDbFiles(parseDb(A), parseDb(B));
  const ba = mergeDbFiles(parseDb(B), parseDb(A));

  assert.equal(ab.settings.account.pin.v, 'new', 'the later PIN lost — settings are not merged');
  assert.equal(ab.settings.profiles.p1.exitLock.v, false, 'a key only A had was dropped');
  assert.equal(ab.settings.profiles.p1.autoplay.v, true, 'a key only B had was dropped');
  // the whole reason this repo writes merge tests at all
  assert.deepEqual(ab.settings, ba.settings, 'order-dependent — two devices never converge');
  // idempotent: a push/pull loop has to settle
  assert.deepEqual(mergeDbFiles(ab, parseDb(A)).settings, ab.settings);
  assert.deepEqual(mergeDbFiles(ab, ab).settings, ab.settings);
});

test('a doc from an OLDER app (no settings key) does not wipe ours', () => {
  // The rollout case: a device still on v1.0.24 pushes a document with no `settings` at
  // all. Reading that as "the family cleared everything" would unlock a locked tablet and
  // erase the parent PIN for the whole account.
  const mine = parseDb(serializeDb({ profiles: [], libraries: {}, profileState: {}, profileSources: {},
    settings: { account: { pin: { v: 'keep', at: 5 } }, profiles: {} } }));
  const legacy = parseDb(JSON.stringify({ kind: 'kids-player-db', schema: 1, libraries: {}, profiles: [] }));
  assert.equal(legacy.settings, undefined, 'the fixture is not actually a legacy doc');
  assert.equal(mergeDbFiles(mine, legacy).settings.account.pin.v, 'keep');
  assert.equal(mergeDbFiles(legacy, mine).settings.account.pin.v, 'keep');
});

test('the settings channel carries NO secret the refusal list bans', () => {
  // drive.js has an explicit never-serialize list (localPath, thumbs, cursors, the API
  // key). A new top-level key is exactly where one would get swept back in.
  const d = doc({ account: { pin: { v: 'h', at: 1 } }, profiles: { p1: { exitLock: { v: true, at: 1 } } } });
  const wire = JSON.stringify(d);
  for (const banned of ['yt:apiKey', 'localPath', 'thumbId', 'backfillCursor', 'dbFileId']) {
    assert.ok(!wire.includes(banned), `the document carries ${banned}`);
  }
});

/* ---------------- profileVideoState ⇄ Drive (v1.0.32) ---------------- */

test('the playback position NEVER travels to Drive', () => {
  // It changes every few seconds of watching — pushing it would rewrite the family
  // document on every pause (the giftRank lesson). A record carrying ONLY a position
  // contributes NOTHING, not an empty object the apply side must skip.
  assert.equal(serializeStateEntry({ posSec: 61, durSec: 300, posAt: 5 }), null);
  // …and a real gift/unwrap entry must not smuggle the position along
  assert.deepEqual(serializeStateEntry({ unwrappedAt: 9, posSec: 61, durSec: 300 }),
    { unwrappedAt: 9 });
  assert.deepEqual(serializeStateEntry({ giftRank: 3, posSec: 61 }), { giftRank: 3 });
  // rank 0 is a valid rank, not "no rank"
  assert.deepEqual(serializeStateEntry({ giftRank: 0 }), { giftRank: 0 });
  assert.equal(serializeStateEntry(null), null);
  assert.equal(serializeStateEntry({}), null);
});

test('applying a remote unwrap PRESERVES the local playback position', () => {
  // The old shape was a blind put({profileId, key, unwrappedAt}) — it erased the local
  // record wholesale, so every pull threw away where the child stopped.
  assert.deepEqual(
    mergeAppliedState({ posSec: 61, durSec: 300, posAt: 5, giftRank: 2 }, { unwrappedAt: 9 }),
    { unwrappedAt: 9, posSec: 61, durSec: 300, posAt: 5 });
  // giftRank is deliberately DROPPED once unwrapped — db.unwrapGift semantics
  assert.equal(mergeAppliedState({ giftRank: 2 }, { unwrappedAt: 9 }).giftRank, undefined);
  // unwrappedAt is min-merged: the EARLIEST open wins ("unwrappedAt is forever")
  assert.equal(mergeAppliedState({ unwrappedAt: 4 }, { unwrappedAt: 9 }).unwrappedAt, 4);
  assert.equal(mergeAppliedState({ unwrappedAt: 9 }, { unwrappedAt: 4 }).unwrappedAt, 4);
  // a remote giftRank applies NOTHING (remote-only rule, unchanged since v1.0.4)
  assert.equal(mergeAppliedState(null, { giftRank: 5 }), null);
  assert.equal(mergeAppliedState({ posSec: 61 }, { giftRank: 5 }), null);
  assert.equal(mergeAppliedState({ posSec: 61 }, {}), null);
  // a fresh device (no local record) simply adopts the unwrap
  assert.deepEqual(mergeAppliedState(null, { unwrappedAt: 9 }), { unwrappedAt: 9 });
});
