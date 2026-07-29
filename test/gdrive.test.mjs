// Drive DB pure-merge tests — the two properties that make server-free convergence
// safe: commutativity and idempotence. Plus the serialization refusal list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeDb, parseDb, mergeDbFiles } from '../www/js/drive.js';

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

test('serializeDb refusal list: no localPath, no thumbId, no backfillCursor', () => {
  const json = serializeDb({
    profiles: [],
    libraries: {
      'lib:x': {
        videos: [vid('yt:aaaaaaaaaaa', { localPath: 'videos/x.mp4', thumbId: 'file:abc' })],
        channels: [{ channelId: 'UCabcdefghijklmnopqrstuv', backfillCursor: 'PAGE_TOKEN' }],
        denylist: [], libraryChannels: []
      }
    },
    profileState: {}
  });
  assert.ok(!json.includes('localPath'));
  assert.ok(!json.includes('thumbId'));
  assert.ok(!json.includes('backfillCursor'));
  assert.ok(!json.includes('PAGE_TOKEN'));
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
