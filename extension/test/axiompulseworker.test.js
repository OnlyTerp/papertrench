/* Axiom Unified Pulse rows carry no price in their React props, so chip buys
 * filled from the resolver/Jupiter and drifted 5-30% on fast coins (410ldv,
 * ticket-0016/0017). Live recon 2026-11-16: the rows are fed by a dedicated
 * `PulseWorker.unified-*.js` Worker posting OUTPUT_BATCH messages —
 * TABLE_REPLACE items / insert ops map pairAddress -> tokenAddress + supply,
 * and patch ops set `marketCap` in the pair's QUOTE-token units with
 * `quoteTokenPriceUsd` alongside. The bridge listens (passively) and emits
 * `row-tick` so content.js's row-feed tier prices the chip from the row. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function boot(hostname) {
  const emitted = [];
  const workers = [];
  const timers = [];
  function FakeWorker(url) { this.url = String(url); this.listeners = []; workers.push(this); }
  FakeWorker.prototype.addEventListener = function (t, fn) { if (t === 'message') this.listeners.push(fn); };
  FakeWorker.prototype.postMessage = function () {};
  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};
  const win = {
    Worker: FakeWorker, WebSocket: FakeWebSocket, XMLHttpRequest: FakeXHR,
    fetch: () => Promise.resolve({ url: '', headers: { get: () => 'application/json' }, clone: () => ({ text: () => Promise.resolve('{}') }) }),
    addEventListener() {}, postMessage(m) { emitted.push(m); },
  };
  win.window = win;
  const sandbox = {
    window: win, location: { href: 'https://' + hostname + '/pulse', hostname, pathname: '/pulse' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), sandbox, { filename: 'price-bridge.js' });
  const flush = () => { for (const fn of timers.splice(0)) { try { fn(); } catch (_) {} } };
  return { win, emitted, workers, flush };
}

const PAIR = '6agnrMqZ2pRZE5sKTusxTiZtat5PUi1iQHsCqFZ3mChP';
const MINT = 'vrmSkVEQcxvT2kJDKSuMTJsXtAuqHmkA6UsXVnSpump';
const batch = (messages) => ({ data: { type: 'OUTPUT_BATCH', messages } });
const replace = { type: 'TABLE_REPLACE', table: 'newPairs', items: [{ chain: 'sol', row: {
  pairAddress: PAIR, tokenAddress: MINT, tokenTicker: 'MEDIEVAL', tokenName: 'The Medieval Horse',
  supply: '1000000000', quoteToken: 'sol', marketCap: 6.0, quoteTokenPriceUsd: 71.09 } }] };
const patch = (set) => ({ type: 'TABLE_OPERATIONS', table: 'newPairs', operations: [{ type: 'patch', chain: 'sol', pairAddress: PAIR, set, unset: [] }] });
const rowTicks = (env) => env.emitted.filter((m) => m.type === 'row-tick').map((m) => m.payload);

function pulseWorker(env) {
  const W = env.win.Worker;
  const w = new W('https://axiom.trade/workers/PulseWorker.unified-4IYH3JRT.js?dpl=x');
  return w;
}

test('a Pulse marketCap patch becomes a mint-keyed USD row tick', () => {
  const env = boot('axiom.trade');
  const w = pulseWorker(env);
  assert.ok(w.listeners.length >= 1, 'the bridge listens on the PulseWorker');
  for (const fn of w.listeners) fn(batch([replace, patch({ marketCap: 9.5 })]));
  env.flush();
  const t = rowTicks(env).filter((p) => p.mint === MINT).pop();
  assert.ok(t, 'a row tick for the mint');
  const usd = t.candidates.find((c) => c.unit === 'usd').value;
  assert.ok(Math.abs(usd - 9.5 * 71.09 / 1e9) < 1e-15, 'price = marketCap x quoteUsd / supply');
  assert.ok(Math.abs(t.mcap - 9.5 * 71.09) < 1e-9, 'USD cap');
  assert.equal(t.symbol, 'MEDIEVAL');
  assert.ok(t.at > 0);
});

test('EVM rows are not emitted; a non-SOL-quoted Solana row is emitted only as UNVERIFIED', () => {
  // Live 2026-11-18: Solana rows quoted in something other than SOL carry
  // the same cap x quote-rate fields. Some are right (GARY: 197.7 x $219.6 =
  // $43.4K, the real cap) and some are not (a USDC row at $42). They may
  // only ever price a fill the tapped row itself confirms, so they are
  // flagged for the content script.
  const env = boot('axiom.trade');
  const w = pulseWorker(env);
  const other = JSON.parse(JSON.stringify(replace));
  Object.assign(other.items[0].row, { quoteToken: 'stock', marketCap: 197.747, quoteTokenPriceUsd: 219.588 });
  const evm = JSON.parse(JSON.stringify(replace));
  evm.items[0].chain = 'bnb';
  evm.items[0].row.pairAddress = '0x2b60000000000000000000000000000000000000';
  for (const fn of w.listeners) fn(batch([other, evm]));
  env.flush();
  const ticks = rowTicks(env);
  assert.equal(ticks.length, 1, 'only the Solana row');
  assert.equal(ticks[0].unverified, true, 'and it is flagged');
  assert.ok(Math.abs(ticks[0].mcap - 197.747 * 219.588) < 1e-6);
});

test('a SOL-quoted row tick is never flagged unverified', () => {
  const env = boot('axiom.trade');
  const w = pulseWorker(env);
  for (const fn of w.listeners) fn(batch([replace]));
  env.flush();
  assert.ok(!rowTicks(env)[0].unverified);
});

test("a patch quote rate far from the row's SOL rate is ignored (live: Pump AMM pair priced at $0)", () => {
  const env = boot('axiom.trade');
  const w = pulseWorker(env);
  for (const fn of w.listeners) fn(batch([replace, patch({ marketCap: 857, quoteTokenPriceUsd: 0.000339 })]));
  env.flush();
  const t = rowTicks(env).filter((p) => p.mint === MINT).pop();
  assert.ok(Math.abs(t.mcap - 857 * 71.09) < 1e-6, 'the SOL rate stands; the cap still moves');
});

test('a patch for an unmapped pair, or without a usable rate, emits nothing', () => {
  const env = boot('axiom.trade');
  const w = pulseWorker(env);
  for (const fn of w.listeners) fn(batch([patch({ marketCap: 9.5 })]));
  env.flush();
  assert.equal(rowTicks(env).length, 0);
});

test('other workers and other hosts are untouched', () => {
  const env = boot('axiom.trade');
  const W = env.win.Worker;
  const other = new W('https://axiom.trade/workers/bubble-image.js');
  assert.equal(other.listeners.length, 0, 'only the Pulse worker is observed');
  const g = boot('gmgn.ai');
  const w2 = new g.win.Worker('https://gmgn.ai/workers/PulseWorker.unified-1.js');
  assert.equal(w2.listeners.length, 0, 'the tap is Axiom-only');
});
