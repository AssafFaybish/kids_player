# ARCHITECTURE.md — module map, data model, and flows

Companion to [CLAUDE.md](CLAUDE.md) (invariants) and [DEVELOPMENT.md](DEVELOPMENT.md)
(original architecture + overhaul addendum §14-§18). This file answers "where does X
live and how does data flow".

## Module map (www/js/)

| Module | Role | Depends on |
|---|---|---|
| `platform.js` | Capacitor shim: Preferences, HTTP (`httpRequest` never throws on status), Filesystem (DATA + EXTERNAL), app lifecycle, back button, exitApp | — |
| `util.js` | fnv1a, canonicalSheetKey/libraryIdFor, mapWithConcurrency | — |
| `csv.js` | RFC4180 parser (quoted Hebrew titles with commas survive) | — |
| `classify.js` | **THE safety boundary**: classifyLink, parseChannelRef, classifySourceRow (watch-link-wins), stripTimeHints, classifyFromSharedText | — |
| `order.js` | sortKeyFor domains (channel=publishedAt / sheet=BASE+rowIndex / manual=above-all), compareForDisplay | — |
| `normalize.js` | normalizeTitle (Hebrew: niqqud/bidi/emoji), mergeVideoRecord (survivor policy) | — |
| `store.js` | legacy Preferences layer (profiles, PIN key, oEmbed title, thumb candidates hq-first); re-exports classify | platform, classify |
| `db.js` | IndexedDB I/O ONLY (no business logic) — see schema below | — |
| `migrate.js` | one-time resumable Preferences→IDB migration (never deletes the legacy blob) | platform, db, order, util |
| `plan.js` | PURE sync brain: planMutations (merge/dedupe/deny/route/caps), planGifts (baseline-12 / incremental) | normalize, order |
| `sync2.js` | the staged pipeline (below); parseSourceSheet | csv, classify, plan, yt, db, quota |
| `yt.js` | Data API client: handle resolution (cached forever + HTML-scrape fallback), channels.list batched, playlistItems backfill, videos.list titles, RSS fetch, quota ledger | platform, keys, db, quota |
| `quota.js` | batchIds, quotaCostFor, planChannelFetch truth table, UU-derivation | — |
| `ytrss.js` | pure keyless parsers (never throw): Atom feed + channel-page logo extractor | — |
| `keys.js` / `keys.local.js` | API-key resolution; keys.local is GITIGNORED, ships in APK via cap copy | — |
| `gauth.js` | KidsGoogleAuth JS side; access token in memory only (~55min) | — |
| `sheetwrite.js` | v1.0.6 sheet write-back: manual adds/channels/approved shares APPEND to the input sheet (durable queue in meta, non-interactive token, gid→tab-title resolution, permission errors surfaced) | platform, gauth, db |
| `drive.js` | Drive DB per-LIBRARY: serializeDb/parseDb/mergeDbFiles (pure CRDT) + push/pull I/O | platform, gauth, normalize, db |
| `snapshot.js` | full-state export/import (import re-classifies EVERYTHING) | classify, normalize, order, db |
| `share.js` | share-intent JS side: listener→drain→queue; v1.0.7 interactive PIN+confirm flow (videos AND channels) with silent-pending fallback | classify, normalize, order, platform, db |
| `search.js` | PURE home-search ranking: normalized exact/starts/word/substring tiers | normalize |
| `dataver.js` | one-shot data migrations after an app update (meta dataVersion; pure pendingSteps) | db, store |
| `spatial.js` | PURE TV D-pad geometry: pickNextIndex / pickFirstIndex (no wrap, drift penalty) | — |
| `ui/dpad.js` | Android TV focus manager (v1.0.9): spatial nav over the active view, watch-view player mode via player.handleTvKey | spatial, nav, modal, player |
| `update.js` | GitHub-releases updater: compareVersions, checkForUpdate (throttled; honors `update.skip` on silent checks), downloadAndInstall (size-verified) | platform |
| `wake.js` | ref-counted keep-screen-on (KidsNative → KeepAwake → wakeLock → noop) | — |
| `player.js` | YT IFrame + `<video>` engines, shared HUD state machine, loadVideoById reuse path | media, classify, config, wake |
| `media.js` | Drive URL normalize, stream→download-cache, captureFrame | platform, store |
| `nav.js` | explicit view stack, hardware-back precedence (fullscreen→modal→view→pop→swallow), scroll restore | ui/modal |
| `ui/*` | modal (confirmKid/alertKid), pager, tiles (in app.js currently), confetti (CSS), sound (WebAudio synth), loading (4 scenes) | — |
| `app.js` | boot + all views (connect/profiles/folders home/folder/watch/pin/parent) + launch update prompt + attention dots + wiring — the candidate for a future views/ split | everything above |
| `pin.js` | SHA-256 parent PIN | platform |
| `sync.js` | LEGACY remote-mirror sync — only `resolveListUrl` and `parseList` still used (tests + sheet URL resolution) | platform, csv, store |

Native (android/, canonical copies in native-reference/): `MainActivity.java`
(YouTube-nav blocking, real fullscreen, popups, share onNewIntent),
`KidsNativePlugin.java` (keepAwake, share inbox, APK installer),
`GoogleAuthPlugin.java` (AuthorizationClient drive.file).
`release/android-release.gradle` = versioning + signing + play-services dep + `.dev` debug suffix.

## IndexedDB schema (`kidsplayer` v1)

| Store | keyPath | Notes |
|---|---|---|
| `videos` | `[scopeId, key]` | scopeId: `lib:<fnv1a(sheetKey)>` (shared per input sheet) or `prof:<profileId>` (personal). Indexes: by_folder_sort `[scope,folder,sortKey]`, by_state, by_channel_title, by_key. Pending rows live in folder `'~pending'` + `homeFolderId`. |
| `profileVideoState` | `[profileId, key]` | gift state per CHILD: `{giftRank}` XOR `{unwrappedAt}`. by_gift index is SPARSE (deleting giftRank removes from index → the "חדשים" folder is a pure range scan). |
| `channels` | `channelId` | global metadata + backfillCursor/backfillDone/lastRssCheckedAt |
| `libraryChannels` | `[libraryId, channelId]` | subscription + autoApprove toggle (+ source: sheet flag vs UI) |
| `thumbs` | `id` | Blob cache (legacy migrated thumbs + captured frames); by_lastUsed for LRU |
| `denylist` | `[scopeId, key]` | grow-only tombstones = durable deletion |
| `sources` | `profileId` | `{sheetUrl, libraryId, sheetHash, shareIntent.requireApproval, defaultAutoApprove, caps…}` |
| `meta` | `id` | migration flag, sync timestamps, handleMap, quota:<date>, drive:{dbFileId…}, gift baselines, dedupe reports |
| `opLog` | autoInc | mutation ops (deny/undeny/unwrap) for future merge use |

Video record: `{scopeId,key,type,id,url,srcUrl,driveId,title,titleSource(api>rss>sheet>oembed),
normTitle,folderId,homeFolderId?,channelId,sortKey,publishedAt,rowIndex,origin(channel|sheet-row|
manual|share-intent|legacy),state(live|pending),addedAt,approvedAt,thumbId,thumbUrl,localPath,
mergedFrom?,updatedAt}` — ~400B, NO base64.

## Sync pipeline (sync2.syncLibrary — one in-flight per profile)

```
hydrate (views read IDB directly — the ONLY thing on the critical path)
└─ background: sheet GET → FNV-1a hash-skip → parseSourceSheet (video rows get ordinals;
   channels rows carry auto/manual flag) → resolve channels (handle cache → API → HTML scrape)
   → channel meta batched (1 unit/50) → per channel planChannelFetch:
        rss (free, latest 15, etag) | backfill (resumable cursor, 40-page budget, quota soft-cap)
   → planMutations (PURE: key-merge, intra-channel title dedupe, deny drop, pending routing,
     caps; quarantine on first post-migration sync) → putVideos (chunked)
   → titles for still-untitled loose links (videos.list 50/unit or oEmbed conc-6)
   → planProfileGifts (baseline newest-12 once per profile+library, then incremental)
   → meta bookkeeping → (drive.schedulePush if enabled)
```

## Player HUD state machine

States via one class `.hud-on` on `#player-wrap`: HIDDEN / VISIBLE(3s timer) / PINNED
(paused or dragging). `reveal()` is the single timer entry point. Any pointerdown in the
wrap (capture) records `wasVisible` then reveals. Shield pointerup: double-tap(<260ms)
= ±10s seek; single tap after 280ms = togglePlay ONLY IF wasVisible && center-50%.
⛶ + the seek bar live inside the wrap and are the ONLY pointer-interactive parts of the
HUD bar. 🏠 sits OUTSIDE the player in `.watch-top` (top-right; v1.0.2 user request) —
going home requires exiting fullscreen first. Tapping any video tile calls
`enterPlayerFullscreen()` synchronously inside the tap gesture (auto-fullscreen);
exiting fullscreen (back / ⛶) lands on the watch page. The app rotates freely
(no screenOrientation lock since v1.0.2); narrow-width CSS lives in the 560px media query.

## Cross-device Drive model (decision 20)

One Drive JSON file per Google account, tagged appProperties{kpApp} (searchable after
reinstall). Document: `{profiles, libraries:{<libId|profScope>: {sheetUrl, videos(no
localPath/thumbId), denylist, channels(no cursor), libraryChannels}}, profileState:{pid:
{key:{unwrappedAt|giftRank}}}, profileSources:{pid:{sheetUrl,updatedAt}}}`. profileSources
(v1.0.4, additive) lets a fresh device rebuild each restored profile's sources record —
without it a restored profile pointed at an empty `lib:p:` library. mergeDbFiles is
commutative+idempotent: video union by key via mergeVideoRecord, deny UNION (denied never
travels), LWW-by-updatedAt for profiles/channel toggles/profileSources, unwrappedAt=min.
Push: version-probe → merge-if-changed → PATCH (multipart/media with explicit
Content-Type). Pull (v1.0.4) also merges doc.profiles into the local Preferences list
(union by id, local wins) and applies unwrappedAt states for EVERY profile in the doc —
the first-launch connect screen (app.js `view-connect`, one-time via `gauth.introDone`)
rides this to restore a whole device.

## Update flow (F14)

`releases/latest` of UPDATE_REPO → pickApkAsset(`kids-player-<tag>.apk`) → numeric
compare vs App.getInfo().version → parent panel shows/downloads (EXTERNAL/updates/,
mkdir first, size check) → KidsNative.installApk (FileProvider `app_updates` path).
Launch check: +4s, 1h throttle (was 6h — a release published right after a device's
check stayed invisible for hours). Since v1.0.4 an available update PROMPTS (never over
watch/pin/parent/connect/loading): accept = PIN → what's-new → download. ONLY the
explicit "לא עכשיו" button writes `update.skip:<version>` (askKid distinguishes it from
a scrim-tap/back dismiss — an accidental dismiss re-offers on the next home entry;
field bug: a child's stray tap used to silence the prompt for the whole version). The
red gate dot and the About tab keep offering a skipped version. Same signing key or
Android refuses.
