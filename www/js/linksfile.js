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

/**
 * One `link[ ,name[,flag]]` line with no trailing empty columns.
 *
 * v1.0.93 — THE SPACE BEFORE THE FIRST COMMA KEEPS THE LINK CLICKABLE once the list is
 * pasted into a chat or a mail (the copy button exists for exactly that). Linkifiers treat
 * ',' as part of a URL path, so `…/channel/UC…,Cocomelon,auto` became ONE link that opened a
 * channel that does not exist. parseSourceRows trims every field, so the import — this app's
 * and every older one — reads the line exactly as before. The space goes BEFORE the comma,
 * never after it: parseCsv opens a quote only at a field's very first character, so
 * `link, "a, b"` would split a quoted title in two.
 *
 * The link itself goes through csvField too: a direct-file URL may carry a comma, and an
 * unquoted one split the line at it (a canonical YouTube link never needs quoting).
 */
function rowLine(link, name, flag) {
  const rest = [csvField(name), flag || ''];
  while (rest.length && !rest[rest.length - 1]) rest.pop();
  const head = csvField(link);
  return rest.length ? `${head} ,${rest.join(',')}` : head;
}

const ZERO_COUNTS = () => ({ channels: 0, playlists: 0, videos: 0, files: 0, skipped: 0 });
const rowsIn = (counts) => (counts.channels | 0) + (counts.playlists | 0) + (counts.videos | 0);

/**
 * PURE: the body lines of ONE profile, and what they hold. Shared by the single-profile
 * file and every section of a multi-profile one (v1.0.93), so the two can never disagree
 * about which records get a line.
 *
 * WHICH VIDEOS GET A LINE: only those NO subscription reproduces (plan.coveredBySubscription
 * — planOrphanGC's rule read forwards). And only `state === 'live'`: a pending share has
 * not been decided, and a rejected video must never travel as a plain add (resolveCuration).
 *
 * ORDER is deterministic — channels (title, then id), playlists, then videos by
 * compareForDisplay — so re-exporting an unchanged library is byte-identical and two
 * exports diff cleanly. Line order becomes `rowIndex` on import.
 */
function linksBody({ subscriptions = [], channelMeta = null, videos = [] } = {}) {
  const meta = channelMeta instanceof Map ? channelMeta : new Map(Object.entries(channelMeta || {}));
  const subs = [...subscriptions].filter((c) => c && c.channelId);
  const titleOf = (c) => String(c.titleOverride || (meta.get(c.channelId) || {}).title || '').trim();

  const counts = ZERO_COUNTS();
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
  return { body, counts };
}

/**
 * PURE: the whole file for ONE profile.
 * -> { text, lines, counts: { channels, playlists, videos, files, skipped } }
 */
export function serializeLinksFile({ subscriptions = [], channelMeta = null, videos = [],
  profileName = '', exportedAt = Date.now(), appVersion = '' } = {}) {
  const { body, counts } = linksBody({ subscriptions, channelMeta, videos });
  const lines = [...linksFileHeader({ profileName, exportedAt, appVersion }), ...body];
  return { text: lines.join('\n') + '\n', lines, counts };
}

/* ======================= several profiles in one list (v1.0.93) ======================= */

/**
 * The SECTION MARKER of a multi-profile list: `# ===== פרופיל: נועם =====`.
 *
 * DELIBERATELY NOT the single-profile `# פרופיל:` marker. An app older than v1.0.93 reads
 * that one (profileNameFromLines) and offers "create a new profile named X" — so a family
 * list carrying it would have become ONE new profile holding every child's content. The
 * `=====` in front means the old regex never matches: an older app sees comments, imports
 * everything into the profile it is told to, and offers no misleading new profile.
 * Every marker line starts with '#', so to any reader it is a comment first.
 */
export const SECTION_RE = /^#\s*=+\s*(?:פרופיל|profile)\s*[:\-–]\s*(.*?)\s*=*\s*$/;
export const sectionMarkerLine = (name) => `# ===== פרופיל: ${String(name || '').trim()} =====`;

/**
 * PURE: the profile name a section marker carries — null when the line is not a marker,
 * '' for a marker with no usable name. The name passes through normalizeProfileName for the
 * same reason the single-profile marker's does: it may become a real child's profile.
 */
export function sectionNameOf(line) {
  const m = String(line ?? '').trim().match(SECTION_RE);
  if (!m) return null;
  const val = m[1].trim();
  if (!val || /https?:\/\//i.test(val)) return '';
  return normalizeProfileName(val);
}

/**
 * PURE: the export of one OR SEVERAL profiles — what both "📤 export to a file" and
 * "📋 copy" produce, so a pasted list and an imported file are the same input.
 *
 * ONE profile with content ⇒ exactly serializeLinksFile's output (the `# פרופיל:` header an
 * older app understands, and the "new profile named X" offer on import). TWO OR MORE ⇒ one
 * shared header with no profile name, then a section per profile in the order given.
 *
 * A profile with NOTHING to export gets no section and is named in `empty`: an empty
 * section would make the import create a profile with nothing in it, and a parent who
 * ticked three children should be told why the list names two.
 *
 * @param profiles [{ profileName, subscriptions, channelMeta, videos }]
 * -> { text, lines, counts (totals), profiles: [{ name, counts }], empty: [name], sections }
 */
export function serializeLinksExport({ profiles = [], exportedAt = Date.now(), appVersion = '' } = {}) {
  const built = (Array.isArray(profiles) ? profiles : []).filter(Boolean).map((p) => ({
    name: String(p.profileName || '').trim(),
    ...linksBody(p)
  }));
  const full = built.filter((b) => rowsIn(b.counts) > 0);
  const empty = built.filter((b) => rowsIn(b.counts) === 0).map((b) => b.name);
  const summary = full.map((b) => ({ name: b.name, counts: b.counts }));

  if (full.length <= 1) {
    const one = full[0] || built[0] || { name: '', body: [], counts: ZERO_COUNTS() };
    const lines = [...linksFileHeader({ profileName: one.name, exportedAt, appVersion }), ...one.body];
    return { text: lines.join('\n') + '\n', lines, counts: one.counts, profiles: summary, empty, sections: full.length };
  }

  const counts = ZERO_COUNTS();
  const lines = [...linksFileHeader({ profileName: '', exportedAt, appVersion })];
  // No comma and no quote in a header line: parseCsv splits a comment like any other row,
  // and the section test re-joins it — keeping header prose plain keeps that trivial.
  lines.push(`# ברשימה ${full.length} פרופילים — כל פרופיל בקטע משלו`);
  for (const b of full) {
    lines.push('#', sectionMarkerLine(b.name), ...b.body);
    for (const k of Object.keys(counts)) counts[k] += b.counts[k] | 0;
  }
  return { text: lines.join('\n') + '\n', lines, counts, profiles: summary, empty, sections: full.length };
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
    counts: { channels: 0, playlists: 0, videos: 0, invalid: 0, removed: 0, total: 0, dropped: 0 },
    sections: []
  };
  let s;
  try { s = String(text ?? ''); } catch { return { ...empty, error: 'html' }; }
  if (!s.trim()) return empty;
  if (s.length > Math.max(1, maxBytes | 0)) return { ...empty, error: 'too-big' };
  if (looksLikeHtml(s)) return { ...empty, error: 'html' };

  let plans;
  let marked = false;
  try {
    // v1.0.93 — split into PROFILE SECTIONS. A marker is a COMMENT row, tested on the whole
    // line re-joined: a profile name may carry a comma, which parseCsv has already split.
    // Rows before the first marker are the unnamed section (a hand-edited list's stray
    // lines); same-named sections merge — the name IS the identity on import.
    const groups = new Map([['', []]]);
    let cur = groups.get('');
    for (const fields of parseCsv(s)) {
      const f = Array.isArray(fields) ? fields : [];
      const name = String(f[0] ?? '').trim().startsWith('#') ? sectionNameOf(f.join(',')) : null;
      if (name !== null) {
        marked = true;
        if (!groups.has(name)) groups.set(name, []);
        cur = groups.get(name);
        continue;
      }
      cur.push(fields);
    }
    plans = [...groups].map(([name, rows]) => ({ name, ...planRows(rows, max) }));
  } catch {
    // parseCsv and parseSourceRows are both documented never-throw, but a parser that is
    // "total by inspection" is not total: a future edit must not turn a bad file into a
    // crash on the parent's screen.
    return { ...empty, error: 'html' };
  }

  // The union is the "everything into ONE profile" answer, and the only shape an old,
  // unmarked file ever had — so for one section it IS that section, line for line.
  const union = unionPlans(plans, max);
  const counts = union.counts;
  const sections = plans.filter((p) => p.counts.total > 0);
  const profileName = !marked
    ? profileNameFromLines(s.split(/\r?\n/))
    : (sections.length === 1 ? sections[0].name : '');
  if (!marked && sections.length === 1) sections[0].name = profileName;
  return {
    ok: counts.total > 0,
    error: counts.total > 0 ? null : 'no-links',
    profileName,
    channels: union.channels, playlists: union.playlists, videos: union.videos,
    removedKeys: union.removedKeys, invalid: union.invalid, counts,
    sections
  };
}

/**
 * PURE: one group of tokenized rows -> a deduped, capped import plan. What a whole
 * single-profile file reduces to, and what every section of a multi-profile one does.
 */
function planRows(rows, max) {
  const parsed = parseSourceRows(rows);
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
  return { channels, playlists, videos, removedKeys: parsed.removedKeys, invalid: parsed.invalid, counts };
}

/**
 * PURE: several section plans as ONE — deduped across sections, re-capped, and the videos
 * re-numbered so line order is still `rowIndex`. For a single plan it is that plan.
 */
function unionPlans(plans, max) {
  const cap = Math.max(1, max | 0);
  const seen = new Set();
  const channels = [];
  const playlists = [];
  const videos = [];
  const removed = new Set();
  const invalid = [];
  let dropped = 0;
  const room = () => channels.length + playlists.length + videos.length < cap;
  const take = (id, push) => {
    if (seen.has(id)) return;
    if (!room()) { dropped += 1; return; }
    seen.add(id);
    push();
  };
  for (const p of plans) {
    dropped += p.counts.dropped | 0;
    for (const k of p.removedKeys) removed.add(k);
    invalid.push(...p.invalid);
    for (const c of p.channels) take('ch:' + c.channelRef.by + ':' + c.channelRef.value, () => channels.push(c));
    for (const pl of p.playlists) take('pl:' + pl.playlistId, () => playlists.push(pl));
    for (const v of p.videos) take(v.key, () => videos.push({ ...v, rowIndex: videos.length }));
  }
  const counts = {
    channels: channels.length, playlists: playlists.length, videos: videos.length,
    invalid: invalid.length, removed: removed.size, dropped,
    total: channels.length + playlists.length + videos.length
  };
  return { channels, playlists, videos, removedKeys: [...removed], invalid, counts };
}

/**
 * PURE (v1.0.93): which local profile each section of a multi-profile list goes to, when
 * the parent answers "every list to its own profile".
 *
 * The NAME is the identity — the same whitespace-collapsed comparison profileNameExists
 * uses, because a profile name is unique per Google account (v1.0.22). A name with no local
 * profile is to be CREATED; the caller must have pulled Drive first, or a sibling that
 * exists only on another device would be minted twice. A section with no name (stray
 * lines above the first marker) goes to the active profile.
 * -> [{ section, name, profileId|null, create }]
 */
export function matchSectionTargets({ sections = [], profiles = [], activeId = null } = {}) {
  const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const list = (Array.isArray(profiles) ? profiles : []).filter((p) => p && p.id);
  return (Array.isArray(sections) ? sections : []).filter(Boolean).map((section) => {
    const name = norm(section.name);
    if (!name) return { section, name: '', profileId: activeId || null, create: false };
    const hit = list.find((p) => norm(p.name) === name);
    return hit
      ? { section, name, profileId: hit.id, create: false }
      : { section, name, profileId: null, create: true };
  });
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
