/* PaperTrench — constant-product (x*y=k) price impact.
 *
 * Pure functions over two pool reserves. No DOM, no chrome APIs, no clock,
 * no randomness — same inputs, same fill, forever.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this module landed the paper engine priced every fill with a FLAT
 * multiplier: `px * (1 + slippageBps/10000)`. Trade size was not an input at
 * all, so a 50 SOL buy into a 12 SOL pool filled at exactly the same price as
 * a 0.01 SOL buy. That is the single most dishonest thing a paper trader can
 * be told, because it lets someone "profit" from a size they could never have
 * filled on chain. A real AMM has no such mercy: you are trading against a
 * curve, and the deeper you push into it the worse every subsequent token
 * costs you.
 *
 * The curve is the standard Uniswap-V2 invariant, which is exactly what both
 * of PaperTrench's real price sources already are:
 *   - pump.fun bonding curves (onchain.js decodePumpCurve) — V2-shaped over
 *     SYNTHETIC `virtualSol` / `virtualToken` reserves.
 *   - PumpSwap / Raydium CP pools (onchain.js decodePumpSwapPool) — literal
 *     base/quote vault balances.
 * Both already surface reserves, and both already derive spot price as
 * quoteReserve / baseReserve (onchain.js priceFromVaults). This module is the
 * missing second half: what the price becomes once YOUR order is in the pool.
 *
 * FEES ARE NOT OUR JOB
 * --------------------
 * Every amount handed to these functions is treated as ALREADY NET OF FEES.
 * Platform fees, priority fees and tips are a separate concern owned by the
 * engine (and by extension/fees.js). Folding a fee into the curve here would
 * double-charge it and, worse, would make `priceImpactPct` a lie — impact is
 * a property of the POOL, not of what a venue chooses to skim. Callers
 * subtract their fee first, then ask the curve what the remainder buys.
 *
 * HONESTY RULES ENFORCED HERE
 * ---------------------------
 *  - Degenerate input returns `null`, never a plausible-looking number. A
 *    missing, zero, negative, NaN or Infinite reserve/amount means we do not
 *    know the fill, and saying so is the whole point of this product.
 *  - An oversized trade is PRICED, NOT REJECTED. See OVERSIZED TRADES below.
 *  - No output is ever Infinity or NaN. Every returned field is checked
 *    finite before the result leaves the function.
 *
 * OVERSIZED TRADES
 * ----------------
 * The constant product self-caps, so there is nothing to clamp by hand:
 *
 *   tokensOut = baseReserve - k/(quoteReserve + solIn)
 *
 * `k/(quoteReserve + solIn)` is strictly positive for any positive solIn, so
 * tokensOut is strictly LESS than baseReserve no matter how large the order
 * is. The pool can be pushed arbitrarily far but never drained, and the price
 * paid grows without bound — a 10x-the-pool buy simply returns a real,
 * catastrophic fill (~1000% impact). We deliberately do NOT reject it: a
 * refusal would hide exactly the lesson the trader needs to see, which is
 * that their size does not fit. The symmetric statement holds for sells:
 * solOut is strictly less than quoteReserve.
 */
(() => {
  'use strict';

  /** Finite and strictly positive. Rejects NaN, Infinity, null, '', objects. */
  function pos(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Normalize the reserve pair every quote needs.
   * Returns { baseReserve, quoteReserve, spotPrice, k } or null.
   *
   * `spotPrice` is quote-per-base — the same definition onchain.js already
   * uses (priceFromVaults returns quote / base), so impact measured against
   * it is measured against the number the trader is looking at.
   */
  function poolState(o) {
    if (!o || typeof o !== 'object') return null;
    const baseReserve = pos(o.baseReserve);
    const quoteReserve = pos(o.quoteReserve);
    if (baseReserve === null || quoteReserve === null) return null;

    const k = baseReserve * quoteReserve;
    // Reserves can be huge (raw lamports x raw token units); if their product
    // overflows to Infinity every downstream number is garbage, so refuse.
    if (!Number.isFinite(k) || k <= 0) return null;

    const spotPrice = quoteReserve / baseReserve;
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;

    return { baseReserve, quoteReserve, spotPrice, k };
  }

  /** Last gate before a result escapes: no Infinity, no NaN, no zero prices. */
  function finiteQuote(q) {
    const keys = Object.keys(q);
    for (let i = 0; i < keys.length; i++) {
      const v = q[keys[i]];
      if (!Number.isFinite(v)) return null;
    }
    if (!(q.avgPrice > 0) || !(q.endPrice > 0)) return null;
    return q;
  }

  /**
   * Buy: `solIn` quote-currency units (already net of fees) into the pool.
   *
   * tokensOut = baseReserve - k/(quoteReserve + solIn)
   * avgPrice  = solIn / tokensOut          (what you ACTUALLY paid per token)
   * impact    = (avgPrice/spotPrice - 1) * 100
   * endPrice  = (quoteReserve + solIn) / (baseReserve - tokensOut)
   *
   * Note avgPrice sits BETWEEN spotPrice and endPrice: you fill across the
   * curve, so you neither get the pre-trade tick nor pay the post-trade one.
   *
   * @returns {{tokensOut:number, avgPrice:number, priceImpactPct:number, endPrice:number}|null}
   */
  function quoteBuy(o) {
    const pool = poolState(o);
    if (!pool) return null;
    const solIn = pos(o.solIn);
    if (solIn === null) return null;

    const quoteAfter = pool.quoteReserve + solIn;
    if (!Number.isFinite(quoteAfter)) return null;

    const baseAfter = pool.k / quoteAfter;
    const tokensOut = pool.baseReserve - baseAfter;
    // Strictly-less-than-baseReserve is the invariant that makes the pool
    // undrainable. If floating point ever eats the difference (a solIn so
    // vast that baseAfter rounds to 0, or so tiny it rounds to nothing) we
    // have no honest answer to give.
    if (!(tokensOut > 0) || !(tokensOut < pool.baseReserve)) return null;
    if (!(baseAfter > 0)) return null;

    return finiteQuote({
      tokensOut,
      avgPrice: solIn / tokensOut,
      priceImpactPct: ((solIn / tokensOut) / pool.spotPrice - 1) * 100,
      endPrice: quoteAfter / baseAfter,
    });
  }

  /**
   * Sell: `tokensIn` base-currency units (already net of fees) into the pool.
   *
   * solOut   = quoteReserve - k/(baseReserve + tokensIn)
   * avgPrice = solOut / tokensIn
   * impact   = (avgPrice/spotPrice - 1) * 100   — NEGATIVE for a sell, because
   *            you receive less per token than the tick showed. Keeping the
   *            same formula (rather than flipping the sign) means the number
   *            always reads "how far the fill moved AGAINST the quote".
   * endPrice = (quoteReserve - solOut) / (baseReserve + tokensIn)
   *
   * @returns {{solOut:number, avgPrice:number, priceImpactPct:number, endPrice:number}|null}
   */
  function quoteSell(o) {
    const pool = poolState(o);
    if (!pool) return null;
    const tokensIn = pos(o.tokensIn);
    if (tokensIn === null) return null;

    const baseAfter = pool.baseReserve + tokensIn;
    if (!Number.isFinite(baseAfter)) return null;

    const quoteAfter = pool.k / baseAfter;
    const solOut = pool.quoteReserve - quoteAfter;
    // Mirror of the buy invariant: you can never extract the whole quote side.
    if (!(solOut > 0) || !(solOut < pool.quoteReserve)) return null;
    if (!(quoteAfter > 0)) return null;

    return finiteQuote({
      solOut,
      avgPrice: solOut / tokensIn,
      priceImpactPct: ((solOut / tokensIn) / pool.spotPrice - 1) * 100,
      endPrice: quoteAfter / baseAfter,
    });
  }

  /** The pre-trade tick these quotes measure impact against. null if unknown. */
  function spotPrice(o) {
    const pool = poolState(o);
    return pool ? pool.spotPrice : null;
  }

  const api = { quoteBuy, quoteSell, spotPrice };

  // House triple-export: content script (window), service worker (self), and
  // node's test runner (module.exports) all load the same file.
  if (typeof window !== 'undefined') window.PTSlippage = api;
  if (typeof self !== 'undefined') self.PTSlippage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
