// ytrss.js — parse YouTube's channel Atom feed (https://www.youtube.com/feeds/videos.xml
// ?channel_id=UC…). Keyless, quota-free, returns the newest ~15 uploads.
// PURE and regex-based (no DOMParser) so it runs under `node --test`. The Atom shape is
// fixed and simple; a truncated body or an HTML error page must return [] — a partial
// HTTP response must never crash sync.

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
 * -> [{ videoId, title, publishedAt (epoch ms), channelId, channelTitle, thumbUrl }]
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
    out.push({
      videoId,
      title: decodeEntities(tag(e, 'title')),
      publishedAt: published,
      channelId: tag(e, 'yt:channelId') || feedChannelId,
      channelTitle,
      thumbUrl: thumb ? decodeEntities(thumb[1]) : ''
    });
  }
  return out;
}
