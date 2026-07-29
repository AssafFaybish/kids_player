// store.js — data model, YouTube helpers, profiles, and legacy persistence.
// The link classifiers moved to classify.js (pure, node-tested); they are re-exported
// here so existing imports keep working.
import { prefGet, prefSet, prefRemove, httpGetJson } from './platform.js';
import { classifyLink } from './classify.js';

export {
  extractYouTubeId, driveFileId, classifyLink, stripTimeHints,
  parseChannelRef, classifySourceRow, classifyFromSharedText
} from './classify.js';

const K_VIDEOS = 'videos';
const K_SOURCE = 'source';

/* ---------------- YouTube thumbnails + title ---------------- */
export function youtubeThumbCandidates(id) {
  // hqdefault FIRST: it exists for EVERY video (480×360, ~20KB; the 4:3 bars are
  // cropped by object-fit:cover). maxresdefault 404s for a huge share of videos —
  // starting there cost up to 15 wasted round trips per page (perf defect #3).
  return [
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/mqdefault.jpg`
  ];
}

export async function fetchYouTubeTitle(id) {
  try {
    const inner = encodeURIComponent(`https://www.youtube.com/watch?v=${id}`);
    const data = await httpGetJson(`https://www.youtube.com/oembed?url=${inner}&format=json`);
    return data && data.title ? data.title : null;
  } catch { return null; }
}

/* ---------------- Profiles ---------------- */
const K_PROFILES = 'profiles';
const K_ACTIVE = 'activeProfile';
const videosKey = (id) => 'videos:' + id;
const sourceKey = (id) => 'source:' + id;

let activeId = null; // in-memory mirror of K_ACTIVE

export function getActiveId() { return activeId; }
export async function loadActiveId() { activeId = await prefGet(K_ACTIVE); return activeId; }
export async function setActiveId(id) { activeId = id; await prefSet(K_ACTIVE, id); }

export async function getProfiles() {
  const raw = await prefGet(K_PROFILES);
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function saveProfiles(list) { await prefSet(K_PROFILES, JSON.stringify(list)); }

export async function getActiveProfile() {
  if (!activeId) return null;
  return (await getProfiles()).find((p) => p.id === activeId) || null;
}
export async function createProfile(name, avatar, color) {
  const list = await getProfiles();
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const profile = { id, name: (name || '').trim() || 'ילד/ה', avatar: avatar || '🙂', color: color || '#4ea1ff' };
  list.push(profile);
  await saveProfiles(list);
  return profile;
}
/**
 * PURE (node-tested): union of local + restored profile lists by id — local always
 * wins, remote entries are sanitized to the local profile shape.
 */
export function mergeProfileLists(local, remote) {
  const list = (local || []).slice();
  const have = new Set(list.map((p) => p.id));
  let added = 0;
  for (const p of remote || []) {
    if (!p || !p.id || have.has(p.id)) continue;
    list.push({ id: p.id, name: p.name || 'ילד/ה', avatar: p.avatar || '🙂', color: p.color || '#4ea1ff' });
    have.add(p.id);
    added += 1;
  }
  return { list, added };
}

/**
 * Merge profiles restored from a Drive backup into the local list (v1.0.4 first-launch
 * connect). Returns how many were added.
 */
export async function mergeRestoredProfiles(remote) {
  const { list, added } = mergeProfileLists(await getProfiles(), remote);
  if (added) await saveProfiles(list);
  return added;
}

export async function deleteProfile(id) {
  await saveProfiles((await getProfiles()).filter((p) => p.id !== id));
  await prefRemove(videosKey(id));
  await prefRemove(sourceKey(id));
  if (activeId === id) { activeId = null; await prefRemove(K_ACTIVE); }
}

// One-time migration: fold any pre-profiles list into a default profile so nothing is lost.
export async function migrateLegacyIfNeeded() {
  if ((await getProfiles()).length > 0) return;
  const legacyVideos = await prefGet(K_VIDEOS);
  const legacySource = await prefGet(K_SOURCE);
  if (!legacyVideos && !legacySource) return;
  const p = await createProfile('שלי', '🦁', '#ffd166');
  if (legacyVideos) await prefSet(videosKey(p.id), legacyVideos);
  if (legacySource) await prefSet(sourceKey(p.id), legacySource);
  await setActiveId(p.id);
  await prefRemove(K_VIDEOS);
  await prefRemove(K_SOURCE);
}

/* ---------------- Persistence (scoped to the active profile) ---------------- */
export async function loadItems() {
  if (!activeId) return [];
  const raw = await prefGet(videosKey(activeId));
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}
export async function saveItems(items) {
  if (!activeId) return;
  await prefSet(videosKey(activeId), JSON.stringify(items));
}
export async function getSource() {
  if (!activeId) return { mode: 'manual', url: '' };
  const raw = await prefGet(sourceKey(activeId));
  if (!raw) return { mode: 'manual', url: '' };
  try { const s = JSON.parse(raw); return { mode: s.mode || 'manual', url: s.url || '' }; }
  catch { return { mode: 'manual', url: '' }; }
}
export async function setSource(src) {
  if (!activeId) return;
  await prefSet(sourceKey(activeId), JSON.stringify({ mode: src.mode || 'manual', url: src.url || '' }));
}

/* ---------------- CRUD (manual mode) ---------------- */
export async function addManualLink(raw, extra = {}) {
  const c = classifyLink(raw);
  if (!c) return { ok: false, error: 'invalid' };

  const items = await loadItems();
  if (items.some((i) => i.key === c.key)) return { ok: false, error: 'duplicate' };

  const item = { ...c, addedAt: Date.now(), title: extra.title || '', thumb: extra.thumb || null };
  if (c.type === 'youtube' && !item.title) {
    item.title = (await fetchYouTubeTitle(c.id)) || '';
  }
  items.push(item);
  await saveItems(items);
  return { ok: true, item };
}

export async function deleteItem(key) {
  const items = await loadItems();
  await saveItems(items.filter((i) => i.key !== key));
}

export async function setItemLocalPath(key, localPath) {
  const items = await loadItems();
  const it = items.find((i) => i.key === key);
  if (it) { it.localPath = localPath; await saveItems(items); }
}

/* ---------------- Display ordering ---------------- */
// Manual mode: newest-added first. Remote mode: keep stored order (= file order).
export function listForDisplay(items, source) {
  if (source && source.mode === 'remote') return items.slice();
  return items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/* ---------------- Export / import ---------------- */
export async function exportJson() {
  return JSON.stringify(await loadItems(), null, 2);
}
export async function importJson(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('bad-format');
  await saveItems(arr);
}
