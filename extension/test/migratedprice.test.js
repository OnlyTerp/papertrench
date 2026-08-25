/* A graduated pump.fun coin must still get a LIVE PRICE (D-59).
 *
 * Community reports, 2026-08-24:
 *   cheng.4848    "it is difficult to make purchases in time after the
 *                  currency migration"
 *   ark_trades13  "the "Fetching live price…" thing happens to me too, but
 *                  only on migrated tokens"
 *
 * Root cause: a pump.fun bonding curve goes `complete: true` when the coin
 * graduates and STOPS carrying a price — prewatchPool refuses it by design
 * ("migrated: the resolver path owns it"). But the resolver path only ever
 * read the MINT account, which yields identity and supply and no price at
 * all. So for the minutes right after migration — the single most tradable
 * window a memecoin has — PaperTrench had no on-chain price and sat on
 * "Fetching live price…" until an aggregator got around to indexing the new
 * pool.
 *
 * The coin is not unpriceable. It has migrated INTO a PumpSwap AMM pool
 * (program pAMMBay6…), which is a plain constant-product pool PaperTrench
 * already has a verified decoder for. It simply was never looked up.
 *
 * These fixtures are REAL mainnet bytes, captured 2026-08-25 from the
 * migrated coin vH6HyoNG…pump ("中国石化") and its pump.fun-reported pool
 * 7vEpDRUy…, so the production decoders run against production data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Feed = require('../onchain-feed.js');
const O = require('../onchain.js');

const MINT = 'vH6HyoNGaWvKHsK1ENNCqFuZhLfR1cpw46TFeGVpump';
const POOL = '7vEpDRUy5PSiBJNdBiiuMxN7KbM7HA3fxhFvgrjRrEnV';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const WSOL = 'So11111111111111111111111111111111111111112';

const POOL_B64 = '8ZptBBGxbbz/AAB6Q1C2SE89KA7SMGRjsC0xmydsAww4ybhZq8eLDq91Xg2l+jGnfH5sq/B/loP1vNqbnbVXwQB7/ZrAuoz/r3cvBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAH7k4VEaTb9JD2KUFTUF0k578Q/o9f2Q4LOT2eALEgelXKkRFjunv3VGc7uoA8/jzdGj5PGfiHlhH+GkSetr9M/pYZCpKYOprMDyFkXXeytdgHE0HHlS41edz8YkLYNIyiAQ2tZ0AMAANtrCTeFrtufaX+xVr/2hO8KczlnuxLsd5jujBQFnuDEAADJQR4YBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const BASE_VAULT_B64 = 'DaX6Mad8fmyr8H+Wg/W82pudtVfBAHv9msC6jP+vdy9myYYmPr/nVRSFb+6zsOz3xX63sYItOsKEBbLws0QBSjUEfqYQMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgcAAAA=';
const QUOTE_VAULT_B64 = 'BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFmyYYmPr/nVRSFb+6zsOz3xX63sYItOsKEBbLws0QBShjv2+1HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAADwHR8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/* ---------- the decoder, against real bytes ---------- */

test('the PumpSwap pool layout decodes a real mainnet pool (D-59)', () => {
  const decoded = O.decodePumpSwapPool(O.bytesFromBase64(POOL_B64));
  assert.ok(decoded, 'a 301-byte PumpSwap pool must decode');
  // Every one of these is what pump.fun's own API reports for this coin.
  assert.equal(decoded.baseMint, MINT, 'base mint sits at offset 43');
  assert.equal(decoded.quoteMint, WSOL, 'quote mint sits at offset 75');
  assert.equal(decoded.baseVault, '8iWkrWUntx3iRxyk59p5mcNnvF6qwER21xXHDsFTgHJn');
  assert.equal(decoded.quoteVault, 'C991coUvgVFfHhhkaJUhPEdz6CYGk1yJrmHNPQdRp3Hh');
});

test('a graduated pool is classified by the decoder we already trust (D-59)', () => {
  // The whole fix rests on this: PumpSwap is cp-vaults, a kind the feed
  // already watches and prices. If this ever stops being true the pool would
  // be discovered and then silently refused.
  assert.equal(O.poolKindForOwner(PUMP_AMM), 'cp-vaults');
});

test('a Token-2022 base vault reads with the same decoder as a classic one (D-59)', () => {
  // Graduated pools routinely pair a 170-byte Token-2022 base vault with a
  // 165-byte classic SPL quote vault. Both share the prefix decodeTokenAccount
  // reads; assuming 165 everywhere would drop the base leg and the price.
  const base = O.decodeTokenAccount(O.bytesFromBase64(BASE_VAULT_B64));
  const quote = O.decodeTokenAccount(O.bytesFromBase64(QUOTE_VAULT_B64));
  assert.ok(base && quote, 'both vault legs must decode');
  assert.equal(base.mint, MINT);
  assert.equal(quote.mint, WSOL);
  assert.ok(base.amount > 0 && quote.amount > 0, 'a live pool holds both legs');
});

/* ---------- the lookup, driving the real function ---------- */

/**
 * Stand in for the RPC pool. Only the reads findGraduatedPool actually makes
 * are answered; anything else throws, so a test can never pass on a call the
 * production path did not make.
 */
function fakePool(accounts, opts) {
  const seen = { gpa: 0, reads: [] };
  const pool = {
    setUserEndpoint() {},
    call(method, params) {
      if (method === 'getProgramAccounts') {
        seen.gpa++;
        seen.gpaProgram = params[0];
        seen.gpaFilters = params[1] && params[1].filters;
        return Promise.resolve((opts && opts.gpa) || []);
      }
      if (method === 'getMultipleAccounts') {
        seen.reads.push(params[0]);
        return Promise.resolve({
          context: { slot: 1000 },
          value: params[0].map((a) => accounts[a] || null),
        });
      }
      throw new Error('unexpected RPC call in this test: ' + method);
    },
  };
  return { pool, seen };
}

const POOL_ACCOUNT = { owner: PUMP_AMM, data: [POOL_B64, 'base64'] };

/**
 * Load a FRESH copy of the feed with a fake RPC pool in place.
 *
 * The module binds its pool at load time (`self.PTRpcPool`), which is the
 * right design for production and means a test must install the fake before
 * the require rather than reaching inside afterwards. Clearing the cache
 * entry keeps each case isolated.
 */
function loadFeedWith(pool) {
  const feedPath = require.resolve('../onchain-feed.js');
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'PTRpcPool');
  const prev = globalThis.PTRpcPool;
  const prevSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.PTRpcPool = pool;
  delete require.cache[feedPath];
  try {
    return require('../onchain-feed.js');
  } finally {
    delete require.cache[feedPath];
    if (had) globalThis.PTRpcPool = prev; else delete globalThis.PTRpcPool;
    if (prevSelf === undefined) delete globalThis.self; else globalThis.self = prevSelf;
  }
}

test('the graduated pool is found by asking the chain which pool holds the mint (D-59)', async () => {
  const { pool, seen } = fakePool(
    { [POOL]: POOL_ACCOUNT },
    { gpa: [{ pubkey: POOL }] }
  );
  const feed = loadFeedWith(pool);
  const found = await feed._findGraduatedPool(MINT);
  assert.equal(found, POOL, 'the migrated coin resolves to its real pool');
  // The filter must be an indexed memcmp on the base-mint offset — a scan of
  // every pool on the program would be far too expensive to run on a click.
  assert.equal(seen.gpaProgram, PUMP_AMM);
  assert.deepEqual(seen.gpaFilters, [{ memcmp: { offset: 43, bytes: MINT } }]);
});

test('a pool quoted in something other than SOL is refused (D-59)', async () => {
  // The feed prices in SOL end to end. A USDC-quoted pool would decode
  // perfectly and mean a completely different number.
  const bytes = O.bytesFromBase64(POOL_B64);
  const usdc = O.b58decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  bytes.set(usdc, 75);
  const usdcPool = { owner: PUMP_AMM, data: [Buffer.from(bytes).toString('base64'), 'base64'] };

  const { pool } = fakePool({ [POOL]: usdcPool }, { gpa: [{ pubkey: POOL }] });
  const feed = loadFeedWith(pool);
  assert.equal(await feed._findGraduatedPool(MINT), null,
    'a non-SOL pool must never be adopted as the price');
});

test('a pool owned by an unverified program is refused (D-59)', async () => {
  // gPA answered, but the account is not a program we have a decoder for.
  const impostor = { owner: 'StakeConfig11111111111111111111111111111111', data: [POOL_B64, 'base64'] };
  const { pool } = fakePool({ [POOL]: impostor }, { gpa: [{ pubkey: POOL }] });
  const feed = loadFeedWith(pool);
  assert.equal(await feed._findGraduatedPool(MINT), null);
});

test('no pool on chain means no invented answer (D-59)', async () => {
  const { pool } = fakePool({}, { gpa: [] });
  const feed = loadFeedWith(pool);
  assert.equal(await feed._findGraduatedPool(MINT), null);
});

test('the deepest SOL pool wins when a coin has more than one (D-59)', async () => {
  // Dust pools exist. Quoting one would show a price nobody can trade at.
  // The thin pool is returned FIRST by gPA, so a "take the first candidate"
  // implementation would pick it — the depth comparison is what must decide.
  const SECOND = '5rFQRVChhZbPvUJvLSGqTVJfLdeTFV7CxczV6NNvXbLK';
  const THIN_VAULT = 'C991coUvgVFfHhhkaJUhPEdz6CYGk1yJrmHNPQdRp3Ha';

  // A real quote-vault account, rewritten to hold dust instead of 304 SOL.
  const dustBytes = O.bytesFromBase64(QUOTE_VAULT_B64);
  for (let i = 0; i < 8; i++) dustBytes[64 + i] = 0;
  dustBytes[64] = 1; // 1 lamport: non-zero, so it is a live pool, just empty

  const thinPool = O.bytesFromBase64(POOL_B64);
  thinPool.set(O.b58decode(THIN_VAULT), 171);

  const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const accounts = {
    [POOL]: POOL_ACCOUNT,
    [SECOND]: { owner: PUMP_AMM, data: [Buffer.from(thinPool).toString('base64'), 'base64'] },
    C991coUvgVFfHhhkaJUhPEdz6CYGk1yJrmHNPQdRp3Hh: { owner: SPL, data: [QUOTE_VAULT_B64, 'base64'] },
    [THIN_VAULT]: { owner: SPL, data: [Buffer.from(dustBytes).toString('base64'), 'base64'] },
  };
  const { pool } = fakePool(accounts, { gpa: [{ pubkey: SECOND }, { pubkey: POOL }] });
  const feed = loadFeedWith(pool);
  assert.equal(await feed._findGraduatedPool(MINT), POOL,
    'the pool with real depth is the one a fill would touch, not the first one listed');
});

test('one lookup never pays for two program scans (Devin review, PR #77)', async () => {
  // getProgramAccounts is the heaviest read this module makes and the public
  // endpoint is keyless. A pump-suffixed mint whose curve is NOT live used to
  // run the scan in the pump branch AND again in the mint-facts branch.
  //
  // The case the review found: the scan comes back EMPTY (no pool indexed
  // yet) but the mint account IS visible, so execution reaches the
  // mint-facts branch carrying the same address.
  const MINT_B64 = 'AQAAAAaJgY9K1B/CG8UcLbCKrDdHDVpXpDDmMBqLLnJPPRT6AICWmAsAAAAGAQEAAAAGiYGPStQfwhvFHC2wiqw3Rw1aV6Qw5jAaiy5yTz0U+g==';
  const { pool, seen } = fakePool(
    { [MINT]: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [MINT_B64, 'base64'] } },
    { gpa: [] },                   // no pool on chain yet
  );
  const feed = loadFeedWith(pool);

  await feed.prewatch({ mint: MINT });

  assert.equal(seen.gpa, 1, `the program scan must run once; ran ${seen.gpa}x`);
});
