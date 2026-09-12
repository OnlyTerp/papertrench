/* Multichain paper trading (docs/MULTICHAIN.md as code).
 *
 * The doctrine under test: an off-Solana token's SOL price is DERIVED
 * (priceUsd / solUsd) with the rate RECORDED — never guessed, never taken
 * from the pair's gas-token priceNative; the chain filter is strict; and
 * the resolver never asks Solana-only sources about a foreign token.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../quote.js');

const EVM = '0x32708538A107253b51a735A724330a23106CA4Ca'; // checksummed
const EVM_LOWER = EVM.toLowerCase();

function bnbPair(overrides = {}) {
  return {
    chainId: 'bsc',
    pairAddress: '0x' + 'ab'.repeat(20),
    baseToken: { address: EVM, symbol: 'MC', name: 'MultiChain' },
    quoteToken: { address: '0x' + 'cd'.repeat(20), symbol: 'WBNB' },
    priceNative: '0.000123', // BNB-denominated — must be DISCARDED
    priceUsd: '0.05',
    marketCap: 5_000_000,
    liquidity: { usd: 250_000 },
    dexId: 'pancakeswap',
    ...overrides,
  };
}

test('an EVM pair derives its SOL price from USD and records the rate — the gas-token priceNative is discarded', () => {
  const payload = { pairs: [bnbPair()] };
  const rec = Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec, 'the record resolves');
  assert.equal(rec.chain, 'bnb');
  assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15,
    'priceNative is priceUsd / solUsd — never the BNB-denominated pair price');
  assert.equal(rec.solUsdAtResolve, 200, 'the conversion rate is recorded on the record');
  assert.equal(rec.priceUsd, 0.05);
  assert.equal(rec.mcap, 5_000_000);
});

test('no SOL/USD rate means NO record — a wrong rate corrupts every fill downstream', () => {
  const payload = { pairs: [bnbPair()] };
  assert.equal(Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 0 }), null);
  assert.equal(Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb' }), null);
});

test('the chain filter is strict: a bnb request ignores solana and ethereum pairs of the same address', () => {
  const payload = {
    pairs: [
      bnbPair({ chainId: 'solana', priceNative: '0.5' }),
      bnbPair({ chainId: 'ethereum', priceUsd: '9.99' }),
      bnbPair(), // the real one
    ],
  };
  const rec = Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec);
  assert.equal(rec.priceUsd, 0.05, 'only the bsc pair may answer a bnb request');
});

test('EVM address matching is case-tolerant; base58 stays case-SENSITIVE', () => {
  // Dexscreener returns checksummed addresses; page URLs are lowercase.
  const rec = Q.tokenFromPayload({ pairs: [bnbPair()] }, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec, 'lowercase URL address matches the checksummed pair base');
  assert.ok(Q.sameAddress(EVM, EVM_LOWER));
  assert.ok(!Q.sameAddress('So11111111111111111111111111111111111111112', 'so11111111111111111111111111111111111111112'),
    'base58 must never be compared case-insensitively');
});

test('pricesFromBatch groups one chain family per call and derives foreign prices', () => {
  // The solana-variant pair here has NO SOL-native price, so neither family
  // may quote from the other's pair.
  const payload = { pairs: [bnbPair(), bnbPair({ chainId: 'solana', priceNative: '0' })] };
  const out = Q.pricesFromBatch(payload, { chain: 'bnb', solUsd: 200 });
  const rec = out[EVM];
  assert.ok(rec, 'keyed by the pair base address');
  assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15);
  // And the default call still speaks Solana only — the bsc pair, whose
  // priceNative is BNB-denominated, must never leak into a solana batch.
  assert.deepEqual(Object.keys(Q.pricesFromBatch(payload)), []);
});

test('the resolver never asks Solana-only sources about a foreign token', async () => {
  const urls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('jup.ag')) {
      return { ok: true, json: async () => ([{ id: Q.WSOL_MINT, usdPrice: 200 }]) };
    }
    return { ok: true, json: async () => ({ pairs: [bnbPair()] }) };
  };
  try {
    delete require.cache[require.resolve('../resolver.js')];
    const R = require('../resolver.js');
    R.clearCache();
    const rec = await R.resolve(EVM_LOWER, { chain: 'bnb' });
    assert.ok(rec, 'the foreign token resolves');
    assert.equal(rec.chain, 'bnb');
    assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15, 'derived at the fetched rate');
    assert.ok(!urls.some((u) => u.includes('/pairs/solana/')),
      'the Solana pair endpoint can never answer for a foreign chain');
    assert.ok(!urls.some((u) => u.includes('jup.ag') && u.includes(EVM_LOWER)),
      'Jupiter is never asked about a foreign address — only the WSOL rate');
  } finally {
    global.fetch = realFetch;
  }
});

test('foreign pairs outside the venue price band never resolve (fantasy units)', () => {
  for (const priceUsd of ['1e-10', '2e6']) {
    assert.equal(Q.normalizePair(bnbPair({ priceUsd }), EVM, { chain: 'bnb', solUsd: 200 }), null,
      `a $${priceUsd} unit price is data error, not a market: ${priceUsd}`);
  }
  assert.ok(Q.normalizePair(bnbPair({ priceUsd: '915.67' }), EVM, { chain: 'bnb', solUsd: 200 }),
    'an in-band price still resolves — the band judges magnitude, not chain');
});

test('a foreign cap inconsistent with its own price reads unknown; the price still trades', () => {
  const rec = Q.normalizePair(bnbPair({ priceUsd: '1', marketCap: 1e15 }), EVM, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec, 'the price is usable even when the cap is nonsense');
  assert.equal(rec.priceUsd, 1);
  assert.equal(rec.mcap, null, 'a 1e15 implied supply is not a market cap');
  assert.equal(rec.mcapIsFdv, false);
});

test('an in-band fdv fallback is adopted AND flagged; an absurd one is dropped', () => {
  const flagged = Q.normalizePair(bnbPair({ marketCap: null, fdv: 5e6 }), EVM, { chain: 'bnb', solUsd: 200 });
  assert.ok(flagged);
  assert.equal(flagged.mcap, 5e6);
  assert.equal(flagged.mcapIsFdv, true, 'a substituted fully-diluted value must say so');
  const dropped = Q.normalizePair(bnbPair({ marketCap: null, fdv: 1e15 }), EVM, { chain: 'bnb', solUsd: 200 });
  assert.ok(dropped, 'the price still trades');
  assert.equal(dropped.mcap, null);
  assert.equal(dropped.mcapIsFdv, false);
});

test('a consistent B-scale foreign cap still displays (the band judges consistency, not size)', () => {
  // 7Stock printed $915.67B. Price and cap agreed with each other (1e9
  // implied supply), so the pair data is not PROVABLY wrong — it may be a
  // real stock-mirror quote. The unit corruption behind the $677M cash was
  // P0-5's gas-as-SOL tick, fixed at the validator; the resolve gate must
  // not invent a size ceiling that would also eat legitimate large caps.
  const rec = Q.normalizePair(bnbPair({ priceUsd: '915.67', marketCap: 9.1567e11 }), EVM,
    { chain: 'bnb', solUsd: 200 });
  assert.ok(rec);
  assert.equal(rec.mcap, 9.1567e11);
  assert.equal(rec.mcapIsFdv, false, 'a reported marketCap is not a fallback');
});

test('Solana keeps its legacy resolve behavior — the band is foreign-only', () => {
  const rec = Q.normalizePair({
    chainId: 'solana',
    pairAddress: 'PooLAddress1111111111111111111111111111111',
    baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'DUST' },
    quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC' },
    priceNative: '0.0000000001', priceUsd: '1e-10', marketCap: 100,
  }, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', { solUsd: 200 });
  assert.ok(rec, 'sub-band Solana dust still resolves — Jupiter/chain/venue cross-check it');
});

test('engine fills and rounds carry the chain, defaulting to solana', () => {
  const E = require('../engine.js');
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  const { trade, position } = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: EVM, symbol: 'MC', site: 'fomo',
    priceNative: 0.00025, priceUsd: 0.05, chain: 'bnb', solAmount: 1,
  });
  assert.equal(trade.chain, 'bnb');
  assert.equal(position.chain, 'bnb');
  const sold = E.sell(state, settings, {
    ts: 1_800_000_060_000, mint: EVM, site: 'fomo',
    qtyFraction: 1, priceNative: 0.0003, priceUsd: 0.06,
  });
  assert.equal(sold.trade.chain, 'bnb', 'the sell inherits the position chain');
  assert.equal(sold.round.chain, 'bnb', 'the round records where it happened');

  const sol = E.buy(state, settings, {
    ts: 1_800_000_120_000, mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL', site: 'padre', priceNative: 1, solAmount: 1,
  });
  assert.equal(sol.trade.chain, 'solana', 'no chain passed means solana');
});
