// app.js — view routing, kids gallery + pagination, hidden parent gesture, PIN UI, parent screen.
import {
  loadItems, saveItems, getSource, setSource, listForDisplay,
  addManualLink, deleteItem, exportJson, importJson, youtubeThumbCandidates,
  getProfiles, getActiveId, getActiveProfile, createProfile, deleteProfile,
  migrateLegacyIfNeeded, loadActiveId, setActiveId
} from './store.js';
import { hasPin, setPin, verifyPin, clearPin } from './pin.js';
import { playItem, stop } from './player.js';
import { syncFromRemote } from './sync.js';
import { clearCache } from './media.js';
import { onAppResume } from './platform.js';

const PAGE_SIZE = 15;
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

/* ---------------- Views ---------------- */
function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  $('view-' + name).classList.add('active');
}
const isGalleryActive = () => $('view-gallery').classList.contains('active');

function goGallery() {
  showView('gallery');
  stop();
  currentWatch = null;
  renderGallery();
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
  showView('watch');
  const status = $('watch-status');
  status.classList.add('hidden');
  status.textContent = '';
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
  showView('pin');
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
function enterParent() { refreshParent(); showView('parent'); }

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
const AVATARS = [
  { e: '🦁', c: '#ffd166' }, { e: '🐼', c: '#cdd6ea' }, { e: '🐰', c: '#ffc9de' },
  { e: '🦊', c: '#ffb37a' }, { e: '🐸', c: '#b8e994' }, { e: '🐵', c: '#e6c79c' },
  { e: '🐯', c: '#ffcf6b' }, { e: '🦄', c: '#e4c1f9' }, { e: '🐙', c: '#ff9aa2' },
  { e: '🐧', c: '#a0c4ff' }, { e: '🐨', c: '#d7d7d7' }, { e: '🐬', c: '#8fd0e0' }
];

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
  showView('create-profile');
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
  showView('gallery');
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
  showView('profiles');
}

async function deleteCurrentProfile() {
  const p = await getActiveProfile();
  if (!p) return;
  if (!window.confirm(`למחוק את הפרופיל "${p.name}" ואת כל הסרטונים שלו? פעולה זו אינה הפיכה.`)) return;
  await deleteProfile(p.id);
  items = [];
  source = { mode: 'manual', url: '' };
  profiles = await getProfiles();
  if (profiles.length > 0) { renderProfiles(); showView('profiles'); }
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
    window.alert(n > 0
      ? `נמחקו ${n} קבצי וידאו שהורדו למכשיר (פינוי מקום). הרשימה עצמה נשמרת.`
      : 'אין קבצי וידאו שהורדו למחיקה. (הורדה מתבצעת רק באפליקציה המותקנת, ורק לקובץ mp4 שההזרמה שלו נכשלה.)');
  });
  $('reset-pin').addEventListener('click', async () => {
    if (!window.confirm('לאפס את קוד ההורים? תתבקשו להגדיר קוד חדש בכניסה הבאה.')) return;
    await clearPin();
    goGallery();
  });
}

/* ---------------- Init ---------------- */
async function init() {
  wire();

  onAppResume(async () => {
    if (getActiveId() && source.mode === 'remote' && isGalleryActive()) {
      await syncFromRemote();
      items = await loadItems();
      renderGallery();
    }
  });

  await migrateLegacyIfNeeded();
  await loadActiveId();
  profiles = await getProfiles();

  if (profiles.length === 0) openCreateProfile();
  else { renderProfiles(); showView('profiles'); }
}

init();
