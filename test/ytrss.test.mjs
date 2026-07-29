// YouTube Atom feed parser tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeRss } from '../www/js/ytrss.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
 <title>ערוץ הילדים</title>
 <author><name>ערוץ הילדים &amp; חברים</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
 <entry>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>שיר הפתיחה &amp; עוד &#39;הפתעות&#39;</title>
  <published>2026-07-20T10:00:00+00:00</published>
  <media:group><media:thumbnail url="https://i2.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/></media:group>
 </entry>
 <entry>
  <yt:videoId>abcdefghijk</yt:videoId>
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>פרק 2</title>
  <published>2026-07-19T10:00:00+00:00</published>
 </entry>
 <entry>
  <title>ללא מזהה — חייב להידלג</title>
  <published>2026-07-18T10:00:00+00:00</published>
 </entry>
</feed>`;

test('parses entries in feed order with decoded Hebrew titles', () => {
  const out = parseYouTubeRss(FEED);
  assert.equal(out.length, 2); // third entry skipped (no videoId), not undefined-keyed
  assert.equal(out[0].videoId, 'dQw4w9WgXcQ');
  assert.equal(out[0].title, "שיר הפתיחה & עוד 'הפתעות'");
  assert.equal(out[0].channelId, 'UCabcdefghijklmnopqrstuv');
  assert.equal(out[0].channelTitle, 'ערוץ הילדים & חברים');
  assert.equal(out[0].thumbUrl, 'https://i2.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.ok(out[0].publishedAt > out[1].publishedAt);
});

test('never throws: truncated body, HTML error page, empty feed, null', () => {
  assert.deepEqual(parseYouTubeRss(FEED.slice(0, 200)), []);
  assert.deepEqual(parseYouTubeRss('<html><body>404</body></html>'), []);
  assert.deepEqual(parseYouTubeRss('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), []);
  assert.deepEqual(parseYouTubeRss(null), []);
});
