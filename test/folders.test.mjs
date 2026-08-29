// v1.0.56 — parent-created folders: the pure decisions, the Drive convergence trio, and
// the folder-art providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomFolder, normalizeFolderTitle, customFolderId, customFolderTitleClash,
  folderPickOptions, planFolderDeletion, groupLibraryByFolder, FOLDER_TITLE_MAX
} from '../www/js/plan.js';
import {
  mergeCustomFolder, mergeDeletedCustomFolders, customFolderOutlivesTombstone,
  planCustomFolderApply, mergeDbFiles
} from '../www/js/drive.js';
import {
  parseCommonsImages, parseOpenverseImages, mergeArtCandidates,
  commonsSearchUrl, openverseSearchUrl, ART_CANDIDATES
} from '../www/js/folderart.js';

/* ---------------- ids and titles ---------------- */

test('a custom folder id is recognizable and unique per creation', () => {
  const a = customFolderId(1700000000000, 0.5);
  const b = customFolderId(1700000000000, 0.9);
  assert.ok(isCustomFolder(a));
  assert.notEqual(a, b, 'two folders minted in the same millisecond must not collide');
  // it must never be mistaken for one of the built-in folder kinds
  for (const other of ['sheet', 'mine', 'new', 'fav', 'ch:UC123', 'pl:PL1', 'grp:UC1', '~pending']) {
    assert.equal(isCustomFolder(other), false, other + ' read as a custom folder');
  }
});

test('a folder title is bounded BY CODE POINT — an emoji is never cut in half', () => {
  assert.equal(normalizeFolderTitle('  שירי   ערש  '), 'שירי ערש');
  assert.equal(normalizeFolderTitle(null), '');
  const long = normalizeFolderTitle('🦁'.repeat(FOLDER_TITLE_MAX + 8));
  assert.equal([...long].length, FOLDER_TITLE_MAX);
  // the v1.0.26 lesson: assert on an UNPAIRED surrogate — a kept 🦁 legitimately ends in
  // a low surrogate, so a naive /[\uD800-\uDFFF]$/ would fire on the CORRECT result too
  assert.doesNotMatch(long, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'a surrogate pair was split');
  assert.doesNotMatch(long, /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'a lone low surrogate survived');
});

test('a duplicate folder name is caught on the NORMALIZED title', () => {
  const folders = [{ folderId: 'cf:a', title: 'חיות' }, { folderId: 'cf:b', title: 'רכבות' }];
  assert.equal(customFolderTitleClash('חיות ', folders).folderId, 'cf:a');
  assert.equal(customFolderTitleClash('  חיות', folders).folderId, 'cf:a');
  assert.equal(customFolderTitleClash('דינוזאורים', folders), null);
  // renaming a folder must not clash with ITSELF
  assert.equal(customFolderTitleClash('חיות', folders, { exceptId: 'cf:a' }), null);
  assert.equal(customFolderTitleClash('', folders), null);
  assert.equal(customFolderTitleClash('חיות', null), null);
});

/* ---------------- the destination picker ---------------- */

test('the picker always offers the DEFAULT first — one tap keeps the old behaviour', () => {
  const rows = folderPickOptions([
    { folderId: 'cf:b', title: 'רכבות', order: 20 },
    { folderId: 'cf:a', title: 'חיות', order: 10 }
  ]);
  assert.equal(rows[0].folderId, 'sheet');
  assert.equal(rows[0].isDefault, true);
  assert.deepEqual(rows.slice(1).map((r) => r.folderId), ['cf:a', 'cf:b'], 'custom folders sort by order');
  // junk in the store cannot produce a bogus destination
  assert.deepEqual(folderPickOptions([null, { folderId: 'ch:UC1', title: 'ערוץ' }]).map((r) => r.folderId), ['sheet']);
  assert.deepEqual(folderPickOptions(null).map((r) => r.folderId), ['sheet']);
});

/* ---------------- deletion ---------------- */

test('deleting a folder: an empty one asks nothing, a full one states what happens', () => {
  const empty = planFolderDeletion({ title: 'חיות', count: 0 });
  assert.equal(empty.needsChoice, false);
  assert.equal(empty.deletes, 0);

  const move = planFolderDeletion({ title: 'חיות', count: 3 });
  assert.equal(move.mode, 'move');
  assert.equal(move.moves, 3);
  assert.equal(move.deletes, 0, 'the default answer must never delete a video');
  assert.match(move.text, /סרטונים נוספים/, 'the text must say WHERE the videos go');
  assert.match(move.text, /לא יימחק/, 'the safe answer must say nothing is deleted');

  const purge = planFolderDeletion({ title: 'חיות', count: 3, mode: 'purge' });
  assert.equal(purge.deletes, 3);
  assert.match(purge.text, /לצמיתות/);
  assert.match(purge.text, /לא ניתן יהיה לשחזר/, 'an irreversible answer must SAY it is irreversible');

  // Hebrew singular/plural (hebCount appends "אחד" after its noun, which reads wrong with
  // a verb — this pins the hand-written phrasing that replaced it)
  assert.match(planFolderDeletion({ title: 'x', count: 1 }).text, /הסרטון שבתוכה יעבור/);
  assert.doesNotMatch(planFolderDeletion({ title: 'x', count: 1 }).text, /אחד/);
});

/* ---------------- the parent's library grouping ---------------- */

test('a custom folder gets its OWN section in the parent list, named or not', () => {
  const recs = [
    { key: 'yt:1', folderId: 'cf:a' },
    { key: 'yt:2', folderId: 'sheet' },
    { key: 'yt:3', folderId: 'cf:zz' } // a peer's folder whose metadata has not synced yet
  ];
  const groups = groupLibraryByFolder(recs, [], [{ folderId: 'cf:a', title: 'חיות', order: 5 }]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  assert.equal(byId.get('cf:a').title, 'חיות');
  assert.equal(byId.get('cf:a').records.length, 1);
  // the unknown folder must NOT be folded into "סרטונים נוספים" — that would tell the
  // parent these videos live somewhere they do not, and disagree with the child's home
  assert.ok(byId.has('cf:zz'), 'an unknown custom folder lost its own section');
  assert.equal(byId.get('cf:zz').title, 'תיקיה');
  assert.equal(byId.get('sheet').records.length, 1);
  // the old two-argument call still works (no third argument = no custom metadata)
  assert.equal(groupLibraryByFolder(recs, []).find((g) => g.id === 'cf:a').records.length, 1);
});

/* ---------------- Drive convergence ---------------- */

test('mergeCustomFolder is LWW, commutative and idempotent', () => {
  const a = { folderId: 'cf:1', title: 'חיות', updatedAt: 100 };
  const b = { folderId: 'cf:1', title: 'חיות גדולות', updatedAt: 200 };
  assert.equal(mergeCustomFolder(a, b).title, 'חיות גדולות');
  assert.equal(mergeCustomFolder(b, a).title, 'חיות גדולות', 'not commutative');
  assert.deepEqual(mergeCustomFolder(a, a), a, 'not idempotent');
  assert.deepEqual(mergeCustomFolder(null, b), b);
  assert.deepEqual(mergeCustomFolder(a, null), a);
  // an exact tie takes the richer row, deterministically (so it stays commutative)
  const plain = { folderId: 'cf:1', title: 'x', updatedAt: 50 };
  const withArt = { folderId: 'cf:1', title: 'x', updatedAt: 50, artThumbId: 'cfart:cf:1' };
  assert.equal(mergeCustomFolder(plain, withArt).artThumbId, 'cfart:cf:1');
  assert.equal(mergeCustomFolder(withArt, plain).artThumbId, 'cfart:cf:1');
});

test('a deleted folder STAYS deleted across a union — and a tie deletes', () => {
  assert.deepEqual(mergeDeletedCustomFolders({ 'cf:1': 10 }, { 'cf:1': 40, 'cf:2': 5 }),
    { 'cf:1': 40, 'cf:2': 5 });
  assert.deepEqual(mergeDeletedCustomFolders(null, undefined), {});

  // strictly newer survives; equal timestamps delete (the siteEntry/resolveCuration rule:
  // showing a child a folder the parent removed is the betrayal)
  assert.equal(customFolderOutlivesTombstone({ updatedAt: 41 }, 40), true);
  assert.equal(customFolderOutlivesTombstone({ updatedAt: 40 }, 40), false);
  assert.equal(customFolderOutlivesTombstone(null, 40), false);

  const plan = planCustomFolderApply({
    localRows: [{ folderId: 'cf:gone', updatedAt: 5 }, { folderId: 'cf:keep', updatedAt: 99 }],
    remoteRows: [{ folderId: 'cf:gone', updatedAt: 5 }, { folderId: 'cf:new', updatedAt: 7 }],
    localTombs: {}, remoteTombs: { 'cf:gone': 50 }
  });
  assert.deepEqual(plan.deletes, ['cf:gone'], 'a peer\'s tombstone must delete the local row');
  assert.deepEqual(plan.puts.map((p) => p.folderId), ['cf:new'], 'a tombstoned row must not be re-put');
  assert.equal(plan.tombs['cf:gone'], 50);
});

test('folders ride the Drive doc, and an OLDER app\'s document is harmless', () => {
  const withFolders = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: {
      'lib:p:1': {
        videos: [], denylist: [], channels: [], libraryChannels: [],
        customFolders: [{ folderId: 'cf:1', title: 'חיות', updatedAt: 100 }],
        deletedCustomFolders: {}
      }
    }
  };
  // an older app writes NO customFolders key at all — merging must keep ours, not wipe it
  const older = {
    kind: 'kids-player-db', schema: 1, profiles: [],
    libraries: { 'lib:p:1': { videos: [], denylist: [], channels: [], libraryChannels: [] } }
  };
  for (const [x, y] of [[withFolders, older], [older, withFolders]]) {
    const m = mergeDbFiles(x, y);
    assert.deepEqual(m.libraries['lib:p:1'].customFolders.map((f) => f.folderId), ['cf:1'],
      'an older doc erased the folders');
    assert.deepEqual(m.libraries['lib:p:1'].deletedCustomFolders, {});
  }
  // and the merge stays idempotent
  assert.deepEqual(mergeDbFiles(withFolders, withFolders).libraries['lib:p:1'].customFolders,
    withFolders.libraries['lib:p:1'].customFolders);
});

/* ---------------- folder art ---------------- */

test('the image-search URLs are keyless, encoded, and ask for a small thumbnail', () => {
  const c = commonsSearchUrl('שירי ערש');
  assert.match(c, /^https:\/\/commons\.wikimedia\.org\//);
  assert.doesNotMatch(c, /[?&]key=/, 'the folder-art search must never carry an API key');
  assert.match(c, /filetype%3Abitmap/, 'SVG/PDF results are not folder pictures');
  assert.match(c, /iiurlwidth=320/);
  assert.match(c, /origin=\*/, 'without this the browser preview cannot read the answer');

  const o = openverseSearchUrl('dinosaur');
  assert.match(o, /^https:\/\/api\.openverse\.org\//);
  assert.match(o, /mature=false/);
  assert.doesNotMatch(o, /[?&]key=/);
});

test('both image parsers are TOTAL and refuse non-https thumbnails', () => {
  // Commons answers a pages OBJECT keyed by page id, not an array
  const commons = {
    query: {
      pages: {
        123: { title: 'File:Dinosaur cake.jpg', imageinfo: [{ thumburl: 'https://x/a.jpg' }] },
        456: { title: 'File:No info.jpg' },                                  // no imageinfo
        789: { title: 'File:Insecure.jpg', imageinfo: [{ thumburl: 'http://x/b.jpg' }] }
      }
    }
  };
  const rows = parseCommonsImages(commons);
  assert.equal(rows.length, 1, 'an http thumbnail or a missing imageinfo must be dropped');
  assert.equal(rows[0].thumbUrl, 'https://x/a.jpg');
  assert.equal(rows[0].title, 'Dinosaur cake', 'the File: prefix and extension are stripped');

  assert.deepEqual(parseOpenverseImages({ results: [{ thumbnail: 'https://y/1.jpg', title: 'T' }] }),
    [{ thumbUrl: 'https://y/1.jpg', title: 'T', source: 'openverse' }]);

  for (const bad of [null, undefined, '', 0, [], {}, { query: {} }, { query: { pages: [] } }, { results: 'x' }]) {
    assert.deepEqual(parseCommonsImages(bad), [], 'commons parser threw or invented rows');
    assert.deepEqual(parseOpenverseImages(bad), [], 'openverse parser threw or invented rows');
  }
});

test('candidates merge in provider order, dedupe, and cap', () => {
  const commons = [{ thumbUrl: 'https://a' }, { thumbUrl: 'https://b' }];
  const openverse = [{ thumbUrl: 'https://b' }, { thumbUrl: 'https://c' }];
  assert.deepEqual(mergeArtCandidates([commons, openverse]).map((r) => r.thumbUrl),
    ['https://a', 'https://b', 'https://c'], 'commons leads (measured: it resolves Hebrew concepts)');
  assert.equal(mergeArtCandidates([Array.from({ length: 20 }, (_, i) => ({ thumbUrl: 'https://' + i }))]).length,
    ART_CANDIDATES);
  assert.deepEqual(mergeArtCandidates(null), []);
  assert.deepEqual(mergeArtCandidates([null, [null, { thumbUrl: '' }]]), []);
});
