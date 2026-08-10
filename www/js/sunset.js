// sunset.js — THE ONE-TIME MIGRATION OFF THE GOOGLE-SHEETS SOURCES LIST (v1.0.38).
//
// ⚠️ THIS WHOLE FILE IS SCHEDULED FOR DELETION AFTER 2026-09-10. A dated test in
// test/sunset.test.mjs fails on that date and carries the removal checklist. Everything the
// migration needs lives here on purpose — including the five sheet-reading pieces lifted out
// of sheetwrite.js — so the removal is one file, one call site and two plan.js functions.
//
// WHAT IT DOES, per profile with a sheetUrl: read the sheet ONE last time, fold it into the
// database, forget the sheet (KEEPING libraryId untouched — no scope move, no data movement),
// then permanently delete the spreadsheet the app created. Three read attempts across
// launches, then it forgets anyway. Silent throughout: a parent never sees it succeed or fail.
//
// THE FOLDER IS NEVER TOUCHED. Under `drive.file` the app cannot see files the parent put
// into it, so it cannot prove the folder is empty — and deleting a Drive folder deletes its
// contents. Exactly one files.delete, addressing one spreadsheet id.

import { httpRequest } from './platform.js';
import { getAccessToken } from './gauth.js';
import { looksLikeHtml } from './csv.js';
import { parseSourceRows } from './linksfile.js';
import { planSheetSunset, planSheetFold, planMutations, effectiveCaps } from './plan.js';
import { getProfiles } from './store.js';
import * as yt from './yt.js';
import {
  getMeta, putMeta, getSources, putSources, listLibraryChannels, putLibraryChannel,
  loadDenySet, loadMergeIndex, putVideos, getVideo, deleteVideo, getDeletedChannels
} from './db.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';

const stateKey = (profileId) => 'sunset:' + profileId;

/* ============================ the sheet read (moved from sheetwrite.js) ============================ */

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

/**
 * PURE — the ONE place that decides whether an HTTP response is rows or a failure.
 * -> array of row arrays, or THROWS.
 *
 * EMPTINESS MAY COME FROM EXACTLY ONE PLACE: a clean 200 whose payload carries no `values`
 * (the Sheets API omits the key for an empty range). Everything else throws.
 *
 * ⚠️ v1.0.38 — THE REASON CHANGED, AND IT IS STILL THE SAME GATE. There is no
 * presence-mirror left to mistake `[]` for "the parent emptied the sheet". But a wrong `[]`
 * now makes the sunset fold NOTHING, forget the sheet, and then PERMANENTLY DELETE a file
 * full of rows — Drive's files.delete bypasses the trash. So the gate guards irrecoverable
 * loss on the other side of the same coin, and none of its branches may be softened:
 *  - non-200 → 'sheet-http-<status>' (0 = no network).
 *  - MARKUP on a 200 is a fetch failure: a lost grant answers 200 with a sign-in page.
 *  - a JSON ERROR ENVELOPE on a 200 has no `values` and would otherwise read as empty.
 *  - `values` present but not an array = a payload we do not understand; guessing [] is the
 *    one answer that can destroy data.
 * Rows are RAGGED (trailing empty cells omitted) — normal input, never an error.
 */
export function interpretSheetResponse(status, data) {
  if (status !== 200) throw new Error('sheet-http-' + (status || 0));
  // A 200 with no body at all. On the BROWSER path this IS the HTML interstitial:
  // platform.httpRequest does `r.json().catch(() => null)`, so the markup never reaches the
  // looksLikeHtml branch below.
  if (!data) throw new Error('sheet-not-json');

  let payload = data;
  if (typeof payload === 'string') {
    if (looksLikeHtml(payload)) throw new Error('sheet-html');
    try { payload = JSON.parse(payload); } catch { throw new Error('sheet-not-json'); }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('sheet-not-json');
  // An error envelope may only ride along with ACTUAL ROWS (a partial-warning shape).
  if (payload.error && !(Array.isArray(payload.values) && payload.values.length)) {
    const err = payload.error;
    const code = err && typeof err === 'object' ? (err.code || err.status || 'error') : String(err || 'error');
    throw new Error('sheet-api-' + code);
  }
  const values = payload.values;
  if (values == null) return []; // the ONLY empty result: a genuinely empty sheet
  if (!Array.isArray(values)) throw new Error('sheet-not-json');
  return values.map((r) => (Array.isArray(r) ? r : []));
}

/** The tab title for the URL's gid — A1 ranges address tabs by title. */
async function resolveTab(token, spreadsheetId, gid) {
  const res = await httpRequest({
    url: `${SHEETS}/${spreadsheetId}?fields=sheets.properties`,
    headers: { Authorization: 'Bearer ' + token }, responseType: 'json'
  });
  if (res.status !== 200 || !res.data) return { error: 'http-' + res.status };
  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const sheets = (data.sheets || []).map((s) => s.properties || {});
  const hit = sheets.find((p) => p.sheetId === gid) || sheets[0];
  return hit ? { title: hit.title } : { error: 'no-tabs' };
}

/** The final authenticated read. THROWS on anything that is not a clean 200 with rows. */
export async function readFinalSheet(sheetUrl) {
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
  return interpretSheetResponse(res.status, res.data);
}

/* ============================ the runner ============================ */

// One read attempt per profile per launch: a flapping network must not burn all three tries
// in a single boot.
const triedThisLaunch = new Set();

async function readState(profileId) {
  const st = await getMeta(stateKey(profileId));
  return (st && typeof st === 'object') ? st : {};
}

/**
 * Delete ONE spreadsheet the app created. `drive.file` covers it (the app created the file),
 * and this is the only DELETE in the codebase — deliberately addressing a FILE id, never a
 * folder. 404 counts as done: the parent may have deleted it themselves.
 */
async function deleteSpreadsheet(spreadsheetId) {
  const token = await getAccessToken({ interactive: false });
  if (!token) return false;
  const res = await httpRequest({
    method: 'DELETE', url: `${DRIVE}/files/${spreadsheetId}`,
    headers: { Authorization: 'Bearer ' + token }, responseType: 'text'
  });
  return res.status === 200 || res.status === 204 || res.status === 404;
}

/**
 * Fold one parsed sheet into the database. Idempotent by construction, which is what makes
 * a crash mid-fold safe: `deleteVideo` is guarded the way sync2's removal loop was,
 * `putLibraryChannel` is a put, and `planMutations` over identical inputs is an empty diff.
 */
async function foldSheet(profileId, src, rows) {
  const lib = src.libraryId;
  const parsed = parseSourceRows(rows);

  // Resolve @handles / custom URLs once each. One bad ref must not kill the migration.
  const resolved = new Map();
  const key = await yt.getApiKey();
  for (const row of parsed.channelRows) {
    const ref = row && row.ref;
    if (!ref || ref.by === 'id') continue;
    const k = ref.by + ':' + ref.value;
    if (resolved.has(k)) continue;
    try { const id = await yt.resolveChannelRef(ref, key); if (id) resolved.set(k, id); } catch { /* skip one row */ }
  }

  const plan = planSheetFold({
    parsed, resolved,
    knownChannelIds: new Set((await listLibraryChannels(lib)).map((c) => c.channelId)),
    deletedChannels: await getDeletedChannels(lib),
    libraryId: lib, defaultAutoApprove: !!src.defaultAutoApprove,
    legacyIndex: null
  });

  // '# הוסר' rows: deny the key, exactly as the sheet stage did. Guarded so a re-run cannot
  // restamp a tombstone's `at` (its LWW tiebreaker).
  const denied = await loadDenySet(lib);
  for (const k of plan.removedKeys) {
    if (denied.has(k) && !(await getVideo(lib, k))) continue;
    await deleteVideo(lib, k, 'sheet-removed');
    denied.add(k);
  }
  for (const rec of plan.channelPuts) await putLibraryChannel(rec);

  let puts = 0;
  if (plan.candidates.length) {
    const mut = planMutations({
      candidates: plan.candidates,
      existing: await loadMergeIndex(lib),
      denySet: await loadDenySet(lib),
      caps: effectiveCaps(src)
    });
    if (mut.puts && mut.puts.length) { await putVideos(mut.puts); puts = mut.puts.length; }
  }
  return { videos: puts, channels: plan.channelPuts.length, removed: plan.removedKeys.length,
    skipped: plan.skippedChannelIds.length };
}

/**
 * Run the migration for EVERY profile. Called from app.entryRefresh between the Drive pull
 * and the sheet sync — never from dataver (that runs before any profile is active, blocks
 * boot behind a faded splash with no progress UI, and has "run once" semantics this needs
 * the opposite of).
 *
 * It iterates getProfiles() itself: entryRefresh is per-ACTIVE-profile, and a profile nobody
 * opens on this device would otherwise keep a sheetUrl forever against a build with no sheet
 * stage — silent content loss for that child.
 *
 * Silent and best-effort. -> { migrated, forgotten, deleted } (for tests/diagnostics)
 */
export async function runSheetSunset() {
  const out = { migrated: 0, forgotten: 0, deleted: 0 };
  if (await getMeta('sunset:done')) return out;

  let profiles = [];
  try { profiles = await getProfiles(); } catch { return out; }
  let allDone = true;

  for (const p of profiles) {
    if (!p || !p.id) continue;
    try {
      const src = await getSources(p.id);
      const state = await readState(p.id);
      // The token is probed ONCE per profile, non-interactively: a system dialog here would
      // ambush a parent who only opened the app.
      const hasToken = !!(await getAccessToken({ interactive: false }).catch(() => null));
      const step = planSheetSunset({ src, state, hasToken });

      if (step.action === 'skip') {
        if (step.reason !== 'done' && step.reason !== 'no-sheet') allDone = false;
        continue;
      }

      if (step.action === 'read') {
        if (triedThisLaunch.has(p.id)) { allDone = false; continue; }
        triedThisLaunch.add(p.id);
        // The attempt is recorded BEFORE the network call, together with the spreadsheet id:
        // after the forget there is no sheetUrl left to derive that id from, and the pending
        // file delete would have nothing to address.
        await putMeta(stateKey(p.id), {
          ...state, attempts: step.attempt, lastAttemptAt: Date.now(), phase: 'pending',
          sheetUrl: src.sheetUrl, spreadsheetId: extractSpreadsheetId(src.sheetUrl)
        });
        let rows = null;
        try {
          rows = await readFinalSheet(src.sheetUrl);
        } catch (e) {
          await putMeta(stateKey(p.id), {
            ...(await readState(p.id)), lastError: String((e && e.message) || e)
          });
          allDone = false;
          continue;
        }
        const folded = await foldSheet(p.id, src, rows);
        await putMeta(stateKey(p.id), {
          ...(await readState(p.id)), phase: 'folded', foldedAt: Date.now(), rows: rows.length, folded
        });
        out.migrated += 1;
        // fall through to the forget in the SAME pass — nothing is gained by waiting
      }

      // FORGET. libraryId is deliberately absent from this patch: changing it would strand
      // the family's whole library under an unreachable scope, on every device.
      const cur = await getSources(p.id);
      if (cur && (cur.sheetUrl || cur.sheetHash || cur.sheetFolderId)) {
        await putSources({
          ...cur, sheetUrl: null, sheetHash: null, sheetFolderId: null, sheetFetchedAt: null,
          updatedAt: Date.now()
        });
      }
      const afterFold = await readState(p.id);
      await putMeta(stateKey(p.id), { ...afterFold, phase: 'forgotten', forgotAt: Date.now() });
      out.forgotten += 1;

      // DELETE the file, from the snapshotted id. Only ever reachable after a SUCCESSFUL
      // read: a failed read never sets phase 'folded', so it never gets here.
      const st2 = await readState(p.id);
      const del = planSheetSunset({ src: null, state: st2, hasToken });
      if (del.action === 'delete-file') {
        const ok = await deleteSpreadsheet(del.spreadsheetId).catch(() => false);
        await putMeta(stateKey(p.id), ok
          ? { ...st2, phase: 'done', deletedFileAt: Date.now() }
          : { ...st2, deleteAttempts: del.attempt });
        if (ok) out.deleted += 1; else allDone = false;
      } else if (del.action === 'skip' && del.reason === 'done') {
        await putMeta(stateKey(p.id), { ...st2, phase: 'done' });
      } else {
        allDone = false;
      }
    } catch {
      // One profile's failure must never stop the others, and must never take a launch down.
      allDone = false;
    }
  }

  // O(1) skip on every later launch, once nothing is left to do anywhere.
  if (allDone) await putMeta('sunset:done', { at: Date.now(), profiles: profiles.length });
  return out;
}
