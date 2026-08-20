/* ark_trades13 (Discord, 2026-08-20): "can you get your total amount of SOL
 * … on the display overlay?" The equity hero has always shown cash+positions
 * as one number; the ask was seeing WHERE it sits. The tiles now carry the
 * split: Cash ◎ and In positions, beside the position count.
 *
 * overlay.js is DOM-bound at top level (runs document.querySelectorAll on
 * load), so this suite locks the wiring structurally — the same discipline
 * as the F-54 structural test — plus the one arithmetic invariant that
 * matters: the tile split must re-sum to the equity hero's number, which
 * holds because both use the same open-value formula.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'overlay.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'overlay.js'), 'utf8');

test('overlay: cash and open-value tiles exist in both layouts', () => {
  assert.match(html, /id="cash"/, 'a Cash tile must exist');
  assert.match(html, /id="openval"/, 'an In-positions tile must exist');
  assert.match(html, /id="open"/, 'the position-count tile must remain');

  // Six tiles in a 3-column grid (was four in 4 columns) — in BOTH the
  // card layout and the bar override. A 3x2 grid at 384px keeps every
  // nowrap label clear of its neighbours.
  assert.doesNotMatch(html, /repeat\(4, 1fr\)/,
    'the card grid must be 3 columns, not 4');
  assert.match(html, /repeat\(3, 1fr\)/, 'card layout: 3 columns');
  assert.match(html, /repeat\(3, auto\)/, 'bar layout: 3 columns');
});

test('overlay: the render populates the split from the same numbers', () => {
  // render() fills both new tiles…
  assert.match(js, /\$\('cash'\)\.textContent = fmt\(state\.cashSol \|\| 0, 2\)/,
    'cash tile must read state.cashSol');
  assert.match(js, /\$\('openval'\)\.textContent = fmt\(openValue, 2\)/,
    'open-value tile must read the summed open value');

  // …using the SAME open-value formula computeStats uses for the equity
  // hero, so cash + in-positions can never disagree with the hero number.
  const formula = '(s, p) => s + (p.qty || 0) * (p.lastPriceNative || 0), 0';
  const uses = js.split(formula).length - 1;
  assert.ok(uses >= 2,
    `the open-value formula must be identical in computeStats and render (found ${uses})`);
});

test('overlay: equity hero stays the sum the split re-adds to', () => {
  // computeStats derives equity as cash + open value; the invariant the
  // tiles rely on. (Exact-formula check, not arithmetic reinvention.)
  assert.match(js, /const equity = \(state\.cashSol \|\| 0\) \+ openValue/,
    'equity must be cash + open value');
});
