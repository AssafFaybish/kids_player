// yt.js — the pure pieces of the YouTube client. Everything else in that module is
// network I/O; what belongs under test is the URL a keyless resolution actually hits,
// because getting the encoding wrong looks exactly like "this channel doesn't exist".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { channelPageUrl } from '../www/js/yt.js';
import { parseChannelRef } from '../www/js/classify.js';

test('channelPageUrl encodes a NON-ASCII handle once, keeping the literal @', () => {
  const ref = parseChannelRef('https://m.youtube.com/@%D7%97%D7%9C%D7%95%D7%9E%D7%95%D7%AA%D7%97%D7%A1%D7%99%D7%93%D7%99%D7%99%D7%9D');
  const url = channelPageUrl(ref);
  assert.equal(url, 'https://www.youtube.com/@%D7%97%D7%9C%D7%95%D7%9E%D7%95%D7%AA%D7%97%D7%A1%D7%99%D7%93%D7%99%D7%99%D7%9D');
  assert.ok(url.includes('/@'), 'YouTube needs the @ literal — encoding it 404s');
  // The killer bug this pins: a handle stored still percent-encoded would be encoded
  // AGAIN here (encodeURI escapes '%'), and the request would 404 forever.
  assert.ok(!url.includes('%25'), 'double-encoded handle: ' + url);
  assert.equal(decodeURIComponent(url), 'https://www.youtube.com/@חלומותחסידיים');
});

test('channelPageUrl covers the legacy shapes and refuses what needs no resolution', () => {
  assert.equal(channelPageUrl({ by: 'handle', value: 'SuperSimpleSongs' }),
    'https://www.youtube.com/@SuperSimpleSongs');
  assert.equal(channelPageUrl({ by: 'user', value: 'OldUser' }), 'https://www.youtube.com/user/OldUser');
  assert.equal(channelPageUrl({ by: 'custom', value: 'Some Name' }), 'https://www.youtube.com/c/Some%20Name');
  // an id is already the answer — resolveChannelRef returns before scraping
  assert.equal(channelPageUrl({ by: 'id', value: 'UCabcdefghijklmnopqrstuv' }), null);
  for (const junk of [null, undefined, {}, { by: 'handle', value: '' }, { by: 'nope', value: 'x' }]) {
    assert.equal(channelPageUrl(junk), null, JSON.stringify(junk));
  }
});

test('every parseChannelRef shape that needs resolution produces a usable URL', () => {
  // The two modules have to agree: a ref the classifier accepts must be resolvable,
  // or an add succeeds at the parse step and then silently fails to find the channel.
  const urls = [
    'https://www.youtube.com/@HebrewKids',
    'https://m.youtube.com/@חלומותחסידיים',
    'https://www.youtube.com/c/SomeName',
    'https://www.youtube.com/user/OldUser'
  ];
  for (const u of urls) {
    const ref = parseChannelRef(u);
    assert.ok(ref, 'classifier rejected ' + u);
    const page = channelPageUrl(ref);
    assert.match(page, /^https:\/\/www\.youtube\.com\/(?:@|c\/|user\/)\S+$/, `${u} -> ${page}`);
    assert.doesNotMatch(page, /\s/, 'a raw space would break the request: ' + page);
  }
});

/* ---------------- handle resolution (v1.0.28, @RabbiRosenblum field bug) ---------------- */

test('extractChannelIdFromHtml: anchored shapes only — a decoy UC id must NOT win', async () => {
  const { extractChannelIdFromHtml } = await import('../www/js/yt.js');
  const REAL = 'UCJ3fCI2FnNMEeU2y-TcdU4Q';
  const DECOY = 'UCpAxY1yuagUKEiIQWVMh7mj';
  // the measured 2026 page shape: NO "channelId" key, a decoy UC string BEFORE the
  // real id, identity carried by externalId + the canonical link
  const modern = `...attribution "${DECOY}" ... href="/channel/${DECOY}/join" ...` +
    `"externalId":"${REAL}" ... <link rel="canonical" href="https://www.youtube.com/channel/${REAL}">`;
  assert.equal(extractChannelIdFromHtml(modern), REAL,
    'the decoy won — the app would subscribe to a STRANGER\'S channel');
  // canonical alone (the /c/ custom-URL case)
  assert.equal(extractChannelIdFromHtml(
    `x channel/${DECOY} y <link rel="canonical" href="https://www.youtube.com/channel/${REAL}">`), REAL);
  // the legacy shape still resolves (older cached pages)
  assert.equal(extractChannelIdFromHtml(`"channelId":"${REAL}"`), REAL);
  // @BARDAK613 (field): the page HAS a "channelId" key, but it is a DECOY — the real id
  // is in externalId. externalId must win over a decoy channelId, or the app subscribes
  // to a stranger's channel and imports 0 of this channel's videos.
  assert.equal(extractChannelIdFromHtml(
    `"channelId":"${DECOY}" ... "externalId":"${REAL}"`), REAL,
    'a decoy "channelId" beat the real externalId');
  // NO anchored shape ⇒ EMPTY, never the first UC-looking string: an occasional
  // failed resolve beats an occasional wrong channel in a child's library
  assert.equal(extractChannelIdFromHtml(`stuff channel/${DECOY} stuff`), '');
  assert.equal(extractChannelIdFromHtml(''), '');
  assert.equal(extractChannelIdFromHtml(null), '');
});

test('resolveChannelRef: only ENRICHMENT trusts the cache first; ADD paths resolve live', () => {
  // TWO field bugs pinned here, both from real channels (@RabbiRosenblum, @BARDAK613):
  //  - the scrape must use the ANCHORED extractor, never the loose first-`channel/UC`;
  //  - a poisoned entry must heal on EVERY add path, INCLUDING a keyless release.
  // v1.0.29 keyed the cache-first shortcut on `!key`, which broke on a keyless build
  // (keys.local.js is gitignored, so a release without it ships no key): the ADD path
  // then passed '' too and returned the poisoned decoy forever. The shortcut is now gated
  // on an explicit `cacheFirst` OPT-IN that ONLY the per-video enrichment caller passes.
  const src = readFileSync(new URL('../www/js/yt.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function resolveChannelRef('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // the early cache return is gated on cacheFirst, never on the key
  assert.match(body, /if \(cacheFirst && map\[ck\]\) return map\[ck\]/,
    'the early cache return is not gated on cacheFirst — a keyless add can return a stale id');
  assert.doesNotMatch(body, /if \(!key && map\[ck\]\)/, 'the !key cache shortcut is back (breaks keyless releases)');
  // live scrape sits before the last-resort cache return
  const scrapeAt = body.indexOf('extractChannelIdFromHtml(');
  const finalCacheAt = body.indexOf('return map[ck] || null');
  assert.ok(scrapeAt > 0 && finalCacheAt > 0 && scrapeAt < finalCacheAt,
    'the cache is returned before the live scrape — a poisoned entry is permanent');
  assert.doesNotMatch(src, /match\(\/channel\\\/\(UC\[A-Za-z0-9_-\]\{22\}\)\//,
    'the loose first-UC-in-page pattern is back');
  // EXACTLY ONE caller opts into cache-first — the per-video enrichment. Any new
  // cacheFirst caller must be a deliberate, reviewed choice (it can serve a stale id).
  assert.equal((src.match(/cacheFirst: true/g) || []).length, 1,
    'a second cacheFirst caller appeared — an add/sheet path must resolve live');
})

test('extractChannelIdFromHtml: the MOBILE page resolves — its identity lives in the feed link and og/twitter metas', async () => {
  // FIELD BUG №2 (@BARDAK613, v1.0.32): a mobile user-agent (the tablet WebView, or the
  // native HTTP layer's Dalvik default) is redirected to m.youtube.com, whose page has NO
  // externalId and NO canonical-channel link — while carrying FIVE decoy "channelId"
  // occurrences (measured live). Every earlier fix verified in a desktop browser, which
  // gets the www page — exactly why the bug kept passing verification and failing on the
  // device. The mobile page names its identity in its RSS alternate link and in
  // og:url/twitter:url metas; those must win over the decoy-prone legacy key.
  const { extractChannelIdFromHtml } = await import('../www/js/yt.js');
  const REAL = 'UCjftf4k2ZNX32zFwXjWXxLA';   // the real @BARDAK613
  const DECOY = 'UCFhhYk_qxfupMCOVO1rs0Cg';  // the decoy its pages actually carry

  // the measured m.youtube.com shape: decoy "channelId" keys, identity ONLY in the metas
  const mobile = `"channelId":"${DECOY}" ...`
    + `<link rel="alternate" type="application/rss+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=${REAL}">`
    + `<meta property="og:url" content="https://www.youtube.com/channel/${REAL}">`
    + `... "channelId":"${DECOY}"`;
  assert.equal(extractChannelIdFromHtml(mobile), REAL,
    'the decoy channelId beat the mobile page\'s own identity — the @BARDAK613 recurrence');

  // each mobile anchor alone suffices
  assert.equal(extractChannelIdFromHtml(
    `href="https://www.youtube.com/feeds/videos.xml?channel_id=${REAL}"`), REAL);
  assert.equal(extractChannelIdFromHtml(
    `<meta property="og:url" content="https://www.youtube.com/channel/${REAL}">`), REAL);
  assert.equal(extractChannelIdFromHtml(
    `<meta name="twitter:url" content="https://www.youtube.com/channel/${REAL}">`), REAL);
  // og:url pointing at the /channel/ form may carry a query suffix (al: variants do)
  assert.equal(extractChannelIdFromHtml(
    `<meta property="og:url" content="https://www.youtube.com/channel/${REAL}?feature=applinks">`), REAL);

  // an og:url in the @handle form anchors NOTHING — it names no UC id
  assert.equal(extractChannelIdFromHtml(
    `<meta property="og:url" content="https://www.youtube.com/@SomeHandle"> channel/${DECOY}`), '');
  // and externalId still outranks every new shape (the www page's primary key)
  assert.equal(extractChannelIdFromHtml(
    `href="https://www.youtube.com/feeds/videos.xml?channel_id=${DECOY}" "externalId":"${REAL}"`), REAL);
});
