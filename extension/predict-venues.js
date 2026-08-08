/* PaperTrench — prediction venue API clients (background-side).
 *
 * Book fetching, market meta, and resolution checks for prediction venues.
 * Runs in the service worker; never in the content script.
 *
 * Each venue adapter is a set of pure-ish functions that fetch from the
 * venue's public API and normalize the response into a standard shape.
 * No auth required for any venue (prediction markets are public-read).
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT).
 */
(() => {
  'use strict';

  const MAX_DEPTH_FRACTION = 0.05;

  /* ── Helpers ─────────────────────────────────────────────────────── */

  /** Round to N decimal places. */
  function roundN(x, dp) {
    const f = 10 ** dp;
    return Math.round(x * f) / f;
  }
  function roundPrice(cents) { return roundN(cents, 2); }
  function roundMoney(usd) { return roundN(usd, 6); }
  function roundQty(q) { return roundN(q, 2); }

  /** Snap a price in cents onto the venue's tick grid. */
  function snapToTick(price, tickCents) {
    if (tickCents <= 0) return price;
    return roundPrice(Math.round(price / tickCents) * tickCents);
  }

  /** Clamp a value between min and max. */
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /** Floor to QTY_DP (2 decimal places). */
  function floorQty(q) { return Math.floor(q * 100) / 100; }

  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }

  /* ── Book math (from predict-engine, inline to avoid load-order) ── */

  function bestBid(ladder) {
    return ladder.bids.length > 0 ? roundPrice(ladder.bids[0][0]) : null;
  }
  function bestAsk(ladder) {
    return ladder.asks.length > 0 ? roundPrice(ladder.asks[0][0]) : null;
  }

  /**
   * Mirror invariant — the single most dangerous bug in the codebase.
   * A YES bid at 7c IS a NO ask at 93c, same size. If these drift, the
   * adapter mis-parsed the venue payload.
   */
  function checkBookInvariants(yes, no, tolerance) {
    if (tolerance == null) tolerance = 0.01;
    var violations = [];
    var checked = 0;
    var pairs = [
      ['best_yes_ask == 100 - best_no_bid', bestAsk(yes), bestBid(no) == null ? null : 100 - bestBid(no)],
      ['best_no_ask == 100 - best_yes_bid', bestAsk(no), bestBid(yes) == null ? null : 100 - bestBid(yes)],
      ['best_yes_bid == 100 - best_no_ask', bestBid(yes), bestAsk(no) == null ? null : 100 - bestAsk(no)],
      ['best_no_bid == 100 - best_yes_ask', bestBid(no), bestAsk(yes) == null ? null : 100 - bestAsk(yes)],
    ];
    for (var i = 0; i < pairs.length; i++) {
      var label = pairs[i][0], lhs = pairs[i][1], rhs = pairs[i][2];
      if (lhs == null || rhs == null) continue;
      checked++;
      if (Math.abs(lhs - rhs) > tolerance) {
        violations.push(label + ': ' + lhs + ' vs ' + rhs);
      }
    }
    return { ok: violations.length === 0, violations: violations, checked: checked };
  }

  /* ── Kalshi adapter ──────────────────────────────────────────────── */

  /* Kalshi orderbook endpoint. Public reads, no auth needed.
   * Verified live 2026-08-07 (dossier §3): api.elections.kalshi.com
   *
   * CRITICAL: the response carries BID LADDERS ONLY. Both ask ladders
   * are synthesized by mirroring the opposite side's bids:
   *   YES bid at X == NO ask at (100 − X), same size.
   *
   * The shape is {orderbook_fp: {yes_dollars: [["0.1500","100.00"],...]}}
   * where element 0 is price in DOLLARS as string, element 1 is CONTRACT
   * COUNT (not a price).
   *
   * Ported from amogus0471/Paper-Prediction @ e03f715 — kalshi.ts:269-298
   */
  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

  /** Parse [["0.1500","100.00"],...] into [[15, 100],...] */
  function kalshiToLevels(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || row.length < 2) continue;
      var price = roundPrice(Number(row[0]) * 100); // dollars → cents
      var size = Number(row[1]);
      if (!(price > 0) || !(price < 100) || !(size > 0)) continue;
      out.push([price, size]);
    }
    return out;
  }

  function kalshiMirror(levels) {
    var out = [];
    for (var i = 0; i < levels.length; i++) {
      var mirrored = roundPrice(100 - levels[i][0]);
      if (mirrored > 0 && mirrored < 100) out.push([mirrored, levels[i][1]]);
    }
    return out;
  }

  /** Normalize a Kalshi orderbook into {yes: {bids, asks}, no: {bids, asks}}. */
  function kalshiNormalizeBook(raw) {
    var fp = raw.orderbook_fp || raw.orderbook || {};
    var yesBids = kalshiToLevels(fp.yes_dollars || fp.yes || []);
    var noBids = kalshiToLevels(fp.no_dollars || fp.no || []);
    // Mirror: YES bid at X == NO ask at (100-X)
    var yesAsks = kalshiMirror(noBids);
    var noAsks = kalshiMirror(yesBids);
    // Sort: bids best-first (descending), asks best-first (ascending)
    yesBids.sort(function(a, b) { return b[0] - a[0]; });
    yesAsks.sort(function(a, b) { return a[0] - b[0]; });
    noBids.sort(function(a, b) { return b[0] - a[0]; });
    noAsks.sort(function(a, b) { return a[0] - b[0]; });
    return {
      yes: { bids: yesBids, asks: yesAsks },
      no: { bids: noBids, asks: noAsks },
    };
  }

  /** Fetch a Kalshi orderbook. Returns null on failure. */
  async function kalshiFetchBook(ticker) {
    var url = KALSHI_BASE + '/markets/' + encodeURIComponent(ticker) + '/orderbook?depth=100';
    try {
      var raw = await fetchJson(url);
      var book = kalshiNormalizeBook(raw);
      var inv = checkBookInvariants(book.yes, book.no);
      return {
        venue: 'kalshi',
        marketId: ticker,
        yes: book.yes,
        no: book.no,
        capturedAt: new Date().toISOString(),
        invariantOk: inv.ok,
        invariantViolations: inv.violations,
        tickCents: 1, // default; venue-specific tick from price_level_structure
      };
    } catch (e) {
      return null;
    }
  }

  /** Check Kalshi market resolution. Returns null if not resolved. */
  async function kalshiCheckResolution(ticker) {
    try {
      var raw = await fetchJson(KALSHI_BASE + '/markets/' + encodeURIComponent(ticker));
      var m = raw.market;
      if (!m) return null;
      var status = (m.status || '').toLowerCase();
      if (status !== 'finalized' && status !== 'settled') return { resolved: false };
      var result = (m.result || '').toLowerCase();
      return {
        resolved: true,
        resolution: result === 'yes' ? 'yes' : result === 'no' ? 'no' : null,
      };
    } catch (e) {
      return null;
    }
  }

  /* ── Polymarket adapter ──────────────────────────────────────────── */

  /* Polymarket uses two hosts:
   *   gamma-api.polymarket.com — market meta, events
   *   clob.polymarket.com — order books, prices
   *
   * Books arrive WORST-FIRST: bids ascend to best-at-END, asks descend to
   * best-at-END. We sort explicitly.
   *
   * Each binary market is TWO ERC-1155 tokens (YES and NO). Both books
   * must be fetched and merged.
   *
   * VERIFIED: endpoint shapes confirmed in dossier §3 (2026-08-07).
   * THIN: no live-ticking price captured — verified:false for now.
   */
  const PM_GAMMA = 'https://gamma-api.polymarket.com';
  const PM_CLOB = 'https://clob.polymarket.com';

  /** Fetch Polymarket event meta and extract binary markets. */
  async function pmFetchEvent(eventSlug) {
    try {
      var events = await fetchJson(PM_GAMMA + '/events?slug=' + encodeURIComponent(eventSlug));
      if (!events || events.length === 0) return null;
      var event = events[0];
      return {
        id: event.id,
        slug: event.slug || eventSlug,
        title: event.title || '',
        markets: (event.markets || []).map(function(m) {
          return {
            conditionId: m.conditionId || m.condition_id,
            question: m.question || m.groupItemTitle || '',
            tokens: m.tokens || [],
            active: m.active !== false,
            closed: m.closed === true,
            outcomePrices: m.outcomePrices,
          };
        }),
      };
    } catch (e) {
      return null;
    }
  }

  /** Fetch a single token's book from the CLOB. */
  async function pmFetchTokenBook(tokenId) {
    try {
      var raw = await fetchJson(PM_CLOB + '/book?token_id=' + encodeURIComponent(tokenId));
      return {
        bids: (raw.bids || []).map(function(l) {
          return [roundPrice(Number(l.price) * 100), Number(l.size)];
        }).filter(function(l) { return l[0] > 0 && l[0] < 100 && l[1] > 0; }),
        asks: (raw.asks || []).map(function(l) {
          return [roundPrice(Number(l.price) * 100), Number(l.size)];
        }).filter(function(l) { return l[0] > 0 && l[0] < 100 && l[1] > 0; }),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch a Polymarket binary market book. Returns merged YES/NO ladders.
   * Sorts explicitly: bids best-first (descending), asks best-first (ascending).
   */
  async function pmFetchBook(conditionId) {
    try {
      var markets = await fetchJson(PM_GAMMA + '/markets?condition_ids=' + encodeURIComponent(conditionId));
      if (!markets || markets.length === 0) return null;
      var market = markets[0];
      var tokens = market.tokens || [];
      if (tokens.length < 2) return null;

      // YES token is outcomeIndex 0, NO is 1
      var yesToken = tokens.find(function(t) { return t.outcome === 'Yes' || t.outcomeIndex === 0; });
      var noToken = tokens.find(function(t) { return t.outcome === 'No' || t.outcomeIndex === 1; });
      if (!yesToken || !noToken) return null;

      var yesBook = await pmFetchTokenBook(yesToken.token_id);
      var noBook = await pmFetchTokenBook(noToken.token_id);
      if (!yesBook || !noBook) return null;

      // Sort: bids descending (best first), asks ascending (best first)
      yesBook.bids.sort(function(a, b) { return b[0] - a[0]; });
      yesBook.asks.sort(function(a, b) { return a[0] - b[0]; });
      noBook.bids.sort(function(a, b) { return b[0] - a[0]; });
      noBook.asks.sort(function(a, b) { return a[0] - b[0]; });

      var yes = { bids: yesBook.bids, asks: yesBook.asks };
      var no = { bids: noBook.bids, asks: noBook.asks };
      var inv = checkBookInvariants(yes, no);

      return {
        venue: 'polymarket',
        marketId: conditionId,
        yes: yes,
        no: no,
        capturedAt: new Date().toISOString(),
        invariantOk: inv.ok,
        invariantViolations: inv.violations,
        tickCents: 1,
      };
    } catch (e) {
      return null;
    }
  }

  /** Check Polymarket resolution. */
  async function pmCheckResolution(conditionId) {
    try {
      var markets = await fetchJson(PM_GAMMA + '/markets?condition_ids=' + encodeURIComponent(conditionId));
      if (!markets || markets.length === 0) return null;
      var m = markets[0];
      if (!m.closed) return { resolved: false };
      try {
        var prices = JSON.parse(m.outcomePrices || '[]');
        var yes = Number(prices[0]);
        if (yes >= 0.99) return { resolved: true, resolution: 'yes' };
        if (yes <= 0.01) return { resolved: true, resolution: 'no' };
        return { resolved: true, resolution: null }; // void
      } catch (e) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  /* ── Hyperliquid Outcomes (stub) ─────────────────────────────────── */
  /* verified:false — THIN capture, no live-ticking price. */

  async function hlOutcomesFetchBook() { return null; }
  async function hlOutcomesCheckResolution() { return null; }

  /* ── Limitless (stub) ────────────────────────────────────────────── */
  /* verified:false — THIN capture, no live-ticking price. */

  async function limitlessFetchBook() { return null; }
  async function limitlessCheckResolution() { return null; }

  /* ── Unified API ─────────────────────────────────────────────────── */

  const adapters = {
    kalshi: {
      fetchBook: kalshiFetchBook,
      checkResolution: kalshiCheckResolution,
    },
    polymarket: {
      fetchBook: pmFetchBook,
      checkResolution: pmCheckResolution,
      fetchEvent: pmFetchEvent,
    },
    'hyperliquid-outcomes': {
      fetchBook: hlOutcomesFetchBook,
      checkResolution: hlOutcomesCheckResolution,
    },
    limitless: {
      fetchBook: limitlessFetchBook,
      checkResolution: limitlessCheckResolution,
    },
  };

  function adapterFor(venue) {
    return adapters[venue] || null;
  }

  const api = {
    adapters: adapters,
    adapterFor: adapterFor,
    // Kalshi internals exposed for testing
    kalshiNormalizeBook: kalshiNormalizeBook,
    kalshiToLevels: kalshiToLevels,
    kalshiMirror: kalshiMirror,
    checkBookInvariants: checkBookInvariants,
    // Constants
    MAX_DEPTH_FRACTION: MAX_DEPTH_FRACTION,
  };

  if (typeof window !== 'undefined') window.PaperPredictVenues = api;
  if (typeof self !== 'undefined') self.PaperPredictVenues = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
