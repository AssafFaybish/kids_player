// Migration-plan tests — the invariants that protect the user's existing library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigration, dataUrlToBytes } from '../www/js/migrate.js';

const ITEMS = [
  { type: 'youtube', id: 'aaaaaaaaaaa', key: 'yt:aaaaaaaaaaa', srcUrl: 'https://youtu.be/aaaaaaaaaaa', title: 'א', thumb: null, addedAt: 100 },
  { type: 'youtube', id: 'bbbbbbbbbbb', key: 'yt:bbbbbbbbbbb', srcUrl: 'https://youtu.be/bbbbbbbbbbb', title: 'ב', thumb: null, addedAt: 300 },
  { type: 'file', url: 'https://cdn/x.mp4', srcUrl: 'https://cdn/x.mp4', key: 'file:https://cdn/x.mp4', title: 'ג', thumb: 'data:image/jpeg;base64,aGk=', localPath: 'videos/x.mp4', addedAt: 200 }
];

test('manual-mode display order (newest addedAt first) is preserved as descending sortKeys', () => {
  const { videos } = planMigration({ profileId: 'p1', items: ITEMS, source: { mode: 'manual', url: '' }, now: 999 });
  const shown = videos.slice().sort((a, b) => b.sortKey - a.sortKey).map((v) => v.title);
  assert.deepEqual(shown, ['ב', 'ג', 'א']); // addedAt 300, 200, 100
});

test('remote-mode file order is preserved (row 0 shown first, as today)', () => {
  const { videos } = planMigration({ profileId: 'p1', items: ITEMS, source: { mode: 'remote', url: 'https://docs.google.com/spreadsheets/d/S/edit' }, now: 999 });
  const shown = videos.slice().sort((a, b) => b.sortKey - a.sortKey).map((v) => v.title);
  assert.deepEqual(shown, ['א', 'ב', 'ג']); // file order, not reversed — reversal applies to FUTURE syncs
});

test('no legacy item is ever gift-wrapped, and curation fields are carried', () => {
  const { videos } = planMigration({ profileId: 'p1', items: ITEMS, source: { mode: 'manual', url: '' }, now: 999 });
  for (const v of videos) {
    assert.equal(v.origin, 'legacy');
    assert.equal(v.state, 'live');
    assert.equal(v.folderId, 'mine');
    assert.equal(v.giftRank, undefined);
  }
  const file = videos.find((v) => v.type === 'file');
  assert.equal(file.localPath, 'videos/x.mp4'); // downloaded bytes stay reachable
  assert.equal(file.addedAt, 200);
});

test('base64 thumbs split into thumb jobs; http thumbs stay as thumbUrl', () => {
  const items = [
    ITEMS[2],
    { ...ITEMS[0], thumb: 'https://i.example/t.jpg' }
  ];
  const { videos, thumbs } = planMigration({ profileId: 'p1', items, source: { mode: 'manual', url: '' } });
  const file = videos.find((v) => v.type === 'file');
  assert.ok(file.thumbId);
  assert.equal(file.thumbUrl, null);
  assert.equal(thumbs.length, 1);
  assert.equal(thumbs[0].id, file.thumbId);
  const yt = videos.find((v) => v.type === 'youtube');
  assert.equal(yt.thumbUrl, 'https://i.example/t.jpg');
  assert.equal(yt.thumbId, null);
});

test('a legacy remote source still derives its libraryId — but keeps NO sheet url (v1.0.44)', () => {
  // The sheet URL used to be stored so the v1.0.38 sunset could do one final read of it.
  // The sunset is gone, so storing it would leave a field nothing can ever clear — and the
  // scope it derives is IMMUTABLE (decision 20), which is why the derivation stays.
  const url = 'https://docs.google.com/spreadsheets/d/SHEET/edit#gid=0';
  const { sources } = planMigration({ profileId: 'p1', items: [], source: { mode: 'remote', url } });
  assert.ok(!('sheetUrl' in sources), 'the migration stores a sheet url again — nothing clears it now');
  assert.ok(!('sheetHash' in sources), 'sheetHash was vestigial before the sunset and is dead after it');
  assert.match(sources.libraryId, /^lib:[0-9a-f]{8}$/, 'the legacy scope must still be derived from the url');
  // KEPT deliberately: sync2's quarantine reads this to route a legacy family's unknown keys
  // to 'pending' instead of resurrecting videos they had deleted in the pre-overhaul app.
  assert.equal(sources.legacySheetMigrated, true);
});

test('manual source migrates with no library', () => {
  const { sources } = planMigration({ profileId: 'p1', items: [], source: { mode: 'manual', url: '' } });
  assert.equal(sources.libraryId, null);
  assert.ok(!('sheetUrl' in sources));
});

test('dataUrlToBytes decodes base64 and percent-encoded; malformed → null, never throws', () => {
  const b64 = dataUrlToBytes('data:image/jpeg;base64,aGk=');
  assert.equal(b64.mime, 'image/jpeg');
  assert.deepEqual(Array.from(b64.bytes), [104, 105]); // "hi"

  const plain = dataUrlToBytes('data:text/plain,hi%20there');
  assert.equal(new TextDecoder().decode(plain.bytes), 'hi there');

  assert.equal(dataUrlToBytes('not-a-data-url'), null);
  assert.equal(dataUrlToBytes(null), null);
  assert.equal(dataUrlToBytes('data:image/jpeg;base64,@@@invalid@@@'), null);
});
