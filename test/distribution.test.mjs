// Distribution wiring (v1.0.19) — the website's download button must ALWAYS land on
// the newest APK, including for releases nobody has cut yet.
//
// The mechanism is GitHub's /releases/latest/download/<asset> redirect, which matches
// by EXACT asset name. That makes it a coupling between three files that are edited
// at completely different times, by different people, for different reasons:
//
//   docs/index.html   the href a parent clicks
//   release.sh        what macOS/Linux uploads
//   release.ps1       what Windows uploads
//
// Rename the asset in one and the button 404s silently — nobody notices until a
// parent reports a dead link, because nothing in the app exercises that URL. These
// tests are the only thing holding the three together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LINKS } from '../www/js/links.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const site = read('docs/index.html');
const sh = read('release.sh');
const ps1 = read('release.ps1');

/** The href behind the big download button. */
const downloadHref = (site.match(/class="dl-btn"\s+href="([^"]+)"/) || [])[1];

test('the download button uses the latest-release redirect, not a version URL', () => {
  assert.ok(downloadHref, 'no .dl-btn href found in docs/index.html');
  assert.match(downloadHref, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/latest\/download\/[\w.-]+$/,
    `must be /releases/latest/download/<asset>, got: ${downloadHref}`);
  // A version anywhere in the URL means it stops being "latest" the next release.
  assert.doesNotMatch(downloadHref, /v?\d+\.\d+\.\d+/,
    'the URL must not contain a version — it would freeze on this release');
});

test('the download button points at OUR repo', () => {
  assert.ok(downloadHref.includes('/' + LINKS.updateRepo + '/'),
    `download URL repo must match LINKS.updateRepo (${LINKS.updateRepo}): ${downloadHref}`);
});

test('BOTH release scripts upload the asset the button asks for', () => {
  // The whole guarantee. If a release ships without this exact filename, the button
  // 404s — and a Windows release used to do exactly that, since only release.sh knew.
  const asset = downloadHref.split('/').pop();
  assert.equal(asset, 'kids-player.apk');

  for (const [name, src] of [['release.sh', sh], ['release.ps1', ps1]]) {
    assert.ok(src.includes(asset), `${name} never mentions ${asset}`);
    // it must be COPIED (so the file exists) and UPLOADED (so the release carries it)
    assert.match(src, /kids-player\.apk/, `${name}: stable name missing`);
    assert.match(src, /gh release create[^\n]*Latest|gh release create[^\n]*LATEST/i,
      `${name}: the stable asset must be passed to \`gh release create\``);
  }
});

test('both scripts still ship the VERSIONED asset too', () => {
  // update.js pickApkAsset prefers the exact kids-player-<tag>.apk and only falls
  // back to "any .apk". Dropping the versioned name would still work, but silently
  // downgrade the updater to a fallback match — and a human's Downloads folder would
  // fill with identically-named files.
  for (const [name, src] of [['release.sh', sh], ['release.ps1', ps1]]) {
    assert.match(src, /kids-player-\$\{?Tag\}?\.apk|kids-player-\$TAG\.apk/i,
      `${name}: the versioned asset name is gone`);
  }
});

test('the manual-publish fallback tells the human about BOTH files', () => {
  // These scripts routinely fail to publish (the local gh account is often read-only
  // on the release repo), so the fallback text IS the release procedure. If it lists
  // one file, the hand-published release breaks the website button.
  for (const [name, src] of [['release.sh', sh], ['release.ps1', ps1]]) {
    assert.match(src, /BOTH files/, `${name}: manual fallback still says "the file"`);
  }
});

test('an UNPUBLISHED release fails the script — exit 0 is how v1.0.33/34 went missing', () => {
  // The fallback above prints the manual procedure and used to exit 0 — which reads
  // as "done". Twice in a row (v1.0.33, v1.0.34) the build ended on one machine,
  // nothing was published, and every device kept answering "the app is up to date"
  // while the fix sat in apk_versions/. The instructions stay (they ARE the
  // procedure), but the script must end in die/Die so an unpublished release can
  // never look like a finished one.
  for (const [name, src] of [['release.sh', sh], ['release.ps1', ps1]]) {
    const fallback = src.indexOf('BOTH files');
    assert.ok(fallback > 0, `${name}: manual fallback block not found`);
    assert.match(src.slice(fallback), /\b[dD]ie ["']?NOT PUBLISHED/,
      `${name}: the manual fallback must end in die "NOT PUBLISHED…" (exit 1)`);
  }
});

test('the app SHARES the same stable asset the website serves (v1.0.20)', async () => {
  // Fourth file in the coupling: the parent-to-parent share message. It used to send
  // the versioned asset URL of whatever release the device knew about, so a forwarded
  // message installed a frozen build. Now it must resolve to the same asset name the
  // website button uses — rename one and this fails instead of a parent's link.
  const { latestApkUrl, STABLE_APK_ASSET } = await import('../www/js/update.js');
  assert.equal(STABLE_APK_ASSET, downloadHref.split('/').pop(),
    'the shared asset name drifted from docs/index.html');
  assert.equal(latestApkUrl(), downloadHref,
    'the shared link and the website button must be the same URL');
});

test('the install steps do not name a versioned file the button no longer serves', () => {
  // The walkthrough used to say "choose kids-player-v<version>.apk" — describing the
  // old two-step flow through the releases page. The button downloads directly now.
  const steps = (site.match(/<ol class="steps">[\s\S]*?<\/ol>/) || [''])[0];
  assert.doesNotMatch(steps, /kids-player-v/,
    'install steps still describe picking a versioned file from a list');
});

/* ---------------- a version no device can receive (v1.0.26) ---------------- */

test('versionIsDeliverable: a FOURTH component is invisible, not smaller', async () => {
  const m = await import('../www/js/update.js');
  for (const ok of ['1.0.26', 'v1.0.26', '0.0.1', '10.20.30', ' 1.0.26 ']) {
    assert.equal(m.versionIsDeliverable(ok), true, ok);
  }
  // Every four-part release this project has actually published. NOT ONE of them could
  // reach a single device, and v1.0.26.1 carried the field-reported share fix.
  for (const bad of ['1.0.4.1', '1.0.19.1', '1.0.21.1', '1.0.26.1', 'v1.0.26.1']) {
    assert.equal(m.versionIsDeliverable(bad), false, bad);
    // the reason, demonstrated rather than asserted in prose:
    assert.deepEqual(m.parseVersion(bad), m.parseVersion(bad.split('.').slice(0, 3).join('.')));
    assert.equal(m.compareVersions(bad, bad.split('.').slice(0, 3).join('.')), 0);
  }
  for (const junk of ['', '1.0', 'abc', '1.0.26-beta', null, undefined, {}, 1.026]) {
    assert.equal(m.versionIsDeliverable(junk), false, JSON.stringify(junk));
  }
});

test('an undeliverable version is refused by BOTH release scripts, before the build', async () => {
  // A guard in only one script is no guard: release.ps1 is the Windows one-command path
  // and would happily publish the tag that release.sh just rejected.
  const sh = read('release.sh');
  const ps = read('release.ps1');
  for (const [name, body] of [['release.sh', sh], ['release.ps1', ps]]) {
    assert.match(body, /versionIsDeliverable/, `${name} does not check the version is reachable`);
    // BEFORE the build: catching it after a signed APK exists wastes the whole cycle and
    // invites publishing it anyway.
    const guard = body.indexOf('versionIsDeliverable');
    const build = body.search(/apk:release|assembleRelease|npm run apk/);
    assert.ok(build === -1 || guard < build, `${name} checks the version only after building`);
  }
});
