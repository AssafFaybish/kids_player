// app.js — boot, global wiring, and (until the view split completes) the gallery,
// PIN and parent screens. Navigation goes through nav.js; dialogs through ui/modal.js.
import {
  loadItems, saveItems, getSource, setSource, listForDisplay,
  addManualLink, deleteItem, exportJson, importJson, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId, fetchYouTubeTitle
} from './store.js';
import * as wake from './wake.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { playItem, stop } from './player.js';
import { syncFromRemote } from './sync.js';
import { clearCache } from './media.js';
import { onAppResume, onBackButton, exitApp } from './platform.js';
import { runMigrationIfNeeded } from './migrate.js';
import { PAGE_VIDEOS, AVATARS } from './config.js';
import { confirmKid, alertKid, mountModal } from './ui/modal.js';
import * as nav from './nav.js';

const PAGE_SIZE = PAGE_VIDEOS;
const $ = (id) => document.getElementById(id);

const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">' +
  '<rect width="320" height="180" fill="#d8d5f0"/>' +
  '<circle cx="160" cy="90" r="42" fill="#8a84c8"/>' +
  '<polygon points="146,68 146,112 184,90" fill="#fff"/></svg>'
);

let items = [];
let source = { mode: 'manual', url: '' };
let page = 0;
let currentWatch = null;
let profiles = [];
let createSel = null;

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
  renderGallery();
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
  nav.register('gallery', { onBack: () => { askExit(); return true; } });
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
}

/* ---------------- Gallery ---------------- */
function setThumb(img, item) {
  const chain = [];
  if (item.thumb) chain.push(item.thumb);
  if (item.type === 'youtube') chain.push(...youtubeThumbCandidates(item.id));
  chain.push(PLACEHOLDER);
  let i = 0;
  const tryNext = () => { img.src = chain[Math.min(i, chain.length - 1)]; };
  img.onerror = () => { i += 1; if (i < chain.length) tryNext(); else img.onerror = null; };
  tryNext();
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
  btn.addEventListener('click', () => openWatch(item));
  return btn;
}

function renderGallery() {
  const list = listForDisplay(items, source);
  const total = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page >= total) page = total - 1;
  if (page < 0) page = 0;

  const grid = $('grid');
  grid.innerHTML = '';
  const empty = list.length === 0;
  $('empty-state').classList.toggle('hidden', !empty);
  grid.classList.toggle('hidden', empty);

  for (const it of list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    grid.appendChild(tileEl(it));
  }

  const pager = $('pager');
  if (list.length > PAGE_SIZE) {
    pager.classList.remove('hidden');
    $('pg-info').textContent = `${page + 1} / ${total}`;
    $('pg-prev').disabled = page === 0;
    $('pg-next').disabled = page >= total - 1;
  } else {
    pager.classList.add('hidden');
  }
}

/* ---------------- Watch ---------------- */
function renderWatchGrid(current) {
  const grid = $('watch-grid');
  grid.innerHTML = '';
  for (const it of listForDisplay(items, source)) {
    if (it.key === current.key) continue;
    grid.appendChild(tileEl(it));
  }
}

async function openWatch(item) {
  currentWatch = item;
  // replace() when already watching: back always returns to the gallery, never
  // through the chain of watched videos. nav scrolls to top — the F4 fix: the
  // user actually SEES the player instead of staying scrolled at the grid.
  if (nav.isActive('watch')) nav.replace('watch', { key: item.key });
  else nav.go('watch', { key: item.key });
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
    onThumb: (data) => persistThumb(item.key, data)
  });
}

async function persistThumb(key, data) {
  const arr = await loadItems();
  const it = arr.find((i) => i.key === key);
  if (it && !it.thumb) { it.thumb = data; await saveItems(arr); items = arr; }
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
      if (t) { el.textContent = t; persistTitle(item.key, t); }
      else { el.textContent = ''; el.classList.add('hidden'); }
    });
  }
}

async function persistTitle(key, title) {
  const arr = await loadItems();
  const it = arr.find((i) => i.key === key);
  if (it && !it.title) { it.title = title; await saveItems(arr); items = arr; }
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

/* ---------------- Parent screen ---------------- */
function enterParent() { refreshParent(); nav.replace('parent'); } // replaces 'pin' on the stack

function setModeUI(mode) {
  $('mode-manual').classList.toggle('active', mode === 'manual');
  $('mode-remote').classList.toggle('active', mode === 'remote');
  $('panel-manual').classList.toggle('hidden', mode !== 'manual');
  $('panel-remote').classList.toggle('hidden', mode !== 'remote');
}
async function setMode(mode) {
  source = { ...source, mode };
  await setSource(source);
  setModeUI(mode);
  renderGallery();
}
function refreshParent() {
  $('remote-url').value = source.url || '';
  setModeUI(source.mode);
  refreshParentList();
  $('add-msg').textContent = '';
  $('remote-status').textContent = '';
}
function refreshParentList() {
  const list = listForDisplay(items, source);
  $('list-count').textContent = `${list.length} סרטונים`;
  const ul = $('parent-list');
  ul.innerHTML = '';
  for (const it of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.className = 'li-thumb';
    setThumb(img, it);
    const body = document.createElement('div');
    body.className = 'li-body';
    const title = document.createElement('div');
    title.className = 'li-title';
    title.innerHTML = (it.title ? escapeHtml(it.title) : '(ללא שם)') +
      `<span class="badge-type ${it.type === 'youtube' ? 'badge-yt' : 'badge-file'}">` +
      (it.type === 'youtube' ? 'YouTube' : 'קובץ') + '</span>';
    const sub = document.createElement('div');
    sub.className = 'li-sub';
    sub.textContent = it.srcUrl || it.url || '';
    body.appendChild(title); body.appendChild(sub);
    const del = document.createElement('button');
    del.className = 'li-del'; del.type = 'button'; del.textContent = '🗑️';
    del.addEventListener('click', async () => {
      await deleteItem(it.key);
      items = await loadItems();
      refreshParentList();
      renderGallery();
    });
    li.appendChild(img); li.appendChild(body); li.appendChild(del);
    ul.appendChild(li);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function doSyncAndRefresh() {
  const status = $('remote-status');
  status.textContent = 'טוען…'; status.className = 'form-msg';
  const res = await syncFromRemote();
  if (res.skipped) { status.textContent = ''; return; }
  if (res.ok && res.count > 0) { status.textContent = `עודכן: ${res.count} סרטונים`; status.className = 'form-msg ok'; }
  else if (res.ok) {
    status.textContent = 'לא נמצאו לינקים. ודאו שזה Google Sheet משותף לצפייה (לא קובץ Excel/xlsx), ושבכל שורה יש לינק.';
    status.className = 'form-msg err';
  } else { status.textContent = 'שגיאה בטעינת הקובץ: ' + (res.error || ''); status.className = 'form-msg err'; }
  items = await loadItems();
  refreshParentList();
  renderGallery();
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
  source = await getSource();
  items = await loadItems();
  page = 0;
  if (source.mode === 'remote') {
    const r = await syncFromRemote();
    if (r && r.ok) items = await loadItems();
  }
  await updateProfileChip();
  renderGallery();
  nav.reset('gallery');
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

  $('pg-prev').addEventListener('click', () => { page -= 1; renderGallery(); });
  $('pg-next').addEventListener('click', () => { page += 1; renderGallery(); });

  $('watch-home').addEventListener('click', goGallery);
  $('ctl-fs').addEventListener('click', () => {
    const el = $('player-wrap');
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  });

  document.querySelector('.keypad').addEventListener('click', (e) => {
    const b = e.target.closest('.key'); if (!b || !b.dataset.k) return;
    onKey(b.dataset.k);
  });
  $('pin-cancel').addEventListener('click', goGallery);

  $('mode-manual').addEventListener('click', () => setMode('manual'));
  $('mode-remote').addEventListener('click', () => setMode('remote'));

  $('add-btn').addEventListener('click', async () => {
    const url = $('add-url').value.trim();
    const msg = $('add-msg');
    if (!url) { msg.textContent = 'הדביקו קודם לינק'; msg.className = 'form-msg err'; return; }
    msg.textContent = 'מוסיף…'; msg.className = 'form-msg';
    const res = await addManualLink(url, { title: $('add-title').value.trim(), thumb: $('add-thumb').value.trim() });
    if (res.ok) {
      $('add-url').value = ''; $('add-title').value = ''; $('add-thumb').value = '';
      msg.textContent = 'נוסף! ✅'; msg.className = 'form-msg ok';
      items = await loadItems(); refreshParentList(); renderGallery();
    } else {
      msg.textContent = res.error === 'duplicate' ? 'הסרטון כבר קיים ברשימה'
        : 'הלינק לא נתמך (רק YouTube או קובץ וידאו mp4)';
      msg.className = 'form-msg err';
    }
  });

  $('export-btn').addEventListener('click', async () => {
    const json = await exportJson();
    const msg = $('add-msg');
    try { await navigator.clipboard.writeText(json); msg.textContent = 'הרשימה הועתקה ללוח'; msg.className = 'form-msg ok'; }
    catch { window.prompt('העתיקו את הרשימה:', json); }
  });
  $('import-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const msg = $('add-msg');
    try {
      await importJson(await f.text());
      items = await loadItems(); refreshParentList(); renderGallery();
      msg.textContent = 'יובא בהצלחה ✅'; msg.className = 'form-msg ok';
    } catch { msg.textContent = 'קובץ לא תקין'; msg.className = 'form-msg err'; }
    e.target.value = '';
  });

  $('remote-save').addEventListener('click', async () => {
    source = { mode: 'remote', url: $('remote-url').value.trim() };
    await setSource(source);
    setModeUI('remote');
    await doSyncAndRefresh();
  });
  $('remote-refresh').addEventListener('click', doSyncAndRefresh);
  $('remote-clear').addEventListener('click', async () => {
    source = { mode: 'manual', url: '' };
    await setSource(source);
    $('remote-url').value = '';
    setModeUI('manual');
    $('remote-status').textContent = 'נותק. עברת לרשימה ידנית.';
    $('remote-status').className = 'form-msg';
    renderGallery();
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
    if (getActiveId() && source.mode === 'remote' && isGalleryActive()) {
      await syncFromRemote();
      items = await loadItems();
      renderGallery();
    }
  });

  await migrateLegacyIfNeeded();
  // Preferences → IndexedDB (idempotent, resumable, non-destructive). The views still
  // read from Preferences until the folder views land; this warms the new store early.
  try { await runMigrationIfNeeded(); } catch (e) { console.warn('idb migration failed', e); }
  await loadActiveId();
  profiles = await getProfiles();

  if (profiles.length === 0) openCreateProfile();
  else { renderProfiles(); nav.reset('profiles'); }
}

init();
