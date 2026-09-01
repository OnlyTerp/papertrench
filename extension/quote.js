/* PaperTrench — pure quote logic.
 *
 * No DOM, no network, no chrome APIs. Everything here is a pure function so it
 * can be driven directly by tests, and it is the SAME code the extension runs
 * in the browser (browser global + guarded CommonJS export at the bottom).
 *
 * Three responsibilities:
 *   pickBestPair / normalizePair  — turn a Dexscreener payload into identity
 *                                   + anchor quote (criterion 1)
 *   validateTick                  — decide whether a page-feed tick may be
 *                                   trusted against that anchor (criterion 2)
 *   headerFields                  — derive what the overlay header shows
 *                                   (criterion 3)
 */
(function () {
  'use strict';

  var WSOL_MINT = 'So11111111111111111111111111111111111111112';
  var BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
  var EVM_RE = /^0x[0-9a-fA-F]{40}$/;

  /* Multichain (docs/MULTICHAIN.md, live-verified 2026-08-05): fomo chain
   * slug -> Dexscreener chainId. solana/bnb/ethereum/robinhood probed live
   * against real trending tokens; the last three come from the site's chain
   * registry and must be re-verified on first real sighting. */
  var CHAIN_MAP = {
    solana: 'solana',
    bnb: 'bsc',
    ethereum: 'ethereum',
    robinhood: 'robinhood',
    base: 'base',
    monad: 'monad',
    hyperliquid: 'hyperliquid',
    /* The other terminals went multichain on 2026-08-06 (GMGN, Birdeye and
     * DexScreener, all route shapes verified live). They already speak
     * Dexscreener's own chainId vocabulary, so these are identity entries —
     * present rather than assumed, because an ABSENT entry is what used to
     * make a foreign token get priced on Solana. test/chainrouting.test.js
     * fails if sites.js can ever emit a chain that is missing here. */
    bsc: 'bsc',
    arbitrum: 'arbitrum',
    avalanche: 'avalanche',
    optimism: 'optimism',
    polygon: 'polygon',
    sui: 'sui',
    ton: 'ton',
    tron: 'tron',
    unichain: 'unichain',
    sonic: 'sonic',
    cronos: 'cronos',
    pulsechain: 'pulsechain',
    abstract: 'abstract',
    hyperevm: 'hyperevm',
  };

  /**
   * The Dexscreener chainId to price a token against, or null.
   *
   * No chain at all means Solana — the historical default, and what every
   * Solana-only caller still passes. But a chain we were GIVEN and cannot
   * map must never fall back to Solana: that silently prices a foreign
   * token against a different chain's pairs, which is the exact class of
   * wrong number this product exists to refuse. Null flows into the pair
   * filters as "match nothing", so the caller gets no price instead of the
   * wrong one.
   */
  function chainIdFor(chain) {
    if (chain === undefined || chain === null || chain === '') return 'solana';
    return Object.prototype.hasOwnProperty.call(CHAIN_MAP, chain) ? CHAIN_MAP[chain] : null;
  }

  /** Case-tolerant address equality: Dexscreener returns checksummed EVM
   *  addresses while page URLs are usually lowercase. Base58 is case-
   *  SENSITIVE and must never be lowercased. */
  function sameAddress(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a === b) return true;
    return EVM_RE.test(a) && EVM_RE.test(b) && a.toLowerCase() === b.toLowerCase();
  }

  /* ------------------------------------------------------------------ *
   * 1. Identity + anchor quote from a Dexscreener payload
   * ------------------------------------------------------------------ */

  /**
   * Choose the pair a trading UI would actually quote: the Solana pair with a
   * usable price and the deepest liquidity. Shallow pools produce wild prices,
   * so liquidity depth is the correct tiebreak rather than array order.
   *
   * When `requestedAddress` is supplied, prefer pairs where that token is the
   * base, or where it is the quote against wrapped SOL. This stops a stablecoin
   * or unrelated token from being returned as the resolved identity.
   */
  function pickBestPair(pairs, requestedAddress, chainId) {
    if (!Array.isArray(pairs)) return null;
    // Multichain: filter to the REQUESTED chain (default solana). On EVM
    // chains Dexscreener's priceNative is denominated in that chain's gas
    // token, not SOL — priceUsd is the number that is true everywhere, so
    // usability is judged on it off-Solana.
    const wantChain = chainId || 'solana';
    const usable = pairs.filter((p) => p && p.chainId === wantChain
      && (wantChain === 'solana' ? Number(p.priceNative) > 0 : Number(p.priceUsd) > 0));
    if (!usable.length) return null;

    const requested = typeof requestedAddress === 'string'
      && (BASE58_RE.test(requestedAddress) || EVM_RE.test(requestedAddress))
      ? requestedAddress
      : null;
    if (requested) {
      const relevant = usable.filter((p) => {
        const base = (p.baseToken && p.baseToken.address) || '';
        const quote = (p.quoteToken && p.quoteToken.address) || '';
        if (sameAddress(base, requested)) return true;
        if (sameAddress(quote, requested) && base === WSOL_MINT) return true;
        return false;
      });
      if (relevant.length) {
        return relevant.reduce((best, p) => {
          const a = Number((p.liquidity && p.liquidity.usd) || 0);
          const b = Number((best.liquidity && best.liquidity.usd) || 0);
          return a > b ? p : best;
        });
      }
    }

    return usable.reduce((best, p) => {
      const a = Number((p.liquidity && p.liquidity.usd) || 0);
      const b = Number((best.liquidity && best.liquidity.usd) || 0);
      return a > b ? p : best;
    });
  }

  /**
   * Normalize one Dexscreener pair into our token record, or null if unusable.
   *
   * Multichain (`opts.chain` = fomo slug, `opts.solUsd` = SOL/USD rate): on a
   * non-Solana chain the pair's priceNative is in that chain's gas token and
   * is DISCARDED. The record's priceNative — the number the SOL-denominated
   * book trades in — is derived as priceUsd / solUsd, and the rate used is
   * RECORDED on the record (solUsdAtResolve). No usable rate → null, never a
   * guess: a wrong rate silently corrupts every fill downstream.
   */
  function normalizePair(pair, fallbackAddress, opts) {
    if (!pair) return null;
    const chain = (opts && opts.chain) || 'solana';
    const foreign = chain !== 'solana';
    const rawPrice = Number(pair.priceNative);
    if (!foreign && !(rawPrice > 0)) return null;

    const requested = typeof fallbackAddress === 'string'
      && (BASE58_RE.test(fallbackAddress) || EVM_RE.test(fallbackAddress))
      ? fallbackAddress
      : null;
    const base = pair.baseToken || {};
    const quote = pair.quoteToken || {};

    let isQuote = false;
    if (requested) {
      if (sameAddress(requested, pair.pairAddress)) {
        isQuote = false;
      } else if (sameAddress(base.address, requested)) {
        isQuote = false;
      } else if (sameAddress(quote.address, requested) && base.address === WSOL_MINT) {
        isQuote = true;
      } else if (sameAddress(quote.address, requested)) {
        return null;
      } else {
        isQuote = false;
      }
    }

    const token = isQuote ? quote : base;
    const priceUsd = pair.priceUsd != null ? Number(pair.priceUsd) : null;
    const usdOk = Number.isFinite(priceUsd) && priceUsd > 0;
    let priceNative;
    let solUsdAtResolve = null;
    if (foreign) {
      const rate = Number(opts && opts.solUsd);
      if (!usdOk || !(rate > 0)) return null;
      priceNative = priceUsd / rate;
      solUsdAtResolve = rate;
    } else {
      priceNative = isQuote ? 1 / rawPrice : rawPrice;
    }
    const mcap = Number(pair.marketCap != null ? pair.marketCap : pair.fdv);

    return {
      mint: token.address || fallbackAddress || null,
      pairAddress: pair.pairAddress || null,
      symbol: token.symbol || null,
      name: token.name || token.symbol || null,
      priceNative,
      priceUsd: usdOk ? priceUsd : null,
      mcap: Number.isFinite(mcap) && mcap > 0 && !isQuote ? mcap : null,
      dex: pair.dexId || null,
      priceSource: 'resolver',
      resolvedAt: Date.now(),
      chain: chain,
      solUsdAtResolve: solUsdAtResolve,
      // F-55: surfaced so a drained pool can be told from a trading one. A
      // rug empties liquidity; a real runner's pool deepens. Null when the
      // source reports none — the mark guard stands aside rather than guess.
      liquidityUsd: Number(pair.liquidity && pair.liquidity.usd) > 0
        ? Number(pair.liquidity.usd) : null,
    };
  }

  /**
   * Accept either Dexscreener response shape:
   *   /tokens/<mint>          -> { pairs: [...] }
   *   /pairs/solana/<pair>    -> { pair: {...} }  (or { pairs: [...] })
   * `opts.chain` (fomo slug) selects the chain family; `opts.solUsd` powers
   * the off-Solana SOL-price derivation (see normalizePair).
   */
  function tokenFromPayload(payload, fallbackAddress, opts) {
    if (!payload || typeof payload !== 'object') return null;
    const chainId = chainIdFor(opts && opts.chain);
    const pair = payload.pair || pickBestPair(payload.pairs, fallbackAddress, chainId);
    const token = normalizePair(pair, fallbackAddress, opts);
    // F-61: surface EVERY pool the source lists for this base mint. A Pulse
    // row buy can commit under a bonding-era PAIR stand-in (the row-feed
    // fallback echoes the click address as the key); after graduation the
    // coin resolves under its REAL mint and the bag strands. The pool list
    // is the deterministic identity proof — graduated bonding pairs stay
    // listed under the same base mint (verified on-chain 2026-08-20, P0-3) —
    // so the chart page can rekey any position whose key is one of these
    // pools. Additive: consumers that ignore it are unaffected.
    if (token && Array.isArray(payload.pairs)) {
      const seen = {};
      const pools = [];
      for (var i = 0; i < payload.pairs.length; i++) {
        var p = payload.pairs[i] && payload.pairs[i].pairAddress;
        if (p && !seen[p]) { seen[p] = 1; pools.push(p); }
      }
      if (pools.length) token.poolAddresses = pools;
    }
    return token;
  }

  /* ------------------------------------------------------------------ *
   * 1b. Fresh-launch identity from Jupiter
   *
   * Dexscreener does not index a token until a pool has been observed, which
   * on a brand-new pump.fun launch is measurably later than the coin exists.
   * That gap is exactly the window snipers care about, so a second source is
   * required. Jupiter's free token search returns new mints within seconds,
   * but quotes USD only — the SOL price is derived from a SOL/USD reference.
   * ------------------------------------------------------------------ */

  /** Pull the entry for `address` out of a Jupiter search response. */
  function jupiterEntry(payload, address) {
    var list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.tokens) ? payload.tokens : null);
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && item.id === address) return item;
    }
    return null;
  }

  /**
   * Normalize one Jupiter token entry into our token record.
   *
   * `solUsd` is the SOL/USD rate used to convert Jupiter's USD quote into the
   * SOL-denominated price the engine trades in. Without a usable rate this
   * returns null rather than guessing, because a wrong rate silently corrupts
   * every fill and P&L number downstream.
   */
  function tokenFromJupiter(payload, address, solUsd) {
    var entry = jupiterEntry(payload, address);
    if (!entry) return null;

    var usd = Number(entry.usdPrice);
    var rate = Number(solUsd);
    if (!(usd > 0) || !(rate > 0)) return null;

    var priceNative = usd / rate;
    if (!(priceNative > 0) || !isFinite(priceNative)) return null;

    var mcap = Number(entry.mcap != null ? entry.mcap : entry.fdv);
    var createdAt = entry.firstPool && entry.firstPool.createdAt
      ? Date.parse(entry.firstPool.createdAt)
      : NaN;

    return {
      mint: entry.id || address || null,
      pairAddress: (entry.firstPool && entry.firstPool.id) || null,
      symbol: entry.symbol || null,
      name: entry.name || entry.symbol || null,
      priceNative: priceNative,
      priceUsd: usd,
      mcap: isFinite(mcap) && mcap > 0 ? mcap : null,
      dex: null,
      priceSource: 'jupiter',
      resolvedAt: Date.now(),
      // Surfaced so the UI can say "brand new" honestly instead of implying
      // an established market exists.
      launchedAt: isFinite(createdAt) ? createdAt : null,
      liquidityUsd: Number(entry.liquidity) > 0 ? Number(entry.liquidity) : null,
    };
  }

  /** Read the SOL/USD rate out of a Jupiter response that includes WSOL. */
  function solUsdFromJupiter(payload) {
    var entry = jupiterEntry(payload, WSOL_MINT);
    var usd = entry ? Number(entry.usdPrice) : NaN;
    return usd > 0 ? usd : null;
  }

  /**
   * Choose between two candidate token records for the same address.
   *
   * A record backed by an actual pool quote (Dexscreener) is preferred when
   * both exist, because it is the venue price. Jupiter wins only when it is
   * the sole source, which is precisely the fresh-launch case.
   */
  function preferResolved(dexRecord, jupRecord) {
    if (dexRecord && Number(dexRecord.priceNative) > 0) return dexRecord;
    if (jupRecord && Number(jupRecord.priceNative) > 0) return jupRecord;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 1c. Venue first-price — GMGN quotation / pump.fun coin API
   *
   * The first minutes of a launch exist on the terminal's own servers
   * before any aggregator indexes them, and the chart on screen is drawn
   * from exactly that server. When Dexscreener and Jupiter are both
   * silent, the site's own quotation endpoint is the same source the
   * visible chart trusts, so it may price the coin (D-38 — "the chart is
   * up, the website sees it, the extension must too").
   *
   * Both families document their `price` field as USD; the unit is still
   * gated by gross market sanity (implied supply = mcap / price must land
   * in the whole-token band below), which refuses the unit-mixture
   * nonsense that used to leak into fills. Raw supply amounts with mint
   * decimals (pump.fun's 1e12-scaled totals) pass through the relative
   * check against the declared supply. No token is ever guessed.
   * ------------------------------------------------------------------ */

  var VENUE_SUPPLY_MIN = 1e2;
  var VENUE_SUPPLY_MAX = 1e13;
  var VENUE_PRICE_MIN = 1e-9;
  var VENUE_PRICE_MAX = 1e6;

  /** Extract the usable fields from either venue payload family:
   *  GMGN { code, data: { price, marketCap, ... } } and
   *  pump.fun { ... price, marketCap, totalSupply } (flat or nested). */
  function venueRoot(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var d = (payload.data && typeof payload.data === 'object') ? payload.data : payload;
    var usd = Number(d.priceUsd != null ? d.priceUsd : d.price);
    var mcap = Number(d.marketCap != null ? d.marketCap
      : (d.market_cap != null ? d.market_cap : NaN));
    var supply = Number(d.totalSupply != null ? d.totalSupply
      : (d.supply != null ? d.supply : NaN));
    return {
      symbol: typeof d.symbol === 'string' ? d.symbol : null,
      name: typeof d.name === 'string' ? d.name : null,
      mint: typeof d.mint === 'string' ? d.mint : null,
      usd: usd,
      mcap: mcap,
      supply: isFinite(supply) ? supply : 0,
    };
  }

  /**
   * Normalize a venue quotation into our token record.
   *
   * @param {object} payload  raw venue response (either family)
   * @param {string} address  the mint the query was issued for
   * @param {number} solUsd   SOL/USD rate (0 = no rate => refusal; a wrong
   *                          rate silently corrupts every SOL fill)
   * @param {string} source   'gmgn' | 'pumpfun'
   */
  function tokenFromVenueQuote(payload, address, solUsd, source) {
    var v = venueRoot(payload);
    if (!v) return null;
    var rate = Number(solUsd);
    if (!(rate > 0)) return null;
    if (!(v.usd > 0)) return null;
    if (v.usd < VENUE_PRICE_MIN || v.usd > VENUE_PRICE_MAX) return null;

    if (v.mcap > 0) {
      var impliedSupply = v.mcap / v.usd;
      var supplyOk = impliedSupply >= VENUE_SUPPLY_MIN && impliedSupply <= VENUE_SUPPLY_MAX;
      if (!supplyOk && v.supply > 0) {
        // pump.fun's totalSupply carries the mint's decimals (1e9 tokens /
        // 6 decimals = 1e15 raw); GMGN reports whole tokens. Accept either
        // scale within a generous relative band around the declaration.
        supplyOk = impliedSupply >= v.supply / 1e12 && impliedSupply <= v.supply * 1e6;
      }
      if (!supplyOk) return null;
    }

    var priceNative = v.usd / rate;
    if (!(priceNative > 0) || !isFinite(priceNative)) return null;

    return {
      mint: v.mint || address || null,
      pairAddress: null,
      symbol: v.symbol,
      name: v.name || v.symbol,
      priceNative: priceNative,
      priceUsd: v.usd,
      mcap: v.mcap > 0 ? v.mcap : null,
      dex: null,
      priceSource: source,
      resolvedAt: Date.now(),
    };
  }

  /** The GMGN quotation family ({ code, data: { price, marketCap, ... } }). */
  function tokenFromGmgn(payload, address, solUsd) {
    return tokenFromVenueQuote(payload, address, solUsd, 'gmgn');
  }

  /** The pump.fun coin API family ({ price, marketCap, totalSupply }). */
  function tokenFromPumpfun(payload, address, solUsd) {
    return tokenFromVenueQuote(payload, address, solUsd, 'pumpfun');
  }

  /* ------------------------------------------------------------------ *
   * 2. Fresh-launch bootstrap from the on-screen price
   * ------------------------------------------------------------------ */

  // A new coin has no Dexscreener/Jupiter anchor yet, but the page already
  // shows a live price on the chart. These thresholds are used to decide what
  // the on-screen number actually is, since TradingView bars come through as
  // unit 'unknown' and can represent USD price, native SOL price, or market cap.
  // Values below this are typical native SOL prices for memecoins (e.g. 1e-8);
  // values at or above are usually USD token prices. The gap exists because
  // a memecoin's native price is tiny while its USD price is 1..3 orders of
  // magnitude larger (SOL/USD ~200).
  var BOOTSTRAP_NATIVE_THRESHOLD = 1e-7;
  var BOOTSTRAP_MCAP_FLOOR = 1000;
  var BOOTSTRAP_USD_CEILING = 1e6;
  // DEFECT F-25: the sane USD unit-price band for a coin still in its
  // pre-index bootstrap window. The old heuristic hardcoded today's SOL/USD
  // scale ("anything in [1e-7, 1000) is USD"), so a genuinely SOL-denominated
  // close just past the threshold was divided by the rate twice (~200x low).
  // With a live rate the two readings are judged the same way: a value is
  // plausibly NATIVE when value x rate lands in this band, plausibly USD when
  // the value itself does. When BOTH readings are plausible the tick is
  // REFUSED rather than guessed — the fast-retry loop delivers an anchored
  // quote within seconds, and a short honest absence beats a 200x-wrong fill.
  // Band intuition at 1e9 supply (the memecoin norm): $100 .. $100K market
  // cap, generous in both directions for a coin no aggregator has indexed.
  var BOOTSTRAP_SANE_USD_MIN = 1e-7;
  var BOOTSTRAP_SANE_USD_MAX = 1e-4;

  // Every pump.fun coin mints exactly 1e9 tokens (6 decimals) and its vanity
  // mint ends in "pump" — protocol facts, not scraped page data. They are the
  // one case where an mcap-scale chart close CAN honestly price a coin no
  // aggregator has indexed. `pumpCurve` is set when the on-chain feed has
  // positively identified the token's bonding curve (see prewatch), covering
  // pair-address pages where the mint is not known yet.
  var PUMP_FAMILY_SUPPLY = 1e9;
  // The mcap READINGS get their own band (as unit price at 1e9): a pump
  // curve launches near a $4K cap and is aggregator-indexed well past
  // migration, so below ~$3K or above $100K the "it's a market cap" reading
  // is not credible — without this floor a 0.5 chart close read as "0.5 SOL
  // of market cap = a $100 coin" would have slipped past the generous
  // unit-price band that F-25 deliberately keeps.
  var PUMP_MCAP_UNIT_MIN = 3e-6;
  var PUMP_MCAP_UNIT_MAX = 1e-4;
  function isPumpFamily(t) {
    if (!t) return false;
    if (t.pumpCurve === true) return true;
    return typeof t.mint === 'string' && /pump$/.test(t.mint);
  }

  /**
   * The supply an mcap-scale reading may honestly be divided by, or null.
   *
   * Two sources, both protocol facts rather than scraped page data: the
   * pump.fun constant (1e9, a rule of the program), and a supply READ FROM
   * THE MINT ACCOUNT ITSELF by the prewatch probe (token.supplyUi, in whole
   * tokens). The measured value is what lets a letsbonk/Believe/Moonshot
   * launch — any coin whose mint does not end in "pump" — be priced from the
   * page's own mcap feed during the minutes before an aggregator indexes it.
   * No supply from either source means mcap readings stay unpriceable, which
   * is the honest answer, not a gap.
   */
  function bootstrapSupplyInfo(t) {
    if (!t) return { supplyUi: null, basis: null };
    var measured = Number(t.supplyUi);
    if (measured > 0) return { supplyUi: measured, basis: 'measured' };
    if (isPumpFamily(t)) return { supplyUi: PUMP_FAMILY_SUPPLY, basis: 'pump-constant' };
    var host = Number(t.hostSupplyUi);
    return host > 0 ? { supplyUi: host, basis: 'host' } : { supplyUi: null, basis: null };
  }

  function bootstrapSupply(t) {
    return bootstrapSupplyInfo(t).supplyUi;
  }

  /** The unit-price band an mcap reading must land in to be credible. The
   * pump band is tighter because the protocol pins the launch cap (~$4K);
   * a measured-supply coin only gets the generic pre-index sanity band. */
  function mcapUnitBand(t) {
    if (isPumpFamily(t)) return { min: PUMP_MCAP_UNIT_MIN, max: PUMP_MCAP_UNIT_MAX };
    return { min: BOOTSTRAP_SANE_USD_MIN, max: BOOTSTRAP_SANE_USD_MAX };
  }

  /**
   * Accept the very first price for a coin no aggregator has indexed yet.
   *
   * The on-screen price is treated as the only truthful quote, so the trader
   * can buy the instant the chart starts printing. Stray page numbers are kept
   * out by requiring a trusted source or a matching mint, and absurd values are
   * refused rather than becoming a bogus fill.
   *
   * @param {object} pendingToken { mint } — the coin waiting for an anchor
   * @param {object} tick         bridge payload from the page's own feed
   * @param {number} solUsd       cached SOL/USD rate (0 if not available yet)
   */
  function bootstrapTick(pendingToken, tick, solUsd) {
    var reject = function (reason) {
      return {
        accepted: false,
        reason: reason,
        priceNative: null,
        priceUsd: null,
        mcap: null,
        basis: null,
        supplyBasis: null,
      };
    };

    if (!pendingToken || !pendingToken.mint) return reject('no-token');
    if (!tick || typeof tick !== 'object') return reject('no-candidates');
    if (tick.mint && tick.mint !== pendingToken.mint) return reject('mint-mismatch');

    var rate = Number(solUsd) > 0 ? Number(solUsd) : null;
    var candidates = Array.isArray(tick.candidates) ? tick.candidates : [];
    var tickMcap = Number(tick.mcap);

    // Only trust chart/trade sources or mint-tagged payloads. A random number
    // scraped off the page must never price a brand-new coin.
    var trusted = tick.mint === pendingToken.mint
      || tick.source === 'padre-chart-bar'
      || tick.source === 'chart-export'
      || tick.source === 'gmgn-ws-trade'
      || tick.source === 'gmgn-mcap-candle';
    if (!trusted) return reject('untrusted-source');

    var accept = function (native, usd, mcap, basis, supplyBasis) {
      return {
        accepted: true,
        reason: 'ok',
        priceNative: native > 0 ? native : null,
        priceUsd: usd > 0 ? usd : null,
        mcap: mcap > 0 ? mcap : null,
        basis: basis,
        supplyBasis: supplyBasis || null,
      };
    };

    // GMGN's live trade feed is mint-tagged and quotes in USD. Convert it to
    // the SOL price the engine trades in.
    if (tick.source === 'gmgn-ws-trade' && tick.mint === pendingToken.mint && candidates.length) {
      var usd = Number(candidates[0].value);
      if (!(usd > 0)) return reject('no-candidates');
      if (!rate) return reject('no-sol-rate');
      var native = usd / rate;
      if (!(native > 0)) return reject('no-sol-rate');
      return accept(native, usd, null, 'ws-usd');
    }

    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      var v = Number(cand && cand.value);
      if (!(v > 0)) continue;
      var unit = (cand && cand.unit) || 'unknown';

      if (unit === 'native') {
        // A memecoin native price is far below 1 SOL. Anything larger is almost
        // certainly a market cap or a mislabelled USD figure.
        if (v >= 1) return reject('native-looks-mcap');
        // F-25: this branch had no floor — dust values and rate-scale
        // mislabels became real fills. With a live rate an explicit native
        // price must still imply a sane USD price for a pre-index coin.
        // Without a rate there is nothing to judge against: keep the old
        // behavior rather than refusing a possibly-good declared unit.
        if (rate) {
          var usdEquiv = v * rate;
          if (usdEquiv < BOOTSTRAP_SANE_USD_MIN || usdEquiv > BOOTSTRAP_SANE_USD_MAX) {
            return reject('native-implausible');
          }
        }
        return accept(v, rate ? v * rate : null, null, 'native');
      }

      if (unit === 'usd') {
        if (!rate) return reject('no-sol-rate');
        if (v >= BOOTSTRAP_USD_CEILING) return reject('mcap-looks-usd');
        var native = v / rate;
        if (!(native > 0)) return reject('no-sol-rate');
        return accept(native, v, null, 'usd');
      }

      // unit === 'unknown' is the common TradingView chart close case.
      if (unit === 'unknown') {
        // A KNOWN supply — pump.fun's protocol constant or one measured off
        // the mint account by the prewatch probe — is what lets an
        // mcap-scale close price the coin; without one the general path
        // below must refuse ("no implied supply"). An Axiom chart parked in
        // MCap mode was exactly the screen that could never bootstrap a
        // fresh launch: the armed buy sat on "fresh-launch wait-line"
        // forever while the site's own chart ticked away (maintainer video,
        // 39-second-old coin; the Padre re-report was the same screen on a
        // non-pump launchpad coin, which is why the constant alone was not
        // enough). A SOL-denominated cap is a SMALL number (a $7K cap is
        // ~47 SOL), so this cannot hide behind a magnitude floor: all four
        // readings of the unlabelled value — native unit, USD unit, SOL
        // mcap, USD mcap — are judged against the same sane band, and the
        // tick is priced only when EXACTLY ONE fits (the F-25 discipline,
        // extended).
        var supplyInfo = bootstrapSupplyInfo(pendingToken);
        var supply = supplyInfo.supplyUi;
        if (rate && supply) {
          var band = mcapUnitBand(pendingToken);
          var readings = [
            { basis: 'native', usd: v * rate, native: v, mcap: null,
              min: BOOTSTRAP_SANE_USD_MIN, max: BOOTSTRAP_SANE_USD_MAX },
            { basis: 'usd', usd: v, native: v / rate, mcap: null,
              min: BOOTSTRAP_SANE_USD_MIN, max: BOOTSTRAP_SANE_USD_MAX },
            { basis: 'native-mcap', usd: (v * rate) / supply, native: v / supply, mcap: v * rate,
              min: band.min, max: band.max },
            { basis: 'mcap', usd: v / supply, native: v / supply / rate, mcap: v,
              min: band.min, max: band.max },
          ];
          var sane = readings.filter(function (r) {
            return r.usd >= r.min && r.usd <= r.max;
          });
          if (sane.length > 1) return reject('ambiguous-unit');
          if (sane.length === 1) {
            return accept(sane[0].native, sane[0].usd, sane[0].mcap, sane[0].basis,
              supplyInfo.basis);
          }
          return reject('implausible-unit');
        }
        // Market cap values are much larger than token prices and we cannot
        // derive a token price without an implied supply.
        if (v >= BOOTSTRAP_MCAP_FLOOR) return reject('mcap-no-supply');

        // F-25: with a live SOL/USD rate the disambiguation is RATE-AWARE,
        // not a hardcoded magnitude split. Judge both readings against the
        // sane pre-index USD band and only accept when exactly ONE fits.
        if (rate) {
          var usdIfNative = v * rate;
          var nativePlausible = usdIfNative >= BOOTSTRAP_SANE_USD_MIN
            && usdIfNative <= BOOTSTRAP_SANE_USD_MAX;
          var usdPlausible = v >= BOOTSTRAP_SANE_USD_MIN
            && v <= BOOTSTRAP_SANE_USD_MAX;
          // Both readings sane: guessing here is exactly the double-division
          // corruption. Refuse; the fast-retry loop anchors the coin soon.
          if (nativePlausible && usdPlausible) return reject('ambiguous-unit');
          if (nativePlausible) return accept(v, usdIfNative, null, 'native');
          if (usdPlausible) {
            var native = v / rate;
            if (native > 0) return accept(native, v, null, 'usd');
            return reject('no-sol-rate');
          }
          // Neither reading lands anywhere sane for a bootstrap coin: an
          // absurd value must never become the first fill price.
          return reject('implausible-unit');
        }

        // No rate yet: keep the original magnitude-only heuristic. Very
        // small values are native SOL prices for memecoins (e.g. 1e-8);
        // anything else needs the rate to be read at all.
        if (v < BOOTSTRAP_NATIVE_THRESHOLD) {
          return accept(v, null, null, 'native');
        }
        return reject('no-sol-rate');
      }
    }

    // A market-cap-only tick (GMGN/Axiom pre-index) can price any coin whose
    // supply is KNOWN — pump's protocol constant or a supply measured off the
    // mint account — through the same exactly-one-sane discipline.
    var mcSupplyInfo = bootstrapSupplyInfo(pendingToken);
    var mcSupply = mcSupplyInfo.supplyUi;
    if (tickMcap > 0 && rate && mcSupply) {
      var mcBand = mcapUnitBand(pendingToken);
      var usdMc = tickMcap / mcSupply;
      var solMc = (tickMcap * rate) / mcSupply;
      var usdOk = usdMc >= mcBand.min && usdMc <= mcBand.max;
      var solOk = solMc >= mcBand.min && solMc <= mcBand.max;
      if (usdOk && solOk) return reject('ambiguous-unit');
      if (usdOk) return accept(usdMc / rate, usdMc, tickMcap, 'mcap', mcSupplyInfo.basis);
      if (solOk) return accept(tickMcap / mcSupply, solMc, tickMcap * rate, 'native-mcap',
        mcSupplyInfo.basis);
    }
    // A market-cap-only tick has no token price, so nothing can be filled yet.
    if (tickMcap > 0) return reject('mcap-only-no-supply');

    return reject('no-candidates');
  }

  /* ------------------------------------------------------------------ *
   * 3. Tick validation against the trusted anchor
   * ------------------------------------------------------------------ */

  // A live price may drift far from the anchor during a memecoin move, but it
  // does not jump by orders of magnitude. A ratio band (not an absolute
  // epsilon) is required because these prices span 1e-9 .. 1e3.
  var ACCEPT_RATIO = 20;

  /**
   * Decide whether a tick from the page's own feed may update the price.
   *
   * @param {object} anchor  trusted token record { mint, priceNative, priceUsd }
   * @param {object} tick    bridge payload { mint?, candidates: [{value, unit}] }
   * @returns {{accepted: boolean, reason: string, priceNative: number|null, priceUsd: number|null}}
   *
   * Rejection is the default: a candidate must positively agree with the anchor.
   * This is what stops a stray page number (the observed bogus 0.44 SOL against
   * a ~0.00000004 SOL token) from ever becoming a displayed or fill price.
   */
  function validateTick(anchor, tick) {
    const reject = (reason) => ({
      accepted: false,
      reason,
      priceNative: anchor && Number(anchor.priceNative) > 0 ? Number(anchor.priceNative) : null,
      priceUsd: anchor && Number(anchor.priceUsd) > 0 ? Number(anchor.priceUsd) : null,
      mcap: anchor && Number(anchor.mcap) > 0 ? Number(anchor.mcap) : null,
      basis: null,
    });

    if (!anchor || !(Number(anchor.priceNative) > 0)) return reject('no-anchor');
    if (!tick || typeof tick !== 'object') return reject('no-candidates');
    // A tick carrying a different mint is about a different token entirely.
    if (tick.mint && anchor.mint && tick.mint !== anchor.mint) {
      return reject('mint-mismatch');
    }

    const candidates = Array.isArray(tick.candidates) ? tick.candidates : [];
    const anchorNative = Number(anchor.priceNative);
    const anchorUsd = Number(anchor.priceUsd) > 0 ? Number(anchor.priceUsd) : null;
    const anchorMcap = Number(anchor.mcap) > 0 ? Number(anchor.mcap) : null;

    let nextNative = null;
    let nextUsd = null;
    let nextMcap = null;
    let basis = null;

    for (const cand of candidates) {
      const v = Number(cand && cand.value);
      if (!(v > 0)) continue;
      const unit = (cand && cand.unit) || 'unknown';

      if (unit !== 'usd' && nextNative === null && withinBand(v, anchorNative)) {
        nextNative = v;
        basis = basis || 'native';
      }
      if (unit !== 'native' && anchorUsd && nextUsd === null && withinBand(v, anchorUsd)) {
        nextUsd = v;
        basis = basis || 'usd';
      }
    }

    // Padre's chart can display market cap instead of token price. Because
    // supply is constant during a normal tick, market-cap movement is exactly
    // price movement. Validate against the trusted mcap anchor, then derive
    // both SOL and USD token prices from the ratio.
    const tickMcap = Number(tick.mcap);
    if (anchorMcap && tickMcap > 0 && withinBand(tickMcap, anchorMcap)) {
      nextMcap = tickMcap;
      if (nextNative === null && nextUsd === null) {
        const ratio = tickMcap / anchorMcap;
        nextNative = anchorNative * ratio;
        nextUsd = anchorUsd ? anchorUsd * ratio : null;
        basis = 'mcap';
      }
    }

    // SOL-denominated market-cap charts (Axiom's USD/SOL toggle in MC mode)
    // plot the cap in SOL, which matches NEITHER the USD price band nor the
    // USD market-cap band — every such tick used to be rejected, freezing the
    // price to slow polling on exactly the charts the user trades on.
    const anchorNativeMcap = anchorMcap && anchorUsd
      ? anchorMcap * (anchorNative / anchorUsd)
      : null;
    if (nextNative === null && nextUsd === null
      && anchorNativeMcap && tickMcap > 0 && withinBand(tickMcap, anchorNativeMcap)) {
      const ratio = tickMcap / anchorNativeMcap;
      nextNative = anchorNative * ratio;
      nextUsd = anchorUsd ? anchorUsd * ratio : null;
      nextMcap = anchorMcap * ratio;
      basis = 'native-mcap';
    }

    if (nextNative === null && nextUsd === null) {
      return reject(candidates.length || tickMcap > 0 ? 'out-of-band' : 'no-candidates');
    }

    // A USD-only tick used to leave the SOL price frozen, which made SOL P&L
    // look delayed even though page ticks were arriving. Derive the missing
    // side from the anchor's SOL/USD ratio. The same works in reverse for a
    // native-only tick.
    if (nextNative === null && nextUsd !== null && anchorUsd) {
      nextNative = anchorNative * (nextUsd / anchorUsd);
    }
    if (nextUsd === null && nextNative !== null && anchorUsd) {
      nextUsd = anchorUsd * (nextNative / anchorNative);
    }

    // Supply is constant during a normal tick, so an accepted price move IS a
    // market-cap move. Without this, a price-only feed (GMGN trades, Padre
    // bars) left the headline market cap frozen at the last resolver quote.
    if (nextMcap === null && anchorMcap && nextNative !== null) {
      nextMcap = anchorMcap * (nextNative / anchorNative);
    }

    return {
      accepted: true,
      reason: 'ok',
      priceNative: nextNative !== null ? nextNative : anchorNative,
      priceUsd: nextUsd !== null ? nextUsd : anchorUsd,
      mcap: nextMcap !== null ? nextMcap : anchorMcap,
      basis,
    };
  }

  /** True when `value` is within ACCEPT_RATIO x of `anchor` in either direction. */
  function withinBand(value, anchor) {
    if (!(value > 0) || !(anchor > 0)) return false;
    const ratio = value > anchor ? value / anchor : anchor / value;
    return ratio <= ACCEPT_RATIO;
  }

  /* ------------------------------------------------------------------ *
   * 4. Live-price scheduling
   * ------------------------------------------------------------------ */

  // How often the anchor is re-quoted when the page's own feed is not
  // supplying usable ticks. At 400ms this is ~150 req/min, inside the
  // Dexscreener ~300 req/min budget. This is only the fallback — the
  // primary price path is event-driven via the DOM/WebSocket observer.
  var POLL_INTERVAL_MS = 400;
  // If the page feed is delivering ticks at least this often, polling the
  // network adds nothing, so it is suspended. 800ms means any feed tick
  // within the last 0.8s suppresses a redundant network poll.
  var FEED_FRESH_MS = 800;
  // Beyond this with no new price from any source, the quote is stale and the
  // UI must say so rather than implying the P&L is live.
  var STALE_AFTER_MS = 3000;
  // Even when the page feed is delivering ticks, the trusted anchor (SOL/USD
  // rate, implied supply, validation band centre) must be re-fetched at a low
  // cadence, or a long session slowly drifts away from reality.
  var ANCHOR_REFRESH_MS = 30_000;

  /**
   * Decide, at a given moment, whether a fresh network quote should be issued.
   * Pure so the cadence is testable without timers.
   *
   * @param {object} s { lastPriceAt, lastPollAt, inFlight, hidden }
   * @param {number} now
   */
  function shouldRequote(s, now) {
    if (!s) return false;
    if (s.inFlight) return false;          // never stack requests
    if (s.hidden) return false;            // background tabs do not poll
    // The page's own feed is fresher than anything we could fetch — but the
    // anchor itself still needs an occasional refresh (see requote(), which
    // in this situation re-anchors WITHOUT overriding the live price).
    if (s.lastPriceAt && now - s.lastPriceAt < FEED_FRESH_MS) {
      return !s.lastPollAt || now - s.lastPollAt >= ANCHOR_REFRESH_MS;
    }
    // Respect the poll interval.
    if (s.lastPollAt && now - s.lastPollAt < POLL_INTERVAL_MS) return false;
    return true;
  }

  /** True when the newest price is old enough that the P&L must not look live. */
  function isPriceStale(lastPriceAt, now) {
    if (!lastPriceAt) return true;
    return now - lastPriceAt > STALE_AFTER_MS;
  }

  // A chain-read fill price and an on-screen price from moments before the
  // click can legitimately differ by sub-second drift — never by double
  // digits. Beyond this ratio one of the two sources is broken (wrong pool,
  // starved vault leg, a decode fault), and the fill must side with the price
  // the trader is actually looking at: a fill 13% away from the chart books
  // instant fake P&L and teaches a wrong lesson, which is worse than losing
  // a few hundred milliseconds of freshness.
  var ONSCREEN_AGREE_RATIO = 1.06;

  /**
   * Comma-list preset parser — the ONE set of rules for preset editing
   * everywhere (dashboard form, popup quick settings, the panel's inline
   * editor): entries must be > 0 and ≤ max, at most 8 (500 presets would be
   * 500 buttons), optional dedupe where repeats are meaningless. Returns
   * null for an empty field ("keep the saved list") and { values, dropped }
   * otherwise so the caller can SAY when entries were rejected instead of
   * silently shrinking the list (D-42/D-06 semantics).
   */
  function parsePresetList(raw, max, opts) {
    var dedupe = Boolean(opts && opts.dedupe);
    var parts = String(raw == null ? '' : raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return null;
    var values = parts.map(function (s) { return parseFloat(s); })
      .filter(function (n) { return isFinite(n) && n > 0 && n <= max; });
    if (dedupe) {
      var seen = {};
      values = values.filter(function (n) {
        if (seen[n]) return false;
        seen[n] = true;
        return true;
      });
    }
    if (values.length > 8) values = values.slice(0, 8);
    return { values: values, dropped: parts.length - values.length };
  }

  /**
   * Rug-guard verdict: holder concentration from getTokenLargestAccounts
   * plus the mint's raw supply. Liquidity is not a holder, so positively
   * identified pool/curve reserve accounts are excluded; with none known,
   * the single largest account is excluded as the assumed pool — and the
   * verdict SAYS which of the two it did (assumedPool), because a guard that
   * hides its own method is not a trustworthy guard.
   *
   * Missing data yields { known: false } — a rug check that cannot see the
   * chain must never block (or bless) a buy on an invented number.
   */
  function rugVerdict(input) {
    var largest = input && Array.isArray(input.largest) ? input.largest : null;
    var supply = Number(input && input.supply);
    var none = { known: false, pct: null, holders: 0, assumedPool: false };
    if (!largest || !largest.length || !(supply > 0)) return none;
    var reserves = {};
    var reserveList = (input && input.reserves) || [];
    for (var i = 0; i < reserveList.length; i++) reserves[reserveList[i]] = true;
    var rows = [];
    for (var j = 0; j < largest.length; j++) {
      var entry = largest[j];
      var amount = Number(entry && entry.amount);
      var address = entry && entry.address;
      if (!(amount > 0) || typeof address !== 'string') continue;
      if (reserves[address]) continue;
      rows.push({ address: address, amount: amount });
    }
    rows.sort(function (a, b) { return b.amount - a.amount; });
    var assumedPool = false;
    if (!reserveList.length && rows.length) {
      rows.shift();
      assumedPool = true;
    }
    if (!rows.length) return none;
    var topN = Math.max(1, Math.min(20, Number(input && input.topN) || 10));
    var top = rows.slice(0, topN);
    var sum = 0;
    for (var k = 0; k < top.length; k++) sum += top[k].amount;
    var pct = (sum / supply) * 100;
    if (!isFinite(pct)) return none;
    return {
      known: true,
      pct: Math.round(pct * 10) / 10,
      holders: top.length,
      assumedPool: assumedPool,
    };
  }

  /** True when the two prices are close enough to be the same market. */
  function fillSourcesAgree(onchainNative, screenNative) {
    if (!(onchainNative > 0) || !(screenNative > 0)) return true; // nothing to compare
    var ratio = onchainNative > screenNative
      ? onchainNative / screenNative
      : screenNative / onchainNative;
    return ratio <= ONSCREEN_AGREE_RATIO;
  }

  /* ------------------------------------------------------------------ *
   * 4b. Fill witness — no single source may resurrect a dead price
   * ------------------------------------------------------------------ */

  // Field report (chatcabal, Axiom, a migrated Pump-AMM coin): the market
  // crashed ~30K -> ~8K, his DCA buy filled honestly at the crashed price,
  // and the SELL one minute later filled at the pre-crash level — a loss
  // rendered as +167%. Whichever source served that number (a lagging
  // aggregator refresh, a frozen feed's last accepted tick, a wrong pool
  // read), the corruption shares one shape: the chosen fill price
  // contradicted market evidence this same tab had JUST accepted as money.
  // The discipline: a fill-time candidate that diverges from recent
  // evidence by more than FILL_WITNESS_RATIO must be confirmed by an
  // INDEPENDENT second source before it can price a fill. No witness, or a
  // dissenting witness, refuses the fill — an honest refusal beats a 2.7x
  // phantom win, and a refused click can be re-clicked two seconds later.
  //
  // The window is generous (memecoins genuinely 4x in a minute — a REAL
  // move is confirmed by any fresh witness and fills normally); the ratio
  // is what a 1s chart cannot do between two consecutive honest reads.
  // F-55 (Rems 3x/wk, husm, Tanza): the coin RUGS, the pool drains to dust,
  // and the next resolver print from that dust pool re-marks the open bag at
  // an absurd price — a dead position rendered gloriously green. Liquidity
  // is the honest discriminator: a rug empties the pool, and you cannot sell
  // into a drained pool AT A HIGHER PRICE. An up-print from a collapsed pool
  // is the phantom (refuse the mark; the position keeps its last honest
  // mark); a DOWN-print is the honest rug mark and must ALWAYS pass — a rug
  // is supposed to hurt. Missing liquidity data (null) means the guard
  // stands aside; it never blocks on absence.
  var RUG_GUARD_DUST_USD = 2000;      // below this a pool is "collapsed"
  var RUG_GUARD_UP_RATIO = 1.25;      // +25% print from a dust pool = phantom

  /** May this resolver print re-mark a position? Pure, no state. */
  function rugGuardVerdict(nextNative, prevNative, liquidityUsd) {
    if (!(nextNative > 0) || !(prevNative > 0)) return 'pass';
    if (!(Number(liquidityUsd) > 0)) return 'pass';       // no data, no guard
    if (Number(liquidityUsd) > RUG_GUARD_DUST_USD) return 'pass'; // pool healthy
    // Collapsed pool. Down-prints are honest rug marks; up-prints are dust.
    return nextNative > prevNative * RUG_GUARD_UP_RATIO ? 'refuse' : 'pass';
  }

  var FILL_WITNESS_WINDOW_MS = 120000;
  var FILL_WITNESS_RATIO = 2;
  var FILL_WITNESS_AGREE_RATIO = 1.6;

  // F-57: the 2x ratio above was calibrated for the on-screen feed, where a
  // genuine memecoin move really can 4x between two honest reads — so a wide
  // band is the price of not refusing real moves. An AGGREGATOR quote has no
  // such excuse. It is a periodic snapshot of a market this tab is already
  // watching tick by tick, and when it disagrees with evidence the tab just
  // accepted as money, the overwhelmingly likely explanation is that the
  // snapshot is behind — not that the market moved 40% between two reads the
  // page feed somehow both missed. Everything from ONSCREEN_AGREE_RATIO up to
  // FILL_WITNESS_RATIO answered to nobody on this path; 1.4x is where the
  // field report landed ("filled me at 35k while the coin is moving around
  // 25k"). These sources now answer to a band that a lagging read fails and
  // an honest one passes.
  var AGGREGATOR_WITNESS_RATIO = 1.15;
  var AGGREGATOR_SOURCES = {
    resolver: 1, 'action-resolver': 1, jupiter: 1, gmgn: 1, pumpfun: 1,
  };

  /** True for a price that came from a periodic snapshot rather than the
   *  page's own live feed or the chain. */
  function isAggregatorSource(source) {
    return Boolean(AGGREGATOR_SOURCES[String(source)]);
  }

  /** The divergence a candidate from this source may show before it must be
   *  corroborated. Unknown sources keep the wide, permissive band. */
  function witnessRatioFor(source) {
    return isAggregatorSource(source) ? AGGREGATOR_WITNESS_RATIO : FILL_WITNESS_RATIO;
  }

  /** Does this candidate need a second, independent source to vouch for it?
   *  `source` is optional — omitted, every candidate gets the wide band, which
   *  is the pre-F-57 behavior. */
  function needsFillWitness(candidateNative, evidenceNative, evidenceAgeMs, source) {
    if (!(candidateNative > 0) || !(evidenceNative > 0)) return false;
    if (!(evidenceAgeMs >= 0) || evidenceAgeMs > FILL_WITNESS_WINDOW_MS) return false;
    var ratio = candidateNative > evidenceNative
      ? candidateNative / evidenceNative
      : evidenceNative / candidateNative;
    return ratio > witnessRatioFor(source);
  }

  /** A missing witness never confirms: a violent divergence that no second
   * source can corroborate is exactly a guess, and a guess must not fill. */
  function witnessAgrees(candidateNative, witnessNative) {
    if (!(candidateNative > 0) || !(witnessNative > 0)) return false;
    var ratio = candidateNative > witnessNative
      ? candidateNative / witnessNative
      : witnessNative / candidateNative;
    return ratio <= FILL_WITNESS_AGREE_RATIO;
  }

  // F-48 (Terp, lute.gg, WhiteBull on the MC axis): the chart and the S mark
  // sat at ~41K when he clicked sell; the engine booked 33.1K — a win
  // rendered as -9.6%. The screen had been quiet for over 600ms so the F-33
  // arbitration never armed, and at 1.24x the divergence sat under the F-47
  // witness ratio: the chain read priced the fill UNCHECKED — value-lag
  // wearing a fresh timestamp. The gap zone was structural: divergence
  // between ONSCREEN_AGREE_RATIO and FILL_WITNESS_RATIO on a quiet screen
  // answered to nobody.
  //
  // The discipline: a chain candidate arriving on a quiet screen must still
  // answer to the freshest evidence this tab accepted as money (the F-47
  // stream — validated ticks and committed fills, never resolver adoptions).
  // Contradiction does not refuse the fill; it DEMOTES the chain read, and
  // the ladder re-prices from sources that can vouch for themselves (a fresh
  // page tick, the aggregator, the bounded snapshot of what the trader was
  // looking at). A REAL move is confirmed by those sources and fills at the
  // moved level; a lagging read never prices a fill by default. The band is
  // wider than ONSCREEN_AGREE_RATIO because the evidence may be seconds old
  // and honest drift is real, but tight enough to catch both field reports
  // of a wrong chain read (F-33's 13%, F-48's 24%).
  var ONCHAIN_EVIDENCE_WINDOW_MS = 30000;
  var ONCHAIN_EVIDENCE_AGREE_RATIO = 1.10;

  /** On a quiet screen, does this chain candidate contradict the market
   * evidence this tab most recently accepted as money? */
  function onchainContradictsEvidence(candidateNative, evidenceNative, evidenceAgeMs) {
    if (!(candidateNative > 0) || !(evidenceNative > 0)) return false;
    if (!(evidenceAgeMs >= 0) || evidenceAgeMs > ONCHAIN_EVIDENCE_WINDOW_MS) return false;
    var ratio = candidateNative > evidenceNative
      ? candidateNative / evidenceNative
      : evidenceNative / candidateNative;
    return ratio > ONCHAIN_EVIDENCE_AGREE_RATIO;
  }

  // F-50 (featurepass, lute, BONK): lute displays a ~10x-scaled cap (its
  // supply convention), and with ACCEPT_RATIO at 20x a chart/title tick at
  // that scale VALIDATES against the anchor and rescales the whole token —
  // the panel was watched flip-flopping $214M ⇄ $2.15B, and an immediate
  // round trip booked -90.2% (buy leg priceSource=padre-chart-bar at 2.15B,
  // sell leg ws at 214.6M, 3.9s apart, both fresh). The 20x band itself is
  // right — memecoins genuinely 10x between anchor refreshes — so the
  // discipline is CONTINUITY: a real 10x arrives as many small steps; a
  // scale flip arrives as ONE step. A single tick may not move the market
  // more than SCALE_STEP_RATIO from the freshest accepted evidence — unless
  // the newcomer sits CLOSER to the resolver anchor than the stream does,
  // in which case the STREAM was the wrong scale (cold-start on the wrong
  // side) and snapping back to the anchor's side is the honest move. The
  // anchor is the arbiter precisely because live ticks are forbidden to
  // drift it.
  var SCALE_STEP_RATIO = 3;
  var SCALE_STEP_WINDOW_MS = 15000;

  function ratioOf(a, b) {
    return a > b ? a / b : b / a;
  }

  /** May this tick move the accepted stream to its value? 'ok' | 'scale-step'. */
  function scaleStepVerdict(candidateNative, lastNative, lastAgeMs, anchorNative) {
    if (!(candidateNative > 0) || !(lastNative > 0)) return 'ok';
    if (!(lastAgeMs >= 0) || lastAgeMs > SCALE_STEP_WINDOW_MS) return 'ok';
    if (ratioOf(candidateNative, lastNative) <= SCALE_STEP_RATIO) return 'ok';
    if (anchorNative > 0
      && ratioOf(candidateNative, anchorNative) < ratioOf(lastNative, anchorNative)) {
      return 'ok'; // the newcomer is the anchor's side — the stream was the wrong scale
    }
    return 'scale-step';
  }

  /* ------------------------------------------------------------------ *
   * 5. Live position mark
   * ------------------------------------------------------------------ */

  /**
   * Compute everything the position card displays from a position and the
   * current price. Pure, so the P&L shown on screen is exactly what tests
   * assert — this is the number the user watches tick.
   */
  /**
   * The money story of one open round: what went in, what has come back, and
   * what is still on the table.
   *
   * positionMark answers "what is this worth now"; this answers "am I ahead",
   * which is the question a partially-sold bag actually raises. A position
   * sold down to house money shows a red unrealized P&L on the remainder
   * while the round as a whole is up — the card said one thing and the trader
   * meant the other.
   *
   * Derived, never stored (doctrine: derive, don't store). Sells are matched
   * by sessionId, which is stamped per position-open, so a previous round in
   * the same token cannot leak in. Chains predating sessionIds fall back to
   * mint, bounded by openedAt for the same reason.
   */
  function positionLedger(journal, pos, remainingValueSol) {
    if (!pos) return null;
    var list = Array.isArray(journal) ? journal : [];
    var sid = pos.sessionId || null;
    var openedAt = Number(pos.openedAt) || 0;
    var soldSol = 0;
    var realizedSol = 0;
    var sells = 0;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || t.side !== 'sell') continue;
      var mine = sid && t.sessionId ? t.sessionId === sid : t.mint === pos.mint;
      if (!mine) continue;
      // A sell older than this position belongs to a previous round.
      if (openedAt && Number(t.ts) < openedAt) continue;
      soldSol += Number(t.solNet) || 0;
      realizedSol += Number(t.pnlSol) || 0;
      sells += 1;
    }

    var invested = Number(pos.investedSol) || 0;
    var remaining = Number(remainingValueSol) || 0;
    // Gross in, versus everything that has come back plus what is still held.
    var change = soldSol + remaining - invested;
    return {
      investedSol: invested,
      soldSol: soldSol,
      remainingSol: remaining,
      realizedSol: realizedSol,
      changeSol: change,
      changePct: invested > 0 ? (change / invested) * 100 : 0,
      sells: sells,
      // Has the round already returned more than it cost? The state the
      // "sell initial" move exists to reach.
      houseMoney: soldSol >= invested && invested > 0,
    };
  }

  /**
   * How much of the bag to sell so the money that went in has come back.
   *
   * "Sell your initial" is a real move with a real number behind it, and the
   * number is not "half". Costs come off the top: to NET back what you put
   * in you must sell MORE than the naive fraction, and by exactly how much
   * depends on the fee, the flat tx cost and the slippage the fill will take.
   * Getting that wrong leaves the trader believing they are de-risked when
   * they are still a few percent short — the one belief this feature exists
   * to make true.
   *
   * Solves for gross from the net that is actually wanted:
   *   net   = gross - gross*fee - flat
   *   gross = (need + flat) / (1 - fee)
   * against the slipped price the engine will really fill at.
   *
   * Returns null when there is nothing to do, or { fraction, needSol,
   * shortfall } — shortfall true when the WHOLE bag cannot cover it, which
   * is a fact to state rather than a button to grey out silently.
   */
  function sellInitialPlan(pos, ledger, priceNative, costs) {
    if (!pos || !(pos.qty > 0) || !ledger) return null;
    var px = Number(priceNative) > 0 ? Number(priceNative) : Number(pos.lastPriceNative);
    if (!(px > 0)) return null;

    var need = Number(ledger.investedSol) - Number(ledger.soldSol);
    if (!(need > 0)) return null;   // already whole — nothing to recover

    var c = costs || {};
    var feeRate = Math.min(0.95, Math.max(0, (Number(c.feeBps) || 0) / 10000));
    var slipRate = Math.min(0.95, Math.max(0, (Number(c.slippageBps) || 0) / 10000));
    var flat = Math.max(0, Number(c.flatSol) || 0);

    // The engine fills a sell at the slipped price, so that is the price this
    // plan has to be built on — not the quote on screen.
    var fillPx = px * (1 - slipRate);
    if (!(fillPx > 0)) return null;

    var grossNeeded = (need + flat) / (1 - feeRate);
    var qtyNeeded = grossNeeded / fillPx;
    var fraction = qtyNeeded / pos.qty;

    return {
      needSol: need,
      // Capped at the whole bag: a fraction over 1 would be silently clamped
      // by the engine anyway, and the caller has to be able to SAY so.
      fraction: Math.min(1, fraction),
      shortfall: fraction > 1,
    };
  }
  function positionMark(pos, priceNative, priceUsd) {
    if (!pos || !(pos.qty > 0)) return null;
    var px = Number(priceNative) > 0 ? Number(priceNative) : Number(pos.lastPriceNative);
    if (!(px > 0)) return null;

    var value = pos.qty * px;
    var pnl = value - pos.costSol;
    var pct = pos.costSol > 0 ? (pnl / pos.costSol) * 100 : 0;
    var avgEntry = pos.qty > 0 ? pos.costSol / pos.qty : 0;

    // Derive the SOL->USD rate from the token's own two quotes so the USD P&L
    // stays consistent with the SOL P&L.
    var rate = Number(priceUsd) > 0 && Number(priceNative) > 0
      ? Number(priceUsd) / Number(priceNative)
      : null;

    return {
      qty: pos.qty,
      avgEntry: avgEntry,
      price: px,
      valueSol: value,
      pnlSol: pnl,
      pnlPct: pct,
      pnlUsd: rate !== null ? pnl * rate : null,
      up: pnl >= 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. Multi-position tracking (the positions bar)
   * ------------------------------------------------------------------ */

  /**
   * Parse a batched Dexscreener /tokens/<a>,<b>,... response into a
   * mint -> quote map, choosing the deepest-liquidity Solana pair per mint.
   *
   * The batch response mixes pairs for every requested mint together, so
   * grouping by baseToken.address is required; taking array order would quote
   * a token from whichever shallow pool happened to come back first.
   */
  function pricesFromBatch(payload, opts) {
    const out = {};
    if (!payload || typeof payload !== 'object') return out;
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
    // Multichain: one batch call carries ONE chain family (the resolver
    // groups by chain); default remains solana with SOL-native usability.
    const chain = (opts && opts.chain) || 'solana';
    const chainId = chainIdFor(chain);
    const foreign = chain !== 'solana';

    const byMint = new Map();
    for (const pair of pairs) {
      if (!pair || pair.chainId !== chainId) continue;
      if (foreign ? !(Number(pair.priceUsd) > 0) : !(Number(pair.priceNative) > 0)) continue;
      const mint = pair.baseToken && pair.baseToken.address;
      if (!mint) continue;
      const prev = byMint.get(mint);
      const liq = Number((pair.liquidity && pair.liquidity.usd) || 0);
      const prevLiq = prev ? Number((prev.liquidity && prev.liquidity.usd) || 0) : -1;
      if (!prev || liq > prevLiq) byMint.set(mint, pair);
    }

    for (const [mint, pair] of byMint) {
      const quote = normalizePair(pair, mint, opts);
      if (quote) out[mint] = quote;
    }
    return out;
  }

  /**
   * Build the rows the positions bar renders, newest position first.
   *
   * `livePrices` is an optional mint -> { priceNative, priceUsd } map from the
   * batch poller. When a mint has no fresh quote the stored mark is used and
   * the row is flagged `stale`, so the bar never invents a number.
   *
   * `activeQuote` is the page feed's own current quote for `activeMint`.
   * O-30: the batch poller deliberately skips the on-screen token (its price
   * comes from the page), but its LAST batch quote used to linger in
   * `livePrices` and outrank the live feed — so the bar chip and the position
   * card marked the same bag from two different venues and disagreed about
   * its P&L. The token on screen is priced by what the screen shows, always.
   */
  function positionRows(state, livePrices, activeMint, activeQuote) {
    const positions = (state && state.positions) || {};
    const prices = livePrices || {};
    const rows = [];

    for (const mint of Object.keys(positions)) {
      const pos = positions[mint];
      if (!pos || !(pos.qty > 0)) continue;
      const live = activeMint && mint === activeMint
        && activeQuote && Number(activeQuote.priceNative) > 0
        ? activeQuote
        : prices[mint];
      const priceNative = live && Number(live.priceNative) > 0
        ? Number(live.priceNative)
        : Number(pos.lastPriceNative);
      const priceUsd = live && Number(live.priceUsd) > 0
        ? Number(live.priceUsd)
        : Number(pos.lastPriceUsd) || null;

      const mark = positionMark(pos, priceNative, priceUsd);
      if (!mark) continue;

      rows.push({
        mint,
        symbol: pos.symbol || shortAddress(mint),
        site: pos.site || null,
        pairAddress: pos.pairAddress || null,
        qty: mark.qty,
        priceNative: mark.price,
        valueSol: mark.valueSol,
        pnlSol: mark.pnlSol,
        pnlPct: mark.pnlPct,
        up: mark.up,
        openedAt: Number(pos.openedAt) || 0,
        active: Boolean(activeMint) && mint === activeMint,
        stale: !(live && Number(live.priceNative) > 0),
      });
    }

    rows.sort((a, b) => b.openedAt - a.openedAt);
    return rows;
  }

  /** Aggregate totals for the bar's summary segment. */
  function portfolioSummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let valueSol = 0;
    let pnlSol = 0;
    let costSol = 0;
    let winners = 0;

    for (const row of list) {
      valueSol += Number(row.valueSol) || 0;
      pnlSol += Number(row.pnlSol) || 0;
      costSol += (Number(row.valueSol) || 0) - (Number(row.pnlSol) || 0);
      if ((Number(row.pnlSol) || 0) > 0) winners += 1;
    }

    return {
      count: list.length,
      valueSol,
      pnlSol,
      pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : 0,
      up: pnlSol >= 0,
      winners,
      losers: list.length - winners,
      anyStale: list.some((row) => row.stale),
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. Header display fields
   * ------------------------------------------------------------------ */

  function shortAddress(addr) {
    if (typeof addr !== 'string' || addr.length <= 10) return addr || '';
    return addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  var SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

  function toSubscript(n) {
    var out = '';
    var s = String(n);
    for (var i = 0; i < s.length; i++) out += SUBSCRIPT_DIGITS[Number(s[i])];
    return out;
  }

  /**
   * Human-readable token price.
   *
   * Memecoins live at 1e-9. `toExponential` renders that as "3.9690e-8", which
   * users reported as unreadable noise, and raw decimals render as an
   * uncountable run of zeros. Every Solana terminal solves this the same way —
   * subscript-zero notation — so PaperTrench matches that convention:
   *
   *   0.00000003969  ->  0.0₇3969
   *   0.00234        ->  0.00234
   *   1.5            ->  1.5
   */
  function formatPrice(p) {
    var value = Number(p);
    if (!(value > 0) || !isFinite(value)) return '';
    if (value >= 0.001) return String(Number(value.toPrecision(6)));

    // Count the zeros between the decimal point and the first significant digit.
    var exponent = Math.floor(Math.log10(value));
    var leadingZeros = -exponent - 1;
    var significant = value / Math.pow(10, exponent);
    var digits = String(Number(significant.toFixed(3))).replace('.', '');

    if (leadingZeros < 4) return String(Number(value.toPrecision(4)));
    return '0.0' + toSubscript(leadingZeros) + digits;
  }

  /**
   * Human-readable market cap / USD magnitude. Never scientific notation, and
   * never a wall of unseparated digits.
   */
  function formatMarketCap(n) {
    var value = Number(n);
    if (!(value > 0) || !isFinite(value)) return '';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(2);
  }

  /** USD price of one token, using the same readable convention as formatPrice. */
  function formatUsdPrice(p) {
    var text = formatPrice(p);
    return text ? '$' + text : '';
  }

  /**
   * Derive exactly what the overlay header shows. Kept pure so the display
   * contract is testable without building a Shadow DOM.
   *
   * `title` is the human name/symbol and `address` is the contract — they are
   * DISTINCT fields. The prior build printed the truncated CA in both, which is
   * the regression criterion 3 guards against.
   */
  function headerFields(token, opts) {
    if (!token || !token.mint) {
      return {
        title: 'No token',
        address: '',
        priceText: '—',
        pending: true,
        hasTrustedPrice: false,
        stale: false,
      };
    }

    const symbol = typeof token.symbol === 'string' ? token.symbol.trim() : '';
    const name = typeof token.name === 'string' ? token.name.trim() : '';
    // A brand-new launch carries no symbol yet on the page feed — but the
    // mint IS the identity. Show it shortened (DezX…B263) rather than the
    // dead-end "Unknown token", which read as a failure to detect the coin
    // at all (live report: sniping a new pair). The full CA stays on its
    // own line below; titleIsAddress stays false so layout treats it as a
    // name, and the title heals itself the moment a tick carries a symbol.
    const shortMint = typeof token.mint === 'string' && token.mint.length > 10
      ? token.mint.slice(0, 4) + '…' + token.mint.slice(-4)
      : (token.mint || '');
    const title = symbol || name || shortMint || 'Unknown token';

    const hasTrustedPrice = Number(token.priceNative) > 0;
    // A brand-new launch is not an error state — it is a token no price source
    // has indexed YET. Saying so plainly beats a generic spinner, because the
    // user is deciding whether to wait or move on.
    const waitingMs = opts && opts.pendingSince ? Math.max(0, ((opts && opts.now) || Date.now()) - opts.pendingSince) : 0;
    const searching = !hasTrustedPrice && waitingMs > 1200;

    /* Traders quote memecoins by market cap, not unit price. Nobody says
     * "I bought at 0.0₇3969" — they say "I bought at 240K". So market cap is
     * the headline figure whenever it is known, and the unit price moves to
     * the secondary line for the rare case someone wants it. */
    const hasMcap = Number(token.mcap) > 0;
    const mcapText = hasMcap ? formatMarketCap(Number(token.mcap)) : '';
    const priceText = hasMcap
          ? mcapText
          : (hasTrustedPrice
            ? formatPrice(Number(token.priceNative)) + ' SOL'
            // D-38: the old fresh-launch wait-line is gone for good. It read
            // like the coin was broken while the terminal already printed it,
            // and the BUY clicks straight to the chain anyway. The unpriced
            // header is now the neutral live-fetch line only.
            : 'Fetching live price…');

    // A price we hold but can no longer refresh must be visibly marked, so a
    // frozen quote is never mistaken for a live one.
    var now = (opts && opts.now) || Date.now();
    var stale = hasTrustedPrice && opts && opts.lastPriceAt !== undefined
      ? isPriceStale(opts.lastPriceAt, now)
      : false;

    return {
      title,
      address: shortAddress(token.mint),
      fullAddress: token.mint,
      priceText,
      // What the headline number actually is, so the UI can label it honestly.
      priceIsMarketCap: hasMcap,
      mcapText,
      priceUsdText: Number(token.priceUsd) > 0 ? '$' + formatPrice(Number(token.priceUsd)) : '',
      pending: !hasTrustedPrice,
      hasTrustedPrice,
      stale,
      searching,
      waitingMs,
      // A token resolved only through Jupiter has no observed pool quote yet.
      freshLaunch: Boolean(token.priceSource === 'jupiter'),
      // Guard for the exact prior regression: name and address must differ.
      // D-41: the SHORT mint (DezX…B263) as a fallback title is identity
      // display, not the CA dump this guard exists for — only the full
      // address as title trips it.
      titleIsAddress: title === token.mint,
    };
  }

  var api = {
    pickBestPair,
    normalizePair,
    rugGuardVerdict,
    tokenFromPayload,
    validateTick,
    bootstrapTick,
    withinBand,
    shouldRequote,
    isPriceStale,
    fillSourcesAgree,
    needsFillWitness,
    witnessRatioFor,
    isAggregatorSource,
    witnessAgrees,
    onchainContradictsEvidence,
    scaleStepVerdict,
    FILL_WITNESS_WINDOW_MS,
    FILL_WITNESS_RATIO,
    FILL_WITNESS_AGREE_RATIO,
    AGGREGATOR_WITNESS_RATIO,
    ONCHAIN_EVIDENCE_WINDOW_MS,
    ONCHAIN_EVIDENCE_AGREE_RATIO,
    SCALE_STEP_RATIO,
    SCALE_STEP_WINDOW_MS,
    isPumpFamily,
    bootstrapSupply,
    bootstrapSupplyInfo,
    rugVerdict,
    parsePresetList,
    positionMark,
    tokenFromJupiter,
    solUsdFromJupiter,
    jupiterEntry,
    preferResolved,
    tokenFromVenueQuote,
    tokenFromGmgn,
    tokenFromPumpfun,
    WSOL_MINT,
    CHAIN_MAP,
    sameAddress,
    pricesFromBatch,
    positionRows,
    positionLedger,
    sellInitialPlan,
    portfolioSummary,
    headerFields,
    shortAddress,
    formatPrice,
    formatMarketCap,
    formatUsdPrice,
    ACCEPT_RATIO,
    ONSCREEN_AGREE_RATIO,
    POLL_INTERVAL_MS,
    FEED_FRESH_MS,
    STALE_AFTER_MS,
    ANCHOR_REFRESH_MS,
  };

  // Always install the browser global; only export under CommonJS when present.
  if (typeof window !== 'undefined') window.PaperQuote = api;
  if (typeof self !== 'undefined') self.PaperQuote = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
