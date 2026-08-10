// linksfile.js — THE LINKS FILE (v1.0.38). One plain-text file that carries a profile's
// whole source list: every subscribed channel/playlist and every individually added video,
// one link per line. It replaces the Google-Sheets sources list as the way to add content
// in bulk, and it is how a library moves to another device or another Google account.
//
// THE FORMAT IS THE OLD SHEET'S ROW GRAMMAR, so there is NO new parser and NO second
// safety boundary: parseCsv tokenizes (quoted Hebrew titles with commas, CRLF, the
// Sheets-export BOM, a tab-separated fallback) and parseSourceRows → classifySourceRow
// classifies. That is also exactly why a CSV pasted out of the old spreadsheet imports —
// it IS the same input the sheet reader used to produce.
//
// LAYER: pure half imports csv + classify only (the store/classify/csv/util tier), so both
// db-level callers — app.js and the temporary sunset.js migration — can use it. The I/O
// half sits above db and is consumed only by app.js, like snapshot.js.
//
// `parseSourceRows` lives HERE, not in sync2.js, on purpose: sync2's sheet stage and the
// whole sunset migration are scheduled for deletion, and the row grammar is not.

import { parseCsv, looksLikeHtml } from './csv.js';
import { classifySourceRow, titleFromFileUrl } from './classify.js';
import { sortKeyFor, compareForDisplay } from './order.js';
import { normalizeProfileName } from './store.js';
import { coveredBySubscription, manualVideoRecord, channelRowSubscription, LINKS_IMPORT_MAX } from './plan.js';

export const LINKS_FILE_VERSION = 1;

/* ============================ the row grammar (pure) ============================ */

/**
 * PURE: typed rows from ALREADY-TOKENIZED rows (array of arrays) — what both the Sheets
 * API and parseCsv produce. Moved here from sync2.js in v1.0.38, unchanged.
 *
 * A row is [link, display name, auto|manual]. Column 3 is only meaningful for a channel
 * or a playlist. `# …` is a comment, `# הוסר: <link>` is a removal marker.
 */
export function parseSourceRows(rows) {
  const videoRows = [];
  const channelRows = [];
  const playlistRows = [];
  const removedKeys = []; // v1.0.12: '# הוסר: <link>' rows — deny these for everyone
  const invalid = [];
  let videoOrdinal = 0;
  for (const fields of (Array.isArray(rows) ? rows : [])) {
    // Rows arrive RAGGED (the Sheets API omits trailing empty cells; a hand-typed file has
    // one field per line) and a malformed payload can hand us a non-array row. Neither may
    // throw: for the sheet reader a throw read as "the sheet is unreadable", and for the
    // links importer it would read as "this is not a links file".
    const parts = (Array.isArray(fields) ? fields : []).map((s) => String(s ?? '').trim().replace(/^"+|"+$/g, ''));
    const row = classifySourceRow(parts[0] || '');
    if (row.kind === 'removed') { removedKeys.push(row.key); continue; }
    if (row.kind === 'blank' || row.kind === 'comment') continue;
    if (row.kind === 'video') {
      videoRows.push({ ...row, title: parts[1] || '', thumbUrl: parts[2] || '', rowIndex: videoOrdinal });
      videoOrdinal += 1;
    } else if (row.kind === 'channel') {
      channelRows.push({ ref: row.channelRef, title: parts[1] || '', flag: (parts[2] || '').toLowerCase() });
    } else if (row.kind === 'playlist') {
      playlistRows.push({ playlistId: row.playlistId, title: parts[1] || '', flag: (parts[2] || '').toLowerCase() });
    } else {
      invalid.push(row);
    }
  }
  // A removal row always wins over a video row for the same key in the SAME input:
  // safety-first — to bring a video back the parent deletes the removal line.
  const removed = new Set(removedKeys);
  return { videoRows: videoRows.filter((r) => !removed.has(r.key)), channelRows, playlistRows, removedKeys, invalid };
}

/* ============================ writing the file (pure) ============================ */

const two = (n) => String(n).padStart(2, '0');
/** YYYY-MM-DD in LOCAL time — the date the parent will recognise on their own device. */
function dateStamp(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/**
 * PURE: the '#' header block. Carries the SOURCE PROFILE NAME, which is what lets an
 * import offer "create a new profile from this file", plus the row legend — the same legend
 * the old sheet's starter rows carried, because it is the same format.
 * EVERY returned line starts with '#', so classifySourceRow reads them all as comments.
 * That is the mechanism, not a convention (unit-pinned).
 */
export function linksFileHeader({ profileName = '', exportedAt = Date.now(), appVersion = '' } = {}) {
  const lines = ['# הסרטונים שלי — רשימת לינקים'];
  const name = String(profileName || '').trim();
  if (name) lines.push('# פרופיל: ' + name);
  lines.push(`# יוצא בתאריך: ${dateStamp(exportedAt)}`
    + (appVersion ? ` · גרסת אפליקציה: ${appVersion}` : '')
    + ` · פורמט: ${LINKS_FILE_VERSION}`);
  lines.push('# שורה אחת = לינק אחד. אפשר גם: לינק,שם להצגה,auto|manual');
  lines.push('# עמודה שלישית רלוונטית רק לערוץ או לרשימת השמעה: manual = ממתין לאישור, auto = נכנס ישר');
  lines.push('# שורה שמתחילה ב-# היא הערה והאפליקציה מדלגת עליה');
  return lines;
}

/**
 * PURE inverse of the '# פרופיל:' marker. Only within the first `maxScan` lines, and the
 * value passes through store.normalizeProfileName — a name out of a file is untrusted input
 * that may become a real child's profile. A value that looks like a link answers ''.
 */
export function profileNameFromLines(lines, { maxScan = 40 } = {}) {
  const arr = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  for (const raw of arr.slice(0, Math.max(0, maxScan | 0))) {
    const s = String(raw ?? '').trim();
    if (!s.startsWith('#')) continue;
    const m = s.match(/^#\s*(?:פרופיל|profile)\s*[:\-–]\s*(.+)$/);
    if (!m) continue;
    const val = m[1].trim();
    if (!val || /https?:\/\//i.test(val)) return '';
    const norm = normalizeProfileName(val);
    // normalizeProfileName never answers '' (it falls back to 'ילד/ה'), so an empty input
    // must be rejected BEFORE it — which the !val check above does.
    return norm;
  }
  return '';
}

const UC_ID = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * PURE: the canonical, resolvable link for one exportable entry. All four forms are
 * available LOCALLY — zero API calls.
 *
 * WHY NOT `srcUrl` FOR A YOUTUBE VIDEO: a stored srcUrl can be a youtu.be link carrying
 * `?si=` tracking, an m.youtube host, a `?t=` seek, or — the one that matters — a `&list=`
 * that classifySourceRow would read back as a PLAYLIST and import as hundreds of videos.
 * The watch form is the only one that guarantees key-for-key identity on the other device.
 * A direct file keeps its original srcUrl: that IS its identity.
 *
 * null = not representable. The caller counts it as `skipped`, never drops it silently.
 */
export function canonicalLinkFor(entry) {
  const e = entry || {};
  if (e.kind === 'channel') {
    return UC_ID.test(String(e.channelId || '')) ? 'https://www.youtube.com/channel/' + e.channelId : null;
  }
  if (e.kind === 'playlist') {
    const id = String(e.playlistId || e.channelId || '');
    return PLAYLIST_ID.test(id) ? 'https://www.youtube.com/playlist?list=' + id : null;
  }
  if (e.type === 'youtube') {
    return /^[A-Za-z0-9_-]{11}$/.test(String(e.id || '')) ? 'https://www.youtube.com/watch?v=' + e.id : null;
  }
  if (e.type === 'file') {
    const u = String(e.srcUrl || e.url || '');
    return /^https:\/\//i.test(u) ? u : null;
  }
  return null;
}

/** A CSV field: quoted only when it must be, so a plain list stays plain text. */
function csvField(s) {
  const v = String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!v) return '';
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** One `link[,name[,flag]]` line with no trailing empty columns. */
function rowLine(link, name, flag) {
  const cells = [link, csvField(name), flag || ''];
  while (cells.length > 1 && !cells[cells.length - 1]) cells.pop();
  return cells.join(',');
}

/**
 * PURE: the whole file.
 *
 * WHICH VIDEOS GET A LINE: only those NO subscription reproduces (plan.coveredBySubscription
 * — planOrphanGC's rule read forwards). And only `state === 'live'`: a pending share has
 * not been decided, and a rejected video must never travel as a plain add (resolveCuration).
 *
 * ORDER is deterministic — channels (title, then id), playlists, then videos by
 * compareForDisplay — so re-exporting an unchanged library is byte-identical and two
 * exports diff cleanly. Line order becomes `rowIndex` on import.
 *
 * -> { text, lines, counts: { channels, playlists, videos, files, skipped } }
 */
export function serializeLinksFile({ subscriptions = [], channelMeta = null, videos = [],
  profileName = '', exportedAt = Date.now(), appVersion = '' } = {}) {
  const meta = channelMeta instanceof Map ? channelMeta : new Map(Object.entries(channelMeta || {}));
  const subs = [...subscriptions].filter((c) => c && c.channelId);
  const titleOf = (c) => String(c.titleOverride || (meta.get(c.channelId) || {}).title || '').trim();

  const counts = { channels: 0, playlists: 0, videos: 0, files: 0, skipped: 0 };
  const body = [];

  const byKind = (kind) => subs
    .filter((c) => (kind === 'playlist' ? c.kind === 'playlist' : c.kind !== 'playlist'))
    .sort((a, b) => {
      const t = titleOf(a).localeCompare(titleOf(b), 'he');
      return t !== 0 ? t : String(a.channelId).localeCompare(String(b.channelId));
    });

  for (const c of byKind('channel')) {
    const link = canonicalLinkFor({ kind: 'channel', channelId: c.channelId });
    if (!link) { counts.skipped += 1; continue; }
    body.push(rowLine(link, titleOf(c), c.autoApprove ? 'auto' : ''));
    counts.channels += 1;
  }
  for (const c of byKind('playlist')) {
    const link = canonicalLinkFor({ kind: 'playlist', playlistId: c.channelId });
    if (!link) { counts.skipped += 1; continue; }
    body.push(rowLine(link, titleOf(c), c.autoApprove ? 'auto' : ''));
    counts.playlists += 1;
  }

  const loose = [...videos]
    .filter((r) => r && r.key && r.state === 'live' && !coveredBySubscription(r, subs))
    .sort(compareForDisplay);
  for (const r of loose) {
    const link = canonicalLinkFor(r);
    if (!link) { counts.skipped += 1; continue; }
    body.push(rowLine(link, r.title || '', ''));
    if (r.type === 'file') counts.files += 1;
    counts.videos += 1;
  }

  const lines = [...linksFileHeader({ profileName, exportedAt, appVersion }), ...body];
  return { text: lines.join('\n') + '\n', lines, counts };
}

/**
 * PURE: safe, dated, recognisable filename. Hebrew is KEPT (the parent has to recognise the
 * file); anything outside letters/digits/space/_/- is stripped and spaces become '-'.
 */
export function linksFileName(profileName, at = Date.now()) {
  const slug = [...String(profileName || '').trim()]
    .filter((ch) => /[\p{L}\p{N} _-]/u.test(ch)).join('')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'profile';
  return `kids-player-links-${slug}-${dateStamp(at)}.txt`;
}

/* ============================ reading the file (pure) ============================ */

/**
 * PURE: a links file -> a typed plan. TOTAL — never throws, on any input.
 *
 * looksLikeHtml runs FIRST: a parent who picked the wrong file, or a saved Drive
 * "request access" page, must hear "this is not a links file" and never "0 links found".
 * The interpretSheetResponse / interpretDriveDoc doctrine — an unreadable input is never
 * an empty one.
 *
 * -> { ok, error: null|'empty'|'html'|'no-links'|'too-big', profileName,
 *      channels, playlists, videos, removedKeys, invalid, counts }
 */
export function parseLinksFile(text, { maxBytes = 2000000, max = LINKS_IMPORT_MAX } = {}) {
  const empty = {
    ok: false, error: 'empty', profileName: '',
    channels: [], playlists: [], videos: [], removedKeys: [], invalid: [],
    counts: { channels: 0, playlists: 0, videos: 0, invalid: 0, removed: 0, total: 0, dropped: 0 }
  };
  let s;
  try { s = String(text ?? ''); } catch { return { ...empty, error: 'html' }; }
  if (!s.trim()) return empty;
  if (s.length > Math.max(1, maxBytes | 0)) return { ...empty, error: 'too-big' };
  if (looksLikeHtml(s)) return { ...empty, error: 'html' };

  let parsed;
  try {
    parsed = parseSourceRows(parseCsv(s));
  } catch {
    // parseCsv and parseSourceRows are both documented never-throw, but a parser that is
    // "total by inspection" is not total: a future edit must not turn a bad file into a
    // crash on the parent's screen.
    return { ...empty, error: 'html' };
  }

  const seen = new Set();
  const channels = [];
  const playlists = [];
  const videos = [];
  let dropped = 0;
  const room = () => channels.length + playlists.length + videos.length < Math.max(1, max | 0);

  for (const c of parsed.channelRows) {
    const id = 'ch:' + c.ref.by + ':' + c.ref.value;
    if (seen.has(id)) continue;
    if (!room()) { dropped += 1; continue; }
    seen.add(id);
    channels.push({ channelRef: c.ref, title: c.title, flag: c.flag });
  }
  for (const p of parsed.playlistRows) {
    const id = 'pl:' + p.playlistId;
    if (seen.has(id) || !PLAYLIST_ID.test(String(p.playlistId || ''))) continue;
    if (!room()) { dropped += 1; continue; }
    seen.add(id);
    playlists.push({ playlistId: p.playlistId, title: p.title, flag: p.flag });
  }
  let ordinal = 0;
  for (const v of parsed.videoRows) {
    if (seen.has(v.key)) continue;
    if (!room()) { dropped += 1; continue; }
    seen.add(v.key);
    videos.push({
      key: v.key, type: v.type, id: v.id ?? null, url: v.url ?? null,
      srcUrl: v.srcUrl, driveId: v.driveId ?? null, title: v.title || '', rowIndex: ordinal
    });
    ordinal += 1;
  }

  const counts = {
    channels: channels.length, playlists: playlists.length, videos: videos.length,
    invalid: parsed.invalid.length, removed: parsed.removedKeys.length, dropped,
    total: channels.length + playlists.length + videos.length
  };
  return {
    ok: counts.total > 0,
    error: counts.total > 0 ? null : 'no-links',
    profileName: profileNameFromLines(s.split(/\r?\n/)),
    channels, playlists, videos,
    removedKeys: parsed.removedKeys, invalid: parsed.invalid, counts
  };
}

/* ============================ the I/O half ============================ */

/**
 * Read what an export needs. The SAME two-scope expression exportProfileSnapshot uses:
 * a profile's content lives in its personal scope and in its (possibly shared) library.
 * -> { subscriptions, channelMeta, videos }
 */
export async function collectLinksExport(profileId) {
  const db = await import('./db.js');
  const src = await db.getSources(profileId);
  const lib = src && src.libraryId;
  const scopes = [db.profScope(profileId), ...(lib ? [lib] : [])];

  const videos = [];
  for (const s of scopes) videos.push(...(await db.loadMergeIndex(s)).values());

  const subscriptions = lib ? await db.listLibraryChannels(lib) : [];
  const channelMeta = new Map();
  for (const c of subscriptions) {
    const ch = await db.getChannel(c.channelId);
    if (ch) channelMeta.set(c.channelId, { title: ch.title || '' });
  }
  return { subscriptions, channelMeta, videos };
}

/**
 * Apply a parsed plan to ONE profile. Dialogs live in app.js; this does the writes.
 *
 * NEVER writes a deny row (a removal line in an imported file must not deny a key on every
 * device forever), and never re-classifies by hand — the rows it receives are
 * classifySourceRow output.
 *
 * @param opts { reviveKeys:Set<string>, resolveRef(ref)->channelId|null, onProgress, now }
 * -> { channels, playlists, videos, existed, skippedDenied, revived, failed }
 */
export async function applyLinksPlan(profileId, plan, {
  reviveKeys = new Set(), resolveRef = null, onProgress = () => {}, now = Date.now()
} = {}) {
  const db = await import('./db.js');
  const src = await db.getSources(profileId);
  const scope = (src && src.libraryId) || db.profScope(profileId);
  const out = { channels: 0, playlists: 0, videos: 0, existed: 0, skippedDenied: 0, revived: 0, failed: 0 };

  const known = new Set((await db.listLibraryChannels(scope)).map((c) => c.channelId));
  const total = (plan.channels || []).length + (plan.playlists || []).length + (plan.videos || []).length;
  let done = 0;
  const tick = () => { done += 1; try { onProgress(done, total); } catch {} };

  let order = known.size;
  for (const row of plan.channels || []) {
    let channelId = null;
    try {
      channelId = row.channelRef && row.channelRef.by === 'id'
        ? row.channelRef.value
        : (resolveRef ? await resolveRef(row.channelRef) : null);
    } catch { channelId = null; }
    tick();
    // One bad ref must not kill the import (sync2's rule) — it is counted and named.
    if (!channelId) { out.failed += 1; continue; }
    if (known.has(channelId)) { out.existed += 1; continue; }
    known.add(channelId);
    order += 1;
    await db.putLibraryChannel(channelRowSubscription(
      { channelId, title: row.title, flag: row.flag }, { ...src, libraryId: scope }, { now, order }
    ));
    out.channels += 1;
  }

  for (const row of plan.playlists || []) {
    tick();
    if (known.has(row.playlistId)) { out.existed += 1; continue; }
    known.add(row.playlistId);
    order += 1;
    await db.putLibraryChannel(channelRowSubscription(
      { playlistId: row.playlistId, kind: 'playlist', title: row.title, flag: row.flag },
      { ...src, libraryId: scope }, { now, order }
    ));
    out.playlists += 1;
  }

  // Videos: ONE batch. Per-row puts (and per-row refreshes) are what made addClassifiedRow
  // the wrong helper for a 300-line file.
  const denied = new Set([...(await db.loadDenySet(scope)), ...(await db.loadDenySet(db.profScope(profileId)))]);
  const batch = [];
  for (const row of plan.videos || []) {
    tick();
    if (denied.has(row.key)) {
      if (!reviveKeys.has(row.key)) { out.skippedDenied += 1; continue; }
      // The one sanctioned revoke: unDeny writes `removedAt`, so the revocation is an EVENT
      // that out-merges a peer's stale ACTIVE tombstone (v1.0.10).
      for (const s of new Set([scope, db.profScope(profileId)])) await db.unDeny(s, row.key);
      out.revived += 1;
    }
    if (await db.getVideo(scope, row.key)) { out.existed += 1; continue; }
    const title = row.title || (row.type === 'file' ? titleFromFileUrl(row.srcUrl || row.url) : '');
    batch.push(manualVideoRecord({
      row, scope, title, origin: 'sheet-row', rowIndex: row.rowIndex,
      sortKey: sortKeyFor({ origin: 'sheet-row', rowIndex: row.rowIndex }), now
    }));
  }
  if (batch.length) {
    await db.putVideos(batch);
    out.videos = batch.length;
  }
  return out;
}
