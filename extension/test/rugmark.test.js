/* F-55: rug-green-PnL — a drained pool may not re-mark a position UP.
 *
 * Field reports (Rems 3x/wk, husm "from 2.7 to +300", Tanza "I hit this
 * too"): the coin rugs, liquidity drains to dust, and the next resolver
 * print from that dust pool re-marks the open bag at an absurd price — a
 * dead position rendered gloriously green while the user watches equity
 * explode on a coin that already died. The on-screen tick path has F-50
 * scale-step + anchor bands; the batch/resolver mark paths had NOTHING.
 *
 * The discipline: liquidity is the honest discriminator. A rug empties the
 * pool; you cannot sell into a drained pool AT A HIGHER PRICE. An up-print
 * beyond RUG_GUARD_UP_RATIO from a collapsed pool (< RUG_GUARD_DUST_USD)
 * is the phantom and must be refused. A DOWN print is the honest rug mark
 * and MUST pass — a rug is supposed to hurt. Missing liquidity data stands
 * aside; the guard never blocks on absence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Q = require('../quote.js');

test('F-55: an up-print from a collapsed pool is refused', () => {
  // husm's case: marked at 2.7-ish, dust pool prints 100x higher.
  assert.equal(Q.rugGuardVerdict(100, 2.7, 800), 'refuse',
    'a 37x up-print from an $800 pool is a phantom');
});

test('F-55: a down-print from a collapsed pool passes (a rug must hurt)', () => {
  assert.equal(Q.rugGuardVerdict(0.02, 2.7, 300), 'pass',
    'the honest rug mark must always be accepted');
  assert.equal(Q.rugGuardVerdict(0.000001, 2.7, 50), 'pass',
    'even total-collapse marks pass');
});

test('F-55: a healthy pool never triggers the guard', () => {
  // A real runner deepens liquidity; even a 100x print from a deep pool is
  // the market's honest opinion.
  assert.equal(Q.rugGuardVerdict(270, 2.7, 250_000), 'pass',
    'deep pool, real move — pass');
  assert.equal(Q.rugGuardVerdict(2700, 2.7, 25_000), 'pass',
    'healthy pool above dust line — pass');
});

test('F-55: missing liquidity data stands aside', () => {
  assert.equal(Q.rugGuardVerdict(270, 2.7, null), 'pass',
    'no liquidity reported — guard must not block');
  assert.equal(Q.rugGuardVerdict(270, 2.7, 0), 'pass',
    'zero liquidity reported — treat as absent, stand aside');
  assert.equal(Q.rugGuardVerdict(270, 2.7, undefined), 'pass');
});

test('F-55: small up-drift inside the band passes even on a dust pool', () => {
  // +10% from a dust pool is within honest wiggle (RUG_GUARD_UP_RATIO 1.25).
  assert.equal(Q.rugGuardVerdict(3.0, 2.7, 1500), 'pass',
    'modest drift from a thin-but-alive pool is not a phantom');
});

test('F-55: guard handles degenerate inputs without throwing', () => {
  assert.equal(Q.rugGuardVerdict(0, 2.7, 100), 'pass');
  assert.equal(Q.rugGuardVerdict(NaN, 2.7, 100), 'pass');
  assert.equal(Q.rugGuardVerdict(2.7, 0, 100), 'pass');
});

test('F-55: normalizePair surfaces liquidityUsd from the Dexscreener pair', () => {
  const pair = {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: 'PAIR1111111111111111111111111111111111111111',
    baseToken: { address: 'MiNT11111111111111111111111111111111111111111', symbol: 'TST', name: 'Test' },
    quoteToken: { address: Q.WSOL_MINT, symbol: 'WSOL' },
    priceNative: '0.00000027',
    priceUsd: '0.000054',
    liquidity: { usd: 1234.5 },
    marketCap: 54000,
  };
  const rec = Q.normalizePair(pair, pair.baseToken.address, null);
  assert.ok(rec, 'pair must normalize');
  assert.equal(rec.liquidityUsd, 1234.5,
    'liquidity must ride the record so the guard can see it');
  // And a pair with no liquidity field reports null, not 0-not-undefined.
  const dry = Q.normalizePair({ ...pair, liquidity: undefined }, pair.baseToken.address, null);
  assert.equal(dry.liquidityUsd, null, 'absent liquidity is null (guard stands aside)');
});

test('F-55: the batch mark path consults the guard (source contract)', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  // The batch site must refuse phantom up-marks before E.markPosition.
  const batchIdx = content.indexOf('F-55: an up-print from a collapsed pool is a dust-pool phantom');
  assert.ok(batchIdx !== -1, 'the batch mark site must document its F-55 guard');
  const block = content.slice(batchIdx, batchIdx + 1400);
  assert.match(block, /Q\.rugGuardVerdict\(/, 'it must call rugGuardVerdict');
  const guardCall = block.indexOf('Q.rugGuardVerdict(');
  const markCall = block.indexOf('E.markPosition(');
  assert.ok(guardCall !== -1 && markCall !== -1 && guardCall < markCall,
    'the guard must run before the mark');
  assert.match(block, /refuse/, 'a refused print must skip the mark');

  // The resolver-refresh site too.
  const resolverIdx = content.indexOf('F-55: this resolver adoption also re-marks any HELD position');
  assert.ok(resolverIdx !== -1, 'the resolver adoption site must have the guard');
  const rblock = content.slice(resolverIdx, resolverIdx + 1400);
  assert.match(rblock, /Q\.rugGuardVerdict\(/, 'resolver path calls the guard');
  assert.ok(rblock.indexOf('Q.rugGuardVerdict(') < rblock.indexOf('E.markPosition('),
    'resolver guard precedes its mark');
});
