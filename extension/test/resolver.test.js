/* Tests for the resolver's I/O layer (resolver.js).
 *
 * The pure normalization logic is covered in quote.test.js. What matters here
 * is that the network wrapper feeds real API responses through that logic,
 * prefers the unambiguous pair lookup, caches, and degrades safely.
 *
 * fetch is stubbed with the recorded fixtures so these run offline and
 * deterministically. The live-API test skips (never fails) without a network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fixtures');
const tokensPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'tokens-bonk.json'), 'utf8'));
const pairPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'pair-bonk.json'), 'utf8'));

const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1';
const WSOL = 'So11111111111111111111111111111111111111112';

function usdcPair() {
  return {
    chainId: 'solana',
    pairAddress: 'Pair111111111111111111111111111111111111111',
    baseToken: { address: BONK_MINT, symbol: 'BONK', name: 'Bonk' },
    quoteToken: { address: USDC, symbol: 'USDC', name: 'USD Coin' },
    priceNative: '0.000003112',
    priceUsd: '0.000003112',
    liquidity: { usd: 1000000 },
  };
}

// Captured before any test stubs it, so the live probe below always uses the
// real implementation rather than a leftover stub from an earlier test.
const REAL_FETCH = globalThis.fetch;

/** Load resolver.js fresh with a controlled fetch, mirroring the browser. */
function loadResolver(fetchImpl) {
  global.window = {};
  global.fetch = fetchImpl;
  delete require.cache[require.resolve('../resolver.js')];
  delete require.cache[require.resolve('../quote.js')];
  require('../quote.js');
  global.window.PaperQuote = require('../quote.js');
  require('../resolver.js');
  return global.window.PaperTrenchResolver;
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
function notFound() {
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

test('resolves a mint address into verified identity and a positive anchor price', async () => {
  const calls = [];
  const R = loadResolver((url) => {
    calls.push(url);
    if (url.includes('/tokens/')) return jsonResponse(tokensPayload);
    return notFound(); // not a pair address
  });

  const token = await R.resolve(BONK_MINT);

  assert.ok(token, 'a mint must resolve');
  assert.ok(token.symbol && token.symbol.length > 0);
  assert.notEqual(token.symbol, token.mint, 'symbol must not be the address');
  assert.ok(token.priceNative > 0, 'must carry a positive anchor price');
  assert.ok(calls.some((u) => u.includes('/tokens/' + BONK_MINT)));
});

test('resolves a pair address, preferring the unambiguous pair lookup', async () => {
  const pairAddr = pairPayload.pair.pairAddress;
  const R = loadResolver((url) => {
    if (url.includes('/pairs/solana/')) return jsonResponse(pairPayload);
    // A token lookup on a pair address would return junk; ensure it is not used.
    return jsonResponse({
      pairs: [{
        chainId: 'solana', priceNative: '999', liquidity: { usd: 1e12 }, pairAddress: 'JUNK',
        baseToken: { address: 'JUNKMINT', symbol: 'JUNK', name: 'Junk' },
      }],
    });
  });

  const token = await R.resolve(pairAddr);

  assert.equal(token.pairAddress, pairAddr);
  assert.equal(token.symbol, pairPayload.pair.baseToken.symbol);
  assert.notEqual(token.symbol, 'JUNK', 'the pair lookup must win over the token lookup');
});

test('returns null when neither lookup yields a usable pair', async () => {
  const R = loadResolver(() => notFound());
  assert.equal(await R.resolve('NotARealAddress'), null);
});

test('survives a network failure without throwing', async () => {
  const R = loadResolver(() => Promise.reject(new Error('offline')));
  assert.equal(await R.resolve(BONK_MINT), null, 'a network error must resolve to null, not throw');
});

test('caches a resolved token so a second lookup makes no new request', async () => {
  let hits = 0;
  const R = loadResolver((url) => {
    hits++;
    if (url.includes('/tokens/')) return jsonResponse(tokensPayload);
    return notFound();
  });

  const first = await R.resolve(BONK_MINT);
  const hitsAfterFirst = hits;
  const second = await R.resolve(BONK_MINT);

  assert.equal(hits, hitsAfterFirst, 'a cached resolve must not hit the network again');
  assert.equal(second.mint, first.mint);
  assert.equal(second.priceNative, first.priceNative);
});

test('refresh re-quotes an already-resolved token', async () => {
  const R = loadResolver((url) => {
    if (url.includes('/pairs/solana/')) return jsonResponse(pairPayload);
    return notFound();
  });

  const fresh = await R.refresh({ mint: BONK_MINT, pairAddress: pairPayload.pair.pairAddress });
  assert.ok(fresh.priceNative > 0);
  assert.equal(fresh.symbol, pairPayload.pair.baseToken.symbol);
});

test('solUsd exposes the cached SOL/USD rate even when the token is unindexed', async () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const R = loadResolver((url) => {
    if (!url.includes('jup.ag')) return notFound();
    return jsonResponse([
      { id: WSOL, name: 'Wrapped SOL', symbol: 'SOL', usdPrice: 198.5 },
    ]);
  });

  const rate = await R.solUsd();
  assert.ok(rate > 0, 'must return a positive SOL/USD rate');
  assert.ok(Math.abs(rate - 198.5) < 1e-9);

  // The rate is cached: a second call must not re-fetch.
  let hits = 0;
  const R2 = loadResolver((url) => {
    if (url.includes('jup.ag')) hits++;
    return jsonResponse([
      { id: WSOL, name: 'Wrapped SOL', symbol: 'SOL', usdPrice: 201.0 },
    ]);
  });
  const first = await R2.solUsd();
  const h1 = hits;
  const second = await R2.solUsd();
  assert.equal(hits, h1, 'cached rate must not trigger a second network call');
  assert.equal(second, first, 'repeated calls return the cached value');
});

test('Solana resolver passes its cached SOL/USD rate to non-SOL pair quotes', async () => {
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) {
      return jsonResponse([{ id: WSOL, usdPrice: 102 }]);
    }
    if (url.includes('/tokens/')) return jsonResponse({ pairs: [usdcPair()] });
    return notFound();
  });

  const token = await R.resolve(BONK_MINT);
  assert.ok(token);
  assert.ok(Math.abs(token.priceNative - 0.000003112 / 102) < 1e-18);
  assert.equal(token.solUsdAtResolve, 102);
});

test('cold Jupiter rate is reused for a Dexscreener USDC quote', async () => {
  let jupiterHits = 0;
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) {
      jupiterHits++;
      return jsonResponse([{ id: WSOL, usdPrice: 102 }]);
    }
    if (url.includes('/tokens/')) return jsonResponse({ pairs: [usdcPair()] });
    return notFound();
  });

  const token = await R.resolve(BONK_MINT);
  assert.ok(token);
  assert.equal(token.solUsdAtResolve, 102);
  assert.ok(Math.abs(token.priceNative - Number(usdcPair().priceUsd) / 102) < 1e-18);
  assert.equal(jupiterHits, 1, 'the bundled Jupiter request supplies the rate');
});

test('a failed Jupiter rate gets one extra SOL/USD request before Dexscreener pricing', async () => {
  let jupiterHits = 0;
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) {
      jupiterHits++;
      if (url.endsWith('query=' + encodeURIComponent(WSOL))) {
        return jsonResponse([{ id: WSOL, usdPrice: 103 }]);
      }
      return jsonResponse([]);
    }
    if (url.includes('/tokens/')) return jsonResponse({ pairs: [usdcPair()] });
    return notFound();
  });

  const token = await R.resolve(BONK_MINT);
  assert.ok(token);
  assert.equal(token.solUsdAtResolve, 103);
  assert.ok(Math.abs(token.priceNative - Number(usdcPair().priceUsd) / 103) < 1e-18);
  assert.equal(jupiterHits, 2, 'one bundled lookup plus one cache-fill rate request');
});

test('Solana refresh passes its cached SOL/USD rate to non-SOL pair quotes', async () => {
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) {
      return jsonResponse([{ id: WSOL, usdPrice: 102 }]);
    }
    if (url.includes('/pairs/solana/')) return jsonResponse({ pair: usdcPair() });
    return notFound();
  });

  assert.equal(await R.solUsd(), 102);
  const token = await R.refresh({ mint: BONK_MINT, pairAddress: usdcPair().pairAddress });
  assert.ok(token);
  assert.ok(Math.abs(token.priceNative - 0.000003112 / 102) < 1e-18);
  assert.equal(token.solUsdAtResolve, 102);
});

test('Solana batch resolver fetches a cold-cache SOL/USD rate once for non-SOL pair quotes', async () => {
  let jupiterHits = 0;
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) {
      jupiterHits++;
      return jsonResponse([{ id: WSOL, usdPrice: 102 }]);
    }
    if (url.includes('/tokens/')) return jsonResponse({ pairs: [usdcPair()] });
    return notFound();
  });

  const prices = await R.batchPrices([BONK_MINT]);
  assert.ok(prices[BONK_MINT]);
  assert.ok(Math.abs(prices[BONK_MINT].priceNative - 0.000003112 / 102) < 1e-18);
  assert.equal(prices[BONK_MINT].solUsdAtResolve, 102);
  assert.equal(jupiterHits, 1);
});

test('Solana batch resolver refuses non-SOL pair quotes when the cold rate fetch fails', async () => {
  const R = loadResolver((url) => {
    if (url.includes('jup.ag')) return Promise.reject(new Error('offline'));
    if (url.includes('/tokens/')) return jsonResponse({ pairs: [usdcPair()] });
    return notFound();
  });

  const prices = await R.batchPrices([BONK_MINT]);
  assert.deepEqual(prices, {});
});

/* ---------------- live API (skips cleanly when offline) ---------------- */

/** Probe the live API so the assertions can be skipped (not failed) offline. */
async function probeLiveToken() {
  global.window = {};
  delete require.cache[require.resolve('../resolver.js')];
  delete require.cache[require.resolve('../quote.js')];
  global.window.PaperQuote = require('../quote.js');
  global.fetch = REAL_FETCH; // the genuine network client, not a test stub
  require('../resolver.js');
  try {
    return await global.window.PaperTrenchResolver.resolve(BONK_MINT);
  } catch (e) {
    return null;
  }
}

// Offline / API unreachable SKIPS rather than fails, so the suite never goes
// flaky for reasons unrelated to this code.
test('live Dexscreener lookup returns a usable quote', async (t) => {
  const liveToken = await probeLiveToken();
  if (!liveToken) {
    t.diagnostic('SKIP: network unavailable or API returned no usable pair');
    return t.skip();
  }

  assert.ok(liveToken.symbol && liveToken.symbol.length > 0, 'live lookup must carry a symbol');
  assert.ok(liveToken.priceNative > 0, 'live lookup must carry a positive price');
  assert.notEqual(liveToken.symbol, liveToken.mint, 'live symbol must not be the address');
});

test('a fill-path resolve can demand freshness the display cache cannot satisfy', async () => {
  // DEFECT F-04: screener quick-buy chips priced fills from the resolver's
  // 60 s display cache — a tap on a token last seen 55 s ago filled at the
  // 55 s price. resolve() accepts { maxAgeMs } so the fill path can refuse a
  // stale entry and refetch, while display callers keep the long TTL.
  let moved = false;
  const R = loadResolver((url) => {
    if (url.includes('api.dexscreener.com') && url.includes('/tokens/')) {
      if (!moved) return jsonResponse(tokensPayload);
      const shifted = JSON.parse(JSON.stringify(tokensPayload));
      for (const pair of shifted.pairs || []) {
        if (pair.priceNative) pair.priceNative = String(Number(pair.priceNative) * 2);
        if (pair.priceUsd) pair.priceUsd = String(Number(pair.priceUsd) * 2);
      }
      return jsonResponse(shifted);
    }
    return notFound();
  });

  const first = await R.resolve(BONK_MINT);
  assert.ok(first && first.priceNative > 0, 'baseline resolve must price');
  moved = true; // the market moves after the cache entry is taken

  const cached = await R.resolve(BONK_MINT);
  assert.equal(cached.priceNative, first.priceNative,
    'a plain resolve keeps serving the display cache');

  await new Promise((r) => setTimeout(r, 15));
  const fresh = await R.resolve(BONK_MINT, { maxAgeMs: 5 });
  assert.ok(fresh && fresh.priceNative > first.priceNative,
    'a fill-path resolve with maxAgeMs must refetch instead of filling at the stale price');
});
/* ---------------- D-38 resolver venue layer ---------------- */

const GMGN_D38 = {
  code: 0,
  data: {
    mint: '5oyPYDcR48bfFD3v8XTkorpTksSQWkUva4ELS4CxkqVLH',
    symbol: 'D38',
    name: 'D38 Test',
    price: '0.00001234',
    marketCap: '1234000',
    liquidity: '30000',
  },
};

const JUP_RATE_ONLY = { tokens: [{ id: 'So11111111111111111111111111111111111111112', usdPrice: '200' }] };

test('a fresh-launch mint fills from the quote layer when aggregators are silent', async () => {
  // Dexscreener and Jupiter do not know a coin minutes old; the terminal
  // quotation APIs that draw the chart on screen already do. The resolver
  // must hand over the venue record so a panel or row buy fills instantly.
  const calls = [];
  const R = loadResolver((url) => {
    calls.push(url);
    if (url.includes('api.dexscreener.com')) return notFound();
    if (url.includes('lite-api.jup.ag')) return jsonResponse(JUP_RATE_ONLY); // SOL/USD rate only
    if (url.includes('gmgn.ai')) return jsonResponse(GMGN_D38);
    return notFound();
  });

  const token = await R.resolve('5oyPYDcR48bfFD3v8XTkorpTksSQWkUva4ELS4CxkqVLH');
  assert.ok(token, 'a coin neither aggregator knows must still resolve');
  assert.ok(token.priceNative > 0, 'and carry a fillable SOL price');
  assert.equal(token.priceSource, 'gmgn', 'the quote must be attributed to its venue');
  assert.ok(calls.some((u) => u.includes('gmgn.ai/defi/quotation/v1/token/sol/')),
    'the GMGN quotation endpoint must be consulted on the failure path');
});

const D38_ADDR2 = '5a5aDcR48bfFD3v8XTorkYksSQWkUva4ELS4CxkVMP1';

test('pump.fun coin API is the second venue net on the same failure path', async () => {
  const calls = [];
  const R = loadResolver((url) => {
    calls.push(url);
    if (url.includes('api.dexscreener.com')) return notFound();
    if (url.includes('lite-api.jup.ag')) return jsonResponse(JUP_RATE_ONLY);
    if (url.includes('gmgn.ai')) return notFound();
    if (url.includes('pump.fun/api/0/coins/')) {
      return jsonResponse({
        mint: D38_ADDR2, symbol: 'PT38',
        name: 'PT D38', price: 0.00002, marketCap: 20000000, totalSupply: '999999999',
      });
    }
    return notFound();
  });

  const token = await R.resolve(D38_ADDR2);
  assert.ok(token, 'pump.fun must answer when GMGN does not');
  assert.equal(token.priceSource, 'pumpfun');
  assert.ok(calls.some((u) => u.includes('pump.fun/api/0/coins/')),
    'the pump.fun coin endpoint must be hit on the failure path');
});

test('the venue layer must NOT run when an aggregator already priced the coin', async () => {
  const calls = [];
  const R = loadResolver((url) => {
    calls.push(url);
    if (url.includes('/tokens/')) return jsonResponse(tokensPayload); // bonk known
    return notFound();
  });

  const token = await R.resolve(BONK_MINT);
  assert.ok(token && token.symbol === 'Bonk', 'resolver answer unchanged');
  assert.ok(!calls.some((u) => u.includes('gmgn.ai') || u.includes('pump.fun')),
    'venue endpoints are failure-path only — the common path pays nothing');
});