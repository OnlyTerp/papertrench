/* D-71 / W1: the real Worker route + Indeix transport, with only network,
 * clock and Cloudflare Cache API replaced. Run from the repo root:
 *   node --test server/test/quote.test.js
 *
 * Exact production-line negative controls (restore the original afterward):
 * - worker/indeix.js:181: replace `if (!item || item.error) continue;` with
 *   `if (!item) continue;` -> "an errored token is omitted without shifting
 *   later tokens" fails: the errored mint with a positive-looking price leaks.
 * - worker/indeix.js:184: replace `positiveNumber(priceUsd / solUsd)` with
 *   `positiveNumber(priceUsd / solUsd / 1e6)` -> "GET /api/quote keeps positional
 *   prices in whole-token units" fails its exact SOL-per-token assertions.
 * - worker/indeix.js:53: replace `if (budget && budget.used >= budget.max)` with
 *   `if (false)` -> "the upstream budget bounds retries and already-spent
 *   requests" fails: the real retry loop spends beyond max.
 * - worker/indeix.js:158: replace `normalized.join(',')` with `''` -> "different
 *   mint sets cannot reuse another batch's quotes" fails on the second mint.
 * - worker/index.js:2277: replace `mints.length > 16` with `mints.length > 17`
 *   -> the "17 mints" case under "invalid mint lists never reach Indeix" fails.
 * - worker/index.js:29: restore `import * as indeix from './indeix.js';` ->
 *   "GET /api/quote keeps positional prices in whole-token units" fails with
 *   503 before fetching (Node cannot infer this CJS module's named exports).
 * - worker/index.js:168: replace `Math.min(30, ttlSec)` with `30` -> "expired
 *   quotes cannot reuse the replay cache or hide an outage, and failures are
 *   not cached" fails its browser max-age assertion (30 instead of 10).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const indeix = require('../worker/indeix.js');

const MINT_A = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const ENV = { INDEIX_API_KEY: 'ix_test_quote', SITE_ORIGIN: 'https://papertrench.com' };
const NOW = 1_783_333_333_000;

/** Expiring, clone-on-read Cache API; consumers see real Response objects. */
function edgeCache(now) {
  const entries = new Map();
  return {
    async match(request) {
      const entry = entries.get(request.url);
      if (!entry || entry.expires <= now()) return undefined;
      return entry.response.clone();
    },
    async put(request, response) {
      const control = response.headers.get('Cache-Control') || '';
      const ttl = /(?:^|[,\s])s-maxage=(\d+)/.exec(control) || /(?:^|[,\s])max-age=(\d+)/.exec(control);
      entries.set(request.url, { response: response.clone(), expires: now() + Number(ttl?.[1] || 0) * 1000 });
    },
  };
}

async function harness(t, upstream) {
  let now = NOW;
  const calls = [];
  const priorCaches = globalThis.caches;
  globalThis.caches = { default: edgeCache(() => now) };
  t.after(() => {
    if (priorCaches === undefined) delete globalThis.caches;
    else globalThis.caches = priorCaches;
  });
  t.mock.method(Date, 'now', () => now);
  // Skip only backoff time; the production retry loop and budget run intact.
  t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return upstream(call, calls.length);
  });
  const worker = (await import('../worker/index.js')).default;
  return {
    calls,
    advance(ms) { now += ms; },
    async request(query, options = {}, env = ENV) {
      const pending = [];
      const response = await worker.fetch(
        new Request('https://api.test/api/quote' + query, options), env,
        { waitUntil(promise) { pending.push(promise); } },
      );
      await Promise.all(pending);
      return response;
    },
  };
}

function batch(payload) {
  return Response.json({ payload });
}

function quote(priceUsd, priceSol, mcapUsd = null, fdvUsd = null, asOf = NOW) {
  return { priceUsd, priceSol, mcapUsd, fdvUsd, source: 'indeix', asOf };
}

test('GET /api/quote keeps positional prices in whole-token units', async (t) => {
  const h = await harness(t, ({ url, init }) => {
    assert.equal(url, 'https://api.indeix.com/2/token/price');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer ' + ENV.INDEIX_API_KEY);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { items: [
      { chainId: 'solana', address: MINT_A },
      { chainId: 'solana', address: MINT_B },
      { chainId: 'solana', address: WSOL },
    ] });
    // No addresses in the response: identity can ONLY come from batch position.
    return batch([
      { priceUSD: '3', liquidityUSD: '900', marketCapUSD: '30000', marketCapDilutedUSD: '60000' },
      { priceUSD: 7.5, marketCapUSD: 75000, marketCapDilutedUSD: 150000 },
      { priceUSD: '150' },
    ]);
  });
  const response = await h.request('?mints=' + MINT_B + ',' + MINT_A, {
    headers: { Origin: 'chrome-extension://unpacked-test-id' },
  });
  assert.equal(response.status, 200, 'public GET needs neither a site origin nor a session');
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: {
    [MINT_A]: quote(3, 0.02, 30000, 60000),
    [MINT_B]: quote(7.5, 0.05, 75000, 150000),
  } });
});

test('an errored token is omitted without shifting later tokens', async (t) => {
  const h = await harness(t, () => batch([
    { error: 'token unavailable', priceUSD: 999, marketCapUSD: 999000 },
    { priceUSD: 7.5 },
    { priceUSD: 150 },
  ]));
  const response = await h.request('?mints=' + MINT_A + ',' + MINT_B);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [MINT_B]: quote(7.5, 0.05) } });
});

test('zero, non-finite and nonnumeric token prices are omitted, never coerced', async (t) => {
  const badPrices = [0, -1, 'Infinity', 'NaN', true, {}, null];
  const mints = badPrices.map((_, i) => String(i + 1).repeat(32));
  const h = await harness(t, () => batch([
    ...badPrices.map((priceUSD) => ({ priceUSD })), { priceUSD: 150 },
  ]));
  const response = await h.request('?mints=' + mints.join(','));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: {} });
});

test('missing token items are omitted rather than zero-filled', async (t) => {
  const h = await harness(t, () => batch([null, { priceUSD: 7.5 }, { priceUSD: 150 }]));
  const response = await h.request('?mints=' + MINT_A + ',' + MINT_B);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [MINT_B]: quote(7.5, 0.05) } });
});

test('an unavailable SOL anchor leaves honest USD prices available', async (t) => {
  for (const [name, anchor] of [
    ['errored despite a price', [{ error: 'anchor unavailable', priceUSD: 150 }]],
    ['missing from the payload', []],
    ['zero price', [{ priceUSD: 0 }]],
  ]) {
    await t.test(name, async (t) => {
      const h = await harness(t, () => batch([{ priceUSD: 3 }, ...anchor]));
      const response = await h.request('?mints=' + MINT_A);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [MINT_A]: quote(3, null) } });
    });
  }
});

test('optional market caps stay null instead of falling back or inventing supply', async (t) => {
  const h = await harness(t, () => batch([
    { priceUSD: 3, marketCapUSD: 'Infinity', marketCapDilutedUSD: 60000 },
    { priceUSD: 7.5, marketCapUSD: 75000 },
    { priceUSD: 150 },
  ]));
  const response = await h.request('?mints=' + MINT_A + ',' + MINT_B);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: {
    [MINT_A]: quote(3, 0.02, null, 60000),
    [MINT_B]: quote(7.5, 0.05, 75000, null),
  } });
});

test('a persistent upstream outage returns only 503 upstream within the route budget', async (t) => {
  const h = await harness(t, () => new Response('provider down', { status: 504 }));
  const response = await h.request('?mints=' + MINT_A);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upstream' });
  assert.equal(h.calls.length, 4, 'one request and its retries exhaust, but never exceed, four calls');
});

test('transient upstream failure retries the batch and returns the real quotes', async (t) => {
  const h = await harness(t, (_, call) => call === 1
    ? new Response('retry', { status: 504 }) : batch([{ priceUSD: 3 }, { priceUSD: 150 }]));
  const response = await h.request('?mints=' + MINT_A);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [MINT_A]: quote(3, 0.02) } });
  assert.equal(h.calls.length, 2);
});

test('transport and batch failures cannot become an empty successful quote', async (t) => {
  const cases = [
    ['rejected credentials', () => new Response('bad key', { status: 403 })],
    ['bad upstream request', () => new Response('bad request', { status: 400 })],
    ['rate limited', () => new Response('limited', { status: 429 })],
    ['network error', () => { throw new Error('network down'); }],
    ['invalid JSON', () => new Response('not JSON')],
    ['missing payload', () => Response.json({ error: 'down' })],
    ['non-array payload', () => Response.json({ payload: {} })],
  ];
  for (const [name, upstream] of cases) {
    await t.test(name, async (t) => {
      const h = await harness(t, upstream);
      const response = await h.request('?mints=' + MINT_A);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'upstream' });
      assert.equal(h.calls.length, 1, 'non-transient failures are not retried');
    });
  }
});

test('a missing provider key fails closed without any upstream call', async (t) => {
  const h = await harness(t, () => { throw new Error('must not fetch'); });
  const response = await h.request('?mints=' + MINT_A, {}, {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upstream' });
  assert.equal(h.calls.length, 0);
});

test('the upstream budget bounds retries and already-spent requests', async (t) => {
  const h = await harness(t, () => new Response('down', { status: 504 }));
  const budget = { used: 0, max: 1 };
  await assert.rejects(indeix.prices(ENV, [MINT_A], budget), { code: 'indeix-budget-exhausted' });
  assert.equal(budget.used, budget.max);
  assert.equal(h.calls.length, 1);
  await assert.rejects(indeix.prices(ENV, [MINT_B], budget), { code: 'indeix-budget-exhausted' });
  assert.equal(budget.used, budget.max);
  assert.equal(h.calls.length, 1, 'an exhausted budget never sends another request');
});

test('a rejected network fetch still consumes its upstream budget slot', async (t) => {
  const h = await harness(t, () => { throw new Error('network down'); });
  const budget = { used: 0, max: 1 };
  await assert.rejects(indeix.prices(ENV, [MINT_A], budget), /network down/);
  assert.equal(budget.used, budget.max);
  await assert.rejects(indeix.prices(ENV, [MINT_A], budget), { code: 'indeix-budget-exhausted' });
  assert.equal(h.calls.length, 1);
});

test('concurrent batches cannot overspend a shared upstream budget', async (t) => {
  const h = await harness(t, () => batch([{ priceUSD: 3 }, { priceUSD: 150 }]));
  const budget = { used: 0, max: 1 };
  const [first, second] = await Promise.allSettled([
    indeix.prices(ENV, [MINT_A], budget), indeix.prices(ENV, [MINT_B], budget),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.deepEqual(first.value, { asOf: NOW, quotes: { [MINT_A]: quote(3, 0.02) } });
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'indeix-budget-exhausted');
  assert.equal(budget.used, budget.max);
  assert.equal(h.calls.length, 1);
});

test('invalid mint lists never reach Indeix', async (t) => {
  const validMints = Array.from({ length: 18 }, (_, i) => '123456789ABCDEFGHJ'[i] + '1'.repeat(31));
  const invalid = [
    ['missing mints', ''], ['empty mints', '?mints='], ['empty list item', '?mints=' + MINT_A + ','],
    ['17 mints', '?mints=' + validMints.slice(0, 17).join(',')],
    ['18 mints', '?mints=' + validMints.join(',')],
    ['short address', '?mints=' + '1'.repeat(31)], ['long address', '?mints=' + '1'.repeat(45)],
    ...['0', 'O', 'I', 'l'].map((c) => ['forbidden ' + c, '?mints=' + c + '1'.repeat(31)]),
  ];
  for (const [name, query] of invalid) {
    await t.test(name, async (t) => {
      const h = await harness(t, () => { throw new Error('validation must run before fetching'); });
      const response = await h.request(query);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'bad-mints' });
      assert.equal(h.calls.length, 0);
    });
  }
});

test('sixteen requested mints fit in one batch plus the SOL anchor', async (t) => {
  const mints = Array.from({ length: 16 }, (_, i) => '123456789ABCDEFG'[i] + '1'.repeat(31));
  const h = await harness(t, ({ init }) => {
    const { items } = JSON.parse(init.body);
    assert.deepEqual(items.map((item) => item.address), [...mints, WSOL]);
    return batch([...mints.map(() => ({ priceUSD: 3 })), { priceUSD: 150 }]);
  });
  const response = await h.request('?mints=' + mints.join(','));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW,
    quotes: Object.fromEntries(mints.map((mint) => [mint, quote(3, 0.02)])),
  });
  assert.equal(h.calls.length, 1);
});

test('a requested SOL anchor is quoted once and normalized duplicate sets share the cache', async (t) => {
  const h = await harness(t, ({ init }) => {
    assert.deepEqual(JSON.parse(init.body).items.map((item) => item.address), [MINT_A, WSOL]);
    return batch([{ priceUSD: 3 }, { priceUSD: 150 }]);
  });
  const first = await h.request('?mints=' + WSOL + ',' + MINT_A + ',' + WSOL);
  assert.deepEqual(await first.json(), { asOf: NOW, quotes: {
    [MINT_A]: quote(3, 0.02), [WSOL]: quote(150, 1),
  } });
  h.advance(1000);
  const second = await h.request('?unused=ignored&mints=' + MINT_A + ',' + WSOL);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { asOf: NOW, quotes: {
    [MINT_A]: quote(3, 0.02), [WSOL]: quote(150, 1),
  } });
  assert.equal(h.calls.length, 1, 'cache hits neither spend calls nor restamp the snapshot');
});

test('different mint sets cannot reuse another batch\'s quotes', async (t) => {
  const h = await harness(t, (_, call) => batch([{ priceUSD: call === 1 ? 3 : 7.5 }, { priceUSD: 150 }]));
  const first = await h.request('?mints=' + MINT_A);
  assert.deepEqual(await first.json(), { asOf: NOW, quotes: { [MINT_A]: quote(3, 0.02) } });
  const second = await h.request('?mints=' + MINT_B);
  assert.deepEqual(await second.json(), { asOf: NOW, quotes: { [MINT_B]: quote(7.5, 0.05) } });
  assert.equal(h.calls.length, 2);
});

test('expired quotes cannot reuse the replay cache or hide an outage, and failures are not cached', async (t) => {
  let down = false;
  const h = await harness(t, () => down ? new Response('down', { status: 504 }) : batch([
    { priceUSD: 3 }, { priceUSD: 150 },
  ]));
  const first = await h.request('?mints=' + MINT_A);
  assert.deepEqual(await first.json(), { asOf: NOW, quotes: { [MINT_A]: quote(3, 0.02) } });
  const control = first.headers.get('Cache-Control');
  assert.equal(Number(/(?:^|[,\s])max-age=(\d+)/.exec(control)[1]), 10, 'browser TTL is also short');
  down = true;
  h.advance(9999);
  const cached = await h.request('?mints=' + MINT_A);
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), { asOf: NOW, quotes: { [MINT_A]: quote(3, 0.02) } });
  assert.equal(h.calls.length, 1);
  h.advance(2);
  const expired = await h.request('?mints=' + MINT_A);
  assert.equal(expired.status, 503);
  assert.deepEqual(await expired.json(), { error: 'upstream' });
  down = false;
  const recovered = await h.request('?mints=' + MINT_A);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { asOf: NOW + 10001, quotes: {
    [MINT_A]: quote(3, 0.02, null, null, NOW + 10001),
  } });
});
