/* Re-pricing is the step that actually stops fabrication, so these tests are
 * phrased as cheats: each one names a forgery the policy must reject, and the
 * honest cases it must never punish.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { judgeFill, priceChain, recordVerdict, minuteOf, DEFAULT_TOLERANCE } =
  require('../core/pricing.js');

// A minute where the token traded 0.9–1.1 USD and SOL sat at 100 USD.
const CANDLES = { tokenUsd: { low: 0.9, high: 1.1 }, solUsd: { low: 99, high: 101 } };

test('an honest fill inside the traded range passes', () => {
  // 0.01 SOL/token × ~100 USD/SOL ≈ 1.00 USD — mid-candle.
  assert.equal(judgeFill({ priceNative: 0.01 }, CANDLES), 'ok');
});

test('a price that never existed that minute is implausible', () => {
  // 0.05 SOL ≈ 5 USD against a 0.9–1.1 candle: fabricated.
  assert.equal(judgeFill({ priceNative: 0.05 }, CANDLES), 'implausible');
  // And too-good-to-be-true cheap entries fail the same way.
  assert.equal(judgeFill({ priceNative: 0.001 }, CANDLES), 'implausible');
});

test('tolerance absorbs pool-vs-aggregate skew but not real gaps', () => {
  // Just above the high edge: within 2.5% slack → ok.
  const nearHigh = (1.1 * (1 + DEFAULT_TOLERANCE * 0.9)) / 99;
  assert.equal(judgeFill({ priceNative: nearHigh }, CANDLES), 'ok');
  // 20% above the high is a gap no slack should forgive.
  assert.equal(judgeFill({ priceNative: (1.1 * 1.2) / 99 }, CANDLES), 'implausible');
});

test('missing market data is no-data — never a pass, never a fail', () => {
  assert.equal(judgeFill({ priceNative: 0.01 }, null), 'no-data');
  assert.equal(judgeFill({ priceNative: 0.01 }, { tokenUsd: null, solUsd: CANDLES.solUsd }), 'no-data');
  assert.equal(judgeFill({ priceNative: 0.01 }, { tokenUsd: CANDLES.tokenUsd, solUsd: null }), 'no-data');
});

test('a zero or negative price is implausible on its face', () => {
  assert.equal(judgeFill({ priceNative: 0 }, CANDLES), 'implausible');
  assert.equal(judgeFill({ priceNative: -1 }, CANDLES), 'implausible');
});

/* ---------------- priceChain ---------------- */

function link(mint, ts, price) {
  return { id: mint + ts, mint, ts, priceNative: price };
}

test('one lookup serves every fill in the same mint-minute', async () => {
  const calls = [];
  const getCandles = async (mint, minute) => { calls.push(mint + '@' + minute); return CANDLES; };
  const links = [
    link('M1', 60000, 0.01), link('M1', 60500, 0.0101), link('M1', 61000, 0.0099),
    link('M2', 60000, 0.01),
  ];
  const run = await priceChain(links, getCandles, {});
  assert.equal(run.done, true);
  assert.equal(calls.length, 2); // M1's minute once, M2's minute once
  assert.equal(run.verdicts.length, 4);
  assert.ok(run.verdicts.every((v) => v.verdict === 'ok'));
});

test('a fill is judged against the chain it COMMITTED to, and only that (L-09)', async () => {
  // The lookup used to hardcode Solana's candle network, so the committed
  // chain label — hashed into every v2 link precisely so a verifier would
  // consult it — was ignored. The chain now rides into every lookup, keys
  // the memo (same mint-minute on two chains is two different markets), and
  // an unpriceable chain comes back null → 'no-data', never a pass.
  const calls = [];
  const getCandles = async (mint, minute, chain) => {
    calls.push(chain + ':' + mint + '@' + minute);
    return chain === 'solana' ? CANDLES : null; // the adapter fails closed
  };
  const links = [
    Object.assign(link('M1', 60000, 0.01), { chain: 'solana' }),
    Object.assign(link('M1', 60000, 0.01), { chain: 'ethereum' }),
    link('M2', 60000, 0.01), // absent chain = v1 link = Solana by definition
  ];
  const run = await priceChain(links, getCandles, {});
  assert.equal(run.done, true);
  assert.deepEqual(calls, [
    'solana:M1@60000', 'ethereum:M1@60000', 'solana:M2@60000',
  ], 'same mint-minute on different chains must be looked up separately');
  assert.equal(run.verdicts[0].verdict, 'ok');
  assert.equal(run.verdicts[1].verdict, 'no-data',
    'a chain the verifier cannot price never verifies');
  assert.equal(run.verdicts[2].verdict, 'ok');
});

test('a lookup budget pauses the run at a resumable cursor', async () => {
  const getCandles = async () => CANDLES;
  const links = [link('M1', 60000, 0.01), link('M2', 120000, 0.01), link('M3', 180000, 0.01)];
  const first = await priceChain(links, getCandles, { maxLookups: 2 });
  assert.equal(first.done, false);
  assert.equal(first.cursor, 2);
  assert.equal(first.verdicts.length, 2);
  const rest = await priceChain(links, getCandles, { startAt: first.cursor });
  assert.equal(rest.done, true);
  assert.equal(rest.verdicts.length, 1);
  assert.equal(rest.verdicts[0].index, 2);
});

test('a throwing candle source PAUSES — failing to ask is never evidence of absence', async () => {
  // The distinction this locks: a null RESULT means "asked, nothing there"
  // (no-data); a THROW means "could not ask" (budget gone, rate limited,
  // network fault). Recording the second as no-data would quietly skip the
  // re-pricing gate on the rest of the chain while reporting coverage as if
  // the fills had been checked.
  const links = [link('M1', 60000, 0.01), link('M2', 120000, 0.01)];
  const run = await priceChain(links, async () => { throw new Error('upstream down'); }, {});
  assert.equal(run.done, false, 'the run must not claim to be finished');
  assert.equal(run.cursor, 0, 'and must resume from the fill it could not price');
  assert.deepEqual(run.verdicts, []);

  // Recovery on the next run produces real verdicts, with nothing lost.
  const ok = await priceChain(links, async () => CANDLES, { startAt: run.cursor });
  assert.equal(ok.done, true);
  assert.equal(ok.verdicts.length, 2);
  assert.ok(ok.verdicts.every((v) => v.verdict === 'ok'));
});

test('a null candle result is still honest no-data', async () => {
  const run = await priceChain([link('M1', 60000, 0.01)], async () => null, {});
  assert.equal(run.done, true);
  assert.equal(run.verdicts[0].verdict, 'no-data');
});

/* ---------------- recordVerdict ---------------- */

const V = (verdict, index) => ({ index: index || 0, id: 'x', verdict });

test('any implausible fill rejects the whole record', () => {
  const verdict = recordVerdict([V('ok'), V('ok'), V('implausible', 2)]);
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.implausible.length, 1);
});

test('full coverage with clean prices is verified', () => {
  const verdict = recordVerdict([V('ok'), V('ok'), V('ok')]);
  assert.equal(verdict.status, 'verified');
  assert.equal(verdict.coverage, 1);
});

test('thin coverage is partial — shown, labeled, never faked to verified', () => {
  const verdict = recordVerdict([V('ok'), V('no-data'), V('no-data')]);
  assert.equal(verdict.status, 'partial');
  assert.ok(verdict.coverage < 0.8);
});

test('coverage at the threshold verifies; the boundary is inclusive', () => {
  const verdicts = [V('ok'), V('ok'), V('ok'), V('ok'), V('no-data')];
  assert.equal(recordVerdict(verdicts).status, 'verified'); // 0.8 exactly
});
