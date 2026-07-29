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

const qKey = (lib) => 'sheetq:' + lib;
const stateKey = (lib) => 'sheetqState:' + lib;

/* ---------------- queue ---------------- */

/**
 * Enqueue one row for the profile's sheet (idempotent by key) and try flushing.
 * Callers enqueue ONLY on a NEW add / first approval — never on merges — so a row
 * lands in the sheet at most once.
 */
export async function enqueueSheetRow(profileId, { key, srcUrl, title = '', flag = '' }) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, noSheet: true };
  const q = (await getMeta(qKey(src.libraryId))) || [];
  if (!q.some((e) => e.key === key)) {
    q.push({ key, row: buildSheetRow({ srcUrl, title, flag }), at: Date.now() });
    await putMeta(qKey(src.libraryId), q.slice(-QUEUE_CAP));
    await patchState(src.libraryId, { pending: Math.min(q.length, QUEUE_CAP) });
  }
  return flushSheetQueue(profileId);
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

/* ---------------- flush ---------------- */

/** The tab title for the URL's gid — A1 ranges can only address tabs by title. */
async function resolveTabTitle(token, spreadsheetId, gid) {
  const res = await httpRequest({
    url: `${SHEETS}/${spreadsheetId}?fields=sheets.properties`,
    headers: { Authorization: 'Bearer ' + token },
    responseType: 'json'
  });
  if (res.status !== 200 || !res.data) return { error: 'http-' + res.status };
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const sheets = (data.sheets || []).map((s) => s.properties || {});
  const hit = sheets.find((p) => p.sheetId === gid) || sheets[0];
  return hit ? { title: hit.title } : { error: 'no-tabs' };
}

/**
 * Push every queued row to the sheet. Safe to call any time:
 * no queue / no sheet / no token → quiet no-op (the queue survives for next time).
 */
export async function flushSheetQueue(profileId) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, empty: true };
  const lib = src.libraryId;
  const q = (await getMeta(qKey(lib))) || [];
  if (!q.length) return { ok: true, empty: true };

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

  const tab = await resolveTabTitle(token, spreadsheetId, extractGid(src.sheetUrl));
  if (tab.error) {
    // 403/404 here = same permission story as the append itself
    const permanent = /http-40[34]/.test(tab.error);
    await patchState(lib, { error: permanent ? 'no-edit-permission' : tab.error, pending: q.length });
    return { ok: false, error: tab.error };
  }

  const range = encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A1`);
  const res = await httpRequest({
    method: 'POST',
    url: `${SHEETS}/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ values: q.map((e) => e.row) }),
    responseType: 'json'
  });

  if (res.status === 200) {
    await putMeta(qKey(lib), []);
    await patchState(lib, { error: null, pending: 0, lastWriteAt: Date.now(), written: q.length });
    return { ok: true, written: q.length };
  }
  await patchState(lib, {
    error: res.status === 403 ? 'no-edit-permission' : res.status === 404 ? 'not-found' : 'http-' + res.status,
    pending: q.length
  });
  return { ok: false, error: 'http-' + res.status };
}
