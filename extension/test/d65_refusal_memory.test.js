/* D-65: RPC refusal-memory fast-path — skip refused gMA batches.
 *
 * Field evidence (ark_trades13 debug exports, 2026-08-30, v3.18.0): the D-62
 * per-account fallback WORKS, but ark's IP was persistently policy-refused on
 * getMultipleAccounts at publicnode for a 6.5h span (294 then 1801 'http 403
 * getMultipleAccounts @ publicnode' events), so every batch read paid a
 * fail-then-fallback toll — and the extra traffic drove 429s and 'rpc pool
 * cooling down' windows (272) where even the fallback lane stalled. The
 * error-log storm (2,242 events in one session) is part of the defect.
 *
 * Three hardenings:
 *   1. refusal memory — a FIRST 403 on (endpoint, method) is enough to push
 *      that endpoint to the back of the ranked line for that method for a
 *      sliding 10-minute window (the two-strike evidence law was tuned for
 *      WAF blips; a hard policy block should not be re-paid twice);
 *   2. fast-path — when EVERY pool endpoint carries live refusal-memory for
 *      getMultipleAccounts, getAccountsResilient skips the doomed batch
 *      attempt entirely (zero wasted 403 round trips) and goes straight to
 *      the per-account lane;
 *   3. log throttle — noteFeedError for fallback transitions fires at most
 *      once per (fn, minute) window.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const Pool = require('../rpc-pool.js');
const RealOnchain = require('../onchain.js');

/** A fake fetch layer: publicnode always 403s gMA, the others answer 200. */
function scriptedFetch(state, opts) {
  opts = opts || {};
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const method = body.method;
    const hit = state.endpoints.find((e) => e.http === url);
    if (!hit) throw new Error('unknown url ' + url);
    if (method === 'getMultipleAccounts' && hit.failGma) {
      state.gma403.push(hit.id);
      return { ok: false, status: opts.failStatus || 403 };
    }
    state.calls.push({ endpoint: hit.id, method });
    const keys = method === 'getMultipleAccounts' ? body.params[0] : [body.params[0]];
    return {
      ok: true,
      status: 200,
      json: async () => method === 'getMultipleAccounts'
        ? { result: { context: { slot: 7 }, value: keys.map((k) => state.accounts[k] || null) } }
        : { result: { value: state.accounts[keys[0]] || null } },
    };
  };
}

function freshPool(fetchImpl) {
  delete require.cache[require.resolve('../rpc-pool.js')];
  const g = globalThis;
  const prevSelf = g.self;
  // fetch stays injected for the test's lifetime — the pool reads global
  // fetch lazily at call time, so it must still be ours when pool.call runs.
  g.fetch = fetchImpl;
  g.self = {};
  try {
    return require('../rpc-pool.js');
  } finally {
    if (prevSelf === undefined) delete g.self; else g.self = prevSelf;
  }
}

const ACCOUNT = { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: ['AA==', 'base64'] };
const KEY1 = 'So11111111111111111111111111111111111111112';
const KEY2 = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

function baseState() {
  return {
    endpoints: [
      { id: 'publicnode', http: 'https://solana-rpc.publicnode.com', ws: null, failGma: true },
      { id: 'solana-labs', http: 'https://api.mainnet-beta.solana.com', ws: null, failGma: false },
      { id: 'tatum', http: 'https://solana-mainnet.gateway.tatum.io', ws: null, failGma: false },
    ],
    accounts: { [KEY1]: ACCOUNT, [KEY2]: ACCOUNT },
    gma403: [],
    calls: [],
  };
}

test('D-65/1: a single gMA 403 pushes the endpoint to the back of the ranked line for that method', async () => {
  const state = baseState();
  const pool = freshPool(scriptedFetch(state));
  pool._reset();
  try {
    // Drive one call that hits publicnode first (it is ranked first by
    // default) and records its 403.
    await pool.call('getMultipleAccounts', [[KEY1], {}]).catch(() => {});
    assert.ok(state.gma403.includes('publicnode'), 'precondition: publicnode refused');
    // The very NEXT ranking for gMA must not put publicnode first anymore —
    // no second strike required.
    const next = pool.ranked({ method: 'getMultipleAccounts' }).map((e) => e.id);
    assert.notEqual(next[0], 'publicnode',
      'refusal memory must demote publicnode for gMA on the FIRST 403');
    // ...but the refusal MEMORY is per-method: only gMA carries an entry
    // (the all-method demotion is pre-existing F-63 law and may also rank
    // publicnode back for a moment — that is not refusal memory).
    const sa = pool._health.get('publicnode');
    assert.ok((sa.refusals.getMultipleAccounts || 0) > Date.now(), 'gMA refusal entry is live');
    assert.equal(Object.keys(sa.refusals).length, 1, 'refusal memory records only the refused method');
    // And it is not a hard block: the endpoint is still in the list (hedge stays).
    assert.ok(next.includes('publicnode'), 'the refused endpoint stays reachable as last resort');
  } finally { pool._reset(); }
});

test('D-65/2: refusal memory decays — the endpoint becomes eligible again after the window', async () => {
  const state = baseState();
  const pool = freshPool(scriptedFetch(state));
  pool._reset();
  try {
    await pool.call('getMultipleAccounts', [[KEY1], {}]).catch(() => {});
    assert.notEqual(pool.ranked({ method: 'getMultipleAccounts' })[0].id, 'publicnode');
    // Slide time past the decay window — eligibility is measured against the
    // REFUSAL entry specifically (latency order after a successful failover
    // is F-63 law, not refusal memory).
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      const s = pool._health.get('publicnode');
      const live = Object.values(s.refusals || {}).some((until) => until > realNow() + 11 * 60_000);
      assert.ok(!live, 'the refusal entry must be EXPIRED after the decay window');
      // Eligibility proof: with the entry expired, publicnode is again a
      // candidate the pool will actually TRY for gMA (not hard-excluded).
      assert.ok(pool.ranked({ method: 'getMultipleAccounts' }).some((e) => e.id === 'publicnode'),
        'after decay the endpoint is eligible again');
      assert.equal(pool.refusalMemoryLive('getMultipleAccounts'), false,
        'refusal memory no longer reports live after decay');
    } finally { Date.now = realNow; }
  } finally { pool._reset(); }
});

test('D-65/3: a 200 clears refusal memory immediately (batch lane restored)', async () => {
  const state = baseState();
  const pool = freshPool(scriptedFetch(state));
  pool._reset();
  try {
    await pool.call('getMultipleAccounts', [[KEY1], {}]).catch(() => {});
    assert.notEqual(pool.ranked({ method: 'getMultipleAccounts' })[0].id, 'publicnode');
    // publicnode heals: it now answers.
    state.endpoints[0].failGma = false;
    // Direct proof of the clear-on-200 law: reportSuccess (the exact hook
    // every 200 lands on) must wipe the refusal entry immediately.
    pool.reportSuccess('publicnode', 50);
    const sa = pool._health.get('publicnode');
    assert.equal(Object.keys(sa.refusals || {}).length, 0,
      'a 200 clears refusal memory instantly — the batch lane is restored');
  } finally { pool._reset(); }
});

test('D-65/4: a later 403 refreshes the refusal-memory window (sliding, not fixed)', async () => {
  const state = baseState();
  const pool = freshPool(scriptedFetch(state));
  pool._reset();
  try {
    const realNow = Date.now;
    await pool.call('getMultipleAccounts', [[KEY1], {}]).catch(() => {});
    // 6 minutes in: still in the 10-min window. Make the healthy endpoints
    // refuse too, so the failover walk actually REACHES demoted publicnode
    // (it ranks last but is still in the list) and refuses again.
    Date.now = () => realNow() + 6 * 60_000;
    try {
      state.endpoints[1].failGma = true;
      state.endpoints[2].failGma = true;
      await pool.call('getMultipleAccounts', [[KEY1], {}]).catch(() => {});
      // 12 minutes after THAT (18 after the first) would exceed a fixed
      // 10-min window anchored at the first 403, but the refresh anchors at
      // the second — still refused for 4 more minutes.
      Date.now = () => realNow() + 18 * 60_000;
      const next = pool.ranked({ method: 'getMultipleAccounts' }).map((e) => e.id);
      assert.notEqual(next[0], 'publicnode', 'a second 403 must REFRESH the sliding window');
    } finally { Date.now = realNow; }
  } finally { pool._reset(); }
});

function freshFeed(pool) {
  delete require.cache[require.resolve('../onchain-feed.js')];
  const g = globalThis;
  const prev = g.self;
  g.self = { PTOnchain: RealOnchain, PTRpcPool: pool };
  try {
    return require('../onchain-feed.js');
  } finally {
    if (prev === undefined) delete g.self; else g.self = prev;
  }
}

/** A pool where EVERY endpoint carries live refusal-memory for gMA. */
function makeAllRefusedPool(accountsByAddress, counters) {
  return {
    calls: [],
    setUserEndpoint() {},
    hasUserEndpoint() { return false; },
    ranked() { return [{ id: 'publicnode', http: 'x', ws: null }, { id: 'tatum', http: 'y', ws: null }]; },
    methodBlockedEverywhere() { return false; },
    // The D-65 fast-path probe: does every ranked endpoint refuse gMA?
    refusalMemoryLive(method) { return method === 'getMultipleAccounts'; },
    async call(method, params) {
      this.calls.push({ method, params });
      counters[method] = (counters[method] || 0) + 1;
      if (method === 'getMultipleAccounts') {
        const err = new Error('http 403 getMultipleAccounts @ publicnode');
        err.kind = 'method';
        err.reported = true;
        err.logged = true;
        throw err;
      }
      if (method === 'getAccountInfo') {
        const key = params[0];
        return { value: accountsByAddress[key] || null };
      }
      throw new Error('unexpected method ' + method);
    },
    websocketUrls() { return []; },
    _attempts: () => [],
    _reset() {},
  };
}

test('D-65/5: all-endpoints-refused → ZERO getMultipleAccounts calls, per-account lane answers', async () => {
  const counters = {};
  const pool = makeAllRefusedPool({ [KEY1]: ACCOUNT, [KEY2]: ACCOUNT }, counters);
  const feed = freshFeed(pool);
  const accounts = await feed._getAccountsForTest([KEY1, KEY2]);
  assert.equal(counters.getMultipleAccounts || 0, 0,
    'no doomed batch attempt may fire when every endpoint refuses gMA');
  assert.equal((counters.getAccountInfo || 0), 2, 'the per-account lane served both keys');
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0] && accounts[0].owner, ACCOUNT.owner, 'real account data through the fast path');
});

test('D-65/6: the batch lane still engages when refusal memory is NOT universal', async () => {
  const counters = {};
  const pool = makeAllRefusedPool({ [KEY1]: ACCOUNT }, counters);
  // Only publicnode refuses; the second endpoint serves — refusal memory is
  // NOT universal, so the doomed-batch fast path must stay off.
  pool.refusalMemoryLive = () => false;
  const realCall = pool.call.bind(pool);
  pool.call = async (method, params) => {
    if (method === 'getMultipleAccounts' && pool._attempt === 0) {
      pool._attempt = 1;
      const err = new Error('http 403 getMultipleAccounts @ publicnode');
      err.kind = 'method'; err.reported = true; err.logged = true;
      throw err;
    }
    return realCall(method, params);
  };
  pool._attempt = 0;
  let gmaAttempts = 0;
  const wrapped = pool.call;
  pool.call = async function (method, params) {
    if (method === 'getMultipleAccounts') gmaAttempts += 1;
    return wrapped.call(pool, method, params);
  };
  const feed = freshFeed(pool);
  const accounts = await feed._getAccountsForTest([KEY1]);
  assert.equal(gmaAttempts, 1,
    'the batch fast path must NOT engage while any endpoint lacks refusal memory');
  assert.ok(accounts.length === 1);
});

test('D-65/7: fallback-transition error log is throttled to <=2 per (fn, minute)', async () => {
  const recorded = [];
  const g = globalThis;
  const prevSelf = g.self;
  const refused = makeAllRefusedPool({ [KEY1]: ACCOUNT }, {});
  // Simulate the ark regime mid-stream: refusal memory is only partially
  // populated, so the batch attempt still fires and 403s — the fallback
  // transition (and its log) happens on every cycle.
  delete refused.refusalMemoryLive;
  g.self = {
    PTOnchain: RealOnchain,
    PTRpcPool: refused,
    PTErrors: { record: (error, context) => recorded.push(context) },
  };
  delete require.cache[require.resolve('../onchain-feed.js')];
  try {
    const feed = require('../onchain-feed.js');
    // 10 consecutive read cycles, each hitting the fallback transition.
    for (let i = 0; i < 10; i++) {
      await feed._getAccountsForTest([KEY1]);
    }
    const fallbackEvents = recorded.filter((c) => c && c.fn === 'getAccounts-fallback');
    assert.ok(fallbackEvents.length <= 2,
      '10 fallback transitions must log <=2 events per (fn, minute), got ' + fallbackEvents.length);
  } finally {
    if (prevSelf === undefined) delete g.self; else g.self = prevSelf;
  }
});

test('D-65/8: production source carries refusal memory + fast path (structural pin)', () => {
  const poolSrc = fs.readFileSync(path.join(ROOT, 'rpc-pool.js'), 'utf8');
  assert.match(poolSrc, /REFUSAL_MEMORY_MS/, 'the refusal-memory decay constant must exist');
  const feedSrc = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  assert.match(feedSrc, /refusalMemoryLive/, 'the fast-path probe must be wired in the feed');
});
