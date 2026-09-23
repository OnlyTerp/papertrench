const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
global.self = global.window;
const Errors = require('../errors.js');
const Pool = require('../rpc-pool.js');
const Feed = require('../onchain-feed.js');

const MINT = '22222222222222222222222222222222222222222222';
const originalFetch = global.fetch;
const originalDateNow = Date.now;

test('keyless refusals update one status entry with bounded per-host evidence', async () => {
  const requests = [];
  let now = 1_800_000_000_000;
  Date.now = () => now;
  global.fetch = async (url, init) => {
    const method = JSON.parse(init.body).method;
    requests.push({ url: String(url), method });
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  try {
    Pool._reset();
    Errors.clear();
    Feed.configure({ rpcUrl: '' });
    for (let i = 0; i < 250; i += 1) {
      await assert.rejects(() => Pool.call('getMultipleAccounts', [[MINT], {}]), /http 429/);
      now += 3000;
    }

    assert.equal(requests.length, 500, '250 failed batch probes contact the two eligible providers each');
    assert.ok(requests.every((request) => request.method === 'getMultipleAccounts'));
    assert.ok(requests.every((request) => !request.url.includes('tatum')),
      'Tatum never receives keyless getMultipleAccounts');
    const snapshot = Errors.snapshot();
    assert.equal(snapshot.length, 1, 'expected refusals create no per-attempt error entries');
    assert.equal(snapshot[0].context.kind, 'rpc-pool-status');
    assert.equal(snapshot[0].context.severity, 'status');
    assert.equal(snapshot[0].count, 500, 'the same status record is refreshed in place');
    assert.deepEqual(snapshot[0].context.pool.endpoints.map((entry) => entry.id), ['publicnode', 'solana-labs']);
    for (const endpoint of snapshot[0].context.pool.endpoints) {
      assert.equal(endpoint.method, 'getMultipleAccounts');
      assert.equal(endpoint.refusalCount, 250);
      assert.equal(endpoint.benchedUntil, 0);
      assert.equal(endpoint.lastSuccessAgeMs, null);
    }
  } finally {
    Date.now = originalDateNow;
    global.fetch = originalFetch;
    Pool._reset();
    Feed.configure({ rpcUrl: '' });
    Errors.clear();
  }
});

test('personal RPC refusals remain ordinary errors, not keyless status', async () => {
  global.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => null }, json: async () => ({}),
  });
  try {
    Pool._reset();
    Errors.clear();
    Feed.configure({ rpcUrl: 'https://personal-rpc.example' });
    const result = await Feed.prewatch({ mint: MINT });
    assert.equal(result, null, 'a refused account read remains an honest miss');
    const snapshot = Errors.snapshot();
    assert.ok(snapshot.some((entry) => /http 429/.test(entry.message)),
      'personal endpoint failures still reach the error ring');
    assert.equal(snapshot.some((entry) => entry.context && entry.context.kind === 'rpc-pool-status'), false,
      'personal endpoint failures are never downgraded to expected keyless status');
  } finally {
    global.fetch = originalFetch;
    Pool._reset();
    Feed.configure({ rpcUrl: '' });
    Errors.clear();
  }
});
