// Version-compare tests — including THE trap: v1.0.10 > v1.0.9 (string compare fails it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, isNewer, pickApkAsset,
  resolveUpdateStatus, buildAppShareMessage, releasesPageUrl, UPDATE_REPO
} from '../www/js/update.js';

test('numeric per-component compare — the 1.0.10 > 1.0.9 trap', () => {
  assert.equal(isNewer('v1.0.10', '1.0.9'), true);
  assert.equal(isNewer('v1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', 'v1.0.1'), false); // never downgrade
});

test('an invisible RLM in the tag (real incident: ‏v1.0.0) still parses', () => {
  // U+200F snuck into the real first release tag via Hebrew-context copy-paste
  assert.deepEqual(parseVersion('‏v1.0.0'), [1, 0, 0]);
  assert.deepEqual(parseVersion('v1.0.1‎'), [1, 0, 1]);
  assert.equal(isNewer('‏v1.0.1', '1.0.0'), true);
});

test('garbage input fails SAFE (never claims newer)', () => {
  assert.equal(isNewer('latest', '1.0.0'), false);
  assert.equal(isNewer('v2.0.0', undefined), false);
  assert.equal(isNewer(null, null), false);
  assert.equal(parseVersion('not-a-version'), null);
  assert.deepEqual(parseVersion('v1.2.3-beta'), [1, 2, 3]);
});

test('compareVersions is antisymmetric', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('pickApkAsset: exact name first, any .apk fallback, null otherwise', () => {
  const assets = [
    { name: 'checksums.txt' },
    { name: 'kids-player-v1.0.3.apk', browser_download_url: 'u1' },
    { name: 'other.apk', browser_download_url: 'u2' }
  ];
  assert.equal(pickApkAsset(assets, 'v1.0.3').name, 'kids-player-v1.0.3.apk');
  assert.equal(pickApkAsset([{ name: 'x.apk' }], 'v9.9.9').name, 'x.apk');
  assert.equal(pickApkAsset([{ name: 'notes.md' }], 'v1.0.0'), null);
  assert.equal(pickApkAsset(null, 'v1'), null);
});

/* ---------------- v1.0.4/5: launch-prompt status + share message ---------------- */

test('resolveUpdateStatus: the decision table (skip applies to SILENT checks only)', () => {
  const latest = { version: '1.0.5' };
  // newer + not skipped -> available (silent or manual)
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.4', skipped: null, silent: true }), 'available');
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.4', skipped: null, silent: false }), 'available');
  // declined THIS version -> silent checks stay quiet, a manual check still surfaces it
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.4', skipped: '1.0.5', silent: true }), 'skipped');
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.4', skipped: '1.0.5', silent: false }), 'available');
  // a NEWER release than the skipped one prompts again
  assert.equal(resolveUpdateStatus({ latest: { version: '1.0.6' }, local: '1.0.4', skipped: '1.0.5', silent: true }), 'available');
  // same or older -> up-to-date regardless of skip state
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.5', skipped: null, silent: true }), 'up-to-date');
  assert.equal(resolveUpdateStatus({ latest, local: '1.0.6', skipped: '1.0.5', silent: true }), 'up-to-date');
  // no cached release at all -> up-to-date (nothing to offer)
  assert.equal(resolveUpdateStatus({ latest: null, local: '1.0.4', skipped: null, silent: true }), 'up-to-date');
});

test('buildAppShareMessage: direct asset link when known, releases page otherwise', () => {
  const direct = buildAppShareMessage({ version: '1.0.5', assetUrl: 'https://github.com/x/y/releases/download/v1.0.5/kids-player-v1.0.5.apk' });
  assert.ok(direct.includes('https://github.com/x/y/releases/download/v1.0.5/kids-player-v1.0.5.apk'));
  assert.ok(direct.includes('1.0.5'));
  assert.ok(direct.includes('לא ידועות'), 'must include the unknown-sources one-liner');

  for (const latest of [null, {}, { version: '1.0.5' }]) {
    const fallback = buildAppShareMessage(latest);
    assert.ok(fallback.includes(releasesPageUrl()), 'no asset url -> releases page link');
  }
  assert.ok(releasesPageUrl().includes(UPDATE_REPO));
  // no-version fallback must not render an empty "(גירסה )"
  assert.ok(!buildAppShareMessage(null).includes('(גירסה'));
});

/* ---------------- v1.0.13: what's-new notes (Hebrew, de-noised, multi-version) ---------------- */

test('extractReleaseNotes prefers the "מה חדש" section and drops the technical rest', async () => {
  const { extractReleaseNotes } = await import('../www/js/update.js');
  const body = [
    '## מה חדש',
    '',
    '* חיפוש חדש במסך הבית',
    '* מחיקת סרטון ישירות מדף הצפייה',
    '',
    '---',
    '',
    '## What\'s Changed',
    '* v1.0.9: Android TV support by @AssafFaybish in https://github.com/x/y/pull/15',
    '**Full Changelog**: https://github.com/x/y/compare/v1.0.8...v1.0.9'
  ].join('\n');
  assert.deepEqual(extractReleaseNotes(body), ['חיפוש חדש במסך הבית', 'מחיקת סרטון ישירות מדף הצפייה']);
});

test('extractReleaseNotes de-noises a GitHub auto-body (no urls, handles, PR refs, markdown)', async () => {
  const { extractReleaseNotes } = await import('../www/js/update.js');
  const auto = [
    '## What\'s Changed',
    '* **v1.0.9**: Android TV support — D-pad navigation by @AssafFaybish in https://github.com/devfassaf/kids_player/pull/15',
    '* fix: update prompt (#16)',
    '',
    '**Full Changelog**: https://github.com/devfassaf/kids_player/compare/v1.0.8...v1.0.9'
  ].join('\n');
  const lines = extractReleaseNotes(auto);
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.ok(!/https?:\/\//.test(l), 'no urls: ' + l);
    assert.ok(!l.includes('@'), 'no handles: ' + l);
    assert.ok(!/[*_`#]/.test(l), 'no markdown: ' + l);
    assert.ok(!/#\d/.test(l), 'no PR refs: ' + l);
    assert.ok(!/Full Changelog/i.test(l));
    assert.ok(l.length <= 160);
  }
  assert.ok(lines[0].includes('Android TV'));
});

test('extractReleaseNotes: empty/garbage input never throws and yields []', async () => {
  const { extractReleaseNotes } = await import('../www/js/update.js');
  assert.deepEqual(extractReleaseNotes(''), []);
  assert.deepEqual(extractReleaseNotes(null), []);
  assert.deepEqual(extractReleaseNotes('## מה חדש\n\n\n'), []);
  assert.deepEqual(extractReleaseNotes('-----'), []);
});

test('buildWhatsNew: every version ABOVE the installed one, newest first, capped', async () => {
  const { buildWhatsNew } = await import('../www/js/update.js');
  const rel = (v, note) => ({ tag_name: 'v' + v, body: '## מה חדש\n\n* ' + note });
  const releases = [rel('1.0.9', 'ט'), rel('1.0.8', 'ח'), rel('1.0.7', 'ז'), rel('1.0.6', 'ו'), rel('1.0.5', 'ה')];
  const w = buildWhatsNew(releases, '1.0.6');
  assert.deepEqual(w.versions.map((v) => v.version), ['1.0.9', '1.0.8', '1.0.7']); // 1.0.6 and below excluded
  assert.deepEqual(w.versions[0].lines, ['ט']);
  assert.equal(w.moreCount, 0);
  // cap + remainder count
  const many = Array.from({ length: 12 }, (_, i) => rel('1.1.' + i, 'שינוי ' + i));
  const capped = buildWhatsNew(many, '1.0.0', { max: 8 });
  assert.equal(capped.versions.length, 8);
  assert.equal(capped.moreCount, 4);
  assert.equal(capped.versions[0].version, '1.1.11'); // numeric order, not string
});

test('buildWhatsNew: drafts/prereleases/garbage tags excluded; above=false keeps all', async () => {
  const { buildWhatsNew } = await import('../www/js/update.js');
  const releases = [
    { tag_name: 'v2.0.0', body: 'x', draft: true },
    { tag_name: 'v1.9.0', body: 'x', prerelease: true },
    { tag_name: 'nightly', body: 'x' },
    { tag_name: 'v1.0.8', body: '## מה חדש\n\n* טוב' },
    null
  ];
  const w = buildWhatsNew(releases, '1.0.7');
  assert.deepEqual(w.versions.map((v) => v.version), ['1.0.8']);
  assert.deepEqual(buildWhatsNew(releases, '9.9.9', { above: false }).versions.map((v) => v.version), ['1.0.8']);
  assert.deepEqual(buildWhatsNew(null, '1.0.0').versions, []);
});
