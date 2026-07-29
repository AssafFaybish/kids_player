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
export function parseChannelRef(url) {
  const s = String(url || '').trim().replace(/^"+|"+$/g, '');
  if (!s) return null;
  let m = s.match(/^@([A-Za-z0-9._-]{3,30})$/);
  if (m) return { by: 'handle', value: m[1] };
  m = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?#]|$)/i);
  if (m) return { by: 'id', value: m[1] };
  m = s.match(/youtube\.com\/@([A-Za-z0-9._-]{3,30})(?:[/?#]|$)/i);
  if (m) return { by: 'handle', value: m[1] };
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
export function classifySourceRow(raw) {
  const s = String(raw || '').trim().replace(/^"+|"+$/g, '');
  if (!s) return { kind: 'blank', raw: s };
  if (s.startsWith('#')) return { kind: 'comment', raw: s };

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
