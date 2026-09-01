/* HTTP 429s are rate limits, not endpoint failures. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadPool(fetchImpl) {
  const self = {};
  self.self = self;
  const ctx = vm.createContext({
    self,
    fetch: fetchImpl,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    setTimeout, clearTimeout,
    Map, Set, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    Error, RegExp, Infinity, isFinite,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'rpc-pool.js'), 'utf8'), ctx, {
    filename: 'rpc-pool.js',
  });
  return self.PTRpcPool;
}

const okResponse = (result) => ({
  ok: true,
  status: 200,
  json: async () => ({ jsonrpc: '2.0', id: 1, result }),
});

const throttleResponse = (retryAfter) => ({
  ok: false,
  status: 429,
  ...(retryAfter === undefined ? {} : {
    headers: { get: (name) => name === 'retry-after' ? retryAfter : null },
  }),
  json: async () => ({}),
});

test('two consecutive 429s do not bench an endpoint and fail over', async () => {
  let userCalls = 0;
  const P = loadPool(async (url) => {
    if (String(url).includes('my-throttled-node')) {
      userCalls += 1;
      return throttleResponse();
    }
    return okResponse('healthy');
  });
  P.setUserEndpoint('https://my-throttled-node.example.com');

  assert.equal(await P.call('getSlot', []), 'healthy');
  assert.equal(await P.call('getSlot', []), 'healthy');
  assert.equal(userCalls, 2, 'the throttled endpoint should be attempted twice');
  const state = P._health.get('user');
  assert.equal(state.failures, 0, '429s must not take transient strikes');
  assert.equal(state.benchedUntil, 0, '429s must not bench an endpoint');
});

test('an all-429 pool attempts every endpoint and returns the HTTP 429 error', async () => {
  let fetchCalls = 0;
  const P = loadPool(async () => {
    fetchCalls += 1;
    return throttleResponse();
  });

  await assert.rejects(() => P.call('getMultipleAccounts', []), /http 429/);
  assert.equal(fetchCalls, P.PUBLIC_ENDPOINTS.length,
    'each all-throttled endpoint should remain eligible for this call');
});

test('Retry-After uses bounded delta-seconds and the two-second default', async () => {
  const cases = [
    ['3', 3000, 'delta-seconds'],
    [undefined, 2000, 'missing header'],
    ['Wed, 21 Oct 2015 07:28:00 GMT', 2000, 'HTTP-date'],
    ['600', 15000, 'large delta-seconds'],
  ];

  for (const [raw, expected, label] of cases) {
    const P = loadPool(async (url) => {
      if (String(url).includes('retry-node')) return throttleResponse(raw);
      return okResponse('healthy');
    });
    P.setUserEndpoint('https://retry-node.example.com');
    const before = Date.now();
    await P.call('getSlot', []);
    const until = P._health.get('user').throttledUntil;
    assert.ok(until > before + expected - 500,
      `${label}: throttle should last at least its bounded duration`);
    assert.ok(until <= before + expected + 1000,
      `${label}: throttle should not exceed its bounded duration plus clock slack`);
  }
});

test('a subsequent success clears an endpoint throttle', async () => {
  let userCalls = 0;
  const P = loadPool(async (url) => {
    if (String(url).includes('recovering-node')) {
      userCalls += 1;
      return userCalls === 1 ? throttleResponse('3') : okResponse('recovered');
    }
    return okResponse('fallback');
  });
  P.setUserEndpoint('https://recovering-node.example.com');

  await P.call('getSlot', []);
  assert.ok(P._health.get('user').throttledUntil > Date.now());
  assert.equal(await P.call('getSlot', []), 'recovered');
  assert.equal(P._health.get('user').throttledUntil, 0);
});

test('a 429 leaves the strike decay clock untouched', () => {
  const P = loadPool(async () => okResponse('ok'));
  const target = P.ranked()[0];
  P.reportFailure(target.id);
  const state = P._health.get(target.id);
  const oldFailureAt = Date.now() - 180000;
  state.lastFailureAt = oldFailureAt;

  P.reportFailure(target.id, { kind: 'throttle', retryAfterMs: 3000 });
  assert.equal(state.lastFailureAt, oldFailureAt);
  P.reportFailure(target.id);
  assert.equal(state.benchedUntil, 0,
    'the old strike must decay before the later transient failure counts');
});

test('a websocket success preserves an active throttle but HTTP success clears it', () => {
  const P = loadPool(async () => okResponse('ok'));
  const target = P.ranked()[0];
  P.reportFailure(target.id, { kind: 'throttle', retryAfterMs: 15000 });
  const until = P._health.get(target.id).throttledUntil;

  P.reportSuccess(target.id, null, { transport: 'ws' });
  assert.equal(P._health.get(target.id).throttledUntil, until,
    'opening a websocket must not cancel the HTTP Retry-After window');

  P.reportSuccess(target.id, 100);
  assert.equal(P._health.get(target.id).throttledUntil, 0,
    'an HTTP success must clear the throttle');
});

test('socket open reports websocket transport explicitly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  assert.match(src, /POOL\.reportSuccess\(candidate\.id, null, \{\s*transport:\s*['"]ws['"]\s*\}\)/,
    'socket open must identify its transport when reporting success');
});

test('a throttled endpoint sorts behind a healthy endpoint', () => {
  const P = loadPool(async () => okResponse('ok'));
  const [throttled, healthy] = P.ranked();
  P.reportFailure(throttled.id, { kind: 'throttle', retryAfterMs: 3000 });

  const order = P.ranked().map((endpoint) => endpoint.id);
  assert.ok(order.indexOf(healthy.id) < order.indexOf(throttled.id),
    'a currently throttled endpoint must rank behind a healthy one');
});

test('network failures still take two strikes and bench unchanged', async () => {
  let userCalls = 0;
  const P = loadPool(async (url) => {
    if (String(url).includes('failing-node')) {
      userCalls += 1;
      throw new Error('network down');
    }
    return okResponse('healthy');
  });
  P.setUserEndpoint('https://failing-node.example.com');

  assert.equal(await P.call('getSlot', []), 'healthy');
  assert.equal(await P.call('getSlot', []), 'healthy');
  assert.equal(userCalls, 2);
  const state = P._health.get('user');
  assert.equal(state.failures, 2);
  assert.ok(state.benchedUntil > Date.now());
});
