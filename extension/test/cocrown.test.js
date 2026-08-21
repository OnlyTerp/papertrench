/* Discipline co-crown KPI (ROADMAP item 4, local half) — source-contract
 * tests. The doctrine: PnL is never the only crown. The KPI row shows the
 * discipline grade (lifetime process average) right next to Realized P&L,
 * same visual weight, never replacing it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = source('node:fs');

function source(m) { return require(m); }

const dash = fs.readFileSync(require('node:path').join(__dirname, '..', 'dashboard.js'), 'utf8');

test('kpi row renders the discipline co-crown next to realized PnL', () => {
  assert.ok(dash.includes('Discipline (co-crown)'), 'co-crown KPI present');
  assert.ok(dash.includes('data-discipline-grade'), 'data hook present');
  const pni = dash.indexOf('Realized P&amp;L');
  const dci = dash.indexOf('Discipline (co-crown)');
  assert.ok(pni > -1 && dci > pni, 'discipline KPI sits after PnL KPI');
});

test('co-crown derives from roundGrade over lifetime rounds, letter-mapped', () => {
  assert.ok(dash.includes('G.roundGrade(state, r)'), 'per-round grade pass');
  assert.ok(dash.includes('const pts = { S: 4, A: 3, B: 2, C: 1, D: 0, F: 0 };'), 'letter→point map');
  assert.ok(dash.includes("avg >= 3.5 ? 'S' : avg >= 2.5 ? 'A'"), 'avg→letter banding');
});

test('co-crown shows honest em-dash when no graded rounds', () => {
  assert.ok(/data-discipline-grade[^]*?\? '—'/.test(dash), 'em-dash branch exists');
});

test('co-crown never replaces PnL KPIs', () => {
  assert.ok(dash.includes('Realized P&amp;L'), 'PnL KPI still present');
  assert.ok(dash.includes('Paper equity'), 'equity hero still present');
});

test('co-crown letter colors are stable hexes (theme-safe)', () => {
  for (const hex of ['#B786FF', '#34D399', '#6AA9FF', '#FF9D45', '#FF5F56']) {
    assert.ok(dash.includes(hex), `color ${hex} present`);
  }
});
