// classify.js — THE SAFETY BOUNDARY. Every link that enters the library passes through
// here; anything unrecognized is rejected (null). Moved out of store.js so it stays pure
// and node-testable; store.js re-exports for backward compatibility.
//
// Accepted: real YouTube video ids, Google Drive file links, https video files.
// New in the channels feature: channel/playlist references for the source sheet
// (parseChannelRef / classifySourceRow) and free-text extraction for Android
// share-intents (classifyFromSharedText).

export function extractYouTubeId(url) {
  const m = String(url).match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

export function driveFileId(url) {
  const s = String(url);
  let m = s.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = s.match(/drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)/); if (m) return m[1];
  m = s.match(/drive\.usercontent\.google\.com\/download\?(?:[^#]*&)?id=([A-Za-z0-9_-]+)/); if (m) return m[1];
  return null;
}

const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv|ogg)(\?|#|$)/i;

/** Returns null for anything that isn't a supported YouTube link or https video file. */
export function classifyLink(raw) {
  const s = String(raw || '').trim().replace(/^"+|"+$/g, '');
  if (!s) return null;

  const yt = extractYouTubeId(s);
  if (yt) return { type: 'youtube', id: yt, key: 'yt:' + yt, srcUrl: s };

  const did = driveFileId(s);
  if (did) {
    return {
      type: 'file', driveId: did,
      url: `https://drive.google.com/uc?export=download&id=${did}`,
      srcUrl: s, key: 'file:drive:' + did
    };
  }

  if (/^https:\/\//i.test(s) && VIDEO_EXT.test(s)) {
    return { type: 'file', url: s, srcUrl: s, key: 'file:' + s };
  }
  return null;
}

/**
 * F3 (start at 0): strip time hints from a playable URL. YouTube ids already discard
 * t= (only the 11-char id survives classifyLink), but media-fragment `#t=30` on a
 * direct file WILL seek, and t/start/time_continue query params may too.
 */
export function stripTimeHints(url) {
  let s = String(url || '');
  s = s.replace(/#t=[^#]*$/i, '');
  s = s.replace(/([?&])(?:t|start|time_continue)=[^&#]*/gi, '$1');
  s = s.replace(/\?&/g, '?').replace(/&&+/g, '&');
  s = s.replace(/[?&]+($|#)/, '$1');
  return s;
}

/**
 * Channel reference from a sheet row. Returns { by, value } or null.
 *   by: 'id'     — /channel/UC… (validated 24-char UC id; free, no API resolution needed)
 *       'handle' — /@handle, bare @handle
 *       'custom' — /c/Name   (legacy custom URL; needs resolution)
 *       'user'   — /user/Name (legacy username; needs resolution)
 */
/**
 * A handle's characters (v1.0.20 fix). Handles are NOT ASCII-only — `@חלומותחסידיים`
 * is a real channel — and the URL a parent copies out of the YouTube app arrives
 * PERCENT-ENCODED: `m.youtube.com/@%D7%97%D7%9C…`. The old `[A-Za-z0-9._-]` class
 * matched neither form, so both fell through to `kind:'invalid'` and the parent was
 * told "הלינק לא נתמך" for a perfectly good channel (reported from the field).
 * YouTube's own rule is 3-30 characters, letters/digits/underscore/hyphen/period.
 */
const HANDLE_CHARS = /^[\p{L}\p{N}._-]{3,30}$/u;

/** Percent-decoded when that yields a valid handle, otherwise the raw segment. */
function asHandle(segment) {
  const raw = String(segment || '');
  const dec = safeDecode(raw);
  if (HANDLE_CHARS.test(dec)) return dec;
  return HANDLE_CHARS.test(raw) ? raw : null;
}

export function parseChannelRef(url) {
  const s = String(url || '').trim().replace(/^"+|"+$/g, '');
  if (!s) return null;
  let m = s.match(/^@([^/?#\s]+)$/);
  if (m) { const h = asHandle(m[1]); if (h) return { by: 'handle', value: h }; }
  m = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/i);
  if (m) return { by: 'id', value: m[1] };
  m = s.match(/youtube\.com\/@([^/?#]+)/i);
  if (m) { const h = asHandle(m[1]); if (h) return { by: 'handle', value: h }; }
  m = s.match(/youtube\.com\/c\/([^/?#]+)/i);
  if (m) return { by: 'custom', value: safeDecode(m[1]) };
  m = s.match(/youtube\.com\/user\/([^/?#]+)/i);
  if (m) return { by: 'user', value: safeDecode(m[1]) };
  return null;
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

/**
 * Classify one input-sheet row (column A). Disambiguation rule (tested):
 * a watch URL that also carries &list= is a VIDEO — the watch link wins.
 */
/**
 * v1.0.12 — REMOVAL rows. A video that lives inside a channel has no row of its own
 * (the channel row represents all of them), so a per-video deletion is expressed as
 * a COMMENT row: `# הוסר: <link> — <title>`. Comment form on purpose: older app
 * versions skip comments entirely, so a removal can never resurrect content there.
 * Returns the removed video's key, or null when the comment isn't a removal row.
 * SAFETY: this only ever yields a key to DENY — never a playable record.
 */
const REMOVAL_MARKERS = /^#\s*(?:הוסר|הוסרו|removed|remove|deleted)\s*[:\-–]?\s*/i;
export function parseRemovalRow(raw) {
  const s = String(raw || '').trim().replace(/^"+|"+$/g, '');
  if (!s.startsWith('#') || !REMOVAL_MARKERS.test(s)) return null;
  const rest = s.replace(REMOVAL_MARKERS, '');
  const m = rest.match(/https?:\/\/[^\s<>"']+/);
  const c = classifyLink(m ? m[0].replace(/[)\]}>,.;:!?'"]+$/, '') : rest.split(/\s+/)[0]);
  return c ? { key: c.key } : null;
}

export function classifySourceRow(raw) {
  const s = String(raw || '').trim().replace(/^"+|"+$/g, '');
  if (!s) return { kind: 'blank', raw: s };
  if (s.startsWith('#')) {
    const rm = parseRemovalRow(s);
    // a removal row is NOT playable content — it only carries a key to deny
    return rm ? { kind: 'removed', key: rm.key, raw: s } : { kind: 'comment', raw: s };
  }

  const video = classifyLink(s);
  if (video) return { kind: 'video', ...video };

  const ch = parseChannelRef(s);
  if (ch) return { kind: 'channel', channelRef: ch };

  if (/youtube\.com|youtu\.be/i.test(s)) {
    const pl = s.match(/[?&]list=([A-Za-z0-9_-]{10,})/);
    if (pl) return { kind: 'playlist', playlistId: pl[1] };
  }
  return { kind: 'invalid', raw: s };
}

/**
 * F12b: extract a playable item from Android share-intent free text
 * ("Baby Shark https://youtu.be/ID?si=x", multi-line, trailing punctuation…).
 * Everything still funnels through classifyLink — the safety boundary holds.
 */
export function classifyFromSharedText(text, subject) {
  const s = String(text || '');
  for (const raw of (s.match(/https?:\/\/[^\s<>"']+/g) || [])) {
    const c = classifyLink(raw.replace(/[)\]}>,.;:!?'"]+$/, ''));
    if (!c) continue;
    const title = String(subject || '').trim() ||
      s.replace(/https?:\/\/[^\s<>"']+/g, ' ') // drop every URL, keep the human text
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return { ...c, title };
  }
  return null;
}

/**
 * v1.0.7: kind-typed share classification — videos AND whole channels.
 * Disambiguation matches classifySourceRow: a video link wins over anything else;
 * a channel reference is recognized only when NO video link exists in the text.
 * -> { kind:'video', …classifyLink fields, title } | { kind:'channel', channelRef, title } | null
 */
export function classifyShared(text, subject) {
  const video = classifyFromSharedText(text, subject);
  if (video) return { kind: 'video', ...video };
  const s = String(text || '');
  for (const raw of (s.match(/https?:\/\/[^\s<>"']+/g) || [])) {
    const ref = parseChannelRef(raw.replace(/[)\]}>,.;:!?'"]+$/, ''));
    if (!ref) continue;
    const title = String(subject || '').trim() ||
      s.replace(/https?:\/\/[^\s<>"']+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { kind: 'channel', channelRef: ref, title };
  }
  // v1.0.26 — a shared PLAYLIST. classifySourceRow has understood these since v1.0.12, but
  // the SHARE path never did, so sharing a playlist from YouTube answered "unsupported"
  // while pasting the identical link in the parent screen worked.
  for (const raw of (s.match(/https?:\/\/[^\s<>"']+/g) || [])) {
    const u = raw.replace(/[)\]}>,.;:!?'"]+$/, '');
    if (!/youtube\.com|youtu\.be/i.test(u)) continue;
    // A watch link merely CARRYING &list= is a video, and classifyFromSharedText above has
    // already claimed it — only a real /playlist link reaches here.
    if (!/\/playlist\b/i.test(u)) continue;
    const pl = u.match(/[?&]list=([A-Za-z0-9_-]{10,})/);
    if (!pl) continue;
    const title = String(subject || '').trim() ||
      s.replace(/https?:\/\/[^\s<>"']+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return { kind: 'playlist', playlistId: pl[1], title };
  }
  return null;
}

/**
 * v1.0.32 — PURE: a direct file's display name, from the filename in its link.
 * The add form's manual name field is gone, and an mp4 has no metadata to fetch —
 * this is what stands in: the last path segment, percent-DECODED (Hebrew filenames
 * arrive as %D7%…), extension stripped, separators (_-+) opened into spaces.
 * Anything unusable answers '' — a tile with no caption beats a caption of garbage —
 * and the result is capped like shared-text titles are.
 */
export function titleFromFileUrl(url) {
  if (typeof url !== 'string') return '';
  let path = url;
  try { path = new URL(url).pathname; } catch { /* not absolute — use as is */ }
  const seg = path.split('/').filter(Boolean).pop() || '';
  let name = seg;
  try { name = decodeURIComponent(seg); } catch { /* malformed %-escape: keep raw */ }
  name = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '') // extension (".mp4", ".webm") — never a Hebrew word
    .replace(/[_\-+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return name;
}
