// linksfile.js + its plan.js decisions — the links file that replaced the Google-Sheets
// sources list (v1.0.38).
//
// The load-bearing test in here is the A→B ROUND TRIP: a file written on one device must
// reproduce the same sources on another, key-for-key. Everything else guards one of the
// three ways that can silently fail — a link form that reads back as a different KIND
// (`&list=` on a watch URL imports a whole playlist), a video that a subscription already
// reproduces getting its own line (double import, and it re-adds rejected videos), and an
// unreadable file reading as an empty one (the interpretSheetResponse doctrine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINKS_FILE_VERSION, parseSourceRows, linksFileHeader, profileNameFromLines,
  canonicalLinkFor, serializeLinksFile, parseLinksFile, linksFileName,
  serializeLinksExport, sectionMarkerLine, sectionNameOf, matchSectionTargets
} from '../www/js/linksfile.js';
import { parseCsv } from '../www/js/csv.js';
import {
  channelRowSubscription, manualVideoRecord, coveredBySubscription, deniedReAddPrompt,
  deniedRestorePrompt, linksImportConfirm, linksImportOutcome, linksExportOutcome,
  planOrphanGC, LINKS_IMPORT_MAX, hebCount, hebCountF,
  hebList, linksExportSelection, linksCopyOutcome, linksSectionsConfirm, linksSectionsOutcome,
  LINKS_CHAT_MAX_CHARS
} from '../www/js/plan.js';

const CH_A = 'UCbCmjCuTUZos6Inko4u57UQ';
const CH_B = 'UCWF5vshm5UfF59-rtvsE5WA';
const PL_A = 'PLBCF2DAC6FFB574DE';
const VID_A = 'dQw4w9WgXcQ';
const VID_B = 'sFU5TdYp8u8';

const vid = (id, over = {}) => ({
  key: 'yt:' + id, type: 'youtube', id, srcUrl: 'https://www.youtube.com/watch?v=' + id,
  title: 'שיר ' + id, state: 'live', folderId: 'sheet', channelId: null, sortKey: 100, ...over
});

/* ==================== canonical links ==================== */

test('canonicalLinkFor: the four representable shapes, and nothing else', () => {
  assert.equal(canonicalLinkFor({ kind: 'channel', channelId: CH_A }),
    'https://www.youtube.com/channel/' + CH_A);
  assert.equal(canonicalLinkFor({ kind: 'playlist', playlistId: PL_A }),
    'https://www.youtube.com/playlist?list=' + PL_A);
  assert.equal(canonicalLinkFor({ type: 'youtube', id: VID_A }),
    'https://www.youtube.com/watch?v=' + VID_A);
  assert.equal(canonicalLinkFor({ type: 'file', srcUrl: 'https://x.test/a.mp4' }), 'https://x.test/a.mp4');
  // not representable -> null, so the caller can COUNT it instead of dropping it silently
  assert.equal(canonicalLinkFor({ kind: 'channel', channelId: 'nope' }), null);
  assert.equal(canonicalLinkFor({ type: 'youtube', id: 'short' }), null);
  assert.equal(canonicalLinkFor({ type: 'file', srcUrl: 'http://insecure.test/a.mp4' }), null);
  assert.equal(canonicalLinkFor({}), null);
  assert.equal(canonicalLinkFor(null), null);
});

test('a YouTube video NEVER exports its stored srcUrl — that is how a video becomes a playlist', () => {
  // Every one of these is a real stored srcUrl shape. classifySourceRow reads the FIRST as
  // a video only because the watch link wins — but `&list=` reaching another device inside
  // a file that gets re-parsed is exactly the kind of thing that imports 200 videos, and a
  // `?si=` / m.youtube / `?t=` form is a different STRING for the same key.
  for (const srcUrl of [
    'https://www.youtube.com/watch?v=' + VID_A + '&list=' + PL_A,
    'https://youtu.be/' + VID_A + '?si=abcd1234',
    'https://m.youtube.com/watch?v=' + VID_A,
    'https://www.youtube.com/watch?v=' + VID_A + '&t=42'
  ]) {
    const out = serializeLinksFile({ videos: [vid(VID_A, { srcUrl })] });
    assert.ok(out.text.includes('https://www.youtube.com/watch?v=' + VID_A),
      'the canonical watch form must be written');
    assert.ok(!out.text.includes('list='), 'a list= parameter must never reach the file');
    assert.ok(!out.text.includes('si='), 'tracking parameters must never reach the file');
    assert.ok(!out.text.includes('m.youtube'), 'the mobile host must never reach the file');
    // and it must read back as a VIDEO, not as a playlist
    const back = parseLinksFile(out.text);
    assert.equal(back.counts.videos, 1);
    assert.equal(back.counts.playlists, 0);
  }
});

/* ==================== the header ==================== */

test('every header line is a COMMENT the parser skips — that is the mechanism, not a convention', () => {
  const lines = linksFileHeader({ profileName: 'נועם', appVersion: '1.0.38', exportedAt: Date.parse('2026-08-10T09:00:00') });
  assert.ok(lines.length >= 4);
  for (const l of lines) assert.ok(l.startsWith('#'), `header line is not a comment: ${l}`);
  const parsed = parseSourceRows(lines.map((l) => [l]));
  assert.deepEqual(parsed.videoRows, []);
  assert.deepEqual(parsed.channelRows, []);
  assert.deepEqual(parsed.playlistRows, []);
  assert.deepEqual(parsed.removedKeys, [], 'a header line must never read as a REMOVAL');
  assert.deepEqual(parsed.invalid, []);
  // the legend has to teach the grammar the importer implements
  const all = lines.join('\n');
  assert.match(all, /שורה אחת = לינק אחד/);
  assert.match(all, /auto\|manual/);
  assert.match(all, new RegExp('פורמט: ' + LINKS_FILE_VERSION));
});

test('profileNameFromLines: the marker round-trips, and a hostile value never becomes a profile', () => {
  assert.equal(profileNameFromLines(linksFileHeader({ profileName: 'נועם' })), 'נועם');
  assert.equal(profileNameFromLines(['# פרופיל: דני']), 'דני');
  assert.equal(profileNameFromLines(['# profile: Dana']), 'Dana');
  // untrusted input: capped and whitespace-collapsed by store.normalizeProfileName
  assert.equal(profileNameFromLines(['# פרופיל:   a   b  ']), 'a b');
  assert.equal(profileNameFromLines(['# פרופיל: ' + 'מ'.repeat(50)]), 'מ'.repeat(20));
  // a link is not a name
  assert.equal(profileNameFromLines(['# פרופיל: https://x.test/a']), '');
  // absent / junk
  assert.equal(profileNameFromLines(['# הסרטונים שלי']), '');
  assert.equal(profileNameFromLines([]), '');
  assert.equal(profileNameFromLines(null), '');
  // only scanned near the top: a line deep in a long file is not a header
  const deep = [...Array(60).fill('# x'), '# פרופיל: לא'];
  assert.equal(profileNameFromLines(deep), '');
});

test('linksFileName keeps Hebrew, strips everything unsafe, and always has a name', () => {
  const at = Date.parse('2026-08-10T09:00:00');
  assert.equal(linksFileName('נועם', at), 'kids-player-links-נועם-2026-08-10.txt');
  assert.equal(linksFileName('a/b:c*d', at), 'kids-player-links-abcd-2026-08-10.txt');
  assert.equal(linksFileName('  two  words ', at), 'kids-player-links-two-words-2026-08-10.txt');
  assert.equal(linksFileName('', at), 'kids-player-links-profile-2026-08-10.txt');
  assert.equal(linksFileName('***', at), 'kids-player-links-profile-2026-08-10.txt');
});

/* ==================== what gets a line ==================== */

test('only LIVE records travel — pending and rejected are not decisions a file may carry', () => {
  const out = serializeLinksFile({
    videos: [
      vid(VID_A),
      vid(VID_B, { state: 'pending', folderId: '~pending', homeFolderId: 'sheet' }),
      vid('ccccccccccc', { state: 'rejected', folderId: '~rejected', homeFolderId: 'sheet' })
    ]
  });
  assert.equal(out.counts.videos, 1);
  assert.ok(out.text.includes(VID_A));
  assert.ok(!out.text.includes(VID_B), 'a PENDING video must not travel as a plain add');
  assert.ok(!out.text.includes('ccccccccccc'), 'a REJECTED video must not travel as a plain add');
});

test('a video some SUBSCRIPTION reproduces gets no line of its own', () => {
  const subs = [{ channelId: CH_A }, { channelId: PL_A, kind: 'playlist' }];
  const videos = [
    vid(VID_A, { channelId: CH_A, folderId: 'ch:' + CH_A }),          // the channel line covers it
    vid(VID_B, { channelId: CH_B, folderId: 'pl:' + PL_A }),          // the playlist line covers it
    vid('ddddddddddd')                                                 // genuinely loose
  ];
  const out = serializeLinksFile({ subscriptions: subs, videos });
  assert.equal(out.counts.videos, 1, 'only the loose video earns a line');
  assert.equal(out.counts.channels, 1);
  assert.equal(out.counts.playlists, 1);
  assert.ok(out.text.includes('ddddddddddd'));
  assert.ok(!out.text.includes(VID_A));
});

test('coveredBySubscription reads planOrphanGC forwards — the two can never disagree', () => {
  const subs = [{ channelId: CH_A }, { channelId: PL_A, kind: 'playlist' }];
  const records = [
    vid(VID_A, { channelId: CH_A, folderId: 'ch:' + CH_A }),
    vid(VID_B, { channelId: CH_B, folderId: 'pl:' + PL_A }),
    vid('eeeeeeeeeee', { channelId: CH_B, folderId: 'ch:' + CH_B }), // orphan: nothing claims it
    vid('fffffffffff')                                               // no channelId: never an orphan
  ];
  const orphans = new Set(planOrphanGC(records, subs));
  for (const r of records) {
    const covered = coveredBySubscription(r, subs);
    if (covered) assert.ok(!orphans.has(r.key), `${r.key}: covered but the GC would delete it`);
    // the converse only holds for records the GC has an opinion about (it ignores channel-less ones)
    if (r.channelId && !covered) assert.ok(orphans.has(r.key), `${r.key}: uncovered but the GC keeps it`);
  }
  assert.equal(coveredBySubscription(null, subs), false);
  assert.equal(coveredBySubscription(vid(VID_A), []), false);
});

test('a PARKED playlist video is judged by its home folder, like the GC judges it', () => {
  const subs = [{ channelId: PL_A, kind: 'playlist' }];
  const parked = vid(VID_A, { channelId: CH_B, state: 'pending', folderId: '~pending', homeFolderId: 'pl:' + PL_A });
  assert.equal(coveredBySubscription(parked, subs), true);
});

/* ==================== the round trip ==================== */

test('A→B ROUND TRIP: a file written on one device reproduces the same sources on another', () => {
  const subscriptions = [
    { channelId: CH_A, autoApprove: true, titleOverride: 'רחוב סומסום' },
    { channelId: CH_B, autoApprove: false, titleOverride: '' },
    { channelId: PL_A, kind: 'playlist', autoApprove: false, titleOverride: 'שירי בוקר' }
  ];
  const channelMeta = new Map([[CH_B, { title: 'ערוץ ב' }]]);
  const videos = [
    vid(VID_A, { title: 'פרפרים, חלק 2' }),               // a comma inside the title
    { key: 'file:https://x.test/a.mp4', type: 'file', srcUrl: 'https://x.test/a.mp4', title: '', state: 'live', folderId: 'sheet', sortKey: 5 }
  ];
  const out = serializeLinksFile({ subscriptions, channelMeta, videos, profileName: 'נועם', appVersion: '1.0.38' });

  const back = parseLinksFile(out.text);
  assert.equal(back.ok, true);
  assert.equal(back.error, null);
  assert.equal(back.profileName, 'נועם');
  assert.equal(back.counts.channels, 2);
  assert.equal(back.counts.playlists, 1);
  assert.equal(back.counts.videos, 2);
  assert.equal(back.counts.invalid, 0, 'every written line must read back as a source');

  // channels keep their id AND their auto/manual answer
  const byId = new Map(back.channels.map((c) => [c.channelRef.value, c]));
  assert.equal(byId.get(CH_A).flag, 'auto');
  assert.equal(byId.get(CH_A).title, 'רחוב סומסום');
  assert.equal(byId.get(CH_B).flag, '');
  assert.equal(byId.get(CH_B).title, 'ערוץ ב', 'the channels-store title is used when there is no override');
  assert.equal(back.playlists[0].playlistId, PL_A);

  // videos keep their KEY — the whole point of the canonical forms
  assert.deepEqual(back.videos.map((v) => v.key).sort(), ['file:https://x.test/a.mp4', 'yt:' + VID_A].sort());
  // …and a title with a comma survives the CSV round trip
  assert.equal(back.videos.find((v) => v.key === 'yt:' + VID_A).title, 'פרפרים, חלק 2');
});

test('re-exporting an unchanged library is byte-identical, in any input order', () => {
  const subscriptions = [
    { channelId: CH_B, autoApprove: false, titleOverride: 'ב' },
    { channelId: CH_A, autoApprove: true, titleOverride: 'א' }
  ];
  const videos = [vid(VID_A, { sortKey: 1 }), vid(VID_B, { sortKey: 2 })];
  const at = Date.parse('2026-08-10T09:00:00');
  const a = serializeLinksFile({ subscriptions, videos, exportedAt: at });
  const b = serializeLinksFile({ subscriptions: [...subscriptions].reverse(), videos: [...videos].reverse(), exportedAt: at });
  assert.equal(a.text, b.text, 'the order must come from the DATA, not from the iteration');
});

test('the sheet grammar still imports — an old spreadsheet pasted in as CSV', () => {
  // exactly what the Sheets CSV export produced, quoted Hebrew title and all
  const csv = '# עמודה A · לינק,עמודה B · שם,עמודה C\n'
    + `https://youtu.be/${VID_A},"פרפרים, חלק 2",\n`
    + `https://www.youtube.com/@SuperSimpleSongs,שירים,auto\n`
    + `https://www.youtube.com/channel/${CH_A},,manual\n`
    + `# הוסר: https://youtu.be/${VID_B} — משהו\n`;
  const out = parseLinksFile(csv);
  assert.equal(out.ok, true);
  assert.equal(out.counts.videos, 1);
  assert.equal(out.counts.channels, 2);
  assert.equal(out.videos[0].title, 'פרפרים, חלק 2');
  assert.equal(out.channels.find((c) => c.channelRef.by === 'handle').flag, 'auto');
  // a removal marker is COUNTED and REPORTED, never applied: an imported file must not
  // deny a key on every device forever (CLAUDE.md — a removal row defeats every restore).
  assert.equal(out.counts.removed, 1);
  assert.deepEqual(out.removedKeys, ['yt:' + VID_B]);
});

/* ==================== refusing to guess ==================== */

test('an unreadable file is NEVER an empty one', () => {
  const html = '<!DOCTYPE html><html><body>Request access</body></html>';
  const r = parseLinksFile(html);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'html', 'a saved permission page must not read as "0 links"');
  assert.equal(parseLinksFile('').error, 'empty');
  assert.equal(parseLinksFile('   \n\n').error, 'empty');
  assert.equal(parseLinksFile('# only comments\n# nothing else').error, 'no-links');
  assert.equal(parseLinksFile('hello world\nnot a link').error, 'no-links');
  assert.equal(parseLinksFile('x'.repeat(50), { maxBytes: 10 }).error, 'too-big');
});

test('parseLinksFile is TOTAL — no input throws', () => {
  for (const junk of [undefined, null, 0, 1, true, {}, [], [[]], 'javascript:alert(1)',
    '  ', '"""', ',,,,', '\n'.repeat(500), { toString() { throw new Error('x'); } }]) {
    const r = parseLinksFile(junk);
    assert.equal(typeof r, 'object');
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.videos) && Array.isArray(r.channels) && Array.isArray(r.playlists));
  }
});

test('a javascript: line and a bare word are REFUSED — classifySourceRow is the boundary', () => {
  const r = parseLinksFile([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://insecure.test/a.mp4',
    'just some words',
    'https://www.youtube.com/watch?v=' + VID_A
  ].join('\n'));
  assert.equal(r.counts.videos, 1, 'only the real YouTube link is a video');
  assert.equal(r.counts.invalid, 4);
  assert.ok(!JSON.stringify(r.videos).includes('javascript:'));
});

test('duplicates collapse and the cap bounds an accident', () => {
  const dup = [
    'https://www.youtube.com/watch?v=' + VID_A,
    'https://youtu.be/' + VID_A,                       // same KEY, different form
    'https://www.youtube.com/channel/' + CH_A,
    'https://www.youtube.com/channel/' + CH_A
  ].join('\n');
  const r = parseLinksFile(dup);
  assert.equal(r.counts.videos, 1);
  assert.equal(r.counts.channels, 1);

  // ids must be exactly 11 chars or classifyLink refuses them — an invalid line is
  // `invalid`, not `dropped`, and this test is about the CAP
  const many = Array.from({ length: 12 },
    (_, i) => 'https://www.youtube.com/watch?v=' + 'a'.repeat(9) + String(i).padStart(2, '0')).join('\n');
  const capped = parseLinksFile(many, { max: 5 });
  assert.equal(capped.counts.videos, 5);
  assert.equal(capped.counts.dropped, 7, 'the overflow is reported, not silently lost');
  assert.ok(LINKS_IMPORT_MAX >= 500, 'the real cap must not be small enough to bite a real family');
});

/* ==================== the record builders (one rule, two callers) ==================== */

test('channelRowSubscription: the flag IS the decision, and an absent flag is not', () => {
  const src = { libraryId: 'lib:x', defaultAutoApprove: false };
  const auto = channelRowSubscription({ channelId: CH_A, flag: 'auto' }, src, { now: 5 });
  assert.equal(auto.autoApprove, true);
  assert.equal(auto.decidedAt, 5, 'an explicit flag IS the sync decision (v1.0.32)');
  assert.equal(auto.autoApproveSource, 'file');

  const manual = channelRowSubscription({ channelId: CH_A, flag: 'manual' }, src, { now: 5 });
  assert.equal(manual.autoApprove, false);
  assert.equal(manual.decidedAt, 5);

  const bare = channelRowSubscription({ channelId: CH_A }, src, { now: 5 });
  assert.equal(bare.autoApprove, false);
  assert.equal(bare.decidedAt, null, 'a flagless row must surface in "ערוצים חדשים" instead');
  assert.equal(bare.autoApproveSource, 'default');

  const dflt = channelRowSubscription({ channelId: CH_A }, { libraryId: 'lib:x', defaultAutoApprove: true }, {});
  assert.equal(dflt.autoApprove, true);

  const pl = channelRowSubscription({ playlistId: PL_A, kind: 'playlist' }, src, {});
  assert.equal(pl.kind, 'playlist');
  assert.equal(pl.channelId, PL_A, 'a playlist id lives in the channelId slot (v1.0.26)');

  // updatedAt must NOT be set here — db.putLibraryChannel stamps it (v1.0.22)
  assert.ok(!('updatedAt' in auto), 'the timestamp belongs to db.putLibraryChannel');
  // junk-safe
  assert.equal(channelRowSubscription(null, null, {}).channelId, null);
});

test('manualVideoRecord: one record shape for paste, search and file import', () => {
  const row = { key: 'yt:' + VID_A, type: 'youtube', id: VID_A, srcUrl: 'https://youtu.be/' + VID_A };
  const rec = manualVideoRecord({ row, scope: 'lib:x', title: 'שיר', sortKey: 7, now: 9 });
  assert.equal(rec.scopeId, 'lib:x');
  assert.equal(rec.key, 'yt:' + VID_A);
  assert.equal(rec.folderId, 'sheet', 'the ⭐ loose folder id — not a spreadsheet');
  assert.equal(rec.state, 'live');
  assert.equal(rec.origin, 'manual');
  assert.equal(rec.titleSource, 'sheet');
  assert.equal(rec.approvedAt, 9);
  assert.equal(rec.channelId, null);

  const empty = manualVideoRecord({ row, scope: 'lib:x', title: '   ' });
  assert.equal(empty.title, '');
  assert.equal(empty.titleSource, null, 'an empty title must leave the sync free to fetch one');

  const fromFile = manualVideoRecord({ row, scope: 'lib:x', origin: 'sheet-row', rowIndex: 3, sortKey: 4e12 + 3 });
  assert.equal(fromFile.origin, 'sheet-row');
  assert.equal(fromFile.rowIndex, 3, 'a file row keeps its line number, like a sheet row did');
});

/* ==================== the dialogs ==================== */

test('deniedReAddPrompt: a tombstone is revived only by an ANSWER', () => {
  assert.equal(deniedReAddPrompt({ denied: false }).ask, false, 'nothing to ask');
  assert.equal(deniedReAddPrompt({ denied: true, exists: true }).ask, false,
    'a live record already exists — asking about its tombstone is incoherent');
  assert.equal(deniedReAddPrompt({ denied: true, count: 0 }).ask, false);

  const one = deniedReAddPrompt({ denied: true, source: 'paste' });
  assert.equal(one.ask, true);
  assert.equal(one.title, 'הסרטון הזה הוסר בעבר — להחזיר אותו?');
  assert.match(one.text, /בכל המכשירים/, 'un-denying is not local, and the parent must know');

  const many = deniedReAddPrompt({ denied: true, source: 'import', count: 7 });
  assert.match(many.title, /^7 /, 'the count is IN the sentence');
  assert.match(many.text, /7/);
  assert.match(many.text, /בכל המכשירים/);
});

test('every revive dialog offers a real way to decline', () => {
  for (const source of ['paste', 'search', 'share', 'import']) {
    for (const count of [1, 5]) {
      const p = deniedReAddPrompt({ denied: true, source, count });
      assert.ok(p.ok && p.ok.trim(), `${source}/${count}: no confirm label`);
      assert.ok(p.cancel && p.cancel.trim(),
        `${source}/${count}: NO WAY TO DECLINE — a tombstone would be revoked by an accidental tap`);
    }
  }
  const r = deniedRestorePrompt(3);
  assert.ok(r.ok && r.ok.trim());
  assert.ok(r.cancel && r.cancel.trim());
  assert.equal(deniedRestorePrompt(0).ask, false);
  assert.match(deniedRestorePrompt(3, { isPlaylist: true }).title, /רשימת ההשמעה/);
  assert.match(deniedRestorePrompt(3).title, /הערוץ/);
});

test('deniedReAddPrompt and deniedRestorePrompt never throw on junk', () => {
  for (const bad of [undefined, null, {}, { count: -3 }, { count: 'x' }, { denied: true, count: NaN }]) {
    assert.equal(typeof deniedReAddPrompt(bad), 'object');
  }
  for (const bad of [undefined, null, -1, 'x', NaN]) {
    assert.equal(typeof deniedRestorePrompt(bad), 'object');
  }
});

test('linksImportConfirm: counts BY KIND, and the target profile is NAMED', () => {
  const c = linksImportConfirm({ channels: 2, playlists: 1, videos: 5 }, { targetName: 'נועם' });
  assert.match(c.text, /2 ערוצים/);
  assert.match(c.text, /רשימת השמעה אחת/);
  assert.match(c.text, /5 סרטונים/);
  assert.equal(c.ok, 'ייבוא לנועם', 'a parent in the wrong profile must see it before committing');
  assert.ok(c.cancel);
  assert.equal(c.third, undefined, 'no profile name in the file ⇒ no third button');

  const withName = linksImportConfirm({ videos: 1 }, { targetName: 'נועם', profileName: 'דני', canCreateProfile: true });
  assert.equal(withName.third, 'לפרופיל חדש בשם "דני"');

  const taken = linksImportConfirm({ videos: 1 }, { targetName: 'נועם', profileName: 'דני', canCreateProfile: false });
  assert.equal(taken.third, undefined, 'never auto-rename behind the parent (v1.0.22)');
  assert.match(taken.text, /כבר יש פרופיל/, 'and say WHY the option is missing');

  const noisy = linksImportConfirm({ videos: 1, invalid: 3, removed: 2 }, { targetName: 'נ' });
  assert.match(noisy.text, /3 שורות לא זוהו/);
  assert.match(noisy.text, /2 שורות מסומנות כמוסרות/);
  assert.equal(typeof linksImportConfirm(null, {}).text, 'string');
});

test('linksImportOutcome: every zero names its own cause, and no two branches share a sentence', () => {
  const msgs = [
    linksImportOutcome({ existed: 4 }),
    linksImportOutcome({ skippedDenied: 4 }),
    linksImportOutcome({ failed: 2 }),
    linksImportOutcome({ invalid: 9 }),
    linksImportOutcome({}),
    linksImportOutcome({ channels: 2, playlists: 1, videos: 3, pending: 40 })
  ];
  assert.equal(new Set(msgs).size, msgs.length, 'two outcomes produce the same sentence');
  for (const m of msgs) assert.ok(m && m.trim().length > 10, `weak message: ${m}`);
  assert.match(msgs[0], /כבר קיימים/);
  assert.match(msgs[1], /הוסרו בעבר/);
  assert.match(msgs[5], /40 סרטונים ממתינים לאישור/, 'the waiting count and its tab are the point');
  assert.match(msgs[5], /ממתינים/);
  const rich = linksImportOutcome({ videos: 2, revived: 2, skippedDenied: 3, existed: 4, failed: 2 });
  for (const frag of ['2 סרטונים', 'הוחזרו', 'דולגו', 'כבר היו', 'לא זוהו']) assert.ok(rich.includes(frag), frag);
});

test('the counted messages are grammatical in Hebrew for ONE of anything', () => {
  // "נוספו 1 ערוצים" is wrong in a way a parent notices immediately, and EVERY count here
  // can legitimately be 1: one channel, one revived video, one duplicate. Found in the
  // browser on a real import, not by reasoning about it.
  assert.equal(hebCount(1, 'ערוץ', 'ערוצים'), 'ערוץ אחד');
  assert.equal(hebCount(3, 'ערוץ', 'ערוצים'), '3 ערוצים');
  assert.equal(hebCountF(1, 'רשימת השמעה', 'רשימות השמעה'), 'רשימת השמעה אחת');
  assert.equal(hebCountF(2, 'רשימת השמעה', 'רשימות השמעה'), '2 רשימות השמעה');
  assert.equal(hebCount(0, 'ערוץ', 'ערוצים'), '0 ערוצים');
  assert.equal(hebCount(-5, 'ערוץ', 'ערוצים'), '0 ערוצים');
  assert.equal(hebCount('x', 'ערוץ', 'ערוצים'), '0 ערוצים');

  const one = linksImportOutcome({ channels: 1, videos: 0, playlists: 0, pending: 1, revived: 1, existed: 1, failed: 1 });
  assert.ok(!/\b1 ערוצים|\b1 סרטונים|\b1 רשימות/.test(one), `ungrammatical singular: ${one}`);
  assert.match(one, /נוסף ערוץ אחד/);
  assert.match(one, /סרטון אחד ממתין/);
  assert.match(one, /1 הוחזר ממחיקה/);
  assert.match(one, /1 כבר היה בספרייה/);
  assert.match(one, /1 מקור לא זוהה/);

  const many = linksImportOutcome({ channels: 2, playlists: 3, videos: 4, pending: 5, revived: 6, existed: 7, failed: 8 });
  assert.match(many, /נוספו 2 ערוצים · 3 רשימות השמעה · 4 סרטונים/);
  assert.match(many, /5 סרטונים ממתינים/);

  // deniedRestorePrompt too — it is the OTHER counted dialog, and it shipped ungrammatical
  // for one commit because hebCount existed and was not used there (caught in the browser).
  for (const isPlaylist of [false, true]) {
    const one = deniedRestorePrompt(1, { isPlaylist });
    assert.ok(!/\b1 סרטונים/.test(one.title + one.text), `ungrammatical singular: ${one.title}`);
    assert.match(one.title, /סרטון אחד .* הוסר בעבר/);
    assert.match(one.text, /הוא לא נוסף/);
    assert.match(one.text, /להחזיר אותו/);
    assert.equal(one.cancel, 'לא, להשאיר מוסר');
    const many = deniedRestorePrompt(4, { isPlaylist });
    assert.match(many.title, /^4 סרטונים .* הוסרו בעבר/);
    assert.match(many.text, /הם לא נוספו/);
    assert.equal(many.cancel, 'לא, להשאיר מוסרים');
  }

  const conf = linksImportConfirm({ channels: 1, playlists: 1, videos: 1 }, { targetName: 'נ' });
  assert.ok(!/\b1 ערוצים|\b1 סרטונים|\b1 רשימות/.test(conf.text), `ungrammatical singular: ${conf.text}`);
  assert.match(conf.text, /ערוץ אחד · רשימת השמעה אחת · סרטון אחד/);
});

test('linksExportOutcome: EVERY rung says where the file is, and none shares a sentence', () => {
  const dir = 'Android/data/com.assaf.kidsplayer/files/exports/';
  const name = 'kids-player-links-נועם-2026-08-10.txt';
  const counts = { channels: 2, playlists: 0, videos: 3, files: 0 };
  const rungs = ['native', 'file-only', 'locked', 'download', 'clipboard', 'shown', 'nothing', 'no-selection', 'none'];
  const seen = new Set();
  for (const delivery of rungs) {
    const r = linksExportOutcome({ delivery, name, dir, counts });
    assert.ok(r.text && r.text.trim().length > 10, `${delivery}: weak message`);
    assert.ok(!seen.has(r.text), `${delivery}: shares a sentence with another rung`);
    seen.add(r.text);
    // the two rungs that actually produced a file on the device must name where it is
    if (delivery === 'native' || delivery === 'file-only' || delivery === 'locked') {
      assert.ok(r.text.includes(dir) && r.text.includes(name), `${delivery}: does not name the file`);
    }
  }
  assert.equal(linksExportOutcome({ delivery: 'nothing' }).ok, false);
  assert.equal(linksExportOutcome({ delivery: 'no-selection' }).ok, false);
  assert.equal(linksExportOutcome({ delivery: 'native', name, dir, counts }).ok, true);
  assert.match(linksExportOutcome({ delivery: 'native', name, dir, counts }).text, /5 לינקים/);
  assert.equal(typeof linksExportOutcome({}).text, 'string');
  // v1.0.93 — the share sheet did not open: never "no app can share it" (the field cause
  // was a percent-encoded Hebrew path), and the way out is the COPY button, named.
  const fileOnly = linksExportOutcome({ delivery: 'file-only', name, dir }).text;
  assert.doesNotMatch(fileOnly, /לא נמצאה אפליקציה/, 'file-only blames a missing app again');
  assert.match(fileOnly, /📋 העתקת הרשימה/);
  assert.equal(linksExportOutcome({ delivery: 'file-only', name, dir }).shareTextFallback, undefined,
    'the share-as-text fallback is gone — the copy button is always there');
  // the kiosk lock is SAID, not folded into a generic failure — and never "a window opened"
  const locked = linksExportOutcome({ delivery: 'locked', name, dir }).text;
  assert.match(locked, /נעול/);
  assert.doesNotMatch(locked, /נפתחה חלונית/);
});

test('linksExportOutcome counts every link ONCE — a file is a video, not a second line (v1.0.93)', () => {
  // `files` is a SUBSET of `videos` (serializeLinksFile counts a file in both), and the old
  // sum added it on top: 3 channels + 2 Drive songs read "7 לינקים".
  const r = linksExportOutcome({ delivery: 'native', name: 'x.txt', dir: 'd/', counts: { channels: 3, playlists: 0, videos: 2, files: 2 } });
  assert.match(r.text, /5 לינקים/);
  assert.doesNotMatch(r.text, /7 לינקים/);
});

/* ==================== v1.0.93 — clickable links, several profiles, the copy ==================== */

const bodyOf = (lines) => lines.filter((l) => l && !l.startsWith('#'));

test('a link is followed by a SPACE before its comma — it stays clickable in a chat (v1.0.93)', () => {
  // Linkifiers treat ',' as part of a URL path: `…/channel/UC…,רחוב סומסום,auto` became ONE
  // link to a channel that does not exist. The space ends the URL for every linkifier.
  const out = serializeLinksFile({
    subscriptions: [{ channelId: CH_A, autoApprove: true, titleOverride: 'רחוב סומסום' }, { channelId: CH_B }],
    videos: [vid(VID_A, { title: 'פרפרים, חלק 2' }), vid(VID_B, { title: '' })]
  });
  const body = bodyOf(out.lines);
  assert.ok(body.includes(`https://www.youtube.com/channel/${CH_A} ,רחוב סומסום,auto`), body.join('\n'));
  // a line with nothing after the link carries no trailing space
  assert.ok(body.includes(`https://www.youtube.com/channel/${CH_B}`), body.join('\n'));
  assert.ok(body.includes(`https://www.youtube.com/watch?v=${VID_B}`), body.join('\n'));
  for (const l of body) {
    assert.match(l, /^\S+( ,|$)/, `the link must end at a space or the line end: ${l}`);
  }
  // the space goes BEFORE the comma: parseCsv opens a quote only at a field's first
  // character, so a quoted title with a comma must still read back whole
  assert.ok(body.includes(`https://www.youtube.com/watch?v=${VID_A} ,"פרפרים, חלק 2"`), body.join('\n'));
  const back = parseLinksFile(out.text);
  assert.equal(back.videos.find((v) => v.key === 'yt:' + VID_A).title, 'פרפרים, חלק 2');
  assert.equal(back.channels.find((c) => c.channelRef.value === CH_A).flag, 'auto');
  assert.equal(back.counts.invalid, 0);
});

test('a direct-file link that carries a comma is quoted and round-trips (v1.0.93)', () => {
  // The link was the one field never quoted, so a comma in a file URL split its line.
  const url = 'https://x.test/a,b.mp4';
  const out = serializeLinksFile({
    videos: [{ key: 'file:' + url, type: 'file', srcUrl: url, title: 'שיר', state: 'live', folderId: 'sheet', sortKey: 1 }]
  });
  const back = parseLinksFile(out.text);
  assert.equal(back.counts.invalid, 0, bodyOf(out.lines).join('\n'));
  assert.deepEqual(back.videos.map((v) => v.key), ['file:' + url]);
  assert.equal(back.videos[0].title, 'שיר');
});

const famA = {
  profileName: 'נועם',
  subscriptions: [{ channelId: CH_A, autoApprove: true, titleOverride: 'רחוב סומסום' }],
  videos: [vid(VID_A)]
};
const famB = {
  profileName: 'מיכל',
  subscriptions: [{ channelId: CH_A, autoApprove: false, titleOverride: 'רחוב סומסום' }, { channelId: PL_A, kind: 'playlist' }],
  videos: [vid(VID_B)]
};
const AT = Date.parse('2026-10-05T09:00:00');

test('serializeLinksExport: ONE profile is exactly the single-profile file (v1.0.93)', () => {
  // byte-identical — so an older app reads it, and the import still offers "new profile X"
  const one = serializeLinksExport({ profiles: [famA], exportedAt: AT, appVersion: '1.0.93' });
  const file = serializeLinksFile({ ...famA, exportedAt: AT, appVersion: '1.0.93' });
  assert.equal(one.text, file.text);
  assert.equal(one.sections, 1);
  assert.deepEqual(one.empty, []);
  assert.deepEqual(one.profiles.map((x) => x.name), ['נועם']);
  assert.equal(profileNameFromLines(one.lines), 'נועם');
});

test('serializeLinksExport: several profiles get a SECTION each, and no single-profile name (v1.0.93)', () => {
  const two = serializeLinksExport({ profiles: [famA, famB], exportedAt: AT });
  assert.equal(two.sections, 2);
  assert.ok(two.lines.includes(sectionMarkerLine('נועם')));
  assert.ok(two.lines.includes(sectionMarkerLine('מיכל')));
  assert.ok(two.lines.indexOf(sectionMarkerLine('נועם')) < two.lines.indexOf(sectionMarkerLine('מיכל')),
    'sections keep the order the parent sees the profiles in');
  for (const l of two.lines) if (l.startsWith('#') || !l) continue; else assert.match(l, /^https:\/\//);
  // AN OLDER APP must not read ONE profile name off a family list — it would offer a single
  // new profile holding every child's content. Its regex never matches the section marker.
  assert.equal(profileNameFromLines(two.lines), '');
  assert.equal(profileNameFromLines(two.text), '');
  // totals are the sum; the per-profile summary rides along for the outcome sentence
  assert.equal(two.counts.channels, 2);
  assert.equal(two.counts.playlists, 1);
  assert.equal(two.counts.videos, 2);
  assert.deepEqual(two.profiles.map((x) => x.name), ['נועם', 'מיכל']);
  // deterministic: the same input is the same text
  assert.equal(serializeLinksExport({ profiles: [famA, famB], exportedAt: AT }).text, two.text);
});

test('serializeLinksExport: a profile with NOTHING gets no section and is named (v1.0.93)', () => {
  const empty = { profileName: 'דני', subscriptions: [], videos: [] };
  const out = serializeLinksExport({ profiles: [famA, empty, famB], exportedAt: AT });
  assert.equal(out.sections, 2);
  assert.deepEqual(out.empty, ['דני']);
  assert.ok(!out.lines.some((l) => sectionNameOf(l) === 'דני'), 'an empty section would mint an empty profile on import');
  // one with content + one without ⇒ the SINGLE-profile shape, for the one with content
  const solo = serializeLinksExport({ profiles: [empty, famB], exportedAt: AT });
  assert.equal(solo.sections, 1);
  assert.equal(solo.text, serializeLinksFile({ ...famB, exportedAt: AT }).text);
  // nothing at all ⇒ zero counts, never a throw
  const none = serializeLinksExport({ profiles: [empty], exportedAt: AT });
  assert.equal(none.counts.channels + none.counts.playlists + none.counts.videos, 0);
  assert.equal(serializeLinksExport({}).sections, 0);
  assert.equal(serializeLinksExport({ profiles: [null, undefined] }).sections, 0);
});

test('sectionNameOf: only a real section marker, and a hostile name never becomes a profile (v1.0.93)', () => {
  assert.equal(sectionNameOf(sectionMarkerLine('נועם')), 'נועם');
  assert.equal(sectionNameOf('#=== profile: Dana ==='), 'Dana');
  assert.equal(sectionNameOf('  # ===== פרופיל:   a   b   =====  '), 'a b');
  assert.equal(sectionNameOf('# ===== פרופיל: x= ====='), 'x=');
  assert.equal(sectionNameOf('# ===== פרופיל: ' + 'מ'.repeat(50) + ' ====='), 'מ'.repeat(20));
  assert.equal(sectionNameOf('# ===== פרופיל: https://evil.test ====='), '', 'a link is not a name');
  assert.equal(sectionNameOf('# ===== פרופיל: ====='), '');
  // the SINGLE-profile marker and ordinary comments are not sections
  assert.equal(sectionNameOf('# פרופיל: נועם'), null);
  assert.equal(sectionNameOf('# הסרטונים שלי'), null);
  assert.equal(sectionNameOf('https://www.youtube.com/watch?v=' + VID_A), null);
  assert.equal(sectionNameOf(null), null);
});

test('MULTI-PROFILE ROUND TRIP: each section reads back as its own profile (v1.0.93)', () => {
  const out = serializeLinksExport({ profiles: [famA, famB], exportedAt: AT });
  const back = parseLinksFile(out.text);
  assert.equal(back.ok, true);
  assert.equal(back.profileName, '', 'a family list carries no single profile name');
  assert.deepEqual(back.sections.map((x) => x.name), ['נועם', 'מיכל']);
  const [a, b] = back.sections;
  assert.deepEqual(a.channels.map((c) => c.channelRef.value), [CH_A]);
  assert.equal(a.channels[0].flag, 'auto');
  assert.deepEqual(a.videos.map((v) => v.key), ['yt:' + VID_A]);
  assert.deepEqual(b.channels.map((c) => c.channelRef.value), [CH_A]);
  assert.equal(b.channels[0].flag, '', 'each profile keeps its OWN auto/manual answer');
  assert.deepEqual(b.playlists.map((p) => p.playlistId), [PL_A]);
  assert.deepEqual(b.videos.map((v) => v.key), ['yt:' + VID_B]);
  // the UNION ("everything into one profile") is deduplicated across sections
  assert.deepEqual(back.channels.map((c) => c.channelRef.value), [CH_A]);
  assert.equal(back.counts.total, 4, 'the shared channel counts once in the union');
  assert.deepEqual(back.videos.map((v) => v.rowIndex), [0, 1], 'the union re-numbers line order');
  assert.equal(back.counts.invalid, 0, 'a marker line must never read as an unrecognised line');
});

test('an OLD single-profile file is ONE section carrying its name — nothing changes for it (v1.0.93)', () => {
  const file = serializeLinksFile({ ...famA, exportedAt: AT });
  const back = parseLinksFile(file.text);
  assert.equal(back.sections.length, 1);
  assert.equal(back.sections[0].name, 'נועם');
  assert.equal(back.profileName, 'נועם');
  assert.deepEqual(back.sections[0].videos, back.videos, 'one section IS the whole plan');
  assert.deepEqual(back.sections[0].channels, back.channels);
  // a bare hand-typed list: one unnamed section
  const bare = parseLinksFile('https://www.youtube.com/watch?v=' + VID_A + '\n');
  assert.deepEqual(bare.sections.map((x) => x.name), ['']);
});

test('sections: stray lines, repeated names, a comma in a name, and a lone named section (v1.0.93)', () => {
  const v = (id) => 'https://www.youtube.com/watch?v=' + id;
  // lines above the first marker are the UNNAMED section; a repeated name merges
  const text = [v(VID_A), sectionMarkerLine('נועם'), v(VID_B), sectionMarkerLine('נועם'), v(VID_A)].join('\n');
  const back = parseLinksFile(text);
  assert.deepEqual(back.sections.map((x) => x.name), ['', 'נועם']);
  assert.deepEqual(back.sections[1].videos.map((x) => x.key), ['yt:' + VID_B, 'yt:' + VID_A]);
  // a profile name may carry a COMMA — parseCsv splits the marker row; the name survives
  const comma = parseLinksFile([sectionMarkerLine('נועם, הגדול'), v(VID_A), sectionMarkerLine('מיכל'), v(VID_B)].join('\n'));
  assert.deepEqual(comma.sections.map((x) => x.name), ['נועם, הגדול', 'מיכל']);
  // a marked list where only ONE section has links reads as that single profile, so the
  // import offers "a new profile named …" exactly like an old single-profile file
  const lone = parseLinksFile([sectionMarkerLine('נועם'), '# nothing here', sectionMarkerLine('מיכל'), v(VID_B)].join('\n'));
  assert.deepEqual(lone.sections.map((x) => x.name), ['מיכל']);
  assert.equal(lone.profileName, 'מיכל');
});

test('the import cap bounds every section AND the union (v1.0.93)', () => {
  const ids = Array.from({ length: 6 }, (_, i) => 'abcdefghij' + String.fromCharCode(65 + i));
  const v = (id) => 'https://www.youtube.com/watch?v=' + id;
  const text = [sectionMarkerLine('א'), ...ids.slice(0, 4).map(v), sectionMarkerLine('ב'), ...ids.slice(2).map(v)].join('\n');
  const back = parseLinksFile(text, { max: 3 });
  for (const sec of back.sections) assert.ok(sec.counts.total <= 3, `${sec.name}: ${sec.counts.total}`);
  assert.ok(back.counts.total <= 3);
  assert.ok(back.counts.dropped > 0, 'what the cap refused is counted, never silent');
});

test('parseLinksFile stays TOTAL with section markers in it (v1.0.93)', () => {
  for (const junk of [sectionMarkerLine(''), '# =====', '#=== profile: ===\n\n', sectionMarkerLine('x') + '\n"unclosed']) {
    const r = parseLinksFile(junk);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.sections));
  }
  assert.deepEqual(parseLinksFile('').sections, []);
  assert.deepEqual(parseLinksFile('<html><body>x</body></html>').sections, []);
});

test('matchSectionTargets: the NAME is the identity, a missing one is CREATED (v1.0.93)', () => {
  const sections = [{ name: 'נועם' }, { name: 'מיכל' }, { name: '' }, { name: '  דני  ' }];
  const profiles = [{ id: 'p1', name: 'נועם' }, { id: 'p2', name: 'דני' }, null, { name: 'no id' }];
  const t = matchSectionTargets({ sections, profiles, activeId: 'p9' });
  assert.deepEqual(t.map((x) => [x.name, x.profileId, x.create]), [
    ['נועם', 'p1', false],
    ['מיכל', null, true],
    ['', 'p9', false], // stray lines go to the OPEN profile
    ['דני', 'p2', false] // whitespace-collapsed, like profileNameExists
  ]);
  assert.equal(t[0].section, sections[0]);
  assert.deepEqual(matchSectionTargets({}), []);
  assert.deepEqual(matchSectionTargets({ sections: [null], profiles: 'x' }), []);
});

/* ---------------- the plan.js sentences ---------------- */

test('hebList joins names the way Hebrew prose does (v1.0.93)', () => {
  assert.equal(hebList([]), '');
  assert.equal(hebList(['נועם']), 'נועם');
  assert.equal(hebList(['נועם', 'מיכל']), 'נועם ומיכל');
  assert.equal(hebList(['נועם', 'מיכל', 'דני']), 'נועם, מיכל ודני');
  assert.equal(hebList(['נועם', 'Dana']), 'נועם ו-Dana');
  assert.equal(hebList([' ', null, 'א']), 'א');
  assert.equal(hebList(null), '');
});

test('linksExportSelection: one profile needs no choice; otherwise exactly the ticked, in order (v1.0.93)', () => {
  const ps = [{ id: 'a', name: 'א' }, { id: 'b', name: 'ב' }, { id: 'c', name: 'ג' }];
  assert.deepEqual(linksExportSelection({ profiles: ps, selected: new Set(['c', 'a']) }), ['a', 'c']);
  assert.deepEqual(linksExportSelection({ profiles: ps, selected: ['b'] }), ['b']);
  assert.deepEqual(linksExportSelection({ profiles: ps, selected: new Set(['gone']) }), [],
    'a deleted profile is not exported, and nothing ticked is NOT "everyone"');
  assert.deepEqual(linksExportSelection({ profiles: ps, selected: null, activeId: 'a' }), [],
    'nothing ticked is never a silent fallback to the open profile either');
  assert.deepEqual(linksExportSelection({ profiles: [ps[1]], selected: new Set() }), ['b'],
    'with ONE profile the picker is hidden and that profile is the answer');
  assert.deepEqual(linksExportSelection({ profiles: [], activeId: 'z' }), ['z']);
  assert.deepEqual(linksExportSelection({}), []);
});

test('linksCopyOutcome: says what was copied AND where to paste it, and warns before a chat cuts it (v1.0.93)', () => {
  const counts = { channels: 3, playlists: 1, videos: 2, files: 2 };
  const seen = new Set();
  for (const how of ['native', 'none', 'no-selection', 'nothing']) {
    const r = linksCopyOutcome({ how, counts, chars: 100 });
    assert.ok(r.text && r.text.length > 10, how);
    assert.ok(!seen.has(r.text), `${how}: shares a sentence`);
    seen.add(r.text);
  }
  const ok = linksCopyOutcome({ how: 'native', counts, chars: 100 });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /6 לינקים/, 'a file is one link, not two');
  assert.match(ok.text, /הדבק/, 'the next step is part of the confirmation');
  assert.equal(ok.long, false);
  for (const how of ['web', 'legacy']) assert.equal(linksCopyOutcome({ how, counts }).ok, true, how);
  assert.match(linksCopyOutcome({ how: 'native', counts: { videos: 1 } }).text, /לינק אחד/);
  // past what a chat carries: still a success, with the warning — never a refusal
  const long = linksCopyOutcome({ how: 'native', counts, chars: LINKS_CHAT_MAX_CHARS + 1 });
  assert.equal(long.ok, true);
  assert.equal(long.long, true);
  assert.match(long.text, /וואטסאפ/);
  assert.match(long.text, /60,001 תווים/);
  // a failed copy SHOWS the list to copy by hand
  const failed = linksCopyOutcome({ how: 'none', counts });
  assert.equal(failed.ok, false);
  assert.equal(failed.shown, true);
  // several profiles are named, and an empty one is said out loud
  const fam = linksCopyOutcome({ how: 'native', counts, profiles: ['נועם', 'מיכל'], empty: ['דני'] });
  assert.match(fam.text, /של נועם ומיכל/);
  assert.match(fam.text, /דני/);
  assert.doesNotMatch(linksCopyOutcome({ how: 'native', counts, profiles: ['נועם'] }).text, / של נועם/,
    'one profile needs no name — the parent knows whose list it is');
  assert.equal(typeof linksCopyOutcome().text, 'string');
});

test('linksSectionsConfirm: every profile named with its share, every NEW profile named before it exists (v1.0.93)', () => {
  const targets = [
    { name: 'נועם', create: false, section: { counts: { channels: 2, playlists: 0, videos: 1 } } },
    { name: 'מיכל', create: true, section: { counts: { channels: 0, playlists: 1, videos: 0 } } },
    { name: 'דני', create: true, section: { counts: { channels: 0, playlists: 0, videos: 3 } } }
  ];
  const c = linksSectionsConfirm({ targets, activeName: 'נועם' });
  assert.match(c.text, /3 פרופילים/);
  assert.match(c.text, /נועם \(2 ערוצים, סרטון אחד\)/);
  assert.match(c.text, /מיכל \(רשימת השמעה אחת\)/);
  assert.match(c.text, /הפרופילים מיכל ודני לא קיימים כאן — הם ייווצרו/);
  assert.match(c.text, /ימתינו לאישורכם/, 'a channel or playlist in the list ⇒ the approval rule is said');
  assert.equal(c.ok, 'כל רשימה לפרופיל שלה');
  assert.equal(c.third, 'הכול לנועם');
  assert.ok(c.cancel);
  const one = linksSectionsConfirm({ targets: [targets[0], targets[1]], activeName: '' });
  assert.match(one.text, /הפרופיל מיכל לא קיים כאן — הוא ייווצר/);
  assert.equal(one.third, 'הכול לפרופיל הפתוח');
  const videosOnly = linksSectionsConfirm({ targets: [targets[2]] });
  assert.doesNotMatch(videosOnly.text, /ימתינו/);
  assert.equal(typeof linksSectionsConfirm({ targets: [null, { section: {} }, 'x'] }).text, 'string');
  assert.equal(typeof linksSectionsConfirm().text, 'string');
});

test('linksSectionsOutcome: PER PROFILE, each zero names its cause, and a closed profile is told when (v1.0.93)', () => {
  const r = linksSectionsOutcome({
    results: [
      { name: 'נועם', active: true, res: { channels: 1, videos: 2 } },
      { name: 'מיכל', created: true, active: false, res: { channels: 2 } },
      { name: 'דני', active: false, res: { existed: 4 } },
      { name: 'רון', active: false, res: { skippedDenied: 1 } },
      { name: 'גל', active: false, res: { failed: 1 } },
      { name: 'טל', active: false, res: {} }
    ],
    pending: 3
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /נועם: נוספו ערוץ אחד, 2 סרטונים/);
  assert.match(r.text, /מיכל \(פרופיל חדש\): נוספו 2 ערוצים/);
  assert.match(r.text, /דני: הכול כבר היה בספרייה/);
  assert.match(r.text, /רון: הכול הוסר בעבר/);
  assert.match(r.text, /גל: המקורות לא זוהו/);
  assert.match(r.text, /טל: לא נוסף כלום/);
  assert.match(r.text, /3 סרטונים ממתינים לאישור/);
  // only the CLOSED profile that got a channel is told its videos come on entry
  assert.match(r.text, /הסרטונים מהערוצים של מיכל יגיעו כשנכנסים לפרופיל/);
  assert.doesNotMatch(r.text, /של נועם יגיעו/);
  // the note names the KIND that will fill — a playlist is not a channel
  assert.match(linksSectionsOutcome({ results: [{ name: 'טל', active: false, res: { playlists: 1 } }] }).text,
    /הסרטונים מהרשימות של טל יגיעו כשנכנסים לפרופיל/);
  assert.match(linksSectionsOutcome({ results: [
    { name: 'א', active: false, res: { channels: 1 } }, { name: 'ב', active: false, res: { playlists: 2 } }] }).text,
    /הסרטונים מהערוצים ומהרשימות של א וב יגיעו כשנכנסים לכל פרופיל/);
  const nothing = linksSectionsOutcome({ results: [{ name: 'א', res: { existed: 1 } }] });
  assert.equal(nothing.ok, false);
  assert.match(linksSectionsOutcome({ results: [{ name: 'א', res: { videos: 1 } }] }).text, /א: נוסף סרטון אחד/);
  assert.equal(typeof linksSectionsOutcome().text, 'string');
});
