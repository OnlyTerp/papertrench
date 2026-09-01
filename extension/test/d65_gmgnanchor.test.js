/* D-65: the GMGN axis anchor survived a token SWITCH but not a token being
 * IDENTIFIED — which is the entire life of a fresh launch.
 *
 * Live evidence (Discord 🐛-bug-reports, portifly, after v3.18.0 shipped
 * D-64): "unfortunately I'm still having this problem, even with the new
 * version" … "when I click on a token and buy or sell, no line appears;
 * however, when I open a second tab for the same token, it does appear."
 *
 * That second sentence is the bug. Both GMGN level lanes need
 * gmgnLastCandleClose — the mcap lane scales through it (C-08 gmgnCapScale)
 * and D-64's native lane multiplies by it — and setCurrentSymbolNeedles
 * cleared it whenever the paper-axis needle set "changed". That signal fires
 * for two different events and only one of them is a new token:
 *
 *   a real switch        A -> B, nothing in common. Genuinely stale.
 *   identity sharpening  [PAIR] -> [PAIR, MINT, SYMBOL], as the resolver
 *                        learns what it is looking at. The SAME token.
 *
 * A fresh launch is the second case, repeatedly — it is the coin whose
 * identity resolves last and in pieces (the same property behind F-51's
 * rekey). GMGN fetches its mcap candles once per chart mount, so once the
 * anchor was wiped nothing put it back, and no average line could be
 * computed for the rest of that session. Open the same coin in a NEW tab and
 * the identity is complete before the candles land, so nothing wipes it —
 * which is exactly why the second tab worked, and why the symptom pointed at
 * ordering rather than at the level arithmetic D-64 had just fixed.
 *
 * Clearing on a genuine switch was racy in the other direction too: the new
 * token's candles routinely arrive BEFORE its paper-axis, so the clear
 * destroyed a close that had just been captured for the token being moved to.
 *
 * Fix under test: the close is tagged with the token its own request named
 * (/api/v1/token_mcap_candles/<chain>/<address>) and staleness is judged at
 * USE time. Ordering stops mattering because the data carries its subject.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

/** The body of a named function declaration, to its closing brace column. */
function bodyOf(name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'function must exist: ' + name);
  const end = src.indexOf('\n  }', at);
  assert.ok(end > at, 'function must close: ' + name);
  return src.slice(at, end);
}

test('D-65/1: the needle path no longer clears the anchor', () => {
  const body = bodyOf('setCurrentSymbolNeedles');
  assert.doesNotMatch(body, /gmgnLastCandleClose\s*=\s*0/,
    'clearing here is what wiped the anchor every time a fresh launch\'s '
    + 'identity sharpened — and GMGN never re-fetches its candles to restore it');
  // The rest of the per-token reset is still correct and must stay: those
  // are export-dedupe state (F-19), not axis evidence.
  assert.match(body, /lastBarClose = 0/, 'F-19 bar dedupe reset must survive');
  assert.match(body, /barCloseLedger\.clear\(\)/, 'the bar ledger reset must survive');
});

test('D-65/2: the close is tagged with the token its request named', () => {
  assert.match(src, /let gmgnLastCandleCloseKey = null;/,
    'the anchor needs a subject to be judged against');
  assert.match(src, /\/\\\/token_mcap_candles\\\/\[\^\/\?#\]\+\\\/\(\[\^\/\?#\]\+\)\//,
    'the key must be parsed from the candle request URL');
  // Captured in the same branch that captures the close, so the two can
  // never disagree about which token they describe.
  const at = src.indexOf('gmgnLastCandleClose = mcap;');
  assert.ok(at > 0, 'the capture site must exist');
  assert.match(src.slice(at, at + 400), /gmgnLastCandleCloseKey =/,
    'key and close must be captured together');
});

test('D-65/3: every level lane reads the guarded accessor, not the raw close', () => {
  assert.match(src, /function gmgnAxisAnchor\(\)/, 'the accessor must exist');
  for (const fn of ['gmgnCapScale', 'gmgnMarkerLevel', 'gmgnLineLevel']) {
    const body = bodyOf(fn);
    assert.match(body, /gmgnAxisAnchor\(\)/, fn + ' must read the accessor');
    assert.doesNotMatch(body, /gmgnLastCandleClose(?!Key)/,
      fn + ' must not read the raw close — that is how another coin\'s anchor '
      + 'would price this coin\'s line');
  }
});

test('D-65/4: the accessor refuses an anchor belonging to a different token', () => {
  const body = bodyOf('gmgnAxisAnchor');
  // No identity yet is the ordinary state while a fresh launch is still
  // being resolved; the close must be usable then, or the fix would
  // reintroduce the very gap it exists to close.
  assert.match(body, /if \(!addrs\.length\) return gmgnLastCandleClose;/,
    'an unidentified token must still be able to use its own anchor');
  // Symbols are not identity: a short ticker can appear inside an unrelated
  // base58 address, and matching on it would accept a foreign anchor.
  assert.match(body, /currentSymbolInfo\.pairAddress, currentSymbolInfo\.mint/,
    'only address needles may decide ownership');
  assert.doesNotMatch(body, /currentSymbolNeedles/,
    'the needle list carries the symbol too — it must not be used here');
  assert.match(body, /indexOf\(gmgnLastCandleCloseKey\) >= 0 \? gmgnLastCandleClose : 0/,
    'a non-matching key must yield no anchor at all');
});

test('D-65/5: the URL parser reads the address out of real GMGN candle requests', () => {
  // Exercised against the exact URLs the production interceptor sees, and
  // the ones the existing nativecharts fixtures inject.
  const re = /\/token_mcap_candles\/[^/?#]+\/([^/?#]+)/;
  assert.equal(re.exec('https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1')[1], 'Mint1');
  assert.equal(
    re.exec('https://gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1m&limit=500')[1],
    'Mint1', 'the query string must not be swallowed into the address');
  assert.equal(re.exec('https://gmgn.ai/api/v1/token_mcap_candles/base/AbC123#frag')[1], 'AbC123');
  // A shape we do not recognise leaves the key null, and the accessor then
  // trusts the close — deliberately the pre-D-65 behaviour rather than a
  // regression into drawing nothing.
  assert.equal(re.exec('https://gmgn.ai/api/v1/token_mcap_candles/'), null);
});
