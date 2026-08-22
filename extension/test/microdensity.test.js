'use strict';
/* Micro density (away32 8/21: "very big looks like ai slop… axiom or padre
 * looks perfect") + idle-SOL bar (same user: "overlay sol balance at the top
 * without needing to open the ext"). Locks the shape these must keep. */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const engine = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const E = require(path.join(ROOT, 'engine.js'));

test('micro density: the CSS layer exists and scopes only to .pt-micro', () => {
  assert.match(content, /\.pt-box\.pt-micro \.pt-banner,/, 'banner dies in micro');
  assert.match(content, /\.pt-box\.pt-micro \.pt-micro-wallet/, 'wallet readout styled');
  assert.ok(!/\.pt-micro[^-\w]/.test(content.replace(/pt-micro-wallet/g, '')) === false,
    'micro classes present');
});

test('micro density: the toggle cycles standard → focus → micro → standard', () => {
  // The cycle derivation must read all three states and wrap.
  assert.match(content, /cur === 'standard' \? 'focus' : cur === 'focus' \? 'micro' : 'standard'/,
    'three-state cycle');
  // panelDensity is persisted; standard clears it (undefined key).
  assert.match(content, /panelDensity: next === 'standard' \? undefined : next/,
    'standard clears the density key');
});

test('applyFocusMode rides .pt-micro and keeps focus rules off it', () => {
  assert.match(content, /els\.box\.classList\.toggle\('pt-micro', micro\)/);
  // focus && !micro — micro never wears both density classes at once.
  assert.match(content, /toggle\('pt-focus', focus && !micro\)/);
});

test('micro always shows the idle wallet with locked SOL called out', () => {
  assert.match(content, /function renderMicroWallet/, 'renderer exists');
  assert.match(content, /renderMicroWallet\(\);/, 'in the render cycle');
  assert.match(content, /lockedBuySol\(state\)/, 'locked SOL is computed');
});

test('densityWantsIdleSol: micro always wants the readout', () => {
  assert.equal(E.densityWantsIdleSol({ panelDensity: 'micro' }, null), true);
});

test('densityWantsIdleSol: a factory-fresh wallet in standard stays quiet', () => {
  const fresh = E.defaultState();
  assert.equal(E.densityWantsIdleSol({}, fresh), false,
    'no chrome until there is something to show');
});

test('densityWantsIdleSol: any history keeps the bar alive', () => {
  const s = E.defaultState();
  s.seq = 1;
  assert.equal(E.densityWantsIdleSol({}, s), true, 'seq bump (a fill happened)');
  const s2 = E.defaultState();
  s2.cashSol = s2.startSol - 0.5;
  assert.equal(E.densityWantsIdleSol({}, s2), true, 'cash moved off birth value');
  const s3 = E.defaultState();
  s3.pendingBuys['mintA'] = [{ id: 'pb1', lockedSol: 0.5, triggerPrice: 1, armedAt: Date.now() }];
  assert.equal(E.densityWantsIdleSol({}, s3), true, 'armed limit buy');
});

test('empty bar renders the wallet, not a zero-position count', () => {
  assert.match(content, /barTotalEls\.count\.textContent = 'wallet';/,
    'empty bar says wallet');
  assert.match(content, /◎ idle/, 'idle SOL carries the ◎ glyph');
});

test('micro never hides the sell controls — execution survives every density', () => {
  // The micro CSS hides decoration; the sell row must not be in the hide list.
  const hideBlock = content.match(/\.pt-box\.pt-micro \.pt-banner,([\s\S]*?)display: none;/);
  assert.ok(hideBlock, 'micro hide-list block found');
  assert.ok(!/pt-sell-row button\s*,/.test(hideBlock[1]) && !/\.pt-sell/.test(hideBlock[1]),
    'sell row is not hidden in micro');
  assert.ok(!/pt-presets/.test(hideBlock[1]),
    'buy presets are not hidden in micro');
});
