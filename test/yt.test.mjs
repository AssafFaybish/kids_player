// yt.js — the pure pieces of the YouTube client. Everything else in that module is
// network I/O; what belongs under test is the URL a keyless resolution actually hits,
// because getting the encoding wrong looks exactly like "this channel doesn't exist".
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
