/* pump.fun's real fee schedule.
 *
 * Every expected number below is a LITERAL taken from the official published
 * schedule (https://pump.fun/docs/fees, pump-public-docs FEE_PROGRAM_README).
 * Nothing here re-derives a tier from FEE_TIERS and compares it to itself —
 * a test that calls the same lookup the implementation calls proves only
 * that the function is deterministic, not that it is CORRECT. If the tier
 * table is edited, these tests must fail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const F = require('../fees.js');

/**
 * The official table, transcribed independently of fees.js.
 * [lower bound in SOL market cap (inclusive), total fee bps]
 */
const OFFICIAL = [
  [0, 125],
  [420, 120],
  [1470, 115],
  [2460, 110],
  [3440, 105],
  [4420, 100],
  [9820, 95],
  [14740, 90],
  [19650, 85],
  [24560, 80],
  [29470, 75],
  [34380, 70],
  [39300, 65],
  [44210, 60],
  [49120, 55],
  [54030, 52.5],
  [58940, 50],
  [63860, 47.5],
  [68770, 45],
  [73681, 42.5],
  [78590, 40],
  [83500, 37.5],
  [88400, 35],
  [93330, 32.5],
  [98240, 30],
];

// One lamport expressed in SOL — the smallest step the chain can actually
// represent, so "just below the boundary" means a real, reachable market cap
// rather than a floating-point fiction.
const LAMPORT = 1e-9;

/* ---------------- shape of the table ---------------- */

test('FEE_TIERS is the official 25-band table, sorted ascending', () => {
  assert.equal(F.FEE_TIERS.length, 25, 'the schedule has exactly 25 bands');
  for (let i = 0; i < OFFICIAL.length; i++) {
    assert.equal(F.FEE_TIERS[i].marketCapSol, OFFICIAL[i][0],
      `tier ${i} threshold must be ${OFFICIAL[i][0]} SOL`);
    assert.equal(F.FEE_TIERS[i].totalBps, OFFICIAL[i][1],
      `tier ${i} total fee must be ${OFFICIAL[i][1]} bps`);
  }
  for (let i = 1; i < F.FEE_TIERS.length; i++) {
    assert.ok(F.FEE_TIERS[i].marketCapSol > F.FEE_TIERS[i - 1].marketCapSol,
      'thresholds must strictly ascend — the lookup walks the array backwards');
    assert.ok(F.FEE_TIERS[i].totalBps < F.FEE_TIERS[i - 1].totalBps,
      'fees must strictly fall as market cap grows');
  }
});

test('the schedule spans 1.25% down to 0.30%', () => {
  assert.equal(F.FEE_TIERS[0].totalBps, 125);
  assert.equal(F.FEE_TIERS[F.FEE_TIERS.length - 1].totalBps, 30);
});

/* ---------------- flat rates ---------------- */

test('the bonding curve charges a flat 125 bps (0.300 creator + 0.950 protocol + 0 LP)', () => {
  assert.equal(F.curveFeeBps(), 125);
  // 0.300% + 0.950% + 0.000% must literally add up to the published 1.25%.
  assert.equal(Math.round((0.300 + 0.950 + 0) * 100), 125);
});

test('a non-canonical PumpSwap pool charges a flat 30 bps', () => {
  assert.equal(F.nonCanonicalFeeBps(), 30);
});

/* ---------------- every boundary, exactly ---------------- */

for (let i = 0; i < OFFICIAL.length; i++) {
  const [threshold, bps] = OFFICIAL[i];

  test(`market cap of exactly ${threshold} SOL pays ${bps} bps (lower bound is inclusive)`, () => {
    assert.equal(F.feeBpsForMarketCap(threshold), bps);
  });

  test(`one lamport above ${threshold} SOL still pays ${bps} bps`, () => {
    assert.equal(F.feeBpsForMarketCap(threshold + LAMPORT), bps);
  });

  if (i > 0) {
    const belowBps = OFFICIAL[i - 1][1];
    test(`one lamport BELOW ${threshold} SOL still pays the band below, ${belowBps} bps`, () => {
      assert.equal(F.feeBpsForMarketCap(threshold - LAMPORT), belowBps);
    });

    test(`the midpoint of the ${OFFICIAL[i - 1][0]}–${threshold} SOL band pays ${belowBps} bps`, () => {
      const mid = (OFFICIAL[i - 1][0] + threshold) / 2;
      assert.equal(F.feeBpsForMarketCap(mid), belowBps);
    });
  }
}

test('a market cap above the last threshold stays at the 30 bps floor', () => {
  assert.equal(F.feeBpsForMarketCap(98240), 30);
  assert.equal(F.feeBpsForMarketCap(150000), 30);
  assert.equal(F.feeBpsForMarketCap(1e12), 30);
});

test('a market cap of zero pays the most expensive band, 125 bps', () => {
  assert.equal(F.feeBpsForMarketCap(0), 125);
});

/* ---------------- fractional bps ---------------- */

test('the five fractional-bps bands are floats, not rounded integers', () => {
  // Rounding 52.5 -> 53 or truncating to 52 misprices every fill in the band.
  assert.equal(F.feeBpsForMarketCap(54030), 52.5);
  assert.equal(F.feeBpsForMarketCap(63860), 47.5);
  assert.equal(F.feeBpsForMarketCap(73681), 42.5);
  assert.equal(F.feeBpsForMarketCap(83500), 37.5);
  assert.equal(F.feeBpsForMarketCap(93330), 32.5);

  for (const mc of [54030, 63860, 73681, 83500, 93330]) {
    const bps = F.feeBpsForMarketCap(mc);
    assert.notEqual(bps, Math.round(bps),
      `${mc} SOL must resolve to a FRACTIONAL bps value, got ${bps}`);
  }
});

test('a fractional bps turns into a real fee amount, not a rounded one', () => {
  // 10 SOL at 52.5 bps = 0.0525 SOL. At a rounded 53 bps it would be 0.053,
  // and at a truncated 52 bps 0.052 — both wrong by real money.
  const bps = F.feeBpsForMarketCap(54030);
  assert.equal(10 * bps / 10000, 0.0525);
});

/* ---------------- routing through resolveFeeBps ---------------- */

test('not graduated routes to the bonding curve regardless of market cap', () => {
  assert.equal(F.resolveFeeBps({ graduated: false, marketCapSol: 0 }), 125);
  // A huge market cap must NOT buy a discount while still on the curve.
  assert.equal(F.resolveFeeBps({ graduated: false, marketCapSol: 98240 }), 125);
  assert.equal(F.resolveFeeBps({ graduated: false, canonical: true, marketCapSol: 60000 }), 125);
});

test('graduated + canonical routes to the market-cap tier', () => {
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 0 }), 125);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 420 }), 120);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 5000 }), 100);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 54030 }), 52.5);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 99000 }), 30);
});

test('canonical defaults to true for a graduated coin — graduation MEANS the canonical pool', () => {
  assert.equal(F.resolveFeeBps({ graduated: true, marketCapSol: 420 }), 120);
  assert.equal(F.resolveFeeBps({ graduated: true, marketCapSol: 99000 }), 30);
});

test('graduated + non-canonical is a flat 30 bps and ignores market cap entirely', () => {
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false, marketCapSol: 0 }), 30);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false, marketCapSol: 420 }), 30);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false, marketCapSol: 99000 }), 30);
  // Even a missing market cap must not push it back to 125.
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false }), 30);
});

test('the three routes give three different answers at the same market cap', () => {
  const mc = 99000;
  assert.equal(F.resolveFeeBps({ graduated: false, marketCapSol: mc }), 125);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: mc }), 30);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false, marketCapSol: mc }), 30);
  // And at a LOW cap the canonical route diverges from the non-canonical one.
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: 100 }), 125);
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: false, marketCapSol: 100 }), 30);
});

/* ---------------- bad input errs EXPENSIVE, never cheap ---------------- */

test('an untrustworthy market cap falls back to 125 bps, never the 30 bps floor', () => {
  // The cheap end of this table is 4x cheaper than the expensive end. A
  // silent fallback to "cheapest" would hand the trader a fee discount
  // exactly when the data is worst, and paper P&L would drift optimistic.
  for (const bad of [null, undefined, NaN, -1, -0.000000001, -1e9, Infinity, -Infinity, 'abc', {}, []]) {
    assert.equal(F.feeBpsForMarketCap(bad), 125,
      `feeBpsForMarketCap(${String(bad)}) must be 125, not the cheapest tier`);
    assert.equal(F.resolveFeeBps({ graduated: true, canonical: true, marketCapSol: bad }), 125,
      `resolveFeeBps with marketCapSol=${String(bad)} must be 125`);
  }
});

test('a graduated canonical pool with NO market cap supplied pays 125 bps', () => {
  assert.equal(F.resolveFeeBps({ graduated: true, canonical: true }), 125);
  assert.equal(F.resolveFeeBps({ graduated: true }), 125);
});

test('resolveFeeBps with no argument at all is the bonding-curve rate', () => {
  assert.equal(F.resolveFeeBps(), 125);
  assert.equal(F.resolveFeeBps(null), 125);
  assert.equal(F.resolveFeeBps({}), 125);
});

test('a numeric string market cap is honoured rather than silently rejected', () => {
  // Page scrapes hand over strings; treating '54030' as garbage would jump
  // the fee from 52.5 to 125 bps on perfectly good data.
  assert.equal(F.feeBpsForMarketCap('54030'), 52.5);
  assert.equal(F.feeBpsForMarketCap('420'), 120);
});

/* ---------------- house style ---------------- */

test('fees.js triple-exports like every other module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'fees.js'), 'utf8');
  assert.match(src, /window\.PTFees = api/, 'must install on window for the page');
  assert.match(src, /self\.PTFees = api/, 'must install on self for the service worker');
  assert.match(src, /module\.exports = api/, 'must export for Node');
});

/* ---------------- the engine actually charges it ---------------- */

const E = require('../engine.js');

function freshState(settings) { return E.defaultState(settings); }
function settingsWith(over) {
  return Object.assign(E.defaultSettings(), { balanceStartSol: 100, slippageBps: 0, gasSolPerTx: 0, tipSolPerTx: 0 }, over || {});
}

test('a buy on a bonding-curve token is charged 125 bps, not the flat setting', () => {
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  const { trade } = E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
    graduated: false,
  });
  assert.equal(trade.feeSol, 10 * 125 / 10000);
  assert.notEqual(trade.feeSol, 10 * 100 / 10000, 'the flat 1% must no longer apply');
});

test('a buy on a large graduated canonical pool is charged the 30 bps floor', () => {
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  const { trade } = E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
    graduated: true, canonical: true, marketCapSol: 99000,
  });
  assert.equal(trade.feeSol, 10 * 30 / 10000);
});

test('a buy in a fractional-bps band charges the fractional amount', () => {
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  const { trade } = E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
    graduated: true, canonical: true, marketCapSol: 54030,
  });
  assert.equal(trade.feeSol, 0.0525);
});

test('a sell is charged the same schedule as a buy', () => {
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
    graduated: true, canonical: true, marketCapSol: 99000,
  });
  const { trade } = E.sell(state, settings, {
    mint: 'MINT', priceNative: 1e-6, qtyFraction: 1, ts: 2,
    graduated: true, canonical: true, marketCapSol: 99000,
  });
  assert.equal(trade.feeSol, trade.solGross * 30 / 10000);
});

test('with NO fee context the engine still honours settings.feeBps', () => {
  // Off-pump.fun venues and every existing caller must keep working.
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  const { trade } = E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
  });
  assert.equal(trade.feeSol, 10 * 100 / 10000);

  const zero = settingsWith({ feeBps: 0 });
  const zstate = freshState(zero);
  const zt = E.buy(zstate, zero, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
  }).trade;
  assert.equal(zt.feeSol, 0);
});

test('effectiveFeeBps is exported and reports what the fill will charge', () => {
  const settings = settingsWith({ feeBps: 100 });
  assert.equal(E.effectiveFeeBps(settings, {}), 100, 'no context -> the configured flat bps');
  assert.equal(E.effectiveFeeBps(settings, { graduated: false }), 125);
  assert.equal(E.effectiveFeeBps(settings, { graduated: true, marketCapSol: 54030 }), 52.5);
  assert.equal(E.effectiveFeeBps(settings, { graduated: true, canonical: false, marketCapSol: 54030 }), 30);
});

test('the USD mcap field never leaks into the SOL tier table', () => {
  // trade.mcap is USD. If the engine fed it to a SOL-denominated table, a
  // $50k coin (~250 SOL) would land in the 98240+ band and pay 30 bps.
  const settings = settingsWith({ feeBps: 100 });
  const state = freshState(settings);
  const { trade } = E.buy(state, settings, {
    mint: 'MINT', symbol: 'X', priceNative: 1e-6, solAmount: 10, ts: 1,
    mcap: 500000,
  });
  assert.equal(trade.feeSol, 10 * 100 / 10000,
    'a USD mcap alone must not select a tier');
});
