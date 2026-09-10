/* D-72 / W3: real candle adapter, attested fills, pricing and submission verdicts.
 * Only network/clock and the D1 transport are replaced; SQL runs in SQLite.
 * Run: node --test server/test/pricing-multichain.test.js
 *
 * Unit contract: EVM UI quotes are USD, but attest.js commits SOL-book
 * priceNative and stores neither priceUsd nor solUsdAtResolve. Independent
 * historical SOL/USD converts that committed value for the existing judge.
 *
 * Exact production-line negative controls (restore byte-identical afterward):
 * - worker/candles.js: `if (!Object.hasOwn(indeix.CHAIN_IDS, slug)) return null;`
 *   -> `if (slug !== 'solana') return null;` makes both "honest ... fill"
 *   cases fail (partial instead of verified).
 * - worker/candles.js: `indeixWindow(env, indeix.CHAIN_IDS[slug], mint, minuteTs, budget)`
 *   -> `indeixWindow(env, 'solana', mint, minuteTs, budget)` makes both honest
 *   cases fail their observed chainId request and market band assertions.
 * - worker/candles.js: `slug + ':' + mint.toLowerCase()` -> `mint.toLowerCase()`
 *   makes "same address and minute on BNB and Robinhood never share candles"
 *   fail: the second market is judged against the first market's band.
 * - worker/candles.js: `low > 0 && high >= low` -> `true` makes
 *   "thin or errored EVM candles never become verified evidence" fail.
 * - core/pricing.js: `const chain = chainOf(link);` ->
 *   `const chain = link.chain || 'solana';` makes "unhashed v1 chain labels
 *   cannot redirect a legacy Solana fill" fail.
 * - core/pricing.js: `const fillLow = price * sol.low;` ->
 *   `const fillLow = price;` makes "Solana verification keeps its original
 *   verdict bytes" fail by accepting its overpriced fill.
 * - core/pricing.js: `if (!tok || !sol || !(tok.low > 0) || !(sol.low > 0)) return 'no-data';`
 *   -> the same guard returning 'ok' makes both missing-leg cases fail.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { makeGetCandles, SOL_USD_POOL } = require('../worker/candles.js');
const { priceChain } = require('../core/pricing.js');
const { priceRecord } = require('../core/submission.js');
const { appendFill, fillPreimage, sha256, verifyChain, GENESIS } = require('../core/chain.js');

const EVM = '0x99A90B1218419c62A2Fa7E427284C6c7D058d47a';
const MINT = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const MINUTE = 1_700_000_040_000;
const NOW = MINUTE + 48 * 3600 * 1000;

/** Same real-SQLite/D1 pattern as submitterrace.test.js, without unused APIs. */
function realDB(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  t.after(() => db.close());
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
      };
      return statement;
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function tokenRow(ts = MINUTE, low = 0.9, high = 1.1) {
  return { t: ts / 1000, o: 1, h: high, l: low, c: 1, v: 1000 };
}

function harness(t, options = {}) {
  const calls = [];
  const priorCaches = globalThis.caches;
  delete globalThis.caches;
  t.after(() => {
    if (priorCaches !== undefined) globalThis.caches = priorCaches;
  });
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    if (parsed.origin === 'https://api.indeix.com') {
      assert.equal(parsed.pathname, '/2/token/ohlcv-history');
      return options.indeix ? options.indeix(parsed) : Response.json({ data: [tokenRow()] });
    }
    assert.equal(parsed.origin, 'https://api.geckoterminal.com');
    if (parsed.pathname.includes('/pools/' + SOL_USD_POOL + '/ohlcv/')) {
      return Response.json({ data: { attributes: { ohlcv_list: options.solRows ?? [
        [MINUTE / 1000, 100, 101, 99, 100, 1000],
      ] } } });
    }
    assert.ok(parsed.pathname.includes('/networks/solana/'), 'only SOL candles/pools use GT');
    if (parsed.pathname.endsWith('/pools')) {
      return Response.json({ data: [{ attributes: { address: 'solana-token-pool' } }] });
    }
    assert.ok(parsed.pathname.includes('/pools/solana-token-pool/ohlcv/'));
    return Response.json({ data: { attributes: { ohlcv_list: options.solanaRows ?? [
      [MINUTE / 1000, 1, 1.1, 0.9, 1, 1000],
    ] } } });
  });
  const env = { DB: realDB(t), INDEIX_API_KEY: 'ix_test_candles' };
  const budget = { used: 0, max: options.max ?? 20 };
  return {
    calls, env, budget,
    getCandles: makeGetCandles(env, budget),
  };
}

async function fill(overrides = {}) {
  const link = await appendFill(GENESIS, {
    id: 'fill', sessionId: 'session', mint: EVM, chain: 'bnb', side: 'buy',
    qty: 100, priceNative: 0.01, solGross: 1, solNet: 1, ts: MINUTE + 1000,
    ...overrides,
  });
  link.seq = 0;
  return link;
}

for (const [chain, chainId] of [['bnb', 'evm:56'], ['robinhood', 'evm:4663']]) {
  test('honest ' + chain + ' fill verifies through independent historical USD conversion', async (t) => {
    const h = harness(t);
    const link = await fill({ chain });
    assert.equal((await verifyChain([link])).valid, true);
    const result = await priceRecord({ chain: [link] }, h.getCandles);
    assert.equal(result.done, true);
    assert.deepEqual(result.verdict, {
      status: 'verified', coverage: 1,
      counts: { ok: 1, implausible: 0, noData: 0 }, implausible: [],
    });
    assert.deepEqual(await h.getCandles(EVM, MINUTE, chain), {
      tokenUsd: { low: 0.9, high: 1.1 }, solUsd: { low: 99, high: 101 },
    }, 'whole-token USD band and independent SOL/USD band are preserved verbatim');
    assert.equal(h.calls.length, 2, 'warm D1 needs neither source again');
    const request = h.calls[1];
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.headers.Authorization, 'Bearer ix_test_candles');
    assert.deepEqual(Object.fromEntries(request.url.searchParams), {
      chainId, address: EVM, period: '1m', from: String(MINUTE),
      to: String(MINUTE + 720 * 60000), amount: '720', usd: 'true', fill: 'false',
    }, 'old fills fetch their own bounded history window, not only recent bars');
    assert.equal(h.budget.used, 2);
  });
}

test('divergent EVM prices reject the record and unhashed USD cannot rescue them', async (t) => {
  const h = harness(t);
  for (const priceNative of [0.05, 0.001]) {
    const link = await fill({ priceNative });
    link.priceUsd = 1;
    link.solUsdAtResolve = 1 / priceNative;
    const result = await priceRecord({ chain: [link] }, h.getCandles);
    assert.deepEqual(result.verdict, {
      status: 'rejected', coverage: 0,
      counts: { ok: 0, implausible: 1, noData: 0 },
      implausible: [{ index: 0, id: 'fill', verdict: 'implausible' }],
    });
  }
});

for (const missing of ['token USD', 'SOL/USD']) {
  test('missing ' + missing + ' candles remain no-data and partial, not a pass or rejection', async (t) => {
    const h = harness(t, missing === 'token USD'
      ? { indeix: () => Response.json({ data: [tokenRow(MINUTE + 60000)] }) }
      : { solRows: [] });
    const result = await priceRecord({ chain: [await fill()] }, h.getCandles);
    assert.equal(result.done, true);
    assert.deepEqual(result.verdicts, [{ index: 0, id: 'fill', verdict: 'no-data' }]);
    assert.deepEqual(result.verdict, {
      status: 'partial', coverage: 0,
      counts: { ok: 0, implausible: 0, noData: 1 }, implausible: [],
    });
  });
}

test('thin or errored EVM candles never become verified evidence', async (t) => {
  const h = harness(t, { indeix: () => Response.json({ data: [
    { ...tokenRow(), error: 'unavailable' },
    tokenRow(MINUTE, 0, 1.1),
    tokenRow(MINUTE, 0.9, 'Infinity'),
    tokenRow(MINUTE, 1.01, 0.99),
  ] }) });
  const result = await priceRecord({ chain: [await fill()] }, h.getCandles);
  assert.deepEqual(result.verdicts, [{ index: 0, id: 'fill', verdict: 'no-data' }]);
  assert.equal(result.verdict.status, 'partial');
});

test('same address and minute on BNB and Robinhood never share candles', async (t) => {
  const h = harness(t, { indeix: (url) => Response.json({ data: [
    url.searchParams.get('chainId') === 'evm:56' ? tokenRow() : tokenRow(MINUTE, 6.9, 7.1),
  ] }) });
  const result = await priceRecord({ chain: [
    await fill({ id: 'bnb', chain: 'bnb' }),
    await fill({ id: 'rh', chain: 'robinhood', priceNative: 0.07 }),
  ] }, h.getCandles);
  assert.deepEqual(result.verdicts, [
    { index: 0, id: 'bnb', verdict: 'ok' }, { index: 1, id: 'rh', verdict: 'ok' },
  ]);
  assert.equal(result.verdict.status, 'verified');
  assert.equal(h.calls.length, 3, 'one SOL/USD candle, two separate token markets');
});

test('unavailable EVM upstream pauses at the fill and recovery resumes without no-data', async (t) => {
  let down = true;
  const h = harness(t, { max: 3, indeix: () => down
    ? new Response('down', { status: 504 }) : Response.json({ data: [tokenRow()] }) });
  const payload = { chain: [await fill()] };
  const paused = await priceRecord(payload, h.getCandles);
  assert.deepEqual(paused, { done: false, cursor: 0, verdicts: [] });
  assert.equal(h.budget.used, 3, 'one SOL call plus two bounded Indeix attempts');
  assert.equal(h.calls.length, 3);
  down = false;
  const recovered = await priceRecord(payload, makeGetCandles(h.env, { used: 0, max: 1 }), paused);
  assert.equal(recovered.done, true);
  assert.equal(recovered.verdict.status, 'verified');
});

test('malformed EVM history pauses instead of caching a market-data absence', async (t) => {
  let malformed = true;
  const h = harness(t, { indeix: () => Response.json(malformed ? { error: 'backend' } : { data: [tokenRow()] }) });
  const payload = { chain: [await fill()] };
  const paused = await priceRecord(payload, h.getCandles);
  assert.deepEqual(paused, { done: false, cursor: 0, verdicts: [] });
  malformed = false;
  const recovered = await priceRecord(payload, h.getCandles, paused);
  assert.equal(recovered.verdict.status, 'verified');
});

test('unknown committed chains spend nothing and cannot borrow a market', async (t) => {
  const h = harness(t);
  for (const chain of ['unknown', '__proto__', 'toString']) {
    const result = await priceRecord({ chain: [await fill({ chain })] }, h.getCandles);
    assert.equal(result.verdict.status, 'partial');
    assert.equal(result.verdicts[0].verdict, 'no-data');
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.budget.used, 0);
});

test('unhashed v1 chain labels cannot redirect a legacy Solana fill', async (t) => {
  const h = harness(t, { indeix: () => Response.json({ data: [tokenRow(MINUTE, 9, 11)] }) });
  const legacy = { ...await fill({ mint: MINT }), version: 1 };
  legacy.hash = await sha256(fillPreimage(legacy, GENESIS));
  legacy.chain = 'bnb'; // v1 never committed this label; its hash still verifies.
  assert.equal((await verifyChain([legacy])).valid, true);
  const result = await priceRecord({ chain: [legacy] }, h.getCandles);
  assert.equal(result.verdict.status, 'verified');
  assert.equal(h.calls.some(({ url }) => url.origin === 'https://api.indeix.com'), false);
});

test('Solana verification keeps its original verdict bytes', async (t) => {
  const h = harness(t, { solRows: [
    [MINUTE / 1000, 100, 101, 99, 100, 1000],
    [MINUTE / 1000 + 60, 100, 101, 99, 100, 1000],
  ] });
  const legacy = { ...await fill({ id: 'legacy', mint: MINT }), version: 1 };
  delete legacy.chain;
  const result = await priceChain([
    legacy,
    await fill({ id: 'modern', mint: MINT, chain: 'solana' }),
    await fill({ id: 'divergent', mint: MINT, chain: 'solana', priceNative: 0.05 }),
    await fill({ id: 'missing', mint: MINT, chain: 'solana', ts: MINUTE + 60000 }),
  ], h.getCandles);
  assert.equal(JSON.stringify(result), JSON.stringify({
    done: true, cursor: 4, lookups: 2, verdicts: [
      { index: 0, id: 'legacy', verdict: 'ok' },
      { index: 1, id: 'modern', verdict: 'ok' },
      { index: 2, id: 'divergent', verdict: 'implausible' },
      { index: 3, id: 'missing', verdict: 'no-data' },
    ],
  }));
  assert.equal(h.calls.some(({ url }) => url.origin === 'https://api.indeix.com'), false);
});
