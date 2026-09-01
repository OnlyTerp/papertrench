/* PaperTrench — MAIN-world live-feed + Padre chart bridge.
 *
 * This file is loaded by the manifest at document_start in the page's MAIN
 * world. That timing matters: Padre opens a binary multiplex WebSocket during
 * startup, so injecting at document_idle is already too late.
 *
 * Live price path on Padre:
 *   Padre's TradingView datafeed -> subscribeBars callback -> `tick` message
 *
 * Native chart marker path on Padre:
 *   PaperTrench paper fill -> `paper-marker` message -> patched datafeed
 *   getMarks() -> TradingView activeChart().refreshMarks()
 *
 * This intentionally does NOT observe the entire DOM. A prior whole-document
 * MutationObserver reacted to PaperTrench's own chart DOM writes and could
 * create a render/mutation feedback loop that froze the site.
 */
(() => {
  'use strict';

  if (window.__paperTrenchMainBridgeV4) return;
  window.__paperTrenchMainBridgeV4 = true;

  const OUT_TAG = 'papertrench-bridge';
  const IN_TAG = 'papertrench-content';
  const PATCHED = Symbol('papertrench-patched');
  const MAX_DEPTH = 7;
  const MAX_CANDIDATES = 32;
  // Upper bound on frames the generic path will JSON.parse. Parse cost at
  // this size is ~10-20 ms occasionally; the collector walk is separately
  // bounded by NODE_BUDGET, so bigger frames cannot runaway the main thread.
  const FRAME_GUARD_BYTES = 2_000_000;
  const MAX_MARKS = 500;

  let paperMarks = [];
  // Per-mark fill levels (USD / SOL / market cap), kept for the execution-
  // shape fallback which must place a Y-anchored arrow on whatever unit the
  // site's chart actually plots.
  const paperMarkLevels = new Map();
  let lastWidget = null;
  let padreBarsHooked = false;
  let padreMarksHooked = false;
  let paperLineSpec = null;
  let lineWidget = null;
  // Newest live bar close seen through the patched datafeed. Charts on these
  // sites plot either token USD price or market cap; the bar close tells us
  // which magnitude the Y axis lives at, so lines and shapes land on it.
  let lastBarClose = 0;
  // F-35: closes tracked PER live subscription. The C-14 token gate keeps
  // other tokens out of lastBarClose, but the SAME token can stream in two
  // units at once (price-mode and mcap-mode charts in a Padre multichart
  // layout, or across a mode toggle) — and those closes differ by the supply
  // factor. Level math must pick a close in the axis's own unit, never
  // "whichever series ticked last".
  const barCloseLedger = new Map(); // subscriberUID -> { close, atMs }
  const BAR_CLOSE_FRESH_MS = 15_000;
  // Chart time (seconds) of the newest live bar — paper shapes/marks clamp to
  // it so a fill can never render ahead of the final candle (F-31).
  let lastBarTimeSec = 0;
  // The pair/mint/symbol the content script has resolved for THIS page, used
  // to keep ticks, exports and drawing on the chart instance that matches it.
  // Axiom preloads charts for OTHER tokens — trusting their closes once put a
  // different token's price into the P&L and the average lines. Some Axiom
  // chart symbols carry the token symbol or mint rather than the pair address,
  // so we match against every identifier we know.
  const currentSymbolNeedles = [];
  const currentSymbolInfo = { mint: null, pairAddress: null, symbol: null };

  function chartSymbolMatches(chart) {
    if (!currentSymbolNeedles.length) return true; // nothing resolved yet: permissive
    try {
      const symbol = chart && typeof chart.symbol === 'function'
        ? String(chart.symbol()).toUpperCase()
        : '';
      if (!symbol || symbol.indexOf('UNKNOWN') === 0) return false;
      return currentSymbolNeedles.some((n) => symbol.indexOf(n) >= 0);
    } catch (_) {
      return false;
    }
  }

  function barSymbolMatches(symbolInfo) {
    if (!currentSymbolNeedles.length) return true;
    const raw = symbolInfo && (symbolInfo.ticker || symbolInfo.name || symbolInfo.symbol);
    if (!raw) return true; // unidentified feed: let validation decide
    const s = String(raw).toUpperCase();
    return currentSymbolNeedles.some((n) => s.indexOf(n) >= 0);
  }

  function setCurrentSymbolNeedles(payload) {
    const next = [];
    for (const key of ['pairAddress', 'mint', 'symbol']) {
      const v = payload && payload[key];
      if (typeof v === 'string' && v.length >= 2) {
        next.push(String(v).toUpperCase());
      }
      if (key in currentSymbolInfo) currentSymbolInfo[key] = v || null;
    }
    const changed = next.length !== currentSymbolNeedles.length
      || !next.every((n) => currentSymbolNeedles.indexOf(n) >= 0);
    currentSymbolNeedles.length = 0;
    for (const n of next) currentSymbolNeedles.push(n);
    // A new token means the old bar close is no longer a valid axis hint —
    // and the export dedupe must forget the old token's close, or the first
    // poll on the new token can be swallowed as "unchanged" (DEFECT F-19).
    // The GMGN candle close is the same class of per-token evidence (C-08).
    if (changed) { lastBarClose = 0; lastBarTimeSec = 0; lastExportedClose = 0; gmgnLastCandleClose = 0; barCloseLedger.clear(); }
  }
  // GMGN runs a private TradingView widget inside a same-origin blob iframe.
  // Its live React chart manager exposes `getActiveChart().createOrderLine()`.
  let gmgnChart = null;
  let gmgnLineSpec = null;
  let gmgnRetryTimer = null;
  // DEFECT C-08: the newest close from GMGN's own mcap-candle feed. GMGN's
  // cap definition can differ from the resolver's (circulating vs total,
  // migrated coins) by a constant factor; this close is the ground truth for
  // what GMGN's Y axis actually shows, so lines and fill shapes are scaled
  // through it rather than trusting resolver-implied supply. Reset per token.
  let gmgnLastCandleClose = 0;

  /* ---------------- content-script liveness (DEFECTS O-04/C-17) ----------
   * The MAIN world cannot observe extension death, so the bridge watches for
   * SILENCE instead: every content-script message refreshes this stamp (the
   * overlay also sends a 30 s 'bridge-ping' while enabled). After 5 minutes
   * without any message the 1 s sweep stops re-asserting lines/marks — a
   * dead extension must not keep repainting a frozen level forever. An
   * explicit 'standdown' message (overlay disabled, extension teardown)
   * clears everything immediately and silences the sweep at once.
   */
  const CONTENT_SILENCE_LIMIT_MS = 5 * 60_000;
  let lastContentMessageAt = Date.now();

  /* ---------------- feed demand gate (Turbo) ------------------------------
   * Parsing is the bridge's whole main-thread cost, and most of the frames it
   * parses have no consumer: ticks feed exactly (a) the page's resolved token
   * and (b) screener row chips. On every other page — wallet, portfolio,
   * settings, a list page with chips disabled — every clone().text() and
   * JSON.parse is pure jank donated to the host site. The content script
   * publishes whether any consumer exists ('page-state'); with none, frames
   * are dropped BEFORE the body copy and the parse, not after.
   *
   * The boot default is TRUE: the bridge runs at document_start, the content
   * script at document_idle, and the first tick of a brand-new coin must not
   * be lost to a gate that nobody has evaluated yet. Silence (the O-04/C-17
   * stamp) still wins over a stale TRUE: a dead extension stops costing the
   * page within CONTENT_SILENCE_LIMIT_MS no matter what it last said, and
   * 'standdown' backdates that stamp so the master switch stops the parsing
   * the instant it is thrown, not five minutes later.
   */
  let feedWanted = true;

  function feedActive() {
    return feedWanted && Date.now() - lastContentMessageAt <= CONTENT_SILENCE_LIMIT_MS;
  }

  /* DEFECT F-26: the widget sweep must not scan forever on sites that never
   * mount a TradingView chart. After WIDGET_SWEEP_MISS_LIMIT consecutive
   * empty scans (~1 minute at the 1 s cadence) it drops to a 10 s cadence;
   * a discovered widget or a fresh paper-axis/paper-lines message returns it
   * to the fast cadence.
   */
  const WIDGET_SWEEP_MISS_LIMIT = 60;
  const WIDGET_SWEEP_SLOW_EVERY = 10;
  let widgetSweepMisses = 0;
  let lastWidgetScanFound = false;

  function emit(type, payload) {
    try {
      window.postMessage({ source: OUT_TAG, type, payload }, '*');
    } catch (_) {}
  }

  function numberValue(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.length <= 64) {
      const n = Number(v.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  // avgPrice is deliberately ABSENT: it is a position-average field, not a
  // live price. When the user holds a REAL position, the site streams their
  // real entry average under that key, and treating it as a market tick let
  // the user's own entry price pollute the paper feed (DEFECT F-30 — the
  // average line "blended" a real buy with the paper buy).
  const PRICE_KEY = /^(price|priceNative|priceUsd|priceInSol|priceSol|solPrice|usdPrice|tokenPrice|lastPrice|last|close|c|markPrice|currentPrice|quote)$/i;
  // Subtrees that describe the USER'S OWN holdings, not the market. Prices
  // inside them are historical facts about the user (entry averages, cost
  // bases, unrealized P&L) and must never become market-price candidates.
  // "hodlers" is fomo's own spelling; holder lists and balance sheets are
  // positions-of-SOMEONE either way, and prices inside them are entries,
  // not the market.
  const POSITION_SUBTREE_KEY = /^(positions?|holdings?|portfolio|userPositions?|myPositions?|openOrders?|hodlers?|holders?|topHolders?|toptraders?|balances?)$/i;
  const MCAP_KEY = /^(marketCap|marketCapInUsd|mcap|mcapInUsd|fdv|fullyDilutedValuation)$/i;
  // A record that IS a trade event — an id-carrying or user-attributed
  // swap/trade object (fomo's social feed, tx-hash trade tapes). Its price
  // and cap fields describe the moment that trade happened, minutes to
  // HOURS in the past, and must never tick the live price: F-30's "the
  // user's own average is not a market price", one layer out. Anonymous
  // live-tape pushes ({price, ts} with no id or attribution) stay eligible.
  const TRADE_EVENT_TYPE_RE = /^(swap|trade|buy|sell)/i;
  function looksLikeTradeEvent(node) {
    const type = node.type || node.eventType || node.txType;
    const typed = typeof type === 'string' && TRADE_EVENT_TYPE_RE.test(type);
    const hasEventId = typeof node.tradeId === 'string' || typeof node.txId === 'string'
      || typeof node.txHash === 'string' || typeof node.signature === 'string'
      || typeof node.transactionHash === 'string';
    // Attribution can be flat (userId on the row) or NESTED — fomo's holder
    // rows carry a whole `user` object; either way the record is about a
    // PERSON's trade, and its prices are that person's history.
    const attributed = typeof node.userId === 'string' || typeof node.userHandle === 'string'
      || typeof node.displayName === 'string' || typeof node.maker === 'string'
      || (node.user !== null && typeof node.user === 'object');
    return (typed && (hasEventId || attributed)) || (hasEventId && attributed);
  }

  /** A POSITION record by shape, whatever key it hides under: cost bases,
   * entry averages and per-position P&L only ever describe someone's
   * holding. A `price` beside them is the ENTRY price (fomo /hodlers rows,
   * captured live 2026-08-05) — F-30's "the user's own average is not a
   * market price", extended to everyone else's averages too. */
  function looksLikePositionRecord(node) {
    return node.costBasis !== undefined || node.averageEntryPrice !== undefined
      || node.avgEntryPrice !== undefined || node.unrealizedPnl !== undefined
      || node.realizedPnl !== undefined || node.realizedPnlUSD !== undefined
      || node.avgBuyPriceUSD !== undefined
      || (node.pnl !== undefined && node.value !== undefined && node.price !== undefined);
  }
  const MINT_KEY = /^(mint|tokenMint|tokenAddress|baseMint|address|contract|ca)$/i;
  const SYMBOL_KEY = /^(symbol|ticker|tokenSymbol|baseSymbol)$/i;
  const NAME_KEY = /^(name|tokenName|baseName)$/i;
  const USD_HINT = /usd|dollar/i;
  const NATIVE_HINT = /native|sol/i;

  // Traversal is bounded by a single global node budget rather than the old
  // per-array slice(0, 80): trade arrays are newest-LAST, so capping at the
  // front reported ever older prices exactly as batches grew with volume
  // (DEFECT F-03). The budget only bites on pathological frames.
  const NODE_BUDGET = 20_000;
  // Identifier strength: on several sites `address`/`ca` carry the AMM/pool
  // address rather than the token mint, so an explicit mint-ish key must win
  // the record association when both appear on one object.
  const MINT_KEY_STRONG = /^(mint|tokenMint|baseMint)$/i;
  const MINT_KEY_MEDIUM = /^(tokenAddress)$/i;
  function mintKeyRank(key) {
    if (MINT_KEY_STRONG.test(key)) return 3;
    if (MINT_KEY_MEDIUM.test(key)) return 2;
    if (MINT_KEY.test(key)) return 1;
    return 0;
  }

  function collect(obj) {
    // Prices are grouped by the token record they appear inside (DEFECT F-02).
    // A batched frame — screener list, multi-pair snapshot, trending payload —
    // carries many tokens; the old flattened walk attributed token B's price
    // to whichever mint happened to be seen first, and the accept band then
    // derived USD/mcap from that wrong ratio self-consistently. A node that
    // carries a mint-shaped identifier opens a record; every price / mcap /
    // symbol beneath it belongs to that token. Finds outside any record land
    // in `top` (frames with no identifier at all), which downstream
    // anchor-banding still validates before use.
    const records = new Map();
    const top = { candidates: [], mcap: null, mint: null, symbol: null, name: null };
    const seen = new WeakSet();
    let budget = NODE_BUDGET;

    const recordFor = (mint) => {
      let rec = records.get(mint);
      if (!rec) {
        rec = { candidates: [], mcap: null, mint, symbol: null, name: null };
        records.set(mint, rec);
      }
      return rec;
    };
    const pushCandidate = (rec, cand) => {
      // Ring, not cap: when a record overflows, keep the NEWEST candidates.
      if (rec.candidates.length >= MAX_CANDIDATES) rec.candidates.shift();
      rec.candidates.push(cand);
    };

    (function walk(node, depth, ctx, tainted) {
      if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
      if (budget-- <= 0) return;
      seen.add(node);

      // Trade EVENTS and POSITION records taint their whole subtree exactly
      // like position subtrees do: identity fields still flow, prices and
      // caps do not.
      if (!tainted && !Array.isArray(node)
        && (looksLikeTradeEvent(node) || looksLikePositionRecord(node))) tainted = true;

      let target = ctx;
      if (!Array.isArray(node)) {
        let bestRank = 0;
        let bestMint = null;
        for (const [key, value] of Object.entries(node)) {
          if (typeof value !== 'string' || !BASE58_RE.test(value)) continue;
          const rank = mintKeyRank(key);
          if (rank > bestRank) { bestRank = rank; bestMint = value; }
        }
        if (bestMint) target = recordFor(bestMint);
      }

      const entries = Array.isArray(node)
        ? node.map((v, i) => [String(i), v])
        : Object.entries(node);

      for (const [key, value] of entries) {
        if (budget <= 0) return;
        if (value && typeof value === 'object') {
          // A subtree describing the user's own holdings is DATA ABOUT THE
          // USER, not the market: entry averages and cost bases inside it
          // must never tick the price (DEFECT F-30). Identity fields still
          // flow; prices and caps do not.
          walk(value, depth + 1, target, tainted || POSITION_SUBTREE_KEY.test(key));
          continue;
        }
        const rec = target || top;
        if (!tainted && PRICE_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0) {
            const unit = USD_HINT.test(key) ? 'usd' : NATIVE_HINT.test(key) ? 'native' : 'unknown';
            pushCandidate(rec, { value: n, unit, key });
          }
        } else if (!tainted && MCAP_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0 && rec.mcap === null) rec.mcap = n;
        } else if (SYMBOL_KEY.test(key) && typeof value === 'string' && value.length <= 24) {
          rec.symbol = rec.symbol || value;
        } else if (NAME_KEY.test(key) && typeof value === 'string' && value.length <= 64) {
          rec.name = rec.name || value;
        }
      }
    })(obj, 0, null, false);

    return { records, top };
  }

  // GMGN's realtime WebSocket publishes every venue trade on the
  // `token_activity` channel with terse keys: `a` = token mint, `pu` = trade
  // price in USD, `e` = buy/sell. The generic key scanner cannot see these
  // (`pu` matches no price pattern and `ca` is the AMM address, not the mint),
  // which left GMGN's live feed entirely unused — the extension fell back to
  // slow polling. Mint-tagged USD ticks let quote.js validate exactly.
  // The tick throttle is PER MINT, not global (DEFECT F-07). The old global
  // 100 ms gate ran before the batch was even inspected, so at high volume —
  // when inter-batch gaps fall under 100 ms — a batch of unrelated mints
  // silently discarded the NEXT batch, including the watched coin. That is
  // the same starvation class v1.2.14 fixed inside a single batch, one layer
  // up. Every batch is now parsed (a single cheap pass) and each mint keeps
  // its own emission clock.
  const ACTIVITY_TICK_MIN_MS = 100;
  const activityLastEmitByMint = new Map();

  function forwardTokenActivity(parsed) {
    if (!parsed || parsed.channel !== 'token_activity' || !Array.isArray(parsed.data)) return false;
    const now = Date.now();
    const latestByMint = new Map();
    for (const item of parsed.data) {
      if (!item || typeof item.a !== 'string' || !BASE58_RE.test(item.a)) continue;
      const priceUsd = numberValue(item.pu);
      if (priceUsd > 0) latestByMint.set(item.a, priceUsd);
    }
    if (!latestByMint.size) return true;
    // Emit the mint the user is actually looking at FIRST: under high volume a
    // batch carries many mints, and Map iteration order offers no guarantee
    // the watched coin makes the cut. Then top up with any others.
    let emitted = 0;
    const due = (mint) => now - (activityLastEmitByMint.get(mint) || 0) >= ACTIVITY_TICK_MIN_MS;
    const emitTick = (mint, priceUsd) => {
      activityLastEmitByMint.set(mint, now);
      emit('tick', {
        candidates: [{ value: priceUsd, unit: 'usd', key: 'tokenActivityPriceUsd' }],
        mcap: null,
        mint,
        symbol: currentSymbolInfo.mint === mint ? currentSymbolInfo.symbol : null,
        name: null,
        source: 'gmgn-ws-trade',
      });
    };
    const watchedMint = currentSymbolInfo.mint;
    if (watchedMint && latestByMint.has(watchedMint) && due(watchedMint)) {
      emitTick(watchedMint, latestByMint.get(watchedMint));
      emitted++;
    }
    for (const [mint, priceUsd] of latestByMint) {
      if (mint === watchedMint) continue;
      if (emitted >= 5) break;
      if (!due(mint)) continue;
      emitTick(mint, priceUsd);
      emitted++;
    }
    // Bound the per-mint clock map so a long trenches session cannot grow it
    // without limit; entries older than a few seconds are meaningless anyway.
    if (activityLastEmitByMint.size > 512) {
      for (const [mint, at] of activityLastEmitByMint) {
        if (now - at > 5000) activityLastEmitByMint.delete(mint);
        if (activityLastEmitByMint.size <= 256) break;
      }
    }
    return true;
  }

  function forwardJson(raw, source, url) {
    // No consumer, no parse — the cheapest frame is the one never read.
    if (!feedActive()) return;
    let parsed = raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trimStart();
      // GMGN's realtime trade batches grow past the parse guard exactly when
      // volume is high (reported: "tech doesn't work when volume is high" on
      // GMGN). The size limit exists to keep the generic collector walk from
      // chewing pathological frames — it must NOT blind the token_activity
      // fast path, which is the whole live feed on GMGN. Route those frames
      // before the guard; the walk keeps its guard. The probe is tolerant of
      // serializer whitespace (`"channel": "token_activity"` matches too);
      // forwardTokenActivity still validates the parsed shape.
      if (trimmed.length > 15 && trimmed.slice(0, 120).indexOf('"token_activity"') !== -1) {
        try { parsed = JSON.parse(raw); } catch (_) { return; }
        forwardTokenActivity(parsed);
        return;
      }
      if (url && /\/api\/v1\/token_mcap_candles\//.test(url)) {
        // GMGN's market-cap candles ARE the chart feed on GMGN, and a hot
        // token's full history outgrows the generic guard — the exact failure
        // v1.2.14 fixed for the trade feed (DEFECT F-06). The URL match is
        // exact, so this is not a generic bypass.
        try { parsed = JSON.parse(raw); } catch (_) { return; }
      } else {
        // The guard bounds JSON.parse cost only — the collector walk itself
        // is bounded by NODE_BUDGET regardless of frame size. 500 KB silently
        // killed every non-GMGN site's trade feed at peak volume (F-06).
        if (raw.length > FRAME_GUARD_BYTES) return;
        if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
        try { parsed = JSON.parse(raw); } catch (_) { return; }
      }
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (forwardTokenActivity(parsed)) return;

    // GMGN's embedded TradingView chart is explicitly a market-cap chart:
    // /api/v1/token_mcap_candles/... returns USD market-cap OHLC values in
    // data.list[]. GMGN's iframe symbol is `<chain>/<mint>/USD/MCAP`, so its
    // `close` value is the exact Y-axis unit, never a token-price value.
    if (url && /\/api\/v1\/token_mcap_candles\//.test(url)) {
      // DEFECT C-26: the candle request names the chart's bar grid
      // (?resolution=1s/1m/...). Note it so GMGN fill markers snap to the
      // bar boundary exactly like the Padre/Axiom mark path does.
      const resMatch = /[?&]resolution=([0-9A-Za-z]+)/.exec(url);
      if (resMatch) noteResolution(resMatch[1]);
      const candles = parsed && parsed.data && Array.isArray(parsed.data.list) ? parsed.data.list : [];
      const last = candles[candles.length - 1];
      const mcap = last && numberValue(last.close);
      if (mcap > 0) {
        // C-08: this close IS the value on GMGN's Y axis — the scale anchor
        // for every GMGN line and fill shape (see gmgnCapScale).
        gmgnLastCandleClose = mcap;
        emit('tick', {
          candidates: [],
          mcap,
          mint: currentSymbolInfo.mint,
          symbol: currentSymbolInfo.symbol,
          source: 'gmgn-mcap-candle',
        });
        return;
      }
    }

    const { records, top } = collect(parsed);
    const hasContent = (rec) => rec.candidates.length || rec.mcap !== null;
    if (records.size) {
      // Watched token first — the GMGN fast-path contract, now generic — then
      // a bounded top-up so screener row chips keep their mint-tagged prices.
      const watched = (currentSymbolInfo.mint && records.get(currentSymbolInfo.mint))
        || (currentSymbolInfo.pairAddress && records.get(currentSymbolInfo.pairAddress))
        || null;
      let emitted = 0;
      if (watched && hasContent(watched)) { emit('tick', { ...watched, source }); emitted++; }
      for (const rec of records.values()) {
        if (rec === watched || !hasContent(rec)) continue;
        if (emitted++ >= 5) break;
        emit('tick', { ...rec, source });
      }
      if (emitted) return;
      // Records existed but carried no prices; fall through to the
      // unattributed finds so a lone top-level price still ticks.
    }
    if (!top.candidates.length && top.mcap === null) return;
    emit('tick', { ...top, source });
  }

  /* ---------------- SPA navigation signal ----------------
   * Every supported site is an SPA, and the content script's only navigation
   * signal used to be an 800 ms URL poll — so the previous token's live panel
   * and chart lines lingered on the new page for up to a tick (DEFECT O-14).
   * Programmatic pushState/replaceState is invisible to the isolated world,
   * so the hook lives here and posts a nav event the moment the route
   * changes. popstate/hashchange are visible to both worlds and the content
   * script listens for those itself.
   */
  try {
    const notifyNav = () => emit('nav', { href: location.href });
    const origPush = history.pushState;
    history.pushState = function (...args) { const r = origPush.apply(this, args); notifyNav(); return r; };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) { const r = origReplace.apply(this, args); notifyNav(); return r; };
  } catch (_) {}

  /* ---------------- early generic transport interception ---------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : (input && input.url) || '';
      promise.then((response) => {
        try {
          // Gate BEFORE the clone: response.clone().text() materializes a
          // second copy of the body on the page's main thread, which is most
          // of this tap's cost. With no tick consumer the copy never happens.
          if (!feedActive()) return;
          const type = response.headers && response.headers.get('content-type');
          if (type && !/json/i.test(type)) return;
          const finalUrl = response.url || requestUrl;
          // Bodies the parse guard would drop anyway are not worth copying.
          // The GMGN mcap-candles route is the one audited fetch/XHR path
          // allowed past the guard (F-06), so it alone skips this pre-gate.
          const length = Number(response.headers && response.headers.get('content-length'));
          if (length > FRAME_GUARD_BYTES && !/\/api\/v1\/token_mcap_candles\//.test(finalUrl)) return;
          response.clone().text().then((text) => forwardJson(text, 'fetch', finalUrl), () => {});
        } catch (_) {}
      }, () => {});
      return promise;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__paperTrenchPatched) {
    const originalSend = XHR.prototype.send;
    XHR.prototype.__paperTrenchPatched = true;
    XHR.prototype.send = function (body) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') forwardJson(this.responseText, 'xhr', this.responseURL);
          else if (this.responseType === 'json') forwardJson(this.response, 'xhr', this.responseURL);
        } catch (_) {}
      });
      return originalSend.call(this, body);
    };
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    const WrappedWebSocket = function (url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      socket.addEventListener('message', (event) => {
        // Padre's multiplex messages are binary protobuf and are deliberately
        // handled after Padre decodes them through its TradingView datafeed.
        if (typeof event.data === 'string') forwardJson(event.data, 'ws');
      });
      return socket;
    };
    WrappedWebSocket.prototype = OriginalWebSocket.prototype;
    WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
    WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    try { window.WebSocket = WrappedWebSocket; } catch (_) {}
  }

  // GMGN routes realtime price updates through a SharedWorker. Observing the
  // worker port gives the page's newest quote without polling or modifying the
  // worker protocol. Returning the original worker object preserves instanceof
  // checks and application behavior.
  //
  // GMGN is the ONLY audited site that carries prices this way (per-site
  // matrix, DEFECTS.md), and this wrapper is the one tap with a side effect —
  // port.start() — on an object the host site owns. Other sites keep their
  // native SharedWorker untouched.
  const OriginalSharedWorker = window.SharedWorker;
  const bridgeHostname = (() => {
    try { return location.hostname || new URL(location.href).hostname; } catch (_) { return ''; }
  })();
  const hostUsesSharedWorkerFeed = /(^|\.)gmgn\.ai$/.test(bridgeHostname);
  if (typeof OriginalSharedWorker === 'function' && hostUsesSharedWorkerFeed) {
    const WrappedSharedWorker = function (url, options) {
      const worker = options === undefined
        ? new OriginalSharedWorker(url)
        : new OriginalSharedWorker(url, options);
      try {
        const port = worker && worker.port;
        if (port && typeof port.addEventListener === 'function') {
          port.addEventListener('message', (event) => {
            if (event && typeof event.data === 'string') forwardJson(event.data, 'shared-worker');
            else if (event && event.data && typeof event.data === 'object') forwardJson(event.data, 'shared-worker');
          });
          if (typeof port.start === 'function') port.start();
        }
      } catch (_) {}
      return worker;
    };
    WrappedSharedWorker.prototype = OriginalSharedWorker.prototype;
    try { window.SharedWorker = WrappedSharedWorker; } catch (_) {}
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    const WrappedEventSource = function (url, options) {
      const source = options === undefined
        ? new OriginalEventSource(url)
        : new OriginalEventSource(url, options);
      source.addEventListener('message', (event) => {
        if (typeof event.data === 'string') forwardJson(event.data, 'sse');
      });
      return source;
    };
    WrappedEventSource.prototype = OriginalEventSource.prototype;
    try { window.EventSource = WrappedEventSource; } catch (_) {}
  }

  /* ---------------- TradingView widget discovery ---------------- */

  /**
   * Find the page's TradingView widget.
   *
   * Padre publishes it as `window.tvWidget`. Axiom loads the same TradingView
   * library (`/scripts/trading-view-lib/datafeeds/udf/dist/bundle.js`) but does
   * not always use that name, so the known globals are checked first and then
   * the window is scanned for an object carrying the widget's own API shape.
   *
   * Matching on API SHAPE rather than a name is what makes this survive a site
   * renaming its variable, which minified bundles do on every deploy.
   */
  const WIDGET_GLOBALS = ['tvWidget', 'tradingViewWidget', 'axiomChart', 'chartWidget', 'widget'];

  function looksLikeWidget(value) {
    if (!value || typeof value !== 'object') return false;
    const hasChart = typeof value.activeChart === 'function' || typeof value.chart === 'function';
    if (!hasChart) return false;
    // onChartReady is present on every TradingView widget and is rare enough
    // elsewhere to make this a safe discriminator.
    return typeof value.onChartReady === 'function' || Boolean(getPadreDatafeed(value));
  }

  function findGlobalWidget() {
    for (const name of WIDGET_GLOBALS) {
      try {
        if (looksLikeWidget(window[name])) return window[name];
      } catch (_) { /* cross-origin or throwing getter */ }
    }
    // Shape scan, bounded so a large page cannot stall the bridge.
    let keys;
    try { keys = Object.keys(window); } catch (_) { return null; }
    for (let i = 0; i < keys.length && i < 400; i++) {
      const key = keys[i];
      if (!/widget|chart|tv|axiom/i.test(key)) continue;
      try {
        if (looksLikeWidget(window[key])) return window[key];
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Axiom exposes NO window global for its TradingView widget — the instances
   * live in React refs. The mounted fiber tree (reached through the standard
   * TradingView container iframe's parent element) is walked defensively for
   * ref objects with the widget's API shape, exactly like the GMGN chart
   * manager discovery below. The scan is cached: it is bounded but not free,
   * and the callers poll.
   */
  const fiberWidgetsCache = { at: 0, widgets: [] };
  const FIBER_SCAN_INTERVAL_MS = 3000;

  function widgetsFromFibers() {
    const now = Date.now();
    if (now - fiberWidgetsCache.at < FIBER_SCAN_INTERVAL_MS) return fiberWidgetsCache.widgets;
    fiberWidgetsCache.at = now;
    const widgets = [];
    try {
      const anchor = document.querySelector('iframe[id^="tradingview_"]');
      const el = anchor && anchor.parentElement;
      const fiberKey = el && Object.getOwnPropertyNames(el).find((key) => key.indexOf('__reactFiber$') === 0);
      let root = fiberKey ? el[fiberKey] : null;
      if (root) {
        while (root.return) root = root.return;
        const seen = new Set();
        const stack = [root];
        let inspected = 0;
        while (stack.length && inspected++ < 8000) {
          const fiber = stack.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
          let hook = fiber.memoizedState;
          let hooks = 0;
          while (hook && hooks++ < 100) {
            const ref = hook.memoizedState && hook.memoizedState.current;
            try {
              if (looksLikeWidget(ref) && widgets.indexOf(ref) < 0) widgets.push(ref);
            } catch (_) { /* throwing getter on a ref */ }
            hook = hook.next;
          }
        }
      }
    } catch (_) { /* fiber internals shifted; other strategies still apply */ }
    fiberWidgetsCache.widgets = widgets;
    return widgets;
  }

  /**
   * Last resort: the TradingView library iframe is same-origin (blob: URL),
   * and its inner window publishes `tradingViewApi` with `activeChart()`.
   * This grants order lines and execution shapes even when the outer widget
   * object cannot be located at all. No datafeed access from here, so bars
   * and getMarks stay unhooked on this path.
   */
  const iframeWidgetCache = new WeakMap();

  function widgetsFromIframes() {
    const out = [];
    try {
      for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]')) {
        let api = null;
        try {
          api = frame.contentWindow && frame.contentWindow.tradingViewApi;
        } catch (_) { continue; }
        if (!api || typeof api.activeChart !== 'function') continue;
        let pseudo = iframeWidgetCache.get(frame);
        if (!pseudo) {
          pseudo = {
            activeChart: () => {
              const live = frame.contentWindow && frame.contentWindow.tradingViewApi;
              return live && typeof live.activeChart === 'function' ? live.activeChart() : null;
            },
            onChartReady: (cb) => { try { cb(); } catch (_) {} },
            _iFrame: frame,
          };
          iframeWidgetCache.set(frame, pseudo);
        }
        // F-38 (fomo, reverse-engineered live 2026-08-05): the top page
        // keeps the widget's OPTIONS BAG — including the datafeed — in
        // window[frameId] ("tradingview_xxxxx"). Without it the pseudo
        // widget could draw but never hook bars: no closes, so mcap lines
        // honestly refused and shapes had nothing to level against.
        // Re-attach on every sweep so a chart remount with a fresh bag
        // re-hooks (the C-12 remount lesson).
        try {
          const bag = window[frame.id];
          if (bag && bag.datafeed) pseudo._options = bag;
        } catch (_) { /* no bag: draws still work, bars stay unhooked */ }
        out.push(pseudo);
      }
    } catch (_) {}
    return out;
  }

  function findTradingViewWidgets() {
    const out = [];
    const push = (w) => { if (w && out.indexOf(w) < 0) out.push(w); };
    push(findGlobalWidget());
    for (const w of widgetsFromFibers()) push(w);
    if (!out.length) for (const w of widgetsFromIframes()) push(w);
    return out;
  }

  function findTradingViewWidget() {
    return findTradingViewWidgets()[0] || null;
  }

  /* ---------------- TradingView live bars ---------------- */

  function getPadreDatafeed(widget) {
    if (!widget || typeof widget !== 'object') return null;
    return (widget._options && widget._options.datafeed)
      || (widget.options && widget.options.datafeed)
      || null;
  }

  let lastLiveBarAt = 0; // newest live bar through the subscribeBars hook

  function emitPadreBar(bar, resolution, subscriberUID) {
    if (!bar || typeof bar !== 'object') return;
    const close = numberValue(bar.close);
    if (!(close > 0)) return;
    lastBarClose = close;
    // F-35: remember which subscription produced this close so line/shape
    // level math can vet closes by unit instead of taking the newest global.
    // F-37: the entry also carries its subscription's RESOLUTION, so mark
    // snapping can follow the series that is actually streaming.
    if (subscriberUID != null) {
      barCloseLedger.set(String(subscriberUID), {
        close, atMs: Date.now(), resMs: resolutionToMs(resolution),
      });
      if (barCloseLedger.size > 32) {
        const cutoff = Date.now() - BAR_CLOSE_FRESH_MS;
        for (const [uid, entry] of barCloseLedger) {
          if (entry.atMs < cutoff) barCloseLedger.delete(uid);
        }
      }
      // F-37 (maintainer: "another buy teleports to a random spot"): the
      // snap grid used to be whichever same-token subscription came LAST —
      // Padre's multi-preset panels subscribe the same token at other
      // resolutions, so a hidden 1m series flipped the grid and every new
      // mark snapped up to a minute away. The grid now follows the series
      // that is actually TICKING; when the active grid changes, existing
      // marks re-snap (the C-14 machinery, driven by the right signal).
      const act = activeResolutionMs();
      if (act && act !== lastResolutionMs) {
        lastResolutionMs = act;
        resnapPaperMarks();
      }
    }
    lastLiveBarAt = Date.now();
    // F-31: remember the newest bar's chart time so paper shapes/marks can be
    // clamped to it — a fill stamped milliseconds ahead of the last bar (feed
    // latency or clock skew on a 1 s chart) parked its bubble beyond the
    // final candle, floating at the right edge.
    const barTimeMs = Number(bar.time);
    if (barTimeMs > 0) lastBarTimeSec = barTimeMs > 1e12 ? Math.floor(barTimeMs / 1000) : Math.floor(barTimeMs);

    // Padre can chart token USD price or market cap. Send the decoded close as
    // both an unknown price candidate and a possible market cap. quote.js
    // validates it against the trusted Dexscreener anchors and chooses the
    // matching interpretation.
    emit('tick', {
      candidates: [{ value: close, unit: 'unknown', key: 'padreChartClose' }],
      mcap: close,
      mint: currentSymbolInfo.mint,
      symbol: currentSymbolInfo.symbol,
      name: null,
      source: 'padre-chart-bar',
      barTime: bar.time || null,
      resolution: resolution || null,
    });
  }

  function patchPadreBars(datafeed) {
    if (!datafeed || typeof datafeed.subscribeBars !== 'function') return false;
    if (datafeed.subscribeBars[PATCHED]) return true;

    const original = datafeed.subscribeBars;
    function subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
      // DEFECT C-14: Axiom's hidden preload widget subscribes for OTHER
      // tokens (often at a different resolution); only the chart showing
      // THIS token may set the mark-snapping grid.
      // DEFECT F-29: this runs inside the HOST site's own subscribe call —
      // a PaperTrench throw here would break the site's chart, so the
      // preamble is contained and the host path always proceeds.
      try {
        if (barSymbolMatches(symbolInfo)) noteResolution(resolution);
      } catch (_) { /* our problem, never the host's */ }
      const wrappedCallback = (bar) => {
        // Bars for a different token's chart (Axiom preload) are still passed
        // to the site but must never move our price or axis detection.
        // F-29: the host's realtime callback MUST run whatever our
        // preamble does — a poisoned bar object or a future bug in
        // emitPadreBar must never kill the site's own chart feed.
        try {
          if (barSymbolMatches(symbolInfo)) emitPadreBar(bar, resolution, subscriberUID);
        } catch (_) { /* our problem, never the host's */ }
        return onRealtimeCallback(bar);
      };
      return original.call(
        this,
        symbolInfo,
        resolution,
        wrappedCallback,
        subscriberUID,
        onResetCacheNeededCallback
      );
    }
    subscribeBars[PATCHED] = true;
    datafeed.subscribeBars = subscribeBars;
    return true;
  }

  /* ---------------- Padre native TradingView marks ---------------- */

  // Newest chart resolution observed through subscribeBars/getMarks, so paper
  // marks can snap their time to the bar grid exactly like the site's own
  // bubbles do.
  let lastResolutionMs = null;

  function resolutionToMs(res) {
    const s = String(res || '');
    if (/^\d+s$/i.test(s)) return parseInt(s, 10) * 1000;
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 60_000;
    // DEFECT C-26: GMGN's candle URLs spell resolutions with lowercase unit
    // suffixes ('1m', '5m', '1h'). Lowercase m is minutes and must be read
    // BEFORE the uppercase-M month rule below.
    if (/^\d+m$/.test(s)) return parseInt(s, 10) * 60_000;
    if (/^\d+h$/i.test(s)) return parseInt(s, 10) * 3_600_000;
    // DEFECT C-14: TradingView sends BARE letters for daily/weekly/monthly
    // ('D', 'W', 'M'), where parseInt alone yields NaN — those charts kept a
    // stale lastResolutionMs and marks snapped to the wrong grid.
    if (/^\d*D$/i.test(s)) return (parseInt(s, 10) || 1) * 86_400_000;
    if (/^\d*W$/i.test(s)) return (parseInt(s, 10) || 1) * 604_800_000;
    if (/^\d*M$/.test(s)) return (parseInt(s, 10) || 1) * 2_592_000_000;
    return null;
  }

  function noteResolution(res) {
    const ms = resolutionToMs(res);
    if (!ms || ms === lastResolutionMs) return;
    lastResolutionMs = ms;
    // DEFECT C-14: marks were snapped ONCE at creation to the then-current
    // grid; a chart switched from 1s to 1m candles silently dropped them
    // (TradingView discards marks whose time is off the bar grid). Re-snap
    // every stored mark from its original fill timestamp and refresh.
    resnapPaperMarks();
  }

  function resnapPaperMarks() {
    if (!paperMarks.length) return;
    let moved = false;
    for (const mark of paperMarks) {
      if (!(mark._tsMs > 0)) continue;
      const snapped = snapMarkTime(mark._tsMs);
      if (snapped !== mark.time) { mark.time = snapped; moved = true; }
    }
    // noteResolution runs inside the HOST's subscribeBars/getMarks call —
    // defer the clear+refresh so a throwing chart cannot break the site's
    // own callback (the C-29 latent-hazard rule).
    if (moved) setTimeout(() => { try { refreshPadreMarks(); } catch (_) {} }, 0);
  }

  /** The grid of the subscription that most recently TICKED (F-37). A
   *  subscription that streams every second outvotes one that subscribed
   *  last but sits idle — subscribe ORDER carries no authority. */
  function activeResolutionMs() {
    const now = Date.now();
    let best = null;
    for (const entry of barCloseLedger.values()) {
      if (!(entry.resMs > 0) || now - entry.atMs > BAR_CLOSE_FRESH_MS) continue;
      if (!best || entry.atMs > best.atMs) best = entry;
    }
    return best ? best.resMs : null;
  }

  function snapMarkTime(tsMs) {
    const grid = activeResolutionMs() || lastResolutionMs;
    if (grid) return Math.floor(tsMs / grid) * grid / 1000;
    return Math.floor(tsMs / 1000);
  }

  /** Compact money text, matching how Axiom prints bubble prices. */
  function formatCompactUsd(n) {
    const v = Number(n);
    if (!(v > 0)) return '';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    if (v >= 0.01) return '$' + v.toFixed(2);
    return '$' + v.toPrecision(4);
  }

  /** Plain-decimal SOL text (never scientific notation), as Axiom prints it. */
  function formatSolNative(v) {
    const n = Number(v);
    if (!(n > 0)) return '';
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (n >= 0.001) return String(Number(n.toPrecision(4)));
    return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }

  // Axiom draws trades as TradingView marks; these are the DEFAULTS of its
  // own bubble settings atoms (userBuyBubbleColor / userSellBubbleColor /
  // userBubbleSize), so paper fills are indistinguishable from the bubbles
  // Axiom paints for the user's and tracked wallets' real trades.
  const AXIOM_HOSTS = /(^|\.)axiom\.trade$/;
  let isAxiomHost = false;
  try { isAxiomHost = AXIOM_HOSTS.test(location.hostname); } catch (_) {}
  const AXIOM_BUY_BUBBLE = '#089981';
  const AXIOM_SELL_BUBBLE = '#f23645';
  const AXIOM_BUBBLE_SIZE = 25;

  /* A PERPS fill is quoted in absolute USD and has no SOL price, no mint and
   * no market cap — the whole unit-disambiguation machine below exists for
   * memecoin charts where price and cap sit ~14 orders of magnitude apart,
   * and a perp axis is USD and only USD. Rather than loosen the spot gate
   * (which exists because C-09/C-16 proved a level built from the wrong unit
   * lands arrows 150x off), a USD-quoted payload declares itself and takes
   * its own normalizer. Everything downstream — dedupe, re-snap, the
   * marks/shapes/bubbles handoff, frozen levels — is shared unchanged. */
  /* Perps marks bypass the host's marks pipeline entirely (see
   * ensureMarksRender), so this flag latches the moment one arrives. */
  let perpsMarksPresent = false;

  function perpShapeText(payload) {
    const long = payload.side === 'long' || payload.side === 'buy';
    if (payload.kind === 'liquidation') return 'PT Liquidated';
    if (payload.kind === 'close') return 'PT Close';
    return long ? 'PT Long' : 'PT Short';
  }

  function normalizePerpMark(payload) {
    const price = numberValue(payload.priceUsd);
    if (!(price > 0)) return null;
    const long = payload.side === 'long' || payload.side === 'buy';
    const tsMs = numberValue(payload.ts) || Date.now();
    const id = typeof payload.fillId === 'string' && payload.fillId
      ? `papertrench-${payload.fillId}`
      : `papertrench-perp-${Math.floor(tsMs)}-${Math.random().toString(36).slice(2, 8)}`;
    const kind = typeof payload.kind === 'string' ? payload.kind : (long ? 'long' : 'short');
    const color = kind === 'liquidation' ? '#E73A44' : (long ? '#17C671' : '#E73A44');
    const head = kind === 'liquidation'
      ? 'Liquidated (Paper)'
      : `${kind === 'close' ? 'Close' : (long ? 'Long' : 'Short')} (Paper)`;
    const sizeText = numberValue(payload.notionalUsd) > 0
      ? `${formatCompactUsd(numberValue(payload.notionalUsd))}` : '';
    const levText = numberValue(payload.leverage) > 0 ? `${payload.leverage}x` : '';
    return {
      id,
      time: snapMarkTime(tsMs),
      _tsMs: Math.floor(tsMs),
      color: { background: color, border: color },
      text: `${head}${sizeText ? `\n${sizeText}${levText ? ` @ ${levText}` : ''}` : ''}`
        + `\n${formatCompactUsd(price)}${payload.symbol ? `\n${payload.symbol}` : ''}`,
      label: kind === 'liquidation' ? 'X' : (long ? 'L' : 'S'),
      labelFontColor: '#FFFFFF',
      minSize: 18,
      borderWidth: 1,
      hoveredBorderWidth: 3,
      imageUrl: null,
      showLabelWhenImageLoaded: true,
      _paperTrench: true,
    };
  }

  function normalizePaperMark(payload) {
    if (payload && payload.quote === 'usd-abs') return normalizePerpMark(payload);
    if (!payload || !(numberValue(payload.priceNative) > 0)) return null;
    const side = payload.side === 'sell' ? 'sell' : 'buy';
    const price = numberValue(payload.priceNative);
    const solAmount = numberValue(payload.solAmount) || 0;
    const tsMs = numberValue(payload.ts) || Date.now();
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';
    // F-41: a fill's identity is the TRADE's id, not a fresh random string.
    // A random id made the bridge structurally incapable of recognizing the
    // same fill twice, so any double-post upstream became two independent
    // marks — two bubbles for one buy. With the trade id the invariant
    // "one fill, one mark" holds here no matter how often it is posted.
    const id = typeof payload.fillId === 'string' && payload.fillId
      ? `papertrench-${payload.fillId}`
      : `papertrench-${side}-${Math.floor(tsMs)}-${Math.random().toString(36).slice(2, 8)}`;

    if (isAxiomHost) {
      const priceUsd = numberValue(payload.priceUsd);
      const mcap = numberValue(payload.mcap);
      const usdSize = priceUsd && price > 0 ? solAmount * (priceUsd / price) : null;
      const sizeText = usdSize ? formatCompactUsd(usdSize) : `${solAmount.toFixed(4)} SOL`;
      // Print the "at" price in the same units the chart's Y axis currently
      // shows — price vs market cap, USD vs SOL — like Axiom's own bubbles.
      const nativeMcap = mcap && priceUsd && price > 0 ? mcap * (price / priceUsd) : null;
      const atEntry = pickAxisEntry([
        { v: mcap, text: mcap ? `${formatCompactUsd(mcap)} Market Cap` : null },
        { v: priceUsd, text: priceUsd ? `${formatCompactUsd(priceUsd)} USD` : null },
        { v: price, text: `${formatSolNative(price)} SOL` },
        { v: nativeMcap, text: nativeMcap ? `${formatSolNative(nativeMcap)} SOL Market Cap` : null },
      ]) || { v: mcap, text: mcap ? `${formatCompactUsd(mcap)} Market Cap` : `${formatSolNative(price)} SOL` };
      const atText = atEntry.text || formatCompactUsd(atEntry.v);
      const background = side === 'buy' ? AXIOM_BUY_BUBBLE : AXIOM_SELL_BUBBLE;
      return {
        id,
        time: snapMarkTime(tsMs),
        // Original fill time, so a later resolution change can re-snap the
        // mark to the new bar grid instead of dropping it (C-14).
        _tsMs: Math.floor(tsMs),
        color: { background, border: background + '80' },
        text: `You ${side === 'buy' ? 'bought' : 'sold'} ${sizeText} at ${atText} (Paper)`,
        label: side === 'buy' ? 'B' : 'S',
        labelFontColor: 'white',
        minSize: AXIOM_BUBBLE_SIZE,
        _paperTrench: true,
      };
    }

    const color = side === 'buy' ? '#17C671' : '#E73A44';
    const sideText = side === 'buy' ? 'Buy' : 'Sell';
    return {
      id,
      time: snapMarkTime(tsMs),
      _tsMs: Math.floor(tsMs), // C-14: kept for re-snapping on resolution change
      color: { background: color, border: color },
      text: `${sideText} (Paper)\n${solAmount.toFixed(4)} SOL\n${price.toPrecision(7)} SOL${symbol ? `\n${symbol}` : ''}`,
      label: side === 'buy' ? 'B' : 'S',
      labelFontColor: '#FFFFFF',
      minSize: 18,
      borderWidth: 1,
      hoveredBorderWidth: 3,
      imageUrl: null,
      showLabelWhenImageLoaded: true,
      _paperTrench: true,
    };
  }

  // Newest moment TradingView actually pulled marks through our patched
  // getMarks. Some sites load the library with marks disabled; when that
  // pipeline never runs, fills are drawn as native execution shapes instead.
  let marksPipelineSeenAt = 0;
  let shapeFallbackActive = false;
  // D-43 (Bug 7): a refreshMarks() WE triggered makes the host call our
  // patched getMarks exactly once — a synthetic pull that proves the pipe is
  // connected, not that it renders. Counting it as pipeline evidence
  // suppressed the shape watchdog forever ("mark accepted, never drawn" —
  // live report: board quick-buy, bubble never on the chart). Only
  // host-initiated pulls (the widget re-fetching marks on pan/zoom/data
  // change, which happen repeatedly) count.
  let syntheticMarksPull = false;

  /** F-31's clamp exists for millisecond feed skew between a fill stamp and
   * the newest candle. When live bars are STALE — the chart subscribed
   * before the patch (fomo, Axiom-late) or volume died and the export peg
   * owns the price — the newest live bar is MINUTES old, and clamping a
   * fresh fill onto it drags the arrow visibly into the past ("my sell
   * never showed up"). A stale clamp target is no clamp at all. */
  function freshBarTimeSec() {
    return lastBarTimeSec > 0 && Date.now() - lastLiveBarAt <= BAR_CLOSE_FRESH_MS
      ? lastBarTimeSec
      : 0;
  }

  function marksInRange(from, to) {
    // Once the execution-shape fallback owns rendering, the getMarks pipeline
    // must not duplicate the same fills.
    if (shapeFallbackActive) return [];
    const lo = Number(from);
    const hi = Number(to);
    // F-31: a mark stamped ahead of the newest bar clamps onto it — clamp
    // BEFORE the range filter so a "future" fill renders on the last candle
    // instead of silently not rendering at all.
    const capSec = freshBarTimeSec();
    const clamp = (t) => (capSec > 0 && t > capSec ? capSec : t);
    return paperMarks
      .map((mark) => { const t = clamp(mark.time); return t === mark.time ? mark : { ...mark, time: t }; })
      .filter((mark) => mark.time >= lo && mark.time <= hi);
  }

  function patchPadreMarks(datafeed) {
    if (!datafeed || typeof datafeed.getMarks !== 'function') return false;
    if (datafeed.getMarks[PATCHED]) return true;

    const original = datafeed.getMarks;
    function getMarks(symbolInfo, from, to, onDataCallback, ...rest) {
      // D-43: a pull caused by our own refreshMarks() is synthetic — it does
      // not prove the widget renders marks. The flag is armed immediately
      // before the refresh call and disarmed on the next macrotask, so only
      // pulls landing inside that call's stack are discounted.
      if (!syntheticMarksPull) marksPipelineSeenAt = Date.now();
      // DEFECT F-29: everything PaperTrench does before handing control back
      // runs inside the HOST's own getMarks call — contained, so a throw in
      // our preamble can never break the site's chart.
      try {
        // C-14: same gate as subscribeBars — a preload chart's resolution must
        // never overwrite the visible chart's snapping grid.
        if (barSymbolMatches(symbolInfo)) noteResolution(rest[0]);
        // The library IS pulling marks — the native pipeline wins. If the
        // execution-shape fallback fired first (slow chart boot), hand
        // rendering back and remove the temporary shapes. Paper fills then
        // render as the site's own bubble marks (Axiom-styled on Axiom).
        //
        // NEVER for perps. On the perps venues the host exposes getMarks but
        // does not render OUR marks from it, and this handback is reached by
        // our own refreshPadreMarks() call — so the sequence was: shapes
        // draw, we ask the host to refresh, the host calls getMarks, and we
        // delete the only thing the user could see. That is the reported
        // "it shows up then it disappears", and on Hyperliquid it took the
        // bubble while leaving the average lines (a separate mechanism)
        // untouched. Shapes stay authoritative once a perps mark exists.
        if (shapeFallbackActive && !perpsMarksPresent) {
          shapeFallbackActive = false;
          clearShapeFallback();
        }
      } catch (_) { /* our problem, never the host's */ }
      const mergedCallback = (siteMarks) => {
        const base = Array.isArray(siteMarks) ? siteMarks : [];
        // F-29: the host's data callback ALWAYS runs; if merging our marks
        // fails, the site still gets its own marks unharmed.
        let ours = [];
        try { ours = marksInRange(from, to); } catch (_) { ours = []; }
        onDataCallback(base.concat(ours));
      };
      return original.call(this, symbolInfo, from, to, mergedCallback, ...rest);
    }
    getMarks[PATCHED] = true;
    datafeed.getMarks = getMarks;
    return true;
  }

  function frameVisible(frame) {
    try {
      if (!frame || typeof frame.getClientRects !== 'function') return false;
      return frame.getClientRects().length > 0 && frame.clientWidth > 0;
    } catch (_) {
      return false;
    }
  }

  // F-39: chart -> hosting iframe, populated during ranking. Only iframe
  // pseudo-widgets set it; broker-build charts never need it.
  const chartFrameMap = new WeakMap();

  /**
   * All reachable charts, best first.
   *
   * Axiom keeps a hidden PRELOAD widget alongside the visible one; its chart
   * has no series ("UNKNOWN-..." symbol) and every draw call on it throws
   * "Value is null". Drawing must always target the chart the user is
   * actually looking at, so charts are ranked by iframe visibility and by
   * whether they carry a real symbol.
   */
  function getRankedCharts() {
    const ranked = [];
    const seen = new Set();
    for (const widget of findTradingViewWidgets()) {
      // Axiom's own drawing code goes through widget.chart(), while the
      // "active" chart of a multi-chart widget can be a seriesless shell
      // whose every draw call throws. Collect BOTH accessors' charts and let
      // the ranked fall-through find the one that actually accepts drawing.
      const accessors = [];
      if (typeof widget.chart === 'function') accessors.push('chart');
      if (typeof widget.activeChart === 'function') accessors.push('activeChart');
      for (const accessor of accessors) {
        try {
          const chart = widget[accessor]();
          if (!chart || seen.has(chart)) continue;
          seen.add(chart);
          // F-39: the DOM bubble layer places chips over the chart's iframe,
          // so every chart remembers which frame it came from.
          if (widget._iFrame) chartFrameMap.set(chart, widget._iFrame);
          let score = 0;
          if (chartSymbolMatches(chart)) score += 4;
          if (frameVisible(widget._iFrame)) score += 2;
          try {
            const symbol = typeof chart.symbol === 'function' ? String(chart.symbol()) : '';
            if (symbol && symbol.indexOf('UNKNOWN') !== 0) score += 1;
          } catch (_) {}
          ranked.push({ chart, score });
        } catch (_) { /* try the next accessor/widget */ }
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    const ordered = ranked.map((entry) => entry.chart);
    if (!currentSymbolNeedles.length) return ordered;
    const matched = ordered.filter((c) => chartSymbolMatches(c));
    return matched.length ? matched : ordered;
  }

  function getPadreChart() {
    return getRankedCharts()[0] || null;
  }

  /* ---------------- async-tolerant native adapters ----------------
   *
   * Current TradingView builds (GMGN today, others as they upgrade) return a
   * Promise from createOrderLine()/createExecutionShape(); older builds hand
   * back the adapter synchronously. Every native drawing below goes through
   * these helpers so both shapes work, including the clear-while-creating
   * race: a slot generation counter makes a stale resolution remove itself.
   */

  function makeLineSlot() { return { adapter: null, pending: false, pendingAt: 0, gen: 0, chart: null, lastLevel: 0 }; }

  function clearLineSlot(slot) {
    slot.gen += 1;
    slot.pending = false;
    slot.pendingAt = 0;
    if (slot.adapter) { try { slot.adapter.remove(); } catch (_) {} }
    slot.adapter = null;
    slot.chart = null;
  }

  /* ---------------- charting-library (line-tools) fallback ----------------
   *
   * F-39 (fomo, live-probed 2026-08-05): fomo ships TradingView's STANDALONE
   * charting library — its chart API carries createOrderLine and
   * createExecutionShape, but calling either throws
   * "... is only available on Trading Platform". The bridge's silent
   * catch-and-retry treated that as "chart not ready yet" and looped
   * forever: no average lines and no fill marks, on every fomo chain, while
   * the fixture (which implemented both calls) stayed green. Capability is
   * learned from the throw itself, once per chart, and drawing reroutes:
   * average lines become locked horizontal_line LINE TOOLS (verified live:
   * createShape resolves an entity id whose ILineDataSourceApi moves it via
   * setPoints), and fills become PaperTrench's own DOM bubble layer below.
   */
  const chartDrawCaps = new WeakMap(); // chart -> 'linetools' once broker calls threw

  function brokerUnavailable(chart, err) {
    if (/only available on Trading Platform/i.test(String((err && err.message) || err))) {
      chartDrawCaps.set(chart, 'linetools');
      return true;
    }
    return false;
  }

  function chartIsLineTools(chart) {
    return chartDrawCaps.get(chart) === 'linetools';
  }

  /**
   * Wrap a horizontal_line entity in the order-line adapter surface, so the
   * slot machinery (create/update/remove, F-32 frozen levels, F-35 want
   * semantics) runs unchanged on charts without broker primitives. Broker
   * niceties with no line-tool equivalent are accepted and ignored.
   */
  function makeShapeLineAdapter(chart, entityId) {
    const api = () => chart.getShapeById(entityId);
    const setProps = (props) => { api().setProperties(props); };
    const self = {
      setPrice(p) { api().setPoints([{ price: Number(p) }]); return self; },
      setText(t) { if (t) setProps({ text: String(t), showLabel: true }); return self; },
      setLineColor(c) { setProps({ linecolor: c, textcolor: c }); return self; },
      setLineStyle(s) { setProps({ linestyle: Number(s) }); return self; },
      setLineWidth(w) { setProps({ linewidth: Number(w) }); return self; },
      setBodyTextColor(c) { setProps({ textcolor: c }); return self; },
      setQuantity() { return self; },
      setBodyFont() { return self; },
      setBodyBorderColor() { return self; },
      setBodyBackgroundColor() { return self; },
      setEditable() { return self; },
      remove() { chart.removeEntity(entityId); },
    };
    return self;
  }

  /**
   * Create the average line as a locked, non-saving horizontal_line. Created
   * AT the wanted price: unlike an order line, a shape is visible the moment
   * it exists, so a placeholder level would flash somewhere wrong first.
   */
  function createShapeAverageLine(chart, price, label, color) {
    if (typeof chart.createShape !== 'function') return null;
    let made;
    try {
      made = chart.createShape({ price: Number(price) || 0 }, {
        shape: 'horizontal_line',
        lock: true,
        disableSelection: true,
        disableSave: true,
        disableUndo: true,
        showInObjectsTree: false,
        text: label || '',
        overrides: {
          linecolor: color,
          textcolor: color,
          linestyle: 2,
          linewidth: 1,
          showLabel: true,
          fontsize: 11,
          horzLabelsAlign: 'right',
          vertLabelsAlign: 'bottom',
        },
      });
    } catch (_) { return null; }
    if (made && typeof made.then === 'function') {
      return made.then((id) => (id == null ? null : makeShapeLineAdapter(chart, id)));
    }
    return made == null ? null : makeShapeLineAdapter(chart, made);
  }

  function configureAverageLine(line, price, label, color) {
    // Exact configuration used by Padre's K5r average-line helper, except
    // the width now rides the same thickness setting as TP/SL lines (both
    // default to their old values: TP/SL 2, averages 1).
    const width = Math.max(1, Math.min(4, Math.round(
      Number(paperLineSpec && paperLineSpec.lineWidth) || 1)));
    return line
      .setText('')
      .setQuantity('')
      .setLineColor(color)
      .setLineStyle(2)
      .setLineWidth(width)
      .setPrice(Number(price))
      .setText(label)
      .setBodyFont('11px Inter, sans-serif')
      .setBodyTextColor(color)
      .setBodyBorderColor('#FFFFFF00')
      .setBodyBackgroundColor('#FFFFFF00')
      .setEditable(false);
  }

  /* ---------------- draggable chart orders (take profit / stop loss) ------
   *
   * The exit half of paper trading, with Padre's ergonomics: a line you grab
   * and drop where you want the position to leave. These are the SAME
   * TradingView order lines the average levels above use — the only
   * differences are setEditable(true) and the onMove/onCancel handlers,
   * which is exactly how a real terminal wires them.
   *
   * UNIT INVERSION — the part that has to be right, or every armed level is
   * a lie. The chart's Y axis is not necessarily a token price: it may be
   * market cap (Axiom's default), USD, native SOL, or absolute USD on a perp
   * axis, and the user can flip it mid-session. A drag hands back
   * getPrice() in WHATEVER unit the axis is currently in.
   *
   * Rather than re-deriving the unit — the failure mode that produced C-02
   * through C-05 — this exploits the one property every basis shares: each
   * is a LINEAR function of the token price. So the ratio to the live level
   * is unit-free and exact:
   *
   *     level   = currentLevel x (trigger / refPrice)      draw
   *     trigger = refPrice     x (level   / currentLevel)  drag back
   *
   * and no branch on axisBasis is needed anywhere. When the current level
   * cannot be established (no bar close yet on an mcap axis, no rate on a
   * USD one) the ratio is undefined, so NO line is drawn and no drag is
   * accepted — honest absence, never a fabricated level.
   */

  let paperOrderSpec = null;         // { enabled, orders: [...], refPrice }
  let orderWidget = null;            // widget the current adapters belong to
  const orderSlots = new Map();      // order id -> line slot

  const ORDER_TP_COLOR = '#3fb950';
  const ORDER_SL_COLOR = '#f85149';

  /**
   * The Y-axis level the LIVE price currently sits at — the anchor both
   * directions of the conversion hang off. Null means the axis unit is not
   * yet knowable, which must stop the feature rather than guess.
   *
   * D-42: on mcap and USD bases the anchor is the unit snapshot the content
   * side posted TOGETHER with refPrice (spec.refMcap / spec.refPriceUsd) —
   * never the live bar close or the live rate. A ratio mixing a stale
   * refPrice with the live unit slides the drawn level as the market moves
   * (supply is constant, so refUnit/refPrice is too: level = refUnit ×
   * trigger/refPrice is the SAME number on every redraw — the line stays
   * where it was armed). The native basis needs no conversion at all.
   */
  function currentAxisLevel(spec) {
    const basis = spec && spec.axisBasis;
    if (basis === 'mcap') {
      const ref = Number(spec && spec.refMcap);
      if (ref > 0) return ref;
      // Legacy posts (pre-D-42) carried no unit snapshot; the live close is
      // the old behavior — kept only so an old spec still draws SOMETHING
      // until the next post refreshes it (≤1 s sweep).
      return lastBarClose > 0 ? lastBarClose : null;
    }
    if (basis === 'usd' || basis === 'usd-abs') {
      const ref = Number(spec && spec.refPriceUsd);
      if (ref > 0) return ref;
      const usd = Number(spec && spec.currentPriceUsd);
      return usd > 0 ? usd : null;
    }
    if (basis === 'native') {
      const native = Number(spec && spec.currentPriceNative);
      return native > 0 ? native : null;
    }
    return null;
  }

  /** Chart level for an armed trigger price. Null when not knowable. */
  function orderLevelFor(spec, triggerPrice) {
    const currentLevel = currentAxisLevel(spec);
    const ref = Number(spec && spec.refPrice);
    const trigger = Number(triggerPrice);
    if (!(currentLevel > 0) || !(ref > 0) || !(trigger > 0)) return null;
    return currentLevel * (trigger / ref);
  }

  /** The inverse: a dragged level back to a trigger price. */
  function orderPriceFromLevel(spec, level) {
    const currentLevel = currentAxisLevel(spec);
    const ref = Number(spec && spec.refPrice);
    const value = Number(level);
    if (!(currentLevel > 0) || !(ref > 0) || !(value > 0)) return null;
    return ref * (value / currentLevel);
  }

  function configureOrderLine(line, order, level) {
    const color = order.kind === 'tp' ? ORDER_TP_COLOR : ORDER_SL_COLOR;
    // Line width rides the spec (settings.chartOrderLineThickness): 1
    // hairline, 2 default, 3 thick for dense charts. Clamped, because a
    // restored settings blob can carry anything.
    const width = Math.max(1, Math.min(4, Math.round(
      Number(paperOrderSpec && paperOrderSpec.lineWidth) || 2)));
    return line
      .setText(order.label || (order.kind === 'tp' ? 'TAKE PROFIT' : 'STOP LOSS'))
      .setQuantity(order.sizePct >= 100 ? 'ALL' : `${order.sizePct}%`)
      .setLineColor(color)
      .setLineStyle(0)
      .setLineWidth(width)
      .setPrice(Number(level))
      .setBodyFont('11px Inter, sans-serif')
      .setBodyTextColor(color)
      .setBodyBorderColor(color)
      .setBodyBackgroundColor('#0D1117E6')
      .setEditable(true);
  }

  /**
   * Wire the drag and the cancel button.
   *
   * onMove fires on DROP with the line already at its new level, so the
   * level is read back off the adapter rather than trusted from a closure.
   * A drag whose level cannot be inverted is reported as a refusal and the
   * line is snapped back, so the chart never shows a level the wallet did
   * not accept.
   */
  function bindOrderLineHandlers(line, order) {
    if (typeof line.onMove === 'function') {
      line.onMove(() => {
        let level = null;
        try { level = line.getPrice(); } catch (_) {}
        const price = orderPriceFromLevel(paperOrderSpec, level);
        if (!(price > 0)) {
          // Put it back where the wallet still believes it is.
          const back = orderLevelFor(paperOrderSpec, order.triggerPrice);
          if (back > 0) { try { line.setPrice(back); } catch (_) {} }
          emit('paper-order-moved', { id: order.id, ok: false, reason: 'axis-unit-unknown' });
          return;
        }
        order.triggerPrice = price;
        // D-42: the drag redefined the level — the next sweep must setPrice
        // (not skip as "unchanged"), so the slot's cached level dies here.
        const draggedSlot = orderSlots.get(order.id);
        if (draggedSlot) draggedSlot.lastLevel = 0;
        emit('paper-order-moved', { id: order.id, ok: true, triggerPrice: price, level });
      });
    }
    if (typeof line.onCancel === 'function') {
      line.onCancel(() => { emit('paper-order-cancelled', { id: order.id }); });
    }
    return line;
  }

  function clearPaperOrderLines() {
    for (const slot of orderSlots.values()) clearLineSlot(slot);
    orderSlots.clear();
  }

  /**
   * Bring the drawn order lines in line with the armed set. Runs on every
   * repost and on the 1 s sweep, like the average lines, so a chart that
   * arrives late still gets its levels.
   */
  function syncPaperOrderLines() {
    const spec = paperOrderSpec;
    if (!spec || !spec.enabled || !Array.isArray(spec.orders) || !spec.orders.length) {
      clearPaperOrderLines();
      return false;
    }
    // Same chart the average lines draw on — ranked, so a multi-chart
    // widget's seriesless shell never wins (see getRankedCharts).
    const widget = findTradingViewWidget();
    const charts = getRankedCharts();
    if (!widget || !charts.length) return false;
    const chart = charts[0];

    // A chart swap invalidates every adapter held against the old one.
    if (orderWidget && orderWidget !== widget) clearPaperOrderLines();
    orderWidget = widget;

    // Orders that are no longer armed lose their line immediately.
    const live = new Set(spec.orders.map((o) => o.id));
    for (const [id, slot] of orderSlots) {
      if (!live.has(id)) { clearLineSlot(slot); orderSlots.delete(id); }
    }

    let drewAll = true;
    for (const order of spec.orders) {
      const level = orderLevelFor(spec, order.triggerPrice);
      if (!(level > 0)) { drewAll = false; continue; }

      let slot = orderSlots.get(order.id);
      if (!slot) { slot = makeLineSlot(); orderSlots.set(order.id, slot); }
      slot.want = { price: level, order };

      // Already drawn: move it rather than rebuild, so a drag in progress on
      // another line is never interrupted by a repost. D-42: skip the
      // setPrice when the level is unchanged — a same-value setPrice still
      // pokes TradingView, which re-anchors the line to its own price scale
      // and shows as the line "moving with the market" on a live chart.
      if (slot.adapter) {
        try {
          if (!(slot.lastLevel > 0) || slot.lastLevel !== level) {
            slot.adapter.setPrice(level);
            slot.lastLevel = level;
          }
          slot.adapter.setQuantity(order.sizePct >= 100 ? 'ALL' : `${order.sizePct}%`);
        }
        catch (_) { clearLineSlot(slot); }
        continue;
      }
      if (slot.pending) { if (Date.now() - slot.pendingAt < 5000) continue; clearLineSlot(slot); }

      let created;
      try { created = chart.createOrderLine(); }
      catch (err) {
        // F-39: a standalone charting library has no broker primitives, so
        // there is nothing here that can be dragged. Say so once and stop —
        // a locked horizontal_line would look identical and refuse to move,
        // which is worse than not offering the feature on this chart.
        if (brokerUnavailable(chart, err)) {
          emit('paper-orders-status', { ok: false, reason: 'no-draggable-lines' });
          clearPaperOrderLines();
          return false;
        }
        created = null;
      }
      if (!created) { drewAll = false; continue; }

      if (typeof created.then === 'function') {
        slot.pending = true;
        slot.pendingAt = Date.now();
        const gen = slot.gen;
        created.then((line) => {
          if (slot.gen !== gen) { try { line.remove(); } catch (_) {} return; }
          slot.pending = false;
          slot.pendingAt = 0;
          try {
            const want = slot.want || { price: level, order };
            configureOrderLine(line, want.order, want.price);
            bindOrderLineHandlers(line, want.order);
            slot.adapter = line;
            slot.chart = chart;
          } catch (_) { try { line.remove(); } catch (_) {} }
        }, () => { if (slot.gen === gen) { slot.pending = false; slot.pendingAt = 0; } });
        continue;
      }
      try {
        configureOrderLine(created, order, level);
        bindOrderLineHandlers(created, order);
        slot.adapter = created;
        slot.chart = chart;
      } catch (_) { clearLineSlot(slot); drewAll = false; }
    }
    return drewAll;
  }

  /**
   * Keep one average line in sync with `price`. Returns true when the line is
   * live, being created, or intentionally absent; false when the chart could
   * not produce it (callers retry).
   */
  function syncLineSlot(slot, chart, price, label, color, wanted) {
    if (!(Number(price) > 0)) {
      // F-41: "no level" and "no line" are different facts. A caller that
      // MEANS no line (spec disabled, no average on this side) clears. But a
      // WANTED level that merely became uncomputable for a moment — the
      // evidence window lapsing on a quiet token — must not destroy a line
      // that is still the correct constant in axis units. Destroying it was
      // how a held position lost its average line 15 s after the last tick
      // and got it back only when the next trade printed.
      if (!wanted) { clearLineSlot(slot); return true; }
      return Boolean(slot.adapter);
    }
    // F-35: the slot always remembers the newest requested appearance. An
    // async createOrderLine that is still in flight configures itself from
    // HERE on resolve — not from the values captured when it was issued, or
    // a DCA that moved the average mid-creation drew at the old level.
    slot.want = { price: Number(price), label, color };
    // The adapter belongs to one chart. If the site promoted a different
    // chart to the foreground (Axiom preload swap), recreate the line there.
    if (slot.adapter && slot.chart && slot.chart !== chart) clearLineSlot(slot);
    if (slot.adapter) {
      try {
        slot.adapter
          .setPrice(Number(price))
          .setLineColor(color)
          .setText(label)
          .setBodyFont('11px Inter, sans-serif')
          .setBodyTextColor(color);
        return true;
      } catch (_) {
        clearLineSlot(slot);
      }
    }
    // An async createOrderLine can stay pending forever when it was issued
    // before the chart had a series (same failure as exportData at boot).
    // Let the guard expire and try again.
    if (slot.pending) {
      if (Date.now() - slot.pendingAt < 5000) return true;
      clearLineSlot(slot);
    }

    let created;
    try { created = chart.createOrderLine(); }
    catch (err) {
      // F-39: on a standalone charting library this throw is a FACT about
      // the build, not a transient failure — note it and draw the same line
      // as a locked horizontal_line instead.
      brokerUnavailable(chart, err);
      created = null;
    }
    if (!created && chartIsLineTools(chart)) {
      created = createShapeAverageLine(chart, (slot.want && slot.want.price) || price, label, color);
    }
    if (!created) return false;
    if (created && typeof created.then === 'function') {
      slot.pending = true;
      slot.pendingAt = Date.now();
      const gen = slot.gen;
      created.then((line) => {
        if (slot.gen !== gen) { try { line.remove(); } catch (_) {} return; }
        slot.pending = false;
        slot.pendingAt = 0;
        try {
          // F-35: configure from the slot's newest request, not the values
          // this closure captured at issue time.
          const want = slot.want || { price, label, color };
          configureAverageLine(line, want.price, want.label, want.color);
          slot.adapter = line;
          slot.chart = chart;
        } catch (_) {
          try { line.remove(); } catch (_) {}
        }
      }, () => { if (slot.gen === gen) { slot.pending = false; slot.pendingAt = 0; } });
      return true;
    }
    try {
      configureAverageLine(created, price, label, color);
      slot.adapter = created;
      slot.chart = chart;
      return true;
    } catch (_) {
      try { created.remove(); } catch (_) {}
      return false;
    }
  }

  /**
   * Spawn one buy/sell execution shape at `level` on the chart's own Y axis.
   * Returns a handle whose `removed` flag also cancels an in-flight creation.
   */
  function spawnExecutionShape(chart, spec) {
    const level = Number(spec.level);
    const timeSec = Number(spec.timeSec);
    if (!(level > 0) || !(timeSec > 0)) return null;
    const isBuy = spec.side !== 'sell';
    const handle = { removed: false, adapter: null };

    const configure = (shape) => {
      shape
        .setText(spec.text || (isBuy ? 'PT Buy' : 'PT Sell'))
        .setTextColor(isBuy ? '#34D399' : '#FF5F56')
        .setArrowColor(isBuy ? '#34D399' : '#FF5F56')
        .setDirection(isBuy ? 'buy' : 'sell')
        .setTime(Math.floor(timeSec))
        .setPrice(level);
      if (handle.removed) { try { shape.remove(); } catch (_) {} return; }
      handle.adapter = shape;
    };

    let created;
    try { created = chart.createExecutionShape(); }
    catch (err) {
      // F-39: remember that this build has no broker primitives, so the
      // caller can hand rendering to the DOM bubble layer instead of
      // retrying a throw forever.
      brokerUnavailable(chart, err);
      return null;
    }
    if (created && typeof created.then === 'function') {
      created.then((shape) => {
        try { configure(shape); } catch (_) { try { shape.remove(); } catch (_) {} }
      }, () => {});
      return handle;
    }
    if (!created) return null;
    try { configure(created); } catch (_) { try { created.remove(); } catch (_) {} return null; }
    return handle;
  }

  function removeShapeHandle(handle) {
    if (!handle) return;
    handle.removed = true;
    if (handle.adapter) { try { handle.adapter.remove(); } catch (_) {} }
    handle.adapter = null;
  }

  /**
   * Choose which stored fill level matches the chart's Y axis. The newest live
   * bar close reveals the axis unit by magnitude: a $0.000003 token and its
   * $250M market cap are ~14 orders of magnitude apart, so the nearest level
   * in log space is unambiguous. Entries may carry a `text` the caller wants
   * to reuse when that unit wins (hover text on Axiom prints in chart units).
   */
  function pickAxisEntry(entries) {
    const usable = entries.filter((e) => Number(e && e.v) > 0);
    if (!usable.length) return null;
    // DEFECT C-05: before the first bar close there is NO evidence of the
    // chart's unit. The old "first usable candidate" fallback painted a USD
    // token price on an mcap axis (~9 orders of magnitude off) exactly
    // during chart boot. Honest absence beats a fabricated level: draw
    // nothing until evidence arrives (a close, or an explicit axisBasis
    // which bypasses this picker entirely).
    if (!(lastBarClose > 0)) return null;
    let best = usable[0];
    let bestDist = Math.abs(Math.log10(best.v / lastBarClose));
    for (const e of usable.slice(1)) {
      const dist = Math.abs(Math.log10(e.v / lastBarClose));
      if (dist < bestDist) { best = e; bestDist = dist; }
    }
    return best;
  }

  function pickAxisLevel(usd, mcap, native, nativeMcap) {
    // With a live bar close the nearest candidate in log space wins; with no
    // close yet, pickAxisEntry refuses (C-05) and callers retry once evidence
    // arrives. The ordering only breaks exact log-distance ties: Axiom's
    // default chart view is market cap, Padre charts price.
    const ordered = isAxiomHost
      ? [{ v: mcap }, { v: usd }, { v: native }, { v: nativeMcap }]
      : [{ v: usd }, { v: mcap }, { v: native }, { v: nativeMcap }];
    const picked = pickAxisEntry(ordered);
    return picked ? picked.v : null;
  }

  /* ---------------- Padre/Axiom average lines ---------------- */

  /**
   * Compute the market-cap level that corresponds to an average token price,
   * using the live bar close as the current mcap and the current token price.
   * This is the only way to draw an accurate mcap average line when the
   * resolver has a different mcap (e.g., Axiom Final Stretch vs Dexscreener).
   */
  function mcapLevelFromClose(avgPrice, currentPrice) {
    if (!(lastBarClose > 0) || !(Number(avgPrice) > 0) || !(Number(currentPrice) > 0)) return null;
    return lastBarClose * (Number(avgPrice) / Number(currentPrice));
  }

  /** A close within [1/4, 4]x of `current` is a plain price tick in that
   *  unit. Cap closes differ from price closes by the supply factor (1e6+),
   *  and USD from SOL by the SOL rate (~1e2), so the band cannot confuse
   *  families; it only needs to absorb feed skew between close and current. */
  function closeWithinBand(close, current) {
    const c = Number(current);
    if (!(c > 0)) return false;
    const ratio = close / c;
    return ratio > 0.25 && ratio < 4;
  }

  /**
   * F-35: the freshest ledger close that is eligible for MCAP-axis level
   * math. A close that looks like a plain price tick (either unit) is the
   * same token's price-mode series — scaling it by avg/current would land
   * the line a supply-factor off, so it is excluded outright. Among the
   * survivors, a close agreeing with the resolver's current mcap is
   * preferred; disagreement alone does not disqualify (Axiom Final Stretch
   * caps legitimately differ from the resolver's — the F-31 lesson).
   */
  function vettedMcapClose(spec) {
    const now = Date.now();
    let preferred = null;
    let survivor = null;
    let sawFresh = false;
    for (const entry of barCloseLedger.values()) {
      if (!(entry.close > 0) || now - entry.atMs > BAR_CLOSE_FRESH_MS) continue;
      // A fresh entry EXISTS; whether it survives unit vetting decides
      // whether falling back to the global close would be dishonest.
      sawFresh = true;
      if (closeWithinBand(entry.close, spec.currentPriceUsd)) continue;
      if (closeWithinBand(entry.close, spec.currentPriceNative)) continue;
      if (!survivor || entry.atMs > survivor.atMs) survivor = entry;
      if (closeWithinBand(entry.close, spec.currentMcap)
        && (!preferred || entry.atMs > preferred.atMs)) preferred = entry;
    }
    const pick = preferred || survivor;
    if (pick) return pick.close;
    // F-41: gate on FRESHNESS, not on ledger SIZE. The old `if
    // (barCloseLedger.size) return null` refused the export-poll close
    // whenever the ledger held any entry at all — including an entirely
    // STALE one. On a quiet token (no trade for 15 s) that silently
    // switched the level from the axis-exact ratio to the resolver's own
    // cap, which on a chart whose visible band is a few percent wide is
    // simply off-screen: the maintainer's "the average line still isn't
    // showing", while the already-frozen bubbles stayed put.
    // A fresh entry that FAILED unit vetting is different evidence: it says
    // the tracked series is price-mode, so the global close is not to be
    // trusted for an mcap level either.
    if (sawFresh) return null;
    if (!(lastBarClose > 0)) return null;
    if (closeWithinBand(lastBarClose, spec.currentPriceUsd)) return null;
    if (closeWithinBand(lastBarClose, spec.currentPriceNative)) return null;
    return lastBarClose;
  }

  /** mcapLevelFromClose, but the close must have passed F-35 unit vetting. */
  function vettedMcapLevel(spec, avgPrice, currentPrice) {
    const close = vettedMcapClose(spec);
    if (!(close > 0) || !(Number(avgPrice) > 0) || !(Number(currentPrice) > 0)) return null;
    return close * (Number(avgPrice) / Number(currentPrice));
  }

  /**
   * The level for one average line. When the content script knows the chart's
   * axis unit (learned from which band accepted the live chart ticks), the
   * matching candidate is used directly — no magnitude guessing. Otherwise
   * fall back to comparing candidates against the newest bar close.
   */
  function lineLevelFor(spec, side) {
    const basis = spec.axisBasis;
    const currentNative = Number(spec.currentPriceNative);
    const currentUsd = Number(spec.currentPriceUsd);

    if (basis === 'usd-abs') {
      // A perp axis is plain USD: no supply, no cap, nothing to convert. The
      // level is the level, or there is no line.
      const usd = Number(spec['avg' + side + 'Usd']);
      return usd > 0 ? usd : null;
    }

    if (basis) {
      // DEFECT C-07: fresh launches can have fills that predate the SOL/USD
      // rate, so avgBuyUsd is null while avgBuyNative sits in the same spec.
      // The old hard `|| null` returned no line on exactly those tokens.
      // When the axis is native, the native average is used directly; when
      // the axis is USD and only the native average is known, convert it via
      // the spec's current rate — and with no rate, draw no line at all
      // rather than a wrong one.
      if (basis === 'usd') {
        const usd = Number(spec['avg' + side + 'Usd']);
        if (usd > 0) return usd;
        const native = Number(spec['avg' + side + 'Native']);
        if (native > 0 && currentUsd > 0 && currentNative > 0) {
          return native * (currentUsd / currentNative);
        }
        return null;
      }
      if (basis === 'native') {
        const native = Number(spec['avg' + side + 'Native']);
        if (native > 0) return native;
        const usd = Number(spec['avg' + side + 'Usd']);
        if (usd > 0 && currentUsd > 0 && currentNative > 0) {
          return usd * (currentNative / currentUsd);
        }
        return null;
      }
      if (basis === 'mcap') {
        // F-35: the close is unit-vetted — a price-mode series of the same
        // token can never price an mcap line, even when it ticked last.
        const avg = Number(spec['avg' + side + 'Usd']);
        const computed = vettedMcapLevel(spec, avg, currentUsd);
        if (computed > 0) return computed;
        // C-07: no USD average — the native price RATIO carries the same
        // information (close x avgNative/currentNative is the same level).
        const viaNative = vettedMcapLevel(spec, Number(spec['avg' + side + 'Native']), currentNative);
        if (viaNative > 0) return viaNative;
        const explicit = Number(spec['avg' + side + 'Mcap']);
        return explicit > 0 ? explicit : null;
      }
      if (basis === 'native-mcap') {
        const avg = Number(spec['avg' + side + 'Native']);
        const computed = vettedMcapLevel(spec, avg, currentNative);
        if (computed > 0) return computed;
        const explicit = Number(spec['avg' + side + 'McapNative']);
        return explicit > 0 ? explicit : null;
      }
    }

    // Fallback: compute mcap candidates from the live bar close when possible,
    // so the bridge can still land the line on an Axiom/Padre mcap chart even
    // if the content script has not determined the axis basis yet.
    const usd = Number(spec['avg' + side + 'Usd']);
    const native = Number(spec['avg' + side + 'Native']);
    const mcap = mcapLevelFromClose(usd, currentUsd)
      || Number(spec['avg' + side + 'Mcap'])
      || null;
    const nativeMcap = mcapLevelFromClose(native, currentNative)
      || Number(spec['avg' + side + 'McapNative'])
      || null;
    return pickAxisLevel(usd, mcap, native, nativeMcap);
  }

  /**
   * F-41: is a wanted level outside what the chart can currently show?
   * Uses the same internal price scale the site's own overlay reads, so the
   * answer is the chart's, not an estimate. Returns a named reason or null;
   * a chart that cannot be measured never accuses anything.
   */
  function offVisibleRange(chart, levels) {
    if (!chart) return null;
    const internals = bubbleInternals(chart);
    if (!internals) return null;
    let height = 0;
    try { height = internals.paneDiv.getBoundingClientRect().height; } catch (_) { return null; }
    if (!(height > 0)) return null;
    for (const level of levels) {
      if (!(Number(level) > 0)) continue;
      let y = null;
      try { y = internals.priceScale.priceToCoordinate(Number(level), internals.firstValue); } catch (_) { return null; }
      if (y == null || !Number.isFinite(y)) return null;
      if (y < 0 || y > height) return 'off-range';
    }
    return null;
  }

  /** Do two specs draw the SAME averages? (F-41 freeze parity.) The current
   *  prices move constantly and are only inputs to the conversion; what a
   *  line DRAWS is the average, so only a changed average may move it. */
  function sameAverages(a, b) {
    const keys = ['avgBuyUsd', 'avgSellUsd', 'avgBuyMcap', 'avgSellMcap',
      'avgBuyNative', 'avgSellNative', 'avgBuyMcapNative', 'avgSellMcapNative'];
    return keys.every((k) => (Number(a[k]) || 0) === (Number(b[k]) || 0));
  }

  /* F-43 (fomo.family field report, 2026-08-06: "the avg fill line and where
   * the entry thought it was just keeps teleporting everywhere — completely
   * unusable").
   *
   * `mcap` (USD cap) and `native-mcap` (SOL cap) are not DECLARED by the
   * chart — they are inferred per tick from which band the value lands in,
   * and the boundary between them moves with the SOL/USD rate. A value near
   * that boundary therefore alternates between the two classifications tick
   * to tick while describing the SAME axis and the SAME entry.
   *
   * Treating that flap as a unit switch discards the frozen level, which
   * hands the line back to the ratio path (close x avg/current) — and the
   * close refreshes on every chart tick while the spec's current price only
   * re-posts every ~2 s. Recomputing across that gap makes the level ride the
   * candle: F-32's exact failure, re-entered through the basis door. Measured
   * on the reported shape, a 60% candle run moved a 240k entry to 384k.
   *
   * So a cap<->cap reclassification is NOT evidence of a unit switch and the
   * freeze survives it. Crossing into or out of an explicit price basis
   * (native / usd / usd-abs) IS a real unit change and still recomputes —
   * and those branches read the exact recorded average rather than the close,
   * so they cannot exhibit this failure at all.
   *
   * The residual risk is the reverse: a GENUINE USD-cap <-> SOL-cap toggle
   * would hold a level that is now ~1 rate off. That is the safer error of
   * the two — the sites do not expose such a toggle (the distinction is our
   * inference, not their control), a held level lands outside the visible
   * band where F-41's offVisibleRange NAMES it, and the next changed average
   * recomputes. A silent 60% teleport is a lie; a named off-range level is
   * not. */
  const CAP_BASES = new Set(['mcap', 'native-mcap']);
  function sameBasisFamily(prevBasis, nextBasis) {
    if (prevBasis === nextBasis) return true;
    return CAP_BASES.has(prevBasis) && CAP_BASES.has(nextBasis);
  }

  const averageFillSlot = makeLineSlot();
  const averageExitSlot = makeLineSlot();

  function clearPaperAverageLines() {
    clearLineSlot(averageFillSlot);
    clearLineSlot(averageExitSlot);
  }

  // The X-Ray dock lesson, applied to lines: a refusal must NAME itself.
  // "LINES ✓" with nothing on the chart (a wanted level froze null) was a
  // silent false-success; "lines connecting…" forever named nothing. The
  // most recent sync's refusal reason rides on paper-lines-status.
  let lastLineSyncReason = null;

  function syncPaperAverageLines() {
    lastLineSyncReason = null;
    const widget = findTradingViewWidget();
    const charts = getRankedCharts();
    if (!widget || !charts.length) { lastLineSyncReason = 'no-chart'; return false; }

    if (lineWidget && lineWidget !== widget) clearPaperAverageLines();
    lineWidget = widget;

    if (!paperLineSpec || !paperLineSpec.enabled) {
      clearPaperAverageLines();
      return true;
    }

    // F-32 (lev's video, post-C-01): an average line is a CONSTANT level in
    // axis units. The ratio math (close x avg/current) exists only to convert
    // the average into the chart's unit — recomputing it on every sweep from
    // a MOVING close meant any staleness anywhere (a missed spec re-post, a
    // frozen current) made the line ride the candle at ratio ~= 1. The level
    // is therefore computed ONCE per spec arrival (or on the first sweep
    // where a bar close exists) and FROZEN; sweeps re-assert the same number.
    // A fresh spec — the content script re-posts within 2 s of any move —
    // recomputes it, so accuracy is unchanged while the failure class dies.
    if (paperLineSpec.frozenBuyLevel === undefined || paperLineSpec.frozenBuyLevel === null) {
      paperLineSpec.frozenBuyLevel = lineLevelFor(paperLineSpec, 'Buy');
    }
    if (paperLineSpec.frozenSellLevel === undefined || paperLineSpec.frozenSellLevel === null) {
      paperLineSpec.frozenSellLevel = lineLevelFor(paperLineSpec, 'Sell');
    }
    const buyLevel = paperLineSpec.frozenBuyLevel;
    const sellLevel = paperLineSpec.frozenSellLevel;
    // A spec that WANTS a line whose level could not be computed is not a
    // success — report the truth and let the sweep retry when a close
    // arrives (frozen null levels recompute per sweep by design).
    const spec = paperLineSpec;
    const wantsBuy = Number(spec.avgBuyUsd) > 0 || Number(spec.avgBuyNative) > 0
      || Number(spec.avgBuyMcap) > 0 || Number(spec.avgBuyMcapNative) > 0;
    const wantsSell = Number(spec.avgSellUsd) > 0 || Number(spec.avgSellNative) > 0
      || Number(spec.avgSellMcap) > 0 || Number(spec.avgSellMcapNative) > 0;
    const missingBuy = wantsBuy && !(buyLevel > 0);
    const missingSell = wantsSell && !(sellLevel > 0);
    if (missingBuy || missingSell) {
      lastLineSyncReason = 'no-level:' + (spec.axisBasis || 'no-basis')
        + (lastBarClose > 0 ? '' : ':no-close');
    }
    // F-41: a level the chart cannot SHOW is not a success. fomo's visible
    // band was measured at a few percent wide (108.9M-119.5M in a 187px
    // pane, live 2026-08-06) — a level off by more than that is drawn
    // perfectly and seen by nobody, which is exactly how "the line isn't
    // showing" reported ok:true for a whole day. Name it instead.
    // D-63 (dashgirn + ark_trades13, 2026-08-29/30): WORSE than unseen — a
    // drawn off-range line ENTERS the host autoscale. A snipe-era fill mcap
    // (200 vs a 5-60K candle band) dragged the y-axis through zero into
    // negative padding (-4.71K / -175K ticks on the reports), squashing the
    // candles and detaching the bubbles. An off-range wanted level is now
    // NOT drawn: its slot is cleared (it stops feeding autoscale, the axis
    // springs back), the reason is named, and the next sweep retries — a
    // level legitimately re-enters range as the axis moves.
    const buyOffRange = offVisibleRange(charts[0], [buyLevel]) === 'off-range';
    const sellOffRange = offVisibleRange(charts[0], [sellLevel]) === 'off-range';
    if (buyOffRange) clearLineSlot(averageFillSlot);
    if (sellOffRange) clearLineSlot(averageExitSlot);
    if ((buyOffRange || sellOffRange) && !lastLineSyncReason) {
      lastLineSyncReason = 'off-range'
        + (buyOffRange ? ':buy' : '') + (sellOffRange ? ':sell' : '');
    }
    if (buyOffRange && sellOffRange) return false; // nothing drawable this sweep
    if (missingBuy && missingSell) return false;
    // The best-ranked chart can still refuse (Axiom's preload chart throws
    // "Value is null" until a series loads); fall through the ranking — but
    // ONLY past charts that refused everything. DEFECT C-15: requiring
    // buyOk && sellOk from one chart tore a WORKING buy line off the visible
    // chart whenever the sell line failed, then rebuilt it on the seriesless
    // preload. A partially-successful chart is kept: the failed line simply
    // retries there on the next sweep, and a working line is never moved to
    // a chart that ranked worse.
    for (const chart of charts) {
      // "PAPER" prefix is non-negotiable: Padre labels the user's REAL
      // position line "Avg. Fill Price", so an identical label on ours made
      // the two indistinguishable when both positions exist (DEFECT F-30).
      // Same doctrine as the P&L-card watermark — a paper artifact must
      // never be mistakable for a real one.
      // A perps book has an ENTRY and a LIQUIDATION, not a fill and an exit,
      // and the liquidation line is the one number that matters most on the
      // chart. The spec may therefore name its own two lines; spot supplies
      // nothing and keeps its labels and colours exactly as they were.
      const buyLabel = typeof spec.buyLabel === 'string' ? spec.buyLabel : 'PAPER Avg. Fill';
      const sellLabel = typeof spec.sellLabel === 'string' ? spec.sellLabel : 'PAPER Avg. Exit';
      const buyColor = typeof spec.buyColor === 'string' ? spec.buyColor : '#90A8FA99';
      const sellColor = typeof spec.sellColor === 'string' ? spec.sellColor : '#F7DC8599';
      // D-63: an off-range side is not passed to syncLineSlot at all — the
      // helper would happily (re)create an order line for any positive
      // number, and recreating it would re-enter autoscale one sweep after
      // the clear above.
      const buyOk = buyOffRange ? false
        : syncLineSlot(averageFillSlot, chart, buyLevel, buyLabel, buyColor, wantsBuy);
      const sellOk = sellOffRange ? false
        : syncLineSlot(averageExitSlot, chart, sellLevel, sellLabel, sellColor, wantsSell);
      if (buyOk && sellOk) {
        // Every wanted level drew, or one is still waiting on a close —
        // ok only when nothing wanted is missing.
        return !(missingBuy || missingSell);
      }
      if (buyOk || sellOk) { lastLineSyncReason = lastLineSyncReason || 'draw-refused'; return false; }
    }
    if (!lastLineSyncReason) lastLineSyncReason = 'draw-refused';
    return false;
  }

  /* ---------------- execution-shape fallback for fills ---------------- */

  const fallbackShapeHandles = new Map(); // mark id -> shape handle
  let fallbackCheckTimer = null;

  /**
   * F-31 (community screenshot, Padre mcap chart): fill shapes floated ~1.5x
   * above the candles while the avg line sat exactly right. The line gets the
   * live-close correction; shapes used the RAW fill-time resolver-implied
   * mcap — and the chart's own cap definition (bonding curve, Padre supply
   * math) differs from the resolver's by a constant factor. The universal
   * honest formula is axis-agnostic: lastBarClose × (fillPrice/currentPrice).
   * Whatever unit the close is in — USD cap, SOL cap, plain price — scaling
   * it by the price ratio lands the fill in that same unit, and supply
   * cancels out entirely. Explicit price axes still use the exact recorded
   * values (no correction needed there).
   */
  function shapeLevelFor(levels) {
    const spec = paperLineSpec || {};
    const basis = spec.axisBasis;
    // Perps: the mark's USD level IS the chart level, with no ratio scaling
    // and no dependence on a spec having arrived first.
    if (levels.perp || basis === 'usd-abs') return levels.usd > 0 ? levels.usd : null;
    if (basis === 'usd' && levels.usd > 0) return levels.usd;
    if (basis === 'native' && levels.native > 0) return levels.native;
    const currentNative = Number(spec.currentPriceNative);
    // F-35: on a declared mcap axis the ratio-scaled close must be a cap
    // close, not a price-mode series that happened to tick last. An unknown
    // basis keeps the historical global-close behavior.
    const close = (basis === 'mcap' || basis === 'native-mcap')
      ? vettedMcapClose(spec)
      : lastBarClose;
    if (close > 0 && levels.native > 0 && currentNative > 0) {
      return close * (levels.native / currentNative);
    }
    return pickAxisLevel(levels.usd, levels.mcap, levels.native, levels.nativeMcap);
  }

  function drawShapeFallback() {
    const charts = getRankedCharts();
    // F-39: on a line-tools-only build execution shapes can never spawn —
    // fills render as PaperTrench's own DOM bubbles, glued to the chart by
    // the same internal scales the site's swap markers use. POSITIVE
    // evidence only: a learned Trading-Platform throw, or line tools
    // present while the broker method is absent outright. A chart that
    // merely lacks createExecutionShape (Padre's marks-pipeline chart)
    // keeps the old skip-and-retry — its fills belong to getMarks.
    const best = charts[0] || null;
    // PERPS render as OUR OWN DOM bubbles, always. Execution shapes belong
    // to the host's chart: it can drop them on any re-render, symbol change
    // or widget remount, and nothing tells us they are gone — the handles
    // still look alive, so the redraw sweep sees a full set and does
    // nothing. That is the reported "shows up then disappears". The bubble
    // layer is PaperTrench's own fixed overlay, repositioned every frame
    // from the chart's own scales, so there is nothing for the host to
    // delete and a lost frame self-heals on the next one.
    if (best && perpsMarksPresent) {
      return syncBubbleLayer(best);
    }
    const bestIsLineTools = best && (chartIsLineTools(best)
      || (typeof best.createExecutionShape !== 'function' && typeof best.createShape === 'function'));
    if (bestIsLineTools) {
      return syncBubbleLayer(best);
    }
    if (bubbleLayer.host) clearBubbleLayer();
    let drewAll = charts.length > 0;
    for (const mark of paperMarks) {
      const levels = paperMarkLevels.get(mark.id);
      if (!levels) continue;
      const existing = fallbackShapeHandles.get(mark.id);
      // Redraw on the current best chart if the site swapped charts.
      if (existing && existing.chart && charts.length && existing.chart !== charts[0]) {
        removeShapeHandle(existing);
        fallbackShapeHandles.delete(mark.id);
      } else if (existing) {
        continue;
      }
      const level = shapeLevelFor(levels);
      if (!(level > 0)) continue;
      let handle = null;
      const capSec = freshBarTimeSec();
      for (const chart of charts) {
        if (typeof chart.createExecutionShape !== 'function') continue;
        handle = spawnExecutionShape(chart, {
          side: levels.side,
          // F-31: never draw ahead of the chart's newest bar — but only a
          // FRESH bar time may clamp; a stale one drags the fill back.
          timeSec: capSec > 0 ? Math.min(mark.time, capSec) : mark.time,
          level,
          text: levels.shapeText || (levels.side === 'sell' ? 'PT Sell' : 'PT Buy'),
        });
        if (handle) { handle.chart = chart; break; }
      }
      if (handle) fallbackShapeHandles.set(mark.id, handle);
      else drewAll = false;
    }
    // The first pass on an unprobed standalone build lands here: the spawn
    // above threw, which is the moment the capability was learned. Reroute
    // to bubbles NOW instead of waiting a sweep tick.
    if (!drewAll && best && chartIsLineTools(best)) return syncBubbleLayer(best);
    return drewAll;
  }

  function clearShapeFallback() {
    for (const handle of fallbackShapeHandles.values()) removeShapeHandle(handle);
    fallbackShapeHandles.clear();
    clearBubbleLayer();
  }

  /* ---------------- DOM bubble layer (line-tools charts) ----------------
   *
   * How fomo draws its OWN swap/thesis markers (decompiled from the token
   * chunk + verified against chart internals, live, 2026-08-05): DOM chips
   * in the top document, positioned per frame from the chart's internal
   * scales — pane geometry from activeChart()._chartWidget.paneWidgets()[0]
   * ._div, X from model().timeScale().timeToCoordinate(seconds), Y from
   * mainSeries().priceScale().priceToCoordinate(value, firstValue()).
   *
   * PaperTrench fills render through the same mechanism, deliberately
   * distinct from the site's chips (F-30: a paper artifact must never be
   * mistakable for a real one): slightly smaller (20px vs 26px), PT palette,
   * and a "(Paper)" tooltip. Each chip is CENTERED on the fill's own axis
   * level — the site floats its markers above the candle high; a trainer
   * whose whole promise is honest numbers anchors at the actual fill.
   *
   * Like the Axiom row chips above, bubbles NEVER enter the page's own DOM
   * tree: they live in a private fixed overlay on <body>.
   */
  const BUBBLE_PX = 20;
  const bubbleLayer = { host: null, nodes: new Map(), chart: null, frame: null, frameQueued: false };

  function bubbleInternals(chart) {
    try {
      const cw = chart._chartWidget
        || (typeof chart.chartWidget === 'function' ? chart.chartWidget() : null);
      if (!cw || typeof cw.paneWidgets !== 'function' || typeof cw.model !== 'function') return null;
      const pane = (cw.paneWidgets() || [])[0];
      const paneDiv = pane && pane._div;
      const model = cw.model();
      const series = model && typeof model.mainSeries === 'function' ? model.mainSeries() : null;
      const timeScale = model && typeof model.timeScale === 'function' ? model.timeScale() : null;
      const priceScale = series && typeof series.priceScale === 'function' ? series.priceScale() : null;
      const firstValue = series && typeof series.firstValue === 'function' ? series.firstValue() : null;
      if (!paneDiv || !timeScale || !priceScale || firstValue == null) return null;
      if (typeof timeScale.timeToCoordinate !== 'function'
        || typeof priceScale.priceToCoordinate !== 'function') return null;
      return { paneDiv, timeScale, priceScale, firstValue };
    } catch (_) { return null; }
  }

  function bubbleNode(mark, levels) {
    let el = bubbleLayer.nodes.get(mark.id);
    if (el) return el;
    const isBuy = levels.side !== 'sell';
    const color = isBuy ? '#34D399' : '#FF5F56';
    el = document.createElement('div');
    el.setAttribute('data-pt-bubble', isBuy ? 'buy' : 'sell');
    el.style.cssText = 'position:fixed;left:0;top:0;width:' + BUBBLE_PX + 'px;height:' + BUBBLE_PX + 'px;'
      + 'border-radius:50%;background:#060510;border:1px solid ' + color + '66;'
      + 'display:flex;align-items:center;justify-content:center;'
      + 'font:700 9px/1 Inter,system-ui,sans-serif;color:' + color + ';'
      + 'visibility:hidden;pointer-events:auto;cursor:default;'
      + 'box-shadow:0 1px 6px rgba(0,0,0,0.5);will-change:transform;';
    el.textContent = isBuy ? '▲' : '▼';
    // The mark text already reads like "Buy (Paper)\n0.5000 SOL\n…" — the
    // native tooltip carries the paper disclosure without any hover code.
    el.title = typeof mark.text === 'string' ? mark.text.replace(/\n/g, ' · ') : 'PaperTrench fill';
    bubbleLayer.nodes.set(mark.id, el);
    return el;
  }

  function hideAllBubbles() {
    for (const el of bubbleLayer.nodes.values()) el.style.visibility = 'hidden';
  }

  // Consecutive frames where the chart's internals were unreadable. Zooms
  // and scale rebuilds null out firstValue for a frame or two — hiding on
  // every such frame made the chips BLINK (maintainer field report,
  // 2026-08-05). Positions are kept through short gaps; only a persistent
  // gap (chart genuinely gone) hides them.
  let bubbleBadFrames = 0;
  const BUBBLE_BAD_FRAME_LIMIT = 30; // ~0.5 s at 60 fps

  function layoutBubbles() {
    const chart = bubbleLayer.chart;
    const host = bubbleLayer.host;
    if (!chart || !host) return false;
    const frame = bubbleLayer.frame;
    const internals = bubbleInternals(chart);
    let frameRect = null;
    let paneRect = null;
    try {
      frameRect = frame && typeof frame.getBoundingClientRect === 'function'
        ? frame.getBoundingClientRect() : { left: 0, top: 0 };
      paneRect = internals && internals.paneDiv.getBoundingClientRect();
    } catch (_) { /* geometry unavailable this frame */ }
    if (!internals || !paneRect) {
      bubbleBadFrames += 1;
      if (bubbleBadFrames >= BUBBLE_BAD_FRAME_LIMIT) hideAllBubbles();
      return false;
    }
    bubbleBadFrames = 0;

    const capSec = freshBarTimeSec();
    const stacks = new Map();
    const liveIds = new Set();
    let anyVisible = false;
    for (const mark of paperMarks) {
      liveIds.add(mark.id);
      const levels = paperMarkLevels.get(mark.id);
      if (!levels) continue;
      const el = bubbleNode(mark, levels);
      if (!el.parentNode) host.appendChild(el);
      // F-32, applied to bubbles (maintainer field report: the chip "moved
      // a little with the chart", vanished seconds after filling, and
      // blinked through zooms): a fill's level is a CONSTANT in axis units.
      // Recomputing it per frame rode the moving close against a throttled
      // current price, and evaporated entirely once every ledger entry aged
      // past BAR_CLOSE_FRESH_MS on a quiet token. The level is computed
      // ONCE, when evidence first allows, then FROZEN on the mark; frames
      // only ever re-derive its screen coordinates.
      let level = levels.frozenLevel;
      if (!(level > 0)) {
        level = shapeLevelFor(levels);
        if (level > 0) levels.frozenLevel = level;
      }
      // F-31: never place a fill ahead of the chart's newest FRESH bar.
      const t = capSec > 0 && mark.time > capSec ? capSec : mark.time;
      let x = null;
      let y = null;
      if (level > 0) {
        try { x = internals.timeScale.timeToCoordinate(t); } catch (_) { x = null; }
        try { y = internals.priceScale.priceToCoordinate(level, internals.firstValue); } catch (_) { y = null; }
      }
      const w = Number(paneRect.width) || 0;
      const h = Number(paneRect.height) || 0;
      // Off-viewport culling, same margins the site's own overlay uses.
      if (x == null || y == null || x < -50 || x > w + 50 || y < -30 || y > h + 30) {
        el.style.visibility = 'hidden';
        continue;
      }
      // Same-bar fills of the same side stack upward like the site's chips.
      const stackKey = t + ':' + levels.side;
      const lift = stacks.get(stackKey) || 0;
      stacks.set(stackKey, lift + 1);
      const px = frameRect.left + paneRect.left + x - BUBBLE_PX / 2;
      const py = frameRect.top + paneRect.top + y - BUBBLE_PX / 2 - lift * (BUBBLE_PX + 3);
      el.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
      el.style.visibility = 'visible';
      anyVisible = true;
    }
    for (const [id, el] of bubbleLayer.nodes) {
      if (!liveIds.has(id)) {
        try { el.remove(); } catch (_) {}
        bubbleLayer.nodes.delete(id);
      }
    }
    return anyVisible;
  }

  /**
   * Keep bubbles glued through scroll/zoom/resize. One frame loop, active
   * only while bubbles exist; it parks itself the moment marks are gone or
   * rendering moved elsewhere, and syncBubbleLayer revives it. Layout is a
   * handful of coordinate reads per frame — the site runs the identical
   * loop for its own markers during interactions.
   */
  function scheduleBubbleFrame() {
    if (bubbleLayer.frameQueued) return;
    const raf = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 120);
    const step = () => {
      bubbleLayer.frameQueued = false;
      if (!bubbleLayer.chart || !shapeFallbackActive || !paperMarks.length) return;
      layoutBubbles();
      bubbleLayer.frameQueued = true;
      raf(step);
    };
    bubbleLayer.frameQueued = true;
    raf(step);
  }

  function syncBubbleLayer(chart) {
    if (typeof document === 'undefined') return false;
    const body = document.body || document.documentElement;
    if (!body) return false;
    if (!bubbleLayer.host) {
      const host = document.createElement('div');
      host.setAttribute('data-pt-bubbles', '');
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;'
        + 'z-index:2147482000;pointer-events:none;';
      body.appendChild(host);
      bubbleLayer.host = host;
    }
    if (bubbleLayer.chart !== chart) {
      // Chart swap (SPA remount): nodes re-place against the new frame on
      // the next layout — the C-12 lesson, handled by construction.
      bubbleLayer.chart = chart;
      bubbleLayer.frame = chartFrameMap.get(chart) || null;
    }
    const ok = layoutBubbles();
    scheduleBubbleFrame();
    return ok;
  }

  function clearBubbleLayer() {
    for (const el of bubbleLayer.nodes.values()) {
      try { el.remove(); } catch (_) {}
    }
    bubbleLayer.nodes.clear();
    bubbleLayer.chart = null;
    bubbleLayer.frame = null;
    if (bubbleLayer.host) {
      try { bubbleLayer.host.remove(); } catch (_) {}
      bubbleLayer.host = null;
    }
  }

  /**
   * After a fill is submitted through the marks pipeline, verify the library
   * actually pulled marks. Axiom loads TradingView without marks support, so
   * refreshMarks() there is a silent no-op — the only reliable signal is
   * whether our patched getMarks ever ran. When it did not, switch this page
   * to native execution shapes permanently.
   */
  function ensureMarksRender() {
    if (shapeFallbackActive) { drawShapeFallback(); return; }
    // PERPS: draw as shapes immediately, never via the host's marks
    // pipeline. Verified live on app.hyperliquid.xyz (2026-08-06): the
    // datafeed HAS getMarks, so it gets patched and reports marksHooked,
    // but the widget never calls it — and our own refreshMarks() makes the
    // host call it just once, which sets marksPipelineSeenAt and thereby
    // suppresses the watchdog forever. The result was a mark accepted with
    // ok:true that never appeared on screen. Both perps venues were
    // confirmed to support createExecutionShape, so the evidence is
    // positive on both sides: marks do not render here, shapes do.
    if (perpsMarksPresent) {
      shapeFallbackActive = true;
      drawShapeFallback();
      return;
    }
    // D-43 (Bug 7): PADRE is the mirrored case, verified live 2026-08-21
    // (pixel-diff on trade.padre.gg): the widget DOES pull our patched
    // getMarks — repeatedly, on its own — so marksHooked stays true and the
    // watchdog below sees a "live pipeline" forever. But it never renders a
    // single one of our marks (zero marker-pixel delta over 4.5 s while the
    // candles visibly ticked). Its chart exposes createShape (the average
    // lines draw), so shapes/bubbles own fills here exactly like perps.
    if (/(^|\.)padre\.gg$/.test(location.hostname)) {
      shapeFallbackActive = true;
      drawShapeFallback();
      return;
    }
    if (fallbackCheckTimer) clearTimeout(fallbackCheckTimer);
    fallbackCheckTimer = setTimeout(() => {
      fallbackCheckTimer = null;
      if (!paperMarks.length) return;
      // D-43: synthetic pulls (our own refreshMarks) are already excluded
      // from marksPipelineSeenAt — a fresh host-initiated pull inside the
      // window still proves a live pipeline. If none came, shapes own it.
      if (marksPipelineSeenAt && Date.now() - marksPipelineSeenAt < 10_000) return;
      shapeFallbackActive = true;
      drawShapeFallback();
    }, 2000);
  }

  /* ---------------- GMGN native TradingView order lines ---------------- */

  function findGmgnChart() {
    const host = document.getElementById('global-tv-overlay');
    if (!host) return null;
    const fiberKey = Object.getOwnPropertyNames(host).find((key) => key.indexOf('__reactFiber$') === 0);
    const start = fiberKey && host[fiberKey];
    if (!start) return null;

    // GMGN's chart manager is not global. It is kept in a React ref whose
    // current value carries these stable public manager subjects/methods.
    // Traverse the mounted fiber tree defensively; no component is mutated.
    let root = start;
    while (root.return) root = root.return;
    const seen = new Set();
    const stack = [root];
    let inspected = 0;
    while (stack.length && inspected++ < 4000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
      let hook = fiber.memoizedState;
      let hooks = 0;
      while (hook && hooks++ < 100) {
        const ref = hook.memoizedState && hook.memoizedState.current;
        if (ref && ref.widgetSubject && ref.activeChartSubject && ref.chartsSubject && typeof ref.getActiveChart === 'function') {
          try {
            const chart = ref.getActiveChart();
            if (chart && typeof chart.createOrderLine === 'function') return chart;
          } catch (_) {}
        }
        hook = hook.next;
      }
    }
    return null;
  }

  const gmgnBuySlot = makeLineSlot();
  const gmgnSellSlot = makeLineSlot();

  function clearGmgnAverageLines() {
    clearLineSlot(gmgnBuySlot);
    clearLineSlot(gmgnSellSlot);
    gmgnChart = null;
    if (gmgnRetryTimer) { clearTimeout(gmgnRetryTimer); gmgnRetryTimer = null; }
  }

  /* ---------------- GMGN native fill markers ---------------- */

  let gmgnShapes = [];       // [{ handle, payload }] for drawn fills
  let gmgnMarkerQueue = [];  // fills waiting for a usable chart (or a cap)
  let gmgnMarkerTimer = null;
  // The chart instance the current shapes were drawn on. GMGN remounts its
  // chart on timeframe changes; shapes drawn on the dead instance vanish and
  // must be re-queued onto the new one (DEFECT C-12).
  let gmgnShapesChart = null;
  // A draw that actually FAILED (createExecutionShape refused) is retried a
  // bounded number of times; waiting for data (no cap yet) never burns these.
  const GMGN_MARKER_DRAW_ATTEMPTS = 30;

  /**
   * DEFECT C-08: how much GMGN's own cap axis differs from resolver-implied
   * caps. Both are supply x priceUsd with different supply definitions, so
   * the ratio is a per-token constant — the live candle close over the
   * resolver's current mcap (carried in the gmgn-lines spec, re-posted by
   * the content script as prices move). 1 until both sides exist.
   */
  function gmgnCapScale() {
    const current = gmgnLineSpec && numberValue(gmgnLineSpec.currentMcap);
    if (gmgnLastCandleClose > 0 && current > 0) return gmgnLastCandleClose / current;
    return 1;
  }

  /**
   * The Y level for one GMGN fill. Resolver-implied caps are corrected onto
   * GMGN's own axis via gmgnCapScale (C-08). A capless fill — priceUsd was
   * null at fill time, so the content script refused to fabricate an mcap
   * (C-09) — is priced from its SOL price the moment the live candle close
   * and a current SOL price coexist: close x (fillNative / currentNative)
   * is the fill expressed on GMGN's axis (C-16). Null means "not yet".
   */
  function gmgnMarkerLevel(payload) {
    const mcap = numberValue(payload && payload.mcap);
    if (mcap > 0) return mcap * gmgnCapScale();
    const native = numberValue(payload && payload.priceNative);
    const currentNative = gmgnLineSpec && numberValue(gmgnLineSpec.currentPriceNative);
    if (native > 0 && currentNative > 0 && gmgnLastCandleClose > 0) {
      return gmgnLastCandleClose * (native / currentNative);
    }
    return null;
  }

  /** C-12: pull every drawn shape back into the queue (chart remounted). */
  function requeueGmgnShapes() {
    for (const entry of gmgnShapes.splice(0)) {
      removeShapeHandle(entry.handle);
      entry.payload._ptDrawAttempts = 0;
      gmgnMarkerQueue.push(entry.payload);
    }
    gmgnShapesChart = null;
  }

  /**
   * Draw paper fills on GMGN's own chart using TradingView execution shapes.
   *
   * A native shape stays anchored to its candle through panning, zooming and
   * auto-scale, which an absolutely-positioned SVG overlay cannot do.
   *
   * Fills are queued and drained: markers restored from the journal arrive
   * before GMGN's chart manager has mounted, and dropping them on the floor
   * was exactly the "bubbles never show" failure. The drain retries until the
   * chart exists. DEFECT C-13: the old drain spliced the whole queue and then
   * DISCARDED payloads whose draw failed (a mid-boot chart ate every batch);
   * failures now go back into the queue with a bounded retry budget, and
   * fills still waiting on a cap (C-16) are kept without burning retries.
   */
  function drainGmgnMarkers() {
    const chart = findGmgnChart();
    // C-12: shapes belong to one chart instance. If GMGN swapped it
    // (timeframe change, SPA remount) the old shapes died with it — requeue
    // everything onto the live chart before draining new fills.
    if (chart && gmgnShapesChart && gmgnShapesChart !== chart && gmgnShapes.length) {
      requeueGmgnShapes();
    }
    if (!gmgnMarkerQueue.length) return true;
    if (!chart || typeof chart.createExecutionShape !== 'function') return false;
    const pending = gmgnMarkerQueue.splice(0);
    const retry = [];
    let allDrawn = true;
    for (const payload of pending) {
      const level = gmgnMarkerLevel(payload);
      if (!(level > 0)) {
        // C-16: cap not resolvable yet — keep waiting. Not a draw failure.
        retry.push(payload);
        allDrawn = false;
        continue;
      }
      const handle = spawnExecutionShape(chart, {
        side: payload.side,
        // DEFECT C-26: snap to the chart's bar grid (noted from the candle
        // URL) exactly like the Padre/Axiom mark path — a raw floor-to-second
        // put mid-bar arrows off-grid. Snapping happens at DRAW time from the
        // original fill ts, so a remount after a timeframe change (C-12)
        // re-snaps the requeued fills onto the new grid for free.
        timeSec: snapMarkTime(numberValue(payload.ts) || 0),
        level,
        text: payload.text,
      });
      if (!handle) {
        // C-13: a failed draw is re-queued (bounded), never lost.
        payload._ptDrawAttempts = (payload._ptDrawAttempts || 0) + 1;
        if (payload._ptDrawAttempts < GMGN_MARKER_DRAW_ATTEMPTS) {
          retry.push(payload);
          allDrawn = false;
        }
        continue;
      }
      gmgnShapes.push({ handle, payload });
      if (gmgnShapes.length > MAX_MARKS) removeShapeHandle(gmgnShapes.shift().handle);
    }
    gmgnShapesChart = chart;
    if (retry.length) gmgnMarkerQueue.unshift(...retry);
    return allDrawn;
  }

  function scheduleGmgnMarkerDrain() {
    if (gmgnMarkerTimer) return;
    let attempts = 0;
    const retry = () => {
      gmgnMarkerTimer = null;
      if (drainGmgnMarkers() || ++attempts >= 30) return;
      gmgnMarkerTimer = setTimeout(retry, 500);
    };
    retry();
  }

  function addGmgnFillMarker(payload) {
    const level = numberValue(payload && payload.mcap);
    const time = numberValue(payload && payload.ts);
    // C-16: a fill whose cap is unknown (null priceUsd at fill time) is still
    // queued when it carries its SOL price — gmgnMarkerLevel prices it the
    // moment the candle close and a current price coexist. Only a fill with
    // no usable level source at all is refused.
    const native = numberValue(payload && payload.priceNative);
    if (!(time > 0) || (!(level > 0) && !(native > 0))) return false;
    gmgnMarkerQueue.push(payload);
    if (gmgnMarkerQueue.length > MAX_MARKS) gmgnMarkerQueue = gmgnMarkerQueue.slice(-MAX_MARKS);
    scheduleGmgnMarkerDrain();
    return true;
  }

  function clearGmgnFillMarkers() {
    gmgnMarkerQueue = [];
    if (gmgnMarkerTimer) { clearTimeout(gmgnMarkerTimer); gmgnMarkerTimer = null; }
    for (const entry of gmgnShapes.splice(0)) removeShapeHandle(entry.handle);
    gmgnShapesChart = null;
  }

  /** C-08: line level on GMGN's own axis (see gmgnCapScale). */
  function gmgnLineLevel(side) {
    const avg = numberValue(gmgnLineSpec && gmgnLineSpec['avg' + side + 'Mcap']);
    if (avg > 0) return avg * gmgnCapScale();
    // D-64 (portifly, 2026-08-28): C-16 parity for LINES. A fresh token with
    // no mcap/priceUsd yet — supply null, so avg{Side}Mcap arrived null —
    // still has its SOL averages. The candle close x native ratio lands the
    // line on GMGN's axis exactly the way the fill markers' C-16 lane does;
    // before this, "Marks work but Avg lines never show up" was the honest
    // report of exactly that gap.
    const native = numberValue(gmgnLineSpec && gmgnLineSpec['avg' + side + 'Native']);
    const currentNative = numberValue(gmgnLineSpec && gmgnLineSpec.currentPriceNative);
    if (native > 0 && currentNative > 0 && gmgnLastCandleClose > 0) {
      return gmgnLastCandleClose * (native / currentNative);
    }
    return null;
  }

  function syncGmgnAverageLines() {
    if (!gmgnLineSpec || !gmgnLineSpec.enabled) {
      clearGmgnAverageLines();
      return true;
    }
    const chart = findGmgnChart();
    if (!chart) return false;
    if (gmgnChart && gmgnChart !== chart) { clearLineSlot(gmgnBuySlot); clearLineSlot(gmgnSellSlot); }
    gmgnChart = chart;
    const buyOk = syncLineSlot(gmgnBuySlot, chart, gmgnLineLevel('Buy'), gmgnLineSpec.avgBuyText || 'PT Avg Buy', '#34D399');
    const sellOk = syncLineSlot(gmgnSellSlot, chart, gmgnLineLevel('Sell'), gmgnLineSpec.avgSellText || 'PT Avg Sell', '#FF5F56');
    return buyOk && sellOk;
  }

  function retryGmgnAverageLines() {
    if (gmgnRetryTimer) clearTimeout(gmgnRetryTimer);
    let attempts = 0;
    const retry = () => {
      gmgnRetryTimer = null;
      if (syncGmgnAverageLines() || ++attempts >= 30) return;
      gmgnRetryTimer = setTimeout(retry, 500);
    };
    retry();
  }

  function refreshPadreMarks() {
    let refreshed = false;
    for (const chart of getRankedCharts()) {
      try {
        if (typeof chart.clearMarks === 'function') chart.clearMarks();
        if (typeof chart.refreshMarks === 'function') {
          // D-43: this call makes the host pull marks through OUR getMarks
          // once — synthetic, not evidence the pipeline renders. Armed here,
          // disarmed on the next macrotask so the discount window is tight.
          syntheticMarksPull = true;
          setTimeout(() => { syntheticMarksPull = false; }, 0);
          chart.refreshMarks();
          refreshed = true;
        }
      } catch (_) { /* a booting chart may refuse; others still refresh */ }
    }
    return refreshed;
  }

  function patchPadreWidget() {
    const widgets = findTradingViewWidgets();
    lastWidgetScanFound = widgets.length > 0;
    if (!widgets.length) return false;

    // Axiom keeps more than one live widget (a visible chart plus a preload).
    // Patch every datafeed so bars and marks flow no matter which instance the
    // site promotes to the foreground.
    let bars = false;
    let marks = false;
    let newlyPatched = false;
    for (const widget of widgets) {
      const datafeed = getPadreDatafeed(widget);
      if (!datafeed) continue;
      const barsWerePatched = Boolean(datafeed.subscribeBars && datafeed.subscribeBars[PATCHED]);
      const marksWerePatched = Boolean(datafeed.getMarks && datafeed.getMarks[PATCHED]);
      const b = patchPadreBars(datafeed);
      const m = patchPadreMarks(datafeed);
      newlyPatched = newlyPatched || (!barsWerePatched && b) || (!marksWerePatched && m);
      bars = bars || b;
      marks = marks || m;
    }

    const widget = widgets[0];
    const changedWidget = widget !== lastWidget;
    lastWidget = widget;
    padreBarsHooked = bars;
    padreMarksHooked = marks;
    const linesReady = paperLineSpec ? syncPaperAverageLines() : true;
    // Armed order lines re-assert on the same sweep: a chart that mounts
    // after the orders were posted still gets them, and a level the user
    // dragged stays where the WALLET says it is if anything repaints.
    if (paperOrderSpec && paperOrderSpec.enabled) syncPaperOrderLines();

    if (changedWidget || newlyPatched) {
      emit('padre-hook-status', {
        barsHooked: padreBarsHooked,
        marksHooked: padreMarksHooked,
        linesReady,
        markerCount: paperMarks.length,
        // C-19: a usable widget exists on this page — the content script may
        // route markers/lines natively regardless of the site's id.
        nativeCapable: true,
      });
      // A paper fill may have arrived while the widget was still loading.
      // Refresh once the native marks hook becomes available.
      if (marks && paperMarks.length) setTimeout(refreshPadreMarks, 0);
      if (paperMarks.length) ensureMarksRender();
    }
    return bars && marks;
  }

  function handleContentMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== IN_TAG) return;
    const { type, payload } = event.data;

    // ANY message from the content script proves the extension is alive
    // (O-04/C-17); a token/chart signal also revives the fast widget sweep
    // after an F-26 stand-down. A bare 'bridge-ping' refreshes liveness only.
    lastContentMessageAt = Date.now();
    if (type === 'paper-axis' || type === 'paper-lines') widgetSweepMisses = 0;

    // Feed demand. 'page-state' is the explicit signal; a token anchor or a
    // chip scan is proof of a consumer regardless of message ordering.
    if (type === 'page-state') {
      feedWanted = Boolean(payload && payload.wantsTicks);
      return;
    }
    if (type === 'paper-axis' || type === 'row-scan') feedWanted = true;

    if (type === 'chip-debug-request') {
      // Debug-report pull (Share debug logs button). The chip map lives in
      // THIS world; the content script relays the answer to the popup. Same
      // read-only mapping as window.__ptRowChipDebug — no state is touched.
      let chips = [];
      try {
        chips = [...rowChips.values()].map((e) => ({
          address: e.address,
          mode: e.place.mode,
          hasPill: Boolean(e.pill),
          display: e.el.style.display,
          hideReason: e.applied ? e.applied.hideReason || null : null,
        }));
      } catch (_) { chips = []; }
      emit('chip-debug', { chips });
      return;
    }

    if (type === 'standdown') {
      // The content script is going away (overlay disabled, or extension
      // reload teardown): erase every native drawing this bridge owns and
      // stop re-asserting it. Backdating the liveness stamp silences the
      // sweep immediately; a future content script revives it by speaking.
      paperLineSpec = null;
      paperOrderSpec = null;
      gmgnLineSpec = null;
      paperMarks = [];
      paperMarkLevels.clear();
      shapeFallbackActive = false;
      if (fallbackCheckTimer) { clearTimeout(fallbackCheckTimer); fallbackCheckTimer = null; }
      clearShapeFallback();
      clearPaperAverageLines();
      clearPaperOrderLines();
      clearGmgnAverageLines();
      clearGmgnFillMarkers();
      refreshPadreMarks();
      lastContentMessageAt = Date.now() - CONTENT_SILENCE_LIMIT_MS;
      // A standdown also ends feed demand outright: "PaperTrench off" must
      // cost the page zero parses from this instant, not from the next tick.
      feedWanted = false;
      return;
    }

    if (type === 'paper-axis') {
      // The page's resolved token identity: ticks, exports and drawing are
      // only taken from the chart whose symbol contains one of these needles.
      setCurrentSymbolNeedles(payload);
      // DEFECT C-19: answer with a capability snapshot. Widget discovery is
      // site-agnostic, so sites outside the hardcoded native set (Photon,
      // BullX, DexScreener...) route markers natively the moment a usable
      // TradingView widget exists here — the content script falls back to
      // the SVG rail only when no widget is found within its grace period.
      emit('padre-hook-status', {
        barsHooked: padreBarsHooked,
        marksHooked: padreMarksHooked,
        nativeCapable: findTradingViewWidgets().length > 0,
      });
      return;
    }

    if (type === 'row-scan') {
      scanScreenerRows(payload);
      return;
    }

    if (type === 'row-buy-done') {
      for (const entry of rowChips.values()) entry.el.classList.remove('busy');
      return;
    }

    if (type === 'gmgn-marker') {
      const ok = addGmgnFillMarker(payload);
      emit('gmgn-lines-status', { action: 'marker', ok });
      return;
    }

    if (type === 'gmgn-marker-clear') {
      clearGmgnFillMarkers();
      emit('gmgn-lines-status', { action: 'marker-clear', ok: true });
      return;
    }

    if (type === 'gmgn-lines-clear') {
      gmgnLineSpec = null;
      clearGmgnAverageLines();
      clearGmgnFillMarkers();
      emit('gmgn-lines-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'gmgn-lines') {
      gmgnLineSpec = {
        enabled: Boolean(payload && payload.enabled),
        avgBuyMcap: numberValue(payload && payload.avgBuyMcap),
        avgSellMcap: numberValue(payload && payload.avgSellMcap),
        // D-64: the SOL averages — the C-16 native-ratio lane's inputs.
        avgBuyNative: numberValue(payload && payload.avgBuyNative),
        avgSellNative: numberValue(payload && payload.avgSellNative),
        avgBuyText: typeof (payload && payload.avgBuyText) === 'string' ? payload.avgBuyText : 'PT Avg Buy',
        avgSellText: typeof (payload && payload.avgSellText) === 'string' ? payload.avgSellText : 'PT Avg Sell',
        // C-08/C-16: the resolver's CURRENT view of the token, re-posted by
        // the content script as prices move — the other half of the candle-
        // close correction, and the rate that prices capless fills.
        currentMcap: numberValue(payload && payload.currentMcap),
        currentPriceNative: numberValue(payload && payload.currentPriceNative),
        currentPriceUsd: numberValue(payload && payload.currentPriceUsd),
      };
      retryGmgnAverageLines();
      // A fresher spec may be exactly what a queued capless fill was waiting
      // for (C-16) — give the drain a chance without waiting for the sweep.
      if (gmgnMarkerQueue.length) scheduleGmgnMarkerDrain();
      return;
    }

    if (type === 'paper-lines-clear') {
      paperLineSpec = null;
      clearPaperAverageLines();
      emit('paper-lines-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'paper-orders-clear') {
      paperOrderSpec = null;
      clearPaperOrderLines();
      emit('paper-orders-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'paper-orders') {
      // The armed set is authoritative: the wallet decides what exists, the
      // chart only draws it. A repost that drops an order removes its line.
      const orders = Array.isArray(payload && payload.orders)
        ? payload.orders
          .map((o) => ({
            id: String(o && o.id || ''),
            kind: o && o.kind === 'tp' ? 'tp' : 'sl',
            triggerPrice: numberValue(o && o.triggerPrice),
            sizePct: numberValue(o && o.sizePct) || 100,
            label: typeof (o && o.label) === 'string' ? o.label : null,
          }))
          .filter((o) => o.id && o.triggerPrice > 0)
        : [];
      paperOrderSpec = {
        enabled: Boolean(payload && payload.enabled),
        axisBasis: typeof (payload && payload.axisBasis) === 'string' ? payload.axisBasis : null,
        // The live price in the SAME unit the trigger prices are quoted in.
        // Both sides of the ratio come from one source, so no basis branch
        // is needed and a perp's USD axis needs no special case.
        refPrice: numberValue(payload && payload.refPrice),
        currentPriceNative: numberValue(payload && payload.currentPriceNative),
        currentPriceUsd: numberValue(payload && payload.currentPriceUsd),
        orders,
        lineWidth: numberValue(payload.lineWidth),
      };
      const synced = syncPaperOrderLines();
      emit('paper-orders-status', {
        action: 'sync',
        ok: synced,
        drawn: [...orderSlots.keys()].filter((id) => orderSlots.get(id).adapter),
      });
      return;
    }

    if (type === 'paper-lines') {
      // A frozen bubble level is a constant IN ITS AXIS UNIT. If the chart
      // flips unit (Price <-> MCap), every frozen level is stale evidence —
      // clear them so the next frame re-freezes in the new unit.
      const prevBasis = paperLineSpec && paperLineSpec.axisBasis;
      const nextBasis = typeof (payload && payload.axisBasis) === 'string' ? payload.axisBasis : null;
      // F-43: bubbles freeze the same way lines do, so the flap teleported
      // them the same way. Only a REAL unit change invalidates their level.
      if (!sameBasisFamily(prevBasis, nextBasis)) {
        for (const levels of paperMarkLevels.values()) levels.frozenLevel = null;
      }
      const prevSpec = paperLineSpec;
      paperLineSpec = {
        enabled: Boolean(payload && payload.enabled),
        axisBasis: nextBasis,
        // F-35's discriminator needs the resolver's current cap to prefer a
        // cap-unit close; the paper spec never carried it, so the branch was
        // dead and unit vetting rested entirely on the exclusion bands.
        currentMcap: numberValue(payload && payload.currentMcap),
        currentPriceNative: numberValue(payload && payload.currentPriceNative),
        currentPriceUsd: numberValue(payload && payload.currentPriceUsd),
        avgBuyUsd: numberValue(payload && payload.avgBuyUsd),
        avgSellUsd: numberValue(payload && payload.avgSellUsd),
        avgBuyMcap: numberValue(payload && payload.avgBuyMcap),
        avgSellMcap: numberValue(payload && payload.avgSellMcap),
        avgBuyNative: numberValue(payload && payload.avgBuyNative),
        avgSellNative: numberValue(payload && payload.avgSellNative),
        avgBuyMcapNative: numberValue(payload && payload.avgBuyMcapNative),
        avgSellMcapNative: numberValue(payload && payload.avgSellMcapNative),
        // Optional per-surface labelling (perps names its own two lines).
        buyLabel: typeof (payload && payload.buyLabel) === 'string' ? payload.buyLabel : null,
        sellLabel: typeof (payload && payload.sellLabel) === 'string' ? payload.sellLabel : null,
        buyColor: typeof (payload && payload.buyColor) === 'string' ? payload.buyColor : null,
        sellColor: typeof (payload && payload.sellColor) === 'string' ? payload.sellColor : null,
      };
      // F-41: freeze PARITY with bubbles. A fill's bubble freezes its level
      // for life; the line recomputed on every 2 s repost, so the moment the
      // evidence changed underneath it (a ledger going stale, a basis not
      // yet learned) a correct line could silently move to a fallback level
      // and off the visible band. The frozen levels therefore survive a
      // repost that did not change what is being drawn — the averages
      // themselves. A DCA changes them, and recomputes, exactly as before.
      if (prevSpec && sameBasisFamily(prevSpec.axisBasis, nextBasis)
        && sameAverages(prevSpec, paperLineSpec)) {
        paperLineSpec.frozenBuyLevel = prevSpec.frozenBuyLevel;
        paperLineSpec.frozenSellLevel = prevSpec.frozenSellLevel;
      }
      patchPadreWidget();
      const synced = syncPaperAverageLines();
      emit('paper-lines-status', {
        action: 'sync',
        ok: synced,
        reason: synced ? undefined : (lastLineSyncReason || undefined),
        buyVisible: Boolean(averageFillSlot.adapter || averageFillSlot.pending),
        sellVisible: Boolean(averageExitSlot.adapter || averageExitSlot.pending),
      });
      return;
    }

    if (type === 'paper-marker-clear') {
      paperMarks = [];
      paperMarkLevels.clear();
      clearShapeFallback();
      patchPadreWidget();
      const refreshed = refreshPadreMarks();
      emit('paper-marker-status', { action: 'clear', ok: refreshed, count: 0 });
      return;
    }

    if (type === 'paper-marker') {
      const mark = normalizePaperMark(payload);
      if (!mark) {
        emit('paper-marker-status', { action: 'add', ok: false, reason: 'invalid-marker' });
        return;
      }
      // F-41: one fill, one mark. A re-post of a fill already on the chart
      // (journal replay after a render handoff, a storage echo) refreshes
      // nothing and must never mint a second bubble.
      if (paperMarkLevels.has(mark.id)) {
        emit('paper-marker-status', {
          action: 'add', ok: true, id: mark.id, count: paperMarks.length,
          duplicate: true, bubblesDrawn: bubbleLayer.nodes.size,
        });
        return;
      }
      paperMarks.push(mark);
      const markNative = numberValue(payload.priceNative);
      const markUsd = numberValue(payload.priceUsd);
      const markMcap = numberValue(payload.mcap);
      const isPerp = payload.quote === 'usd-abs';
      if (isPerp) perpsMarksPresent = true;
      paperMarkLevels.set(mark.id, {
        // A perps SHORT is an entry, not a sale: it must colour and point
        // like the position it opened, so the side maps by direction.
        side: isPerp
          ? (payload.side === 'short' || payload.kind === 'liquidation' ? 'sell' : 'buy')
          : (payload.side === 'sell' ? 'sell' : 'buy'),
        native: markNative,
        usd: markUsd,
        mcap: markMcap,
        nativeMcap: markMcap && markUsd && markNative ? markMcap * (markNative / markUsd) : null,
        // Shapes carry the perps vocabulary rather than Buy/Sell.
        shapeText: isPerp ? perpShapeText(payload) : null,
        // A perps level is absolute USD and needs no axis spec to interpret.
        // Without this the mark could only be placed AFTER a paper-lines
        // message had established the basis, so the first fill on a fresh
        // page silently failed to draw (and a lines-clear un-drew it again).
        perp: isPerp,
      });
      if (paperMarks.length > MAX_MARKS) {
        for (const dropped of paperMarks.slice(0, paperMarks.length - MAX_MARKS)) {
          paperMarkLevels.delete(dropped.id);
          const handle = fallbackShapeHandles.get(dropped.id);
          if (handle) { removeShapeHandle(handle); fallbackShapeHandles.delete(dropped.id); }
        }
        paperMarks = paperMarks.slice(-MAX_MARKS);
      }
      patchPadreWidget();
      const refreshed = refreshPadreMarks();
      ensureMarksRender();
      emit('paper-marker-status', {
        action: 'add',
        // Shapes owning rendering IS ok — on a no-getMarks datafeed (fomo)
        // they are the only fill path there will ever be.
        ok: (padreMarksHooked && refreshed) || shapeFallbackActive,
        id: mark.id,
        count: paperMarks.length,
        marksHooked: padreMarksHooked,
        shapeFallback: shapeFallbackActive,
        shapesDrawn: fallbackShapeHandles.size,
        // F-39: fills that render as DOM bubbles (line-tools charts).
        bubblesDrawn: bubbleLayer.nodes.size,
      });
    }
  }

  window.addEventListener('message', handleContentMessage);

  /* ---------------- screener row chips (Axiom Pulse) ----------------
   *
   * Rows without an address link identify their token only through the row
   * component's React props — and fibers are visible exclusively in the MAIN
   * world, so this lives here. Chips forward their tap back to the content
   * script, which owns the fill pipeline.
   *
   * CRITICAL: chips NEVER enter the page's own DOM tree. Inserting foreign
   * nodes into React-managed containers corrupts reconciliation — on Axiom
   * Pulse (rows re-render every second) that crashed the whole list into an
   * error-boundary skeleton state. Instead every chip lives in a private
   * fixed overlay layer on <body> and is positioned over its row from the
   * row's bounding rect.
   */

  const ROW_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

  let rowChipLayer = null;
  const rowChips = new Map(); // row element -> { el, address, place }

  function ensureRowChipLayer() {
    if (rowChipLayer && rowChipLayer.isConnected) return rowChipLayer;
    rowChipLayer = document.getElementById('pt-rowbuy-layer');
    if (!rowChipLayer) {
      rowChipLayer = document.createElement('div');
      rowChipLayer.id = 'pt-rowbuy-layer';
      (document.body || document.documentElement).appendChild(rowChipLayer);
    }
    return rowChipLayer;
  }

  /* Chip taps are handled at the WINDOW capture phase: these sites install
   * their own capturing click handlers that stop propagation (Padre does),
   * so a listener on the chip itself never fires. The bridge runs at
   * document_start — its window listener registers before any page script,
   * so it always sees the event first. Press events are swallowed too so
   * the row underneath never navigates from a chip tap.
   */
  function handleRowChipTap(ev) {
    const target = ev.target;
    const chip = target && target.closest ? target.closest('.pt-rowbuy') : null;
    if (!chip) return;
    // pointerdown must keep propagating to OTHER window-capture listeners:
    // the content script's gesture stamp (isTrusted pointerdown) lives there,
    // and stopImmediatePropagation starved it — so a chip tap after >5 s of
    // idling was refused by the fill pipeline's own forgery gate and the chip
    // stuck in busy forever (DEFECT F-08). stopPropagation still keeps the
    // row underneath from navigating; the later press events stay swallowed
    // entirely.
    if (ev.type === 'pointerdown') {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    if (ev.type !== 'click') return;
    for (const entry of rowChips.values()) {
      if (entry.el === chip) {
        chip.classList.add('busy');
        emit('row-buy', {
          address: entry.address,
          quote: rowQuoteFromFiber(entry.row, entry.address),
        });
        break;
      }
    }
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, handleRowChipTap, true);
  }

  /* Chip layout runs in two strict phases (Turbo): ALL reads, then ALL
   * writes. The old per-chip read→write interleave dirtied layout with every
   * chip's style writes, forcing a synchronous reflow for the NEXT chip's
   * getBoundingClientRect/elementFromPoint — O(N chips) reflows per sweep,
   * on the same thread the feed parses on (the F-18 starvation class).
   * Measured against clean layout the whole sweep costs one reflow, and the
   * writes are diffed against the last applied values, so a steady-state
   * sweep (rows unmoved) writes nothing and leaves layout clean for the
   * page's own frame.
   */
  const PILL_RETRY_MS = 1000;

  /**
   * F-53 helper: does the chip's anchored BODY land on the row's own
   * content? The anchor point alone is not enough — the chip extends LEFT
   * of its anchor by its own width, so the probe reads elementFromPoint at
   * the body's midpoint (anchor.x minus half the measured chip width).
   * READ-phase only: no style writes. Returns true when the hit is an
   * element INSIDE the row that is neither the row container nor the chip
   * itself — i.e. real content (text, stat, avatar) the chip would cover.
   * A hit outside the row entirely (page background, whitespace) is fine:
   * the anchor is in the gutter already.
   *
   * F-60: the chip is CLICKABLE (pointer-events:auto on .pt-rowbuy), so
   * once it is painted at the anchor its own body tops the hit-test and
   * elementFromPoint returns the chip — reading "clean" forever while it
   * covers the MC a live format switch (or a late mount, or a row
   * recycle) just moved under it. The probe therefore reads the STACK
   * (elementsFromPoint) and skips chip-owned entries: the first element
   * in the stack that is neither the chip, inside the chip, nor this
   * layer's other chips, is the ground truth the chip is covering.
   * Engines without elementsFromPoint keep the legacy top-hit read.
   */
  function rowAnchorHitsContent(anchor, rect, row, entry, pillRect) {
    const chipWidth = (entry && entry.el && entry.el.getBoundingClientRect)
      ? entry.el.getBoundingClientRect().width
      : 0;
    const bodyX = Math.max(1, Math.round(anchor.x - (chipWidth > 0 ? chipWidth / 2 : 14)));
    const bodyY = Math.min(Math.max(Math.round(anchor.y), 1), (window.innerHeight || 1) - 1);
    let hits = null;
    try {
      if (typeof document.elementsFromPoint === 'function') {
        hits = document.elementsFromPoint(bodyX, bodyY);
      } else {
        const one = document.elementFromPoint(bodyX, bodyY);
        hits = one ? [one] : [];
      }
    } catch (_) { return false; }
    if (!hits || !hits.length) return false;
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      if (!hit) continue;
      // Skip everything the chip itself owns: its own body and anything
      // inside it. The stack is painted front-to-back, so these lead.
      if (hit === entry.el) continue;
      try { if (entry.el && entry.el.contains(hit)) continue; } catch (_) {}
      // Skip other chips from this same layer: a neighbouring row's chip
      // can legitimately sit beneath this one on overlap-heavy layouts.
      if (hit.dataset && hit.dataset.ptRowChip === '1') continue;
      if (hit === row) return false;
      // Content INSIDE the row (or the pill the anchor belongs to): covered.
      try {
        if (row.contains(hit)) return true;
      } catch (_) {}
      if (pillRect && hit.getBoundingClientRect) {
        const hr = hit.getBoundingClientRect();
        if (hr.width > 0 && hr.right > pillRect.left && hr.left < pillRect.right
            && hr.bottom > pillRect.top && hr.top < pillRect.bottom) return true;
      }
      return false;
    }
    return false;
  }

  function positionRowChip(entry) {
    // READ phase: measures and decides; touches no styles. Returns the write
    // plan for applyRowChip, or null when the row is gone.
    const { row, el, place } = entry;
    if (!row.isConnected) return null;
    const rect = row.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10 ||
        rect.bottom < 0 || rect.top > window.innerHeight ||
        rect.right < 0 || rect.left > window.innerWidth) {
      return { display: 'none', hideReason: 'row-offscreen' };
    }
    // Occlusion: rows scroll inside their own panes — when a row slides
    // under a sticky header the fixed-layer chip must vanish with it.
    const probeY = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    const probeX = Math.min(Math.max(rect.left + rect.width * 0.35, 1), window.innerWidth - 1);
    const hit = document.elementFromPoint(probeX, probeY);
    if (hit && hit !== el && !row.contains(hit) && !el.contains(hit)) {
      return {
        display: 'none',
        hideReason: 'row-occluded:' + (hit.tagName || '?')
          + (hit.id ? '#' + hit.id : '')
          + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(/\s+/).slice(0, 2).join('.') : ''),
      };
    }

    let anchor = null; // { x, y, align }
    if (place.mode === 'before-buy-button') {
      let pill = entry.pill;
      if (pill && pill.isConnected) {
        // A cached pill must still sit in this row's column — rows get
        // recycled and a stale pill would drag the chip onto another card.
        const r = pill.getBoundingClientRect();
        if (!(r.width > 0 && r.right > rect.left && r.left < rect.right &&
              r.bottom > rect.top - 8 && r.top < rect.bottom + 44)) pill = null;
      } else {
        pill = null;
      }
      if (!pill) entry.pill = null;
      if (!pill && Date.now() - (entry.pillMissAt || 0) >= PILL_RETRY_MS) {
        // The pill can live just OUTSIDE the detected row container (Padre
        // renders it in a sibling strip below the card body), so widen the
        // search up two ancestors but only accept buttons overlapping the
        // row's own column — never a neighbour card's pill. The walk reads a
        // rect per button, so a row that simply HAS no pill must not pay it
        // on every sweep: misses retry at 1 Hz. A fresh chip searches at
        // once (pillMissAt starts unset), so first placement is never late.
        const matches = (scope) => [...scope.querySelectorAll('button')].filter((b) => {
          if (!place.pattern.test((b.textContent || '').trim())) return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 &&
            r.right > rect.left && r.left < rect.right &&
            r.bottom > rect.top - 8 && r.top < rect.bottom + 44;
        });
        pill = matches(row)[0] || null;
        for (let up = row.parentElement, i = 0; !pill && up && i < 2; up = up.parentElement, i += 1) {
          pill = matches(up)[0] || null;
        }
        entry.pill = pill;
        entry.pillMissAt = pill ? 0 : Date.now();
      }
      if (pill) {
        const pr = pill.getBoundingClientRect();
        anchor = { x: pr.left - 6, y: pr.top + pr.height / 2, align: 'right-center' };
        // F-53 (jb, Padre "ultra" format): the chip sits immediately LEFT of
        // the site's own pill — but the ultra row compresses the layout so
        // the chip's body (which extends further left from the anchor)
        // lands on the row's market-cap text. The pill position itself is
        // the site's truth, so the probe shifts onto the CHIP's body
        // midpoint, and a hit on row content drops the chip to the
        // bottom-right gutter (below the MC, clear of the pill).
        if (entry.placementPref === 'bottom'
            || rowAnchorHitsContent(anchor, rect, row, entry, pr)) {
          anchor = { x: rect.right - 6, y: rect.bottom - 6, align: 'right-bottom' };
        }
      } else {
        anchor = { x: rect.right - 6, y: rect.bottom - 6, align: 'right-bottom' };
      }
    } else if (place.mode === 'badge') {
      // Straddling the card's top-right edge: half in the row gutter, half
      // over the card's own top padding — clear of the MC/stat text.
      anchor = { x: rect.right - 8, y: rect.top, align: 'right-center' };
    } else {
      anchor = { x: rect.right - 6, y: rect.top + 6, align: 'right-top' };
      // F-53 (jb, Axiom "ultra" format): compact rows put the market cap
      // exactly at that top-right corner, and the chip painted over it. The
      // float anchor is a GUESS about the row's layout; when the guess is
      // wrong the honest move is the row's bottom-right gutter — the same
      // anchor the pill-miss fallback already uses, clear of both the MC
      // and the site's own buttons. Probing the anchor point is one
      // elementFromPoint the sweep already pays for the overlay check; a
      // hit that is neither the row container itself nor outside the row
      // means the anchor lands ON content: drop to the gutter. 'bottom'
      // (explicit user preference) skips the probe and pins the gutter.
      if (entry.placementPref === 'bottom') {
        anchor = { x: rect.right - 6, y: rect.bottom - 6, align: 'right-bottom' };
      } else if (rowAnchorHitsContent(anchor, rect, row, entry)) {
        anchor = { x: rect.right - 6, y: rect.bottom - 6, align: 'right-bottom' };
      }
    }

    // DEFECT O-22: the chip layer sits BELOW the PaperTrench panel/bar by
    // design (a chip must never cover the trade panel), so a chip whose spot
    // the overlay covers would render invisible yet swallow no clicks — a
    // dead control. Probe the chip's own anchor point: everything the
    // overlay draws (panel, positions bar, pill, toasts) lives in the
    // #papertrench-host shadow tree, and elementFromPoint retargets shadow
    // content to its host, so one id check covers all of it. Occluded chips
    // stand down; they return the moment the panel is dragged away.
    const chipProbeX = Math.min(Math.max(anchor.x - 10, 1), (window.innerWidth || 1) - 1);
    const chipProbeY = Math.min(Math.max(
      anchor.y + (anchor.align === 'right-top' ? 8 : anchor.align === 'right-bottom' ? -8 : 0),
      1), (window.innerHeight || 1) - 1);
    const over = document.elementFromPoint(chipProbeX, chipProbeY);
    if (over && over !== el && !el.contains(over) && over.id === 'papertrench-host') {
      return { display: 'none', hideReason: 'under-pt-panel' };
    }

    const size = Number(entry.size) > 0 ? entry.size : 1;
    return {
      display: '',
      left: anchor.x + 'px',
      top: anchor.y + 'px',
      origin: anchor.align === 'right-center' ? '100% 50%'
        : anchor.align === 'right-bottom' ? '100% 100%'
        : '100% 0%',
      transform: (anchor.align === 'right-center' ? 'translate(-100%, -50%)'
        : anchor.align === 'right-bottom' ? 'translate(-100%, -100%)'
        : 'translate(-100%, 0)') + ' scale(' + size + ')',
    };
  }

  function applyRowChip(entry, plan) {
    // WRITE phase: every write is diffed — an unmoved chip costs nothing.
    const el = entry.el;
    const last = entry.applied || (entry.applied = {});
    if (plan.display === 'none') {
      if (last.display !== 'none') { el.style.display = 'none'; last.display = 'none'; }
      // Diagnostics only: WHY the chip is hidden, surfaced via
      // __ptRowChipDebug so a harness (or a screen-share debug session) can
      // tell an occluded chip from a dead one. Zero style writes.
      last.hideReason = plan.hideReason || 'unknown';
      return;
    }
    if (last.display !== '') { el.style.display = ''; last.display = ''; }
    last.hideReason = null;
    if (last.left !== plan.left) { el.style.left = plan.left; last.left = plan.left; }
    if (last.top !== plan.top) { el.style.top = plan.top; last.top = plan.top; }
    if (last.origin !== plan.origin) { el.style.transformOrigin = plan.origin; last.origin = plan.origin; }
    if (last.transform !== plan.transform) { el.style.transform = plan.transform; last.transform = plan.transform; }
  }

  function sweepRowChips() {
    // Phase R: measure every chip against clean layout…
    const plans = [];
    const dead = [];
    for (const [row, entry] of rowChips) {
      const plan = positionRowChip(entry);
      if (!plan) {
        dead.push(entry);
        rowChips.delete(row);
        continue;
      }
      plans.push([entry, plan]);
    }
    // …Phase W: then write, removals included.
    for (const entry of dead) entry.el.remove();
    for (const [entry, plan] of plans) applyRowChip(entry, plan);
  }

  let rowChipRaf = 0;
  function scheduleRowChipReposition() {
    if (rowChipRaf || !rowChips.size) return;
    rowChipRaf = requestAnimationFrame(() => {
      rowChipRaf = 0;
      sweepRowChips();
    });
  }
  window.addEventListener('scroll', scheduleRowChipReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleRowChipReposition, { passive: true });
  // Screener lists churn hard (New Pairs shifts every row down each time a
  // token lands) — chips must chase their rows the moment the DOM moves,
  // not on the next 350ms scan, or they visibly trail onto the wrong row.
  let rowChipObserver = null;
  function ensureRowChipObserver() {
    if (rowChipObserver || !document.body) return;
    rowChipObserver = new MutationObserver(scheduleRowChipReposition);
    // childList only: rows shifting is a node change. characterData fired a
    // reposition (with its forced-layout chip walk) on EVERY price-digit
    // update across the whole list — main-thread starvation exactly when
    // volume peaked, on the same thread the feed parses on (DEFECT F-18).
    // Pure text updates cannot move a row; scroll/resize listeners and the
    // 1 s sweep cover residual drift.
    rowChipObserver.observe(document.body, { childList: true, subtree: true });
  }
  // SPA navigation away from the list unmounts the rows without another
  // row-scan ever firing — this sweep is what clears the orphaned chips.
  setInterval(() => { if (rowChips.size) sweepRowChips(); }, 1000);
  // Read-only diagnostics for E2E tooling (no page code can reach the map).
  try {
    Object.defineProperty(window, '__ptRowChipDebug', {
      value: () => [...rowChips.values()].map((e) => ({
        address: e.address,
        mode: e.place.mode,
        hasPill: Boolean(e.pill),
        display: e.el.style.display,
        hideReason: e.applied ? e.applied.hideReason || null : null,
        align: e.applied ? e.applied.transform : null,
        // The chip's OWN rect (not the row's) so E2E tooling can click the
        // exact chip pinned to an address — rect math against a moving
        // virtualized list kept matching the wrong neighbor (D-40 harness).
        rect: e.el.isConnected ? (({ x, y, width, height }) => ({
          x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.el.getBoundingClientRect()) : null,
        rowRect: e.row.isConnected ? (({ x, y, width, height }) => ({
          x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.row.getBoundingClientRect()) : null,
      })),
      configurable: true,
    });
  } catch (_) { /* diagnostics only */ }

  function addressFromRowFiber(row) {
    try {
      const key = Object.getOwnPropertyNames(row).find((k) => k.indexOf('__reactFiber$') === 0);
      const start = key && row[key];
      if (!start) return null;
      const seen = new Set();
      const stack = [start];
      let steps = 0;
      let best = null;
      const consider = (value, keyName) => {
        // The WHOLE value must be one base58 address: substring matches let
        // EVM rows (0x…) and IPFS image CIDs sneak in as fake Solana mints.
        if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return;
        if (!/address|pair|token|mint|\bca\b/i.test(keyName)) return;
        if (/image|img|logo|icon|uri|url|banner/i.test(keyName)) return;
        const score = /pair/i.test(keyName) ? 3 : /token|mint/i.test(keyName) ? 2 : 1;
        if (!best || score > best.score) best = { address: value, score };
      };
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 3) return;
        for (const [k, v] of Object.entries(obj)) {
          consider(v, k);
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      while (stack.length && steps++ < 80) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        walk(fiber.memoizedProps, 0);
        walk(fiber.memoizedState, 0);
        if (best && best.score >= 3) break;
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      return best ? best.address : null;
    } catch (_) {
      return null;
    }
  }

  function rowQuoteFromFiber(row, tappedAddress) {
    try {
      if (!row || !BASE58_RE.test(tappedAddress || '')) return null;
      const key = Object.getOwnPropertyNames(row).find((k) => k.indexOf('__reactFiber$') === 0);
      const start = key && row[key];
      if (!start) return null;
      const seen = new Set();
      const stack = [start];
      const candidates = [];
      const identityKeys = new Set(['tokenAddress', 'mint', 'pairAddress']);
      const priceKeys = new Set([
        'priceSol', 'priceNative', 'tokenPriceUsd', 'priceUsd',
        'marketCapSol', 'marketCapUsd',
      ]);
      const badKey = /change|pct|percent|min|hr|24h|ratio/i;
      const fieldsFor = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        const fields = {};
        for (const [name, value] of Object.entries(obj)) {
          if (badKey.test(name)) continue;
          if (identityKeys.has(name)) {
            if (typeof value === 'string' && BASE58_RE.test(value)) fields[name] = value;
            continue;
          }
          if (name === 'supply' || priceKeys.has(name)) {
            const number = numberValue(value);
            if (number !== null && number > 0) fields[name] = number;
          }
        }
        return fields;
      };
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 3) return;
        const own = fieldsFor(obj) || {};
        const hasIdentity = own.tokenAddress || own.mint || own.pairAddress;
        const hasPrice = [...priceKeys].some((name) => own[name] !== undefined);
        if (hasIdentity && hasPrice) candidates.push(own);
        const hasUsdPrice = own.tokenPriceUsd !== undefined
          || own.priceUsd !== undefined
          || own.marketCapUsd !== undefined;
        if (!hasIdentity && hasUsdPrice) {
          for (const value of Object.values(obj)) {
            const nested = fieldsFor(value);
            if (nested && nested.tokenAddress) {
              candidates.push({ tokenAddress: nested.tokenAddress, ...own });
              break;
            }
          }
        }
        for (const value of Object.values(obj)) {
          if (value && typeof value === 'object') walk(value, depth + 1);
        }
      };
      let steps = 0;
      while (stack.length && steps++ < 80) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        walk(fiber.memoizedProps, 0);
        walk(fiber.memoizedState, 0);
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      const matching = candidates.filter((fields) =>
        fields.tokenAddress === tappedAddress
        || fields.mint === tappedAddress
        || fields.pairAddress === tappedAddress);
      if (!matching.length) return null;
      const selected = matching.reduce((best, fields) =>
        !best || Object.keys(fields).length > Object.keys(best).length ? fields : best, null);
      const usd = candidates.find((fields) =>
        fields.tokenAddress
        && fields.tokenAddress === selected.tokenAddress
        && (fields.tokenPriceUsd !== undefined
          || fields.priceUsd !== undefined
          || fields.marketCapUsd !== undefined));
      const merged = { ...selected };
      if (usd) {
        for (const name of ['tokenPriceUsd', 'priceUsd', 'marketCapUsd']) {
          if (merged[name] === undefined && usd[name] !== undefined) merged[name] = usd[name];
        }
      }
      return {
        mint: merged.tokenAddress || merged.mint || null,
        pair: merged.pairAddress || null,
        priceSol: merged.priceSol || merged.priceNative || null,
        priceUsd: merged.tokenPriceUsd || merged.priceUsd || null,
        mcapUsd: merged.marketCapUsd || null,
        supply: merged.supply || null,
      };
    } catch (_) {
      return null;
    }
  }

  function findRowContainer(anchor) {
    // Height band: Padre's reworked Trenches board renders its live column
    // in a COMPACT format — measured 2026-08-26: the row is 34px tall,
    // 346px wide (`_row_14q3h_6`), and the next ancestor is the whole
    // 1360px list. With the old 55px floor NO ancestor ever qualified, so a
    // fresh launch's row never got a quick-buy chip at all — the board
    // surface of "it wont let u buy half the time" (vro, 8/26). 28px keeps
    // ticker pills and chrome out (they fail the 300px width gate anyway).
    let node = anchor;
    for (let i = 0; i < 9 && node && node.parentElement; i++) {
      node = node.parentElement;
      const rect = node.getBoundingClientRect();
      if (rect.height >= 28 && rect.height <= 190 && rect.width >= 380) return node;
      if (rect.height >= 28 && rect.height <= 190 && rect.width >= 300) return node;
    }
    return null;
  }

  /* Bug 5 (live report 2026-08-22): one chip per CARD, even when several
   * anchors on the card climb to several NESTED rows. Measured on padre's
   * reworked Trenches DOM: the trade-link anchor finds the inner body
   * (384x59) while the pump.fun icon anchor finds the card (472x98) —
   * both fit findRowContainer's size heuristic, and the old anchor loop
   * keyed BOTH, so every card wore two quick-buy chips. The rule: among
   * nested rows the OUTERMOST wins; an inner row is dropped from the map.
   * Sibling cards never nest, so distinct cards keep distinct chips.
   * Pure function over [row, address] pairs — unit-tested in
   * extension/test/rowchipdedupe.test.js. */
  function dedupeNestedRows(pairs) {
    const rows = new Map();
    for (const [row, address] of pairs) {
      let skip = false;
      for (const [other] of rows) {
        if (other === row || (other.contains && other.contains(row))) { skip = true; break; }
        if (row.contains && row.contains(other)) rows.delete(other); // outer wins
      }
      if (!skip) rows.set(row, address);
    }
    return rows;
  }

  function scanScreenerRows(spec) {
    const amount = numberValue(spec && spec.amount) || 0.1;
    const size = Math.max(0.6, Math.min(1.5, numberValue(spec && spec.size) || 1));
    // jb (#bug-reports): on Axiom's "ultra" compact terminal format the
    // float anchor (top-right of the row) sits exactly on the row's market
    // cap. 'auto' probes the anchor and drops to the bottom-right gutter
    // only when it lands on row content; 'bottom' pins the gutter anchor
    // unconditionally; anything else keeps the per-site default untouched.
    const placementPref = spec && (spec.placementPref === 'bottom' || spec.placementPref === 'auto')
      ? spec.placementPref
      : null;
    const selectors = spec && Array.isArray(spec.linkSelectors) ? spec.linkSelectors : [];
    const groupRows = spec && spec.containerMode === 'group';
    const beforeButton = spec && spec.placement === 'before-buy-button';
    const rows = new Map(); // row/card element -> address

    const anchorPairs = [];
    for (const selector of selectors) {
      let anchors;
      try { anchors = document.querySelectorAll(selector); } catch (_) { continue; }
      for (const anchor of anchors) {
        const match = String(anchor.getAttribute('href') || '').match(ROW_ADDR_RE);
        if (!match) continue;
        // Axiom Pulse rows carry the stable `group` class — matching it
        // exactly keeps chips out of page chrome.
        const row = groupRows ? anchor.closest('div.group') : findRowContainer(anchor);
        if (row) anchorPairs.push([row, match[0]]);
      }
    }
    // Bug 5: several anchors on one card can climb to NESTED rows (card +
    // inner body); the outermost row wins — one chip per card.
    for (const [row, address] of dedupeNestedRows(anchorPairs)) rows.set(row, address);
    // A chip left by an earlier sweep on a NESTED row of a card we just
    // claimed is a leftover of the duplicate bug — counted below when the
    // map is final, not inside the loop that mutates it.

    // Rows/cards with no address link at all: the identity lives in React
    // props. Enumerate siblings of known rows (same list container), plus
    // Axiom's div.group rows directly.
    const candidates = new Set();
    if (groupRows) {
      let groups;
      try { groups = document.querySelectorAll('div.group'); } catch (_) { groups = []; }
      for (const g of groups) {
        const rect = g.getBoundingClientRect();
        if (rect.height >= 40 && rect.height <= 160 && rect.width >= 380) candidates.add(g);
      }
    } else {
      // Cousin cards too: on Padre an anchor-found row is a card's BODY,
      // buried inner-twin > wrapper > wrapper > list — climb until the
      // ancestors include the container whose children are sibling cards.
      const parents = new Set();
      for (const row of [...rows.keys(), ...rowChips.keys()]) {
        let p = row.parentElement;
        for (let i = 0; p && i < 5; i += 1, p = p.parentElement) parents.add(p);
      }
      for (const parent of parents) {
        for (const card of parent.children) {
          const rect = card.getBoundingClientRect();
          // Same 28px floor as findRowContainer — the sibling walk must
          // accept the same compact rows the anchor walk does, or cards in
          // the compact column would chip only when they carry a link.
          if (rect.height >= 28 && rect.height <= 190 && rect.width >= 300) candidates.add(card);
        }
      }
    }
    const staleAt = Date.now() - 3000;
    const isNested = (a, b) => a === b || (a.contains && a.contains(b)) || (b.contains && b.contains(a));
    for (const row of candidates) {
      if (rows.has(row)) continue;
      const chipped = rowChips.get(row);
      if (chipped && chipped.verifiedAt > staleAt) continue;
      if (!chipped) {
        // A card and its inner body both look like rows — one chip only.
        // (The anchor loop already dedupes nested rows via dedupeNestedRows;
        // this walk covers rows ONLY the fiber scan can find.)
        let nested = false;
        for (const other of rows.keys()) if (isNested(other, row)) { nested = true; break; }
        if (!nested) {
          for (const other of rowChips.keys()) {
            if (other.isConnected && isNested(other, row)) { nested = true; break; }
          }
        }
        if (nested) continue;
      }
      // Fresh row, or a recycled element that may now show a different
      // token: (re-)read the address from the row's React props.
      const address = addressFromRowFiber(row);
      if (address) rows.set(row, address);
      else if (chipped) { chipped.el.remove(); rowChips.delete(row); }
    }

    let pattern;
    try { pattern = new RegExp((spec && spec.buyButtonPattern) || '^Buy\\s', 'i'); } catch (_) { pattern = /^Buy\s/i; }
    const layer = ensureRowChipLayer();
    ensureRowChipObserver();

    // Retire chips whose row nests under a row this scan just claimed (an
    // update from a build without the anchor-loop dedupe leaves one chip on
    // the card and one on its inner body). The inner one goes.
    for (const chippedRow of [...rowChips.keys()]) {
      if (rows.has(chippedRow)) continue;
      let nested = false;
      for (const claimed of rows.keys()) {
        if (claimed !== chippedRow && claimed.contains(chippedRow)) { nested = true; break; }
      }
      if (nested) {
        const entry = rowChips.get(chippedRow);
        rowChips.delete(chippedRow);
        if (entry && entry.el) entry.el.remove();
      }
    }

    const now = Date.now();
    for (const [row, address] of rows) {
      const existing = rowChips.get(row);
      if (existing) {
        existing.address = address;
        existing.verifiedAt = now;
        existing.size = size;
        existing.placementPref = placementPref;
        continue;
      }

      const button = document.createElement('button');
      button.className = 'pt-rowbuy';
      // F-60: mark the chip so collision probes can recognise (and look
      // through) their own paint in the elementsFromPoint stack.
      try { button.dataset.ptRowChip = '1'; } catch (_) {}
      button.type = 'button';
      button.textContent = `P ${amount}`;
      button.title = `PaperTrench: paper-buy ${amount} SOL of this token right now`;
      const entry = {
        row,
        el: button,
        address,
        pill: null,
        verifiedAt: now,
        size,
        placementPref,
        place: { mode: beforeButton ? 'before-buy-button' : (spec && spec.placement) || 'float', pattern },
      };
      // Taps are handled by the window-level capture listener above — a
      // listener on the chip itself never fires on sites that stop
      // propagation during capture.
      layer.appendChild(button);
      rowChips.set(row, entry);
      // Placement happens in the sweep below — one batched read/write pass
      // for every chip, the fresh one included.
    }

    sweepRowChips();
  }

  /* ---------------- chart-export price peg ----------------
   *
   * The subscribeBars hook only sees bars for subscriptions created AFTER the
   * patch. On Axiom the widget is unreachable until React mounts, by which
   * time the chart has already subscribed — so no live bars ever flow and the
   * displayed price (and unrealized P&L) drifted to slower fallback sources.
   *
   * The fix reads the newest close directly off the site's own chart via the
   * public `exportData()` API. That value IS the chart the user is looking
   * at, which is exactly what the P&L must be pegged to. The poll suspends
   * itself whenever real live bars are flowing or the tab is hidden.
   */
  const CHART_EXPORT_POLL_MS = 700;
  // exportData() called before the chart has a series can stay pending
  // FOREVER (observed on GMGN during page boot). The in-flight guard
  // therefore expires, and a sequence number disarms the stale promise so a
  // years-late resolution cannot publish an outdated close.
  const EXPORT_STUCK_MS = 5000;
  let lastExportedClose = 0;
  let lastExportEmitAt = 0;
  let exportStartedAt = 0;
  let exportSeq = 0;

  function pollChartClose() {
    const now = Date.now();
    // F-26: a page that has produced no TradingView widget for a minute has
    // nothing to export — stand down with the widget sweep; the slow sweep
    // resets the miss counter the moment a chart appears.
    if (widgetSweepMisses >= WIDGET_SWEEP_MISS_LIMIT) return;
    if (exportStartedAt && now - exportStartedAt < EXPORT_STUCK_MS) return;
    if (now - lastLiveBarAt < 1500) return; // live bars own the peg
    try { if (document.hidden) return; } catch (_) {}
    // Only the chart showing THIS page's token may set the price — a preload
    // chart for another token must not.
    const charts = getRankedCharts();
    const chart = currentSymbolNeedles.length
      ? charts.find((c) => chartSymbolMatches(c))
      : charts[0];
    if (!chart || typeof chart.exportData !== 'function') return;

    let exported;
    try {
      exported = chart.exportData({
        from: Math.floor(now / 1000) - 600,
        includeTime: true,
        includedStudies: [],
      });
    } catch (_) { return; }

    exportStartedAt = now;
    const seq = ++exportSeq;
    Promise.resolve(exported).then((result) => {
      if (seq !== exportSeq) return; // superseded by a newer poll
      exportStartedAt = 0;
      // A live bar may have arrived while the export was in flight; the
      // subscription feed always outranks a polled snapshot.
      if (Date.now() - lastLiveBarAt < 1500) return;
      const rows = result && Array.isArray(result.data) ? result.data : null;
      if (!rows || !rows.length) return;
      const schema = Array.isArray(result.schema) ? result.schema : null;
      let closeIndex = 4; // TradingView default: [time, open, high, low, close]
      if (schema) {
        const found = schema.findIndex((f) => f && (f === 'close' || f.plotTitle === 'close' || f.sourceTitle === 'close'));
        if (found >= 0) closeIndex = found;
      }
      // Rows come back as Float64Array (not Array), so index access only.
      const lastRow = rows[rows.length - 1];
      const close = numberValue(lastRow ? lastRow[closeIndex] : null);
      if (!(close > 0)) return;
      // A flat market is not a dead feed. Re-assert an unchanged close on a
      // slow heartbeat so staleness handling does not declare a healthy chart
      // dead and route every fill to the resolver (DEFECT F-19).
      if (close === lastExportedClose && Date.now() - lastExportEmitAt < 2500) return;
      lastExportedClose = close;
      lastExportEmitAt = Date.now();
      lastBarClose = close;
      emit('tick', {
        candidates: [{ value: close, unit: 'unknown', key: 'chartExportClose' }],
        mcap: close,
        mint: currentSymbolInfo.mint,
        symbol: currentSymbolInfo.symbol,
        name: null,
        source: 'chart-export',
      });
    }, () => { if (seq === exportSeq) exportStartedAt = 0; });
  }

  setInterval(pollChartClose, CHART_EXPORT_POLL_MS);

  // The bridge is installed before Padre creates window.tvWidget. Check
  // frequently during startup so subscribeBars is wrapped before the chart
  // subscribes, then continue at a low cadence to catch SPA widget replacement.
  let fastChecks = 0;
  const fastTimer = setInterval(() => {
    fastChecks += 1;
    if (patchPadreWidget() || fastChecks >= 500) clearInterval(fastTimer);
  }, 10);
  let sweepTicks = 0;
  setInterval(() => {
    sweepTicks += 1;
    // O-04/C-17: a content script that has said NOTHING for 5+ minutes is
    // dead (extension reloaded/removed) or deliberately stood down. Stop
    // repainting lines/marks; the transport wrappers keep forwarding ticks,
    // and any future content-script message revives the sweep instantly.
    if (Date.now() - lastContentMessageAt > CONTENT_SILENCE_LIMIT_MS) return;

    // GMGN recovery is driven by its own chart manager, not the TradingView
    // widget scan, so it runs whenever specs/queues exist.
    if (gmgnLineSpec && gmgnLineSpec.enabled && !gmgnRetryTimer) {
      // D-64: want-detection must consider every level source — a side whose
      // mcap candidate is null but whose native average exists (C-16 lane)
      // wants a line just as much, and previously never re-armed the sync.
      const wantsBuy = Number(gmgnLineSpec.avgBuyMcap) > 0 || Number(gmgnLineSpec.avgBuyNative) > 0;
      const wantsSell = Number(gmgnLineSpec.avgSellMcap) > 0 || Number(gmgnLineSpec.avgSellNative) > 0;
      const buyMissing = wantsBuy && !gmgnBuySlot.adapter && !gmgnBuySlot.pending;
      const sellMissing = wantsSell && !gmgnSellSlot.adapter && !gmgnSellSlot.pending;
      if (buyMissing || sellMissing) syncGmgnAverageLines();
    }
    if (gmgnMarkerQueue.length && !gmgnMarkerTimer) scheduleGmgnMarkerDrain();
    // DEFECT C-12: lines detect chart replacement inside syncGmgnAverageLines,
    // but shapes had no such check — a GMGN timeframe change permanently
    // erased every paper arrow. Compare the drawn shapes' chart identity to
    // the live chart and requeue+redraw on mismatch. Only runs while shapes
    // exist, i.e. on GMGN pages with fills.
    if (gmgnShapes.length && !gmgnMarkerTimer) {
      const liveGmgnChart = findGmgnChart();
      if (liveGmgnChart && gmgnShapesChart && liveGmgnChart !== gmgnShapesChart) {
        requeueGmgnShapes();
        scheduleGmgnMarkerDrain();
      }
    }

    // F-26: after a minute of empty scans the widget sweep (fiber walks,
    // iframe probes) drops to every 10th tick until a chart shows up or the
    // content script announces one (paper-axis/paper-lines resets misses).
    const standingDown = widgetSweepMisses >= WIDGET_SWEEP_MISS_LIMIT;
    if (standingDown && sweepTicks % WIDGET_SWEEP_SLOW_EVERY !== 0) return;
    patchPadreWidget();
    widgetSweepMisses = lastWidgetScanFound ? 0 : widgetSweepMisses + 1;
    // Shape-mode fills that could not draw yet (chart still booting, or the
    // site swapped to a fresh chart instance) are retried here.
    if (shapeFallbackActive && paperMarks.length && fallbackShapeHandles.size < paperMarks.length) {
      drawShapeFallback();
    }
  }, 1000);

  emit('ready', { href: location.href, phase: 'document-start', version: 4 });
})();
