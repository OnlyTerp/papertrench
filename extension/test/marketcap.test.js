/* Market cap is the unit traders actually use.
 *
 * Nobody says "I bought at 0.0₇3969" — they say "I bought at 240K". Unit price
 * for a memecoin is an unreadable artifact of supply, so market cap is the
 * headline figure everywhere a level is shown, with price only as a fallback
 * when no cap is known.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function loadQuote() {
  const win = {};
  win.window = win;
  const ctx = vm.createContext({
    window: win, self: win,
    Math, Number, String, Array, Object, Boolean, JSON, Date,
    isFinite, isNaN, parseInt, parseFloat,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8'), ctx, {
    filename: 'quote.js',
  });
  return win.PaperQuote;
}

function loadCard() {
  const win = {};
  win.window = win;
  const ctx = vm.createContext({
    window: win, self: win,
    Math, Number, String, Array, Object, Boolean, JSON, Date,
    isFinite, isNaN, parseInt, parseFloat,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'pnlcard.js'), 'utf8'), ctx, {
    filename: 'pnlcard.js',
  });
  return win.PTPnlCard;
}

/* Real BONK figures: ~0.00000003969 SOL, ~$255.8M cap. */
const LIVE_TOKEN = {
  mint: BONK,
  symbol: 'Bonk',
  priceNative: 0.00000003969,
  priceUsd: 0.0000029,
  mcap: 255830000,
};

test('the headline figure is the market cap, not the unit price', () => {
  const Q = loadQuote();
  const header = Q.headerFields(LIVE_TOKEN);

  assert.equal(header.priceText, '$255.83M',
    `the headline must be the market cap; got "${header.priceText}"`);
  assert.equal(header.priceIsMarketCap, true);
  assert.doesNotMatch(header.priceText, /SOL/,
    'a raw SOL unit price must not be the headline figure');
});

test('a token with no known market cap still shows a usable price', () => {
  const Q = loadQuote();
  const header = Q.headerFields({ ...LIVE_TOKEN, mcap: null });

  assert.equal(header.priceIsMarketCap, false);
  assert.match(header.priceText, /SOL$/,
    'without a cap the SOL price is the honest fallback');
  assert.doesNotMatch(header.priceText, /e[+-]/i,
    'the fallback price must still be readable');
});

test('a pending token still reports plainly instead of showing a number', () => {
  const Q = loadQuote();
  const now = Date.now();
  const header = Q.headerFields(
    { mint: BONK, symbol: 'Bonk', priceNative: null, mcap: null },
    { now, pendingSince: now - 4000 }
  );

  assert.equal(header.pending, true);
  assert.doesNotMatch(header.priceText, /\d/,
    'a pending header must never show a fabricated number');
});

test('the market cap headline never renders as scientific notation', () => {
  const Q = loadQuote();
  for (const mcap of [842, 45600, 255830000, 1234000000]) {
    const header = Q.headerFields({ ...LIVE_TOKEN, mcap });
    assert.doesNotMatch(header.priceText, /e[+-]/i,
      `market cap ${mcap} leaked scientific notation`);
    assert.match(header.priceText, /^\$/, 'a market cap reads as money');
  }
});

/* ---------------- overlay wiring ---------------- */

test('the overlay derives an entry market cap rather than showing a raw price', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  assert.match(src, /function mcapAtPrice/,
    'the overlay must be able to express any fill price as a market cap');
  assert.match(src, /posEls\.entry\.textContent = entryText\(/,
    'the position card must show the entry as a market cap');
  assert.doesNotMatch(src, /posEls\.entry\.textContent = `\$\{trimSci/,
    'the raw SOL entry price must no longer be the entry figure');
});

test('a fill confirmation states the market cap it filled at', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  // The buy toast reports the amount in the currency the trader ordered in
  // (dollars on a foreign-chain panel, SOL otherwise) AND the cap it
  // filled at.
  // D-41: the toast falls back to the short mint for a symbol-less new
  // launch (the sym line above the template), so the lock matches the
  // template itself, which still leads with the amount + cap.
  assert.match(src, /Bought \$\{boughtText\} of \$\{sym\}\$\{atMcap/,
    'a buy toast must report the market cap it filled at');
  assert.match(src, /: `\$\{E\.fmt\(solAmount, 3\)\} SOL`/,
    'SOL panels keep the SOL amount in the confirmation');
  assert.match(src, /exitMcap \? ` at \$\{fmtMoney\(exitMcap\)\} MC` : ''/,
    'a sell toast must report the market cap it exited at');
});

/* ---------------- chart labels ---------------- */

test('chart markers and average lines are labelled in market cap', () => {
  const markers = fs.readFileSync(path.join(ROOT, 'chart-markers.js'), 'utf8');
  assert.match(markers, /currency === 'MCAP'/,
    'the chart must be able to render a value as a market cap');

  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /PT Avg Buy \$\{Q\.formatMarketCap/,
    "GMGN's average buy line must be labelled with its market cap");
  assert.match(content, /currency: supply \? 'MCAP' : 'USD'/,
    'generic chart average lines must label in market cap when supply is known');
});

test('a marker carries the market cap of its fill for the hover detail', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(src, /return \{ plot, display: chartMcap, currency: 'MCAP' \}/,
    'the hover figure must be the market cap of that fill');
});

/* ---------------- shared card ---------------- */

test('a shared card shows entry and exit as market caps', () => {
  const PC = loadCard();
  const model = PC.cardModel({
    symbol: 'BONK',
    mint: BONK,
    investedSol: 1,
    returnedSol: 3,
    pnlSol: 2,
    pnlPct: 200,
    heldMs: 480000,
    entryMcap: 240000,
    exitMcap: 900000,
    entryPrice: 0.00000003969,
    exitPrice: 0.00000014,
  }, {});

  assert.equal(model.entryText, '$240.0K');
  assert.equal(model.exitText, '$900.0K');
});

test('a card falls back to a readable price when no cap was recorded', () => {
  const PC = loadCard();
  const model = PC.cardModel({
    symbol: 'BONK', mint: BONK,
    investedSol: 1, returnedSol: 2, pnlSol: 1, pnlPct: 100, heldMs: 60000,
    entryPrice: 0.00000003969,
    exitPrice: 0.00000007938,
  }, {});

  assert.doesNotMatch(model.entryText, /e[+-]/i,
    'a shared card must never post scientific notation');
  assert.match(model.entryText, /^0\.0[₀-₉]/,
    `expected subscript-zero notation, got "${model.entryText}"`);
});

/* ---------------- dashboard ---------------- */

test('the dashboard reports fills by market cap under a matching header', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  assert.match(src, /function fillLevel/,
    'the dashboard needs one shared way to describe a fill level');
  assert.match(src, /<th class="num">Market cap<\/th>/,
    'the trade history column must be labelled Market cap');
  assert.doesNotMatch(src, /\$\{fmt\(t\.priceNative, 8\)\}/,
    'the raw unit price column must be gone');
  assert.doesNotMatch(src, /fmt\(event\.trade\.priceNative, 9\)/,
    'replay events must describe fills by market cap too');
});
