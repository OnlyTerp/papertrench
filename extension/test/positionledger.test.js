/* The round ledger: invested / sold / remaining / change.
 *
 * Requested from a venue screenshot — INVESTED, SOLD, REMAINING, PNL CHANGE.
 * The question it answers is not the one positionMark answers. A bag sold
 * halfway down shows a RED unrealized P&L on what is left while the round as
 * a whole is up, so the card stated one thing and the trader meant the other.
 *
 * Derived, never stored, so the tests are about what it must never count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require('../quote.js');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const POS = { mint: 'MINT', sessionId: 'S1', openedAt: 1000, investedSol: 2, qty: 10, costSol: 1 };
// mint rides on every real journal fill, and the sessionId-less fallback path
// matches on it — a fixture without one exercises neither branch.
const sell = (o) => Object.assign(
  { side: 'sell', mint: 'MINT', sessionId: 'S1', ts: 2000, solNet: 0, pnlSol: 0 }, o);

test('no sells yet means no ledger to show', () => {
  const led = Q.positionLedger([], POS, 3);
  assert.equal(led.sells, 0, 'nothing has come back');
  assert.equal(led.soldSol, 0);
});

test('the change is money back plus money still held, against money in', () => {
  const led = Q.positionLedger([sell({ solNet: 1.5, pnlSol: 0.5 })], POS, 1.2);
  assert.equal(led.investedSol, 2);
  assert.equal(led.soldSol, 1.5);
  assert.equal(led.remainingSol, 1.2);
  // 1.5 returned + 1.2 still held − 2 in = +0.7
  assert.ok(Math.abs(led.changeSol - 0.7) < 1e-9);
  assert.ok(Math.abs(led.changePct - 35) < 1e-9);
});

test('a previous round in the same token is not counted', () => {
  // sessionId is stamped per position-open, so the earlier round has its own.
  const led = Q.positionLedger([
    sell({ solNet: 1, pnlSol: 0.4 }),
    sell({ sessionId: 'OLD-ROUND', solNet: 99, pnlSol: 99 }),
  ], POS, 0.5);
  assert.equal(led.sells, 1);
  assert.equal(led.soldSol, 1, 'the old round must not inflate this one');
});

test('a sell older than the position is not counted, even without a sessionId', () => {
  // Chains predating sessionIds fall back to matching by mint, which alone
  // would sweep in every earlier round the token ever had.
  const led = Q.positionLedger([
    sell({ sessionId: null, ts: 500, solNet: 50, pnlSol: 50 }),
    sell({ sessionId: null, ts: 3000, solNet: 1, pnlSol: 0.2 }),
  ], POS, 0.5);
  assert.equal(led.sells, 1, 'only the sell that belongs to THIS open round');
  assert.equal(led.soldSol, 1);
});

test('buys are never mistaken for money coming back', () => {
  const led = Q.positionLedger([
    { side: 'buy', sessionId: 'S1', ts: 1500, solNet: 5 },
    sell({ solNet: 1, pnlSol: 0.1 }),
  ], POS, 0.5);
  assert.equal(led.soldSol, 1);
});

test('house money is the sells alone covering what went in', () => {
  const under = Q.positionLedger([sell({ solNet: 1.99, pnlSol: 0.2 })], POS, 5);
  assert.equal(under.houseMoney, false, 'unrealised value must not count toward it');
  const over = Q.positionLedger([sell({ solNet: 2.0, pnlSol: 0.3 })], POS, 0.1);
  assert.equal(over.houseMoney, true);
});

test('a zero-invested position cannot produce an infinite percentage', () => {
  const led = Q.positionLedger([sell({ solNet: 1 })], { ...POS, investedSol: 0 }, 1);
  assert.equal(led.changePct, 0, 'no denominator means no percentage claim');
  assert.ok(Number.isFinite(led.changeSol));
});

test('the panel renders it in the venue currency, and only after a sell', () => {
  const fn = content.slice(
    content.indexOf('function renderPositionLedger('),
    content.indexOf('\n  }', content.indexOf('function renderPositionLedger(')) + 4);
  // It is permanent now. Before the first sell, `sold` is honestly zero —
  // money genuinely has not come back — while invested and remaining are
  // real from the first fill, so there is nothing to hide.
  assert.ok(!/led\.sells === 0/.test(fn), 'the ledger must not hide itself any more');
  assert.match(fn, /ledger\.classList\.remove\('pt-hidden'\)/,
    'it is shown on every pass');
  assert.match(fn, /panelUsd\(\)/, 'dollars off Solana');
  assert.match(fn, /E\.fmt\(sol, 3\)} SOL/, 'SOL on Solana');
  assert.match(fn, /pt-house/, 'and it must mark the house-money state');
});

/* ------------------------------------------------------------------------
 * The panel keeps its shape whether or not a bag is open.
 *
 * Reported: the sell buttons are not always there, the ledger is not always
 * there, and on the smallest panel the paper balance is nowhere at all.
 * ---------------------------------------------------------------------- */

function fnOf(name) {
  const at = content.indexOf(`function ${name}(`);
  assert.ok(at !== -1, `${name} must exist`);
  return content.slice(at, content.indexOf('\n  }', at) + 4);
}

test('the position card is no longer torn down when nothing is held', () => {
  const render = fnOf('renderPosition');
  assert.ok(!/els\.position\.textContent = ''/.test(render),
    'clearing the card is what made the sell ladder come and go');
  assert.match(render, /renderEmptyPosition\(\)/, 'it renders an empty card instead');
});

test('an empty card dashes every figure rather than showing zeros', () => {
  // A zero is a measurement — it says the position is worth nothing. There is
  // no position to measure, so the honest mark is an em dash.
  const empty = fnOf('renderEmptyPosition');
  assert.match(empty, /const DASH = '—';/);
  for (const field of ['qty', 'entry', 'value', 'pnl', 'ledIn', 'ledOut', 'ledLeft', 'ledChg']) {
    assert.ok(new RegExp(`${field}\.textContent = DASH`).test(empty),
      `${field} must be dashed, not zeroed`);
  }
});

test('an empty card disables what cannot be done, and keeps it on screen', () => {
  const empty = fnOf('renderEmptyPosition');
  assert.match(empty, /setSellLadderEnabled\(false\)/, 'the ladder goes inert');
  assert.match(empty, /initial\.disabled = true/, 'so does sell-initial');
  assert.match(empty, /ledger\.classList\.remove\('pt-hidden'/, 'the ledger stays visible');
  assert.match(empty, /initial\.classList\.remove\('pt-hidden'/, 'and so does sell-initial');
});

test('a live position re-arms everything the empty state switched off', () => {
  // The card persists now, so a disabled control would otherwise stay
  // disabled after a buy — the ladder would be permanently dead.
  const render = fnOf('renderPosition');
  assert.match(render, /setSellLadderEnabled\(true\)/,
    'the ladder must be re-enabled once something is held');
});

test('direction is colour-coded before it is read', () => {
  assert.match(content, /\.pt-preset \{ color: var\(--pt-green\); \}/, 'buy chips are green');
  assert.match(content, /\.pt-buy \{ color: var\(--pt-green\); \}/, 'so is the BUY button');
  assert.match(content, /\.pt-sell \{ color: var\(--pt-red\); \}/, 'the sell ladder is red');
});

test('each ledger figure gets its own box', () => {
  // Reported as "thrown there" with nothing separating the numbers: at a
  // glance the value of one read as the label of the next.
  assert.match(content, /\.pt-led \{[^}]*border: 1px solid var\(--pt-line\)/,
    'every cell needs its own border, not a shared background');
});

test('the smallest panel still shows the paper balance', () => {
  // #pt-buy-label is where cash on hand lives. Micro hid it with the rest of
  // the buy furniture, so the smallest panel was the one that never showed
  // how much paper SOL you had — on any site.
  const microHides = content.slice(content.indexOf('.pt-box.pt-micro #pt-costs'),
    content.indexOf('.pt-box.pt-micro .pt-xray'));
  assert.ok(!microHides.includes('#pt-buy-label'),
    'micro must not hide the element that carries the balance');
  assert.match(content, /\.pt-box\.pt-micro #pt-buy-label \{/,
    'it is trimmed for the smaller panel instead');
});

test('the compact panels keep the ledger, at fewer columns', () => {
  assert.match(content, /\.pt-box\.pt-micro \.pt-ledger \{ grid-template-columns: repeat\(2, 1fr\)/,
    'four boxes do not fit a micro panel; two do');
});
