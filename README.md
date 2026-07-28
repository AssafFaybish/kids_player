# הסרטונים שלי — Kids Player

A child-safe, parent-curated video player for a 4-year-old on an Android tablet.
Plays **YouTube links** (via the official IFrame player, on `youtube-nocookie.com`) and
**direct video files** (e.g. `.mp4` on Google Drive) — **inside the app**, with no navigation to
youtube.com, no recommendations grid, and the minimum possible YouTube chrome.

Built as a plain HTML/CSS/JS web app wrapped into an Android APK with **Capacitor**.

> **Maintainers / future development:** read [DEVELOPMENT.md](DEVELOPMENT.md) — it documents the
> architecture, data model, storage keys, each module, the APK build, and known gotchas, so you can
> continue from where this stands.

## Parts

- **Profiles** — on launch you pick a profile ("מי צופה?") or create one (a name + an animal
  avatar). Each profile has its **own separate video list** (and its own remote source) stored on the
  tablet. Tap the profile chip in the gallery header to switch profiles. A parent can delete the
  current profile from the parent screen. An existing pre-profiles list is migrated automatically into
  a profile named "שלי".
- **Kids screen** — a paginated 3×5 grid (15 per page) of big tappable thumbnails. Tap → the video
  plays large at the top with only **Play/Pause + Fullscreen** (volume is the tablet's hardware
  buttons); when it ends, it returns to the gallery automatically.
- **Parent screen** — reached via the **🔒 הורים** button + a 4-digit PIN (shared across profiles).
  Curate the active profile's list by **pasting links**, or by pointing it at a **remote file** (a
  shared Google Sheet) you edit from anywhere.

## Requirements

- Node.js 18+
- JDK 17 and the Android SDK (for building the APK). Android Studio is the easiest way to get both.

## Quick start (web preview — UI only)

Native features (blocking youtube.com, real fullscreen, no-CORS fetch, file download/cache,
autoplay-with-sound) only work in the APK. For fast UI iteration you can still open the web app:

```bash
npm run serve       # always serves at http://localhost:5173 (fixed port)
```

Then open **http://localhost:5173** in a browser — the address and port never change (the server
refuses to start on another port rather than switching). Use `localhost` (not a `file://` path) so ES
modules and WebCrypto work. The server also sends `Cache-Control: no-store`, so a normal refresh
always loads the latest code.

To get a tap-to-open **app icon on the tablet**, package the APK (below) — that's the robust path
(self-contained, no server). See [DEVELOPMENT.md §10](DEVELOPMENT.md) for the PWA "Add to Home Screen"
alternative and its HTTPS requirement.

## Build the Android app

```bash
npm install
npx cap add android            # generates the android/ project (first time only)
# apply the native tweaks — see "Native tweaks" below
npx cap copy android           # copy www/ into the native project (after every web change)
cd android && ./gradlew assembleDebug
# install on a connected tablet:
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or `npx cap run android` to build + launch on a connected device/emulator, and `npx cap open android`
to open the project in Android Studio.

## Native tweaks (required)

Capacitor's default WebView *opens the external browser* when the child taps the YouTube logo, and
HTML5 fullscreen is a no-op by default. After `npx cap add android`, copy the reference file
[`native-reference/MainActivity.java`](native-reference/MainActivity.java) over the generated
`android/app/src/main/java/com/assaf/kidsplayer/MainActivity.java` (keep the top `package` line
matching your `appId`). It:

- swallows navigations to `youtube.com` / `youtu.be` so the app never leaves to YouTube (the embed,
  which loads from `youtube-nocookie.com` as a subframe, still plays);
- installs a `WebChromeClient` that makes real fullscreen work and blocks pop-up windows.

Re-apply this file if you ever delete and re-add the `android/` project.

## Using the parent screen

1. Open the app and tap the small **🔒 הורים** (parents) button in the top corner of the gallery.
2. First time: set a 4-digit PIN (entered twice). Later: enter the PIN to get in. The PIN — not
   hiding the button — is what keeps the child out.
3. **Manual mode:** paste a YouTube link or a direct video-file link, press *הוספה*. Optionally set a
   display name and (for video files) a thumbnail image URL.
4. **Remote mode:** paste the URL of your list file and press *שמירה* / *רענון עכשיו*. The app then
   mirrors that file — one link per line (`#` lines ignored; `link,name,thumb` also supported). The
   order in the file is the display order. The list refreshes on every app launch/return and via the
   refresh button.

### Recommended remote file: a shared Google Sheet

1. Create a Google **Sheet** (not an Excel/`.xlsx` file — that's binary and won't parse).
2. Put **one YouTube link per row in column A** (optionally a name in B and a thumbnail URL in C).
3. **Share → Anyone with the link → Viewer.**
4. Copy the normal sheet link (`https://docs.google.com/spreadsheets/d/<ID>/edit...`) and paste it
   into the app. The app converts it to a CSV export automatically.

Edits propagate within ~1–5 minutes (Google's cache). A published `...pub?output=csv` URL or any
plain-text/CSV URL also works.

## Known limitations (honest)

- **YouTube ads** on monetized videos cannot be blocked by any compliant method. Curate ad-light
  channels.
- **YouTube end cards** may flash for a second before the near-end auto-return fires.
- **Google Drive** streaming of large files is unreliable; the app falls back to downloading the file
  once and caching it (first play is slower, uses device storage). Direct hosts (Dropbox `?raw=1`, a
  web server/CDN) stream instantly.
- Reliable file format: **mp4 (H.264/AAC)**. Other formats depend on the device codecs.

## Lock the child in (recommended)

Enable Android **App pinning** (Settings → Security → App pinning), then pin this app from Recents so
a 4-year-old cannot leave it.

## Project layout

```
www/                 the web app (this is what runs)
  index.html         shell: gallery / watch / PIN / parent views (RTL Hebrew)
  css/styles.css
  js/                platform, store, pin, media, player, sync, app
capacitor.config.json
native-reference/    MainActivity.java to copy into the generated android/ project
```
# kids_player
# kids_player
# kids_player
# kids_player
