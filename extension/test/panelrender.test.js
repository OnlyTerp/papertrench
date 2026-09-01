'use strict';
// Side-panel desk (DELIGHT-MAP.md D1) — RENDER contract.
//
// sidepanel.test.js pins the wiring (manifest, script tags, storage reads)
// and paneldata.test.js pins the pure assembly. Neither ever ran a render
// helper over a populated desk, and that gap is exactly what shipped:
//
//   activeHtml called `fmtSol(...)` bare, and afterHtml called `P.fmtSol(...)`
//   — neither identifier existed in panel.js, because panel-data.js exports
//   onto window.PTPanel. Both threw ReferenceError, so the desk rendered only
//   while it was EMPTY. The first open position, or the first closed round
//   carrying an after-watch, took render() down.
//
// The empty desk was the only working state, which is why it looked fine in
// screenshots and broke the moment anyone traded. These tests execute the
// helpers over real data, so a formatter that is not in scope fails here
// rather than in a docked panel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const panelJs = fs.readFileSync(path.join(EXT, 'panel.js'), 'utf8');
const PTPanel = require(path.join(EXT, 'panel-data.js'));

/**
 * Evaluate panel.js's render helpers in the scope panel.js gives them.
 *
 * Only the module's own declarations plus the `window` globals are in
 * scope — deliberately no `fmtSol`, no ambient `P`. Anything the helpers
 * reach for that the real page would not have is a ReferenceError here,
 * which is the whole point of the harness.
 */
function loadHelpers() {
  const names = ['fmtAgo', 'fmtHeld', 'esc', 'chipHtml', 'activeHtml', 'afterHtml'];
  const consts = [];
  // Hoist the module-level const declarations the helpers close over.
  for (const decl of ['P', 'MARK_REST', 'MARK_AFTER']) {
    const re = new RegExp('^const ' + decl + ' =[\\s\\S]*?;$', 'm');
    const m = panelJs.match(re);
    if (m) consts.push(m[0]);
  }
  const bodies = names.map((n) => {
    const start = panelJs.indexOf('function ' + n + '(');
    if (start < 0) {
      const arrow = panelJs.match(new RegExp('^const ' + n + ' =[\\s\\S]*?\\);$', 'm'));
      if (arrow) return arrow[0];
      throw new Error('helper not found in panel.js: ' + n);
    }
    let depth = 0;
    let i = panelJs.indexOf('{', start);
    for (; i < panelJs.length; i++) {
      if (panelJs[i] === '{') depth++;
      else if (panelJs[i] === '}') { depth--; if (depth === 0) break; }
    }
    return panelJs.slice(start, i + 1);
  });
  const src = `'use strict';\n${consts.join('\n')}\n${bodies.join('\n')}\nreturn { ${names.join(', ')} };`;
  return new Function('window', src)({ PTPanel, PTGamify: { STREAK_TIERS: [] } });
}

test('the active-round card renders with an open position (regression: fmtSol undefined)', () => {
  const H = loadHelpers();
  const html = H.activeHtml({
    symbol: 'WIF', costSol: 1.25, heldMs: 5400000, thesisMissing: false,
  });
  assert.match(html, /WIF/);
  assert.match(html, /\+1\.25 SOL/, 'open cost must render through the shared SOL formatter');
  assert.doesNotMatch(html, /undefined|NaN/, 'a formatter out of scope leaks as undefined/NaN');
});

test('the After feed renders rows (regression: bare P.fmtSol threw)', () => {
  const H = loadHelpers();
  const html = H.afterHtml([
    { symbol: 'BONK', closedAt: Date.now() - 3600000, pnlSol: 0.42, maxPct: 63 },
    { symbol: 'MEW', closedAt: Date.now() - 7200000, pnlSol: -0.19, maxPct: 4 },
  ]);
  assert.match(html, /BONK/);
  assert.match(html, /\+0\.42 SOL/);
  assert.match(html, /-0\.19 SOL/);
  assert.match(html, /ran \+63% after you left/, 'a >=20% runner is called out');
  assert.match(html, /didn't run \(\+4% max\)/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('held time reads as a duration, never as a SOL amount', () => {
  const H = loadHelpers();
  assert.equal(H.fmtHeld(5400000), '1h 30m');
  assert.equal(H.fmtHeld(180000), '3m');
  assert.equal(H.fmtHeld(1000), 'just opened');
  assert.equal(H.fmtHeld(2 * 86400000 + 3 * 3600000), '2d 3h');
  // The shipped bug: a duration pushed through the SOL formatter.
  const wrong = PTPanel.fmtSol(5400000).replace(' SOL', '');
  assert.notEqual(H.fmtHeld(5400000), wrong);
  assert.doesNotMatch(H.activeHtml({ symbol: 'X', costSol: 1, heldMs: 5400000 }), /5400000/);
});

test('both empty states are rendered states, not bare text', () => {
  const H = loadHelpers();
  const active = H.activeHtml(null);
  const after = H.afterHtml([]);
  for (const html of [active, after]) {
    assert.match(html, /class="empty"/, 'empty states carry the designed container');
    assert.match(html, /<svg/, 'and a mark, so the panel does not read as failed to load');
  }
  assert.match(active, /No open position/);
  assert.match(after, /Nothing yet/);
});

test('a zero streak is not dressed as an achievement', () => {
  const H = loadHelpers();
  const zero = H.chipHtml('journal', { current: 0, best: 0 }, null);
  const live = H.chipHtml('journal', { current: 4, best: 9 }, 'Sharp');
  assert.doesNotMatch(zero, /class="streak on"/, 'an untraded desk must not glow');
  assert.match(live, /class="streak on"/);
  assert.match(live, /best 9/);
  assert.match(live, /Sharp/);
});

test('untrusted state cannot inject markup through the desk', () => {
  const H = loadHelpers();
  const html = H.activeHtml({ symbol: '<img src=x onerror=alert(1)>', costSol: 1, heldMs: 60000 });
  assert.doesNotMatch(html, /<img/, 'a token symbol is data, not markup');
  assert.match(html, /&lt;img/);
  const feed = H.afterHtml([
    { symbol: '<script>alert(1)</script>', closedAt: Date.now(), pnlSol: 0, maxPct: 0 },
  ]);
  assert.doesNotMatch(feed, /<script>alert/);
});

test('panel.js resolves the pure module once, rather than assuming a global', () => {
  assert.match(panelJs, /const P = window\.PTPanel;/,
    'the formatter must be bound from the module that exports it');
  // Comments describe the bug and name the old call, so this reads CODE only.
  const code = panelJs
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /[^.\w]fmtSol\(/,
    'no bare fmtSol — panel-data.js exports it on PTPanel, not as a global');
});
