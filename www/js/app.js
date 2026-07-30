// app.js — boot, global wiring, and (until the view split completes) the gallery,
// PIN and parent screens. Navigation goes through nav.js; dialogs through ui/modal.js.
import {
  loadItems, getSource, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId, fetchYouTubeTitle,
  profileNameExists
} from './store.js';
import * as wake from './wake.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { playItem, stop } from './player.js';
import { clearCache } from './media.js';
import { onAppResume, onBackButton, exitApp, prefGet, prefSet } from './platform.js';
import { runMigrationIfNeeded } from './migrate.js';
import { PAGE_VIDEOS, PAGE_WATCH, PAGE_FOLDERS, AVATARS } from './config.js';
import { confirmKid, askKid, alertKid, mountModal, isModalOpen } from './ui/modal.js';
import { rankItems } from './search.js';
import { makePager } from './ui/pager.js';
import * as loading from './ui/loading.js';
import * as nav from './nav.js';
import * as db from './db.js';
import { syncLibrary, shouldSync } from './sync2.js';
import { normalizeTitle } from './normalize.js';
import { burst } from './ui/confetti.js';
import { playUnwrap } from './ui/sound.js';
import { initShareTarget, drainShareQueue } from './share.js';

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
let giftStates = new Map();           // key -> profileVideoState record (gifts, F9)
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

/* ---------------- Exit lock (v1.0.11, per-device) ---------------- */
// When ON: the app is OS-pinned (home/recents/back contained by Android — the only
// sanctioned way to catch the HOME button), the exit button disappears, and every
// exit path runs confirm → parent PIN → unpin + exit.
async function exitLockOn() {
  try { return (await prefGet('exitLock')) === '1'; } catch { return false; }
}

async function applyExitLockUi() {
  const on = await exitLockOn();
  $('exit-btn').classList.toggle('hidden', on);
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

/* ---------------- Attention (v1.0.4): red dots for the parent ---------------- */
/** attention = pending approvals waiting OR an update ready to install. */
async function computeAttention() {
  let pending = 0;
  try {
    const scopes = [libScope, activeProfileId ? db.profScope(activeProfileId) : null].filter(Boolean);
    for (const s of scopes) pending += (await db.pagePending(s, { limit: 1 })).total;
  } catch {}
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
 * (6h) and the prompt fires at most once per session.
 */
function homeEntryRefresh() {
  if (!activeProfileId) return;
  (async () => {
    if (await shouldSync(activeProfileId)) {
      syncLibrary(activeProfileId).then(async () => {
        await loadGiftStates();
        if (nav.isActive('gallery')) renderHome();
      }).catch(() => {});
    }
  })().catch(() => {});
  import('./update.js')
    .then((u) => u.checkForUpdate({ silent: true }))
    .then((r) => maybePromptUpdate(r))
    .catch(() => {});
}

/** The red dot on the 🔒 gate button — the parent's cue to come look. */
async function refreshGateDot() {
  try {
    const a = await computeAttention();
    $('gate-dot').classList.toggle('hidden', !(a.pending > 0 || a.updateReady));
  } catch {}
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
 * v1.0.8 (user request): right before installing, show WHAT'S NEW — the release
 * notes the parent wrote when publishing (already stored from GitHub). One OK
 * button, no cancel: informational only, the install follows.
 */
async function showWhatsNew(latest) {
  const notes = String((latest && latest.notes) || '').trim();
  if (!notes) return;
  await alertKid({
    emoji: '✨', title: `מה חדש בגירסה ${latest.version}`,
    text: notes.slice(0, 600), ok: 'אישור והתקנה'
  });
}

/** Download + hand off to the Android installer, with the loading screen as progress. */
async function runUpdateInstall(latest) {
  await showWhatsNew(latest);
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
      if (tourIdx > 0) { tourIdx -= 1; renderTourSlide(); } else { finishTour(); }
      return true;
    }
  });
  nav.register('sheet-setup', { onBack: () => { finishSheetSetup(); return true; } });
  nav.register('profiles', { onBack: () => { askExit(); return true; } });
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
  nav.register('folder', {}); // default pop → home
  nav.register('search', {}); // default pop → home; watch pushed on top returns here
  nav.register('watch', {
    onLeave: (prev, next) => {
      if (next && next.name === 'watch') return; // video→video: player.js reuses the iframe
      stop();
      wake.releaseAll();
      currentWatch = null;
    }
  });
  // Leaving the pin view WITHOUT success (cancel button / hardware back) resolves
  // the session as cancelled — waiting flows (share add, update) get their answer.
  nav.register('pin', { onLeave: () => consumePinDone(false) });
  nav.register('parent', { onBack: () => { goGallery(); return true; } });
  loading.registerLoadingView();
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

/* ---------------- Home: folders (F10) ---------------- */
function folderTile(f) {
  const btn = document.createElement('button');
  btn.className = 'tile tile-folder' + (f.isNew ? ' folder-new' : '');
  btn.type = 'button';
  btn.style.position = 'relative';

  const logo = document.createElement('span');
  logo.className = 'folder-logo';
  if (f.logoUrl) {
    const img = document.createElement('img');
    img.src = f.logoUrl;
    img.alt = '';
    img.onerror = () => { img.remove(); logo.textContent = f.emoji; };
    logo.appendChild(img);
  } else {
    logo.textContent = f.emoji;
  }
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
  // never mistake a folder for a playable video tile.
  if (String(f.id).startsWith('ch:')) {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    chip.textContent = '📺 ערוץ';
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
          const { enqueueSheetRow } = await import('./sheetwrite.js');
          await enqueueSheetRow(profileId, { key: rec.key, srcUrl: rec.srcUrl || rec.url || '', title: rec.title || '' });
        }
        moved += 1;
      }
      await db.deleteVideoRaw(pScope, rec.key); // raw: a move, not a deletion — no tombstone
    }
    await db.copyDenies(pScope, lib); // personal deletions keep protecting the shared list
    if (moved) maybeSchedulePush();
  } catch { /* absorbing must never block activation; next activation retries */ }
}

async function buildFolders() {
  const out = [];
  if (!activeProfileId) return out;
  const giftCount = await db.countGifts(activeProfileId);
  if (giftCount > 0) out.push({ id: 'new', title: 'חדשים', emoji: '🎁', count: giftCount, isNew: true });

  const src = await db.getSources(activeProfileId);
  libScope = (src && src.libraryId) || null;
  if (libScope) {
    for (const lc of await db.listLibraryChannels(libScope)) {
      if (lc.hidden) continue;
      const ch = (await db.getChannel(lc.channelId)) || {};
      const count = await db.countFolder(libScope, 'ch:' + lc.channelId);
      if (!count) continue;
      out.push({
        id: 'ch:' + lc.channelId, scope: libScope, title: lc.titleOverride || ch.title || 'ערוץ',
        // logo → persisted per-channel fallback thumbnail → 📺 emoji (v1.0.6):
        // every channel folder must stay visually distinct for a non-reading child
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '📺', count
      });
    }
    // the merged shared list (sheet rows + manual adds + approved shares, v1.0.6)
    const sheetCount = await db.countFolder(libScope, 'sheet');
    if (sheetCount) out.push({ id: 'sheet', scope: libScope, title: 'סרטונים נוספים', emoji: '⭐', count: sheetCount });
  }
  // legacy safety: pre-absorb profile-scope items (e.g. before the first sync creates
  // sources) stay reachable until absorbMineIntoShared picks them up
  const mineCount = await db.countFolder(db.profScope(activeProfileId), 'mine');
  if (mineCount) out.push({ id: 'mine', scope: db.profScope(activeProfileId), title: 'סרטונים נוספים', emoji: '💜', count: mineCount });
  return out;
}

function scopeForFolder(fid) {
  if (fid === 'mine') return db.profScope(activeProfileId);
  return libScope;
}

/**
 * Home = folder tiles. UX rule: with a SINGLE content folder (the common sheet-only
 * setup) the home renders that folder's videos flat — exactly today's experience —
 * and folders appear only once there's something to organize.
 */
async function renderHome() {
  folders = await buildFolders();
  const grid = $('grid');
  const contentFolders = folders.filter((f) => !f.isNew);

  refreshGateDot(); // fire-and-forget — the red dot must never delay the grid

  const empty = folders.length === 0;
  $('empty-state').classList.toggle('hidden', !empty);
  grid.classList.toggle('hidden', empty);
  if (empty) { $('pg-controls').classList.add('hidden'); grid.innerHTML = ''; return; }

  if (contentFolders.length === 1 && folders.length === 1) {
    await renderGridPage(grid, contentFolders[0].scope, contentFolders[0].id, 'home');
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

/** Render one page of videos of (scope, folderId) into a grid ('home' or 'folder'). */
async function renderGridPage(grid, scope, fid, which) {
  const pg = which === 'home' ? page : folderPage;
  let items15;
  let total;
  if (fid === 'new') {
    const res = await db.pageGifts(activeProfileId, { offset: pg * PAGE_SIZE, limit: PAGE_SIZE });
    total = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
    items15 = [];
    const prefer = [libScope, db.profScope(activeProfileId)].filter(Boolean);
    for (const st of res.items) {
      // by-key lookup across ALL scopes: immune to library-id drift (a re-saved sheet
      // URL used to orphan gift states — badge counted them, the folder came up empty)
      const rec = await db.findLiveByKey(st.key, prefer);
      if (rec) {
        items15.push(rec);
      } else {
        // self-heal: the video is gone everywhere — drop the orphaned state so the
        // "חדשים" badge converges with what the child actually sees
        try { await db.deleteVideoState(activeProfileId, st.key); giftStates.delete(st.key); } catch {}
      }
    }
  } else {
    const res = await db.pageFolder(scope, fid, { offset: pg * PAGE_SIZE, limit: PAGE_SIZE });
    total = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
    items15 = res.items;
  }
  grid.innerHTML = '';
  for (const rec of items15) grid.appendChild(tileEl(rec));
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
  const folderEntries = [];
  if (libScope) {
    for (const lc of await db.listLibraryChannels(libScope)) {
      if (lc.hidden) continue;
      const ch = (await db.getChannel(lc.channelId)) || {};
      const count = await db.countFolder(libScope, 'ch:' + lc.channelId);
      if (!count) continue;
      const title = lc.titleOverride || ch.title || '';
      folderEntries.push({
        id: 'ch:' + lc.channelId, scope: libScope, key: 'folder:' + lc.channelId,
        title, normTitle: normalizeTitle(title),
        logoUrl: ch.logoUrl || ch.fallbackThumbUrl || '', emoji: '📺', count
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
    const img = document.createElement('img');
    img.src = f.logoUrl;
    img.alt = '';
    img.onerror = () => { img.remove(); logoTop.textContent = f.emoji || '📺'; };
    logoTop.appendChild(img);
    logoTop.classList.remove('hidden');
  } else if (f && f.emoji && !f.isNew) {
    logoTop.textContent = f.emoji;
    logoTop.classList.remove('hidden');
  } else {
    logoTop.classList.add('hidden');
  }
  nav.go('folder', { folderId: fid });
  await renderFolderView();
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

  const res = await db.pageFolder(scope, fid, { offset: watchPage * PAGE_WATCH, limit: PAGE_WATCH });
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
  currentWatch = item;
  // Tapping a video goes straight to fullscreen (user request). Synchronous — still
  // inside the tap gesture. Exiting fullscreen (back / ⛶) lands on the watch page,
  // where the 🏠 button lives.
  enterPlayerFullscreen();
  // watch-grid context: the record's own folder (or where the child was browsing)
  watchCtx = {
    scope: item.scopeId || scopeForFolder(folderId) || libScope || db.profScope(activeProfileId),
    folderId: (item.folderId && item.folderId !== '~pending') ? item.folderId : folderId
  };
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

  await playItem(item, $('player-host'), {
    onExit: () => { if ($('view-watch').classList.contains('active')) goGallery(); },
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
      for (const scope of scopes) {
        const rec = await db.getVideo(scope, item.key);
        if (rec) {
          if ((rec.homeFolderId || rec.folderId) === 'sheet') sheetBacked = true;
          await db.deleteVideo(scope, item.key); // atomic delete + deny tombstone
          deleted = true;
        }
      }
      if (deleted) {
        giftStates.delete(item.key);
        if (activeProfileId) { try { await db.deleteVideoState(activeProfileId, item.key); } catch {} }
        // v1.0.10: a sheet-backed video loses its ROW too — every sheet participant
        // converges. (Channel videos have no row; their deletion stays per-account.)
        if (sheetBacked) enqueueSheetDeleteVideo(item.key);
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
  if (nav.isActive('pin') || isModalOpen()) return Promise.resolve(c.kind === 'channel' ? null : 'pending');
  return new Promise((resolve) => {
    (async () => {
      startPin((await hasPin()) ? 'verify' : 'setup', {
        replace: nav.isActive('watch'), // never leave a torn-down player behind
        title: c.kind === 'channel' ? 'קוד הורים להוספת הערוץ' : 'קוד הורים להוספת הסרטון',
        onDone: (success) => { if (!success) resolve(c.kind === 'channel' ? null : 'pending'); },
        onSuccess: async () => {
          if (c.kind === 'channel') {
            const yes = await confirmKid({
              emoji: '📺', title: 'להוסיף את הערוץ כולו?',
              text: (c.title ? c.title + ' — ' : '') + 'סרטונים חדשים שלו ימתינו לאישור הורים.',
              ok: 'הוספת הערוץ', cancel: 'לא עכשיו'
            });
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
    })().catch(() => resolve(c.kind === 'channel' ? null : 'pending'));
  });
}

/* v1.0.10: fire-and-forget sheet write-back helpers (never block the UI) */
function enqueueSheetDeleteVideo(key) {
  import('./sheetwrite.js')
    .then((sw) => sw.enqueueSheetVideoDelete(activeProfileId, key))
    .then(() => refreshSheetWriteStatus().catch(() => {}))
    .catch(() => {});
}
function enqueueSheetDeleteChannel(channelId) {
  import('./sheetwrite.js')
    .then((sw) => sw.enqueueSheetChannelDelete(activeProfileId, channelId))
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
  if (replace) nav.replace('pin'); else nav.go('pin');
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

/* ---------------- Parent screen (tabs: approve / add / sources / settings) ---------------- */
function enterParent() { refreshParent(); nav.replace('parent'); } // replaces 'pin' on the stack

const PARENT_TABS = ['approve', 'add', 'sources', 'settings', 'about'];
let parentTab = 'add';

function setParentTab(name) {
  parentTab = name;
  for (const t of PARENT_TABS) {
    $('tab-' + t).classList.toggle('active', t === name);
    $('panel-' + t).classList.toggle('hidden', t !== name);
  }
}

async function refreshParent() {
  const src = await db.getSources(activeProfileId);
  $('remote-url').value = (src && src.sheetUrl) || '';
  $('apikey-input').value = (await import('./platform.js').then((p) => p.prefGet('yt:apiKey'))) || '';
  $('share-approval-toggle').checked = !src || !src.shareIntent || src.shareIntent.requireApproval !== false;
  $('exit-lock-toggle').checked = await exitLockOn();
  $('add-msg').textContent = '';
  $('remote-status').textContent = '';
  $('approve-msg').textContent = '';
  setParentTab(parentTab);
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
  if (st.error === 'no-edit-permission') {
    el.textContent = '⚠️ אין הרשאת עריכה לגיליון — סרטונים שנוספו באפליקציה לא נרשמים בו. שתפו את הגיליון לחשבון Google המחובר כעורך.';
    el.className = 'form-msg err';
  } else if (st.error === 'published-link') {
    el.textContent = '⚠️ הקישור לגיליון הוא קישור פרסום — כדי שהאפליקציה תרשום אליו, הדביקו את קישור העריכה הרגיל של הגיליון.';
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
  const meta = (await db.getMeta('drive')) || {};
  const on = !!meta.enabled;
  $('drive-status').textContent = on
    ? `פעיל ✅ — גיבוי אחרון: ${meta.lastPushAt ? new Date(meta.lastPushAt).toLocaleString('he-IL') : 'עדיין לא'}`
    : 'כבוי — הספרייה שמורה רק במכשיר הזה. ההפעלה דורשת אישור חד-פעמי בחשבון Google.';
  $('drive-enable').classList.toggle('hidden', on);
  $('drive-push').classList.toggle('hidden', !on);
}

/** Push local state to Drive soon — no-op until the parent enabled backup. */
async function maybeSchedulePush() {
  const meta = (await db.getMeta('drive')) || {};
  if (!meta.enabled) return;
  const { schedulePush } = await import('./drive.js');
  schedulePush(profiles);
}

function parentRow({ rec, onDelete, onApprove }) {
  const li = document.createElement('li');
  const img = document.createElement('img');
  img.className = 'li-thumb';
  setThumb(img, rec);
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
  li.appendChild(img);
  li.appendChild(body);
  if (onApprove) {
    const ok = document.createElement('button');
    ok.className = 'li-ok'; ok.type = 'button'; ok.textContent = '✅';
    ok.addEventListener('click', onApprove);
    li.appendChild(ok);
  }
  const del = document.createElement('button');
  del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
  del.addEventListener('click', onDelete);
  li.appendChild(del);
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
  $('list-count').textContent = all.length > PARENT_LIST_CAP
    ? `מוצגים ${PARENT_LIST_CAP} מתוך ${all.length} סרטונים`
    : `${all.length} סרטונים`;
  const ul = $('parent-list');
  ul.innerHTML = '';
  for (const rec of all.slice(0, PARENT_LIST_CAP)) {
    ul.appendChild(parentRow({
      rec,
      onDelete: async () => {
        await db.deleteVideo(rec.scopeId, rec.key); // atomic delete + deny tombstone
        // v1.0.10: sheet-backed rows are removed from the sheet for everyone
        if ((rec.homeFolderId || rec.folderId) === 'sheet') enqueueSheetDeleteVideo(rec.key);
        await refreshParentList();
        renderHome();
        maybeSchedulePush();
      }
    }));
  }
}

/**
 * v1.0.6: approved shares / manual items become sheet rows — channel videos do NOT
 * (their channel row already represents them in the sheet).
 */
async function enqueueApprovedForSheet(recs) {
  const rows = (recs || []).filter((r) => r.origin === 'share-intent' || r.origin === 'manual');
  if (!rows.length) return;
  try {
    const { enqueueSheetRow } = await import('./sheetwrite.js');
    for (const r of rows) {
      await enqueueSheetRow(activeProfileId, { key: r.key, srcUrl: r.srcUrl || r.url || '', title: r.title || '' });
    }
  } catch {}
}

/** Pending queue (channel discoveries / quarantined sheet rows / shares). */
async function refreshPendingList() {
  const scopes = [libScope, db.profScope(activeProfileId)].filter(Boolean);
  const all = [];
  let grandTotal = 0;
  for (const s of scopes) {
    const r = await db.pagePending(s, { limit: 500 });
    all.push(...r.items);
    grandTotal += r.total;
  }
  const badge = $('pending-badge');
  badge.textContent = grandTotal;
  badge.classList.toggle('hidden', grandTotal === 0);
  const ul = $('pending-list');
  ul.innerHTML = '';
  for (const rec of all.slice(0, PARENT_LIST_CAP)) {
    ul.appendChild(parentRow({
      rec,
      onApprove: async () => {
        await db.approvePending(rec.scopeId, [rec.key]);
        await enqueueApprovedForSheet([rec]);
        await refreshPendingList();
        renderHome();
        maybeSchedulePush();
      },
      onDelete: async () => {
        await db.rejectPending(rec.scopeId, [rec.key]); // tombstoned — never comes back
        await refreshPendingList();
      }
    }));
  }
  return all;
}

async function refreshChannelsList() {
  const ul = $('channels-list');
  ul.innerHTML = '';
  if (!libScope) return;
  for (const lc of await db.listLibraryChannels(libScope)) {
    const ch = (await db.getChannel(lc.channelId)) || {};
    const li = document.createElement('li');
    const logo = document.createElement('img');
    logo.className = 'li-thumb';
    logo.style.width = '46px';
    logo.style.aspectRatio = '1';
    logo.style.borderRadius = '50%';
    if (ch.logoUrl) logo.src = ch.logoUrl;
    const body = document.createElement('div');
    body.className = 'li-body';
    const title = document.createElement('div');
    title.className = 'li-title';
    title.textContent = lc.titleOverride || ch.title || lc.channelId;
    const toggle = document.createElement('label');
    toggle.className = 'li-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!lc.autoApprove;
    cb.addEventListener('change', async () => {
      await db.putLibraryChannel({ ...lc, autoApprove: cb.checked, autoApproveSource: 'ui' });
      if (!cb.checked) return;
      // v1.0.6: turning auto-approve ON offers to flush the channel's WAITING videos
      // too — otherwise they'd sit in ממתינים forever ("approved the channel, why is
      // the queue still full?"). Declining keeps them for one-by-one review.
      const { items } = await db.pagePending(libScope, { limit: 5000 });
      const keys = items.filter((r) => r.channelId === lc.channelId).map((r) => r.key);
      if (!keys.length) return;
      const yes = await confirmKid({
        emoji: '✅', title: `לאשר גם ${keys.length} סרטונים שממתינים?`,
        text: 'הם ייכנסו מיד לתיקיית הערוץ אצל הילד. "רק מהיום" ישאיר אותם ברשימת הממתינים.',
        ok: 'אישור הכול', cancel: 'רק מהיום והלאה'
      });
      if (!yes) return;
      await db.approvePending(libScope, keys);
      await loadGiftStates();
      await Promise.all([refreshPendingList(), refreshParentList()]);
      renderHome();
      maybeSchedulePush();
    });
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode('אישור אוטומטי לסרטונים חדשים'));
    body.appendChild(title);
    body.appendChild(toggle);
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
      enqueueSheetDeleteChannel(lc.channelId);
      await loadGiftStates();
      await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
      renderHome();
      maybeSchedulePush();
    });
    li.appendChild(logo);
    li.appendChild(body);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

/** The profile's sources record, created on first use (stable library even without a sheet). */
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

  const { classifySourceRow } = await import('./classify.js');
  const row = classifySourceRow(url);

  if (row.kind === 'video') {
    // v1.0.6: manual adds live in the SHARED library folder (single list for the
    // whole family) and are appended to the sheet — one master list, everywhere.
    const scope = (await ensureSources()).libraryId;
    const exists = (await db.getVideo(scope, row.key)) || (await db.getVideo(db.profScope(activeProfileId), row.key));
    if (exists) { msg.textContent = 'הסרטון כבר קיים ברשימה'; msg.className = 'form-msg err'; return; }
    const now = Date.now();
    const title = $('add-title').value.trim();
    const rec = {
      scopeId: scope, key: row.key, type: row.type, id: row.id ?? null, url: row.url ?? null,
      srcUrl: row.srcUrl, driveId: row.driveId ?? null,
      title, titleSource: title ? 'sheet' : null, normTitle: normalizeTitle(title),
      folderId: 'sheet', channelId: null,
      sortKey: (await import('./order.js')).sortKeyFor({ origin: 'manual', addedAt: now }),
      publishedAt: null, rowIndex: null, origin: 'manual', state: 'live',
      addedAt: now, approvedAt: now,
      thumbId: null, thumbUrl: $('add-thumb').value.trim() || null, localPath: null, updatedAt: now
    };
    await db.putVideos([rec]);
    const { enqueueSheetRow } = await import('./sheetwrite.js');
    enqueueSheetRow(activeProfileId, { key: rec.key, srcUrl: rec.srcUrl, title: rec.title }).catch(() => {});
    if (!rec.title && rec.type === 'youtube') {
      fetchYouTubeTitle(rec.id).then((t) => t && persistTitle(rec, t)).catch(() => {});
    }
    $('add-url').value = ''; $('add-title').value = ''; $('add-thumb').value = '';
    msg.textContent = 'נוסף! ✅'; msg.className = 'form-msg ok';
    await refreshParentList();
    renderHome();
    maybeSchedulePush();
    return;
  }

  if (row.kind === 'channel') {
    msg.textContent = 'מזהה את הערוץ…';
    await ensureSources();
    const ytApi = await import('./yt.js');
    const channelId = await ytApi.resolveChannelRef(row.channelRef, await ytApi.getApiKey());
    if (!channelId) { msg.textContent = 'לא הצלחנו לזהות את הערוץ'; msg.className = 'form-msg err'; return; }
    const known = (await db.listLibraryChannels(libScope)).some((c) => c.channelId === channelId);
    await db.putLibraryChannel({
      libraryId: libScope, channelId, autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
    });
    if (!known) { // v1.0.6: channels added here become sheet rows too (single master list)
      const { enqueueSheetRow } = await import('./sheetwrite.js');
      enqueueSheetRow(activeProfileId, {
        key: 'ch:' + channelId,
        srcUrl: 'https://www.youtube.com/channel/' + channelId,
        flag: 'manual' // approval-required, matching the in-app default
      }).catch(() => {});
    }
    msg.textContent = 'הערוץ נוסף! מושכים סרטונים…'; msg.className = 'form-msg ok';
    $('add-url').value = '';
    syncLibrary(activeProfileId, { force: true }).then(async () => {
      await loadGiftStates();
      await Promise.all([refreshChannelsList(), refreshPendingList(), refreshParentList()]);
      renderHome();
      msg.textContent = 'הערוץ סונכרן ✅'; msg.className = 'form-msg ok';
    }).catch(() => { msg.textContent = 'שגיאה במשיכת הערוץ'; msg.className = 'form-msg err'; });
    await refreshChannelsList();
    return;
  }

  msg.textContent = 'הלינק לא נתמך (סרטון YouTube, ערוץ, או קובץ mp4)';
  msg.className = 'form-msg err';
}

async function doSyncAndRefresh() {
  const status = $('remote-status');
  status.textContent = 'טוען…'; status.className = 'form-msg';
  try {
    const res = await syncLibrary(activeProfileId, {
      force: true,
      onProgress: (p) => { status.textContent = p.label || 'טוען…'; }
    });
    if (res.ok) {
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
  await loadGiftStates();
  await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
  renderHome();
  maybeSchedulePush();
}

/* ---------------- Onboarding tour (v1.0.8, once per install) ---------------- */
const TOUR_SLIDES = [
  {
    img: 'assets/tour/01-profiles.jpg', title: 'לכל ילד פרופיל משלו',
    text: 'בכניסה בוחרים פרופיל — שם ותמונה. לכל פרופיל ספריית סרטונים, מתנות והתקדמות משלו.'
  },
  {
    img: 'assets/tour/02-home.jpg', title: 'מסך הבית של הילד',
    text: 'ערוצים כתיקיות עם הלוגו שלהם, "סרטונים נוספים" לכל השאר, חיפוש 🔍 למעלה — וסרטונים חדשים מגיעים עטופים כמתנה 🎁.'
  },
  {
    img: 'assets/tour/03-watch.jpg', title: 'צפייה בטוחה',
    text: 'בלי פרסומות, בלי המלצות, בלי יציאה ליוטיוב. הבית 🏠 ומחיקת סרטון 🗑️ (עם קוד הורים) — בפינות למעלה.'
  },
  {
    img: 'assets/tour/04-parent.jpg', title: 'מסך ההורים 🔒',
    text: 'נכנסים עם קוד. מוסיפים סרטון בודד או ערוץ שלם, מחברים קובץ מקורות בגוגל — וכל הוספה נרשמת בקובץ אוטומטית.'
  },
  {
    img: 'assets/tour/05-approve.jpg', title: 'הכול באישור שלכם',
    text: 'סרטונים חדשים בערוצים ממתינים לאישור. נקודה אדומה על כפתור ההורים אומרת שמשהו מחכה לכם.'
  }
];
let tourIdx = 0;
let tourOnDone = null;

function renderTourSlide() {
  const s = TOUR_SLIDES[tourIdx];
  $('tour-img').src = s.img;
  $('tour-title').textContent = s.title;
  $('tour-text').textContent = s.text;
  $('tour-next').textContent = tourIdx === TOUR_SLIDES.length - 1 ? '✔' : '◀';
  $('tour-prev').disabled = tourIdx === 0;
  const dots = $('tour-dots');
  dots.innerHTML = '';
  TOUR_SLIDES.forEach((_, i) => {
    const d = document.createElement('span');
    if (i === tourIdx) d.classList.add('on');
    dots.appendChild(d);
  });
}

/** Boot shows it once ever (tour.done); the About tab replays on demand. */
function startTour({ replay = false, onDone = null } = {}) {
  tourIdx = 0;
  tourOnDone = onDone;
  renderTourSlide();
  if (replay) nav.go('tour'); else nav.reset('tour');
}

async function finishTour() {
  await prefSet('tour.done', '1');
  const done = tourOnDone;
  tourOnDone = null;
  if (done) { done(); return; }     // boot flow continues (connect / profiles)
  if (!nav.back()) goGallery();      // replay from the About tab — go back there
}

/* ---------------- Sheet setup wizard (v1.0.8, after profile creation) ---------------- */
let wizardProfile = null; // the freshly-created profile awaiting activation

/**
 * The wizard shows ONLY when the family truly starts from nothing (user decision):
 * - profiles restored from the Drive backup arrive with their sheet already wired
 *   (profileSources) and never pass through here;
 * - a NEW sibling profile on a device that already has a sheet quietly ADOPTS the
 *   same sheet (v1.0.6 made the library shared per-sheet anyway) — no wizard.
 */
async function openSheetSetup(p) {
  try {
    for (const other of await getProfiles()) {
      if (other.id === p.id) continue;
      const src = await db.getSources(other.id);
      if (src && src.sheetUrl) {
        wizardProfile = p;
        await connectWizardSheet(src.sheetUrl);
        wizardProfile = null;
        await alertKid({
          emoji: '📄', title: 'חיברנו את הקובץ המשפחתי ✅',
          text: `${p.name} יקבל את אותה רשימת סרטונים של שאר המשפחה. אפשר לשנות במסך ההורים ← מקורות.`,
          ok: 'מעולה'
        });
        await activateProfile(p.id);
        return;
      }
    }
  } catch {}
  wizardProfile = p;
  $('sheetsetup-name').textContent = p.name;
  $('sheetsetup-msg').textContent = '';
  $('sheetsetup-msg').className = 'form-msg';
  $('sheetsetup-paste').classList.add('hidden');
  $('sheetsetup-url').value = '';
  nav.reset('sheet-setup');
}

async function finishSheetSetup() {
  const p = wizardProfile;
  wizardProfile = null;
  if (p) await activateProfile(p.id); // activation syncs + shows the loading screen
}

/** The same connection routine as the sources tab — for the wizard's new profile. */
async function connectWizardSheet(url) {
  const { libraryIdFor } = await import('./util.js');
  let src = (await db.getSources(wizardProfile.id)) || { profileId: wizardProfile.id, schema: 1 };
  src = {
    shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
    maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: false },
    ...src, sheetUrl: url, libraryId: libraryIdFor(url), sheetHash: null, updatedAt: Date.now()
  };
  await db.putSources(src);
}

async function wizardCreateSheet() {
  const msg = $('sheetsetup-msg');
  msg.textContent = 'מתחברים לחשבון Google ויוצרים את הקובץ…';
  msg.className = 'form-msg';
  try {
    const { createSourceSheet } = await import('./sheetwrite.js');
    const r = await createSourceSheet(`רשימת הסרטונים של ${wizardProfile.name}`);
    if (!r.ok) {
      const { lastAuthError } = await import('./gauth.js');
      msg.textContent = r.error === 'no-token'
        ? gauthErrorText(lastAuthError())
        : 'יצירת הקובץ נכשלה — אפשר לנסות שוב, להדביק לינק לקובץ קיים, או לדלג';
      msg.className = 'form-msg err';
      return;
    }
    await connectWizardSheet(r.url);
    if (r.permissionWarning) {
      await alertKid({
        emoji: '⚠️', title: 'הקובץ נוצר, אבל…',
        text: 'לא הצלחנו להגדיר שיתוף לקריאה. פתחו את הקובץ בדרייב ← שיתוף ← "כל מי שיש לו את הקישור — צפייה", אחרת האפליקציה לא תוכל לקרוא אותו.',
        ok: 'הבנתי'
      });
    }
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

async function wizardConnectPasted() {
  const url = $('sheetsetup-url').value.trim();
  const msg = $('sheetsetup-msg');
  const { isSheetsUrl } = await import('./sheetwrite.js');
  if (!isSheetsUrl(url)) {
    msg.textContent = 'זה לא נראה כמו לינק לגיליון Google Sheets — העתיקו את הלינק מהדפדפן';
    msg.className = 'form-msg err';
    return;
  }
  msg.textContent = 'מחברים…';
  msg.className = 'form-msg';
  await connectWizardSheet(url);
  await finishSheetSetup();
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
  if (profiles.length === 0) openCreateProfile();
  else { renderProfiles(); nav.reset('profiles'); }
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
  try {
    const { signIn, lastAuthError } = await import('./gauth.js');
    const { pullDrive, pushDrive } = await import('./drive.js');
    if (!(await signIn())) {
      msg.textContent = gauthErrorText(lastAuthError());
      msg.className = 'form-msg err';
      return;
    }
    msg.textContent = 'בודקים אם יש גיבוי קיים…';
    const pulled = await pullDrive(activeProfileId);
    profiles = await getProfiles(); // pullDrive may have restored profiles
    await pushDrive(profiles);      // enables the backup even without a prior file
    await prefSet('gauth.introDone', 'connected');
    if (pulled.ok && !pulled.empty) {
      await alertKid({
        emoji: '☁️', title: 'הגיבוי חובר ✅',
        text: pulled.profilesRestored
          ? `נמצא גיבוי קיים: שוחזרו ${pulled.profilesRestored} פרופילים והספרייה סונכרנה.`
          : 'נמצא גיבוי קיים והספרייה סונכרנה למכשיר.',
        ok: 'מעולה'
      });
    }
    startAtProfiles();
  } catch {
    msg.textContent = 'שגיאה בהתחברות — אפשר לדלג ולנסות שוב מאוחר יותר דרך מסך ההורים';
    msg.className = 'form-msg err';
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Profiles ---------------- */
function renderProfiles() {
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
    btn.addEventListener('click', () => activateProfile(p.id));
    grid.appendChild(btn);
  }
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
  // v1.0.8: two profiles with the same name are indistinguishable on screen — block
  if (profileNameExists(await getProfiles(), name)) {
    msg.textContent = 'כבר יש פרופיל בשם הזה — בחרו שם אחר';
    msg.className = 'form-msg err';
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

  const hasContent = folders.length > 0;
  if (!hasContent) {
    // Nothing cached (fresh profile with a sheet): the child needs the loading screen.
    loading.show({ step: 'מביאים סרטונים חדשים…' });
  }
  nav.reset('gallery');

  // v1.0.7: shares queued before a profile was active drain AFTER the gallery is up —
  // their interactive PIN flow must not fight the activation navigation.
  drainShareQueue().catch(() => {});

  // Background sync — never blocks the grid; re-renders when new content lands.
  if (await shouldSync(id)) {
    syncLibrary(id, { onProgress: (p) => loading.setStep(p.label || '') })
      .then(async (r) => {
        await absorbMineIntoShared(id); // first sync may have just created sources
        await loadGiftStates();
        if (nav.isActive('gallery') || nav.isActive('loading')) await renderHome();
        await loading.hide();
        if (!nav.isActive('gallery') && nav.isActive('loading')) nav.reset('gallery');
        maybeSchedulePush();
      })
      .catch(async () => { await loading.hide(); });
  } else {
    await loading.hide();
  }
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
  await deleteProfile(p.id);
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
    if (tourIdx < TOUR_SLIDES.length - 1) { tourIdx += 1; renderTourSlide(); }
    else finishTour();
  });
  $('tour-prev').addEventListener('click', () => {
    if (tourIdx > 0) { tourIdx -= 1; renderTourSlide(); }
  });
  $('tour-skip').addEventListener('click', finishTour);

  // v1.0.8: sheet setup wizard (PIN required for create/paste — user-specified)
  $('sheetsetup-skip').addEventListener('click', finishSheetSetup);
  $('sheetsetup-create').addEventListener('click', async () => {
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים ליצירת הקובץ',
      onSuccess: () => { if (!nav.back()) nav.reset('sheet-setup'); wizardCreateSheet(); }
    });
  });
  $('sheetsetup-paste-btn').addEventListener('click', async () => {
    startPin((await hasPin()) ? 'verify' : 'setup', {
      title: 'קוד הורים לחיבור הקובץ',
      onSuccess: () => {
        if (!nav.back()) nav.reset('sheet-setup');
        $('sheetsetup-paste').classList.remove('hidden');
        setTimeout(() => { try { $('sheetsetup-url').focus(); } catch {} }, 60);
      }
    });
  });
  $('sheetsetup-connect').addEventListener('click', () => { wizardConnectPasted().catch(() => {}); });

  $('connect-google').addEventListener('click', connectGoogleFirstLaunch);
  $('connect-skip').addEventListener('click', async () => {
    await prefSet('gauth.introDone', 'skipped');
    startAtProfiles();
  });

  $('profile-chip').addEventListener('click', backToProfiles);
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

  for (const t of PARENT_TABS) $('tab-' + t).addEventListener('click', () => setParentTab(t));
  $('add-btn').addEventListener('click', parentAdd);

  $('approve-all').addEventListener('click', async () => {
    const pend = await refreshPendingList();
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
  });
  $('reject-all').addEventListener('click', async () => {
    const pend = await refreshPendingList();
    const yes = await confirmKid({
      emoji: '🗑️', title: `לדחות ${pend.length} סרטונים?`,
      text: 'הם לא יופיעו שוב, גם לא בסנכרונים הבאים.',
      ok: 'דחיית הכול', cancel: 'ביטול', danger: true
    });
    if (!yes) return;
    for (const r of pend) await db.rejectPending(r.scopeId, [r.key]);
    await refreshPendingList();
  });

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

  $('remote-save').addEventListener('click', async () => {
    const url = $('remote-url').value.trim();
    const { libraryIdFor } = await import('./util.js');
    let src = (await db.getSources(activeProfileId)) || { profileId: activeProfileId, schema: 1 };
    src = {
      shareIntent: { enabled: true, requireApproval: true }, defaultAutoApprove: false,
      maxItemsPerChannel: 500, maxItemsTotal: 5000, drive: { enabled: false },
      ...src, sheetUrl: url || null, updatedAt: Date.now()
    };
    if (url) src.libraryId = libraryIdFor(url);
    src.sheetHash = null; // force a full re-parse of the new sheet
    await db.putSources(src);
    libScope = src.libraryId || null;
    await doSyncAndRefresh();
  });
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
  $('remote-clear').addEventListener('click', async () => {
    const src = await db.getSources(activeProfileId);
    if (src) await db.putSources({ ...src, sheetUrl: null, sheetHash: null, updatedAt: Date.now() });
    $('remote-url').value = '';
    $('remote-status').textContent = 'הגיליון נותק. הערוצים והסרטונים הקיימים נשארים.';
    $('remote-status').className = 'form-msg';
  });

  $('apikey-save').addEventListener('click', async () => {
    const { prefSet, prefRemove } = await import('./platform.js');
    const v = $('apikey-input').value.trim();
    if (v) await prefSet('yt:apiKey', v); else await prefRemove('yt:apiKey');
    await prefRemove('yt:apiKeyState');
    $('apikey-msg').textContent = v ? 'המפתח נשמר ✅' : 'המפתח הוסר — האפליקציה תשתמש במפתח המובנה';
    $('apikey-msg').className = 'form-msg ok';
  });

  // v1.0.11: exit lock — applying is immediate (Android may show its own one-time
  // pinning confirmation); turning it off unpins right away (we're behind the PIN).
  $('exit-lock-toggle').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await prefSet('exitLock', on ? '1' : '');
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
    await db.putSources({ ...src, shareIntent: { ...(src.shareIntent || {}), enabled: true, requireApproval: e.target.checked }, updatedAt: Date.now() });
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
      const pulled = await pullDrive(activeProfileId);
      await pushDrive(profiles);
      await loadGiftStates();
      await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
      renderHome();
      await refreshDriveStatus();
      msg.textContent = pulled.ok && !pulled.empty ? 'גיבוי קיים מוזג למכשיר ✅' : 'הגיבוי הופעל ✅';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'שגיאה בהפעלת הגיבוי';
      msg.className = 'form-msg err';
    }
  });
  $('drive-push').addEventListener('click', async () => {
    const msg = $('drive-msg');
    msg.textContent = 'מגבים…'; msg.className = 'form-msg';
    const { pushDrive } = await import('./drive.js');
    const r = await pushDrive(profiles);
    msg.textContent = r.ok ? 'גובה ✅' : 'הגיבוי נכשל — ננסה שוב אוטומטית';
    msg.className = r.ok ? 'form-msg ok' : 'form-msg err';
    await refreshDriveStatus();
  });

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
    await showWhatsNew(latest); // v1.0.8: what's-new before the install starts
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
  $('contact-dev').addEventListener('click', () => {
    const subject = encodeURIComponent('הסרטונים שלי — הצעה לשיפור');
    $('contact-msg').textContent = 'dev.fassaf@gmail.com';
    $('contact-msg').className = 'form-msg';
    try {
      window.location.href = `mailto:dev.fassaf@gmail.com?cc=${encodeURIComponent('fassaf.f@gmail.com')}&subject=${subject}`;
    } catch {}
  });
  $('tour-replay').addEventListener('click', () => { startTour({ replay: true }); });

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

  // v1.0.11: re-arm the exit lock on every launch (pinning does not survive restarts)
  try {
    if (await exitLockOn()) {
      const { lockTask } = await import('./platform.js');
      lockTask().catch(() => {});
    }
    await applyExitLockUi();
  } catch {}

  onAppResume(async () => {
    // resync on foreground — but never while a video plays, and only from the home
    if (activeProfileId && isGalleryActive() && await shouldSync(activeProfileId)) {
      syncLibrary(activeProfileId).then(async () => {
        await loadGiftStates();
        if (isGalleryActive()) renderHome();
      }).catch(() => {});
    }
  });

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
    onShareAdded: async ({ pending, channelAdded, channelFailed, title }) => {
      if (channelFailed) {
        await alertKid({ emoji: '😕', title: 'לא הצלחנו לזהות את הערוץ', text: 'אפשר לנסות דרך מסך ההורים ← הוספה.', ok: 'בסדר' });
        return;
      }
      if (channelAdded) {
        await alertKid({ emoji: '📺', title: 'הערוץ נוסף! ✅', text: `${title || 'הערוץ'} — מושכים את הסרטונים שלו; חדשים ימתינו לאישור במסך ההורים.`, ok: 'מעולה' });
      }
      if (nav.isActive('gallery')) renderHome();
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
