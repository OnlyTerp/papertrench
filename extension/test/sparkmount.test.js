'use strict';
// Daily Spark dashboard mount — source-contract tests in the
// trenchgridmount.test.js style: the dashboard page has no DOM harness in
// this suite, so the mount is pinned by contract (nav, section, script
// order, dispatcher, renderer, styles, painter export), while the Spark
// MATH itself is behaviour-tested against the real module in spark.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(EXT, 'dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'dashboard.js'), 'utf8');
const sparkJs = fs.readFileSync(path.join(EXT, 'spark.js'), 'utf8');
const pnlcardJs = fs.readFileSync(path.join(EXT, 'pnlcard.js'), 'utf8');

test('spark is reachable: nav button, section, and script tag exist', () => {
  assert.match(html, /<button data-section="spark">Daily Spark<\/button>/,
    'nav button missing');
  assert.match(html, /<section id="spark" class="section hidden"><\/section>/,
    'section container missing');
  assert.match(html, /<script src="spark\.js"><\/script>/,
    'spark.js not loaded by dashboard.html');
  // spark.js must load BEFORE dashboard.js runs (the mount calls window.PTSpark).
  assert.ok(html.indexOf('<script src="spark.js"></script>') < html.indexOf('<script src="dashboard.js"></script>'),
    'spark.js must load before dashboard.js');
});

test('dashboard dispatches the spark section to renderSpark (live-DOM path)', () => {
  // Spark owns its DOM lifecycle like replay: the early-return path renders
  // into the LIVE section, never a detached staged div.
  assert.match(js, /if \(id === 'spark'\) \{ renderSpark\(el\); return; \}/,
    'spark live-DOM dispatch missing');
  assert.match(js, /function renderSpark\(el\)/,
    'renderSpark not defined');
  assert.match(js, /fetch\(spark\.API \+ '\/api\/spark\/today'/,
    'spark/today fetch missing');
  // The load is BLIND: nothing in the mount fetches the after-T bars.
  assert.ok(!/spark\/grade/.test(js.split('renderSpark')[1] || ''),
    'renderSpark must not fetch the grade endpoint');
});

test('spark.js exports the window API the mount consumes', () => {
  assert.match(sparkJs, /window\.PTSpark = api/, 'window.PTSpark missing');
  assert.match(sparkJs, /sparkModel/, 'sparkModel missing');
  assert.match(sparkJs, /renderSpark/, 'renderSpark missing');
  assert.match(sparkJs, /sparkCardModel/, 'sparkCardModel missing');
  assert.match(sparkJs, /drawChart/, 'drawChart missing');
});

test('pnlcard.js exposes the spark painter (no-PnL card law)', () => {
  assert.match(pnlcardJs, /function sparkCardModel/, 'sparkCardModel missing');
  assert.match(pnlcardJs, /function drawSparkCard/, 'drawSparkCard missing');
  assert.match(pnlcardJs, /sparkCardModel, drawSparkCard/, 'exports missing');
  // The painter must never paint a PnL figure: no usd/sol/roi in the spark
  // painter body.
  const painter = pnlcardJs.slice(pnlcardJs.indexOf('function drawSparkCard'));
  const nextFn = painter.indexOf('\n  /**');
  const body = nextFn > 0 ? painter.slice(0, nextFn) : painter;
  for (const key of ['usd', 'roi', 'pnl', 'profit']) {
    assert.ok(!body.toLowerCase().includes(key), 'spark painter must not paint ' + key);
  }
});

test('spark styles exist in dashboard.html', () => {
  assert.match(html, /\.spark-chart \{/, 'spark chart style missing');
  assert.match(html, /\.spark-grade \{/, 'spark grade style missing');
  assert.match(html, /\.spark-btn \{/, 'spark button style missing');
});