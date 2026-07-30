// sheetwrite.js — write-back to the parent's Google Sheet (v1.0.6): the sheet is the
// single human-readable master list, so manual adds, manually-added channels and
// approved shares are APPENDED to it as rows.
//
// Design rules:
//  - Local state is written FIRST and never blocks on the network: rows go into a
//    durable queue (meta store) and are flushed opportunistically (after sync, after
//    adds) with a NON-interactive token — no consent UI ever pops mid-flow.
//  - Requires the signed-in Google account to have EDIT permission on the sheet and
//    the extra `spreadsheets` OAuth scope (GoogleAuthPlugin; one-time re-consent).
//  - Published links (docs.google.com/spreadsheets/d/e/…) carry an opaque token, NOT
//    the spreadsheet id — writing is impossible; surfaced as a parent-facing state.
//  - Appends target the SAME tab the app reads: the gid in the sheet URL is resolved
//    to the tab's title via spreadsheets.get (A1 ranges address tabs by title only).

import { httpRequest } from './platform.js';
import { getAccessToken } from './gauth.js';
import { getMeta, putMeta, getSources } from './db.js';
import { classifySourceRow } from './classify.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const QUEUE_CAP = 200;

/**
 * v1.0.19 — every sheet the app creates lives in ONE visible Drive folder, so a
 * parent can find their lists instead of hunting a bare file in Drive root.
 *
 * The Drive DB (kids-player-db.json) deliberately stays OUT of this folder: the
 * folder is the thing a parent is likely to share with a partner, and sharing it
 * would hand over the database — profiles, child names, the whole library.
 * Per-file sharing is safe; folder sharing is not.
 */
export const SHEETS_FOLDER_NAME = 'רשימת השמעה לאפליקציה הסרטונים שלי';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * The folder's id, creating it on first use. Under `drive.file` a files.list only
 * ever returns files THIS app created, so searching by name cannot collide with
 * something of the parent's — and if they delete the folder we simply make a new
 * one. Returns null on any failure; callers must treat the folder as optional
 * (a sheet in Drive root still works).
 */
export async function ensureSheetsFolder(token) {
  if (!token) return null;
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  try {
    const q = encodeURIComponent(
      `mimeType='${FOLDER_MIME}' and name='${SHEETS_FOLDER_NAME.replace(/'/g, "\\'")}' and trashed=false`
    );
    const found = await httpRequest({
      url: `${DRIVE}/files?q=${q}&spaces=drive&fields=files(id,name)`,
      headers: { Authorization: 'Bearer ' + token }, responseType: 'json'
    });
    if (found.status === 200 && found.data) {
      const d = typeof found.data === 'string' ? JSON.parse(found.data) : found.data;
      const hit = (d.files || [])[0];
      if (hit && hit.id) return hit.id;
    }
    const made = await httpRequest({
      method: 'POST', url: `${DRIVE}/files?fields=id`, headers: auth,
      body: JSON.stringify({ name: SHEETS_FOLDER_NAME, mimeType: FOLDER_MIME }),
      responseType: 'json'
    });
    if (made.status !== 200 || !made.data) return null;
    const md = typeof made.data === 'string' ? JSON.parse(made.data) : made.data;
    return md.id || null;
  } catch { return null; }
}

/* ---------------- pure (node-tested) ---------------- */

/** Spreadsheet id from a normal Sheets link; null for published /d/e/ links & garbage. */
export function extractSpreadsheetId(url) {
  const m = String(url || '').match(/docs\.google\.com\/spreadsheets\/d\/(?!e\/)([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** The gid (tab id) named in the sheet URL; 0 (the original first tab) when absent. */
export function extractGid(url) {
  const m = String(url || '').match(/[#?&]gid=([0-9]+)/);
  return m ? +m[1] : 0;
}

/** One sheet row, in the app's own column convention: A=link, B=title, C=flag. */
export function buildSheetRow({ srcUrl, title = '', flag = '' }) {
  return [String(srcUrl || ''), String(title || ''), String(flag || '')];
}

/**
 * v1.0.12 — the removal row for a video INSIDE a channel (it has no row of its own).
 * Comment form: older app versions skip it; new ones read it as "deny this key".
 * The title rides along so a human scanning the sheet sees what was removed.
 */
export function buildRemovalRow({ srcUrl, title = '' }) {
  const note = `# הוסר: ${String(srcUrl || '')}${title ? ' — ' + String(title) : ''}`;
  return [note, '', ''];
}

const qKey = (lib) => 'sheetq:' + lib;
const stateKey = (lib) => 'sheetqState:' + lib;

/* ---------------- pure: typed ops (v1.0.10 — deletions too) ---------------- */

/** Queue entries from before v1.0.10 were bare appends — normalize them. */
export function normalizeOps(queue) {
  return (queue || []).map((e) => (e && !e.op ? { ...e, op: 'append' } : e)).filter(Boolean);
}

/** One identity per sheet entity: a video key, or ch:<channelId>. */
const opIdentity = (o) => (o.op === 'delchannel' ? 'ch:' + o.channelId : o.key);

/**
 * The LATEST intent per identity wins: an add followed by a delete (or the other
 * way around) collapses to whichever the parent did last — the sheet never sees
 * the superseded operation.
 */
export function reconcileOps(queue) {
  const latest = new Map();
  for (const o of normalizeOps(queue)) {
    const id = opIdentity(o);
    const cur = latest.get(id);
    if (!cur || (o.at || 0) >= (cur.at || 0)) latest.set(id, o);
  }
  return [...latest.values()];
}

/**
 * Which 0-based sheet rows should be removed for these delete-ops?
 * Video rows match by CLASSIFIED key (URL variants of the same video all match);
 * channel rows match by resolved channel id — @handles resolve through the
 * handleMap cache that sync populated when the channel was first subscribed.
 * -> indices sorted DESCENDING (delete bottom-up so indices stay valid).
 */
export function matchRowsForDeletion(colA, ops, handleMap = {}) {
  const deletes = ops.filter((o) => o.op === 'delvideo' || o.op === 'delchannel');
  if (!deletes.length) return [];
  const wantVideo = new Set(deletes.filter((o) => o.op === 'delvideo').map((o) => o.key));
  const wantChannel = new Set(deletes.filter((o) => o.op === 'delchannel').map((o) => o.channelId));
  const out = [];
  (colA || []).forEach((raw, i) => {
    const row = classifySourceRow(raw);
    if (row.kind === 'video' && wantVideo.has(row.key)) out.push(i);
    else if (row.kind === 'channel') {
      const ref = row.channelRef;
      const id = ref.by === 'id' ? ref.value : handleMap[ref.by + ':' + String(ref.value).toLowerCase()];
      if (id && wantChannel.has(id)) out.push(i);
    }
  });
  return out.sort((a, b) => b - a);
}

/* ---------------- queue ---------------- */

async function enqueueOp(profileId, op, { flush = true } = {}) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, noSheet: true };
  // v1.0.18: RECONCILE BEFORE CAPPING. `slice(-QUEUE_CAP)` drops the HEAD, so an
  // offline bulk cleanup silently discarded the oldest ops — a dropped delvideo
  // leaves the row in the sheet, the next mirror pass reads that as presence and
  // revokes the tombstone, and the deleted video comes back on every device.
  // Reconciling first collapses per entity, so only 200 DISTINCT entities overflow.
  const q = reconcileOps([...normalizeOps((await getMeta(qKey(src.libraryId))) || []), { ...op, at: Date.now() }]);
  const kept = q.slice(-QUEUE_CAP);
  await putMeta(qKey(src.libraryId), kept);
  // Overflow is data loss, not a queue detail — say so instead of dropping quietly.
  await patchState(src.libraryId, {
    pending: kept.length,
    ...(q.length > QUEUE_CAP ? { error: 'queue-overflow' } : {})
  });
  return flush ? flushSheetQueue(profileId) : { ok: true, queued: true };
}

/**
 * Enqueue one APPEND for the profile's sheet and try flushing. Idempotent twice
 * over: reconcileOps keeps the latest intent per key, and the flush skips appends
 * whose key already exists in the sheet.
 */
export function enqueueSheetRow(profileId, { key, srcUrl, title = '', flag = '' }, opts = {}) {
  return enqueueOp(profileId, { op: 'append', key, row: buildSheetRow({ srcUrl, title, flag }) }, opts);
}

/** v1.0.10: queue the removal of a VIDEO row (matched by classified key). */
export function enqueueSheetVideoDelete(profileId, key) {
  return enqueueOp(profileId, { op: 'delvideo', key });
}

/**
 * v1.0.12: queue a REMOVAL ROW for a channel video (no row of its own to delete).
 * Keyed 'rm:<videoKey>' so reconcileOps and the sheet-presence dedupe treat it as
 * its own identity — appending it twice is impossible.
 */
export function enqueueSheetRemovalRow(profileId, { key, srcUrl, title = '' }) {
  const row = buildRemovalRow({ srcUrl, title });
  // Never write a DEAD row: the note must parse back to exactly this key, or the
  // sheet would carry a removal nobody can act on (e.g. a record with no usable link).
  const back = classifySourceRow(row[0]);
  if (!back || back.kind !== 'removed' || back.key !== key) {
    return Promise.resolve({ ok: false, error: 'unrepresentable' });
  }
  return enqueueOp(profileId, { op: 'append', key: 'rm:' + key, row });
}

/** v1.0.10: queue the removal of a CHANNEL row (matched by resolved channel id). */
export function enqueueSheetChannelDelete(profileId, channelId) {
  return enqueueOp(profileId, { op: 'delchannel', channelId });
}

/**
 * Channel ids with a queued-but-unflushed delete — sync must NOT re-subscribe them
 * from the still-present sheet row (this closed the "deleted channel comes back"
 * bug even before the row removal lands).
 */
export async function pendingChannelDeletes(libraryId) {
  if (!libraryId) return new Set();
  const q = reconcileOps((await getMeta(qKey(libraryId))) || []);
  return new Set(q.filter((o) => o.op === 'delchannel').map((o) => o.channelId));
}

/** Video keys queued for APPEND but not yet flushed — mirror treats them as lag. */
export async function pendingAppendKeys(libraryId) {
  if (!libraryId) return [];
  const q = reconcileOps((await getMeta(qKey(libraryId))) || []);
  return q.filter((o) => o.op === 'append').map((o) => o.key);
}

/** Identities queued for REMOVAL ('yt:…' / 'ch:<id>') — their sheet presence is lag,
    so the mirror must not treat them as deliberate re-adds (no unDeny). */
export async function pendingDeleteKeys(libraryId) {
  if (!libraryId) return [];
  const q = reconcileOps((await getMeta(qKey(libraryId))) || []);
  return q.filter((o) => o.op === 'delvideo' || o.op === 'delchannel')
    .map((o) => (o.op === 'delchannel' ? 'ch:' + o.channelId : o.key));
}

/** Rows waiting + last error — the parent sources tab renders this. */
export async function sheetWriteState(libraryId) {
  if (!libraryId) return null;
  return (await getMeta(stateKey(libraryId))) || null;
}

async function patchState(lib, patch) {
  const cur = (await getMeta(stateKey(lib))) || {};
  await putMeta(stateKey(lib), { ...cur, ...patch, at: Date.now() });
}

/* ---------------- create a fresh source sheet (v1.0.8 wizard) ---------------- */

/** PURE: the welcome row of a new sheet — a # comment (the parser skips it, humans read it). */
export function starterRows() {
  return [[
    '# ברוכים הבאים! כל שורה = סרטון או ערוץ. עמודה A: לינק (סרטון יוטיוב / ערוץ / @שם). עמודה B: שם לתצוגה (לא חובה). עמודה C בשורת ערוץ: auto או manual',
    '', ''
  ]];
}

/** PURE: does this look like a connectable Google Sheets link? */
export function isSheetsUrl(url) {
  return /docs\.google\.com\/spreadsheets\//.test(String(url || ''));
}

/** PURE (v1.0.12): the name of a sheet created for a profile — "<שם>_רשימת סרטונים". */
export function sheetNameFor(profileName) {
  const name = String(profileName || '').replace(/\s+/g, ' ').trim() || 'ילד/ה';
  return `${name}_רשימת סרטונים`;
}

/**
 * Create a new source sheet in the signed-in parent's Drive: title → spreadsheet,
 * welcome comment row, and "anyone with the link can VIEW" permission — the app
 * reads sheets via their public CSV export, so a private sheet would sync nothing.
 * Uses the existing spreadsheets + drive.file scopes (drive.file may manage
 * permissions of files the app itself created).
 */
export async function createSourceSheet(title) {
  const token = await getAccessToken({ interactive: true });
  if (!token) return { ok: false, error: 'no-token' };
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  const created = await httpRequest({
    method: 'POST', url: SHEETS, headers: auth,
    body: JSON.stringify({ properties: { title } }), responseType: 'json'
  });
  if (created.status !== 200 || !created.data) return { ok: false, error: 'create-http-' + created.status };
  const data = typeof created.data === 'string' ? JSON.parse(created.data) : created.data;
  const id = data.spreadsheetId;
  const url = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`;
  if (!id) return { ok: false, error: 'no-id' };

  await httpRequest({
    method: 'POST',
    url: `${SHEETS}/${id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    headers: auth, body: JSON.stringify({ values: starterRows() }), responseType: 'json'
  });

  // v1.0.19 — NO "anyone with the link" permission any more. Reads go through the
  // authenticated Sheets API now, so the sheet stays PRIVATE to the parent's
  // account. Previously every family's playlist was world-readable to anyone
  // holding the URL, purely because the reader was an unauthenticated CSV fetch.
  // File it in the app's folder; a failure there is cosmetic, not fatal.
  const folderId = await ensureSheetsFolder(token);
  if (folderId) {
    try {
      await httpRequest({
        method: 'PATCH',
        url: `${DRIVE}/files/${id}?addParents=${folderId}&fields=id,parents`,
        headers: auth, body: JSON.stringify({}), responseType: 'json'
      });
    } catch { /* the sheet still works from Drive root */ }
  }
  return { ok: true, id, url, folderId: folderId || null };
}

/**
 * v1.0.19 — read the source sheet through the authenticated Sheets API.
 * -> array of row arrays (what parseSourceRows in sync2.js consumes)
 *
 * THROWS on anything that is not a clean 200. That is deliberate and load-bearing:
 * the caller uses the throw to leave `sheetParsed` false, and the v1.0.10
 * presence-mirror deletes content only on a SUCCESSFUL parse. Returning [] on a
 * failed read would tell the mirror the parent emptied the sheet, and it would
 * tombstone the whole library. Never soften this to a silent empty result.
 */
export async function readSourceSheet(sheetUrl) {
  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) throw new Error('sheet-bad-url');
  const token = await getAccessToken({ interactive: false });
  if (!token) throw new Error('sheet-no-token');
  const auth = { Authorization: 'Bearer ' + token };

  const tab = await resolveTab(token, spreadsheetId, extractGid(sheetUrl));
  if (tab.error) throw new Error('sheet-' + tab.error);
  const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A:C`);
  const res = await httpRequest({
    url: `${SHEETS}/${spreadsheetId}/values/${range}`, headers: auth, responseType: 'json'
  });
  if (res.status !== 200 || !res.data) throw new Error('sheet-http-' + res.status);
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  // An empty sheet legitimately returns no `values` key at all. That IS an empty
  // sheet (not a failure) — and the mirror's total-disappearance valve is what
  // asks the parent about it, so returning [] here is correct.
  return (data.values || []).map((r) => (Array.isArray(r) ? r : []));
}

/* ---------------- flush ---------------- */

/** The tab title + numeric sheetId for the URL's gid — A1 ranges address tabs by
    title, but DeleteDimension (row removal) needs the numeric sheetId. */
async function resolveTab(token, spreadsheetId, gid) {
  const res = await httpRequest({
    url: `${SHEETS}/${spreadsheetId}?fields=sheets.properties`,
    headers: { Authorization: 'Bearer ' + token },
    responseType: 'json'
  });
  if (res.status !== 200 || !res.data) return { error: 'http-' + res.status };
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const sheets = (data.sheets || []).map((s) => s.properties || {});
  const hit = sheets.find((p) => p.sheetId === gid) || sheets[0];
  return hit ? { title: hit.title, sheetId: hit.sheetId } : { error: 'no-tabs' };
}

/**
 * Apply every queued op to the sheet: row DELETIONS first (bottom-up), then the
 * remaining appends (skipping keys the sheet already has). Safe to call any time:
 * no queue / no sheet / no token → quiet no-op (the queue survives for next time).
 * Idempotent on retry: a re-run matches no rows for done deletes and dedupes
 * already-landed appends against the sheet's content.
 */
export async function flushSheetQueue(profileId) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, empty: true };
  const lib = src.libraryId;

  // v1.0.18 — SERIALIZE PER LIBRARY. enqueueOp flushes on every enqueue and sync2
  // flushes at the end of every sync, so overlapping flushes were routine. Two of
  // them both read column A before either append lands (duplicate rows), and the
  // loser's unconditional queue-clear used to destroy the winner's un-sent ops.
  const running = flushInFlight.get(lib);
  if (running) { flushAgain.add(lib); return running; }

  const p = (async () => {
    let res;
    try { res = await doFlush(profileId, src, lib); } finally { flushInFlight.delete(lib); }
    // ops enqueued mid-flight were deliberately left in the queue — drain them now
    if (flushAgain.delete(lib)) { try { res = await flushSheetQueue(profileId); } catch {} }
    return res;
  })();
  flushInFlight.set(lib, p);
  return p;
}

const flushInFlight = new Map(); // libraryId -> in-flight flush promise
const flushAgain = new Set();    // libraryId -> a follow-up run is owed

/**
 * Remove ONLY what we just wrote. Anything enqueued while the network calls were
 * in the air carries a newer `at` for its identity (or an identity we never saw)
 * and must survive — clearing the whole queue silently dropped a parent's delete,
 * which then resurrected the video everywhere on the next mirror pass.
 */
async function clearFlushed(lib, flushed) {
  const remaining = remainingAfterFlush((await getMeta(qKey(lib))) || [], flushed);
  await putMeta(qKey(lib), remaining);
  return remaining.length;
}

/**
 * PURE — which queued ops survive a flush that wrote `flushed`?
 * An op survives when its identity carries a STRICTLY newer timestamp than the one
 * we just wrote (it was enqueued mid-flight), or when we never wrote that identity
 * at all. Everything we did write is dropped.
 */
export function remainingAfterFlush(currentQueue, flushed) {
  const flushedAt = new Map(normalizeOps(flushed).map((o) => [opIdentity(o), o.at || 0]));
  return normalizeOps(currentQueue).filter((o) => (o.at || 0) > (flushedAt.get(opIdentity(o)) ?? -1));
}

async function doFlush(profileId, src, lib) {
  const q = reconcileOps((await getMeta(qKey(lib))) || []);
  if (!q.length) { await clearFlushed(lib, []); return { ok: true, empty: true }; }

  const spreadsheetId = extractSpreadsheetId(src.sheetUrl);
  if (!spreadsheetId) {
    await patchState(lib, { error: 'published-link', pending: q.length });
    return { ok: false, error: 'published-link' };
  }
  const token = await getAccessToken({ interactive: false });
  if (!token) {
    await patchState(lib, { error: 'no-token', pending: q.length });
    return { ok: false, error: 'no-token' };
  }

  const tab = await resolveTab(token, spreadsheetId, extractGid(src.sheetUrl));
  if (tab.error) {
    // 403/404 here = same permission story as the writes themselves
    const permanent = /http-40[34]/.test(tab.error);
    await patchState(lib, { error: permanent ? 'no-edit-permission' : tab.error, pending: q.length });
    return { ok: false, error: tab.error };
  }
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const tabRef = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A:A`);

  // current column A — used both for delete matching and append dedupe
  const read = await httpRequest({ url: `${SHEETS}/${spreadsheetId}/values/${tabRef}`, headers: auth, responseType: 'json' });
  if (read.status !== 200 || !read.data) {
    await patchState(lib, { error: read.status === 403 ? 'no-edit-permission' : 'http-' + read.status, pending: q.length });
    return { ok: false, error: 'http-' + read.status };
  }
  const readData = typeof read.data === 'string' ? JSON.parse(read.data) : read.data;
  const colA = (readData.values || []).map((r) => (r && r[0]) || '');
  const handleMap = (await getMeta('handleMap')) || {};

  /* ---- deletions, bottom-up in ONE batchUpdate ---- */
  const delRows = matchRowsForDeletion(colA, q, handleMap);
  if (delRows.length) {
    const del = await httpRequest({
      method: 'POST', url: `${SHEETS}/${spreadsheetId}:batchUpdate`, headers: auth,
      body: JSON.stringify({
        requests: delRows.map((i) => ({
          deleteDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } }
        }))
      }),
      responseType: 'json'
    });
    if (del.status !== 200) {
      await patchState(lib, { error: del.status === 403 ? 'no-edit-permission' : 'http-' + del.status, pending: q.length });
      return { ok: false, error: 'http-' + del.status };
    }
  }

  /* ---- appends the sheet doesn't already have ---- */
  const deleted = new Set(delRows);
  const presentIds = new Set();
  colA.forEach((raw, i) => {
    if (deleted.has(i)) return;
    const row = classifySourceRow(raw);
    if (row.kind === 'removed') presentIds.add('rm:' + row.key); // v1.0.12 removal rows
    else if (row.kind === 'video') presentIds.add(row.key);
    else if (row.kind === 'channel') {
      const ref = row.channelRef;
      const id = ref.by === 'id' ? ref.value : handleMap[ref.by + ':' + String(ref.value).toLowerCase()];
      if (id) presentIds.add('ch:' + id);
    }
  });
  const appends = q.filter((o) => o.op === 'append' && !presentIds.has(o.key));
  if (appends.length) {
    const appendRef = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A1`);
    const res = await httpRequest({
      method: 'POST',
      url: `${SHEETS}/${spreadsheetId}/values/${appendRef}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      headers: auth,
      body: JSON.stringify({ values: appends.map((e) => e.row) }),
      responseType: 'json'
    });
    if (res.status !== 200) {
      await patchState(lib, { error: res.status === 403 ? 'no-edit-permission' : 'http-' + res.status, pending: q.length });
      return { ok: false, error: 'http-' + res.status };
    }
  }

  const stillPending = await clearFlushed(lib, q);
  await patchState(lib, { error: null, pending: stillPending, lastWriteAt: Date.now(), written: q.length });
  return { ok: true, written: q.length, deletedRows: delRows.length };
}
