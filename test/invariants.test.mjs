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
/** Same modules with comments stripped. Deletion guards must judge CODE: a tombstone
 *  comment naming what was removed ("planScopeAdoption (v1.0.20) died…") is documentation,
 *  and a guard that trips on it would force us to stop explaining our own history. */
const stripComments = (b) => b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = new Map([...MODULES].map(([k, v]) => [k, stripComments(v)]));

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
  //
  // v1.0.33: ytsearch.js is the ONE exemption from the URL-literal pattern — the
  // parent's search uses YouTube's KEYLESS internal endpoint (0 quota, no API key),
  // which also contains the substring `/search?`. The exemption is by MODULE, never by
  // weakening the pattern, and inside that module every `/search?` literal must be one
  // of the two sanctioned keyless endpoints. The Data-API guards stay global.
  const YTSEARCH = 'www/js/ytsearch.js';
  for (const [p, body] of MODULES) {
    // call shapes only — quota.js states the rule in PROSE, and a doc comment naming
    // the endpoint must not read as a violation
    assert.doesNotMatch(body, /\bapiGet\s*\(\s*['"`]search\b/i, `${p} calls search.list via apiGet`);
    assert.doesNotMatch(body, /youtube\/v3\/search/i, `${p} calls youtube/v3/search`);
    assert.doesNotMatch(body, /googleapis\.com[^'"`\n]*\/search/i, `${p} hand-builds a Data-API search URL`);
    if (p !== YTSEARCH) {
      assert.doesNotMatch(body, /['"`][^'"`\n]*\/search\?/i, `${p} builds a search endpoint URL`);
    }
  }
  for (const lit of (MODULES.get(YTSEARCH) || '').match(/['"`][^'"`\n]*\/search\?[^'"`\n]*/g) || []) {
    assert.match(lit, /youtubei\/v1\/search\?prettyPrint=false|\/complete\/search\?/,
      `ytsearch.js carries an unsanctioned search URL: ${lit}`);
  }
});

test('the keyless youtubei endpoints live in EXACTLY one module and never see a key', () => {
  // The endpoints are undocumented — when YouTube changes them, ONE module must be the
  // whole blast radius. And they never need a key: sending one would tie the family's
  // shared quota (or the parent's own key) to requests that are free without it.
  // v1.0.33 widened this from /v1/search to ANY youtubei path (browse joined search).
  const carriers = [...MODULES].filter(([, b]) => /youtubei\//.test(b)).map(([p]) => p);
  assert.deepEqual(carriers, ['www/js/ytsearch.js'],
    'a youtubei endpoint moved or spread: ' + carriers.join(', '));

  const body = MODULES.get('www/js/ytsearch.js') || '';
  // call/import shapes only (the rule this file states for itself): prose naming the
  // getter must not read as a violation — the module's own header documents this ban
  assert.doesNotMatch(body, /[?&]key=/, 'ytsearch.js puts a key in a URL');
  assert.doesNotMatch(body, /\bgetApiKey\s*\(/, 'ytsearch.js calls the API-key getter');
  assert.doesNotMatch(body, /from\s+['"]\.\/keys/, 'ytsearch.js imports the keys module');

  // tier pin: pure parsers + thin transport — nothing above platform/util may enter,
  // or the no-bundler import order breaks and the parsers stop being node-testable
  const deps = [...new Set([...importsOf('www/js/ytsearch.js'), ...dynamicImportsOf('www/js/ytsearch.js')])];
  const allowed = new Set(['www/js/platform.js', 'www/js/util.js']);
  assert.deepEqual(deps.filter((d) => !allowed.has(d)), [],
    'ytsearch.js imports above its tier: ' + deps);
});

test('the search feature keeps one add path, its words, and its safe transport (v1.0.33)', () => {
  const app = MODULES.get('www/js/app.js');
  const yts = MODULES.get('www/js/ytsearch.js');
  const platform = MODULES.get('www/js/platform.js');

  // ONE add path (the v1.0.25 lesson — the importChannelAndAsk pin, applied to the
  // extraction whose whole point was that pasting and search-adding cannot drift).
  // Raise the count only for a new deliberate ADD surface, never to silence a break.
  assert.match(app, /async function addClassifiedRow\(/, 'the shared add path is gone');
  const sites = (app.match(/addClassifiedRow\(/g) || []).length - 1;
  assert.equal(sites, 2, `expected exactly 2 callers (parentAdd + ytsAdd), found ${sites}`);

  // a search result re-enters through the classify boundary, and a kind mismatch is
  // refused — classifyLink stays THE safety gate even for content YouTube handed us
  const ytsAddFn = app.slice(app.indexOf('async function ytsAdd('));
  const ytsAddBody = ytsAddFn.slice(0, ytsAddFn.indexOf('\n}\n'));
  assert.match(ytsAddBody, /classifySourceRow\(/, 'search adds bypass the classify boundary');
  // the FULL conditional shape, not the bare comparison: a `false &&` plant kept the
  // substring alive and this guard green (caught by its own red-check)
  assert.match(ytsAddBody, /if \(!row \|\| row\.kind !== item\.type\)/,
    'a classify/kind mismatch is no longer refused');

  // every stage app.js asks searchMessage for has TEXT (the channelAddWait analog —
  // a stage without words is a silent wait, the exact v1.0.27 ambiguity)
  const used = [...app.matchAll(/searchMessage\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(new Set(used).size >= 4, `only ${new Set(used).size} message stages used — the flow went quiet`);
  for (const stage of new Set(used)) {
    assert.match(yts, new RegExp(`case '${stage}':`),
      `app.js asks for '${stage}' but searchMessage has no text for it`);
  }

  // the transport seam owns BOTH halves of the CapacitorHttp body trap: an explicit
  // Content-Type (or the body is silently discarded) and a pre-stringified body
  // (the drive.js precedent)
  const post = platform.slice(platform.indexOf('export async function httpPostJson('));
  const postBody = post.slice(0, post.indexOf('\n}\n'));
  assert.match(postBody, /JSON\.stringify\(/, 'httpPostJson no longer pre-stringifies the body');
  assert.match(postBody, /'Content-Type': 'application\/json'/,
    'the explicit Content-Type is gone — CapacitorHttp silently drops the body without it');

  // hardware back closes the add tab's overlays before the screen — suggestion
  // dropdown, then browse, then goGallery — and only while the add panel is VISIBLE
  // (state left on another tab must not eat a back press). Deleting the gate or
  // reordering the chain fails here.
  const reg = app.slice(app.indexOf("nav.register('parent'"));
  const regBody = reg.slice(0, reg.indexOf('onLeave'));
  const iPrev = regBody.indexOf('isPreviewOpen()');
  const iSuggest = regBody.indexOf('ytsHideSuggest()');
  const iBrowse = regBody.indexOf('closeYtsBrowse()');
  const iGallery = regBody.indexOf('goGallery()');
  assert.ok(iPrev > -1 && iSuggest > iPrev && iBrowse > iSuggest && iGallery > iBrowse,
    'parent onBack order broke: preview → suggest → browse → goGallery');
  assert.match(regBody, /panel-add/, 'the overlay back-close lost its panel-add visibility gate');

  // renderPreview delegates its per-mode button matrix to the TESTED pure helper —
  // hand-ordered toggles are where the "live 🗑️ over a search result" bug lived
  const rp = app.slice(app.indexOf('function renderPreview('));
  assert.match(rp.slice(0, rp.indexOf('\n}\n')), /previewBubbleButtons\(/,
    'renderPreview grew a private button matrix again');
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

test('NO module reads or writes a Google Sheet any more (v1.0.38)', () => {
  // The whole sheet layer is gone: sheetwrite.js (the write queue, the create path, the
  // listing), sync.js (the unauthenticated CSV reader), the sheet stage and the presence
  // mirror. Only the one-time MIGRATION may still read one, and only to fold it in once.
  // Wiring any of it back would restore the two-sources-of-truth design this release ended.
  const sheetApi = /sheets\.googleapis\.com|\/values\/|:append|spreadsheets\/d\//;
  // prove the pattern fires on the exact literals the deleted code used (TESTING.md rule 2)
  for (const bad of ["'https://sheets.googleapis.com/v4/spreadsheets'",
    '`${SHEETS}/${id}/values/${range}`', "url + ':append'",
    "'https://docs.google.com/spreadsheets/d/' + id"]) {
    assert.match(bad, sheetApi, 'the sheet-API pattern went vacuous');
  }
  for (const [p, body] of MODULES) {
    assert.doesNotMatch(body, sheetApi, `${p} talks to the Sheets API again`);
  }
  // the deleted modules must stay deleted
  for (const gone of ['www/js/sheetwrite.js', 'www/js/sync.js']) {
    assert.ok(!MODULES.has(gone), `${gone} is back`);
    for (const [p, body] of MODULES) {
      const name = gone.split('/').pop();
      assert.doesNotMatch(body, new RegExp("(?:\\bfrom|\\bimport)\\s*\\(?\\s*['\"](?:[^'\"]*/)?" + name.replace('.', '\\.') + "['\"]"),
        `${p} imports the deleted ${name}`);
    }
  }
  // and nothing may re-grow a sheet write queue (CODE, not comments — see stripComments)
  for (const [p, body] of CODE) {
    assert.doesNotMatch(body, /enqueueSheetRow|flushSheetQueue|planSheetMirror|applySheetMirror\s*\(/,
      `${p} references the deleted sheet write-back layer`);
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
  // v1.0.40: 'fav' (⭐) joins the list — another folder that no record carries.
  for (const kind of ["'new'", "'fav'", "'grp:'", "'sheet'", "'ch:'"]) {
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
  // total occurrences minus the one declaration = real call sites.
  // EXACT, deliberately: the old `>= 5` floor stayed green while three call sites were
  // deleted. The 7 are: refreshPendingList's row-approve, approveChannelBacklog,
  // importChannelAndAsk (the awaited wait:true one), parentAdd, the pending
  // single-approve and approve-all handlers, and the share handler in init.
  // v1.0.27 DELIBERATE change 8→7: pickChannelVideos no longer fires its own silent
  // sync — importChannelAndAsk runs the one blocking 'finishing' wait for BOTH dialog
  // answers, which is the waiting-screens feature's whole point on that branch (the
  // "no step is silent" test pins that path). A new add/approve path adds one HERE,
  // and a removal must explain where its refresh went.
  // v1.0.38 DELIBERATE change 7→8: linksImportFromText. ONE call for the whole file
  // (behind the 'finishing' wait), never one per row — a 300-line file must not fire 300
  // forced syncs, which is exactly why the importer does not route through
  // addClassifiedRow. The count is what would catch that regression.
  const sites = (app.match(/refreshAfterAdd\(/g) || []).length - 1;
  assert.equal(sites, 8,
    `expected exactly 8 refreshAfterAdd call sites, found ${sites} — an add path stopped refreshing, or a new one must be pinned here deliberately`);
  // it must FORCE: the 3-min shouldSync throttle is what made the bug invisible
  const fn = app.slice(app.indexOf('function refreshAfterAdd('));
  // `[^}]*` rather than an immediate `}`: v1.0.26 added an `onProgress` option for the one
  // caller that waits behind a loading screen. The RULE is "it must force" — the old regex
  // also pinned the punctuation, so a legitimate second option failed it.
  assert.match(fn.slice(0, 900), /syncLibrary\(activeProfileId,\s*\{[^}]*force:\s*true\b/,
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
  const at = src.indexOf('export function syncLibrary');
  assert.ok(at > 0, 'syncLibrary is gone — re-anchor this guard');
  const fn = src.slice(at);
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.match(body, /planSyncDispatch\(/, 'syncLibrary re-implements the decision inline again');
  // Anchor to the CURRENT entry names, LOUDLY: the first version of this guard banned
  // `cur.force` long after any `cur` stopped existing, so the v1.0.21 bug rewritten in
  // today's names passed it. A rename must fail HERE, not silently defuse the ban below.
  assert.match(body, /const running = inFlight\.get\(/,
    'the in-flight entry variable was renamed — re-anchor this guard or its .force ban matches nothing');
  assert.match(body, /const queued = queuedRuns\.get\(/,
    'the queued entry variable was renamed — re-anchor this guard or its .force ban matches nothing');
  for (const action of ['start', 'join-running', 'join-queued', 'queue']) {
    assert.ok(body.includes(`'${action}'`), `syncLibrary ignores the '${action}' decision`);
  }
  // The bug was a condition that read an ENTRY's own force flag and joined. The only
  // `.force` the dispatcher may read is the CALLER's (opts.force, fed to the pure
  // helper); any other `.force` inside syncLibrary is the v1.0.21 condition in new names.
  assert.doesNotMatch(body, /(?<!opts)\.force\b/,
    'syncLibrary consults an entry\'s .force directly — the v1.0.21 join-a-forced-run condition is back');
  // …and every join must be gated by the pure decision, never by an ad-hoc condition.
  for (const line of body.split('\n')) {
    if (!line.includes('attach(')) continue;
    assert.match(line, /action === '/,
      `syncLibrary joins a run without asking planSyncDispatch: ${line.trim()}`);
  }
});

test('BOTH ways to add a channel import it and then ASK (v1.0.25)', () => {
  // v1.0.22 made the parent screen ask before a stranger's whole catalogue reaches a
  // 5-year-old. The SHARE path never got it: handleChannelShare subscribed, fired a sync
  // it did not await, and reported success immediately — so the backlog landed in
  // ממתינים with no dialog and no count. CLAUDE.md already claimed the question covered
  // "parent screen + share"; only one of them was true. Pin that they share one path.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function importChannelAndAsk\(/, 'the shared import-then-ask path is gone');
  // v1.0.26 raised this from 2 to 3 DELIBERATELY: pasting a standalone playlist is a third
  // way to subscribe, and it goes through the same import-then-ask path for the same
  // reason. Raise it only when a new SUBSCRIPTION path is added, never to silence a break.
  const sites = (app.match(/importChannelAndAsk\(/g) || []).length - 1;
  assert.equal(sites, 3,
    `expected exactly 3 callers (parent screen: channel + playlist, and share), found ${sites}`);

  // The share layer must NOT run its own sync: it cannot show the loading screen or the
  // modal (it may not import ui/*), and a second sync would make the parent wait twice.
  const share = MODULES.get('www/js/share.js');
  // v1.0.26 renamed it: a shared PLAYLIST takes the same path as a shared channel.
  const at = share.indexOf('async function handleSourceShare');
  assert.ok(at > 0, 'the shared channel/playlist handler is gone');
  const chan = share.slice(at);
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
  // v1.0.49: THREE, deliberately. The third is the parent's own "רענון נתונים" button,
  // which never pulled at all — so a site or an approval made on another device could not
  // arrive through the one control whose whole promise is "fetch what is new". Raise this
  // only for another deliberate surface, never to silence a break.
  const callers = (app.match(/maybePullDrive\(/g) || []).length - 1; // minus the definition
  assert.ok(callers <= 3, `maybePullDrive has ${callers} call sites — entry + resume + the refresh button`);
  const dsr = app.slice(app.indexOf('async function doSyncAndRefresh'));
  const dsrBody = dsr.slice(0, dsr.indexOf('\n}\n') + 1);
  assert.match(dsrBody, /maybePullDrive\(\{ force: true \}\)/,
    'the parent\'s refresh button does not pull — it cannot bring anything from another device');
  assert.ok(dsrBody.indexOf('maybePullDrive(') < dsrBody.indexOf('syncLibrary('),
    'the refresh button syncs before it pulls — both write the same records');
  assert.match(dsrBody, /refreshSitesPanel\(\)/,
    'the refresh button leaves the sites tab stale — the tab the parent is standing in');
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
  const chipAt = app.indexOf('async function onProfileChip(');
  assert.ok(chipAt > 0, 'the profile-switch gate is gone');
  const fn = app.slice(chipAt);
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  // v1.0.28 (deliberate change): the chip ALWAYS gates — the exitLockOn() conditional is
  // gone because the unconditional rule is strictly stronger. What this guard now bans is
  // any UN-GATED path: backToProfiles may appear only as startPin's onSuccess, never as a
  // free-standing branch, or a child switches to a sibling's profile in one tap again.
  assert.match(body, /startPin\(/, 'the profile switch no longer asks for the parent code');
  // comments stripped first — the function's own doc block NAMES the old escape, and a
  // pin a comment can trip pins prose, not code (the snapshot-guard lesson, again)
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const freestanding = code.replace(/onSuccess:\s*backToProfiles/g, '');
  assert.doesNotMatch(freestanding, /backToProfiles/,
    'onProfileChip has an un-gated path to the profile picker');
  // and the gate must not fail OPEN — in the FUNCTION, not only in the wiring line: a
  // catch anywhere in onProfileChip that falls back to backToProfiles makes a locked
  // profile escapable by whatever made the check throw. (The first version looked only
  // at the addEventListener line, so a `.catch(() => backToProfiles())` inside the
  // function body — the documented real escape — passed it.)
  assert.doesNotMatch(body, /catch[\s\S]{0,120}backToProfiles/,
    'onProfileChip falls back to backToProfiles on a throw — the switch gate fails open');
  const wiring = app.split('\n').find((l) => l.includes("$('profile-chip').addEventListener")) || '';
  assert.match(wiring, /onProfileChip/, 'the chip is wired straight to backToProfiles again');
  assert.doesNotMatch(wiring, /catch[\s\S]{0,120}backToProfiles/, 'the switch gate fails open at the wiring');

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
  // and it must actually CALL the OS pinning, not just the button. The first version
  // matched the bare names, which the destructuring import line satisfies on its own —
  // deleting both OS calls left the kiosk as a hidden button and a green suite.
  const helperAt = app.indexOf('async function applyExitLock(');
  assert.ok(helperAt > 0, 'the per-profile arming helper is gone — re-anchor this guard');
  const helper = app.slice(helperAt);
  const helperBody = helper.slice(0, helper.indexOf('\n}\n') + 1);
  assert.match(helperBody, /await lockTask\(\)/, 'the helper no longer pins — the import alone is not a call');
  // v1.0.36 SUPERSEDES the old "helper must release" half: releasing on activation is
  // exactly what raised the device keyguard mid-profile-switch. The never-unpin rule
  // (and the release points that replace it) is pinned by its own test below.
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

test('the preview bubble leaves the screen behind it untouched (v1.0.26)', () => {
  // The bubble exists so a parent can CHECK a video without losing the queue they are
  // triaging. Everything here is a way that promise gets broken silently.
  const app = MODULES.get('www/js/app.js');
  // Every slice must PROVE its anchor first (the handleSourceShare pattern above): an
  // indexOf that answers -1 makes slice(-1) a one-character body, the inner indexOf
  // answers -1 too, and every doesNotMatch below passes vacuously on an EMPTY string —
  // a renamed function turned this whole test into decoration once already.
  const sliceAt = (needle) => {
    const at = app.indexOf(needle);
    assert.ok(at > 0, `app.js lost the anchor "${needle}" — this guard cannot run on an empty slice`);
    return app.slice(at);
  };

  // 1. It must not be the kid player. setupHud binds window/document listeners and must
  //    never run twice without a teardown; the kid HUD also hides the very scrub bar the
  //    parent needs. The bubble builds its own iframe from the tested pure URL.
  assert.match(app, /previewEmbedUrl\(/, 'the preview no longer uses the tested embed URL');
  const fn = sliceAt('function renderPreview(');
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.doesNotMatch(body, /playItem\(/, 'the preview mounts the KID player — setupHud runs twice');

  // 2. Closing must tear the player out, or a video keeps playing behind the parent screen.
  const close = sliceAt('function closePreview(');
  assert.match(close.slice(0, close.indexOf('\n}\n') + 1), /innerHTML = ''/,
    'closing the bubble leaves the iframe alive and playing');
  assert.match(app, /onLeave: \(\) => closePreview\(\)/,
    'leaving the parent screen no longer stops the preview');

  // 3. Hardware back must close the BUBBLE first, not throw the parent out of the screen.
  const reg = sliceAt("nav.register('parent'");
  assert.match(reg.slice(0, 400), /isPreviewOpen\(\)/, 'back skips the bubble and leaves the screen');

  // 4. THE promise itself: deciding one video must not untick the rows the parent lined up.
  //    Doing this by parameter was wrong — refreshAfterAdd rebuilds the list a beat later
  //    and cleared them right back — so preservation is unconditional and filtered against
  //    the rebuilt list.
  const rp = sliceAt('async function refreshPendingList(');
  const rpBody = rp.slice(0, rp.indexOf('\n}\n') + 1);
  assert.match(rpBody, /const carried = new Set\(pendingSel\)/, 'the selection is dropped on rebuild again');
  assert.match(rpBody, /alive\.has\(id\)/, 'ticks are restored without checking the row still exists');
  assert.doesNotMatch(app, /keepSelection/, 'preservation is conditional again — refreshAfterAdd will undo it');

  // 5. A cancelled confirm must not count as a decision and skip the video.
  const pd = sliceAt('async function previewDecide(');
  assert.match(pd.slice(0, pd.indexOf('\n}\n') + 1), /!== false/,
    'backing out of the delete confirm still advances past the video');
});

test('NO share route can be silent (v1.0.26)', () => {
  // THE field bug: a parent reported that sharing from YouTube does not work, and the app
  // could not answer which of seven silent `return`s it had taken — nor did success say
  // anything either. Every route now ends in a reason, and app.js shows it.
  const share = MODULES.get('www/js/share.js');
  const fnBody = (name) => {
    const at = share.indexOf(`async function ${name}(`);
    assert.ok(at > 0, `share.js lost ${name} — re-anchor this guard`);
    const fn = share.slice(at);
    return fn.slice(0, fn.indexOf('\n}\n') + 1);
  };

  // EVERY function on the share path, not just routeShare: three of the seven real
  // v1.0.26 drops lived in handleSourceShare, which the first version never scanned.
  // (drainShareQueue/initShareTarget stay out: their early returns mean "no share
  // arrived", not a share swallowed.)
  const FLOWS = ['handleShare', 'routeShare', 'handleSourceShare'];
  const reasons = new Set();
  for (const name of FLOWS) {
    const body = fnBody(name);
    // A silent drop is `return;` — and `return null;` / `return undefined;` are the SAME
    // nothing wearing a value. The first version matched only the bare form. Shape-based,
    // not line-based: the real ones look like `if (!c) return;` mid-line.
    assert.doesNotMatch(body, /\breturn\s*(?:null|undefined)?\s*;/,
      `${name} has a silent return — that is a share the parent never hears about`);
    // harvest EVERY reason a return can answer, INCLUDING ternary arms
    // (`return a ? 'pending' : 'added';` — the old `return '…'` shape missed both)
    for (const st of body.matchAll(/\breturn\b([^;]*);/g)) {
      for (const lit of st[1].matchAll(/'([a-z][a-z-]*)'/g)) reasons.add(lit[1]);
    }
  }

  // and handleShare must actually report what routeShare answered
  assert.match(fnBody('handleShare'), /onResult\(reason\)/,
    'the reason is computed and then thrown away');

  // every reason share.js can return must exist in the pure message table
  assert.ok(reasons.size >= 10,
    `only ${reasons.size} reasons harvested — the share sweep went blind`);
  const table = MODULES.get('www/js/plan.js');
  for (const r of reasons) {
    assert.ok(table.includes(`  ${r}: {`) || table.includes(`  '${r}': {`),
      `share.js can answer '${r}' but plan.js has no message for it`);
  }

  // app.js must render them
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /resultHandler:/, 'app.js no longer listens for share outcomes');
  assert.match(app, /shareOutcome\(reason\)/, 'the outcome is not turned into a message');
  assert.match(app, /toast\(/, 'nothing shows the message');
});

test('no module parses an ISO-8601 duration (Shorts are not a length)', () => {
  // THE trap. YouTube defines a Short as "≤3 minutes AND square-or-taller"; the Data API
  // exposes no aspect ratio and no isShort field, so length can never reproduce the rule.
  // Measured 2026-07-31: 6 of the 15 most recent Super Simple Songs LONG-FORM uploads are
  // under 3 minutes (3 of 15 for Cocomelon) — a duration filter would silently delete real
  // nursery rhymes, the app's core content. Membership of the UULF/UUSH playlists is the
  // only correct filter; see quota.planBackfillPlaylist.
  //
  // Nothing here needs a duration (the player reads seconds off the media element, not
  // the API). The banned shape is any realistic parser over `PT…H/M/S`: `PT` followed by
  // a group, a `\d` or a `[0-9]`, with an H/M/S unit nearby. The first version banned the
  // literal `PT(?:` — only NON-CAPTURING-group parsers — and `/PT(\d+H)?/`, the shape a
  // parser that actually wants the numbers uses, sailed straight past it.
  const durationParser = /PT(?:\(|\\d|\[0-9\])[^\n]{0,40}[HMS]/;
  // prove the pattern can fire on the shapes it exists to catch (TESTING.md rule 2)
  for (const bad of ['/^PT(\\d+H)?(\\d+M)?(\\d+S)?$/', '/PT(?:(\\d+)H)?/',
    'PT([0-9]+M)', '/PT\\d+S/']) {
    assert.match(bad, durationParser, 'the duration-parser pattern went vacuous');
  }
  for (const [p, body] of MODULES) {
    assert.doesNotMatch(body, durationParser,
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

test("the name input's maxlength IS store.PROFILE_NAME_MAX", async () => {
  // v1.0.26: the profile-name limit lives in TWO places that cannot see each other — the
  // `maxlength` attribute the parent actually types against, and the cap `createProfile`
  // stores by. Before this release the attribute was the ONLY one, so the limit was a DOM
  // detail no test could reach; now that both exist, the failure mode is drift: raise the
  // attribute alone and long names reach storage unbounded, raise the constant alone and
  // the parent simply cannot type them. The profile TILE is sized for `PROFILE_NAME_MAX`
  // (2 lines at 9em, browser-measured), so the attribute is what keeps that promise true.
  const { PROFILE_NAME_MAX } = await import('../www/js/store.js');
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const tag = html.match(/<input[^>]*id="create-name"[^>]*>/);
  assert.ok(tag, 'index.html has no #create-name input');
  const attr = tag[0].match(/maxlength="(\d+)"/);
  assert.ok(attr, `#create-name has no maxlength — the cap would be silent: ${tag[0]}`);
  assert.equal(Number(attr[1]), PROFILE_NAME_MAX,
    'index.html maxlength and store.PROFILE_NAME_MAX disagree');
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

test('the pending-reset banner is rendered by the HOME, not only behind the PIN', () => {
  // v1.0.26. The 24-hour wait is not what protects the parent — the ANNOUNCEMENT is. A
  // reset request that nobody sees just means the child waits a day and walks in, so the
  // notice has to be on the screen that is on all day. If `renderHome` stops drawing it,
  // the feature silently becomes a delay with no alarm attached, and every unit test for
  // `planPinRecovery` still passes.
  const app = MODULES.get('www/js/app.js');
  const home = app.slice(app.indexOf('async function renderHome('));
  const body = home.slice(0, home.indexOf('\n}\n'));
  assert.match(body, /refreshRecoveryBanner\(/,
    'renderHome no longer announces a pending parent-code reset');
});

test('a PIN-reset request is DEVICE-LOCAL: exactly one module knows the key', () => {
  // v1.0.26. The request must not travel. The PIN hash itself is synced (that is why
  // recovery has to exist at all), but a *pending reset* is not family state: syncing it
  // would let one device start the clock on every other one, and a peer's stale copy
  // could re-arm a request the parent already cancelled. Keeping the key in a single
  // module is what makes that checkable — `drive.serializeDb` cannot carry what it cannot
  // name, and nothing can read it behind the PIN and quietly decide otherwise.
  const owners = [];
  for (const [p, body] of MODULES) {
    if (body.includes('pinRecoveryAt')) owners.push(p);
  }
  assert.deepEqual(owners, ['www/js/recovery.js'],
    'the recovery timestamp leaked out of recovery.js — see the comment above');
});

test('the device-credential bridge fails CLOSED, and cannot lock a parent out', () => {
  // v1.0.26. Two opposite failures, both reachable from one sloppy line in platform.js:
  //   (a) treating a thrown/absent bridge as SUCCESS would open the parent screen to
  //       anyone on any device where the plugin is missing — i.e. the browser, and every
  //       APK built before this method existed;
  //   (b) letting it THROW would blow up `onPinForgot` before it can offer the 24-hour
  //       wait, turning a missing fingerprint sensor into a permanent lockout.
  // So both wrappers must compare against an explicit `=== true` and swallow.
  const plat = MODULES.get('www/js/platform.js');
  for (const fn of ['canDeviceAuth', 'deviceAuth']) {
    const i = plat.indexOf(`export async function ${fn}(`);
    assert.ok(i > 0, `platform.js no longer exports ${fn}`);
    const body = plat.slice(i, plat.indexOf('\n}', i));
    assert.match(body, /catch\s*\{\s*return false;?\s*\}/,
      `${fn} lets a bridge error escape — a locked-out parent never reaches the wait`);
    assert.match(body, /===\s*true/, `${fn} accepts a truthy value as proof of an adult`);
  }
});

test('a failed device prompt still offers the wait', () => {
  // The fast path is an ADDITION, never a replacement. If `onPinForgot` returns on a
  // failed prompt instead of falling through, then on a device WITH a lock screen the
  // 24-hour route becomes unreachable — and that is the only route that always works.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function onPinForgot('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /planRecoveryRoute\(/, 'app.js re-implements the route decision inline');
  // Scope to the DEVICE branch alone. Slicing to the end of the function made this guard
  // vacuous: the wait-start branch below also calls requestRecovery(), so deleting the
  // fallback entirely still passed. Caught by planting exactly that.
  const from = body.indexOf("if (route === 'device')");
  assert.ok(from > 0, 'onPinForgot no longer has a device branch');
  const to = body.indexOf('const go = await confirmKid', from);
  assert.ok(to > from, 'the wait-start branch moved — re-anchor this guard');
  const dev = body.slice(from, to);
  assert.match(dev, /requestRecovery\(/,
    'the device branch never falls back to the wait when the prompt fails');
});

test('no step of the channel-add flow is left silent (v1.0.26)', () => {
  // FIELD REPORT: "adding a channel takes a while — fine — but between clicks I cannot
  // tell whether it is still working or waiting for me." Only the long import ever showed
  // anything; every other step handed back the ordinary screen with work still running.
  //
  // Two things must hold, and neither is visible to a unit test:
  //   (a) every stage app.js waits on has TEXT in plan.js — otherwise the parent gets the
  //       generic "בטעינה…", which is the same non-answer;
  //   (b) the post-decision sync is AWAITED, because that one is a second full library
  //       sync and was by far the longest silence.
  const app = MODULES.get('www/js/app.js');
  const plan = MODULES.get('www/js/plan.js');

  const used = [...app.matchAll(/withChannelWait\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 4, `only ${used.length} waited steps — the flow went quiet again`);
  for (const stage of new Set(used)) {
    assert.match(plan, new RegExp(`^\\s{2}${stage}\\s*:`, 'm'),
      `app.js waits on '${stage}' but plan.channelAddWait has no text for it`);
  }

  // The blocking wait, and its valve. `wait: true` is what turns the fire-and-forget
  // refresh into something the parent can see finish.
  const imp = app.slice(app.indexOf('async function importChannelAndAsk('));
  const body = imp.slice(0, imp.indexOf('\n}\n'));
  assert.match(body, /withChannelWait\(\s*'finishing'/, 'the post-decision work went silent again');
  assert.match(body, /refreshAfterAdd\(\{[^}]*wait:\s*true/, 'the second sync is fire-and-forget again');
  // A loading screen swallows back, so an unbounded wait is a trap, not a courtesy.
  assert.match(body, /waitWithValve\(/, 'the blocking wait lost its escape valve');
});

test('the orphan GC delegates to planOrphanGC, and the playlist stages are gated (v1.0.27)', () => {
  // Three fixes from one review, all in the standalone-playlist family — each pinned to
  // the LIVE code path so the pure tests cannot pass while production regrows the inline
  // version they replaced (the v1.0.20 "it pinned the fixture" lesson).
  const sync = MODULES.get('www/js/sync2.js');
  const app = MODULES.get('www/js/app.js');

  // (a) the GC: the inline predicate deleted every standalone-playlist video on every
  //     mirror pass (their channelId is the OWNER, not the subscribed playlist id).
  //     v1.0.38: the sweep moved into its own `gcOrphans`, so the anchor is that function.
  const gcAt = sync.indexOf('export async function gcOrphans(');
  assert.ok(gcAt > 0, 'gcOrphans is gone — the orphan sweep has no home');
  const gc = sync.slice(gcAt, sync.indexOf('\n}\n', gcAt));
  assert.match(gc, /planOrphanGC\(/, 'the orphan GC no longer delegates to planOrphanGC');
  assert.doesNotMatch(sync, /!subscribed\.has\(rec\.channelId\)/,
    'the inline orphan predicate is back — it deletes playlist videos');
  // ONE sweep site: a second renderer-style private copy is how this bug class returns.
  assert.equal((sync.match(/planOrphanGC\(/g) || []).length, 1,
    'planOrphanGC gained a second caller — the sweep must have exactly one site');
  for (const p of [...MODULES.keys()]) {
    if (p === 'www/js/sync2.js' || p === 'www/js/plan.js') continue;
    assert.doesNotMatch(MODULES.get(p), /planOrphanGC\(/, `${p} sweeps orphans on its own`);
  }

  // (b) the standalone playlist stage must gate items like the channel stage does:
  //     a MISSING owner is a private/deleted entry (an untappable "Private video" tile).
  const stAt = sync.indexOf('מושכים סרטונים מרשימת ההשמעה');
  assert.ok(stAt > 0, 'the standalone playlist stage moved — re-anchor this guard');
  assert.match(sync.slice(stAt, stAt + 900), /acceptPlaylistItem\(/,
    'the standalone playlist stage pushes page items unfiltered');

  // (c) the share confirm: a playlist fell into the VIDEO branch, so handleSourceShare
  //     (which accepts only the source decision) answered "ההוספה בוטלה" after the
  //     parent tapped הוספה — the v1.0.26 feature could not succeed on any path.
  const shAt = app.indexOf('function handleShareInteractive(');
  assert.ok(shAt > 0, 'handleShareInteractive moved');
  const sh = app.slice(shAt, app.indexOf('\n}\n', shAt));
  assert.match(sh, /kind === 'playlist'/, 'handleShareInteractive treats a playlist as a video again');
});

test('snapshot deny import goes through the LWW merge — never a blind restamped put', () => {
  // v1.0.26: importProfileSnapshot used to `deny.put({ …, at: d.at || Date.now(), … })` —
  // the v1.0.22 copyDenies bug replayed. A revoked tombstone lost its `removedAt`, took a
  // fresh `at`, imported as ACTIVE-and-newest, clobbered any local revocation, and the
  // restamped row then won every Drive merge and re-deleted the video on every device.
  // The decision now lives in pure planDenyImport (behaviourally tested in
  // snapshot.test.mjs); this pin only holds the IDB loop — which no node test can
  // execute — onto that helper, and bans the exact restamping shape. Comments are
  // STRIPPED first: snapshot.js quotes the old shape in its own doc blocks, and a pin
  // that a comment can satisfy (or trip) pins prose, not code — the routeShare-guard
  // lesson.
  const body = MODULES.get('www/js/snapshot.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(body, /planDenyImport\(existingDenies/,
    'importProfileSnapshot no longer routes deny rows through planDenyImport');
  assert.doesNotMatch(body, /d\.at\s*\|\|\s*Date\.now\(\)/,
    'the blind restamping deny put is back');
  // and the EXPORT carries FULL rows: loadDenySet hides revoked entries, so exporting
  // through it silently dropped every revocation from the backup (presence must be judged
  // by the record existing — the db.copyDenies rule).
  assert.doesNotMatch(body, /loadDenySet/,
    'the export filters the deny-list through loadDenySet again — revocations do not travel');
});

test('the TV remote can reach folded sections (v1.0.28)', () => {
  // <details>/<summary> became the parent screen's main structure (the grouped library
  // list; the rejected archive had it since v1.0.23) — and `summary` was never in the
  // D-pad's focusable selector, so on Android TV every folded section was silently
  // unreachable: the remote skipped straight over it and the content inside might as
  // well not exist. Enter on a focused summary toggles natively; FOCUS was the gap.
  const dpad = MODULES.get('www/js/ui/dpad.js');
  const at = dpad.indexOf('querySelectorAll');
  assert.ok(at > 0, 'the focusables selector moved — re-anchor this guard');
  // end-anchor searched FROM the selector: the word also appears in a comment above it,
  // and slicing to the first occurrence made this guard fail on the correct code
  const sel = dpad.slice(at, dpad.indexOf('offsetParent', at));
  assert.match(sel, /\bsummary\b/, 'summary fell out of the D-pad focusable selector');
});

test('the preview bubble is reachable from a TV remote (v1.0.29)', () => {
  // The bubble is an OVERLAY outside every .view (deliberately — the screen behind keeps
  // its state), so the D-pad's view-scoped scan could never see its buttons: on TV it
  // opened and the remote was trapped behind it. And the thumbnail that OPENS it was a
  // bare <img> with a click listener — not focusable, Enter-dead.
  // comments stripped: the fix's own comment names the bubble, and a pin a comment can
  // satisfy pins prose (this exact plant passed the first version of this guard)
  const dpad = MODULES.get('www/js/ui/dpad.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(dpad, /getElementById\('preview-bubble'\)/,
    "dpad's scope priority lost the open bubble");
  assert.match(dpad, /\?\s*pv\s*:/, 'the bubble branch fell out of the scope ternary');
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('function parentRow(');
  assert.ok(at > 0, 'parentRow moved');
  const fn = app.slice(at, at + 3500);
  assert.match(fn, /img\.tabIndex = 0/, 'the preview thumbnail fell out of the focus scan');
  assert.match(fn, /'Enter'/, 'Enter no longer opens the preview from the remote');
});

test('every D-pad-focusable type that has no native ring gets the TV focus ring (v1.0.29)', () => {
  // On Android TV the ONLY cue to what the remote is on is the focus ring. The D-pad
  // focusable selector (dpad.js) and the `html.tv …:focus` ring rule (styles.css) are two
  // lists that must stay in step: `summary` and `[href]` are focusable but are neither
  // button/input nor carry a [tabindex] ATTRIBUTE (a native summary's tabIndex is a
  // PROPERTY, not an attribute — `[tabindex]` never matches it), so without their own
  // entry they were focusable-but-INVISIBLE from the remote — the grouped-library sections
  // (v1.0.28) and the privacy link. This pins that both are in the ring rule.
  const css = readFileSync(join(ROOT, 'www', 'css', 'styles.css'), 'utf8');
  const ring = css.slice(css.indexOf('html.tv button:focus'), css.indexOf('{', css.indexOf('html.tv button:focus')));
  assert.ok(ring, 'the html.tv focus-ring rule moved — re-anchor this guard');
  for (const sel of ['summary:focus', '[href]:focus']) {
    assert.ok(ring.includes(sel), `the TV focus ring does not cover ${sel} — it is focusable but invisible on TV`);
  }
});

test('the scheduled lock is device-local timer + synced settings (v1.0.31)', () => {
  // A lock is about THIS device's session — syncing "locked until X" would lock a sibling's
  // device on the same account. So the two live timestamps live in Preferences keyed by
  // profile, and MUST NOT appear in the Drive settings channel. The SETTINGS (after/duration)
  // do sync, like the other per-profile settings.
  const app = MODULES.get('www/js/app.js');
  // the timer keys are prefGet/prefSet only, never getSetting/putSetting
  assert.match(app, /schedlock:.*:armed/, 'the armed-timer pref key is gone');
  assert.match(app, /schedlock:.*:until/, 'the locked-until pref key is gone');
  // the SETTINGS travel through the synced channel
  assert.match(app, /putSetting\(activeProfileId, 'lockAfterMin'/, 'lockAfterMin is not saved to the synced settings');
  assert.match(app, /putSetting\(activeProfileId, 'lockDurationMin'/, 'lockDurationMin is not saved to the synced settings');
  // the live timer must never be serialized to Drive
  const drive = MODULES.get('www/js/drive.js');
  assert.doesNotMatch(drive, /schedlock:/, 'the device-local lock timer leaked into the Drive document');
  // the decision is the pure helper, not re-implemented inline
  assert.match(app, /evalScheduledLock\(/, 'app.js re-implements the lock decision inline');
});

test('the scheduled-lock screen cannot be escaped by the child (v1.0.31)', () => {
  // It swallows hardware-back (like the loading screen), and the ONLY exit is the exit
  // button — shown solely when the kiosk lock is OFF — or the discreet parent-code tap.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /nav\.register\('locked',\s*\{\s*onBack:\s*\(\)\s*=>\s*true/,
    "the locked view does not swallow back — a child can navigate out of it");
  const fn = app.slice(app.indexOf('async function showLockedScreen('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /exitLockOn\(\)/, 'the exit button is shown without checking the kiosk lock');
  assert.match(body, /locked-exit'\)\.classList\.toggle\('hidden', kiosk\)/,
    'the exit button is not gated on the kiosk lock (must hide when kiosk is ON)');
});

test('screen-off pauses the video (v1.0.32) — the lifecycle listener exists and does both halves', () => {
  // Node cannot press a tablet's power button, so this is a source guard (the kind a
  // behavioural test cannot express). Android does NOT pause the WebView: before this
  // listener a playing video kept its soundtrack running behind a dark screen. Proven to
  // fail on a planted regression (listener removed / a half dropped).
  const app = MODULES.get('www/js/app.js');
  const m = app.match(/onAppPause\(\(\) => \{([\s\S]*?)\}\);/);
  assert.ok(m, 'app.js no longer registers an onAppPause listener — screen-off keeps playing');
  // comment lines don't count — the first version of this guard passed with the call
  // commented out, which is exactly the vacuous-guard failure TESTING.md warns about
  const body = m[1].split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // save FIRST (it reads the live playhead), then pause. Both halves, this order.
  const save = body.indexOf('saveWatchPosition(currentWatch)');
  const pause = body.indexOf('pauseCurrent()');
  assert.ok(save >= 0, 'the screen-off handler no longer banks the stop point');
  assert.ok(pause >= 0, 'the screen-off handler no longer pauses the player');
  assert.ok(save < pause, 'pause runs before the save — the saved playhead may be stale');
  // and the pause must be IN PLACE — stop() tears the player down, which is the
  // "הסרטון נעלם" the user reported. The handler must not contain a bare stop() call.
  assert.doesNotMatch(body, /\bstop\(\)/, 'the screen-off handler tears the player down');
  // platform.js: the listener really is the INACTIVE half of appStateChange
  const platform = MODULES.get('www/js/platform.js');
  const fn = platform.slice(platform.indexOf('export function onAppPause('));
  assert.match(fn.slice(0, 400), /!s\.isActive/, 'onAppPause no longer keys on isActive:false');
});

test('idle screen-off (v1.0.34): the sleep branch does both halves IN ORDER, in place, and the plumbing is wired', () => {
  // Node cannot wait ten minutes in front of a tablet, so this is a source guard for
  // what the pure tests cannot see: the app-side plumbing. Same discipline as the
  // v1.0.32 screen-off guard above — comment lines don't count, and each clause was
  // proven to fail on a planted regression before landing.
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function tickIdleSleep('));
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // the decision is the PURE helper's, fed through the sanitizer that knows
  // never-written ≠ explicit 0 (Number(null) is 0 — the wrong kind of "off")
  assert.match(body, /screenOffMinutes\(/, 'the minutes no longer pass the never-written/0 sanitizer');
  assert.match(body, /evalIdleSleep\(/, 'the tick no longer delegates to the pure decision');
  // the sleep half: save FIRST (reads the live playhead), THEN pause — IN PLACE.
  const save = body.indexOf('saveWatchPosition(currentWatch)');
  const pause = body.indexOf('pauseCurrent()');
  assert.ok(save >= 0, 'the idle sleep no longer banks the stop point');
  assert.ok(pause >= 0, 'the idle sleep no longer pauses the player');
  assert.ok(save < pause, 'pause runs before the save — the saved playhead may be stale');
  // stop() here is the "הסרטון נעלם" bug: the child comes back to a black hole
  assert.doesNotMatch(body, /\bstop\(\)/, 'the idle sleep tears the player down');
  // input is observed at the WINDOW in CAPTURE phase for both touch and remote keys —
  // a handler that stops propagation must not be able to starve the timer
  assert.match(app, /addEventListener\('pointerdown', onUserInput, true\)/,
    'touch no longer counts as user input (capture listener gone)');
  assert.match(app, /addEventListener\('keydown', onUserInput, true\)/,
    'remote keys no longer count as user input — a TV child would be paused mid-episode');
  // the answer tap must consume its WHOLE gesture: hiding the overlay on pointerdown
  // puts the tap-shield under the finger, and the shield acts on the END of a tap —
  // without these the "I'm here" tap PAUSED the video (measured in the browser)
  for (const tail of ['pointerup', 'click', 'pointercancel']) {
    assert.match(app, new RegExp(`addEventListener\\('${tail}', swallowIdleGestureTail, true\\)`),
      `the answer tap's ${tail} is no longer consumed — answering the prompt pauses/toggles the video`);
  }
  // the prompt overlay lives INSIDE #player-wrap — that is the element that goes
  // fullscreen; outside it the question is invisible while a video plays
  const html = readFileSync(join(ROOT, 'www', 'index.html'), 'utf8');
  const wrap = html.indexOf('id="player-wrap"');
  const prompt = html.indexOf('id="idle-prompt"');
  const hudEnd = html.indexOf('class="player-hud"');
  assert.ok(wrap >= 0 && prompt > wrap && hudEnd > prompt,
    'the "עדיין צופים?" overlay left #player-wrap — invisible in fullscreen');
});

test('NOTHING can attach a sources sheet any more (v1.0.38)', () => {
  // The migration DELETES the family's sheet files, so a re-attached URL would point at a
  // file nothing maintains — and it would undo the migration on the next launch. The wizard,
  // its view, the connect door and the copy button are all gone.
  const app = MODULES.get('www/js/app.js');
  const html = readFileSync(join(ROOT, 'www/index.html'), 'utf8');
  for (const gone of ['openSheetSetup', 'connectWizardSheet', 'wizardGated', 'wizardCreateSheet',
    'joinExistingSheet', 'createSourceSheet', 'listAppSheets', 'sheetsetup']) {
    assert.ok(!app.includes(gone), `app.js still references ${gone}`);
  }
  for (const gone of ['view-sheet-setup', 'sheetsetup-', 'remote-connect', 'remote-copy']) {
    assert.ok(!html.includes(gone), `index.html still has ${gone}`);
  }
  // a nav registration for a view that no longer exists is a silent back-handling hole
  assert.doesNotMatch(app, /nav\.register\('sheet-setup'/, 'the wizard nav registration survived its view');
  // creating a profile must land IN the app, not in a deleted screen
  const cn = app.slice(app.indexOf('async function createNewProfile('));
  const body = cn.slice(0, cn.indexOf('\n}\n'));
  assert.match(body, /activateProfile\(p\.id\)/, 'profile creation no longer enters the app');
  // and no scope can change any more — that is what makes the sunset's libraryId rule real
  for (const [p, b2] of CODE) {
    assert.doesNotMatch(b2, /moveScope\s*\(|planScopeAdoption\s*\(|adoptLibraryScope\s*\(/,
      `${p} can still move a library scope`);
  }
});

test('the picker exit button cannot walk through an armed kiosk (v1.0.32)', () => {
  // askExit also serves the BOOT profile picker, where no profile is active yet — but
  // the kiosk was armed from the LAST ACTIVE one (the launch rule). Reading only the
  // live global would let the picker's exit button walk straight through an armed lock
  // (the real case: a cold-start share showing the picker on a locked device).
  const app = MODULES.get('www/js/app.js');
  const fn = app.slice(app.indexOf('async function askExit('));
  const body = fn.slice(0, fn.indexOf('\n}\n'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(body, /exitLockOn\(activeProfileId \|\| await prefGet\('activeProfile'\)\)/,
    'askExit no longer falls back to the stored profile — the boot picker bypasses the kiosk');
  // and the picker really has the button wired to this flow
  assert.match(app, /\$\('profiles-exit'\)\.addEventListener\('click', askExit\)/,
    'the picker exit button is not bound to askExit');
});

/* ---------------- kiosk pin/unpin discipline (v1.0.36) ---------------- */

test('profile activation NEVER unpins, and resume re-arms the lock (v1.0.36)', () => {
  // stopLockTask() raises the DEVICE keyguard on many devices ("lock device when
  // unpinning" is a system setting the app can neither read nor change) — so
  // applyExitLock's old else-branch locked the whole TABLET when switching from a
  // locked child to an unlocked sibling (field report). The activation path may only
  // PIN; the unpin belongs to askExit, the settings toggle and the native installer.
  const app = MODULES.get('www/js/app.js');
  const start = app.indexOf('async function applyExitLock()');
  assert.ok(start > 0, 'applyExitLock not found');
  const body = app.slice(start, app.indexOf('\n}', start));
  assert.ok(!body.includes('unlockTask'),
    'applyExitLock unpins again — profile switches will raise the device keyguard');
  assert.ok(body.includes('lockTask'), 'applyExitLock no longer pins at all');
  // The installer unpins natively; a CANCELLED install resumes back into the app still
  // unpinned on a locked profile — resume must re-arm or the kiosk is silently off.
  const resumeStart = app.indexOf('onAppResume(async () => {');
  assert.ok(resumeStart > 0, 'onAppResume block not found');
  const resumeBody = app.slice(resumeStart, app.indexOf('\n  });', resumeStart));
  assert.ok(resumeBody.includes('applyExitLock'),
    'resume no longer re-arms the exit lock — a cancelled update leaves the kiosk off');
});

test('native pin/unpin are gated on lock-task state and the installer unpins — BOTH java copies (v1.0.36)', () => {
  for (const p of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const java = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(java.includes('private boolean inLockTask()'), `${p}: the inLockTask gate is gone`);
    const lock = java.slice(java.indexOf('public void lockTask'), java.indexOf('public void isTaskLocked'));
    assert.ok(lock.includes('if (inLockTask())') && lock.includes('if (!inLockTask())'),
      `${p}: lockTask/unlockTask no longer gate on the current state — redundant unpins keyguard the tablet`);
    // A PINNED task cannot start the system installer (Android refuses new tasks over
    // lock-task mode), so with the kiosk ON the update button did nothing.
    const inst = java.slice(java.indexOf('public void installApk'), java.indexOf('private void startInstaller'));
    assert.ok(inst.includes('stopLockTask'),
      `${p}: installApk no longer unpins first — updates are dead under the kiosk lock`);
  }
});

/* ---------------- channel-deletion tombstones (v1.0.36) ---------------- */

test('a channel deletion writes its tombstone FIRST, and a move never writes one (v1.0.36)', () => {
  // The pure halves (merge filter, apply plan) are behavior-tested in gdrive.test.mjs;
  // this pins the IDB wiring the node suite cannot execute.
  const db = MODULES.get('www/js/db.js');
  const fnAt = db.indexOf('export async function deleteLibraryChannel(');
  assert.ok(fnAt > 0, 'deleteLibraryChannel not found');
  const body = db.slice(fnAt, db.indexOf('\n}\n', fnAt));
  const tombAt = body.indexOf('putDeletedChannels');
  const rowDelAt = body.indexOf('s.delete([libraryId, channelId])');
  assert.ok(tombAt > 0, 'deleteLibraryChannel no longer writes a tombstone — deletions resurrect on the next pull');
  assert.ok(rowDelAt > tombAt,
    'the tombstone must be written BEFORE the row delete (a crash in between must keep the intent)');
  // v1.0.38: moveScope was the other `tombstone: false` caller and is gone.
  // v1.0.45: snapshot.js joined, DELIBERATELY — importing a snapshot applies an external
  // document's tombstones, exactly like a Drive pull, and restamping them with Date.now()
  // there would make this device's copy instantly newer than the peer's and the two would
  // bump each other forever. What must never reach this branch is a PARENTAL deletion,
  // which is why each caller is also required to write the merged map first.
  const drive = MODULES.get('www/js/drive.js');
  // CALLERS only: db.js is where the parameter is DECLARED (`{ tombstone = true }`) and
  // documented, which is not a call site.
  const falseCallers = [...CODE.entries()]
    .filter(([k, b2]) => k !== 'www/js/db.js' && /tombstone: false/.test(b2)).map(([k]) => k);
  assert.deepEqual(falseCallers.sort(), ['www/js/drive.js', 'www/js/snapshot.js'],
    `tombstone:false is only for APPLYING an external doc's tombstones, found: ${falseCallers.join(', ')}`);
  assert.match(drive, /tombstone: false/, 'the apply path no longer preserves a peer tombstone');
  // Every such caller must persist the merged tombstone map BEFORE it deletes anything —
  // otherwise "the tombstone already exists" is a claim the code does not actually honour.
  for (const mod of falseCallers) {
    const body = CODE.get(mod);
    for (const [put, del] of [['putDeletedChannels(', 'tombstone: false'], ['putDeletedSiteEntries(', 'tombstone: false']]) {
      const p = body.indexOf(put);
      if (p < 0) continue;
      assert.ok(p < body.indexOf(del, p) || body.indexOf(del) > p,
        `${mod}: the merged tombstone map must be written before a ${del} delete`);
    }
  }
});

test('applyRemoteDoc routes libraryChannels through planChannelApply (v1.0.36)', () => {
  // pullDrive applies the RAW remote doc, so without this a stale doc still carrying a
  // deleted subscription re-puts it — the exact field report ("the channel comes back").
  const drive = MODULES.get('www/js/drive.js');
  const at = drive.indexOf('async function applyRemoteDoc(');
  assert.ok(at > 0, 'applyRemoteDoc not found');
  const body = drive.slice(at, drive.indexOf('\n}\n', at));
  assert.match(body, /planChannelApply\(/, 'applyRemoteDoc no longer consults the tombstone plan');
  assert.match(body, /putDeletedChannels\(/, 'the merged tombstones are not persisted — an interrupted apply forgets');
  assert.match(body, /for \(const lc of chPlan\.puts\)/,
    'libraryChannels are applied straight from the doc again, bypassing the tombstone filter');
  // the deletions must NOT restamp: the peer's own `at` is what converges
  assert.match(body, /deleteLibraryChannel\(libId, chId, \{ tombstone: false \}\)/,
    'apply-side deletions restamp the tombstone — the two devices will bump each other forever');
});

/* ---------------- the silent import ceiling (v1.0.37) ---------------- */

test('the import caps have a LIVE consumer — config.js is not decoration (v1.0.37)', () => {
  // THE TRAP THAT MADE THIS BUG SURVIVE FOUR RELEASES: config.js exported
  // MAX_ITEMS_PER_CHANNEL / MAX_ITEMS_TOTAL and NOTHING imported them, while the binding
  // values were literals frozen into every profile's `sources` row at creation. Editing
  // config.js changed nothing, no parent could raise the ceiling, and a library at 5000
  // silently imported zero from every new channel. A constant nobody reads is a lie.
  const consumers = [...MODULES.entries()]
    .filter(([p, s]) => p !== 'www/js/config.js' && /MAX_ITEMS_TOTAL/.test(s))
    .map(([p]) => p);
  assert.ok(consumers.length > 0, 'MAX_ITEMS_TOTAL is dead again — the caps are frozen per profile');
  assert.ok(consumers.includes('www/js/plan.js'), 'effectiveCaps must be the one place the caps come from');
});

test('the sync enforces effectiveCaps, never the frozen sources row (v1.0.37)', () => {
  const sync = MODULES.get('www/js/sync2.js');
  const at = sync.indexOf('planMutations({');
  assert.ok(at > 0, 'planMutations call not found');
  const call = sync.slice(at, sync.indexOf('});', at));
  assert.match(call, /caps: effectiveCaps\(src\)/,
    'the caps come from the stored row again — existing profiles stay frozen at their creation-day ceiling');
  assert.doesNotMatch(call, /src\.maxItemsTotal|src\.maxItemsPerChannel/,
    'the stored literals are back in the cap path');
});

test('a dropped import reaches the parent: sync → diagnose → message (v1.0.37)', () => {
  // The counts were computed since the overhaul and thrown away at every hop, which is
  // why an import that dropped 98 of 98 candidates still reported "the channel is empty".
  const sync = MODULES.get('www/js/sync2.js');
  const app = MODULES.get('www/js/app.js');
  const ret = sync.slice(sync.lastIndexOf('ok: true, added:'));
  assert.match(ret.slice(0, ret.indexOf('};')), /drops: plan\.drops/,
    'syncLibrary no longer returns the run\'s drops — the information dies in the sync again');

  const impAt = app.indexOf('async function importChannelAndAsk(');
  const imp = app.slice(impAt, app.indexOf('\n}\n', impAt));
  assert.match(imp, /await syncLibrary\([^)]*\)/, 'the forced sync call moved');
  assert.match(imp, /drops = res && res\.drops/, 'importChannelAndAsk discards the sync result again');
  assert.match(imp, /diagnoseEmptyChannel\(channelId, count, drops\)/,
    'the drops never reach the diagnosis, so a zero cannot name its cause');

  const diagAt = app.indexOf('async function diagnoseEmptyChannel(');
  const diag = app.slice(diagAt, app.indexOf('\n}\n', diagAt));
  assert.match(diag, /sourceDrops\(drops, channelId\)/, 'the diagnosis no longer reads the attribution');
  // BOTH return paths must carry them. The early `if (count)` return is the PARTIAL cap —
  // "12 waiting" out of 98 reads as the whole channel — and is the easy one to lose.
  const returns = diag.split('return ').slice(1);
  assert.equal(returns.length, 2, 'diagnoseEmptyChannel changed shape — re-anchor this guard');
  for (const [i, r] of returns.entries()) {
    assert.match(r, /capped/, `return #${i + 1} of diagnoseEmptyChannel no longer reports the cap`);
    assert.match(r, /denied/, `return #${i + 1} of diagnoseEmptyChannel no longer reports the tombstones`);
  }
});

test('a previously-removed backlog has a way back, and it is the PARENT who says yes (v1.0.37)', () => {
  // A deny tombstone is revoked by exactly one thing: the sheet re-adding the key
  // (v1.0.10). A channel video has no sheet row, so a single in-place delete — or the
  // 30-day purge of a rejected record (v1.0.26) — made the channel unimportable forever.
  // It must NOT be automatic: a parent who removed three bad videos must not get them
  // back for re-subscribing (the v1.0.23 rule).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function offerDeniedRestore(');
  assert.ok(at > 0, 'the restore offer is gone — a removed backlog is a permanent dead end again');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /confirmKid\(/, 'the restore no longer ASKS — it must never revoke tombstones silently');
  assert.match(body, /if \(!yes\) return false/, 'a declined restore must change nothing');
  assert.match(body, /unDeny\(/, 'the restore does not actually revoke the tombstones');
  const askAt = body.indexOf('confirmKid(');
  assert.ok(body.indexOf('unDeny(') > askAt, 'the tombstones are revoked BEFORE the parent answers');
  // wired into both add paths, and only when nothing arrived
  assert.equal((app.match(/offerDeniedRestore\(/g) || []).length, 3,
    'the restore must be offered by the channel AND the playlist add path (plus its definition)');
  assert.match(app, /if \(!count && await offerDeniedRestore\(channelId, empty\)\)/,
    'the channel path offers the restore unconditionally or not at all');
});

/* ---------------- the links file (v1.0.38) ---------------- */

test('the links import goes through classifySourceRow, never a raw line', () => {
  // classifyLink/classifySourceRow is THE safety boundary — every link that enters the
  // library passes through it. A bulk importer that split lines itself would be the one
  // door that skips it, on input the parent got from someone else.
  const lf = MODULES.get('www/js/linksfile.js');
  assert.ok(lf, 'linksfile.js is gone');
  const at = lf.indexOf('export function parseLinksFile(');
  assert.ok(at > 0, 'parseLinksFile is gone');
  const body = lf.slice(at, lf.indexOf('\n}\n', at));
  assert.match(body, /parseSourceRows\(parseCsv\(/,
    'parseLinksFile no longer tokenizes with parseCsv + parseSourceRows — the grammar was re-implemented');
  // and it must refuse an unreadable body BEFORE it can read as empty
  const htmlAt = body.indexOf('looksLikeHtml(');
  const parseAt = body.indexOf('parseSourceRows(');
  assert.ok(htmlAt > 0 && htmlAt < parseAt,
    'looksLikeHtml must run BEFORE parsing, or a saved permission page reads as "0 links"');
  assert.doesNotMatch(lf, /split\(\s*\/\[\\t,\]/, 'a hand-rolled delimiter split is back');
  // The module BUILDS canonical URLs (that is canonicalLinkFor's whole job) but must never
  // PARSE one — parsing is classify.js's. So every youtube.com literal must live inside
  // canonicalLinkFor, and none of them may be fed to .match()/.test().
  // Comments are stripped first: this is a rule about CODE, and the doc comment on
  // canonicalLinkFor explains at length why a stored youtu.be srcUrl is not used.
  const code = lf.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const buildAt = code.indexOf('export function canonicalLinkFor(');
  const buildEnd = code.indexOf('\n}\n', buildAt);
  const outside = code.slice(0, buildAt) + code.slice(buildEnd);
  assert.ok(!/youtube\.com|youtu\.be/.test(outside),
    'a YouTube URL literal escaped canonicalLinkFor — link building must stay in one place');
  assert.ok(!/\/[^\n/]*youtu[^\n/]*\/[gimsuy]*\s*\.(test|exec)|\.match\(\s*\/[^\n/]*youtu/.test(lf),
    'linksfile.js parses a YouTube link with its own regex — classifySourceRow owns that');
});

test('the links importer does NOT route through the per-item add paths', () => {
  // addClassifiedRow's channel branch raises importChannelAndAsk (loading screen + the
  // three-way approval dialog + a 90s finishing wait) PER CHANNEL, and its video branch
  // fires refreshAfterAdd + renderHome + a push PER VIDEO. A 16-channel file would raise
  // 16 dialogs; a 300-line file, 300 forced syncs.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function linksImportFromText(');
  assert.ok(at > 0, 'the links importer is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!body.includes('importChannelAndAsk('),
    'the importer calls importChannelAndAsk — that is one dialog per channel');
  assert.ok(!body.includes('addClassifiedRow('),
    'the importer calls addClassifiedRow — that is one forced sync per video');
  // ONE forced sync, and it must be forced: a non-forced call can JOIN a launch run that
  // already read the library (planSyncDispatch, the v1.0.25 field bug).
  assert.equal((body.match(/refreshAfterAdd\(/g) || []).length, 1,
    'the import must refresh exactly ONCE for the whole file');
  assert.match(body, /wait: true/, 'the import refresh must be the awaited one — it owns a waiting screen');
  // the denied question is asked ONCE, outside any loop over rows
  assert.equal((body.match(/deniedReAddPrompt\(/g) || []).length, 1,
    'the denied question must be asked once for the whole file, not per row');
  assert.match(body, /source: 'import', count: hits\.length/,
    'the denied question must carry the real count — that is the whole point of asking once');
});

test('a re-added deleted video is ANSWERED for, never silently destroyed (v1.0.38)', () => {
  // THE HOLE THIS CLOSES. A deny tombstone was revocable by exactly one thing — the SHEET
  // re-adding the key (planSheetMirror.unDenyKeys) — and drive.mergeDbFiles DELETES any
  // video whose tombstone is active from the merged document. addClassifiedRow never
  // consulted the deny set at all, so a re-pasted deleted video was written, shown to the
  // child, and destroyed by the next pull on every device.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function addClassifiedRow(');
  assert.ok(at > 0, 'addClassifiedRow is gone');
  const body = app.slice(at, app.indexOf("\n  if (row && row.kind === 'channel')", at));
  const gate = body.indexOf('offerDeniedReAdd(');
  const write = body.indexOf('db.putVideos(');
  assert.ok(gate > 0, 'the video add path no longer checks the deny list — the v1.0.38 hole is back open');
  assert.ok(write > 0 && gate < write, 'the deny check must run BEFORE the record is written');

  // the helper itself: it must ASK, and only un-deny on a yes
  const hAt = app.indexOf('async function offerDeniedReAdd(');
  assert.ok(hAt > 0, 'offerDeniedReAdd is gone');
  const helper = app.slice(hAt, app.indexOf('\n}\n', hAt));
  assert.match(helper, /confirmKid\(/, 'the re-add must ASK — never revoke a tombstone silently');
  assert.match(helper, /if \(!yes\) return false/, 'a declined re-add must not add the video');
  assert.ok(helper.indexOf('unDeny(') > helper.indexOf('confirmKid('),
    'the tombstone is revoked BEFORE the parent answers');
  // BOTH scopes: a key can carry a tombstone in the shared library and in the personal one
  assert.match(helper, /profScope\(activeProfileId\)/,
    'only one scope is un-denied — the other tombstone survives and re-deletes the video');
});

test('both revive dialogs get their words from ONE place (v1.0.38)', () => {
  // There are exactly two acts that revoke a deletion tombstone — re-adding one key
  // (deniedReAddPrompt) and restoring a channel's backlog (deniedRestorePrompt) — and their
  // wording must not drift into describing the same act differently. It already had: for one
  // commit `offerDeniedRestore` kept an inline copy while the pure helper sat unused, which is
  // also the "a helper with no consumer is a lie" smell (v1.0.37).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function offerDeniedRestore(');
  assert.ok(at > 0, 'offerDeniedRestore is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /deniedRestorePrompt\(/, 'offerDeniedRestore grew its own dialog text again');
  // no Hebrew dialog literal may live in either revive path — plan.js owns them
  for (const frag of ['לשחזר', 'שחזרו', 'להשאיר מוסר']) {
    assert.ok(!body.includes(frag), `offerDeniedRestore hard-codes "${frag}" — it belongs in plan.js`);
  }
  const plan = MODULES.get('www/js/plan.js');
  for (const fn of ['deniedReAddPrompt', 'deniedRestorePrompt']) {
    assert.match(plan, new RegExp('export function ' + fn + '\\('), `plan.${fn} is gone`);
  }
});

test('a snapshot import never re-introduces a forgotten sheet (v1.0.38)', () => {
  // An OLD snapshot still carries sheetUrl/sheetHash/sheetFolderId. Adopting one wholesale
  // put a sheetUrl back on a profile that had already migrated — inert today, but able to
  // outlive sunset.js itself, which is exactly what its deadline branch exists to prevent.
  // libraryId must SURVIVE: it is what puts the imported records where the profile looks.
  const snap = MODULES.get('www/js/snapshot.js');
  const at = snap.indexOf('const mySrc = await getSources(profileId);');
  assert.ok(at > 0, 'the snapshot sources adoption moved — re-anchor this guard');
  const body = snap.slice(at, at + 600);
  assert.match(body, /sheetUrl, sheetHash, sheetFolderId/, 'the sheet fields are adopted again');
  assert.ok(!/putSources\(\{ \.\.\.snap\.sources/.test(snap),
    'snap.sources is adopted wholesale again — that carries the sheet fields back in');
  assert.ok(!/libraryId[^\n]*\.\.\.rest|libraryId,/.test(body),
    'libraryId must NOT be stripped — the imported records would be unreachable');
});

test('EVERY unDeny in the UI layer sits next to a question (v1.0.38)', () => {
  // With the sheet gone there are exactly two sanctioned revocation paths, and both are an
  // explicit parental answer: offerDeniedReAdd (one key) and offerDeniedRestore (a
  // channel's backlog). A third, unconditional one would make deletion meaningless.
  for (const p of ['www/js/app.js', 'www/js/share.js', 'www/js/linksfile.js']) {
    const body = MODULES.get(p) || '';
    const re = /unDeny\(/g;
    let m;
    while ((m = re.exec(body))) {
      const around = body.slice(Math.max(0, m.index - 1400), m.index + 400);
      assert.ok(/deniedReAddPrompt|offerDeniedRestore|offerDeniedReAdd|reviveKeys/.test(around),
        `${p}: an unDeny at index ${m.index} is not guarded by a parental answer`);
    }
  }
});

test('the export WRITES the file before it shares it, and shares the FILE first (v1.0.38)', () => {
  // The write is the artifact a device transfer needs and the only thing that survives a
  // cancelled share; the share is how it leaves the tablet at all, because Android 11+
  // hides Android/data from the Files app. Sharing the list as TEXT is the last rung —
  // EXTRA_TEXT is a Binder payload receivers truncate, and a 400-link message is not a
  // file the other device can import.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function linksExport(');
  assert.ok(at > 0, 'linksExport is gone');
  const body = app.slice(at, app.indexOf('\nlet lastLinksExportText', at));
  const write = body.indexOf('fsWriteTextExternal(');
  const shareF = body.indexOf('shareFile(');
  assert.ok(write > 0, 'the export no longer writes a file');
  assert.ok(shareF > write, 'the share must come AFTER the write — a cancelled share must leave the file');
  assert.ok(!body.includes('shareText('), 'shareText must not be a rung of the export itself');
  // the empty library must be refused, not exported as a blank file
  assert.match(body, /delivery: 'nothing'/, 'an empty library must be named, not exported as an empty file');
});

test('the native shareFile exists in BOTH java copies and its FileProvider path is declared', () => {
  // ARCHITECTURE.md calls native-reference/ the canonical rebuild copy; a method that lives
  // in only one of them is a rebuild that silently loses the feature.
  for (const p of ['android/app/src/main/java/com/assaf/kidsplayer/KidsNativePlugin.java',
                   'native-reference/KidsNativePlugin.java']) {
    const java = readFileSync(join(ROOT, p), 'utf8');
    const at = java.indexOf('public void shareFile(PluginCall call)');
    assert.ok(at > 0, `${p}: shareFile is missing — the links export cannot leave the device`);
    const body = java.slice(at, java.indexOf('\n    }\n', java.indexOf('try {', at)));
    assert.match(body, /FileProvider\.getUriForFile/,
      `${p}: a raw file:// URI throws FileUriExposedException on API 24+`);
    assert.match(body, /EXTRA_STREAM/, `${p}: shareFile attaches no file`);
    assert.match(body, /FLAG_GRANT_READ_URI_PERMISSION/,
      `${p}: without the grant flag the receiving app opens an empty document`);
  }
  // …and the path must be whitelisted, in both copies, or getUriForFile throws
  for (const p of ['android/app/src/main/res/xml/file_paths.xml', 'native-reference/file_paths.xml']) {
    const xml = readFileSync(join(ROOT, p), 'utf8');
    assert.match(xml, /<external-files-path[^>]*path="exports\/"/,
      `${p}: exports/ is not declared — FileProvider.getUriForFile throws for the export path`);
  }
});

test('a links import cannot mint a duplicate profile name (v1.0.38)', () => {
  // A PROFILE NAME IS UNIQUE PER GOOGLE ACCOUNT, NOT PER DEVICE (v1.0.22): two devices each
  // creating "נועם" splits that child's gift progress and personal videos while the parent
  // sees two identical avatars. The import's "create a new profile from this file" branch is
  // a NEW way to mint one and must not be the path that skips the check.
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /async function profileNameClash\(/, 'the shared name gate is gone');
  const gate = app.slice(app.indexOf('async function profileNameClash('));
  assert.match(gate.slice(0, 900), /profileNameConflict\(/, 'the gate no longer uses the pure conflict rule');
  assert.match(gate.slice(0, 900), /pullDrive\(/, 'the gate no longer pulls first — a peer name would be invisible');
  const at = app.indexOf('async function linksImportFromText(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /profileNameClash\(/, 'the create-a-profile branch skips the uniqueness gate');
  assert.ok(body.indexOf('profileNameClash(') < body.indexOf('createProfile('),
    'the name is checked AFTER the profile is created');
  // and createNewProfile must share it rather than keep a private copy
  const cn = app.slice(app.indexOf('async function createNewProfile('), app.indexOf('async function activateProfile('));
  assert.match(cn, /profileNameClash\(/, 'createNewProfile grew a private copy of the gate again');
});

test('the library SCOPE travels with each profile in the Drive doc (v1.0.38)', () => {
  // Without this a fresh device restoring a MIGRATED family gets the profiles and every
  // libraries[…] blob but no sources row — ensureSources then mints lib:p:<id> while the
  // content sits under the old lib:<hash>. Empty home, full database, no tool to fix it
  // (moveScope is gone in this release).
  const drive = MODULES.get('www/js/drive.js');
  const at = drive.indexOf('async function buildLocalDoc(');
  assert.ok(at > 0, 'buildLocalDoc is gone');
  // Bounded to the profileSources block. The first version ended the slice at `\n  return {`,
  // which does not occur after buildLocalDoc at all — indexOf answered -1, slice(at, -1) took
  // the REST OF THE FILE, and the libraries[] `sheetUrl: src.sheetUrl || null` two lines
  // below satisfied every assertion. A slice that silently widens to the whole file is a
  // guard that pins nothing; caught by re-checking the plant.
  const end = drive.indexOf('const lib = src && src.libraryId;', at);
  assert.ok(end > at, 'the buildLocalDoc slice lost its end boundary');
  const build = drive.slice(at, end);
  assert.match(build, /profileSources\[p\.id\] = \{[\s\S]{0,200}libraryId:/,
    'profileSources no longer carries libraryId — a restored profile cannot find its scope');
  assert.ok(!/if \(src && src\.sheetUrl\) \{\s*\n\s*profileSources/.test(build),
    'profileSources is written only for sheet-backed profiles again — the map empties after the migration');
  // the restore side must not reinstate the guard that skipped sheet-less entries
  assert.ok(!/if \(!ps \|\| !ps\.sheetUrl\) continue/.test(drive),
    'the restore branch skips sheet-less entries again — that IS the empty-home bug');
  assert.match(drive, /libraryId: resolveRestoredLibraryId\(/,
    'the restore no longer routes through the pure resolver');

  // A migrated entry's sheetUrl must be NULL, and this has to be checked HERE rather than in
  // a unit test: a gdrive.test.mjs case hands serializeDb a hand-built profileSources, so it
  // pins the FIXTURE and not the production expression — the same trap that made
  // libraryChannels.updatedAt provably order-dependent while the suite stayed green
  // (v1.0.22). buildLocalDoc reads IndexedDB and cannot be unit-tested at all.
  // WHY IT MATTERS: a v1.0.37 device's own `if (!ps.sheetUrl) continue` is the entire reason
  // the new document is harmless to it. A truthy sentinel there and the old app derives a
  // scope from garbage.
  assert.match(build, /sheetUrl: src\.sheetUrl \|\| null,/,
    'buildLocalDoc no longer writes a NULL sheetUrl for a migrated profile — an older app would read the sentinel as a real sheet');
});

test('the orphan sweep is an UNCONDITIONAL STAGE of every sync (v1.0.38)', () => {
  // THE BUG: planOrphanGC only ever ran inside applySheetMirror, gated on `if (sheetParsed)`
  // — so a profile with NO sheet never swept, which is the normal case since v1.0.32 and the
  // ONLY case after this release. A peer deleting a subscription sends the v1.0.36 tombstone,
  // applyRemoteDoc deletes the row, and nothing deleted the videos: the child kept a folder
  // full of a channel nobody subscribes to, forever.
  const sync = MODULES.get('www/js/sync2.js');
  const dsAt = sync.indexOf('async function doSync(');
  assert.ok(dsAt > 0, 'doSync is gone');
  const body = sync.slice(dsAt);
  const subsAt = body.indexOf('const allSubs = await listLibraryChannels(lib)');
  const gcAt = body.indexOf('gcOrphans(lib)');
  const rssAt = body.indexOf("report('rss'");
  assert.ok(subsAt > 0 && gcAt > 0 && rssAt > 0, 'one of the stage anchors moved');
  assert.ok(gcAt > subsAt, 'the sweep runs before the subscription list is known');
  assert.ok(gcAt < rssAt,
    'the sweep runs AFTER the fetch stages — the sync would spend network on channels it is about to sweep');
  // and it must not be gated on a sheet parse ever again
  const stage = body.slice(subsAt, rssAt);
  assert.doesNotMatch(stage, /if \(sheetParsed\)/,
    'the sweep is gated on a sheet parse again — that is the bug this stage fixes');
  // the valve is what makes an unconditional sweep safe on an old install
  assert.match(sync, /orphanSweepValve\(/, 'the sweep lost its valve — a first pass can churn against the Drive doc');
  const gcFn = sync.slice(sync.indexOf('export async function gcOrphans('));
  assert.match(gcFn.slice(0, 1200), /if \(!valve\.sweep\)/, 'gcOrphans ignores the valve');

  // the channel-remove button goes through removeSubscription, not the mirror
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /removeSubscription\(libScope, lc\.channelId\)/,
    'the channel 🗑️ no longer routes through removeSubscription');
  const rs = sync.slice(sync.indexOf('export async function removeSubscription('));
  assert.match(rs.slice(0, 400), /deleteLibraryChannel\(/,
    'removeSubscription does not unsubscribe — the v1.0.36 tombstone is written inside it');
  assert.match(rs.slice(0, 400), /gcOrphans\(/, 'removeSubscription leaves the videos orphaned');

  // a parked sweep must be SAID, not just recorded: a meta key nobody reads is a lie (v1.0.37)
  assert.match(app, /gcAlert:/, 'nothing surfaces a parked sweep to the parent');
});

/* ---------------- the rolling window (v1.0.39) ---------------- */

test('THE SYNC NEVER DELETES FOR THE WINDOW — it has no consumer at all (v1.0.39)', () => {
  // The whole safety model of this feature: planChannelWindow PROPOSES, and the only code
  // that deletes runs behind a parent's confirm. If the sync ever starts consuming the
  // proposal, the child's videos begin disappearing in the background — which is exactly
  // what the user asked NOT to happen ("tell me first, let me mark what to keep").
  for (const [p, s] of MODULES) {
    // plan.js declares the planner, app.js holds the review, db.js DEFINES the bulk delete
    if (p === 'www/js/plan.js' || p === 'www/js/app.js') continue;
    assert.ok(!/planChannelWindow/.test(s),
      `${p} reaches into the rolling window — only the parent-facing review may act on it`);
    if (p === 'www/js/db.js') continue; // its definition, not a call
    assert.ok(!/deleteVideosWithTombstones/.test(s),
      `${p} performs a bulk prune — only the parent-facing review may delete for the window`);
  }
  const sync = MODULES.get('www/js/sync2.js');
  assert.ok(!/keepNewest|keepForever/.test(sync),
    'sync2.js now knows about the window — the proposal must stay out of the background pipeline');
});

test('the window review DELETES ONLY behind a confirm, and marks favourites FIRST (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  assert.ok(at > 0, 'the rolling-window review is gone');
  const body = app.slice(at, app.indexOf('\n}\n\nasync function refreshChannelsList', at));
  const askAt = body.indexOf('confirmKid(');
  const delAt = body.indexOf('deleteVideosWithTombstones(');
  const markAt = body.indexOf('markKeepForever(');
  assert.ok(askAt > 0, 'the review no longer ASKS before deleting');
  assert.ok(delAt > askAt, 'the deletion runs BEFORE the parent confirms it');
  assert.match(body, /if \(!yes\)/, 'a declined confirm must change nothing');
  // The marks are written first on purpose: a crash in between must leave the favourites
  // protected, never leave them deletable with the deletion already committed.
  assert.ok(markAt > 0 && markAt < delAt,
    'the keep-forever marks must be written BEFORE the deletion');
  // …and the tombstone form is required: a raw delete is pure absence, and every Drive
  // merge is a union, so a peer would re-push every pruned video (the v1.0.36 lesson).
  assert.ok(!/deleteVideoRaw\(/.test(body), 'the prune uses a tombstone-free delete — peers will resurrect it');
});

test('the window is surfaced BY NAME in the sources tab, and derived not stored (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  const sources = app.slice(app.indexOf('async function refreshSourcesPanel('));
  assert.match(sources.slice(0, sources.indexOf('\n}\n')), /refreshWindowBox\(\)/,
    'the מקורות tab no longer tells the parent which channels are over the window');
  // Nothing about the proposal may be persisted: a stored proposal is a second source of
  // truth that goes stale on the next sync, pull or manual deletion — the entire class of
  // bug v1.0.38 removed. It must be derived on demand.
  const derive = app.slice(app.indexOf('async function channelsOverWindow('));
  const body = derive.slice(0, derive.indexOf('\n}\n'));
  assert.ok(!/putMeta\(/.test(body), 'the window proposal is being stored — it will go stale');
  assert.match(body, /planChannelWindow\(/, 'the derivation no longer uses the pure planner');
  // The protection set must come from the PURE helper, whose own test pins what counts
  // (the parent's marks + a saved position, and NOT unwrappedAt — the gift baseline stamps
  // that on nearly every record, which made the window propose nothing at all: measured).
  assert.match(body, /protectedWindowKeys\(/, 'the protection set is no longer built by the pure helper');
  assert.match(body, /states: giftStates/, 'the child\'s per-video state is no longer consulted');
});

test('the window setting is per-profile, synced, and OFF unless written (v1.0.39)', () => {
  const app = MODULES.get('www/js/app.js');
  assert.match(app, /putSetting\(activeProfileId, 'keepNewest'/, 'the window is no longer per-profile');
  assert.match(app, /getSetting\(activeProfileId, 'keepNewest', null\)/,
    'reading it with a non-null fallback would make never-written indistinguishable from a real 0');
  // it travels: a screen-time style decision belongs to the child, not to one tablet
  const setAt = app.indexOf("$('keep-newest').addEventListener");
  assert.ok(setAt > 0, 'the settings field is not wired');
  const handler = app.slice(setAt, app.indexOf('});', setAt));
  assert.match(handler, /maybeSchedulePush\(\)/, 'the window size no longer syncs to the other devices');
  assert.match(handler, /keepNewestPerChannel\(/, 'the field writes a raw value — a mistyped 1 would propose emptying folders');
  // saving a setting may never delete anything by itself
  assert.ok(!/deleteVideo|markKeepForever/.test(handler), 'saving the setting deletes content');
});

test('"delete this whole channel" still honours an earlier keep-forever mark (v1.0.39)', () => {
  // A marked video is not PROPOSED, so it never appears in the list and cannot be ticked
  // again — which is exactly how the first version deleted two favourites the parent had
  // already protected, behind a button whose label only mentioned a count. Measured in the
  // browser. The promise made when they ticked ("יישארו לתמיד") has to outlive this button.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  const body = app.slice(at, app.indexOf('\n}\n\nasync function refreshChannelsList', at));
  const decl = body.slice(body.indexOf('const allLive ='), body.indexOf(';', body.indexOf('const allLive =')));
  // The pool must exclude the WHOLE protected set, not just `keepForever`: the other half
  // (a saved playback position) has the identical property — never proposed, therefore never
  // rendered, therefore impossible for the parent to tick and save.
  assert.match(decl, /!guarded\.has\(r\.key\)/,
    'the "delete every video of this channel" pool no longer excludes the full protected set');
  assert.match(body, /const guarded = protectedWindowKeys\(/,
    'the protected set is no longer built from the pure helper inside the review');
  // and the same set must gate the PROPOSAL, so the two buttons cannot disagree
  assert.match(body, /entry\.over\.map\(\(k\) => index\.get\(k\)\)\.filter\(\(r\) => r && !guarded\.has\(r\.key\)\)/,
    'the proposal no longer filters against the protected set');
});

test('the window prune RE-READS before deleting — the proposal can go stale (v1.0.39)', () => {
  // The proposal is computed when the review OPENS. A sync, a Drive pull or the parent
  // acting elsewhere can move a video in between: approved, rejected, protected, or already
  // deleted. Writing a window tombstone for something that is no longer a prunable live
  // record would permanently deny a video this dialog never asked about.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  assert.ok(at > 0, 'the window commit is gone');
  const body = app.slice(at, app.indexOf('\n  };', at));
  const reread = body.indexOf('await db.loadMergeIndex(scope)');
  const del = body.indexOf('deleteVideosWithTombstones(');
  assert.ok(reread > 0, 'the commit no longer re-reads the library before deleting');
  assert.ok(reread < del, 'the re-read must happen BEFORE the deletion');
  assert.match(body, /r\.state === 'live' && !r\.keepForever/,
    'the re-read no longer filters to still-prunable live records');
  // and the toast must report what was ACTUALLY removed, not the pre-confirm intent
  assert.match(body, /toast\(`נמחקו \$\{removed\}/, 'the toast reports the stale count again');
});

test('the prune clears per-child gift state, or 🎁 jams forever (v1.0.39)', () => {
  // THE SEVEREST audit finding. planGifts counts `outstanding` straight out of
  // profileVideoState — `giftRank && !unwrappedAt`, whether or not the video record still
  // exists — and stops gifting at `outstanding >= baseline`. Prune a handful of un-opened
  // gifts and the child NEVER receives another one; planGiftRunawayRepair cannot rescue it
  // (it no-ops below its 60-record floor). The 🎁 tile counts the same index, so the orphans
  // would also promise a folder that resolves to nothing.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  const body = app.slice(at, app.indexOf('\n  };', at));
  assert.match(body, /deleteVideoStates\(/, 'the prune leaves orphan gift state — gifting will jam');
  const del = body.indexOf('deleteVideosWithTombstones(');
  assert.ok(body.indexOf('deleteVideoStates(') > del, 'the state must be cleared for what was ACTUALLY deleted');
  assert.match(body, /giftStates\.delete\(/, 'the in-memory gift map keeps the orphans until the next load');
  // …for every profile that reads this library, not just the active one: a legacy shared
  // scope means a sibling's gift counter is jammed just as easily.
  assert.match(body, /src\.libraryId === scope/, 'only the active profile\'s state is cleared');
});

test('a failed prune is SAID, and never leaves the buttons inert (v1.0.39)', () => {
  // `settled` used to be released only on a cancelled confirm, so any rejection inside the
  // work (a tx-aborted write, a failed chunk) left the parent on the review with both delete
  // buttons dead and no message — the handlers' .catch(() => {}) ate the reason.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const commit = async (everything)');
  const body = app.slice(at, app.indexOf('\n  };', at));
  assert.match(body, /\} catch \(e\) \{/, 'the commit no longer catches its own failure');
  const cat = body.slice(body.lastIndexOf('} catch (e) {'));
  assert.match(cat, /settled = false/, 'a failure leaves settled=true — both buttons stay inert forever');
  assert.match(cat, /toast\(/, 'a failed deletion says nothing to the parent');
  // ticking every row is a legitimate answer and must not open a "delete 0" confirm
  assert.match(body, /if \(!doomed\.length\)/, 'an empty selection still raises a confirm for zero videos');
});

test('only ONE window review can be open at a time (v1.0.39)', () => {
  // The prelude does two full library reads before it navigates, so a double-tap let a
  // second review repaint the list and replace pickHandlers — and the resulting nav.go
  // fired the pick view's onLeave, which nulls whatever pickHandlers holds: the LIVE one.
  // The screen became a zombie with dead buttons and two 'pick' entries on the stack.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function reviewChannelWindow(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /windowReviewOpening \|\| nav\.isActive\('pick'\)/,
    'a second review can open over a live one again');
  assert.match(body, /finally/, 'the in-flight flag is not released on every path');
});

/* ---------------- favourites (v1.0.40) ---------------- */

test('⭐ sits directly after 🎁 at the top of the home, and hides at zero (v1.0.40)', () => {
  // The user's explicit requirement: "בראש כל התיקיות, אחרי התיקיה של החדשים". And a tile
  // that opens an empty grid is the v1.0.21 bug, so a count of 0 gets no tile at all.
  const app = MODULES.get('www/js/app.js');
  const gift = app.indexOf("id: 'new', title:");
  const fav = app.indexOf("id: 'fav', title:");
  const firstChannel = app.indexOf("id: prefix + lc.channelId");
  assert.ok(gift > 0, 'the 🎁 folder is gone');
  assert.ok(fav > gift, '⭐ must be pushed AFTER 🎁');
  assert.ok(fav < firstChannel, '⭐ must come before the channel folders');
  assert.match(app.slice(fav - 300, fav), /favCount > 0/, '⭐ renders a tile at zero favourites');
  // v1.0.40: the loose list must NOT reuse ⭐ — it read as the favourites folder (user report)
  const loose = app.slice(app.indexOf("id: 'sheet', scope: lib"), app.indexOf("id: 'sheet', scope: lib") + 160);
  assert.ok(!/emoji: '⭐'/.test(loose), '"סרטונים נוספים" is wearing the favourites folder\'s star again');
});

test('the ⭐ toggle has ONE write path, and no gate (v1.0.40)', () => {
  // It is the CHILD's button: no PIN, no confirm — it is not destructive in either
  // direction (the video stays where it lives; ⭐ is an additional place to find it).
  const app = MODULES.get('www/js/app.js');
  assert.equal((app.match(/db\.setFavourite\(/g) || []).length, 2,
    'db.setFavourite must have exactly two callers: the toggle and the ⭐ folder self-heal');
  const at = app.indexOf('async function toggleFavourite(');
  assert.ok(at > 0, 'the toggle is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!/startPin\(|confirmKid\(/.test(body), 'the child\'s own star must not be gated');
  assert.match(body, /maybeSchedulePush\(\)/, 'a star is a child decision and must reach the other devices');
  // the in-memory mirror must be restored when the write fails, or the button lies
  assert.match(body, /catch \{[\s\S]*giftStates\.set\(key, st\)/, 'a failed write leaves the button showing a star that was never saved');
});

test('the ⭐ folder self-heal clears only the FAVOURITE fields (v1.0.40)', () => {
  // The state row also carries gift/unwrap/resume. The gift folder may delete the whole row
  // (a rank IS the whole point there); doing that here would erase `unwrappedAt` and
  // RE-GIFT a video the child already opened.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function pageFavFolder(');
  assert.ok(at > 0, 'the ⭐ pager is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /db\.setFavourite\(activeProfileId, key, false\)/,
    'the self-heal no longer un-stars the missing video');
  assert.ok(!/deleteVideoState\(/.test(body),
    'the self-heal deletes the whole state row — that would re-gift an opened video');
});

test('a favourite is protected from the window, including a sibling\'s (v1.0.40)', () => {
  // The feature's central promise. The pure half is unit-tested; this pins the WIRING,
  // which the node suite cannot execute (it reads IndexedDB per profile).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function channelsOverWindow(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  // pin the CALL, not the mere mention: the first version of this guard matched the array's
  // construction, so dropping it from the protectedWindowKeys arguments passed vacuously —
  // the exact trap CLAUDE.md documents.
  assert.match(body, /protectedWindowKeys\(\{ records, states: giftStates, statesByProfile \}\)/,
    'the siblings\' stars are built but not passed — a shared library eats the sibling\'s favourite');
  assert.match(body, /src\.libraryId !== scope/, 'the sibling scan no longer filters to THIS library');
  assert.match(body, /loadVideoStates\(/, 'the siblings\' state is never read');
});

test('a tap on a video reaches fullscreen SYNCHRONOUSLY (v1.0.2 rule, pinned v1.0.40)', () => {
  // CLAUDE.md has called this an invariant since v1.0.2 — "enterPlayerFullscreen() runs
  // SYNCHRONOUSLY inside the tap gesture (an await first may void the user activation)" —
  // and nothing pinned it. Every feature since has added lines to openWatch and to the tile
  // handler; one `await` in front of either silently costs the child fullscreen, and the
  // symptom (a video that opens windowed, sometimes) is untestable in node.
  const app = MODULES.get('www/js/app.js');

  // 1) the TILE handler must call openWatch with nothing awaited before it
  const tileAt = app.indexOf('function tileEl(');
  const tileBody = app.slice(tileAt, app.indexOf('\n}\n', tileAt));
  const handlerAt = tileBody.indexOf("btn.addEventListener('click'");
  assert.ok(handlerAt > 0, 'the tile click handler moved — re-anchor this guard');
  const handler = tileBody.slice(handlerAt, tileBody.indexOf('});', handlerAt));
  assert.ok(!/\basync\b/.test(handler), 'the tile handler is async — the tap loses its user activation');
  assert.ok(!/\bawait\b/.test(handler), 'the tile handler awaits before opening the video');
  assert.match(handler, /openWatch\(item\)/, 'the tile no longer opens the video directly');

  // 2) openWatch must reach the fullscreen request with no await in front of it
  const openAt = app.indexOf('async function openWatch(');
  assert.ok(openAt > 0, 'openWatch is gone');
  const fsAt = app.indexOf('enterPlayerFullscreen();', openAt);
  assert.ok(fsAt > openAt, 'openWatch no longer requests fullscreen');
  const prelude = app.slice(openAt, fsAt)
    .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/\bawait\b/.test(prelude),
    'openWatch awaits something BEFORE going fullscreen — the tap\'s user activation is spent');
});

test('the folder illustration ships, is self-contained, and has an emoji fallback (v1.0.41)', () => {
  // Same rule the guide slides follow: an asset named in code must EXIST in www/, or the
  // child gets an empty circle where their folder should be. And it must be self-contained
  // — the app runs from file:// inside a WebView with no network guarantee, so an external
  // font/image/filter reference would silently render nothing.
  const app = MODULES.get('www/js/app.js');
  const m = app.match(/art: '([^']+)'/);
  assert.ok(m, 'no folder names an illustration any more');
  // v1.0.41: the drawing belongs to the LOOSE-SINGLES folder; ⭐ keeps its plain star
  const favPush = app.slice(app.indexOf("id: 'fav', title:") - 40, app.indexOf("id: 'fav', title:") + 140);
  assert.ok(!/art:/.test(favPush), 'the favourites folder took the drawing back — ⭐ is its mark');
  const rel = m[1];
  const svg = readFileSync(join(ROOT, 'www', rel), 'utf8'); // throws if it is not shipped
  assert.match(svg, /^<svg/, `${rel} is not an SVG`);
  for (const forbidden of [/xlink:href/, /<image\b/, /url\(https?:/, /@font-face/, /<script/]) {
    assert.ok(!forbidden.test(svg), `${rel} pulls in something external (${forbidden}) — it must be self-contained`);
  }
  // the emoji fallback is what makes a missing/blocked asset degrade instead of vanish
  const mountAt = app.indexOf('function mountFolderArt(');
  assert.ok(mountAt > 0, 'the art mounter is gone');
  const body = app.slice(mountAt, app.indexOf('\n}\n', mountAt));
  assert.match(body, /addEventListener\('error'/, 'a failed illustration leaves an EMPTY circle');
  assert.match(body, /fallbackEmoji/, 'the fallback emoji is no longer used');
});

test('emptying ⭐ from the watch screen falls back to the real folder (v1.0.40)', () => {
  // ⭐ is a VIEW, not a folder, and the child can empty it from the very screen that pages
  // it: un-starring the video they are watching removes it from the list. With one favourite
  // that leaves an EMPTY under-player grid and then an empty folder screen — the same shape
  // the 🎁 folder needed fixing for in v1.0.21 (a gift leaves 🎁 the instant it is unwrapped).
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function renderWatchGrid(');
  assert.ok(at > 0, 'renderWatchGrid is gone');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /fid === 'fav' && !favouriteKeys\(giftStates\)\.length/,
    'an emptied ⭐ no longer falls back — the child is left with an empty grid');
  assert.match(body, /current && \(current\.homeFolderId \|\| current\.folderId\)/,
    'the fallback must be where the video actually LIVES');
});

test('leaving fullscreen lands on the TOP of the watch page (v1.0.43)', () => {
  // Exiting fullscreen is NOT a navigation: nav.handleBack answers 'exit-fullscreen' and
  // returns, and the HUD's ⛶ does the same — so nothing scrolled, and the child came back
  // to wherever they had scrolled to (usually the grid, with the small player off-screen
  // above). nav.go has guaranteed a top landing since the F4 fix; this is the one way out
  // that never goes through nav.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('const onFullscreenChange = () => {');
  assert.ok(at > 0, 'the fullscreen-exit scroll handler is gone');
  const body = app.slice(at, app.indexOf('\n  };', at));
  // entering fullscreen must do nothing
  assert.match(body, /if \(document\.fullscreenElement \|\| document\.webkitFullscreenElement\) return;/,
    'the handler also fires when ENTERING fullscreen');
  // and it must not fight a navigation that already restored a scroll position: `leaveWatch`
  // (a video that ended) exits fullscreen and then nav.back()s into the folder.
  assert.equal((body.match(/nav\.isActive\('watch'\)/g) || []).length, 2,
    'the watch guard must be checked at event time AND inside the deferred callback');
  // TWICE: immediate (rAF callbacks are SUSPENDED while the document is hidden — measured)
  // and deferred (the reflow as the element leaves fullscreen would undo an immediate one).
  assert.equal((body.match(/window\.scrollTo\(0, 0\)/g) || []).length, 2,
    'the scroll must be both immediate and deferred');
  assert.match(body, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/,
    'the deferred scroll no longer uses the double rAF nav.transition relies on');
  // registered on BOTH vendor names, once, in wire()
  const wireAt = app.indexOf('function wire()');
  const wireBody = app.slice(wireAt);
  assert.match(wireBody, /document\.addEventListener\('fullscreenchange', onFullscreenChange\)/);
  assert.match(wireBody, /document\.addEventListener\('webkitfullscreenchange', onFullscreenChange\)/,
    'older WebViews fire only the webkit-prefixed event');
});

/* ---------------- the sheet sunset is GONE (v1.0.44) ---------------- */

test('nothing reads a Google Sheet, and nothing deletes a Drive file (v1.0.44)', () => {
  // The v1.0.38 sunset migration was the last code that did either: it read the family's
  // sources sheet one final time and then deleted the file, bypassing Drive's trash. Both
  // capabilities are gone with it, and this is what keeps them gone — a re-introduction
  // would also re-introduce a Google scope the app no longer needs.
  for (const [p, body] of MODULES) {
    assert.ok(!/sheets\.googleapis|v4\/spreadsheets/.test(body),
      `${p} calls the Google Sheets API — the app has no sheet concept any more`);
    assert.ok(!/method: 'DELETE'|"DELETE"/.test(body),
      `${p} issues an HTTP DELETE — the only one the app ever had was the sunset's file delete`);
    assert.ok(!/runSheetSunset|planSheetSunset|planSheetFold|SUNSET_DEADLINE/.test(body),
      `${p} still references the removed sunset migration`);
  }
  // …and the module itself must not come back
  assert.ok(!MODULES.has('www/js/sunset.js'), 'sunset.js is back — the migration was deleted on purpose');
});

/* ================= approved websites (v1.0.45) =================
   This feature puts a BROWSER on a 5-year-old's tablet. Almost everything below pins a
   door closed rather than a feature working — a broken feature is visible, an open door
   is not. Each guard names what gets through if it fails. */

const JAVA_PAIRS = [
  'android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java',
  'native-reference/KidsWebPlugin.java'
];
const readRepo = (p) => readFileSync(join(ROOT, p), 'utf8');
/** Java source with comments stripped. Every positional/absence guard below MUST use
 *  this: the comments deliberately NAME what they forbid ("verifying a PIN in Java
 *  would be…", "MUST run before super.onCreate()"), so a guard reading raw text trips
 *  on its own documentation. All three of these fired on comments the first time. */
const readRepoCode = (p) => stripComments(readRepo(p));

test('the URL-prefix rule lives in ONE module (v1.0.45)', () => {
  // The whole feature's safety is one comparison. A second copy of it anywhere — an
  // inline startsWith in a click handler, a "quick check" in the parent panel — is a
  // second answer to "may the child go here", and the two will disagree.
  const owners = [...CODE.entries()]
    .filter(([k, b]) => k !== 'www/js/weblock.js' && /\b(navAllowed|subresourceAllowed|canonicalSitePrefix)\s*\(/.test(b))
    .filter(([, b]) => !/from '\.\/weblock\.js'/.test(b) === true);
  assert.deepEqual(owners.map(([k]) => k), [],
    'the prefix rule is implemented outside weblock.js');
  // and nobody may hand-roll a host/prefix comparison instead of importing it
  for (const [k, b] of CODE.entries()) {
    if (k === 'www/js/weblock.js') continue;
    assert.ok(!/\.startsWith\(\s*['"]https:\/\//.test(b),
      `${k}: a raw startsWith on an https URL is not a prefix check — use weblock`);
  }
});

test('a site deletion writes its tombstone FIRST (v1.0.45)', () => {
  // Absence carries no information: every Drive merge is a union, so a removed site that
  // left only a missing row is re-added by the first peer that has not pulled yet.
  const db = MODULES.get('www/js/db.js');
  const at = db.indexOf('export async function deleteSiteEntry(');
  assert.ok(at > 0, 'deleteSiteEntry not found');
  const body = db.slice(at, db.indexOf('\n}\n', at));
  const tomb = body.indexOf('putDeletedSiteEntries');
  const del = body.indexOf('s.delete([scopeId, entryId])');
  assert.ok(tomb > 0, 'deleteSiteEntry writes no tombstone — removed sites come back on the next pull');
  assert.ok(del > tomb, 'the tombstone must be written BEFORE the row delete');
});

test('applyRemoteDoc routes site entries through planSiteApply (v1.0.45)', () => {
  const drive = CODE.get('www/js/drive.js');
  assert.match(drive, /planSiteApply\(\{/, 'the apply path no longer uses the pure planner');
  assert.match(drive, /putDeletedSiteEntries\(libId, sitePlan\.tombs\)/,
    'the merged tombstone map must be adopted, or an interrupted apply forgets it');
  assert.match(drive, /preserveTimestamp: true/,
    'an applied remote row must keep the winner\'s timestamp or two devices ping-pong');
});

test('EVERY createObjectStore sits behind an oldVersion guard (v1.0.45)', () => {
  // An unguarded store creation on a bumped DB_VERSION throws ConstraintError, aborts the
  // version-change transaction and leaves the app unable to open its database AT ALL —
  // on every installed device. Verified in the browser: it really does throw.
  const db = MODULES.get('www/js/db.js');
  const at = db.indexOf('req.onupgradeneeded');
  const end = db.indexOf('req.onsuccess', at);
  const body = db.slice(at, end);
  assert.match(body, /\(ev\)\s*=>/, 'the upgrade handler must receive the event to read oldVersion');
  const guards = [...body.matchAll(/if \(from < (\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(guards.length >= 2, 'expected one oldVersion block per schema version');
  // every createObjectStore must come AFTER the first guard opens
  const firstGuard = body.indexOf('if (from <');
  for (const m of body.matchAll(/createObjectStore\(/g)) {
    assert.ok(m.index > firstGuard,
      'a createObjectStore sits outside an oldVersion guard — this BRICKS every existing install');
  }
});

test('the site collection travels in BOTH buildLocalDoc branches (v1.0.45)', () => {
  // Sites are PROFILE-scoped, and the prof: pseudo-library is built by a separate, thinner
  // branch that already omits deletedChannels. Carrying the collection in only the library
  // branch means the sites sync NOWHERE, silently, while every local screen looks right.
  const drive = CODE.get('www/js/drive.js');
  const at = drive.indexOf('async function buildLocalDoc');
  const body = drive.slice(at, drive.indexOf('\n}\n', at));
  const hits = [...body.matchAll(/siteEntries:/g)];
  assert.ok(hits.length >= 2,
    'only one buildLocalDoc branch carries siteEntries — the profile-scoped ones would never sync');
  assert.match(body, /listSiteEntries\(pScope\)/, 'the prof: branch must read the real rows');
  // and the blob must be built even when the profile has no personal VIDEOS
  assert.match(body, /pv\.length \|\| pSites\.length/,
    'the prof: blob is gated on videos alone — a child with only websites would sync nothing');
});

test('the scheduled lock CLOSES the site viewer before it renders (v1.0.45)', () => {
  // The viewer is a native view over the whole app, so nav.reset('locked') would swap the
  // screen UNDERNEATH it and the child would keep browsing with the lock invisible.
  const app = MODULES.get('www/js/app.js');
  const at = app.indexOf('async function showLockedScreen()');
  const body = stripComments(app.slice(at, app.indexOf('\n}\n', at)));
  const close = body.indexOf('closeSiteViewer()');
  const reset = body.indexOf("nav.reset('locked')");
  assert.ok(close > 0, 'the lock no longer closes the site viewer — screen time stops applying to browsing');
  assert.ok(reset > close, 'the viewer must be closed BEFORE the locked view is shown');
});

test('the idle timer counts while a site is open, and its input comes from native (v1.0.45)', () => {
  // Taps inside a native WebView never reach this window, so without the bridge event the
  // idle timer either never fires (viewer not counted) or fires on an active child.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /playing: !!\(st && st\.playing\) \|\| siteViewerOpen/,
    'tickIdleSleep ignores an open site viewer — the screen-off timer is off while browsing');
  assert.match(app, /onSiteEvent\('webActivity'/,
    'nothing feeds idleLastInputAt from the viewer — a browsing child looks idle');
  assert.match(app, /onSiteEvent\('webClosed'/,
    'siteViewerOpen would stay true forever after the viewer closes');
});

test('the child sees SHORTCUTS only, never the navigation rules (v1.0.45)', () => {
  // A rule may be a sub-path or a different site entirely. Rendering rules as tiles would
  // put things on the child's screen the parent never pictured them opening.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /kind === 'shortcut'/, 'siteShortcuts no longer filters by kind');
  const at = app.indexOf('function renderSitesView()');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /siteShortcuts\(\)/,
    'the child grid must render siteShortcuts(), not the whole entry list');
  assert.ok(!/siteRules\(\)/.test(body), 'the child grid renders navigation rules as tiles');
});

test('the launcher is gated on the setting AND a shortcut AND not-TV (v1.0.45)', () => {
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function refreshSitesLauncher()');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /sitesEnabledCache/, 'the parent toggle no longer hides the button');
  assert.match(body, /siteShortcuts\(\)\.length > 0/,
    'a button that opens an empty grid is the v1.0.21 bug');
  assert.match(body, /classList\.contains\('tv'\)/, 'the feature must stay hidden on Android TV');
  assert.match(body, /await loadSiteEntries\(\)/,
    'reading a cache here means a peer\'s change is invisible until the profile is switched');
});

test('parent mode is unreachable from anything the child can touch (v1.0.45)', () => {
  // parentMode navigates WITHOUT restriction. It exists so a parent can complete an SSO
  // login behind the PIN; a path to it from the child's side would be the whole feature
  // undone in one tap.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /parentMode: false/, 'the child path must pass parentMode: false explicitly');
  const kid = app.slice(app.indexOf('async function openSiteForKid'), app.indexOf('async function openSiteForParent'));
  assert.ok(!/parentMode: true/.test(kid), 'the CHILD path can open an unrestricted viewer');
  // and the only caller of the parent path is the parent panel row
  const parentCalls = (app.match(/openSiteForParent\(/g) || []).length - 1;
  assert.ok(parentCalls <= 2, `openSiteForParent has ${parentCalls} call sites — each one must be behind the PIN`);
});

test('the PIN is never verified in Java (v1.0.45)', () => {
  // A second implementation of the one check that guards the whole parent surface. The
  // native side asks JS to take over (webAddRequest) and JS runs the real startPin.
  for (const p of JAVA_PAIRS) {
    const code = readRepoCode(p);
    assert.ok(!/\bpin\b/i.test(code.replace(/kidsweb/gi, '')),
      `${p}: the native side must not know anything about the parent code`);
    assert.match(code, /webAddRequest/, `${p}: no way to hand a blocked page back to the parent`);
  }
});

test('the site viewer closes every escape, in BOTH java copies (v1.0.45)', () => {
  // Each of these is a one-gesture way out of the approved set for a child who is simply
  // exploring. They are listed with the door they close.
  const required = [
    ['shouldOverrideUrlLoading', 'navigation outside the approved rules'],
    ['shouldInterceptRequest', 'ads, trackers and embedded third-party players'],
    ['setDownloadListener', 'downloading an APK'],
    ['onCreateWindow', 'target=_blank and window.open'],
    ['onPermissionRequest', 'camera and microphone'],
    ['onGeolocationPermissionsShowPrompt', 'location'],
    ['setOnLongClickListener', 'the long-press "open in new tab" menu'],
    ['startActionMode', 'text selection → "Web search" (launches another app)'],
    ['setAllowFileAccess(false)', 'file:// browsing'],
    ['MIXED_CONTENT_NEVER_ALLOW', 'http content inside an https page'],
    ['setAcceptThirdPartyCookies', 'cross-site tracking cookies'],
    ['CookieManager.getInstance().flush', 'losing the parent\'s login on every process kill']
  ];
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    for (const [needle, door] of required) {
      assert.ok(body.includes(needle), `${p}: ${needle} is gone — ${door} is open`);
    }
    // https ONLY: intent:// market:// tel: mailto: all leave the app entirely
    assert.match(body, /"https"\.equals\(u\.getScheme\(\)\)/,
      `${p}: the scheme gate is gone — intent:// would launch another app`);
    assert.match(body, /getUserInfo\(\) != null/,
      `${p}: https://good.com@evil.com/ defeats a host check without this`);
    assert.match(body, /"\.\.".equals\(seg\)/,
      `${p}: %2e%2e arrives DECODED and would climb out of the allowed section`);
  }
});

test('MainActivity wires the viewer into back and the lifecycle, in BOTH copies (v1.0.45)', () => {
  for (const p of [
    'android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java',
    'native-reference/MainActivity.java'
  ]) {
    const body = readRepoCode(p);
    assert.match(body, /registerPlugin\(KidsWebPlugin\.class\)/, `${p}: the plugin is not registered`);
    const reg = body.indexOf('registerPlugin(KidsWebPlugin.class)');
    const sup = body.indexOf('super.onCreate(');
    assert.ok(reg < sup, `${p}: plugins must register BEFORE super.onCreate()`);
    assert.match(body, /KidsWebPlugin\.handleBack\(\)/,
      `${p}: hardware back would navigate the app hidden UNDER the site`);
    assert.match(body, /KidsWebPlugin\.onActivityPause\(\)/,
      `${p}: a site's audio would keep playing after the screen-off button (v1.0.32)`);
  }
});

test('the native pair is byte-identical (v1.0.45)', () => {
  // The manifest drifted for three releases because no test compared a pair; a rebuild
  // from native-reference would have shipped an APK with no Android TV support.
  for (const [a, b] of [
    ['android/app/src/main/java/com/assaf/kidsplayer/KidsWebPlugin.java', 'native-reference/KidsWebPlugin.java'],
    ['android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java', 'native-reference/MainActivity.java'],
    ['android/app/src/main/AndroidManifest.xml', 'native-reference/AndroidManifest.xml']
  ]) {
    assert.equal(readRepo(a), readRepo(b), `${a} and ${b} have drifted — disaster recovery would ship the wrong app`);
  }
});

/* ---- v1.0.45 review findings, each pinned so it cannot come back ---- */

test('a parent approval from the CHILD\'s blocked page reopens in CHILD mode (v1.0.45)', () => {
  // The severe one. That flow starts on the child's screen: the parent leans over, types
  // the code, approves, and hands the tablet back. Reopening in parentMode — which
  // navigates WITHOUT restriction — left that child holding a free browser, i.e. the
  // feature undone by the act of fixing it.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function askSiteRuleGrain');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.ok(!/openSiteForParent\(/.test(body),
    'the blocked-page approval reopens in PARENT mode — the child gets an unrestricted browser');
  assert.match(body, /reopenForKid\(/, 'the approval must hand the page back in child mode');
  const reopen = app.slice(app.indexOf('async function reopenForKid'), app.indexOf('async function openSiteForParent'));
  assert.match(reopen, /parentMode: false/, 'reopenForKid must be explicit about the mode');
});

test('parent mode does not survive an absence (v1.0.45)', () => {
  // It navigates unrestricted, so a tablet put down mid-login and picked up by the child
  // would be a free browser. Closing on PAUSE would be wrong (hopping to a password
  // manager is the commonest thing a parent does mid-login), so it expires on resume.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    assert.match(body, /PARENT_MODE_GRACE_MS/, `${p}: parent mode never expires`);
    const at = body.indexOf('static void onActivityResume');
    const fn = body.slice(at, body.indexOf('\n    }', at));
    assert.match(fn, /parentMode/, `${p}: resume does not consider parent mode`);
    assert.match(fn, /closeOverlay\(\)/, `${p}: an abandoned parent session is never closed`);
  }
});

test('the modal helpers are never called positionally (v1.0.45)', () => {
  // confirmKid/askKid/alertKid take an OPTIONS object. A positional call is not a syntax
  // error and not a crash — it silently renders the default dialog: "❓", no title, no
  // text. One shipped in this feature's own error path and only a read caught it.
  for (const [k, b] of CODE.entries()) {
    const bad = [...b.matchAll(/\b(alertKid|confirmKid|askKid)\(\s*['"`]/g)].map((m) => m[1]);
    assert.deepEqual(bad, [],
      `${k}: ${bad.join(', ')} called with a string — the dialog renders EMPTY`);
  }
});

test('the site probe is bounded, and the constant has a consumer (v1.0.45)', () => {
  // "A constant with no consumer is a lie" (v1.0.37). And without the bound a hanging
  // host leaves the parent on "בודקים את הכתובת…" with no way out — httpRequest has no
  // timeout of its own. Measured in the browser: the flow now completes in ~8s.
  const cfg = CODE.get('www/js/config.js');
  assert.match(cfg, /SITE_PROBE_TIMEOUT_MS/, 'the timeout constant is gone');
  const app = CODE.get('www/js/app.js');
  assert.match(app, /SITE_PROBE_TIMEOUT_MS/, 'nothing consumes the probe timeout');
  const at = app.indexOf('async function probeSite');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /Promise\.race/, 'probeSite awaits the network with no bound');
});

test('one site add at a time (v1.0.45)', () => {
  // Two taps ran two probes and raised two confirms; the modal swallows the second and
  // reports it as a cancel, so the parent's second tap silently did nothing.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /siteAddBusy/, 'the add button is not latched against a double tap');
  const at = app.indexOf('async function addSiteFromInput');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /if \(siteAddBusy\) return;/, 'the latch is not checked');
  assert.match(body, /finally/, 'a throw would leave the add button disabled forever');
});

test('nothing touches the WebView from the off-thread request hook (v1.0.45)', () => {
  // FIELD-REPORTED CRASH. `shouldInterceptRequest` is documented to run OFF the UI
  // thread, once per subresource. Any WebView method called from there throws
  // "A WebView method was called on thread 'WebViewCoreThread'" and kills the app — and
  // since the fatal exception surfaces from inside the WebView implementation, Android
  // blames the WebView package and offers the user to uninstall its updates.
  //
  // It only ever hit CHILD mode: parent mode returns on the hook's first line, so the
  // phone showed a working parent preview and a crash the moment the child opened the
  // same site. The state that hook reads must be plain fields, and volatile.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    const slice = (needle, close) => {
      const at = body.indexOf(needle);
      assert.ok(at > 0, `${p}: ${needle} not found`);
      return body.slice(at, body.indexOf(close, at));
    };
    const hook = slice('public WebResourceResponse shouldInterceptRequest', '\n        }');
    const helper = slice('private boolean subresourceAllowed', '\n    }');
    for (const [name, code] of [['shouldInterceptRequest', hook], ['subresourceAllowed', helper]]) {
      assert.ok(!/\bweb\s*\./.test(code),
        `${p}: ${name} calls a WebView method, but it runs OFF the UI thread — that is a fatal crash`);
    }
    // and the cross-thread state must actually be safe to read there
    for (const field of ['rules', 'currentPageUrl', 'parentMode']) {
      assert.match(body, new RegExp(`volatile\\s+[\\w<>.]+\\s+${field}\\b`),
        `${p}: ${field} is read from the request hook's thread and must be volatile`);
    }
    // `rules` must be REPLACED, never mutated in place, or the worker can observe it empty
    assert.ok(!/rules\.clear\(\)/.test(body),
      `${p}: rules is mutated in place — the off-thread reader can see it half-swapped`);
  }
});

test('the site viewer implements HTML5 fullscreen, and back leaves it first (v1.0.45)', () => {
  // A bare WebView does not implement fullscreen AT ALL — without onShowCustomView the
  // fullscreen button on an embedded player does nothing whatsoever, which is how this
  // shipped: it fails SILENTLY, with no error and no log. Reported from the device.
  for (const p of JAVA_PAIRS) {
    const body = readRepoCode(p);
    assert.match(body, /public void onShowCustomView\(/,
      `${p}: no onShowCustomView — a video's fullscreen button does nothing at all`);
    assert.match(body, /public void onHideCustomView\(/, `${p}: fullscreen can be entered but never left`);
    assert.match(body, /setKeepScreenOn\(true\)/,
      `${p}: a playing video is USE — without this the screen sleeps mid-video`);
    // The idle timer counts an open viewer and is fed only by page loads, so a video with
    // nobody touching the glass would look idle and the viewer would close mid-playback.
    const show = body.slice(body.indexOf('public void onShowCustomView('), body.indexOf('public void onHideCustomView('));
    assert.match(show, /fsPing|webActivity/,
      `${p}: nothing reports activity while fullscreen — the idle timer closes the video`);
    // back: fullscreen before history before close
    const back = body.slice(body.indexOf('static boolean handleBack()'), body.indexOf('\n    }', body.indexOf('static boolean handleBack()')));
    const fs = back.indexOf('customView');
    const goBack = back.indexOf('canGoBack');
    assert.ok(fs > 0 && fs < goBack,
      `${p}: back must leave FULLSCREEN before it walks history, or the child lands on a black screen`);
    // and closing the viewer must not leak a detached surface
    assert.match(body.slice(body.indexOf('private void closeOverlay')), /exitFullscreen\(\)/,
      `${p}: closing while fullscreen leaves the video surface attached`);
  }
});

test('the add flow ASKS about external content, and the answer reaches the rule (v1.0.48)', () => {
  // Asked at add time, not left to a toggle further down the panel: it is a per-site
  // decision the parent is already thinking about, and a site whose embedded videos will
  // not play looks broken long before anyone goes hunting for a switch.
  const app = CODE.get('www/js/app.js');
  const at = app.indexOf('async function runSiteAdd');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /askKid\(/, 'the add confirm is not a three-way question any more');
  assert.match(body, /third:/, 'there is no "with external content" answer');
  assert.match(body, /answer !== 'ok' && answer !== 'third'/,
    'an accidental dismiss must add NOTHING — the v1.0.23 rule');
  assert.match(body, /allowExternal = answer === 'third'/, 'the answer is not read');
  assert.match(body, /addSiteShortcut\([^)]*allowExternal/s, 'the shortcut door drops the answer');
  assert.match(body, /addSiteRule\(finalCanon, \{ allowExternal \}\)/, 'the rule door drops the answer');
  // and the rule a shortcut auto-creates must inherit it, or saying yes changes nothing
  const sc = app.slice(app.indexOf('async function addSiteShortcut'), app.indexOf('async function removeSiteEntry'));
  assert.match(sc, /addSiteRule\(canon, \{ allowExternal \}\)/,
    'the auto-created rule ignores the answer — the parent says yes and the page stays strict');
  // the SAFE answer must be the primary button
  const okIdx = body.indexOf("ok: 'הוספה — בלי");
  assert.ok(okIdx > 0, 'the primary button is no longer the strict one');
});

test('a landed pull redraws the surface the parent is ON, not just the home (v1.0.49)', () => {
  // FIELD-REPORTED. A pull lands wherever the parent is standing, and the parent screen is
  // exactly where they go to check that what they added on the other device arrived. Both
  // entryRefresh branches re-rendered the gallery ALONE, so every parent surface kept
  // showing pre-pull data and the parent pressed "רענון" to reveal rows already in the DB.
  const app = CODE.get('www/js/app.js');
  assert.match(app, /async function renderAfterRemoteChange\(/, 'the shared post-pull render is gone');
  const fn = app.slice(app.indexOf('async function renderAfterRemoteChange('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);

  assert.match(body, /nav\.isActive\('gallery'\)/, 'the child home is no longer redrawn');
  assert.match(body, /nav\.isActive\('parent'\)/, 'the PARENT screen is not redrawn — the reported bug');
  for (const r of ['refreshPendingList', 'refreshChannelsList', 'refreshSitesPanel']) {
    assert.ok(body.includes(r), `${r} is missing — that list stays stale after a pull`);
  }
  // refreshParent() also clears the status lines, re-applies the tab and re-runs the
  // update check: a SILENT background pull must not wipe a message the parent is reading.
  assert.ok(!/\brefreshParent\(\)/.test(body),
    'a background pull must not run refreshParent() — it clobbers the parent mid-action');

  // and BOTH branches must go through it, or they drift apart exactly as they did before
  const er = app.slice(app.indexOf('async function entryRefresh('));
  const erBody = er.slice(0, er.indexOf('\n}\n') + 1);
  const calls = (erBody.match(/renderAfterRemoteChange\(\)/g) || []).length;
  assert.equal(calls, 2, `entryRefresh calls the shared render ${calls}× — the pull and sync branches must BOTH use it`);
  assert.ok(!/nav\.isActive\('gallery'\)\)\s*(await\s*)?renderHome\(\)/.test(erBody),
    'entryRefresh renders the gallery directly again — the parent screen goes stale');
});

test('site entries are read by PRIMARY KEY, never the by_scope index (v1.0.49)', () => {
  // MEASURED IN THE BROWSER. `by_scope` is ['scopeId','order'], and IndexedDB leaves a
  // record OUT of an index entirely when any component of its key is undefined. A row
  // written without `order` — a peer on another version, a hand-edited snapshot, any
  // future writer — therefore EXISTED in the store and was invisible to every reader,
  // permanently and silently: getAll() on the store returned two rows while
  // listSiteEntries returned none, so the child's launcher stayed hidden and the parent
  // panel stayed empty over a full database. It presents as "the sync is broken" and
  // cannot be diagnosed from any screen.
  const db = CODE.get('www/js/db.js');
  const fn = db.slice(db.indexOf('export async function listSiteEntries'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(!/index\('by_scope'\)/.test(body),
    'listSiteEntries reads the by_scope index again — a row missing `order` becomes invisible');
  assert.match(body, /objectStore\('siteEntries'\)/, 'it no longer range-scans the store itself');
  // and the writer must guarantee the field, so no row can be malformed in the first place
  const put = db.slice(db.indexOf('export async function putSiteEntry'));
  const putBody = put.slice(0, put.indexOf('\n}\n') + 1);
  assert.match(putBody, /order/, 'putSiteEntry no longer defaults `order` — the nine call sites must not own it');
});
