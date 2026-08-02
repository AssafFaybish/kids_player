# CLAUDE.md — kids_player

Child-safe, parent-curated YouTube/video player for a ~5-year-old on an Android tablet.
**Vanilla JS ES modules (NO framework, NO bundler) + Capacitor 6.** UI is RTL Hebrew
(`<html dir="rtl">`). `www/` is the whole app; `android/` is committed and carries
hand-maintained native code. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the module map
and data model before touching sync/db/player code.

## Commands

```bash
npm run serve        # dev server http://localhost:5173 (fixed port, no-store, /__proxy CORS helper)
npm test             # node:test suite (~305 tests) — MUST stay green; pure logic only, no DOM
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
- Deletion = atomic delete + deny-list tombstone. Since v1.0.10 the deny-list is an
  LWW-element set: entries are never removed, but the SHEET re-adding a key revokes them
  (`removedAt >= at` = inert; `db.denyActive`, merge rule `drive.mergeDenyRecord` — later
  event wins, tie → revoked). The ONLY undeny path is a sheet re-add
  (`planSheetMirror.unDenyKeys`); everything else still only grows the set.
- The sheet mirrors BOTH ways (v1.0.10), judged by PRESENCE on every successful parse
  (never diff-vs-baseline — a baseline forgets, and a stale Drive-doc merge would
  resurrect deleted content forever): LIVE sheet-backed records missing from the sheet
  are deleted WITH a 'sheet-mirror' tombstone (docs can't resurrect them); denied keys
  the sheet LISTS are revived (unless our own row-removal is still queued). PENDING
  records are NOT sheet-backed (their row appears at approval) — mirroring them would
  kill shares before the parent saw them (real bug, audit-caught). Unsubscribed-channel
  content is orphan-GC'd on every mirror pass. The SAFETY VALVE (>max(10, 5%)
  deletions at once) parks everything behind a parent decision in the sources tab;
  "ignore" remembers the divergence signature so the SAME divergence never re-alerts.
  In-app deletes of sheet-backed entities enqueue ROW-REMOVAL ops (sheetwrite
  delvideo/delchannel; channel rows matched via the handleMap cache); a channel with a
  queued delete is never re-subscribed from its lingering row. Single-video deletions
  from a CHANNEL are NOT representable in the sheet — they stay per-account.
- `sortKey` depends only on the row's own ordinal/timestamps — appending sheet rows never renumbers
  existing ones (test-pinned). Sheet display order is REVERSED via DESC cursor (last row shown first).
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
- Scoping (decision 20): `lib:<fnv1a(sheet)>` = shared per input-sheet; `prof:<id>` = personal.
  A profile with NO sheet gets `lib:p:<profileId>`. CONNECTING or CHANGING a sheet therefore
  CHANGES the scope — always route it through `adoptLibraryScope()` (→ `db.moveScope`, which
  moves videos + channel subs and UNIONS tombstones) and register the moved items as sheet
  rows. Skipping the migration silently orphans everything the parent added (v1.0.17 fix);
  the queued rows are also what stops the presence-mirror from tombstoning them.

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
- The API key ships via GITIGNORED [www/js/keys.local.js](www/js/keys.local.js) (repo is PUBLIC —
  never commit it; never serialize it into the Drive DB/Sheet). Restrict it by API only — an
  Android-app restriction breaks CapacitorHttp requests.
- No-bundler import layer order (a cycle = undefined bindings at runtime, not a build error):
  `platform → store/classify/csv/util → db → plan/sync2/drive → ui/* → app.js`. `nav.js` never
  imports views. `tour.js` imports NOTHING (pure data + pure functions), so it is safe
  anywhere in the order.

## Verification workflow

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
- **v1.0.25 overview: [docs/V1025.md](docs/V1025.md)** — the five features of this release
  in one place, including which three ALREADY EXISTED and were broken, and the two bugs
  that browser verification caught while the suite was green. The per-feature invariants
  stay below; that file is the map.
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
  - **A PER-PROFILE LOCK OPENS A HOLE, closed in the same release.** The lock contains
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
  - `sheetwrite.interpretSheetResponse` is the ONE gate for EVERY `values.get` read,
    including the one inside `doFlush` — hand-rolling that one read let an error envelope
    or a sign-in page pass as an empty sheet, so no row matched for deletion, every append
    was re-appended, and `clearFlushed` then dropped the unsent `delvideo` ops whose rows
    were still in the sheet: the next mirror pass read that presence as a re-add and
    resurrected the deleted videos everywhere. An unreadable read ABORTS the flush with
    the queue intact. An error envelope may ride along only with ACTUAL ROWS.
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
