/* PaperTrench — prediction-market fill engine.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT)
 * Source files: packages/core/src/book.ts, packages/core/src/decimal.ts,
 *              packages/core/src/types.ts, supabase/functions/_shared/fill.ts
 *
 * Pure functions over plain data — no DOM, no chrome APIs, no network I/O.
 * The content script, background worker, and dashboard all load this module
 * and drive it with storage reads/writes.
 *
 * Levels are [priceCents, size] tuples. Prices are in CENTS (1–99).
 * A Level is always sorted BEST FIRST: highest bid first, lowest ask first.
 */
(() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────
  /** Max fraction of visible depth a single order may consume. */
  const MAX_DEPTH_FRACTION = 0.05;
  /** How far the price may move against the user between quote and fill. */
  const PRICE_MOVE_TOLERANCE = 0.02;
  /** How old a book snapshot may be (ms) before we refuse to quote. */
  const MAX_BOOK_AGE_MS = 30000;
  /** Max fraction of visible depth a single position may represent. */
  const POSITION_LIMIT_FRACTION = 0.2;

  // ─── Precision ─────────────────────────────────────────────────────────
  // Matches the SQL column types used by the reference backend:
  //   price  → cents, 2 dp numeric(6,2) / numeric(8,4) for averages
  //   qty    → units, 2 dp numeric(20,2)
  //   money  → dollars, 6 dp numeric(20,6) — micro-dollars matching USDC
  const PRICE_DP = 4;
  const QTY_DP = 2;
  const MONEY_DP = 6;

  // ─── Decimal helpers ───────────────────────────────────────────────────
  /**
   * Multiply `value` by 10^exp without ever going through float multiplication.
   * Naively writing ``Number(`${value}e${exp}`)`` breaks the moment a number's
   * own toString is already exponential. Splits off any existing exponent and
   * adds to it.
   */
  function shiftExponent(value, exp) {
    if (value === 0 || !Number.isFinite(value)) return value;
    const parts = `${value}`.split('e');
    const mantissa = parts[0];
    const existing = parts.length > 1 ? Number(parts[1]) : 0;
    const nextExp = existing + exp;
    return Number(`${mantissa}e${nextExp}`);
  }

  /**
   * Round half-away-from-zero at `dp` decimal places.
   * `Math.round(x * 10 ** dp)` alone is wrong when the float representation
   * lands just below a .5 boundary. Shifting through the decimal string
   * repairs that before rounding.
   */
  function roundTo(value, dp) {
    if (!Number.isFinite(value)) return 0;
    const scaled = shiftExponent(value, dp);
    if (!Number.isFinite(scaled)) return 0;
    const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
    const out = shiftExponent(rounded, -dp);
    return !Number.isFinite(out) || out === 0 ? 0 : out;
  }

  function roundPrice(v) { return roundTo(v, PRICE_DP); }
  function roundQty(v) { return roundTo(v, QTY_DP); }
  function roundMoney(v) { return roundTo(v, MONEY_DP); }

  /**
   * Round toward zero at `dp` places.
   * The fill engine floors quantities rather than rounding them: a dollar
   * budget is a ceiling the user set, and rounding a partial unit up would
   * spend money they did not offer.
   */
  function floorTo(value, dp) {
    if (!Number.isFinite(value)) return 0;
    const scaled = shiftExponent(value, dp);
    if (!Number.isFinite(scaled)) return 0;
    const truncated = Math.sign(scaled) * Math.floor(Math.abs(scaled));
    const out = shiftExponent(truncated, -dp);
    return !Number.isFinite(out) || out === 0 ? 0 : out;
  }

  function floorQty(v) { return floorTo(v, QTY_DP); }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * Snap a price to a tick grid. Works in scaled integers to avoid
   * 0.1 + 0.2 drift.
   */
  function snapToTick(priceCents, tickCents, mode) {
    if (mode === undefined) mode = 'nearest';
    if (!(tickCents > 0)) return roundPrice(priceCents);
    const scale = Math.pow(10, PRICE_DP);
    const p = Math.round(priceCents * scale);
    const t = Math.round(tickCents * scale);
    if (t <= 0) return roundPrice(priceCents);
    const q = p / t;
    const snapped = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
    return roundPrice((snapped * t) / scale);
  }

  // ─── Book helpers ──────────────────────────────────────────────────────

  /** Total units visible on a ladder side. */
  function depthQty(levels) {
    let q = 0;
    for (let i = 0; i < levels.length; i++) {
      if (levels[i][1] > 0) q += levels[i][1];
    }
    return roundQty(q);
  }

  /**
   * Total dollar value visible on a ladder side.
   * This is what the 5% cap measures against.
   */
  function depthNotional(levels) {
    let usd = 0;
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      if (l[1] > 0 && l[0] > 0 && l[0] < 100) usd += (l[1] * l[0]) / 100;
    }
    return roundMoney(usd);
  }

  function bestBid(ladder) {
    const l = ladder.bids[0];
    return l ? roundPrice(l[0]) : null;
  }

  function bestAsk(ladder) {
    const l = ladder.asks[0];
    return l ? roundPrice(l[0]) : null;
  }

  /**
   * Mid price in cents, or null when the book is one-sided.
   * The mid is `p_market` in the calibration record — the price the market
   * thought was fair at the moment you disagreed with it.
   */
  function midPrice(ladder) {
    const b = bestBid(ladder);
    const a = bestAsk(ladder);
    if (b == null && a == null) return null;
    if (b == null) return a;
    if (a == null) return b;
    return roundPrice((b + a) / 2);
  }

  function spreadCents(ladder) {
    const b = bestBid(ladder);
    const a = bestAsk(ladder);
    if (b == null || a == null) return null;
    return roundPrice(a - b);
  }

  /**
   * Slippage of a fill against the book mid, in basis points, signed so that
   * positive always means "worse for the user".
   */
  function slippageBps(avgPriceCents, midCents, side) {
    if (!(midCents > 0) || !(avgPriceCents > 0)) return 0;
    const raw = ((avgPriceCents - midCents) / midCents) * 10000;
    return roundPrice(side === 'buy' ? raw : -raw);
  }

  /**
   * The ladder a market order actually consumes.
   * Buying takes from asks; selling hits bids. Selling YES is not buying NO.
   */
  function takerLevels(ladder, side) {
    return side === 'buy' ? ladder.asks : ladder.bids;
  }

  /**
   * Apply Brutal mode's adverse tick: you fill one tick worse than the book
   * showed. Buys pay more, sells receive less. Never crosses 0 or 100.
   */
  function applyAdverseTicks(levels, side, ticks, tickCents) {
    if (!ticks) return levels;
    const delta = ticks * tickCents * (side === 'buy' ? 1 : -1);
    const out = [];
    for (let i = 0; i < levels.length; i++) {
      const l = levels[i];
      const p = roundPrice(clamp(l[0] + delta, tickCents, 100 - tickCents));
      out.push([p, l[1]]);
    }
    return out;
  }

  /**
   * Ladder invariant check — the single most likely catastrophic bug in the
   * codebase, so it gets asserted on every snapshot rather than trusted.
   *
   * A YES bid at 7c IS a NO ask at 93c, same size. If these drift apart,
   * the adapter mis-parsed the venue payload and every fill price is
   * silently wrong.
   *
   * Returns { ok, violations, checked }.
   */
  function checkBookInvariants(yes, no, toleranceCents) {
    if (toleranceCents === undefined) toleranceCents = 0.01;
    const violations = [];
    let checked = 0;

    const pairs = [
      ['best_yes_ask == 100 - best_no_bid', bestAsk(yes), bestBid(no) == null ? null : 100 - bestBid(no)],
      ['best_no_ask == 100 - best_yes_bid', bestAsk(no), bestBid(yes) == null ? null : 100 - bestBid(yes)],
      ['best_yes_bid == 100 - best_no_ask', bestBid(yes), bestAsk(no) == null ? null : 100 - bestAsk(no)],
      ['best_no_bid == 100 - best_yes_ask', bestBid(no), bestAsk(yes) == null ? null : 100 - bestAsk(yes)],
    ];

    for (let i = 0; i < pairs.length; i++) {
      const label = pairs[i][0];
      const lhs = pairs[i][1];
      const rhs = pairs[i][2];
      if (lhs == null || rhs == null) continue; // one-sided book
      checked++;
      if (Math.abs(lhs - rhs) > toleranceCents) {
        violations.push(`${label}: ${lhs} vs ${rhs} (delta ${roundPrice(lhs - rhs)})`);
      }
    }

    return { ok: violations.length === 0, violations, checked };
  }

  /**
   * A ladder is well-formed when it is sorted best-first with no crossed
   * prices. Bids should be descending, asks ascending.
   */
  function isSortedBestFirst(levels, side) {
    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1][0];
      const cur = levels[i][0];
      if (side === 'bids' ? cur > prev : cur < prev) return false;
    }
    return true;
  }

  // ─── Walk engine (the heart) ───────────────────────────────────────────

  /**
   * Walk a real order book and produce an honest fill.
   *
   * The four rules of the fill engine live and die here:
   *   1. Never fill beyond visible depth. If the book shows 500 and you want
   *      2,000, you get 500 and the order is partial. No synthesized liquidity.
   *   2. (enforced by the caller via `depthNotional` + maxDepthFraction)
   *   3. (enforced by the caller — it re-walks a post-latency snapshot)
   *   4. No market impact modelling. The book does not react to you.
   *
   * `levels` must be sorted BEST FIRST. Adapters guarantee this.
   *
   * `tickCents` snaps the level prices onto the venue's grid so a fill price
   * can never claim a precision the venue does not actually quote at.
   *
   * @param {Array<[number, number]>} levels - [priceCents, size] sorted best first
   * @param {{ kind: 'qty', qty: number } | { kind: 'notional', usd: number }} target
   * @param {number} [tickCents=1]
   * @returns {{ fills, avgPrice, totalQty, cost, partial, unfilledQty, levelsConsumed }}
   */
  function walkBook(levels, target, tickCents) {
    if (tickCents === undefined) tickCents = 1;

    const fills = [];
    let remainingQty = target.kind === 'qty' ? target.qty : Number.POSITIVE_INFINITY;
    let remainingUsd = target.kind === 'notional' ? target.usd : Number.POSITIVE_INFINITY;
    let totalQty = 0;
    let cost = 0;

    if (!(remainingQty > 0) || !(remainingUsd > 0)) {
      return { fills, avgPrice: 0, totalQty: 0, cost: 0, partial: false, unfilledQty: 0, levelsConsumed: 0 };
    }

    // Why the walk stopped — the difference between "the book ran out" and
    // "your budget bought everything it could afford".
    // Only the first is a partial fill. Quantities are floored to QTY_DP, so
    // a $100 order at 99.1c leaves ~0.009 of a cent that cannot buy another
    // hundredth of a share. That residue was being reported as "book ran out"
    // next to millions of dollars of visible depth, which is not a rounding
    // nitpick: it tells the user their order was truncated when it was filled.
    let exhaustedBook = true;
    let lastPriceUsd = 0;

    for (let i = 0; i < levels.length; i++) {
      if (remainingQty <= 0 || remainingUsd <= 0) {
        exhaustedBook = false;
        break;
      }

      const level = levels[i];
      const rawPrice = level[0];
      const availableSize = level[1];
      if (!(availableSize > 0)) continue;

      // A price outside (0,100) is not a tradeable probability — skip rather
      // than trust it. A venue glitch must not become a free position.
      const priceCents = snapToTick(clamp(rawPrice, 0, 100), tickCents);
      if (!(priceCents > 0) || !(priceCents < 100)) continue;

      const priceUsd = priceCents / 100;

      // How much can we actually take here? The binding constraint of:
      // what's left to buy, what's left to spend, and what the level holds.
      const byQty = Math.min(remainingQty, availableSize);
      const byUsd = remainingUsd / priceUsd;
      // Floor, never round: rounding a partial unit up would overspend a
      // budget the user explicitly capped, and would claim depth the level
      // did not hold.
      const take = floorQty(Math.min(byQty, Math.min(byUsd, availableSize)));
      if (!(take > 0)) {
        // The level had size; we simply could not afford a whole unit of it.
        exhaustedBook = false;
        break;
      }
      lastPriceUsd = priceUsd;

      const notional = roundMoney(take * priceUsd);

      fills.push({ price: priceCents, qty: take, notional });
      totalQty = roundQty(totalQty + take);
      cost = roundMoney(cost + notional);
      remainingQty -= take;
      remainingUsd -= notional;
    }

    // Cost is the sum of what we actually paid at each level, never a
    // recomputation from the average — that is the invariant the tests pin.
    const avgPrice = totalQty > 0 ? roundPrice((cost / totalQty) * 100) : 0;
    const unfilledQty = target.kind === 'qty' ? roundQty(Math.max(0, target.qty - totalQty)) : 0;

    // A budget walk is partial only when the book gave out with money still
    // on the table AND that money could have bought at least one more unit.
    // Below one unit there was nothing left to buy at any depth, so the
    // order is done.
    const oneUnit = Math.pow(10, -QTY_DP);
    const partial =
      target.kind === 'qty'
        ? unfilledQty > 0
        : exhaustedBook && totalQty > 0 && remainingUsd > lastPriceUsd * oneUnit;

    return {
      fills,
      avgPrice,
      totalQty,
      cost,
      partial,
      unfilledQty,
      levelsConsumed: fills.length,
    };
  }

  // ─── Fill pricing (server-side logic) ──────────────────────────────────

  /**
   * Resolution front-running guard.
   * A game ends at 22:14 and the venue settles at 22:31. In between, the
   * price is 99c and the outcome is already public. Buying there is not
   * forecasting, it is collecting — so trading is frozen once the book has
   * effectively resolved.
   *
   * @param {{ bids: Array, asks: Array }} ladder
   * @throws {{ code: string, message: string }} when resolved
   */
  function assertNotResolved(ladder) {
    const bid = ladder.bids[0] != null ? ladder.bids[0][0] : null;
    const ask = ladder.asks[0] != null ? ladder.asks[0][0] : null;
    if (bid == null || ask == null) return;
    const spread = ask - bid;
    if (spread < 2 && (bid >= 97 || ask <= 3)) {
      throw { code: 'resolution_lockout', message: 'This market is already priced as a near-certainty. Trading it now would be front-running the result, not forecasting it.' };
    }
  }

  /**
   * Book freshness check.
   * @param {{ captured_at: string }} snap
   * @throws {{ code: string, message: string }}
   */
  function assertFresh(snap) {
    const age = Date.now() - new Date(snap.captured_at).getTime();
    if (age > MAX_BOOK_AGE_MS) {
      throw { code: 'stale_book', message: "We've lost the live book for this market. Try again shortly." };
    }
  }

  /**
   * Market tradeability check.
   * @param {{ status: string, close_time: string|null }} market
   * @throws {{ code: string, message: string }}
   */
  function assertTradeable(market) {
    if (market.status !== 'open') {
      throw { code: 'market_closed', message: 'This market has closed.' };
    }
    if (market.close_time && new Date(market.close_time).getTime() <= Date.now()) {
      throw { code: 'market_closed', message: 'This market has closed.' };
    }
  }

  /**
   * Rule 3: your quote is not your fill.
   * Returns true when the price moved against the user beyond tolerance
   * between quoting and submitting. Buys care about paying more; sells about
   * receiving less. A move in the user's favour is never a rejection.
   */
  function priceMovedAgainstUser(quotedPrice, filledPrice, side) {
    if (!(quotedPrice > 0)) return false;
    const delta = side === 'buy' ? filledPrice - quotedPrice : quotedPrice - filledPrice;
    return delta / quotedPrice > PRICE_MOVE_TOLERANCE;
  }

  /**
   * Price an order against one snapshot. Used identically by `quote` and by
   * `order-submit` — the only difference is which snapshot gets passed in.
   *
   * @param {object} opts
   * @param {{ yes_bids, yes_asks, no_bids, no_asks, captured_at }} opts.snap
   * @param {{ status, close_time, tick_cents, min_order_size }} opts.market
   * @param {'buy'|'sell'} opts.side
   * @param {'yes'|'no'} opts.outcome
   * @param {'instant'|'realistic'|'brutal'} opts.realism
   * @param {{ kind:'qty', qty:number }|{ kind:'notional', usd:number }} opts.target
   * @param {boolean} [opts.enforceDepthCap=true]
   * @returns {{ walk, avgPrice, qty, cost, fee, totalCost, bookMid, slippage, depth }}
   */
  function priceOrder(opts) {
    // Realism mode parameters — mirrors REALISM from types.ts
    const REALISM = {
      instant:    { latencyMs: 0,   feeMultiplier: 0,   adverseTicks: 0, allowPartial: false, usesMid: true,  scoringEligible: false },
      realistic:  { latencyMs: 250, feeMultiplier: 1,   adverseTicks: 0, allowPartial: true,  usesMid: false, scoringEligible: true },
      brutal:     { latencyMs: 750, feeMultiplier: 1.5, adverseTicks: 1, allowPartial: true,  usesMid: false, scoringEligible: true },
    };

    const cfg = REALISM[opts.realism];
    if (!cfg) throw { code: 'invalid_argument', message: `Unknown realism mode: ${opts.realism}` };

    const snap = opts.snap;
    const yes = { bids: snap.yes_bids || [], asks: snap.yes_asks || [] };
    const no  = { bids: snap.no_bids  || [], asks: snap.no_asks  || [] };
    const ladder = opts.outcome === 'yes' ? yes : no;
    const bookMid = midPrice(ladder);

    assertTradeable(opts.market);
    assertFresh(snap);
    assertNotResolved(ladder);

    // A snapshot whose mirror invariants failed means the adapter mis-parsed
    // the venue payload. Refusing to quote is the only safe response.
    const inv = checkBookInvariants(yes, no);
    if (!inv.ok) {
      throw { code: 'stale_book', message: "We've lost the live book for this market. Try again shortly." };
    }

    let levels = takerLevels(ladder, opts.side);
    if (levels.length === 0) {
      throw { code: 'no_liquidity', message: 'There is no visible liquidity on that side of the book right now.' };
    }

    const depth = depthNotional(levels);

    // Brutal mode fills one tick worse than the book showed.
    if (cfg.adverseTicks > 0) {
      levels = applyAdverseTicks(levels, opts.side, cfg.adverseTicks, opts.market.tick_cents);
    }

    // Instant mode is the tutorial: one bottomless level at the mid of
    // whichever side is being traded, so nothing ever partials and nothing
    // ever scores.
    if (cfg.usesMid && bookMid != null) {
      levels = [[bookMid, Number.MAX_SAFE_INTEGER]];
    }

    const walk = walkBook(levels, opts.target, opts.market.tick_cents);

    if (walk.totalQty <= 0) {
      throw { code: 'no_liquidity', message: 'There is no visible liquidity on that side of the book right now.' };
    }

    if (walk.totalQty < opts.market.min_order_size) {
      throw { code: 'below_min_size', message: `Minimum order on this market is ${opts.market.min_order_size}.` };
    }

    // Rule 2: cap size against visible depth. This is the single most
    // important anti-exploit in the product — without it the leaderboard
    // belongs to whoever finds the thinnest book.
    const enforceDepthCap = opts.enforceDepthCap !== false;
    if (enforceDepthCap && depth > 0 && walk.cost > depth * MAX_DEPTH_FRACTION) {
      throw { code: 'size_exceeds_depth', message: "Larger than this market can absorb — in reality you'd move the price against yourself." };
    }

    // Fee computation (simplified — the full fee model lives server-side).
    // feeMultiplier 0 means instant/tutorial: no fee.
    const fee = 0; // fee model integration point

    return {
      walk,
      avgPrice: walk.avgPrice,
      qty: walk.totalQty,
      cost: walk.cost,
      fee,
      totalCost: Math.round((walk.cost + fee) * 1e6) / 1e6,
      bookMid,
      slippage: bookMid != null ? slippageBps(walk.avgPrice, bookMid, opts.side) : 0,
      depth,
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────

  const _PaperPredictEngine = {
    // Constants
    MAX_DEPTH_FRACTION,
    PRICE_MOVE_TOLERANCE,
    MAX_BOOK_AGE_MS,
    POSITION_LIMIT_FRACTION,
    PRICE_DP,
    QTY_DP,
    MONEY_DP,

    // Decimal helpers
    roundPrice,
    roundQty,
    roundMoney,
    floorQty,
    clamp,
    snapToTick,

    // Book helpers
    depthQty,
    depthNotional,
    bestBid,
    bestAsk,
    midPrice,
    spreadCents,
    slippageBps,
    takerLevels,
    applyAdverseTicks,
    checkBookInvariants,
    isSortedBestFirst,

    // Walk engine
    walkBook,

    // Fill pricing
    priceOrder,
    priceMovedAgainstUser,
    assertNotResolved,
    assertFresh,
    assertTradeable,
  };

  if (typeof window !== 'undefined') {
    window.PaperPredictEngine = _PaperPredictEngine;
  }
  if (typeof self !== 'undefined') {
    self.PaperPredictEngine = _PaperPredictEngine;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _PaperPredictEngine;
  }

})();
