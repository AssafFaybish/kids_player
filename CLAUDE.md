# CLAUDE.md — kids_player

Child-safe, parent-curated YouTube/video player for a ~5-year-old on an Android tablet.
**Vanilla JS ES modules (NO framework, NO bundler) + Capacitor 6.** UI is RTL Hebrew
(`<html dir="rtl">`). `www/` is the whole app; `android/` is committed and carries
hand-maintained native code. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the module map
and data model before touching sync/db/player code.

## Commands

```bash
npm run serve        # dev server http://localhost:5173 (fixed port, no-store, /__proxy CORS helper)
npm test             # node:test suite (~84 tests) — MUST stay green; pure logic only, no DOM
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
- HUD bar CONTAINERS are `pointer-events:none` ALWAYS (only buttons/seek take events, only while
  `.hud-on`) — interactive bars swallow the center-tap/double-tap on small players.
- Tap model: hidden→tap only reveals; visible→center-50% tap toggles play. Paused pins the HUD.
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
- Deletion = atomic delete + deny-list tombstone. The deny-list only ever GROWS (union in every
  merge path) — that's what makes deletion durable across syncs and devices.
- `sortKey` depends only on the row's own ordinal/timestamps — appending sheet rows never renumbers
  existing ones (test-pinned). Sheet display order is REVERSED via DESC cursor (last row shown first).
- `planMutations` twice over identical inputs ⇒ empty diff (the churn-free test is sacred).
- Gift state lives in `profileVideoState`, NOT on video records (siblings share libraries);
  `unwrappedAt` is forever (min-merged everywhere).
- Scoping (decision 20): `lib:<fnv1a(sheet)>` = shared per input-sheet; `prof:<id>` = personal.

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
  imports views.

## Verification workflow

1. `npm test` after any logic change.
2. Browser (`npm run serve`): full UI flows; IndexedDB migration works in-browser; sync runs against
   the real sheet through `/__proxy`. Escape = hardware-back stand-in. Fullscreen is DENIED in
   embedded panes — not an app bug.
3. Device (`npm run apk` → the `.dev` app): back button, native fullscreen, keep-awake,
   share-from-YouTube, Drive sign-in, updater. NEVER install a debug build over the release app.

## Current state pointers

- All 14 overhaul features are implemented (see git log stages 0-7 + fix commits).
- v1.0.4: launch update PROMPT (decline stores `update.skip` per version — the throttled
  check path honors it); one-time Google-connect screen before profiles (`gauth.introDone`
  pref; restores profiles + per-profile sheet via the Drive doc's additive `profileSources`);
  folder tiles restyled + keyless channel-logo scrape (`yt.scrapeChannelLogo`, weekly retry);
  real exit via `KidsNative.exitApp`; red attention dots (`gate-dot` = pending>0 or update
  ready, `settings-dot` + red pending badge inside the parent screen).
- v1.0.5: in-place delete from the watch page (`watch-delete` → parameterized PIN gate
  `startPin(mode, {onSuccess, replace, title})` — replace:true so back never lands on a
  torn-down player → confirm → deleteVideo in EVERY scope holding the key → home); share
  the app from parent settings (`KidsNative.shareText` chooser → Web Share → clipboard;
  message built by pure `update.buildAppShareMessage`, direct assetUrl or releases page).
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
- The updater reads `devfassaf/kids_player` releases/latest (`UPDATE_REPO` in update.js);
  asset naming: `kids-player-v<X.Y.Z>.apk`.
- Known unaudited item: `media.js` `videos/` cache may need the same mkdir-before-downloadFile fix.
- Push access: the local `gh` account may be READ-only on `devfassaf/kids_player` → push a branch to
  the `AssafFaybish/kids_player` fork (`git push fork <branch>`) and open a PR.
