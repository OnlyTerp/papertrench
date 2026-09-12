/* Adapter lock tests for the venues added after the Kalshi landing:
 * Polymarket and Limitless. (Hyperliquid outcomes was removed in A3 —
 * see the REMOVED note below.)
 *
 * Every payload shape below is the shape the live API actually returned
 * when probed (Polymarket books arrive worst-first; Limitless quotes one
 * side).
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

/* The REAL gamma shape, captured live 2026-08-08: an event slug resolves to a
 * list of markets, each carrying `clobTokenIds` as a JSON-encoded [yes, no].
 * There is no `tokens` field — the adapter used to ask for one and could
 * therefore never find a token to price. */
const PM_EVENT = [{
  title: 'Fed Decision',
  markets: [
    { conditionId: '0xthin', clobTokenIds: '["thinYES","thinNO"]', question: 'Thin one', liquidityClob: '10', orderPriceMinTickSize: 0.01 },
    { conditionId: '0xcond', clobTokenIds: '["tokYES","tokNO"]', question: 'Will the Fed cut by 25bps?', liquidityClob: '9000', orderPriceMinTickSize: 0.01 },
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
    ['gamma-api.polymarket.com/events?slug=', PM_EVENT],
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

test('Polymarket: an event whose markets carry no clobTokenIds REFUSES', () => withFetch(
  [['gamma-api.polymarket.com/events?slug=', [{ markets: [{ conditionId: '0xcond', question: 'no ids here' }] }]]],
  async () => {
    assert.equal(await V.adapterFor('polymarket').fetchBook('some-event'), null);
  },
));

test('Polymarket: the EVENT slug resolves to its most liquid market, and says which', () => withFetch(
  pmRoutes(PM_YES_WORST_FIRST, PM_NO_WORST_FIRST),
  async (seen) => {
    // polymarket.com/event/<slug> names an event holding several markets.
    // Picking one silently would put a true price next to the wrong question.
    const book = await V.adapterFor('polymarket').fetchBook('fed-decision');
    assert.equal(book.marketId, '0xcond', 'the 9000-liquidity market wins over the 10');
    assert.equal(book.resolvedVia, 'event');
    assert.equal(book.siblingCount, 2);
    assert.match(book.marketTitle, /Fed cut by 25bps/);
    assert.ok(!seen.some((s) => s.url.includes('token_id=thin')), 'the thin market is never priced');
  },
));

test('Polymarket: a failed CLOB fetch REFUSES with its status — never a book with one live side (B5)', () => withFetch(
  [
    ['gamma-api.polymarket.com/events?slug=', PM_EVENT],
    ['token_id=tokYES', PM_YES_WORST_FIRST],
    ['token_id=tokNO', HTTP(500)],
  ],
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('0xcond');
    assert.equal(book.refused, true, 'half a book is worse than no book');
    assert.equal(book.httpStatus, 500, 'the refusal must name the transport failure, not collapse to null');
    assert.ok(!book.yes, 'a refusal is not a book');
  },
));

/* ── Hyperliquid outcomes: REMOVED (A3) ───────────────────────────────
 * The adapter is deleted (it could only ever return null); these tests
 * assert the absence, so a re-add without the discovery work fails loudly
 * instead of re-shipping a panel that can never quote.
 */
test('Hyperliquid outcomes has no adapter — the venue is not quotable (A3)', () => {
  assert.equal(V.adapterFor('hyperliquid-outcomes'), null);
});

/* ================================================================== */
/*  Limitless — the constructed NO ladder                              */
/* ================================================================== */

/* The REAL Limitless shape, captured live 2026-08-08. `/markets` (bare list)
 * is a 404 — the previous fake served it, which is how a lookup that could
 * never succeed shipped with a green suite. A slug resolves via
 * `/markets/<slug>`, and a `group` market has children that each own a book at
 * `/markets/<child-slug>/orderbook` (the numeric id 404s there). */
const LL_GROUP = {
  id: 10013243,
  slug: 't1-vs-hanwha',
  marketType: 'group',
  status: 'FUNDED',
  markets: [
    { id: 1, slug: 'hanwha-x', title: 'Hanwha', volume: '10', status: 'FUNDED' },
    { id: 2, slug: 't1-x', title: 'T1', volume: '9000', status: 'FUNDED' },
  ],
};
const LL_BOOK = {
  bids: [{ price: '0.30', size: '100' }, { price: '0.28', size: '200' }],
  asks: [{ price: '0.33', size: '50' }, { price: '0.35', size: '75' }],
};

function llRoutes(book, group) {
  return [
    ['/orderbook', book],
    ['api.limitless.exchange/markets/', group || LL_GROUP],
  ];
}

test('Limitless: a GROUP resolves to its busiest child, whose slug keys the book', () => withFetch(
  llRoutes(LL_BOOK),
  async (seen) => {
    const book = await V.adapterFor('limitless').fetchBook('t1-vs-hanwha');
    assert.ok(book, 'a group must resolve, not refuse');
    assert.equal(book.marketId, 't1-x', 'the 9000-volume child wins over the 10');
    assert.equal(book.marketTitle, 'T1');
    assert.equal(book.resolvedVia, 'group');
    assert.equal(book.siblingCount, 2);
    assert.ok(seen.some((s) => s.url.includes('/markets/t1-x/orderbook')), 'the book is keyed by the CHILD slug');
  },
));

test('Limitless: the NO ladder is CONSTRUCTED by mirror — the venue quotes one side', () => withFetch(
  llRoutes(LL_BOOK),
  async () => {
    const book = await V.adapterFor('limitless').fetchBook('t1-vs-hanwha');
    assert.ok(book);
    assert.deepEqual(book.yes.bids.map((l) => l[0]), [30, 28]);
    assert.deepEqual(book.yes.asks.map((l) => l[0]), [33, 35]);
    assert.deepEqual(book.no.bids.map((l) => l[0]), [67, 65]);
    assert.deepEqual(book.no.asks.map((l) => l[0]), [72, 70].sort((a, b) => a - b));
    assert.equal(book.venue, 'limitless');
  },
));

test('Limitless: a failed orderbook fetch REFUSES with its status (B5)', () => withFetch(
  llRoutes(HTTP(503)),
  async () => {
    const book = await V.adapterFor('limitless').fetchBook('t1-vs-hanwha');
    assert.equal(book.refused, true);
    assert.equal(book.httpStatus, 503);
  },
));

test('Limitless: an unknown slug REFUSES with its 404 before any book is requested (B5)', () => withFetch(
  [['api.limitless.exchange/markets/', HTTP(404)], ['/orderbook', LL_BOOK]],
  async (seen) => {
    const book = await V.adapterFor('limitless').fetchBook('no-such-market');
    assert.equal(book.refused, true);
    assert.equal(book.httpStatus, 404);
    assert.ok(!seen.some((s) => s.url.includes('orderbook')), 'must not ask for a book it cannot identify');
  },
));

test('Limitless: a group whose children have all resolved REFUSES', () => withFetch(
  llRoutes(LL_BOOK, { ...LL_GROUP, markets: [{ id: 1, slug: 'done', title: 'Done', volume: '5', status: 'RESOLVED' }] }),
  async () => {
    assert.equal(await V.adapterFor('limitless').fetchBook('t1-vs-hanwha'), null, 'a settled outcome is not tradable');
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

/* ── Kalshi event path: the nested-markets pick (A1/A2) ────────────────
 * Live shape verified 2026-08-08: every child reports liquidity_dollars
 * "0.0000" while books hold real depth — sizes live in yes_bid_size_fp /
 * yes_ask_size_fp. The fakes below carry that shape exactly, so a sort on
 * the zero field is a no-op here exactly as it is live.
 */
const kxKid = (ticker, sub, bidFp, askFp, last) => ({
  ticker, status: 'active', liquidity_dollars: '0.0000',
  yes_bid_size_fp: String(bidFp), yes_ask_size_fp: String(askFp),
  last_price_dollars: String(last), yes_sub_title: sub,
  close_time: '2026-10-30T12:29:00Z',
});
const kxBook = { orderbook: { yes_dollars: [['0.50', '10']], no_dollars: [['0.50', '10']] } };
const kxRoutes = (kids) => [
  ['/markets/KXGDP-26OCT30/orderbook', {}], // direct ticker is an event: empty ladders
  ['/events/KXGDP-26OCT30', { event: { markets: kids } }],
  ['/markets/KXGDP-26OCT30-T', kxBook], // whichever child wins gets a book
];

test('Kalshi: the event pick sorts on book sizes, not the always-zero liquidity field (A1)', () => withFetch(
  kxRoutes([
    kxKid('KXGDP-26OCT30-T0.0', 'thin first', 10, 10, 0.47),
    kxKid('KXGDP-26OCT30-T1.0', 'deep second', 500, 500, 0.60),
  ]),
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.marketId, 'KXGDP-26OCT30-T1.0', 'the 1000-size book wins over the 20-size book');
    assert.equal(book.resolvedVia, 'event');
    assert.equal(book.siblingCount, 2);
    assert.match(book.marketTitle, /deep second/);
  },
));

test('Kalshi: a near-certain deepest book is skipped for a live question (A2)', () => withFetch(
  kxRoutes([
    kxKid('KXGDP-26OCT30-T0.0', 'thin first', 10, 10, 0.47),
    kxKid('KXGDP-26OCT30-T1.0', 'deep live', 500, 500, 0.60),
    kxKid('KXGDP-26OCT30-T2.0', 'deepest decided', 5000, 5000, 0.99),
  ]),
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.marketId, 'KXGDP-26OCT30-T1.0', 'the 99c book is decided; the live 60c book wins');
  },
));

test('Kalshi: when every child is decided, the deepest still wins so the lockout speaks (A2)', () => withFetch(
  kxRoutes([
    kxKid('KXGDP-26OCT30-T0.0', 'thin decided', 10, 10, 0.99),
    kxKid('KXGDP-26OCT30-T1.0', 'deep decided', 500, 500, 0.01),
  ]),
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.marketId, 'KXGDP-26OCT30-T1.0', 'fallback is most-liquid, not first-listed');
  },
));

test('Kalshi: the event pick threads its close_time so expiry can refuse (A4)', () => withFetch(
  kxRoutes([
    kxKid('KXGDP-26OCT30-T0.0', 'thin first', 10, 10, 0.47),
    kxKid('KXGDP-26OCT30-T1.0', 'deep second', 500, 500, 0.60),
  ]),
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.marketId, 'KXGDP-26OCT30-T1.0');
    assert.ok(book.closeTime, 'the picked market must carry its venue close_time');
  },
));

test('Kalshi: the resolution record doubles as quote-path liveness (A4/A5)', () => withFetch(
  [
    ['/markets/KXSHUT', { market: { status: 'finalized', result: 'yes', close_time: '2026-08-01T12:00:00Z' } }],
    ['/markets/KXOPEN', { market: { status: 'active', result: '', close_time: '2026-10-30T12:29:00Z' } }],
  ],
  async () => {
    const open = await V.adapterFor('kalshi').checkResolution('KXOPEN');
    assert.deepEqual(open, { resolved: false, closed: false, closeTime: '2026-10-30T12:29:00Z' });
    const shut = await V.adapterFor('kalshi').checkResolution('KXSHUT');
    assert.deepEqual(shut, { resolved: true, resolution: 'yes', closed: true, closeTime: '2026-08-01T12:00:00Z' });
  },
));

test('Polymarket: the resolution record carries closed and endDate (A4/A5)', () => withFetch(
  [
    ['/markets?condition_ids=0xopen', [{ closed: false, endDate: '2026-11-04T00:00:00Z', outcomePrices: '["0.55","0.45"]' }]],
    ['/markets?condition_ids=0xshut', [{ closed: true, endDate: '2026-08-01T00:00:00Z', outcomePrices: '["0.995","0.005"]' }]],
  ],
  async () => {
    const open = await V.adapterFor('polymarket').checkResolution('0xopen');
    assert.deepEqual(open, { resolved: false, closed: false, closeTime: '2026-11-04T00:00:00Z' });
    const shut = await V.adapterFor('polymarket').checkResolution('0xshut');
    assert.deepEqual(shut, { resolved: true, resolution: 'yes', closed: true, closeTime: '2026-08-01T00:00:00Z' });
  },
));

/* ── B5: transport failures refuse WITH their status ───────────────────
 * A 429/500/403 is not an empty book. Adapters return
 * { refused: true, httpStatus } so the ticket can say "venue returned 429"
 * instead of "no book" — and so a broken adapter and an empty market stop
 * being the same test outcome. Only genuinely-empty/absent stays null.
 */

test('Kalshi: a rate-limited direct book REFUSES without hammering the event path (B5)', () => withFetch(
  [
    ['/markets/KXGDP-26OCT30/orderbook', HTTP(429)],
    ['/events/KXGDP-26OCT30', { event: { markets: [] } }],
  ],
  async (seen) => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.refused, true);
    assert.equal(book.httpStatus, 429);
    assert.ok(!seen.some((s) => s.url.includes('/events/')), 'a 429 is transport, not "try the other endpoint"');
  },
));

test('Kalshi: a 404 direct book still falls through to the event path (B5)', () => withFetch(
  [
    ['/markets/KXGDP-26OCT30/orderbook', HTTP(404)], // event ticker, not a market: by design
    ['/events/KXGDP-26OCT30', { event: { markets: [kxKid('KXGDP-26OCT30-T1.0', 'deep second', 500, 500, 0.60)] } }],
    ['/markets/KXGDP-26OCT30-T', kxBook],
  ],
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.marketId, 'KXGDP-26OCT30-T1.0', '404 on direct means "resolve as event", not failure');
  },
));

test('Kalshi: a failed event lookup REFUSES with its status (B5)', () => withFetch(
  [
    ['/markets/KXGDP-26OCT30/orderbook', {}], // empty ladders: an event, resolve it
    ['/events/KXGDP-26OCT30', HTTP(500)],
  ],
  async () => {
    const book = await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30');
    assert.equal(book.refused, true);
    assert.equal(book.httpStatus, 500);
  },
));

test('Kalshi: an event with no open markets is genuinely-empty null, not a refusal (B5)', () => withFetch(
  [
    ['/markets/KXGDP-26OCT30/orderbook', {}],
    ['/events/KXGDP-26OCT30', { event: { markets: [{ ticker: 'KXGDP-26OCT30-T0.0', status: 'settled' }] } }],
  ],
  async () => {
    assert.equal(await V.adapterFor('kalshi').fetchBook('KXGDP-26OCT30'), null);
  },
));

test('Polymarket: an event with no live markets is genuinely-empty null, not a refusal (B5)', () => withFetch(
  [['gamma-api.polymarket.com/events?slug=', [{ title: 'Settled', markets: [{ conditionId: '0xdone', clobTokenIds: '["a","b"]', closed: true }] }]]],
  async () => {
    assert.equal(await V.adapterFor('polymarket').fetchBook('settled'), null);
  },
));

test('Polymarket: when the depth field churns away, the pick sorts on volume (B6)', () => withFetch(
  [
    // No liquidityClob anywhere — the shape gamma serves when the field
    // churns (closed markets already omit it; verified live 2026-09-12).
    ['gamma-api.polymarket.com/events?slug=', [{
      title: 'Pick', markets: [
        { conditionId: '0xthin', clobTokenIds: '["thinYES","thinNO"]', question: 'Thin one', volumeNum: 10, orderPriceMinTickSize: 0.01 },
        { conditionId: '0xcond', clobTokenIds: '["tokYES","tokNO"]', question: 'Deep one', volumeNum: 9000, orderPriceMinTickSize: 0.01 },
      ],
    }]],
    ['token_id=tokYES', PM_YES_WORST_FIRST],
    ['token_id=tokNO', PM_NO_WORST_FIRST],
  ],
  async () => {
    const book = await V.adapterFor('polymarket').fetchBook('pick');
    assert.equal(book.marketId, '0xcond', 'the 9000-volume market wins over the 10');
  },
));
