// ytrss.js — keyless YouTube parsing helpers: the channel Atom feed
// (https://www.youtube.com/feeds/videos.xml?channel_id=UC…, newest ~15 uploads) and
// the channel-page logo extractor (v1.0.5).
// PURE and regex-based (no DOMParser) so it runs under `node --test`. The shapes are
// fixed and simple; a truncated body or an HTML error page must return ''/[] — a
// partial HTTP response must never crash sync.

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // LAST, or double-encoded entities decode twice
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

/**
 * The channel avatar URL out of a public channel page (v1.0.4/5 keyless-logo path):
 * og:image first (stable meta tag), the ytInitialData avatar JSON as fallback.
 * Handles both HTML entities (&amp;) and JSON escapes (&) in the URL.
 * Garbage/truncated input -> '' (the caller keeps the emoji fallback).
 */
export function extractChannelLogoFromHtml(html) {
  const s = String(html ?? '');
  // The JSON fallback must tolerate escapes INSIDE the url (&, \/) — a char
  // class that excludes backslash would silently fail the whole match on them.
  const m = s.match(/<meta property="og:image" content="([^"]+)"/)
    || s.match(/"avatar":\{"thumbnails":\[\{"url":"((?:\\.|[^"\\])*)"/);
  if (!m || !m[1]) return '';
  return m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/');
}

/**
 * v1.0.21 — is this feed entry a SHORT (or a live stream)? The feed carries no duration
 * and no dimensions, but every entry's `<link rel="alternate">` points at the form
 * YouTube itself considers canonical:
 *     <link rel="alternate" href="https://www.youtube.com/shorts/Gsn9eOqFOdA"/>   Short
 *     <link rel="alternate" href="https://www.youtube.com/watch?v=vMH1M0px_-s"/>  video
 * Measured 2026-07-31: 100% agreement with UUSH/UULF playlist membership over 60 videos
 * on 4 channels. Free, keyless, no extra request — this is what keeps Shorts out of the
 * INCREMENTAL (RSS) path, which the UULF playlist trick cannot reach.
 * Attribute order is not assumed. Unknown/missing link -> not a short: a wrongly HIDDEN
 * video is a visible bug, while a leaked Short is cosmetic.
 */
function altLinkKind(entry) {
  const linkRe = /<link\b[^>]*>/g;
  let m;
  while ((m = linkRe.exec(entry))) {
    if (!/rel\s*=\s*"alternate"/i.test(m[0])) continue;
    const href = m[0].match(/href\s*=\s*"([^"]*)"/i);
    if (!href) continue;
    if (/\/shorts\//i.test(href[1])) return 'short';
    if (/\/live\//i.test(href[1])) return 'live';
    return 'video';
  }
  return 'video';
}

/**
 * -> [{ videoId, title, publishedAt (epoch ms), channelId, channelTitle, thumbUrl,
 *       isShort, isLive }]
 * in feed order (newest first). Entries missing a videoId are skipped, never
 * emitted with an undefined key.
 */
export function parseYouTubeRss(xml) {
  const t = String(xml ?? '');
  if (!t.includes('<feed')) return [];
  const feedChannelId = tag(t.slice(0, t.indexOf('<entry') === -1 ? t.length : t.indexOf('<entry')), 'yt:channelId');
  const author = t.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/);
  const channelTitle = author ? decodeEntities(author[1].trim()) : '';

  const out = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(t))) {
    const e = m[1];
    const videoId = tag(e, 'yt:videoId');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const published = Date.parse(tag(e, 'published')) || 0;
    const thumb = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const kind = altLinkKind(e);
    out.push({
      videoId,
      title: decodeEntities(tag(e, 'title')),
      publishedAt: published,
      channelId: tag(e, 'yt:channelId') || feedChannelId,
      channelTitle,
      thumbUrl: thumb ? decodeEntities(thumb[1]) : '',
      isShort: kind === 'short',
      isLive: kind === 'live'
    });
  }
  return out;
}
