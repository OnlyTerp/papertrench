/* PaperTrench — pump.fun's real, published fee schedule.
 *
 * Pure data + pure functions. No DOM, no network, no chrome APIs, so the
 * whole schedule is directly testable and the extension runs this exact
 * code in the browser (browser/worker globals + guarded CommonJS export at
 * the bottom, same as engine.js and quote.js).
 *
 * WHY this file exists: PaperTrench charged a flat 1% per side, which is a
 * plausible-looking invention. pump.fun does NOT charge 1%. It charges 1.25%
 * on the bonding curve and a market-cap-TIERED fee once a coin graduates to
 * its canonical PumpSwap pool — falling from 1.25% all the way to 0.30% as
 * the coin grows. Paper fills that ignore that are lying to the trader in
 * BOTH directions: too cheap on a fresh curve coin, far too expensive on a
 * large graduated one. Source: https://pump.fun/docs/fees and the
 * pump-public-docs FEE_PROGRAM_README.
 */
(function () {
  'use strict';

  /* ---------------- bonding curve ---------------- */

  /**
   * Bonding curve (pre-graduation) fee, FLAT regardless of market cap:
   *   creator 0.300% + protocol 0.950% + LP 0.000% = 1.250% = 125 bps
   * There is no LP on the curve, which is why the LP leg is zero here and
   * only appears once the coin is trading in a real pool.
   */
  var CURVE_FEE_BPS = 125;

  /**
   * A PumpSwap pool that was NOT migrated from a pump.fun bonding curve is
   * just a generic AMM pool as far as the fee program is concerned: flat
   * 0.30%. It never enters the tier table.
   */
  var NON_CANONICAL_FEE_BPS = 30;

  /* ---------------- graduated (canonical PumpSwap) tiers ---------------- */

  /**
   * TOTAL fee in bps by market cap in SOL, where
   *   marketCapSol = price_in_SOL * 1e9 tokens (pump.fun's fixed supply).
   *
   * Sorted ASCENDING by threshold — `feeBpsForMarketCap` and every consumer
   * depend on that ordering, so keep it sorted if a tier is ever added.
   *
   * The 52.5 / 47.5 / 42.5 / 37.5 / 32.5 entries are FRACTIONAL bps in the
   * official schedule. They are deliberately left as floats: rounding them
   * to whole bps would silently overcharge or undercharge every fill in
   * five of the twenty-five bands.
   */
  var FEE_TIERS = [
    { marketCapSol: 0, totalBps: 125 },
    { marketCapSol: 420, totalBps: 120 },
    { marketCapSol: 1470, totalBps: 115 },
    { marketCapSol: 2460, totalBps: 110 },
    { marketCapSol: 3440, totalBps: 105 },
    { marketCapSol: 4420, totalBps: 100 },
    { marketCapSol: 9820, totalBps: 95 },
    { marketCapSol: 14740, totalBps: 90 },
    { marketCapSol: 19650, totalBps: 85 },
    { marketCapSol: 24560, totalBps: 80 },
    { marketCapSol: 29470, totalBps: 75 },
    { marketCapSol: 34380, totalBps: 70 },
    { marketCapSol: 39300, totalBps: 65 },
    { marketCapSol: 44210, totalBps: 60 },
    { marketCapSol: 49120, totalBps: 55 },
    { marketCapSol: 54030, totalBps: 52.5 },
    { marketCapSol: 58940, totalBps: 50 },
    { marketCapSol: 63860, totalBps: 47.5 },
    { marketCapSol: 68770, totalBps: 45 },
    { marketCapSol: 73681, totalBps: 42.5 },
    { marketCapSol: 78590, totalBps: 40 },
    { marketCapSol: 83500, totalBps: 37.5 },
    { marketCapSol: 88400, totalBps: 35 },
    { marketCapSol: 93330, totalBps: 32.5 },
    { marketCapSol: 98240, totalBps: 30 },
  ];

  function curveFeeBps() { return CURVE_FEE_BPS; }

  function nonCanonicalFeeBps() { return NON_CANONICAL_FEE_BPS; }

  /**
   * Official `calculateFeeTier` rule, reproduced exactly:
   *   - tiers sorted ascending by threshold;
   *   - if marketCap is below the FIRST threshold, use the FIRST tier;
   *   - otherwise walk from the HIGHEST tier down and take the first tier
   *     whose threshold is <= marketCap.
   * Band boundaries are therefore inclusive on the LOWER bound: a market cap
   * of exactly 420 SOL pays the 420 tier (120 bps), not the tier below it.
   *
   * A market cap we cannot trust (null, undefined, NaN, Infinity, negative)
   * resolves to the FIRST tier — 125 bps, the most EXPENSIVE band. That is
   * deliberate and it is the whole point: the cheap end of this table is
   * 30 bps, so a silent fallback to "cheapest" would quietly hand the
   * trader a 4x fee discount every time market-cap data went missing, and
   * paper P&L would drift optimistic exactly when the data is worst. Erring
   * expensive is the only honest direction for a missing input.
   */
  function feeBpsForMarketCap(marketCapSol) {
    var mc = Number(marketCapSol);
    if (marketCapSol === null || marketCapSol === undefined
      || !isFinite(mc) || mc < 0) {
      return FEE_TIERS[0].totalBps;
    }
    if (mc < FEE_TIERS[0].marketCapSol) return FEE_TIERS[0].totalBps;
    for (var i = FEE_TIERS.length - 1; i >= 0; i--) {
      if (FEE_TIERS[i].marketCapSol <= mc) return FEE_TIERS[i].totalBps;
    }
    return FEE_TIERS[0].totalBps;
  }

  /**
   * The single entry point the engine calls.
   *
   *   not graduated                -> bonding curve, flat 125 bps
   *   graduated + canonical pool   -> market-cap tiered
   *   graduated + non-canonical    -> flat 30 bps
   *
   * `canonical` defaults to TRUE for a graduated pump.fun coin, because that
   * is what graduation MEANS — the curve migrates into the canonical
   * PumpSwap pool. A caller has to say `canonical: false` on purpose.
   */
  function resolveFeeBps(o) {
    var ctx = o || {};
    if (!ctx.graduated) return CURVE_FEE_BPS;
    if (ctx.canonical === false) return NON_CANONICAL_FEE_BPS;
    return feeBpsForMarketCap(ctx.marketCapSol);
  }

  var api = {
    FEE_TIERS: FEE_TIERS,
    CURVE_FEE_BPS: CURVE_FEE_BPS,
    NON_CANONICAL_FEE_BPS: NON_CANONICAL_FEE_BPS,
    curveFeeBps: curveFeeBps,
    nonCanonicalFeeBps: nonCanonicalFeeBps,
    feeBpsForMarketCap: feeBpsForMarketCap,
    resolveFeeBps: resolveFeeBps,
  };

  // Loaded in BOTH worlds: content script / dashboard page (window) and the
  // service worker (self). Assigning only to window would leave PTFees
  // undefined in the worker and silently drop the engine back to the flat
  // configured fee there — the exact class of bug onchain.js already hit.
  if (typeof window !== 'undefined') window.PTFees = api;
  if (typeof self !== 'undefined') self.PTFees = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
