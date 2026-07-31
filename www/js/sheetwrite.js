// sheetwrite.js — write-back to the parent's Google Sheet (v1.0.6): the sheet is the
// single human-readable master list, so manual adds, manually-added channels and
// approved shares are APPENDED to it as rows.
//
// Design rules:
//  - Local state is written FIRST and never blocks on the network: rows go into a
//    durable queue (meta store) and are flushed opportunistically (after sync, after
//    adds) with a NON-interactive token — no consent UI ever pops mid-flow.
//  - v1.0.19: the ONLY scope is `drive.file`, which reaches exactly the files this
//    app created — which is why the sheet must be one the app created, and why
//    pasting a link to the parent's own sheet was removed (403 appNotAuthorizedToFile).
//  - Published links (docs.google.com/spreadsheets/d/e/…) carry an opaque token, NOT
//    the spreadsheet id — writing is impossible; surfaced as a parent-facing state.
//  - Appends target the SAME tab the app reads: the gid in the sheet URL is resolved
//    to the tab's title via spreadsheets.get (A1 ranges address tabs by title only).

import { httpRequest } from './platform.js';
import { getAccessToken } from './gauth.js';
import { getMeta, putMeta, getSources } from './db.js';
import { classifySourceRow } from './classify.js';
// csv.js sits BELOW db in the import order (platform → store/classify/csv/util → db →
// plan/sync2/drive), so pulling looksLikeHtml in here cannot create a cycle. It is
// imported for the READ path: a markup body wearing an HTTP 200 is a failed fetch.
import { looksLikeHtml } from './csv.js';

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

/**
 * PURE — the queue after enqueuing `newOp`, plus whether the cap dropped anything.
 * -> { queue, overflow }
 *
 * Two rules, both paid for in lost data before they were rules:
 *
 *  - RECONCILE BEFORE CAPPING (v1.0.18). Re-editing one video 300 times used to push
 *    300 entries and shove 100 unrelated ops out of the queue. Collapsing per entity
 *    first means the cap counts DISTINCT ENTITIES, so churn on one video can never
 *    evict another video's pending delete.
 *  - KEEP THE OLDEST INTENTS. `slice(-cap)` drops the HEAD, and the head is where the
 *    parent's EARLIEST deletions live: an offline bulk cleanup of 300 videos silently
 *    discarded the first 100 delvideo ops, their rows stayed in the sheet, the next
 *    mirror pass read that presence as a deliberate re-add, revoked the tombstones,
 *    and every deleted video came back on every device. Head-slicing also means an op
 *    could vanish with no action of its own — purely because unrelated later activity
 *    pushed it out. FIFO instead: what is already queued stays queued and drains in
 *    order, and the op that cannot fit is the one being enqueued RIGHT NOW, at the
 *    same moment `error: 'queue-overflow'` reaches the parent's sources tab.
 *
 * Junk in (null, holes, legacy op-less rows) must never throw — this runs on a
 * durable queue read back from storage, possibly written by an older version.
 */
export function planQueue(existingOps, newOp, cap = QUEUE_CAP) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : QUEUE_CAP;
  const merged = reconcileOps([...normalizeOps(existingOps), ...(newOp ? [newOp] : [])]);
  return { queue: merged.slice(0, limit), overflow: merged.length > limit };
}

async function enqueueOp(profileId, op, { flush = true } = {}) {
  const src = await getSources(profileId);
  if (!src || !src.sheetUrl || !src.libraryId) return { ok: true, noSheet: true };
  // The clock stays HERE so planQueue can be pure (and testable).
  const { queue, overflow } = planQueue(
    (await getMeta(qKey(src.libraryId))) || [], { ...op, at: Date.now() }, QUEUE_CAP
  );
  await putMeta(qKey(src.libraryId), queue);
  // Overflow is DATA LOSS, not a queue detail, and it must outlive the next flush.
  // It used to be written into `error`, which every doFlush exit overwrites — a
  // successful flush two lines below erased it before any parent could see it, and the
  // sources tab (which has no overflow branch) then promised the dropped rows "will be
  // written automatically at the next sync". `dropped` is a durable count instead:
  // only the parent acknowledging it clears it.
  const cur = (await sheetWriteState(src.libraryId)) || {};
  await patchState(src.libraryId, {
    pending: queue.length,
    ...(overflow ? { dropped: (Number(cur.dropped) || 0) + 1, droppedAt: Date.now() } : {})
  });
  const res = flush ? await flushSheetQueue(profileId) : { ok: true, queued: true };
  return overflow ? { ...res, overflow: true } : res;
}

/** The parent has seen the overflow warning — stop showing it. */
export async function acknowledgeDropped(libraryId) {
  if (!libraryId) return;
  await patchState(libraryId, { dropped: 0, droppedAt: null });
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

/**
 * PURE (v1.0.19) — the opening rows of a new sheet: a real COLUMN HEADER plus a
 * short how-to, so a parent who opens the file cold understands it without docs.
 *
 * Every one of these rows starts column A with `#`, which `classifySourceRow`
 * classifies as `comment` and the pipeline skips — that is what lets row 1 read as
 * a header while remaining invisible to the parser. Columns B and C carry their own
 * captions so the header lines up UNDER the columns it describes, instead of being
 * one long sentence crammed into A (which is what this used to be).
 *
 * Three properties these rows must keep, all pinned by tests:
 *  - column A always starts with '#' — otherwise a header line becomes content;
 *  - none of them may contain a removal marker (הוסר / removed / deleted), or
 *    parseRemovalRow would read the example link as a deletion and DENY that key
 *    for every device on the sheet;
 *  - they never affect `rowIndex`, because videoOrdinal counts video rows only.
 */
export function starterRows() {
  return [
    ['# עמודה A · לינק (חובה)', 'עמודה B · שם להצגה (רשות)', 'עמודה C · auto / manual (לערוץ בלבד)'],
    ['# כל שורה = סרטון אחד או ערוץ אחד. מדביקים לינק בעמודה A ושומרים — האפליקציה תתעדכן בסנכרון הבא.', '', ''],
    ['# לינק לסרטון: https://youtu.be/VIDEO_ID   ·   לינק לערוץ: https://www.youtube.com/@ChannelName', '', ''],
    ['# עמודה C רלוונטית רק לשורת ערוץ: manual (ברירת מחדל) = סרטון חדש ממתין לאישורכם, auto = מופיע לילד מיד.', '', ''],
    ['# שורות שמתחילות ב-# הן הערות בלבד והאפליקציה מתעלמת מהן. אפשר למחוק אותן.', '', '']
  ];
}

// v1.0.19: `isSheetsUrl` was deleted with the paste-a-link flow it validated. It
// had no caller left, and dead URL-validation for a removed flow is exactly the
// kind of helper that gets resurrected later to re-enable pasting — which cannot
// work under drive.file. If you need it back, read the scope note in
// GoogleAuthPlugin.java first.

/** PURE (v1.0.12): the name of a sheet created for a profile — "<שם>_רשימת סרטונים". */
export function sheetNameFor(profileName) {
  const name = String(profileName || '').replace(/\s+/g, ' ').trim() || 'ילד/ה';
  return `${name}_רשימת סרטונים`;
}

/**
 * Create a new source sheet in the signed-in parent's Drive: title → spreadsheet →
 * header + how-to rows (starterRows) → filed into the app's Drive folder.
 *
 * v1.0.19: it is NOT shared publicly. Reads go through the authenticated Sheets API
 * (readSourceSheet), so the sheet stays private to the parent's account — it used to
 * be forced to "anyone with the link can VIEW" purely so an unauthenticated CSV
 * export could see it, which made every family's playlist world-readable.
 *
 * -> { ok, id, url, folderId }  — folderId is null unless the move was VERIFIED.
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
  // `removeParents=root` is required: Drive v3 dropped multi-parenting, and an
  // addParents-only PATCH can leave the file sitting in root — the exact thing the
  // folder exists to prevent. httpRequest RETURNS a status rather than throwing, so
  // the status must be checked explicitly; a try/catch alone would never fire, and
  // the UI would keep telling parents the file is filed when it is not.
  let folderId = await ensureSheetsFolder(token);
  if (folderId) {
    let moved = false;
    try {
      const mv = await httpRequest({
        method: 'PATCH',
        url: `${DRIVE}/files/${id}?addParents=${folderId}&removeParents=root&fields=id,parents`,
        headers: auth, body: JSON.stringify({}), responseType: 'json'
      });
      moved = mv.status === 200;
    } catch { moved = false; }
    if (!moved) folderId = null; // the sheet still works from Drive root — just say so
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
  return interpretSheetResponse(res.status, res.data);
}

/**
 * PURE — the ONE place that decides whether an HTTP response is rows or a failure.
 * -> array of row arrays, or THROWS.
 *
 * EMPTINESS MAY COME FROM EXACTLY ONE PLACE: a clean 200 whose payload carries no
 * `values` (the Sheets API omits the key for an empty range). Everything else throws,
 * because the caller turns a throw into "leave `sheetParsed` false" and the v1.0.10
 * presence-mirror deletes content only on a SUCCESSFUL parse — an `[]` from a failed
 * read tells the mirror the parent emptied the sheet, and it tombstones the whole
 * library. Every branch below is therefore a refusal to guess:
 *
 *  - non-200 → 'sheet-http-<status>' (status 0 = no network). The string is what
 *    `sheetErrorMessage` pattern-matches, so it must keep carrying the code.
 *  - a MARKUP body on a 200 is a fetch failure, not an empty sheet (csv.js
 *    looksLikeHtml): a lost grant redirects to a sign-in / "request access" page
 *    that answers 200 with HTML. This once deleted whole libraries through the CSV
 *    reader; the authenticated reader can meet the same interstitial.
 *  - a JSON ERROR ENVELOPE on a 200 (Google's `{error:{code,…}}`, which a proxy can
 *    hand back with the status flattened) has no `values` and would otherwise read
 *    as "empty". The code rides along so the message stays specific.
 *  - `values` present but not an array = a payload we do not understand. Guessing []
 *    is the one answer that can destroy data, so refuse.
 *
 * Rows are RAGGED — the API omits trailing empty cells and can send a bare `[]` for
 * a blank line. That is normal input, never an error.
 */
export function interpretSheetResponse(status, data) {
  if (status !== 200) throw new Error('sheet-http-' + (status || 0));
  // A 200 with no body at all. On the BROWSER path this IS the HTML interstitial:
  // platform.httpRequest does `r.json().catch(() => null)`, so the markup never reaches
  // the looksLikeHtml branch below. It must therefore route like one — 'sheet-http-200'
  // matched no sheetErrorMessage branch and told the parent "maybe no internet", i.e.
  // "do nothing", for a lost grant that only reconnecting fixes.
  if (!data) throw new Error('sheet-not-json');

  let payload = data;
  if (typeof payload === 'string') {
    // CapacitorHttp hands back the raw string when responseType:'json' cannot parse.
    if (looksLikeHtml(payload)) throw new Error('sheet-html');
    try { payload = JSON.parse(payload); } catch { throw new Error('sheet-not-json'); }
  }
  // A bare array is not a values.get payload either — only `{…}` can carry `values`.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('sheet-not-json');
  // An error envelope may only ride along with ACTUAL ROWS (a partial-warning shape).
  // Gating this on `values == null` alone let `{error:{…}, values:[]}` return [] — a
  // SECOND source of emptiness, and emptiness is the one answer that can destroy data.
  if (payload.error && !(Array.isArray(payload.values) && payload.values.length)) {
    const err = payload.error;
    // carry the status TEXT when there is no numeric code, so sheetErrorMessage can still
    // route it — 'sheet-api-error' matched nothing and read as "maybe no internet"
    const code = err && typeof err === 'object' ? (err.code || err.status || 'error') : String(err || 'error');
    throw new Error('sheet-api-' + code);
  }
  const values = payload.values;
  if (values == null) return []; // the ONLY empty result: a genuinely empty sheet
  if (!Array.isArray(values)) throw new Error('sheet-not-json');
  return values.map((r) => (Array.isArray(r) ? r : []));
}

/**
 * PURE (v1.0.19) — turn a readSourceSheet failure into something a parent can ACT on.
 *
 * This exists because the failure used to be invisible: sync swallowed the throw,
 * still returned ok, and the sources tab answered every refresh with "עודכן ✅" while
 * the library was frozen. Reads need a token now, so that state is reachable simply
 * by revoking the app in the Google account. Every branch must end in a next step —
 * a dead end here recreates the bug in a politer font.
 */
export function sheetErrorMessage(err) {
  const e = String(err || '');
  // status TEXT, not just numeric codes: a Sheets envelope can arrive with `status`
  // only, and an OAuth failure arrives as the bare string 'invalid_grant'
  if (/no-token|401|UNAUTHENTICATED|invalid_grant/i.test(e)) {
    return 'אין חיבור לחשבון Google — הרשימה לא נקראה. התחברו מחדש בהגדרות (הגיבוי בגוגל דרייב).';
  }
  if (/40[34]|PERMISSION_DENIED|NOT_FOUND/i.test(e)) {
    // The pre-v1.0.19 case: a sheet the parent created and pasted. drive.file cannot
    // reach it, and the paste flow that produced it no longer exists.
    return 'אין גישה לקובץ הרשימה. אם חיברתם קובץ ידנית בגרסה ישנה — צרו רשימה חדשה כאן, והתוכן הקיים יעבור אליה.';
  }
  if (/bad-url/.test(e)) return 'הקישור לרשימה אינו תקין — צרו רשימה חדשה.';
  // interpretSheetResponse's "this is not data" cases: a sign-in / request-access page
  // wearing a 200, or a payload we cannot read. Almost always a lost grant, so point
  // at reconnecting — and say the library is intact, because it is.
  if (/html|not-json/.test(e)) {
    return 'התקבלה תשובה לא צפויה מגוגל בקריאת הרשימה. התחברו מחדש לחשבון Google בהגדרות ונסו לרענן — התוכן הקיים נשמר.';
  }
  return 'לא הצלחנו לקרוא את הרשימה (אולי אין חיבור לאינטרנט). התוכן הקיים נשמר.';
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

  // Current column A — used both for delete matching and append dedupe, so an
  // UNREADABLE response must abort the flush with the queue INTACT. This read goes
  // through the same gate as readSourceSheet: hand-rolling it treated an error envelope
  // or a sign-in page as an empty sheet, which matched no row for deletion, re-appended
  // every row as a duplicate, and then let clearFlushed() drop the unsent delvideo ops —
  // their rows stayed in the sheet, and the next mirror pass read that presence as a
  // deliberate re-add and resurrected the deleted videos on every device.
  const read = await httpRequest({ url: `${SHEETS}/${spreadsheetId}/values/${tabRef}`, headers: auth, responseType: 'json' });
  let colA;
  try {
    colA = interpretSheetResponse(read.status, read.data).map((r) => (r && r[0]) || '');
  } catch (e) {
    const code = String(e && e.message || e);
    const permanent = /40[34]/.test(code);
    await patchState(lib, { error: permanent ? 'no-edit-permission' : code, pending: q.length });
    return { ok: false, error: code };
  }
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
