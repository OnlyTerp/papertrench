/* U5 batch (2026-08-22): away32's asks after v3.11.0 —
 *   1. header buttons that jump to TP/SL and market-cap alerts,
 *   2. panel skins that look like the dexes he named (Axiom, Padre),
 * plus the rug-PnL regression (remsonly1/sebaasumana, reviews 8/16:
 * "when you get rugged your PnL turns green and your percentage doubles or
 * triples") — the F-56 fill-honesty fix (v3.10.0) is the root-cause repair;
 * this pins the engine math so a rug can never again print a green round.
 *
 * Source-contract pins: the header controls must exist with honest refusals,
 * the themes must exist with full token sets and dashboard options, and a
 * bought-then-rugged round must close deeply RED.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

/* ---------------- header jump buttons (away32 8/22 02:01) ---------------- */

test('header carries jump buttons for TP/SL and alerts, next to the density toggle', () => {
  assert.ok(content.includes('id="pt-jump-orders"'), '⚑ TP/SL jump button exists');
  assert.ok(content.includes('id="pt-jump-alerts"'), '🔔 alerts jump button exists');
  // "next to the Density button" — the jump buttons sit before ◧ in the header.
  const header = content.slice(
    content.indexOf('id="pt-header"') >= 0 ? content.indexOf('id="pt-header"') : content.indexOf('id="pt-drag"'),
    content.indexOf('id="pt-focus-toggle"')
  );
  assert.ok(header.includes('pt-jump-orders') && header.includes('pt-jump-alerts'),
    'both jump buttons live in the header before the density toggle');
});

test('jump buttons refuse honestly instead of scrolling nowhere', () => {
  // No position → no TP/SL card: the toast says so instead of a dead scroll.
  assert.ok(content.includes("'No open position yet — TP/SL lives on the position card'"),
    'TP/SL jump explains the missing position');
  assert.ok(content.includes("'No token on this page — alerts arm per token'"),
    'alerts jump explains the missing token');
  // TP/SL disabled globally → point at the setting, not a phantom card.
  assert.ok(content.includes("'TP/SL is off — enable chart orders in Settings'"),
    'disabled chart orders get the settings pointer');
});

test('jumpToSection exists, scrolls, pulses once, and never moves the page', () => {
  assert.ok(/function jumpToSection\(/.test(content), 'helper defined');
  assert.ok(content.includes("scrollIntoView({ behavior: 'smooth', block: 'nearest' })"),
    'scrolls inside the panel body only (nearest block, page untouched)');
  assert.ok(content.includes('pt-jump-flash'), 'one-shot flash class applied');
  assert.ok(/setTimeout\(\(\) => target\.classList\.remove\('pt-jump-flash'\), 1400\)/.test(content),
    'flash is removed so repeat jumps can re-pulse');
});

test('micro density keeps the jump buttons at compact size instead of hiding them', () => {
  // away32 asked for these buttons AND lives in micro density — hiding them
  // there would hide them from the requester. They shrink, never vanish.
  assert.ok(content.includes('.pt-box.pt-micro .pt-header #pt-jump-orders'), 'micro rule exists');
  assert.ok(/\.pt-box\.pt-micro \.pt-header #pt-jump-orders,[\s\S]{0,140}?width: 20px; height: 20px; font-size: 11px;/.test(content),
    'micro sizes them to the 20px footprint, not display:none');
  assert.ok(!/\.pt-box\.pt-micro \.pt-header #pt-jump-orders,[\s\S]{0,140}?display: none/.test(content),
    'never hidden at micro');
});

/* ---------------- theme skins: axiom + padre (away32 8/22) ---------------- */

test('Axiom and Padre skins exist with full token sets', () => {
  for (const name of ['axiom', 'padre']) {
    assert.ok(content.includes(`    ${name}: {`), `${name} theme declared`);
    const block = content.slice(content.indexOf(`    ${name}: {`), content.indexOf('label:', content.indexOf(`    ${name}: {`)));
    assert.ok(block.length > 0, `${name} has a label`);
  }
  // Every skin must re-map the tokens that carry the panel's identity —
  // a partial set would render a half-trench, half-axiom chimera.
  const mustTokens = ['--pt-void', '--pt-bg', '--pt-surface', '--pt-raised', '--pt-amber',
    '--pt-green', '--pt-red', '--pt-text', '--pt-dim', '--pt-shell-hi', '--pt-shell-lo', '--pt-rim'];
  for (const name of ['axiom', 'padre']) {
    const start = content.indexOf(`    ${name}: {`);
    const end = content.indexOf('},', content.indexOf('tokens: {', start));
    const block = content.slice(start, end);
    for (const tok of mustTokens) {
      assert.ok(block.includes(`'${tok}'`), `${name} re-maps ${tok}`);
    }
  }
});

test('header theme cycler exists and cycles every skin without desyncing the dashboard setting', () => {
  assert.ok(content.includes('id="pt-theme-toggle"'), '◍ theme button in the header');
  // The cycle covers all five skins, named looks first.
  assert.ok(content.includes("['trench', 'axiom', 'padre', 'lute', 'solana']"),
    'explicit cycle order exists');
  // Cycling persists the SAME preference the dashboard select owns.
  assert.ok(/panelTheme: next/.test(content), 'cycles write settings.panelTheme');
  assert.ok(/applyTheme\(next\)/.test(content), 'cycle applies live');
  // And both new skins are selectable from the dashboard too.
  assert.ok(dashJs.includes('value="axiom"'), 'dashboard offers Axiom');
  assert.ok(dashJs.includes('value="padre"'), 'dashboard offers Padre');
});

test('applyTheme tolerates unknown names by falling back to trench', () => {
  // Pinned from the existing behavior the cycler relies on.
  assert.ok(/const theme = THEMES\[name\] \? name : 'trench';/.test(content),
    'unknown theme names never break the host attribute');
});

test('the panel shell itself is token-driven — skins re-paint the whole panel', () => {
  // The chimera defect this batch fixed: the box body and rim were hardcoded
  // trench gradients; now both read tokens the skins override.
  assert.ok(/linear-gradient\(180deg, var\(--pt-shell-hi\), var\(--pt-shell-lo\)\)/.test(content),
    'box body gradient reads --pt-shell-*');
  assert.ok(/background: var\(--pt-rim\);/.test(content), 'box rim reads --pt-rim');
  for (const name of ['axiom', 'padre']) {
    const start = content.indexOf(`    ${name}: {`);
    const end = content.indexOf('},', content.indexOf('tokens: {', start));
    const block = content.slice(start, end);
    assert.ok(block.includes('--pt-shell-hi') && block.includes('--pt-rim'),
      `${name} re-paints the shell and rim, not just the children`);
  }
});

/* ---------------- rug PnL regression (reviews 8/16) ---------------- */

test('a rug prints a deeply RED round — bought 1 SOL at 100k MC, exited at 2k MC', () => {
  const settings = Object.assign(E.defaultSettings(), { balanceStartSol: 10 });
  const state = E.defaultState(settings);
  // Buy 1 SOL into a coin at price 1e-7 (say 100k MC), then the coin rugs:
  // price collapses 98% to 2e-9. This is the reported scenario ("PnL turns
  // green and your percentage either 2xed or triples on how bad the rug was").
  E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'RugCoin', symbol: 'RUG', site: 'axiom',
    priceNative: 1e-7, solAmount: 1,
  });
  E.sell(state, settings, {
    ts: 1_800_001_200_000, mint: 'RugCoin', qtyFraction: 1,
    priceNative: 2e-9, // −98%: a rug, not a dip
  });
  const round = state.rounds[0];
  assert.ok(round, 'round closed');
  assert.ok(round.pnlSol < -0.9, `a −98% rug must lose almost the whole stake, got ${round.pnlSol.toFixed(4)} SOL`);
  assert.ok(round.pnlPct < -90, `pnlPct must read deeply negative, got ${round.pnlPct.toFixed(2)}%`);
  assert.ok(state.stats.realizedPnlSol < 0, 'session realized PnL is negative after the rug');
  // And the inverse lie is pinned out: pnlPct can never be positive here.
  assert.ok(!(round.pnlPct > 0), 'a rug never prints a positive percentage');
});

test('a rug never flips the SIGN of PnL on partial exits either', () => {
  const settings = Object.assign(E.defaultSettings(), { balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'RugTwo', symbol: 'RG2', site: 'padre',
    priceNative: 5e-8, solAmount: 2,
  });
  // Scale out half on the way down, then the rest at the bottom.
  E.sell(state, settings, { ts: 1_800_000_300_000, mint: 'RugTwo', qtyFraction: 0.5, priceNative: 3e-8 });
  E.sell(state, settings, { ts: 1_800_001_000_000, mint: 'RugTwo', qtyFraction: 1, priceNative: 1e-9 });
  const round = state.rounds[0];
  assert.ok(round.pnlSol < -1.2, `partial-exit rug still loses most of the stake, got ${round.pnlSol.toFixed(4)} SOL`);
  assert.ok(round.pnlPct < -60, `partial-exit rug percentage deeply negative, got ${round.pnlPct.toFixed(2)}%`);
});

test('a WINNER still prints green — the rug pin is not a sign flip for profit', () => {
  const settings = Object.assign(E.defaultSettings(), { balanceStartSol: 10 });
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'Winner', symbol: 'WIN', site: 'lute',
    priceNative: 1e-7, solAmount: 1,
  });
  E.sell(state, settings, {
    ts: 1_800_000_600_000, mint: 'Winner', qtyFraction: 1,
    priceNative: 4e-7, // +300%
  });
  const round = state.rounds[0];
  assert.ok(round.pnlPct > 250, `a 4x exit must print a big WIN, got ${round.pnlPct.toFixed(2)}%`);
  assert.ok(round.pnlSol > 2.5, `profit in SOL matches, got ${round.pnlSol.toFixed(4)}`);
});
