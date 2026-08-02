// Source-level invariants (v1.0.20). Everything here is a rule that CANNOT fail at
// build time — there is no bundler and no type checker — and whose breakage shows up
// only on a real device, in a family's library. Each test names the consequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIR = join(ROOT, 'www', 'js');

// `exts` is load-bearing: this used to hard-code `.js`, so the Java sweep below
// (the ONLY place the OAuth scope can live) silently walked zero files while the
// test reported the invariant as pinned.
function walk(dir, exts = ['.js']) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const FILES = walk(JS_DIR);
const src = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const MODULES = new Map(FILES.map((p) => [rel(p), src(p)]));

/** Static `import … from './x.js'` targets of one module, resolved repo-relative. */
function importsOf(relPath) {
  const body = MODULES.get(relPath) || '';
  const out = [];
  const re = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(body))) {
    const dir = dirname(relPath);
    out.push(join(dir, m[1]).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * DYNAMIC `await import('./x.js')` targets. This codebase has MORE of these than static
 * imports (app.js alone: 61 vs 21), and the static-only regex above could not see any of
 * them — a typo'd dynamic path is a blank screen on the device and a fully green suite.
 * Kept separate from importsOf() on purpose: a dynamic edge is evaluated lazily and is
 * this repo's sanctioned way to BREAK a cycle, so the cycle test must not follow it.
 */
function dynamicImportsOf(relPath) {
  const body = MODULES.get(relPath) || '';
  const out = [];
  const re = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(body))) out.push(join(dirname(relPath), m[1]).replace(/\\/g, '/'));
  return out;
}

test('the module graph has NO CYCLES', () => {
  // A cycle in a no-bundler ES-module app is not a build error: it is an `undefined`
  // binding at runtime, on a device, in whichever order the browser happened to
  // evaluate. CLAUDE.md pins the layer order for exactly this reason.
  const state = new Map(); // 0 = visiting, 1 = done
  const trail = [];
  const visit = (node) => {
    if (state.get(node) === 1) return;
    if (state.get(node) === 0) {
      assert.fail('import cycle: ' + trail.slice(trail.indexOf(node)).concat(node).join(' → '));
    }
    state.set(node, 0);
    trail.push(node);
    for (const dep of importsOf(node)) if (MODULES.has(dep)) visit(dep);
    trail.pop();
    state.set(node, 1);
  };
  for (const p of MODULES.keys()) visit(p);
});

test('tour.js imports NOTHING, so it is safe anywhere in the order', () => {
  // Pure data + pure functions is what lets app.js, the About tab and the empty-home
  // button all reach the decks without dragging a dependency chain along.
  assert.deepEqual(importsOf('www/js/tour.js'), []);
});

test('nav.js depends on no SCREEN — only on the modal primitive it must outrank', () => {
  // The router owns back-precedence (fullscreen → modal → view → pop → swallow), so it
  // legitimately needs to ask ui/modal.js "are you open?". What it must never import is
  // a screen: that is the cycle app.js → nav.js → app.js waiting to happen.
  const allowed = new Set(['www/js/ui/modal.js']);
  const deps = importsOf('www/js/nav.js').filter((d) => !allowed.has(d));
  assert.deepEqual(deps.filter((d) => /app\.js$|ui\/(?!modal)/.test(d)), [],
    'nav.js pulled in a screen: ' + deps);
});

test('nothing calls the YouTube search endpoint (100 quota units per call)', () => {
  // The entire quota budget is 10 000/day. One search.list per channel would burn it
  // before lunch and freeze every family's library for the rest of the day.
  // The patterns must match how this codebase actually writes a call — params are object
  // literals fed to URLSearchParams and the host is the `API` constant, so the previous
  // `part=` / `youtube/v3/search` patterns could not match ANY real offender.
  for (const [p, body] of MODULES) {
    // call shapes only — quota.js states the rule in PROSE, and a doc comment naming
    // the endpoint must not read as a violation
    assert.doesNotMatch(body, /\bapiGet\s*\(\s*['"`]search\b/i, `${p} calls search.list via apiGet`);
    assert.doesNotMatch(body, /['"`][^'"`\n]*\/search\?/i, `${p} builds a search endpoint URL`);
    assert.doesNotMatch(body, /youtube\/v3\/search/i, `${p} calls youtube/v3/search`);
  }
});

test('the sensitive `spreadsheets` OAuth scope is gone for good', () => {
  // v1.0.19: that scope is what triggered Google's "hasn't verified this app" screen
  // for every family, and verification needs DNS we do not control. Re-adding it to
  // make a pasted sheet writable brings the warning back for everyone.
  const suspects = [...MODULES.entries()];
  // native-reference/ is included deliberately: ARCHITECTURE.md calls those the canonical
  // copies for a `npx cap add android` rebuild, so a stale scope there would be restored
  // verbatim into a real APK.
  for (const dir of ['android/app/src/main/java', 'www', 'native-reference']) {
    for (const p of walk(join(ROOT, dir), ['.js', '.java'])) suspects.push([rel(p), src(p)]);
  }
  assert.ok(suspects.some(([p]) => p.endsWith('.java')), 'the Java sweep matched no files');
  for (const [p, body] of suspects) {
    assert.doesNotMatch(body, /auth\/spreadsheets/, `${p} requests the spreadsheets scope`);
  }
});

test('the UI no longer offers to paste a third-party sheet link', () => {
  // `drive.file` is per-file: a pasted sheet returns 403 appNotAuthorizedToFile, so the
  // input could only ever fail. It was removed from the wizard AND the sources tab.
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  for (const id of ['sheetsetup-paste', 'remote-paste', 'remote-url']) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still has the paste-a-sheet control #${id}`);
  }
});

test('the API key file is gitignored and never referenced from a committed constant', () => {
  // The repo is PUBLIC. keys.local.js ships inside the APK but must never be committed,
  // and the key must never be serialized into the Drive DB or the sheet.
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /keys\.local\.js/, '.gitignore no longer excludes keys.local.js');
  assert.match(MODULES.get('www/js/keys.js'), /import\(['"]\.\/keys\.local\.js['"]\)/,
    'keys.js must load the local key lazily, so a fresh clone runs keyless');
});

test('the dead sheet-parsing path has no production caller', () => {
  // parseSourceSheet + sync.js are kept only for the tokenizer tests. Wiring either
  // back to a fetch would reintroduce the unauthenticated CSV read that v1.0.19 removed
  // (and with it the "unshared sheet returns HTML 200" library-wipe).
  for (const [p, body] of MODULES) {
    if (p === 'www/js/sync.js') continue;
    // both forms: `await import('./sync.js')` evaded the `from`-anchored check entirely
    assert.doesNotMatch(body, /from\s+['"]\.\/sync\.js['"]/, `${p} imports the dead sync.js`);
    assert.ok(!dynamicImportsOf(p).some((d) => d === 'www/js/sync.js'),
      `${p} dynamically imports the dead sync.js`);
    if (p === 'www/js/sync2.js') {
      // its own definition is the ONLY mention allowed — one more means a caller
      const hits = (body.match(/\bparseSourceSheet\s*\(/g) || []).length;
      assert.equal(hits, 1, 'sync2.js gained a parseSourceSheet caller');
      continue;
    }
    assert.doesNotMatch(body, /\bparseSourceSheet\s*\(/, `${p} calls parseSourceSheet`);
  }
});

test('every module app.js imports actually exists on disk', () => {
  // A typo'd path is a blank screen on the device and nothing at all in `npm test` —
  // which is why the DYNAMIC form has to be resolved here too, not just the static one.
  for (const [p] of MODULES) {
    for (const dep of [...importsOf(p), ...dynamicImportsOf(p)]) {
      if (dep.includes('keys.local')) continue; // gitignored by design
      assert.ok(MODULES.has(dep), `${p} imports a file that does not exist: ${dep}`);
    }
  }
});

test('every grid pages through pageAnyFolder — including the 🎁 folder', () => {
  // v1.0.21 FIELD BUG: renderGridPage had its own `fid === 'new'` branch (db.pageGifts)
  // and renderWatchGrid did not, so opening a gift left the UNDER-PLAYER GRID EMPTY —
  // 🎁 is not a stored folder, so pageAnyFolder fell through to db.pageFolder(scope,
  // 'new'), whose folderRange is an exact bound that no record can match. The child lost
  // every way to reach the next video. CLAUDE.md calls pageAnyFolder "the ONE pagination
  // entry point"; this pins that, so a second renderer cannot grow a private branch.
  const app = MODULES.get('www/js/app.js');
  const lines = app.split('\n');
  const idx = (needle) => lines.findIndex((l) => l.includes(needle));

  // the two low-level pagers may be called only from pageAnyFolder, its 🎁 helper, or
  // nextAfter — the three members of the pagination family, kept adjacent on purpose
  const giftHelper = idx('async function pageGiftFolder');
  const entry = idx('async function pageAnyFolder');
  const afterEntry = lines.findIndex((l, i) => i > entry && l === '}');
  const nextFn = idx('async function nextAfter');
  const afterNext = lines.findIndex((l, i) => i > nextFn && l === '}');
  assert.ok(giftHelper > 0 && entry > giftHelper, 'pageGiftFolder must sit above pageAnyFolder');
  assert.ok(nextFn > entry, 'nextAfter must sit with the other pagers, not off on its own');

  for (const [n, line] of lines.entries()) {
    for (const raw of ['db.pageGifts(', 'db.pageFolder(']) {
      if (!line.includes(raw)) continue;
      const inHelper = n > giftHelper && n < entry;
      const inEntry = n > entry && n <= afterEntry;
      const inNext = n > nextFn && n <= afterNext;
      assert.ok(inHelper || inEntry || inNext,
        `app.js:${n + 1} calls ${raw} outside the pagination family — every grid must page through it`);
    }
  }
  // and pageAnyFolder must actually HANDLE the gift folder, or it silently returns []
  const body = lines.slice(entry, afterEntry + 1).join('\n');
  assert.match(body, /fid === 'new'/, "pageAnyFolder lost its 🎁 ('new') branch");

  // v1.0.25 — nextAfter (continuous play) must recognise EVERY folder kind pageAnyFolder
  // does. This is the real hazard of a third pager: a folder kind added to one and not the
  // other means the chain silently disagrees with the grid the child is looking at —
  // stopping early, or worse, playing something that is not the next tile.
  const nextBody = lines.slice(nextFn, afterNext + 1).join('\n');
  for (const kind of ["'new'", "'grp:'", "'sheet'", "'ch:'"]) {
    assert.ok(body.includes(kind), `pageAnyFolder no longer handles ${kind}`);
    assert.ok(nextBody.includes(kind),
      `nextAfter does not handle ${kind} — continuous play would disagree with the grid`);
  }
});

test('every path that makes a record LIVE forces a refresh', () => {
  // v1.0.21 field bug: a freshly written record is INERT — `srcChannelId` (which files it
  // into its channel folder) comes from the sync's enrichment stage and `giftRank` only
  // from planProfileGifts, so a shared/added video sat in the loose list and was not a 🎁
  // until the parent happened to press "רענון נתונים".
  //
  // A COUNT is all a grep can honestly assert here (the behaviour is DOM- and
  // IndexedDB-coupled). It catches a call being deleted; it cannot catch a NEW approval
  // path that never had one — which is a real hole this suite hit once already, so any
  // new approve/add site must be added here deliberately.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /function refreshAfterAdd\(/, 'the post-add refresh helper is gone');
  // total occurrences minus the one declaration = real call sites
  const sites = (app.match(/refreshAfterAdd\(/g) || []).length - 1;
  assert.ok(sites >= 5, `only ${sites} refreshAfterAdd call sites — an add path stopped refreshing`);
  // it must FORCE: the 3-min shouldSync throttle is what made the bug invisible
  const fn = app.slice(app.indexOf('function refreshAfterAdd('));
  assert.match(fn.slice(0, 900), /syncLibrary\(activeProfileId,\s*\{\s*force:\s*true\s*\}/,
    'refreshAfterAdd must force the sync, or the 3-min throttle swallows it');
  // …and never under a playing video: a forced sync also bypasses the per-channel RSS
  // throttle, so it is a full sweep of every channel on a low-end tablet
  assert.match(fn.slice(0, 900), /nav\.isActive\('watch'\)/,
    'refreshAfterAdd lost its playback guard');
});

test('syncLibrary DELEGATES the join-or-queue decision to planSyncDispatch', () => {
  // The same trap nav.test.mjs describes, and this one already sprang once: v1.0.21 wrote
  // the rule ("a FORCED sync CHAINS, NEVER JOINS") into the comment above syncLibrary and
  // then shipped a condition that joined whenever the running sync was also forced. A
  // comment cannot fail a test. Pin that the tested decision core is the LIVE one.
  const src = MODULES.get('www/js/sync2.js');
  const fn = src.slice(src.indexOf('export function syncLibrary'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /planSyncDispatch\(/, 'syncLibrary re-implements the decision inline again');
  for (const action of ['join-running', 'join-queued', 'queue']) {
    assert.ok(body.includes(`'${action}'`), `syncLibrary ignores the '${action}' decision`);
  }
  // The bug was a condition that let a forced caller take the join path. There must be no
  // reachable `return` of an existing run's promise that is not gated by that decision.
  assert.doesNotMatch(body, /cur\.force/, 'the v1.0.21 join-a-forced-run condition is back');
});

test('BOTH ways to add a channel import it and then ASK (v1.0.25)', () => {
  // v1.0.22 made the parent screen ask before a stranger's whole catalogue reaches a
  // 5-year-old. The SHARE path never got it: handleChannelShare subscribed, fired a sync
  // it did not await, and reported success immediately — so the backlog landed in
  // ממתינים with no dialog and no count. CLAUDE.md already claimed the question covered
  // "parent screen + share"; only one of them was true. Pin that they share one path.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function importChannelAndAsk\(/, 'the shared import-then-ask path is gone');
  const sites = (app.match(/importChannelAndAsk\(/g) || []).length - 1;
  assert.equal(sites, 2, `expected exactly 2 callers (parent screen + share), found ${sites}`);

  // The share layer must NOT run its own sync: it cannot show the loading screen or the
  // modal (it may not import ui/*), and a second sync would make the parent wait twice.
  const share = MODULES.get('www/js/share.js');
  const chan = share.slice(share.indexOf('async function handleChannelShare'));
  assert.doesNotMatch(chan, /syncLibrary\(/, 'share.js syncs a shared channel behind onAdded again');
  assert.match(chan, /await onAdded\(/, 'the share must AWAIT the import, or it reports an outcome it does not have');
});

test('the new-channel dialog offers three answers and handles every one', () => {
  // A three-way question needs three REAL buttons: mapping an answer onto an accidental
  // dismiss (scrim tap, hardware back) would let a child decide what reaches them. The
  // labels are the parent-facing contract, so they are pinned with the routing.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function offerChannelApproval('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  for (const label of ['אישור הכל', 'אישור ידני', 'אחר כך']) {
    assert.ok(body.includes(`'${label}'`), `the dialog lost its "${label}" button`);
  }
  assert.match(body, /answer === 'ok'/, "the 'אישור הכל' branch is gone");
  assert.match(body, /answer === 'third'/, "the 'אישור ידני' branch is gone");
  // "approve everything" is exactly what ticks the ✅ in the parent's channel list
  assert.match(body, /autoApprove:\s*true/, 'approving all no longer flips autoApprove');
  assert.match(body, /pickChannelVideos\(/, "'אישור ידני' no longer opens the picker");
});

test('the channel-approval paths resolve the library scope, never the bare global', () => {
  // `libScope` is published by buildFolders — only after a home render. A channel shared
  // from YouTube can now reach these on a cold start, and a null scope reads as "this
  // library is empty": no dialog, and a picker with no rows.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function currentLibScope\(/, 'the defensive scope resolver is gone');
  for (const name of ['pendingKeysOfChannel', 'pickChannelVideos', 'offerChannelApproval']) {
    const fn = app.slice(app.indexOf(`function ${name}(`));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    assert.match(body, /currentLibScope\(\)/, `${name} reads the bare libScope global again`);
  }
});

test('the home entry PULLS before it SYNCS, and nothing else pulls (v1.0.25)', () => {
  // Both write the same video records, so interleaving them lets one clobber the other's
  // merge — CLAUDE.md has said so since v1.0.22, and it was FALSE on launch:
  // nav.reset('gallery') fires the gallery's onEnter synchronously, so the forced launch
  // sync was already running by the time activateProfile reached its own pullThenSync on
  // the very next line. Every launch, on every device with backup enabled.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function entryRefresh\(/, 'the single refresh pipeline is gone');
  const fn = app.slice(app.indexOf('async function entryRefresh('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  const pullAt = body.indexOf('maybePullDrive(');
  const syncAt = body.indexOf('syncLibrary(');
  assert.ok(pullAt >= 0, 'entryRefresh no longer pulls');
  assert.ok(syncAt >= 0, 'entryRefresh no longer syncs');
  assert.ok(pullAt < syncAt, 'the sheet sync now runs BEFORE the Drive pull');
  assert.match(body, /await maybePullDrive\(\)/, 'the pull is not awaited — that IS the race');

  // ONE puller on the entry path. A second call site is how the race got in.
  const callers = (app.match(/maybePullDrive\(/g) || []).length - 1; // minus the definition
  assert.ok(callers <= 2, `maybePullDrive has ${callers} call sites — entry + resume only`);
  // Call shapes only, like the search.list guard: the comment above entryRefresh NAMES the
  // function it replaced, and a doc comment must never read as a violation.
  assert.doesNotMatch(app, /function pullThenSync\b/, 'the old parallel pipeline is back');
  assert.doesNotMatch(app, /[^`'"\w]pullThenSync\s*\(/, 'something calls the old parallel pipeline');

  // …and the decision about WHETHER to pull/force is the tested pure one.
  assert.match(app, /planEntryRefresh\(/, 'homeEntryRefresh re-implements the throttles inline');
});

test('synced settings have ONE source of truth (v1.0.25)', () => {
  // The PIN, the exit lock and the share-approval toggle moved to settings.js so they
  // travel between a family's devices. A leftover direct Preferences read is not a
  // cosmetic duplicate: it is a second source of truth, and the symptom is a parent
  // changing the code on the phone while the tablet keeps opening with the old one.
  for (const [p, body] of MODULES) {
    if (p === 'www/js/settings.js') continue;
    // pin.js legitimately reads the LEGACY key once, to lift an existing PIN out of
    // Preferences — resetting everyone's parent gate for a launch is not an option.
    if (p !== 'www/js/pin.js') {
      assert.doesNotMatch(body, /pref(Get|Set)\(\s*['"]pin['"]/, `${p} reads/writes the PIN outside settings.js`);
    }
    assert.doesNotMatch(body, /pref(Get|Set)\(\s*['"]exitLock['"]/, `${p} still stores the exit lock per device`);
  }
  // and pin.js must never WRITE the legacy key back — that is the two-sources bug
  assert.doesNotMatch(MODULES.get('www/js/pin.js'), /prefSet\(/,
    'pin.js writes the legacy Preferences key again');
});

test('the exit lock is per-profile, and leaving a locked profile is gated', () => {
  // A per-profile lock opens a hole a device-wide one did not have: the profile chip went
  // straight to backToProfiles, so a child on a locked profile could tap their avatar,
  // pick a sibling whose profile is NOT locked, and walk out. Two taps, and the kiosk is
  // decoration.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function onProfileChip\(/, 'the profile-switch gate is gone');
  const fn = app.slice(app.indexOf('async function onProfileChip('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /exitLockOn\(\)/, 'the gate no longer checks the lock');
  assert.match(body, /startPin\(/, 'a locked profile can be left without the parent code');
  const wiring = app.split('\n').find((l) => l.includes("$('profile-chip').addEventListener")) || '';
  assert.match(wiring, /onProfileChip/, 'the chip is wired straight to backToProfiles again');
  // and the gate must not fail OPEN: a catch that falls back to backToProfiles would make
  // a locked profile escapable by whatever made the check throw.
  assert.doesNotMatch(wiring, /catch\([^)]*\)\s*=>\s*backToProfiles/, 'the switch gate fails open');

  // …and the lock must arm at launch from the LAST active profile, or there is an
  // unlocked window between launch and the profile tap.
  assert.match(app, /exitLockOn\(await prefGet\('activeProfile'\)\)/,
    'the launch arming no longer knows which profile to arm for');

  // SWITCHING children changes the answer, so activation must re-apply it. Without this
  // the escape is real: arriving at a LOCKED profile from an unlocked one left the device
  // unpinned with the exit button on screen — the child the lock exists for walks out.
  assert.match(app, /async function applyExitLock\(/, 'the per-profile arming helper is gone');
  const act = app.slice(app.indexOf('async function activateProfile('));
  const actBody = act.slice(0, act.indexOf('\n}\n') + 1);
  assert.match(actBody, /applyExitLock\(\)/,
    'activateProfile does not re-apply the exit lock — a locked child keeps a sibling\'s unlocked state');
  // and it must actually touch the OS pinning, not just the button
  const helper = app.slice(app.indexOf('async function applyExitLock('));
  const helperBody = helper.slice(0, helper.indexOf('\n}\n') + 1);
  assert.match(helperBody, /lockTask/, 'the helper no longer pins');
  assert.match(helperBody, /unlockTask/, 'the helper never releases — a sibling stays pinned');
});

test('the settings channel travels, but the API key never does', () => {
  // The repo is PUBLIC and the key ships in a gitignored file; drive.js has an explicit
  // refusal list. A settings channel is exactly the kind of place a key would get swept
  // into by accident.
  const drive = MODULES.get('www/js/drive.js');
  assert.match(drive, /mergeSettings\(/, 'the Drive doc no longer merges settings');
  const ser = drive.slice(drive.indexOf('export function serializeDb('));
  const body = ser.slice(0, ser.indexOf('\n}\n') + 1);
  assert.match(body, /settings/, 'settings are no longer serialized into the Drive doc');
  for (const [p, src2] of MODULES) {
    if (p !== 'www/js/settings.js' && p !== 'www/js/drive.js') continue;
    assert.doesNotMatch(src2, /yt:apiKey/, `${p} touches the YouTube API key`);
  }
});

test('continuous play routes through planAutoplay, and onExit says WHY (v1.0.25)', () => {
  // finish() fires for a clean end AND for an embedding-disabled video. Without a reason
  // on the wire an autoplay chain cannot tell them apart, so it skips through every broken
  // video in the library in silence — and the failure ceiling can never trigger.
  const player = MODULES.get('www/js/player.js');
  assert.match(player, /const finish = \(reason = 'ended'\)/g, 'finish() lost its reason');
  assert.match(player, /finish\('error'\)/, 'the embed-error path no longer reports a failure');
  assert.match(player, /onExit\(reason\)/, 'onExit is called without the reason again');
  // the DOM hands a listener an Event, which would arrive AS the reason
  assert.doesNotMatch(player, /addEventListener\('ended',\s*finish\s*\)/,
    "the 'ended' listener passes a DOM Event as the exit reason");

  const app = MODULES.get('www/js/app.js');
  assert.match(app, /planAutoplay\(/, 'app.js re-implements the chain decision inline');
  const fn = app.slice(app.indexOf('async function onVideoFinished('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  for (const action of ['stop', 'retry']) {
    assert.ok(body.includes(`'${action}'`), `onVideoFinished ignores the '${action}' decision`);
  }
  // A chain must not survive the child leaving, and a tap must beat the queued video.
  assert.match(app, /resetAutoplayChain\(\); \/\/ a queued next video must never follow/,
    'leaving the watch view no longer cancels a pending countdown');
  const ow = app.slice(app.indexOf('async function openWatch('));
  assert.match(ow.slice(0, 600), /cancelAutoplay\(\)/, 'opening a video does not cancel the countdown');
});

test('deleting a profile actually deletes it, and it STAYS deleted (v1.0.25)', () => {
  // `db.purgeProfile` existed with ZERO CALLERS while the confirm dialog promised
  // "כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה". Measured 2026-08-02: a throwaway
  // profile with one channel kept all 500 videos, its subscription and its sources record.
  // A function nobody calls is the failure mode here, so the call site is the invariant.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function deleteCurrentProfile('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /db\.purgeProfile\(/, 'deleting a profile leaves all of its data behind again');
  assert.match(body, /planProfilePurge\(/,
    'the purge no longer asks which scopes it may erase — a SHARED sheet library would go too');

  // The deletion has to survive the next pull, or it undoes itself on every other device.
  const store = MODULES.get('www/js/store.js');
  const del = store.slice(store.indexOf('export async function deleteProfile('));
  assert.match(del.slice(0, del.indexOf('\n}\n') + 1), /markProfileDeleted\(/,
    'no tombstone is written — a Drive pull will resurrect the profile');
  assert.match(store, /export function mergeProfileLists\(local, remote, deleted/,
    'mergeProfileLists no longer filters deleted profiles');

  // …and the tombstones have to travel, in both directions.
  const drive = MODULES.get('www/js/drive.js');
  assert.match(drive, /deletedProfiles/, 'the Drive document no longer carries the tombstones');
  assert.match(drive, /mergeDeletedProfiles\(/, 'the document merge drops the tombstones');
});

test('no module parses an ISO-8601 duration (Shorts are not a length)', () => {
  // THE trap. YouTube defines a Short as "≤3 minutes AND square-or-taller"; the Data API
  // exposes no aspect ratio and no isShort field, so length can never reproduce the rule.
  // Measured 2026-07-31: 6 of the 15 most recent Super Simple Songs LONG-FORM uploads are
  // under 3 minutes (3 of 15 for Cocomelon) — a duration filter would silently delete real
  // nursery rhymes, the app's core content. Membership of the UULF/UUSH playlists is the
  // only correct filter; see quota.planBackfillPlaylist.
  //
  // `PT(?:` is the shape every such parser has, and nothing here needs one (the player
  // reads seconds off the media element, not the API).
  for (const [p, body] of MODULES) {
    assert.doesNotMatch(body, /PT\(\?:/,
      `${p} parses an ISO-8601 duration — length misclassifies short nursery rhymes as Shorts`);
  }
});

test('every $(id) the code asks for EXISTS in index.html', () => {
  // `$` is `document.getElementById`, and this app has no bundler, no type checker and no
  // JSX — a renamed or forgotten id is not a build error. It is `null.classList`, thrown
  // during mount, which is a BLANK SCREEN on a family's tablet with the whole library
  // still intact behind it. Cheap to pin, and it catches the exact mistake that adding a
  // control to a panel invites: wiring the handler and forgetting the markup.
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [];
  for (const [p, body] of MODULES) {
    for (const m of body.matchAll(/\$\('([^']+)'\)/g)) {
      if (!ids.has(m[1])) missing.push(`${p}: $('${m[1]}')`);
    }
  }
  assert.deepEqual(missing, [], 'these ids are read from JS but are not in index.html');
});

test('the version chain is not one deletable line', () => {
  // EVERY APK's version comes from one `apply from` at the END of a CAPACITOR-GENERATED
  // file. `npx cap add android` regenerates that file, and its own defaultConfig still says
  // versionName "1.0" — so losing the line ships every build as 1.0, which makes
  // isNewer(anything, '1.0') true forever: an update-nag loop on every launch, and no way
  // to tell which build a parent is running.
  const gradle = readFileSync(join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.match(gradle, /apply from:.*release\/android-release\.gradle/,
    'android/app/build.gradle lost the version+signing hook — every APK would ship as 1.0');
  const rel = readFileSync(join(ROOT, 'release/android-release.gradle'), 'utf8');
  assert.match(rel, /package\.json/, 'the version no longer derives from package.json');
});

test('package.json is the single version source and is well-formed', () => {
  // gradle parses this with a regex and THROWS on a non-X.Y.Z value, but that failure only
  // shows up at build time on the release machine.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `version "${pkg.version}" breaks the gradle parser`);
  const [, minor, patch] = pkg.version.split('.').map(Number);
  // versionCode = major*10000 + minor*100 + patch, so >99 in either would collide
  assert.ok(minor <= 99 && patch <= 99, 'minor/patch must stay <= 99 for the versionCode scheme');
});
