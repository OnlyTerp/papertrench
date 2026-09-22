/* Gross-basis open and per-sell P&L, while the equity curve keeps its net steps. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../engine.js');
require('../quote.js');
const E = global.window.PaperEngine;
const Q = global.window.PaperQuote;

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function close(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`);
}

test('T1: seeded buys and partial sells preserve gross P&L and the existing curve identity', () => {
  const random = seeded(0xD77079);
  for (const feeBps of [100, 125]) {
    for (const flatSol of [0, 0.001]) {
      const settings = Object.assign(E.defaultSettings(), {
        balanceStartSol: 100,
        feeBps,
        gasSolPerTx: flatSol,
        tipSolPerTx: 0,
        slippageBps: 0,
      });
      const state = E.defaultState(settings);
      let ts = 1_800_000_000_000;

      const buySequence = (mint, count) => {
        for (let i = 0; i < count; i++) {
          const priceNative = 0.0008 + random() * 0.0006;
          E.buy(state, settings, {
            ts: ts += 1000,
            mint,
            symbol: mint,
            site: 'gmgn',
            solAmount: 0.25 + random() * 0.5,
            priceNative,
            priceUsd: priceNative * 150,
          });
        }
      };
      const sellAt = (mint, qtyFraction, multiplier) => {
        const pos = state.positions[mint];
        const priceNative = pos.lastPriceNative * multiplier;
        return E.sell(state, settings, {
          ts: ts += 1000,
          mint,
          qtyFraction,
          priceNative,
          priceUsd: priceNative * 150,
        });
      };

      buySequence(`Full-${feeBps}-${flatSol}`, 3);
      const fullMint = `Full-${feeBps}-${flatSol}`;
      const fullPos = state.positions[fullMint];
      const fullPrice = fullPos.lastPriceNative * (0.9 + random() * 0.2);
      const fullPreview = E.previewSell(fullPos, settings, {
        qtyFraction: 1, priceNative: fullPrice, priceUsd: fullPrice * 150,
      });
      assert.deepEqual(Object.keys(fullPreview).sort(), [
        'qty', 'px', 'gross', 'fee', 'flat', 'net', 'grossCostShare', 'pnlGrossSol',
      ].sort(), 'previewSell exposes the full sale math without mutating state');
      const fullExit = E.sell(state, settings, {
        ts: ts += 1000,
        mint: fullMint,
        qtyFraction: 1,
        priceNative: fullPrice,
        priceUsd: fullPrice * 150,
      });
      assert.ok(fullExit.round, 'the 100% sell closes the round');
      close(fullPreview.pnlGrossSol, fullExit.trade.pnlGrossSol, 1e-12,
        'preview and committed 100% sell use identical math');
      close(fullPreview.pnlGrossSol, fullExit.round.pnlSol, 1e-12,
        'preview of the one-shot close equals the completed round');

      const partialMint = `Partial-${feeBps}-${flatSol}`;
      buySequence(partialMint, 4);
      sellAt(partialMint, 0.23 + random() * 0.12, 0.88 + random() * 0.24);
      sellAt(partialMint, 0.31 + random() * 0.12, 0.88 + random() * 0.24);
      const partialExit = sellAt(partialMint, 1, 0.88 + random() * 0.24);
      assert.ok(partialExit.round, 'the final clipped sell closes its round');

      const openMint = `Open-${feeBps}-${flatSol}`;
      buySequence(openMint, 2);
      const openExit = sellAt(openMint, 0.37, 0.9 + random() * 0.2);
      const latestPartial = E.latestClosedPnl(state, openMint);
      const grossCostShare = openExit.trade.solNet - openExit.trade.pnlGrossSol;
      close(latestPartial.pnlSol, openExit.trade.pnlGrossSol, 1e-12,
        'the partial-exit builder selects gross P&L');
      close(latestPartial.pnlPct, openExit.trade.pnlGrossSol / grossCostShare * 100, 1e-12,
        'the partial-exit percentage uses its gross cost share');
      const legacyState = JSON.parse(JSON.stringify(state));
      const legacySell = legacyState.journal.find((trade) => trade.id === openExit.trade.id);
      delete legacySell.pnlGrossSol;
      const legacyResult = E.latestClosedPnl(legacyState, openMint);
      const legacyRemaining = legacyState.positions[openMint];
      const legacyFraction = legacySell.qty / (legacySell.qty + legacyRemaining.qty);
      const legacyShare = E.grossOpenCostSol(legacyRemaining) * legacyFraction / (1 - legacyFraction);
      close(legacyResult.pnlSol, legacySell.pnlSol, 1e-12,
        'legacy partial rows retain their historical P&L value');
      close(legacyResult.pnlPct, legacySell.pnlSol / legacyShare * 100, 1e-12,
        'legacy partial percentages use the gross cost share when derivable');
      const openPos = state.positions[openMint];
      const livePrice = openPos.lastPriceNative * (0.9 + random() * 0.2);
      E.markPosition(state, openMint, livePrice, livePrice * 150);

      for (const round of state.rounds) {
        const roundSells = state.journal.filter((trade) =>
          trade.side === 'sell' && round.tradeIds.includes(trade.id));
        close(roundSells.reduce((sum, trade) => sum + trade.pnlGrossSol, 0), round.pnlSol, 1e-9,
          'gross per-sell results sum to every closed round');
      }

      const grossSells = state.journal.filter((trade) => trade.side === 'sell')
        .reduce((sum, trade) => sum + trade.pnlGrossSol, 0);
      const grossOpen = Object.values(state.positions)
        .reduce((sum, pos) => sum + E.unrealizedPnlGross(pos), 0);
      close(E.sessionStats(state, settings).unrealizedSol, grossOpen, 1e-12,
        'dashboard open totals use gross unrealized P&L');
      const month = new Date(ts).getMonth();
      const year = new Date(ts).getFullYear();
      close(E.pnlCalendar(state, year, month, { now: ts }).openPnlSol, grossOpen, 1e-12,
        'calendar open totals use gross unrealized P&L');
      const start = E.anchorStartSol(state, settings);
      close(E.equitySol(state) - start, grossSells + grossOpen, 1e-9,
        'equity change equals gross realized sells plus gross open P&L');
      const netSells = state.journal.filter((trade) => trade.side === 'sell')
        .reduce((sum, trade) => sum + trade.pnlSol, 0);
      close(state.stats.realizedPnlSol, netSells, 1e-12,
        'the load-bearing state accumulator retains its existing net semantics');

      const curve = E.equityCurvePoints(state, start, { now: ts + 1000 });
      close(curve[curve.length - 1].eq, E.equitySol(state), 1e-9,
        'the unchanged equity-curve identity still ends at equity');
    }
  }
});

test('T2: positionMark uses unrealizedPnlGross and the shared gross percentage', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 125, gasSolPerTx: 0, tipSolPerTx: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1_800_000_000_000,
    mint: 'GrossMark',
    symbol: 'GROSS',
    solAmount: 0.5,
    priceNative: 1,
    priceUsd: 150,
  });
  const pos = state.positions.GrossMark;
  const price = 1.3;
  const mark = Q.positionMark(pos, price, price * 150, E.grossOpenCostSol(pos));

  assert.ok(mark);
  close(mark.pnlSol, E.unrealizedPnlGross(pos, price), 1e-12,
    'positionMark SOL P&L matches the engine gross helper');
  close(mark.pnlPct, E.positionPnlPct({ ...pos, lastPriceNative: price }), 1e-12,
    'positionMark percentage matches the engine gross denominator');
  close(mark.pnlUsd, mark.pnlSol * 150, 1e-10,
    'USD follows the gross SOL P&L');

  const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  assert.match(content, /Q\.positionMark\(pos, token\.priceNative, token\.priceUsd, E\.grossOpenCostSol\(pos\)\)/,
    'the panel and profit alerts pass the engine gross cost into positionMark');
  assert.match(content, /Q\.positionRows\(state, livePositionPrices, token && token\.mint, activeQuote, E\.grossOpenCostSol\)/,
    'positions-bar chips and totals use the engine gross cost');
  assert.match(content, /pnlSol: E\.unrealizedPnlGross\(pos\)/,
    'the in-page open-position share card uses gross P&L');
  assert.match(dashboard, /const pnl = E\.unrealizedPnlGross\(p\)/,
    'dashboard open-position rows use gross P&L');
  assert.match(dashboard, /pnlSol: E\.unrealizedPnlGross\(pos\)/,
    'dashboard open-position share cards use gross P&L');
});
