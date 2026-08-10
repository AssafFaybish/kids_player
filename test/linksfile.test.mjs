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
  canonicalLinkFor, serializeLinksFile, parseLinksFile, linksFileName
} from '../www/js/linksfile.js';
import {
  channelRowSubscription, manualVideoRecord, coveredBySubscription, deniedReAddPrompt,
  deniedRestorePrompt, linksImportConfirm, linksImportOutcome, linksExportOutcome,
  planOrphanGC, LINKS_IMPORT_MAX, hebCount, hebCountF
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
  const rungs = ['native', 'file-only', 'download', 'clipboard', 'shown', 'nothing', 'none'];
  const seen = new Set();
  for (const delivery of rungs) {
    const r = linksExportOutcome({ delivery, name, dir, counts });
    assert.ok(r.text && r.text.trim().length > 10, `${delivery}: weak message`);
    assert.ok(!seen.has(r.text), `${delivery}: shares a sentence with another rung`);
    seen.add(r.text);
    // the two rungs that actually produced a file on the device must name where it is
    if (delivery === 'native' || delivery === 'file-only') {
      assert.ok(r.text.includes(dir) && r.text.includes(name), `${delivery}: does not name the file`);
    }
  }
  assert.equal(linksExportOutcome({ delivery: 'nothing' }).ok, false);
  assert.equal(linksExportOutcome({ delivery: 'native', name, dir, counts }).ok, true);
  assert.equal(linksExportOutcome({ delivery: 'file-only', name, dir }).shareTextFallback, true);
  assert.match(linksExportOutcome({ delivery: 'native', name, dir, counts }).text, /5 לינקים/);
  assert.equal(typeof linksExportOutcome({}).text, 'string');
});
