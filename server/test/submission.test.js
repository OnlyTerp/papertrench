/* The submission pipeline is the door to the board. Every test here is a
 * cheat at the door: replaced histories, shrunk chains, tampered links,
 * absurd payloads — each must be turned away with a named reason, and the
 * honest path must sail through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { fastChecks, priceRecord, shapeProblem, MAX_CHAIN_LINKS } =
  require('../core/submission.js');
const { appendFill, GENESIS } = require('../core/chain.js');

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

let seq = 0;
function buy(mint, sol, ts) {
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'buy',
           qty: sol * 1000, priceNative: 0.001, solGross: sol, solNet: sol * 0.99, ts };
}
function sell(mint, qty, price, ts) {
  const gross = qty * price;
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'sell',
           qty, priceNative: price, solGross: gross, solNet: gross * 0.99, ts };
}

const MIN = 60000;

async function honestPayload() {
  const chain = await chainOf([
    buy('M1', 1, 10 * MIN), sell('M1', 1000, 0.002, 20 * MIN),
  ]);
  return {
    version: 1,
    submittedAt: 21 * MIN,
    identity: { handle: 'someone', verified: true },
    claim: {
      equitySol: 10.99, realizedPnlSol: 0.99, rounds: 1, wins: 1, losses: 0,
      startingBalanceSol: 10,
    },
    chain,
    head: chain[chain.length - 1].hash,
  };
}

test('an honest submission is accepted with replayed stats', async () => {
  const result = await fastChecks(await honestPayload(), null);
  assert.equal(result.accepted, true);
  assert.equal(result.claimMismatch, false);
  assert.equal(result.stats.rounds, 1);
  assert.ok(Math.abs(result.replayed.realizedPnlSol - 0.99) < 1e-9);
});

test('a tampered link is rejected as chain-invalid', async () => {
  const payload = await honestPayload();
  payload.chain[0].qty = 999999; // the classic hand-edit
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-invalid');
  assert.ok(result.problems.length > 0);
});

test('a replaced history is rejected: the new chain must extend the old head', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length, startingSol: 10 };
  // A fresh, luckier chain of the same length — the oldest cheat.
  seq = 100;
  const lucky = await chainOf([
    buy('M9', 1, 30 * MIN), sell('M9', 1000, 0.01, 40 * MIN),
  ]);
  const payload = Object.assign({}, first, {
    chain: lucky, head: lucky[lucky.length - 1].hash,
    claim: Object.assign({}, first.claim, { realizedPnlSol: 8.9 }),
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-replaced');
});

test('a shrunk chain is rejected even if internally valid', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length, startingSol: 10 };
  const payload = Object.assign({}, first, {
    chain: first.chain.slice(0, 1), head: first.chain[0].hash,
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-shrunk');
});

test('the declared bankroll is pinned — shrinking it cannot inflate ROI', async () => {
  // The cheapest possible cheat: resubmit the identical fills but declare a
  // tiny bankroll, and the same P&L becomes a vastly larger return.
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length, startingSol: 10 };

  const inflated = Object.assign({}, first, {
    claim: Object.assign({}, first.claim, { startingBalanceSol: 0.01 }),
  });
  const result = await fastChecks(inflated, previous);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'bankroll-changed');

  // The same chain with the same declared bankroll still goes through.
  assert.equal((await fastChecks(first, previous)).accepted, true);
});

test('a bankroll smaller than the chain proves is rejected on the FIRST submission', async () => {
  // Reported by a real user: "I download the export, change the code in it,
  // then upload it." Pinning only stops the bankroll CHANGING — the first
  // submission set it freely, and shrinking the denominator multiplies every
  // ranked figure without forging a single hash.
  //
  // The chain itself is the floor: this one spends 1 SOL on its first buy, so
  // a declared balance of 0.01 is not a preference, it is impossible.
  const payload = await honestPayload();
  payload.claim.startingBalanceSol = 0.01;
  const result = await fastChecks(payload, null);   // null = first submission
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'bankroll-too-small');

  // A balance the fills actually fit inside still goes through.
  const honest = await honestPayload();
  honest.claim.startingBalanceSol = 1;
  assert.equal((await fastChecks(honest, null)).accepted, true);
});

test('the floor reads committed fields, so editing unhashed ones cannot dodge it', async () => {
  // solNet on a buy is not in the preimage. Zeroing it would make the spend
  // look free to any replay that trusted it.
  const payload = await honestPayload();
  payload.claim.startingBalanceSol = 0.01;
  payload.chain[0].solNet = 0;
  payload.chain[0].amount = 0;
  payload.chain[0].txCostSol = 0;
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, false, 'the committed solGross still proves the spend');
  assert.equal(result.reason, 'bankroll-too-small');
});

test('an extended chain from the committed head is accepted', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length, startingSol: 10 };
  const extended = first.chain.slice();
  const next = await appendFill(first.head, buy('M2', 1, 30 * MIN));
  next.seq = extended.length;
  extended.push(next);
  const payload = Object.assign({}, first, {
    chain: extended, head: next.hash,
    claim: Object.assign({}, first.claim),
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, true);
});

test('a claim that disagrees with the replay is flagged, and replay wins', async () => {
  const payload = await honestPayload();
  payload.claim.realizedPnlSol = 42; // stated ≠ committed
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, true);
  assert.equal(result.claimMismatch, true);
  // Ranked stats come from the chain, not the brag — on the committed cash
  // basis (gross out on buys), which is 0.98 rather than the client's 0.99.
  assert.ok(Math.abs(result.stats.realizedPnlSol - 0.98) < 1e-9);
});

test('shape gates turn absurd payloads away before any crypto runs', async () => {
  assert.equal(shapeProblem(null), 'not-an-object');
  // 1 is the envelope's own version; 2 is the F-44 mislabel that shipped in
  // v3.4.0 exports (byte-identical envelope, wrong stamp — DEFECT L-01).
  // Both name a shape we have actually defined and checked. 3 names nothing.
  assert.equal(shapeProblem({ version: 3 }), 'unknown-version');
  assert.equal(shapeProblem({ version: 1, chain: [] }), 'chain-empty');
  assert.equal(shapeProblem({ version: 2, chain: [] }), 'chain-empty',
    'a v2-stamped envelope must clear the version gate (L-01)');
  const payload = await honestPayload();
  assert.equal(shapeProblem(Object.assign({}, payload, {
    claim: Object.assign({}, payload.claim, { startingBalanceSol: 0 }),
  })), 'starting-balance-invalid');
  assert.equal(shapeProblem(Object.assign({}, payload, { head: 'nope' })), 'head-mismatch');
  const huge = Object.assign({}, payload, { chain: { length: MAX_CHAIN_LINKS + 1 } });
  assert.equal(shapeProblem(huge), 'chain-missing'); // not an array → gate fires
});

test('a v3.4.0 export stamped version 2 is accepted end to end (L-01)', async () => {
  // The mislabel that emptied the board: the F-44 link bump leaked into the
  // envelope stamp, and this exact payload — honest, verifiable, and
  // byte-identical to a v1 envelope — was refused as shape:unknown-version
  // on every submission. It must sail through now and forever.
  const payload = await honestPayload();
  payload.version = 2;
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, true);
  assert.equal(result.claimMismatch, false);
});

/* ---------------- amount plausibility (DEFECT L-03) ----------------
 *
 * Re-pricing proves the PRICE existed; these prove the CASH matched it. The
 * preimage commits one money field per fill (gross on buys, net on sells),
 * and the replay books exactly that cash — so before this gate, a chain with
 * honest mints, timestamps and prices could still commit a sell that
 * "received" any number it liked and walk onto the board.
 */

test('a sell committing more cash than its own price supports is rejected', async () => {
  seq = 300;
  const richSell = { id: 'f-rich', sessionId: 's', mint: 'M1', side: 'sell',
    qty: 1000, priceNative: 0.002, solGross: 2,
    solNet: 50, // committed! the chain verifies; the arithmetic does not
    ts: 20 * MIN };
  const chain = await chainOf([buy('M1', 1, 10 * MIN), richSell]);
  const payload = {
    version: 1, submittedAt: 21 * MIN, identity: { handle: 'someone' },
    claim: { startingBalanceSol: 10, realizedPnlSol: 49 },
    chain, head: chain[chain.length - 1].hash,
  };
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'amount-implausible');
  assert.equal(result.problems[0].reason, 'sell-exceeds-priced-value');
});

test('a buy committing less cash than its own price demands is rejected', async () => {
  seq = 310;
  const freeBuy = { id: 'f-free', sessionId: 's', mint: 'M1', side: 'buy',
    qty: 1000, priceNative: 0.001, // worth 1 SOL
    solGross: 0.01,                // committed as costing nothing
    solNet: 0.01, ts: 10 * MIN };
  const chain = await chainOf([freeBuy, sell('M1', 1000, 0.002, 20 * MIN)]);
  const payload = {
    version: 1, submittedAt: 21 * MIN, identity: { handle: 'someone' },
    claim: { startingBalanceSol: 10, realizedPnlSol: 1.97 },
    chain, head: chain[chain.length - 1].hash,
  };
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'amount-implausible');
  assert.equal(result.problems[0].reason, 'buy-cheaper-than-priced');
});

test('honest fees pass the amount gate: they only push in the honest direction', async () => {
  seq = 320;
  const chain = await chainOf([
    // 1% fee on top of a 1 SOL buy: gross 1.01 >= value 1. Honest.
    { id: 'f-buy', sessionId: 's', mint: 'M1', side: 'buy',
      qty: 1000, priceNative: 0.001, solGross: 1.01, solNet: 1, ts: 10 * MIN },
    // Fees and tx costs off a 2 SOL exit: net 1.93 <= value 2. Honest.
    { id: 'f-sell', sessionId: 's', mint: 'M1', side: 'sell',
      qty: 1000, priceNative: 0.002, solGross: 2, solNet: 1.93, ts: 20 * MIN },
  ]);
  const payload = {
    version: 1, submittedAt: 21 * MIN, identity: { handle: 'someone' },
    claim: { startingBalanceSol: 10, realizedPnlSol: 0.92 },
    chain, head: chain[chain.length - 1].hash,
  };
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, true,
    'no fee setting a real user can choose may trip the gate');
});

/* ---------------- resumable pricing ---------------- */

test('pricing resumes across budgeted runs and lands one final verdict', async () => {
  seq = 200;
  const chain = await chainOf([
    buy('A', 1, 10 * MIN), buy('B', 1, 20 * MIN), buy('C', 1, 30 * MIN),
    buy('D', 1, 40 * MIN),
  ]);
  const payload = { chain };
  // 0.001 SOL × [45,55] USD/SOL = [0.045, 0.055] USD — inside this candle.
  const okCandles = async () => ({ tokenUsd: { low: 0.045, high: 0.06 }, solUsd: { low: 45, high: 55 } });

  let progress = null;
  let runs = 0;
  while (!progress || !progress.done) {
    progress = await priceRecord(payload, okCandles, progress, { maxLookups: 2 });
    runs++;
    assert.ok(runs < 10, 'pricing must converge');
  }
  assert.equal(progress.verdicts.length, 4);
  assert.equal(progress.verdict.status, 'verified');
  assert.ok(runs >= 2, 'the budget must actually have split the work');
});
