/* predict-sites.test.js — URL gating locks for prediction venues
 *
 * Verifies that detect() correctly gates which pages mount each venue's
 * adapter and refuses non-market surfaces (homepage, portfolio, etc.).
 *
 * Framework: node:test + node:assert/strict (no deps).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/* Bootstrap: the module attaches to window in a browser-ish IIFE; fake it. */
global.window = global.window || {};
require('../predict-sites.js');
const S = global.window.PaperPredictSites;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a bare "host/path..." string into { host, pathname } matching
 * how content scripts feed detect().  A leading slash on the host is
 * absent (e.g. "kalshi.com/markets/kxgdp").
 */
function url(s) {
  const i = s.indexOf('/');
  if (i === -1) return { host: s, pathname: '/' };
  return { host: s.slice(0, i), pathname: s.slice(i) };
}

/* ================================================================== */
/*  1. Kalshi — must-mount pages                                      */
/* ================================================================== */

test('Kalshi — series page /markets/kxelonmars → refused (list page, not a market)', () => {  const u = url('kalshi.com/markets/kxelonmars');  assert.equal(S.detect(u.host, u.pathname), null);});

test('Kalshi — deep market /markets/kxelonmars/elon-mars/kxelonmars-99', () => {
  const u = url('kalshi.com/markets/kxelonmars/elon-mars/kxelonmars-99');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'kalshi',
    marketId: 'kxelonmars-99',
    verified: true,
  });
});

test('Kalshi — GDP market /markets/kxgdp/us-gdp-growth/kxgdp-26oct30', () => {
  const u = url('kalshi.com/markets/kxgdp/us-gdp-growth/kxgdp-26oct30');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'kalshi',
    marketId: 'kxgdp-26oct30',
    verified: true,
  });
});

/* ================================================================== */
/*  2. Kalshi — must-refuse pages                                     */
/* ================================================================== */

test('Kalshi — refuse homepage kalshi.com', () => {
  assert.equal(S.detect('kalshi.com', '/'), null);
});

test('Kalshi — refuse portfolio /portfolio', () => {
  assert.equal(S.detect('kalshi.com', '/portfolio'), null);
});

test('Kalshi — refuse bare /markets (no segments)', () => {
  assert.equal(S.detect('kalshi.com', '/markets'), null);
});

/* ================================================================== */
/*  3. Polymarket — must-mount pages                                  */
/* ================================================================== */

test('Polymarket — event page /event/bitcoin-above-100000-on-july-31', () => {
  const u = url('polymarket.com/event/bitcoin-above-100000-on-july-31');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'polymarket',
    eventSlug: 'bitcoin-above-100000-on-july-31',
    verified: false,
  });
});

/* ================================================================== */
/*  4. Polymarket — must-refuse pages                                 */
/* ================================================================== */

test('Polymarket — refuse homepage polymarket.com', () => {
  assert.equal(S.detect('polymarket.com', '/'), null);
});

test('Polymarket — refuse /portfolio', () => {
  assert.equal(S.detect('polymarket.com', '/portfolio'), null);
});

/* ================================================================== */
/*  5. Hyperliquid outcomes — must-mount pages                        */
/* ================================================================== */

test('Hyperliquid outcomes — /outcomes with title carrying BTC market', () => {
  assert.deepEqual(
    S.detect('app.hyperliquid.xyz', '/outcomes', '64,869 | BTC | Hyperliquid'),
    {
      venue: 'hyperliquid-outcomes',
      market: 'BTC',
      verified: false,
    },
  );
});

test('Hyperliquid outcomes — /outcomes index with no title REFUSES (never a half-mount)', () => {
  // This asserted the opposite until pt-recon check caught it (RETURNED_NO_ID)
  // against the captured /outcomes index. Returning {venue, market: null} reads
  // to every caller as "we are on a market" and then there is nothing to price:
  // the ticket mounts on the index page with no book behind it. The contract is
  // null, or an identified market — never an object with no identifier.
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcomes'), null);
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcomes', 'Hyperliquid'), null);
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcomes/', 'no price here'), null);
});

/* ================================================================== */
/*  6. Hyperliquid — must-refuse pages                                */
/* ================================================================== */

test('Hyperliquid — refuse /trade/SOL (perps, not outcomes)', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade/SOL'), null);
});

test('Hyperliquid — refuse homepage app.hyperliquid.xyz', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/'), null);
});

/* ================================================================== */
/*  7. Limitless — must-mount pages                                   */
/* ================================================================== */

test('Limitless — market /markets/will-btc-hit-100k', () => {
  const u = url('limitless.exchange/markets/will-btc-hit-100k');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'limitless',
    marketSlug: 'will-btc-hit-100k',
    verified: false,
  });
});

/* ================================================================== */
/*  8. Limitless — must-refuse pages                                  */
/* ================================================================== */

test('Limitless — refuse homepage limitless.exchange', () => {
  assert.equal(S.detect('limitless.exchange', '/'), null);
});

test('Limitless — refuse /portfolio', () => {
  assert.equal(S.detect('limitless.exchange', '/portfolio'), null);
});

/* ================================================================== */
/*  9. Bounds locks — PAIRED: under refuses AND the minimum mounts     */
/*                                                                     */
/*  A one-sided bounds lock only catches a gate being WIDENED. Narrow  */
/*  the same regex — require a 10-char slug, three path segments — and */
/*  every refuse-side assertion still passes while real markets stop   */
/*  mounting. Each bound below is asserted from both directions.       */
/* ================================================================== */

test('Bounds — Kalshi: 1 segment refuses, the 2-segment minimum mounts', () => {
  assert.equal(S.detect('kalshi.com', '/markets/x'), null);
  assert.deepEqual(S.detect('kalshi.com', '/markets/x/y'), {
    venue: 'kalshi', marketId: 'y', verified: true,
  });
});

test('Bounds — Polymarket: a 2-char slug refuses, the 3-char minimum mounts', () => {
  assert.equal(S.detect('polymarket.com', '/event/a'), null);
  assert.equal(S.detect('polymarket.com', '/event/ab'), null);
  assert.deepEqual(S.detect('polymarket.com', '/event/abc'), {
    venue: 'polymarket', eventSlug: 'abc', verified: false,
  });
});

test('Bounds — Hyperliquid: /outcome refuses, and the ticker length gate holds both ways', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcome'), null);
  // Ticker gate is [A-Z]{2,10}: one under and one over must refuse.
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcomes/B'), null);
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcomes/ABCDEFGHIJK'), null);
  assert.deepEqual(S.detect('app.hyperliquid.xyz', '/outcomes/BT'), {
    venue: 'hyperliquid-outcomes', market: 'BT', verified: false,
  });
  assert.deepEqual(S.detect('app.hyperliquid.xyz', '/outcomes/ABCDEFGHIJ'), {
    venue: 'hyperliquid-outcomes', market: 'ABCDEFGHIJ', verified: false,
  });
});

test('Bounds — Limitless: a 2-char slug refuses, the 3-char minimum mounts', () => {
  assert.equal(S.detect('limitless.exchange', '/markets/a'), null);
  assert.equal(S.detect('limitless.exchange', '/markets/ab'), null);
  assert.deepEqual(S.detect('limitless.exchange', '/markets/abc'), {
    venue: 'limitless', marketSlug: 'abc', verified: false,
  });
});

/* ================================================================== */
/*  10. The gating MATRIX — every row a route pt-recon actually        */
/*      captured on the live venue (2026-08-07/08).                    */
/*                                                                     */
/*  The corpora themselves are never committed (they carry cookies and */
/*  balances — see .gitignore), so the routes are copied out here in   */
/*  sanitized form. `ptrecon check` runs the same decisions against    */
/*  the raw capture; this is the half that runs in CI forever.         */
/* ================================================================== */

const MATRIX = [
  // [host, path, mounts?, why]
  ['kalshi.com', '/markets', false, 'venue index'],
  ['kalshi.com', '/markets/kxelonmars', false, 'series page, not a market'],
  ['kalshi.com', '/markets/kxelonmars/elon-mars/kxelonmars-99', true, 'captured market page'],
  ['kalshi.com', '/markets/kxgdp/us-gdp-growth/kxgdp-26oct30', true, 'captured market page'],
  ['kalshi.com', '/portfolio', false, 'wallet/positions — must never mount'],
  ['kalshi.com', '/sign-in', false, 'auth route — ticks live prices behind the form'],

  ['polymarket.com', '/event/kraken-ipo-in-2025', true, 'captured market page'],
  ['polymarket.com', '/event/uk-election-called-by', true, 'captured market page'],
  ['polymarket.com', '/leaderboard', false, 'other traders history'],
  ['polymarket.com', '/rewards', false, 'programme page'],
  ['polymarket.com', '/new', false, 'category index that ticks live prices'],
  ['polymarket.com', '/politics', false, 'category index that ticks live prices'],

  ['app.hyperliquid.xyz', '/outcomes/BTC', true, 'captured outcomes market'],
  ['app.hyperliquid.xyz', '/outcomes/ETH', true, 'captured outcomes market'],
  ['app.hyperliquid.xyz', '/outcomes', false, 'outcomes INDEX — the half-mount pt-recon caught'],
  ['app.hyperliquid.xyz', '/trade/BTC', false, 'PERPS route — a different instrument entirely'],
  ['app.hyperliquid.xyz', '/trade/ETH', false, 'PERPS route — a different instrument entirely'],
  ['app.hyperliquid.xyz', '/portfolio', false, 'wallet — must never mount'],

  ['limitless.exchange', '/markets/xrp-up-or-down-daily-1786118400', true, 'captured market page'],
  ['limitless.exchange', '/', false, 'homepage'],
  ['limitless.exchange', '/crypto', false, 'category index that ticks live prices'],
  ['limitless.exchange', '/leaderboard', false, 'other traders history'],
  ['limitless.exchange', '/rewards', false, 'programme page'],
];

for (const [host, path, shouldMount, why] of MATRIX) {
  test(`Matrix — ${shouldMount ? 'MOUNT ' : 'refuse'} ${host}${path} (${why})`, () => {
    const got = S.detect(host, path);
    if (shouldMount) {
      assert.ok(got, `${host}${path} must mount — ${why}`);
      assert.equal(typeof got.venue, 'string');
      // A mount with no market identifier is a mount with nothing to price.
      const id = got.marketId || got.eventSlug || got.marketSlug || got.market;
      assert.ok(id && String(id).trim(), 'a mounted market must carry an identifier');
      assert.equal(typeof got.verified, 'boolean', 'the honest-gating flag is part of the contract');
    } else {
      assert.equal(got, null, `${host}${path} must refuse — ${why}`);
    }
  });
}

test('Hyperliquid: a PERPS page REFUSES even though its title parses as a market', () => {
  // Perps and outcomes share app.hyperliquid.xyz, and the perps tab title has
  // the same "<price> | <market> | Hyperliquid" shape the outcomes adapter
  // reads (see [HL-TTL] in perps-sites.js: "73.483 | SOL | Hyperliquid").
  // So on a real perps page the title extractor succeeds, and the ROUTE GATE
  // is the only thing standing between a binary-outcome ticket and a
  // leveraged perp. Passing a parseable title here is the difference between
  // locking that gate and merely locking the null-market guard behind it.
  const perpsTitle = '73.483 | SOL | Hyperliquid';
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade/SOL', perpsTitle), null);
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade/BTC', '64,869 | BTC | Hyperliquid'), null);
  // And the outcomes route with the same title shape still mounts, so the gate
  // is proven to discriminate by ROUTE rather than by failing to parse.
  assert.deepEqual(S.detect('app.hyperliquid.xyz', '/outcomes', perpsTitle), {
    venue: 'hyperliquid-outcomes', market: 'SOL', verified: false,
  });
});

test('Matrix — only Kalshi is verified:true; the rest ship as stubs until their live pass', () => {
  // The gate this locks: a venue is verified only when its dossier is green,
  // its locks are in, and the panel has been seen working on the real site.
  // Flipping a flag is not evidence — d5f71af flipped three venues on none,
  // and f79aba6 put them back.
  const verifiedOf = (h, p) => (S.detect(h, p) || {}).verified;
  assert.equal(verifiedOf('kalshi.com', '/markets/kxgdp/us-gdp-growth/kxgdp-26oct30'), true);
  assert.equal(verifiedOf('polymarket.com', '/event/kraken-ipo-in-2025'), false);
  assert.equal(verifiedOf('app.hyperliquid.xyz', '/outcomes/BTC'), false);
  assert.equal(verifiedOf('limitless.exchange', '/markets/xrp-up-or-down-daily-1786118400'), false);
});
