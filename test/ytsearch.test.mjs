// ytsearch.js — the pure half of the parent's YouTube search. The fixtures below are
// TRIMMED REAL SHAPES captured live from the youtubei endpoint (2026-08-06, WEB client,
// hl=he) — videoRenderer/channelRenderer/lockupViewModel/officialCardViewModel — so a
// parser change that stops matching production shapes fails here first. The Shorts and
// RD-mix filters are pinned planted-regression style: the forbidden item sits between
// two legitimate ones, so a filter that silently dies keeps the neighbors AND leaks the
// planted row — which this suite must catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchBody, buildBrowseBody, parseSearchResponse, parseBrowseResponse,
  parseSuggestions, searchMessage, suggestUrl
} from '../www/js/ytsearch.js';

/* ---------------- fixture builders (real shapes, trimmed) ---------------- */

const VID_A = 'sFU5TdYp8u8';
const VID_B = 'WRVsOCh907o';
const VID_SHORT = 'aaaaaaaaaaa';
const CH_REAL = 'UCWF5vshm5UfF59-rtvsE5WA';
const CH_DECOY = 'UCfXdCQfn2Wly74kX-vyPubw';

function vid(id, title, extra = {}) {
  return {
    videoRenderer: {
      videoId: id,
      title: { runs: [{ text: title }] },
      ownerText: { runs: [{ text: 'ערוץ פלא' }] },
      lengthText: { simpleText: '54:30' },
      publishedTimeText: { simpleText: 'לפני שנה' },
      viewCountText: { simpleText: '1,234,567 צפיות' },
      shortViewCountText: { simpleText: '1.2M צפיות' },
      thumbnail: {
        thumbnails: [
          { url: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg', width: 480 },
          { url: 'https://i.ytimg.com/vi/' + id + '/hq720.jpg', width: 720 }
        ]
      },
      navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=' + id } } },
      thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '54:30' }, style: 'DEFAULT' } }],
      ...extra
    }
  };
}

function channel(id) {
  return {
    channelRenderer: {
      channelId: id,
      title: { simpleText: 'רותמאמא - תכנים לקטנטנים' },
      videoCountText: { simpleText: '96.8K מנויים' },
      // protocol-relative — the REAL shape channel avatars arrive in
      thumbnail: { thumbnails: [{ url: '//yt3.googleusercontent.com/abc=s88', width: 88 }] }
    }
  };
}

function lockupPlaylist(id, title) {
  return {
    lockupViewModel: {
      contentId: id,
      contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST',
      contentImage: {
        collectionThumbnailViewModel: {
          primaryThumbnail: {
            thumbnailViewModel: {
              image: { sources: [{ url: 'https://i.ytimg.com/vi/' + VID_B + '/hq720.jpg', width: 720 }] }
            }
          }
        }
      },
      metadata: { lockupMetadataViewModel: { title: { content: title } } }
    }
  };
}

function officialCard({ headerId = 'UCbCmjCuTUZos6Inko4u57UQ', extraHeaderId = null } = {}) {
  const headerEndpoints = [
    { navigationEndpoint: { browseEndpoint: { browseId: headerId } } },
    { onTap: { innertubeCommand: { browseEndpoint: { browseId: extraHeaderId || headerId, canonicalBaseUrl: '/@CoComelon' } } } }
  ];
  return {
    officialCardViewModel: {
      header: {
        pageHeaderViewModel: {
          title: { dynamicTextViewModel: { text: { content: 'Cocomelon' } } },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: '@CoComelon' } }] },
                { metadataParts: [{ text: { content: '202M מנויים' } }, { text: { content: '2K סרטונים' } }] }
              ]
            }
          },
          image: { decoratedAvatarViewModel: { avatar: { avatarViewModel: { image: { sources: [{ url: 'https://yt3.googleusercontent.com/cocoAvatar=s160', width: 160 }] } } } } }
        },
        links: headerEndpoints
      },
      // the card's CONTENTS carry FOREIGN related-channel ids (measured live) —
      // an unanchored "first UC wins" parser subscribes the family to a stranger
      contents: [{ related: { browseEndpoint: { browseId: CH_DECOY } } }]
    }
  };
}

function firstPage(items, token = 'TOK_NEXT') {
  const contents = [{ itemSectionRenderer: { contents: items } }];
  if (token) contents.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents } } } } };
}

function continuationPage(items, token = null) {
  const continuationItems = [{ itemSectionRenderer: { contents: items } }];
  if (token) continuationItems.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return { onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems } }] };
}

/* ---------------- buildSearchBody ---------------- */

test('buildSearchBody: hl=he context, typed filters, and NEVER an API key', () => {
  const b = buildSearchBody('בוב הבנאי');
  assert.equal(b.query, 'בוב הבנאי');
  assert.equal(b.context.client.clientName, 'WEB');
  assert.equal(b.context.client.hl, 'he');
  assert.equal(b.context.client.gl, 'IL');
  assert.equal(b.params, undefined, 'the "all" filter must send NO params');

  assert.equal(buildSearchBody('x', { filter: 'video' }).params, 'EgIQAQ==');
  assert.equal(buildSearchBody('x', { filter: 'channel' }).params, 'EgIQAg==');
  assert.equal(buildSearchBody('x', { filter: 'playlist' }).params, 'EgIQAw==');
  assert.equal(buildSearchBody('x', { filter: 'nonsense' }).params, undefined, 'unknown filter = unfiltered, never a crash');

  // THE invariant at the unit level: this endpoint never sees a key of any kind.
  for (const body of [b, buildSearchBody('x', { filter: 'video' }), buildSearchBody('x', { continuation: 'T' })]) {
    assert.doesNotMatch(JSON.stringify(body), /"key"|apiKey|AIza/i, 'an API key leaked into the search body');
  }
});

test('buildSearchBody: a continuation body carries ONLY context+token', () => {
  const b = buildSearchBody('ignored', { filter: 'video', continuation: 'TOK123' });
  assert.deepEqual(Object.keys(b).sort(), ['context', 'continuation']);
  assert.equal(b.continuation, 'TOK123');
  // resending query/params beside a token restarts the search from page one
  assert.equal(b.query, undefined);
  assert.equal(b.params, undefined);
});

/* ---------------- parseSearchResponse: shapes ---------------- */

test('first page: videos, channels and playlists map with their real fields', () => {
  const r = parseSearchResponse(firstPage([
    vid(VID_A, 'בוב הבנאי - 5 פרקים ברצף'),
    channel(CH_REAL),
    lockupPlaylist('PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug', 'בוב הבנאי')
  ]));
  assert.ok(r, 'a recognized document parsed as null');
  assert.equal(r.continuation, 'TOK_NEXT');
  assert.equal(r.items.length, 3);

  const [v, c, p] = r.items;
  assert.deepEqual(v, {
    type: 'video', id: VID_A, url: 'https://www.youtube.com/watch?v=' + VID_A,
    title: 'בוב הבנאי - 5 פרקים ברצף', channelTitle: 'ערוץ פלא', durationText: '54:30',
    publishedText: 'לפני שנה', viewCountText: '1.2M צפיות',
    thumbUrl: 'https://i.ytimg.com/vi/' + VID_A + '/hq720.jpg'
  });
  assert.equal(c.type, 'channel');
  assert.equal(c.id, CH_REAL);
  assert.equal(c.url, 'https://www.youtube.com/channel/' + CH_REAL);
  assert.equal(c.subText, '96.8K מנויים');
  // protocol-relative avatar normalized — an <img src="//…"> works, but the record
  // must store a real https URL like every other thumb in the app
  assert.equal(c.thumbUrl, 'https://yt3.googleusercontent.com/abc=s88');
  assert.equal(p.type, 'playlist');
  assert.equal(p.url, 'https://www.youtube.com/playlist?list=PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug');
  assert.equal(p.title, 'בוב הבנאי');
});

test('continuation shape parses too, and its token chains', () => {
  const r = parseSearchResponse(continuationPage([vid(VID_A, 'א')], 'TOK_MORE'));
  assert.ok(r);
  assert.equal(r.items.length, 1);
  assert.equal(r.continuation, 'TOK_MORE');
  // last page: no token
  assert.equal(parseSearchResponse(continuationPage([vid(VID_A, 'א')])).continuation, null);
});

test('unrecognized document -> null; recognized-but-empty -> {items:[]} — different facts', () => {
  // null is the "YouTube changed something" alarm; [] is a real "no results".
  assert.equal(parseSearchResponse(null), null);
  assert.equal(parseSearchResponse({}), null);
  assert.equal(parseSearchResponse({ contents: { somethingElse: {} } }), null);
  const empty = parseSearchResponse(firstPage([], null));
  assert.ok(empty, 'an empty result page must NOT read as a parse failure');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.continuation, null);
});

test('videos inside a shelfRenderer are collected (the "people also watched" shelf)', () => {
  const shelf = { shelfRenderer: { title: { simpleText: 'x' }, content: { verticalListRenderer: { items: [vid(VID_B, 'מתוך מדף')] } } } };
  const r = parseSearchResponse(firstPage([shelf]));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, VID_B);
});

test('duplicates collapse to one row (a video can appear straight AND inside a shelf)', () => {
  const shelf = { shelfRenderer: { content: { verticalListRenderer: { items: [vid(VID_A, 'שוב')] } } } };
  const r = parseSearchResponse(firstPage([vid(VID_A, 'פעם'), shelf]));
  assert.equal(r.items.length, 1);
});

test('malformed ids are dropped: a 10-char video id and a non-UC channel id', () => {
  const r = parseSearchResponse(firstPage([
    vid('shortid123', 'לא תקין'),
    { channelRenderer: { channelId: 'PLnotachannel', title: { simpleText: 'x' } } },
    vid(VID_A, 'תקין')
  ]));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, VID_A);
});

/* ---------------- the Shorts filter (the parent's decision: NONE, anywhere) ---------------- */

test('a videoRenderer carrying the SHORTS overlay is dropped, its neighbors survive', () => {
  const short = vid(VID_SHORT, 'שורט מוסווה');
  short.videoRenderer.thumbnailOverlays = [
    { thumbnailOverlayTimeStatusRenderer: { text: { simpleText: '0:58' }, style: 'SHORTS' } }
  ];
  const r = parseSearchResponse(firstPage([vid(VID_A, 'לפני'), short, vid(VID_B, 'אחרי')]));
  assert.deepEqual(r.items.map((i) => i.id), [VID_A, VID_B],
    'the SHORTS-overlay filter died — a Short reached the result list');
});

test('a videoRenderer navigating to /shorts/ is dropped even without the overlay', () => {
  const short = vid(VID_SHORT, 'שורט בניווט');
  short.videoRenderer.thumbnailOverlays = [];
  short.videoRenderer.navigationEndpoint = {
    commandMetadata: { webCommandMetadata: { url: '/shorts/' + VID_SHORT } }
  };
  const byUrl = parseSearchResponse(firstPage([short, vid(VID_A, 'רגיל')]));
  assert.deepEqual(byUrl.items.map((i) => i.id), [VID_A]);

  const reel = vid(VID_SHORT, 'שורט reel');
  reel.videoRenderer.thumbnailOverlays = [];
  reel.videoRenderer.navigationEndpoint = { reelWatchEndpoint: { videoId: VID_SHORT } };
  const byReel = parseSearchResponse(firstPage([reel, vid(VID_A, 'רגיל')]));
  assert.deepEqual(byReel.items.map((i) => i.id), [VID_A]);
});

test('a reelShelfRenderer (the Shorts shelf) is dropped WHOLESALE', () => {
  const reelShelf = { reelShelfRenderer: { items: [ { reelItemRenderer: { videoId: VID_SHORT } }, vid(VID_SHORT, 'בתוך המדף') ] } };
  const r = parseSearchResponse(firstPage([vid(VID_A, 'לפני'), reelShelf, vid(VID_B, 'אחרי')]));
  assert.deepEqual(r.items.map((i) => i.id), [VID_A, VID_B],
    'the Shorts shelf leaked into the results');
});

/* ---------------- the mix filter ---------------- */

test('an RD… mix is dropped, a real PL… playlist survives beside it', () => {
  const r = parseSearchResponse(firstPage([
    lockupPlaylist('RDEMqoGUgNWsf_NaVYG4SU5N8g', 'מיקס – Cocomelon'), // real captured mix id
    lockupPlaylist('PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug', 'רשימה אמיתית')
  ]));
  assert.equal(r.items.length, 1, 'the RD-mix filter died — a mix reached the result list');
  assert.equal(r.items[0].id, 'PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug');
});

/* ---------------- the official-artist card ---------------- */

test('officialCard: identity is anchored to the HEADER; the contents\' foreign ids never leak', () => {
  const r = parseSearchResponse(firstPage([officialCard()]));
  assert.equal(r.items.length, 1);
  const c = r.items[0];
  assert.equal(c.type, 'channel');
  assert.equal(c.id, 'UCbCmjCuTUZos6Inko4u57UQ', 'the card resolved to a foreign related-channel id');
  assert.equal(c.title, 'Cocomelon');
  assert.match(c.subText, /מנויים/);
  assert.equal(c.thumbUrl, 'https://yt3.googleusercontent.com/cocoAvatar=s160');
});

test('officialCard with CONFLICTING header ids is skipped — ambiguity must not guess', () => {
  // the @RabbiRosenblum lesson: an occasionally missing channel row beats an
  // occasionally WRONG one; the ערוצים chip still finds the real channelRenderer
  const r = parseSearchResponse(firstPage([officialCard({ extraHeaderId: CH_DECOY }), vid(VID_A, 'רגיל')]));
  assert.deepEqual(r.items.map((i) => i.type), ['video']);
});

/* ---------------- browsing INSIDE a channel / playlist result (v1.0.33) ---------------- */

// the measured browse-lockup shape: video lockup with the duration on the thumbnail's
// corner badge and views/age in the metadata rows
function browseLockup(id, title, { duration = '25:39', shorts = false } = {}) {
  return {
    lockupViewModel: {
      contentId: id,
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: 'https://i.ytimg.com/vi/' + id + '/hq720.jpg', width: 720 }] },
          overlays: [{
            thumbnailBottomOverlayViewModel: {
              badges: [{ thumbnailBadgeViewModel: { text: duration, badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }]
            }
          }]
        }
      },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: title },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [{ metadataParts: [{ text: { content: '406K צפיות' } }, { text: { content: 'לפני חודשיים' } }] }]
            }
          }
        }
      },
      rendererContext: {
        commandContext: { onTap: { innertubeCommand: { commandMetadata: { webCommandMetadata: {
          url: shorts ? '/shorts/' + id : '/watch?v=' + id
        } } } } }
      }
    }
  };
}

function channelBrowsePage(items, token = 'B_TOK') {
  const contents = items.map((it) => ({ richItemRenderer: { content: it } }));
  if (token) contents.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          { tabRenderer: { title: 'בית' } }, // unselected tabs carry NO content (measured)
          { tabRenderer: { title: 'סרטונים', content: { richGridRenderer: { contents } } } }
        ]
      }
    }
  };
}

function playlistBrowsePage(items, token = 'P_TOK') {
  const sections = [{ itemSectionRenderer: { contents: items } }];
  if (token) sections.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: sections } } } }]
      }
    }
  };
}

test('buildBrowseBody: channel = Videos-tab params, playlist = VL prefix, never a key', () => {
  const ch = buildBrowseBody({ kind: 'channel', id: 'UCWF5vshm5UfF59-rtvsE5WA' });
  assert.equal(ch.browseId, 'UCWF5vshm5UfF59-rtvsE5WA');
  assert.ok(ch.params, 'a channel browse without the Videos-tab params lands on the Home tab');
  const pl = buildBrowseBody({ kind: 'playlist', id: 'PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug' });
  assert.equal(pl.browseId, 'VLPLsJS3uJXxKz9worTXC-m35wB-nQXSRGug');
  assert.equal(pl.params, undefined);
  const cont = buildBrowseBody({ kind: 'channel', id: 'UCx' }, { continuation: 'T9' });
  assert.deepEqual(Object.keys(cont).sort(), ['context', 'continuation']);
  for (const b of [ch, pl, cont]) {
    assert.doesNotMatch(JSON.stringify(b), /"key"|apiKey|AIza/i, 'an API key leaked into the browse body');
  }
});

test('a channel Videos-tab page parses: richItem-wrapped lockups, duration from the badge', () => {
  const r = parseBrowseResponse(channelBrowsePage([
    browseLockup(VID_A, 'מחרוזת שירים'),
    browseLockup(VID_B, 'עוד פרק', { duration: '1:02:03' })
  ]));
  assert.ok(r, 'the measured channel-browse shape parsed as null');
  assert.equal(r.continuation, 'B_TOK');
  assert.deepEqual(r.items.map((i) => [i.id, i.durationText, i.viewCountText]), [
    [VID_A, '25:39', '406K צפיות'],
    [VID_B, '1:02:03', '406K צפיות']
  ]);
  assert.equal(r.items[0].url, 'https://www.youtube.com/watch?v=' + VID_A);
});

test('a playlist page parses, and its Shorts-shaped entries are dropped', () => {
  const r = parseBrowseResponse(playlistBrowsePage([
    browseLockup(VID_A, 'רגיל'),
    browseLockup(VID_SHORT, 'שורט ברשימה', { shorts: true }),
    browseLockup(VID_B, 'רגיל 2')
  ]));
  assert.equal(r.continuation, 'P_TOK');
  assert.deepEqual(r.items.map((i) => i.id), [VID_A, VID_B],
    'a /shorts/-tapping lockup leaked into the playlist browse');
});

test('a browse CONTINUATION page (onResponseReceivedActions) parses and chains', () => {
  const page = {
    onResponseReceivedActions: [{
      appendContinuationItemsAction: {
        continuationItems: [
          { richItemRenderer: { content: browseLockup(VID_A, 'המשך') } },
          { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'B_NEXT' } } } }
        ]
      }
    }]
  };
  const r = parseBrowseResponse(page);
  assert.equal(r.items.length, 1);
  assert.equal(r.continuation, 'B_NEXT');
  // and the search parser accepts the Actions key too (shared reader)
  assert.ok(parseSearchResponse(page));
});

test('legacy playlistVideoRenderer items still map (older documents)', () => {
  const legacy = {
    playlistVideoListRenderer: {
      contents: [{
        playlistVideoRenderer: {
          videoId: VID_A,
          title: { runs: [{ text: 'פרק ישן' }] },
          lengthText: { simpleText: '7:11' },
          shortBylineText: { runs: [{ text: 'ערוץ פלא' }] },
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/' + VID_A + '/hqdefault.jpg' }] },
          navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/watch?v=' + VID_A } } }
        }
      }]
    }
  };
  const r = parseBrowseResponse(playlistBrowsePage([legacy], null));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].channelTitle, 'ערוץ פלא');
  assert.equal(r.items[0].durationText, '7:11');
});

test('an unrecognized browse document -> null; a recognized empty one -> {items:[]}', () => {
  assert.equal(parseBrowseResponse(null), null);
  assert.equal(parseBrowseResponse({ contents: { somethingElse: {} } }), null);
  const empty = parseBrowseResponse(channelBrowsePage([], null));
  assert.ok(empty, 'an empty Videos tab must not read as a parse failure');
  assert.deepEqual(empty.items, []);
});

/* ---------------- totality: malformed-but-truthy shapes must never THROW ---------------- */

test('the parsers are TOTAL: innertube array→object churn returns null/items, never throws', () => {
  // The module's design premise is "YouTube may change its shapes". A THROW here used
  // to escape as a generic error and the UI said "בדקו את החיבור לאינטרנט" over working
  // Wi-Fi — the shape-changed alarm never fired (review-caught, demonstrated live).
  const malformed = [
    { onResponseReceivedCommands: {} },                                        // spread site
    { onResponseReceivedActions: { a: 1 } },
    firstPage([{ itemSectionRenderer: { contents: {} } }]),                    // section contents
    firstPage([vid(VID_A, 'x', { thumbnailOverlays: {} })]),                   // overlay loop
    firstPage([{ shelfRenderer: { content: { verticalListRenderer: { items: {} } } } }]),
    { contents: { twoColumnBrowseResultsRenderer: { tabs: {} } } },            // tabs loop
    playlistBrowsePage([{ playlistVideoListRenderer: { contents: {} } }], null),
    { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [null, 42, 'str'] } } } } }
  ];
  for (const [i, doc] of malformed.entries()) {
    let r;
    assert.doesNotThrow(() => { r = parseSearchResponse(doc); }, `search parser threw on malformed doc #${i}`);
    assert.doesNotThrow(() => { r = parseBrowseResponse(doc); }, `browse parser threw on malformed doc #${i}`);
  }
});

test('lockup videos carrying only a reelWatchEndpoint (no /shorts/ url) are dropped too', () => {
  // parity with isShortVideo — either signal alone is a Short
  const reel = browseLockup(VID_SHORT, 'שורט חבוי');
  reel.lockupViewModel.rendererContext = {
    commandContext: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: VID_SHORT } } } }
  };
  const r = parseBrowseResponse(channelBrowsePage([
    { richItemRenderer: { content: reel } },
    { richItemRenderer: { content: browseLockup(VID_A, 'רגיל') } }
  ], null));
  assert.deepEqual(r.items.map((i) => i.id), [VID_A],
    'a reel-endpoint lockup leaked past the Shorts filter');
});

test('playlist ids are validated like every other identifier class', () => {
  // a hostile id containing `"]` used to flow into a querySelector string and throw
  // AFTER a successful add (review finding) — now it never leaves the parser
  const bad = lockupPlaylist('PL"]evil', 'עוין');
  const short = lockupPlaylist('PL123', 'קצר מדי');
  const good = lockupPlaylist('PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug', 'תקין');
  const r = parseSearchResponse(firstPage([bad, short, good]));
  assert.deepEqual(r.items.map((i) => i.id), ['PLsJS3uJXxKz9worTXC-m35wB-nQXSRGug']);
});

/* ---------------- suggestions ---------------- */

test('parseSuggestions: clean firefox JSON, the JSONP wrapper, and junk', () => {
  assert.deepEqual(parseSuggestions('["בוב",["בוב הבנאי","בוב ספוג"]]'), ['בוב הבנאי', 'בוב ספוג']);
  assert.deepEqual(
    parseSuggestions('window.google.ac.h(["בוב",[["בוב הבנאי",0,[512]],["בוב ספוג",0]],{"k":1}])'),
    ['בוב הבנאי', 'בוב ספוג']);
  assert.deepEqual(parseSuggestions(''), []);
  assert.deepEqual(parseSuggestions('<!doctype html><html>sign in</html>'), []);
  assert.deepEqual(parseSuggestions('["q","not-an-array"]'), []);
  const eleven = parseSuggestions(JSON.stringify(['q', Array.from({ length: 20 }, (_, i) => 's' + i)]));
  assert.equal(eleven.length, 10, 'the dropdown is capped — 20 rows under a text field is a wall');
});

test('suggestUrl encodes the query and asks for Hebrew', () => {
  const u = suggestUrl('בוב הבנאי');
  assert.ok(u.includes('q=%D7%91%D7%95%D7%91%20%D7%94%D7%91%D7%A0%D7%90%D7%99') || u.includes('q=%D7%91%D7%95%D7%91+%D7%94'), u);
  assert.ok(u.includes('hl=he'), 'suggestions must come back in the UI language');
  assert.ok(u.includes('client=firefox'), 'firefox client = clean JSON, no JSONP');
  // without oe=utf-8 a Hebrew query is answered in windows-1255 (measured live) and
  // the dropdown renders ���� — the encoding parameter is part of the contract
  assert.ok(u.includes('oe=utf-8'), 'missing oe=utf-8: Hebrew suggestions arrive as mojibake');
});

/* ---------------- messages (the words ARE the feature — v1.0.27) ---------------- */

test('searchMessage: every stage distinct and honest, nothing leaks undefined', () => {
  // no 'added'/'exists' here on purpose: the add outcome text is addClassifiedRow's
  // message (one add path = one voice) — the stages were dead code and were deleted
  const stages = ['searching', 'browse', 'more', 'empty', 'network', 'parse'];
  const texts = stages.map((s) => searchMessage(s, { query: 'בוב' }));
  for (const [i, t] of texts.entries()) {
    assert.ok(t && t.trim(), stages[i] + ' has no text');
    assert.doesNotMatch(t, /undefined|NaN|null/, stages[i] + ' leaks a JS value');
  }
  assert.equal(new Set(texts).size, texts.length, 'two stages share one text — ambiguity is the bug this exists to kill');
  assert.ok(searchMessage('empty', { query: 'בוב' }).includes('בוב'),
    'the empty message must name the query — "אין תוצאות" alone reads as a broken screen');
  // 'parse' and 'network' must be tellable apart: one means update-the-app, one means try-again
  assert.notEqual(searchMessage('parse'), searchMessage('network'));
  assert.equal(searchMessage('nonsense-stage'), '');
});
