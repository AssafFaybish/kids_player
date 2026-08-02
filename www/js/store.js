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
/**
 * PURE (node-tested, v1.0.8): does a profile with this name already exist?
 * Compared after trimming + whitespace-collapse — "דני" and " דני " are the same
 * child; two profiles with the same display name are indistinguishable on screen.
 */
export function profileNameExists(list, name) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const n = norm(name);
  if (!n) return false;
  return (list || []).some((p) => p && norm(p.name) === n);
}

/**
 * v1.0.22 — PURE: WHERE does this name already exist? `'local'` | `'remote'` | `null`.
 *
 * Two devices on the same Google account could both create "נועם": `createProfile` mints
 * the id LOCALLY (`Date.now()` + random), and both merge paths union by ID
 * (`mergeProfileLists` here, `mergeDbFiles` in drive.js) — the name is never compared. So
 * the duplicate survived, and the damage is not cosmetic: `profileVideoState` is keyed by
 * profileId (so the child's 🎁 progress SPLITS — a video opened on one is still a gift on
 * the other), `prof:<id>` splits their personal videos, and a sheet-less profile gets
 * `lib:p:<profileId>`, i.e. two separate libraries for one child. On screen the parent just
 * sees two identical avatars with the same name.
 *
 * The distinction matters only for the MESSAGE: after a Drive pull the other device's
 * profiles are already local (pullDrive → mergeRestoredProfiles), so the caller passes the
 * list it had BEFORE the pull to tell "you already have this" from "another device does".
 */
export function profileNameConflict(localBefore, merged, name) {
  if (!profileNameExists(merged, name)) return null;
  return profileNameExists(localBefore, name) ? 'local' : 'remote';
}

/**
 * v1.0.22 — PURE: names shared by more than one profile, for the parent screen.
 *
 * Blocking at creation cannot close this completely: with no server there is no
 * coordination point, so two devices both offline can each mint "נועם" and only meet
 * later. At THAT moment there is nothing left to block — the profile exists on both sides.
 * Merging them would be irreversible (gift state, scopes) and renaming behind the parent's
 * back is worse, so the collision is reported and the parent decides.
 * -> [{ name, ids: [...] }], only for names with 2+ profiles.
 */
export function duplicateProfileNames(list) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const byName = new Map();
  for (const p of list || []) {
    if (!p || !p.id) continue;
    const n = norm(p.name);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p.id);
  }
  return [...byName.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }));
}

/**
 * v1.0.26 — PURE: the stored form of a profile name. Raised from 12 to 20 characters.
 *
 * **THE LIMIT USED TO EXIST ONLY AS `maxlength` ON THE INPUT** — a DOM attribute that no
 * test can see and that binds exactly one caller. Every other way a profile is born
 * (a future caller, a restored list, a peer's document) was unbounded, and the profile
 * TILE is the one place a name is rendered at full length, so an absurd name is the one
 * that reshapes the picker. The cap belongs next to the write, where it is testable;
 * `invariants.test.mjs` pins the input's attribute to `PROFILE_NAME_MAX` so the two
 * cannot drift.
 *
 * Sliced by CODE POINT, not by `.length`: "נועם 🦁" is a plausible name and a UTF-16 cut
 * lands in the middle of the surrogate pair, storing a replacement character forever.
 * Trimmed again afterwards, because the cut itself can leave a trailing space.
 */
export const PROFILE_NAME_MAX = 20;

export function normalizeProfileName(name) {
  const collapsed = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  const capped = [...collapsed].slice(0, PROFILE_NAME_MAX).join('').trim();
  return capped || 'ילד/ה';
}

export async function createProfile(name, avatar, color) {
  const list = await getProfiles();
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const profile = { id, name: normalizeProfileName(name), avatar: avatar || '🙂', color: color || '#4ea1ff' };
  list.push(profile);
  await saveProfiles(list);
  return profile;
}
/**
 * PURE (node-tested): union of local + restored profile lists by id — local always
 * wins, remote entries are sanitized to the local profile shape.
 */
export function mergeProfileLists(local, remote, deleted = null) {
  const gone = deleted instanceof Set ? deleted : new Set(Object.keys(deleted || {}));
  // A deleted profile must not walk back in from a peer's document. Nothing filtered the
  // remote list before, so "delete נועם" on the tablet lasted exactly until the next pull
  // — and the confirm dialog says the action cannot be undone.
  const list = (local || []).filter((p) => p && !gone.has(p.id));
  const have = new Set(list.map((p) => p.id));
  let added = 0;
  for (const p of remote || []) {
    if (!p || !p.id || have.has(p.id) || gone.has(p.id)) continue;
    list.push({ id: p.id, name: p.name || 'ילד/ה', avatar: p.avatar || '🙂', color: p.color || '#4ea1ff' });
    have.add(p.id);
    added += 1;
  }
  return { list, added };
}

/* ---------------- Deleted-profile tombstones ----------------
 * A GROW-ONLY set of `{ profileId: deletedAt }`, the same shape of answer the video
 * deny-list gives: a deletion is a fact that has to travel, or every other device
 * re-creates what the parent removed. Grow-only is safe here where the deny-list needed
 * revocation, because a profile id is minted randomly at creation and never reused — the
 * "the sheet re-added it" case simply cannot arise.
 */
const K_DELETED = 'profilesDeleted';

export async function getDeletedProfiles() {
  try {
    const raw = JSON.parse((await prefGet(K_DELETED)) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

export async function markProfileDeleted(id, at = Date.now()) {
  if (!id) return;
  const all = await getDeletedProfiles();
  if (!all[id]) all[id] = at;   // keep the FIRST deletion time; it is the one peers saw
  await prefSet(K_DELETED, JSON.stringify(all));
}

/** Whole-map write, used by the Drive apply path (it carries real timestamps already). */
export async function putDeletedProfiles(map) {
  await prefSet(K_DELETED, JSON.stringify(map && typeof map === 'object' ? map : {}));
}

/** PURE: union of two tombstone maps. Earliest timestamp wins, so it is order-free. */
export function mergeDeletedProfiles(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, at] of Object.entries(src || {})) {
      const t = Number(at) || 0;
      out[id] = id in out ? Math.min(out[id], t) : t;
    }
  }
  return out;
}

/**
 * Merge profiles restored from a Drive backup into the local list (v1.0.4 first-launch
 * connect). Returns how many were added.
 */
export async function mergeRestoredProfiles(remote) {
  const before = await getProfiles();
  const { list, added } = mergeProfileLists(before, remote, await getDeletedProfiles());
  // `added` alone is no longer enough to decide whether to write: the tombstone filter can
  // REMOVE a local entry (a peer deleted a profile and we just learned about it), and that
  // has to be persisted too.
  if (added || list.length !== before.length) await saveProfiles(list);
  return added;
}

export async function deleteProfile(id) {
  await saveProfiles((await getProfiles()).filter((p) => p.id !== id));
  // The tombstone is what makes the deletion stick. Without it the next Drive pull unions
  // the profile straight back in — the parent deletes a child, and it reappears.
  await markProfileDeleted(id);
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
