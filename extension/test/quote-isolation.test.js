/* Quote isolation tests (VAL-TRADE targeted group).
 *
 * Doctrine under test: cache identity is (chain, canonical address) — never
 * address alone; an unknown requested chain fails CLOSED everywhere (resolve,
 * singular pair payloads, batch parsing); the SOL/USD fallback only accepts
 * finite positive rates from same-chain stablecoin pools; concurrent rate
 * callers share one in-flight request; and poolAddresses never lists a pool
 * that does not actually contain the resolved mint on the requested chain.
 *
 * All I/O is stubbed fetch; every function exercised is the real production
 * export (resolver.js / quote.js), no re-implementations.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmWq7F';
const EVM = '0x32708538A107253b51a735A724330a23106CA4Ca'; // checksummed
const EVM_LOWER = EVM.toLowerCase();
const SOL_USD = 163.4;

const REAL_FETCH = globalThis.fetch;
const REAL_DATE_NOW = Date.now;

/** Load resolver.js + quote.js fresh with a controlled fetch, mirroring the browser. */
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

/** EVM pair factory on a given Dexscreener chainId. */
function evmPair(chainId, pairAddress, overrides = {}) {
  return {
    chainId,
    pairAddress,
    baseToken: { address: EVM, symbol: 'MC', name: 'MultiChain' },
    quoteToken: { address: '0x' + 'cd'.repeat(20), symbol: chainId === 'bsc' ? 'WBNB' : 'WETH' },
    priceUsd: '0.05',
    marketCap: 5_000_000,
    liquidity: { usd: 250_000 },
    dexId: 'pancakeswap',
    ...overrides,
  };
}

function solPair(mint, overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'PAIR' + mint.slice(0, 8),
    baseToken: { address: mint, symbol: 'TKN', name: 'Token' },
    quoteToken: { address: WSOL, symbol: 'SOL' },
    priceNative: '0.0000011',
    priceUsd: '0.00016',
    liquidity: { usd: 22000 },
    dexId: 'raydium',
    ...overrides,
  };
}

/** Stub fetch router: Jupiter search, Dexscreener WSOL batch, generic paths. */
function router(handlers) {
  return (url) => {
    if (url.startsWith('https://lite-api.jup.ag')) return handlers.jupiter(url);
    if (url.includes('/tokens/' + WSOL)) return handlers.wsolTokens(url);
    if (url.includes('/pairs/solana/')) return handlers.pair ? handlers.pair(url) : notFound();
    if (url.includes('/tokens/')) return handlers.tokens(url);
    return notFound();
  };
}

function jupiterWsok(rate) {
  return jsonResponse([{ id: WSOL, usdPrice: String(rate), symbol: 'SOL', name: 'Solana' }]);
}

test.afterEach(() => {
  global.fetch = REAL_FETCH;
  Date.now = REAL_DATE_NOW;
});

test('cache identity is chain-scoped: the same EVM address on bnb and ethereum never shares an entry', async (t) => {
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: () => {
      tokenFetches++;
      // One mixed payload: the chain filter in tokenFromPayload picks the
      // requested chain's pair, so the SAME payload yields different records.
      return jsonResponse({ pairs: [
        evmPair('bsc', '0x' + 'ab'.repeat(20), { priceUsd: '0.05' }),
        evmPair('ethereum', '0x' + 'bb'.repeat(20), { priceUsd: '0.06' }),
      ] });
    },
  }));

  const bnb = await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(bnb.chain, 'bnb', 'bnb request resolves the bsc pair');
  assert.equal(tokenFetches, 1, 'first bnb resolve fetches once');

  const eth = await R.resolve(EVM, { chain: 'ethereum' });
  assert.equal(eth.chain, 'ethereum', 'ethereum request resolves the ethereum pair');
  assert.equal(tokenFetches, 2, 'a different chain MUST miss the cache and fetch again');
  assert.notEqual(bnb.priceNative, eth.priceNative, 'the two records are distinct quotes');

  const bnbAgain = await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(bnbAgain.chain, 'bnb');
  assert.equal(tokenFetches, 2, 'the bnb entry is still cached under its own chain key');
});

test('EVM checksum casing is normalized for cache identity; base58 is case-sensitive', async (t) => {
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: () => { tokenFetches++; return jsonResponse({ pairs: [evmPair('bsc', '0x' + 'ab'.repeat(20))] }); },
  }));

  const upper = await R.resolve(EVM, { chain: 'bnb' });
  const lower = await R.resolve(EVM_LOWER, { chain: 'bnb' });
  assert.equal(tokenFetches, 1, 'lowercased EVM address must hit the checksummed entry');
  assert.equal(lower.mint, upper.mint);

  const sol = loadResolver(router({
    jupiter: () => jsonResponse([]),
    pair: () => notFound(),
    tokens: (url) => {
      tokenFetches++;
      return jsonResponse({ pairs: [solPair(BONK)] });
    },
  }));
  await sol.resolve(BONK);
  const mutated = 'DE' + BONK.slice(2); // still valid base58, different case
  await sol.resolve(mutated);
  assert.equal(tokenFetches, 3, 'base58 case change is a DIFFERENT address: cache must miss');
});

test('pair-address aliases populate the cache: resolving the mint after the pair fetches nothing new', async (t) => {
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jsonResponse([]),
    pair: () => jsonResponse({ pair: solPair(BONK) }),
    tokens: (url) => { tokenFetches++; return jsonResponse({ pairs: [solPair(BONK)] }); },
  }));

  const viaPair = await R.resolve(solPair(BONK).pairAddress);
  assert.equal(viaPair.mint, BONK, 'pair address resolves to the base mint record');
  const fetchesAfterPair = tokenFetches;

  const viaMint = await R.resolve(BONK);
  assert.equal(viaMint.mint, BONK, 'the mint alias resolves to the same record');
  assert.equal(tokenFetches, fetchesAfterPair, 'the mint alias must be served from cache');
});

test('TTL expiry and maxAgeMs freshness demands are honored on the chain-scoped cache', async () => {
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: () => { tokenFetches++; return jsonResponse({ pairs: [evmPair('bsc', '0x' + 'ab'.repeat(20))] }); },
  }));

  // Deterministic clock: no real sleeps, every boundary asserted exactly.
  let now = 1_000_000;
  Date.now = () => now;

  await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(tokenFetches, 1);

  // maxAgeMs 0 demands a quote cached at THIS exact instant; age === 0
  // satisfies it (0 > 0 is false), so no refetch.
  await R.resolve(EVM, { chain: 'bnb', maxAgeMs: 0 });

  // One tick later the same demand must miss and refetch...
  now += 1;
  const stale = await R.resolve(EVM, { chain: 'bnb', maxAgeMs: 0 });
  assert.ok(stale, 'maxAge 0 miss falls through to a fresh resolve, still returning a record');
  assert.equal(tokenFetches, 2, 'a fill-demanding maxAge must bypass a display-fresh entry');
  // ...while a display caller still rides the cached entry (age 1 < TTL 60s).
  await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(tokenFetches, 2, 'a display caller does not refetch a 1ms-old entry');

  // Display TTL is 60_000ms: age === TTL must EXPIRE (age >= TTL), the next
  // display resolve refetches.
  now += 60_000;
  await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(tokenFetches, 3, 'an entry at exactly the display TTL boundary is expired');
});

test('refresh re-quotes through the chain-scoped path and re-populates the cache', async (t) => {
  let version = 1;
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: () => {
      tokenFetches++;
      return jsonResponse({ pairs: [evmPair('bsc', '0x' + 'ab'.repeat(20), { priceUsd: '0.0' + version++ })] });
    },
  }));

  const first = await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(first.priceUsd, 0.01);
  const fresh = await R.refresh(first);
  assert.equal(fresh.priceUsd, 0.02, 'refresh fetches a new quote');
  const after = await R.resolve(EVM, { chain: 'bnb' });
  assert.equal(after.priceUsd, 0.02, 'the refreshed record replaced the cached one');
  assert.equal(tokenFetches, 2, 'resolve after refresh must be served from cache');
});

test('batchPrices parses and populates the chain-scoped cache for later resolves', async (t) => {
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: (url) => {
      tokenFetches++;
      if (url.includes('/tokens/' + WSOL)) return jsonResponse({ pairs: [] });
      return jsonResponse({ pairs: [solPair(BONK), solPair(JUP_MINT)] });
    },
  }));

  const out = await R.batchPrices([BONK, JUP_MINT]);
  assert.ok(out[BONK] && out[JUP_MINT], 'both mints priced from one batch call');
  const afterBatch = tokenFetches;
  const cached = await R.resolve(BONK);
  assert.equal(cached.mint, BONK, 'resolve after batch returns the batched record');
  assert.equal(tokenFetches, afterBatch, 'batch results must populate the cache');
  assert.ok(cached.priceNative > 0, 'batched record carries a positive SOL price');
});

test('batchPrices scopes output+cache to requested mints; an A/B base pool never corrupts a cross-chain key', async () => {
  // Mixed EVM casing on purpose: the caller's exact key must come back.
  const ETH_C = '0xE' + 'e'.repeat(39); // checksummed-ish, exists on ethereum
  const STRAY_BASE = '0x' + '99'.repeat(20); // NOT requested by anyone
  let tokenFetches = 0;
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    wsolTokens: () => jsonResponse({ pairs: [] }),
    tokens: (url) => {
      tokenFetches++;
      if (url.includes(EVM_LOWER)) {
        // bnb chunk: the wanted A(base)/WBNB pool, PLUS an unrelated X/A pool
        // whose BASE is a token nobody asked about (Dexscreener returns every
        // matching pair in the payload).
        return jsonResponse({ pairs: [
          evmPair('bsc', '0x' + 'ab'.repeat(20), { priceUsd: '0.05' }),
          { chainId: 'bsc', pairAddress: '0x' + '11'.repeat(20),
            baseToken: { address: STRAY_BASE, symbol: 'X' },
            quoteToken: { address: EVM_LOWER, symbol: 'WBNB' },
            priceUsd: '0.4', liquidity: { usd: 9e6 } },
        ] });
      }
      // ethereum chunk: base A AGAIN (same 0x address, other chain - the
      // corruption vector) plus the actually-requested C.
      return jsonResponse({ pairs: [
        evmPair('ethereum', '0x' + '22'.repeat(20), { priceUsd: '0.09' }),
        evmPair('ethereum', '0x' + '33'.repeat(20), {
          baseToken: { address: ETH_C, symbol: 'CCC' }, priceUsd: '0.07' }),
      ] });
    },
  }));

  const out = await R.batchPrices([EVM_LOWER, ETH_C], {
    [EVM_LOWER]: 'bnb',
    [ETH_C]: 'ethereum',
  });

  // The requested bnb token keeps ITS chain's record - the later ethereum
  // group (which also returned base A) must not overwrite it.
  assert.ok(out[EVM_LOWER], 'requested bnb token is present under the exact caller key');
  assert.equal(out[EVM_LOWER].chain, 'bnb');
  assert.equal(Number(out[EVM_LOWER].priceUsd), 0.05, 'bnb record survives the ethereum chunk');
  assert.ok(out[ETH_C], 'requested ethereum token is present under the exact caller key');
  assert.equal(out[ETH_C].chain, 'ethereum');
  assert.equal(Number(out[ETH_C].priceUsd), 0.07);

  // The extraneous X/A base is in neither the output nor the cache.
  assert.equal(out[STRAY_BASE], undefined, 'an unrequested base mint never leaks into the output');
  const before = tokenFetches;
  await R.resolve(STRAY_BASE, { chain: 'bnb' });
  assert.equal(tokenFetches, before + 1, 'a cache MISS proves the extraneous base was never cached');
});

test('resolve fails closed on an unknown chain slug with zero network calls', async (t) => {
  let calls = 0;
  const R = loadResolver(() => { calls++; return jsonResponse({ pairs: [] }); });
  const result = await R.resolve(EVM, { chain: 'gaschain' });
  assert.equal(result, null, 'an unmappable chain must resolve to null');
  assert.equal(calls, 0, 'no fetch may be issued for an unknown chain');
});

test('singular {pair} payloads fail closed on mismatched and unknown chains', async (t) => {
  const Q = require('../quote.js');
  const bnbSingular = { pair: evmPair('bsc', '0x' + 'ab'.repeat(20), { priceUsd: '0.05' }) };
  assert.equal(
    Q.tokenFromPayload(bnbSingular, EVM, { chain: 'ethereum', solUsd: SOL_USD }),
    null,
    'a bsc pair announced for an ethereum request must be rejected in the singular shape',
  );
  assert.equal(
    Q.tokenFromPayload(bnbSingular, EVM, { chain: 'gaschain', solUsd: SOL_USD }),
    null,
    'an unknown chain slug must reject even a structurally valid singular pair',
  );
  const ok = Q.tokenFromPayload(bnbSingular, EVM, { chain: 'bnb', solUsd: SOL_USD });
  assert.ok(ok && ok.chain === 'bnb', 'the matching chain still resolves through the singular shape');
  const batch = Q.pricesFromBatch({ pairs: [evmPair('bsc', '0x' + 'ab'.repeat(20))] }, { chain: 'gaschain' });
  assert.deepEqual(batch, {}, 'batch parsing must fail closed on an unknown chain slug');
});

test('normalizePair rejects a non-finite or non-positive final priceNative; the next valid pool wins', () => {
  const Q = require('../quote.js');
  // Raw Infinity priceNative on a solana pair.
  assert.equal(
    Q.tokenFromPayload({ pairs: [solPair(BONK, { priceNative: 'Infinity' })] }, BONK),
    null,
    'a raw Infinity priceNative must not resolve',
  );
  // NaN priceNative.
  assert.equal(
    Q.tokenFromPayload({ pairs: [solPair(BONK, { priceNative: 'NaN' })] }, BONK),
    null,
    'a NaN priceNative must not resolve',
  );
  // Zero priceNative.
  assert.equal(
    Q.tokenFromPayload({ pairs: [solPair(BONK, { priceNative: '0' })] }, BONK),
    null,
    'a zero priceNative must not resolve',
  );
  // Inversion to zero: a WSOL-BASED pair where the requested token is the
  // quote derives its native price as 1 / rawPrice; rawPrice Infinity inverts
  // to exactly 0, which must also be rejected.
  const wsolBase = {
    chainId: 'solana',
    pairAddress: 'PAIR_wsolbase',
    baseToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    quoteToken: { address: BONK, symbol: 'BONK', name: 'Bonk' },
    priceNative: 'Infinity',
    priceUsd: '0.0000016',
    liquidity: { usd: 22000 },
    dexId: 'raydium',
  };
  assert.equal(
    Q.tokenFromPayload({ pairs: [wsolBase] }, BONK),
    null,
    'a 1/Infinity inversion to zero must not resolve',
  );
  // A zero-rate foreign derivation (priceUsd / 0 -> Infinity) is rejected.
  assert.equal(
    Q.tokenFromPayload({ pairs: [evmPair('bsc', EVM, { priceUsd: '0.05' })] }, EVM, { chain: 'bnb', solUsd: 0 }),
    null,
    'a zero SOL rate must not fabricate an Infinity native price',
  );
  // The valid candidate behind a hostile one still wins (tokenFromPayload
  // walks rankPairs' candidates and takes the first that normalizes).
  const ok = Q.tokenFromPayload({
    pairs: [
      solPair(BONK, { pairAddress: 'PAIR_hostile', priceNative: 'Infinity', liquidity: { usd: 9e9 } }),
      solPair(BONK, { priceUsd: '0.00016' }),
    ],
  }, BONK);
  assert.ok(ok, 'a valid pool behind a hostile one still resolves');
  assert.equal(Number.isFinite(ok.priceNative) && ok.priceNative > 0, true, 'the winning record has a finite positive native price');
});

test('a valid foreign chain resolve derives (and records) its SOL price from the passed rate', async (t) => {
  const R = loadResolver(router({
    jupiter: () => jupiterWsok(SOL_USD),
    tokens: () => jsonResponse({ pairs: [evmPair('bsc', '0x' + 'ab'.repeat(20), { priceUsd: '0.05' })] }),
  }));

  const record = await R.resolve(EVM, { chain: 'bnb' });
  assert.ok(record, 'a known chain with a usable rate resolves');
  assert.equal(record.chain, 'bnb');
  assert.ok(Math.abs(record.priceNative - 0.05 / SOL_USD) < 1e-12, 'priceNative = priceUsd / solUsd');
  assert.equal(record.solUsdAtResolve, SOL_USD, 'the rate used is recorded on the record');
});

test('poolAddresses lists only same-chain pools that actually contain the resolved mint', async (t) => {
  const Q = require('../quote.js');
  const payload = { pairs: [
    evmPair('bsc', '0x' + '01'.repeat(20)),                                    // winner, ours
    evmPair('bsc', '0x' + '02'.repeat(20), { baseToken: { address: '0x' + 'ff'.repeat(20), symbol: 'OTHER' } }), // same chain, not our mint
    evmPair('bsc', '0x' + '03'.repeat(20), { chainId: 'ethereum' }),           // other chain, our mint
    evmPair('bsc', '0x' + '04'.repeat(20)),                                    // second legit pool
  ] };
  const record = Q.tokenFromPayload(payload, EVM, { chain: 'bnb', solUsd: SOL_USD });
  assert.ok(record, 'the winning pair resolves');
  assert.ok(Array.isArray(record.poolAddresses), 'poolAddresses is surfaced');
  assert.deepEqual(
    record.poolAddresses.sort(),
    ['0x' + '01'.repeat(20), '0x' + '04'.repeat(20)],
    'unrelated mints and other-chain pools must never enter the rekey proof',
  );
});

test('SOL/USD outage: Jupiter refusal falls back to the deepest same-chain USDC/USDT pool', async (t) => {
  let jupiterCalls = 0;
  const R = loadResolver(router({
    jupiter: () => { jupiterCalls++; return notFound(); },
    wsolTokens: () => jsonResponse({ pairs: [
      { chainId: 'bsc', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: '0x' + 'cd'.repeat(20) }, priceUsd: '1.0', liquidity: { usd: 1e12 } }, // wrong chain + not a stable
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: '163.5', liquidity: { usd: 25.9e6 } },
    ] }),
    tokens: () => jsonResponse({ pairs: [] }),
    pair: () => notFound(),
  }));

  const rate = await R.solUsd();
  assert.equal(jupiterCalls, 1, 'the primary source is attempted exactly once');
  assert.ok(rate > 0, 'the Dexscreener fallback supplies the rate when Jupiter refuses');
  assert.equal(rate, 163.5, 'the fallback returns the deepest stable-quoted pool price');
});

test('SOL/USD fallback rejects non-finite rates, foreign chains and non-stable quotes', async (t) => {
  const R = loadResolver(router({
    jupiter: () => notFound(),
    wsolTokens: () => jsonResponse({ pairs: [
      // Infinity price with the deepest liquidity must NOT win over a finite pool.
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: 'Infinity', liquidity: { usd: 1e12 } },
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: '0x' + 'cd'.repeat(20) }, priceUsd: '500', liquidity: { usd: 1e11 } },  // not USDC/USDT
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: 'Es9vMFras5nRCLKFubqtKQfSc71gUZ2KSKVVvwH7mFJU' }, priceUsd: '163.4', liquidity: { usd: 1e6 } },
      // HOSTILE: a stable-quoted pool whose BASE is a random token (an A/B
      // pool that merely quotes in USDC) - deep liquidity, plausible price.
      { chainId: 'solana', baseToken: { address: BONK, symbol: 'BONK' }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: '163.5', liquidity: { usd: 5e11 } },
      // HOSTILE: a real WSOL/USDC pool with Infinity liquidity - the deepest
      // pool on paper; only a FINITE positive liquidity is usable.
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: '163.6', liquidity: { usd: Infinity } },
    ] }),
    tokens: () => jsonResponse({ pairs: [] }),
    pair: () => notFound(),
  }));

  const rate = await R.solUsd();
  assert.equal(rate, 163.4, 'only the finite, same-chain, stable-quoted pool is usable');
  const dead = loadResolver(router({
    wsolTokens: () => jsonResponse({ pairs: [
      { chainId: 'solana', baseToken: { address: WSOL, symbol: 'SOL' }, quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, priceUsd: 'Infinity', liquidity: { usd: 1e12 } },
    ] }),
    tokens: () => jsonResponse({ pairs: [] }),
    pair: () => notFound(),
  }));
  assert.equal(await dead.solUsd(), 0, 'no usable pool means zero, never a fabricated rate');
});

test('concurrent solUsd callers share one in-flight request', async (t) => {
  let jupiterCalls = 0;
  const R = loadResolver(router({
    jupiter: async () => {
      jupiterCalls++;
      // Deterministic barrier: let the synchronous in-flight registration in
      // solUsd() settle before the (shared) fetch resolves — no wall clock.
      await new Promise((r) => setImmediate(r));
      return jupiterWsok(SOL_USD);
    },
    tokens: () => jsonResponse({ pairs: [] }),
    pair: () => notFound(),
  }));

  const [a, b, c] = await Promise.all([R.solUsd(), R.solUsd(), R.solUsd()]);
  assert.equal(jupiterCalls, 1, 'three concurrent callers must share one in-flight probe');
  assert.equal(a, SOL_USD);
  assert.equal(b, SOL_USD);
  assert.equal(c, SOL_USD);
});

test('resolveViaJupiter does not immortalize a cached SOL/USD rate past its TTL', async () => {
  let now = 1_000_000;
  Date.now = () => now;
  const queries = [];
  let rate = SOL_USD;
  const R = loadResolver(router({
    jupiter: (url) => {
      const query = new URL(url).searchParams.get('query');
      queries.push(query);
      const tokens = [{ id: JUP_MINT, usdPrice: '0.8', symbol: 'JUP', name: 'Jupiter' }];
      if (query.split(',').includes(WSOL)) {
        tokens.push({ id: WSOL, usdPrice: String(rate), symbol: 'SOL', name: 'Solana' });
      }
      return jsonResponse(tokens);
    },
    tokens: () => jsonResponse({ pairs: [] }),
    pair: () => notFound(),
  }));

  const first = await R.resolve(JUP_MINT);
  assert.equal(first.priceNative, 0.8 / SOL_USD);
  // Clear only token records. Reads inside the rate's TTL must not renew it.
  for (let step = 0; step < 2; step++) {
    now += 10_000;
    R.clearCache();
    assert.equal((await R.resolve(JUP_MINT)).priceNative, 0.8 / SOL_USD);
  }
  now += 10_000;
  rate = 200;
  R.clearCache();
  const refreshed = await R.resolve(JUP_MINT);
  assert.equal(refreshed.priceNative, 0.8 / rate, 'rate expires from its fetch time, not its last use');
  assert.deepEqual(queries, [JUP_MINT + ',' + WSOL, JUP_MINT, JUP_MINT, JUP_MINT + ',' + WSOL]);
});
