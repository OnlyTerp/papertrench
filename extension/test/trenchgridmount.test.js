'use strict';
// Trench Grid dashboard mount — source-contract tests in the
// dashboardfixes.test.js style: the dashboard page has no DOM harness in
// this suite, so the mount is pinned by contract (nav, section, script,
// SECTIONS, rebind, renderer, CSS), while the grid MATH itself is
// behaviour-tested against the real modules in trenchgrid.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(EXT, 'dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'dashboard.js'), 'utf8');
const gridJs = fs.readFileSync(path.join(EXT, 'trench-grid.js'), 'utf8');

test('grid is reachable: nav button, section, and script tag exist', () => {
  assert.match(html, /<button data-section="grid">Trench Grid<\/button>/,
    'nav button missing');
  assert.match(html, /<section id="grid" class="section hidden"><\/section>/,
    'section container missing');
  assert.match(html, /<script src="trench-grid\.js"><\/script>/,
    'trench-grid.js not loaded by dashboard.html');
  // Script must load BEFORE dashboard.js uses it.
  assert.ok(
    html.indexOf('trench-grid.js') < html.indexOf('dashboard.js'),
    'trench-grid.js must load before dashboard.js');
});

test('grid is wired: SECTIONS entry, rebind branch, renderer defined', () => {
  assert.match(js, /'overview', 'game', 'calendar', 'grid',/,
    "SECTIONS must include 'grid' or the nav button 404s the section switch");
  assert.match(js, /else if \(id === 'grid'\) renderTrenchGrid\(staged\);/,
    'rebind branch missing');
  assert.match(js, /function renderTrenchGrid\(/, 'renderer missing');
});

test('grid renderer drives the REAL PTGrid.derive, not a re-implementation', () => {
  const m = js.match(/function renderTrenchGrid\([\s\S]*?\n\}/);
  assert.ok(m, 'renderer body not found');
  assert.match(m[0], /= window\.PTGrid;/, 'must alias the real PTGrid module');
  assert.match(m[0], /\.derive\(state/, 'must derive through PTGrid, not inline math');
  assert.match(m[0], /PTGamify/, 'streak chip must ride PTGamify tiers');
  assert.doesNotMatch(m[0], /\.pnlSol|pnlPct|returnedSol/,
    'renderer must not read P&L fields — grade-of-process only (A1 law)');
});

test('grid palette classes exist in dashboard CSS', () => {
  for (const cls of ['.tg-cell', '.tg-empty', '.tg-s', '.tg-a', '.tg-b',
    '.tg-c', '.tg-d', '.tg-f', '.tg-legend', '.tg-streaks']) {
    assert.ok(html.includes(cls), `CSS missing ${cls}`);
  }
});

test('trench-grid module triple-registers like the other PT* modules', () => {
  assert.match(gridJs, /window\.PTGrid = api/);
  assert.match(gridJs, /module\.exports = api/);
});
