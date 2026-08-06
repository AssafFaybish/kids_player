// app.js — boot, global wiring, and (until the view split completes) the gallery,
// PIN and parent screens. Navigation goes through nav.js; dialogs through ui/modal.js.
import {
  loadItems, getSource, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId, fetchYouTubeTitle,
  profileNameExists, profileNameConflict, duplicateProfileNames
} from './store.js';
import * as wake from './wake.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { getSetting, putSetting } from './settings.js';
import { playItem, stop, playbackState, pauseCurrent } from './player.js';
import { clearCache } from './media.js';
import { onAppResume, onAppPause, onBackButton, exitApp, prefGet, prefSet, prefRemove } from './platform.js';
import { runMigrationIfNeeded } from './migrate.js';
import { PAGE_VIDEOS, PAGE_WATCH, PAGE_FOLDERS, AVATARS,
  AUTOPLAY_COUNTDOWN_MS, AUTOPLAY_RETRY_MS, REJECTED_TTL_DAYS, RESUME_SAVE_MS,
  PIN_RECOVERY_DELAY_HOURS, SCHED_LOCK_DEFAULT_DURATION_MIN } from './config.js';
import { confirmKid, askKid, alertKid, mountModal, isModalOpen } from './ui/modal.js';
import { rankItems } from './search.js';
import { toast } from './ui/toast.js';
import { planAutoplay, nextInOrder, previewEmbedUrl,
  resumeStartAt, resumeSaveDecision, watchedFraction } from './playerlogic.js';
import { groupSinglesByChannel, shouldFlattenHome, planScopeAdoption, isSheetBacked,
  resolveWatchContext, attentionDot, parentLandingTab,
  pendingBulkAction, PARENT_TAB_IDS, channelAddOutcome, planEntryRefresh,
  planProfilePurge, planRejectedPurge, shareOutcome, groupLibraryByFolder, planBootProfile, evalScheduledLock, scheduledLockDurationMs, lockCountdownLabel,
  planChannelSections } from './plan.js';
import { makePager } from './ui/pager.js';
import * as loading from './ui/loading.js';
import * as nav from './nav.js';
import * as db from './db.js';
import { syncLibrary, shouldSync } from './sync2.js';
import { normalizeTitle } from './normalize.js';
import { burst } from './ui/confetti.js';
import { playUnwrap } from './ui/sound.js';
import { initShareTarget, drainShareQueue } from './share.js';
import { TOUR_SLIDES, ADD_GUIDE_SLIDES, nextIndex, slideState, deckChrome, backAction } from './tour.js';

const PAGE_SIZE = PAGE_VIDEOS;
const $ = (id) => document.getElementById(id);

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">' +
  '<rect width="320" height="180" fill="#d8d5f0"/>' +
  '<circle cx="160" cy="90" r="42" fill="#8a84c8"/>' +
  '<polygon points="146,68 146,112 184,90" fill="#fff"/></svg>'
);

let items = [];                       // legacy Preferences list — parent screen only
let source = { mode: 'manual', url: '' };
let page = 0;                         // home page (folder tiles OR flat single-folder)
let currentWatch = null;
let profiles = [];
let createSel = null;

// IDB-backed kid views (F10)
let activeProfileId = null;
let libScope = null;                  // the shared library scope of this profile's sheet
let folders = [];                     // built by buildFolders()
let folderId = null;                  // open folder in #view-folder
let folderPage = 0;
let folderPagerObj = null;
let giftStates = new Map();           // key -> profileVideoState record (gifts F9, resume v1.0.32)
let resumeEnabled = false;            // the active profile's synced 'resume' setting (v1.0.32)
// v1.0.12 grouping of loose singles — record arrays built by ONE bulk read in
// buildFolders and paginated directly (no per-key IDB reads on render).
let singleGroups = new Map();         // channelId -> records of its grouped singles
let absorbedSingles = new Map();      // channelId -> singles shown inside its 📺 folder
let looseSingles = [];                // what stayed in the flat "סרטונים נוספים" list
let watchCtx = { scope: null, folderId: null }; // which folder the watch grid pages

// PIN flow state
let pinMode = 'verify';
let pinStep = 1;
let pinFirst = '';
let pinBuffer = '';
let pinOnSuccess = null; // what a correct code unlocks (default: the parent screen)
let pinDone = null;      // v1.0.7: fires exactly once per pin session — success OR cancel

/** Resolve the pin session once. Success consumes it BEFORE navigation, so the
    onLeave that follows (enterParent replaces the view) can't double-fire as cancel. */
function consumePinDone(success) {
  const f = pinDone;
  pinDone = null;
  if (f) { try { f(success); } catch {} }
}

/* ---------------- Views (routing via nav.js) ---------------- */
const isGalleryActive = () => nav.isActive('gallery');

function goGallery() {
  stop();
  wake.releaseAll(); // hard safety net (F7): outside the player, the screen may sleep
  currentWatch = null;
  renderHome();
  nav.reset('gallery');
}

/* ---------------- Exit lock (v1.0.11; PER-PROFILE since v1.0.25) ---------------- */
// When ON: the app is OS-pinned (home/recents/back contained by Android — the only
// sanctioned way to catch the HOME button), the exit button disappears, and every
// exit path runs confirm → parent PIN → unpin + exit.
//
// v1.0.25 — it belongs to the CHILD, not the tablet: one account can hold a 3-year-old
// who must not get out and a 7-year-old who may. It also syncs, so setting it once
// covers every device that child uses.
//
// `pid` defaults to the active profile, but the launch arming runs BEFORE a profile is
// chosen and passes the last active one — otherwise the app sits unlocked from launch
// until someone taps a tile, which is exactly when an unattended child is holding it.
async function exitLockOn(pid = activeProfileId) {
  if (!pid) return false;
  try { return (await getSetting(pid, 'exitLock', false)) === true; } catch { return false; }
}

async function applyExitLockUi() {
  const on = await exitLockOn();
  $('exit-btn').classList.toggle('hidden', on);
}

/**
 * Bring the OS pinning and the exit button in line with the ACTIVE profile's setting.
 *
 * Must run on every profile activation, not only at launch: once the lock belongs to a
 * child rather than to the tablet, switching children changes the answer. Both directions
 * were wrong without this, and one of them is a real escape — arriving at a LOCKED profile
 * from an unlocked one left the device unpinned with the exit button still on screen, so
 * the child the lock exists for could simply walk out. (The other direction merely leaves
 * a sibling pinned until the next launch.)
 */
async function applyExitLock() {
  const on = await exitLockOn();
  try {
    const { lockTask, unlockTask } = await import('./platform.js');
    if (on) await lockTask(); else await unlockTask();
  } catch { /* browser preview / plugin absent — the UI half still applies */ }
  await applyExitLockUi();
}

/* ---------------- Scheduled per-profile lock (v1.0.31) ---------------- */
// A screen-time limit: after N minutes of a session the app LOCKS for M minutes, then
// returns to normal and re-arms on the child's next video. SETTINGS sync per profile;
// the live timer state is DEVICE-LOCAL (Preferences, keyed by profile) — a lock is about
// THIS device's session, and syncing "locked until X" would lock a sibling's device.
// The pure decision lives in plan.evalScheduledLock; here is only the plumbing.
const lockArmedKey = (pid) => 'schedlock:' + pid + ':armed';
const lockUntilKey = (pid) => 'schedlock:' + pid + ':until';
let lockTicker = null;

async function schedLockSettings(pid) {
  let after = 0, dur = SCHED_LOCK_DEFAULT_DURATION_MIN;
  try { after = Number(await getSetting(pid, 'lockAfterMin', 0)) || 0; } catch {}
  try { dur = Number(await getSetting(pid, 'lockDurationMin', SCHED_LOCK_DEFAULT_DURATION_MIN)); } catch {}
  return { afterMin: after, durationMin: dur };
}

/** Read the device-local timer state + settings and let the pure helper decide. */
async function evalActiveLock() {
  const pid = activeProfileId;
  if (!pid) return { phase: 'off', msLeft: 0, pid: null };
  const { afterMin, durationMin } = await schedLockSettings(pid);
  const armedAt = Number(await prefGet(lockArmedKey(pid))) || 0;
  const lockedUntil = Number(await prefGet(lockUntilKey(pid))) || 0;
  return { ...evalScheduledLock({ armedAt, lockedUntil, afterMin, durationMin }), pid, durationMin };
}

/**
 * Arm the countdown on the child's FIRST video of a session (user's decision: the timer
 * ACCUMULATES — it never resets on a later video, or continuous play would defeat it).
 * Idempotent: only the first call while idle sets the stamp.
 */
async function armScheduledLock() {
  try {
    const e = await evalActiveLock();
    if (e.phase === 'idle') await prefSet(lockArmedKey(e.pid), String(Date.now()));
  } catch {}
}

/** Enter the lock: stamp the end time, drop the armed stamp, show the locked screen. */
async function enterScheduledLock(pid, durationMin) {
  await prefSet(lockUntilKey(pid), String(Date.now() + scheduledLockDurationMs(durationMin, SCHED_LOCK_DEFAULT_DURATION_MIN)));
  await prefRemove(lockArmedKey(pid)).catch(() => {});
  await showLockedScreen();
}

/** Clear the lock AND the armed stamp — the next video re-arms a fresh cycle. */
async function clearScheduledLock(pid = activeProfileId) {
  if (!pid) return;
  await prefRemove(lockUntilKey(pid)).catch(() => {});
  await prefRemove(lockArmedKey(pid)).catch(() => {});
}

/**
 * The one evaluator, run on a timer and on lifecycle events. Transitions:
 *   due    → start the lock (unless already showing it);
 *   locked → show the screen (or refresh the countdown) — expired clears and re-arms;
 *   else   → if the locked screen is up but the lock is gone, leave it.
 */
async function tickScheduledLock() {
  try {
    const e = await evalActiveLock();
    if (e.phase === 'due') { await enterScheduledLock(e.pid, e.durationMin); return; }
    if (e.phase === 'locked') {
      if (e.msLeft <= 0) { await clearScheduledLock(e.pid); if (nav.isActive('locked')) leaveLockedScreen(); return; }
      if (nav.isActive('locked')) $('locked-countdown').textContent = lockCountdownLabel(e.msLeft);
      else await showLockedScreen();
      return;
    }
    // not locked any more but the screen is still up (parent unlocked elsewhere)
    if (nav.isActive('locked')) leaveLockedScreen();
  } catch {}
}

/** Draw + reveal the locked screen for the active profile, exit button per the kiosk lock. */
async function showLockedScreen() {
  const e = await evalActiveLock();
  if (e.phase !== 'locked') return;
  // v1.0.31: NEVER slam the lock over the parent mid-configuration. The parent screen and
  // its PIN sit behind the code, so a child is not there — and locking a parent out of the
  // very screen where they set the timer would be absurd. The next tick (or their return to
  // the gallery) shows it once they leave. The lock is stamped either way, so no time is lost.
  if (nav.isActive('parent') || nav.isActive('pin') || nav.isActive('connect') || nav.isActive('tour')) return;
  $('locked-countdown').textContent = lockCountdownLabel(e.msLeft);
  // The exit button appears ONLY when the kiosk exit-lock is OFF. With it ON the child is
  // fully contained (no exit at all); with it off, closing the app is a legitimate escape.
  let kiosk = false;
  try { kiosk = await exitLockOn(); } catch {}
  $('locked-exit').classList.toggle('hidden', kiosk);
  if (!nav.isActive('locked')) nav.reset('locked');
}

function leaveLockedScreen() {
  // back to where the child belongs — their gallery
  if (activeProfileId) nav.reset('gallery'); else nav.reset('profiles');
}

/** The discreet פתיחה tap: parent code → unlock immediately (and re-arm on next video). */
async function onLockedParentTap() {
  startPin((await hasPin()) ? 'verify' : 'setup', {
    replace: true, title: 'קוד הורים לפתיחת הנעילה',
    onSuccess: async () => { await clearScheduledLock(); leaveLockedScreen(); }
  });
}

function startLockTicker() {
  if (lockTicker) return;
  lockTicker = setInterval(() => { tickScheduledLock().catch(() => {}); }, 5000);
}

/**
 * v1.0.25 — THE HOLE A PER-PROFILE LOCK OPENS, closed in the same release.
 *
 * The lock contains HOME, recents and back, and hides the exit button — but the profile
 * chip was never protected: `$('profile-chip')` went straight to `backToProfiles`. Once
 * the lock belongs to a profile rather than the device, a child on a locked profile could
 * tap their own avatar, pick a sibling whose profile is NOT locked, and walk out. Two
 * taps, and the lock becomes decoration.
 *
 * The chip stays VISIBLE on purpose — it is also how the child sees whose library they are
 * in — but leaving the locked profile is now the protected act, like the exit itself.
 */
async function onProfileChip() {
  // v1.0.28 (parent's decision): switching profiles MID-SESSION always asks for the
  // code — not only when the active profile is exit-locked. A child hopping to a
  // sibling's profile changes whose library, whose gift progress and whose settings
  // are in effect; that is a parental act. The BOOT picker stays free (same decision):
  // it is how each child enters their own profile, and a code at every app start would
  // mean the parent types it every morning.
  // Still fails CLOSED: a throw leaves the child where they are (v1.0.25 rule — the
  // pre-v1.0.28 unlocked branch called backToProfiles() directly, which was the escape
  // the per-profile lock had to close; now there is no unlocked branch at all).
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים להחלפת פרופיל',
    onSuccess: backToProfiles
  });
}

/**
 * Name the child that the per-profile toggles belong to. A settings screen that says
 * "נעילת יציאה" with no owner reads as a device switch, which is exactly what it used
 * to be — a parent would flip it for one child and expect it everywhere.
 */
async function labelProfileSettings() {
  const p = await getActiveProfile();
  const who = p ? ` — ${p.name}` : '';
  for (const id of ['exit-lock-owner', 'share-approval-owner', 'autoplay-owner', 'resume-owner', 'sched-lock-owner']) {
    const el = $(id);
    if (el) el.textContent = who;
  }
}

async function askExit() {
  const leave = await confirmKid({
    emoji: '👋', title: 'לצאת מהאפליקציה?', text: 'תמיד אפשר לחזור!',
    ok: 'צא', cancel: 'השאר', danger: true
  });
  if (!leave) return;
  if (await exitLockOn()) {
    // the exit itself is the protected resource — PIN before unpinning
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים ליציאה מהאפליקציה',
      onSuccess: async () => {
        const { unlockTask } = await import('./platform.js');
        await unlockTask();
        exitApp();
      }
    });
    return;
  }
  exitApp();
}

/* ---------------- Attention (v1.0.4): dots for the parent ---------------- */
/**
 * How many records are waiting for a parental decision, across BOTH of the profile's
 * scopes (the shared library and the personal one). `limit: 1` because only `total`
 * is read — this runs on every home render and again on every parent-screen entry.
 */
/**
 * The shared library scope, safe to call before the first home render.
 *
 * `libScope` is published by buildFolders, i.e. only once a home render has completed.
 * Anything that asks earlier (the gate tapped while the profile is still activating, or a
 * share arriving on a cold start) would otherwise read null and quietly answer "nothing
 * here" about a library that is full. Falling back to the stored value costs one read,
 * and only in that window.
 */
async function currentLibScope() {
  if (libScope) return libScope;
  if (!activeProfileId) return null;
  try { return (await db.getSources(activeProfileId) || {}).libraryId || null; } catch { return null; }
}

async function pendingTotal() {
  let pending = 0;
  const lib = await currentLibScope();
  const scopes = [lib, activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean);
  for (const s of scopes) pending += (await db.pagePending(s, { limit: 1 })).total;
  return pending;
}

/** attention = pending approvals waiting OR an update ready to install. */
async function computeAttention() {
  let pending = 0;
  try { pending = await pendingTotal(); } catch {}
  let updateReady = false;
  try {
    const upd = await import('./update.js');
    const local = await upd.currentVersion(); // null in the browser preview
    if (local) {
      const latest = JSON.parse((await prefGet('update.latest')) || 'null');
      updateReady = !!(latest && upd.isNewer(latest.version, local));
    }
  } catch {}
  return { pending, updateReady };
}

/**
 * v1.0.7: fresh-on-home — fired on every gallery entry, never blocking the render.
 * Content sync self-throttles (shouldSync, 3 min); the update check self-throttles
 * (6h) and the prompt fires at most once per session. v1.0.21: the first pass of each
 * LAUNCH bypasses both throttles — see below.
 */
let launchSyncDone = false; // the forced launch refresh happens once per process
let entryRefreshInFlight = null; // activateProfile awaits this to own the loading screen
function homeEntryRefresh() {
  if (!activeProfileId) return;
  // v1.0.21: the FIRST refresh of a launch is forced. The 3-min throttle exists so a
  // child flipping between home and a video doesn't resync every few seconds — but it
  // also meant reopening the app minutes after the parent edited the sheet showed stale
  // content until something else happened to trip a sync. One forced pass per launch is
  // the fix; every later home entry keeps the throttle.
  const plan = planEntryRefresh({ launchDone: launchSyncDone, sinceLastPullMs: Date.now() - lastPullAt });
  launchSyncDone = true;
  entryRefreshInFlight = entryRefresh(activeProfileId, plan).catch(() => {});
  // …and so is the version check: the 6h throttle could hide a release for a whole day
  // of launches. `silent` still honors update.skip, so a version the parent declined
  // does not nag again — only the red dot stays lit.
  import('./update.js')
    .then((u) => u.checkForUpdate({ silent: true, force: plan.forceSync }))
    .then((r) => maybePromptUpdate(r))
    .catch(() => {});
}

/**
 * v1.0.25 — THE one place that refreshes the home, and it runs PULL THEN SYNC, in series.
 *
 * Both write the same video records, so interleaving them lets one clobber the other's
 * merge — CLAUDE.md has said so since v1.0.22. It was not true on launch: `nav.reset
 * ('gallery')` fires the gallery's onEnter SYNCHRONOUSLY, so the forced launch sync was
 * already running by the time `activateProfile` reached its own `pullThenSync` on the next
 * line, and the two raced on every single launch of every device with backup enabled.
 *
 * There is now exactly one caller (the gallery's onEnter) and one promise; activation
 * awaits that promise for its loading screen instead of starting a second pipeline.
 */
async function entryRefresh(id, { pull = true, forceSync = false } = {}) {
  if (pull && await maybePullDrive()) {
    if (activeProfileId !== id) return; // switched profile under us — that render owns it
    await loadGiftStates();
    if (nav.isActive('gallery')) await renderHome();
  }
  if (activeProfileId !== id) return;
  if (!forceSync && !(await shouldSync(id))) return;
  await syncLibrary(id, { force: forceSync, onProgress: (p) => loading.progress(p) });
  if (activeProfileId !== id) return;
  await absorbMineIntoShared(id); // the first sync may have just created sources
  await loadGiftStates();
  if (nav.isActive('gallery') || nav.isActive('loading')) await renderHome();
  maybeSchedulePush();
}

/**
 * v1.0.21 — run after ANY content the parent just added (a share, a manual link, an
 * approval). A freshly written record is INERT until a sync touches it:
 *  - `srcChannelId` is filled only by the sync's enrichment stage, and that field is
 *    what `groupSinglesByChannel` folds a single into its 🎞️ collection / 📺 channel
 *    folder by — so without it the video sits in the loose "סרטונים נוספים" list;
 *  - `giftRank` is assigned only by `planProfileGifts`, so the video is not a 🎁 either.
 * Both used to appear only after the parent happened to press "רענון נתונים" (field bug).
 * Silent and non-blocking BY DEFAULT: the child may be looking at a populated grid, and
 * covering it with the loading screen is the worse bug (v1.0.18).
 *
 * v1.0.26 — `wait: true` RETURNS the promise instead, for the one context where the
 * opposite is true: the parent is standing in front of the screen having just answered
 * "what should I do with this catalogue?", and this is a SECOND full library sync that can
 * run for minutes. Silence there was read as "it finished" or "it is stuck" — the field
 * report this option exists for. The default is untouched precisely because the v1.0.18
 * reasoning still holds everywhere else; only the caller that owns a waiting screen may
 * ask to wait.
 */
function refreshAfterAdd({ parent = false, wait = false } = {}) {
  if (!activeProfileId) return wait ? Promise.resolve() : undefined;
  // NEVER while a video plays: a forced sync also bypasses the 30-min per-channel RSS
  // throttle, so this is a full sweep of every channel plus a whole-library re-plan —
  // on a low-end tablet, under a playing video. The gallery/parent screens are the only
  // safe places, and the next home entry re-runs it anyway.
  if (nav.isActive('watch')) return wait ? Promise.resolve() : undefined;
  // `onProgress` is passed ONLY when a caller is waiting: it fans out to a loading screen
  // that does not exist otherwise, and sync2 skips the work of building labels nobody reads.
  const run = syncLibrary(activeProfileId, {
    force: true,
    ...(wait ? { onProgress: (p) => loading.progress(p) } : {})
  }).then(async () => {
    await loadGiftStates();
    if (nav.isActive('gallery')) renderHome();
    if (parent && nav.isActive('parent')) {
      await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]).catch(() => {});
    }
    refreshGateDot();
  }).catch(() => {});
  return wait ? run : undefined;
}

/**
 * The dot on the 🔒 gate button — the parent's cue to come look.
 *
 * v1.0.24: its COLOUR names the errand (pure `plan.attentionDot`). Blue = content is
 * waiting for a decision, and crossing the PIN lands straight on ממתינים; red = an app
 * update. The two used to share one red dot, so the routine errand (a manual-approval
 * channel published something the child cannot see yet) was indistinguishable from the
 * rare one — and a signal that means two things gets learned as meaning nothing.
 */
async function refreshGateDot() {
  try {
    const kind = attentionDot(await computeAttention());
    const dot = $('gate-dot');
    dot.classList.toggle('hidden', !kind);
    dot.classList.toggle('attn-dot-info', kind === 'info');
  } catch {}
}

/**
 * v1.0.26 — the pending-reset banner on the child's home.
 *
 * THIS BANNER IS THE SAFEGUARD, not decoration: the 24-hour wait only protects the parent
 * if they learn that somebody asked. It therefore lives on the screen that is on all day,
 * not behind the PIN — a notice only the requester can see would protect nobody.
 *
 * Shown for 'waiting' AND for 'ready': a request that has matured is exactly when the
 * parent most needs to know, and hiding it then would turn the countdown into a trap that
 * goes quiet just before it opens.
 */
async function refreshRecoveryBanner() {
  const box = $('recovery-banner');
  try {
    const { recoveryState } = await import('./recovery.js');
    const { pinRecoveryLabel } = await import('./plan.js');
    const st = await recoveryState();
    if (st.state === 'none') { box.classList.add('hidden'); return; }
    $('recovery-banner-text').textContent = st.state === 'ready'
      ? '🔓 התבקש איפוס של קוד ההורים, וניתן לבצע אותו עכשיו'
      : '⏳ ' + pinRecoveryLabel(st);
    box.classList.remove('hidden');
  } catch { box.classList.add('hidden'); }
}

/* ---------------- Launch update prompt (v1.0.4) ---------------- */
/**
 * The deferred launch check now ASKS instead of staying silent. Declining snoozes
 * THIS version's prompt (update.skip) — the red dot and the parent screen keep
 * offering it; a newer release prompts again.
 */
let updatePromptedThisSession = false; // the ask fires at most once per launch

async function maybePromptUpdate(r) {
  if (!r || r.status !== 'available' || !r.latest) return;
  if (updatePromptedThisSession) return;
  // Never interrupt watching / PIN / parent work / first-launch connect — the red
  // dot still shows, and the next home entry or launch re-offers.
  if (nav.isActive('watch') || nav.isActive('pin') || nav.isActive('parent')
    || nav.isActive('connect') || nav.isActive('loading') || nav.isActive('tour')
    || nav.isActive('sheet-setup') || isModalOpen()) return;
  updatePromptedThisSession = true;
  const answer = await askKid({
    emoji: '🚀', title: 'יש גירסה חדשה!',
    text: `גירסה ${r.latest.version} מוכנה להתקנה (במקום ${r.local}). לעדכן עכשיו?`,
    ok: 'עדכון עכשיו', cancel: 'לא עכשיו'
  });
  if (answer !== 'ok') {
    // Only the EXPLICIT "לא עכשיו" snoozes this version. A scrim tap / hardware
    // back (e.g. the child poking the screen) just closes the dialog — it comes
    // back on the next home entry. Real bug found in the field: an accidental
    // dismiss silently wrote update.skip and the parent never saw the offer again.
    if (answer === 'cancel') {
      await prefSet('update.skip', r.latest.version);
      refreshGateDot();
    } else {
      updatePromptedThisSession = false; // dismissed, not answered — re-offer
    }
    return;
  }
  // v1.0.7 (user request): installing requires the parent PIN — a child tapping
  // "עדכון עכשיו" can't launch the installer alone.
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים לעדכון הגירסה',
    onSuccess: async () => {
      if (!nav.back()) nav.reset(activeProfileId ? 'gallery' : 'profiles');
      await runUpdateInstall(r.latest);
    }
  });
}

/**
 * What's-new screen (v1.0.8 → rewritten v1.0.13). A real SCROLLING view, not the
 * modal: notes can span several versions, so the list scrolls while the button
 * stays reachable. Hebrew parent-facing lines only (update.extractReleaseNotes
 * strips GitHub's PR titles/handles/links). Resolves true = proceed to install.
 * Back / "לא עכשיו" cancel the update (user decision).
 */
let wnResolve = null;

function renderWhatsNew({ versions, moreCount }, { installMode }) {
  $('wn-title').textContent = installMode ? 'מה חדש בעדכון' : 'מה חדש בגירסה';
  const body = $('wn-body');
  body.innerHTML = '';
  for (const v of versions) {
    const h = document.createElement('div');
    h.className = 'wn-ver';
    h.textContent = 'גירסה ' + v.version;
    body.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'wn-list';
    const lines = v.lines && v.lines.length ? v.lines : ['שיפורים ותיקונים כלליים'];
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (moreCount > 0) {
    const p = document.createElement('p');
    p.className = 'wn-more';
    p.textContent = `ועוד ${moreCount} גרסאות קודמות`;
    body.appendChild(p);
  }
  $('wn-ok').textContent = installMode ? 'עדכון עכשיו' : 'סגירה';
  $('wn-cancel').classList.toggle('hidden', !installMode);
  body.scrollTop = 0;
}

/** installMode=true → resolves true only if the parent pressed "עדכון עכשיו". */
function showWhatsNew(data, { installMode = true } = {}) {
  const versions = (data && data.versions) || [];
  if (installMode && !versions.length) return Promise.resolve(true); // nothing to show — don't block the update
  renderWhatsNew({ versions, moreCount: (data && data.moreCount) || 0 }, { installMode });
  return new Promise((resolve) => {
    wnResolve = resolve;
    nav.go('whatsnew');
  });
}

/** Resolve the screen exactly once (button OR hardware back). */
function closeWhatsNew(proceed) {
  const f = wnResolve;
  wnResolve = null;
  if (f) f(proceed);
}

/** Download + hand off to the Android installer, with the loading screen as progress. */
async function runUpdateInstall(latest) {
  // v1.0.13: the what's-new screen is the last gate — back / "לא עכשיו" aborts
  const proceed = await showWhatsNew(latest && latest.whatsNew, { installMode: true });
  if (!proceed) { if (!nav.back()) goGallery(); return; }
  if (nav.isActive('whatsnew') && !nav.back()) goGallery();
  const upd = await import('./update.js');
  loading.show({ defer: 0, step: 'מורידים את העדכון…' });
  let res = null;
  try {
    res = await upd.downloadAndInstall(latest, {
      onProgress: (done, total) => {
        if (total) loading.setStep(`מורידים את העדכון… ${Math.round((done / total) * 100)}%`);
      }
    });
  } finally {
    await loading.hide();
  }
  if (!res || !res.ok) {
    await alertKid({
      emoji: '😕', title: 'העדכון לא הצליח',
      text: res && res.error === 'truncated' ? 'ההורדה לא הושלמה — נסו שוב מאוחר יותר.'
        : res && res.error === 'installed-app-only' ? 'עדכון זמין באפליקציה המותקנת בלבד.'
        : 'אפשר לנסות שוב דרך מסך ההורים ← הגדרות.',
      ok: 'בסדר'
    });
  }
}

function registerViews() {
  // Back precedence per view. Returning true = consumed; otherwise nav pops.
  nav.register('connect', { onBack: () => { askExit(); return true; } });
  // tour back = previous slide (or skip on the first one) — never exits the app
  nav.register('tour', {
    onBack: () => {
      if (backAction(tourIdx) === 'prev') tourStep(-1); else finishTour();
      return true;
    }
  });
  nav.register('sheet-setup', { onBack: () => { finishSheetSetup(); return true; } });
  // v1.0.13: back on the what's-new screen CANCELS the update (user decision)
  nav.register('whatsnew', { onLeave: () => closeWhatsNew(false) });
  // v1.0.23 — leaving the picker ANY way (back, hardware back, a later navigation) must
  // resolve its promise, or the caller awaits forever and the add flow never finishes.
  nav.register('pick', { onLeave: () => { const h = pickHandlers; pickHandlers = null; if (h) h.cancel(); } });
  nav.register('profiles', {
    // v1.0.23: while this screen is choosing a share's destination, back means "no
    // decision" — resolve the chooser instead of asking whether to exit the app.
    onBack: () => {
      if (shareProfileCancel) { const c = shareProfileCancel; shareProfileCancel = null; c(); nav.back(); return true; }
      askExit();
      return true;
    },
    onLeave: () => { const c = shareProfileCancel; shareProfileCancel = null; if (c) c(); }
  });
  nav.register('create-profile', {
    onBack: () => {
      if (profiles.length > 0) { renderProfiles(); nav.reset('profiles'); }
      return true; // no profiles yet → swallow (nowhere to go back to)
    }
  });
  nav.register('gallery', {
    onBack: () => { askExit(); return true; },
    // Re-render on EVERY return home: after unwrapping gifts the "חדשים" folder must
    // update immediately — and disappear entirely when the last gift was opened
    // (home then falls back to the flat video grid).
    // v1.0.7: every home entry also refreshes content (3-min throttle in shouldSync)
    // and re-offers a pending update (6h check throttle; asked once per session).
    onEnter: () => { renderHome(); homeEntryRefresh(); }
  });
  // v1.0.32: onEnter fires on BACK-restores too (nav.transition), so returning from a
  // video re-renders the page the child left — the tile they just watched must show its
  // fresh progress bar, exactly like the home view's own onEnter re-render. Same page,
  // same scroll (nav restores it after the double-rAF).
  nav.register('folder', { onEnter: () => { if (folderId) renderFolderView().catch(() => {}); } });
  nav.register('search', {}); // default pop → home; watch pushed on top returns here
  nav.register('watch', {
    onLeave: (prev, next) => {
      if (next && next.name === 'watch') return; // video→video: player.js reuses the iframe
      resetAutoplayChain(); // a queued next video must never follow the child out
      // v1.0.32: bank the stop point BEFORE stop() tears the clock down. openWatch's
      // save-previous covers the video→video path that returned above.
      saveWatchPosition(currentWatch);
      clearInterval(posTimer);
      posTimer = null;
      stop();
      wake.releaseAll();
      currentWatch = null;
    }
  });
  // Leaving the pin view WITHOUT success (cancel button / hardware back) resolves
  // the session as cancelled — waiting flows (share add, update) get their answer.
  nav.register('pin', { onLeave: () => consumePinDone(false) });
  nav.register('parent', {
    onBack: () => {
      // v1.0.26: the bubble is an overlay, not a view — back must close IT first, or the
      // parent is thrown out of the screen they were triaging in.
      if (isPreviewOpen()) { closePreview(); return true; }
      goGallery();
      return true;
    },
    onLeave: () => closePreview() // never leave a player running behind another screen
  });
  loading.registerLoadingView();
  // v1.0.31: the scheduled-lock screen swallows hardware-back — a child must not escape it.
  nav.register('locked', { onBack: () => true });
}

/* ---------------- Tiles (IDB records) ---------------- */
function setThumb(img, item) {
  const chain = [];
  if (item.thumb) chain.push(item.thumb);          // legacy inline data URL
  if (item.thumbUrl) chain.push(item.thumbUrl);    // API/RSS-provided (guaranteed sizes)
  if (item.type === 'youtube' && item.id) chain.push(...youtubeThumbCandidates(item.id));
  chain.push(PLACEHOLDER);
  let i = 0;
  const tryNext = () => { img.src = chain[Math.min(i, chain.length - 1)]; };
  img.onerror = () => { i += 1; if (i < chain.length) tryNext(); else img.onerror = null; };
  tryNext();
  if (item.thumbId) { // migrated legacy Blob — upgrade in place when it loads
    db.getThumbBlob(item.thumbId)
      .then((b) => { if (b) { img.onerror = null; img.src = URL.createObjectURL(b); } })
      .catch(() => {});
  }
}

function tileEl(item) {
  const btn = document.createElement('button');
  btn.className = 'tile';
  btn.type = 'button';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const img = document.createElement('img');
  img.alt = item.title || '';
  img.loading = 'lazy';
  img.setAttribute('decoding', 'async');
  setThumb(img, item);
  thumb.appendChild(img);

  if (item.type === 'file') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '🎬';
    thumb.appendChild(badge);
  }
  const play = document.createElement('span');
  play.className = 'play-badge';
  play.textContent = '▶';
  thumb.appendChild(play);
  btn.appendChild(thumb);

  if (item.title) {
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = item.title;
    btn.appendChild(cap);
  }

  // F9: an un-unwrapped gift shows wrapped; the FIRST tap unwraps (confetti + jingle)
  // and does NOT play. From then on it's a normal tile.
  const st = giftStates.get(item.key);
  if (st && st.giftRank && !st.unwrappedAt) {
    btn.classList.add('tile-gift');
    const wrap = document.createElement('span');
    wrap.className = 'gift';
    // The 3D-looking 🎁 emoji (same one as the "חדשים" folder logo) — user request:
    // a dimensional gift instead of the flat CSS wrap.
    wrap.innerHTML = '<span class="gift-emoji">🎁</span>';
    thumb.appendChild(wrap);
    const cap = btn.querySelector('.cap');
    if (cap) cap.textContent = 'מתנה! 🎁';
  }

  // v1.0.32: watched-progress bar (red sliver at the thumb's bottom). Gated on the
  // profile's resume setting — no position is saved while it is off, and a stale one
  // from an earlier ON period must not draw. A wrapped gift never played, so no bar.
  if (resumeEnabled && !(st && st.giftRank && !st.unwrappedAt)) {
    const frac = watchedFraction(st && st.posSec, st && st.durSec);
    if (frac !== null) {
      const bar = document.createElement('span');
      bar.className = 'tile-progress';
      const fill = document.createElement('span');
      fill.className = 'tile-progress-fill';
      fill.style.width = (frac * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      thumb.appendChild(bar);
    }
  }

  btn.addEventListener('click', () => {
    const cur = giftStates.get(item.key);
    if (cur && cur.giftRank && !cur.unwrappedAt) { unwrapTileEl(btn, item); return; }
    openWatch(item);
  });
  return btn;
}

async function unwrapTileEl(btn, item) {
  playUnwrap();
  burst(btn);
  btn.classList.add('unwrapping');
  giftStates.set(item.key, { ...(giftStates.get(item.key) || {}), giftRank: undefined, unwrappedAt: Date.now() });
  try { await db.unwrapGift(activeProfileId, item.key); } catch {}
  setTimeout(() => {
    btn.querySelector('.gift')?.remove();
    btn.classList.remove('tile-gift', 'unwrapping');
    const cap = btn.querySelector('.cap');
    if (cap) cap.textContent = item.title || '';
  }, 340);
}

async function loadGiftStates() {
  giftStates = new Map();
  if (!activeProfileId) return;
  // v1.0.32: the resume flag rides the same load — tileEl is synchronous and needs both.
  try { resumeEnabled = (await getSetting(activeProfileId, 'resume', false)) === true; }
  catch { resumeEnabled = false; }
  const dbi = await db.openDb();
  await new Promise((resolve) => {
    const range = IDBKeyRange.bound([activeProfileId, ''], [activeProfileId, '￿']);
    const req = dbi.transaction('profileVideoState').objectStore('profileVideoState').openCursor(range);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve();
      giftStates.set(cur.value.key, cur.value);
      cur.continue();
    };
    req.onerror = () => resolve();
  });
}

/* ---------------- Resume playback (v1.0.32) ----------------
 * The saving half. The DECISIONS are pure (resumeSaveDecision / resumeStartAt /
 * watchedFraction in playerlogic.js); this owns the profile, the database and the timer.
 * Positions are saved only while the profile's synced 'resume' setting is ON, and they
 * are DEVICE-LOCAL — drive.serializeStateEntry never lets them travel.
 * giftStates (the in-memory mirror of profileVideoState) is kept in step on every write,
 * so the tile bars are correct on the very next render without an extra IDB read. */
let posTimer = null;

/** Forget a video's position: it ended, so the next viewing starts fresh. */
function clearWatchPosition(item) {
  if (!item || !activeProfileId) return;
  const st = giftStates.get(item.key);
  if (st) {
    const { posSec, durSec, posAt, ...rest } = st;
    if (rest.giftRank !== undefined || rest.unwrappedAt) giftStates.set(item.key, rest);
    else giftStates.delete(item.key);
  }
  db.clearPlayPosition(activeProfileId, item.key).catch(() => {});
}

/** Read the live playhead and persist it for `item`, per the pure decision. */
function saveWatchPosition(item, state = playbackState()) {
  if (!resumeEnabled || !item || !activeProfileId || !state) return;
  const decision = resumeSaveDecision({ pos: state.time, dur: state.duration });
  if (decision === 'ignore') return;
  if (decision === 'clear') { clearWatchPosition(item); return; }
  const pos = Math.floor(state.time);
  const dur = Math.floor(state.duration);
  const prev = giftStates.get(item.key) || { profileId: activeProfileId, key: item.key };
  giftStates.set(item.key, { ...prev, posSec: pos, durSec: dur, posAt: Date.now() });
  db.savePlayPosition(activeProfileId, item.key, pos, dur).catch(() => {});
}

/* ---------------- Home: folders (F10) ---------------- */

/**
 * v1.0.24 — the channel's avatar did not LOAD. Record it, so the next sync can go and get
 * a fresh URL (pure `plan.planChannelLogo`).
 *
 * Without this the failure is invisible AND permanent: `img.onerror` quietly swaps in the
 * 📺 emoji, and both fetch paths skipped any channel that already had a `logoUrl` — so a
 * channel that rebranded (its old avatar URL now 404s) lost its picture forever, and the
 * child lost the only thing that tells one folder from another. The stored URL is NOT
 * cleared here: a moment offline must not throw away a perfectly good avatar, and the
 * sync overwrites it only once it holds a replacement.
 *
 * Once per channel per session — the same tile re-renders on every home entry, and each
 * write bumps `db.dataVersion()`, which is what the folder cache keys off.
 */
const logoFailuresNoted = new Set();
function noteLogoFailure(channelId) {
  if (!channelId || logoFailuresNoted.has(channelId)) return;
  logoFailuresNoted.add(channelId);
  db.setLogoFailedAt(channelId, Date.now()).catch(() => {});
}

/** Show a channel avatar; on failure fall back to the emoji AND report it (see above). */
function mountChannelLogo(host, url, channelId, emoji) {
  if (!url) { host.textContent = emoji; return; }
  const img = document.createElement('img');
  img.alt = '';
  img.onerror = () => { img.remove(); host.textContent = emoji; noteLogoFailure(channelId); };
  img.src = url;
  host.appendChild(img);
}

function folderTile(f) {
  const btn = document.createElement('button');
  btn.className = 'tile tile-folder' + (f.isNew ? ' folder-new' : '');
  btn.type = 'button';
  btn.style.position = 'relative';

  const logo = document.createElement('span');
  logo.className = 'folder-logo';
  if (f.logoUrl) mountChannelLogo(logo, f.logoUrl, f.channelId, f.emoji);
  else logo.textContent = f.emoji;
  const nm = document.createElement('span');
  nm.className = 'folder-name';
  nm.textContent = f.title;
  const cnt = document.createElement('span');
  cnt.className = 'folder-count';
  cnt.textContent = `${f.count} סרטונים`;
  btn.appendChild(logo);
  btn.appendChild(nm);
  btn.appendChild(cnt);
  // v1.0.4: channel folders carry an explicit chip — the child (and parent) must
  // never mistake a folder for a playable video tile. v1.0.12: grouped singles get
  // their OWN chip (🎞️ אוסף) so the two folder kinds never look alike.
  const fid = String(f.id);
  if (fid.startsWith('ch:') || fid.startsWith('grp:') || fid.startsWith('pl:')) {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    chip.textContent = fid.startsWith('grp:') ? '🎞️ אוסף'
      : fid.startsWith('pl:') ? '🎵 רשימה' : '📺 ערוץ';
    btn.appendChild(chip);
  }
  if (f.isNew) {
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = f.count;
    btn.appendChild(badge);
  }
  btn.addEventListener('click', () => openFolder(f.id));
  return btn;
}

/**
 * v1.0.6: ONE shared "extra videos" list. Profile-scope 'mine' records (manual adds,
 * approved shares) are absorbed into the library's 'sheet' folder — shared by every
 * profile on the sheet — and first-time moves are queued for the sheet write-back.
 * Idempotent and cheap when there is nothing to move; runs on every activation, so
 * copies resurrected by a Drive merge from a not-yet-updated device self-heal too.
 */
async function absorbMineIntoShared(profileId) {
  try {
    const src = await db.getSources(profileId);
    const lib = src && src.libraryId;
    if (!lib) return; // sources appear on first sync — the next activation absorbs
    const pScope = db.profScope(profileId);
    const mine = await db.loadMergeIndex(pScope);
    let moved = 0;
    for (const rec of mine.values()) {
      if ((rec.homeFolderId || rec.folderId) !== 'mine') continue;
      if (!(await db.getVideo(lib, rec.key))) {
        const pending = rec.state === 'pending';
        await db.putVideos([{
          ...rec, scopeId: lib,
          folderId: pending ? '~pending' : 'sheet',
          homeFolderId: pending ? 'sheet' : null,
          updatedAt: Date.now()
        }]);
        // live items are part of the master list — register them in the sheet once
        // (pending shares enqueue at APPROVAL time instead)
        if (!pending) {
          // {flush:false} — a bulk caller must NOT flush per record (v1.0.18): this runs on
          // EVERY profile activation and was one network round trip per moved video. The
          // single flush after the loop also closes the window in which a record is live +
          // sheet-backed + rowless, which is exactly what the presence-mirror tombstones.
          const { enqueueSheetRow } = await import('./sheetwrite.js');
          await enqueueSheetRow(profileId, { key: rec.key, srcUrl: rec.srcUrl || rec.url || '', title: rec.title || '' }, { flush: false });
        }
        moved += 1;
      }
      await db.deleteVideoRaw(pScope, rec.key); // raw: a move, not a deletion — no tombstone
    }
    await db.copyDenies(pScope, lib); // personal deletions keep protecting the shared list
    if (moved) {
      try {
        const { flushSheetQueue } = await import('./sheetwrite.js');
        await flushSheetQueue(profileId);
      } catch {}
      maybeSchedulePush();
    }
  } catch { /* absorbing must never block activation; next activation retries */ }
}

/**
 * Derived-home cache (v1.0.20 performance fix). buildFolders() has to read the WHOLE
 * library — the grouping needs full records, which then feed the tiles directly — and
 * renderHome() runs on every gallery entry, every return from a video and every home
 * page flip. On a real library that was a full-store deserialize per interaction, which
 * is what made the app feel sticky. `db.dataVersion()` changes on every committed write,
 * so a hit here is only possible when NOTHING has changed since the last derivation.
 */
let foldersCache = null;

async function buildFolders() {
  const cache = foldersCache;
  if (cache && cache.profileId === activeProfileId && cache.seq === db.dataVersion()) {
    libScope = cache.libScope;
    singleGroups = cache.singleGroups;
    absorbedSingles = cache.absorbedSingles;
    looseSingles = cache.looseSingles;
    return cache.folders.slice();
  }
  const seq = db.dataVersion();
  // Capture the profile ALONGSIDE the write counter. Switching profile writes only to
  // Preferences, so dataVersion() does NOT change across a switch — `profileId` is the
  // cache's only cross-profile guard, and reading it at cache-WRITE time (after every
  // await below) let a derivation that started as child A get stamped with child B's id.
  // B then hit the cache and was shown A's library, with libScope pointing at A's videos.
  const pid = activeProfileId;
  const out = [];
  if (!pid) return out;
  const giftCount = await db.countGifts(pid);
  if (giftCount > 0) out.push({ id: 'new', title: 'חדשים', emoji: '🎁', count: giftCount, isNew: true });

  const src = await db.getSources(pid);
  const lib = (src && src.libraryId) || null;
  // ALL grouping state is derived into LOCALS and published together at the very end.
  // A profile without sources used to keep the PREVIOUS profile's looseSingles, and a
  // derivation superseded mid-await by a profile switch used to publish its stale
  // globals over the new child's (latent leak, and the cross-profile cache hit above).
  let groups = new Map();
  let absorbed = new Map();
  let loose = [];
  if (lib) {
    const libChannels = await db.listLibraryChannels(lib); // read ONCE — this used
    const subscribedIds = new Set(libChannels.map((c) => c.channelId)); // to run twice
    for (const lc of libChannels) {
      if (lc.hidden) continue;
      const ch = (await db.getChannel(lc.channelId)) || {};
      // v1.0.26: a standalone playlist is a subscription in the same table, and gets its
      // own folder — except for the videos whose channel is ALSO subscribed, which
      // playlistVideoFolder files under the channel instead (the parent's unify rule).
      // A playlist whose videos ALL went to channel folders has count 0 and no tile,
      // which is exactly right: it would have been an empty duplicate.
      const isPl = lc.kind === 'playlist';
      const prefix = isPl ? 'pl:' : 'ch:';
      const count = await db.countFolder(lib, prefix + lc.channelId);
      if (!count) continue;
      out.push({
        id: prefix + lc.channelId, scope: lib,
        title: lc.titleOverride || ch.title || (isPl ? 'רשימת השמעה' : 'ערוץ'),
        // logo → persisted per-channel fallback thumbnail → 📺 emoji (v1.0.6):
        // every channel folder must stay visually distinct for a non-reading child.
        // v1.0.24: channelId rides along so a tile whose image FAILS TO LOAD can say so
        // (noteLogoFailure) — that failure is otherwise invisible and permanent.
        channelId: lc.channelId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: isPl ? '🎵' : '📺', count
      });
    }
    // v1.0.12: loose single links from the SAME channel collapse into one 🎞️ folder
    // (2+ = a group; a lone single stays in the flat list, so deleting down to one
    // un-groups it by itself). Singles of an already-subscribed channel are shown
    // inside that channel's 📺 folder instead of a second same-named folder.
    // All of it rides ONE bulk read — the record arrays feed pagination directly.
    const { compareForDisplay } = await import('./order.js');
    const sheetRecords = [...(await db.loadMergeIndex(lib)).values()].filter(isSheetBacked);
    const grouping = groupSinglesByChannel(sheetRecords.filter((r) => !r.channelId), subscribedIds);
    const byKey = new Map(sheetRecords.map((r) => [r.key, r]));
    const recsOf = (keys) => keys.map((k) => byKey.get(k)).filter(Boolean).sort(compareForDisplay);

    groups = new Map(grouping.groups.map((g) => [g.channelId, recsOf(g.keys)]));
    absorbed = new Map([...grouping.absorb].map(([id, keys]) => [id, recsOf(keys)]));
    for (const [chId, recs] of absorbed) {
      const f = out.find((x) => x.id === 'ch:' + chId);
      if (f) { f.count += recs.length; continue; }
      // subscribed but nothing imported yet — the singles still need a home
      const ch = (await db.getChannel(chId)) || {};
      out.push({
        id: 'ch:' + chId, scope: lib, title: ch.title || 'ערוץ', channelId: chId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '📺', count: recs.length
      });
    }
    for (const g of grouping.groups) {
      const ch = (await db.getChannel(g.channelId)) || {};
      out.push({
        id: 'grp:' + g.channelId, scope: lib, title: g.title, channelId: g.channelId,
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '🎞️',
        count: g.keys.length, grouped: true
      });
    }
    // the merged shared list — only what stayed loose after grouping (v1.0.12)
    const claimed = new Set([
      ...grouping.groups.flatMap((g) => g.keys),
      ...[...grouping.absorb.values()].flat()
    ]);
    loose = sheetRecords.filter((r) => !claimed.has(r.key)).sort(compareForDisplay);
    if (loose.length) {
      out.push({ id: 'sheet', scope: lib, title: 'סרטונים נוספים', emoji: '⭐', count: loose.length });
    }
  }
  // legacy safety: pre-absorb profile-scope items (e.g. before the first sync creates
  // sources) stay reachable until absorbMineIntoShared picks them up
  const mineCount = await db.countFolder(db.profScope(pid), 'mine');
  if (mineCount) out.push({ id: 'mine', scope: db.profScope(pid), title: 'סרטונים נוספים', emoji: '💜', count: mineCount });
  // Superseded by a profile switch while we were awaiting? Publish NOTHING — not the
  // globals, not the cache. The switch does its own render and re-derives from scratch.
  if (pid !== activeProfileId) return out;
  libScope = lib;
  singleGroups = groups;
  absorbedSingles = absorbed;
  looseSingles = loose;
  // Cache against the write counter AND the profile READ AT ENTRY: if anything committed
  // while we were deriving, `seq` is already stale and the next render redoes the work
  // (never serves a list that never matched the store).
  foldersCache = {
    seq, profileId: pid, libScope: lib, folders: out.slice(),
    singleGroups: groups, absorbedSingles: absorbed, looseSingles: loose
  };
  return out;
}

function scopeForFolder(fid) {
  if (fid === 'mine') return db.profScope(activeProfileId);
  return libScope;
}

/**
 * Home = folder tiles. UX rule (pure `shouldFlattenHome`): when the only folder is the
 * shared loose list the home renders its videos flat — folders appear once there is
 * something to organize. A CHANNEL folder always keeps its tile, even alone (v1.0.20):
 * flattening it hid the channel's logo behind a 100-page flat list.
 */
async function renderHome() {
  folders = await buildFolders();
  const grid = $('grid');

  refreshGateDot(); // fire-and-forget — the red dot must never delay the grid
  refreshRecoveryBanner(); // same: the grid must never wait on a Preferences read

  const empty = folders.length === 0;
  $('empty-state').classList.toggle('hidden', !empty);
  grid.classList.toggle('hidden', empty);
  if (empty) { $('pg-controls').classList.add('hidden'); grid.innerHTML = ''; return; }

  if (shouldFlattenHome(folders)) {
    // shouldFlattenHome only says yes for a SINGLE non-🎁 folder, so folders[0] is it
    await renderGridPage(grid, folders[0].scope, folders[0].id, 'home');
    return;
  }

  const total = Math.max(1, Math.ceil(folders.length / PAGE_FOLDERS));
  if (page >= total) page = total - 1;
  if (page < 0) page = 0;
  grid.innerHTML = '';
  for (const f of folders.slice(page * PAGE_FOLDERS, (page + 1) * PAGE_FOLDERS)) {
    grid.appendChild(folderTile(f));
  }
  updateHomePager(total);
}

function updateHomePager(total) {
  const controls = $('pg-controls');
  if (total > 1) {
    controls.classList.remove('hidden');
    $('pg-info').textContent = `${page + 1} / ${total}`;
    $('pg-prev').disabled = page === 0;
    $('pg-next').disabled = page >= total - 1;
  } else {
    controls.classList.add('hidden');
  }
}

/**
 * 🎁 "חדשים" — the sparse by_gift index resolved to live records, rank order.
 * Kept out of pageAnyFolder's body only for readability; it is reached ONLY through it.
 */
async function pageGiftFolder({ offset, limit }) {
  const res = await db.pageGifts(activeProfileId, { offset, limit });
  const items = [];
  const prefer = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  for (const st of res.items) {
    // by-key lookup across ALL scopes: immune to library-id drift (a re-saved sheet
    // URL used to orphan gift states — badge counted them, the folder came up empty)
    const rec = await db.findLiveByKey(st.key, prefer);
    if (rec) {
      items.push(rec);
    } else {
      // self-heal: the video is gone everywhere — drop the orphaned state so the
      // "חדשים" badge converges with what the child actually sees
      try { await db.deleteVideoState(activeProfileId, st.key); giftStates.delete(st.key); } catch {}
    }
  }
  return { items, total: res.total };
}

/**
 * One pagination entry point for every folder kind (v1.0.12):
 *   new      — 🎁 "חדשים": the sparse gift index, resolved to live records (v1.0.21);
 *   grp:<id> — a virtual folder of loose singles sharing a channel (array slice);
 *   sheet    — the flat list MINUS whatever grouping claimed (array slice);
 *   ch:<id>  — the channel's indexed range, with absorbed singles PREPENDED
 *              (they come first, then the channel's own videos, paged correctly);
 *   anything else — the plain by_folder_sort range.
 *
 * 🎁 lives HERE, not in renderGridPage, because it is not a stored folder: no record
 * carries `folderId:'new'`, so `folderRange(scope,'new')` is an exact bound that matches
 * nothing. renderGridPage had its own gift branch and renderWatchGrid did not, so opening
 * a gift left the UNDER-PLAYER GRID EMPTY (v1.0.21 field bug) — the child lost every way
 * to pick the next video. One entry point means one gift implementation.
 */
async function pageAnyFolder(scope, fid, { offset = 0, limit = PAGE_SIZE } = {}) {
  const slice = (arr) => ({ items: arr.slice(offset, offset + limit), total: arr.length });
  if (fid === 'new') return pageGiftFolder({ offset, limit });
  if (String(fid).startsWith('grp:')) return slice(singleGroups.get(String(fid).slice(4)) || []);
  if (fid === 'sheet' && looseSingles.length) return slice(looseSingles);

  const extras = (String(fid).startsWith('ch:') && absorbedSingles.get(String(fid).slice(3))) || [];
  if (!extras.length) return db.pageFolder(scope, fid, { offset, limit });
  const eSlice = extras.slice(offset, offset + limit);
  const consumed = Math.min(extras.length, offset);        // extras already shown
  const res = await db.pageFolder(scope, fid, { offset: offset - consumed, limit: limit - eSlice.length });
  return { items: [...eSlice, ...res.items], total: res.total + extras.length };
}

/**
 * v1.0.25 — the video AFTER `current`, in the order the child is looking at.
 *
 * Lives inside pageAnyFolder's region deliberately: that is the one pagination entry
 * point (invariants.test.mjs pins `db.pageFolder`/`db.pageGifts` to these lines), and a
 * second renderer growing its own private branch is the v1.0.21 bug that rule exists for.
 * "Next" must mean the tile that follows on screen, or the chain disagrees with the grid.
 *
 * The plain branch uses pageFolder's KEYSET mode — O(1) at any depth, and until now it
 * had no caller at all. Loading the whole folder to find one index would read 2000
 * records at the end of every video on a low-end tablet.
 */
async function nextAfter(scope, fid, current) {
  if (!scope || !fid || !current || !current.key) return null;
  // 🎁 is never chained (planAutoplay stops first); it is also not a stored folder, so
  // there is no cursor to advance here even if it were.
  if (fid === 'new') return null;
  if (String(fid).startsWith('grp:')) return nextInOrder(singleGroups.get(String(fid).slice(4)) || [], current.key);
  if (fid === 'sheet' && looseSingles.length) return nextInOrder(looseSingles, current.key);

  // A channel folder shows its absorbed singles FIRST, then the channel's own videos.
  const extras = (String(fid).startsWith('ch:') && absorbedSingles.get(String(fid).slice(3))) || [];
  const at = extras.findIndex((v) => v && v.key === current.key);
  if (at >= 0) {
    if (at + 1 < extras.length) return extras[at + 1];
    const first = await db.pageFolder(scope, fid, { offset: 0, limit: 1 }); // cross into the channel's own
    return first.items[0] || null;
  }
  if (!Number.isFinite(Number(current.sortKey))) return null; // no cursor to resume from
  const res = await db.pageFolder(scope, fid, { after: { sortKey: current.sortKey, key: current.key }, limit: 1 });
  return res.items[0] || null;
}

/** Render one page of videos of (scope, folderId) into a grid ('home' or 'folder'). */
async function renderGridPage(grid, scope, fid, which) {
  const pg = which === 'home' ? page : folderPage;
  const res = await pageAnyFolder(scope, fid, { offset: pg * PAGE_SIZE, limit: PAGE_SIZE });
  const total = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
  grid.innerHTML = '';
  for (const rec of res.items) grid.appendChild(tileEl(rec));
  if (which === 'home') updateHomePager(total);
  else folderPagerObj.update(folderPage, total);
}

/* ---------------- Search (v1.0.7) ---------------- */
// The kid searches the APPROVED library only (live records + visible channel folders)
// — no network, no external content; ranking is pure (search.js, node-tested).
let searchIndex = null; // { videos: [records], folders: [{...folder, normTitle}] }
let searchTimer = null;

async function buildSearchIndex() {
  const videos = [];
  const scopes = [libScope, activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean);
  for (const s of scopes) {
    for (const rec of (await db.loadMergeIndex(s)).values()) {
      if (rec.state === 'live') videos.push(rec);
    }
  }
  // v1.0.18 — DERIVED FROM `folders`, THE SAME LIST THE HOME SCREEN RENDERS.
  //
  // This used to re-derive channel folders from listLibraryChannels + countFolder and
  // skip any whose count was 0. But buildFolders deliberately PUBLISHES such a folder
  // when absorbedSingles has entries for it ("subscribed, nothing imported yet, but
  // loose singles live here"), and it adds those singles to the count of the folders
  // that do have imports. So a folder could sit on the child's home screen holding two
  // videos and be unfindable by name, and every absorbed count was understated — the
  // v1.0.17 fix closed this for 🎞️ groups but left it open for 📺 channels.
  // One source of truth removes the whole class: if it is on the home screen, it is
  // searchable, with the count the child can see. `folders` already excludes hidden
  // channels (buildFolders), and non-channel tiles (🎁 חדשים, the shared 'sheet'
  // folder) are filtered out here because they are not channel names to search for.
  const folderEntries = [];
  if (libScope) {
    for (const f of folders) {
      const id = String(f.id || '');
      const isGroup = id.startsWith('grp:');
      // v1.0.26: playlist folders are searchable too — a parent looking for "שירי בוקר"
      // must find the playlist by name exactly as they find a channel.
      if (!isGroup && !id.startsWith('ch:') && !id.startsWith('pl:')) continue;
      const title = f.title || '';
      if (!title) continue;
      folderEntries.push({
        id, scope: f.scope || libScope,
        key: (isGroup ? 'group:' : 'folder:') + id.slice(id.indexOf(':') + 1),
        title, normTitle: normalizeTitle(title),
        logoUrl: f.logoUrl || '', emoji: f.emoji || (isGroup ? '🎞️' : '📺'),
        count: f.count || 0
      });
    }
  }
  searchIndex = { videos, folders: folderEntries };
}

async function openSearch() {
  searchIndex = null;
  nav.go('search');
  $('search-input').value = '';
  $('search-results').innerHTML = '';
  $('search-empty').classList.add('hidden');
  buildSearchIndex().catch(() => {});
  setTimeout(() => { try { $('search-input').focus(); } catch {} }, 60);
}

async function renderSearchResults() {
  if (!searchIndex) { try { await buildSearchIndex(); } catch { return; } }
  const q = $('search-input').value;
  // channel folders first (few, big targets), then videos by match accuracy
  const folderHits = rankItems(q, searchIndex.folders, { limit: 6 });
  const videoHits = rankItems(q, searchIndex.videos, { limit: 24 });
  const grid = $('search-results');
  grid.innerHTML = '';
  for (const { item } of folderHits) grid.appendChild(folderTile(item));
  for (const { item } of videoHits) grid.appendChild(tileEl(item));
  $('search-empty').classList.toggle(
    'hidden',
    !(normalizeTitle(q).length >= 2 && !folderHits.length && !videoHits.length)
  );
}

/* ---------------- Folder view ---------------- */
async function openFolder(fid) {
  folderId = fid;
  folderPage = 0;
  const f = folders.find((x) => x.id === fid)
    || (searchIndex && searchIndex.folders.find((x) => x.id === fid)); // opened from search
  $('folder-title').textContent = f ? (f.isNew ? 'חדשים 🎁' : f.title) : '';
  // v1.0.4: the channel's logo (or the folder emoji) next to the name — the child
  // always sees WHICH channel they're inside.
  const logoTop = $('folder-logo-top');
  logoTop.innerHTML = '';
  if (f && f.logoUrl) {
    mountChannelLogo(logoTop, f.logoUrl, f.channelId, f.emoji || '📺');
    logoTop.classList.remove('hidden');
  } else if (f && f.emoji && !f.isNew) {
    logoTop.textContent = f.emoji;
    logoTop.classList.remove('hidden');
  } else {
    logoTop.classList.add('hidden');
  }
  nav.go('folder', { folderId: fid }); // its onEnter renders the grid (v1.0.32)
}

async function renderFolderView() {
  if (!folderPagerObj) {
    folderPagerObj = makePager({
      mount: $('folder-pager'),
      onChange: async (p) => { folderPage = p; await renderFolderView(); }
    });
  }
  await renderGridPage($('folder-grid'), scopeForFolder(folderId), folderId, 'folder');
}

/* ---------------- Watch ---------------- */
// F4: the under-player grid is PAGINATED (6 tiles/page) — the old render-everything
// was the page's lag source with hundreds of tiles. The playing item stays in the
// grid (marked) so pagination is stable while switching videos.
let watchPage = 0;
let watchPager = null;

async function renderWatchGrid(current) {
  if (!watchPager) watchPager = makePager({ mount: $('watch-pager'), onChange: (p) => { watchPage = p; renderWatchGrid(currentWatch); } });
  const grid = $('watch-grid');
  // Same-folder browsing (user decision): the grid pages the folder the child came
  // from. A gift opened from "חדשים" browses its ORIGIN folder (rec.folderId).
  const scope = watchCtx.scope;
  const fid = watchCtx.folderId;
  if (!scope || !fid) { grid.innerHTML = ''; watchPager.update(0, 1); return; }

  const res = await pageAnyFolder(scope, fid, { offset: watchPage * PAGE_WATCH, limit: PAGE_WATCH });
  const total = Math.max(1, Math.ceil(res.total / PAGE_WATCH));
  if (watchPage >= total) watchPage = total - 1;

  grid.innerHTML = '';
  for (const rec of res.items) {
    const tile = tileEl(rec);
    if (current && rec.key === current.key) tile.classList.add('tile-current');
    grid.appendChild(tile);
  }
  watchPager.update(watchPage, total);
}

/**
 * v1.0.16: a video that ENDED returns the child to where they came from — the
 * folder, the search results, or home — never unconditionally to home (that was the
 * bug: a video finishing inside a folder dumped the child on the home screen).
 * Fullscreen is always released first, so the folder is actually visible.
 */
function leaveWatch() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
  }
  // nav.back() pops the watch entry and restores the previous view's scroll;
  // if watch is somehow the only entry, home is the safe floor.
  if (!nav.back()) goGallery();
}

/* ---------------- Continuous play (v1.0.25) ----------------
 * OFF by default, per child, synced. The decision itself is pure `planAutoplay`
 * (playerlogic.js) — read its comment for the 🎁 rule and the failure ceiling.
 * Everything here is the DOM half: a countdown the child can stop, and the chain state.
 */
let autoplayTimer = null;
let autoplayFailures = 0;   // CONSECUTIVE; a video that plays resets it
let autoplayRetriedKey = null;

/** Called on every exit from the watch view, and before every new video starts. */
function cancelAutoplay() {
  clearInterval(autoplayTimer);
  autoplayTimer = null;
  const el = $('autoplay-next');
  if (el) el.classList.add('hidden');
}

function resetAutoplayChain() {
  cancelAutoplay();
  autoplayFailures = 0;
  autoplayRetriedKey = null;
}

/**
 * Count down in front of the child, then play `item`.
 *
 * The countdown is not decoration: continuous play keeps the app in fullscreen, where the
 * 🏠 button lives OUTSIDE the player and is therefore invisible (v1.0.2). Without this the
 * only way out is Android's back gesture, which in immersive mode needs an edge swipe a
 * 5-year-old does not know. `retry` reuses the same overlay with no thumbnail change —
 * the child does not need to know a video failed, only that something is about to happen.
 */
function countdownThen(item, ms) {
  cancelAutoplay();
  const el = $('autoplay-next');
  const img = $('autoplay-thumb');
  img.src = item.thumbUrl || PLACEHOLDER;
  img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
  $('autoplay-title').textContent = item.title || '';
  el.classList.remove('hidden');

  let left = Math.max(1, Math.ceil(ms / 1000));
  $('autoplay-count').textContent = String(left);
  autoplayTimer = setInterval(() => {
    left -= 1;
    if (left > 0) { $('autoplay-count').textContent = String(left); return; }
    cancelAutoplay();
    // The child may have navigated away while it ticked — never yank them back.
    if (!nav.isActive('watch')) { resetAutoplayChain(); return; }
    openWatch(item).catch(() => { resetAutoplayChain(); leaveWatch(); });
  }, 1000);
}

/**
 * A video finished. This replaces the old unconditional `leaveWatch()`.
 * @param reason 'ended' | 'error', from player.js
 */
async function onVideoFinished(reason = 'ended') {
  const item = currentWatch;
  if (!item) { leaveWatch(); return; }

  // v1.0.32: a video that ENDED starts fresh next time — its saved position (and the
  // tile's progress bar) is gone. Player teardown already ran, so playbackState() is
  // null and no later save can resurrect it. An 'error' exit keeps the position.
  if (reason === 'ended' && resumeEnabled) clearWatchPosition(item);

  let enabled = false;
  try { enabled = (await getSetting(activeProfileId, 'autoplay', false)) === true; } catch {}
  // The child can leave during those awaits; anything after this point would act on a
  // screen they are no longer looking at.
  if (!nav.isActive('watch')) { resetAutoplayChain(); return; }

  let next = null;
  if (enabled) {
    try { next = await nextAfter(watchCtx.scope, watchCtx.folderId, item); } catch { next = null; }
    if (!nav.isActive('watch')) { resetAutoplayChain(); return; }
  }

  // A wrapped gift is a deliberate tap, never something a chain opens for the child.
  const nextState = next ? giftStates.get(next.key) : null;
  const plan = planAutoplay({
    enabled,
    folderId: watchCtx.folderId,
    reason,
    failures: autoplayFailures,
    retriedCurrent: autoplayRetriedKey === item.key,
    hasNext: !!next,
    nextIsGift: !!(nextState && nextState.giftRank && !nextState.unwrappedAt)
  });

  if (plan.action === 'stop') { resetAutoplayChain(); leaveWatch(); return; }
  // Count the failure only once the decision is made, so `failures` is what the NEXT
  // call sees rather than something this call already acted on.
  autoplayFailures = reason === 'error' ? autoplayFailures + 1 : 0;

  if (plan.action === 'retry') {
    autoplayRetriedKey = item.key;
    countdownThen(item, AUTOPLAY_RETRY_MS);
    return;
  }
  autoplayRetriedKey = null;
  countdownThen(next, AUTOPLAY_COUNTDOWN_MS);
}

/** Enter fullscreen on the player. MUST be called synchronously inside the tap's
    user-activation window — after an await the browser may deny the request. */
function enterPlayerFullscreen() {
  try {
    const el = $('player-wrap');
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } catch { /* embedded webviews may deny — playing inline is a fine fallback */ }
}

async function openWatch(item) {
  // v1.0.32: switching video→video — bank the OLD video's stop point BEFORE playItem
  // reuses or tears down the player (the clock goes with it).
  if (currentWatch && currentWatch.key !== item.key) saveWatchPosition(currentWatch);
  currentWatch = item;
  armScheduledLock().catch(() => {}); // v1.0.31: first video arms the screen-time countdown
  // A tap during the continuous-play countdown wins over the queued video. Synchronous
  // and BEFORE the fullscreen request, so it cannot cost the tap its user activation.
  cancelAutoplay();
  // Tapping a video goes straight to fullscreen (user request). Synchronous — still
  // inside the tap gesture. Exiting fullscreen (back / ⛶) lands on the watch page,
  // where the 🏠 button lives.
  enterPlayerFullscreen();
  // watch-grid context: the record's own folder (or where the child was browsing)
  // v1.0.12: when the child came from a FOLDER view, browse THAT folder — virtual
  // 🎞️ group folders aren't stored on the record, so item.folderId can't express
  // them. video→video from the under-player grid keeps the existing context.
  // …and 🎁 'new' is a VIEW, not a folder: paging it after the gift is unwrapped came up
  // short or empty, so a gift browses where the video actually lives (resolveWatchContext).
  watchCtx = resolveWatchContext({
    item,
    isWatching: nav.isActive('watch'),
    prevFolderId: nav.isActive('watch') ? watchCtx.folderId : folderId,
    folderViewId: nav.isActive('folder') ? folderId : null,
    libScope,
    profileScope: db.profScope(activeProfileId)
  });
  // replace() when already watching: back always returns to the gallery, never
  // through the chain of watched videos. nav scrolls to top — the F4 fix: the
  // user actually SEES the player instead of staying scrolled at the grid.
  if (nav.isActive('watch')) nav.replace('watch', { key: item.key }); // keep the child's grid page
  else { watchPage = 0; nav.go('watch', { key: item.key }); }
  const status = $('watch-status');
  status.classList.add('hidden');
  status.textContent = '';
  setWatchTitle(item);
  renderWatchGrid(item);

  // v1.0.32: resume — the pure decision; 0 whenever the setting is off, nothing usable
  // is stored, or the stored stop is inside the tail. giftStates mirrors the whole
  // profileVideoState store, so this is a sync lookup, not an IDB read.
  const stored = giftStates.get(item.key);
  const startAt = resumeStartAt({
    enabled: resumeEnabled,
    posSec: stored && stored.posSec,
    durSec: stored && stored.durSec
  });
  // …and while watching, bank the playhead every few seconds: a process killed while the
  // screen is off must still know where the child stopped.
  clearInterval(posTimer);
  posTimer = setInterval(() => {
    if (nav.isActive('watch') && currentWatch) saveWatchPosition(currentWatch);
  }, RESUME_SAVE_MS);

  await playItem(item, $('player-host'), {
    startAt,
    onExit: (reason) => { if ($('view-watch').classList.contains('active')) onVideoFinished(reason).catch(() => leaveWatch()); },
    onStatus: (s) => {
      if (!s) { status.classList.add('hidden'); status.textContent = ''; return; }
      status.textContent = s === 'downloading' ? 'טוען את הסרטון… רגע אחד ⏳'
        : s === 'unsupported' ? 'הסרטון הזה יעבוד רק באפליקציה המותקנת'
        : 'אופס, לא הצלחנו לנגן את הסרטון';
      status.classList.remove('hidden');
    },
    onThumb: (data) => persistThumb(item, data)
  });
}

/* Captured first frame of a direct file → Blob in the thumbs store (never base64 in a record). */
async function persistThumb(item, dataUrl) {
  try {
    if (item.thumbId || item.thumbUrl) return;
    const { dataUrlToBytes } = await import('./migrate.js');
    const dec = dataUrlToBytes(dataUrl);
    if (!dec) return;
    const { fnv1a } = await import('./util.js');
    const id = 'file:' + fnv1a(item.key);
    await db.putThumb(id, new Blob([dec.bytes], { type: dec.mime }), { origin: 'capture' });
    await db.setVideoFields(item.scopeId, item.key, { thumbId: id });
    item.thumbId = id;
  } catch {}
}

/* F5: the playing video's title under the player, YouTube-style. */
function setWatchTitle(item) {
  const el = $('watch-title');
  el.textContent = item.title || '';
  el.classList.toggle('hidden', !item.title);
  if (!item.title && item.type === 'youtube') {
    el.textContent = '…';
    el.classList.remove('hidden');
    fetchYouTubeTitle(item.id).then((t) => {
      if (!currentWatch || currentWatch.key !== item.key) return; // stale fetch
      if (t) { el.textContent = t; persistTitle(item, t); }
      else { el.textContent = ''; el.classList.add('hidden'); }
    });
  }
}

async function persistTitle(item, title) {
  try {
    if (!item.scopeId) return;
    await db.setVideoFields(item.scopeId, item.key, {
      title, titleSource: 'oembed', normTitle: normalizeTitle(title)
    });
    item.title = title;
  } catch {}
}

/* ---------------- Delete from the watch page (v1.0.5) ---------------- */
/**
 * User-specified order: tap 🗑️ → parent PIN (EVERY tap — no session caching) →
 * an explicit "delete this video?" confirm → delete → home. Deletion goes through
 * db.deleteVideo (atomic delete + deny-list tombstone), so the video never comes
 * back — not on the next sync, not on other devices (the tombstone travels via
 * the Drive backup).
 */
async function onDeleteWatch() {
  const item = currentWatch;
  if (!item || !item.key) return;
  // Capture the item BEFORE navigating: entering the pin view tears the player
  // down (watch onLeave) and clears currentWatch.
  startPin((await hasPin()) ? 'verify' : 'setup', {
    replace: true,
    title: 'קוד הורים למחיקת הסרטון',
    onSuccess: () => { confirmDeleteWatch(item); }
  });
}

async function confirmDeleteWatch(item) {
  const yes = await confirmKid({
    emoji: '🗑️', title: 'למחוק את הסרטון הזה?',
    text: item.title || 'הסרטון יוסר מהספרייה לצמיתות',
    ok: 'מחיקה', cancel: 'ביטול', danger: true
  });
  if (yes) {
    try {
      // Delete EVERY copy of this key: the same video can live both in the shared
      // library (channel/sheet) and in the profile scope (manual add) — removing
      // just the played copy would leave the other one visible on the home grid.
      const scopes = new Set([item.scopeId, libScope,
        activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean));
      let deleted = false;
      let sheetBacked = false;
      let channelVideo = null;
      for (const scope of scopes) {
        const rec = await db.getVideo(scope, item.key);
        if (rec) {
          if ((rec.homeFolderId || rec.folderId) === 'sheet') sheetBacked = true;
          if (rec.channelId) channelVideo = rec;
          await db.deleteVideo(scope, item.key); // atomic delete + deny tombstone
          deleted = true;
        }
      }
      if (deleted) {
        giftStates.delete(item.key);
        if (activeProfileId) { try { await db.deleteVideoState(activeProfileId, item.key); } catch {} }
        // The sheet carries the deletion to every participant (v1.0.10/12):
        // a sheet-backed single loses its ROW; a video inside a CHANNEL has no row
        // of its own, so it gets a '# הוסר' removal row instead.
        if (sheetBacked) enqueueSheetDeleteVideo(item.key);
        else if (channelVideo) enqueueSheetRemoval(item.key, channelVideo.srcUrl || channelVideo.url || '', channelVideo.title || item.title || '');
        maybeSchedulePush();
      }
    } catch { /* a failed delete must never strand the child outside the gallery */ }
  }
  goGallery();
}

/* ---------------- Interactive share add (v1.0.7) ---------------- */
/**
 * A share from YouTube now opens the ASK flow (user-specified order): parent PIN →
 * "add this video / whole channel?" → added live + registered in the sheet.
 * Returns share.js's decision: 'live' | 'pending' | 'channel' | null.
 * PIN cancel or a "not now" answer parks a VIDEO as pending (never lost); a channel
 * share is simply not added. When a PIN/modal is already up we don't interrupt —
 * the share falls back to the silent pending route.
 */
function handleShareInteractive(c) {
  // v1.0.27: a PLAYLIST is a source, here too. It fell into the video branch below, so
  // the parent typed the PIN, was asked "להוסיף את הסרטון?", tapped הוספה — and
  // handleSourceShare, which accepts only the 'channel' decision, answered "ההוספה
  // בוטלה". The v1.0.26 share-a-playlist feature could not succeed on ANY path.
  const isSource = c.kind === 'channel' || c.kind === 'playlist';
  const isPl = c.kind === 'playlist';
  if (nav.isActive('pin') || isModalOpen()) return Promise.resolve(isSource ? null : 'pending');
  return new Promise((resolve) => {
    (async () => {
      startPin((await hasPin()) ? 'verify' : 'setup', {
        replace: nav.isActive('watch'), // never leave a torn-down player behind
        title: isPl ? 'קוד הורים להוספת רשימת ההשמעה'
          : c.kind === 'channel' ? 'קוד הורים להוספת הערוץ' : 'קוד הורים להוספת הסרטון',
        onDone: (success) => { if (!success) resolve(isSource ? null : 'pending'); },
        onSuccess: async () => {
          if (isSource) {
            // ערוץ is masculine, רשימה feminine — the same rule channelAddOutcome follows.
            const yes = await confirmKid(isPl
              ? { emoji: '🎵', title: 'להוסיף את רשימת ההשמעה כולה?',
                  text: (c.title ? c.title + ' — ' : '') + 'כל הסרטונים שבה ימתינו לאישור הורים.',
                  ok: 'הוספת הרשימה', cancel: 'לא עכשיו' }
              : { emoji: '📺', title: 'להוסיף את הערוץ כולו?',
                  text: (c.title ? c.title + ' — ' : '') + 'סרטונים חדשים שלו ימתינו לאישור הורים.',
                  ok: 'הוספת הערוץ', cancel: 'לא עכשיו' });
            // 'channel' is the SOURCE-decision token handleSourceShare keys on — one
            // token for both kinds, because the routing question is the same.
            resolve(yes ? 'channel' : null);
          } else {
            const yes = await confirmKid({
              emoji: '▶️', title: 'להוסיף את הסרטון?',
              text: c.title || c.srcUrl || '', ok: 'הוספה', cancel: 'לא עכשיו'
            });
            resolve(yes ? 'live' : 'pending');
          }
          goGallery();
        }
      });
    })().catch(() => resolve(isSource ? null : 'pending'));
  });
}

/* v1.0.10: fire-and-forget sheet write-back helpers (never block the UI) */
function enqueueSheetDeleteVideo(key) {
  import('./sheetwrite.js')
    .then((sw) => sw.enqueueSheetVideoDelete(activeProfileId, key))
    .then(() => refreshSheetWriteStatus().catch(() => {}))
    .catch(() => {});
}
function enqueueSheetDeleteChannel(channelId, kind = 'channel') {
  import('./sheetwrite.js')
    .then((sw) => sw.enqueueSheetChannelDelete(activeProfileId, channelId, kind))
    .then(() => refreshSheetWriteStatus().catch(() => {}))
    .catch(() => {});
}
/** v1.0.12: '# הוסר' row for a video that lives inside a channel (no row of its own). */
function enqueueSheetRemoval(key, srcUrl, title) {
  import('./sheetwrite.js')
    .then((sw) => sw.enqueueSheetRemovalRow(activeProfileId, { key, srcUrl, title }))
    .then(() => refreshSheetWriteStatus().catch(() => {}))
    .catch(() => {});
}

/* ---------------- PIN ---------------- */
async function openParentGate() {
  startPin((await hasPin()) ? 'verify' : 'setup');
}
function updateDots() {
  const dots = $('pin-dots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('filled', i < pinBuffer.length);
}
/**
 * PIN gate (parameterized since v1.0.5 — it also guards in-place deletion).
 * onSuccess runs once after a correct code (or after setup completes).
 * replace=true swaps the CURRENT view for the pin view instead of stacking on
 * top of it — the delete flow uses it so hardware-back never lands on a watch
 * page whose player was already torn down.
 */
function startPin(mode, { onSuccess = enterParent, replace = false, title = '', onDone = null } = {}) {
  pinMode = mode; pinBuffer = ''; pinFirst = ''; pinStep = 1;
  pinOnSuccess = onSuccess;
  pinDone = onDone;
  $('pin-msg').textContent = '';
  $('pin-title').textContent = mode === 'setup' ? 'בחרו קוד הורים חדש' : (title || 'הזינו קוד הורים');
  updateDots();
  // The recovery affordance belongs to 'verify' only — in SETUP there is no code yet to
  // have forgotten, and offering a reset there would be a second way to choose the first
  // PIN. Refreshed on every entry because a wait started yesterday may now be ready.
  refreshPinRecovery().catch(() => {});
  if (replace) nav.replace('pin'); else nav.go('pin');
}

/**
 * Draw the "שכחתי את הקוד" affordance for the CURRENT state of a recovery request.
 *
 * Three states, three different things to offer: nothing asked yet (a button that starts
 * the wait), waiting (the countdown plus a way to call it off), and ready (a button that
 * goes straight to choosing a new code). Failure here must never take the PIN screen down
 * with it — the gate still has to work — so every caller swallows.
 */
async function refreshPinRecovery() {
  const btn = $('pin-forgot');
  const note = $('pin-recovery-note');
  if (pinMode !== 'verify') {
    btn.classList.add('hidden');
    note.classList.add('hidden');
    return;
  }
  const { recoveryState } = await import('./recovery.js');
  const { pinRecoveryLabel, planRecoveryRoute } = await import('./plan.js');
  const { canDeviceAuth } = await import('./platform.js');
  const st = await recoveryState();
  const route = planRecoveryRoute({ deviceAuth: await canDeviceAuth(), recovery: st });
  btn.classList.remove('hidden');
  if (route === 'wait-ready') {
    btn.textContent = 'איפוס הקוד — מוכן ✅';
    note.textContent = `תמו ${PIN_RECOVERY_DELAY_HOURS} השעות. אפשר לקבוע קוד הורים חדש.`;
    note.classList.remove('hidden');
  } else if (route === 'wait-pending') {
    btn.textContent = 'ביטול בקשת האיפוס';
    note.textContent = pinRecoveryLabel(st);
    note.classList.remove('hidden');
  } else {
    // 'device' and 'wait-start' share a label on purpose: the parent is answering "I forgot
    // it", not choosing a mechanism. Which one they get is the device's business, and if
    // the prompt fails they are offered the wait without ever having to understand why.
    btn.textContent = 'שכחתי את הקוד';
    note.classList.add('hidden');
  }
}

/**
 * The one handler behind that button — what it does depends on the state it is showing.
 *
 * The RESET itself runs `startPin('setup', { replace: true })`: `replace` so hardware-back
 * cannot land on the verify screen we just satisfied, and the request is cleared BEFORE
 * the new code is chosen so an abandoned setup cannot leave a spent request armed.
 */
async function onPinForgot() {
  const { recoveryState, requestRecovery, cancelRecovery } = await import('./recovery.js');
  const { planRecoveryRoute } = await import('./plan.js');
  const { canDeviceAuth, deviceAuth } = await import('./platform.js');
  const st = await recoveryState();
  const route = planRecoveryRoute({ deviceAuth: await canDeviceAuth(), recovery: st });

  if (route === 'wait-ready') {
    await cancelRecovery();
    startPin('setup', { replace: true, onSuccess: enterParent });
    return;
  }
  if (route === 'wait-pending') {
    const stop = await confirmKid({
      emoji: '🔓', title: 'לבטל את בקשת האיפוס?',
      text: 'קוד ההורים הנוכחי יישאר בתוקף.', ok: 'ביטול הבקשה', cancel: 'להשאיר'
    });
    if (stop) { await cancelRecovery(); await refreshPinRecovery(); }
    return;
  }
  if (route === 'device') {
    // The one-second path. A SUCCESS goes straight to choosing a new code — the device
    // just proved an adult is present, which is a stronger claim than any wait can make.
    const ok = await deviceAuth('אימות הורה', 'אישור בעזרת נעילת המכשיר כדי לקבוע קוד הורים חדש');
    if (ok) { startPin('setup', { replace: true, onSuccess: enterParent }); return; }
    // A FAILURE is not a dead end. Cancelled, no finger enrolled after all, locked out,
    // or a prompt that could not open under screen pinning — the parent still gets the
    // wait, which is the whole reason it is the floor and not an alternative.
    const useWait = await confirmKid({
      emoji: '⏳', title: 'האימות לא הושלם',
      text: `אפשר במקום זאת לבקש איפוס בהמתנה: בעוד ${PIN_RECOVERY_DELAY_HOURS} שעות אפשר יהיה לקבוע קוד חדש.`,
      ok: 'בקשת איפוס בהמתנה', cancel: 'לא עכשיו'
    });
    if (!useWait) return;
    await requestRecovery();
    await refreshPinRecovery();
    await refreshRecoveryBanner();
    return;
  }

  const go = await confirmKid({
    emoji: '⏳', title: 'לאפס את קוד ההורים?',
    text: `מטעמי בטיחות האיפוס לא מיידי: בעוד ${PIN_RECOVERY_DELAY_HOURS} שעות אפשר יהיה לקבוע קוד חדש. ` +
          'עד אז תופיע הודעה במסך הבית, וכל אחד יוכל לבטל את הבקשה.',
    ok: 'בקשת איפוס', cancel: 'לא עכשיו'
  });
  if (!go) return;
  await requestRecovery();
  await refreshPinRecovery();
  await refreshRecoveryBanner();
}
async function onPinComplete() {
  if (pinMode === 'setup') {
    if (pinStep === 1) {
      pinFirst = pinBuffer; pinBuffer = ''; pinStep = 2;
      $('pin-title').textContent = 'הקלידו שוב לאישור';
      updateDots();
      return;
    }
    if (pinBuffer === pinFirst) { await setPin(pinBuffer); consumePinDone(true); pinOnSuccess(); }
    else {
      $('pin-msg').textContent = 'הקודים לא תואמים, נסו שוב';
      pinBuffer = ''; pinFirst = ''; pinStep = 1;
      $('pin-title').textContent = 'בחרו קוד הורים חדש';
      updateDots();
    }
  } else {
    if (await verifyPin(pinBuffer)) { consumePinDone(true); pinOnSuccess(); }
    else { $('pin-msg').textContent = 'קוד שגוי'; pinBuffer = ''; updateDots(); }
  }
}
function onKey(k) {
  if (k === 'del') { pinBuffer = pinBuffer.slice(0, -1); updateDots(); return; }
  if (pinBuffer.length >= 4) return;
  pinBuffer += k;
  updateDots();
  if (pinBuffer.length === 4) setTimeout(onPinComplete, 130);
}

/* ---------------- Voluntary support (v1.0.14) ---------------- */
// Everything here lives behind the parent PIN: a child can never reach a payment
// page. Links open in the SYSTEM browser (the WebView blocks external navigation).

/** Tap "תרומה" → choose HOW to pay (only configured methods are offered). */
async function openDonateFlow() {
  const msg = $('donate-msg');
  msg.textContent = ''; msg.className = 'form-msg';
  const { donateOptions } = await import('./donate.js');
  const opts = donateOptions();
  if (!opts.length) return;

  let chosen = opts[0];
  if (opts.length > 1) {
    // confirmKid gives exactly two big choices — enough for PayBox vs PayPal, and
    // an accidental dismiss must NOT pick a payment method (askKid tells them apart).
    const answer = await askKid({
      emoji: '💜', title: 'איך נוח לכם לתרום?',
      text: `${opts[0].label} — ${opts[0].hint}\n${opts[1].label} — ${opts[1].hint}`,
      ok: opts[0].label, cancel: opts[1].label
    });
    if (answer === 'dismiss') return;
    chosen = answer === 'ok' ? opts[0] : opts[1];
  }
  const { openExternal } = await import('./platform.js');
  const opened = await openExternal(chosen.url);
  msg.textContent = opened
    ? 'נפתח דף התרומה בדפדפן — תודה מכל הלב 💜'
    : 'לא הצלחנו לפתוח את הדפדפן. הקישור: ' + chosen.url;
  msg.className = opened ? 'form-msg ok' : 'form-msg err';
}

/** Show the donate button only when a link is actually configured. */
async function refreshDonateUi() {
  try {
    const { donateAvailable, shouldShowDonateNudge } = await import('./donate.js');
    const available = donateAvailable();
    $('donate-btn').classList.toggle('hidden', !available);
    $('help-block').classList.toggle('hidden', false); // free ways to help always apply
    const show = shouldShowDonateNudge({
      firstSeenAt: Number(await prefGet('install.firstSeenAt')) || 0,
      dismissed: (await prefGet('donate.nudgeDismissed')) === '1'
    });
    $('donate-nudge').classList.toggle('hidden', !show);
  } catch {}
}

/* ---------------- Parent screen (tabs: about / approve / add / sources / settings) ---------------- */
/**
 * v1.0.24 — the landing tab is DECIDED before the view is shown, never corrected after.
 * `refreshParent` calls `setParentTab` before it awaits the lists, so choosing the tab
 * from the pending count inside it would render אודות and then visibly jump.
 *
 * The count is one indexed COUNT per scope, but awaiting it still yields to the event
 * loop — if hardware-back left the pin view in that window the parent changed their mind,
 * and replacing whatever is on top now with the parent screen would be a real bug.
 */
async function enterParent() {
  let total = 0;
  try { total = await pendingTotal(); } catch {}
  parentTab = parentLandingTab(parentTab, total);
  if (!nav.isActive('pin')) return;
  refreshParent();
  nav.replace('parent'); // replaces 'pin' on the stack
}

// v1.0.14: "אודות" is the first tab AND the default landing tab of the parent screen.
// v1.0.24: the list itself lives in plan.js, next to `parentLandingTab` which validates
// against it — two hand-kept copies would let the override name a tab that does not exist.
const PARENT_TABS = PARENT_TAB_IDS;
let parentTab = 'about';

function setParentTab(name) {
  parentTab = name;
  for (const t of PARENT_TABS) {
    $('tab-' + t).classList.toggle('active', t === name);
    $('panel-' + t).classList.toggle('hidden', t !== name);
  }
}

// v1.0.19's connectSheetUrl lived here. v1.0.32 removed it with its last callers (the
// sources tab's create/join buttons — user request): the profile-creation WIZARD is
// now the only place a sheet is attached, and it has its own connectWizardSheet, which
// routes through adoptLibraryScope exactly the same way. Re-attaching a sheet from the
// sources tab must go through that migration too if it ever comes back.

/**
 * The sources panel's sheet section — status only since v1.0.32: create / join /
 * disconnect are no longer parent-facing (user request); the wizard at profile
 * creation is the one place a list is chosen.
 */
async function refreshSourcesPanel() {
  const src = await db.getSources(activeProfileId);
  const cur = $('remote-current');
  if (!cur) return;
  // Only claim the folder when the move actually succeeded (sources.sheetFolderId).
  // Asserting it unconditionally sent parents hunting for a folder that isn't there.
  cur.textContent = !(src && src.sheetUrl)
    ? 'אין רשימת מקורות מחוברת לפרופיל הזה — הסרטונים והערוצים נשמרים באפליקציה.'
    : src.sheetFolderId
      ? 'הרשימה מחוברת ✅ הקובץ נמצא בגוגל דרייב שלכם, בתיקייה "רשימת השמעה לאפליקציה הסרטונים שלי".'
      : 'הרשימה מחוברת ✅ הקובץ נמצא בגוגל דרייב שלכם.';
  cur.className = 'field remote-current' + (src && src.sheetUrl ? ' ok' : '');
}

async function refreshParent() {
  const src = await db.getSources(activeProfileId);
  await refreshSourcesPanel();
  $('share-approval-toggle').checked = await getSetting(activeProfileId, 'shareApproval', true) !== false;
  $('exit-lock-toggle').checked = await exitLockOn();
  $('autoplay-toggle').checked = (await getSetting(activeProfileId, 'autoplay', false)) === true;
  $('resume-toggle').checked = (await getSetting(activeProfileId, 'resume', false)) === true;
  // v1.0.31: scheduled lock — load both numbers (0 after = off)
  $('lock-after-min').value = String(Number(await getSetting(activeProfileId, 'lockAfterMin', 0)) || 0);
  $('lock-duration-min').value = String(Number(await getSetting(activeProfileId, 'lockDurationMin', SCHED_LOCK_DEFAULT_DURATION_MIN)) || SCHED_LOCK_DEFAULT_DURATION_MIN);
  await labelProfileSettings();
  // v1.0.22: a same-name collision that ALREADY happened (both devices offline at once)
  // cannot be blocked retroactively, and merging or renaming it silently would be worse —
  // so tell the parent and let them rename or delete. Nothing is touched automatically.
  const dups = duplicateProfileNames(await getProfiles());
  const dupEl = $('dup-profiles');
  dupEl.classList.toggle('hidden', !dups.length);
  if (dups.length) {
    const names = dups.map((d) => `"${d.name}" (${d.ids.length})`).join(', ');
    dupEl.textContent = `⚠️ יש יותר מפרופיל אחד באותו שם: ${names}. זה קורה כששני מכשירים יצרו את אותו שם בלי חיבור לאינטרנט. הילד רואה שני אווטארים זהים, וההתקדמות שלו (מתנות וסרטונים אישיים) מתפצלת ביניהם — כדאי לשנות שם לאחד מהם, או למחוק את המיותר.`;
  }
  $('add-msg').textContent = '';
  $('remote-status').textContent = '';
  $('approve-msg').textContent = '';
  setParentTab(parentTab);
  refreshDonateUi().catch(() => {});
  refreshDriveStatus();
  refreshSheetWriteStatus().catch(() => {});
  runUpdateCheck().catch(() => {});
  await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
}

/** v1.0.6: surface the sheet write-back queue state in the sources tab.
    v1.0.10: also the mirror safety-valve alert (mass row disappearance). */
async function refreshSheetWriteStatus() {
  const el = $('sheetwrite-status');
  el.textContent = '';
  el.className = 'form-msg';
  if (!libScope) return;

  const alert = await db.getMeta('sheetMirrorAlert:' + libScope);
  $('mirror-alert').classList.toggle('hidden', !alert);
  if (alert) {
    $('mirror-alert-text').textContent =
      `⚠️ ${alert.disappeared} שורות נעלמו מקובץ המקורות בבת אחת — ייתכן שנמחקו בכוונה, וייתכן שזו תקלת קריאה. המחיקה אצלך הושהתה עד להחלטתך:`;
  }

  const { sheetWriteState, flushSheetQueue } = await import('./sheetwrite.js');
  await flushSheetQueue(activeProfileId).catch(() => {}); // opportunistic retry on entry
  const st = await sheetWriteState(libScope);
  if (!st) return;
  if (st.dropped) {
    // The write queue hit its cap and REFUSED an op. A refused delete is the dangerous
    // one: its row stays in the sheet, and the mirror reads that presence as a
    // deliberate re-add. Never let this hide behind the reassuring "pending" line.
    el.textContent = `⚠️ ${st.dropped} פעולות לא נרשמו בקובץ הרשימה (תור הכתיבה מלא) — ייתכן שמחיקות או הוספות שביצעתם לא יעברו למכשירים אחרים. בדקו את קובץ הרשימה ידנית. `;
    el.className = 'form-msg err';
    // …and it must be DISMISSIBLE: `acknowledgeDropped` existed with no caller, so once
    // this warning appeared it stayed forever, hiding every later queue status behind it.
    const ack = document.createElement('button');
    ack.type = 'button';
    ack.className = 'text-btn';
    ack.textContent = 'הבנתי, אפשר להסתיר';
    ack.addEventListener('click', async () => {
      const { acknowledgeDropped } = await import('./sheetwrite.js');
      await acknowledgeDropped(libScope);
      await refreshSheetWriteStatus();
    });
    el.appendChild(ack);
    return;
  }
  if (st.error === 'no-edit-permission') {
    el.textContent = '⚠️ אין הרשאת עריכה לגיליון — סרטונים שנוספו באפליקציה לא נרשמים בו. שתפו את הגיליון לחשבון Google המחובר כעורך.';
    el.className = 'form-msg err';
  } else if (st.error === 'published-link') {
    // v1.0.19: the old copy told the parent to "paste the normal edit link" — advice
    // they can no longer follow, because the paste field is gone. Point at the action
    // that actually exists now.
    el.textContent = '⚠️ לא ניתן לכתוב לרשימה הזו (קובץ שחובר בגרסה ישנה). צרו רשימה חדשה כאן — התוכן הקיים יעבור אליה אוטומטית.';
    el.className = 'form-msg err';
  } else if (st.error === 'no-token' && st.pending) {
    el.textContent = `${st.pending} סרטונים ממתינים להירשם בגיליון — יירשמו אוטומטית אחרי חיבור חשבון Google (בהגדרות).`;
  } else if (st.pending) {
    el.textContent = `${st.pending} סרטונים ממתינים להירשם בגיליון — יירשמו אוטומטית בסנכרון הבא.`;
  }
}

/** Update panel state (settings tab). manual=true bypasses the 6h throttle. */
async function runUpdateCheck({ manual = false } = {}) {
  const msg = $('update-msg');
  const upd = await import('./update.js');
  const local = await upd.currentVersion();
  $('ver-current').textContent = local || 'דפדפן';
  if (manual) { msg.textContent = 'בודק…'; msg.className = 'form-msg'; }
  const r = await upd.checkForUpdate({ silent: !manual, force: manual });
  if (r.latest) $('ver-latest').textContent = r.latest.version;
  // 'skipped' = the launch prompt was declined — still installable from here, and it
  // keeps the red dot on the ABOUT tab (the update UI's home since v1.0.8).
  const installable = r.status === 'available' || r.status === 'skipped';
  $('update-install').classList.toggle('hidden', !installable);
  $('about-dot').classList.toggle('hidden', !installable);
  if (!manual) return;
  msg.className = 'form-msg';
  msg.textContent =
    r.status === 'available' ? `יש גירסה חדשה: ${r.latest.version} 🎉`
    : r.status === 'up-to-date' ? 'האפליקציה מעודכנת ✅'
    : r.status === 'browser' ? 'בדיקת עדכון זמינה באפליקציה המותקנת בלבד'
    : r.status === 'no-asset' ? 'לא נמצא קובץ התקנה בגירסה האחרונה'
    : 'לא הצלחנו לבדוק (אין רשת?)';
}

async function refreshDriveStatus() {
  // v1.0.32: an ACTIVE backup shows NOTHING (user request — it is automatic, and a
  // status line + manual button only invited fiddling). The block survives solely as
  // the enable path for a family that skipped the first-launch Google connect; hiding
  // it for them too would leave no way to ever turn backup on.
  const meta = (await db.getMeta('drive')) || {};
  $('drive-block').classList.toggle('hidden', !!meta.enabled);
}

/** Push local state to Drive soon — no-op until the parent enabled backup. */
/* v1.0.22 — SHARED STATE TRAVELS BOTH WAYS.
 *
 * The app scheduled a PUSH on every mutation but called `pullDrive` from exactly three
 * places — the first-launch Google connect, profile creation, and the enable-backup
 * button. So an approval made on the phone reached Drive and sat there: the tablet had no
 * code path that read it, and the same profile showed a different library on every device.
 * Pulled here on profile activation (which covers every launch — a launch ends in one) and
 * on resume from the background.
 *
 * Non-negotiables:
 *  - SILENT and best-effort. Covering a populated grid with the loading screen is the
 *    worse bug (v1.0.18), and a network failure must never stop a child from watching.
 *  - ONE pull at a time. Two callers share the in-flight promise, the way `authorize()`
 *    shares a token request so two taps cannot pop two dialogs.
 *  - Throttled, because resume + activation can fire together.
 *  - Answers whether local data actually CHANGED, via the `db.dataVersion()` write
 *    counter, so the caller re-renders only when there is something new to show.
 */
const PULL_THROTTLE_MS = 60 * 1000;
let pullInFlight = null;
let lastPullAt = 0;

async function maybePullDrive({ force = false } = {}) {
  const meta = await db.getMeta('drive');
  if (!meta || !meta.enabled) return false; // Drive is opt-in, and not connected here
  if (pullInFlight) return pullInFlight;
  if (!force && Date.now() - lastPullAt < PULL_THROTTLE_MS) return false;
  const before = db.dataVersion();
  pullInFlight = (async () => {
    try {
      const { pullDrive } = await import('./drive.js');
      const r = await pullDrive(activeProfileId);
      lastPullAt = Date.now();
      return !!(r && r.ok) && db.dataVersion() !== before;
    } catch {
      return false;
    } finally {
      pullInFlight = null;
    }
  })();
  return pullInFlight;
}

/**
 * After activation: wait for the home-entry refresh that `nav.reset('gallery')` just
 * started, then put the loading screen away.
 *
 * This used to run its own pull-then-sync pipeline, which is the bug: the gallery's
 * onEnter had ALREADY started one synchronously, so the pull here raced the sync there.
 * All this owns now is the loading screen the caller raised — the work itself belongs to
 * `entryRefresh`, and there is only ever one of those.
 */
async function awaitEntryRefresh() {
  try {
    await entryRefreshInFlight;
  } finally {
    await loading.hide(); // idempotent; the ONLY guarantee the child depends on
    if (!nav.isActive('gallery') && nav.isActive('loading')) nav.reset('gallery');
  }
}

async function maybeSchedulePush() {
  const meta = (await db.getMeta('drive')) || {};
  if (!meta.enabled) return;
  const { schedulePush } = await import('./drive.js');
  schedulePush(profiles);
}

/**
 * One row of a parent list.
 *
 * `select` (v1.0.24, ממתינים only) turns the row into a selectable one: `{ id, checked,
 * onToggle }`. It reuses the picker's `.pick-cb` and its whole-row tap target, but NOT
 * `.pick-off` — see the CSS note: an unticked row here is simply outside the current bulk
 * action, not a video about to be thrown out.
 */
/* ---------------- Preview bubble (v1.0.26) ----------------
 * The parent needs to WATCH a video — scrub it, jump around — before deciding. Doing that
 * in the kid player would mean leaving the parent screen and losing the queue, the open
 * tab and the ticked rows, so this is an OVERLAY that changes nothing behind it.
 *
 * It deliberately does NOT reuse player.js:
 *  - `setupHud` binds window/document listeners and the invariant is that it must never
 *    run twice without a teardown; the parent screen is the wrong place to risk that;
 *  - the kid HUD hides the timeline and turns a centre tap into play/pause. For a parent
 *    EVALUATING content that is exactly backwards — they need YouTube's own scrub bar.
 * So: a plain iframe with `controls=1`, and a <video controls> for a direct file.
 *
 * MUTED on open (parent's decision): checking a video usually happens with the child in
 * the room, and a nursery rhyme at full volume is the one thing guaranteed to summon
 * them. Browsers also block autoplay WITH sound, so unmuted would often just not start.
 */
let previewCtx = null; // { items, idx, mode, onDecision }

function closePreview() {
  previewCtx = null;
  const host = $('pv-host');
  if (host) host.innerHTML = ''; // tearing out the iframe is what actually stops playback
  const el = $('preview-bubble');
  if (el) el.classList.add('hidden');
}

function isPreviewOpen() {
  const el = $('preview-bubble');
  return !!el && !el.classList.contains('hidden');
}

function renderPreview() {
  const ctx = previewCtx;
  if (!ctx) return closePreview();
  const rec = ctx.items[ctx.idx];
  if (!rec) return closePreview();

  $('preview-bubble').classList.remove('hidden');
  $('pv-title').textContent = (rec.title || '(ללא שם)')
    + (ctx.items.length > 1 ? `  ·  ${ctx.idx + 1}/${ctx.items.length}` : '');
  const host = $('pv-host');
  host.innerHTML = '';
  const src = previewEmbedUrl(rec);
  if (src) {
    const f = document.createElement('iframe');
    f.src = src;
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.setAttribute('allowfullscreen', '');
    host.appendChild(f);
  } else if (rec.url || rec.localPath) {
    const v = document.createElement('video');
    v.src = rec.localPath || rec.url;
    v.controls = true; v.muted = true; v.autoplay = true; v.playsInline = true;
    host.appendChild(v);
  }
  // Always offered, never conditional: an embedding-disabled video shows a black box
  // inside the iframe and there is no reliable, cheap way to detect that from here — and
  // a blocked video is exactly the kind a parent most wants to look at before deciding.
  $('pv-note').textContent = rec.type === 'youtube'
    ? 'לא מתנגן? ייתכן שהערוץ חסם הטמעה — אפשר לפתוח ביוטיוב.' : '';
  $('pv-open').classList.toggle('hidden', rec.type !== 'youtube');

  const pending = ctx.mode === 'pending';
  $('pv-approve').classList.toggle('hidden', !pending);
  $('pv-reject').classList.toggle('hidden', !pending);
  $('pv-delete').classList.toggle('hidden', pending);
}

/** Open the bubble on `items[idx]`. `mode` is 'pending' (approve/reject) or 'library'. */
function openPreview(items, idx, mode) {
  previewCtx = { items: (items || []).filter(Boolean), idx: Math.max(0, idx | 0), mode };
  renderPreview();
}

/**
 * The parent decided from inside the bubble. Advance to the next item rather than closing
 * (parent's decision): triaging thirty videos must not cost thirty open/close cycles.
 * The decided row is dropped from the local list so the counter stays honest.
 */
async function previewDecide(fn) {
  const ctx = previewCtx;
  if (!ctx) return;
  const rec = ctx.items[ctx.idx];
  if (!rec) return closePreview();
  let done = true;
  // `false` means the parent backed out (a cancelled confirm) — the video is untouched, so
  // advancing past it would silently skip the one they were still looking at.
  try { done = (await fn(rec)) !== false; } catch { done = false; }
  if (previewCtx !== ctx) return;          // the parent closed it while we awaited
  if (!done) return;
  ctx.items.splice(ctx.idx, 1);
  if (ctx.idx >= ctx.items.length) ctx.idx = ctx.items.length - 1;
  if (!ctx.items.length) return closePreview();
  renderPreview();
}

function parentRow({ rec, onDelete, onApprove, onPreview = null, note = '', select = null }) {
  const li = document.createElement('li');
  if (select) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'pick-cb';
    cb.checked = !!select.checked;
    li.dataset.sel = select.id;
    li.classList.toggle('li-sel', cb.checked);
    const apply = (on) => {
      cb.checked = on;
      li.classList.toggle('li-sel', on);
      select.onToggle(rec, on);
    };
    cb.addEventListener('change', () => apply(cb.checked));
    // The whole row toggles (a bare checkbox is a cruel target on a tablet) — but this row
    // also carries ✅ and 🗑️, and a tap on either must NEVER also flip the selection.
    li.addEventListener('click', (e) => {
      if (e.target === cb || e.target === img || (e.target.closest && e.target.closest('button'))) return;
      apply(!cb.checked);
    });
    li.appendChild(cb);
  }
  const img = document.createElement('img');
  img.className = 'li-thumb';
  setThumb(img, rec);
  // v1.0.26: the thumbnail is the preview target — the obvious thing to tap when you want
  // to SEE the video. It is excluded from the row's selection toggle below for the same
  // reason ✅ and 🗑️ are: one tap must mean one thing.
  if (onPreview) {
    img.classList.add('li-thumb-play');
    img.setAttribute('role', 'button');
    img.title = 'צפייה מהירה';
    img.addEventListener('click', (e) => { e.stopPropagation(); onPreview(rec); });
    // v1.0.29 (TV): a bare <img> is invisible to the D-pad. tabIndex puts it in the
    // focus scan; Enter needs explicit handling because only buttons activate natively.
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onPreview(rec); }
    });
  }
  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = rec.title || '(ללא שם)';
  const badge = document.createElement('span');
  badge.className = 'badge-type ' + (rec.type === 'youtube' ? 'badge-yt' : 'badge-file');
  badge.textContent = rec.type === 'youtube' ? 'YouTube' : 'קובץ';
  title.appendChild(badge);
  const sub = document.createElement('div');
  sub.className = 'li-sub';
  sub.textContent = rec.srcUrl || rec.url || '';
  body.appendChild(title);
  body.appendChild(sub);
  // v1.0.26: the rejected archive's per-row countdown to permanent deletion
  if (note) {
    const n = document.createElement('div');
    n.className = 'li-note li-ttl';
    n.textContent = '⏳ ' + note;
    body.appendChild(n);
  }
  li.appendChild(img);
  li.appendChild(body);
  if (onApprove) {
    const ok = document.createElement('button');
    ok.className = 'li-ok'; ok.type = 'button'; ok.textContent = '✅';
    ok.addEventListener('click', onApprove);
    li.appendChild(ok);
  }
  // v1.0.23: only when there IS a handler. It used to bind `undefined` unconditionally, so
  // a caller that omits onDelete rendered a 🗑️ that looks live and does nothing.
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
    del.addEventListener('click', onDelete);
    li.appendChild(del);
  }
  return li;
}

const PARENT_LIST_CAP = 200;

/** The library list — reads IndexedDB; deletion writes a TOMBSTONE (durable forever). */
async function refreshParentList() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const all = [];
  for (const s of scopes) {
    for (const rec of (await db.loadMergeIndex(s)).values()) {
      if (rec.state === 'live') all.push(rec);
    }
  }
  all.sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));
  $('list-count').textContent = `📚 הסרטונים הקיימים (${all.length})`;

  // v1.0.28 — grouped and folded (parent's request): one sub-section per folder the
  // child actually sees, all CLOSED by default so the tab opens onto the add form, not
  // onto hundreds of already-approved rows. Grouping is pure plan.groupLibraryByFolder;
  // the per-folder cap keeps the old PARENT_LIST_CAP promise per section instead of
  // globally, so a huge channel can no longer hide the small folders behind the cap.
  const shownLive = all.slice(0, PARENT_LIST_CAP * 4); // preview/delete work over this order
  const subsList = libScope ? await db.listLibraryChannels(libScope) : [];
  const groups = groupLibraryByFolder(shownLive, subsList);
  const host = $('parent-groups');
  const openIds = new Set([...host.querySelectorAll('details[open]')].map((d) => d.dataset.gid));
  host.innerHTML = '';
  const rowFor = (rec) => parentRow({
    rec,
    // v1.0.26: same quick-look here. These videos are already approved, so the bubble
    // offers DELETE — the one action this list has — after the parent has actually seen
    // what they are about to remove.
    onPreview: () => openPreview(shownLive, shownLive.indexOf(rec), 'library'),
    onDelete: async () => {
      await db.deleteVideo(rec.scopeId, rec.key); // atomic delete + deny tombstone
      // the sheet carries it to everyone: singles lose their row, channel videos
      // get a '# הוסר' removal row (v1.0.10/12)
      if ((rec.homeFolderId || rec.folderId) === 'sheet') enqueueSheetDeleteVideo(rec.key);
      else if (rec.channelId) enqueueSheetRemoval(rec.key, rec.srcUrl || rec.url || '', rec.title || '');
      await refreshParentList();
      renderHome();
      maybeSchedulePush();
    }
  });
  for (const g of groups) {
    const box = document.createElement('details');
    box.className = 'library-group';
    box.dataset.gid = g.id;
    // a rebuild after a delete keeps whatever the parent had open — the same
    // "the screen behind stays as it was" rule the pending list follows for ticks
    if (openIds.has(g.id)) box.open = true;
    const sum = document.createElement('summary');
    sum.className = 'library-group-head';
    const cap = Math.min(g.records.length, PARENT_LIST_CAP);
    sum.textContent = `${g.title} (${g.records.length})`;
    box.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'parent-list';
    for (const rec of g.records.slice(0, PARENT_LIST_CAP)) ul.appendChild(rowFor(rec));
    if (g.records.length > cap) {
      const more = document.createElement('li');
      more.className = 'li-note';
      more.textContent = `מוצגים ${cap} מתוך ${g.records.length}`;
      ul.appendChild(more);
    }
    box.appendChild(ul);
    host.appendChild(box);
  }
}

/**
 * v1.0.6: approved shares / manual items become sheet rows — channel videos do NOT
 * (their channel row already represents them in the sheet).
 */
/**
 * v1.0.18 — QUEUE ALL, THEN FLUSH ONCE.
 *
 * These records are already LIVE in the 'sheet' folder by the time we get here, so
 * until each one has a queued row it is sheet-backed, absent from the sheet, and
 * absent from pendingAppendKeys — which is exactly the shape the presence-mirror
 * deletes (with a tombstone, on every device). The old loop flushed inside every
 * enqueue, so approving N shares held that window open for N network round trips,
 * and one rejection mid-loop skipped every remaining record permanently.
 *
 * Enqueuing is local IndexedDB work, so the window now closes in one tick; the
 * single flush at the end does the network. Per-item catch: one bad record must
 * never cost the others their row.
 */
async function enqueueApprovedForSheet(recs) {
  const rows = (recs || []).filter((r) => r.origin === 'share-intent' || r.origin === 'manual');
  if (!rows.length) return;
  try {
    const { enqueueSheetRow, flushSheetQueue } = await import('./sheetwrite.js');
    for (const r of rows) {
      try {
        await enqueueSheetRow(
          activeProfileId,
          { key: r.key, srcUrl: r.srcUrl || r.url || '', title: r.title || '' },
          { flush: false }
        );
      } catch {}
    }
    await flushSheetQueue(activeProfileId);
  } catch {}
}

/**
 * v1.0.24 — which rows of the ממתינים queue are ticked.
 *
 * Keyed by scope AND key: the same `yt:<id>` can sit in the shared library and in the
 * personal scope at once, and `db.approvePending` takes ONE scope — acting on the wrong
 * copy would silently leave the other one waiting. NUL is the separator because it is the
 * one character a scopeId (`lib:…`/`prof:…`) and a key (`yt:…`) can never contain, so two
 * different pairs can never collide into a single id.
 */
const pendingSel = new Set();
const selIdOf = (rec) => rec.scopeId + '\u0000' + rec.key;
let pendingShownTotal = 0;

/** Bulk buttons follow the selection; the label always names what will actually happen. */
function paintPendingBulk() {
  const act = pendingBulkAction(pendingSel.size, pendingShownTotal);
  $('approve-all').textContent = act.approve;
  $('reject-all').textContent = act.reject;
  $('pending-bulk').classList.toggle('hidden', pendingShownTotal === 0);
  // "סמן הכול / נקה בחירה" needs at least two rows to mean anything
  $('pending-sel').classList.toggle('hidden', pendingShownTotal < 2);
}

/**
 * Tick or clear every RENDERED row. Rows past `PARENT_LIST_CAP` have no checkbox and so
 * can never be selected — covering those is exactly what the unselected "אישור הכול" /
 * "דחיית הכול" scope is for.
 */
function setPendingSelection(on) {
  pendingSel.clear();
  for (const li of $('pending-list').children) {
    const cb = li.querySelector('.pick-cb');
    if (!cb) continue;
    cb.checked = on;
    li.classList.toggle('li-sel', on);
    if (on) pendingSel.add(li.dataset.sel);
  }
  paintPendingBulk();
}

/**
 * Read the queue WITHOUT touching the DOM. Split out in v1.0.24 so the bulk handlers can
 * see fresh records before a confirm dialog: re-rendering first would clear the parent's
 * ticks, and cancelling the dialog would leave them with nothing selected.
 */
async function collectPending() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const all = [];
  let total = 0;
  for (const s of scopes) {
    const r = await db.pagePending(s, { limit: 500 });
    all.push(...r.items);
    total += r.total;
  }
  return { all, total };
}

/** Pending queue (channel discoveries / quarantined sheet rows / shares). */
async function refreshPendingList() {
  const { all, total: grandTotal } = await collectPending();
  const badge = $('pending-badge');
  badge.textContent = grandTotal;
  badge.classList.toggle('hidden', grandTotal === 0);
  const ul = $('pending-list');
  ul.innerHTML = '';
  // v1.0.26: say it out loud. An empty list looked identical to a list that had not
  // loaded, on the very screen the blue dot sends the parent to.
  $('pending-empty').classList.toggle('hidden', grandTotal > 0);
  // A rebuild always follows a mutation, so a surviving tick could point at a row that is
  // gone (or is now live) — which is why this used to clear the whole selection.
  //
  // v1.0.26 keeps the ticks that are STILL THERE instead. Filtering against the rebuilt
  // list gives the same guarantee (no id can survive its row) while not throwing away work
  // the parent did: deciding one video — from its own ✅, or from the preview bubble —
  // must not silently untick the twenty rows they had lined up. Doing this by parameter
  // first was wrong and the browser showed it: `refreshAfterAdd` rebuilds the list too, a
  // beat later, and cleared them right back.
  const carried = new Set(pendingSel);
  pendingSel.clear();
  pendingShownTotal = grandTotal;
  const shown = all.slice(0, PARENT_LIST_CAP);
  const alive = new Set(shown.map((r) => selIdOf(r)));
  for (const id of carried) if (alive.has(id)) pendingSel.add(id);
  for (const rec of shown) {
    ul.appendChild(parentRow({
      rec,
      onPreview: () => openPreview(all, all.indexOf(rec), 'pending'),
      select: {
        id: selIdOf(rec),
        checked: pendingSel.has(selIdOf(rec)),
        onToggle: (r, on) => {
          if (on) pendingSel.add(selIdOf(r)); else pendingSel.delete(selIdOf(r));
          paintPendingBulk();
        }
      },
      onApprove: async () => {
        await db.approvePending(rec.scopeId, [rec.key]);
        await enqueueApprovedForSheet([rec]);
        await refreshPendingList();
        renderHome();
        // approval is what makes the record LIVE, so this is the moment it becomes
        // eligible for enrichment and for a gift rank — see refreshAfterAdd
        refreshAfterAdd({ parent: true });
        maybeSchedulePush();
      },
      onDelete: async () => {
        // v1.0.23: parked in '~rejected', NOT tombstoned — the parent can pull it back out
        // of the rejected list below. No '# הוסר' sheet row either: that denies the key on
        // every device permanently and would defeat the restore. Emptying the rejected list
        // is what makes it final.
        await db.rejectPending(rec.scopeId, [rec.key]);
        await refreshPendingList();
      }
    }));
  }
  paintPendingBulk();
  // v1.0.24: the queue and the gate dot must never disagree. Rejecting the last waiting
  // video used to leave the dot lit until something happened to re-render the home.
  refreshGateDot();
  await refreshRejectedList();
  return all;
}

/** Every rejected record across the profile's scopes, newest rejection first. */
async function collectRejected() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const out = [];
  for (const s of scopes) out.push(...(await db.pageRejected(s, { limit: 500 })).items);
  return out.sort((a, b) => (b.rejectedAt || 0) - (a.rejectedAt || 0));
}

/**
 * v1.0.23 — the rejected archive. Rendered from inside refreshPendingList so the two lists
 * can never disagree about what is where: one rejection moves a row from one to the other.
 */
async function refreshRejectedList() {
  const rej = await collectRejected();
  const box = $('rejected-box');
  box.classList.toggle('hidden', rej.length === 0);
  $('rejected-summary').textContent = `דחויים (${rej.length})`;
  // v1.0.26 — the archive empties itself, and that deletion CANNOT be undone (for a video
  // inside a channel there is no way back at all: only a sheet re-add revokes a tombstone,
  // and a channel video has no row). So say it, and give every row its own countdown.
  const { daysLeft } = planRejectedPurge(rej, { days: REJECTED_TTL_DAYS });
  $('rejected-ttl').textContent = `סרטון שנדחה נמחק לצמיתות אוטומטית אחרי ${REJECTED_TTL_DAYS} יום.`;
  const ul = $('rejected-list');
  ul.innerHTML = '';
  for (const rec of rej.slice(0, PARENT_LIST_CAP)) {
    const left = daysLeft.get(rec.key);
    ul.appendChild(parentRow({
      rec,
      note: left ? (left === 1 ? 'נמחק מחר' : `נמחק בעוד ${left} ימים`) : '',
      // ↩️ back to the approval queue — deliberately NOT straight to live: the parent is
      // reconsidering, and the queue is where a decision gets made.
      onApprove: async () => {
        await db.restoreRejected(rec.scopeId, [rec.key]);
        await refreshPendingList();
        maybeSchedulePush();
      },
      // per-item permanent delete, confirmed: this is the one action here with no way back
      onDelete: async () => {
        const yes = await confirmKid({
          emoji: '🗑️', title: 'למחוק את הסרטון לצמיתות?',
          text: 'הוא לא יחזור — גם לא בסנכרון הבא ולא במכשירים האחרים.',
          ok: 'מחיקה', cancel: 'ביטול', danger: true
        });
        if (!yes) return;
        await db.purgeRejected(rec.scopeId, [rec.key]);
        await refreshPendingList();
        maybeSchedulePush();
      }
    }));
  }
}

/**
 * v1.0.32 — stamp "the parent made this channel's sync decision". What clears a row out
 * of the "ערוצים חדשים" section (pure plan.planChannelSections reads it). Stamped by the
 * three-way dialog's REAL answers and by the auto-approve toggle — never by "אחר כך".
 */
async function markChannelDecided(channelId) {
  const scope = await currentLibScope();
  if (!scope) return;
  const lc = (await db.listLibraryChannels(scope)).find((c) => c.channelId === channelId);
  if (lc && !lc.decidedAt) await db.putLibraryChannel({ ...lc, decidedAt: Date.now() });
}

/** A tap on a row in "ערוצים חדשים": the same three-way dialog the add flow raises. */
async function decideNewChannel(lc) {
  const res = await offerChannelApproval(lc.channelId);
  // A channel with an EMPTY queue has nothing to decide (Shorts-only, or auto-approved
  // meanwhile) — the dialog never opened, and a row that does nothing on tap reads as
  // broken. Treat the tap itself as the review.
  if (res.count === 0) {
    await markChannelDecided(lc.channelId);
    toast('אין סרטונים שממתינים בערוץ הזה — הועבר לרשימת הערוצים');
  }
  await Promise.all([refreshChannelsList(), refreshPendingList()]);
  renderHome();
}

/** One subscription row. `fresh` rows trade the auto-approve toggle for the decision button. */
async function channelRow(lc, { fresh = false } = {}) {
  const ch = (await db.getChannel(lc.channelId)) || {};
  const li = document.createElement('li');
  const logo = document.createElement('img');
  logo.className = 'li-thumb';
  logo.style.width = '46px';
  logo.style.aspectRatio = '1';
  logo.style.borderRadius = '50%';
  // v1.0.24: a channel with no avatar used to render an EMPTY <img> here — a blank hole,
  // not even the 📺 the home screen falls back to. And a URL that failed to load was
  // never reported, so it could never be replaced.
  if (ch.logoUrl) {
    logo.src = ch.logoUrl;
    logo.onerror = () => { logo.removeAttribute('src'); noteLogoFailure(lc.channelId); };
  }
  const body = document.createElement('div');
  body.className = 'li-body';
  const title = document.createElement('div');
  title.className = 'li-title';
  title.textContent = lc.titleOverride || ch.title || lc.channelId;
  body.appendChild(title);
  if (fresh) {
    // v1.0.32: the decision affordance — a real <button> (the TV remote needs one).
    const decide = document.createElement('button');
    decide.className = 'btn btn-small btn-primary';
    decide.type = 'button';
    decide.textContent = '⚙️ איך לסנכרן את הערוץ?';
    decide.addEventListener('click', () => decideNewChannel(lc).catch(() => {}));
    body.appendChild(decide);
  } else {
    const toggle = document.createElement('label');
    toggle.className = 'li-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!lc.autoApprove;
    cb.addEventListener('change', async () => {
      // flipping the toggle IS the sync decision (v1.0.32) — in either direction
      await db.putLibraryChannel({
        ...lc, autoApprove: cb.checked, autoApproveSource: 'ui',
        decidedAt: lc.decidedAt || Date.now()
      });
      if (!cb.checked) return;
      // v1.0.6: turning auto-approve ON offers to flush the channel's WAITING videos
      // too — otherwise they'd sit in ממתינים forever ("approved the channel, why is
      // the queue still full?"). Declining keeps them for one-by-one review.
      const keys = await pendingKeysOfChannel(lc.channelId);
      if (!keys.length) return;
      const yes = await confirmKid({
        emoji: '✅', title: `לאשר גם ${keys.length} סרטונים שממתינים?`,
        text: 'הם ייכנסו מיד לתיקיית הערוץ אצל הילד. "רק מהיום" ישאיר אותם ברשימת הממתינים.',
        ok: 'אישור הכול', cancel: 'רק מהיום והלאה'
      });
      if (!yes) return;
      await approveChannelBacklog(keys);
    });
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode('אישור אוטומטי לסרטונים חדשים'));
    body.appendChild(toggle);
  }
  const del = document.createElement('button');
  del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
  del.addEventListener('click', async () => {
    const yes = await confirmKid({
      emoji: '📺', title: 'להסיר את הערוץ?',
      text: 'הערוץ וכל הסרטונים שלו יימחקו — גם מקובץ המקורות, אצל כל מי שמשתמש בו. אפשר להוסיף אותו שוב בעתיד.',
      ok: 'הסרה', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    // v1.0.10: full cleanup — the subscription, its imported videos, AND the
    // sheet row (so the channel doesn't resurrect on the next sync, anywhere)
    const { applySheetMirror } = await import('./sync2.js');
    await applySheetMirror(libScope, { deleteChannelIds: [lc.channelId] });
    enqueueSheetDeleteChannel(lc.channelId, lc.kind || 'channel');
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    maybeSchedulePush();
  });
  // v1.0.21: a channel with NO long-form videos yields nothing, because Shorts are
  // excluded on purpose. Say it here — otherwise the parent sees an empty folder and
  // reasonably concludes the app is broken.
  if (ch.noLongForm) {
    const note = document.createElement('div');
    note.className = 'li-note';
    note.textContent = 'הערוץ הזה מפרסם רק Shorts — לא נמשכו ממנו סרטונים.';
    body.appendChild(note);
  }
  li.appendChild(logo);
  li.appendChild(body);
  li.appendChild(del);
  return li;
}

async function refreshChannelsList() {
  const ul = $('channels-list');
  const newUl = $('channels-new-list');
  ul.innerHTML = '';
  newUl.innerHTML = '';
  $('channels-new-box').classList.add('hidden');
  $('channels-count').textContent = 'ערוצים';
  if (!libScope) return;
  // v1.0.32: "ערוצים חדשים" above, the folded regular list below — pure
  // plan.planChannelSections decides membership (undecided + ≤24h) and the
  // newest-first order in both.
  const { fresh, rest } = planChannelSections(await db.listLibraryChannels(libScope));
  $('channels-new-box').classList.toggle('hidden', fresh.length === 0);
  $('channels-count').textContent = rest.length ? `ערוצים (${rest.length})` : 'ערוצים';
  for (const lc of fresh) newUl.appendChild(await channelRow(lc, { fresh: true }));
  for (const lc of rest) ul.appendChild(await channelRow(lc, { fresh: false }));
}

/**
 * v1.0.17 — the library scope is derived from the SHEET URL, so connecting a sheet
 * (or switching to another one) moves the profile to a different scope. Everything
 * the parent had already added lived in the old scope and simply DISAPPEARED from
 * the UI. Now the content follows the profile, and the moved items are registered
 * in the new sheet — which is also what keeps the presence-mirror from tombstoning
 * them (queued appends count as "not yet in the sheet, on purpose").
 */
async function adoptLibraryScope(profileId, oldLib, newLib) {
  // v1.0.18 — NEVER EMPTY A SHARED SCOPE. `lib:<fnv1a(sheet)>` is shared by EVERY
  // profile on that sheet (the wizard's "join <profile>'s file" button creates exactly
  // that) and moveScope *moves*: it deletes the source. Changing one child's sheet used
  // to carry the whole family library away — a blank home for the sibling and their
  // pending shares surfacing in this child's approval list. The decision itself is pure
  // `planScopeAdoption` (v1.0.20), so it is unit-tested rather than re-read by eye.
  const others = [];
  for (const p of await getProfiles()) {
    if (p.id === profileId) continue;
    const s = await db.getSources(p.id);
    others.push({ profileId: p.id, libraryId: (s && s.libraryId) || null });
  }
  const decision = planScopeAdoption(profileId, oldLib, newLib, others);
  if (decision.action !== 'move') {
    return decision.sharedWith.length
      ? { videoKeys: [], channelIds: [], sharedWith: decision.sharedWith }
      : { videoKeys: [], channelIds: [] };
  }

  const moved = await db.moveScope(oldLib, newLib);
  if (!moved.videoKeys.length && !moved.channelIds.length) return moved;
  // Queue every row BEFORE any network call, then flush once. These records are
  // already live in the new scope, so until their row is queued they are
  // sheet-backed, absent from the sheet and absent from pendingAppendKeys — the
  // exact shape the presence-mirror tombstones. Flushing inside the loop (the old
  // shape) held that window open for one round trip per item, and a single throw
  // skipped every remaining record with nothing recording that it was owed.
  try {
    const sw = await import('./sheetwrite.js');
    for (const key of moved.videoKeys) {
      try {
        const rec = await db.getVideo(newLib, key);
        if (!rec || rec.state !== 'live') continue;
        if ((rec.homeFolderId || rec.folderId) !== 'sheet') continue; // channel content has no row
        await sw.enqueueSheetRow(
          profileId,
          { key, srcUrl: rec.srcUrl || rec.url || '', title: rec.title || '' },
          { flush: false }
        );
      } catch { /* one bad record must not cost the others their row */ }
    }
    for (const channelId of moved.channelIds) {
      try {
        await sw.enqueueSheetRow(profileId, {
          key: 'ch:' + channelId,
          srcUrl: 'https://www.youtube.com/channel/' + channelId,
          flag: 'manual'
        }, { flush: false });
      } catch {}
    }
    await sw.flushSheetQueue(profileId);
  } catch { /* queued rows survive in IndexedDB; the next sync flushes them */ }
  return moved;
}

/** The profile's sources record, created on first use (stable library even without a sheet). */
/** The WAITING videos of one channel, in the shared library scope (channel content
    never lands anywhere else). One read — the caller decides what to do with them. */
async function pendingKeysOfChannel(sourceId) {
  const scope = await currentLibScope();
  if (!scope) return [];
  const { items } = await db.pagePending(scope, { limit: 5000 });
  // v1.0.26 — a source is a channel OR a standalone playlist. A playlist video keeps its
  // OWNER in `channelId` (that is what the title-dedupe index and the unify rule need), so
  // matching on channelId alone found ZERO for a playlist and the approval dialog never
  // appeared — the exact shape of the v1.0.22 bug, on the new path. A parked record
  // remembers where it will live in `homeFolderId`, and that is the honest test.
  return items
    .filter((r) => r.channelId === sourceId || r.homeFolderId === 'pl:' + sourceId)
    .map((r) => r.key);
}

/** Approve a channel's whole backlog + refresh everything that shows it. */
async function approveChannelBacklog(keys) {
  await db.approvePending(await currentLibScope(), keys);
  await loadGiftStates();
  await Promise.all([refreshPendingList(), refreshParentList(), refreshChannelsList()]);
  renderHome();
  // approvePending assigns no giftRank — planProfileGifts is the only assigner, so
  // without this the newly-approved videos arrive with no 🎁 at all
  refreshAfterAdd({ parent: true });
  maybeSchedulePush();
}

/** A playlist's row in the sources sheet — same shape as a channel's (v1.0.26). */
function enqueuePlaylistSheetRow(playlistId, flag) {
  return import('./sheetwrite.js')
    .then(({ enqueueSheetRow }) => enqueueSheetRow(activeProfileId, {
      key: 'pl:' + playlistId,
      srcUrl: 'https://www.youtube.com/playlist?list=' + playlistId,
      flag
    }))
    .catch(() => {});
}

/** The channel's row in the sources sheet; `flag` mirrors the in-app approval choice. */
function enqueueChannelSheetRow(channelId, flag) {
  return import('./sheetwrite.js')
    .then(({ enqueueSheetRow }) => enqueueSheetRow(activeProfileId, {
      key: 'ch:' + channelId,
      srcUrl: 'https://www.youtube.com/channel/' + channelId,
      flag
    }))
    .catch(() => {});
}

/**
 * v1.0.22 — ASK, once, right after a hand-added channel finishes importing.
 *
 * The channel is created `autoApprove:false`, so its ENTIRE back catalogue lands in the
 * approval queue and the child sees NOTHING — while the message said "הערוץ סונכרן ✅".
 * A real channel (@rotemama4kids) put 109 videos there and the parent reasonably
 * concluded the app had imported 2 of them. Pasting a channel link behind the PIN is a
 * deliberate parental act, so the backlog should not need 109 more taps; but it is also
 * the one moment before a stranger's whole catalogue reaches a 5-year-old, so we ask
 * instead of silently approving (parent's decision, 2026-07-31).
 * "Yes" also flips autoApprove, so future uploads flow without another visit here.
 * -> { approved, count } — count is the backlog size either way, for the message.
 */
async function offerChannelApproval(channelId) {
  const scope = await currentLibScope();
  const keys = await pendingKeysOfChannel(channelId);
  if (!keys.length) return { approved: false, count: 0 };
  const ch = (await db.getChannel(channelId)) || {};
  const name = ch.title ? '"' + ch.title + '"' : 'הערוץ';
  // v1.0.23 — THREE answers, because "yes / no" could not express the middle one. The
  // third button is a real button: mapping an answer onto an accidental dismiss would let
  // a child poking the scrim decide what reaches them.
  const answer = await askKid({
    emoji: '📺',
    title: `${keys.length} סרטונים ב${name}. מה לעשות איתם?`,
    text: 'אישור הכל: הכול נכנס מיד, וגם כל סרטון חדש שיעלה בערוץ בעתיד — בלי לשאול שוב. '
      + 'אישור ידני: תראו את כל הסרטונים ותסמנו אילו להשאיר. '
      + 'אחר כך: הכול ממתין בטאב "ממתינים" עד שתחליטו.',
    ok: 'אישור הכל', third: 'אישור ידני', cancel: 'אחר כך'
  });

  if (answer === 'ok') {
    // The dialog has closed, so the loading screen may come up without stacking on it.
    await withChannelWait('approve', { count: keys.length }, async () => {
      const lc = (await db.listLibraryChannels(scope)).find((c) => c.channelId === channelId);
      // The ✅ in the parent's channel list IS this flag — refreshChannelsList renders
      // `cb.checked = !!lc.autoApprove`, so approving here is what ticks it.
      // decidedAt (v1.0.32): this answer is THE sync decision — the row leaves "ערוצים חדשים".
      if (lc) await db.putLibraryChannel({ ...lc, autoApprove: true, autoApproveSource: 'ui', decidedAt: lc.decidedAt || Date.now() });
      await db.approvePending(scope, keys);
      // Re-flag the sheet row to match. reconcileOps keeps the later intent, so this wins
      // whenever the row has not flushed yet; once it HAS, sheet-presence dedupe skips the
      // append and the sheet keeps 'manual' — harmless, because a device joining the sheet
      // later then asks ITS parent the same question instead of inheriting our answer.
      await enqueueChannelSheetRow(channelId, 'auto');
    });
    return { approved: true, count: keys.length };
  }

  if (answer === 'third') {
    const picked = await pickChannelVideos(channelId, name);
    // v1.0.32: a SAVED pick is a sync decision; backing out of the picker is not —
    // exactly like "אחר כך", the row stays in "ערוצים חדשים".
    if (picked) await markChannelDecided(channelId);
    return { approved: false, count: keys.length, picked, kept: picked ? picked.kept : 0 };
  }
  // 'cancel' (אחר כך) and 'dismiss' both leave everything waiting — the safe default.
  return { approved: false, count: keys.length };
}

/**
 * v1.0.25 — ONE path for "a channel was just subscribed": import it, then ask.
 *
 * Both places a parent can add a channel must behave the same, and until now only the
 * parent screen did. A channel SHARED from YouTube subscribed it, fired a sync it never
 * waited for, and immediately reported success — so the entire back catalogue landed in
 * ממתינים with no dialog and no count, which is precisely the v1.0.22 bug that the parent
 * screen was fixed for. CLAUDE.md already claimed the question covered "parent screen +
 * share"; the code only ever covered one of them. Sharing them here is what stops the two
 * from drifting again.
 *
 * The wait is unavoidable: the dialog needs the backlog, and the backlog needs the sync.
 * loading.hide() runs in a `finally` and BEFORE the dialog — modals must never stack.
 */
/**
 * v1.0.26 — run one step of the channel-add flow behind a waiting screen that SAYS which
 * step it is (pure `plan.channelAddWait`).
 *
 * `defer: 250` is what makes this safe to wrap around short steps too: a fast path never
 * flashes a screen, so a two-video channel behaves exactly as it did before, while a
 * 500-video one has no silent gap left anywhere.
 *
 * ALWAYS hides in a `finally`, and every caller must hide BEFORE raising a modal — a
 * loading screen under a dialog is the stacking bug v1.0.18 called out.
 */
async function withChannelWait(stage, opts, fn) {
  const { channelAddWait } = await import('./plan.js');
  const text = channelAddWait(stage, opts) || {};
  loading.show({ defer: 250, title: text.title, step: text.step });
  try { return await fn(); } finally { await loading.hide(); }
}

// The blocking wait on the post-decision sync must not become a TRAP: nav swallows back on
// the loading view, so a sync that never settles would hold the parent there forever. The
// valve does not silently drop the screen — that would restore the exact ambiguity this
// feature removes — it hands back control and SAYS the work continues in the background.
const CHANNEL_FINISH_MAX_MS = 90000;

/** -> true if the work finished, false if the valve fired and it is still running. */
async function waitWithValve(promise, ms = CHANNEL_FINISH_MAX_MS) {
  let timer = null;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([promise.then(() => true).catch(() => true), timeout]); }
  finally { clearTimeout(timer); }
}

async function importChannelAndAsk(channelId) {
  // A brand-new channel backfills up to ~2000 videos — by far the longest wait a parent
  // triggers by hand, and it used to run behind a one-line message (v1.0.18).
  loading.show({ title: 'מושכים את הסרטונים של הערוץ', step: 'מתחילים…', pct: 0 });
  let synced = false;
  try {
    await syncLibrary(activeProfileId, { force: true, onProgress: (p) => loading.progress(p) });
    synced = true;
  } catch { /* reported by the caller */ } finally {
    await loading.hide();
  }
  if (!synced) return { synced: false, approved: false, count: 0, picked: null, empty: {} };

  const { approved, count, kept = 0, picked = null } = await offerChannelApproval(channelId);
  // Everything below used to run with the ORDINARY screen showing and no indication at
  // all — the field report. The heavy part is the second full sync inside refreshAfterAdd.
  let backgrounded = false;
  await withChannelWait('finishing', {}, async () => {
    await loadGiftStates();
    await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
    renderHome();
    // AWAITED here, silent everywhere else — see refreshAfterAdd's own comment. BOTH
    // answers need it: "אישור הכל" approves the backlog, and the manual picker keeps a
    // subset — either way those records are live but have no gift rank yet.
    if (approved || kept > 0) {
      backgrounded = !(await waitWithValve(refreshAfterAdd({ parent: true, wait: true })));
    }
    maybeSchedulePush();
  });
  return {
    synced: true, approved, count, backgrounded, picked,
    empty: await diagnoseEmptyChannel(channelId, count)
  };
}

/**
 * A channel that produced NOTHING: say which nothing it is.
 *
 * Until the planSyncDispatch fix a zero here was usually a LIE — the forced sync had
 * joined the launch run and never looked at this channel at all. Now that a zero is real,
 * the parent still deserves better than a reassuring ✅ over an empty folder: a
 * Shorts-only channel is a permanent fact about the channel (Shorts are excluded on
 * purpose, v1.0.21) and is worth saying out loud, which is what the parent's channel list
 * already does with `noLongForm`.
 *
 * Only read when there is nothing to report — two IDB reads that the common path skips.
 */
async function diagnoseEmptyChannel(channelId, count) {
  const ch0 = count ? await db.getChannel(channelId).catch(() => null) : null;
  // `isPlaylist` is needed for the WORDING whatever the count is — returning {} on the
  // common path made a successful playlist import announce itself as "הערוץ נוסף".
  if (count) return { isPlaylist: !!(ch0 && ch0.kind === 'playlist') };
  const ch = await db.getChannel(channelId).catch(() => null);
  const scope = await currentLibScope();
  const prefix = ch && ch.kind === 'playlist' ? 'pl:' : 'ch:';
  const live = await db.countFolder(scope, prefix + channelId).catch(() => 0);
  return { noLongForm: !!(ch && ch.noLongForm), hasLive: live > 0, isPlaylist: prefix === 'pl:' };
}


/**
 * v1.0.23 — the MANUAL choice: show every waiting video of one channel and keep only the
 * ticked ones. Everything unticked becomes 'rejected' — parked, invisible to the child, and
 * recoverable from the parent's rejected list (decision 2026-08-01: the parent asked for a
 * list they can pull things back out of, so this must NOT tombstone).
 *
 * Everything starts TICKED (the parent's choice): a channel is usually added because it is
 * wanted, so the common job is unticking a few. That is only safe BECAUSE unticking is
 * reversible — with the old permanent rejection, defaulting to "all" would have been a trap.
 * -> { kept, rejected } | null when the parent backed out
 */
function pickChannelVideos(channelId, name) {
  return new Promise((resolve) => {
    (async () => {
      const { compareForDisplay } = await import('./order.js');
      // Resolved, not the bare global: since v1.0.25 a channel SHARED from YouTube can
      // reach this picker before any home render has published `libScope`.
      const scope = await currentLibScope();
      // v1.0.26: reading up to 5000 pending records and building a row + thumbnail for
      // each is the step that looked most like "my tap did nothing" — the parent screen
      // simply stayed put for seconds after they chose "אישור ידני".
      const recs = await withChannelWait('building', {}, async () => {
        const { items } = await db.pagePending(scope, { limit: 5000 });
        return items.filter((r) => r.channelId === channelId).sort(compareForDisplay);
      });
      const chosen = new Set(recs.map((r) => r.key)); // all ticked
      const ul = $('pick-list');
      const boxes = new Map();

      const paint = () => {
        $('pick-sub').textContent = `${name} · נבחרו ${chosen.size} מתוך ${recs.length}`;
        $('pick-ok').textContent = chosen.size === recs.length ? 'להשאיר את כולם' : `להשאיר ${chosen.size}`;
      };
      ul.innerHTML = '';
      for (const rec of recs) {
        const li = document.createElement('li');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.className = 'pick-cb';
        const img = document.createElement('img');
        img.className = 'li-thumb';
        setThumb(img, rec);
        const body = document.createElement('div');
        body.className = 'li-body';
        const title = document.createElement('div');
        title.className = 'li-title';
        title.textContent = rec.title || '(ללא שם)';
        body.appendChild(title);
        // the whole row toggles — a checkbox alone is a cruel target on a tablet
        const toggle = () => {
          cb.checked = !cb.checked;
          if (cb.checked) chosen.add(rec.key); else chosen.delete(rec.key);
          li.classList.toggle('pick-off', !cb.checked);
          paint();
        };
        li.addEventListener('click', (e) => { if (e.target !== cb) toggle(); });
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.add(rec.key); else chosen.delete(rec.key);
          li.classList.toggle('pick-off', !cb.checked);
          paint();
        });
        boxes.set(rec.key, { cb, li });
        li.appendChild(cb);
        li.appendChild(img);
        li.appendChild(body);
        ul.appendChild(li);
      }
      const setAll = (on) => {
        chosen.clear();
        for (const [key, { cb, li }] of boxes) {
          cb.checked = on;
          li.classList.toggle('pick-off', !on);
          if (on) chosen.add(key);
        }
        paint();
      };
      paint();

      let settled = false;
      const finish = async (commit) => {
        if (settled) return;
        settled = true;
        if (!commit) { resolve(null); return; }
        const keep = recs.filter((r) => chosen.has(r.key)).map((r) => r.key);
        const drop = recs.filter((r) => !chosen.has(r.key)).map((r) => r.key);
        // v1.0.26: the same silent gap as the bulk path — the parent tapped "להשאיר N"
        // and got the parent screen back while hundreds of records were still being
        // written. `importChannelAndAsk` owns the 'finishing' wait that follows.
        await withChannelWait('saving', { count: keep.length }, async () => {
          if (keep.length) {
            await db.approvePending(scope, keep);
            await enqueueApprovedForSheet(recs.filter((r) => chosen.has(r.key)));
          }
          if (drop.length) await db.rejectPending(scope, drop); // parked, NOT tombstoned
          await loadGiftStates();
          await Promise.all([refreshPendingList(), refreshParentList(), refreshChannelsList()]);
          renderHome();
        });
        // NO refreshAfterAdd here: `importChannelAndAsk` runs the one blocking
        // 'finishing' wait for BOTH answers. Firing a second, silent sync from this
        // branch is what left the manual path with the very gap this release removes.
        maybeSchedulePush();
        resolve({ kept: keep.length, rejected: drop.length });
      };

      pickHandlers = {
        ok: () => finish(true).catch(() => resolve(null)),
        cancel: () => finish(false),
        all: () => setAll(true),
        none: () => setAll(false)
      };
      nav.go('pick');
    })().catch(() => resolve(null));
  });
}

let pickHandlers = null;

async function ensureSources() {
  let src = await db.getSources(activeProfileId);
  if (!src) {
    src = {
      profileId: activeProfileId, schema: 1, sheetUrl: null, libraryId: 'lib:p:' + activeProfileId,
      shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
      maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: false }, updatedAt: Date.now()
    };
    await db.putSources(src);
  }
  libScope = src.libraryId;
  return src;
}

/** Add a single video (live immediately — the parent is right here) or a whole channel. */
async function parentAdd() {
  const url = $('add-url').value.trim();
  const msg = $('add-msg');
  if (!url) { msg.textContent = 'הדביקו קודם לינק'; msg.className = 'form-msg err'; return; }
  msg.textContent = 'מוסיף…'; msg.className = 'form-msg';

  const { classifySourceRow, titleFromFileUrl } = await import('./classify.js');
  const row = classifySourceRow(url);

  if (row.kind === 'video') {
    // v1.0.6: manual adds live in the SHARED library folder (single list for the
    // whole family) and are appended to the sheet — one master list, everywhere.
    const scope = (await ensureSources()).libraryId;
    const exists = (await db.getVideo(scope, row.key)) || (await db.getVideo(db.profScope(activeProfileId), row.key));
    if (exists) { msg.textContent = 'הסרטון כבר קיים ברשימה'; msg.className = 'form-msg err'; return; }
    const now = Date.now();
    // v1.0.32: the name/image form is gone (user request) — the name comes from the
    // content itself. YouTube: fetched below, like an empty field always was. A direct
    // file has no metadata to fetch, so its DISPLAY NAME derives from the filename in
    // the link (pure classify.titleFromFileUrl; Hebrew percent-encoding included) and
    // its thumbnail from the captured first frame (persistThumb, since v1.0.5).
    const title = row.type === 'file' ? titleFromFileUrl(row.srcUrl || row.url) : '';
    const rec = {
      scopeId: scope, key: row.key, type: row.type, id: row.id ?? null, url: row.url ?? null,
      srcUrl: row.srcUrl, driveId: row.driveId ?? null,
      title, titleSource: title ? 'sheet' : null, normTitle: normalizeTitle(title),
      folderId: 'sheet', channelId: null,
      sortKey: (await import('./order.js')).sortKeyFor({ origin: 'manual', addedAt: now }),
      publishedAt: null, rowIndex: null, origin: 'manual', state: 'live',
      addedAt: now, approvedAt: now,
      thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
    };
    await db.putVideos([rec]);
    const { enqueueSheetRow } = await import('./sheetwrite.js');
    // AWAITED before the forced sync below: the record is live + folderId 'sheet', i.e.
    // sheet-backed, and the presence-mirror deletes sheet-backed records the sheet does
    // not list. Racing its own row against its own sync could tombstone it (one item
    // never trips the safety valve). Every other add path already awaits this.
    await enqueueSheetRow(activeProfileId, { key: rec.key, srcUrl: rec.srcUrl, title: rec.title }).catch(() => {});
    if (!rec.title && rec.type === 'youtube') {
      fetchYouTubeTitle(rec.id).then((t) => t && persistTitle(rec, t)).catch(() => {});
    }
    $('add-url').value = '';
    msg.textContent = 'נוסף! ✅'; msg.className = 'form-msg ok';
    // the record is live but not yet enriched or gifted — see refreshAfterAdd
    refreshAfterAdd({ parent: true });
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
    return;
  }

  if (row.kind === 'channel') {
    msg.textContent = 'מזהה את הערוץ…';
    // v1.0.26: a @handle resolve is a real network step (up to a 1.5MB page scrape when
    // keyless) that used to run behind that one line of small text. defer:250 means a raw
    // /channel/UC… link — which resolves instantly — never flashes a screen for it.
    const channelId = await withChannelWait('resolve', {}, async () => {
      await ensureSources();
      const ytApi = await import('./yt.js');
      return ytApi.resolveChannelRef(row.channelRef, await ytApi.getApiKey());
    });
    if (!channelId) { msg.textContent = 'לא הצלחנו לזהות את הערוץ'; msg.className = 'form-msg err'; return; }
    await withChannelWait('subscribe', {}, async () => {
      const k = (await db.listLibraryChannels(libScope)).some((c) => c.channelId === channelId);
      await db.putLibraryChannel({
        libraryId: libScope, channelId, autoApprove: false, autoApproveSource: 'ui',
        order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
      });
      if (!k) { // v1.0.6: channels added here become sheet rows too (single master list)
        // AWAITED, like the video path above: the forced sync below runs the presence-mirror,
        // and a subscribed channel the sheet does not list is exactly what that deletes. The
        // queued append is what protects it (planSheetMirror's pendingAppendKeys).
        await enqueueChannelSheetRow(channelId, 'manual'); // approval-required for now
      }
    });
    msg.textContent = 'הערוץ נוסף! מושכים סרטונים…'; msg.className = 'form-msg ok';
    $('add-url').value = '';
    await refreshChannelsList();
    const { synced, approved, count, empty, picked } = await importChannelAndAsk(channelId);
    if (!synced) { msg.textContent = 'שגיאה במשיכת הערוץ'; msg.className = 'form-msg err'; return; }
    msg.textContent = channelAddOutcome(approved, count, empty, picked);
    msg.className = 'form-msg ok';
    return;
  }

  if (row.kind === 'playlist') {
    // v1.0.26 — a playlist is a SUBSCRIPTION, stored in the same table as a channel with
    // `kind:'playlist'`. classifySourceRow has recognised these since v1.0.12 and the app
    // then dropped them on the floor here, which is why pasting one has always answered
    // "הלינק לא נתמך" — a missing feature wearing the costume of a parse error.
    msg.textContent = 'מזהה את רשימת ההשמעה…';
    await ensureSources();
    const plId = row.playlistId;
    const known = (await db.listLibraryChannels(libScope)).some((c) => c.channelId === plId);
    await db.putLibraryChannel({
      libraryId: libScope, channelId: plId, kind: 'playlist',
      autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
    });
    // Same reason the channel path awaits this: the forced sync below runs the
    // presence-mirror, and a subscription the sheet does not list is what it deletes.
    if (!known) await enqueuePlaylistSheetRow(plId, 'manual');
    msg.textContent = 'רשימת ההשמעה נוספה! מושכים סרטונים…'; msg.className = 'form-msg ok';
    $('add-url').value = '';
    await refreshChannelsList();
    const { synced, approved, count, empty, picked } = await importChannelAndAsk(plId);
    if (!synced) { msg.textContent = 'שגיאה במשיכת רשימת ההשמעה'; msg.className = 'form-msg err'; return; }
    msg.textContent = channelAddOutcome(approved, count, empty, picked);
    msg.className = 'form-msg ok';
    return;
  }

  msg.textContent = 'הלינק לא נתמך (סרטון YouTube, ערוץ, רשימת השמעה, או קובץ mp4)';
  msg.className = 'form-msg err';
}

async function doSyncAndRefresh() {
  const status = $('remote-status');
  status.textContent = 'טוען…'; status.className = 'form-msg';
  // v1.0.18: a forced sync re-reads the whole sheet, every channel feed and every
  // logo — minutes on a big library. The .form-msg line stays (it holds the RESULT
  // once we are done); the full-screen view is what carries the wait itself.
  loading.show({ title: 'בודקים את רשימת הסרטונים', step: 'טוען…', pct: 0 });
  try {
    const res = await syncLibrary(activeProfileId, {
      force: true,
      onProgress: (p) => { status.textContent = p.label || 'טוען…'; loading.progress(p); }
    });
    if (res.ok && res.sheetError) {
      // v1.0.19: the pipeline ran, but the SHEET was never read. Saying "עודכן ✅"
      // here is how a permanently frozen library looked healthy — reads need a token
      // now, so a revoked grant or an unreadable file stops sync silently forever.
      const { sheetErrorMessage } = await import('./sheetwrite.js');
      status.textContent = sheetErrorMessage(res.sheetError);
      status.className = 'form-msg err';
    } else if (res.ok) {
      status.textContent = `עודכן ✅ ${res.added ? `נוספו ${res.added}` : ''} ${res.pending ? `• ממתינים לאישור: ${res.pending}` : ''}`;
      status.className = 'form-msg ok';
    } else {
      status.textContent = 'שגיאה בסנכרון: ' + (res.error || '');
      status.className = 'form-msg err';
    }
  } catch (e) {
    status.textContent = 'שגיאה בסנכרון';
    status.className = 'form-msg err';
  }
  try {
    loading.setStep('מרעננים את הרשימות…');
    await loadGiftStates();
    await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
    renderHome();
  } finally {
    await loading.hide(); // the caller must ALWAYS reach hide()
  }
  maybeSchedulePush();
}

/* ---------------- Onboarding tour (v1.0.8; two decks since v1.0.18) ----------------
   Slide content and all bounds arithmetic live in tour.js (pure + unit-tested).
   This half is only the DOM. `tourDeck` is whichever deck is on screen, so the
   first-run tour and the "how do I add videos" guide share one view and one
   renderer. `tour.done` is written only by the FIRST-RUN deck — replaying the
   guide must never look like the onboarding was completed. */
let tourDeck = TOUR_SLIDES;
let tourIdx = 0;
let tourOnDone = null;
let tourIsOnboarding = true;

function renderTourSlide() {
  const s = tourDeck[tourIdx];
  if (!s) return;
  const st = slideState(tourIdx, tourDeck.length);
  const ch = deckChrome(tourDeck, tourIdx);
  $('tour-img').src = s.img;
  $('tour-img').alt = s.title;
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-next').textContent = st.nextLabel;
  $('tour-prev').disabled = st.prevDisabled;
  // The first-run deck hands off to the guide instead of just ending: a parent who
  // never learns how to add a link cannot use the app at all.
  const more = $('tour-more');
  if (more) more.classList.toggle('hidden', !(st.isLast && tourIsOnboarding));
  // Chapter chip + "שלב N מתוך M" replace the dots once a deck is too long to count
  // (18 dots read as noise); the short onboarding deck keeps its dots untouched.
  const chip = $('tour-chapter');
  chip.textContent = ch.chapter;
  chip.classList.toggle('hidden', !ch.chapter);
  const step = $('tour-step');
  step.textContent = ch.stepLabel;
  step.classList.toggle('hidden', ch.useDots);
  const dots = $('tour-dots');
  dots.classList.toggle('hidden', !ch.useDots);
  dots.innerHTML = '';
  if (!ch.useDots) return;
  for (const on of st.dots) {
    const d = document.createElement('span');
    if (on) d.classList.add('on');
    dots.appendChild(d);
  }
}

/**
 * Boot shows the onboarding deck once ever (tour.done); the About tab replays it,
 * and the parent screen opens the add-videos guide directly.
 * @param deck        which slide deck to show
 * @param onboarding  does finishing this deck mark the onboarding as done?
 */
function startTour({ replay = false, onDone = null, deck = TOUR_SLIDES, onboarding = true } = {}) {
  tourDeck = Array.isArray(deck) && deck.length ? deck : TOUR_SLIDES;
  tourIsOnboarding = onboarding;
  tourIdx = 0;
  tourOnDone = onDone;
  renderTourSlide();
  if (replay) nav.go('tour'); else nav.reset('tour');
}

/** The add-videos chapter — from the last tour slide, the parent screen, About. */
function startAddGuide({ replay = true } = {}) {
  startTour({ replay, deck: ADD_GUIDE_SLIDES, onboarding: false });
}

function tourStep(delta) {
  const n = nextIndex(tourIdx, tourDeck.length, delta);
  if (n === tourIdx) return;
  tourIdx = n;
  renderTourSlide();
}

async function finishTour() {
  // Only the onboarding deck may retire the first-run tour.
  if (tourIsOnboarding) await prefSet('tour.done', '1');
  const done = tourOnDone;
  tourOnDone = null;
  if (done) { done(); return; }     // boot flow continues (connect / profiles)
  if (!nav.back()) goGallery();      // replay from the About tab — go back there
}

/* ---------------- Sheet setup wizard (v1.0.8, after profile creation) ---------------- */
let wizardProfile = null; // the freshly-created profile awaiting activation

/**
 * v1.0.12 — the wizard ALWAYS asks (it used to silently adopt the family file):
 * join an existing profile's file / create a new one / paste a link / skip.
 * Restored profiles still bypass it — they arrive with their sheet already wired
 * through the Drive doc's profileSources.
 */
async function openSheetSetup(p) {
  wizardProfile = p;
  $('sheetsetup-name').textContent = p.name;
  $('sheetsetup-msg').textContent = '';
  $('sheetsetup-msg').className = 'form-msg';

  // one "join <name>'s file" button per OTHER profile that already has one,
  // deduped by URL so two siblings on the same file show a single choice
  const join = $('sheetsetup-join');
  join.innerHTML = '';
  const seen = new Set();
  try {
    for (const other of await getProfiles()) {
      if (other.id === p.id) continue;
      const src = await db.getSources(other.id);
      if (!src || !src.sheetUrl || seen.has(src.sheetUrl)) continue;
      seen.add(src.sheetUrl);
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.type = 'button';
      b.textContent = `👨‍👩‍👧 להצטרף לקובץ של ${other.name}`;
      b.addEventListener('click', () => joinExistingSheet(src.sheetUrl, other.name));
      join.appendChild(b);
    }
  } catch {}
  join.classList.toggle('hidden', join.children.length === 0);
  nav.reset('sheet-setup');
}

/** Join a sibling's sheet — same library scope, so the whole family shares one list. */
async function joinExistingSheet(url, ownerName) {
  startPin((await hasPin()) ? 'verify' : 'setup', {
    title: 'קוד הורים לחיבור הקובץ',
    onSuccess: async () => {
      if (!nav.back()) nav.reset('sheet-setup');
      try {
        await connectWizardSheet(url);
        await alertKid({
          emoji: '👨‍👩‍👧', title: 'הצטרפנו לקובץ המשפחתי ✅',
          text: `${wizardProfile ? wizardProfile.name : 'הפרופיל'} יראה את אותה רשימה של ${ownerName}.`,
          ok: 'מעולה'
        });
        await finishSheetSetup();
      } catch {
        $('sheetsetup-msg').textContent = 'החיבור נכשל — אפשר לנסות שוב או לדלג';
        $('sheetsetup-msg').className = 'form-msg err';
      }
    }
  });
}

async function finishSheetSetup() {
  const p = wizardProfile;
  wizardProfile = null;
  if (p) await activateProfile(p.id); // activation syncs + shows the loading screen
}

/** The same connection routine as the sources tab — for the wizard's new profile. */
async function connectWizardSheet(url, { folderId = null } = {}) {
  const { libraryIdFor } = await import('./util.js');
  let src = (await db.getSources(wizardProfile.id)) || { profileId: wizardProfile.id, schema: 1 };
  const oldLib = src.libraryId || null;
  src = {
    shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
    maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: false },
    ...src, sheetUrl: url, libraryId: libraryIdFor(url), sheetHash: null,
    sheetFolderId: folderId, updatedAt: Date.now()
  };
  await db.putSources(src);
  // same scope-change hazard as the sources tab (a wizard-created profile is usually
  // empty, but "skip now, connect later" and re-runs are not)
  await adoptLibraryScope(wizardProfile.id, oldLib, src.libraryId);
}

async function wizardCreateSheet() {
  const msg = $('sheetsetup-msg');
  msg.textContent = 'מתחברים לחשבון Google ויוצרים את הקובץ…';
  msg.className = 'form-msg';
  let r;
  loading.show({ title: 'יוצרים את הקובץ בגוגל', step: 'מתחברים לחשבון…' });
  try {
    const { createSourceSheet, sheetNameFor } = await import('./sheetwrite.js');
    r = await createSourceSheet(sheetNameFor(wizardProfile.name));
  } catch {
    msg.textContent = 'משהו השתבש — אפשר לנסות שוב או לדלג';
    msg.className = 'form-msg err';
    return;
  } finally {
    // hide BEFORE the dialogs below — a modal must never stack on the loading view
    await loading.hide();
  }
  try {
    if (!r.ok) {
      const { lastAuthError } = await import('./gauth.js');
      msg.textContent = r.error === 'no-token'
        ? gauthErrorText(lastAuthError())
        : 'יצירת הרשימה נכשלה — אפשר לנסות שוב או לדלג';
      msg.className = 'form-msg err';
      return;
    }
    await connectWizardSheet(r.url, { folderId: r.folderId || null });
    const copy = await confirmKid({
      emoji: '📄', title: 'הקובץ נוצר וחובר! ✅',
      text: 'מוסיפים סרטונים בהדבקת לינקים בקובץ (שורה = סרטון או ערוץ). אפשר להעתיק את הלינק לקובץ עכשיו.',
      ok: 'העתקת הלינק', cancel: 'סיום'
    });
    if (copy) {
      try {
        await navigator.clipboard.writeText(r.url);
        await alertKid({ emoji: '📋', title: 'הלינק הועתק!', text: 'הדביקו בדפדפן או שמרו בפתק — משם עורכים את הרשימה.', ok: 'סבבה' });
      } catch {
        await alertKid({ emoji: '🔗', title: 'הלינק לקובץ', text: r.url, ok: 'סגירה' });
      }
    }
    await finishSheetSetup();
  } catch {
    msg.textContent = 'משהו השתבש — אפשר לנסות שוב או לדלג';
    msg.className = 'form-msg err';
  }
}

/* ---------------- First-launch Google connect (v1.0.4) ---------------- */
/** Maps a gauth failure to the parent-facing message (shared: connect + settings). */
function gauthErrorText(err) {
  err = err || '';
  return /auth-unavailable:10\b/.test(err)
    ? 'האפליקציה לא רשומה ב-Google Cloud — השלימו את צעדים 3-4 במדריך GOOGLE_CLOUD_SETUP.md (ודאו שה-SHA-1 של גרסת ה-release רשום)'
    : /auth-unavailable/.test(err)
      ? `שירותי Google לא זמינים במכשיר (${err})`
      : err === 'no-plugin'
        ? 'זמין באפליקציה המותקנת בלבד (לא בדפדפן)'
        : 'ההתחברות בוטלה';
}

/** The normal boot landing: profiles picker, or profile creation when none exist. */
function startAtProfiles() {
  if (profiles.length === 0) { openCreateProfile(); return; }
  // v1.0.29: resume the LAST-USED profile (device-local — prefGet, never the synced
  // channel: one account, several devices, a different child on each). The decision is
  // pure planBootProfile; a queued cold-start share still gets the picker, because the
  // picker IS that share's routing question (v1.0.23). Falls back to the picker on any
  // doubt — auto-entering a deleted profile would be worse than one extra tap.
  (async () => {
    const { prefGet } = await import('./platform.js');
    const { hasQueuedShares } = await import('./share.js');
    const id = planBootProfile({
      storedId: await prefGet('activeProfile'),
      profileIds: profiles.map((pr) => pr.id),
      hasQueuedShare: await hasQueuedShares()
    });
    if (id) { await activateProfile(id); return; }
    renderProfiles(); nav.reset('profiles');
  })().catch(() => { renderProfiles(); nav.reset('profiles'); });
}

/**
 * Offer the Google connect ONCE, before profile selection: not in the browser
 * preview (no Google services), not after it was answered, not when backup is
 * already on. Skipping is always available — the parent screen keeps the flow.
 */
async function shouldOfferConnect() {
  try {
    const { gauthAvailable } = await import('./gauth.js');
    if (!gauthAvailable()) return false;
    if (await prefGet('gauth.introDone')) return false;
    return !((await db.getMeta('drive')) || {}).enabled;
  } catch { return false; }
}

async function connectGoogleFirstLaunch() {
  const msg = $('connect-msg');
  const btn = $('connect-google');
  btn.disabled = true;
  msg.textContent = 'מתחברים…'; msg.className = 'form-msg';
  let pulled = null;
  try {
    const { signIn, lastAuthError } = await import('./gauth.js');
    const { pullDrive, pushDrive } = await import('./drive.js');
    if (!(await signIn())) {
      msg.textContent = gauthErrorText(lastAuthError());
      msg.className = 'form-msg err';
      return;
    }
    // v1.0.18: reading and merging the Drive backup is the LONGEST blocking wait in
    // the app, and it used to report itself only through this 22px line at the very
    // bottom of the screen — parents read that as a freeze. Give it the full-screen
    // animation, and hide it again before any modal so the two never stack.
    msg.textContent = 'בודקים אם יש גיבוי קיים…';
    loading.show({ title: 'בודקים את הגיבוי בגוגל', step: 'מחפשים גיבוי קיים…' });
    pulled = await pullDrive(activeProfileId);
    loading.setStep('שומרים את הפרופילים…');
    profiles = await getProfiles(); // pullDrive may have restored profiles
    await pushDrive(profiles);      // enables the backup even without a prior file
    await prefSet('gauth.introDone', 'connected');
  } catch {
    msg.textContent = 'שגיאה בהתחברות — אפשר לדלג ולנסות שוב מאוחר יותר דרך מסך ההורים';
    msg.className = 'form-msg err';
    return;
  } finally {
    await loading.hide();
    btn.disabled = false;
  }
  if (pulled && pulled.ok && !pulled.empty) {
    await alertKid({
      emoji: '☁️', title: 'הגיבוי חובר ✅',
      text: pulled.profilesRestored
        ? `נמצא גיבוי קיים: שוחזרו ${pulled.profilesRestored} פרופילים והספרייה סונכרנה.`
        : 'נמצא גיבוי קיים והספרייה סונכרנה למכשיר.',
      ok: 'מעולה'
    });
  }
  startAtProfiles();
}

/* ---------------- Profiles ---------------- */
/**
 * The profile picker. `onPick` (v1.0.23) makes it a SELECTION screen instead of the
 * activation screen — used to route an Android share. Selection and activation used to be
 * inseparable (every tile hard-wired `activateProfile`), so there was no way to ask "which
 * child?" about anything.
 */
function renderProfiles({ onPick = null, title = null } = {}) {
  $('profiles-title').textContent = title || 'מי צופה? 🍿';
  const grid = $('profiles-grid');
  grid.innerHTML = '';
  for (const p of profiles) {
    const btn = document.createElement('button');
    btn.className = 'profile-tile';
    btn.type = 'button';
    const av = document.createElement('span');
    av.className = 'avatar avatar-lg';
    av.textContent = p.avatar;
    av.style.background = p.color;
    const nm = document.createElement('span');
    nm.className = 'profile-name';
    nm.textContent = p.name;
    btn.appendChild(av);
    btn.appendChild(nm);
    btn.addEventListener('click', () => (onPick ? onPick(p.id) : activateProfile(p.id)));
    grid.appendChild(btn);
  }
  // No "new profile" tile while choosing a share target: creating a profile runs the sheet
  // wizard and its own activation, which would abandon the share mid-flight.
  if (onPick) return;
  const add = document.createElement('button');
  add.className = 'profile-tile profile-add';
  add.type = 'button';
  const addAv = document.createElement('span');
  addAv.className = 'avatar avatar-lg avatar-add';
  addAv.textContent = '➕';
  const addNm = document.createElement('span');
  addNm.className = 'profile-name';
  addNm.textContent = 'פרופיל חדש';
  add.appendChild(addAv);
  add.appendChild(addNm);
  add.addEventListener('click', openCreateProfile);
  grid.appendChild(add);
}

/**
 * WHICH profile does this shared link go to?
 *
 * v1.0.26: asked whenever there is MORE THAN ONE profile. v1.0.23 also skipped the question
 * when several profiles followed the same sheet — the video lands in the same library row
 * either way — but a parent reported not knowing where a shared video had gone, and "it
 * does not matter" is only true of the DATA, not of what they can see. A single profile
 * still skips: there is nothing to ask, and a one-tile picker teaches tapping without
 * reading.
 *
 * The parent's decision (2026-08-01) is that choosing also SWITCHES the app into that
 * profile — so the picker resolves through `activateProfile`, and the share's own PIN +
 * confirm flow then runs inside the chosen profile.
 * -> profileId | null (backed out)
 */
async function chooseShareProfile() {
  // v1.0.26 — ASK WHENEVER THERE IS A CHOICE. v1.0.23 also skipped the question when two
  // profiles happened to share one sheet (same library scope, same row either way), but a
  // parent reported not knowing where a shared video had gone — and the answer "it does not
  // matter" is only true of the DATA, not of what the parent can see. One profile still
  // skips: there is nothing to ask, and a one-tile picker teaches tapping without reading.
  if (profiles.length < 2) return activeProfileId || (profiles[0] && profiles[0].id) || null;

  return new Promise((resolve) => {
    let settled = false;
    const done = (id) => { if (settled) return; settled = true; shareProfileCancel = null; resolve(id); };
    shareProfileCancel = () => done(null); // back / any navigation away = no decision
    renderProfiles({
      title: 'לאיזה פרופיל להוסיף?',
      onPick: async (id) => {
        if (settled) return;
        settled = true;
        shareProfileCancel = null;
        await activateProfile(id); // resets nav to that profile's gallery
        resolve(id);
      }
    });
    nav.go('profiles');
  });
}
let shareProfileCancel = null;

function renderAvatarGrid() {
  const grid = $('avatar-grid');
  grid.innerHTML = '';
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.className = 'avatar-opt';
    b.type = 'button';
    b.textContent = a.e;
    b.style.background = a.c;
    b.addEventListener('click', () => {
      createSel = a;
      $('create-preview-av').textContent = a.e;
      $('create-preview-av').style.background = a.c;
      for (const x of grid.children) x.classList.remove('sel');
      b.classList.add('sel');
    });
    grid.appendChild(b);
  }
}

function openCreateProfile() {
  createSel = null;
  $('create-name').value = '';
  $('create-preview-av').textContent = '🙂';
  $('create-preview-av').style.background = '#eceaff';
  $('create-msg').textContent = '';
  $('create-back').classList.toggle('hidden', profiles.length === 0);
  renderAvatarGrid();
  if (profiles.length === 0) nav.reset('create-profile');
  else nav.go('create-profile');
}

async function createNewProfile() {
  const name = $('create-name').value.trim();
  const msg = $('create-msg');
  if (!name) { msg.textContent = 'בחרו שם'; msg.className = 'form-msg err'; return; }
  if (!createSel) { msg.textContent = 'בחרו תמונה'; msg.className = 'form-msg err'; return; }

  // v1.0.22 — the name must be unique across the whole GOOGLE ACCOUNT, not just this
  // device. `createProfile` mints its id locally and both merge paths union by ID, so two
  // devices could each create "נועם" and BOTH would survive the sync — splitting that
  // child's gift progress, personal videos and (with no sheet) their whole library, while
  // the parent sees two identical avatars. So: pull first, then decide.
  //
  // The pull is best-effort on purpose. Hard-blocking creation when Drive is unreachable
  // would make the app unusable on a plane; we fall back to the local list and accept that
  // the rare simultaneous-offline case is resolved later, in the parent screen.
  const localBefore = await getProfiles();
  let merged = localBefore;
  try {
    if (((await db.getMeta('drive')) || {}).enabled) {
      const { pullDrive } = await import('./drive.js');
      loading.show({ title: 'בודקים שהשם פנוי…', step: 'קוראים את הגיבוי בגוגל דרייב' });
      try { await pullDrive(activeProfileId); } finally { loading.hide(); }
      merged = await getProfiles(); // pullDrive already folded the remote profiles in
    }
  } catch { /* offline / not connected — the local check below still applies */ }

  const clash = profileNameConflict(localBefore, merged, name);
  if (clash) {
    msg.textContent = clash === 'remote'
      ? 'שם הפרופיל קיים כבר בחשבון הגוגל, במכשיר אחר — בחרו שם אחר.'
      : 'כבר יש פרופיל בשם הזה — בחרו שם אחר';
    msg.className = 'form-msg err';
    renderProfiles(); // the pull may have added profiles — show them
    return;
  }
  const p = await createProfile(name, createSel.e, createSel.c);
  profiles = await getProfiles();
  await openSheetSetup(p); // v1.0.8: offer a source sheet before entering the app
}

async function activateProfile(id) {
  await setActiveId(id);
  activeProfileId = id;
  source = await getSource();
  items = await loadItems(); // legacy list — parent screen only
  page = 0;

  // HYDRATE first: render whatever IndexedDB has, instantly. Sync runs after.
  await absorbMineIntoShared(id); // v1.0.6: fold personal adds into the shared list
  await loadGiftStates();
  await renderHome();
  await updateProfileChip();
  // v1.0.25: the exit lock belongs to the CHILD now, so switching children changes the
  // answer — re-arm (or release) it and repaint the exit button for whoever this is.
  await applyExitLock();
  // v1.0.31: a persisted scheduled lock survives a restart AND a profile switch — check it
  // now (it overrides the gallery), and keep the ticker running for this session.
  startLockTicker();
  await tickScheduledLock();

  const hasContent = folders.length > 0;
  if (!hasContent) {
    // Nothing cached (fresh profile with a sheet): the child needs the loading screen.
    // A child who DOES have cached content keeps browsing while the sync runs behind
    // them — covering a populated grid every 3 minutes would be the worse bug.
    loading.show({ title: 'מכינים את הסרטונים', step: 'מביאים סרטונים חדשים…', pct: 0 });
  }
  // Fires the gallery's onEnter SYNCHRONOUSLY, which is what starts the refresh below.
  // Cleared first so a bail-out inside homeEntryRefresh cannot leave us awaiting the
  // PREVIOUS profile's refresh.
  entryRefreshInFlight = null;
  nav.reset('gallery');

  // v1.0.7: shares queued before a profile was active drain AFTER the gallery is up —
  // their interactive PIN flow must not fight the activation navigation.
  drainShareQueue().catch(() => {});

  // Background: pull the family's shared state, then sync the sheet — one pipeline,
  // started by the line above. Never blocks the grid; re-renders when either one lands
  // something new (v1.0.22).
  awaitEntryRefresh().catch(async () => { await loading.hide(); });
}

async function updateProfileChip() {
  const p = await getActiveProfile();
  const chip = $('profile-chip');
  if (!p) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  $('chip-av').textContent = p.avatar;
  $('chip-av').style.background = p.color;
  $('chip-name').textContent = p.name;
}

async function backToProfiles() {
  stop();
  currentWatch = null;
  profiles = await getProfiles();
  renderProfiles();
  nav.reset('profiles');
}

async function deleteCurrentProfile() {
  const p = await getActiveProfile();
  if (!p) return;
  const yes = await confirmKid({
    emoji: '🗑️', title: `למחוק את הפרופיל "${p.name}"?`,
    text: 'כל הסרטונים של הפרופיל יימחקו. פעולה זו אינה הפיכה.',
    ok: 'מחיקה', cancel: 'ביטול', danger: true
  });
  if (!yes) return;
  // v1.0.25: actually erase it. The confirm has always said the deletion is permanent,
  // but only the row in the profile list was removed — db.purgeProfile had zero callers.
  // The library scope goes too, unless a sibling profile still reads the same sheet.
  try {
    const src = await db.getSources(p.id);
    const others = [];
    for (const other of profiles) {
      if (!other || other.id === p.id) continue;
      const os = await db.getSources(other.id).catch(() => null);
      others.push({ profileId: other.id, libraryId: os && os.libraryId });
    }
    const { scopes } = planProfilePurge(p.id, src && src.libraryId, others);
    await db.purgeProfile(p.id, scopes);
  } catch { /* the profile still goes; leftover rows are invisible without it */ }
  await deleteProfile(p.id);   // also writes the tombstone that stops a Drive pull reviving it
  maybeSchedulePush();
  items = [];
  source = { mode: 'manual', url: '' };
  profiles = await getProfiles();
  if (profiles.length > 0) { renderProfiles(); nav.reset('profiles'); }
  else openCreateProfile();
}

/* ---------------- Wiring ---------------- */
function wire() {
  // v1.0.8: onboarding tour
  $('tour-next').addEventListener('click', () => {
    if (slideState(tourIdx, tourDeck.length).isLast) finishTour();
    else tourStep(1);
  });
  $('tour-prev').addEventListener('click', () => tourStep(-1));
  $('tour-skip').addEventListener('click', finishTour);
  // v1.0.18: last slide of the onboarding deck → straight into the add-videos
  // guide, without losing the "onboarding finished" mark on the way.
  $('tour-more').addEventListener('click', async () => {
    await prefSet('tour.done', '1');
    const done = tourOnDone;
    tourOnDone = null;
    tourDeck = ADD_GUIDE_SLIDES;
    tourIsOnboarding = false;
    tourIdx = 0;
    tourOnDone = done; // the boot flow still continues once the guide ends
    renderTourSlide();
  });

  // v1.0.8: sheet setup wizard (PIN required for create/paste — user-specified)
  $('sheetsetup-skip').addEventListener('click', finishSheetSetup);
  $('sheetsetup-create').addEventListener('click', async () => {
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים ליצירת הקובץ',
      onSuccess: () => { if (!nav.back()) nav.reset('sheet-setup'); wizardCreateSheet(); }
    });
  });

  $('connect-google').addEventListener('click', connectGoogleFirstLaunch);
  $('connect-skip').addEventListener('click', async () => {
    await prefSet('gauth.introDone', 'skipped');
    startAtProfiles();
  });

  // Fails CLOSED: if anything in the gate throws, the child stays put. Falling back to
  // backToProfiles() would make a locked profile escapable by whatever made it throw.
  $('profile-chip').addEventListener('click', () => { onProfileChip().catch(() => {}); });
  $('create-back').addEventListener('click', backToProfiles);
  $('create-save').addEventListener('click', createNewProfile);
  $('delete-profile').addEventListener('click', deleteCurrentProfile);
  $('parent-gate-btn').addEventListener('click', openParentGate);

  $('pg-prev').addEventListener('click', () => { page -= 1; renderHome(); });
  $('pg-next').addEventListener('click', () => { page += 1; renderHome(); });
  $('exit-btn').addEventListener('click', askExit);
  $('folder-back').addEventListener('click', () => { if (!nav.back()) goGallery(); });

  // v1.0.7: home search
  $('search-open').addEventListener('click', openSearch);
  $('search-back').addEventListener('click', () => { if (!nav.back()) goGallery(); });
  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { renderSearchResults().catch(() => {}); }, 180);
  });

  // ✋ — the child's way out of a chain. Same destination a video END has with continuous
  // play OFF: the folder they came from, not the home screen.
  $('autoplay-stop').addEventListener('click', () => { resetAutoplayChain(); leaveWatch(); });
  // v1.0.31: scheduled lock — the exit button (only shown when the kiosk lock is off) and
  // the discreet parent-unlock tap.
  $('locked-exit').addEventListener('click', () => exitApp());
  $('locked-parent').addEventListener('click', () => { onLockedParentTap().catch(() => {}); });
  /* preview bubble (v1.0.26) */
  $('pv-close').addEventListener('click', closePreview);
  $('pv-open').addEventListener('click', async () => {
    const rec = previewCtx && previewCtx.items[previewCtx.idx];
    if (!rec) return;
    const { openExternal } = await import('./platform.js');
    openExternal(rec.srcUrl || ('https://www.youtube.com/watch?v=' + rec.id)).catch(() => {});
  });
  $('pv-approve').addEventListener('click', () => previewDecide(async (rec) => {
    await db.approvePending(rec.scopeId, [rec.key]);
    await enqueueApprovedForSheet([rec]);
    await refreshPendingList();
    renderHome();
    refreshAfterAdd({ parent: true }); // approval is what makes it live — enrich + gift it
    maybeSchedulePush();
  }));
  $('pv-reject').addEventListener('click', () => previewDecide(async (rec) => {
    // Parked in '~rejected', exactly like the row's 🗑️ — recoverable, no sheet removal row.
    await db.rejectPending(rec.scopeId, [rec.key]);
    await refreshPendingList();
  }));
  $('pv-delete').addEventListener('click', () => previewDecide(async (rec) => {
    const yes = await confirmKid({
      emoji: '🗑️', title: 'למחוק את הסרטון?', text: rec.title || '',
      ok: 'מחיקה', cancel: 'ביטול', danger: true
    });
    if (!yes) return false; // backed out — stay on this video
    await db.deleteVideo(rec.scopeId, rec.key);
    if ((rec.homeFolderId || rec.folderId) === 'sheet') enqueueSheetDeleteVideo(rec.key);
    else if (rec.channelId) enqueueSheetRemoval(rec.key, rec.srcUrl || rec.url || '', rec.title || '');
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
  }));
  $('watch-home').addEventListener('click', goGallery);
  $('watch-delete').addEventListener('click', onDeleteWatch);
  $('ctl-fs').addEventListener('click', () => {
    const el = $('player-wrap');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
      else if (el.requestFullscreen) { const p = el.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch { /* some embedded webviews deny fullscreen — never throw at the child */ }
  });

  document.querySelector('.keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key'); if (!b || !b.dataset.k) return;
    onKey(b.dataset.k);
  });
  // v1.0.7: cancel returns to WHERE THE PIN OPENED FROM (profiles/gallery/folder) —
  // the pin view can now open over the profiles screen too (update flow).
  $('pin-cancel').addEventListener('click', () => { if (!nav.back()) goGallery(); });
  $('pin-forgot').addEventListener('click', () => { onPinForgot().catch(() => {}); });
  $('recovery-banner-cancel').addEventListener('click', async () => {
    // Free to cancel, by design (recovery.js): whoever did NOT ask for the reset cannot
    // prove who they are, and that is precisely the situation this feature exists for.
    // A child cancelling only restores the status quo.
    try {
      const { cancelRecovery } = await import('./recovery.js');
      await cancelRecovery();
    } catch {}
    await refreshRecoveryBanner();
  });

  for (const t of PARENT_TABS) $('tab-' + t).addEventListener('click', () => setParentTab(t));
  $('add-btn').addEventListener('click', parentAdd);

  $('pending-all').addEventListener('click', () => setPendingSelection(true));
  $('pending-none').addEventListener('click', () => setPendingSelection(false));

  /**
   * v1.0.24 — what the two bulk buttons act on: the ticked rows, or the WHOLE queue when
   * nothing is ticked (their original v1.0.4 meaning, which also reaches the rows past the
   * display cap). `plan.pendingBulkAction` writes that scope into the button labels, so the
   * two can never disagree about what a press is about to do.
   */
  const bulkTargets = async () => {
    const sel = new Set(pendingSel);
    const { all } = await collectPending(); // read only — the ticks must survive a cancel
    // A ticked row that vanished meanwhile (another device approved it, a sync moved it)
    // simply drops out — never fall back to the whole queue.
    return sel.size ? all.filter((r) => sel.has(selIdOf(r))) : all;
  };

  $('approve-all').addEventListener('click', async () => {
    const pend = await bulkTargets();
    if (!pend.length) return;
    const byScope = new Map();
    for (const r of pend) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [s, keys] of byScope) await db.approvePending(s, keys);
    await enqueueApprovedForSheet(pend);
    $('approve-msg').textContent = `אושרו ${pend.length} סרטונים ✅`;
    $('approve-msg').className = 'form-msg ok';
    await loadGiftStates();
    await Promise.all([refreshPendingList(), refreshParentList()]);
    renderHome();
    refreshAfterAdd({ parent: true }); // newly-live records need enrichment + gift ranks
  });
  $('reject-all').addEventListener('click', async () => {
    const pend = await bulkTargets();
    if (!pend.length) return;
    const yes = await confirmKid({
      emoji: '🗑️', title: `לדחות ${pend.length} סרטונים?`,
      // v1.0.23: no longer a one-way door — say so, or the parent won't dare press it
      text: 'הם יעברו לרשימת הדחויים ולא יופיעו אצל הילד. אפשר להחזיר אותם משם בכל עת.',
      ok: `דחייה (${pend.length})`, cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    const byScope = new Map();
    for (const r of pend) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [scope, keys] of byScope) await db.rejectPending(scope, keys); // one tx per scope
    await refreshPendingList();
  });

  // v1.0.23 — the ONLY destructive step in the rejected flow: empty the list for real.
  $('purge-rejected').addEventListener('click', async () => {
    const rej = await collectRejected();
    if (!rej.length) return;
    const yes = await confirmKid({
      emoji: '🗑️', title: `למחוק ${rej.length} סרטונים לצמיתות?`,
      text: 'רשימת הדחויים תתרוקן. זו מחיקה סופית — הסרטונים לא יחזרו, גם לא בסנכרון '
        + 'ובשאר המכשירים. כדי לשמור על אחד מהם, החזירו אותו לתור האישורים לפני המחיקה.',
      ok: 'מחיקה לצמיתות', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    const byScope = new Map();
    for (const r of rej) {
      if (!byScope.has(r.scopeId)) byScope.set(r.scopeId, []);
      byScope.get(r.scopeId).push(r.key);
    }
    for (const [scope, keys] of byScope) await db.purgeRejected(scope, keys);
    await refreshPendingList();
    maybeSchedulePush(); // the tombstones must reach the other devices
  });

  $('pick-ok').addEventListener('click', () => { const h = pickHandlers; if (h) { pickHandlers = null; h.ok(); } if (nav.isActive('pick')) nav.back(); });
  $('pick-cancel').addEventListener('click', () => { if (nav.isActive('pick')) nav.back(); }); // onLeave cancels
  $('pick-all').addEventListener('click', () => pickHandlers && pickHandlers.all());
  $('pick-none').addEventListener('click', () => pickHandlers && pickHandlers.none());

  $('export-btn').addEventListener('click', async () => {
    const msg = $('add-msg');
    try {
      const { exportProfileSnapshot } = await import('./snapshot.js');
      const p = await getActiveProfile();
      const json = await exportProfileSnapshot(activeProfileId, p);
      await navigator.clipboard.writeText(json);
      msg.textContent = 'גיבוי מלא הועתק ללוח (שמרו אותו בקובץ)'; msg.className = 'form-msg ok';
    } catch { msg.textContent = 'הייצוא נכשל'; msg.className = 'form-msg err'; }
  });
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const msg = $('add-msg');
    try {
      const { importProfileSnapshot } = await import('./snapshot.js');
      const res = await importProfileSnapshot(activeProfileId, await f.text());
      if (res.ok) {
        msg.textContent = `יובאו ${res.imported} סרטונים ✅${res.rejected ? ` (${res.rejected} נדחו — לינק לא נתמך)` : ''}`;
        msg.className = 'form-msg ok';
        await loadGiftStates();
        await refreshParentList();
        renderHome();
      } else { msg.textContent = 'קובץ לא תקין'; msg.className = 'form-msg err'; }
    } catch { msg.textContent = 'קובץ לא תקין'; msg.className = 'form-msg err'; }
    e.target.value = '';
  });

  $('remote-copy').addEventListener('click', async () => {
    const src = await db.getSources(activeProfileId);
    const url = src && src.sheetUrl;
    if (!url) {
      // v1.0.32: the create button is gone, so the old "אפשר ליצור אחת עכשיו" pointed
      // at nothing — say what is actually true instead.
      $('remote-status').textContent = 'לפרופיל הזה אין רשימת מקורות — התוכן נשמר באפליקציה ובגיבוי.';
      $('remote-status').className = 'form-msg err';
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      $('remote-status').textContent = 'הלינק הועתק ✅ אפשר להדביק בדפדפן ולערוך את הרשימה.';
      $('remote-status').className = 'form-msg ok';
    } catch {
      await alertKid({ emoji: '🔗', title: 'הלינק לרשימה', text: url, ok: 'סגירה' });
    }
  });

  // v1.0.32: the remote-create / remote-join / remote-clear controls are gone (user
  // request) — list management is no longer parent-facing. connectSheetUrl and
  // createSourceSheet keep their remaining caller: the profile-creation wizard.
  $('remote-refresh').addEventListener('click', doSyncAndRefresh);

  // v1.0.10: safety-valve resolution — the parent decides what a mass row
  // disappearance meant. Apply = mirror the sheet (delete locally); ignore =
  // keep everything and adopt the current sheet as the new baseline.
  $('mirror-apply').addEventListener('click', async () => {
    const alert = await db.getMeta('sheetMirrorAlert:' + libScope);
    if (!alert) return;
    const { applySheetMirror } = await import('./sync2.js');
    await applySheetMirror(libScope, alert);
    await db.putMeta('sheetMirrorAlert:' + libScope, null);
    await loadGiftStates();
    await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
    await refreshSheetWriteStatus().catch(() => {});
    renderHome();
    maybeSchedulePush();
  });
  $('mirror-ignore').addEventListener('click', async () => {
    // remember WHICH divergence was waved off — the presence check runs every sync,
    // so only a DIFFERENT deletion set may alert again
    const alert = await db.getMeta('sheetMirrorAlert:' + libScope);
    if (alert && alert.sig) await db.putMeta('sheetMirrorIgnoredSig:' + libScope, alert.sig);
    await db.putMeta('sheetMirrorAlert:' + libScope, null);
    await refreshSheetWriteStatus().catch(() => {});
  });
  // v1.0.28: the API-key form is gone from the UI; a stored 'yt:apiKey' override is
  // still honored by yt.getApiKey, so past users lose nothing.

  // v1.0.11: exit lock — applying is immediate (Android may show its own one-time
  // pinning confirmation); turning it off unpins right away (we're behind the PIN).
  $('autoplay-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'autoplay', e.target.checked);
    maybeSchedulePush(); // per-profile and synced, like the exit lock
    const msg = $('settings-msg');
    msg.textContent = e.target.checked
      ? 'ניגון רציף הופעל ✅ — בסוף כל סרטון יתחיל הבא בתור'
      : 'ניגון רציף כובה — בסוף סרטון חוזרים לתיקייה';
    msg.className = 'form-msg ok';
  });
  // v1.0.32: resume playback — per-profile and synced; the position itself never leaves
  // the device (drive.serializeStateEntry never emits it).
  $('resume-toggle').addEventListener('change', async (e) => {
    await putSetting(activeProfileId, 'resume', e.target.checked);
    resumeEnabled = e.target.checked; // tileEl and the save loop read the cached flag
    maybeSchedulePush();
    const msg = $('settings-msg');
    msg.textContent = e.target.checked
      ? 'המשך צפייה הופעל ✅ — סרטון שנעצר ייפתח מאותה נקודה'
      : 'המשך צפייה כובה — כל סרטון מתחיל מההתחלה';
    msg.className = 'form-msg ok';
  });
  // v1.0.31: scheduled per-profile lock — two synced numbers. Clamp to sane bounds and
  // reflect the outcome. A change takes effect on the child's next armed cycle.
  const saveSchedLock = async () => {
    const after = Math.max(0, Math.min(600, parseInt($('lock-after-min').value, 10) || 0));
    const dur = Math.max(1, Math.min(600, parseInt($('lock-duration-min').value, 10) || SCHED_LOCK_DEFAULT_DURATION_MIN));
    $('lock-after-min').value = String(after);
    $('lock-duration-min').value = String(dur);
    await putSetting(activeProfileId, 'lockAfterMin', after);
    await putSetting(activeProfileId, 'lockDurationMin', dur);
    maybeSchedulePush();
    // v1.0.31: apply to the CURRENT session at once (the timer accumulates against a fixed
    // armedAt, so reducing the minutes shortens the ongoing countdown). Safe to run from the
    // parent screen: showLockedScreen refuses to reveal the lock while the parent is here.
    startLockTicker();
    await tickScheduledLock();
    const msg = $('settings-msg');
    msg.textContent = after > 0
      ? `נעילה מתוזמנת: אחרי ${after} דקות, למשך ${dur} דקות ✅`
      : 'נעילה מתוזמנת כבויה';
    msg.className = 'form-msg ok';
  };
  $('lock-after-min').addEventListener('change', () => saveSchedLock().catch(() => {}));
  $('lock-duration-min').addEventListener('change', () => saveSchedLock().catch(() => {}));
  $('exit-lock-toggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await putSetting(activeProfileId, 'exitLock', on);
    maybeSchedulePush(); // it travels now — the other device must hear about it
    const { lockTask, unlockTask, isNative } = await import('./platform.js');
    let note = on ? 'נעילת היציאה הופעלה ✅' : 'נעילת היציאה כובתה';
    if (on) {
      const locked = await lockTask();
      if (!locked && !isNative) note = 'נשמר ✅ (הנעילה עצמה פועלת רק באפליקציה המותקנת)';
      else if (!locked) note = 'נשמר, אך ההצמדה נכשלה — ננסה שוב בכניסה הבאה';
      else note = 'נעילת היציאה הופעלה ✅ — יציאה תדרוש קוד הורים';
    } else {
      await unlockTask();
    }
    await applyExitLockUi();
    $('settings-msg').textContent = note;
    $('settings-msg').className = 'form-msg ok';
  });

  $('share-approval-toggle').addEventListener('change', async (e) => {
    const src = (await db.getSources(activeProfileId));
    if (!src) return;
    await putSetting(activeProfileId, 'shareApproval', e.target.checked);
    maybeSchedulePush();
    $('settings-msg').textContent = 'נשמר ✅';
    $('settings-msg').className = 'form-msg ok';
  });

  $('drive-enable').addEventListener('click', async () => {
    const msg = $('drive-msg');
    msg.textContent = 'מתחברים…'; msg.className = 'form-msg';
    try {
      const { signIn, lastAuthError } = await import('./gauth.js');
      const { pullDrive, pushDrive } = await import('./drive.js');
      if (!(await signIn())) {
        msg.textContent = gauthErrorText(lastAuthError());
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = 'בודקים אם יש גיבוי קיים…';
      loading.show({ title: 'בודקים את הגיבוי בגוגל', step: 'מחפשים גיבוי קיים…' });
      const pulled = await pullDrive(activeProfileId);
      loading.setStep('מגבים את המצב הנוכחי…');
      await pushDrive(profiles);
      loading.setStep('מרעננים את הרשימות…');
      await loadGiftStates();
      await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
      renderHome();
      await refreshDriveStatus();
      msg.textContent = pulled.ok && !pulled.empty ? 'גיבוי קיים מוזג למכשיר ✅' : 'הגיבוי הופעל ✅';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'שגיאה בהפעלת הגיבוי';
      msg.className = 'form-msg err';
    } finally {
      await loading.hide();
    }
  });
  // v1.0.32: the manual "גיבוי עכשיו" button is gone (user request) — backup is
  // automatic: a push is scheduled on every mutation and a pull runs on entry/resume.

  // v1.0.5: share a download link for the latest release (OS share sheet; the
  // browser preview falls back to Web Share / clipboard).
  $('share-app').addEventListener('click', async () => {
    const msg = $('share-msg');
    msg.textContent = 'מכינים את הלינק…'; msg.className = 'form-msg';
    try {
      const upd = await import('./update.js');
      const text = upd.buildAppShareMessage(await upd.latestKnownRelease());
      const { shareText } = await import('./platform.js');
      const how = await shareText(text, 'הסרטונים שלי — אפליקציה לילדים');
      msg.textContent =
        how === 'native' || how === 'web' ? 'חלון השיתוף נפתח 📤'
        : how === 'clipboard' ? 'ההודעה עם הלינק הועתקה ללוח — הדביקו איפה שנוח'
        : 'השיתוף לא זמין במכשיר הזה';
      msg.className = how === 'none' ? 'form-msg err' : 'form-msg ok';
    } catch {
      msg.textContent = 'השיתוף נכשל — נסו שוב';
      msg.className = 'form-msg err';
    }
  });

  $('update-check').addEventListener('click', () => runUpdateCheck({ manual: true }));
  $('update-install').addEventListener('click', async () => {
    const msg = $('update-msg');
    const upd = await import('./update.js');
    const latest = JSON.parse((await import('./platform.js').then((p) => p.prefGet('update.latest'))) || 'null');
    if (!latest) return;
    // v1.0.13: what's-new first; the parent may still back out here
    if (!(await showWhatsNew(latest.whatsNew, { installMode: true }))) { if (!nav.back()) goGallery(); return; }
    if (nav.isActive('whatsnew') && !nav.back()) goGallery();
    if (!(await upd.canInstall())) {
      msg.textContent = 'נדרש אישור חד-פעמי: "התקנת אפליקציות לא ידועות" — נפתח את ההגדרה';
      msg.className = 'form-msg';
      await upd.openInstallSettings(); // advisory only — we still attempt the install after
    }
    msg.textContent = 'מוריד…'; msg.className = 'form-msg';
    const r = await upd.downloadAndInstall(latest, {
      onProgress: (done, total) => {
        if (total) msg.textContent = `מוריד… ${Math.round((done / total) * 100)}%`;
      }
    });
    if (r.ok) { msg.textContent = 'נפתח מסך ההתקנה של אנדרואיד…'; msg.className = 'form-msg ok'; }
    else {
      msg.textContent = r.error === 'truncated' ? 'ההורדה לא הושלמה — נסו שוב'
        : r.error === 'installed-app-only' ? 'עדכון זמין באפליקציה המותקנת בלבד'
        : r.error === 'no-installer' ? 'לא נמצא מתקין חבילות במכשיר'
        : 'ההתקנה נכשלה — נסו שוב';
      msg.className = 'form-msg err';
    }
  });

  // v1.0.8: About tab — contact the developer (opens the mail app; the address is
  // visible in the hint if no mail app handles mailto) + tour replay.
  $('contact-dev').addEventListener('click', async () => {
    // v1.0.15: addresses come from links.js (one config file for every external link)
    const { LINKS } = await import('./links.js');
    const { email, cc, subject } = LINKS.contact;
    $('contact-msg').textContent = email; // visible fallback if no mail app handles mailto
    $('contact-msg').className = 'form-msg';
    try {
      window.location.href = `mailto:${email}?cc=${encodeURIComponent(cc || '')}&subject=${encodeURIComponent(subject || '')}`;
    } catch {}
  });
  // v1.0.19: the landing page — what the app is, the install walkthrough, and the
  // link a parent forwards to another parent. Same openExternal path as the policy
  // buttons: the WebView blocks external navigation by design, so it must leave
  // the app; if that fails, show the address so it can still be copied by hand.
  $('site-btn').addEventListener('click', async () => {
    const { LINKS } = await import('./links.js');
    const { openExternal } = await import('./platform.js');
    const ok = await openExternal(LINKS.site.home);
    if (!ok) {
      $('contact-msg').textContent = LINKS.site.home;
      $('contact-msg').className = 'form-msg';
    }
  });
  // v1.0.32: the privacy/terms buttons are gone (user request) — the policies live on
  // the site as nav tabs, one tap behind site-btn; OAuth verification keeps pointing at
  // the same URLs (LINKS.site.privacy/terms stay in links.js as the record of them).
  $('tour-replay').addEventListener('click', () => { startTour({ replay: true }); });
  $('guide-add').addEventListener('click', () => { startAddGuide(); });
  // v1.0.20: the same guide from the child's EMPTY home — the one moment a parent is
  // guaranteed to be looking at the app and stuck. Reading it needs no PIN (it adds
  // nothing); back returns to the empty home because startAddGuide uses nav.go.
  $('empty-guide').addEventListener('click', () => { startAddGuide(); });
  // v1.0.32: the "מה חדש בגירסה" button is gone (user request) — the notes show in the
  // one place that matters: the update prompt, before every install (showWhatsNew there).
  // v1.0.14: voluntary support — donate + the two free ways to help
  $('donate-btn').addEventListener('click', () => { openDonateFlow().catch(() => {}); });
  $('nudge-donate').addEventListener('click', async () => {
    await prefSet('donate.nudgeDismissed', '1'); // shown once, whatever the answer
    $('donate-nudge').classList.add('hidden');
    openDonateFlow().catch(() => {});
  });
  $('nudge-dismiss').addEventListener('click', async () => {
    await prefSet('donate.nudgeDismissed', '1');
    $('donate-nudge').classList.add('hidden');
  });
  $('help-share').addEventListener('click', () => { $('share-app').click(); });

  $('wn-ok').addEventListener('click', () => { closeWhatsNew(true); if (nav.isActive('whatsnew')) nav.back(); });
  $('wn-cancel').addEventListener('click', () => { closeWhatsNew(false); if (nav.isActive('whatsnew')) nav.back(); });

  $('parent-exit').addEventListener('click', goGallery);
  $('clear-cache').addEventListener('click', async () => {
    const n = await clearCache();
    await alertKid({
      emoji: '🧹',
      title: n > 0 ? `נמחקו ${n} קבצי וידאו` : 'אין מה לנקות',
      text: n > 0
        ? 'הקבצים שהורדו למכשיר נמחקו (פינוי מקום). הרשימה עצמה נשמרת.'
        : 'הורדה מתבצעת רק באפליקציה המותקנת, ורק לקובץ mp4 שההזרמה שלו נכשלה.',
      ok: 'סבבה'
    });
  });
  $('reset-pin').addEventListener('click', async () => {
    const yes = await confirmKid({
      emoji: '🔓', title: 'לאפס את קוד ההורים?',
      text: 'תתבקשו להגדיר קוד חדש בכניסה הבאה למסך ההורים.',
      ok: 'איפוס', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    await clearPin();
    goGallery();
  });
}

/* ---------------- Init ---------------- */
async function init() {
  // v1.0.31: the cold-start splash. init() runs once per process, so this fires only on a
  // real launch, never on resume. The app boots behind it; ~1.3s later it fades away.
  const splash = document.getElementById('splash-overlay');
  if (splash) setTimeout(() => splash.classList.add('splash-hide'), 1300);
  mountModal();
  registerViews();
  wire();
  onBackButton(nav.handleBack);

  // v1.0.9: Android TV — 10-foot layout + D-pad focus mode. Same APK as the tablet;
  // browser preview can force it with localStorage['tv']='1'.
  try {
    const { isTv } = await import('./platform.js');
    if (await isTv()) {
      document.documentElement.classList.add('tv');
      (await import('./ui/dpad.js')).initDpad();
    }
  } catch {}

  // v1.0.11: re-arm the exit lock on every launch (pinning does not survive restarts).
  // v1.0.25: the lock is per-profile now, and this runs BEFORE a profile is picked — so
  // it arms from the LAST active one. Without that there is an unlocked window between
  // launch and the profile tap, which is precisely when an unattended child is holding it.
  try {
    if (await exitLockOn(await prefGet('activeProfile'))) {
      const { lockTask } = await import('./platform.js');
      lockTask().catch(() => {});
    }
    await applyExitLockUi();
  } catch {}

  // v1.0.32 — the physical screen-off button (and HOME / the app switcher): stop the
  // sound, bank the spot. Android does not pause the WebView, so until this listener a
  // playing video kept its soundtrack running behind a dark screen — with the kiosk lock
  // ON and OFF alike. The order is load-bearing: save FIRST (it reads the live playhead),
  // THEN pause. The player stays mounted at its position, so when the screen comes back
  // the child finds the video waiting, paused, exactly where it stopped (the HUD's
  // heartbeat notices the pause and pins itself). saveWatchPosition is a no-op while the
  // resume setting is off — the in-session position lives in the paused player itself.
  onAppPause(() => {
    saveWatchPosition(currentWatch);
    pauseCurrent();
  });

  onAppResume(async () => {
    // v1.0.31: a scheduled lock may have matured while backgrounded — check before anything.
    await tickScheduledLock().catch(() => {});
    // v1.0.22 — pull the family's shared state FIRST: the parent very often approves on
    // the phone and then hands the tablet to the child, and resume does not re-fire the
    // gallery's onEnter. Same guards as the resync below (never mid-video, home only),
    // and serialized before it so the two never write the same records at once.
    if (activeProfileId && isGalleryActive()) {
      try {
        if (await maybePullDrive()) {
          await loadGiftStates();
          if (isGalleryActive()) await renderHome();
        }
      } catch {}
    }
    // resync on foreground — but never while a video plays, and only from the home
    if (activeProfileId && isGalleryActive() && await shouldSync(activeProfileId)) {
      syncLibrary(activeProfileId).then(async () => {
        await loadGiftStates();
        if (isGalleryActive()) renderHome();
      }).catch(() => {});
    }
    // v1.0.21: also re-check for a release here. Coming back from the background does
    // NOT re-fire the gallery's onEnter, so a device left running for days never looked.
    if (activeProfileId && isGalleryActive()) {
      import('./update.js')
        .then((u) => u.checkForUpdate({ silent: true }))
        .then((r) => maybePromptUpdate(r))
        .catch(() => {});
    }
  });

  // v1.0.14: stamp the first launch once — the gentle support reminder waits a month
  try { if (!(await prefGet('install.firstSeenAt'))) await prefSet('install.firstSeenAt', String(Date.now())); } catch {}

  await migrateLegacyIfNeeded();
  // Preferences → IndexedDB (idempotent, resumable, non-destructive).
  try { await runMigrationIfNeeded(); } catch (e) { console.warn('idb migration failed', e); }
  // v1.0.8: one-shot data-structure migrations after an app update (dataver.js).
  try { const { runDataMigrations } = await import('./dataver.js'); await runDataMigrations(); } catch {}

  // F12b + v1.0.7: videos AND channels shared from the YouTube app go through the
  // interactive PIN+confirm flow (listener first, then drain — see share.js).
  initShareTarget({
    profileIdGetter: () => activeProfileId,
    interactiveHandler: handleShareInteractive,
    // v1.0.26: EVERY outcome is reported. Sharing used to be silent on all of its routes —
    // added, parked, duplicate, previously deleted, dropped — so "sharing does not work"
    // could not be told apart from "it worked and you are looking at the wrong screen".
    resultHandler: (reason) => {
      const { kind, text } = shareOutcome(reason);
      toast(text, kind);
    },
    profileChooser: chooseShareProfile, // v1.0.23 — asked only when it changes the outcome
    onShareAdded: async ({ pending, channelAdded, channelFailed, title, isPlaylist }) => {
      if (channelFailed) {
        await alertKid({ emoji: '😕', title: 'לא הצלחנו לזהות את הערוץ', text: 'אפשר לנסות דרך מסך ההורים ← הוספה.', ok: 'בסדר' });
        return;
      }
      if (channelAdded) {
        // v1.0.25: the SAME import-then-ask path the parent screen uses. This used to be a
        // bare "הערוץ נוסף! ✅ … חדשים ימתינו לאישור" over a catalogue that was still
        // downloading — the parent was told the outcome before there was one, and the
        // backlog then sat in ממתינים unannounced.
        const { synced, approved, count, empty, picked } = await importChannelAndAsk(channelAdded);
        // share.js has passed `isPlaylist` since v1.0.26 — this handler ignored it, so a
        // shared playlist (once the confirm above let one through at all) announced
        // itself as "הערוץ נוסף". `picked` rides to channelAddOutcome so a manual pick
        // reports what was chosen, not a queue the parent just emptied (v1.0.27).
        const addedWhat = isPlaylist ? 'רשימת ההשמעה נוספה' : 'הערוץ נוסף';
        await alertKid(synced
          ? { emoji: isPlaylist ? '🎵' : '📺', title: `${addedWhat}! ✅`, text: `${title || (isPlaylist ? 'הרשימה' : 'הערוץ')} — ${channelAddOutcome(approved, count, empty, picked)}`, ok: 'מעולה' }
          : { emoji: '😕', title: `${addedWhat}, אבל המשיכה נכשלה`, text: 'אפשר לנסות שוב ממסך ההורים ← מקורות ← רענון נתונים.', ok: 'בסדר' });
        if (nav.isActive('gallery')) renderHome();
        return; // importChannelAndAsk already re-rendered and scheduled the push
      }
      if (nav.isActive('gallery')) renderHome();
      // A video shared from YouTube lands with no srcChannelId and no gift rank, so it
      // showed up in the loose list and was not a 🎁 until the parent happened to press
      // "רענון נתונים" (v1.0.21 field bug). A PENDING video waits for approval, which
      // syncs then.
      if (!pending) refreshAfterAdd();
    }
  });
  await loadActiveId();
  profiles = await getProfiles();

  // Boot order (v1.0.8): onboarding tour (once per install) → Google-connect offer
  // (once) → profiles. The tour never blocks a returning user.
  const bootContinue = async () => {
    if (await shouldOfferConnect()) nav.reset('connect');
    else startAtProfiles();
  };
  if (!(await prefGet('tour.done'))) startTour({ onDone: () => { bootContinue().catch(() => startAtProfiles()); } });
  else await bootContinue();

  // F14 launch check — un-awaited, throttled, all paths caught. NEVER blocks startup.
  // v1.0.4: when an update exists, ASK whether to install (maybePromptUpdate).
  setTimeout(() => {
    import('./update.js')
      .then((u) => u.cleanupPendingApk().then(() => u.checkForUpdate({ silent: true })))
      .then((r) => maybePromptUpdate(r))
      .catch(() => {});
  }, 4000);
}

init();
