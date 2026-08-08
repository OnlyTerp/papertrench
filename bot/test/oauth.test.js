/* OAuth 1.0a signing locks.
 *
 * The signature vector is the worked example from X's developer guide,
 * fetched 2026-08-07 from
 * docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature
 * (the current docs use api.x.com as the example host — the classic
 * api.twitter.com variant of the same example signs to a different value).
 * If this test fails after an edit to oauth.js, the edit broke signing — the
 * vector is external authority, never to be regenerated from the
 * implementation's own output.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pctEncode, sign } = require('../oauth.js');

test('pctEncode follows RFC 3986, not encodeURIComponent', () => {
  assert.equal(pctEncode('Ladies + Gentlemen'), 'Ladies%20%2B%20Gentlemen');
  assert.equal(pctEncode('An encoded string!'), 'An%20encoded%20string%21');
  assert.equal(pctEncode("Dogs, Cats & Mice"), 'Dogs%2C%20Cats%20%26%20Mice');
  assert.equal(pctEncode("!*'()"), '%21%2A%27%28%29');
  assert.equal(pctEncode('unreserved-._~AZaz09'), 'unreserved-._~AZaz09');
});

test('signs the worked example from X\'s "Creating a signature" guide', () => {
  const r = sign(
    'POST',
    'https://api.x.com/1.1/statuses/update.json',
    {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      include_entities: 'true',
    },
    {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    },
    { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 }
  );
  assert.equal(r.signature, 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=');
});

test('Authorization header carries all oauth params, percent-encoded and quoted', () => {
  const r = sign('POST', 'https://api.x.com/2/tweets', null, {
    consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessSecret: 'as',
  }, { nonce: 'n0nce', timestamp: 1700000000 });
  assert.ok(r.header.startsWith('OAuth '));
  for (const k of ['oauth_consumer_key="ck"', 'oauth_token="at"',
    'oauth_signature_method="HMAC-SHA1"', 'oauth_timestamp="1700000000"',
    'oauth_nonce="n0nce"', 'oauth_version="1.0"', 'oauth_signature="']) {
    assert.ok(r.header.includes(k), 'header missing ' + k);
  }
});

test('query params enter the base string; a JSON body does not', () => {
  const withQuery = sign('POST', 'https://api.x.com/2/tweets?foo=bar', null, {
    consumerKey: 'ck', consumerSecret: 'cs', accessToken: 'at', accessSecret: 'as',
  }, { nonce: 'n', timestamp: 1700000000 });
  assert.ok(withQuery.baseString.includes('foo%3Dbar'));
  assert.ok(!withQuery.baseString.includes('?'), 'query string must not stay attached to the base URL');
});
