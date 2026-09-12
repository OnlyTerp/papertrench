/* EVM ticks from the page feed (v3.23.0).
 *
 * Field report (Discord #bug-reports, cheng + ark, 2026-09-10/11): every
 * Robinhood page sat at pending:true / priceSource:null forever — buys
 * armed and never fired. Root cause: every identity-keyed reader in
 * price-bridge.js required base58, so ALL 0x trade ticks were dropped
 * before emission. GMGN's token_activity feed quotes in USD per trade,
 * which is exactly what the foreign bootstrap needs — the ticks just
 * never arrived.
 *
 * Second half: Dexscreener returns CHECKSUMMED EVM addresses while page
 * URLs and feeds are usually lowercase. The bridge canonicalizes EVM to
 * lowercase at intake (marker, records, WS batches) so the two meet on
 * one key; base58 is case-SENSITIVE and passes through untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// REALMARKETS on Robinhood Chain (the ark_debug Sep-11 report page).
const EVM_LOWER = '0x7a3d9aa42d71a145c31e0dae984509904b23e8c9';
const EVM_CHECKSUMMED = '0x7a3d9AA42d71a145c31E0Dae984509904B23E8c9';
const EVM_OTHER = '0x9fd55a73ea219cee30c864834eac2da8a49cbd57';
const EVM_POOL = '0x3f261075d82bc731c4b8e83a88bbb24d47c63db9';
const SOL_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function runBridge(body, href) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const responseBody = JSON.stringify(body);
  const win = {
    fetch(url) {
      return Promise.resolve({
        url: String(url),
        headers: { get: () => 'application/json' },
        clone: () => ({ text: () => Promise.resolve(responseBody) }),
      });
    },
    XMLHttpRequest: function FakeXHR() {},
    WebSocket: function FakeWebSocket() {},
    SharedWorker: function FakeSharedWorker() {},
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.XMLHttpRequest.prototype.send = function () {};
  win.XMLHttpRequest.prototype.addEventListener = function () {};
  win.WebSocket.prototype.addEventListener = function () {};
  win.SharedWorker.prototype.port = {
    addEventListener() {},
    start() {},
  };
  win.window = win;
  const sandbox = {
    window: win,
    location: { href: href || ('https://gmgn.ai/robinhood/token/' + EVM_LOWER), hostname: 'gmgn.ai' },
    console,
    Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });
  for (const fn of timers.slice()) fn();
  return {
    emitted,
    sendContent(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    async fetch() {
      await win.fetch('https://gmgn.ai/api/frame');
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

const ticks = (env) => env.emitted.filter((m) => m.type === 'tick');

test('GMGN token_activity trades with 0x mints emit USD ticks', async () => {
  const env = runBridge({
    channel: 'token_activity',
    data: [
      { a: EVM_LOWER, pu: 0.000003285, e: 'buy' },
      { a: EVM_OTHER, pu: 0.0012, e: 'sell' },
    ],
  });
  env.sendContent('paper-axis', { mint: EVM_LOWER, pairAddress: null, symbol: 'REALMARKETS' });
  await env.fetch();
  const got = ticks(env);
  assert.ok(got.length >= 2, `expected 0x trade ticks, got ${got.length} ticks`);
  const ours = got.find((t) => t.payload.mint === EVM_LOWER);
  assert.ok(ours, 'a tick for the 0x mint must be emitted');
  assert.equal(ours.payload.source, 'gmgn-ws-trade');
  assert.equal(ours.payload.candidates[0].value, 0.000003285);
  assert.equal(ours.payload.candidates[0].unit, 'usd');
});

test('a checksummed marker still meets its lowercase feed', async () => {
  const env = runBridge({
    channel: 'token_activity',
    data: [
      { a: EVM_OTHER, pu: 0.0012, e: 'sell' },
      { a: EVM_LOWER, pu: 0.000003285, e: 'buy' },
    ],
  });
  // The resolver hands back checksummed; the page feed prints lowercase.
  env.sendContent('paper-axis', { mint: EVM_CHECKSUMMED, pairAddress: null, symbol: 'REALMARKETS' });
  await env.fetch();
  const got = ticks(env);
  assert.ok(got.length >= 1, 'expected ticks despite the casing split');
  assert.equal(got[0].payload.mint, EVM_LOWER, 'the watched coin emits first, canonically cased');
  assert.equal(got[0].payload.symbol, 'REALMARKETS', 'the watched coin keeps its symbol');
});

test('collect() adopts EVM mint-keyed records canonically', async () => {
  const env = runBridge({
    token: {
      mint: EVM_CHECKSUMMED,
      pairAddress: EVM_POOL,
      symbol: 'REALMARKETS',
      priceUsd: 0.000003285,
      marketCap: 3285,
    },
  });
  env.sendContent('paper-axis', { mint: EVM_LOWER, pairAddress: EVM_POOL });
  await env.fetch();
  const ours = ticks(env).find((t) => t.payload.mint === EVM_LOWER);
  assert.ok(ours, 'an EVM mint-keyed record must produce a tick under the canonical mint');
  const facts = env.emitted.find((m) => m.type === 'facts' && m.payload.mint === EVM_LOWER);
  assert.ok(facts, 'facts must be keyed canonically too');
  assert.ok(facts.payload.addresses.includes(EVM_POOL.toLowerCase()),
    'snapshot addresses are canonical: the page tie-break survives casing');
});

test('a 0x run inside a longer string is still not an address (O-11)', async () => {
  const env = runBridge({
    token: {
      note: 'xx' + EVM_LOWER + 'yy',
      priceUsd: 1.23,
    },
  });
  env.sendContent('paper-axis', { mint: EVM_LOWER, pairAddress: null });
  await env.fetch();
  const ours = ticks(env).filter((t) => t.payload.mint === EVM_LOWER);
  assert.equal(ours.length, 0, 'substring matches must never mint a record');
});

test('base58 trade ticks are untouched by the EVM widening', async () => {
  const env = runBridge(
    {
      channel: 'token_activity',
      data: [{ a: SOL_MINT, pu: 0.0000021, e: 'buy' }],
    },
    'https://gmgn.ai/sol/token/' + SOL_MINT,
  );
  env.sendContent('paper-axis', { mint: SOL_MINT, pairAddress: null, symbol: 'BONK' });
  await env.fetch();
  const ours = ticks(env).find((t) => t.payload.mint === SOL_MINT);
  assert.ok(ours, 'the Solana WS lane must keep working byte-for-byte');
  assert.equal(ours.payload.candidates[0].value, 0.0000021);
});
