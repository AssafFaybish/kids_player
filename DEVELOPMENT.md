# Kids Player — Development & Maintenance Guide

This is the handoff/reference doc. Read this to understand the app and continue development from
where it stands. For end-user setup see [README.md](README.md).

---

## 1. What this is

A child-safe, parent-curated video player for a 4-year-old on an Android tablet. It plays **YouTube
links** (official IFrame player on `youtube-nocookie.com`) and **direct video files** (e.g. `.mp4` on
Google Drive) **inside the app**, with no navigation to youtube.com, no recommendations/related grid,
and the minimum possible player chrome. Built as a **plain HTML/CSS/JS** web app, wrapped into an
Android **APK via Capacitor**.

Design principle: the web app is fully functional on its own; Capacitor only adds the native
behaviors a browser can't do (block youtube.com navigation, real fullscreen, CORS-free fetch, file
download/cache, durable storage).

## 2. Current status

| Area | Status |
|---|---|
| Web app (all features) | ✅ Done, verified in browser |
| Profiles (multi-user) | ✅ Done |
| Remote list sync (Google Sheet / Drive / CSV) | ✅ Done |
| YouTube + direct-file players | ✅ Done |
| Native code applied + compiled into the APK | ✅ Done |
| Android **APK build** | ✅ Built → `android/app/build/outputs/apk/debug/app-debug.apk` (~3.6 MB) |
| Automated tests | ✅ `npm test` (node:test) — 7 passing |

**Build env used:** JDK 17 (`/opt/homebrew/opt/openjdk@17`), Android SDK at
`~/Library/Android/sdk`, `compileSdk/targetSdk = 35` (set in `android/variables.gradle`, since
android-34 isn't installed). **Next step:** install the APK on the tablet (§10) — that delivers the
"tap an icon → app opens" behavior.

## 3. Run & develop

The dev server serves the web app and (for browser testing only) proxies remote lists and disables
caching so you never get stale code.

```bash
cd /Users/assaf.faybish/repository/kids_player
npm run serve      # → http://localhost:5173   (Node 18+; uses global fetch)
```

- **Fixed URL / port:** always **http://localhost:5173**. The port is hard-set in
  [dev-server.mjs](dev-server.mjs) and the server **refuses to start on a different port** (it errors
  on conflict instead of silently switching), so the address never changes. (Override only via
  `PORT=xxxx npm run serve` if ever needed.)
- After changing code, just refresh the browser (the server sends `Cache-Control: no-store`). If you
  ever see stale behavior, hard-refresh once: `Cmd+Shift+R`.
- The app's **own origin inside the APK is always `https://localhost`** (set by
  `server.androidScheme` in `capacitor.config.json`) — also fixed and never changes.

## 4. File map

```
www/
  index.html            6 views: #view-profiles, #view-create-profile, #view-gallery,
                        #view-watch, #view-pin, #view-parent (RTL Hebrew)
  css/styles.css        kid-friendly RTL styles; big tap targets
  manifest.webmanifest  PWA manifest (name/icon/standalone) — for "Add to Home Screen" & branding
  assets/icon.svg       app icon
  js/
    platform.js         Capacitor shim + browser fallbacks (see §6)
    store.js            data model, link classifier, YouTube helpers, PROFILES + migration,
                        per-profile persistence, listForDisplay, export/import
    pin.js              parent PIN (SHA-256 via WebCrypto; djb2 fallback). Global (shared across profiles)
    media.js            direct-file playback: Drive URL normalize, stream→download+cache, frame-capture, clearCache
    player.js           playItem() dispatch: YouTube IFrame OR <video>; custom controls; auto-return
    sync.js             remote list: resolveListUrl(), parseList(), syncFromRemote() (mirror)
    app.js              views/routing, profiles UI, gallery+pagination, watch view, PIN UI, parent screen, init()
dev-server.mjs          local dev server (static no-cache + /__proxy) — browser testing only
capacitor.config.json   appId, webDir, androidScheme:https
native-reference/MainActivity.java   native tweaks to copy into android/ after `cap add android`
```

## 5. Data model & storage

All state is local (no backend). Stored via `@capacitor/preferences` on device, `localStorage` in a
browser (same keys, abstracted in `platform.js`).

| Key | Value |
|---|---|
| `profiles` | `[{ id, name, avatar (emoji), color (hex) }]` |
| `activeProfile` | id of the currently selected profile (also cached in-memory in `store.js`) |
| `videos:<profileId>` | that profile's list — array of items (below) |
| `source:<profileId>` | that profile's list source — `{ mode: 'manual' \| 'remote', url }` |
| `pin` | SHA-256 hash of the 4-digit parent PIN (**global**, one for all profiles) |

**Item shapes** (produced by `classifyLink` in `store.js`):
- YouTube: `{ type:'youtube', id, key:'yt:<id>', srcUrl, title, thumb, addedAt }`
- File: `{ type:'file', url, srcUrl, driveId?, key:'file:<url>'|'file:drive:<id>', title, thumb, localPath?, addedAt }`

**Ordering** (`listForDisplay`): manual mode = newest `addedAt` first; remote mode = file order (as
parsed). **Migration:** `migrateLegacyIfNeeded()` folds any pre-profiles `videos`/`source` into a new
profile named "שלי" on first run, then removes the legacy keys.

## 6. Platform shim (`platform.js`)

Detects native vs browser and routes accordingly:
- **Preferences** → Capacitor Preferences (native) / `localStorage` (browser).
- **HTTP** (`httpGetText`/`httpGetJson`) → CapacitorHttp (native, **CORS-exempt**). In a browser:
  direct `fetch` → same-origin dev proxy `/__proxy?url=` (from `dev-server.mjs`) → public CORS proxies
  (corsproxy.io, allorigins) as last resort. **The APK never needs the proxies.**
- **Filesystem** → download/cache/convertFileSrc (native only; browser is a no-op).
- **App resume** → `App.appStateChange` (native) / `visibilitychange` (browser).

## 7. Players (`player.js`)

`playItem(item, host, { onExit, onStatus, onThumb })` renders into `#player-host`. Key invariant:
**`stop()` only tears the player down; it never navigates.** "Return to gallery" happens only on true
end (`finish()`), via the near-end timer / `ended` / error — this is what fixed the "next video plays
behind the scenes" bug when switching videos.

- **YouTube:** `YT.Player` with `host: youtube-nocookie.com`, `playerVars: { rel:0, iv_load_policy:3,
  disablekb:1, playsinline:1, fs:0, controls:0, autoplay:1, enablejsapi:1, origin }`. `controls:0`
  hides YouTube's entire bar; we draw our own **Play/Pause** (`#ctl-play`) + **Fullscreen** (`#ctl-fs`)
  and a transparent **`#tap-shield`** over the iframe (blocks the "Watch on YouTube" overlay/end-cards;
  tap = play/pause). On ready: `unMute()` + `setVolume(100)` (volume is the device's hardware buttons)
  + `unloadModule('captions')`. **Near-end timer** exits ~1.5s before the end to dodge the end-screen
  recommendations (can't be removed via the API).
- **Direct file:** `<video controls=false autoplay playsinline volume=1>`, custom controls, tap-shield.
  **Hybrid:** try streaming `item.url`; on `error`, `downloadAndCache()` (Drive uses the
  `usercontent…&confirm=t` URL) then play the local copy (also enables offline).

Fullscreen requests `#player-wrap`. In the APK the custom `WebChromeClient` in `MainActivity.java`
makes HTML5 fullscreen actually work (Capacitor's default is a no-op) and blocks pop-up windows.

## 8. Remote list sync (`sync.js`)

- `resolveListUrl(url)` makes a pasted link fetchable: a Google **Sheet** `/edit` link → CSV export
  (`/export?format=csv&gid=…`); a Google **Drive** file link → `uc?export=download`; already-CSV or
  other URLs pass through. (Sheet must be shared "Anyone with the link: Viewer".)
- `parseList(text)` accepts plain text (one link per line, `#` comments), CSV (`link,title,thumb`), or
  a JSON array. `classifyLink` keeps only valid YouTube IDs / https video URLs → **the safety boundary**
  (a tampered file can't inject anything else).
- `syncFromRemote()` **mirrors** the file: rebuild the active profile's list to match exactly (add
  new, drop removed, preserve file order), keeping any downloaded `localPath`. Runs on profile
  activation, on app resume, and via "Refresh now". Offline/failure → keep last cached list.
- **Not supported: `.xlsx` (Excel).** It's a binary file; use a Google Sheet or plain text/CSV.

## 9. Native / APK build

Web app stays plain HTML/JS; only `MainActivity.java` is custom.

```bash
# one-time prerequisites: JDK 17 + Android SDK (Android Studio is easiest)
#   e.g. `brew install --cask temurin@17` and set JAVA_HOME to it
#   export ANDROID_HOME="$HOME/Library/Android/sdk"
npm install
npx cap add android                 # generates android/ (first time)
# copy native-reference/MainActivity.java over
#   android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java  (keep the package line)
npx cap copy android                # after every web change
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
# or: npx cap run android   /   npx cap open android
```

`MainActivity.java` does two things Capacitor doesn't: (1) swallows navigations to
`youtube.com`/`youtu.be` (the embed still loads because it's a subframe on `youtube-nocookie.com`);
(2) a `WebChromeClient` that enables real fullscreen and blocks pop-ups.

## 10. App icon on the tablet (tap → app opens)

Getting a home-screen icon that opens the app requires **packaging**, not just a URL:

- **APK (recommended, robust):** the built app installs as a real app with its own icon; tapping it
  launches our page in a full-screen WebView automatically — **no browser UI, no server, offline
  shell**. This is the intended path (sideload only; not published to any store).
  **Launcher icon is set** (kid-friendly gradient + play button + sparkles). To regenerate: edit the
  sources `assets/icon-only.svg` / `icon-foreground.svg` / `icon-background.svg`, rasterize to PNG
  (`cd assets && for n in icon-only icon-foreground icon-background; do qlmanage -t -s 1024 -o . $n.svg && mv $n.svg.png $n.png; done`),
  run `npx @capacitor/assets generate --android`, then in
  `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher*.xml` remove the `<inset>` on `<background>`
  (keep the gradient full-bleed), and `npm run android:build`. (`@capacitor/assets` is used one-off via
  `npx`; it's not a saved dependency because its `sharp` install is finicky.)
- **PWA "Add to Home Screen" (interim):** [`manifest.webmanifest`](www/manifest.webmanifest) is
  included (standalone, landscape, icon). Chrome can "Add to Home Screen" to get an icon that opens
  the app in standalone mode — **but** the tablet must load the page over **HTTPS or localhost**
  (secure context). Serving from the Mac dev server over `http://<lan-ip>:5173` is **not** a secure
  context, so PWA install won't work from there. Practically: use the APK, or host the `www/` folder
  on any HTTPS static host and install from there.

## 11. Known limitations (by design / platform)

- **YouTube ads** on monetized videos cannot be blocked by any compliant method.
- **YouTube end cards** may flash briefly before the near-end auto-return fires.
- **Google Drive** streaming of large files is unreliable → the hybrid downloads once (slower first
  play, uses storage). Direct hosts (Dropbox `?raw=1`, a web server/CDN) stream instantly.
- Reliable video format: **mp4 (H.264/AAC)**; others depend on device codecs.
- Remote sync is near-real-time (next launch/resume/refresh; a published Sheet can lag ~1–5 min).

## 12. Gotchas learned (don't re-discover these)

- **CORS:** a plain browser blocks `fetch` to Google. The APK's CapacitorHttp is CORS-exempt; the dev
  server's `/__proxy` covers browser testing. Don't "fix" this by weakening the APK path.
- **Caching:** ES-module caching caused "old code" confusion. The dev server sends `no-store`; keep it.
- **`fs=0` + `controls=0`:** removing YouTube chrome is only possible all-or-nothing; individual
  buttons can't be toggled. Cleanliness = params + tap-shield + native nav-block.
- **Don't call `onExit` from `stop()`** — only from `finish()` (see §7), or switching videos breaks.

## 13. Extension ideas (good next tasks)

- Automated tests (unit: `classifyLink`, `driveFileId`, `resolveListUrl`, `parseList`, ordering,
  migration; integration via the dev server). No test harness exists yet — add one (e.g. `node:test`).
- Reorder profiles / drag to reorder the manual list.
- Avatars from a real photo (camera/file) in addition to emoji.
- Optional per-profile PIN or a "kid can't create/delete profiles" lock.
- Watch history / "continue watching"; simple search in the parent screen.
- Set the Android launcher icon + splash via `@capacitor/assets`.
