/* D-71 — RPC exit: the worker supplies a witness, never a weaker refusal.
 *
 * These tests run the shipped background listener, content R facade, fill
 * ladder, and host-facts section in VMs (fillprovenance.test.js style). Only
 * the worker HTTP response and on-chain observation are replaced; no live
 * worker route, public RPC, credentials, or new dependencies are required.
 *
 * Negative controls run against production (D-71 working-tree line numbers):
 * - content.js:2315-2320 — remove the worker fallback immediately after
 *   `if (obs && obs.priceNative > 0) witnessNative = obs.priceNative;`.
 *   "dead RPC plus agreeing worker" and "zero chain price" lose their fill;
 *   "disagreeing worker" loses the witness in its refusal (3 failures).
 * - content.js:638-650 — remove the worker request block from
 *   `decision.reason === 'no-united-price'`. "worker corroborates supply"
 *   loses hostSupplyUi; the host mismatch/attempt/in-flight cases fail too
 *   (4 failures).
 * - content.js:642 — delete `hostSupplyWorkerAttempts.add(mint);`.
 *   "failure preserves diagnostics" observes 2 requests instead of 1 after
 *   the background TTL expires (1 failure).
 * - content.js:645 — remove `token.mint !== mint` from the response guard.
 *   "in-flight host witness" overwrites the new coin's supply with the old
 *   quote (100 instead of 200; 1 failure).
 * - background.js:3415-3459 — replace `case 'pt_worker_quote': { ... }`
 *   with `case 'pt_worker_quote': sendResponse(null); break;`.
 *   Agreeing/zero-chain fills, host adoption, and mint-set cache fail through
 *   the real content.js:36-37 R facade (9 failures total).
 * - background.js:3424-3427 — delete the cached.promise return block.
 *   "mint-set cache" observes 2 concurrent requests instead of 1 (1 failure).
 * - background.js:1980 — remove 'pt_worker_quote' from VIEWER_QUIET_MESSAGES.
 *   "hidden warm viewers" receives a quote instead of null (1 failure).
 * Every control ran this entire file with node --test (exit 1), then restored
 * source byte-identically (backup + SHA-256 compare) and reran it (exit 0).
 * No witness ratio, refusal gate, position anchor, or pure Q helper changed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global.window || {};
const Q = require('../quote.js');
const ROOT = path.join(__dirname, '..');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const NOW = 1_800_000_000_000;
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = '2222222222222222222222222222222222222222222';
const MARKET = 1e-7;
const CANDIDATE = 1.4e-7;

// Reuse the existing worker boot without registering/running its test suite.
const backgroundTests = fs.readFileSync(path.join(__dirname, 'background.test.js'), 'utf8');
const workerStart = backgroundTests.indexOf('function serviceWorker(');
const workerEnd = backgroundTests.indexOf('\nfunction send(', workerStart);
assert.ok(workerStart >= 0 && workerEnd > workerStart, 'existing worker harness must exist');
const serviceWorker = new Function('ROOT', 'fs', 'path', 'vm',
  backgroundTests.slice(workerStart, workerEnd) + '\nreturn serviceWorker;')(ROOT, fs, path, vm);

function sliceContent(startAnchor, endAnchor) {
  const start = contentJs.indexOf(startAnchor);
  const end = contentJs.indexOf(endAnchor, start);
  assert.ok(start >= 0 && end > start, 'production section must exist: ' + startAnchor);
  return contentJs.slice(start, end);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function quote(priceSol = CANDIDATE * 0.99, extras = {}) {
  return {
    priceUsd: priceSol === null ? 2 : priceSol * 180,
    priceSol, mcapUsd: 25_000, fdvUsd: 30_000,
    source: 'indeix', asOf: NOW - 20,
    ...extras,
  };
}

function response(quotes) {
  return { ok: true, status: 200, json: async () => ({ asOf: NOW, quotes }) };
}

function boot(options = {}) {
  let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const observations = [];
  const diagnostics = [];
  const worker = serviceWorker({
    fetch: options.fetch || (async () => response(options.quotes || {})),
  });
  worker.ctx.Date = Clock;
  worker.ctx.PTOnchainFeed.currentQuote = () => options.onchain || null;
  const send = (message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker message timed out')), 2000);
    worker.listener(message, { id: 'papertrench-test', tab: { id: 1 } }, value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const R = vm.runInNewContext(
    sliceContent('  function okOrNull(', "  const HOST_ID =") + '\nR;',
    { sendMessage: send, resolver: null }, { filename: 'content.js#resolver-facade' });
  let refreshCalls = 0;
  worker.ctx.PaperTrenchResolver.refresh = async () => {
    refreshCalls += 1;
    return options.refresh || null;
  };
  const currentToken = options.token || {
    mint: MINT, priceNative: CANDIDATE, priceUsd: CANDIDATE * 180,
    mcap: 35_000, priceSource: 'resolver', pending: false,
  };
  const sandbox = {
    Q, R, E: { fmt: value => String(value) }, Date: Clock,
    console: { debug: (...args) => observations.push(args) }, setTimeout,
    token: currentToken, state: options.state || { positions: {} },
    lastPriceAt: NOW - 200, lastPageTickAt: NOW - 4_000,
    pageQuoteSeq: 0, pageQuoteWaiters: new Set(), site: { id: 'axiom' },
    window: { PTErrors: { record: (message, details) => diagnostics.push({ message, details }) } },
    armedBuy: null, rekeyLiveState: () => {}, sendPadreMarker: () => {},
  };
  const context = vm.createContext(sandbox);
  const ladder = vm.runInContext(
    sliceContent('/* -------------------- action-time quotes and fills',
      '/* -------------------- fills --------------------')
      + '\n;({ quoteForTrade, corroborateForFill, setEvidence: value => { lastAcceptedMarket = value; },'
      + ' getRefusal: () => lastQuoteRefusal, fmtWitness });',
    context, { filename: 'content.js#action-quotes' });
  ladder.setEvidence({ priceNative: MARKET, at: NOW - 2_000 });
  const host = vm.runInContext(
    sliceContent('  const hostSupplyRefusals =', '  function sendPadreMarker(')
      + '\n;({ handleHostFacts });',
    context, { filename: 'content.js#host-facts' });
  return {
    worker, R, send, ladder, host, token: currentToken, diagnostics, observations,
    setNow: value => { now = value; },
    refreshCalls: () => refreshCalls,
  };
}

function facts(extras = {}) {
  return {
    mint: MINT, addresses: [MINT], supply: 1_000_000, decimals: 4,
    priceUsd: null, mcap: null, source: 'axiom',
    url: 'https://axiom.trade/meme/' + MINT,
    ...extras,
  };
}

function pendingToken(mint = MINT) {
  return { mint, srcAddress: mint, pending: true, priceNative: null, priceUsd: null, mcap: null };
}

// The refusal's contract is its REASON and its legs — not its prose. Legs
// print through the real fmtWitness (significant digits, never "0 vs 0").
function assertRefusal(env, witness = null, candidate = CANDIDATE) {
  const got = env.ladder.getRefusal();
  const f = env.ladder.fmtWitness;
  assert.match(got, /Price sources disagree/, 'the refusal names its reason');
  assert.ok(got.includes(f(candidate)) && got.includes(f(MARKET)),
    `both legs print at significant digits, never "0 vs recent 0": ${got}`);
  if (witness === null) assert.match(got, /no second source/);
  else assert.ok(got.includes('witness ' + f(witness)), `the adopted witness value is shown: ${got}`);
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('D-71 E1: dead RPC plus agreeing worker permits the aggregator fill', async () => {
  const env = boot({ quotes: { [MINT]: quote() } });
  const fill = await env.ladder.quoteForTrade();
  assert.equal(fill && fill.priceNative, CANDIDATE, 'worker corroborates, it does not reprice the candidate');
  assert.equal(env.ladder.getRefusal(), null);
  assert.equal(env.refreshCalls(), 0, 'an aggregator never corroborates itself');
});

test('D-71 E1: disagreeing worker still refuses with the existing witness message', async () => {
  const env = boot({ quotes: { [MINT]: quote(MARKET / 2) } });
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env, MARKET / 2);
});

test('D-71 E1: both witnesses absent retain the exact no-second-source refusal', async () => {
  const env = boot();
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env);
  assert.equal(env.refreshCalls(), 0);
});

test('D-71 E1: worker network failure is null through the message path and cannot permit a fill', async () => {
  const env = boot({ fetch: async () => { throw new Error('network unavailable'); } });
  assert.equal(await env.send({ type: 'pt_worker_quote', mints: [MINT] }), null);
  assert.equal(await env.R.workerQuote(MINT), null);
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env);
});

test('D-71 E1: first positive chain witness wins even when a worker would agree', async () => {
  const env = boot({ onchain: { priceNative: MARKET / 2 }, quotes: { [MINT]: quote() } });
  assert.equal(await env.ladder.corroborateForFill({ mint: MINT, source: 'resolver', priceNative: CANDIDATE }), null);
  assertRefusal(env, MARKET / 2);
  assert.equal(env.worker.fetchCalls.length, 0, 'do not shop for a witness after the chain dissents');
});

test('D-71 E1: zero chain price falls through to the agreeing worker', async () => {
  const env = boot({ onchain: { priceNative: 0 }, quotes: { [MINT]: quote() } });
  assert.equal((await env.ladder.quoteForTrade())?.priceNative, CANDIDATE);
});

test('D-71 E1: a rejected facade call remains a null witness', async () => {
  const env = boot();
  env.R.workerQuote = async () => { throw new Error('message port closed'); };
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env);
});

test('D-71 E1: non-aggregator candidates still use resolver corroboration only', async () => {
  const candidate = { mint: MINT, source: 'page-feed', priceNative: MARKET * 4 };
  const env = boot({ refresh: { mint: MINT, priceNative: candidate.priceNative } });
  assert.equal(await env.ladder.corroborateForFill(candidate), candidate);
  assert.equal(env.refreshCalls(), 1);
  assert.equal(env.worker.fetchCalls.length, 0);
});

test('D-71 E1: F-56 position evidence still refuses an unwitnessed aggregator move', async () => {
  const env = boot({ state: { positions: { [MINT]: { lastPriceNative: MARKET } } } });
  env.ladder.setEvidence(null);
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env);
});

test('D-71 E2: worker corroborates supply within the existing one-percent rule', async () => {
  const env = boot({ token: pendingToken(), quotes: { [MINT]: quote(null, { priceUsd: 2, mcapUsd: 201 }) } });
  env.host.handleHostFacts(facts());
  await settle();
  assert.equal(env.token.hostSupplyUi, 100, 'atomic host units must still be normalized by the real decision');
  assert.equal(env.token.hostSupplyWitness.source, 'worker-quote');
  assert.deepEqual(plain(env.token.hostSupplyWitness.keys), { priceUsd: 2, mcap: 201, supply: 1_000_000, decimals: 4 });
  assert.equal(env.token.priceNative, null, 'a supply witness is not a fill candidate');
  assert.equal(env.token.pending, true);
});

test('D-71 E2: worker market cap outside one percent cannot legitimize host supply', async () => {
  const env = boot({ token: pendingToken(), quotes: { [MINT]: quote(null, { priceUsd: 2, mcapUsd: 202.02 }) } });
  env.host.handleHostFacts(facts());
  await settle();
  assert.equal(env.token.hostSupplyUi, undefined);
  assert.equal(env.diagnostics.at(-1)?.details.kind, 'host-facts-supply-refused');
});

test('D-71 E2: failure preserves diagnostics and caches the attempt across repeated ticks', async () => {
  const env = boot({ token: pendingToken(), fetch: async () => { throw new Error('offline'); } });
  const missing = facts();
  env.host.handleHostFacts(missing);
  env.host.handleHostFacts(missing);
  const originalDiagnostic = [{
    message: 'host supply for ' + MINT + ' lacks corroborating USD price and live market cap',
    details: {
      scope: 'content', kind: 'host-facts-supply-uncorroborated', source: 'axiom', url: missing.url,
      values: { priceUsd: null, mcap: null, supply: 1_000_000, decimals: 4 },
      missing: { priceUsd: true, mcap: true },
    },
  }];
  assert.deepEqual(plain(env.diagnostics), originalDiagnostic, 'the immediate diagnostic path is unchanged');
  await settle();
  env.setNow(NOW + 20_000); // beyond the background TTL: content must remember the failed attempt
  env.host.handleHostFacts(missing);
  env.host.handleHostFacts(facts({ mcap: 200 }));
  await settle();
  assert.equal(env.token.hostSupplyUi, undefined);
  assert.equal(env.token.hostSupplyWitness, undefined);
  assert.equal(env.worker.fetchCalls.length, 1, 'failure is cached per mint, not per fact payload');
  assert.deepEqual(plain(env.diagnostics[0]), originalDiagnostic[0]);
  assert.deepEqual(plain(env.diagnostics[1].details.missing), { priceUsd: true, mcap: false });
});

test('uncorroborated-supply diagnostics dedupe by shape, not by tick values', async () => {
  // September debug reports carried the same "lacks corroborating USD
  // price" fact x243: the dedupe keyed on tick VALUES, so every tick was
  // a new episode and exports ballooned to 145 KB of one repeated fact.
  const env = boot({ token: pendingToken() });
  for (let i = 0; i < 10; i++) {
    env.host.handleHostFacts(facts({ supply: 1000000 + i * 7, mcap: null, priceUsd: null }));
  }
  await settle();
  const uncorr = env.diagnostics.filter((d) => d.message && d.message.includes('lacks corroborating'));
  assert.equal(uncorr.length, 1, 'ten ticks, one shape, one diagnostic — never one episode per tick');
});

test('the supply worker attempt retries per minute, never per tick', async () => {
  const env = boot({ token: pendingToken(), quotes: {} });
  const missing = () => facts({ supply: 1000000, mcap: null, priceUsd: null });
  env.host.handleHostFacts(missing());
  await settle();
  assert.equal(env.worker.fetchCalls.length, 1, 'the first attempt fires immediately');
  env.host.handleHostFacts(missing());
  await settle();
  assert.equal(env.worker.fetchCalls.length, 1, 'no per-tick storm while the answer stays missing');
  env.setNow(NOW + 61_000);
  env.host.handleHostFacts(missing());
  await settle();
  assert.equal(env.worker.fetchCalls.length, 2, 'a transient miss recovers within the minute');
});

test('D-71 E2: in-flight host witness cannot overwrite a rekeyed token', async () => {
  let release;
  const reply = new Promise(resolve => { release = resolve; });
  const env = boot({ token: pendingToken(), fetch: async () => reply });
  env.host.handleHostFacts(facts());
  env.host.handleHostFacts(facts());
  await settle();
  // Host identity adoption mutates the pending token in place. An object-only
  // check misses this race: old facts remain tied to its original srcAddress.
  env.host.handleHostFacts(facts({ mint: OTHER, priceUsd: 2, mcap: 400, supply: 2_000_000 }));
  assert.equal(env.token.mint, OTHER);
  release(response({ [MINT]: quote(null, { priceUsd: 2, mcapUsd: 200 }) }));
  await settle();
  assert.equal(env.token.mint, OTHER);
  assert.equal(env.token.hostSupplyUi, 200, 'a late quote cannot overwrite the newer host supply');
  assert.equal(env.token.hostSupplyWitness.source, 'axiom');
  assert.equal(env.worker.fetchCalls.length, 1);
});

test('D-71 E2: fully united host facts keep the synchronous path without a worker read', () => {
  const env = boot({ token: pendingToken() });
  env.host.handleHostFacts(facts({ priceUsd: 2, mcap: 200 }));
  assert.equal(env.token.hostSupplyUi, 100);
  assert.equal(env.token.hostSupplyWitness.source, 'axiom');
  assert.equal(env.worker.fetchCalls.length, 0);
});

test('D-71 E2: FDV is not substituted for an absent live market cap', async () => {
  const env = boot({ token: pendingToken(), quotes: { [MINT]: quote(null, { priceUsd: 2, mcapUsd: null, fdvUsd: 200 }) } });
  env.host.handleHostFacts(facts());
  await settle();
  assert.equal(env.token.hostSupplyUi, undefined);
  assert.equal(env.diagnostics.at(-1)?.details.kind, 'host-facts-supply-uncorroborated');
});

test('D-71 E1: mint-set cache normalizes order, coalesces in-flight requests, and expires', async () => {
  let release;
  const reply = new Promise(resolve => { release = resolve; });
  const firstQuote = quote(CANDIDATE, { mcapUsd: null, fdvUsd: null });
  const env = boot({ fetch: async () => reply });
  const a = env.send({ type: 'pt_worker_quote', mints: [OTHER, MINT, MINT] });
  const b = env.send({ type: 'pt_worker_quote', mints: [MINT, OTHER] });
  await settle();
  const inFlightRequests = env.worker.fetchCalls.length;
  release(response({ [MINT]: firstQuote }));
  const [one, two] = await Promise.all([a, b]);
  assert.equal(inFlightRequests, 1);
  const url = new URL(env.worker.fetchCalls[0]);
  assert.equal(url.origin + url.pathname, 'https://papertrench-api.onerobby.workers.dev/api/quote');
  assert.deepEqual(url.searchParams.get('mints').split(','), [MINT, OTHER].sort());
  assert.deepEqual(plain(one), { [MINT]: { priceNative: CANDIDATE, priceUsd: CANDIDATE * 180, mcapUsd: null, fdvUsd: null, at: NOW - 20 } });
  assert.deepEqual(plain(two), plain(one));
  assert.equal(one[OTHER], undefined, 'unknown mints remain omitted');
  env.setNow(NOW + 9_999);
  await env.send({ type: 'pt_worker_quote', mints: [OTHER, MINT] });
  assert.equal(env.worker.fetchCalls.length, 1);
  env.setNow(NOW + 10_001);
  await env.send({ type: 'pt_worker_quote', mints: [OTHER, MINT] });
  assert.equal(env.worker.fetchCalls.length, 2);
});

test('D-71 E1: missing SOL anchor stays null at the boundary but vouches via the live rate', async () => {
  const env = boot({ quotes: { [MINT]: quote(null, { priceUsd: CANDIDATE * 180 }) } });
  const mapped = await env.R.workerQuote(MINT);
  assert.equal(mapped.priceNative, null, 'the background never invents a native price');
  assert.equal(mapped.priceUsd, CANDIDATE * 180);
  env.R.solUsd = async () => 180;
  const fill = await env.ladder.quoteForTrade();
  assert.equal(fill && fill.priceNative, CANDIDATE, 'a USD-only worker vouches through the live cached rate');
  assert.equal(env.ladder.getRefusal(), null);
});

test('USD-only worker without a rate still refuses — never an invented conversion', async () => {
  const env = boot({ quotes: { [MINT]: quote(null, { priceUsd: 2, mcapUsd: 200 }) } });
  env.R.solUsd = async () => 0;
  assert.equal(await env.ladder.quoteForTrade(), null);
  assertRefusal(env);
});

test('non-aggregator candidates fall back to the worker when refresh misses', async () => {
  // A page-feed candidate diverging from evidence with a dead aggregator
  // used to refuse without ever asking the independent worker (hole D).
  const candidate = { mint: MINT, source: 'page-feed', priceNative: MARKET * 4 };
  const env = boot({ refresh: null, quotes: { [MINT]: quote(MARKET * 4 * 0.99) } });
  const fill = await env.ladder.corroborateForFill(candidate);
  assert.equal(fill, candidate, 'the worker vouches a page-feed candidate the aggregator cannot see');
  assert.equal(env.refreshCalls(), 1, 'refresh stays the primary witness for its own family');
  assert.equal(env.worker.fetchCalls.length, 1, 'the worker is consulted exactly once, on the miss');
});

test('worker-quote misses expire fast while hits keep the full TTL', async () => {
  const env = boot({ quotes: {} }); // every fetch answers empty
  assert.deepEqual(plain(await env.send({ type: 'pt_worker_quote', mints: [MINT] })), {});
  assert.deepEqual(plain(await env.send({ type: 'pt_worker_quote', mints: [MINT] })), {});
  assert.equal(env.worker.fetchCalls.length, 1, 'immediate misses still coalesce — no retry storm');
  env.setNow(NOW + 2_500);
  await env.send({ type: 'pt_worker_quote', mints: [MINT] });
  assert.equal(env.worker.fetchCalls.length, 2, 'a miss must not bar the next click for ten seconds');
});

test('fmtWitness prints dust at significant digits, never bare zero', () => {
  const env = boot();
  const f = env.ladder.fmtWitness;
  assert.equal(f(1.05e-8), '0.0000000105', 'dust legs stay distinguishable in pasted refusals');
  assert.equal(f(1.4e-7), '0.00000014');
  assert.equal(f(0.5), '0.5');
  assert.equal(f(1234.5678), '1235');
  assert.equal(f(0), '0');
  assert.equal(f(null), '0');
  assert.doesNotMatch(f(1.05e-8), /e[+-]/i, 'no exponents anywhere in the overlay');
});

test('D-71 E1: invalid mint sets never reach the worker and upstream failure returns null', async () => {
  const env = boot({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: 'upstream' }) }) });
  assert.equal(await env.send({ type: 'pt_worker_quote', mints: [MINT, 'not-a-solana-mint'] }), null);
  assert.equal(await env.send({ type: 'pt_worker_quote', mints: [] }), null);
  assert.equal(env.worker.fetchCalls.length, 0);
  assert.equal(await env.send({ type: 'pt_worker_quote', mints: [MINT] }), null);
  assert.equal(await env.R.workerQuote(MINT), null);
});

test('D-71 E1: hidden warm viewers do not spend worker quote traffic', async () => {
  const env = boot({ quotes: { [MINT]: quote() } });
  vm.runInContext('warmViewerTabs.add(1)', env.worker.ctx);
  assert.equal(await env.R.workerQuote(MINT), null);
  assert.equal(env.worker.fetchCalls.length, 0);
});
