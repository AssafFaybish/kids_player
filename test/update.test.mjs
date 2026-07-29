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
