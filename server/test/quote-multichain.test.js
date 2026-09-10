/* D-72 / W2: real Worker route and Indeix adapter, only network/clock/cache replaced.
 * Run: node --test server/test/quote-multichain.test.js
 *
 * Exact production-line negative controls (restore byte-identical afterward):
 * - worker/indeix.js: `bnb: 'evm:56',` -> `bnb: 'solana',` makes
 *   "bnb quotes use the EVM batch and never invent SOL" fail the request body.
 * - worker/index.js: `!Object.hasOwn(indeix.CHAIN_IDS, chain)` -> `false` makes
 *   "unknown or repeated chains are rejected before the provider" fail (503).
 * - worker/index.js: `!addressPattern.test(mint)` -> `false` makes
 *   "invalid and mixed-chain address lists are refused" fail (200).
 * - worker/indeix.js: `if (isSolana) addresses.push(WSOL);` ->
 *   `addresses.push(WSOL);` makes both EVM batch tests fail (foreign WSOL item).
 * - worker/indeix.js: `upstreamUrl.searchParams.set('chain', chain);` ->
 *   `upstreamUrl.searchParams.set('chain', 'solana');` makes "adapter cache
 *   separates the same address on different chains" fail (BNB quote on RH).
 * - worker/index.js: `cacheKey(url, { chain, mints: normalized.join(',') })` ->
 *   `cacheKey(url, { mints: normalized.join(',') })` makes "route cache
 *   separates the same address on different chains" fail (BNB quote on RH).
 * - worker/indeix.js: `positiveNumber(priceUsd / solUsd)` ->
 *   `positiveNumber(priceUsd / solUsd / 1e6)` makes "absent chain keeps the
 *   D-71 Solana response bytes and anchor semantics" fail.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const indeix = require('../worker/indeix.js');

const MINT = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const WSOL = 'So11111111111111111111111111111111111111112';
const EVM = '0x99A90B1218419c62A2Fa7E427284C6c7D058d47a';
const EVM_B = '0xfe189e97832da1573e4e4ff034f4ffc3a15c7777';
const NOW = 1_783_333_333_000;
const ENV = { INDEIX_API_KEY: 'ix_test_multichain', SITE_ORIGIN: 'https://papertrench.com' };

function edgeCache(now) {
  const entries = new Map();
  return {
    async match(request) {
      const entry = entries.get(request.url);
      return entry && entry.expires > now() ? entry.response.clone() : undefined;
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
  t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return upstream(call);
  });
  const worker = (await import('../worker/index.js')).default;
  return {
    calls,
    advance(ms) { now += ms; },
    async request(query) {
      const pending = [];
      const response = await worker.fetch(new Request('https://api.test/api/quote' + query), ENV,
        { waitUntil(promise) { pending.push(promise); } });
      await Promise.all(pending);
      return response;
    },
  };
}

function quote(priceUsd, priceSol = null, mcapUsd = null, fdvUsd = null, asOf = NOW) {
  return { priceUsd, priceSol, mcapUsd, fdvUsd, source: 'indeix', asOf };
}

for (const [chain, chainId, address] of [
  ['bnb', 'evm:56', EVM_B.toUpperCase()],
  ['robinhood', 'evm:4663', EVM],
]) {
  test(chain + ' quotes use the EVM batch and never invent SOL', async (t) => {
    const h = await harness(t, ({ url, init }) => {
      assert.equal(url, 'https://api.indeix.com/2/token/price');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { items: [{ chainId, address }] });
      // Foreign native/SOL-looking figures and a surplus response item cannot
      // become a SOL anchor; only the explicitly requested token is quoted.
      return Response.json({ payload: [
        { priceUSD: '3', priceSol: 91, marketCapUSD: '30000', marketCapDilutedUSD: '60000' },
        { priceUSD: 150 },
      ] });
    });
    const response = await h.request('?chain=' + chain + '&mints=' + address);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { asOf: NOW, quotes: {
      [address]: quote(3, null, 30000, 60000),
    } });
  });
}

test('unknown or repeated chains are rejected before the provider', async (t) => {
  const h = await harness(t, () => { throw new Error('provider must not be called'); });
  for (const chainQuery of [
    'chain=unknown', 'chain=evm%3A56', 'chain=', 'chain=__proto__', 'chain=toString',
    'chain=bnb,robinhood', 'chain=bnb&chain=robinhood', 'chain=bnb&chain=bnb',
  ]) {
    const response = await h.request('?' + chainQuery + '&mints=' + EVM);
    assert.equal(response.status, 400, chainQuery);
    assert.deepEqual(await response.json(), { error: 'bad-chain' });
  }
  assert.deepEqual(h.calls, []);
});

test('invalid and mixed-chain address lists are refused', async (t) => {
  const h = await harness(t, () => Response.json({ payload: [{ priceUSD: 3 }, { priceUSD: 150 }] }));
  for (const query of [
    '?chain=bnb&mints=',
    '?chain=bnb&mints=' + EVM.slice(0, -1),
    '?chain=robinhood&mints=' + EVM + 'a',
    '?chain=bnb&mints=' + EVM.replace('9', 'g'),
    '?chain=bnb&mints=' + EVM.slice(2),
    '?chain=robinhood&mints=' + EVM + ',' + MINT,
    '?chain=bnb&mints=' + WSOL,
    '?chain=solana&mints=' + EVM,
    '?mints=' + EVM,
    '?chain=bnb&mints=' + Array(17).fill(EVM).join(','),
  ]) {
    const response = await h.request(query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'bad-mints' });
  }
  assert.deepEqual(h.calls, []);
});

test('EVM failures omit only their positional token and preserve honest USD', async (t) => {
  const h = await harness(t, ({ init }) => {
    assert.deepEqual(JSON.parse(init.body), { items: [
      { chainId: 'evm:56', address: EVM }, { chainId: 'evm:56', address: EVM_B },
    ] });
    return Response.json({ payload: [
      { error: 'unlisted', priceUSD: 3 },
      { priceUSD: 7, marketCapUSD: 0, marketCapDilutedUSD: 'invalid' },
    ] });
  });
  const response = await h.request('?chain=bnb&mints=' + EVM_B + ',' + EVM);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [EVM_B]: quote(7) } });
});

test('route cache separates the same address on different chains', async (t) => {
  const h = await harness(t, ({ init }) => Response.json({ payload: [
    { priceUSD: JSON.parse(init.body).items[0].chainId === 'evm:56' ? 3 : 7 },
  ] }));
  for (const [chain, price] of [['bnb', 3], ['robinhood', 7], ['bnb', 3], ['robinhood', 7]]) {
    const response = await h.request('?chain=' + chain + '&mints=' + EVM);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { asOf: NOW, quotes: { [EVM]: quote(price) } });
  }
  assert.equal(h.calls.length, 2);
});

test('adapter cache separates the same address on different chains', async (t) => {
  const h = await harness(t, ({ init }) => Response.json({ payload: [
    { priceUSD: JSON.parse(init.body).items[0].chainId === 'evm:56' ? 3 : 7 },
  ] }));
  const budget = { used: 0, max: 2 };
  for (const [chain, price] of [['bnb', 3], ['robinhood', 7], ['bnb', 3]]) {
    const answer = await indeix.prices(ENV, [EVM], budget, chain);
    assert.deepEqual(answer, { asOf: NOW, quotes: { [EVM]: quote(price) } });
  }
  assert.equal(budget.used, 2);
  assert.equal(h.calls.length, 2);
});

test('absent chain keeps the D-71 Solana response bytes and anchor semantics', async (t) => {
  const h = await harness(t, ({ init }) => {
    assert.deepEqual(JSON.parse(init.body), { items: [
      { chainId: 'solana', address: MINT }, { chainId: 'solana', address: WSOL },
    ] });
    return Response.json({ payload: [
      { priceUSD: 3, marketCapUSD: 30000, marketCapDilutedUSD: 60000 }, { priceUSD: 150 },
    ] });
  });
  const expected = JSON.stringify({ asOf: NOW, quotes: {
    [MINT]: quote(3, 0.02, 30000, 60000), [WSOL]: quote(150, 1),
  } });
  const implicit = await h.request('?mints=' + WSOL + ',' + MINT + ',' + WSOL);
  assert.equal(implicit.status, 200);
  assert.equal(await implicit.text(), expected);
  assert.equal(implicit.headers.get('Cache-Control'), 'public, max-age=10, s-maxage=10');
  const explicit = await h.request('?chain=solana&mints=' + MINT + ',' + WSOL);
  assert.equal(explicit.status, 200);
  assert.equal(await explicit.text(), expected);
  assert.equal(h.calls.length, 1);
});

test('expired EVM quotes fail closed on outage and can recover immediately', async (t) => {
  let down = false;
  const h = await harness(t, () => down ? new Response('down', { status: 504 }) :
    Response.json({ payload: [{ priceUSD: 3 }] }));
  const query = '?chain=robinhood&mints=' + EVM;
  const first = await h.request(query);
  assert.deepEqual(await first.json(), { asOf: NOW, quotes: { [EVM]: quote(3) } });
  h.advance(10001);
  down = true;
  const expired = await h.request(query);
  assert.equal(expired.status, 503);
  assert.deepEqual(await expired.json(), { error: 'upstream' });
  assert.equal(h.calls.length, 5, 'one healthy request plus the bounded four-attempt outage');
  down = false;
  const recovered = await h.request(query);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { asOf: NOW + 10001, quotes: {
    [EVM]: quote(3, null, null, null, NOW + 10001),
  } });
});
