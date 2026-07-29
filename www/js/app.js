// app.js — boot, global wiring, and (until the view split completes) the gallery,
// PIN and parent screens. Navigation goes through nav.js; dialogs through ui/modal.js.
import {
  loadItems, getSource, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId, fetchYouTubeTitle
} from './store.js';
import * as wake from './wake.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { playItem, stop } from './player.js';
import { clearCache } from './media.js';
import { onAppResume, onBackButton, exitApp } from './platform.js';
import { runMigrationIfNeeded } from './migrate.js';
import { PAGE_VIDEOS, PAGE_WATCH, PAGE_FOLDERS, AVATARS } from './config.js';
import { confirmKid, alertKid, mountModal } from './ui/modal.js';
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

/* ---------------- Views (routing via nav.js) ---------------- */
const isGalleryActive = () => nav.isActive('gallery');

function goGallery() {
  stop();
  wake.releaseAll(); // hard safety net (F7): outside the player, the screen may sleep
  currentWatch = null;
  renderHome();
  nav.reset('gallery');
}

async function askExit() {
  const leave = await confirmKid({
    emoji: '👋', title: 'לצאת מהאפליקציה?', text: 'תמיד אפשר לחזור!',
    ok: 'צא', cancel: 'השאר', danger: true
  });
  if (leave) exitApp();
}

function registerViews() {
  // Back precedence per view. Returning true = consumed; otherwise nav pops.
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
    onEnter: () => { renderHome(); }
  });
  nav.register('folder', {}); // default pop → home
  nav.register('watch', {
    onLeave: (prev, next) => {
      if (next && next.name === 'watch') return; // video→video: player.js reuses the iframe
      stop();
      wake.releaseAll();
      currentWatch = null;
    }
  });
  nav.register('pin', {}); // default pop
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
  if (f.isNew) {
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = f.count;
    btn.appendChild(badge);
  }
  btn.addEventListener('click', () => openFolder(f.id));
  return btn;
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
        logoUrl: ch.logoUrl || '', emoji: '📺', count
      });
    }
    const sheetCount = await db.countFolder(libScope, 'sheet');
    if (sheetCount) out.push({ id: 'sheet', scope: libScope, title: 'הרשימה שלנו', emoji: '⭐', count: sheetCount });
  }
  const mineCount = await db.countFolder(db.profScope(activeProfileId), 'mine');
  if (mineCount) out.push({ id: 'mine', scope: db.profScope(activeProfileId), title: 'הסרטונים שלי', emoji: '💜', count: mineCount });
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

/* ---------------- Folder view ---------------- */
async function openFolder(fid) {
  folderId = fid;
  folderPage = 0;
  const f = folders.find((x) => x.id === fid);
  $('folder-title').textContent = f ? (f.isNew ? 'חדשים 🎁' : f.title) : '';
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

/* ---------------- PIN ---------------- */
async function openParentGate() {
  startPin((await hasPin()) ? 'verify' : 'setup');
}
function updateDots() {
  const dots = $('pin-dots').children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('filled', i < pinBuffer.length);
}
function startPin(mode) {
  pinMode = mode; pinBuffer = ''; pinFirst = ''; pinStep = 1;
  $('pin-msg').textContent = '';
  $('pin-title').textContent = mode === 'setup' ? 'בחרו קוד הורים חדש' : 'הזינו קוד הורים';
  updateDots();
  nav.go('pin');
}
async function onPinComplete() {
  if (pinMode === 'setup') {
    if (pinStep === 1) {
      pinFirst = pinBuffer; pinBuffer = ''; pinStep = 2;
      $('pin-title').textContent = 'הקלידו שוב לאישור';
      updateDots();
      return;
    }
    if (pinBuffer === pinFirst) { await setPin(pinBuffer); enterParent(); }
    else {
      $('pin-msg').textContent = 'הקודים לא תואמים, נסו שוב';
      pinBuffer = ''; pinFirst = ''; pinStep = 1;
      $('pin-title').textContent = 'בחרו קוד הורים חדש';
      updateDots();
    }
  } else {
    if (await verifyPin(pinBuffer)) enterParent();
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

const PARENT_TABS = ['approve', 'add', 'sources', 'settings'];
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
  $('add-msg').textContent = '';
  $('remote-status').textContent = '';
  $('approve-msg').textContent = '';
  setParentTab(parentTab);
  refreshDriveStatus();
  runUpdateCheck().catch(() => {});
  await Promise.all([refreshParentList(), refreshPendingList(), refreshChannelsList()]);
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
  $('update-install').classList.toggle('hidden', r.status !== 'available');
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
        await refreshParentList();
        renderHome();
        maybeSchedulePush();
      }
    }));
  }
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
        text: 'הסרטונים שלו יוסתרו מהילד. אפשר להוסיף אותו שוב בעתיד.',
        ok: 'הסרה', cancel: 'ביטול', danger: true
      });
      if (!yes) return;
      await db.deleteLibraryChannel(libScope, lc.channelId);
      await refreshChannelsList();
      renderHome();
    });
    li.appendChild(logo);
    li.appendChild(body);
    li.appendChild(del);
    ul.appendChild(li);
  }
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
    const scope = db.profScope(activeProfileId);
    const exists = (await db.getVideo(scope, row.key)) || (libScope && await db.getVideo(libScope, row.key));
    if (exists) { msg.textContent = 'הסרטון כבר קיים ברשימה'; msg.className = 'form-msg err'; return; }
    const now = Date.now();
    const title = $('add-title').value.trim();
    const rec = {
      scopeId: scope, key: row.key, type: row.type, id: row.id ?? null, url: row.url ?? null,
      srcUrl: row.srcUrl, driveId: row.driveId ?? null,
      title, titleSource: title ? 'sheet' : null, normTitle: normalizeTitle(title),
      folderId: 'mine', channelId: null,
      sortKey: (await import('./order.js')).sortKeyFor({ origin: 'manual', addedAt: now }),
      publishedAt: null, rowIndex: null, origin: 'manual', state: 'live',
      addedAt: now, approvedAt: now,
      thumbId: null, thumbUrl: $('add-thumb').value.trim() || null, localPath: null, updatedAt: now
    };
    await db.putVideos([rec]);
    if (!rec.title && rec.type === 'youtube') {
      fetchYouTubeTitle(rec.id).then((t) => t && persistTitle(rec, t)).catch(() => {});
    }
    $('add-url').value = ''; $('add-title').value = ''; $('add-thumb').value = '';
    msg.textContent = 'נוסף! ✅'; msg.className = 'form-msg ok';
    await refreshParentList();
    renderHome();
    return;
  }

  if (row.kind === 'channel') {
    msg.textContent = 'מזהה את הערוץ…';
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
    const ytApi = await import('./yt.js');
    const channelId = await ytApi.resolveChannelRef(row.channelRef, await ytApi.getApiKey());
    if (!channelId) { msg.textContent = 'לא הצלחנו לזהות את הערוץ'; msg.className = 'form-msg err'; return; }
    await db.putLibraryChannel({
      libraryId: libScope, channelId, autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false, titleOverride: ''
    });
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
  const p = await createProfile(name, createSel.e, createSel.c);
  profiles = await getProfiles();
  await activateProfile(p.id);
}

async function activateProfile(id) {
  await setActiveId(id);
  activeProfileId = id;
  source = await getSource();
  items = await loadItems(); // legacy list — parent screen only
  page = 0;

  // HYDRATE first: render whatever IndexedDB has, instantly. Sync runs after.
  await drainShareQueue(); // shares that arrived before a profile was active
  await loadGiftStates();
  await renderHome();
  await updateProfileChip();

  const hasContent = folders.length > 0;
  if (!hasContent) {
    // Nothing cached (fresh profile with a sheet): the child needs the loading screen.
    loading.show({ step: 'מביאים סרטונים חדשים…' });
  }
  nav.reset('gallery');

  // Background sync — never blocks the grid; re-renders when new content lands.
  if (await shouldSync(id)) {
    syncLibrary(id, { onProgress: (p) => loading.setStep(p.label || '') })
      .then(async (r) => {
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
  $('profile-chip').addEventListener('click', backToProfiles);
  $('create-back').addEventListener('click', backToProfiles);
  $('create-save').addEventListener('click', createNewProfile);
  $('delete-profile').addEventListener('click', deleteCurrentProfile);
  $('parent-gate-btn').addEventListener('click', openParentGate);

  $('pg-prev').addEventListener('click', () => { page -= 1; renderHome(); });
  $('pg-next').addEventListener('click', () => { page += 1; renderHome(); });
  $('exit-btn').addEventListener('click', askExit);
  $('folder-back').addEventListener('click', () => { if (!nav.back()) goGallery(); });

  $('watch-home').addEventListener('click', goGallery);
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
  $('pin-cancel').addEventListener('click', goGallery);

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
        const err = lastAuthError() || '';
        msg.textContent =
          /auth-unavailable:10\b/.test(err)
            ? 'האפליקציה לא רשומה ב-Google Cloud — השלימו את צעדים 3-4 במדריך GOOGLE_CLOUD_SETUP.md (ודאו שה-SHA-1 של גרסת ה-release רשום)'
            : /auth-unavailable/.test(err)
              ? `שירותי Google לא זמינים במכשיר (${err})`
              : err === 'no-plugin'
                ? 'זמין באפליקציה המותקנת בלבד (לא בדפדפן)'
                : 'ההתחברות בוטלה';
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

  $('update-check').addEventListener('click', () => runUpdateCheck({ manual: true }));
  $('update-install').addEventListener('click', async () => {
    const msg = $('update-msg');
    const upd = await import('./update.js');
    const latest = JSON.parse((await import('./platform.js').then((p) => p.prefGet('update.latest'))) || 'null');
    if (!latest) return;
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

  // F12b: videos shared from the YouTube app (listener first, then drain — see share.js)
  initShareTarget({
    profileIdGetter: () => activeProfileId,
    onShareAdded: ({ pending }) => {
      if (!pending && nav.isActive('gallery')) renderHome();
    }
  });
  await loadActiveId();
  profiles = await getProfiles();

  if (profiles.length === 0) openCreateProfile();
  else { renderProfiles(); nav.reset('profiles'); }

  // F14 launch check — un-awaited, throttled, all paths caught. NEVER blocks startup.
  setTimeout(() => {
    import('./update.js')
      .then((u) => u.cleanupPendingApk().then(() => u.checkForUpdate({ silent: true })))
      .catch(() => {});
  }, 4000);
}

init();
