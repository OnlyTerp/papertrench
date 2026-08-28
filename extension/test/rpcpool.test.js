/* Keyless RPC endpoint pool.
 *
 * PaperTrench ships no API key, because an extension bundle is public — Avast
 * (7M users), Awesome Screen Recorder (3M) and Equatio (5M) all leaked live
 * credentials exactly that way. A shipped key would also mean one shared rate
 * limit for every user of the product.
 *
 * Public Solana RPC limits are enforced per IP, so keyless endpoints scale
 * across installs automatically. They do throttle and disappear, though, so
 * these tests pin the failover behaviour that keeps the feed alive.
 */
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

/* ---------------- no shipped credentials ---------------- */

test('no endpoint in the shipped pool carries an API key', () => {
  const P = loadPool(async () => okResponse('ok'));
  for (const endpoint of P.PUBLIC_ENDPOINTS) {
    const urls = [endpoint.http, endpoint.ws].filter(Boolean).join(' ');
    assert.doesNotMatch(urls, /api[-_]?key=|\/v1\/[0-9a-f]{16,}|token=/i,
      `${endpoint.id} looks like it embeds a credential: ${urls}`);
  }
});

test('the shipped source contains no credential-shaped literal', () => {
  // The exact scan a bundle scraper would run.
  for (const file of ['rpc-pool.js', 'onchain-feed.js', 'onchain.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(src, /sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}/,
      `${file} contains something shaped like a live credential`);
  }
});

test('the default settings ship no RPC key and no forced endpoint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  assert.match(src, /rpcUrl: ''/,
    'rpcUrl must default to empty, meaning the keyless pool');
});

/* ---------------- failover ---------------- */

test('a throttled endpoint fails over instead of killing the price feed', async () => {
  const seen = [];
  const P = loadPool(async (url) => {
    seen.push(url);
    // First endpoint is rate-limited, exactly what a public node does.
    if (seen.length === 1) return { ok: false, status: 429, json: async () => ({}) };
    return okResponse({ value: 'live' });
  });

  const result = await P.call('getAccountInfo', []);
  assert.deepEqual(result, { value: 'live' }, 'the call must still succeed');
  assert.ok(seen.length >= 2, 'a 429 must be retried on a different endpoint');
  assert.notEqual(seen[0], seen[1], 'failover must move to a different provider');
});

test('an endpoint that returns an rpc error is treated as a failure', async () => {
  let calls = 0;
  const P = loadPool(async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => ({ error: { message: 'blocked' } }) };
    }
    return okResponse('recovered');
  });

  assert.equal(await P.call('getHealth', []), 'recovered');
  assert.ok(calls >= 2, 'an rpc-level error must fail over too');
});

test('when every endpoint is down the caller gets an error, never a fake price', async () => {
  const P = loadPool(async () => { throw new Error('network down'); });
  await assert.rejects(() => P.call('getAccountInfo', []),
    'a total outage must surface as an error rather than a fabricated value');
});

/* ---------------- health ranking ---------------- */

test('a repeatedly failing endpoint is benched behind healthy ones', () => {
  const P = loadPool(async () => okResponse('ok'));
  const first = P.ranked()[0];

  P.reportFailure(first.id);
  P.reportFailure(first.id);

  const afterBenching = P.ranked();
  assert.notEqual(afterBenching[0].id, first.id,
    'an endpoint that failed twice must not stay the first choice');
  assert.ok(afterBenching.some((e) => e.id === first.id),
    'a benched endpoint is kept for later recovery, not discarded');
});

test('a benched endpoint recovers once it succeeds again', () => {
  const P = loadPool(async () => okResponse('ok'));
  const target = P.ranked()[0];

  P.reportFailure(target.id);
  P.reportFailure(target.id);
  P.reportSuccess(target.id, 120);

  assert.equal(P.ranked()[0].id, target.id,
    'a recovered endpoint must be usable as the first choice again');
});

test('a faster endpoint is preferred once latency is known', () => {
  const P = loadPool(async () => okResponse('ok'));
  const [a, b] = P.ranked();

  P.reportSuccess(a.id, 900);
  P.reportSuccess(b.id, 90);

  assert.equal(P.ranked()[0].id, b.id, 'the measurably faster endpoint must win');
});

test('even with everything benched an endpoint is still offered', () => {
  const P = loadPool(async () => okResponse('ok'));
  for (const endpoint of P.ranked()) {
    P.reportFailure(endpoint.id);
    P.reportFailure(endpoint.id);
  }
  assert.ok(P.ranked().length > 0,
    'a total bench must still yield a least-bad option rather than no feed at all');
});

/* ---------------- optional user endpoint ---------------- */

test('a user-supplied endpoint is preferred but never required', () => {
  const P = loadPool(async () => okResponse('ok'));
  assert.equal(P.hasUserEndpoint(), false, 'no endpoint is required by default');
  assert.ok(P.ranked().length > 0, 'the keyless pool works with no configuration');

  P.setUserEndpoint('https://my-private-node.example.com');
  assert.equal(P.hasUserEndpoint(), true);
  assert.equal(P.ranked()[0].id, 'user', 'a private endpoint must take priority');
});

test('a malformed user endpoint is ignored rather than breaking the feed', () => {
  const P = loadPool(async () => okResponse('ok'));
  for (const bad of ['', 'not a url', 'ftp://nope', null, undefined]) {
    P.setUserEndpoint(bad);
    assert.equal(P.hasUserEndpoint(), false, `"${bad}" must not be accepted`);
    assert.ok(P.ranked().length > 0, 'the public pool must remain usable');
  }
});

test('a user http endpoint yields a matching websocket url', () => {
  const P = loadPool(async () => okResponse('ok'));
  P.setUserEndpoint('https://my-node.example.com/rpc');
  const [first] = P.websocketUrls();
  assert.equal(first.id, 'user');
  assert.equal(first.url, 'wss://my-node.example.com/rpc');
});

/* ---------------- websocket ranking ---------------- */

test('only endpoints that actually support websockets are offered for streaming', () => {
  const P = loadPool(async () => okResponse('ok'));
  for (const entry of P.websocketUrls()) {
    assert.ok(entry.url && /^wss?:\/\//.test(entry.url),
      `${entry.id} offered a non-websocket url: ${entry.url}`);
  }
});

test('the feed walks the ranked websocket list instead of one hardcoded url', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  assert.match(src, /POOL\.websocketUrls\(\)/,
    'the feed must take its socket endpoints from the pool');
  assert.match(src, /wsIndex \+= 1/,
    'a failed socket must advance to a different provider');
  assert.doesNotMatch(src, /const DEFAULT_RPC/,
    'the feed must not hardcode a single endpoint any more');
});

/* ---------------- DEFECT F-09: benched-pool circuit breaker ------------- */

test("F-09: a fully benched pool fails fast instead of hammering dead endpoints", async () => {
  let fetchCalls = 0;
  const P = loadPool(async () => { fetchCalls += 1; throw new Error("throttled"); });

  // Each failing call walks the whole pool, putting one strike on every
  // endpoint; two calls bench them all (two-strike rule).
  await assert.rejects(() => P.call("getSlot", []));
  await assert.rejects(() => P.call("getSlot", []));
  const afterBenching = fetchCalls;

  // Third call is the single half-open probe: exactly one endpoint touched.
  await assert.rejects(() => P.call("getSlot", []));
  assert.equal(fetchCalls, afterBenching + 1,
    "the half-open probe must touch exactly one endpoint, not the whole pool");

  // Inside the probe window the pool fails fast with ZERO network traffic —
  // hammering benched endpoints kept them benched forever (the F-09 cascade).
  await assert.rejects(() => P.call("getSlot", []), /cooling down/);
  assert.equal(fetchCalls, afterBenching + 1,
    "no network traffic while the pool cools down");
});

test("F-27: the abort timer clears on every path, including a rejected fetch", () => {
  // The fetch + timer moved from call() into attemptEndpoint() when hedged
  // failover landed; the contract is unchanged and anchors there now.
  const src = fs.readFileSync(path.join(ROOT, "rpc-pool.js"), "utf8");
  const fnStart = src.indexOf("function attemptEndpoint(");
  assert.ok(fnStart !== -1, "the per-endpoint attempt must exist");
  const block = src.slice(fnStart, src.indexOf("\n  }", fnStart) + 4);
  assert.match(block, /\.finally\(\(\) => \{[\s\S]*?clearTimeout\(timer\)/,
    "clearTimeout must live in a finally so a rejected fetch cannot leak the abort timer");
});

const FAKE_ADDR = '4w2cysotX6czaUGmmWg13hDpY4QEMG2CzeKYEQyK9Ama';
const blockedResponse = () => ({ ok: false, status: 403 });

test("F-63 refined: one 403 demotes to the back of the line, no bench, evidence armed", async () => {
  // Scripted WAF: only publicnode refuses, every other endpoint serves.
  // The call must still SUCCEED via failover — that is the demotion design:
  // the next call starts elsewhere without the endpoint leaving the pool.
  const P = loadPool(async (url) => {
    if (String(url).includes('publicnode')) throw new TypeError('no network in unit tests');
    return okResponse('ok');
  });
  const urlOf = (id) => P.PUBLIC_ENDPOINTS.find((e) => e.id === id).http;
  const P403 = loadPool(async (url) => {
    if (String(url).includes('publicnode')) return blockedResponse();
    return okResponse('ok');
  });
  await P403.call('getMultipleAccounts', [[FAKE_ADDR], { encoding: 'base64' }]);
  const s = P403._health.get('publicnode');
  assert.equal(s.benchedUntil, 0, 'a single 403 must not bench the endpoint');
  assert.ok(s.methodEvidence.getMultipleAccounts > 0, 'evidence must be armed after one 403');
  assert.ok(s.demotedUntil > Date.now(), 'the endpoint must be demoted after a 403');
  const order = P403.ranked({ method: 'getSlot' }).map((e) => e.id);
  assert.notEqual(order[0], 'publicnode',
    'the demoted endpoint must not lead the next call for any method');
  // A success on the endpoint lifts the demotion and disarms the evidence.
  P403.reportSuccess('publicnode', 120);
  assert.equal(P403._health.get('publicnode').demotedUntil, 0,
    'a success must lift the 403 demotion');
  assert.ok(!P403._health.get('publicnode').methodEvidence.getMultipleAccounts,
    'a success must disarm pending method evidence');
  // Pool isolation: vm-scoped instances must not share health state — the
  // untouched pool must have an empty health map after the other pool
  // served a 403 and two successes.
  assert.equal(P._health.size, 0,
    'separate pool instances must not share health state');
});

test("F-63 refined: a second 403 on the same method confirms the block; 403s never take transient strikes", async () => {
  // Every endpoint refuses getMultipleAccounts but serves everything else —
  // exactly a keyless WAF policy against heavy scans.
  let fetchCalls = 0;
  const P = loadPool(async (url, init) => {
    const body = init && init.body ? String(init.body) : '';
    fetchCalls += 1;
    if (body.includes('getMultipleAccounts')) return blockedResponse();
    return okResponse(12345);
  });
  // Two gMA attempts: the first arms evidence, the second confirms policy.
  await assert.rejects(() => P.call('getMultipleAccounts', [[FAKE_ADDR], {}]), /403/);
  await assert.rejects(() => P.call('getMultipleAccounts', [[FAKE_ADDR], {}]), /403/);
  const s = P._health.get('publicnode');
  assert.ok(s.methodBlocks.getMultipleAccounts > Date.now(),
    'two 403s on one method must confirm the method block');
  assert.equal(s.benchedUntil, 0,
    'method 403s must never take transient strikes (the ark_trades13 spiral)');
  // A confirmed block must not poison other methods: getSlot still serves.
  const slot = await P.call('getSlot', []);
  assert.equal(slot, 12345, 'a method block must leave other methods working');
  // With every endpoint confirmed-blocked for gMA, the pool fails fast with
  // ZERO new network traffic — the anti-hammer contract.
  const callsBefore = fetchCalls;
  await assert.rejects(() => P.call('getMultipleAccounts', [[FAKE_ADDR], {}]), /403|blocked/);
  assert.equal(fetchCalls, callsBefore,
    'a fully method-blocked pool must fail fast without network traffic');
});
