/* DeBot (debot.ai) site adapter tests + pollution guard locks.
 *
 * Every shape here was captured from the LIVE site on 2026-10-27, LOGGED OUT,
 * in an in-app browser (issue #118):
 *
 *  - Token page URL: debot.ai/token/<slug>/<address>. Slugs seen on real feed
 *    links after switching ?chain= on the home page: solana, bsc, base, eth.
 *    X Layer / Polygon / Arbitrum are advertised in the title but no token
 *    link for them was captured, so those slugs fail closed.
 *  - Feed/tracker routes linked from the nav: /, /meme, /hot, /track,
 *    /favorite, /asset, /callout, /copyOrder/history, /perps/trading,
 *    /referral. None is a token page.
 *  - Loaded token-page title: "DJT $1.269M - DJTu...xvoF | Debot - ..." —
 *    symbol plus a $-keyed MARKET CAP, so the default TITLE_PATTERNS fallback
 *    reads it and no debot entry is needed. While loading the same title
 *    reads "DJT $0 - ...", which the parser's > 0 rule drops.
 *  - Trade tape (/api/dashboard/dex/latest/by_token): rows of
 *    {op: 'buy'|'sell', tx, trader, price, ...}. Each row is one wallet's
 *    past trade — HISTORY, not the market — and none of those three keys was
 *    a spelling looksLikeTradeEvent knew, so every row's price reached the
 *    tick unattributed.
 *  - Pools (/api/market/token/pools): rows {pair, price, token: {address},
 *    base_token: {address}} — a genuine market snapshot that must still tick.
 *
 * NOT captured (login-gated, every one answered {"code":101,"message_en":
 * "not login"}): /api/kline/price_markers (types=avg_cost_price,
 * position_price, avg_sell_price, ...), /api/dashboard/token/position/top10,
 * /api/dex/profit/multi_wallet_token_analysis, and the price WebSocket (it
 * rides a SharedWorker). Their key spellings are a logged-in recon item on
 * the QA matrix, not something these locks may assume.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');
const TitleFeed = require(path.join(ROOT, 'title-feed.js'));

// Live-captured token pages, 2026-10-27.
const SOL_MINT = 'DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF';
const BSC_TOKEN = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
const BASE_TOKEN = '0x4cfcdd76df7f00f7f7d911263947a9b5ed0b0fe5';
const ETH_TOKEN = '0xe60e9bd04ccc0a394f1fdf29874e35a773cb07f4';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { site, token: site.detect(), api: sandbox.window.PaperTrenchSites };
}

/* ====================== Detection ====================== */

test('debot adapter detects each captured chain into its canonical name', () => {
  const pages = [
    ['solana', SOL_MINT, 'solana'],
    ['bsc', BSC_TOKEN, 'bnb'],
    ['base', BASE_TOKEN, 'base'],
    ['eth', ETH_TOKEN, 'ethereum'],
  ];
  for (const [slug, address, chain] of pages) {
    const { site, token } = detectAt(`https://debot.ai/token/${slug}/${address}`);
    assert.equal(site.id, 'debot');
    assert.ok(token, `/token/${slug}/ must mount`);
    assert.equal(token.kind, 'mint');
    assert.equal(token.address, address);
    assert.equal(token.chain, chain, `${slug} must be named ${chain} downstream`);
  }
});

test('debot adapter refuses every captured non-token route (O-10)', () => {
  for (const href of [
    'https://debot.ai/',
    'https://debot.ai/?chain=solana',
    'https://debot.ai/meme?chain=solana',
    'https://debot.ai/hot?chain=solana',
    'https://debot.ai/track?chain=solana',
    'https://debot.ai/favorite?chain=solana',
    'https://debot.ai/asset?chain=solana',
    'https://debot.ai/callout?chain=solana',
    'https://debot.ai/copyOrder/history?chain=solana',
    'https://debot.ai/perps/trading?chain=solana',
    'https://debot.ai/referral',
    'https://debot.ai/token/solana',
  ]) {
    const { site, token } = detectAt(href);
    assert.equal(site.id, 'debot', `${href} must route to the debot adapter`);
    assert.equal(token, null, `${href} must not mount (O-10)`);
  }
});

test('debot adapter fails closed on advertised but uncaptured slugs', () => {
  for (const slug of ['xlayer', 'polygon', 'arbitrum', 'sol', 'bnb', 'ethereum']) {
    assert.equal(detectAt(`https://debot.ai/token/${slug}/${BSC_TOKEN}`).token, null,
      `/token/${slug}/ was never seen on the live site and must not be guessed`);
  }
});

test('debot adapter is shape-strict per slug (O-11)', () => {
  assert.equal(detectAt(`https://debot.ai/token/solana/${BSC_TOKEN}`).token, null,
    'an EVM address under the solana slug is refused');
  assert.equal(detectAt(`https://debot.ai/token/eth/${SOL_MINT}`).token, null,
    'a base58 mint under an EVM slug is refused');
});

/* ============ Bounds lock — the solana slug's {32,44} gate ============ */

test('debot solana length gate is exact at both bounds', () => {
  assert.ok(detectAt('https://debot.ai/token/solana/' + '1'.repeat(32)).token,
    '32-char base58 is a valid address shape and must mount');
  assert.ok(detectAt('https://debot.ai/token/solana/' + '1'.repeat(44)).token,
    '44-char base58 is a valid address shape and must mount');
  assert.equal(detectAt('https://debot.ai/token/solana/' + '1'.repeat(31)).token, null,
    '31 chars is not an address');
  assert.equal(detectAt('https://debot.ai/token/solana/' + '1'.repeat(45)).token, null,
    '45 chars is not an address');
});

/* ====================== Links back to DeBot ====================== */

test('debot tokenUrl rebuilds DeBot\'s own slug for every chain it detects', () => {
  for (const [slug, address] of [['solana', SOL_MINT], ['bsc', BSC_TOKEN], ['base', BASE_TOKEN], ['eth', ETH_TOKEN]]) {
    const href = `https://debot.ai/token/${slug}/${address}`;
    const { site, token } = detectAt(href);
    assert.equal(site.tokenUrl(token.address, null, token.chain), href,
      'a chip must return to the exact page the position was opened on');
  }
});

test('a debot position chip navigates back to debot.ai', () => {
  const { api } = detectAt(`https://debot.ai/token/solana/${SOL_MINT}`);
  assert.equal(api.tokenUrlFor(BSC_TOKEN, { siteId: 'debot', chain: 'bnb' }),
    `https://debot.ai/token/bsc/${BSC_TOKEN}`);
});

/* ====================== Title signal ====================== */

test('the captured debot title yields its market cap through the default pattern', () => {
  const title = 'DJT $1.269M - DJTu...xvoF | Debot - Crypto Signals & Alpha Exchange for Memecoins & BTC, ETH & SOL & Xlayer & Polygon & BSC & Base & Arbitrum';
  assert.equal(TitleFeed.parseTitle(title, 'debot'), 1.269 * 1e6);
  assert.equal(TitleFeed.parseTitle('DJT $0 - DJTu...xvoF | Debot', 'debot'), null,
    'the loading title carries no cap and must not produce one');
});

/* ============ Behavioral pollution locks (the fomo pair-form) ============
 *
 * Boot the shipped price-bridge.js on a debot-shaped page with no chart
 * surface: debot's TradingView internals were not part of this capture, and
 * the fake must not implement what was never observed (F-39). */

function microtasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

function jsonResponse(body) {
  return {
    url: '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : String(body.length)) },
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
}

function runDebotBridge(opts = {}) {
  const emitted = [];
  const listeners = {};

  function makeFakeEl(tag) {
    return {
      tag, style: {}, attrs: {}, children: [], parentNode: null, textContent: '', title: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      remove() {
        const p = this.parentNode;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentNode = null;
      },
    };
  }

  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeFakeEl(tag),
    body: makeFakeEl('body'),
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    fetch: (...args) => Promise.resolve(opts.fetchResponse ? opts.fetchResponse(args[0]) : {
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: undefined,
    EventSource: undefined,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    document: doc,
    location: { href: `https://debot.ai/token/solana/${SOL_MINT}`, hostname: 'debot.ai' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    // Timers are captured and never fired: the walker locks need none, and
    // firing the bridge's chart pollers would need a chart that was not captured.
    setInterval() { return 0; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'price-bridge.js' }
  );

  return {
    win,
    send(type, payload) {
      listeners.message({ source: win, data: { source: 'papertrench-content', type, payload } });
    },
    statuses(type) { return emitted.filter((m) => m.source === 'papertrench-bridge' && m.type === type).map((m) => m.payload); },
  };
}

async function ticksFor(body) {
  const env = runDebotBridge({ fetchResponse: () => jsonResponse(JSON.stringify(body)) });
  env.send('paper-axis', { mint: SOL_MINT, symbol: 'DJT', pairAddress: null });
  await env.win.fetch('https://debot.ai/__shape_fixture__');
  await microtasks(10);
  return env.statuses('tick');
}

function ticked(ticks, value) {
  return ticks.filter((t) => t && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === value));
}

// Two rows exactly as captured (fields trimmed to the ones that matter; the
// live rows also carry uuid, block, log_index, amount, volume, profit, ...).
const TAPE_ROWS = [
  {
    token: SOL_MINT, base_token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', base_token_symbol: 'USDC',
    time: 1793138196, op: 'buy', price: 6.423683203,
    tx: '5LpKAAZzDmwkrYsboHUo54822LMvKYzVmM23BVaQt21cwJYDZFSSgKfSCXuonZhXJPvSZTDwS48DB8Yjb2vqnFjX',
    trader: 'CtJFsmNo4yLtJeSSakoqvBBb1Dk1qEpCRTm3YpuHhVEr', native_token_price: 101.49,
  },
  {
    token: SOL_MINT, base_token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', base_token_symbol: 'USDC',
    time: 1793138192, op: 'sell', price: 6.385148477,
    tx: '62VVC1gzq1kK94dUrbpgjTyUnd1dvr42qv3vwbW3dPPe78VSmwPNb8qypYjSqt4BGAJp3xxMw8Hxak2jTjbCzQ7J',
    trader: 'AdQzWKi6xQiUoe1VZubpJMTdeJFwi1J6yEntzemDHvgd', native_token_price: 101.5,
  },
];

test('debot: trade-tape rows are someone\'s HISTORY — their prices never tick', async () => {
  const ticks = await ticksFor({ code: 0, data: { transactions: TAPE_ROWS } });
  for (const row of TAPE_ROWS) {
    assert.equal(ticked(ticks, row.price).length, 0,
      `a captured ${row.op} at ${row.price} is one wallet's past fill, not the market`);
  }
});

// Each fixture below keeps exactly TWO of the three new spellings, so each
// clause of looksLikeTradeEvent is locked in isolation: dropping `op`, `tx`
// or `trader` from the guard reds the test(s) that depend on it alone.
const ROW_OP_TX = { token: SOL_MINT, op: 'buy', tx: TAPE_ROWS[0].tx, price: 6.4101 };
const ROW_OP_TRADER = { token: SOL_MINT, op: 'sell', trader: TAPE_ROWS[0].trader, price: 6.4102 };
const ROW_TX_TRADER = { token: SOL_MINT, tx: TAPE_ROWS[1].tx, trader: TAPE_ROWS[1].trader, price: 6.4103 };

test('debot: a row typed by `op` with a `tx` id is a trade event', async () => {
  const ticks = await ticksFor({ data: { transactions: [ROW_OP_TX] } });
  assert.equal(ticked(ticks, ROW_OP_TX.price).length, 0, 'op + tx marks a trade event');
});

test('debot: a row typed by `op` and attributed to a `trader` is a trade event', async () => {
  const ticks = await ticksFor({ data: { transactions: [ROW_OP_TRADER] } });
  assert.equal(ticked(ticks, ROW_OP_TRADER.price).length, 0, 'op + trader marks a trade event');
});

test('debot: a row with a `tx` id attributed to a `trader` is a trade event', async () => {
  const ticks = await ticksFor({ data: { transactions: [ROW_TX_TRADER] } });
  assert.equal(ticked(ticks, ROW_TX_TRADER.price).length, 0, 'tx + trader marks a trade event');
});

// Positive controls: the guard must not over-reach.
test('debot: a captured pools row (genuine market snapshot) still ticks', async () => {
  const ticks = await ticksFor({
    code: 0,
    data: {
      list: [{
        show_dex: 'orca', chain: 'solana', pair: '7gkB2D1SqhUYgKrSpDU5cma4tK9efijHouYituABdJcG',
        price: 6.387376866, liquidity: 555524.187010947,
        token: { chain: 'solana', symbol: 'DJT', decimal: 6, address: SOL_MINT },
        base_token: { chain: 'solana', symbol: 'USDC', decimal: 6, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      }],
    },
  });
  assert.ok(ticked(ticks, 6.387376866).length >= 1, 'a pool price is market data and must keep flowing');
});

test('debot: one spelling alone does not make a trade event', async () => {
  // `op: 'buy'` alone is a label, `tx` alone is an id, `trader` alone is a
  // wallet — the guard needs two signals, exactly as before this change.
  for (const [row, value] of [
    [{ token: SOL_MINT, op: 'buy', price: 6.4201 }, 6.4201],
    [{ token: SOL_MINT, tx: TAPE_ROWS[0].tx, price: 6.4202 }, 6.4202],
    [{ token: SOL_MINT, trader: TAPE_ROWS[0].trader, price: 6.4203 }, 6.4203],
  ]) {
    const ticks = await ticksFor({ data: row });
    assert.ok(ticked(ticks, value).length >= 1,
      `${JSON.stringify(Object.keys(row))} alone must not taint a market price`);
  }
});
