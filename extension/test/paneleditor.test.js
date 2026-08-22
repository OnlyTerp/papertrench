/* Inline preset editor + compact focus mode (lev, round two).
 *
 * "when i asked for this i didn't mean these to be added in the extension
 * but in the trading tab itself" — so the pencil lives on the PANEL header,
 * the cost strip (fee/gas/tip/slip) sits under the buy presets like the
 * terminals' own widgets, and focus mode drops the balance card and the big
 * BUY button ("the less information in the tab the better" — with one-tap
 * presets the chips ARE the buttons; Enter in the amount box buys).
 *
 * Invariants pinned:
 *   1. One rulebook: the panel editor validates through Q.parsePresetList —
 *      the same bounds the dashboard form and popup enforce.
 *   2. Non-destructive writes: the editor patches over live settings and
 *      persists via the standard store.set path.
 *   3. The sell row rebuilds immediately after a save (it is built into the
 *      position card at mount).
 *   4. Focus mode hides the big BUY only while instant one-tap buying is on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Q = require('../quote.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- the shared parser ---------------- */

test('parsePresetList: dashboard rules, one implementation', () => {
  const ok = Q.parsePresetList('0.1, 0.5, 1, 2', 1000);
  assert.deepEqual(ok.values, [0.1, 0.5, 1, 2]);
  assert.equal(ok.dropped, 0);

  const bounded = Q.parsePresetList('0, -1, 2000, 5', 1000);
  assert.deepEqual(bounded.values, [5], 'entries must be > 0 and ≤ max');
  assert.equal(bounded.dropped, 3, 'the caller can SAY how many were rejected');

  const dedupe = Q.parsePresetList('25, 50, 50, 100', 100, { dedupe: true });
  assert.deepEqual(dedupe.values, [25, 50, 100]);

  const capped = Q.parsePresetList('1,2,3,4,5,6,7,8,9,10', 1000);
  assert.equal(capped.values.length, 8, 'max 8 — presets are buttons');

  assert.equal(Q.parsePresetList('', 1000), null, 'empty field means "keep the saved list"');
  assert.equal(Q.parsePresetList('  ', 1000), null);
});

/* ---------------- panel wiring pins ---------------- */

test('the pencil, cost strip and editor live in the panel template', () => {
  const src = read('content.js');
  assert.match(src, /id="pt-edit" title="Edit presets/, 'the ✎ button is on the panel header');
  assert.match(src, /id="pt-costs"/, 'the cost strip renders in the panel body');
  assert.match(src, /id="pt-editor"/, 'the inline editor block exists');
  for (const id of ['pt-edit-buy', 'pt-edit-sell', 'pt-edit-fee', 'pt-edit-gas', 'pt-edit-tip', 'pt-edit-slip']) {
    assert.match(src, new RegExp(`id="${id}"`), `editor field #${id}`);
  }
});

test('the editor validates through the shared parser and persists via store.set', () => {
  const src = read('content.js');
  const fnAt = src.indexOf('async function savePresetEditor(');
  assert.ok(fnAt !== -1);
  const block = src.slice(fnAt, src.indexOf('\n  }', fnAt) + 4);
  // Currency-aware bound: SOL rows keep the dashboard's 1000 cap; dollar
  // rows (foreign-chain panels) allow the venue's own $100k scale. Both go
  // through the ONE shared parser.
  assert.match(block, /const buyCap = usdMode \? 100000 : 1000;/,
    'the buy bound follows the panel currency');
  assert.match(block, /Q\.parsePresetList\(els\.editBuy\.value, buyCap\)/,
    'buy presets go through the ONE parser, same bound family as the dashboard');
  assert.match(block, /patch\[usdMode \? 'presetsBuyUsd' : 'presetsBuy'\] = buy\.values;/,
    'each currency saves to its own key — a chain switch never rewrites the other list');
  assert.match(block, /Q\.parsePresetList\(els\.editSell\.value, 100, \{ dedupe: true \}\)/,
    'sell percents: bounded at 100, deduplicated');
  assert.match(block, /settings = \{ \.\.\.settings, \.\.\.patch \}/,
    'the write patches over live settings — foreign keys survive');
  assert.match(block, /store\.set\(\{ \[E\.STORAGE_KEYS\.settings\]: settings \}\)/,
    'persisted through the standard settings write');
  // Costs mirror the dashboard bounds (D-11/D-23), entered as %.
  assert.match(block, /Math\.min\(1000, Math\.max\(0, Math\.round\(feePct \* 100\)\)\)/);
  assert.match(block, /Math\.min\(2000, Math\.max\(0, Math\.round\(slipPct \* 100\)\)\)/);
  assert.match(block, /Math\.min\(gas, 0\.5\)/);
  // The sell row is mounted with the position card: a save must rebuild it.
  assert.match(block, /posEls = null/, 'sell percents must appear without a token switch');
});

test('compact focus mode: balance card and big BUY go; Enter still buys', () => {
  const src = read('content.js');
  // Wave 2: the balance card no longer exists in ANY mode — cash rides the
  // Buy label everywhere, so there is nothing left for focus to hide.
  assert.doesNotMatch(src, /pt-balance/,
    'the balance card is decoration in focus — cash rides on the Buy label');
  assert.match(src, /\.pt-box\.pt-focus\.pt-focus-instant \.pt-buy \{ display: none; \}/,
    'the big BUY hides ONLY under one-tap presets (chips are the buttons)');
  assert.match(src, /pt-focus-instant', focus && !micro && settings\.instantBuyEnabled !== false/,
    'with instant buy off the button must stay — select-then-buy needs a trigger (micro hides it via CSS, chips only)');
  assert.match(src, /event\.key === 'Enter'\) els\.btnBuy\.click\(\)/,
    'Enter in the amount box buys — the hidden button still owns the flow');
  const labelFn = src.slice(src.indexOf('function buyLabelText('), src.indexOf('\n  }', src.indexOf('function buyLabelText(')));
  // Wave 2: the cash line is the label in EVERY mode now, not a focus swap.
  assert.doesNotMatch(labelFn, /panelFocusMode/, 'no mode branch — one label, always with cash');
  assert.match(labelFn, /cash/, 'cash on hand is execution info, not decoration');
});

test('the cost strip states fee, gas, tip and slippage — honest costs at a glance', () => {
  const src = read('content.js');
  const fnAt = src.indexOf('function renderCosts(');
  const block = src.slice(fnAt, src.indexOf('\n  }', fnAt) + 4);
  for (const chip of ['Fee ', 'Gas ', 'Tip ', 'Slip ']) {
    assert.ok(block.includes('`' + chip) , `cost strip must show ${chip.trim()}`);
  }
  assert.match(block, /feeBps\) \|\| 0\) \/ 100/, 'fees display as the % the site UIs show');
});
