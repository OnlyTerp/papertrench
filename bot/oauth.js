/* OAuth 1.0a request signing (RFC 5849), pure node:crypto — no dependencies.
 *
 * X's POST /2/tweets requires OAuth 1.0a user-context signing. Only oauth_*
 * parameters and URL query parameters enter the signature base string; a JSON
 * request body does not (it is not form-encoded). The implementation is locked
 * by bot/test/oauth.test.js against the worked example in X's developer guide
 * (docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature,
 * fetched 2026-08-07): same inputs, same base string, same signature.
 */

'use strict';

const crypto = require('crypto');

/* RFC 3986 percent-encoding: everything except ALPHA / DIGIT / "-" / "." /
 * "_" / "~". encodeURIComponent leaves !'()* unescaped; OAuth must not. */
function pctEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/* Signature base string: METHOD & enc(scheme://host/path) & enc(sorted params).
 * Params = URL query params + extraParams (form/oauth params). Sort by encoded
 * key, then encoded value, per RFC 5849 §3.4.1.3.2. */
function baseString(method, url, params) {
  const u = new URL(url);
  const base = u.protocol + '//' + u.host + u.pathname;
  const all = [];
  u.searchParams.forEach((v, k) => all.push([k, v]));
  for (const [k, v] of Object.entries(params || {})) all.push([k, String(v)]);
  const pairs = all.map(([k, v]) => [pctEncode(k), pctEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1
    : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramStr = pairs.map(([k, v]) => k + '=' + v).join('&');
  return [method.toUpperCase(), pctEncode(base), pctEncode(paramStr)].join('&');
}

/* Sign a request. extraParams: form-encoded body/query params that belong in
 * the signature (pass null for a JSON body). creds: { consumerKey,
 * consumerSecret, accessToken, accessSecret }. opts.nonce / opts.timestamp
 * exist for the test vector; production callers omit them. */
function sign(method, url, extraParams, creds, opts) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: (opts && opts.nonce) || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String((opts && opts.timestamp) || Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const bs = baseString(method, url, Object.assign({}, extraParams, oauth));
  const key = pctEncode(creds.consumerSecret) + '&' + pctEncode(creds.accessSecret);
  const signature = crypto.createHmac('sha1', key).update(bs).digest('base64');
  const headerParams = Object.assign({ oauth_signature: signature }, oauth);
  const header = 'OAuth ' + Object.keys(headerParams).sort()
    .map((k) => pctEncode(k) + '="' + pctEncode(headerParams[k]) + '"')
    .join(', ');
  return { signature, header, baseString: bs };
}

module.exports = { pctEncode, baseString, sign };
