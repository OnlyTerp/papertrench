/* Shareable P&L card.
 *
 * The card is the thing people post publicly, so two properties matter more
 * than looks:
 *   1. Its numbers are the engine's numbers — a shared image cannot show a
 *      result the journal does not contain.
 *   2. It always identifies itself as paper. A screenshot of a simulated trade
 *      must never be passable as a real one.
 *
 * These drive the shipped module directly; the canvas painting is exercised
 * through a recording stub so the draw order and the always-on watermark are
 * verified rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PC = require('../pnlcard.js');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/* ---------------- the numbers come from the engine ---------------- */

test('the card reports the same result the engine recorded', () => {
  // Drive a real round through the shipped engine, then card it.
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0, balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: MINT, symbol: 'BONK', site: 'padre', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });

  const round = state.rounds[0];
  const model = PC.cardModel(round);

  // Expectations derived from the round itself, not pasted.
  const expectedMultiple = round.returnedSol / round.investedSol;
  assert.equal(model.multipleText, `${expectedMultiple.toFixed(2)}x`);
  assert.equal(model.pnlPctText, `${round.pnlPct >= 0 ? '+' : ''}${round.pnlPct.toFixed(1)}%`);
  assert.match(model.pnlSolText, /^\+/, 'a winning round must render a signed gain');
  assert.equal(model.symbol, 'BONK');
  assert.equal(model.win, true);
});

test('a losing round renders as a loss, not a win', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: MINT, symbol: 'WIF', priceNative: 0.002, solAmount: 2 });
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.001 });

  const model = PC.cardModel(state.rounds[0]);
  assert.equal(model.win, false);
  assert.equal(model.accent, PC.COLORS.red);
  assert.match(model.pnlSolText, /^-/, 'a loss must not be rendered with a + sign');
  // Halving the position is a 0.50x outcome.
  assert.equal(model.multipleText, '0.50x');
});

test('a card is refused when there is nothing real to show', () => {
  assert.equal(PC.cardModel(null), null);
  assert.equal(PC.cardModel({}), null, 'no basis and no P&L means no card');
  assert.equal(PC.cardModel({ investedSol: 0, pnlSol: 1 }), null,
    'a zero cost basis cannot produce an honest multiple');
});

test('an extreme multiple formats without losing precision', () => {
  const model = PC.cardModel({ symbol: 'X', investedSol: 0.5, returnedSol: 64.2, pnlSol: 63.7, pnlPct: 12740 });
  // Derived: (0.5 + 63.7) / 0.5 = 128.4
  assert.equal(model.multipleText, '128.4x', 'large multiples drop to 1dp so they still fit');
  assert.equal(model.pnlPctText, '+12740.0%');
});

/* ---------------- always identifiable as paper ---------------- */

test('every card carries the PAPER watermark and the PaperTrench mark', () => {
  const model = PC.cardModel({ symbol: 'X', investedSol: 1, returnedSol: 2, pnlSol: 1 });
  assert.equal(model.watermark, 'PAPER');
  assert.equal(model.brand, 'PaperTrench');
});

/**
 * Record every canvas call so the draw itself can be asserted.
 * This is what proves the watermark is painted, not merely present in a model.
 */
function recordingContext() {
  const calls = [];
  const texts = [];
  const handler = {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'texts') return texts;
      if (prop === 'measureText') return (t) => { texts.push(String(t)); return { width: String(t).length * 10 }; };
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'canvas') return { width: PC.WIDTH, height: PC.HEIGHT };
      if (typeof target[prop] === 'function' || !(prop in target)) {
        return (...args) => {
          calls.push({ fn: String(prop), args });
          if (prop === 'fillText' || prop === 'strokeText') texts.push(String(args[0]));
          return undefined;
        };
      }
      return target[prop];
    },
    set() { return true; },
  };
  return new Proxy({}, handler);
}

test('the watermark and brand are actually painted onto the canvas', () => {
  const ctx = recordingContext();
  const model = PC.cardModel({
    symbol: 'BONK', mint: MINT, investedSol: 1, returnedSol: 1.83,
    pnlSol: 0.83, pnlPct: 83.1, heldMs: 300000, closedAt: Date.now(),
  });

  assert.equal(PC.drawCard(ctx, model), true);
  assert.ok(ctx.texts.includes('PAPER'),
    'a shared paper trade must be visibly labelled as paper');
  assert.ok(ctx.texts.includes('PaperTrench'), 'the brand mark must be drawn');
  assert.ok(ctx.texts.some((t) => /not financial advice/i.test(t)),
    'the disclaimer must be drawn, not just documented');
  assert.ok(ctx.texts.includes('BONK'), 'the token must be identified');
  assert.ok(ctx.texts.includes(model.multipleText), 'the hero multiple must be drawn');
});

test('the watermark is drawn even when a custom background is supplied', () => {
  const ctx = recordingContext();
  const model = PC.cardModel({ symbol: 'X', investedSol: 1, returnedSol: 3, pnlSol: 2 });
  const fakeImage = { naturalWidth: 1600, naturalHeight: 900 };

  PC.drawCard(ctx, model, fakeImage);

  assert.ok(ctx.calls.some((c) => c.fn === 'drawImage'),
    'the supplied picture must actually be painted');
  assert.ok(ctx.texts.includes('PAPER'),
    'a background image must never be able to hide the paper label');
});

test('drawing refuses a missing model rather than painting a blank card', () => {
  assert.equal(PC.drawCard(recordingContext(), null), false);
  assert.equal(PC.drawCard(null, { watermark: 'PAPER' }), false);
});

/* ---------------- background fitting ---------------- */

test('a background is cover-fitted and centred, never stretched', () => {
  // A wide image into a 16:9 card: height governs, width overflows evenly.
  const wide = PC.coverRect(3000, 1000, PC.WIDTH, PC.HEIGHT);
  assert.ok(Math.abs(wide.height - PC.HEIGHT) < 1e-6, 'the short axis must fill exactly');
  assert.ok(wide.width > PC.WIDTH, 'the long axis overflows rather than squashing');
  assert.ok(Math.abs(wide.x + wide.width / 2 - PC.WIDTH / 2) < 1e-6, 'overflow is centred');

  // A tall image: width governs instead.
  const tall = PC.coverRect(600, 2000, PC.WIDTH, PC.HEIGHT);
  assert.ok(Math.abs(tall.width - PC.WIDTH) < 1e-6);
  assert.ok(tall.height > PC.HEIGHT);

  // Aspect ratio is preserved in both cases.
  assert.ok(Math.abs((wide.width / wide.height) - 3) < 1e-6);
  assert.ok(Math.abs((tall.width / tall.height) - 0.3) < 1e-6);
});

/* ---------------- formatting helpers ---------------- */

test('prices stay readable across the whole memecoin range', () => {
  // A shared card gets screenshotted and posted, so exponent form ("3.87e-8")
  // is the worst possible rendering. Sub-cent prices use subscript-zero
  // notation instead, matching the overlay and every Solana terminal.
  const tiny = PC.formatPrice(0.0000000387);
  assert.doesNotMatch(tiny, /e[+-]/i, 'a shared card must never post exponent form');
  assert.match(tiny, /^0\.0[₀-₉]/, `expected subscript-zero notation, got "${tiny}"`);

  assert.equal(PC.formatPrice(1.25), '1.25');
  assert.equal(PC.formatPrice(0), '—', 'no price is shown as a dash, never as zero');
  assert.equal(PC.formatPrice(-1), '—');
});

test('market caps on a shared card read as money', () => {
  assert.equal(PC.formatMarketCap(240000), '$240.0K');
  assert.equal(PC.formatMarketCap(255830000), '$255.83M');
  assert.equal(PC.formatMarketCap(0), '—', 'an unknown cap is a dash, never $0');
});

test('hold time is humanised', () => {
  assert.equal(PC.formatHeld(45_000), '45s');
  assert.equal(PC.formatHeld(300_000), '5m 0s');
  assert.equal(PC.formatHeld(3_720_000), '1h 2m');
});

/* ---------------- wiring ---------------- */

test('the dashboard exposes a share action and loads the card module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  assert.match(html, /src="pnlcard\.js"/, 'the module must be loaded');
  assert.match(html, /id="card-canvas"/, 'the composer needs a canvas to paint into');
  assert.match(html, /id="card-file"/, 'the user must be able to choose a picture or GIF');

  const js = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(js, /class="btn-sec share-btn"/, 'each round needs a share action');
  assert.match(js, /function openShareCard/);
  assert.match(js, /accept="image\/\*"/.test(html) ? /./ : /never/, 'the picker accepts images');
});

/* ---------------- fee honesty on the card ---------------- */

test('the card prints the round trip cost when fills recorded fees', () => {
  // A 0.1 SOL buy + full sell with 1% fees each leg: the engine records
  // feeSol on every fill; the card must print the sum, uppercased on the
  // journey line: "INCL 0.003 SOL FEES".
  const settings = Object.assign(E.defaultSettings(), { feeBps: 100, balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: MINT, symbol: 'FEE', site: 'padre', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.003 });
  const round = state.rounds[0];
  const model = PC.cardModel(PC.roundCardSource(round, state.journal));
  assert.ok(model.feesText, 'fees line present when fees were paid');
  // The number is the journal's own sum over the round's fills — derived,
  // never pasted (the house rule).
  const fills = state.journal.filter((t) => round.tradeIds.includes(t.id));
  const sum = fills.reduce((acc, t) => acc + (t.feeSol || 0), 0);
  assert.ok(sum > 0, 'journal carries fees: ' + sum);
  assert.equal(model.feesText, 'incl ' + PC.formatSol(sum) + ' SOL fees',
    'prints the journal sum, formatSol-rounded: ' + model.feesText);
});

test('rounds without fee data stay fee-silent rather than inventing a fee', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0, balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: MINT, symbol: 'NOFEE', site: 'padre', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });
  const model = PC.cardModel(state.rounds[0]);
  assert.equal(model.feesText, '', 'zero fees = no fees line');
});
