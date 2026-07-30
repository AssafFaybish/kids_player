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
const QUEUE_CAP = 200;

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

async function enqueueOp(profileId, op) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, noSheet: true };
  const q = normalizeOps((await getMeta(qKey(src.libraryId))) || []);
  q.push({ ...op, at: Date.now() });
  await putMeta(qKey(src.libraryId), q.slice(-QUEUE_CAP));
  await patchState(src.libraryId, { pending: Math.min(q.length, QUEUE_CAP) });
  return flushSheetQueue(profileId);
}

/**
 * Enqueue one APPEND for the profile's sheet and try flushing. Idempotent twice
 * over: reconcileOps keeps the latest intent per key, and the flush skips appends
 * whose key already exists in the sheet.
 */
export function enqueueSheetRow(profileId, { key, srcUrl, title = '', flag = '' }) {
  return enqueueOp(profileId, { op: 'append', key, row: buildSheetRow({ srcUrl, title, flag }) });
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

  const perm = await httpRequest({
    method: 'POST', url: `https://www.googleapis.com/drive/v3/files/${id}/permissions`,
    headers: auth, body: JSON.stringify({ role: 'reader', type: 'anyone' }), responseType: 'json'
  });
  // Permission failure isn't fatal for creation — but the app won't be able to READ
  // the sheet until the parent shares it manually; the caller must surface this.
  return { ok: true, id, url, permissionWarning: perm.status !== 200 };
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
  const q = reconcileOps((await getMeta(qKey(lib))) || []);
  if (!q.length) { await putMeta(qKey(lib), []); return { ok: true, empty: true }; }

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

  await putMeta(qKey(lib), []);
  await patchState(lib, { error: null, pending: 0, lastWriteAt: Date.now(), written: q.length });
  return { ok: true, written: q.length, deletedRows: delRows.length };
}
