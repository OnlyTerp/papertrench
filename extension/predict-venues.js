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
    if (!res.ok) {
      // B5: the status rides the error so adapters can refuse WITH it — a
      // 429/500/403 is not an empty book, and collapsing it to null made a
      // broken adapter and an empty market the same test outcome.
      const err = new Error(`HTTP ${res.status} ${url}`);
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  }

  /* A transport failure becomes a refusal object; anything else (parse,
   * shape, absence) stays null — genuinely-empty, not broken-pipe. */
  function transportRefusal(e) {
    if (e && e.httpStatus) return { refused: true, httpStatus: e.httpStatus };
    return null;
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

  const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

  function kalshiToLevels(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || row.length < 2) continue;
      var price = roundPrice(Number(row[0]) * 100);
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

  function kalshiNormalizeBook(raw) {
    var fp = raw.orderbook_fp || raw.orderbook || {};
    var yesBids = kalshiToLevels(fp.yes_dollars || fp.yes || []);
    var noBids = kalshiToLevels(fp.no_dollars || fp.no || []);
    var yesAsks = kalshiMirror(noBids);
    var noAsks = kalshiMirror(yesBids);
    yesBids.sort(function(a, b) { return b[0] - a[0]; });
    yesAsks.sort(function(a, b) { return a[0] - b[0]; });
    noBids.sort(function(a, b) { return b[0] - a[0]; });
    noAsks.sort(function(a, b) { return a[0] - b[0]; });
    return {
      yes: { bids: yesBids, asks: yesAsks },
      no: { bids: noBids, asks: noAsks },
    };
  }

  /**
   * Resolve what the URL gave us into a TRADABLE market ticker.
   *
   * kalshi.com/markets/<series>/<event-slug>/<ticker> ends in the EVENT
   * ticker, not a market. Ask the orderbook endpoint for an event and it
   * answers HTTP 200 with EMPTY LADDERS rather than an error — so the panel
   * mounts, quotes against nothing, and reports "no liquidity" on a market
   * whose page is showing 47c/54c. Verified live 2026-08-08: KXGDP-26OCT30
   * returns {yes_dollars: [], no_dollars: []}, while the event holds 9 real
   * markets (KXGDP-26OCT30-T0.0 … -T4.0) that each have depth.
   *
   * So: try the ticker as a market; if its book is empty, treat it as an
   * event and pick the most liquid open market underneath. Returns the
   * ticker AND its title, because quoting a market the user did not choose
   * without naming it is exactly the wrong-number-on-screen failure.
   */
  async function kalshiResolveMarket(ticker) {
    try {
      var raw = await fetchJson(KALSHI_BASE + '/markets/' + encodeURIComponent(ticker) + '/orderbook?depth=100');
      var direct = kalshiNormalizeBook(raw);
      if (direct.yes.bids.length || direct.no.bids.length) {
        return { ticker: ticker, title: null, book: direct, resolvedVia: 'direct' };
      }
    } catch (e) {
      // 404/parse: an event ticker, not a market — fall through by design. Any
      // other transport failure (429/403/500) refuses HERE; retrying the event
      // endpoint against a rate limit is hammering, not resolving (B5).
      if (e && e.httpStatus && e.httpStatus !== 404) return { refused: true, httpStatus: e.httpStatus };
    }

    // The events endpoint is CASE-SENSITIVE where the markets endpoint is not:
    // verified live 2026-08-08, /events/kxgdp-26oct30 is a 404 while
    // /events/KXGDP-26OCT30 returns its 9 markets. URLs carry the lowercase
    // form, so every event lookup upper-cases first.
    try {
      var ev = await fetchJson(KALSHI_BASE + '/events/' + encodeURIComponent(String(ticker).toUpperCase()) + '?with_nested_markets=true');
      var markets = (ev.event && ev.event.markets) || ev.markets || [];
      var open = markets.filter(function(m) {
        var s = (m.status || '').toLowerCase();
        return m.ticker && (s === 'active' || s === 'open' || s === 'initialized');
      });
      if (!open.length) return null;
      // Most liquid first — but liquidity_dollars is "0.0000" on EVERY nested
      // child (verified live 2026-08-08: all 9 KXGDP children zero while
      // books hold real depth), so sorting on it is a no-op that picks
      // whatever order the API returned. Sort on top-of-book sizes instead
      // (A1); they are monotonic in depth even if their units are venue lore.
      var depth = function(m) {
        var b = Number(m.yes_bid_size_fp), a = Number(m.yes_ask_size_fp);
        return (isFinite(b) ? b : 0) + (isFinite(a) ? a : 0);
      };
      open.sort(function(a, b) { return depth(b) - depth(a); });
      // The deepest book in an event is very often the one already priced at
      // 1c or 99c — the outcome everybody has agreed on. Quoting it just
      // trips the front-running lockout and the panel opens on a refusal.
      // Prefer a market that is still a live question; fall back to the most
      // liquid one if every market has effectively resolved, so the lockout
      // still gets to speak rather than being pre-empted here (A2 — the same
      // doctrine as the Polymarket picker).
      var forecastable = open.filter(function(m) {
        var p = Number(m.last_price_dollars);
        return !isFinite(p) || (p > 0.03 && p < 0.97);
      });
      var pick = (forecastable.length ? forecastable : open)[0];
      var pickRaw = await fetchJson(KALSHI_BASE + '/markets/' + encodeURIComponent(pick.ticker) + '/orderbook?depth=100');
      return {
        ticker: pick.ticker,
        title: pick.yes_sub_title || pick.subtitle || pick.title || pick.ticker,
        book: kalshiNormalizeBook(pickRaw),
        resolvedVia: 'event',
        siblingCount: open.length,
        closeTime: pick.close_time || null,
      };
    } catch (e) {
      return transportRefusal(e);
    }
  }
  async function kalshiFetchBook(ticker) {
    try {
      var resolved = await kalshiResolveMarket(ticker);
      if (!resolved) return null;
      if (resolved.refused) return resolved;
      var book = resolved.book;
      var inv = checkBookInvariants(book.yes, book.no);
      return {
        venue: 'kalshi',
        marketId: resolved.ticker,
        marketTitle: resolved.title,
        // True when the URL named an event and we picked a market under it —
        // the ticket shows which one, so the number on screen is never for a
        // market the user did not know they were looking at.
        resolvedVia: resolved.resolvedVia || 'direct',
        siblingCount: resolved.siblingCount || 0,
        closeTime: resolved.closeTime || null,
        yes: book.yes,
        no: book.no,
        capturedAt: new Date().toISOString(),
        invariantOk: inv.ok,
        invariantViolations: inv.violations,
        // 1c is a VERIFIED constant, not a lazy one: neither nested nor
        // /markets/<ticker> payloads carry any tick field (checked live
        // 2026-09-12 — no tick_size key on either shape) and Kalshi quotes
        // integer cents. Do not "thread" a field that does not exist.
        tickCents: 1,
      };
    } catch (e) {
      return transportRefusal(e);
    }
  }

  async function kalshiCheckResolution(ticker) {
    try {
      var raw = await fetchJson(KALSHI_BASE + '/markets/' + encodeURIComponent(ticker));
      var m = raw.market;
      if (!m) return null;
      var status = (m.status || '').toLowerCase();
      // The record doubles as the market's liveness proof for the quote
      // path (A4/A5): closed + closeTime let the background refuse expiry
      // and settlement without fabricating status. Kalshi's open statuses
      // mirror the event filter (active/open/initialized); anything else
      // that is not finalized/settled is closed-but-unresolved.
      var openish = status === 'active' || status === 'open' || status === 'initialized';
      var base = { closed: !openish, closeTime: m.close_time || null };
      if (status !== 'finalized' && status !== 'settled') {
        return Object.assign({ resolved: false }, base);
      }
      var result = (m.result || '').toLowerCase();
      return Object.assign({
        resolved: true,
        resolution: result === 'yes' ? 'yes' : result === 'no' ? 'no' : null,
      }, base);
    } catch (e) {
      return null;
    }
  }

  /* ── Polymarket adapter ──────────────────────────────────────────── */

  const PM_GAMMA = 'https://gamma-api.polymarket.com';
  const PM_CLOB = 'https://clob.polymarket.com';

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
      return transportRefusal(e);
    }
  }

  /**
   * Resolve what the URL gave us into a tradable market with its two CLOB
   * token ids.
   *
   * polymarket.com/event/<slug> names an EVENT, and an event holds several
   * markets ("Fed Decision in September?" holds 5). Verified live 2026-08-08:
   *   /events?slug=<slug>      → { markets: [ { conditionId, clobTokenIds,
   *                                            question, liquidityClob } ] }
   *   /markets?condition_ids=  → the market WITHOUT a `tokens` field
   * The adapter used to ask for `market.tokens`, which gamma does not return
   * at all — so even given a condition id it could never find a token to
   * price. The real ids live in `clobTokenIds`, a JSON-encoded [yes, no].
   */
  async function pmResolveMarket(eventSlug) {
    try {
      var raw = await fetchJson(PM_GAMMA + '/events?slug=' + encodeURIComponent(eventSlug));
      var ev = Array.isArray(raw) ? raw[0] : raw;
      var markets = (ev && ev.markets) || [];
      var live = markets.filter(function(m) { return m && m.clobTokenIds && !m.closed; });
      if (!live.length) return null;
      // Depth dollars pick the market; cumulative volume is the fallback when
      // the depth field churns (verified live 2026-09-12: open markets carry
      // both liquidityClob and volumeNum; closed carry volumeNum only — so a
      // sort on depth alone would silently flatten to API order).
      var liq = function(m) {
        var l = Number(m.liquidityClob);
        if (isFinite(l) && l > 0) return l;
        var v = Number(m.volumeNum);
        return isFinite(v) ? v : 0;
      };
      live.sort(function(a, b) { return liq(b) - liq(a); });
      // The most liquid market in an event is very often the one already
      // priced at 1c or 99c — the outcome everybody has agreed on. Quoting it
      // just trips the front-running lockout and the panel opens on a refusal.
      // Prefer a market that is still a live question; fall back to the most
      // liquid one if every market in the event has effectively resolved, so
      // the lockout still gets to speak rather than being pre-empted here.
      var forecastable = live.filter(function(m) {
        var p = Number(m.lastTradePrice != null ? m.lastTradePrice : m.outcomePrices ? JSON.parse(m.outcomePrices || '[]')[0] : NaN);
        return !isFinite(p) || (p > 0.03 && p < 0.97);
      });
      var pick = (forecastable.length ? forecastable : live)[0];
      var ids;
      try { ids = JSON.parse(pick.clobTokenIds); } catch (e) { return null; }
      if (!Array.isArray(ids) || ids.length < 2) return null;
      return {
        conditionId: pick.conditionId,
        yesTokenId: ids[0],
        noTokenId: ids[1],
        title: pick.question || pick.groupItemTitle || null,
        tickCents: roundPrice(Number(pick.orderPriceMinTickSize || 0.01) * 100),
        resolvedVia: 'event',
        siblingCount: live.length,
        endDate: pick.endDate || null,
      };
    } catch (e) {
      return transportRefusal(e);
    }
  }

  async function pmFetchBook(eventSlug) {
    try {
      var resolved = await pmResolveMarket(eventSlug);
      if (!resolved) return null;
      if (resolved.refused) return resolved;

      var yesBook = await pmFetchTokenBook(resolved.yesTokenId);
      if (yesBook && yesBook.refused) return yesBook;
      var noBook = await pmFetchTokenBook(resolved.noTokenId);
      if (noBook && noBook.refused) return noBook;
      if (!yesBook || !noBook) return null;
      var conditionId = resolved.conditionId;

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
        marketTitle: resolved.title,
        resolvedVia: resolved.resolvedVia || 'event',
        siblingCount: resolved.siblingCount || 0,
        closeTime: resolved.endDate || null,
        yes: yes,
        no: no,
        capturedAt: new Date().toISOString(),
        invariantOk: inv.ok,
        invariantViolations: inv.violations,
        tickCents: resolved.tickCents || 1,
      };
    } catch (e) {
      return transportRefusal(e);
    }
  }

  async function pmCheckResolution(conditionId) {
    try {
      var markets = await fetchJson(PM_GAMMA + '/markets?condition_ids=' + encodeURIComponent(conditionId));
      if (!markets || markets.length === 0) return null;
      var m = markets[0];
      // Like Kalshi: the record doubles as the quote path's liveness proof.
      var base = { closed: !!m.closed, closeTime: m.endDate || null };
      if (!m.closed) return Object.assign({ resolved: false }, base);
      try {
        var prices = JSON.parse(m.outcomePrices || '[]');
        var yes = Number(prices[0]);
        if (yes >= 0.99) return Object.assign({ resolved: true, resolution: 'yes' }, base);
        if (yes <= 0.01) return Object.assign({ resolved: true, resolution: 'no' }, base);
        return Object.assign({ resolved: true, resolution: null }, base);
      } catch (e) {
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  /* ── Hyperliquid Outcomes: REMOVED (A3) ─────────────────────────────
   * Deleted 2026-09-12: the adapter could only ever return null (coin
   * lookup misses — no documented endpoint maps a market to its `#`
   * outcome ids; l2Book levels are objects, not the arrays the parser
   * read). A shipped adapter whose only output is null is worse than an
   * absent one: it mounted badge+panel that could never quote. Restore by
   * doing the discovery work first (see PREDICTION-AUDIT-FEEDBACK.md A3),
   * not by reverting this deletion.
   */

  /* ── Limitless adapter ───────────────────────────────────────────── */

  const LL_API = 'https://api.limitless.exchange';

  /**
   * A single market by slug.
   *
   * The previous implementation fetched a bare `/markets` LIST and searched it
   * for the slug. That endpoint is a 404 — verified live 2026-08-08 — so the
   * lookup always returned null and every Limitless quote refused with "no
   * live book". The real route is `/markets/<slug>`.
   */
  async function limitlessFetchMarket(slug) {
    try {
      return await fetchJson(LL_API + '/markets/' + encodeURIComponent(slug));
    } catch (e) {
      return transportRefusal(e);
    }
  }

  /**
   * Resolve to a market that actually has a book.
   *
   * Limitless has the same shape Kalshi and Polymarket do: the URL can name a
   * GROUP (`marketType: "group"`), whose own orderbook route answers "Market
   * not found" while its children each carry a real book. Verified live: the
   * group `t1-vs-hanwha-life-esports-…` holds 2 children, and
   * `/markets/<child-slug>/orderbook` returns bids and asks. Note the book is
   * keyed by SLUG — the numeric id 404s.
   */
  async function limitlessResolveMarket(slug) {
    var m = await limitlessFetchMarket(slug);
    if (!m) return null;
    if (m.refused) return m;
    var kids = Array.isArray(m.markets) ? m.markets : [];
    if ((m.marketType === 'group' || !m.marketType) && kids.length) {
      var live = kids.filter(function(k) { return k && k.slug && !k.expired && (k.status || '').toUpperCase() !== 'RESOLVED'; });
      if (!live.length) return null;
      var vol = function(k) { var v = Number(k.volume); return isFinite(v) ? v : 0; };
      live.sort(function(a, b) { return vol(b) - vol(a); });
      var pick = live[0];
      return { slug: pick.slug, title: pick.title || pick.proxyTitle || null, resolvedVia: 'group', siblingCount: live.length, market: pick };
    }
    return { slug: slug, title: null, resolvedVia: 'direct', siblingCount: 0, market: m };
  }

  async function limitlessFetchBook(slug) {
    try {
      var resolved = await limitlessResolveMarket(slug);
      if (!resolved) return null;
      if (resolved.refused) return resolved;
      var market = resolved.market;
      // The book route is `/markets/<slug>/orderbook` — keyed by slug; the
      // numeric id 404s. The old `/orderbook?marketId=` route does not exist.
      var book = await fetchJson(LL_API + '/markets/' + encodeURIComponent(resolved.slug) + '/orderbook');
      var yesBids = (book.bids || []).map(function(l) {
        return [roundPrice(Number(l.price) * 100), Number(l.size || l.amount || 0)];
      }).filter(function(l) { return l[0] > 0 && l[0] < 100 && l[1] > 0; });
      var yesAsks = (book.asks || []).map(function(l) {
        return [roundPrice(Number(l.price) * 100), Number(l.size || l.amount || 0)];
      }).filter(function(l) { return l[0] > 0 && l[0] < 100 && l[1] > 0; });
      // Construct NO side by mirror, since Limitless only quotes one side.
      var noBids = yesAsks.map(function(l) { return [roundPrice(100 - l[0]), l[1]]; }).filter(function(l) { return l[0] > 0 && l[0] < 100; });
      var noAsks = yesBids.map(function(l) { return [roundPrice(100 - l[0]), l[1]]; }).filter(function(l) { return l[0] > 0 && l[0] < 100; });
      yesBids.sort(function(a, b) { return b[0] - a[0]; });
      yesAsks.sort(function(a, b) { return a[0] - b[0]; });
      noBids.sort(function(a, b) { return b[0] - a[0]; });
      noAsks.sort(function(a, b) { return a[0] - b[0]; });
      var yes = { bids: yesBids, asks: yesAsks };
      var no = { bids: noBids, asks: noAsks };
      var inv = checkBookInvariants(yes, no);
      return {
        venue: 'limitless',
        marketId: resolved.slug,
        marketTitle: resolved.title,
        resolvedVia: resolved.resolvedVia || 'direct',
        siblingCount: resolved.siblingCount || 0,
        yes: yes,
        no: no,
        capturedAt: new Date().toISOString(),
        invariantOk: inv.ok,
        invariantViolations: inv.violations,
        tickCents: roundPrice((market.orderPriceMinTickSize || 0.01) * 100),
      };
    } catch (e) {
      return transportRefusal(e);
    }
  }

  async function limitlessCheckResolution(slug) {
    try {
      var market = await limitlessFetchMarket(slug);
      if (!market || market.refused) return null;
      // The venue exposes no close timestamp; closed is still honest.
      if (!market.closed && !market.resolved) return { resolved: false, closed: false, closeTime: null };
      var result = String(market.outcome || market.resolution || '').toLowerCase();
      return {
        resolved: true,
        resolution: result === 'yes' ? 'yes' : result === 'no' ? 'no' : null,
        closed: true,
        closeTime: null,
      };
    } catch (e) {
      return null;
    }
  }

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
    // hyperliquid-outcomes removed (A3) — see the REMOVED note above.
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
    kalshiNormalizeBook: kalshiNormalizeBook,
    kalshiToLevels: kalshiToLevels,
    kalshiMirror: kalshiMirror,
    checkBookInvariants: checkBookInvariants,
    MAX_DEPTH_FRACTION: MAX_DEPTH_FRACTION,
  };

  if (typeof window !== 'undefined') window.PaperPredictVenues = api;
  if (typeof self !== 'undefined') self.PaperPredictVenues = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
