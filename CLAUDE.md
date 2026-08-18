# CLAUDE.md — kids_player

Child-safe, parent-curated YouTube/video player for a ~5-year-old on an Android tablet.
**Vanilla JS ES modules (NO framework, NO bundler) + Capacitor 6.** UI is RTL Hebrew
(`<html dir="rtl">`). `www/` is the whole app; `android/` is committed and carries
hand-maintained native code. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the module map
and data model before touching sync/db/player code.

## Commands

```bash
npm run serve        # dev server http://localhost:5173 (fixed port, no-store, /__proxy CORS helper)
npm test             # node:test suite (~519 tests) — MUST stay green; pure logic only, no DOM
npm run apk          # cap copy + DEBUG apk → installs as com.assaf.kidsplayer.DEV (never collides with release)
npm run apk:release  # cap copy + SIGNED release apk (fails loudly if ~/.keystores/kids-player.properties missing)
npm run apk:verify   # apksigner — mandatory before publishing anything
```

Release/versioning/publishing: [PUBLISHING.md](PUBLISHING.md) + [INSTALL_AND_RELEASE.md](INSTALL_AND_RELEASE.md).
Version single source of truth = `package.json "version"` (gradle + JS derive from it).

## Hard invariants — breaking any of these is a regression

**Player ([www/js/player.js](www/js/player.js)):**
- `stop()` tears down and NEVER calls `onExit`; only `finish()` may (switching videos breaks otherwise).
- `setupHud()` binds `window` listeners — never run it twice without `teardown()`.
- The YouTube→YouTube reuse path (`loadVideoById`) must not recreate the iframe/HUD; it swaps the
  mutable `cb` so `finish()` never fires a stale `onExit`. Near-end poll guarded by
  `Date.now()-swapAt>1200 && currentTime>0.5`.
- `TAP_SINGLE_DELAY >= TAP_DOUBLE_MS` (config.js) or a slow double-tap both pauses AND seeks.
  The single-tap branch must ALSO `clearTimeout(tapTimer)` first: two taps in the 20ms gap
  between the two constants armed TWO toggles, so a deliberate double-tap paused and
  instantly resumed (v1.0.22).
- The pure decisions live in [playerlogic.js](www/js/playerlogic.js) (imports only config.js)
  and are node-tested — player.js itself is untestable DOM. **`clampSeek` on EVERY seek**
  (touch, drag and TV remote): an unclamped forward seek runs past the end, YouTube fires
  ENDED → `finish()` → `onExit`, so pressing ⏩ near the end EJECTED the child from the
  video. `shouldFinishNearEnd` also compares the player's REPORTED video id against the
  expected one — the wall-clock swap grace alone is a bet on network latency, and a slow
  `loadVideoById` made the poll read the previous video's tail.
- `pointercancel` MUST be bound next to `pointerup`: the seek bar sits in Android's bottom
  gesture inset, so the OS routinely steals the drag and no `pointerup` arrives. `dragging`
  then stayed true forever and every later pointermove anywhere seeked the video (v1.0.22).
- `loadYouTubeApi()` must be able to FAIL and be retried (onerror + timeout, and a rejected
  attempt is not cached). It used to cache a promise with no reject, so one offline tap left
  every YouTube video dead — black player, stale HUD, no status — until the app was killed.
- The YT `onError` timer is CANCELLABLE and re-checks `swapAt`. `reuse()` deliberately leaves
  `torn === false`, so video A's 400ms error timer used to destroy the iframe playing B.
- `playFile` takes the same `playSeq` token as `playYouTube`: `prepareStreamSrc` awaits a
  native bridge, and a tap during it detached the `<video>` while it kept decoding audio —
  two soundtracks that nothing could stop, because `current` no longer referenced it.
- A held TV-remote key must NOT scrub (`e.repeat` → reveal only). Android TV repeats at
  ~30/s and each event was a full ±10s seek: one second jumped ~4 minutes and could run
  past the end, ejecting the child.
- HUD bar CONTAINERS are `pointer-events:none` ALWAYS (only buttons/seek take events, only while
  `.hud-on`) — interactive bars swallow the center-tap/double-tap on small players.
- Tap model: hidden→tap only reveals; visible→center-50% tap toggles play. Paused pins the HUD.
- A video that ENDS calls `leaveWatch()` (v1.0.16): exit fullscreen, then `nav.back()` —
  the child returns to the FOLDER / search results they came from, never unconditionally
  home (`goGallery()` there was the bug). Works after video→video switches too because
  `openWatch` uses `nav.replace` while watching, so the entry below stays the folder.
- The app runs in game-style IMMERSIVE mode always (v1.0.16, MainActivity
  `applyImmersive()` + re-applied in `onWindowFocusChanged`): system bars hidden,
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` reveals them on an edge swipe. CSS keeps a
  minimum top padding (`calc(16px + env(safe-area-inset-top))`) so content never hugs
  the bezel when the insets report 0.
- Auto-fullscreen on tile tap: `enterPlayerFullscreen()` runs SYNCHRONOUSLY inside the tap
  gesture (an await first may void the user activation). 🏠 lives OUTSIDE the player
  (`.watch-top`, top-right) — deliberate: home requires exiting fullscreen first (v1.0.2).
- The app rotates freely (no manifest screenOrientation since v1.0.2) — portrait tweaks live in
  the 560px media query; check both orientations when touching layout.

**Data ([www/js/db.js](www/js/db.js), [plan.js](www/js/plan.js), [sync2.js](www/js/sync2.js)):**
- `classifyLink` in [classify.js](www/js/classify.js) is THE safety boundary — every link entering
  storage passes through it, including snapshot import and share intents. Never bypass.
- `loadMergeIndex` returns FULL records. A partial projection silently strips type/id/url from
  merged records (real bug once).
- Pending records are PARKED in `folderId:'~pending'` (kid folder queries must never see them);
  approval restores `homeFolderId`.
- **THERE ARE THREE CURATION STATES, AND 'rejected' IS NOT A DELETION** (v1.0.23).
  `normalize.PARKED` names both parking slots (`~pending`, `~rejected`) — a record the child
  must not see is moved OUT of its real folder, because `by_folder_sort` has no state
  component and state alone would not hide it. `db.rejectPending` now PARKS instead of
  calling `deleteVideo`: the record survives, no tombstone is written, and the parent can
  pull it back from the rejected list (`db.restoreRejected` → pending). The old behaviour was
  unappealable — `deleteVideo` erased the row AND wrote a deny tombstone whose only undeny
  path is a sheet re-add, and a video inside a channel has no sheet row at all.
  `db.purgeRejected` ("מחק לצמיתות") is the ONLY destructive step and it is the old path:
  delete + tombstone, so it travels to every device. Neither soft-reject nor purge writes
  `# הוסר` sheet rows — a removal row denies the key everywhere forever (defeating restore),
  and bulk rows wreck the sheet (the same reason bulk reject-all never wrote them).
- **A REJECTION MUST SURVIVE EVERY LATER SYNC.** A channel video is re-offered by the RSS
  pass every 30 minutes and by every backfill page, so anything that forgets the rejection
  hands the child back exactly what the parent threw out. Two layers, both deliberate:
  `normalize.resolveCuration` (pure) decides curation for any two copies of one video — **the
  LATER parental decision wins**, `pending` is never a decision, and a tie resolves to
  `'rejected'` (hiding a wanted video is a complaint; showing a rejected one is a betrayal);
  and `plan.planMutations`' prior branch pins `prior.state` for pending/rejected. The pure
  helper is the mechanism — the plan.js line is a second layer and no test fails without it
  (its own comment says so; do not read it as load-bearing).
- `mergeVideoRecord` no longer promotes with "a live loser beats a pending survivor" — it
  delegates to `resolveCuration`, so a peer's stale `live` copy cannot revive a rejection
  that happened later on another device.
- **APPROVAL IS DECIDED BEFORE ANY MERGE, AND A MERGE MAY NEVER GRANT IT** (v1.0.22).
  `base.state` in `planMutations` defaulted to `'live'` and the `quarantine || !autoApprove`
  routing lived only in the brand-new branch at the bottom — so the titleTwin branch
  short-circuited past it with a spurious `'live'`, and `mergeVideoRecord` promotes a
  pending survivor when the LOSER is live. A channel added in the parent screen is
  `autoApprove:false`, so a same-titled twin arriving in the SAME run AUTO-APPROVED a video
  the parent had never seen: live in the child's folder with `approvedAt` still null. Found
  in the field on @rotemama4kids — its 109-video backfill contained exactly 2 such twins,
  and those 2 were the ONLY videos the child could see (the parent read that as "the app
  imported 2 videos"). Both merge branches now go through pure `settleCuration`, which also
  closes the mirror-image hole: `mergeVideoRecord` flips `state` but never `folderId`, so a
  legitimately promoted record used to stay parked in `'~pending'` — invisible in the child's
  folder AND absent from the approval queue. `settleCuration` lives in
  [normalize.js](www/js/normalize.js) next to the merge it repairs, because BOTH callers of
  that merge need it: `plan.planMutations` and `drive.applyRemoteDoc` — a peer's approval
  arriving over the Drive doc hits the identical promotion.
- **SHARED STATE TRAVELS BOTH WAYS** (v1.0.22). The app scheduled a PUSH on every mutation
  but called `pullDrive` from exactly three places — the first-launch Google connect,
  profile creation, and the enable-backup button. Neither app launch, nor profile entry, nor
  `syncLibrary`, nor the parent's 🔄 ever pulled, so an approval made on the phone reached
  Drive and SAT there: the tablet had no code path that read it, and one profile showed a
  different library on every device. `app.maybePullDrive()` now pulls on profile activation
  (which covers every launch — a launch ends in one) and on resume from the background.
  It is SILENT, best-effort, throttled (60s), and shares its in-flight promise so two
  callers cannot pop two pulls. It reports whether anything CHANGED via the
  `db.dataVersion()` write counter, so a render only happens when there is something new.
  **The pull and the sheet sync are SERIALIZED** (`pullThenSync`): both write the same video
  records, and interleaving them would let one clobber the other's merge.
- **`libraryChannels.updatedAt` IS STAMPED INSIDE `db.putLibraryChannel`**, not at the nine
  call sites (v1.0.22). That row carries `autoApprove` = "the parent approved this whole
  channel", and `drive.mergeLibraryChannel` resolves two devices by that timestamp. Nobody
  set it, so both sides compared `0 > 0`, the FIRST document won, and `merge(A,B)` answered
  `true` where `merge(B,A)` answered `false` — provably order-dependent, i.e. the documented
  commutativity invariant was false for this field. The suite missed it because the fixtures
  carry timestamps: **it pinned the fixture, not the production path.** On an exact tie
  (two legacy rows) the tie-break is the SAFE direction — the row still requiring approval
  wins — which is deterministic and can only ever ask for one extra confirmation.
  `drive.applyRemoteDoc` passes `preserveTimestamp`: restamping an applied remote record
  would make it instantly newer than the peer's and the two devices would ping-pong forever.
- Gift RANKS stay device-local on purpose (`drive.js` skips `giftRank`); only `unwrappedAt`
  converges, min-merged, so what a child opened stays open everywhere. Decision 2026-07-31:
  syncing `giftRank` is the exact path that once produced a runaway 🎁 folder needing a
  repair migration, and the child-visible benefit is small.
- **THE SOURCE OF TRUTH IS (SUBSCRIPTIONS, LOOSE VIDEOS); EVERYTHING ELSE IS DERIVED**
  (v1.0.38). `libraryChannels` rows ARE the source list; video records in the `'sheet'`
  folder are the individually added singles; both already travel in the Drive doc, which
  is why removing the Google-Sheets list added **0 bytes** to it. There is no second store
  and no mirror: nothing outside the app can add or delete content. See
  [docs/V1038.md](docs/V1038.md).
- Deletion = atomic delete + deny-list tombstone. Since v1.0.10 the deny-list is an
  LWW-element set: entries are never removed, only REVOKED (`removedAt >= at` = inert;
  `db.denyActive`, merge rule `drive.mergeDenyRecord` — later event wins, tie → revoked).
  **The revocation paths are now exactly two, and both are an explicit parental ANSWER**
  (v1.0.38): `plan.deniedReAddPrompt` when the parent re-adds one key by paste/search/
  share/import, and `app.offerDeniedRestore` for a channel's removed backlog. It must
  never be automatic — a parent who removed three bad videos must not get them back for
  re-pasting a link (the v1.0.23 rule). ⚠️ THIS WAS A LIVE HOLE, not a theoretical one:
  `addClassifiedRow` never consulted the deny set at all, so a re-pasted deleted video
  was written, shown to the child, and destroyed by the next pull
  (`drive.mergeDbFiles` deletes any video whose tombstone is active). The sheet's
  un-deny had been quietly repairing that.
- **NOTHING MIRRORS ANY MORE** (v1.0.38 deleted `planSheetMirror` + `applySheetMirror`).
  What the mirror also did — sweeping content whose channel nobody subscribes to — is now
  an UNCONDITIONAL sync stage (`sync2.gcOrphans`, pure `plan.planOrphanGC`), which is a
  bug fix: it only ever ran under `if (sheetParsed)`, so a sheet-less profile never swept,
  and a peer's channel deletion left its videos forever. `plan.orphanSweepValve` parks any
  sweep above max(10, 5%) or one that would take EVERYTHING (the v1.0.18 rule), because
  `deleteVideoRaw` writes no tombstone and a mass sweep churns against the Drive doc; a
  parked sweep is SAID in the sources tab, never left in a meta key nobody reads.
- **THE COMPLETE LIST OF THINGS THAT MAY DELETE A VIDEO RECORD**: the parent's explicit
  🗑️, `db.purgeRejected`, the 30-day rejected expiry, the migration's `# הוסר` rows,
  `db.purgeProfile`, and the orphan sweep. Adding to this list is a safety decision.
- `sortKey` depends only on the row's own ordinal/timestamps — appending never renumbers
  existing rows (test-pinned). `origin:'sheet-row'` survives as an ORDERING DOMAIN
  (`order.SHEET_BASE + rowIndex`, rendered DESC so the last line shows first); a links-file
  import writes it, which is why an imported list keeps its file order.
- `planMutations` twice over identical inputs ⇒ empty diff (the churn-free test is sacred).
- Gift state lives in `profileVideoState`, NOT on video records (siblings share libraries);
  `unwrappedAt` is forever (min-merged everywhere).
- **AN UNREADABLE DRIVE DOC IS NEVER AN EMPTY ONE** (v1.0.22, `drive.interpretDriveDoc` /
  `interpretDriveList` / `decidePush` — same pattern as `interpretSheetResponse`, and the
  same reason). `readDbFile` used to answer `null` for a 401, a network drop, a 200 + HTML
  sign-in page and a genuinely absent file alike; `mergeDbFiles(local, null)` returns
  `local`, so the "the remote changed since our last write, merge first" branch became a
  BLIND OVERWRITE of the very document it protected — one failed read and a fresh device
  PATCHed its empty doc over the family's whole library. **A version mismatch we could not
  read ABORTS** (`pendingPush` retries). Emptiness may come from exactly one input: a 404.
  A failed file SEARCH likewise must not read as "no backup" — that created a second db
  file permanently shadowing the real one.
- **PER-DEVICE CHANNEL PROGRESS TRAVELS NOWHERE**, in either direction, via ONE shared list
  (`drive.stripPerDeviceChannel` / `mergeChannelForApply`): cursors, `backfillDone`,
  `lastRssCheckedAt`, `playlistQueue`/`playlistsDone`, `noLongForm`. The serialize side used
  to omit `backfillDone`, and the apply side wrote a peer's record VERBATIM when the channel
  was new here — so a device inherited "finished" and only ever saw the ~15-video RSS window.
- A 401 INVALIDATES the cached token (`gauth.invalidateToken`, called from `drive.api`). The
  55-minute lifetime is our guess, not something `authorize()` returns, so a token revoked in
  the parent's account kept being handed out for up to an hour of failing I/O — which is the
  most likely real-world trigger for the overwrite above. `authorize()` is also shared between
  concurrent callers, so two taps cannot pop two system dialogs.
- `copyDenies` judges presence by the RECORD EXISTING, not by `loadDenySet` (which hides
  revoked entries), and carries the source row's own `at` (`db.denyRowToWrite`). Otherwise a
  revoked tombstone read as absent, was overwritten with `at: Date.now()`, lost its
  `removedAt`, won the Drive last-event comparison, and re-deleted the video on every device.
- `db.pageFolder` returns NOTHING for `limit <= 0`. The push used to precede the length
  check, so a zero limit yielded one row — and `pageAnyFolder` passes `limit - extras.length`,
  which is exactly 0 once absorbed singles fill a page (16 tiles on a 15-tile grid, the row
  repeated on page 2).
- **A PROFILE NAME IS UNIQUE PER GOOGLE ACCOUNT, NOT PER DEVICE** (v1.0.22). `createProfile`
  mints the id LOCALLY and BOTH merge paths union by id (`store.mergeProfileLists`,
  `drive.mergeDbFiles`) — the name is never compared — so two devices on one account could
  each create "נועם" and both would survive the sync. That is not cosmetic: `profileVideoState`
  is keyed by profileId (the child's 🎁 progress SPLITS), `prof:<id>` splits their personal
  videos, and a sheet-less profile gets `lib:p:<profileId>` — two whole libraries for one
  child, while the parent just sees two identical avatars. Creation therefore PULLS FROM
  DRIVE first (`pullDrive` already folds remote profiles in via `mergeRestoredProfiles`) and
  blocks with a distinct message via pure `store.profileNameConflict` → 'local'|'remote'|null.
  The pull is BEST-EFFORT: hard-blocking creation when Drive is unreachable would make the
  app unusable offline. That leaves one irreducible case — two devices offline at once —
  because with no server there is no coordination point; `store.duplicateProfileNames`
  reports it in the parent screen and the parent renames or deletes. Never auto-merge
  (irreversible: gift state + scopes) and never auto-rename behind their back.
- **A PROFILE'S `libraryId` IS IMMUTABLE** (decision 20, as of v1.0.38). `lib:p:<profileId>`
  for every profile created from now on; `prof:<id>` stays the personal scope. A legacy
  `lib:<fnv1a(sheetKey)>` is kept EXACTLY as it is — pre-v1.0.38 families derived it from a
  sheet URL and several profiles may SHARE one, so changing it would strand the whole family
  library under an unreachable scope, on every device. `db.moveScope`, `plan.planScopeAdoption`
  and `app.adoptLibraryScope` are DELETED, which is what makes this enforceable rather than
  aspirational: no code path can change a scope any more, and an invariants guard fails if one
  comes back. There is deliberately NO way to attach a sources sheet either — the migration
  deletes the family's sheet files, so a re-attached URL would point at a file nothing
  maintains AND would undo the migration on the next launch.
- **THE SCOPE TRAVELS IN THE DRIVE DOC** (`profileSources[pid].libraryId`, v1.0.38, additive).
  It used to be derivable from the sheet URL and the entry was written only when one existed —
  so after the migration a fresh device restoring the backup got the profiles and every
  `libraries[…]` blob but NO sources row, and `ensureSources` minted `lib:p:<id>` while the
  content sat under the old hash: empty home, full database. Pure
  `drive.resolveRestoredLibraryId` decides (explicit id → the legacy derivation → `lib:p:`).
  An older app is unharmed because a migrated entry carries `sheetUrl: null` and its own
  `if (!ps.sheetUrl) continue` skips it — which is why that value must stay NULL, never `''`
  or a sentinel (test-pinned).

**Platform/native:**
- `platform.exitApp()` prefers `KidsNative.exitApp` (finishAndRemoveTask + delayed kill) —
  `App.exitApp()` only finish()es and reads as "minimize" on real devices (v1.0.4).
- CapacitorHttp silently DROPS a request body without an explicit `Content-Type` header.
- `Filesystem.downloadFile` IGNORES `recursive:true` on Android — `mkdir` first.
- Registering Capacitor's `backButton` listener disables ALL default back handling —
  `nav.handleBack` must consume every case (catch-all swallow).
- Native plugins register BEFORE `super.onCreate()` in MainActivity. `BridgeActivity.load()` calls
  `this.onNewIntent(getIntent())` itself — one onNewIntent override covers cold+warm share intents.
- OAuth = Play Services AuthorizationClient (`drive.file` only): NO refresh token exists, no client
  secret; one Android OAuth client per signing SHA-1 (see GOOGLE_CLOUD_SETUP.md).
- YouTube quota: NEVER call `search.list` (100 units). RSS is free. Batch by 50.
  The parent's search (v1.0.33) is NOT an exception: it uses the KEYLESS youtubei
  endpoint (0 quota, no API key), sanctioned in `www/js/ytsearch.js` ONLY — the
  invariants suite pins the one-module rule, bans `key=`/`getApiKey()` there, and
  still fails any Data-API search shape anywhere.
- The API key ships via GITIGNORED [www/js/keys.local.js](www/js/keys.local.js) (repo is PUBLIC —
  never commit it; never serialize it into the Drive DB/Sheet). Restrict it by API only — an
  Android-app restriction breaks CapacitorHttp requests.
- No-bundler import layer order (a cycle = undefined bindings at runtime, not a build error):
  `platform → store/classify/csv/util → db → plan/sync2/drive → ui/* → app.js`. `nav.js` never
  imports views. `tour.js` imports NOTHING (pure data + pure functions), so it is safe
  anywhere in the order.

- v1.0.45 — **APPROVED WEBSITES: a restricted browser inside the app** (user request).
  Full record: **[docs/V1045.md](docs/V1045.md)**; the maintainer's map (what lives where,
  how to extend it, the five things that break in silence): **[docs/WEBSITES.md](docs/WEBSITES.md)**
  — read that one BEFORE touching `weblock.js` or `KidsWebPlugin.java`. Until now every item a child could see
  passed `classifyLink`, one narrow boundary; this puts a BROWSER on a 5-year-old's
  tablet, so most of the work is what gets BLOCKED.
  - **TWO LISTS, AND THE SPLIT IS THE FEATURE.** One store, `siteEntries`, discriminated
    by `kind`: a **`shortcut`** (url+title+icon) is what the child sees as a tile; a
    **`rule`** (a canonical prefix) is where they may navigate and is **NEVER rendered** —
    a rule is often a sub-path or a different site entirely. Navigation is checked against
    ALL rules, so one approved site may link to another. **Adding a shortcut auto-creates
    the matching rule**, or the first link tap inside it is blocked and the site reads as
    broken rather than as an unmade setting. Scope is the PROFILE (`prof:<id>`).
  - **[weblock.js](www/js/weblock.js) IS THE SAFETY BOUNDARY** — the `classifyLink` of this
    feature, pure, one module, invariant-pinned. A `startsWith` is NOT a prefix check:
    `example.com/kids/` would admit `example.com/kids-adult/`, `good.com` would admit
    `good.com.evil.com` and `good.com@evil.com` (userinfo). So https ONLY, userinfo
    refused, host lower-cased sans `www.`, port normalized, **path compared BY SEGMENT**,
    each segment `decodeURIComponent`-ed and THEN `.`/`..` refused — that order because
    `Uri.getPathSegments()` decodes on its own, so `%2e%2e` reaches Java already as `..`.
    `matchRule` returns the LONGEST match, so a broad rule added later cannot loosen a
    section the parent kept strict.
  - **THE RULE LIVES IN TWO LANGUAGES, SO JS NORMALIZES AND JAVA ONLY COMPARES.**
    Enforcement is `shouldOverrideUrlLoading`, which the node suite cannot execute; JS
    hands over `{host, port, segments[]}` already canonical and `KidsWebPlugin` must never
    parse a prefix itself.
  - **AN `<iframe>` CANNOT ENFORCE THIS** (same-origin blocks reading `location` or
    intercepting navigation, and much of the web sends `X-Frame-Options: DENY`), and
    Custom Tabs has no hooks. Hence a native WebView — added to the decor view, NOT a
    second Activity, so lock-task (the kiosk lock) and immersive mode are unaffected.
  - **NINE DOORS, EACH A ONE-GESTURE ESCAPE**, all pinned in BOTH java copies: non-https
    schemes (`intent://` `market://` `tel:` `mailto:` open ANOTHER APP), subresources
    (ads/trackers/embedded players), downloads (an APK), `onCreateWindow`, camera/mic/
    geolocation, the long-press menu, `startActionMode` (text selection → "Web search"),
    `file://`, and mixed content. **Third-party content is STRICT by default** — same host
    or subdomain, or another approved rule's host — with a per-RULE opt-out behind a
    warning.
  - **THE PASSWORD IS TYPED ONCE**: cookies + DOM storage persist, and
    **`CookieManager.flush()`** runs on close and on `onPause` — without it the login dies
    with the process and "once" silently becomes "every time". ⚠️ SSO to another host is
    blocked by the rules, so the login door is **parent mode**: `parentMode:true` navigates
    UNRESTRICTED, behind the PIN, with a differently-coloured bar; the child inherits the
    session. Not a new capability — the parent screen already opens any URL via
    `openExternal`. An invariants guard pins that no child path can reach it.
  - **A BLOCKED PAGE IS A FIX, NOT A DEAD END**: a calm message plus a discreet "הורים"
    button → `webAddRequest` → **`startPin` in JS** → pick the grain (whole site / this
    section / this page, defaulting to the SECTION, never the whole site) → reopen on the
    blocked page. **THE PIN IS NEVER VERIFIED IN JAVA** — that would be a second
    implementation of the one check guarding the whole parent surface; an invariant bans
    the word.
  - ⚠️ **`DB_VERSION` 1 → 2, AND THE UPGRADE HANDLER WOULD HAVE BRICKED EVERY INSTALL.**
    It created all 9 stores UNCONDITIONALLY — harmless only while the version never moved.
    Measured in the browser: an unguarded bump throws `ConstraintError`, aborts the
    version-change transaction, and the app cannot open its database AT ALL. Every
    `createObjectStore` now sits inside `if (ev.oldVersion < N)`, pinned by a test.
  - ⚠️ **`buildLocalDoc` HAS TWO BRANCHES AND THE SECOND IS THINNER.** Sites are
    profile-scoped, and the `prof:<id>` pseudo-library is built separately (it already
    omitted `deletedChannels`) **and only `if (pv.length)`** — so a child with approved
    sites and no personal videos would have synced NOTHING, silently, while every local
    screen looked right. Both branches carry the collection now; guard-pinned.
  - Deletion is a **tombstone written FIRST** (`meta['siteDel:<scope>']`, max-merge, strict
    outlives, **tie = deleted**) — the v1.0.36 lesson: absence alone is re-added by any
    peer that has not pulled. `purgeProfile`'s `metaKeys` loop was filtered to `lib:`
    scopes and would have stranded these; fixed.
  - **SCREEN TIME, or the browser is a hole in it**: `armScheduledLock()` on site open;
    **`showLockedScreen` closes the viewer BEFORE `nav.reset('locked')`** (a native overlay
    would otherwise hide the lock while the child kept browsing); taps inside a native
    WebView never reach `window`, so the plugin emits a throttled `webActivity` that feeds
    `idleLastInputAt`; `tickIdleSleep` counts `siteViewerOpen`. There is deliberately NO
    "עדיין צופים?" prompt for a site — it lives inside `#player-wrap`, under the WebView —
    so the idle path just closes the viewer and hands control back to the app.
  - `sitesEnabled` is per-profile and synced, **ON unless written** (tie → off). The
    launcher shows only when it is on AND at least one shortcut exists (v1.0.21), and never
    on TV — a remote cannot drive an arbitrary website. `refreshSitesLauncher` RE-READS
    rather than trusting a cache: measured in the browser, a peer's change was otherwise
    invisible until the profile was switched.
  - **THE VIEWER IS DEVICE-ONLY AND THE BROWSER SAYS SO** rather than half-working with an
    iframe. All the chrome is browser-verifiable; the viewer is a device-checklist item.
  - The links file is deliberately untouched (its promise is "no second parser, no second
    safety boundary"). 18 weblock unit tests + 8 Drive/snapshot tests + 13 wiring
    invariants; every guard proven red on a planted regression — and the first three fired
    on their own COMMENTS, so the Java guards read comment-stripped source.

- v1.0.43 — **LEAVING FULLSCREEN LANDS ON THE TOP OF THE WATCH PAGE** (user request). Exiting
  fullscreen is NOT a navigation: `nav.handleBack` answers `'exit-fullscreen'` and returns,
  and the HUD's ⛶ does the same — so nothing ever scrolled, and the child came back to
  wherever they had scrolled to, usually the under-player grid with the small player
  off-screen above. `nav.go` has guaranteed a top landing since the F4 fix; this is the one
  way out that never goes through nav.
  - The scroll runs **TWICE, and both are load-bearing**: immediately, because
    `requestAnimationFrame` callbacks are **SUSPENDED while the document is hidden**
    (measured — fullscreen exiting as the app backgrounds would otherwise leave the page
    scrolled), and again after `nav.transition`'s proven double rAF, because the reflow as
    the element leaves fullscreen lands after an immediate scroll and would undo it.
  - `nav.isActive('watch')` is checked at event time AND inside the deferred callback:
    `leaveWatch` (a video that ENDED) exits fullscreen and then `nav.back()`s into the
    folder, restoring its scroll — a late scroll-to-top would drop the child at the top of a
    folder they were half-way down. Verified in the browser: scrolled to 280 → exit →
    top; and a LATE event after the navigation left the folder's position alone.
  - Both vendor event names are bound (older WebViews fire only `webkitfullscreenchange`).
  - **v1.0.51: the double rAF was NOT enough on device** — Android's WebView RESTORES the
    pre-fullscreen scroll offset as the native custom view tears down, after both rAFs.
    A `scroll` listener now PINS the top for `FS_EXIT_PIN_MS` (700ms) after the exit
    (same three guards: window expired / re-entered fullscreen / left the watch view).
    Never fix this class of race with a longer timer — the pin reacts to the restore
    whenever it lands. See docs/V1045.md §18.

- v1.0.44 — **THE SHEET SUNSET IS DELETED, a month before its deadline** (user request). The
  v1.0.38 migration's whole job was one final read of the family's sources sheet plus the
  deletion of that file; `test/sunset.test.mjs` carried the seven-step checklist and all of it
  is done. What that removes from the app: the **only** Google Sheets call and the **only**
  HTTP DELETE it ever made — both now banned by an invariant, because either one coming back
  would also bring back a Google capability the app does not need.
  - **DEVIATION FROM MY OWN CHECKLIST, deliberate**: step 4 said to delete
    `migrate.planMigration`'s `legacySheetMigrated` along with `sheetUrl`/`sheetHash`. It has a
    LIVE consumer — `sync2`'s quarantine reads it to route a legacy family's unknown keys to
    `'pending'` instead of resurrecting videos they deleted in the pre-overhaul app. `sheetUrl`
    had to go (nothing clears it once the sunset is gone) and `sheetHash` was already
    vestigial; the flag stays, and does not depend on a sheet existing.
  - `sunset:<pid>` meta rows are left behind on devices that ran the migration. Deliberate: a
    dataver step to sweep a few dead bytes per profile is more machinery than the tidiness is
    worth, and nothing reads them.
  - ⚠️ **THE EARLY REMOVAL'S COST, stated because it is real**: a family that never launched
    v1.0.38–v1.0.43 three times will now never have its sheet read. The failure mode is NOT
    destruction — with the migration gone nothing deletes their sheet either, so the file
    stays in their Drive and its rows can be re-imported through the links-file paste. What
    they lose is the automatic fold of rows the sync had not already stored.

## Verification workflow

**Full guide: [docs/TESTING.md](docs/TESTING.md)** — including what a green suite does NOT
prove, and the device checklist. The short version:

1. `npm test` after any logic change.
2. Browser (`npm run serve`): full UI flows; IndexedDB migration works in-browser; sync runs against
   the real sheet through `/__proxy`. Escape = hardware-back stand-in. Fullscreen is DENIED in
   embedded panes — not an app bug.
3. Device (`npm run apk` → the `.dev` app): back button, native fullscreen, keep-awake,
   share-from-YouTube, Drive sign-in, updater. NEVER install a debug build over the release app.

## Configuration — one file

[www/js/links.js](www/js/links.js) (`LINKS`) is the SINGLE place for every external
address: donation links (`donate.paybox` / `donate.paypal` — empty string = method not
offered, both empty = donation block hidden), developer contact mail + cc + subject,
the public site (GitHub Pages from `docs/`, used by Google OAuth verification AND the
About tab's privacy button), and `updateRepo` for the updater. `donate.js`, `update.js`
(`UPDATE_REPO`) and `app.js` all read from it — never hardcode an address again; a test
pins that the consumers follow the config and that every address is well-formed.

## Current state pointers

- All 14 overhaul features are implemented (see git log stages 0-7 + fix commits).
- v1.0.40 — **⭐ מועדפים: THE CHILD'S OWN MARK** (user request 2026-08-11: any video the child
  taps ⭐ on appears in its own folder at the top of the home, IN ADDITION to where it lives,
  and is never deleted automatically; a second tap removes it).
  - **IT ALSO FIXES v1.0.39's WEAKEST POINT.** The window's automatic belt was `posSec`, and
    a video watched to the END clears its position — so the most-rewatched video carried no
    signal at all. A star is a STATEMENT, not a guess, and it is now the strongest member of
    `protectedWindowKeys`.
  - **`favAt` + `favOffAt`, AN LWW-ELEMENT SET** (`plan.favActive`, the `db.denyActive`
    pattern). A removal is an EVENT, never a cleared field: with a single `favAt`, un-starring
    on the tablet would be undone by the phone's stale copy and the video would walk back
    into ⭐. Later event wins; a TIE is NOT a favourite (a star the child taps again is a
    shrug, a video that refuses to leave is the app disobeying them). `mergeFavState` is
    max-per-field, so it is commutative and idempotent.
  - **TWO FUNCTIONS WOULD HAVE DROPPED IT IN SILENCE**, and the feature would have looked
    device-local: `drive.serializeStateEntry` was an if/return chain ("whichever field
    wins"), so a star on an already-opened video — i.e. almost every one — never reached the
    document; and `mergeAppliedState` returned `null` unless the REMOTE carried an
    `unwrappedAt`, so a favourite-only entry was discarded on pull. Both now carry the
    favourite half, and the fold preserves the local position AND a local `giftRank`.
  - **NO NEW INDEX AND NO `DB_VERSION` BUMP**: the ⭐ folder is derived from the profile's
    state map, which `loadGiftStates` already holds in memory for every render. `db.setFavourite`
    is a read-modify-write on ONE row so it cannot disturb the gift/unwrap/resume fields.
  - **ORDER IS `favAt` ASCENDING — a new star is APPENDED** (the user's decision). A
    5-year-old navigates by POSITION, not by title; newest-first would move every video they
    already know each time they add one.
  - ⭐ is pushed SECOND in `buildFolders`, right after 🎁, and hidden at zero (a tile that
    opens an empty grid is the v1.0.21 bug). Both `pageAnyFolder` AND `nextAfter` learn the
    kind — the existing invariant that they cover the same set now includes `'fav'`, so the
    chain can never disagree with the grid. ⭐ IS chained (unlike 🎁): watching favourites
    one after another is the point of the folder.
  - The ⭐ pager's self-heal clears only the FAVOURITE fields. The gift folder may delete the
    whole state row (a rank is its whole point); doing that here would erase `unwrappedAt`
    and RE-GIFT a video the child already opened.
  - The button lives in `.watch-top` next to 🏠, **OUTSIDE `player-wrap`** — the HUD's tap
    model (centre tap = pause, double tap = seek) has been broken more than once, and a real
    `<button>` there is also what the TV remote reaches. No PIN and no confirm: it is not
    destructive in either direction.
  - **A SIBLING'S STAR PROTECTS TOO** (`protectedWindowKeys({ statesByProfile })` +
    `db.loadVideoStates`): on a legacy shared library one child's window must never prune the
    other child's favourite — the same cross-profile rule `db.deleteVideoStates` follows.
  - ⚠️ **NO CAP, by the user's decision** (2026-08-11) after the consequence was stated: a
    child who stars a great many videos narrows what the rolling window can ever propose. A
    channel whose whole over-window set is starred simply produces no notice, which is the
    honest outcome — there is nothing to offer.
  - **THE FOLDER ART** (user request; corrected in v1.0.42 — I had it backwards). **⭐ STAYS
    THE FAVOURITES FOLDER'S MARK**: a star IS the universal "favourite" sign and was never
    what collided. The hand-authored SVG scene belongs to the LOOSE-SINGLES folder
    ("סרטונים נוספים"), which is what used to wear that star — a mixed-bag folder gets a
    mixed-bag picture (rainbow, rocket, horse, two children), with 🎬 as its fallback. Two constraints decided the drawing and the first draft broke both: it renders in a
    104px circle (72px under 560px), so a shape must be ~35 of 120 units to read at all (the
    draft's 22-unit faces came out ~7px, i.e. mud); and the circular clip cuts anything past
    ~52 units from the centre (the draft's sun and second child were sliced). `mountFolderArt`
    keeps the emoji as an `onerror` FALLBACK — a stale WebView cache must degrade to ⭐, never
    to an empty circle. An invariants test pins that the asset SHIPS, that it is
    self-contained (no xlink/image/remote url/font/script — the app runs from file://), and
    that the fallback exists.
  - **⭐ IS A VIEW THE CHILD CAN EMPTY FROM INSIDE IT**, which nothing else in the app can do:
    un-starring the video they are watching removes it from the very list the under-player
    grid is paging, and with one favourite that left an EMPTY grid and then an empty folder
    screen. `renderWatchGrid` falls back to where the video actually LIVES
    (`homeFolderId || folderId`) when ⭐ runs dry — the same fix 🎁 needed in v1.0.21, for the
    same reason (a gift leaves 🎁 the instant it is unwrapped). Verified in the browser: the
    grid went 1 → 3 tiles (the channel) instead of 1 → 0.
  - **TAP → FULLSCREEN IS NOW PINNED** (the v1.0.2 rule had no test for 38 releases). Every
    feature since has added lines to `openWatch` and to the tile handler, and ONE `await` in
    front of either silently costs the child fullscreen — a symptom node cannot see. The guard
    checks the tile handler is neither `async` nor awaiting, and that nothing is awaited
    between `openWatch`'s entry and `enterPlayerFullscreen()`. Measured with a REAL tap in the
    browser: the request reaches `#player-wrap` with `navigator.userActivation.isActive` TRUE.
  - **TV AUDIT** (v1.0.40): the ⭐ makes `.watch-top` a three-button row; verified in `tv=1`
    that all three are real, visible `<button>`s, that the remote reaches the star (up from
    the player, then left), and that `html.tv button:focus` covers it. ⚠️ WHILE AUDITING,
    `getComputedStyle` reported `outline-style: none` on ALL THREE — including two untouched
    buttons. That was **`document.hasFocus() === false`** in a background pane, so `:focus`
    matched nothing: an artifact, not a bug (the same class as the preview browser's fake
    image failures, v1.0.24). Verify a focus ring only in a pane that holds focus.
  - Verified end-to-end in the browser: ☆ → ⭐ → ☆ → ⭐ with the stored LWW timestamps, the
    home ordering 🎁 → ⭐ → 📺, the video present in BOTH ⭐ and its channel folder, and a
    window of 1 over 8 videos proposing seven — never the starred one. 8 unit tests + 4
    wiring invariants, every guard proven red on a planted regression (one of them caught
    VACUOUS on its first plant and sharpened).
- v1.0.39 — **THE ROLLING WINDOW: the library stops growing forever, and NOTHING is ever
  deleted without the parent answering** (user request 2026-08-09: "I want to stay up to
  date with the newest videos" → their own conditions: *tell me which channel, let me mark
  what not to delete, or wipe the channel and keep only new ones*).
  - **THE FRAMING CORRECTION THAT CAME FIRST, and it was measured**: the per-channel cap
    does NOT block new uploads. A folder at 500 — or at 3000 — accepts fresh RSS entries
    (5 offered, 5 imported). The ceiling that eventually stops new videos is
    `MAX_ITEMS_TOTAL`, and it stops them **for every channel at once**. So this feature
    bounds GROWTH; it is not a fix for "new videos do not arrive".
  - **`keepNewest` is per-profile, SYNCED, and 0 (OFF) unless written.** The opposite
    default to `screenOffAfterMin`, deliberately: it is the only setting in the app that
    deletes the CHILD's content, so it may never arrive with an update. Pure
    `plan.keepNewestPerChannel` reads every unusable value — including a window below the
    10 minimum — as OFF: a mistyped `1` must not propose emptying a folder.
  - **THE SYNC NEVER DELETES FOR THE WINDOW.** `plan.planChannelWindow` PROPOSES (live
    records only — pending/rejected are parked and belong to the approval queue and its
    30-day purge), the מקורות tab NAMES the channels that are over, and the only code that
    deletes sits behind a `confirmKid`. An invariants test bans any other module from even
    mentioning `planChannelWindow` or `deleteVideosWithTombstones`.
  - The review reuses `view-pick` with the MIRRORED default: rows arrive **unticked**
    (they are the ones proposed for deletion; a tick means "keep forever"), where the
    approval picker starts all-ticked. Two answers: delete those over the window, or
    `pick-alt` — delete every video of the channel and let RSS repopulate it ("only new
    from now on"; the backfill is already finished for a subscribed channel).
    `pickHandlers.keepOpen` exists because a CANCELLED confirm must leave the parent on the
    list with live buttons — the shared wiring nulls the handlers and navigates back.
  - **`keepForever` is GROW-ONLY through `normalize.mergeVideoRecord`** (`s.keepForever ||
    l.keepForever`). `out = {...s}` alone loses it whenever the other copy wins — a peer
    with an older `addedAt` becomes the survivor, and the fresh sync candidate carries no
    flag — and the failure mode is a protected favourite quietly becoming deletable.
  - The prune uses **`db.deleteVideosWithTombstones`** (`reason: 'window-prune'`), chunked.
    A tombstone is NOT optional: a raw delete is pure absence and every Drive merge is a
    union, so a peer would re-push every pruned video (the v1.0.36 lesson). Consequence to
    state out loud, and the confirm does: a pruned video returns only by re-adding the
    channel (`app.offerDeniedRestore`, v1.0.37).
  - **THREE DEFECTS THE BROWSER CAUGHT AND REASONING DID NOT** — all three would have
    shipped green:
    1. `giftStates` is a **Map**, and the first version read it with `Object.entries`, so
       the child-side protection matched NOBODY.
    2. **`unwrappedAt` IS NOT A WATCH SIGNAL.** `planGifts`' baseline stamps it on every
       live record that did not become a gift, so after one sync nearly the whole library
       carries it — trusting it made the feature a measured no-op (a 60-video channel 40
       over its window proposed ZERO). The app has no play counter; `posSec` (resume) is
       the only honest signal, so **the parent's ticks are the real protection**.
    3. `pick-alt` deleted videos the parent had ALREADY marked keep-forever — a marked
       video is not proposed, so it never appears in the list and cannot be re-ticked.
       `allLive` now excludes `keepForever`.
  - **THE PROPOSAL IS RE-READ AT COMMIT TIME.** It is computed when the review OPENS, and a
    sync, a Drive pull or the parent acting elsewhere can move a video in between (approved,
    rejected, protected, already gone). Writing a `window-prune` tombstone for something
    that is no longer a prunable live record would permanently deny a video this dialog
    never asked about; the toast reports what was ACTUALLY removed, not the pre-confirm
    intent.
  - `keepForever` also travels through the SNAPSHOT: the export carries full records, and
    the import (which builds an explicit record) used to drop it, so a restore silently
    unprotected every favourite — the same class as the `srcChannel*` fields that function
    already carries for exactly that reason. It stays SPARSE (never written as `false`).
  - `settings.SAFE_ON_TIE_MAX` — a numeric tie-break for `keepNewest`: on an exact `at`
    collision the LARGER window wins, because the generic fallback orders by STRING and
    would prefer `"9"` over `"200"`. Too large keeps videos nobody wanted; too small
    proposes deleting videos the child watches (the resolveCuration asymmetry).
  - ⚠️ KNOWN CONSEQUENCE, not a bug: on a LEGACY shared library (`lib:<hash>`, several
    profiles on one sheet-derived scope) the setting is per-child but the CONTENT is shared,
    so one child's window prunes the shared folder for the siblings too. The settings label
    names the child (`keep-newest-owner`) and every deletion is reviewed per channel, so
    nothing happens unseen — but the effect crosses profiles.
  - **THE ADVERSARIAL PASS FOUND FIVE MORE, and the first one was severe** (all fixed,
    all pinned):
    1. **ORPHAN GIFT STATE JAMS 🎁 FOREVER.** `planGifts` counts `outstanding` straight out
       of `profileVideoState` — `giftRank && !unwrappedAt`, records or no records — and stops
       gifting at `outstanding >= baseline`. Pruning a handful of UN-OPENED gifts therefore
       meant the child never received another one, and `planGiftRunawayRepair` cannot rescue
       it (it no-ops below its 60-record floor). The 🎁 tile counts the same index, so the
       orphans also promised a folder that resolved to nothing, and `serializeStateEntry`
       would have carried them in the Drive doc forever — in a feature whose purpose is
       bounding growth. `db.deleteVideoStates` now clears them for **every profile that reads
       the library**, not just the active one (a legacy shared scope jams a sibling too).
    2. **`pick-alt` deleted the `posSec`-protected half** — the exact twin of the
       keep-forever bug: protected ⇒ never proposed ⇒ never rendered ⇒ impossible to tick.
       ONE `guarded` set now gates the proposal AND the wipe pool.
    3. **`SAFE_ON_TIE_MAX` turned an explicit OFF into ON**: 0 is not a small window, it is
       off, so it wins the tie before the max rule.
    4. **A throw inside `commit` was a silent dead end** — `settled` was released only on a
       cancelled confirm, so any failed write left both buttons inert with no message.
       try/catch releases it and says so.
    5. **The review could be opened twice** (its prelude does two library reads before
       navigating): the second open repainted the list and replaced `pickHandlers`, and the
       `nav.go('pick')` then nulled the LIVE handler — a zombie screen with dead buttons.
       One-at-a-time guard.
    Plus the honesty fixes the feature's own rules demanded: pure `plan.pruneConfirmText`
    names the rows the parent could NOT see (`hidden`), says when the folder will empty and
    vanish from the child's home, and states the way back as **not guaranteed** (re-adding
    means remove-then-add, whose orphan sweep takes the channel's remaining records; the
    backfill re-arms only when no other library subscribes; a keyless install only sees the
    RSS window). The borrowed `view-pick` chrome is retargeted (🧺, "להשאיר הכול") instead of
    heading a deletion screen with a green ✅.
  - ⚠️ **`posSec` IS A WEAK BELT, and the reason is worth knowing**: a video watched to the
    END clears its position (`resumeSaveDecision` → 'clear'), so the most-rewatched video —
    the one the rationale is about — carries no signal at all. Only ABANDONED videos are
    belted. The app has no play counter; the parent's ticks are the protection.
  - Verified end-to-end in the browser through the real PIN gate: 60 live + window 20 → 40
    proposed → two ticked → confirm CANCELLED leaves 60 records, 0 marks and live buttons →
    confirmed leaves exactly 22 (20 newest + 2 marked), 38 `window-prune` tombstones, and
    the notice disappears. The wipe path verified to honour an earlier mark (28 of 30).
    20 unit tests + 11 wiring invariants, every guard proven red on a planted regression.
- v1.0.38 — **THE GOOGLE-SHEETS SOURCES LIST IS GONE** (user request). Full record:
  **[docs/V1038.md](docs/V1038.md)** — read it before touching `sunset`, `linksfile` or
  `libraryId`. The short version, because each line is an invariant elsewhere in this file:
  - The sheet was a SECOND SOURCE OF TRUTH (read every sync, DELETED what vanished from it,
    written back through a durable queue) — the root of fixes in v1.0.10/12/18/19/20/26/32/34.
    The sources were always in the database; removing it added **0 bytes** to the Drive doc.
    Doc COMPACTION (614→175 B/record) was deliberately left out: it is a one-way format
    change, and bundling it would make a sync regression impossible to attribute.
  - **The links file** ([linksfile.js](www/js/linksfile.js)) is the bulk door and the way a
    library moves between devices/accounts. It reuses the OLD SHEET'S ROW GRAMMAR as text, so
    there is no new parser and no second safety boundary (`parseCsv` → `parseSourceRows` →
    `classifySourceRow`) and a CSV pasted from an old spreadsheet still imports. Export writes
    CANONICAL links only — never a video's stored `srcUrl`, which can carry `&list=` and read
    back as a PLAYLIST — and only records no subscription reproduces (514 records → 4 lines,
    measured). Import has TWO doors (picker + paste; Android TV has no picker at all) and does
    NOT route through `addClassifiedRow`: that is one dialog per channel and one forced sync
    per video. Delivery is write-then-share (`EXTERNAL` is permission-free; the new native
    `shareFile` exists because `shareText` cannot attach a file).
  - **THE MIGRATION IS DELETABLE AND A DATED TEST SAYS WHEN** ([sunset.js](www/js/sunset.js),
    ⏳ **delete after 2026-09-10**; `test/sunset.test.mjs` fails on that date and carries the
    checklist). It runs between the pull and the sync in `entryRefresh` — NOT in `dataver`,
    which blocks boot behind a faded splash and means "run once" where this needs three
    attempts across launches. Its two irrecoverable-loss guards: a channel with a v1.0.36
    tombstone is NEVER re-subscribed by the final read (a sheet row has no timestamp and
    `putLibraryChannel` stamps a fresh one that would beat it), and `interpretSheetResponse`
    keeps every refusal because a wrong `[]` now forgets the sheet and then PERMANENTLY
    deletes a file full of rows. Exactly one `files.delete`, on a FILE id — the folder is
    never touched, because under `drive.file` we cannot prove it is empty.
  - Two latent bugs the removal exposed and fixed: the orphan sweep never ran for a sheet-less
    profile, and `profileSources` carried no entry without a `sheetUrl` (a restored migrated
    family would have landed on an empty home over a full database).
- v1.0.37 — **"הערוץ נוסף אבל אין בו סרטונים" WAS NEVER ABOUT THE CHANNEL** (@BARDAK613,
  the FIFTH report of this sentence; v1.0.28/29/31/32 each fixed a real resolution bug and
  none of them was this). **RESOLUTION IS FINE** — measured live on the reported channel:
  `channels.list?forHandle` → the right id, the DESKTOP scrape (`externalId`) → the right
  id, the MOBILE scrape (the RSS `href`, v1.0.32) → the right id, UULF → 97 long-form
  videos, RSS → 13. The zero came from `planMutations`, and it came out SILENT:
  - **THE CAPS WERE DEAD CONSTANTS.** `config.js` has exported `MAX_ITEMS_PER_CHANNEL` /
    `MAX_ITEMS_TOTAL` since the overhaul with **ZERO consumers** (proven by a sweep, now a
    test). The binding values were the literals `500`/`5000` written into each profile's
    `sources` row the day it was created — six copies across app.js, drive.js, share.js,
    sync2.js, migrate.js — so editing config.js changed nothing, no parent could raise the
    ceiling, and a library at 5000 dropped **every candidate of every new channel, forever**
    (measured: 98 real candidates in, `capped: 98`, 0 puts). A parent with 16 channels is
    plausibly there, which is why it "kept coming back and was never solved".
  - `plan.effectiveCaps(src)` is now the ONE source: **config is the FLOOR**, which is what
    heals the rows already frozen at 5000 without a migration; a stored value wins only when
    HIGHER (shrinking a family's library from a stale row is the same silent loss).
    `MAX_ITEMS_TOTAL` 5000 → **12000, on a measurement** (browser, real records:
    `loadMergeIndex` 114ms @5000 / 229ms @10000 / 468ms @20000, paid once per
    write-generation thanks to the v1.0.20 buildFolders cache; paging stayed FLAT at
    2.8→7.2ms because it is index-ranged).
  - **A DROP IS NOW ATTRIBUTED, AND A ZERO NAMES ITS OWN CAUSE.** `counts.capped`/`denied`
    were computed since the overhaul and thrown away by every caller, so "the library is
    full", "these videos were removed before" and "this channel genuinely has none"
    produced the IDENTICAL sentence. `planMutations` returns `drops.byChannel`,
    `syncLibrary` returns it, `importChannelAndAsk` passes it to `diagnoseEmptyChannel`,
    and `channelAddOutcome` names the ceiling (with the count and the way out) or the
    tombstones. A **PARTIAL** cap is reported too — "12 ממתינים" out of 98 is the same lie
    in miniature.
  - **ATTRIBUTION COUNTS UNIQUE KEYS, NOT DROP EVENTS**: one run offers the same video via
    the RSS window, the UULF backfill AND the playlists pass, so the first version told the
    parent "250 מהסרטונים שלו הוסרו" about a 98-video channel (measured). Attribution is
    keyed by BOTH `channelId` and the folder's source id — a playlist video keeps its OWNER
    in `channelId` (v1.0.26), so matching on channelId alone finds ZERO for a playlist,
    the exact shape of the pendingKeysOfChannel bug.
  - **A REMOVED BACKLOG HAS A WAY BACK** (`app.offerDeniedRestore`). A deny tombstone is
    revoked by exactly one thing — the SHEET re-adding the key (v1.0.10) — and a channel
    video has no sheet row, so one in-place delete or the 30-day purge of a rejected record
    (v1.0.26) made that channel unimportable FOREVER, on every device. It is never revoked
    automatically (a parent who removed three bad videos must not get them back for
    re-subscribing — the v1.0.23 rule): the parent is ASKED, with the count, while standing
    right there, which is the same explicit act the sheet re-add stands in for.
  - **LESSON, now a test**: a constant with no consumer is a lie. Both `MAX_ITEMS_*` are
    pinned to having a live importer, and the cap path is pinned against reading
    `src.maxItems*` again. 7 behavior tests + 4 wiring invariants; every guard proven red on
    a planted regression (the unique-key guard's first plant did not even apply — caught by
    re-checking, the vacuous-guard trap).
- v1.0.36 — **A DELETED CHANNEL FINALLY STAYS DELETED** (field report: "אני מסיר ערוץ
  והוא חוזר אחרי זמן מה", multi-device account). `libraryChannels` deletion was pure row
  ABSENCE — no tombstone anywhere — and every Drive merge is a UNION, so any peer (or any
  stale doc, including this device's own inside the 60s push-debounce window) silently
  re-subscribed the family to the channel the parent threw out. The exact disease
  `deletedProfiles` and the video deny-list already cured; channels never got the
  treatment.
  - **`deletedChannels` tombstones** ({channelId: deletedAt}, meta key `chDel:<lib>`),
    written INSIDE `db.deleteLibraryChannel` BEFORE the row delete (a crash in between
    must keep the intent). LATEST deletion wins the map merge (`drive.mergeDeletedChannels`
    — deliberately unlike profiles' min-merge: a channel CAN be re-added and deleted
    again). A row outlives the tombstone only when its own `updatedAt` is STRICTLY newer
    (`channelOutlivesTombstone`): a deliberate re-add (sheet row / in-app add / snapshot
    import / moveScope re-attach — all stamp fresh) wins; a TIE deletes (resurrection is
    the betrayal, re-hiding a re-add is a complaint — the resolveCuration rule).
  - The tombstones ride each library in the Drive doc (additive — an older app ignores
    them, and a doc WITHOUT the key filters nothing), `mergeDbFiles` filters the union
    against them, and `applyRemoteDoc` routes libraryChannels through pure
    `planChannelApply`: adopt the merged map FIRST, delete local losers WITHOUT
    restamping (the preserveTimestamp lesson — apply-side passes `tombstone:false`),
    and refuse to put a stale doc's rows. The pull path (`pullDrive`) applies the RAW
    remote doc, so the apply-side filter is load-bearing, not belt-and-braces.
  - `moveScope` passes `tombstone:false` (a move is not a parental deletion) and its
    re-put deliberately stamps fresh so re-attaching a sheet outranks old tombstones;
    `purgeProfile` deletes the `chDel:` meta key with the other per-library bookkeeping.
  - The sheet layer is unchanged: the queued-delete guard (v1.0.10) still blocks
    re-subscribe while the row-removal op is in flight, and a row STILL PRESENT in the
    sheet legitimately re-adds (presence is truth) — with a fresh stamp that beats the
    tombstone by design.
  - 8 behavior tests in gdrive.test.mjs (both merge orders, re-add, tie, older-app docs,
    idempotence, apply plan, serialization) + 2 wiring invariants, every guard proven
    red on a planted regression.
- v1.0.36 — **THE KIOSK PIN NEVER RELEASES MID-SESSION, AND THE UPDATER RUNS UNDER IT**
  (two field reports, same root: `stopLockTask()` raises the DEVICE keyguard on many
  devices — "lock device when unpinning" is a system setting the app can neither read
  nor change).
  - `applyExitLock` (profile activation, and now the resume re-arm) only ever PINS.
    Switching from a locked child to an unlocked sibling used to lock the whole TABLET
    mid-switch; now the session stays pinned and the unlocked profile keeps the exit
    button as its way out — containment errs STRICT, never loose, and unlocked→locked
    still pins immediately. The release points are exactly: `askExit`, the settings
    toggle, and the native installer.
  - Native `lockTask`/`unlockTask` are GATED on `getLockTaskModeState` (one
    `inLockTask()` gate): a redundant unpin keyguards the tablet; a redundant re-pin
    re-runs the pinning ceremony on some OEMs. `isTaskLocked` reads the same gate.
  - `installApk` unpins DEFENSIVELY on the SAME UI-thread hop that starts the installer
    — Android silently refuses new tasks over lock-task mode, so with the kiosk ON the
    update button did nothing. A cancelled install resumes into the `onAppResume`
    re-arm (safe on every resume precisely because `applyExitLock` never unpins).
  - Both java copies (android/ + native-reference/) carry the change; `invariants.test.mjs`
    pins all four halves, each proven red on a planted regression.
- v1.0.34 — **A SHEET-LESS PROFILE GOT ITS DOOR BACK** (user request: the sources tab
  showed a DEAD copy-link button over "אין רשימת מקורות"). When the active profile has no
  sheet, `#remote-copy` is replaced by `#remote-connect` (exactly one of the two, pure
  `plan.sourcesPanelActions`) which opens **the SAME wizard as profile creation**
  (`openSheetSetup(p, { fromParent: true })`) — create a new list / join a sibling's /
  **pick from the app-created lists found in Drive** (`sheetwrite.listAppSheets`, new).
  Invariants guard pins the routing, proven against a hand-rolled-putSources plant.
  - **PASTING AN EXTERNAL SHEET STAYED OUT, deliberately** (user decision 2026-08-07,
    after the v1.0.19 wall was explained): under `drive.file` a hand-made sheet cannot
    even be READ, and re-adding the `spreadsheets` scope brings Google's unverified-app
    scare screen back for every family. The Drive picker covers the honest cases —
    reinstall / second device of the same account — which the join-by-profile buttons
    cannot see.
  - **A FAILED LISTING IS NEVER AN EMPTY ONE** (`sheetwrite.interpretFileList`, the
    interpretSheetResponse/interpretDriveList doctrine): pretending emptiness would push
    a parent into creating a DUPLICATE family list. `ok:false` with a token shows "לא
    הצלחנו לבדוק"; `no-token` stays silent — the listing runs as SILENT enrichment when
    the wizard opens, and a family that skipped the Google connect must not get an
    uninvited sign-in dialog. A stale answer may not paint into a wizard that moved on
    (the logoTarget lesson), and dedupe is by `util.canonicalSheetKey`, never the raw
    URL — the same file joined via two URL forms must land in ONE `lib:` scope.
  - **FROM THE SOURCES TAB THE WIZARD IS PUSHED, NOT RESET, AND SKIPS ITS OWN PIN**
    (`wizardGated`): the parent crossed the real gate seconds ago, and a second code
    reads as broken. Back/skip return to the PARENT SCREEN (`onBack` returns false → nav
    pops; activating the profile there would kick the parent to the child's home for
    changing nothing); a successful connect still runs `finishSheetSetup` →
    `activateProfile` (the adoption sync needs its loading screen). At profile creation
    everything behaves exactly as before (reset + PIN).
- v1.0.34 — **THE SCREEN GOES DARK WHEN NOBODY IS THERE** (user request: a child falls
  asleep mid-video and the panel burns all night). After `screenOffAfterMin` minutes
  (per-profile, SYNCED; **default ON at 10** — an explicit 0 = never, the old behavior;
  ⚠️ the default changes every existing install and MUST ride the release notes) with no
  touch/remote key WHILE A VIDEO PLAYS: the "עדיין צופים? 👀" overlay shows for
  `SCREEN_OFF_PROMPT_SEC` (45s); unanswered → save position, pause IN PLACE (the v1.0.32
  order: save FIRST, never `stop()`), and keep-awake follows the pause down by itself
  (wake.js holds it only while playing). **The DEVICE's own display timeout is what turns
  the screen off** — an app cannot do that (device-admin is the wrong tool for a kids
  player) nor change the system timeout (WRITE_SETTINGS), so a tablet set to "never
  sleep" stays lit and the settings hint says so honestly.
  - Pure decisions, unit-pinned: `plan.screenOffMinutes` — never-written ⇒ DEFAULT
    (`Number(null) === 0` is the trap: the unset check must precede coercion or the
    default silently reads as "off"), explicit 0 ⇒ off, nonsense ⇒ default (the
    planRejectedPurge rule); `plan.evalIdleSleep` → 'off'|'counting'|'prompt'|'sleep',
    where `playing:false` is 'off' BY DESIGN — wake is not held while paused/outside the
    player, the OS already owns those, so "count only while playing" is the whole feature.
  - **THE ANSWERING TAP/KEY IS CONSUMED** (`onUserInput` stops propagation only while the
    prompt is up): on TV, OK would otherwise toggle pause and ←/→ would seek ±10s — "I'm
    here" must never scrub the video. Input = window-CAPTURE `pointerdown`+`keydown`, so
    no handler's stopPropagation can starve the timer; the prompt itself needs no handler
    of its own (any input anywhere answers it — the button is an affordance).
  - The overlay lives INSIDE `#player-wrap`, above the tap-shield (the autoplay-next
    rule: that is the element that goes fullscreen). Same behavior on TV (user decision
    2026-08-07): the pause lets the TV's own screensaver/sleep take over. A profile
    switch stamps fresh input so a sibling never inherits idle time. The invariants
    guard was proven against five planted regressions (order swap, dropped save,
    `stop()`, dropped keydown listener, overlay outside the wrap).
- v1.0.33 — **THE ADD TAB SEARCHES YOUTUBE** (user request: type like on youtube.com,
  see YouTube's own results, preview, add). The mechanism is the KEYLESS youtubei
  endpoint — `search.list` stayed banned (100 units on the shared key ≈ 80 searches/day
  for ALL families combined) — verified live incl. the Dalvik UA, so the v1.0.32
  mobile-page trap does not apply (an API, not a redirecting page). Invariants, all
  guard-pinned and proven against planted regressions:
  - **The youtubei literal lives in [ytsearch.js](www/js/ytsearch.js) ONLY** (one-module
    blast radius for an undocumented endpoint), it never sees a key (`key=`, a
    `getApiKey()` call and a keys import all fail the suite), and its imports are
    ⊆ {platform, util}. The `/search?` URL-literal guard now exempts exactly that
    module and, inside it, allows exactly the two sanctioned endpoints — the
    suggestions URL (`/complete/search?`) trips the same regex, so an exemption
    written only for youtubei leaves the suite red.
  - **Shorts and RD-mixes are filtered IN THE PURE PARSER** (the user's decision: no
    Shorts anywhere): reel shelves dropped wholesale, a videoRenderer with the SHORTS
    overlay or a /shorts/ navigation dropped, `RD…` lockup playlists dropped. Planted
    fixtures pin each (the forbidden item sits between two survivors). Unknown signal
    = include, per the standing rule.
  - **The officialCard is HEADER-ANCHORED**: Cocomelon-class channels appear in mixed
    results only as `officialCardViewModel`, whose `contents` subtree carries FOREIGN
    related-channel ids (measured) — identity is read from the header alone and only
    when every UC id there agrees; an ambiguous card is skipped (the ערוצים chip still
    finds the real channelRenderer). The @RabbiRosenblum decoy class, pre-empted.
  - **A CHANNEL/PLAYLIST RESULT OPENS FOR BROWSING** (user request, same release):
    tapping its thumbnail OR its name swaps the list area for the source's own videos —
    a channel shows its VIDEOS TAB only (`youtubei/v1/browse` + the tab's own protobuf
    params; Shorts have a separate tab, so this is by construction what a subscription
    would import), a playlist shows its contents (`VL`-prefixed browseId). The header
    carries back / avatar / name / one ➕ for adding the whole source; every video row
    behaves exactly like a search result (bubble preview, single-add, ✓ precompute).
    Back (button AND hardware back, before goGallery — gated on the add panel being
    visible) restores the search results untouched; a new search closes the browse.
    ONE state map serves both lists (a ✓ earned inside the browse must show on the
    results row and vice versa — a video key is global). Browse continuations ride
    `onResponseReceivedActions` (search uses ...Commands; the reader takes both), and
    **an unparsable CONTINUATION is END-OF-LIST, never the 'parse' alarm** — measured:
    a playlist delivered whole on page one still carries a token whose continuation
    answers nothing but trackingParams; only a FIRST page may raise 'parse'. The
    one-module invariant widened from `youtubei/v1/search` to ANY `youtubei/` literal.
  - **Adding routes through the SAME pipeline as pasting**: results are normalized to
    canonical URLs and re-classified (`classifySourceRow` — classifyLink stays THE
    boundary; a kind mismatch is refused), then `addClassifiedRow` — the helper
    extracted from `parentAdd`, one path for both callers (the v1.0.25 lesson).
    share.js deliberately NOT unified (pending-first is a different curation policy).
    A search add carries the result's title so the record needs no oEmbed fetch.
  - **The preview bubble gained mode `'search'`**: `#pv-add` adds-and-advances via
    `previewDecide` (added AND already-exists count as decided); `pv-delete` is hidden
    there too — the old `toggle('hidden', pending)` would have shown a live 🗑️ over an
    item with no stored record. The bubble gets COPIES (previewDecide splices); row
    state syncs back by key, never index.
  - **Two monotonic seq counters** (search vs suggestions — one counter would let a
    keystroke's suggest fetch invalidate an in-flight search); a late response never
    paints a newer query's list (the logoTarget lesson). Continuation additionally
    re-checks query+filter, and appends dedupe by `type:id`.
  - **`oe=utf-8` on the suggestions URL is LOAD-BEARING**: without it a Hebrew query
    is answered in windows-1255 (measured live — the dropdown rendered ����).
    Suggestion taps bind on **pointerdown** (click loses the race against the input's
    blur); Escape closes only the dropdown (stopPropagation — browser Escape doubles
    as hardware-back).
  - **Messages are the feature** (v1.0.27 rule), pinned distinct in `searchMessage`:
    'network' (try again; the shown results stay) vs 'parse' (= "YouTube changed
    something", the update-the-app alarm — `parseSearchResponse` answers null only
    when NO top-level shape is recognized; recognized-but-empty is `{items:[]}`).
  - **"✓ קיים" is precomputed against BOTH scopes** (lib + prof) before render — the
    row must agree with what the add would answer, and `addClassifiedRow` dedupes
    against both.
  - Transport: `platform.httpPostJson` — body stringified + explicit Content-Type at
    the seam (the CapacitorHttp silent-body-drop trap); browser dev rides `/__proxy`,
    which now forwards POST (1MB cap, Content-Type only, never cookies/auth — dev
    server only, same SSRF guard). No public-CORS-proxy POST rung on purpose.
  - The guide gained 2 slides at the end of 'דרך 2 · במסך ההורים' — the deck is now
    EXACTLY at the 20-slide test cap; the next slide must raise the cap deliberately.
  - **THE REVIEW PASS IS PART OF THE RELEASE** ([docs/V1033.md](docs/V1033.md) §4 has
    the full list; every fix is pinned). The rules it minted:
    - **The parsers are TOTAL** — innertube's array→keyed-object churn answers
      "unrecognized", never a throw. A throw used to read as 'network' ("בדקו את
      החיבור" over working Wi-Fi) and the shape-changed alarm never fired; a totality
      test feeds truthy-malformed docs to both parsers. A 200-with-HTML interstitial
      is 'network' on BOTH transports (device and browser used to disagree).
    - **Browse teardown has ONE path** (`closeYtsBrowse`) — a hand-rolled two-line
      teardown in ytsSearch left the old browse rows rendered and tappable while the
      fetch ran (and forever when it failed), so a thumbnail tap previewed the WRONG
      video via `activeYtsItems()`'s fallback. The HIGH finding of the pass.
    - **`previewDecide` is re-entrancy-latched**: the `previewCtx !== ctx` check
      cannot catch a double-tap because splice MUTATES the shared object — the second
      splice removed the NEXT video, which the parent never saw.
    - **The bubble's button matrix is pure** (`playerlogic.previewBubbleButtons`,
      per-mode node tests, unknown mode = nothing destructive); renderPreview's
      delegation is guard-pinned.
    - **Hiding the suggest dropdown invalidates its in-flight fetch** (seq bump inside
      `ytsHideSuggest`), suggestion taps bind pointerdown AND click (a TV remote's OK
      produces no pointerdown), and blur skips the hide when focus moved INTO the
      dropdown. Hardware back closes dropdown → browse → screen, in that order,
      guard-pinned with the panel-add visibility gate.
    - **`resetYtsUi()` on profile activation** — the search area is per profile; the
      previous child's "✓ קיים" marks were computed against the other child's scopes
      (the buildFolders profile-identity rule, applied here).
    - **One `libraryHasVideo` helper** for the row precompute AND addClassifiedRow's
      dedupe (the row must agree with what the add answers), and one transient
      `'adding'` state (⏳) latches the same source across surfaces — the browse-head ➕
      and the result row could run two concurrent imports.
    - `addClassifiedRow` has EXACTLY two callers (parentAdd + ytsAdd, the
      importChannelAndAsk-style pin); ytsAdd's kind-mismatch refusal is pinned by its
      FULL conditional shape — the bare-substring version stayed green under a
      `false &&` plant, caught by its own red-check.
    - Playlist ids are validated (`PLAYLIST_ID`) like every other id class; the
      youtubei endpoint constants are NOT exported (an import plus a hand-appended
      key parameter would have tripped no guard); dead `searchMessage` stages deleted
      — the add outcome speaks in `addClassifiedRow`'s voice only.
- v1.0.32 — **CHANNEL LOGOS ARE CACHED AS BYTES AND RETRY ON EVERY HOME ENTRY** (user
  request: the folder picture must always load). The avatar used to be re-fetched from
  the network on EVERY render (`<img src=url>`) — flaky Wi-Fi or a rebrand (old URL
  404s) showed 📺 despite the app having had the picture moments earlier. Now the bytes
  are stored ONCE in the thumbs store (`logo:<channelId>`, ~30KB, `srcUrl` in the meta)
  and render from the device — offline included; pure `plan.planLogoCache` decides:
  cached bytes ALWAYS render and the render NEVER waits for the network (a new URL only
  refreshes in the background; a dead/absent URL keeps the picture — stored BYTES beat
  the v1.0.24 lesson's stored-URL). `platform.httpGetBlob` fetches (native base64 →
  Blob; browser: direct → /__proxy → CORS proxies). A folder still missing its bytes
  retries on each render/home entry, deduped only while a fetch is in flight.
  **THE SERVE HALF NEVER DEDUPES — only the network half does.** The first version
  deduped the whole resolver: a render arriving mid-fetch got nothing and the fetch then
  painted a DETACHED img (the home re-renders several times during boot alone) —
  measured as 📺 tiles sitting on top of a full byte cache. `logoTarget` tracks the
  LATEST mounted img per channel; delivery re-mounts into the host when onerror already
  swapped the emoji in. Used logos get `touchThumbs` so the LRU eviction never takes
  them. The parent's channel list heals through the same cache.
  Hardening pass (self-review, all three pinned pure):
  - **A late fetch may NOT paint into a host that moved on** (`planLogoDelivery`):
    `#folder-logo-top` is ONE element shared by every folder view, and channel A's slow
    fetch used to plant A's logo into folder B's header. The host carries
    `dataset.logoChannel`; a mismatch skips.
  - **Warm memory paints FIRST** (`logoFirstPaint`): the unconditional `img.src = url`
    hit the network on every render even with a full cache. Verified: zero ggpht
    requests across a whole re-rendering session.
  - **The refreshed logo's OLD objectURL is never revoked**: a background view's img may
    still display it, and revoking fires a spurious `noteLogoFailure`. One leaked URL
    per rebrand is nothing.
- v1.0.32 — **THE PROFILE PICKER HAS AN EXIT BUTTON** (user request): same `.exit-btn`
  as the home's, same `askExit` flow hardware-back there always ran — confirm, then a
  free exit, **or the parent code first when the kiosk lock is armed** (user's decision:
  always visible, never a silent hole). The lock check reads
  `activeProfileId || prefGet('activeProfile')` — on a boot picker no profile is active
  yet but the kiosk was armed from the LAST ACTIVE one (the launch rule), and reading
  only the live global would have walked straight through an armed lock (the cold-start
  share picker is the real case: stored profile + lock + picker shown).
- v1.0.32 — **THE MOBILE CHANNEL PAGE FINALLY RESOLVES — @BARDAK613, THIRD RECURRENCE,
  ROOT CAUSE AT LAST.** A request carrying a MOBILE user-agent (the tablet WebView, or
  the native HTTP layer's Dalvik default) is REDIRECTED to m.youtube.com, whose page has
  NO `externalId` and NO canonical-channel link while carrying FIVE decoy `"channelId"`
  occurrences (measured live) — so the anchored extractor correctly refused, fell back to
  the poisoned cache, and returned the decoy. **Every earlier fix (v1.0.29–31) verified
  in a DESKTOP browser, which gets the www page — that is why they kept passing
  verification and failing on the device.** The mobile page names its identity in its own
  anchored shapes: the RSS alternate link (`feeds/videos.xml?channel_id=UC…`) and the
  og:url/twitter:url metas pointing at `/channel/UC…` — both now matched, BEFORE the
  decoy-prone legacy key. Verified live across the full UA matrix (none/Dalvik/okhttp/
  mobile-Chrome) and generalized on @rotemama4kids + @RabbiRosenblum mobile pages.
  A device already carrying the bad subscription self-heals: the sheet row keeps the
  @handle and re-resolves on every sync, so once resolution answers the real id the real
  channel subscribes and imports by itself. **LESSON: any scrape-parsing fix must be
  probed against the MOBILE page variant, not just the browser's desktop one.**
- v1.0.32 — **BACKUP AND LIST MANAGEMENT LEFT THE UI; THE MACHINERY IS UNTOUCHED** (user
  request: backup is automatic — never let the user run it by hand).
  - Settings: the status line and "גיבוי עכשיו" are GONE. The `#drive-block` shows ONLY
    while backup is OFF (the enable path for a family that skipped the first-launch
    connect — hiding it for them too would leave no door, ever); once enabled the whole
    block disappears. The automatic pull (entry/resume) + push (every mutation) are
    exactly as before.
  - Sources: create / join / disconnect are GONE — list management is not a parent-facing
    concept any more. **The profile-creation wizard is the ONE remaining place a sheet is
    attached** (`connectWizardSheet` → `adoptLibraryScope`); `connectSheetUrl` was removed
    with its last callers — anything re-attaching a sheet from the sources tab must route
    through that same migration if it ever returns. The copy-link button stays (how a
    parent opens/shares the sheet), the refresh stays, and BOTH safety surfaces stay: the
    mirror safety-valve alert and the sheetwrite queue/dropped warnings.
  - A sheet-less profile keeps working (`lib:p:<id>`); the panel and the copy button now
    SAY that instead of pointing at buttons that no longer exist.
- v1.0.32 — **THE ADD FORM LOST ITS NAME/IMAGE FIELDS** (user request): the `אפשרויות`
  details (add-title/add-thumb) is gone — never re-add it. The name and picture come
  from the content itself: YouTube titles/thumbnails were already fetched when the field
  was left empty (now always); a direct FILE has no metadata, so its display name derives
  from the filename in the link — pure `classify.titleFromFileUrl` (percent-DECODED, so
  Hebrew filenames work; extension stripped; `_-+` opened into spaces; '' for anything
  unusable — no caption beats a caption of garbage) — and its thumbnail from the captured
  first frame (`persistThumb`, unchanged since v1.0.5).
- v1.0.32 — **THE ABOUT TAB LOST THREE BUTTONS** (user request): מדיניות פרטיות, תנאי
  שימוש, מה חדש בגירסה. The policies LIVE ON THE SITE as sticky nav tabs (all three
  docs/ pages carry the same `.site-tabs` bar) — **the privacy/terms URLs must stay
  ALIVE: Google OAuth verification points at them** (`LINKS.site.privacy/terms` remain
  in links.js as the record even though the app no longer opens them; the 🌐 site button
  is the in-app path). What's-new shows in the ONE place that matters — the update
  prompt before an install; `update.notesForInstalledVersion` + the `update.notesAll`
  store went with the button (dead code).
- v1.0.32 — **THE SOURCES TAB: subscriptions fold away; an undecided channel surfaces as
  "ערוצים חדשים" for 24h.** The channel list is a CLOSED `<details>` like the library list
  (v1.0.28), sorted newest-first by `addedAt` (every creation path already stamped it;
  a pre-v1.0.21 row without one is never "new" and sorts to the END — surprising an old
  subscription into the new section would read as a bug). Membership and order are pure
  `plan.planChannelSections` (undecided + |now−addedAt| < `NEW_CHANNEL_WINDOW_MS`; the
  absolute delta lets a peer clock minutes ahead still read as new without letting a
  broken clock pin a row there for a year).
  - **`decidedAt` is the new field**: stamped by the three-way dialog's REAL answers
    (אישור הכל, and a SAVED manual pick — backing out of the picker is "אחר כך" and
    stamps nothing), by the auto-approve toggle in either direction, and at creation for
    a sheet row carrying an explicit auto/manual flag. It rides the libraryChannels
    record, so a decision made on any device travels. "אחר כך" is deliberately NOT a
    decision; 24h drains the row into the regular list by itself, so the section cannot
    silt up.
  - A fresh row trades the auto-approve toggle for one real `<button>` (TV remote needs
    one) that raises the SAME three-way dialog the add flow uses. A fresh channel whose
    queue is EMPTY (Shorts-only, or auto-approved meanwhile) treats the tap itself as
    the review — a row that does nothing on tap reads as broken — with a toast saying so.
  - Browser-verified end-to-end behind the real PIN gate: planted fresh row renders in
    the section, the folded list shows "ערוצים (N)" closed, the tap stamps `decidedAt`,
    hides the section and moves the row.
- v1.0.32 — **THE SCREEN-OFF BUTTON FINALLY PAUSES THE VIDEO** (field report: pressing
  the tablet's physical power button darkened the screen but the soundtrack kept
  playing — kiosk lock on or off alike). Android does NOT pause the WebView, and the app
  listened only to `onAppResume`; `platform.onAppPause` (appStateChange `isActive:false`,
  visibilitychange-hidden in the browser) is the missing half. The handler does exactly
  two things IN ORDER: `saveWatchPosition(currentWatch)` (reads the live playhead —
  pausing first would be fine, but a torn-down player would not) then
  `player.pauseCurrent()` — **pause IN PLACE, never `stop()`**: stop() destroys the
  player and coming back to a black hole is the "הסרטון נעלם" the user reported. When the
  screen returns the video waits, PAUSED, at its spot (the HUD heartbeat pins itself on
  the pause); the child taps play. The power button itself was never blocked — keep-awake
  only prevents the idle timeout. An invariants guard pins listener + both halves + order
  + no-stop(), proven against three planted regressions (including a commented-out call —
  the first guard version passed on that, the exact vacuous-guard trap).
- v1.0.32 — **RESUME PLAYBACK: a stopped video reopens where it stopped** (per-profile
  setting, OFF by default — a family that never opens the settings screen keeps today's
  start-from-zero exactly). The SETTING syncs (`resume`, safe-on-tie false); **THE
  POSITION IS DEVICE-LOCAL**: it changes every few seconds of watching, so
  `drive.serializeStateEntry` (pure, tested) never emits `posSec`/`durSec`/`posAt`, and
  the apply side folds through pure `mergeAppliedState`, which PRESERVES the local
  position and MIN-MERGES `unwrappedAt` — the old blind put erased the local record
  wholesale on every pull (and let a later remote unwrap beat an earlier local one).
  - The decisions are pure (`playerlogic.resumeStartAt` / `resumeSaveDecision` /
    `watchedFraction`): resume lands `RESUME_REWIND_SEC` (3s) before the stop point; a
    stop inside `RESUME_TAIL_SEC` (12s) of the end CLEARS the position (or every video
    "sticks" seconds before its end forever); below `RESUME_MIN_POS_SEC` (8s) nothing is
    saved and clearing is refused — a 2-second accidental tap must not erase progress; an
    unknown duration never saves (a wrong resume point is worse than none).
  - Saved every `RESUME_SAVE_MS` while playing (survives a process kill), plus in watch's
    `onLeave` (BEFORE `stop()` — the teardown takes the clock with it) and at the top of
    `openWatch` for the video→video path (`playItem` reuses the player, same reason).
    A video that ENDS clears its position in `onVideoFinished`.
  - The tile's red progress bar (`.tile-progress`, inside `.thumb`) is gated on the
    SETTING, not just the data — a stale position from an earlier ON period must not
    draw; a wrapped gift never shows one. `giftStates` mirrors every write so the next
    render needs no extra IDB read. **The folder view re-renders on BACK-restores**
    (`nav.register('folder')` gained onEnter, like the home view always had) or the tile
    the child just left keeps its stale bar.
  - `player.playbackState()` lends app.js the live clock (null after teardown, never a
    stale player's numbers); `opts.startAt` is the app's resume decision — a URL's t=
    hint still never chooses where a video starts (classifyLink keeps stripping it).
  - Verified in the browser end-to-end: save at 64s → bar at 44.4% → reopen at 61s →
    seek to the tail → ended → position cleared, bar gone, `unwrappedAt` intact.
- v1.0.32 — **THE HUD SHOWS ELAPSED / TOTAL TIME** (user request: like the YouTube app).
  `playerlogic.formatTime` is pure + tested: floored seconds (a second that has not
  finished must not show), `h:mm:ss` above an hour, and `0:00` for NaN/Infinity/negative —
  `getDuration()` answers 0 before metadata and Infinity for a live stream, and none of
  those may leak onto the child's screen. The labels live INSIDE the `.player-hud`
  container so they inherit its `pointer-events:none` ALWAYS (the HUD-bar invariant) and
  fade with the HUD. The `.seek-row` is `dir="ltr"` like the timeline itself — elapsed by
  the bar's start, total by its end. Text writes are guarded by value: `renderProgress`
  runs 4×/s and identical textContent writes still invalidate layout on cheap tablets.
- v1.0.31 — **A COLD-START SPLASH + A SCHEDULED PER-PROFILE LOCK.**
  - **SPLASH** (`#splash-overlay`): a FIXED overlay above the nav (not a view — a view would
    vanish the moment `nav.reset` runs behind it), shown for ~1.3s while the app boots, then
    faded. Cold-start-only is automatic: `init()` runs once per process; resume never
    re-enters. Inline emoji + CSS animation, self-contained.
  - **SCHEDULED LOCK** ("time to do something else"): after `lockAfterMin` minutes of a
    session the app locks for `lockDurationMin`, shows the child a calm sleeping-tablet
    screen with a live countdown, then returns to normal and re-arms on the next video.
    - **SETTINGS SYNC, LIVE TIMER IS DEVICE-LOCAL** (`schedlock:<pid>:armed`/`:until` in
      Preferences). A lock is about THIS device's session — syncing "locked until X" would
      lock a sibling's device on one account. `drive.js` must never carry these keys; a test
      pins it. Same split as PIN recovery.
    - The timer **ACCUMULATES** (armed by the first video, runs continuously, never resets on
      a later video — the user's decision; resetting would let continuous play defeat it) and
      counts wall-clock while the app is open. Pure `plan.evalScheduledLock` decides; a
      nonsense window falls back to the default (`scheduledLockDurationMs`, the
      `planRejectedPurge` rule — a 0 duration would unlock instantly).
    - **IT SURVIVES A RESTART** (persisted `:until`, checked on boot + resume + profile
      switch) so a child cannot bypass it by force-closing. The locked view swallows
      hardware-back.
    - **THE EXIT BUTTON IS GATED ON THE KIOSK LOCK**: shown only when the exit-lock is OFF
      (closing the app is then a legitimate escape); with the kiosk ON the child is fully
      contained. A discreet `פתיחה להורים` tap → parent code → unlock early (and re-arm).
      Both pinned by an invariants test.
    - lockAfter 0 = OFF (the default), so a family that never opens this setting sees nothing.
- v1.0.29 — **LAUNCH RESUMES THE LAST-USED PROFILE, PER DEVICE** (pure
  `plan.planBootProfile`). The stored id was ALREADY device-local (`prefGet('activeProfile')`
  — Preferences never sync; one account, several devices, a different child on each); the
  boot flow just never used it. Three fallbacks to the picker, each load-bearing: nothing
  stored; the stored profile no longer exists (deleted, possibly via a peer's tombstone);
  and a QUEUED COLD-START SHARE — the boot picker IS that share's routing question
  (v1.0.23, `alreadyRouted`), so auto-resuming would route a share nobody addressed.
  Combined with v1.0.28's chip gate, the model is now: the device belongs to its child;
  entering ANY other profile costs the parent code.
- v1.0.29 — **A POISONED HANDLE CACHE COULD NOT HEAL WITHOUT THE SHARED KEY**, and a
  DECOY `"channelId"` beat the real id (@BARDAK613, field — "הערוץ נוסף אבל אין בו
  סרטונים" on a channel full of videos). Two layers on top of the v1.0.28 fix:
  - v1.0.28 healed a poisoned `handleMap` entry only when the API succeeded, and the
    built-in key's quota is SHARED by every family — one exhausted afternoon left
    `channelId` null and the old order then returned the poisoned cache WITHOUT trying the
    scrape. `resolveChannelRef` now scrapes BEFORE the cache on any KEYED resolve (the add
    paths): API → live scrape → cache-as-last-resort. Healing is now independent of the
    shared key's quota. Keyless enrichment (`resolveChannelRef(ref, '')`, per-video) still
    hits the cache first — it must not scrape N times, and a stale id there only affects
    grouping. Browser-proven: a poisoned entry heals with BOTH a working and a broken key.
  - @BARDAK613's page carries a real `"channelId":"UC…"` — but it is a DECOY (the real id
    is in `externalId`). `extractChannelIdFromHtml` already tries `externalId` first, so
    the anchored order was already correct; a test now pins the decoy case explicitly.
- v1.0.31 — **A KEYLESS RELEASE COULD NOT HEAL A POISONED HANDLE CACHE** (@BARDAK613,
  reported STILL failing on v1.0.30 which already had the v1.0.29 heal). The v1.0.29 fix
  keyed the cache-first shortcut on `!key` — but `keys.local.js` is GITIGNORED, so a
  release built without it ships NO API key, and then the ADD path (`resolveChannelRef(ref,
  getApiKey())`) passes `''` too, hits the keyless cache-first shortcut, and returns the
  poisoned decoy forever. The scrape (which heals) was never reached. Now the shortcut is
  gated on an explicit `cacheFirst` OPT-IN that ONLY the per-video enrichment caller passes;
  every ADD/SHEET path resolves LIVE regardless of the key, so healing is key-independent.
  A test pins that exactly ONE caller opts into `cacheFirst`. The channel resolves and
  imports (98 via API, ~13 via keyless RSS) — verified; a device already carrying the bad
  SUBSCRIPTION still needs a delete + re-add, which now resolves correctly.
- v1.0.28 — **A HANDLE COULD RESOLVE TO A STRANGER'S CHANNEL, AND THE MISTAKE WAS
  PERMANENT** (@RabbiRosenblum, field). Current channel pages no longer carry
  `"channelId":"UC…"` at all, so the keyless scrape fell to its loose second pattern —
  the FIRST `channel/UC…` anywhere in ~1.2MB of HTML — and a decoy UC id appears BEFORE
  the real one (measured live). The wrong id was cached FOREVER (`handleMap` was consulted
  before the API), so the subscription stayed empty — "הערוץ נוסף, אבל אין בו סרטונים" —
  on every later attempt. The trigger is the BUILT-IN key's quota running out: it is
  shared by every family, so one heavy afternoon pushes resolves onto the scrape.
  - Pure `yt.extractChannelIdFromHtml`: ANCHORED shapes only (`externalId`, the canonical
    link, legacy `channelId`) and NO bare-UC fallback — an occasionally failed resolve
    beats an occasionally WRONG one; for this app a wrong channel is a safety hole.
  - **THE API NOW OUTRANKS THE CACHE** when a key is available, refreshing `handleMap` on
    every keyed resolve — which also HEALS devices already carrying a poisoned entry (the
    user's own tablet). Tests pin the order (API before the cache return) and the decoy
    case, both proven by planted regressions.
- v1.0.29 — **TV AUDIT: the grouped library's sections were focusable-but-INVISIBLE.**
  A full D-pad sweep of every surface added since v1.0.26 (verified in `tv=1` mode): all
  new controls are real `button`/`summary`/focusable, and the grouped-library `<details>`
  are fully reachable (each group summary opens on Enter). ONE real gap: `html.tv …:focus`
  ring covered `button`/`input`/`[tabindex]` but NOT `summary` or `[href]` — a native
  summary's `tabIndex` is a PROPERTY, not an attribute, so `[tabindex]` never matched it.
  On TV the remote could focus a library section or the privacy link with NO visible ring.
  Fixed in the ring rule; `invariants.test.mjs` now pins that both are covered. (The two
  whole-row `<li>` click handlers are convenience duplicates of a focusable checkbox, so
  they are reachable regardless.)
- v1.0.28 — **THE SIMPLIFICATION PASS** (parent's request: a user who knows no technical
  terms). Five changes, one chain:
  - **The YouTube-API-key form is GONE from the UI.** The target user cannot mint a Google
    Cloud key, so the form only frightened. A key saved in the PAST keeps working —
    `yt.getApiKey` still reads the stored `yt:apiKey` override first. Never re-add the form;
    developers have GOOGLE_CLOUD_SETUP.md.
  - **The parent's library list folds away** (`#library-box` + `plan.groupLibraryByFolder`,
    pure + tested): one closed line, inside it one `<details>` per folder the CHILD sees,
    all closed by default. Grouping is by HOME folder; unsubscribed leftovers group under
    their remembered title rather than vanish; the PARENT_LIST_CAP promise became
    per-section. A rebuild keeps whatever sections were open.
  - **Switching profiles MID-SESSION always asks for the code** — the `exitLockOn()`
    conditional is gone (a sibling switch changes whose library/gifts/settings are live;
    that is a parental act). The BOOT picker stays free, same decision. Still fails CLOSED;
    the invariants guard now bans any free-standing `backToProfiles` in `onProfileChip`.
  - **The landing page sells the app, not its permission model** — the scopes section is
    one plain privacy card (privacy/terms links KEPT — OAuth verification points at them),
    plus a new "איך מוסיפים תוכן" section. Functional warnings stay (Android's install
    prompts, Google's "we don't know this app" screen) — preparation, not jargon.
  - **`summary` joined the D-pad focusable selector** — every folded section (the rejected
    archive since v1.0.23, now the whole library list) was UNREACHABLE from a TV remote.
    Enter toggles natively; focus was the entire gap.
- v1.0.27 — **NO STEP OF ADDING A CHANNEL IS SILENT ANY MORE.** Field report: "the add
  takes a while — fine — but between clicks I cannot tell whether it is still working or
  waiting for me." Only the long import ever showed the loading screen; resolve, subscribe,
  the bulk approve, building the manual-pick list, saving the pick, and above all the
  SECOND full sync after the decision all ran behind the ordinary screen.
  - The texts are pure `plan.channelAddWait(stage, {count})` — a waiting screen with no
    explanation is the same ambiguity in a different colour, so the words ARE the feature
    and are test-pinned (never the generic "בטעינה…", the count in the sentence when known,
    and no NaN/0 leaking in). `invariants.test.mjs` pins that every stage `app.js` waits on
    via `withChannelWait` has an entry — a stage added without text fails the suite.
  - `withChannelWait` keeps `defer: 250`, so THE FAST PATH NEVER FLASHES — measured: an
    already-synced channel reaches the dialog in 150ms with zero screens, while the same
    flow with real work shows each step with its own words (and the finishing screen
    streams the sync's real progress labels via `onProgress`).
  - **`refreshAfterAdd` gained `wait: true` for exactly ONE caller** (`importChannelAndAsk`,
    which owns the waiting screen); the default stays silent because the v1.0.18 rule
    still holds everywhere else — covering the child's populated grid is the worse bug.
    BOTH dialog answers route through the same awaited 'finishing' wait: the manual pick
    used to fire its own silent sync, which was the exact gap on that branch.
  - **A blocking wait must not become a TRAP**: the loading view swallows back, so the
    post-decision sync is raced against `waitWithValve` (90s). The valve does not drop the
    screen silently — that would restore the ambiguity — it reports `backgrounded` so the
    caller can say the work continues.
  - **Found while verifying: the manual pick reported a queue the parent had just emptied**
    ("3 סרטונים ממתינים לאישור" after they kept 2 and rejected 1). `channelAddOutcome` now
    takes the pick result and says what was chosen; a missing pick keeps the honest
    "waiting" sentence because that queue is real.
- v1.0.26 — **AN EMPTY QUEUE SAYS SO** (`#pending-empty`, `.list-empty`). ממתינים rendered a
  blank area when nothing was waiting, which is indistinguishable from a list that has not
  loaded or a screen that is broken — and since v1.0.24 the BLUE attention dot deliberately
  sends the parent to exactly this tab, so "I followed the dot and found nothing" was the
  common case, not the rare one. The line is driven by `grandTotal`, the count that already
  spans BOTH scopes, so it can never disagree with the list beside it.
- v1.0.26 — **A PROFILE NAME MAY BE 20 CHARACTERS, AND THE LIMIT IS NOW REAL.** It was 12,
  and it lived ONLY as `maxlength` on `#create-name` — an attribute no test can see, which
  binds exactly one caller and which **does not bind that one either**: assigning `.value`
  from script sails straight past it (measured). So the cap now lives next to the write, in
  pure `store.normalizeProfileName` (trim, collapse whitespace, cap, fall back to 'ילד/ה'),
  and `invariants.test.mjs` pins the attribute to `store.PROFILE_NAME_MAX` so the two cannot
  drift — raise one alone and either long names reach storage unbounded or the parent cannot
  type what the tile is sized for.
  - **THE CAP SLICES BY CODE POINT.** "נועם 🦁" is a plausible name and a `.slice(0, 20)`
    cuts the surrogate pair in half, storing a replacement character forever. The test that
    pins this is also a lesson in writing the assertion right: the first version checked
    `/[\uD800-\uDFFF]$/`, which fires on the CORRECT result too — a kept 🦁 legitimately ends
    in its low half. It must look for an UNPAIRED surrogate.
  - **THE TILE IS THE ONLY PLACE A NAME IS DRAWN AT FULL LENGTH**, and it had no width bound
    at all, so a long name just widened its flex item and the picker went ragged. `9em`
    (=180px here) holds the widest possible 20 characters in exactly two lines — measured in
    the browser against an all-'מ' worst case, not guessed. `overflow-wrap: anywhere` is
    load-bearing (a 20-char name with no spaces is one unbreakable word); the 2-line clamp
    is INSURANCE for a longer name arriving from a peer, not the normal path. Everywhere
    else was already safe: `.chip-name` has been ellipsised at 90px all along (it truncated
    12-char names too), and the per-profile settings labels wrap — verified at 375px.
- v1.0.26 — **A FORGOTTEN PARENT CODE HAD NO WAY BACK, AND v1.0.25 IS WHAT CLOSED IT.**
  Until then the answer was "reinstall the app". Then the PIN hash moved into the synced
  settings channel and rides the Drive document, so a family WITH backup reinstalls,
  reconnects, and gets the forgotten code handed straight back on the first pull — the
  families who did the right thing were the ones with no door. [recovery.js](www/js/recovery.js)
  is the door: request → **24-hour wait** (`PIN_RECOVERY_DELAY_HOURS`) → choose a new code.
  - **THE WAIT IS THE UNIVERSAL PATH, ON PURPOSE.** It needs no device lock (a child's
    tablet often has none and Android TV never does), no permission, no network, and
    nothing the parent must have kept. It is the FLOOR, never an alternative.
  - **THE DEVICE CREDENTIAL IS THE FAST PATH ON TOP OF IT** (`KidsNative.canDeviceAuth` /
    `deviceAuth`, `androidx.biometric` — a fingerprint or the device's own lock code, which
    is the only identity claim this app can honestly check offline). Pure
    `plan.planRecoveryRoute` decides between them, and the ORDER is the rule:
    **an existing request always outranks the fast path.** A wait already running is state
    the parent deliberately created — possibly on a day the sensor would not cooperate —
    so a capable device must not hide it behind a prompt they may fail again, nor discard
    it silently.
  - **BOTH DIRECTIONS OF NATIVE FAILURE ARE CLOSED, and a test pins each.** Treating an
    absent/throwing bridge as SUCCESS would open the parent screen to anyone in the browser
    and on every APK built before the method existed, so both wrappers compare `=== true`;
    letting it THROW would blow up `onPinForgot` before it can offer the wait, turning a
    missing sensor into a permanent lockout, so both swallow. A FAILED prompt (cancelled,
    locked out, or unopenable) falls through to the wait — `BIOMETRIC_WEAK`, not STRONG,
    for the same reason: this gates a UI screen, not a crypto key.
  - **THE BANNER IS THE SAFEGUARD, NOT THE DELAY.** A wait nobody is told about just means
    the child waits a day and walks in, so the notice lives on the CHILD'S HOME — the
    screen that is on all day — and is shown for `ready` as well as `waiting` (going quiet
    right before the door opens would make the countdown a trap). `invariants.test.mjs`
    pins that `renderHome` still draws it; every `planPinRecovery` unit test passes without.
  - **CANCELLING IS FREE, DELIBERATELY.** A parent who did not request the reset cannot
    prove who they are — that is the exact situation the feature exists for — and a child
    cancelling only restores the status quo. For the same reason `requestRecovery` NEVER
    restamps a live request: re-tapping must not push the deadline away, or a child who
    found the button could keep the parent locked out for good.
  - **THE REQUEST IS DEVICE-LOCAL AND A TEST PINS IT.** The PIN hash syncs (that is why
    this exists); a *pending reset* must not, or one device starts everyone's clock and a
    peer's stale copy re-arms a cancelled request. `pinRecoveryAt` may appear in exactly
    one module.
  - **IT IS NOT A SECURITY BOUNDARY AND THE DOCS SAY SO**: moving the system clock forward
    skips the wait. Unavoidable without a server, and a different threat from the
    5-year-old this app has always defended against.
  - The affordance shows on EVERY `'verify'`-mode code screen — the parent-screen gate,
    the exit-lock gate, the profile-switch gate (parent's decision 2026-08-02) — and it is
    DELIBERATELY SMALL AND LOW-CONTRAST (12px, 0.55 opacity, tucked into the card's
    bottom corner): a reading child will find any text eventually, which is exactly why
    the SAFEGUARD is the 24-hour wait plus the home-screen banner, never this link's
    obscurity. Never in SETUP mode (there is no code to have forgotten, and offering a
    reset there would be a second way to pick the first PIN), and
    the reset uses `startPin('setup', { replace: true })` so hardware-back cannot land on
    the verify screen it just satisfied. `planPinRecovery` follows the `planRejectedPurge`
    rule — **a nonsense window falls back to the default, never to a short one** — which
    here means a typo cannot hand the parent screen to the child the same afternoon.
- v1.0.27 — **THE STANDALONE-PLAYLIST FEATURE SHIPPED WITH A DATA-DESTROYING LOOP, AND
  THREE MORE HOLES.** All review-caught, all demonstrated against the running code; the
  v1.0.26 entry below describes the design — this entry is what it missed.
  - **THE MIRROR'S ORPHAN GC DELETED EVERY PLAYLIST VIDEO ON EVERY PASS.** The GC's
    one-line predicate compared `rec.channelId` against subscriptions — but a playlist
    subscription carries `PL…` while its videos deliberately keep their OWNER (`UC…`), so
    every foreign-owner playlist video read as an orphan: imported, raw-deleted (NO
    tombstone), re-imported pending, with every approval and every REJECTION undone in a
    30-minute loop. The decision is now pure `plan.planOrphanGC`: membership is judged by
    the FOLDER too (`pl:<id>` of a subscribed playlist; parked records by `homeFolderId`),
    a record with no channelId is never touched, and deleting the playlist still orphans
    its videos for real. `invariants.test.mjs` pins that `applySheetMirror` delegates and
    that the inline predicate cannot come back.
  - **A PLAYLIST COULD NOT BE DELETED.** Its sheet row classifies as `kind:'playlist'`,
    which `matchRowsForDeletion` did not know — the delete matched nothing, `clearFlushed`
    dropped the op anyway, and the still-present row re-subscribed it on the next sync,
    while the confirm promised removal "מקובץ המקורות". AND the add/delete never
    reconciled: the append travels as `pl:<id>` but `opIdentity` stamped `ch:<id>`
    unconditionally, so the flush re-appended the row it had just deleted. `delchannel`
    ops now carry `kind`, both identity and row-matching are kind-aware, and
    `planSheetMirror` protects `pl:<id>` pending appends like `ch:<id>` ones (without
    that, a playlist added on a READ-ONLY joined sheet was unsubscribed by the very next
    mirror pass, permanently — the append can never land there).
  - **SHARING A PLAYLIST COULD NEVER SUCCEED.** `handleShareInteractive` branched only on
    `kind === 'channel'`, so a playlist fell into the video branch: PIN → "להוסיף את
    הסרטון?" → הוספה → and `handleSourceShare`, which accepts only the source decision,
    answered "ההוספה בוטלה". The parent CONFIRMED and was told it was cancelled. A
    playlist now gets the source branch with its own feminine wording, and `onShareAdded`
    finally reads the `isPlaylist` flag share.js has passed since v1.0.26.
  - **THE STANDALONE STAGE PUSHED PAGE ITEMS UNFILTERED** — unlike the channel-playlists
    stage, nothing rejected entries with a missing `videoOwnerChannelId`, which is what
    private/deleted videos look like (untappable "Private video" tiles). It now runs
    `acceptPlaylistItem(v, {})`: no owner check (foreign videos are the point) and no
    shortIds (no UUSH sibling exists), but malformed ids and ownerless entries are out.
- v1.0.26 — **A SHARE FROM YOUTUBE COULD FAIL IN SEVEN WAYS AND SAY NOTHING.** Reported
  from the field as "sharing does not add the video, the parent screen does". The native
  side was never at fault (intent-filter, `onNewIntent` for cold+warm, matching field
  names, retained event) and neither was the classifier — verified against the real
  YouTube-app payloads including the `?si=` parameter. `handleShare` simply had **seven
  silent `return`s and no success message either**, so added / parked-for-approval /
  duplicate / previously-deleted / cancelled / unsupported all looked identical: nothing.
  - **EVERY ROUTE NOW ENDS IN A REASON** (`routeShare` returns one, `handleShare` reports
    it) and pure `plan.shareOutcome` turns it into text. `ui/toast.js` is the app's first
    non-blocking feedback channel — it must never block, never need dismissing, and never
    fight the PIN screen or a confirm that is already up. `invariants.test.mjs` pins that
    routeShare contains **no bare `return;`** and that every reason it can answer has a
    message. That guard's first version anchored to the start of a line and so could not
    fail on `if (!c) return;` — the exact shape it exists to catch.
  - **THREE REAL DROPS, all in the channel path**: a `null` decision (which
    `handleShareInteractive` returns for a channel whenever the PIN screen or a modal is
    already up — easy to hit on a share into a running app); a profile with no `sources`
    record, which returned instead of creating one the way the parent screen always has;
    and a failed reference resolve that reported `channelFailed` to a handler that showed
    nothing.
  - **A SHARED PLAYLIST WORKS TOO.** `classifySourceRow` understood playlists since
    v1.0.12 but `classifyShared` never did, so sharing one answered "unsupported" while
    pasting the identical link worked. A watch link merely CARRYING `&list=` must stay a
    video — otherwise sharing one video imports hundreds.
  - **THE PROFILE QUESTION IS ASKED WHENEVER THERE IS A CHOICE** (parent's decision
    2026-08-02). v1.0.23 also skipped it when several profiles followed one sheet — same
    library row either way — but a parent reported not knowing where a shared video went,
    and "it does not matter" is only true of the DATA. One profile still skips.
    `plan.shouldAskShareProfile` is deleted, not left dangling.
- v1.0.26 — **THE REJECTED ARCHIVE EMPTIES ITSELF AFTER 30 DAYS** (`REJECTED_TTL_DAYS`).
  v1.0.23 made a rejection PARKED rather than deleted so the parent can pull it back — but
  that means the archive only grows, and a channel re-offers its whole catalogue every 30
  minutes, so it grows fast. After the window the record is purged for real: delete + deny
  tombstone, exactly what "מחק לצמיתות" does, which is also what stops the video returning
  on the next sync.
  - **IT IS IRREVERSIBLE, SO IT IS STATED.** For a video inside a channel there is no way
    back at all — only a SHEET re-add revokes a tombstone, and a channel video has no row.
    The archive therefore carries the rule up front AND a per-row countdown
    (`parentRow`'s `note`); pure `plan.planRejectedPurge` returns both the expired keys and
    the days left, so the sweep and the label can never disagree about the deadline.
  - **A RECORD WITH NO `rejectedAt` IS NEVER AUTO-PURGED** — rows written before this
    existed, or arriving from a peer on an older app. Showing an old video costs nothing;
    deleting one the parent still wants cannot be undone.
  - **A NONSENSE WINDOW FALLS BACK TO THE DEFAULT, never to a short one.** The first
    version used `Math.max(1, Number(days) || 30)`, so a negative value clamped to a
    ONE-DAY window and a config typo would have emptied the whole archive on the next
    sync. Caught by its own test.
  - The sweep lives in `doSync`, not in the parent screen: it has to happen whether or not
    anyone opens that screen, and ONE place means the deadline cannot drift. It covers
    BOTH scopes (a rejection can be parked in the shared library or the personal one) and
    is wrapped in try/catch — housekeeping must never take the sync down with it.
- v1.0.26 — **THE PARENT CAN WATCH A VIDEO WITHOUT LEAVING THE QUEUE** (preview bubble).
  Tapping a row's THUMBNAIL in ממתינים or in הוספה opens a floating player over the parent
  screen. It is an OVERLAY, never a view: the scroll position, the open tab and the ticked
  rows all survive, because triaging a queue means coming straight back to the list.
  - **IT IS NOT THE KID PLAYER, DELIBERATELY.** `setupHud` binds window/document listeners
    and must never run twice without a teardown, and the kid HUD hides the timeline and
    turns a centre tap into play/pause — exactly backwards for a parent jumping through a
    video to judge it. The bubble builds a plain iframe from pure
    `playerlogic.previewEmbedUrl`: `controls=1` (YouTube's real scrub bar), `mute=1`
    (a child is usually in the room, and browsers block unmuted autoplay anyway — parent's
    decision), `rel=0`. A direct file gets a `<video controls>`. All three params are
    silent when wrong, so they are test-pinned.
  - `closePreview` empties the host: tearing the iframe out is what actually STOPS
    playback, and the parent view's `onLeave` calls it so no player survives the screen.
    Hardware back closes the BUBBLE first (`nav.register('parent')`), or the parent is
    thrown out of the screen they were triaging in.
  - **A DECISION ADVANCES TO THE NEXT ITEM** rather than closing (parent's decision):
    thirty videos must not cost thirty open/close cycles. `previewDecide` treats a handler
    returning `false` as "nothing happened" — a cancelled delete confirm must not skip the
    video the parent is still looking at.
  - **`refreshPendingList` NOW KEEPS THE TICKS.** It used to clear the whole selection on
    every rebuild, which would have silently undone twenty ticks each time the parent
    decided one video — the exact opposite of "the screen behind stays as it was". The old
    reason (a tick could point at a row that is gone) is answered by filtering the carried
    ids against the REBUILT list. Doing it by parameter first was wrong and the browser
    proved it: `refreshAfterAdd` rebuilds the list a beat later and cleared them back.
  - `parentRow` gained `onPreview` on the thumbnail, so BOTH lists got this from one
    change; the thumbnail is excluded from the row's selection toggle for the same reason
    ✅ and 🗑️ are. "פתח ביוטיוב" is offered unconditionally — an embedding-disabled video
    is a black box with no cheap way to detect it, and is exactly what a parent most wants
    to inspect.
- v1.0.26 — **A PLAYLIST IS A SOURCE.** Reported from the field, repeatedly, as "the link
  is not supported". The classifier was never at fault: `classifySourceRow` has answered
  `{kind:'playlist', playlistId}` since v1.0.12, for `m.youtube.com` and `www` alike. The
  app then threw it away — `parentAdd` handled only 'video' and 'channel', and
  `parseSourceRows` pushed playlist rows into `invalid` as `'playlist-unsupported-yet'`.
  **A missing feature wearing the costume of a parse error**, which is why it kept
  recurring: the message listed what IS supported instead of naming what was not.
  - **STORED AS A SUBSCRIPTION IN THE SAME TABLE** — a `libraryChannels` row with
    `kind:'playlist'` and the playlist id in the `channelId` slot. No schema change, no
    `DB_VERSION` bump, and it inherits Drive sync, deletion, the parent's channel list and
    the auto-approve flag for free. `doSync` splits `allSubs` so every CHANNEL stage
    (channels.list, the logo scrape, RSS, the UULF backfill) keeps seeing only real
    channels; `quota.js` already guards those id derivations with `/^UC/`, so the split is
    belt and braces rather than the only defence.
  - **THE UNIFY RULE** (parent's decision, 2026-08-02): pure `plan.playlistVideoFolder`.
    A playlist video whose owner channel is ALSO subscribed lands in `ch:<owner>`, not
    `pl:<id>`. Duplicate RECORDS were never the risk — `planMutations` keys on
    `yt:<videoId>` — the FOLDER was: `folderId` is in `DIFF_FIELDS`, so two passes that
    disagreed would rewrite the record every sync and break the churn-free invariant. It
    is also order-free: add the playlist first and subscribe later, and the next sync
    moves those videos by itself. A playlist whose videos ALL went to channel folders has
    count 0 and shows no tile — exactly right, it would have been an empty duplicate.
  - Unlike a channel's own playlists tab (v1.0.21), **FOREIGN VIDEOS ARE THE POINT** here,
    so they are kept; and Shorts cannot be told apart (no UUSH sibling exists for an
    arbitrary playlist), so they are INCLUDED per the standing "an unknown signal means
    include" rule.
  - **`pendingKeysOfChannel` MATCHES THE PARKED HOME FOLDER TOO.** A playlist video keeps
    its OWNER in `channelId` (the title-dedupe index and the unify rule both need that),
    so matching on `channelId` alone found ZERO for a playlist and the approval dialog
    never appeared — the exact shape of the v1.0.22 bug, on the new path. Caught in the
    browser: all 30 videos had imported correctly and the dialog still said nothing.
  - The outcome sentence is gender-correct: ערוץ is masculine, רשימה feminine
    (`channelAddOutcome`'s `isPlaylist`), and `diagnoseEmptyChannel` reports it on EVERY
    path — returning `{}` on the common one made a successful playlist import announce
    itself as "הערוץ נוסף".
- v1.0.25 — **DELETING A PROFILE NOW DELETES IT, AND IT STAYS DELETED.** The confirm has
  always said "כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה" while
  `deleteCurrentProfile` removed only the row in the Preferences profile list —
  **`db.purgeProfile` had ZERO CALLERS.** Measured 2026-08-02: a throwaway profile with one
  channel kept all 500 videos, its subscription and its sources record. Two halves:
  - **WHAT MAY BE ERASED IS A DECISION** (pure `plan.planProfilePurge`). `prof:<id>` is
    always the profile's own; the LIBRARY scope only when no sibling still reads it —
    `lib:<fnv1a(sheet)>` is SHARED and erasing it would take a sibling's whole library,
    the same question `planScopeAdoption` asks before a move. A sheet-less profile owns
    `lib:p:<id>` outright, and THAT is where nearly all its content lives, which is why
    the old "personal scope only" purge was effectively a no-op. `purgeProfile` also drops
    the library's `libraryChannels` rows and its per-library `meta` keys — **deleted, not
    `putMeta(k, null)`**, which leaves the row in place.
  - **A DELETION MUST SURVIVE THE NEXT PULL.** Both merge paths union profiles by id and
    nothing filtered them, so a delete lasted exactly until another device's document
    arrived. `store` now keeps a GROW-ONLY tombstone map (`profilesDeleted`), travels it in
    the Drive doc (`deletedProfiles`, additive), filters it in `mergeProfileLists`, and
    `applyRemoteDoc` adopts a peer's tombstones AND purges anything an earlier pull already
    restored. Grow-only is safe here where the video deny-list needed revocation: a profile
    id is minted randomly and never reused, so "the sheet re-added it" cannot arise.
- **Release records: [docs/V1045.md](docs/V1045.md), [docs/V1038.md](docs/V1038.md), [docs/V1033.md](docs/V1033.md), [docs/V1032.md](docs/V1032.md),
  [docs/V1026.md](docs/V1026.md), [docs/V1025.md](docs/V1025.md)** — what changed in each
  and why, including which features ALREADY EXISTED and were broken. The per-feature
  invariants stay below; those files are the map.
- **[docs/TESTING.md](docs/TESTING.md) — read before trusting a green run.** What the suite
  covers, what it structurally CANNOT see (no DOM, no IndexedDB, no network), the four bugs
  that shipped past it, and the device checklist for everything a browser cannot prove
  (share intents, the kiosk lock, cross-device convergence).
- v1.0.25 — **CONTINUOUS PLAY: at the end of a video the next one starts, without leaving
  the player.** OFF by default, PER PROFILE, and synced (it rides the v1.0.25 settings
  channel) — "one more video" is a parenting decision, not a device preference, and one
  account can hold a 3-year-old and a 7-year-old. A family that never opens the settings
  screen keeps v1.0.16 behaviour exactly: a video that ends calls `leaveWatch()`.
  The decision is pure `playerlogic.planAutoplay` → `'next' | 'retry' | 'stop'`:
  - **`onExit` NOW CARRIES A REASON** (`'ended' | 'error'`). `finish()` fires for an
    embedding-disabled video too, so without it a chain skips silently through every
    broken video in the library and the failure ceiling can never trigger. Note the
    `<video>` element's `'ended'` listener MUST be wrapped — the DOM hands a listener an
    Event, which would arrive as the reason.
  - **A CHAIN CAN ALWAYS END.** One retry of the same video absorbs a blip
    (`AUTOPLAY_RETRY_MS`), then it is skipped, and `AUTOPLAY_MAX_FAILURES` (5) consecutive
    failures stop the chain — a run of unplayable videos must never flip through black
    screens forever. `failures` counts CONSECUTIVE failures; a video that plays resets it.
  - **NEITHER 🎁 FOLDER NOR 🎁 VIDEO IS EVER CHAINED.** The `'new'` folder is refused
    outright — but gift state lives per child ON THE VIDEO, so wrapped tiles appear inside
    channel folders too, and the chain stops when the NEXT video is still wrapped
    (`nextIsGift`, from `giftStates`: `giftRank && !unwrappedAt`, the same predicate
    `tileEl` renders by). Found in the browser, not by reasoning: the first tap on a gift
    unwraps it and deliberately does NOT play, so a chain that called `openWatch` would
    skip the ritual AND leave the tile wrapped forever with its video already watched.
  - **`nextAfter` IS A THIRD MEMBER OF THE PAGINATION FAMILY** and lives beside
    `pageAnyFolder` for the reason that rule exists — "next" must be the tile that FOLLOWS
    ON SCREEN, so it has to know the same folder kinds (`new`/`grp:`/`sheet`/`ch:`+absorbed).
    The invariants test now pins that both cover the same set; a kind added to one and not
    the other means the chain silently disagrees with the grid. It uses `db.pageFolder`'s
    KEYSET mode — which had no caller until now — because loading a 2000-record folder to
    find one index at the end of every video is not acceptable on a low-end tablet.
  - The countdown overlay lives INSIDE `#player-wrap` (the element that goes fullscreen;
    anything outside it is invisible while playing) and sits ABOVE `.tap-shield`, which
    otherwise swallows every tap. It is the child's ONLY visible way out of a chain: 🏠 is
    outside the player by design (v1.0.2) and Android's back needs an edge swipe in
    immersive mode. Opening any video cancels a pending countdown, and leaving the watch
    view resets the whole chain — a queued video must never follow the child out.
- v1.0.25 — **SETTINGS TRAVEL NOW, THROUGH ONE CHANNEL** ([settings.js](www/js/settings.js)).
  Until this, exactly ONE setting-like value crossed between a family's devices —
  `libraryChannels.autoApprove`, and only because it rides a record that carries a
  timestamp. Everything a parent could actually change was device-local, so a PIN set on
  the phone left the tablet on its old code. Shape:
  `{ account: { <name>:{v,at} }, profiles: { <pid>: { <name>:{v,at} } } }`, stored in
  **Preferences, not IndexedDB** — these are preferences, pin.js needs them before any DB
  work, and it keeps the whole channel node-testable behind the existing localStorage stub.
  `at` is stamped INSIDE `putSetting`, never at the call sites (the v1.0.22
  `putLibraryChannel` lesson). Merge is per key: later write wins, and an exact tie takes
  the SAFE direction (`exitLock`/`shareApproval` → true, `autoplay` → false; the PIN hash
  has no safe direction so it orders by value — still commutative). Tests pin
  `merge(A,B) === merge(B,A)` **and** idempotence; a doc from an older app carries no
  `settings` key and must never read as "the family cleared everything".
  **`getSetting`'s fallback cannot answer "was this ever written?"** — passing `undefined`
  triggers the `fallback = null` default. pin.js reads the ENTRY via `getAllSettings`.
  That exact mistake shipped in this branch and every unit test stayed green, because they
  all call `setPin` first and so never took the migration branch; the browser caught it.
  - **THE PIN MIGRATES, the other settings do not** (parent's decision 2026-08-02 was
    "start fresh", but that question named exitLock and shareApproval). An existing hash is
    lifted out of Preferences on first read, then the legacy key is dropped — channel
    first, so no failure leaves the PIN nowhere. Resetting it would leave every installed
    app with NO gate for one launch, and `startPin`'s SETUP flow lets whoever arrives first
    pick the new code — on a child's tablet, the child. `clearPin` writes an explicit `''`
    rather than deleting the entry, or the next read would lift the old hash straight back.
  - **EXIT LOCK AND SHARE-APPROVAL ARE PER PROFILE** and both toggles name their child in
    the UI (`labelProfileSettings`). ⚠️ Existing values do NOT carry over — a family with
    the kiosk on finds it off after the update. Must appear in the release notes.
  - **A PER-PROFILE LOCK OPENS A HOLE, closed in the same release.** (v1.0.28 supersedes
    the conditional: the chip now gates EVERY mid-session switch, locked or not — the
    parent's decision — and the boot picker stays free. The fail-closed rule is unchanged.) The lock contains
    HOME/recents/back and hides the exit button, but the profile chip went straight to
    `backToProfiles` — so a child on a locked profile could tap their avatar, pick a
    sibling who is NOT locked, and walk out. Two taps. `onProfileChip` now PIN-gates
    leaving a locked profile; the chip stays visible because it is also how the child sees
    whose library they are in. It **fails CLOSED**: a throw leaves the child where they are,
    because falling back to `backToProfiles` would make the lock escapable by whatever
    threw. The launch arming reads the LAST ACTIVE profile (`prefGet('activeProfile')`) —
    it runs before a profile is picked, and without that there is an unlocked window from
    launch until someone taps a tile. **`activateProfile` re-applies it on every profile
    switch** (`applyExitLock` — pin/unpin plus the exit button). Both directions were wrong
    without that, and one is a real escape: arriving at a LOCKED profile from an unlocked
    one left the device unpinned with the exit button on screen, so the child the lock
    exists for could simply walk out.
- v1.0.25 — **ENTERING THE HOME PULLS, THEN SYNCS — AND THAT IS FINALLY TRUE ON LAUNCH.**
  v1.0.22 declared the two SERIALIZED because both write the same video records, and
  `pullThenSync` did serialize them — but it was never the only pipeline.
  `activateProfile` calls `nav.reset('gallery')`, which fires the gallery's `onEnter`
  **synchronously**, so `homeEntryRefresh` had already started the forced launch sync by
  the time the very next line reached `pullThenSync`. The pull then ran against a library
  the sync was actively rewriting — on every launch, on every device with backup enabled.
  There is now ONE pipeline (`entryRefresh`) with ONE caller (the gallery's `onEnter`) and
  one promise; `activateProfile` awaits that promise purely to own its loading screen
  (`awaitEntryRefresh`), and `pullThenSync` is gone. Because the pull now sits on the home
  entry rather than on activation, it also runs on every LATER return to the home (still
  throttled 60s) — which is what "sync against the database on every entry" actually means.
  The gates are pure `plan.planEntryRefresh` → `{ pull, forceSync }`: the first entry of a
  launch bypasses BOTH throttles, because opening the app is not the same act as a child
  flipping between the home and a video. The invariants test pins the ORDER inside
  `entryRefresh` (pull before sync, and `await`ed — an un-awaited pull IS the race) and
  that `maybePullDrive` keeps at most two call sites, entry and resume.
- v1.0.25 — **BOTH WAYS TO ADD A CHANNEL NOW IMPORT IT AND THEN ASK.** v1.0.22 gave the
  parent screen the "what should I do with this catalogue?" question and CLAUDE.md recorded
  that it covered "parent screen + share". **The share path never had it.**
  `share.handleChannelShare` subscribed the channel, fired a sync it did NOT await, and
  immediately announced "הערוץ נוסף! ✅ … חדשים ימתינו לאישור" — an outcome reported before
  there was one, over a back catalogue that then sat in ממתינים unannounced. That is the
  v1.0.22 bug, still live on the other half of the feature. Both callers now go through
  `app.importChannelAndAsk` (loading screen → awaited forced sync → `loading.hide()` →
  dialog), and a test pins that it has EXACTLY two callers and that share.js no longer syncs
  behind `onAdded` — sharing the path is what stops the two from drifting again.
  The three answers are **אישור הכל / אישור ידני / אחר כך** (relabelled from
  אישור אוטומטי / בחירה ידנית; the parent's decision 2026-08-02 kept the third button —
  without it the only way out is the scrim or hardware back, neither discoverable).
  אישור הכל is what ticks the ✅ in the parent's channel list: `refreshChannelsList`
  renders `cb.checked = !!lc.autoApprove`, so the flag IS the checkbox.
  **The channel-approval paths resolve the library scope instead of reading the bare
  `libScope` global** (`currentLibScope`, the same fallback `pendingTotal` already used).
  That global is published by `buildFolders`, i.e. only after a home render — and a share
  can now reach `offerChannelApproval` / `pickChannelVideos` on a cold start, where a null
  scope reads as "this library is empty": no dialog, and a picker with no rows.
  The outcome sentence is pure `plan.channelAddOutcome`, and it NAMES A ZERO too: a
  Shorts-only channel and "nothing arrived" are different facts, the first one permanent
  (Shorts are excluded on purpose). A plain ✅ is left for the single case that earns it —
  nothing new, but the channel does have content the child can see. `diagnoseEmptyChannel`
  does the two IDB reads only when the count is 0, so the common path skips them.
- v1.0.25 — **A FORCED SYNC CHAINS, NEVER JOINS — AND NOW THE CODE ACTUALLY DOES IT.**
  v1.0.21 wrote that sentence in the comment above `syncLibrary` and then shipped
  `if (!opts.force || cur.force) return cur.promise`, which JOINS whenever the RUNNING sync
  is itself forced. The first sync of every launch IS forced (`launchSyncDone`, app.js) and
  takes minutes on a real library — a page fetch per channel logo, up to 40 backfill pages —
  so the collision was ROUTINE, not rare. Everything the parent did inside that window rode
  a run that had already read the library at [sync2.js:266](www/js/sync2.js:266):
  - **adding a channel imported NOTHING.** The run listed the channels before the new one
    existed, finished "successfully", `offerChannelApproval` found 0 pending videos so the
    three-way dialog never appeared, and the parent was told "הערוץ סונכרן ✅" over an empty
    import. Pressing "רענון נתונים" (no run in flight) fixed it — exactly how it was
    reported from the field.
  - **every `refreshAfterAdd` path silently regressed to the v1.0.21 bug**: no
    `srcChannelId` (the video sits in the loose list instead of its channel folder) and no
    `giftRank` (not a 🎁).
  The decision is now pure `plan.planSyncDispatch` → `'start'|'join-running'|'join-queued'|
  'queue'`. **`join-queued` is load-bearing, not an optimisation**: a QUEUED run has read
  nothing yet, so it is guaranteed to observe the caller's write — without it three adds in
  a row would queue three full library sweeps. Measured in the browser 2026-08-02: with the
  old code two overlapping forced calls returned the IDENTICAL promise; with the fix they
  are separate runs, the second starting after the first ends.
  **`onProgress` now fans out to every caller a run serves** (`entry.listeners`). A joined
  caller used to lose its callback entirely — measured: the second caller received zero
  progress events — which is why the add-a-channel loading screen sat frozen on its first
  step for the whole run. A comment cannot fail a test, so `invariants.test.mjs` pins that
  `syncLibrary` delegates to the helper and handles every branch it can return.
  Also: a channel add reporting ZERO now says WHICH zero instead of the reassuring
  "הערוץ סונכרן ✅" that hid this for a release — see `plan.channelAddOutcome` above, which
  is where that decision lives now, so BOTH add paths get it.
- v1.0.24 — **A CHANNEL FOLDER SHOWING 📺 IS A BUG, AND IT HAD TWO INDEPENDENT CAUSES.**
  Reported from the field on @rotemama4kids. NOT the channel and NOT the parser: both
  `yt.fetchChannelMeta` and the keyless `yt.scrapeChannelLogo` return a good avatar for it
  today (verified against the live page), and `extractChannelLogoFromHtml` matches the real
  HTML. The two defects, both now pinned by `plan.planChannelLogo`:
  - **`logoTriedAt` WAS STAMPED FOR AN ATTEMPT THAT NEVER HAPPENED.** The channels.list
    writer stamped it unconditionally — but `fetchChannelMeta` with no key returns empty
    logos WITHOUT making a request, and its error branch does the same. The keyless
    page-scrape fifteen lines below is gated on that field, so the ONLY working fallback was
    suppressed for a WEEK starting on a channel's very first sync — exactly when the parent
    is looking at the new tile. The scrape (the last resort) now owns `logoTriedAt`; the API
    path owns `logoApiTriedAt`; only a real URL stamps `logoFetchedAt`.
  - **A STORED URL THAT WILL NOT LOAD IS WORSE THAN NO URL.** `img.onerror` silently swaps
    in the emoji, and BOTH fetch paths skipped any channel that already had a `logoUrl` — so
    a channel that rebrands (old avatar URL 404s) loses its picture forever. The renderer now
    calls `noteLogoFailure`, and a failure newer than `logoFetchedAt` marks the URL known-bad.
    **The marker lives in `meta` (`db.getLogoFailedAt`/`setLogoFailedAt`), NOT on the channel
    record** — 13 sync call sites read a channel, spend seconds on the network and write the
    whole snapshot back, so a marker on the record is reverted by whichever stage is in
    flight. That is measured, not theoretical: it swallowed the first version of this fix.
    It is per-device by nature anyway. The scrape loop RE-READS the record before writing,
    for the same reason.
  `logoApiTriedAt` being a NEW field is the migration: every channel already on a device
  passes the API gate exactly once after the update, which heals the ones stranded by the
  first defect. Retry budgets differ by cost — API 24h (batched, ~1 unit), scrape 7 days (a
  1.5MB page fetch each). The parent's channel list rendered an EMPTY `<img>` for a
  logo-less channel (not even the 📺); it now shares the same fallback and reporting.
  DECISION (2026-08-01): the `fallbackThumbUrl` stage still requires a LIVE video — a
  thumbnail the parent has not approved must not appear anywhere, so a channel whose whole
  backlog is pending keeps 📺 in the parent's list until the first approval.
  NOT DONE, and deliberately: a candidate chain over the two Google avatar hosts
  (`yt3.ggpht.com` ⇄ `yt3.googleusercontent.com`). It looked necessary because the sandboxed
  preview browser loaded only one of them — but all four host×size forms answer 200 with
  real bytes over the real network, so that was an artifact of the test environment and the
  code would have been speculative complexity justified by a false measurement.
- v1.0.24 — **A DOT THAT MEANS TWO THINGS MEANS NOTHING.** A manual-approval channel already
  parked its new uploads in the queue (`plan.js` `needsApproval`, unchanged) — the failure was
  purely that nobody could TELL. The gate dot lit for `pending > 0 || updateReady` in the same
  red, and the parent screen landed on אודות, so the routine errand (a video the child cannot
  see until someone says yes) was indistinguishable from the rare one and got learned as
  ignorable. Now the dot's COLOUR IS ITS DESTINATION (pure `plan.attentionDot` →
  `'info'|'alert'|null`): **blue** (`.attn-dot-info`, `--brand`) = content waiting, and crossing
  the PIN lands on ממתינים; **red** (the default) = an app update, landing on אודות. A tie goes
  to the content — a child is waiting at the other end of it, and the update keeps its own
  `about-dot` regardless. The `#pending-badge` turned blue to match: a parent who followed a
  blue dot must not arrive at a red count.
  **THE LANDING TAB IS DECIDED BEFORE THE VIEW IS SHOWN.** `enterParent` awaits `pendingTotal()`
  and feeds pure `parentLandingTab(sticky, pending)`; deciding inside `refreshParent` would
  render אודות and visibly jump, because `setParentTab` runs there BEFORE the lists are
  awaited. The override fires on EVERY visit while the queue is non-empty (not once), and an
  empty queue restores the sticky tab so it can never strand a parent who lives in הגדרות.
  Two consequences of awaiting before navigating, both load-bearing: `enterParent` bails
  unless `nav.isActive('pin')` (hardware-back during that yield means the parent changed their
  mind, and replacing whatever is on top would be a real bug), and `pendingTotal` falls back to
  `db.getSources(...).libraryId` when `libScope` is still null — that global is published by
  `buildFolders`, i.e. only after a home render, so asking earlier counted ZERO and reported an
  empty queue that was full. `PARENT_TAB_IDS` moved to plan.js next to the helper that
  validates against it. `refreshPendingList` now ends with `refreshGateDot()`: rejecting the
  last waiting video used to leave the dot lit until something re-rendered the home.
- v1.0.24 — **THE ממתינים QUEUE HAS THE PICKER'S SELECTION, WITH ONE DELIBERATE DIFFERENCE.**
  Per-row `.pick-cb` checkboxes + `#pending-all`/`#pending-none` (סמן הכול / נקה בחירה), whole
  row as the tap target — the same mechanism as `view-pick`. It does NOT reuse `.pick-off`:
  there an unticked row is a video about to be REJECTED so the strike-through is the truth,
  here it is merely outside the current bulk action and dimming half the list would read as
  "already thrown out". Selected rows get `.li-sel` instead. **Nothing is ticked by default**,
  unlike the picker (a freshly added channel is presumed wanted; this queue is a drip being
  triaged, and pre-ticking puts a whole-queue action one tap away under a label that reads
  like a selection). `approve-all`/`reject-all` are SELECTION-AWARE via pure
  `plan.pendingBulkAction`: with nothing ticked they keep their v1.0.4 whole-queue meaning —
  the only way to reach rows past `PARENT_LIST_CAP` — and one tick narrows both and rewrites
  the label, so "דחיית הכול" can never throw out thirty when three are ticked. Selecting all
  200 rendered rows is still a SELECTION, never the 250-row queue. `collectPending` was split
  out of `refreshPendingList` so the handlers can read fresh records WITHOUT re-rendering:
  re-rendering clears the ticks, and cancelling the confirm dialog would then leave the parent
  with nothing selected. The row-click handler skips `e.target.closest('button')` — a tap on
  ✅/🗑️ must never also flip the selection. Selection ids are `scopeId \0 key`: one `yt:<id>`
  can sit in both the shared and the personal scope and `approvePending` takes ONE scope.
- v1.0.23 — **A SHARE FROM ANDROID ASKS WHICH PROFILE, BUT ONLY WHEN THAT CHANGES ANYTHING.**
  `share.handleShare` routed everything to `activeProfileId` with no question. It now consults
  an optional `profileChooser` callback (`app.chooseShareProfile`), gated by pure
  `plan.shouldAskShareProfile(targets)`: **two profiles that follow the same sheet share one
  library scope**, so the video is the same row either way and asking would be noise that
  trains the parent to tap through dialogs. One profile ⇒ never ask. A profile with no
  sources counts as its own destination.
  Choosing also SWITCHES to that profile (decision 2026-08-01), so the picker resolves
  through `activateProfile` and the share's PIN+confirm then runs inside it.
  `renderProfiles({ onPick, title })` is what made this possible — every tile used to
  hard-wire `activateProfile`, so selection and activation were inseparable and nothing could
  ask "which child?". In pick mode the ➕ tile is HIDDEN: creating a profile runs the sheet
  wizard and its own activation, which would abandon the share mid-flight.
  **THE COLD-START PATH DELIBERATELY DOES NOT ASK.** A share arriving with no active profile
  is stashed in Preferences and replayed by `drainShareQueue` — which passes
  `alreadyRouted:true` — because that boot lands on the profile picker anyway and the profile
  the parent taps IS the answer. Asking again would be the same question twice.
  Backing out of the picker writes NOTHING (no stash, no record): `nav.register('profiles')`
  gained an `onLeave`/`onBack` that resolves the chooser with null, so the awaiting share
  cannot hang forever.
- v1.0.23 — **A NEW CHANNEL ASKS THREE QUESTIONS, NOT TWO.** `offerChannelApproval` now
  raises a three-way choice (decision 2026-08-01): **אישור אוטומטי** (everything now and
  every future upload, + the auto-approve flag), **בחירה ידנית** (→ `view-pick`), or
  **אחר כך** (all stay waiting). The third option needed a REAL third modal button
  (`modal-third`, optional `third:` in `ui/modal.js`, `askKid` → `'third'`): mapping an
  answer onto an accidental dismiss would let a child poking the scrim decide what reaches
  them. `.modal-btns` wraps, because three Hebrew labels do not fit one phone row.
  `view-pick` lists every waiting video of that channel with **everything ticked** (a channel
  is usually added because it is wanted, so the job is unticking a few — only safe because
  unticking is now reversible), whole-row tap targets, סמן הכול / נקה בחירה, and a live count
  in the confirm button. Ticked → live; unticked → `'rejected'`. It reuses view-whatsnew's
  skeleton so only the list scrolls and 109 items can never push the confirm button
  off-screen — and **`#view-pick.active` must carry the centering flex**, or the fixed-width
  `.wn-wrap` pins itself to the RTL right edge (measured: 560px at left:720 of 1280).
  The rejected archive lives inside the ממתינים tab as a collapsed `<details>` (`#rejected-box`,
  hidden at zero) with per-row restore ✅ and per-row permanent delete 🗑️, plus
  "מחק לצמיתות" to empty it. `parentRow` renders 🗑️ only when given an `onDelete` — it used
  to bind `undefined` unconditionally, so a caller that omits it drew a dead button.
  Asking is scoped to the paths where the parent is PRESENT (parent screen + share). A channel
  from the SHEET keeps today's behaviour: column C already carries the auto/manual answer.
- v1.0.22 — **ADDING A CHANNEL ASKS ONCE, AND SAYS WHAT ACTUALLY HAPPENED.** A channel
  added in the parent screen is created `autoApprove:false`, so its ENTIRE back catalogue
  landed in the approval queue while the message read "הערוץ סונכרן ✅" — the parent had no
  reason to look in ממתינים, and the child's home stayed empty. Pasting a channel link
  behind the PIN is a deliberate parental act, so `offerChannelApproval()` (app.js) now asks
  once, right after the import: "yes" approves the backlog AND flips `autoApprove` so future
  uploads flow without another visit; "רק לסקירה" keeps them queued. Either way the status
  line reports the real outcome (`N אושרו` / `N ממתינים לאישור`) — a reassuring ✅ over an
  invisible backlog is how this survived to the field. Decision (2026-07-31): ASK, never
  auto-approve silently — it is the one moment before a stranger's whole catalogue reaches a
  5-year-old. The dialog is raised only AFTER `loading.hide()` (modals must never stack), so
  the channel add now awaits its sync instead of firing it into a `.then()`. The pending
  lookup + bulk approve are shared with the channel-list auto-approve toggle
  (`pendingKeysOfChannel` / `approveChannelBacklog`) so the two paths cannot drift.
- v1.0.21 — **A CHANNEL MEANS ITS "VIDEOS" TAB + ITS "PLAYLISTS" TAB. NOTHING ELSE.**
  No Shorts, no live streams. The mechanism is playlist membership, and it is the only
  correct one:
  - YouTube auto-generates siblings of the uploads playlist, addressed by swapping the
    prefix on the channel id: `UU…` all uploads, **`UULF…` long-form only (= the Videos
    tab)**, `UUSH…` Shorts only, `UULV…` live. `quota.longFormPlaylistIdFor` /
    `shortsPlaylistIdFor`. The backfill pages UULF instead of UU — same
    `playlistItems.list` call, **zero extra quota**. UNDOCUMENTED by Google; measured
    2026-07-31 on Cocomelon / Blippi / Super Simple Songs: `UULF ∪ UUSH = UU` exactly,
    no overlap, no leftovers.
  - **NEVER FILTER BY DURATION.** A Short is "≤3 minutes AND square-or-taller"; the API
    exposes no aspect ratio and no `isShort` field at all. 6 of the 15 most recent Super
    Simple Songs LONG-FORM uploads are under 3 minutes (3 of 15 for Cocomelon), so a
    length rule would delete real nursery rhymes — the app's core content. An invariants
    test rejects any ISO-8601 duration parser anywhere in `www/js`.
  - A variant playlist **does not exist** when the channel has no content of that type, so
    a Shorts-only channel answers `404 playlistNotFound` (`fetchUploadsPage(...).notFound`).
    That is information: the channel is marked `noLongForm`, the backfill is closed so we
    stop asking, and the parent's channel list SAYS SO. Deliberately NOT falling back to
    `UU` — that would import the very Shorts being excluded.
  - The RSS incremental path cannot see playlists, so it uses the other free signal: each
    entry's `<link rel="alternate">` is `/shorts/…` vs `/watch?v=…` vs `/live/…`
    (`ytrss.altLinkKind` → `isShort`/`isLive`). Measured 100% agreement with UUSH/UULF
    over 60 videos on 4 channels. Everything here rests on undocumented behaviour, so an
    UNKNOWN signal means INCLUDE: a wrongly hidden video is a bug the parent cannot
    explain, a leaked Short is cosmetic.
  - The **playlists tab is a SOURCE, not a folder layout** (decision 2026-07-31): its
    videos land in the channel's own `ch:<id>` folder, mixed by date. Own budget
    (`PLAYLIST_PAGE_BUDGET`) so it can never starve the uploads pass, walked only after
    `backfillDone`, and resumable per page via `playlistQueue`/`playlistCursor`.
    Two filters are load-bearing: **foreign videos are dropped** (`videoOwnerChannelId
    !== channelId` — the parent subscribed to THIS channel, not to whatever it curated),
    and the channel's own Shorts are dropped via UUSH membership, because
    `playlistItems` carries no Shorts flag. Playlists whose title matches `/shorts?/i`
    are skipped outright.
  - **Duplicates need no new code**: `planMutations` keys on `yt:<videoId>` and its
    per-channel title index also merges same-titled twins WITHIN a run, so the heavy
    Videos-tab∩playlists overlap collapses to one record and one gift (test-pinned).
    Note the price, also pinned: a same-title/DIFFERENT-id twin (an alt mix, a re-upload)
    merges too, and `mergedFrom` makes that permanent — the loser can never be imported.
  - Review fixes, each now a rule:
    - **A PAGE TOKEN BELONGS TO ONE PLAYLIST.** `backfillPlaylistId` travels with
      `backfillCursor`, and `quota.planBackfillPlaylist` RESETS the cursor on a mismatch.
      Reusing a `UU…` token against `UULF…` either skipped a slice of the back catalogue
      and latched `backfillDone`, or was rejected and written back — leaving the channel
      returning `'backfill'` forever, never delivering another video. `playlistId: null`
      means SKIP; substituting `UU…` is what the whole release exists to avoid.
    - **PAGING STATE NEVER TRAVELS TO DRIVE.** `serializeDb` strips `backfillCursor`,
      `backfillPlaylistId`, `playlistCursor`, `playlistQueue`, `playlistsDone`,
      `noLongForm`, and the apply side keeps the LOCAL values. A peer's "playlists
      finished" made another device skip pages it had never walked.
    - **`playlistsDone` REQUIRES A COMPLETE ENUMERATION** (`plan.planPlaylistAdvance`).
      Deriving it from "the queue is empty" made one throttled first call disable the
      source for that channel forever — nothing rearms it. `db.deleteLibraryChannel`
      now rearms the playlist walk and `noLongForm` alongside the backfill.
    - **A MISSING `videoOwnerChannelId` IS REJECTED** (`plan.acceptPlaylistItem`): that
      is what private and deleted playlist entries look like, and they reached the child
      as untappable "Private video" tiles. RSS fails OPEN, playlist items fail CLOSED.
    - **ONE 404 IS A CHANNEL, ALL 404s ARE AN OUTAGE** (`plan.planNoLongForm` +
      `planLongFormOutage`). Only a first-page 404 on a derived id means "Shorts-only";
      every channel 404ing at once means YouTube retired the alias, so nothing is closed
      and no parent is told something false. `noLongForm` is retracted the moment
      long-form content appears.
    - **A FORCED SYNC CHAINS, NEVER JOINS.** `inFlight` used to hand a forced caller the
      running promise and drop its opts, so a share landing inside the launch sync's
      window got no `srcChannelId` and no `giftRank` — the exact bug it was fixing.
    - **`planGifts` CAPS THE OUTSTANDING GIFTS AT `baseline` ON BOTH BRANCHES.** The
      incremental branch had no ceiling, so approve-all / a backfill going live / a
      baseline spent on a near-empty library gifted EVERYTHING. A runaway 🎁 folder is
      now unrepresentable rather than repairable, and the NEWEST arrivals get the ranks.
    - `refreshAfterAdd` refuses to run under a playing video (a forced sync also bypasses
      the per-channel RSS throttle, so it is a full sweep), `parentAdd` AWAITS its sheet
      row before syncing (its own mirror could otherwise tombstone it), and the
      channel-auto-approve bulk path calls it too.
    - Source-level guards may not pin SYNTAX. Three did, and all three broke on a
      refactor that improved the code while a dead filter would have passed them. The
      decisions live in pure `plan.js`/`quota.js` helpers with behavioural tests; the
      only greps left are the ones a test cannot express (no duration parser anywhere,
      no second caller of `db.pageGifts`).
- v1.0.21 field fixes — these are INVARIANTS now:
  - **`pageAnyFolder` PAGES 🎁 TOO.** 🎁 "חדשים" is not a stored folder — no record carries
    `folderId:'new'`, so `folderRange(scope,'new')` is an exact bound matching nothing.
    `renderGridPage` had its own gift branch and `renderWatchGrid` did not, so opening a
    gift left the UNDER-PLAYER GRID EMPTY: the child lost every way to reach the next
    video. The gift case now lives in `pageGiftFolder`, reached ONLY through
    `pageAnyFolder` (still THE one pagination entry point), and `renderGridPage` has no
    special case left. A test pins that nothing calls `db.pageGifts`/`db.pageFolder`
    outside it — a second renderer must never grow a private branch again.
  - **A FRESHLY ADDED RECORD IS INERT UNTIL A SYNC TOUCHES IT.** `srcChannelId` is written
    only by the sync's enrichment stage, and that field is what `groupSinglesByChannel`
    folds a single into its 🎞️/📺 folder by; `giftRank` is assigned only by
    `planProfileGifts`. So a video shared from YouTube (or pasted in the parent screen)
    sat in the loose "סרטונים נוספים" list and was NOT a 🎁 until the parent happened to
    press "רענון נתונים". Every path that makes a record live now calls
    `refreshAfterAdd()` — manual add, share, single approve, approve-all — which forces
    the sync (the 3-min `shouldSync` throttle is exactly what hid this), reloads gift
    state and re-renders. It is SILENT and non-blocking: covering a populated grid with
    the loading screen is the worse bug (v1.0.18). A channel share already synced itself;
    a PENDING share deliberately waits for approval, which syncs then.
  - **THE FIRST REFRESH OF EACH LAUNCH IS FORCED** (`launchSyncDone`, per process). The
    3-min content throttle and the 6h update-check throttle both exist for good reasons
    mid-session, but together they meant reopening the app minutes after the parent edited
    the sheet showed stale content, and a release could stay hidden for a whole day of
    launches. Later home entries keep both throttles. The update check stays `silent`, so
    `update.skip` still suppresses a version the parent declined — only the red dot shows.
    App RESUME also re-checks for a release now: coming back from the background does not
    re-fire the gallery's `onEnter`, so a device left running for days never looked.
- v1.0.4: launch update PROMPT (decline stores `update.skip` per version — the throttled
  check path honors it); one-time Google-connect screen before profiles (`gauth.introDone`
  pref; restores profiles + per-profile sheet via the Drive doc's additive `profileSources`);
  folder tiles restyled + keyless channel-logo scrape (`yt.scrapeChannelLogo`, weekly retry);
  real exit via `KidsNative.exitApp`; attention dots (`gate-dot`, `about-dot` + the pending
  badge inside the parent screen) — see v1.0.24 for what the colours mean now. There is no
  `settings-dot`: the update UI moved to the About tab in v1.0.8 and took the dot with it.
- v1.0.5: in-place delete from the watch page (`watch-delete` → parameterized PIN gate
  `startPin(mode, {onSuccess, replace, title})` — replace:true so back never lands on a
  torn-down player → confirm → deleteVideo in EVERY scope holding the key → home); share
  the app from parent settings (`KidsNative.shareText` chooser → Web Share → clipboard;
  message built by pure `update.buildAppShareMessage` — explainer page first, then the
  APK link, which since v1.0.20 is ALWAYS `update.latestApkUrl()`
  (`/releases/latest/download/kids-player.apk`, `STABLE_APK_ASSET`) and never
  `latest.assetUrl`: a forwarded WhatsApp message outlives its release and must not
  install a frozen build. `test/distribution.test.mjs` pins that link, the website
  button and both release scripts to ONE asset name).
- v1.0.14: parent screen LANDS on "אודות" (`PARENT_TABS[0]`; the panel's initial markup
  must match it or the screen flashes empty). Voluntary support block: two FREE ways to
  help (share / feedback) + `❤️ תרומה למפתח` → `askKid` payment-method choice (an
  accidental dismiss picks nothing) → `platform.openExternal` → `KidsNative.openUrl`
  (http(s) only; the WebView blocks external navigation by design). ALL links live in
  `www/js/donate.js` (`DONATE_LINKS`) — empty string = method not offered, both empty =
  donate button hidden entirely; pure `donateOptions`/`shouldShowDonateNudge` are tested.
  ONE-TIME nudge in the parent screen after 30 days of use (`install.firstSeenAt` stamped
  at first launch, `donate.nudgeDismissed` kills it forever). Never shown to the child.
- v1.0.13: what's-new is a real SCROLLING view (`view-whatsnew`), not the modal (the old
  `alertKid` card had no max-height, so long English bodies overflowed it). Only `.wn-body`
  scrolls — header and button stay put. Notes are PARENT-FACING Hebrew:
  `update.extractReleaseNotes` prefers the `## מה חדש` section of the release body and
  otherwise de-noises the whole body (drops headings, urls, @handles, PR refs, markdown,
  "Full Changelog"); `buildWhatsNew` groups EVERY version above the installed one
  (newest first, cap 8 + `moreCount`). `checkForUpdate` now fetches `/releases?per_page=30`
  (same single call) → `latest.whatsNew` + `update.notesAll` (all versions, for the About
  tab's 🎉 button after an update). Back / "לא עכשיו" CANCELS the update. release.sh /
  release.ps1 wrap the notes argument in a `## מה חדש` heading (default: Hebrew
  "שיפורים ותיקונים"); `scripts/backfill-release-notes.sh` adds Hebrew sections to
  pre-v1.0.13 releases (idempotent, keeps the original body below a divider; needs WRITE
  access — the local gh account has read-only on devfassaf).
- v1.0.12: (a) REMOVAL ROWS — a video inside a channel has no row of its own, so its
  deletion travels as a comment row `# הוסר: <link> — <title>` (`classify.parseRemovalRow`
  → `classifySourceRow` kind 'removed'; old app versions skip comments, so a removal can
  never resurrect content there). A removal row WINS over a video row of the same key in
  the same sheet; the mirror denies those keys and never un-denies them.
  `enqueueSheetRemovalRow` refuses rows that don't round-trip (no dead rows). Bulk
  reject-all deliberately writes NO rows (hundreds would wreck the sheet).
  (b) LOOSE-SINGLE GROUPING — `plan.groupSinglesByChannel` (pure) folds 2+ singles of the
  same channel into a VIRTUAL `grp:<channelId>` folder (🎞️ אוסף chip); one single stays
  loose, so deleting down to one un-groups by itself. Singles of an already-subscribed
  channel are absorbed into its 📺 folder instead. `srcChannelId/srcChannelTitle` come
  free from the videos.list(snippet)/oEmbed calls titles already make (sync enrichment
  stage, ≤100/run, weekly retry). `pageAnyFolder` is the ONE pagination entry point
  (group slices / trimmed flat list / channel+absorbed prepend).
  (c) The sheet wizard ALWAYS asks (no silent adopt): join `<profile>`'s file (one button
  per distinct sheet, PIN-gated) / create (`sheetwrite.sheetNameFor` → "<שם>_רשימת
  סרטונים") / paste link / skip.
- v1.0.11: exit lock (`exitLock` pref, PER-DEVICE, settings toggle) — OS screen-pinning
  kiosk via `KidsNative.lockTask/unlockTask` (HOME is uninterceptable by apps; lock-task
  is the sanctioned mechanism; native exitApp stopLockTask()s defensively first). Exit
  flow when on: confirm → PIN ("קוד הורים ליציאה") → unpin + exit; exit button hidden;
  re-armed at every launch. TV parent screens are D-pad-complete (OK toggles
  checkboxes — the text-field guard exempts checkbox/radio inputs). Google-verification
  kit: docs/site/ homepage+privacy for GitHub Pages + submission walkthrough in
  GOOGLE_CLOUD_SETUP.md שלב 3א (the unverified warning is scope-sensitivity, not code).
- v1.0.10: the sheet is the truth in BOTH directions — deletions too. sheetwrite ops
  queue (append/delvideo/delchannel, reconcileOps latest-intent, flush deletes rows
  bottom-up via batchUpdate then appends with sheet-presence dedupe); sync mirror stage
  (sheetSeen baseline diff, valve alert meta + sources-tab resolution UI); deny-list
  became revocable (see invariants). Channel remove = full cleanup everywhere.
- v1.0.9: Android TV support, same APK (manifest: LEANBACK_LAUNCHER + optional
  leanback/touchscreen + tv_banner drawable). `KidsNative.isTv` (UiModeManager) →
  `platform.isTv()` (dev override: localStorage tv=1) → `html.tv` class = 10-foot CSS
  (overscan padding, 4-col grid ≥900px, big focus ring) + `ui/dpad.js` D-pad focus
  manager (pure geometry in spatial.js — no wrap-around, orthogonal-drift penalty;
  fresh focus prefers GRID content over top-bar chrome). Watch-view remote model:
  top buttons ↕ PLAYER (nothing focused: OK=pause, ←→=seek via `player.handleTvKey`)
  ↕ under-player grid. Sideloading on TV needs the Downloader-app/adb path once.
- v1.0.8: onboarding tour (`view-tour`, once per install via `tour.done` pref; REAL app
  screenshots in www/assets/tour/ — the playwright staging script that made them was
  scratchpad tooling and is NOT in the repo, so they must be re-shot by hand; replay
  from the About tab); sheet-setup wizard after profile creation (`view-sheet-setup`:
  skip / create-a-sheet via `sheetwrite.createSourceSheet` — spreadsheets.create +
  anyone-reader permission + starter # row — / paste-link; PIN-gated; a new profile
  AUTO-ADOPTS an existing family sheet and skips the wizard; restored profiles never
  see it); About tab (app explanation, version+update UI moved from settings,
  `about-dot`, mailto contact, tour replay); what's-new dialog (release notes) before
  every install; data-migrations framework (`dataver.js`, meta dataVersion; step 1 =
  force sheet re-parse); duplicate profile names blocked (`profileNameExists`);
  clear-cache lives ONLY in the sources tab (was in the every-tab footer).
- v1.0.7: interactive share adds — a YouTube share (video OR channel, `classifyShared`)
  opens PIN → confirm → live + sheet row; cancel parks a video as pending, a channel is
  dropped (share.js falls back to silent pending without the handler). `startPin` gained
  `onDone` (fires exactly once — success consumes it before navigation, pin onLeave fires
  cancel). Home search (`search-open` → `view-search`): pure ranking in search.js over
  live records + channel folders, back-from-watch returns to results. Home entry syncs
  (shouldSync now 3 min) + re-offers updates (once per session); installing an update now
  requires the parent PIN. pin-cancel returns to the PREVIOUS view (nav.back), not
  hard-coded gallery.
- v1.0.6: the sheet is the single master list — sheetwrite.js appends manual adds,
  manual channels and approved shares back to it (requires the `spreadsheets` scope in
  GoogleAuthPlugin + edit rights; queue survives offline; published /d/e/ links can't be
  written to). ONE shared "סרטונים נוספים" folder: `absorbMineIntoShared` idempotently
  folds profile-scope 'mine' records into the library 'sheet' folder on every activation
  (deny lists union via `db.copyDenies`; share.js writes lib scope directly when sources
  exist). Channel auto-approve toggle now offers to approve that channel's PENDING videos
  (dialog with count). Channels without a logo get a PERSISTED `fallbackThumbUrl` (oldest
  live video's thumbnail) so folders stay visually distinct.
- The updater reads `devfassaf/kids_player` releases/latest (`UPDATE_REPO` in update.js).
  EVERY release carries **TWO copies of the same APK** (v1.0.19):
  `kids-player-v<X.Y.Z>.apk` (humans + `pickApkAsset`'s exact match) and
  `kids-player.apk` (a STABLE name, because GitHub's
  `/releases/latest/download/<asset>` redirect — what the website's download button
  uses — resolves only an exactly-named asset). Both release.sh and release.ps1
  upload both, and `test/distribution.test.mjs` pins the names together across the
  two scripts and docs/index.html. Publishing by hand with only one file silently
  404s the website button.
- v1.0.18: (a) EVERY BLOCKING WAIT uses the full-screen `view-loading` (horse/rocket/
  balloon/train), not a `.form-msg` line — Google connect, Drive enable/push, sheet
  creation, forced sync, add-channel. `loading.show({title, step, pct})` +
  `loading.progress(p)` consume the `pct` sync2 always emitted; an INDETERMINATE step
  hides the bar rather than freezing it. Always `hide()` in a `finally`, and hide
  BEFORE any modal (they must never stack). The 3-min background refresh on home entry
  deliberately does NOT show it — covering a populated grid is the worse bug.
  (b) TWO TOUR DECKS share `view-tour`: `TOUR_SLIDES` (landing page + 5 screens) and
  `ADD_GUIDE_SLIDES` (how to add content: YouTube share / in-app paste / the sheet).
  Content and ALL bounds arithmetic live in [tour.js](www/js/tour.js) (pure, no imports,
  unit-tested) — app.js holds only the DOM. Only the ONBOARDING deck may write
  `tour.done`. Guide illustrations are hand-authored SVGs in www/assets/guide/, all
  `viewBox="0 0 1280 800"` to match the screenshots (the slide CSS has no max-height,
  so a different ratio pushes the nav off-screen). See v1.0.20 for the guide deck's
  current form.
- v1.0.20 field fixes — these are INVARIANTS now:
  - **A LONE CHANNEL IS STILL A FOLDER.** `renderHome` flattens its single folder into a
    flat video list only for the loose lists (`plan.shouldFlattenHome` → `'sheet'`/`'mine'`).
    The old rule was "exactly one folder, whatever it is", so a library whose only content
    was ONE subscribed channel rendered the whole backfill flat — no 📺 tile, no logo,
    which is exactly what the parent subscribed for. 🎁 alone is never the whole home.
  - **HANDLES ARE NOT ASCII.** `parseChannelRef` accepts `\p{L}\p{N}._-` (YouTube's own
    3-30 rule) and percent-DECODES the segment first: `m.youtube.com/@חלומותחסידיים` and
    the `%D7%97…` form the YouTube app puts on the clipboard both used to be rejected as
    "unsupported link". The stored value is the readable handle, and `yt.channelPageUrl()`
    encodes it exactly once (encodeURI escapes `%`, so a still-encoded handle would become
    `%25D7%2597…` and 404 forever). Keep the literal `@`.
  - **THE GIFT BASELINE NEEDS SOMETHING TO BASELINE.** `plan.shouldRecordGiftBaseline`
    refuses to burn the flag when no record is live yet. Adding a channel syncs while
    everything is still pending, so the flag was spent on nothing: the child got NO gifts
    after approval, and the next sync took the incremental path and gifted the ENTIRE
    backfill. `dataver` step 2 (`plan.planGiftRunawayRepair`) retires such a pile on
    already-affected devices — only above an implausible floor (60), and `giftRank` must
    be DELETED not zeroed (the sparse by_gift index is the 🎁 folder).
    **RANK IS NOT RECENCY** on those piles: only `planGifts`' BASELINE branch sorts by
    `compareForDisplay`; the INCREMENTAL branch (the one that creates a runaway) stamps
    `maxRank+1` while walking `loadMergeIndex`, a cursor over the `[scopeId,key]` primary
    key — i.e. ALPHABETICAL. Ranking the repair by `giftRank` kept an arbitrary dozen and
    retired the genuinely newest videos, permanently (`unwrappedAt` is min-merged forever).
    So `planGiftRunawayRepair` takes `sortKeyOf` and the caller supplies the VIDEOS' own
    recency; giftRank is only the tie-break. STILL OPEN (see the review notes): the step
    runs at boot, before the sync that can create the pile, and nothing ever clears a
    burned `baselineDone`.
  - **THE HOME NO LONGER RE-READS THE LIBRARY PER RENDER.** `buildFolders` needs full
    records (they feed the tiles), and `renderHome` runs on every gallery entry, every
    return from a video and every page flip — a full-store deserialize each time. `db.dataVersion()`
    counts committed writes (bumped inside `tx()` itself, so no write path can forget)
    and `buildFolders` caches its whole derivation against it. Measured with 1020 videos:
    22ms → 1.8ms per render. NEVER cache derived home state against anything else.
    The cache key is `{seq, profileId}` and **BOTH are captured AT ENTRY**: switching
    profile writes only to Preferences, so `dataVersion()` does NOT change across a
    switch and `profileId` is the ONLY cross-profile guard. Reading it at cache-write
    time let a derivation that began as child A get stamped with child B, and B was then
    served A's library with `libScope` pointing at A's videos. For the same reason all
    the derived state (`libScope`, `singleGroups`, `absorbedSingles`, `looseSingles`)
    is built into LOCALS and published only if the profile is still current.
  - Also: the sync's deny set is read once per run instead of once per removed key (it was
    quadratic in accumulated deletions) — and it is `add()`ed to as the loop tombstones,
    because duplicate `# הוסר` rows otherwise re-ran `deleteVideo` and restamped the
    tombstone's LWW `at`. `update.currentVersion()` is memoized — the attention dot was
    making a native bridge round trip on every render.
  - Snapshot import: a PENDING record keeps its exported `homeFolderId` — UNLESS its
    `scopeId` was rejected and downgraded to `prof:`, in which case `'sheet'` becomes
    `'mine'`: the shared folder is raised only for `libScope`, so the record would be
    stored, approvable, and in no folder on any screen. Import also preserves
    `srcChannelId`/`srcChannelTitle`/`srcChannelTriedAt` (without them every 🎞️
    collection dissolves into the flat list) and REFUSES a non-finite `sortKey`
    (`by_folder_sort` takes no NaN key and a string sorts outside `folderRange`, so the
    row counted as imported and was invisible forever).
    Since v1.0.26 **ALL THREE curation states survive the round trip**: 'rejected' used
    to fall into the live branch (`pending ? 'pending' : 'live'`), so a restore put
    every video the parent threw out BACK ON THE CHILD'S HOME — live, in a real folder,
    giftable. A rejected record imports parked in `'~rejected'` with its ORIGINAL
    `rejectedAt`: restamping would restart `planRejectedPurge`'s 30-day clock on every
    restore, and a row exported without one imports without one (no `rejectedAt` =
    never auto-purged — the safe direction). The sheet→mine downgrade applies to it
    exactly as to pending. DENY rows travel as FULL records in both directions
    (`loadDenyRecords`, never `loadDenySet` — the `copyDenies` presence rule) and the
    import MERGES via `drive.mergeDenyRecord` in pure `planDenyImport` instead of
    blind-putting: the old `at: d.at || Date.now()` dropped `removedAt` and restamped
    the event, so a revoked tombstone imported as ACTIVE-and-newest, clobbered a local
    revocation, and the resurrected deny then won every Drive merge — the v1.0.22
    `copyDenies` bug replayed on the snapshot path. A row with no `at` gets 0, never
    "now": a timeless entry must lose to any real event.
  - `sheetwrite.interpretSheetResponse` is the ONE gate for EVERY `values.get` read,
    including the one inside `doFlush` — hand-rolling that one read let an error envelope
    or a sign-in page pass as an empty sheet, so no row matched for deletion, every append
    was re-appended, and `clearFlushed` then dropped the unsent `delvideo` ops whose rows
    were still in the sheet: the next mirror pass read that presence as a re-add and
    resurrected the deleted videos everywhere. An unreadable read ABORTS the flush with
    the queue intact. An error envelope may ride along only with ACTUAL ROWS.
  - **THE WRITES ARE GATED THE SAME WAY (v1.0.26): A WRITE MUST BE PROVEN, NOT MERELY
    NOT-REFUSED.** The batchUpdate and append calls in `doFlush` checked only
    `res.status !== 200` — but `platform.httpRequest` does `r.json().catch(() => null)`,
    so the sign-in interstitial the read gate exists for (a lost grant answering
    200 + HTML) arrived as `{status: 200, data: null}` and COUNTED AS A SUCCESSFUL
    WRITE; a proxied error envelope (200 + `{error:{…}}`) passed too. `clearFlushed`
    then dropped the append whose row never landed, leaving a record that is live +
    sheet-backed + rowless + absent from `pendingAppendKeys` — exactly what the next
    presence-mirror pass tombstones, on every device; and one lost append of a
    50-video library stays under the max(10, 5%) valve, so no parent was ever asked.
    A dropped un-landed DELETE is the mirror image: its row stays in the sheet and the
    next pass reads that presence as a re-add. `interpretWriteResponse(status, data,
    kind)` is the write twin of the read gate — SUCCESS MAY COME FROM EXACTLY ONE
    SHAPE: a 200 whose body is a real object, carries no `error` key, and carries the
    operation's own marker (`updates` for values.append; `spreadsheetId`/`replies` for
    batchUpdate — deleteDimension replies are empty objects, so only the array's
    EXISTENCE is a marker). An error envelope is NEVER proof, even beside a marker —
    unlike the read gate there are no "actual rows" to ride along with — and an
    unknown kind fails CLOSED. Anything else aborts the flush with the queue INTACT
    (the same `abortFlush` the column-A read uses; `clearFlushed` must never run for
    ops whose write was not proven). Retrying is idempotent: a landed delete matches
    no row, a landed append dedupes by sheet presence. Both call sites are pinned
    behaviourally through the real `flushSheetQueue` (a 200+null append and a
    200+envelope batchUpdate each leave their op queued), proven to fail on a
    planted status-only revert of either site.
  - Queue overflow is DATA LOSS and must outlive the next flush: it lives in a durable
    `dropped` counter (not `error`, which every `doFlush` exit overwrites) and the sources
    tab renders it ABOVE the reassuring "pending" line.
  - New test files: `invariants.test.mjs` (import graph acyclic, `tour.js` imports nothing,
    no `search.list`, no `spreadsheets` scope, no paste-a-sheet control, keys.local.js
    gitignored, `parseSourceSheet` has no production caller), `pin.test.mjs`, `yt.test.mjs`,
    `snapshot.test.mjs`. Guards in there must be PROVEN to fail on a planted regression —
    three of them were vacuous: `walk()` collected only `.js` so the `spreadsheets` sweep
    read ZERO Java files (and `native-reference/`, the canonical rebuild copy, still
    declared the scope), the `search.list` patterns matched nothing this repo can write,
    and `importsOf` was blind to `await import()`, which outnumbers static imports here.
- v1.0.20 — the ADD-CONTENT GUIDE is the app's real manual: **18 slides, chaptered.**
  Without it the app is worthless to a parent, so it gets the detail it needs.
  Same `view-tour` mechanism; every `ADD_GUIDE_SLIDES` slide now carries a `chapter`
  (לפני שמתחילים · דרך 1 · שיתוף מיוטיוב · דרך 2 · במסך ההורים · דרך 3 · קובץ הרשימה ·
  אישור ומחיקה). Pure `deckChrome(deck, idx)` picks the chrome: a deck longer than
  `DOTS_MAX` (8) HIDES the dot row and shows a chapter chip + "שלב N מתוך M" (18 dots
  are noise); the onboarding deck keeps its dots and shows no chip. `chapters(deck)`
  derives the chapter table FROM THE SLIDES — never a second hand-kept list — and the
  tests pin that the chapters are contiguous, uniquely titled, and cover every slide.
  IMAGES (decision, not taste): every APP screen is a REAL 1280x800 screenshot
  (`assets/guide/app-*.jpg` + `share-04-pin.jpg` / `share-05-confirm.jpg`), staged
  through the live UI with playwright — scratchpad tooling, NOT in the repo, so they
  must be re-shot by hand. ONLY what the app doesn't render stays a drawing: YouTube's
  share button, Android's chooser, the spreadsheet columns, the Drive folder. A drawn
  parent screen sends parents hunting for a button that looks like nothing on screen.
  A test pins that every slide's asset EXISTS in `www/` and that app steps are
  photographed rather than drawn. Entry points: the parent screen (`guide-add`), the
  last onboarding slide (`tour-more`), the About tab — and the child's EMPTY home
  (`#empty-guide`, no PIN: reading adds nothing), which is where a stuck parent is.
- v1.0.19 — ⚠️ **HISTORY: everything in this block about the sheet itself is GONE (v1.0.38).**
  `sheetwrite.js`, `starterRows`, `SHEETS_FOLDER_NAME`, `parseSourceSheet`, `sync.js` and the
  app-created spreadsheet no longer exist; the read gate lives on only inside `sunset.js`
  until 2026-09-10. **The one rule here that is still LIVE and load-bearing is the first
  sentence** — `drive.file` is the only OAuth scope, and it must never grow. The rest is kept
  for its lessons (an unreadable response is never an empty one; a write must be proven, not
  merely not-refused) — those doctrines still govern `interpretSheetResponse`,
  `interpretDriveDoc` and `parseLinksFile`.
- v1.0.19 — **`drive.file` IS THE ONLY OAUTH SCOPE.** `spreadsheets` is classified
  SENSITIVE and was the sole cause of the "Google hasn't verified this app" screen.
  Verification was not an option: it needs a DNS-level Search Console Domain
  Property and the site is on `github.io`, whose DNS we don't control. Consequences,
  all load-bearing:
  - The app writes ONLY to sheets it created itself — `drive.file` is per-file and a
    pasted third-party sheet returns `403 appNotAuthorizedToFile`. **Pasting a sheet
    link is therefore GONE** from both the wizard and the sources tab. Never re-add
    it, and never re-add the `spreadsheets` scope to make it work: that brings the
    warning screen back for every family.
  - The only two writable sources: create a new list, or join a list this app
    already created for another profile ON THIS DEVICE/ACCOUNT. A different Google
    account cannot write to it (read-only), by design.
  - READS ARE AUTHENTICATED (`sheetwrite.readSourceSheet` → Sheets API `values.get`),
    not a public CSV export. So sheets are **no longer shared "anyone with the link"**
    — previously every family's playlist was world-readable to anyone with the URL.
    `readSourceSheet` THROWS on any non-200 and that is load-bearing: the throw keeps
    `sheetParsed` false so the presence-mirror can't read "unreadable" as "emptied".
    Never soften it to a silent `[]`. Since v1.0.20 the whole decision is pure
    `interpretSheetResponse(status, data)`: **emptiness may come from exactly ONE input**
    — a clean 200 with no `values` key. A markup body (`looksLikeHtml`, a lost grant
    answering 200 with a sign-in page), a JSON error envelope on a 200, a non-array
    `values` and an unparseable body all THROW instead of guessing `[]`.
  - `parseSourceRows(rows)` is the parser. `parseSourceSheet(text)` has NO production
    caller (verified) and is kept only for the tokenizer tests — do not wire it back
    to a fetch. `sync.js` is likewise dead in production. Sheets-API rows are RAGGED (trailing empty cells
    omitted) — both must tolerate that without throwing.
  - `starterRows()` writes a real COLUMN HEADER (A=link, B=display name, C=auto/manual)
    plus how-to lines into every new sheet. Every one starts column A with `#` so
    `classifySourceRow` skips it. Three properties are test-pinned: A always starts
    with `#`; NO line may contain a removal marker (הוסר/removed/deleted) or
    `parseRemovalRow` would deny the example link's key for every device; and they
    never shift `rowIndex` (videoOrdinal counts video rows only, so sortKey is safe).
  - App-created sheets live in the Drive folder `רשימת השמעה לאפליקציה הסרטונים שלי`
    (`sheetwrite.SHEETS_FOLDER_NAME` / `ensureSheetsFolder`). The Drive DB
    (`kids-player-db.json`) deliberately stays OUT of it: the folder is what a parent
    would share with a partner, and sharing it would hand over the whole database.
    Share per FILE, never the folder.
- v1.0.18 data-loss fixes — these are INVARIANTS now, not just fixes:
  - A sheet body that `looksLikeHtml` (csv.js) is a FETCH FAILURE, never an empty
    sheet: an unshared sheet 302s to a permission page that returns HTTP 200 + HTML,
    and parsing that as "the parent emptied the sheet" deleted whole libraries.
  - `planSheetMirror` valves on `disappeared === localTotal` REGARDLESS of size. The
    old `> max(10, 5%)` floor meant a child owning ≤10 things was wiped silently.
  - `deleteLibraryChannel` rearms `backfillCursor/backfillDone` once no library
    subscribes — otherwise a re-added channel only ever returns its RSS window.
  - `flushSheetQueue` is serialized per library and clears ONLY the ops it wrote
    (pure `remainingAfterFlush`). Clearing the whole queue destroyed un-sent deletes,
    which resurrected deleted videos everywhere via the mirror's `unDenyKeys`.
  - `enqueueOp` reconciles BEFORE capping so the cap counts distinct ENTITIES, and the
    cap keeps the OLDEST intents (`planQueue`, pure): head-dropping discarded the
    parent's earliest deletions — their rows stayed in the sheet, the next mirror read
    that presence as a deliberate re-add and `unDenyKeys` resurrected everything, on
    every device. At capacity the op being REFUSED is the newest one, at the same moment
    `queue-overflow` reaches the sources tab. Bulk callers pass `{flush:false}`
    and flush ONCE at the end — a record that is live + sheet-backed + rowless is
    exactly what the mirror tombstones, so that window must close in one tick.
  - `adoptLibraryScope` refuses to migrate when ANOTHER profile still points at the
    old scope: `lib:<fnv1a(sheet)>` is shared, and `moveScope` deletes its source.
  - `moveScope` unions tombstones BEFORE deleting (an interruption used to lose the
    deny-list forever, and nothing retries).
  - `fsDownload` mkdirs its own parent directory — `downloadFile` ignores
    `recursive:true` on Android. This was the known-unaudited `media.js` item and it
    was real: direct-file video caching never worked on device.
  - `playItem` issues a monotonic `playSeq`; `playYouTube` bails if superseded after
    `await loadYouTubeApi()`. Otherwise a second tap during the API load mounted a
    second player+HUD (breaking the setupHud-twice invariant) and left an orphan
    firing a stale `onExit`.
  - The search index is derived from the SAME `folders` array the home screen renders
    — re-deriving it left absorbed-singles channel folders on screen but unfindable.
- Push access: the local `gh` account may be READ-only on `devfassaf/kids_player` → push a branch to
  the `AssafFaybish/kids_player` fork (`git push fork <branch>`) and open a PR.
