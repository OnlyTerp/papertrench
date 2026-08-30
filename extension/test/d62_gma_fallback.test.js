/* D-62: getMultipleAccounts policy-refusal fallback + batch chunking.
 *
 * Live evidence (Discord debug exports, 2026-08-26..30): heavy users hit
 * `http 403 getMultipleAccounts @ publicnode` for HOURS (ark_trades13's
 * 2026-08-29 export: 65 grouped hits across fn:prewatch AND fn:watch, a 3.5h
 * span; cheng.4848 and giovinastro the same day, all on v3.17.1). The method
 * is priced per-key/weight by the free endpoints — a light-IP probe passes
 * while an all-day trader's IP is refused — and EVERY HTTP read in the feed
 * rode it: prewatch could not classify the page's address, describePool
 * could not watch, and the panel sat on "Fetching live price…" until an
 * aggregator indexed the coin (the reported 20-30s..minutes buy delay).
 *
 * Two hardenings, both honest:
 *   1. getAccountInfo fallback — a different (cheaper) method with a
 *      different weight class. ark's log carries ZERO getAccountInfo errors
 *      because the extension never called it; the endpoints serve it fine.
 *      Slot honesty: single-account reads return the account's own data with
 *      no context.slot, so getAccountsWithSlot reports slot 0 unless the
 *      primary path succeeded — callers already treat 0 as "no slot proof"
 *      (O.isNewerObservation guards everything).
 *   2. Batch chunking — never send one getMultipleAccounts carrying more
 *      than 20 keys, on the happy path too: a 100-key discoverPoolMint scan
 *      (F-45's chunked candidates) is exactly the oversized payload a
 *      weight-based WAF refuses first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const RealOnchain = require('../onchain.js');
const RealPool = require('../rpc-pool.js');

const WSOL = 'So11111111111111111111111111111111111111112';

/** Drive the feed's real HTTP read path with a scripted pool: every
 * getMultipleAccounts call is recorded and refuses with the exact production
 * error shape (kind:'method'); getAccountInfo answers honestly. This is the
 * behavioral lane — the negative control (VAL-A-03) stashes the production
 * fix and watches these same tests go red. */
function makeRefusingPool(accountsByAddress, opts) {
  opts = opts || {};
  const calls = [];
  const callsByMethod = {};
  return {
    calls,
    setUserEndpoint() {},
    hasUserEndpoint() { return false; },
    ranked() { return [{ id: 'publicnode', http: 'x', ws: null }]; },
    methodBlockedEverywhere() { return false; },
    async call(method, params) {
      calls.push({ method, params });
      callsByMethod[method] = (callsByMethod[method] || 0) + 1;
      if (method === 'getMultipleAccounts') {
        if (opts.gmaError === false) {
          // explicit pass-through mode for the chunking test
          const keys = params[0];
          return { context: { slot: 1234 }, value: keys.map((k) => accountsByAddress[k] || null) };
        }
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
      if (method === 'getSlot') {
        return opts.slot || 0;
      }
      throw new Error('unexpected method ' + method);
    },
    websocketUrls() { return []; },
    _attempts: () => [],
    _reset() {},
  };
}

const REAL_ACCOUNT = {
  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  data: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'base64'],
};

function freshFeed(pool) {
  // The feed resolves POOL at module load from self.PTRpcPool (browser) or
  // require (node). Inject the scripted pool through a temporary global
  // `self` so the production binding path itself is exercised, with a fresh
  // module instance so state never leaks between tests.
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

test('D-62/1: getAccounts survives a pool-wide getMultipleAccounts refusal via getAccountInfo', async () => {
  const pool = makeRefusingPool({ [WSOL]: REAL_ACCOUNT });
  const feed = freshFeed(pool);
  const accounts = await feed._getAccountsForTest([WSOL]);
  assert.ok(Array.isArray(accounts) && accounts.length === 1, 'one address in, one account slot out');
  assert.equal(accounts[0] && accounts[0].owner, REAL_ACCOUNT.owner, 'the fallback must return the REAL account data, not an empty lane');
  assert.ok(pool.calls.some((c) => c.method === 'getAccountInfo'), 'the fallback must actually issue getAccountInfo calls');
});

test('D-62/2: getAccountsWithSlot falls back honestly — account data yes, unproven slot zero', async () => {
  const pool = makeRefusingPool({ [WSOL]: REAL_ACCOUNT });
  const feed = freshFeed(pool);
  const { slot, accounts } = await feed._getAccountsWithSlotForTest([WSOL]);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0] && accounts[0].owner, REAL_ACCOUNT.owner, 'account still readable through the refusal');
  // A single-account getAccountInfo response has NO context.slot; claiming
  // one would defeat the slot-ordering guards. Zero is the honest answer and
  // exactly what the existing isNewerObservation callers already handle.
  assert.equal(slot, 0, 'slot must be 0 unless the primary batch path proved it');
});

test('D-62/3: the fallback only engages after the batch method actually failed', async () => {
  const pool = makeRefusingPool({ [WSOL]: REAL_ACCOUNT });
  const feed = freshFeed(pool);
  await feed._getAccountsForTest([WSOL]);
  const gma = pool.calls.filter((c) => c.method === 'getMultipleAccounts');
  const gai = pool.calls.filter((c) => c.method === 'getAccountInfo');
  assert.ok(gma.length >= 1, 'the batch attempt is made first (fast path preserved)');
  assert.ok(gai.length >= 1, 'only then does the per-account lane engage');
});

test('D-62/4: a >20-key batch is chunked even on the happy path (WAF size avoidance)', async () => {
  const keys = [];
  for (let i = 0; i < 55; i++) keys.push('Key' + i + '1111111111111111111111111111111111111111');
  const accounts = {};
  keys.forEach((k) => { accounts[k] = REAL_ACCOUNT; });
  const pool = makeRefusingPool(accounts, { gmaError: false });
  const feed = freshFeed(pool);
  const out = await feed._getAccountsForTest(keys);
  assert.equal(out.length, 55, 'every key answered');
  const gmaCalls = pool.calls.filter((c) => c.method === 'getMultipleAccounts');
  assert.ok(gmaCalls.length >= 3, 'the batch must split (' + gmaCalls.length + ' calls for 55 keys)');
  for (const call of gmaCalls) {
    assert.ok(call.params[0].length <= 20,
      'no single getMultipleAccounts may carry more than 20 keys (got ' + call.params[0].length + ')');
  }
});

test('D-62/5: production source carries the fallback (structural pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  const block = src.slice(src.indexOf('async function getAccountsResilient('), src.indexOf('/* ---------------- pool resolution'));
  assert.ok(block.length > 0, 'the read helpers block must be locatable');
  assert.match(block, /getAccountInfo/, 'the per-account fallback method must appear in the read helpers');
  assert.match(block, /GMA_MAX_KEYS/, 'the chunk constant must exist');
});
