/* F-47 — the fill witness: no single source may resurrect a dead price.
 *
 * Field report (chatcabal, Axiom, migrated Pump-AMM coin "fork"): the market
 * crashed ~$30K -> ~$8K market cap; his DCA buy filled honestly at the
 * crashed price ($6.8K MC), and the SELL sixty seconds later filled at the
 * pre-crash level ($30.0K MC) — a real loss rendered as +167% P&L, 8.09 SOL
 * returned on 3 SOL in. Whatever source served the dead price, the
 * corruption's shape is one: the chosen candidate contradicted market
 * evidence the same tab had JUST accepted as money.
 *
 * The discipline under test: a candidate that diverges from recent accepted
 * evidence by more than FILL_WITNESS_RATIO needs an independent second
 * source to vouch for it; a missing or dissenting witness refuses the fill.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
const Q = require('../quote.js');

// The report's own numbers, as native prices at ~1e9 supply and SOL≈$180:
// $6.8K MC ≈ 3.78e-8 SOL, $30K MC ≈ 1.67e-7 SOL, $8K MC ≈ 4.44e-8 SOL.
const CRASHED_BUY = 3.78e-8;   // his honest DCA fill, 60s before the sell
const DEAD_PRICE = 1.67e-7;    // what the sell actually filled at
const REAL_MARKET = 4.44e-8;   // what a fresh independent source would say

test('F-47: the chatcabal sell — a resurrected pre-crash price demands a witness and fails it', () => {
  assert.equal(Q.needsFillWitness(DEAD_PRICE, CRASHED_BUY, 60_000), true,
    'a 4.4x divergence from a 60s-old accepted fill must not fill unexamined');
  assert.equal(Q.witnessAgrees(DEAD_PRICE, REAL_MARKET), false,
    'the fresh market price refutes the dead candidate — the fill is refused');
});

test('F-47: a REAL violent move is confirmed by any fresh witness and fills normally', () => {
  // The market genuinely 4x'd: candidate and witness both sit at the new level.
  const newLevel = CRASHED_BUY * 4;
  assert.equal(Q.needsFillWitness(newLevel, CRASHED_BUY, 45_000), true,
    'the divergence still asks for a witness');
  assert.equal(Q.witnessAgrees(newLevel, newLevel * 1.05), true,
    'a corroborated real move fills — the guard must never tax honest pumps');
});

test('F-47: ordinary moves never pay the witness round trip', () => {
  assert.equal(Q.needsFillWitness(CRASHED_BUY * 1.8, CRASHED_BUY, 30_000), false,
    'inside the ratio: no witness, no extra latency');
  assert.equal(Q.needsFillWitness(DEAD_PRICE, CRASHED_BUY, Q.FILL_WITNESS_WINDOW_MS + 1), false,
    'evidence beyond the window is history, not evidence');
  assert.equal(Q.needsFillWitness(DEAD_PRICE, null, 1000), false,
    'no evidence at all: the bootstrap/sane-band rules own that case');
});

test('F-47: a missing witness never confirms', () => {
  assert.equal(Q.witnessAgrees(DEAD_PRICE, null), false);
  assert.equal(Q.witnessAgrees(DEAD_PRICE, 0), false);
  assert.equal(Q.witnessAgrees(0, REAL_MARKET), false,
    'a nonsense candidate cannot be vouched for either');
});

test('F-47: the fill path actually routes through the witness', () => {
  // Source contract on content.js: quoteForTrade must be the corroborated
  // wrapper, evidence must come from ACCEPTED ticks and committed fills —
  // never from token.priceNative, which requote() overwrites with resolver
  // prices (the exact source class that resurrected the dead price).
  const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.match(content, /async function quoteForTrade\(\) \{\s*\n\s*return corroborateForFill\(await pickQuoteForTrade\(\)\);/,
    'every buy/sell quote must pass the witness gate');
  assert.match(content, /lastAcceptedMarket = \{ priceNative: verdict\.priceNative, at: Date\.now\(\) \};/,
    'accepted ticks are evidence');
  const fillEvidence = content.match(/lastAcceptedMarket = \{ priceNative: result\.trade\.priceNative, at: Date\.now\(\) \};/g) || [];
  assert.ok(fillEvidence.length >= 2, 'committed buys AND sells are money evidence');
  // F-57 widened this contract: the judgment also carries WHERE the candidate
  // came from, because an aggregator snapshot answers to a tighter band than
  // a live feed does.
  assert.match(content, /Q\.needsFillWitness\(chosen\.priceNative, evidence && evidence\.priceNative,\s*\n?\s*evidenceAge, chosen\.source\)/,
    'the divergence judgment is the pure, tested one, and it knows the source');
  assert.match(content, /if \(Q\.isAggregatorSource\(chosen\.source\)\) \{\s*\n\s*const obs = await R\.onchainQuote\(/,
    'an aggregator candidate must be witnessed by the chain, never by the aggregator again');
  assert.match(content, /if \(Q\.witnessAgrees\(chosen\.priceNative, witnessNative\)\) return chosen;/,
    'only an agreeing witness lets a divergent candidate fill');
});
