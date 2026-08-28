'use strict';
// Trench Wrapped dashboard mount — source-contract tests in the
// trenchgridmount.test.js style: the dashboard page has no DOM harness in
// this suite, so the mount is pinned by contract (nav, section, script
// order, dispatcher, renderer, styles, painter export), while the Wrapped
// MATH itself is behaviour-tested against the real module in wrapped.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(EXT, 'dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'dashboard.js'), 'utf8');
const wrappedJs = fs.readFileSync(path.join(EXT, 'wrapped.js'), 'utf8');
const pnlcardJs = fs.readFileSync(path.join(EXT, 'pnlcard.js'), 'utf8');

test('wrapped is reachable: nav button, section, and script tag exist', () => {
  assert.match(html, /<button data-section="wrapped">Wrapped<\/button>/,
    'nav button missing');
  assert.match(html, /<section id="wrapped" class="section hidden"><\/section>/,
    'section container missing');
  assert.match(html, /<script src="wrapped\.js"><\/script>/,
    'wrapped.js not loaded by dashboard.html');
  // wrapped.js must load BEFORE dashboard.js runs (the mount calls window.PTWrapped).
  assert.ok(html.indexOf('<script src="wrapped.js"></script>') < html.indexOf('<script src="dashboard.js"></script>'),
    'wrapped.js must load before dashboard.js');
});

test('dashboard dispatches the wrapped section to renderWrapped (sync staged path)', () => {
  assert.match(js, /else if \(id === 'wrapped'\) renderWrapped\(staged\);/,
    'section dispatcher missing');
  assert.match(js, /function renderWrapped\(el\)/,
    'renderWrapped not defined');
  assert.match(js, /wrapped\.derive\(state, window\.PTGamify\)/,
    'renderWrapped must derive from local state (no fetch)');
  // The recap is local: NO network call in renderWrapped (slice to the next
  // function boundary so trailing code can't leak in).
  const start = js.indexOf('function renderWrapped');
  const end = js.indexOf('\nfunction ', start + 1);
  const fn = js.slice(start, end > start ? end : start + 2000);
  assert.ok(!/fetch\(/.test(fn), 'renderWrapped must not fetch');
  // The share button is wired to the painter.
  assert.match(js, /wrappedCardModel\(m/, 'share card model missing');
  assert.match(js, /drawWrappedCard\(card\)/, 'share painter call missing');
});

test('wrapped.js exports the window API the mount consumes', () => {
  assert.match(wrappedJs, /window\.PTWrapped = api/, 'window.PTWrapped missing');
  assert.match(wrappedJs, /derive/, 'derive missing');
  assert.match(wrappedJs, /fmtDuration/, 'fmtDuration missing');
  assert.match(wrappedJs, /gradeRank/, 'gradeRank missing');
});

test('pnlcard.js exposes the wrapped painter (no-PnL card law)', () => {
  assert.match(pnlcardJs, /function wrappedCardModel/, 'wrappedCardModel missing');
  assert.match(pnlcardJs, /function drawWrappedCard/, 'drawWrappedCard missing');
  assert.match(pnlcardJs, /wrappedCardModel, drawWrappedCard/, 'exports missing');
  // The painter must never paint a PnL figure: no usd/sol/roi/pnl in the
  // wrapped painter body.
  const painter = pnlcardJs.slice(pnlcardJs.indexOf('function drawWrappedCard'));
  const nextFn = painter.indexOf('\n  /**');
  const body = nextFn > 0 ? painter.slice(0, nextFn) : painter;
  for (const key of ['usd', 'roi', 'pnl', 'profit']) {
    assert.ok(!body.toLowerCase().includes(key), 'wrapped painter must not paint ' + key);
  }
});

test('wrapped styles exist in dashboard.html', () => {
  assert.match(html, /\.wr-letter \{/, 'wrapped letter style missing');
  assert.match(html, /\.wr-stats \{/, 'wrapped stats style missing');
  assert.match(html, /\.wr-stat \{/, 'wrapped stat card style missing');
});