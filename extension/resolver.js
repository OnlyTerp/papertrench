/* PaperTrench — token resolver (I/O layer).
 *
 * Turns an address taken from a page URL (either a token mint OR an LP/pair
 * address) into a verified token record + anchor quote, using the free
 * Dexscreener API (no key, no registration).
 *
 * All decision logic lives in quote.js as pure functions; this file is only
 * the network wrapper around them, so the interesting behavior stays testable
 * without a network.
 */
(function () {
  'use strict';

  var Q = (typeof window !== 'undefined' && window.PaperQuote)
    || (typeof self !== 'undefined' && self.PaperQuote)
    || (typeof module !== 'undefined' && module.exports ? require('./quote.js') : null);

  var BASE = 'https://api.dexscreener.com/latest/dex';
  var TTL_MS = 60000;
  var cache = new Map(); // address -> { at, data }

  function cacheGet(address, maxAgeMs) {
    var hit = cache.get(address);
    if (!hit) return null;
    var age = Date.now() - hit.at;
    if (age >= TTL_MS) { cache.delete(address); return null; }
    // A caller about to FILL a trade at this price can demand tighter
    // freshness than the display TTL. The entry stays cached for display use.
    if (typeof maxAgeMs === 'number' && maxAgeMs >= 0 && age > maxAgeMs) return null;
    return hit.data;
  }

  function cachePut(data) {
    if (!data) return;
    var at = Date.now();
    if (data.mint) cache.set(data.mint, { at: at, data: data });
    if (data.pairAddress) cache.set(data.pairAddress, { at: at, data: data });
  }

  async function getJson(url, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 4000) : null;
    try {
      var res = await fetch(url, ctrl ? { cache: 'no-store', signal: ctrl.signal } : { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  var JUP = 'https://lite-api.jup.ag/tokens/v2/search';

  // D-38: the venue first-price layer. A launch's first minutes live on the
  // terminal's OWN servers before any aggregator indexes them, and the chart
  // on screen is drawn from exactly those. GMGN's quotation API (their public
  // docs endpoint) and pump.fun's coin API are the same sources the rendered
  // pages read; both are fetched only AFTER the aggregators stay silent, so
  // the common path pays nothing. They are mint-keyed Solana quotes — a pair
  // address simply gets null back, which is the honest non-answer.
  var GMGN_QUOTE_URL = 'https://gmgn.ai/defi/quotation/v1/token/sol/';
  var PUMP_COIN_URL = 'https://pump.fun/api/0/coins/';

  /** Race the two venue quotation APIs for a mint neither aggregator knows. */
  async function resolveViaVenues(address) {
    var rate = await solUsd().catch(function () { return 0; });
    if (!(rate > 0)) return null;
    var payloads = await Promise.all([
      getJson(GMGN_QUOTE_URL + address, 4000).catch(function () { return null; }),
      getJson(PUMP_COIN_URL + address, 4000).catch(function () { return null; }),
    ]);
    return Q.tokenFromGmgn(payloads[0], address, rate)
      || Q.tokenFromPumpfun(payloads[1], address, rate);
  }

  // SOL/USD is needed to convert Jupiter's USD-only quotes into the SOL prices
  // the engine trades in. It moves slowly relative to a memecoin, so a short
  // cache keeps fresh-launch resolution to a single round trip.
  var solUsdCache = { at: 0, value: 0 };
  var SOL_USD_TTL_MS = 30000;

  function cachedSolUsd() {
    var now = Date.now();
    return now - solUsdCache.at < SOL_USD_TTL_MS && solUsdCache.value > 0
      ? solUsdCache.value
      : 0;
  }

  function jupiterUrl(query) {
    return JUP + '?query=' + encodeURIComponent(query);
  }

  /**
   * Ask Jupiter for a token AND the SOL reference in one request.
   * Returns { record, solUsd } — record is null when Jupiter doesn't know it.
   */
  async function resolveViaJupiter(address) {
    var cachedRate = cachedSolUsd();
    var fresh = cachedRate > 0;
    // Bundle WSOL into the same query when the cached rate is stale, so a
    // brand-new coin still costs exactly one request.
    var query = fresh ? address : address + ',' + Q.WSOL_MINT;
    var payload = await getJson(jupiterUrl(query), 4000);
    if (!payload) return { record: null, solUsd: cachedRate };

    var solUsd = fresh ? cachedRate : Q.solUsdFromJupiter(payload);
    if (solUsd > 0) solUsdCache = { at: Date.now(), value: solUsd };
    if (!(solUsd > 0)) return { record: null, solUsd: 0 };

    return { record: Q.tokenFromJupiter(payload, address, solUsd), solUsd: solUsd };
  }

  /**
   * Resolve an address that may be a mint or a pair address.
   *
   * All three lookups are issued together. Dexscreener gives the venue price
   * for established tokens; Jupiter covers the first seconds of a launch, when
   * Dexscreener still returns `pairs: null`. Racing them means a sniper is not
   * blocked waiting for whichever source is slower to index.
   */
  async function resolve(address, opts) {
    if (!address) return null;

    var cached = cacheGet(address, opts && opts.maxAgeMs);
    if (cached) return cached;

    var chain = (opts && opts.chain) || 'solana';
    if (chain !== 'solana') {
      // Multichain (docs/MULTICHAIN.md): Dexscreener's /tokens/ endpoint is
      // chain-agnostic and covers every fomo chain (live-verified, incl.
      // robinhood). Jupiter and the Solana pair lookup are SKIPPED, not
      // failed — they can only answer for Solana. The SOL/USD rate rides
      // along so the record's SOL price is derived and recorded honestly.
      var foreign = await Promise.all([
        getJson(BASE + '/tokens/' + address),
        solUsd().catch(function () { return 0; }),
      ]);
      var record = Q.tokenFromPayload(foreign[0], address, { chain: chain, solUsd: foreign[1] });
      if (record) {
        if (!record.mint) record.mint = address;
        cachePut(record);
      }
      return record;
    }

    var results = await Promise.all([
      getJson(BASE + '/tokens/' + address),
      getJson(BASE + '/pairs/solana/' + address),
      resolveViaJupiter(address).catch(function () { return { record: null, solUsd: 0 }; }),
    ]);
    var byToken = results[0];
    var byPair = results[1];
    var viaJup = results[2] || { record: null };

    // A pair lookup is unambiguous, so prefer it when it returned something.
    // Jupiter's combined request may already have supplied a fresh SOL/USD
    // rate even when its token leg timed out; keep that rate for Dexscreener.
    var dexRate = cachedSolUsd() || Number(viaJup.solUsd) || 0;
    var dexOpts = { solUsd: dexRate };
    var dexData = Q.tokenFromPayload(byPair, address, dexOpts)
      || Q.tokenFromPayload(byToken, address, dexOpts);
    // A Dexscreener payload can arrive while the bundled Jupiter rate is
    // unavailable. Give one cache-first rate request a chance before
    // abandoning a USD-quoted pool for the venue fallback.
    if (!dexData && !(dexRate > 0) && (byPair || byToken)) {
      dexRate = await solUsd().catch(function () { return 0; });
      if (dexRate > 0) {
        dexOpts = { solUsd: dexRate };
        dexData = Q.tokenFromPayload(byPair, address, dexOpts)
          || Q.tokenFromPayload(byToken, address, dexOpts);
      }
    }
    var data = Q.preferResolved(dexData, viaJup.record);
    if (!data) {
      // Aggregators silent: the terminal's own quotation API may already
      // price this launch (the chart on screen draws from it). Solana-only,
      // and only on the failure path — the common path pays nothing.
      var siteData = await resolveViaVenues(address).catch(function () { return null; });
      data = siteData || null;
    }
    if (data) {
      if (!data.mint) data.mint = address;
      cachePut(data);
    }
    return data;
  }

  /** Re-quote an already-resolved token (slow safety net behind the live feed). */
  async function refresh(token) {
    if (!token) return null;

    // Multichain: an off-Solana token re-quotes through the same
    // chain-filtered /tokens/ path it resolved through — Jupiter and the
    // Solana pair endpoint can never know it.
    if (token.chain && token.chain !== 'solana') {
      var foreign = await Promise.all([
        getJson(BASE + '/tokens/' + token.mint),
        solUsd().catch(function () { return 0; }),
      ]);
      var record = Q.tokenFromPayload(foreign[0], token.mint, { chain: token.chain, solUsd: foreign[1] });
      if (record) { cachePut(record); return record; }
      return null;
    }

    // A token first resolved through Jupiter is, by definition, one that
    // Dexscreener did not have. Re-quoting it there would return nothing and
    // freeze the price, so keep using the source that actually knows it until
    // Dexscreener catches up.
    if (token.priceSource === 'jupiter') {
      var viaJup = await resolveViaJupiter(token.mint).catch(function () { return { record: null }; });
      if (viaJup && viaJup.record) { cachePut(viaJup.record); return viaJup.record; }
      // Dexscreener may have indexed it by now; fall through and try.
    }

    var json = token.pairAddress
      ? await getJson(BASE + '/pairs/solana/' + token.pairAddress)
      : await getJson(BASE + '/tokens/' + token.mint);
    var rate = cachedSolUsd();
    if (!(rate > 0)) rate = await solUsd().catch(function () { return 0; });
    var data = json
      ? Q.tokenFromPayload(json, token.mint, { solUsd: rate })
      : null;
    if (data) { cachePut(data); return data; }

    // Last resort for a token neither source indexed under its pair address.
    var retry = await resolveViaJupiter(token.mint).catch(function () { return { record: null }; });
    if (retry && retry.record) { cachePut(retry.record); return retry.record; }
    // The venue quotation layer rounds out the ladder: a coin the aggregators
    // still do not list may already be priced by the terminal that charts it.
    var venueRetry = await resolveViaVenues(token.mint).catch(function () { return null; });
    if (venueRetry) { cachePut(venueRetry); return venueRetry; }
    return null;
  }

  /**
   * Price several mints in as few requests as possible.
   *
   * Dexscreener's /tokens/ endpoint accepts a comma-separated list and returns
   * every matching pair in one payload, so N open positions cost roughly
   * ceil(N / CHUNK) requests instead of N. This is what lets the positions bar
   * track tokens whose charts are not on screen.
   */
  var BATCH_CHUNK = 25;

  async function batchPrices(mints, chainByMint) {
    var unique = [];
    var seen = Object.create(null);
    for (var i = 0; i < (mints || []).length; i++) {
      var m = mints[i];
      if (typeof m === 'string' && m && !seen[m]) { seen[m] = 1; unique.push(m); }
    }
    if (!unique.length) return {};

    // Multichain: one batch call carries one chain family, because the same
    // 0x address can exist on several EVM chains and the parser must know
    // which one the position actually lives on.
    var groups = Object.create(null);
    for (var g = 0; g < unique.length; g++) {
      var chain = (chainByMint && chainByMint[unique[g]]) || 'solana';
      (groups[chain] = groups[chain] || []).push(unique[g]);
    }
    var rate = await solUsd().catch(function () { return 0; });

    var out = {};
    var chainNames = Object.keys(groups);
    for (var c = 0; c < chainNames.length; c++) {
      var chainName = chainNames[c];
      var list = groups[chainName];
      var chunks = [];
      for (var j = 0; j < list.length; j += BATCH_CHUNK) {
        chunks.push(list.slice(j, j + BATCH_CHUNK));
      }
      var payloads = await Promise.all(chunks.map(function (chunk) {
        return getJson(BASE + '/tokens/' + chunk.join(','), 6000);
      }));
      var parseOpts = { solUsd: rate };
      if (chainName !== 'solana') parseOpts.chain = chainName;
      for (var k = 0; k < payloads.length; k++) {
        var parsed = Q.pricesFromBatch(payloads[k], parseOpts);
        for (var mint in parsed) {
          if (Object.prototype.hasOwnProperty.call(parsed, mint)) {
            out[mint] = parsed[mint];
            cachePut(parsed[mint]);
          }
        }
      }
    }
    return out;
  }

  /**
   * Expose the cached SOL/USD rate so the UI can convert on-screen USD prices
   * into SOL-denominated fills while a brand-new coin is still unindexed. The
   * rate is fetched alongside every Jupiter resolve and refreshed on demand.
   */
  async function solUsd() {
    var now = Date.now();
    var cachedRate = cachedSolUsd();
    if (cachedRate > 0) return cachedRate;

    var payload = await getJson(jupiterUrl(Q.WSOL_MINT), 4000);
    if (!payload) return 0;

    var rate = Q.solUsdFromJupiter(payload);
    if (rate > 0) solUsdCache = { at: now, value: rate };
    return rate || 0;
  }

  function clearCache() { cache.clear(); }

  var api = {
    resolve: resolve,
    refresh: refresh,
    batchPrices: batchPrices,
    clearCache: clearCache,
    solUsd: solUsd,
    BASE: BASE,
    BATCH_CHUNK: BATCH_CHUNK,
  };

  if (typeof window !== 'undefined') window.PaperTrenchResolver = api;
  if (typeof self !== 'undefined') self.PaperTrenchResolver = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
