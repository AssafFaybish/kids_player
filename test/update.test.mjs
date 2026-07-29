// Version-compare tests — including THE trap: v1.0.10 > v1.0.9 (string compare fails it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, compareVersions, isNewer, pickApkAsset } from '../www/js/update.js';

test('numeric per-component compare — the 1.0.10 > 1.0.9 trap', () => {
  assert.equal(isNewer('v1.0.10', '1.0.9'), true);
  assert.equal(isNewer('v1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', 'v1.0.1'), false); // never downgrade
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
