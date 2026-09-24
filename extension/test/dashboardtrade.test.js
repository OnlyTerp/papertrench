/* Dashboard open-position trading (s0berr: "buy and sell buttons on the
 * dashboard's open positions, price updated right inside PaperTrench").
 *
 * Two layers pinned here:
 *
 *   - quote.js dashboardFillDecision: both legs fresh (≤10s), agreeing
 *     within 3% on the chain's own unit (native on Solana, USD elsewhere),
 *     and the fill books the CONSERVATIVE side of the pair — sells take the
 *     lower quote, buys the higher.
 *   - dashboard.js dashboardFill driven through a stub chrome.runtime: a
 *     sell commits through the real mutateState CAS loop, appends the
 *     attestation link AFTER the commit, emits pt_trade_event, and a
 *     disagreement refusal leaves the wallet untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const Q = require('../quote.js');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NOW = 1_800_000_000_000;

const leg = (over) => Object.assign({
  name: 'resolver', chain: 'solana', at: NOW,
  priceNative: 0.001, priceUsd: 0.2, mcap: 1e6,
}, over || {});

/* ---------------- the pure decision table ---------------- */

test('two fresh agreeing quotes fill at the conservative leg', () => {
  // Sells take the LOWER quote: a disagreement can only cost the trader.
  const sell = Q.dashboardFillDecision('sell',
    leg({ priceNative: 0.001 }), leg({ name: 'onchain', priceNative: 0.00098 }), NOW);
  assert.equal(sell.ok, true);
  assert.equal(sell.priceNative, 0.00098);
  assert.equal(sell.source, 'dashboard:resolver+onchain');

  // Buys take the HIGHER quote.
  const buy = Q.dashboardFillDecision('buy',
    leg({ priceNative: 0.001 }), leg({ name: 'onchain', priceNative: 0.00102 }), NOW);
  assert.equal(buy.ok, true);
  assert.equal(buy.priceNative, 0.00102);
});

test('a >3% disagreement refuses', () => {
  const d = Q.dashboardFillDecision('sell',
    leg({ priceNative: 0.001 }), leg({ name: 'onchain', priceNative: 0.0009 }), NOW);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'disagree');
});

test('a stale or missing leg refuses', () => {
  assert.equal(Q.dashboardFillDecision('sell', leg(), leg({ at: NOW - 11_000 }), NOW).reason, 'stale');
  assert.equal(Q.dashboardFillDecision('sell', leg(), null, NOW).reason, 'missing');
  assert.equal(Q.dashboardFillDecision('sell', leg({ at: 0 }), leg(), NOW).reason, 'stale');
  assert.equal(Q.dashboardFillDecision('sell', leg(), leg({ priceNative: 0 }), NOW).reason, 'missing');
});

test('foreign chains compare the USD leg, never a synthesized SOL leg', () => {
  // Native legs wildly divergent, USD legs identical: on robinhood the USD
  // leg is the truth, so this AGREES.
  const d = Q.dashboardFillDecision('sell',
    leg({ chain: 'robinhood', priceNative: 0.001, priceUsd: 0.5 }),
    leg({ name: 'worker', chain: 'robinhood', priceNative: 0.9, priceUsd: 0.505 }), NOW);
  assert.equal(d.ok, true);
  assert.equal(d.priceUsd, 0.5, 'a sell books the lower USD leg');
  // …and the same shapes flipped refuse on USD disagreement.
  const no = Q.dashboardFillDecision('sell',
    leg({ chain: 'robinhood', priceUsd: 0.5 }),
    leg({ name: 'worker', chain: 'robinhood', priceUsd: 0.4 }), NOW);
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'disagree');
});

test('a fill with no SOL leg can never book', () => {
  // Both legs quote USD only on Solana — the wallet is SOL-denominated, so
  // the missing leg refuses rather than inventing a conversion.
  const d = Q.dashboardFillDecision('sell',
    leg({ priceNative: null }), leg({ name: 'worker', priceNative: null, priceUsd: 0.21 }), NOW);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'missing');
});

/* ---------------- the dashboard glue, stubbed runtime ---------------- */

function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/**
 * Boot the real dashboard row-fill path: dashboardQuoteLegs + the
 * summarizers + dashboardFill + the REAL mutateState CAS loop, against a
 * stub chrome.runtime that records every message.
 */
function bootDashboard({ resolver, witness, storage }) {
  const sent = [];
  const storageObj = Object.assign({ pt_state: storage.state, pt_settings: storage.settings }, storage.extra || {});
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg) => {
        sent.push(msg);
        if (msg.type === 'pt_refresh') return Promise.resolve(resolver(msg.token));
        if (msg.type === 'pt_onchain_quote') return Promise.resolve(witness.onchain ? witness.onchain(msg.mint) : null);
        if (msg.type === 'pt_worker_quote') {
          const q = witness.worker ? witness.worker(msg.mints[0]) : null;
          return Promise.resolve(q ? { [msg.mints[0]]: q } : null);
        }
        if (msg.type === 'pt_state_commit') {
          const cur = storageObj.pt_state;
          if (!msg.force && (Number(cur && cur.seq) || 0) !== (Number(msg.expectedSeq) || 0)) {
            return Promise.resolve({ ok: false, reason: 'stale', current: cur ? JSON.parse(JSON.stringify(cur)) : null });
          }
          storageObj.pt_state = JSON.parse(JSON.stringify(msg.state));
          return Promise.resolve({ ok: true });
        }
        if (msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0 });
        return Promise.resolve({ ok: true });
      },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          for (const k of [].concat(keys)) if (k in storageObj) out[k] = JSON.parse(JSON.stringify(storageObj[k]));
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          for (const k of Object.keys(obj)) storageObj[k] = JSON.parse(JSON.stringify(obj[k]));
          if (cb) cb();
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { create: () => {} },
  };

  const notes = [];
  const ctx = {
    window: { PaperQuote: Q }, chrome, console, Date, JSON, Number, Math, Object, Array, Promise, String,
    E, settings: storage.settings,
    state: storage.state,
    posQuotes: new Map(),
    storageReadFailed: false,
    posRowNote: (mint, text) => notes.push(text),
    invalidateReplayView: () => {},
    refreshIfChanged: async () => {},
    refreshLiveDerived: () => {},
    fillLevel: (t) => String(t && t.mcap || ''),
    setTimeout: (fn) => fn(),
    document: { visibilityState: 'visible', querySelector: () => null, addEventListener: () => {} },
  };
  vm.createContext(ctx);
  // The real store + mutateState — the CAS contract is part of what is
  // pinned here, not a stub of it.
  const storeStart = dashJs.indexOf('const store = {');
  const storeEnd = dashJs.indexOf('\n};', storeStart);
  vm.runInContext(dashJs.slice(storeStart, storeEnd + 3), ctx);
  vm.runInContext(fnBlock(dashJs, 'async function mutateState('), ctx);
  vm.runInContext(fnBlock(dashJs, 'async function dashboardQuoteLegs('), ctx);
  vm.runInContext(fnBlock(dashJs, 'function dashSummarizeSession('), ctx);
  vm.runInContext(fnBlock(dashJs, 'function dashSummarizeTrade('), ctx);
  vm.runInContext(fnBlock(dashJs, 'function dashSummarizeRound('), ctx);
  vm.runInContext(fnBlock(dashJs, 'async function dashboardFill('), ctx);
  return { ctx, sent, notes, storageObj };
}

function dashboardWallet() {
  const settings = E.mergeSettings({ feeBps: 0, slippageBps: 0, gasSolPerTx: 0, tipSolPerTx: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: NOW - 60_000, mint: MINT, symbol: 'BONK', site: 'gmgn',
    solAmount: 1, priceNative: 0.001, priceUsd: 0.2, mcap: 1e6,
  });
  return { state, settings };
}

test('a row sell commits through CAS, appends the chain, emits the event', async () => {
  const { state, settings } = dashboardWallet();
  const qtyBefore = state.positions[MINT].qty;
  const { ctx, sent, notes, storageObj } = bootDashboard({
    storage: { state, settings },
    resolver: () => ({ mint: MINT, priceNative: 0.0012, priceUsd: 0.24, mcap: 1.2e6, resolvedAt: Date.now() }),
    witness: { onchain: () => ({ mint: MINT, priceNative: 0.00119, observedAt: Date.now() }) },
  });
  await ctx.dashboardFill(MINT, 'sell', 50);

  const pos = storageObj.pt_state.positions[MINT];
  assert.ok(pos && pos.qty > 0 && pos.qty < qtyBefore, 'the 50% sell halved the bag');
  const fill = storageObj.pt_state.journal.find((j) => j.side === 'sell' && j.mint === MINT);
  assert.ok(fill, 'a sell fill is journaled');
  assert.equal(fill.priceSource, 'dashboard:resolver+onchain');
  assert.ok(fill.priceNative < 0.0012, 'sold at the conservative (lower) leg');
  assert.ok(Number.isFinite(fill.priceAgeMs));

  // Ordering: the wallet commit precedes the chain append precedes the
  // trade event — a chained link must never precede its fill's commit.
  const order = sent.map((m) => m.type);
  assert.ok(order.indexOf('pt_state_commit') < order.indexOf('pt_attest_append'),
    'attest append lands after the wallet commit');
  assert.ok(order.indexOf('pt_attest_append') < order.indexOf('pt_trade_event'));
  const ev = sent.find((m) => m.type === 'pt_trade_event');
  assert.equal(ev.kind, 'sell');
  assert.equal(ev.trade.source, 'dashboard');
  assert.equal(ev.trade.mint, MINT);
  assert.ok(!notes.some((n) => /disagree|unavailable/.test(n)), JSON.stringify(notes));
});

test('a row buy adds through the same gate (Solana only button)', async () => {
  const { state, settings } = dashboardWallet();
  const cashBefore = state.cashSol;
  const { ctx, sent, storageObj } = bootDashboard({
    storage: { state, settings },
    resolver: () => ({ mint: MINT, priceNative: 0.001, priceUsd: 0.2, mcap: 1e6, resolvedAt: Date.now() }),
    witness: { onchain: () => ({ mint: MINT, priceNative: 0.00101, observedAt: Date.now() }) },
  });
  await ctx.dashboardFill(MINT, 'buy', 0.5);
  const pos = storageObj.pt_state.positions[MINT];
  assert.ok(storageObj.pt_state.cashSol < cashBefore, 'cash spent');
  assert.ok(storageObj.pt_state.journal.some((j) => j.side === 'buy' && j.priceSource === 'dashboard:resolver+onchain'));
  const ev = sent.find((m) => m.type === 'pt_trade_event');
  assert.equal(ev.kind, 'buy');
  assert.equal(ev.opened, false, 'adding to an open bag is not an open');
});

test('a disagreement refuses loudly and leaves the wallet untouched', async () => {
  const { state, settings } = dashboardWallet();
  const journalLen = state.journal.length;
  const { ctx, sent, notes, storageObj } = bootDashboard({
    storage: { state, settings },
    resolver: () => ({ mint: MINT, priceNative: 0.001, priceUsd: 0.2, mcap: 1e6, resolvedAt: Date.now() }),
    witness: { onchain: () => ({ mint: MINT, priceNative: 0.0008, observedAt: Date.now() }) }, // 20% off
  });
  await ctx.dashboardFill(MINT, 'sell', 50);
  assert.equal(storageObj.pt_state.journal.length, journalLen, 'no fill booked');
  assert.equal(storageObj.pt_state.positions[MINT].qty, state.positions[MINT].qty);
  assert.ok(!sent.some((m) => m.type === 'pt_state_commit'), 'no wallet write attempted');
  assert.ok(!sent.some((m) => m.type === 'pt_attest_append'), 'no chain link for a refused fill');
  assert.ok(notes.some((n) => /disagree|unavailable/.test(n)), JSON.stringify(notes));
});

test('a dead second source refuses rather than filling on the aggregator alone', async () => {
  const { state, settings } = dashboardWallet();
  const journalLen = state.journal.length;
  const { ctx, notes, storageObj } = bootDashboard({
    storage: { state, settings },
    resolver: () => ({ mint: MINT, priceNative: 0.001, priceUsd: 0.2, mcap: 1e6, resolvedAt: Date.now() }),
    witness: { onchain: () => null, worker: () => null },
  });
  await ctx.dashboardFill(MINT, 'sell', 100);
  assert.equal(storageObj.pt_state.journal.length, journalLen);
  assert.ok(notes.some((n) => /unavailable|disagree/.test(n)));
});
