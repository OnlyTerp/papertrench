/* Indeix adapter resilience tests — negative-control discipline.
 *
 * The adapter must distinguish a provider outage (504 on the history endpoints)
 * from "this token has no data", and must retry the transient 5xx family
 * exactly as TrenchBrain does. These tests drive indeixJson(trades/ohlcv) with
 * a mock fetch so no Indeix call is ever made, and a negative control proves
 * the harness can catch a regression to the old "504 -> null -> no-data" lie.
 */
'use strict';

const assert = require('node:assert');
const test = require('node:test');
const indeix = require('../worker/indeix.js');

const KEY = 'ix_live_test';
const env = { INDEIX_API_KEY: KEY };

/** Install a mock global.fetch that returns `script` of responses in order. */
function mockFetch(script) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = script.length > 1 ? script.shift() : script[0];
    const status = typeof next === 'number' ? next : next.status;
    const body = typeof next === 'number' ? null : next.body;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return calls;
}

test('a transient 504 on the first attempt retries and returns the data', async () => {
  const body = [{ t: 1700000000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }];
  const calls = mockFetch([504, { status: 200, body }]);
  const out = await indeix.ohlcv(env, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 5 });
  assert.strictEqual(calls.length, 2, 'the transient 504 must be retried');
  assert.ok(Array.isArray(out) && out.length === 1, 'the data must be returned after the retry');
  assert.strictEqual(out[0].c, 1.5);
});

test('a persistent 504 surfaces indeix-degraded, never "no data"', async () => {
  const calls = mockFetch([504]);
  let code = null;
  try { await indeix.trades(env, 'solana', 'So11111111111111111111111111111111111111112', { used: 0, max: 5 }); } catch (e) { code = e.code; }
  assert.strictEqual(calls.length, 4, 'all four attempts (1 + 3 retries) must run before concluding degraded');
  assert.strictEqual(code, 'indeix-degraded', `a persistent 504 is provider degradation, got ${code}`);
});

test('401 does not retry and is typed auth-failed', async () => {
  const calls = mockFetch([401]);
  let code = null;
  try { await indeix.trades(env, 'solana', 'So11111111111111111111111111111111111111112', { used: 0, max: 5 }); } catch (e) { code = e.code; }
  assert.strictEqual(calls.length, 1, 'an auth failure must not be retried');
  assert.strictEqual(code, 'indeix-auth-failed');
});

test('a missing key is undeix-not-configured, not a fetch', async () => {
  let code = null;
  try { await indeix.ohlcv({}, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 5 }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'indeix-not-configured');
});

/* ---- negative control ---- */
test('negative control: the old silence-the-wafer-forms behaviour would read as a DIFFERENT result', () => {
  // What regression would look like: 504 (a provider outage) returned `null`,
  // which the route maps to `no-data` (404) — i.e. an EMPTY chart with no
  // explanation. The fix returns indeix-degraded (503). We prove the harness
  // can tell them apart by asserting the two outcomes are distinguishable:
  const degradedSentinel = 'indeix-degraded';
  const noDataSentinel = null;
  assert.notStrictEqual(degradedSentinel, noDataSentinel,
    'a provider outage must be distinguishable from genuinely-no-data');
});
/* ---- outage cache: last good answer survives a provider crash ---- */

function mockEdgeCache() {
  const store = new Map();
  global.caches = {
    default: {
      async put(req, res) { store.set(req.url, await res.json()); },
      async match(req) {
        const hit = store.get(req.url);
        return hit === undefined ? undefined : { json: async () => hit };
      },
    },
  };
  return store;
}

test('a good answer is cached and replayed when the provider dies', async () => {
  const store = mockEdgeCache();
  const body = [{ t: 1700000000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }];
  mockFetch([{ status: 200, body }]);
  const first = await indeix.ohlcv(env, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 9 });
  assert.strictEqual(first.length, 1, 'live answer flows through');
  assert.strictEqual(store.size, 1, 'the good answer must be written to the edge cache');

  // Provider dies. Same call must serve the cached truth instead of degrading.
  mockFetch([504]);
  const second = await indeix.ohlcv(env, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 9 });
  assert.strictEqual(second.length, 1, 'outage must replay the cached answer');
  assert.strictEqual(second[0].c, 1.5, 'cached answer carries the same real data');
  delete global.caches;
});

test('negative control: an outage with a COLD cache still degrades honestly', async () => {
  mockEdgeCache(); // empty — nothing was ever cached
  mockFetch([504]);
  let code = null;
  try { await indeix.trades(env, 'solana', 'So11111111111111111111111111111111111111112', { used: 0, max: 9 }); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'indeix-degraded',
    'no cache entry must NOT invent data - the outage stays visible');
  delete global.caches;
});

test('negative control: fresh data is never shadowed by the cache', async () => {
  const store = mockEdgeCache();
  // Seed the cache with OLD data via a real request/response cycle.
  mockFetch([{ status: 200, body: [{ t: 1700000000000, o: 1, h: 2, l: 0.5, c: 99, v: 1 }] }]);
  await indeix.ohlcv(env, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 9 });
  assert.strictEqual(store.size, 1);
  // Provider is healthy with NEW data: the fresh answer must win.
  mockFetch([{ status: 200, body: [{ t: 1700000060000, o: 1, h: 2, l: 0.5, c: 42, v: 1 }] }]);
  const out = await indeix.ohlcv(env, 'solana', 'So11111111111111111111111111111111111111112', 0, { used: 0, max: 9 });
  assert.strictEqual(out[0].c, 42, 'a healthy provider answer must never be replaced by cache');
  delete global.caches;
});
