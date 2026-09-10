/* D-72 / E3 — foreign witnesses use USD, while the book still uses SOL.
 *
 * Reuse D-71's real background listener, R facade, action-time ladder, and
 * host-facts VM harness. Foreign records come from the real normalizePair:
 * priceNative = priceUsd / solUsd (quote.js:164-218), NOT the panel's dollars.
 * requestBuy converts USD amounts to SOL before doBuy passes both quote
 * prices to the engine (content.js requestBuy / doBuy). No RPC is mocked into
 * being a foreign witness: an R.onchainQuote spy must see no calls at all.
 *
 * Production negative controls (D-72 source lines):
 * - background.js:3419 — `.every((mint) => isAddressForChain(mint, chain))`
 *   -> `.every(isSolanaAddress)` => EVM quotes/fills and host supply fail.
 * - background.js:3425 — `const key = chain + ':' + mintList;` ->
 *   `const key = mintList;` => BNB/Robinhood cross-serve the same EVM mint.
 * - background.js:3435 — remove `+ '&chain=' + chain` from the fetch URL
 *   => chain-dependent quotes cross-route and the Solana default pin fails.
 * - background.js:3446 — remove `chain === 'solana' &&` from priceNative
 *   => a foreign response incorrectly exposes a native SOL price.
 * - content.js:36 — omit `chain` from the R.workerQuote message
 *   => agreeing EVM fills and foreign host supply lose their witness.
 * - content.js:644 — R.workerQuote(mint, token.chain) -> R.workerQuote(mint)
 *   => foreign host supply stays uncorroborated.
 * - content.js:2321 — R.workerQuote(mint, chain) -> R.workerQuote(mint)
 *   => agreeing foreign fills lose their witness.
 * - content.js:2324 — witnessUsd = worker.priceUsd ->
 *   witnessUsd = worker.priceNative => agreeing USD witnesses lose the fill.
 * - content.js:2317 — restore `const obs = await R.onchainQuote(mint)
 *   .catch(() => null);` => foreign corroboration makes an RPC-lane attempt.
 * - content.js:2409 — restore `const observation = await
 *   R.onchainQuote(startMint);` => foreign quote selection attempts RPC.
 * - content.js:2336-2337 — replace Q.witnessAgrees acceptance with
 *   `if (true) return chosen;` => dissent/absence incorrectly permit fills.
 * - background.js:1980 — remove 'pt_worker_quote' from VIEWER_QUIET_MESSAGES
 *   => hidden foreign and Solana viewers receive quotes and spend HTTP.
 * Executed every control separately with:
 *   node --test extension/test/multichainwitness.test.js extension/test/workerquote.test.js
 * Each run exited 1 with its expected failure, then source was restored from
 * a backup copy, SHA-256 matched byte-identically, and the same run exited 0
 * with all 32 tests passing (the 19 D-71 regressions are unchanged).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// D-71's setup is shared without registering or rewriting its regression tests.
const d71 = fs.readFileSync(path.join(__dirname, 'workerquote.test.js'), 'utf8');
const setupEnd = d71.indexOf("\ntest('D-71 E1:");
assert.ok(setupEnd > 0, 'the D-71 harness must precede its tests');
const { boot, response, quote, pendingToken, facts, settle, Q, NOW, MINT } =
  new Function('require', '__dirname', d71.slice(0, setupEnd)
    + '\nreturn { boot, response, quote, pendingToken, facts, settle, Q, NOW, MINT };')(require, __dirname);

const EVM_MINT = '0x99A90B1218419c62A2Fa7E427284C6c7D058d47a';
const USD_PRICE = 1.75;
const SOL_USD = 128;
const RECENT_NATIVE = 1.25 / SOL_USD;

function foreignToken(chain) {
  return Q.normalizePair({
    chainId: Q.chainIdFor(chain),
    baseToken: { address: EVM_MINT, symbol: 'TEST' },
    quoteToken: { address: '0x1111111111111111111111111111111111111111' },
    priceNative: '0.0007', // the EVM gas-token quote must never price the SOL book
    priceUsd: String(USD_PRICE), marketCap: 175_000,
  }, EVM_MINT, { chain, solUsd: SOL_USD });
}

function foreignEnv(chain, options = {}) {
  const token = options.token || foreignToken(chain);
  assert.ok(token, 'real foreign normalization supplies a SOL-book quote');
  const env = boot({ token, quotes: { [EVM_MINT]: quote(null, { priceUsd: USD_PRICE }) }, ...options });
  env.ladder.setEvidence({ priceNative: RECENT_NATIVE, at: NOW - 2_000 });
  let rpcCalls = 0;
  env.R.onchainQuote = async () => {
    rpcCalls += 1;
    return null;
  };
  env.rpcCalls = () => rpcCalls;
  return env;
}

function foreignRefusal(witnessUsd) {
  return 'Price sources disagree (' + USD_PRICE / SOL_USD + ' vs recent ' + RECENT_NATIVE
    + (witnessUsd ? ', witness ' + witnessUsd / SOL_USD : ', no second source')
    + ') — paper fill refused. Try again in a moment.';
}

for (const chain of ['bnb', 'robinhood']) {
  test('D-72 E3: ' + chain + ' agreeing USD witness permits the SOL-book fill without RPC', async () => {
    const env = foreignEnv(chain);
    const fill = await env.ladder.quoteForTrade();
    assert.equal(fill?.priceNative, USD_PRICE / SOL_USD, 'witness must not reprice the SOL book');
    assert.equal(fill?.priceUsd, USD_PRICE);
    assert.equal(env.ladder.getRefusal(), null);
    assert.equal(env.rpcCalls(), 0, 'foreign fills never enter the Solana quote lane');
    assert.equal(new URL(env.worker.fetchCalls[0]).searchParams.get('chain'), chain);
  });

  test('D-72 E3: ' + chain + ' dissenting USD witness preserves the existing refusal shape', async () => {
    const env = foreignEnv(chain, { quotes: { [EVM_MINT]: quote(null, { priceUsd: 0.5 }) } });
    assert.equal(await env.ladder.quoteForTrade(), null);
    assert.equal(env.ladder.getRefusal(), foreignRefusal(0.5));
    assert.equal(env.rpcCalls(), 0);
    assert.equal(env.refreshCalls(), 0, 'an aggregator cannot corroborate itself');
  });

  test('D-72 E3: ' + chain + ' worker failure remains no second source, never an invented witness', async () => {
    const env = foreignEnv(chain, { fetch: async () => { throw new Error('worker offline'); } });
    assert.equal(await env.ladder.quoteForTrade(), null);
    assert.equal(env.ladder.getRefusal(), foreignRefusal());
    assert.equal(env.rpcCalls(), 0);
  });
}

test('D-72 E3: a missing USD candidate cannot use a native-looking worker value', async () => {
  const token = foreignToken('bnb');
  token.priceUsd = null;
  const env = foreignEnv('bnb', {
    token, quotes: { [EVM_MINT]: quote(token.priceNative, { priceUsd: token.priceNative }) },
  });
  assert.equal(await env.ladder.quoteForTrade(), null);
  assert.equal(env.ladder.getRefusal(), foreignRefusal());
  assert.equal(env.rpcCalls(), 0);
});

test('D-72 E3: foreign worker quotes preserve exact EVM keys and never expose priceNative', async () => {
  const env = foreignEnv('bnb', { quotes: {
    [EVM_MINT]: quote(123, { priceUsd: USD_PRICE, mcapUsd: 175_000, fdvUsd: 200_000 }),
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(await env.R.workerQuote(EVM_MINT, 'bnb'))), {
    priceNative: null, priceUsd: USD_PRICE, mcapUsd: 175_000, fdvUsd: 200_000, at: NOW - 20,
  });
  const request = new URL(env.worker.fetchCalls[0]);
  assert.equal(request.searchParams.get('mints'), EVM_MINT);
  assert.equal(request.searchParams.get('chain'), 'bnb');
});

test('D-72 E3: address validation stays chain-strict and matches canonical EVM shapes', async () => {
  const env = foreignEnv('bnb');
  const invalid = [
    MINT, EVM_MINT.slice(0, -1), EVM_MINT + '0', EVM_MINT.replace('0x', '0X'),
    EVM_MINT.replace('99', 'gg'), ' ' + EVM_MINT, null,
  ];
  for (const mint of invalid) {
    assert.equal(await env.send({ type: 'pt_worker_quote', chain: 'bnb', mints: [mint] }), null);
  }
  assert.equal(await env.send({ type: 'pt_worker_quote', chain: 'unknown', mints: [EVM_MINT] }), null);
  assert.equal(await env.send({ type: 'pt_worker_quote', chain: 'bnb', mints: [EVM_MINT, MINT] }), null);
  assert.equal(env.worker.fetchCalls.length, 0, 'malformed or wrong-chain mints never reach HTTP');
  const canonical = Q.canonicalAddress(EVM_MINT);
  const accepted = boot({ quotes: { [canonical]: quote(null, { priceUsd: USD_PRICE }) } });
  assert.equal((await accepted.R.workerQuote(canonical, 'robinhood'))?.priceUsd, USD_PRICE);
});

test('D-72 E3: the same mint never cross-serves chains, while each cache keeps its TTL', async () => {
  const env = foreignEnv('bnb', { fetch: async url => {
    const chain = new URL(url).searchParams.get('chain');
    return response({ [EVM_MINT]: quote(null, { priceUsd: chain === 'bnb' ? 2 : 7 }) });
  } });
  const bnb = { type: 'pt_worker_quote', chain: 'bnb', mints: [EVM_MINT] };
  const rh = { ...bnb, chain: 'robinhood' };
  assert.equal((await env.send(bnb))[EVM_MINT].priceUsd, 2);
  assert.equal((await env.send(rh))[EVM_MINT].priceUsd, 7);
  assert.equal(await env.send({ ...bnb, chain: 'solana' }), null, 'cached EVM mint is still invalid on Solana');
  assert.equal(await env.send({ type: 'pt_worker_quote', mints: [EVM_MINT] }), null, 'omitted chain still means Solana');
  env.setNow(NOW + 9_999);
  assert.equal((await env.send(bnb))[EVM_MINT].priceUsd, 2);
  assert.equal((await env.send(rh))[EVM_MINT].priceUsd, 7);
  assert.equal(env.worker.fetchCalls.length, 2);
  env.setNow(NOW + 10_001);
  await env.send(bnb);
  assert.equal(env.worker.fetchCalls.length, 3);
});

test('D-72 E3: foreign host supply uses chain-aware USD corroboration without repricing the token', async () => {
  const token = { ...pendingToken(EVM_MINT), chain: 'robinhood' };
  const env = foreignEnv('robinhood', { token, quotes: {
    [EVM_MINT]: quote(null, { priceUsd: 2, mcapUsd: 200 }),
  } });
  env.host.handleHostFacts(facts({ mint: EVM_MINT, addresses: [EVM_MINT], decimals: 18, supply: 100e18 }));
  await settle();
  assert.equal(env.token.hostSupplyUi, 100);
  assert.equal(env.token.hostSupplyWitness.source, 'worker-quote');
  assert.equal(env.token.priceNative, null);
  assert.equal(env.token.pending, true);
  assert.equal(new URL(env.worker.fetchCalls[0]).searchParams.get('chain'), 'robinhood');
});

test('D-72 E3: hidden foreign warm viewers still spend no worker quote traffic', async () => {
  const env = foreignEnv('bnb');
  require('node:vm').runInContext('warmViewerTabs.add(1)', env.worker.ctx);
  assert.equal(await env.R.workerQuote(EVM_MINT, 'bnb'), null);
  assert.equal(env.worker.fetchCalls.length, 0);
});

test('D-72 E3: explicit and omitted Solana chains keep native units and chain-first witness order', async () => {
  for (const chain of [undefined, 'solana']) {
    const env = boot({ quotes: { [MINT]: quote() } });
    env.token.chain = chain;
    const calls = [];
    env.R.onchainQuote = async () => { calls.push('onchain'); return null; };
    const workerQuote = env.R.workerQuote;
    env.R.workerQuote = (mint, witnessChain) => {
      calls.push('worker');
      return workerQuote(mint, witnessChain);
    };
    assert.equal((await env.ladder.quoteForTrade())?.priceNative, env.token.priceNative);
    assert.deepEqual(calls, ['onchain', 'onchain', 'worker']);
    assert.equal(new URL(env.worker.fetchCalls[0]).searchParams.get('chain'), 'solana');
  }
});
