/* F-48 — the quiet-screen chain fill: the gap zone between two guards.
 *
 * Field report (Terp, lute.gg, WhiteBull on the MC axis, first live lute
 * session): the chart and the S mark sat at ~41K market cap when he clicked
 * sell; the engine booked the exit at 33.1K — a winning trade rendered as
 * -9.6%. The F-33 arbitration only arms when the screen ticked within 600ms
 * of the click, and the F-47 witness only wakes beyond 2x divergence. On a
 * quiet microcap the click landed in the structural gap between them: a
 * chain read lagging 24%, wearing a fresh timestamp, priced the fill with
 * no guard looking at it.
 *
 * These tests EXECUTE the shipped ladder — the action-quote section of
 * content.js booted verbatim against the real quote.js — with a resolver
 * fake that behaves exactly as the shipped R does (sendMessage().then(okOrNull):
 * it resolves null on failure, it never rejects). The field's own numbers
 * are the named regression.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global.window || {};
const Q = require('../quote.js');

const ROOT = path.join(__dirname, '..');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

// The report's numbers as native prices at 1e9 supply and SOL≈$180:
// 41K MC on the chart at click, 33.1K booked — a 1.24x lag, inside the
// (1.06x, 2x] gap zone neither shipped guard examined.
const MINT = 'oUwiFakeF48RegressionMintxxxxxxxxxxxxxxpump';
const N_CHART = 41_000 / 1e9 / 180;   // what he was looking at
const N_LAGGED = 33_100 / 1e9 / 180;  // what the chain read served

/** Boot the shipped action-quote ladder with a controlled surrounding. */
function bootLadder(env) {
  const start = contentJs.indexOf('/* -------------------- action-time quotes and fills');
  const end = contentJs.indexOf('/* -------------------- fills --------------------');
  assert.ok(start !== -1 && end > start, 'the action-quote section must exist in content.js');
  const block = contentJs.slice(start, end);

  const sandbox = {
    console: { debug: (...a) => env.debugLines.push(a.join(' ')) },
    Date, Promise, Set, Number, Boolean, Math, Infinity, JSON, setTimeout,
    Q,
    R: env.R,
    E: { fmt: (v) => String(v) },
    token: env.token,
    lastPriceAt: env.lastPriceAt,
    pageQuoteSeq: 0,
    pageQuoteWaiters: new Set(),
    site: env.site || { id: 'lute' },
  };
  const script = block + '\n;({ quoteForTrade, pickQuoteForTrade,'
    + ' setEvidence: (v) => { lastAcceptedMarket = v; },'
    + ' getRefusal: () => lastQuoteRefusal });';
  return vm.runInNewContext(script, vm.createContext(sandbox), { filename: 'content.js#action-quotes' });
}

/** A lute-shaped token as the panel holds it mid-session: chart-fed, resolved. */
function luteToken() {
  return {
    mint: MINT,
    priceNative: N_CHART,
    priceUsd: N_CHART * 180,
    mcap: 41_000,
    priceSource: 'chart-export',
    pending: false,
  };
}

/** The shipped R shape: resolves null on failure, never rejects. */
function fakeResolver(overrides) {
  const calls = { onchain: 0, refresh: 0 };
  return {
    calls,
    onchainQuote: async (mint) => {
      calls.onchain += 1;
      return overrides.observation && mint === overrides.observation.mint
        ? overrides.observation : (overrides.observation || null);
    },
    refresh: async () => {
      calls.refresh += 1;
      return overrides.refreshResult || null;
    },
  };
}

test('F-48: the WhiteBull sell — a lagging chain read on a quiet screen no longer prices the fill', async () => {
  const debugLines = [];
  const now = Date.now();
  const R = fakeResolver({
    // Value-lag wearing a fresh timestamp: the observation is stale in VALUE
    // only — its observedAt is the moment of the click.
    observation: { mint: MINT, priceNative: N_LAGGED, observedAt: now, slot: 1 },
    refreshResult: null, // pump-family, no aggregator anchor — exactly the field case
  });
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 1500, R, debugLines });
  // The tab accepted the 41K tick as money 1.5s ago — quiet (>600ms), not stale (<3s).
  ladder.setEvidence({ priceNative: N_CHART, at: now - 1500 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused — the trader\'s own screen price is in bound');
  assert.ok(Math.abs(q.priceNative - N_CHART) / N_CHART < 1e-9,
    `the fill must price at the ~41K the trader was looking at, not the lagging 33.1K (got ${q.priceNative})`);
  assert.notEqual(q.source, 'onchain',
    'the contradicted chain read must not be the source of this fill');
  assert.ok(debugLines.some((l) => l.includes('contradicts accepted market evidence')),
    'the demotion must leave a console trail naming both numbers');
});

test('F-48: a REAL move is confirmed by an independent source and fills at the moved level', async () => {
  const debugLines = [];
  const now = Date.now();
  const nMoved = N_CHART * 0.72; // a genuine -28% dump since the last tick
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: nMoved, observedAt: now, slot: 2 },
    // The aggregator has seen the same move — the chain read was TRUE.
    refreshResult: { mint: MINT, priceNative: nMoved * 1.01, priceUsd: nMoved * 1.01 * 180, mcap: 29_700 },
  });
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 1500, R, debugLines });
  ladder.setEvidence({ priceNative: N_CHART, at: now - 1500 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'a corroborated real move must fill — the guard must not over-reach');
  assert.ok(Math.abs(q.priceNative - nMoved * 1.01) / nMoved < 0.02,
    `the fill must price at the MOVED level (got ${q.priceNative}, expected ~${nMoved})`);
  assert.equal(q.source, 'action-resolver',
    'the independent source that confirmed the move is the source that prices it');
});

test('F-33 unchanged: a fresh screen still arbitrates and wins on divergence', async () => {
  const debugLines = [];
  const now = Date.now();
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_LAGGED, observedAt: now, slot: 3 },
  });
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 100, R, debugLines });
  ladder.setEvidence({ priceNative: N_CHART, at: now - 100 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused');
  assert.ok(Math.abs(q.priceNative - N_CHART) / N_CHART < 1e-9,
    'on a fresh screen the on-screen price still wins the divergence');
});

test('F-48: agreement adopts the chain read with no extra round trip', async () => {
  const debugLines = [];
  const now = Date.now();
  const nClose = N_CHART * 1.03; // inside the evidence band — ordinary drift
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: nClose, observedAt: now, slot: 4 },
  });
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 1500, R, debugLines });
  ladder.setEvidence({ priceNative: N_CHART, at: now - 1500 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused');
  assert.equal(q.source, 'onchain', 'an agreeing chain read is still the authority');
  assert.equal(R.calls.refresh, 0,
    'the default path must never pay an aggregator round trip — the guard is free when nothing is wrong');
});

test('F-48: no evidence, no veto — a fresh boot still fills from the only source there is', async () => {
  const debugLines = [];
  const now = Date.now();
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_LAGGED, observedAt: now, slot: 5 },
  });
  // Screen quiet AND no accepted evidence yet (first seconds on a token page).
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 1500, R, debugLines });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused');
  assert.equal(q.source, 'onchain',
    'with nothing to contradict, the chain read is the only truth and must fill');
});

test('F-48: when every honest source is gone, the answer is a refusal — never the lagging read', async () => {
  const debugLines = [];
  const now = Date.now();
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_LAGGED, observedAt: now, slot: 6 },
    refreshResult: null,
  });
  // Screen stale beyond the last-resort bound: the snapshot may not stand in.
  const ladder = bootLadder({ token: luteToken(), lastPriceAt: now - 4000, R, debugLines });
  ladder.setEvidence({ priceNative: N_CHART, at: now - 4000 });

  const q = await ladder.quoteForTrade();
  assert.equal(q, null,
    'a contradicted chain read with no honest source left must refuse, not fill 20% off the chart');
});

/* ---------------- the pure judgment, bounds and guards ---------------- */

test('F-48: the field ratios trip the band; ordinary drift does not', () => {
  assert.equal(Q.onchainContradictsEvidence(N_LAGGED, N_CHART, 1500), true,
    'the report\'s own 1.24x must be caught');
  assert.equal(Q.onchainContradictsEvidence(1.13, 1.0, 1500), true,
    'F-33\'s 13% chain error must be caught by the quiet-screen band too');
  assert.equal(Q.onchainContradictsEvidence(1.08, 1.0, 1500), false,
    'sub-band drift never trips — the guard must not tax ordinary fills');
  assert.equal(Q.onchainContradictsEvidence(N_CHART, N_LAGGED, 1500), true,
    'the band is direction-agnostic: a LEADING read answers to evidence too');
});

test('F-48: evidence beyond the window is history, not evidence', () => {
  assert.equal(Q.onchainContradictsEvidence(N_LAGGED, N_CHART, Q.ONCHAIN_EVIDENCE_WINDOW_MS + 1), false);
  assert.equal(Q.onchainContradictsEvidence(N_LAGGED, N_CHART, -1), false,
    'a negative age is a clock fault, not evidence');
});

test('F-48: missing numbers never veto', () => {
  assert.equal(Q.onchainContradictsEvidence(null, N_CHART, 1000), false);
  assert.equal(Q.onchainContradictsEvidence(N_LAGGED, null, 1000), false);
  assert.equal(Q.onchainContradictsEvidence(N_LAGGED, 0, 1000), false);
  assert.equal(Q.onchainContradictsEvidence(0, 0, 1000), false);
});

test('F-48: the veto judges ACCEPTED evidence, never token.priceNative', () => {
  // Source contract with the same rationale as F-47's: requote() overwrites
  // token.priceNative with resolver prices — a lagging aggregator is the
  // witness problem, not its solution. The quiet-screen judgment must read
  // the lastAcceptedMarket stream (validated ticks and committed fills).
  assert.match(contentJs,
    /Q\.onchainContradictsEvidence\(onchain\.priceNative,\s*\n?\s*acceptedEvidence && acceptedEvidence\.priceNative/,
    'the judgment is the pure, tested one, fed by accepted evidence');
  assert.match(contentJs, /const acceptedEvidence = lastAcceptedMarket;/,
    'the evidence is the F-47 accepted-market stream');
});
