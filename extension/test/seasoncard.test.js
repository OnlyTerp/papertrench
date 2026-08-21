/* Season share card (ROADMAP item 6) — source-contract tests.
 *
 * The card must be spoiler-free BY CONSTRUCTION: no PnL fields anywhere in
 * the source, model, or painter inputs. These tests assert the contract on
 * the module's observable API: what seasonCardSource accepts/returns, what
 * seasonCardModel renders as strings, and that drawSeasonCard with a stub
 * context never receives a PnL-looking value.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const PC = require('../pnlcard.js');

const SESSION = {
  id: 'season', status: 'won', rounds: 14, startedAt: 1_800_000_000_000,
  score: 3.1, gates: { played: true, journaled: true, graded: true },
  elimination: null,
};
const TRENCH = { coverage: 0.86, avgGrade: 3.1, streak: 9, streakTier: { name: 'Flame' }, rankName: 'Operator', belts: 2 };

test('seasonCardSource: accepts season + survival, rejects others', () => {
  assert.ok(PC.seasonCardSource(SESSION, TRENCH));
  assert.ok(PC.seasonCardSource({ ...SESSION, id: 'survival' }, TRENCH));
  assert.equal(PC.seasonCardSource({ ...SESSION, id: 'gauntlet' }, TRENCH), null);
  assert.equal(PC.seasonCardSource(null, TRENCH), null);
});

test('seasonCardSource: returns no PnL fields (spoiler-free by construction)', () => {
  const src = PC.seasonCardSource(SESSION, TRENCH);
  const json = JSON.stringify(src);
  for (const banned of ['pnlSol', 'pnlPct', 'investedSol', 'returnedSol', 'pnlUsd', 'investedUsd', 'returnedUsd', 'multiple']) {
    assert.ok(!json.includes(banned), `source leaks ${banned}`);
  }
});

test('seasonCardSource: unknown status coerces to live', () => {
  const src = PC.seasonCardSource({ ...SESSION, status: 'weird' }, TRENCH);
  assert.equal(src.status, 'live');
});

test('seasonCardModel: status text and colors per status', () => {
  const m = PC.seasonCardModel(PC.seasonCardSource(SESSION, TRENCH), {});
  assert.equal(m.statusText, 'BELT WON');
  assert.equal(m.statusColor, PC.COLORS.green);
  const live = PC.seasonCardModel(PC.seasonCardSource({ ...SESSION, status: 'live' }, TRENCH), {});
  assert.equal(live.statusText, 'SEASON — LIVE');
  const sur = PC.seasonCardModel(PC.seasonCardSource({ ...SESSION, id: 'survival', status: 'live' }, TRENCH), {});
  assert.equal(sur.statusText, 'SURVIVAL — LIVE');
  const bust = PC.seasonCardModel(PC.seasonCardSource({ ...SESSION, id: 'survival', status: 'busted', elimination: 'stake blown — 18% left' }, TRENCH), {});
  assert.equal(bust.statusText, 'BUSTED');
  assert.equal(bust.statusColor, PC.COLORS.red);
});

test('seasonCardModel: gate dots render filled/empty per gates', () => {
  const partial = { ...SESSION, status: 'live', gates: { played: true, journaled: false, graded: true } };
  const m = PC.seasonCardModel(PC.seasonCardSource(partial, TRENCH), {});
  assert.deepEqual(m.gateDots, ['●', '○', '●']);
});

test('seasonCardModel: null trench renders honest em-dashes', () => {
  const m = PC.seasonCardModel(PC.seasonCardSource(SESSION, {}), {});
  assert.equal(m.coverageText, '—');
  assert.equal(m.avgGradeText, '—');
  assert.equal(m.streakText, 'no streak');
  assert.equal(m.rankText, '');
});

test('drawSeasonCard: stub ctx never receives PnL-shaped values', () => {
  const seen = [];
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === 'font' || prop === 'fillStyle' || prop === 'textAlign') return undefined;
      if (prop === 'fillRect') return () => {};
      if (prop === 'fillText') return (text) => { seen.push(String(text)); };
      return () => {};
    },
    set() { return true; },
  });
  const m = PC.seasonCardModel(PC.seasonCardSource(SESSION, TRENCH), {});
  PC.drawSeasonCard(ctx, m);
  assert.ok(seen.length > 0, 'painter drew something');
  const all = seen.join(' | ');
  for (const banned of ['SOL', 'x,', '%)(', '+', 'multiple']) {
    if (banned === 'multiple') continue;
    assert.ok(!/\d+\.\d+x\b/.test(all), 'painter drew a multiple');
  }
  assert.ok(!/SOL/.test(all), 'painter drew SOL amounts');
});

test('pnlcard exports the season pipeline', () => {
  assert.equal(typeof PC.seasonCardSource, 'function');
  assert.equal(typeof PC.seasonCardModel, 'function');
  assert.equal(typeof PC.drawSeasonCard, 'function');
});

/* ---------- dashboard wiring (source-contract on dashboard.js) ---------- */

const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');

test('dashboard: share button rendered for season/survival sessions only', () => {
  assert.ok(dash.includes('id="game-share"'), 'share button id present');
  assert.ok(dash.includes("session.id === 'season' || session.id === 'survival'"), 'gate on session ids');
});

test('dashboard: openSeasonShareCard derives from gameSession + streakLadder + rank + games', () => {
  assert.ok(dash.includes('function openSeasonShareCard'), 'function exists');
  assert.ok(dash.includes('PC.seasonCardSource'), 'uses the spoiler-free source');
  assert.ok(dash.includes('PC.drawSeasonCard'), 'paints via season painter');
  assert.ok(dash.includes('PC.seasonCardModel'), 'models via season model');
});

test('dashboard: coverage recomputed honestly from windowed rounds', () => {
  assert.ok(dash.includes('journaled / inWindow.length'), 'ratio from rounds, not the boolean gate');
});

/* ---------- pnlcard source contract: painter never reads PnL ---------- */

test('pnlcard: drawSeasonCard refuses non-season models', () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === 'fillText') return (text) => { calls.push(String(text)); };
      return () => {};
    },
    set() { return true; },
  });
  PC.drawSeasonCard(ctx, null);
  PC.drawSeasonCard(ctx, { kind: 'round' });
  assert.equal(calls.length, 0, 'refused without drawing');
});
