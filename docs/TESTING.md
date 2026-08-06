# How this app is tested — and what the tests cannot see

`npm test` is ~402 node tests and it is the fastest, cheapest signal in the project. It is
also **not sufficient**, and this file exists because that gap has bitten repeatedly: in the
v1.0.25/v1.0.26 work, **four real bugs shipped past a fully green suite** and were caught by
driving the app in a browser.

Read this before adding a feature, and before believing a green run.

---

## 1. What the suite covers

| Layer | Where | Notes |
|---|---|---|
| Pure decisions | `plan.js`, `playerlogic.js`, `normalize.js`, `quota.js`, `settings.js`, `order.js`, `search.js`, `spatial.js`, `tour.js`, `update.js` | The real logic. If a rule matters, it belongs here as a pure function. |
| Parsers | `classify.js`, `csv.js`, `ytrss.js`, `sync2.parseSourceRows` | Fed the exact strings the field produces. |
| CRDT merges | `drive.js`, `settings.js` | Commutativity **and** idempotence, always. |
| Wiring | `invariants.test.mjs` | Source-level pins: the tested core is the LIVE one. |

**No DOM. No IndexedDB. No network.** There is no jsdom and no `fake-indexeddb`, deliberately
— the suite stays fast and dependency-free. The cost is section 2.

### The two rules for a new test

1. **Extract the decision into a pure function**, then test the function. If a rule lives
   inline in `app.js`, it is untestable and it will drift.
2. **Plant the regression and watch the test fail** before you keep it. This repo has shipped
   guards that could never fail — a `walk()` that matched zero files, patterns that matched
   nothing this codebase can write, an import scanner blind to `await import()`. A guard that
   has not been proven to fail is decoration.

### Wiring pins (`invariants.test.mjs`)

A pure function nobody calls is worthless, so the suite also pins that production uses it.
The pattern (see `nav.test.mjs`'s `handleBack` test):

```js
const app = MODULES.get('www/js/app.js');
const fn  = app.slice(app.indexOf('async function onVideoFinished('));
assert.match(fn, /planAutoplay\(/, 'app.js re-implements the decision inline');
```

Match **call shapes**, never prose — several of these tests describe the bug they prevent in
a comment that names the very function or endpoint being banned.

---

## 2. What the suite CANNOT see

Everything below is invisible to `npm test`. All four bugs listed here were green.

| Blind spot | Real bug it hid |
|---|---|
| **Module wiring at runtime** | `syncLibrary` joined a forced run when the running one was also forced. Its own comment said the opposite. Adding a channel imported nothing and the approval dialog never appeared. |
| **Migration / upgrade paths** | The PIN migration never ran: `getSetting(scope, name, undefined)` triggers the `fallback = null` default, so "never written" read as "already migrated". **Every pin test called `setPin()` first, so none took the lift branch.** A real install would have lost its parent gate. |
| **Real stored data** | The autoplay chain would have opened WRAPPED GIFTS — gift state lives per child *on the video*, so wrapped tiles exist inside channel folders, not only in 🎁. |
| **Cross-function state** | Selection preservation done by parameter looked right; `refreshAfterAdd` rebuilt the list a beat later and cleared the ticks straight back. |

**The pattern:** tests set up the NEW state and skip the branch that converts the OLD one.
When you add a feature that changes where something is stored, the migration branch is the
one with no coverage.

---

## 3. Browser verification (`npm run serve`)

The dev server is at `http://localhost:5173` (fixed port, no-store, `/__proxy` for CORS).

```bash
npm run serve
```

**Before you touch anything, check the blast radius.** The browser profile is a real
IndexedDB with real data:

```js
// in the console — is this sandbox connected to a real Drive / sheet?
(await (await import('/js/db.js')).getMeta('drive'))   // null ⇒ no backup, safe
```

If Drive or a sheet is connected, writes leave the machine. Prefer a **throwaway profile**
for anything destructive, and purge it afterwards.

- Escape stands in for the hardware back button.
- **Fullscreen is DENIED in embedded panes** — not an app bug.
- Modules are live: `await import('/js/plan.js')` gives you the same instance the app uses,
  so you can call pure helpers against real data.
- Leave the sandbox as you found it. Record the counts before you start.

---

## 4. Device checklist (`npm run apk` → the `.dev` app)

**Never install a debug build over the release app.** These cannot be verified any other way.

### Android intents and native APIs
- [ ] **Share a video from the YouTube app** → PIN → confirm → it appears, **and a toast at
      the bottom says what happened** (added / waiting for approval / why it failed). Since
      v1.0.26 no share route is silent: if nothing is added, the toast names the reason.
- [ ] Share a link that was **deleted before** → the toast must say so, not stay silent.
- [ ] Share a **playlist** from the YouTube app (v1.0.26).
- [ ] With TWO+ profiles, every share must **ask which profile first**.
- [ ] **Share a CHANNEL** → loading screen → the three-way dialog (`אישור הכל` / `אישור ידני` /
      `אחר כך`) with a real count. *(v1.0.25 rewrote this path; it does not exist in a browser.)*
- [ ] Share with **no profile active** (cold start) → lands on the profile picker, and the
      profile you tap is the destination — it must not ask twice.
- [ ] **Exit lock**: turn it on for one child → the OS pinning confirmation appears, HOME is
      contained, the exit button is hidden, exiting asks for the PIN.
- [ ] **Per-profile lock** (v1.0.25): with a locked child active, tapping the profile chip
      asks for the PIN. Switch to an UNLOCKED sibling → the device unpins and the exit button
      returns. Switch back → it re-pins. *(Both directions; the second one is the escape.)*
- [ ] **Parent-code recovery, device path** (v1.0.26) — NEVER RUN ON HARDWARE. On a device
      WITH a lock screen: "שכחתי את הקוד" must raise the system prompt; success goes straight
      to choosing a new code; cancelling must still offer the 24-hour wait.
- [ ] The same on a device with **no lock screen** → no prompt at all, straight to the wait.
- [ ] ⚠️ **With the exit lock ON (screen pinning)** — the open question. If the keyguard
      cannot appear under lock-task, the wait is the only route there and the UI must still
      reach it rather than dead-ending.
- [ ] Real fullscreen on tap, and 🏠 only after leaving fullscreen.
- [ ] Keep-awake during playback.
- [ ] **Physical power button mid-video** (v1.0.32): the soundtrack STOPS with the screen;
      screen back on → the video is waiting, PAUSED, at the same second — not gone, not
      restarted. Repeat with the exit lock ON: identical. *(The browser only simulates
      `visibilitychange`; the real button and lock-task interplay exist only on a device.)*
- [ ] **Picker exit button** (v1.0.32): with the kiosk armed for the last-used child,
      reach the profile picker (cold-start share is the honest route) → 🚪 must ask for
      the parent code before leaving. With the kiosk off: confirm → straight out.

### Cross-device (needs TWO devices on one Google account)
> Nothing here has ever been verified end to end. The merge logic and local storage are
> tested; **the full round trip is not.**
- [ ] Approve a video on device A → it appears on device B after a launch or a resume.
- [ ] Change the **parent PIN** on A → B opens with the new code.
- [ ] Toggle a per-child setting on A → B agrees.
- [ ] **Delete a profile on A → it stays deleted on B** (v1.0.25 tombstones), and does not
      reappear after several syncs.
- [ ] Add a channel on A → B gets it without duplicating its videos.

### Content sources
- [ ] Add a channel by **Hebrew @handle** (e.g. `@חלומותחסידיים`) — CORS blocks the keyless
      page scrape in a browser, so only a device proves this.
- [ ] **Add `@BARDAK613` from the tablet** (v1.0.32). The device's HTTP layer gets the
      MOBILE page (m.youtube.com), which has none of the desktop identity keys — v1.0.29–31
      all passed in a desktop browser and failed here. The channel must import its real
      videos (~97 long-form), not "הערוץ נוסף, אבל לא נמצאו בו סרטונים".
      **Any scrape-parsing fix must be probed against the mobile page variant.**
- [ ] Add a **playlist** link, `m.youtube.com` form (v1.0.26).
- [ ] Add a channel **and** a playlist of that same channel → one folder, no duplicates.
- [ ] **YouTube search on the device** (v1.0.33): a Hebrew query in the add tab returns
      results through the NATIVE CapacitorHttp POST (Dalvik UA — the live probes say the
      API is UA-safe, but the @BARDAK613 lesson makes device verification mandatory; a
      silently-dropped POST body would surface here as the network/parse message over
      working Wi-Fi). Suggestions appear in HEBREW (not ����), the chips filter, a video
      adds from the bubble ➕ and advances, a channel add reaches the three-way dialog,
      'עוד תוצאות' appends, and airplane mode shows the network message while the
      existing results stay.

### Playback
- [ ] **Continuous play** (v1.0.25): enable it for one child, let a video end → the countdown
      overlay appears and the next video starts without leaving the player. ✋ returns to the
      folder. With it OFF, a video ending returns to the folder as before.
- [ ] Continuous play must **stop** at the 🎁 folder and before a wrapped gift.
- [ ] **Resume playback** (v1.0.32): enable the setting, stop a video mid-way, force-close
      the app, reopen the video → it continues ~3s before the stop point, and the tile
      carries the red progress sliver. Let a video END → next opening starts at 0, no bar.
- [ ] **Channel logos offline** (v1.0.32): open the app once online, then again in airplane
      mode → the channel folders keep their pictures (served from the byte cache).
      *(CapacitorHttp's `responseType:'blob'` base64 answer is assumed from its docs — the
      first device run of the logo fetch is what proves it.)*
- [ ] TV: D-pad through the parent screens, OK toggles checkboxes.

---

## 5. Verifying each v1.0.25 / v1.0.26 / v1.0.32 feature

| Feature | Fastest honest check |
|---|---|
| Forced sync chains | Two overlapping forced `syncLibrary` calls must return **different** promises and run in series. Both must receive progress events. |
| Channel/share dialog | Add a channel **immediately after launch**, while the launch sync is still running — that window is what used to break it. |
| Pull before sync | `entryRefresh` awaits `maybePullDrive()` before `syncLibrary`; there must be exactly one pipeline. |
| Synced settings | `merge(A,B) === merge(B,A)` and idempotence, plus the doc round trip in `gdrive.test.mjs`. An older doc with no `settings` key must not wipe anything. |
| Continuous play | Seek to the end with `player.handleTvKey('fwd')` (~80ms apart — faster and YouTube reports a stale time). |
| Profile delete | Create a throwaway profile with content, delete it through the UI, then feed `mergeRestoredProfiles` a doc that still lists it. Nothing may come back. |
| Playlist source | The exact field URL, in an isolated profile. Check the folder title, the 🎵 chip and the video count. |
| Preview bubble | Tick two rows, preview a third, decide → **the ticks must survive**. |
| 30-day purge | Age one rejected record past the window in IndexedDB, run a sync, confirm it is gone, a tombstone exists with `reason: 'rejected-expired'`, and fresher rows survive. |
| PIN recovery | Request a reset, then age `pinRecoveryAt` back past 24h in Preferences. Check BOTH the PIN screen and the child's home — the banner is the actual safeguard. Restore the sandbox PIN afterwards. |
| Share feedback | `plan.shareOutcome` covers every reason `routeShare` can return (pinned). On a device, the toast is the diagnostic — read it before assuming the share was lost. |
| Channel-add waits | Add an already-synced channel: the dialog must appear in <300ms with ZERO loading flashes (defer:250). Then stage pending videos and answer each dialog button — every step must name itself, and the finishing screen must stream the sync's real labels. |
| Empty queue | Approve or reject the last waiting video **without leaving the tab** — the line must appear and the badge must clear on the same rebuild. |
| 20-char names | Create a profile with a 20-character name: the tile wraps to two lines and the picker stays aligned. Note `maxlength` does **not** bind a scripted `.value` — test the stored name, not the input. |
| Resume playback (v1.0.32) | Save at ~60s, reopen → `playbackState().time ≈ 57`. Seek into the tail with `player.handleTvKey('fwd')`, let it end → the position record is GONE, `unwrappedAt` intact, no tile bar. The position must never appear in a serialized Drive doc (`serializeStateEntry` is the pin). |
| Screen-off pause (v1.0.32) | In the browser: `Object.defineProperty(document,'hidden',{value:true,configurable:true})` + dispatch `visibilitychange` → `playbackState().playing === false`, same `time`, position banked. The invariants guard pins listener + order + no-`stop()`. |
| ערוצים חדשים (v1.0.32) | Plant a `libraryChannels` row with `addedAt: Date.now()`, no `decidedAt` → it renders in the new section with the ⚙️ button; answering the dialog (or an empty queue tap) stamps `decidedAt` and moves it. `planChannelSections` covers the clock-skew and legacy-row rules. |
| Logo byte cache (v1.0.32) | After one online render: the folder `<img>` src starts with `blob:` and `performance.getEntriesByType('resource')` shows ZERO new ggpht requests on re-render. The two traps are pinned pure: `logoFirstPaint` (warm memory never touches the network) and `planLogoDelivery` (a late fetch may not paint into a host that moved on — `#folder-logo-top` is shared). |
| Mobile channel resolve (v1.0.32) | `extractChannelIdFromHtml` against an m.youtube.com page body: decoy `"channelId"`s must lose to the RSS-alternate link / og:url / twitter:url. Probe fixes with a MOBILE UA — a desktop browser cannot reproduce the failure. |

---

## 6. Release verification

See [PUBLISHING.md](../PUBLISHING.md). The two that keep going wrong:

0. **A four-component version reaches nobody.** `parseVersion` reads three, so `1.0.26.1`
   compares EQUAL to an installed `1.0.26` and every app answers "up-to-date". Both release
   scripts now refuse one before building (`update.versionIsDeliverable`) — it had already
   happened four times, most recently to the release carrying the field-reported share fix.
1. **Every release needs BOTH APK names** — `kids-player-v<X.Y.Z>.apk` (humans + the
   updater's exact match) **and** `kids-player.apk` (the stable name the website button
   redirects to). v1.0.24 shipped only the first; v1.0.25 only the second.
   ```bash
   gh release view v<X.Y.Z> --repo devfassaf/kids_player --json assets -q '[.assets[].name]|join(", ")'
   ```
2. **Bump the version in its own PR, before building.** `release.sh` tags at main's HEAD, so
   building first makes the tag and the artifact disagree.

Release notes are parent-facing Hebrew and get de-noised by `update.extractReleaseNotes`
(12 lines, 160 chars, no markdown/URLs/PR refs). Check what a parent will actually see:

```bash
node -e "import('./www/js/update.js').then(m=>console.log(m.extractReleaseNotes(require('fs').readFileSync('/tmp/notes.txt','utf8')).join('\n')))"
```
