/* Adapter lock tests for the three venues added after the Kalshi landing:
 * Polymarket, Hyperliquid outcomes, and Limitless.
 *
 * These adapters shipped in d2c8ad7 with no tests at all. Every payload shape
 * below is the shape the live API actually returned when probed on 2026-08-08
 * (Hyperliquid `allMids` keys `#10330`/`#10331` confirm the `#{outcome}{side}`
 * convention; Polymarket books arrive worst-first; Limitless quotes one side).
 *
 * THE FAKE THROWS WHAT THE SITE THROWS (F-39). `fetchJson` turns a non-2xx
 * into an exception, so the fake returns `{ok: false, status}` for failures
 * rather than rejecting — a fake that rejects would exercise a path the real
 * venue never takes, and the suite would stay green while the shipped code
 * mishandled a 500.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../predict-venues.js');
const V = global.window.PaperPredictVenues;

/* ── the strict fake ─────────────────────────────────────────────────
 * Routes are matched by substring against the URL the adapter builds. An
 * unrouted URL is a hard failure, not an empty response: an adapter that
 * starts calling a new endpoint must fail loudly here rather than silently
 * receiving `{}` and reporting a book with no levels.
 */
function withFetch(routes, fn) {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
    for (const [needle, reply] of routes) {
      if (String(url).includes(needle)) {
        const r = typeof reply === 'function' ? reply(String(url), opts) : reply;
        if (r && r.__http_error) return { ok: false, status: r.__http_error, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => r };
      }
    }
    throw new Error(`strict fake: unrouted request ${url}`);
  };
  return Promise.resolve(fn(seen)).finally(() => { global.fetch = real; });
}

const HTTP = (status) => ({ __http_error: status });

/* ================================================================== */
/*  Polymarket — the worst-first ordering trap (H2)                    */
/* ================================================================== */

const PM_MARKET = [{
  condition_id: '0xcond',
  orderPriceMinTickSize: 0.01,
  tokens: [
    { outcome: 'Yes', outcomeIndex: 0, token_id: 'tokYES' },
    { outcome: 'No', outcomeIndex: 1, token_id: 'tokNO' },
  ],
}];

// Polymarket returns ladders WORST-FIRST: bids ascend to the best bid at the
// END of the array, asks descend to the best ask at the end. Read either as
// best-first and a buy that should fill at 13¢ fills at 15¢.
const PM_YES_WORST_FIRST = {
  bids: [{ price: '0.10', size: '50' }, { price: '0.11', size: '40' }, { price: '0.12', size: '30' }],
  asks: [{ price: '0.16', size: '60' }, { price: '0.15', size: '20' }, { price: '0.13', size: '10' }],
};
const PM_NO_WORST_FIRST = {
  bids: [{ price: '0.84', size: '25' }, { price: '0.87', size: '15' }],
  asks: [{ price: '0.92', size: '35' }, { price: '0.88', size: '45' }],
};

function pmRoutes(yesBook, noBook) {
  return [
    ['gamma-api.polymarket.com/markets', PM_MARKET],
    ['token_id=tokYES', yesBook],
    ['token_id=tokNO', noBook],
  ];
}

test('Polymarket: a worst-first book is sorted best-first, not reversed blindly', () => withFetch(
  pmRoutes(PM_YES_WORST_FIRST, PM_NO_WORST_FIRST),
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('0xcond');
    assert.ok(book, 'a well-formed book must not be refused');
    // Best bid is the HIGHEST, best ask the LOWEST — regardless of arrival order.
    assert.equal(book.yes.bids[0][0], 12, 'best YES bid must be the highest price');
    assert.equal(book.yes.asks[0][0], 13, 'best YES ask must be the lowest price');
    // Full ladders stay ordered, so walking them consumes the best levels first.
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [12, 11, 10]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [13, 15, 16]);
    assert.deepEqual(book.no.bids.map((l) => l[0]), [87, 84]);
    assert.deepEqual(book.no.asks.map((l) => l[0]), [88, 92]);
  },
));

test('Polymarket: an ALREADY best-first book is left correct (sort, never reverse)', () => withFetch(
  // The same ladders arriving best-first. A `.reverse()` implementation would
  // pass the worst-first test above and corrupt this one — which is exactly why
  // the doctrine says sort explicitly.
  pmRoutes(
    { bids: [{ price: '0.12', size: '30' }, { price: '0.11', size: '40' }], asks: [{ price: '0.13', size: '10' }, { price: '0.15', size: '20' }] },
    { bids: [{ price: '0.87', size: '15' }], asks: [{ price: '0.88', size: '45' }] },
  ),
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('0xcond');
    assert.equal(book.yes.bids[0][0], 12);
    assert.equal(book.yes.asks[0][0], 13);
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [12, 11]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [13, 15]);
  },
));

test('Polymarket: dollar prices become cents, sizes survive', () => withFetch(
  pmRoutes(PM_YES_WORST_FIRST, PM_NO_WORST_FIRST),
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('0xcond');
    // 0.13 dollars is 13 cents — not 0.13 cents and not 13 dollars.
    const best = book.yes.asks[0];
    assert.equal(best[0], 13);
    assert.equal(best[1], 10);
    assert.equal(book.tickCents, 1, 'a 0.01 dollar tick is a 1 cent tick');
  },
));

test('Polymarket: a market missing an outcome token REFUSES rather than half-pricing', () => withFetch(
  [['gamma-api.polymarket.com/markets', [{ condition_id: '0xcond', tokens: [{ outcome: 'Yes', token_id: 'tokYES' }] }]]],
  async () => {
    assert.equal(await V.adapterFor('polymarket').fetchBook('0xcond'), null);
  },
));

test('Polymarket: a failed CLOB fetch REFUSES — never a book with one live side', () => withFetch(
  [
    ['gamma-api.polymarket.com/markets', PM_MARKET],
    ['token_id=tokYES', PM_YES_WORST_FIRST],
    ['token_id=tokNO', HTTP(500)],
  ],
  async () => {
    assert.equal(await V.adapterFor('polymarket').fetchBook('0xcond'), null, 'half a book is worse than no book');
  },
));

/* ================================================================== */
/*  Hyperliquid outcomes — the null-l2Book trap (H6)                   */
/* ================================================================== */

const HL_META = { universe: [{ name: 'BTC', index: 1033, tokens: [7] }] };
const HL_L2 = {
  coin: 'BTC',
  levels: [
    [{ 0: '0.40', 1: '10' }, { 0: '0.39', 1: '20' }].map((o) => [o[0], o[1]]),
    [{ 0: '0.42', 1: '15' }, { 0: '0.43', 1: '25' }].map((o) => [o[0], o[1]]),
  ],
};

function hlRoutes(reply) {
  return [['api.hyperliquid.xyz/info', (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.type === 'spotMeta') return HL_META;
    if (body.type === 'l2Book') return reply;
    return {};
  }]];
}

test('Hyperliquid: a null l2Book REFUSES — an unknown asset id must not render as an empty market', () => withFetch(
  // The documented trap: l2Book answers a wrong coin id with `null` rather than
  // an error, so a guess renders as a market with no depth instead of a bug.
  hlRoutes(null),
  async () => {
    assert.equal(await V.adapterFor('hyperliquid-outcomes').fetchBook('BTC'), null);
  },
));

test('Hyperliquid: an l2Book with no levels REFUSES', () => withFetch(
  hlRoutes({ coin: 'BTC' }),
  async () => {
    assert.equal(await V.adapterFor('hyperliquid-outcomes').fetchBook('BTC'), null);
  },
));

test('Hyperliquid: a market absent from the universe REFUSES (no invented coin id)', () => withFetch(
  hlRoutes(HL_L2),
  async () => {
    assert.equal(await V.adapterFor('hyperliquid-outcomes').fetchBook('DOGE'), null, 'an unlisted market must not be priced');
  },
));

test('Hyperliquid: the NO ladder is the mirror of YES, and both are best-first', () => withFetch(
  hlRoutes(HL_L2),
  async () => {
    const book = await V.adapterFor('hyperliquid-outcomes').fetchBook('BTC');
    assert.ok(book);
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [40, 39]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [42, 43]);
    // A YES ask at 42 is a NO bid at 58; a YES bid at 40 is a NO ask at 60.
    assert.deepEqual(book.no.bids.map((l) => l[0]), [58, 57]);
    assert.deepEqual(book.no.asks.map((l) => l[0]), [60, 61]);
    // Sizes ride along with the mirrored level, they are not recomputed.
    assert.equal(book.no.bids[0][1], 15);
  },
));

/* ================================================================== */
/*  Limitless — the constructed NO ladder                              */
/* ================================================================== */

// The adapter resolves a slug by fetching the whole /markets LIST and
// searching it — not /markets/<slug>. The fake mirrors that exactly; a fake
// that served a per-slug route would pass while the shipped code called an
// endpoint nobody tested.
const LL_MARKET = { id: 'mkt-1', slug: 'will-btc-hit-100k', orderPriceMinTickSize: 0.01, status: 'open' };
const LL_BOOK = {
  bids: [{ price: '0.30', size: '100' }, { price: '0.28', size: '200' }],
  asks: [{ price: '0.33', size: '50' }, { price: '0.35', size: '75' }],
};

function llRoutes(book) {
  return [
    ['orderbook?marketId=', book],
    ['api.limitless.exchange/markets', [LL_MARKET]],
  ];
}

test('Limitless: the NO ladder is CONSTRUCTED by mirror — the venue quotes one side', () => withFetch(
  llRoutes(LL_BOOK),
  async () => {
    const book = await V.adapterFor('limitless').fetchBook('will-btc-hit-100k');
    assert.ok(book);
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [30, 28]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [33, 35]);
    assert.deepEqual(book.no.bids.map((l) => l[0]), [67, 65]);
    assert.deepEqual(book.no.asks.map((l) => l[0]), [72, 70].sort((a, b) => a - b));
    assert.equal(book.venue, 'limitless');
  },
));

test('Limitless: a failed orderbook fetch REFUSES', () => withFetch(
  llRoutes(HTTP(503)),
  async () => {
    assert.equal(await V.adapterFor('limitless').fetchBook('will-btc-hit-100k'), null);
  },
));

test('Limitless: a slug absent from the market list REFUSES before any book is requested', () => withFetch(
  llRoutes(LL_BOOK),
  async (seen) => {
    assert.equal(await V.adapterFor('limitless').fetchBook('no-such-market'), null);
    assert.ok(!seen.some((s) => s.url.includes('orderbook')), 'must not ask for a book it cannot identify');
  },
));

/* ================================================================== */
/*  Cross-venue: nothing is priced off a level the venue did not quote */
/* ================================================================== */

test('every venue drops levels outside 0<p<100 and non-positive sizes', () => withFetch(
  pmRoutes(
    { bids: [{ price: '0.00', size: '10' }, { price: '0.12', size: '0' }, { price: '0.11', size: '5' }], asks: [{ price: '1.00', size: '10' }, { price: '0.13', size: '5' }] },
    { bids: [{ price: '0.87', size: '15' }], asks: [{ price: '0.88', size: '45' }] },
  ),
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('0xcond');
    // 0¢ and 100¢ are settled outcomes, not tradable depth; a zero size is not
    // depth at all. Only the 11¢ bid and the 13¢ ask survive.
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [11]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [13]);
  },
));
