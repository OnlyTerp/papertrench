/* "Sell your initial" — recover what went in, hold the rest as house money.
 *
 * The number behind that move is not "half", and it is not the naive
 * invested/value either: costs come off the top, so netting back what you put
 * in means selling MORE. Get it wrong and the trader believes they are
 * de-risked while still a few percent short — which is the exact belief this
 * feature exists to make true.
 *
 * So these tests do not assert the formula back at itself. They run the plan
 * through the REAL engine and check the money actually came back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
const E = require('../engine.js');
const Q = require('../quote.js');

/** Open a position, then ask for the sell-initial plan and execute it. */
function runScenario({ feeBps = 0, slippageBps = 0, gas = 0, tip = 0, buySol = 1, growth = 3 }) {
  const settings = Object.assign(E.defaultSettings(), {
    feeBps, slippageBps, gasSolPerTx: gas, tipSolPerTx: tip, balanceStartSol: 100,
  });
  const state = E.defaultState(settings);
  const mint = 'MINT';
  E.buy(state, settings, { ts: 1000, mint, symbol: 'T', site: 's', priceNative: 1, solAmount: buySol });

  const pos = state.positions[mint];
  const price = growth; // the token has run to `growth`x the entry price
  const mark = Q.positionMark(pos, price, null);
  const ledger = Q.positionLedger(state.journal, pos, mark.valueSol);
  const plan = Q.sellInitialPlan(pos, ledger, price, {
    feeBps, slippageBps, flatSol: gas + tip,
  });

  if (!plan) return { plan: null, state, settings, pos, ledger };
  E.sell(state, settings, { ts: 2000, mint, qtyFraction: plan.fraction, priceNative: price });

  const after = Q.positionLedger(state.journal, state.positions[mint] || pos,
    (state.positions[mint] ? state.positions[mint].qty : 0) * price);
  return { plan, state, settings, ledger, after };
}

test('with no costs, selling the plan returns exactly what went in', () => {
  const { plan, ledger, after } = runScenario({ growth: 4 });
  assert.ok(plan, 'a plan must exist while money is still out');
  assert.ok(Math.abs(after.soldSol - ledger.investedSol) < 1e-9,
    `sold ${after.soldSol} should equal invested ${ledger.investedSol}`);
  assert.equal(after.houseMoney, true, 'the remainder is now house money');
});

test('a percentage fee is paid out of the sale, not out of the trader', () => {
  // The naive fraction would net (1 - fee) of what was needed and leave the
  // position quietly short.
  const { plan, ledger, after } = runScenario({ feeBps: 100, growth: 4 });
  assert.ok(Math.abs(after.soldSol - ledger.investedSol) < 1e-9,
    'a 1% fee must not leave the recovery 1% short');
  assert.ok(plan.fraction > 0 && plan.fraction < 1);
});

test('flat gas and tip are recovered too', () => {
  const { ledger, after } = runScenario({ gas: 0.002, tip: 0.003, growth: 4 });
  assert.ok(Math.abs(after.soldSol - ledger.investedSol) < 1e-9,
    'the flat cost of the exit itself must be covered by the exit');
});

test('slippage is priced from the fill, not the quote on screen', () => {
  // The engine fills a sell BELOW the displayed price. Planning on the quote
  // would sell too little every time.
  const { ledger, after } = runScenario({ slippageBps: 200, growth: 4 });
  assert.ok(Math.abs(after.soldSol - ledger.investedSol) < 1e-9,
    '2% slippage must be planned for, not discovered');
});

test('every cost at once still lands exactly whole', () => {
  const { ledger, after } = runScenario({
    feeBps: 100, slippageBps: 150, gas: 0.001, tip: 0.001, growth: 5,
  });
  assert.ok(Math.abs(after.soldSol - ledger.investedSol) < 1e-9,
    'fee + slippage + flat compose without drift');
});

test('a position that has not run cannot recover its initial, and says so', () => {
  // Down 50%: the whole bag is worth less than what went in.
  const { plan } = runScenario({ growth: 0.5 });
  assert.ok(plan, 'a plan is still returned — the shortfall is information');
  assert.equal(plan.shortfall, true, 'it must state that the bag cannot cover it');
  assert.equal(plan.fraction, 1, 'and cap at the whole position rather than over-ask');
});

test('an already-whole round offers nothing to do', () => {
  const settings = Object.assign(E.defaultSettings(), { balanceStartSol: 100, feeBps: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: 'M', symbol: 'T', site: 's', priceNative: 1, solAmount: 1 });
  // Sell most of it at 10x — proceeds far exceed what went in.
  E.sell(state, settings, { ts: 2000, mint: 'M', qtyFraction: 0.5, priceNative: 10 });
  const pos = state.positions.M;
  const ledger = Q.positionLedger(state.journal, pos, pos.qty * 10);
  assert.equal(ledger.houseMoney, true);
  assert.equal(Q.sellInitialPlan(pos, ledger, 10, { flatSol: 0 }), null,
    'nothing left to recover means no plan');
});

test('a priceless or empty position produces no plan rather than a guess', () => {
  const ledger = { investedSol: 1, soldSol: 0 };
  assert.equal(Q.sellInitialPlan({ qty: 0, lastPriceNative: 1 }, ledger, 1, {}), null);
  assert.equal(Q.sellInitialPlan({ qty: 5, lastPriceNative: 0 }, ledger, 0, {}), null);
  assert.equal(Q.sellInitialPlan(null, ledger, 1, {}), null);
});

/* ---------------- the control that acts on the plan ---------------- */

const fs = require('node:fs');
const path = require('node:path');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function block(name) {
  const at = content.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${name} must exist`);
  return content.slice(at, content.indexOf('\n  }', at) + 4);
}

test('the button plans against the same costs the fill will charge', () => {
  // A plan built on different numbers from the sell is a plan that misses.
  const fn = block('currentInitialPlan');
  assert.match(fn, /feeBps: settings\.feeBps/);
  assert.match(fn, /slippageBps: settings\.slippageBps/);
  assert.match(fn, /flatSol: E\.txCostSol\(settings\)/,
    'the flat cost must come from the engine, not a second copy of the clamp');
});

test('a shortfall refuses instead of selling everything and calling it a recovery', () => {
  const click = content.slice(content.indexOf("initialBtn.addEventListener('click'"),
    content.indexOf('buildOrdersSection(card)'));
  assert.match(click, /if \(!plan \|\| plan\.shortfall\) return;/,
    'the handler must refuse a shortfall outright');

  const render = block('renderSellInitial');
  assert.match(render, /btn\.disabled = true/, 'and the control must show as unavailable');
  assert.match(render, /Not enough to cover the initial yet/, 'saying why');
});

test('the label states the fraction it is about to sell', () => {
  // "Sell initial" alone asks the trader to trust an unstated number.
  const render = block('renderSellInitial');
  assert.match(render, /plan\.fraction \* 100/);
  assert.match(render, /Sell initial \(\$\{/);
});

test('nothing to recover means no button at all', () => {
  const render = block('renderSellInitial');
  assert.match(render, /if \(!plan\) \{ btn\.classList\.add\('pt-hidden'\); return; \}/,
    'a round already whole has no initial left to take off the table');
});
