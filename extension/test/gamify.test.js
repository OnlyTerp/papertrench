/* Gamification derived from the journal (docs/GAMIFY.md as code).
 *
 * The doctrine under test: discipline is the loop, never volume, never luck.
 * A red round can grade S; a lucky win can grade F; a thesisless round can
 * never out-grade a C; reps diminish per day so grinding cannot game them;
 * and no function here mutates the state it reads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../gamify.js');

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';

const THESIS = { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 };

let seq = 0;
/** A closed round with engine-shaped fields. Chronological helpers below. */
function mkRound(opts = {}) {
  seq += 1;
  const investedSol = opts.investedSol ?? 1;
  const pnlSol = opts.pnlSol ?? 0.1;
  const closedAt = opts.closedAt ?? (1_800_000_000_000 + seq * 300_000);
  const heldMs = opts.heldMs ?? 60_000;
  return {
    id: 'r' + seq,
    mint: opts.mint || MINT_A,
    symbol: 'TEST',
    openedAt: opts.openedAt ?? (closedAt - heldMs),
    closedAt,
    heldMs,
    investedSol,
    returnedSol: investedSol + pnlSol,
    pnlSol,
    pnlPct: investedSol > 0 ? (pnlSol / investedSol) * 100 : 0,
    peakPnlSol: opts.peakPnlSol ?? Math.max(0, pnlSol),
    troughPnlSol: opts.troughPnlSol ?? Math.min(0, pnlSol),
    thesis: 'thesis' in opts ? opts.thesis : THESIS,
  };
}

/** State whose rounds arrive chronological; stored newest-first like the engine. */
function state(chronologicalRounds) {
  return { rounds: chronologicalRounds.slice().reverse(), journal: [], positions: {}, cashSol: 10 };
}

/* ---------------- round grades ---------------- */

test('a disciplined red round grades S — process, not P&L', () => {
  // Never went green, stop never breached, thesis written, size normal.
  const r = mkRound({ pnlSol: -0.2, peakPnlSol: 0, troughPnlSol: -0.25 });
  const grade = G.roundGrade(state([r]), r);
  assert.equal(grade.letter, 'S');
  assert.equal(grade.luckyWin, false);
  assert.equal(grade.parts.length, 0, 'no deductions: the loss followed the plan');
});

test('a lucky win grades F when it is revenge with no plan', () => {
  const loss = mkRound({ mint: MINT_B, pnlSol: -0.4, peakPnlSol: 0, troughPnlSol: -0.4, closedAt: 1_800_000_000_000 });
  const win = mkRound({
    mint: MINT_B,
    thesis: null,
    investedSol: 2,             // 2x the losing stake, minutes later
    openedAt: 1_800_000_000_000 + 4 * 60 * 1000,
    closedAt: 1_800_000_000_000 + 6 * 60 * 1000,
    pnlSol: 0.9,
    peakPnlSol: 0.9,
  });
  const grade = G.roundGrade(state([loss, win]), win);
  assert.equal(grade.letter, 'F', 'green P&L, F process');
  assert.equal(grade.luckyWin, true);
  assert.ok(grade.parts.some((p) => p.id === 'revenge'));
  assert.ok(grade.parts.some((p) => p.id === 'no-thesis'));
});

test('no thesis caps the grade at C even with a perfect exit', () => {
  const r = mkRound({ thesis: null, pnlSol: 0.9, peakPnlSol: 1.0 }); // 90% captured
  const grade = G.roundGrade(state([r]), r);
  assert.equal(grade.letter, 'C');
  assert.ok(grade.score <= 67);
});

test('breaking the written plan is penalized even on a green exit', () => {
  // Target 50% was reached in-trade (peak 60%), exit banked only 20%.
  const r = mkRound({ pnlSol: 0.2, peakPnlSol: 0.6 });
  const grade = G.roundGrade(state([r]), r);
  assert.ok(grade.parts.some((p) => p.id === 'plan-broken'));
  assert.ok(grade.parts.some((p) => p.id === 'exit-early'));
  assert.equal(grade.luckyWin, true, 'a win on a broken plan is lucky, and says so');
  assert.equal(grade.letter, 'C');
});

test('an outsized stake versus the trailing normal is a deduction', () => {
  const priors = Array.from({ length: 5 }, () => mkRound({ pnlSol: 0.05, peakPnlSol: 0.06 }));
  const big = mkRound({ investedSol: 3, pnlSol: -0.1, peakPnlSol: 0, troughPnlSol: -0.1 });
  const grade = G.roundGrade(state([...priors, big]), big);
  assert.ok(grade.parts.some((p) => p.id === 'outsized'));
});

/* ---------------- streaks ---------------- */

test('discipline streaks count and break honestly', () => {
  const rounds = [
    mkRound({}),                                     // thesis ok, clean
    mkRound({}),                                     // thesis ok, clean
    mkRound({ thesis: null }),                       // breaks the journal streak
    mkRound({ pnlSol: -0.1, peakPnlSol: 0.2, troughPnlSol: -0.1 }), // round-tripped
    mkRound({}),
  ];
  const st = G.streaks(state(rounds));
  assert.equal(st.journal.best, 2);
  assert.equal(st.journal.current, 2, 'the two rounds after the gap');
  assert.equal(st.cleanExit.best, 3);
  assert.equal(st.cleanExit.current, 1, 'reset by the round-trip, rebuilt once');
  assert.equal(st.noRevenge.current, 5, 'no revenge anywhere');
});

/* ---------------- Trench Rank ---------------- */

test('rank tiers gate on the graduation criteria and report progress', () => {
  assert.equal(G.rank(state([])).tier, 0);
  assert.equal(G.rank(state([])).name, 'Fresh Meat');

  const five = Array.from({ length: 5 }, () => mkRound({}));
  const r5 = G.rank(state(five));
  assert.equal(r5.tier, 0);
  const gate = r5.next.requirements.find((g) => g.label.indexOf('10+') === 0);
  assert.ok(Math.abs(gate.progress - 0.5) < 1e-9, 'five of ten rounds is half a gate');

  // Ten thesis-carrying rounds with wins outweighing losses: Journaler,
  // not yet Survivor (needs 25).
  const ten = Array.from({ length: 10 }, (_, i) => mkRound({
    pnlSol: i % 3 === 0 ? -0.1 : 0.3,
    peakPnlSol: i % 3 === 0 ? 0 : 0.3,
    troughPnlSol: i % 3 === 0 ? -0.1 : 0,
  }));
  const r10 = G.rank(state(ten));
  assert.equal(r10.tier, 1);
  assert.equal(r10.name, 'Journaler');
  assert.equal(r10.next.name, 'Survivor');
});

/* ---------------- reps ---------------- */

test('reps diminish per day: full to 10, half to 20, zero past 20', () => {
  const base = new Date(2026, 7, 5, 9, 0, 0).getTime(); // one local day
  const rounds = Array.from({ length: 22 }, (_, i) => mkRound({
    mint: i % 2 ? MINT_A : MINT_B,
    pnlSol: -0.01,
    peakPnlSol: 0,
    troughPnlSol: -0.01,
    openedAt: base + i * 60_000,
    closedAt: base + i * 60_000 + 30_000,
  }));
  const rep = G.reps(state(rounds), base + 23 * 60_000);
  // All rounds grade S (disciplined reds): 10 x 1.5 + 10 x 0.75 + 2 x 0.
  assert.ok(Math.abs(rep.total - 22.5) < 1e-9, `expected 22.5 rep points, got ${rep.total}`);
  assert.equal(rep.today.count, 22);
  assert.equal(rep.today.capped, true);
  assert.equal(rep.level, Math.floor(Math.sqrt(22.5 / 3)));
});

/* ---------------- badges ---------------- */

test('badges date what the journal can date, and exclude luck by design', () => {
  const first = mkRound({ pnlSol: 0.1, peakPnlSol: 0.2 }); // 50% captured: no sniper
  const sniper = mkRound({ pnlSol: 0.85, peakPnlSol: 1.0 }); // 85% captured
  const list = G.badges(state([first, sniper]));
  const byId = Object.fromEntries(list.map((b) => [b.id, b]));

  assert.equal(byId['first-thesis'].earned, true);
  assert.equal(byId['first-thesis'].earnedAt, first.closedAt);
  assert.equal(byId['sniper'].earned, true);
  assert.equal(byId['sniper'].earnedAt, sniper.closedAt);
  assert.equal(byId['fifty-club'].earned, false);
  // Doctrine: no profit/win-streak/volume badges exist to earn.
  assert.ok(!list.some((b) => /profit|win/i.test(b.id)));
});

/* ---------------- drills ---------------- */

test('the daily drill is deterministic for a day and measures honestly', () => {
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const a = G.drills(state([]), now);
  const b = G.drills(state([]), now);
  assert.equal(a.id, b.id, 'same day, same drill');
  assert.equal(a.roundsToday, 0);
  assert.equal(a.done, false, 'an empty day completes nothing');

  // Find the next capture-day and satisfy it with three >=50% captures.
  let day = new Date(2026, 7, 5, 12, 0, 0);
  while (G.drills(state([]), day.getTime()).id !== 'capture-day') {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime();
  const rounds = Array.from({ length: 3 }, (_, i) => mkRound({
    pnlSol: 0.6, peakPnlSol: 1.0, // 60% captured
    openedAt: dayStart + i * 600_000,
    closedAt: dayStart + i * 600_000 + 300_000,
  }));
  const done = G.drills(state(rounds), day.getTime());
  assert.equal(done.id, 'capture-day');
  assert.equal(done.done, true);
  assert.equal(done.progress, 3);
});

/* ---------------- trading games ---------------- */

test('the Gauntlet counts non-overlapping disciplined runs and resets on a violation', () => {
  const clean = () => mkRound({ pnlSol: -0.01, peakPnlSol: 0, troughPnlSol: -0.01 });
  const rounds = [];
  for (let i = 0; i < 10; i += 1) rounds.push(clean());   // one full run
  rounds.push(mkRound({ thesis: null }));                  // violation resets
  for (let i = 0; i < 4; i += 1) rounds.push(clean());     // partial run
  const g = G.games(state(rounds), Date.now()).find((x) => x.id === 'gauntlet');
  assert.equal(g.completions, 1);
  assert.equal(g.progress, 4, 'the current run restarts after the thesisless round');
  assert.equal(g.best, 10);
});

test('One-Shot banks exactly-one-round days at 50%+ capture and judges today live', () => {
  const base = new Date(2026, 7, 1, 10).getTime();
  const day = (n) => base + n * 24 * 60 * 60 * 1000;
  const rounds = [
    mkRound({ openedAt: day(0), closedAt: day(0) + 60_000, pnlSol: 0.6, peakPnlSol: 1.0 }),   // day 0: 60% — win
    mkRound({ openedAt: day(1), closedAt: day(1) + 60_000, pnlSol: 0.2, peakPnlSol: 1.0 }),   // day 1: 20% — miss
    mkRound({ openedAt: day(2), closedAt: day(2) + 60_000, pnlSol: 0.9, peakPnlSol: 1.0 }),   // day 2 first…
    mkRound({ openedAt: day(2), closedAt: day(2) + 120_000, pnlSol: 0.9, peakPnlSol: 1.0 }),  // …second: busted
    mkRound({ openedAt: day(3), closedAt: day(3) + 60_000, pnlSol: 0.8, peakPnlSol: 1.0 }),   // today: 80%
  ];
  const g = G.games(state(rounds), day(3) + 3 * 60 * 60 * 1000).find((x) => x.id === 'one-shot');
  assert.equal(g.wins, 1, 'only the clean single-round 50%+ day banks');
  assert.equal(g.today.rounds, 1);
  assert.equal(g.today.verdict, 'won', 'today is judged live, not banked');
});

test('Score Attack high score is a day of 3+ graded rounds, never a single exit', () => {
  const base = new Date(2026, 7, 10, 10).getTime();
  const day = (n) => base + n * 24 * 60 * 60 * 1000;
  const at = (d, i, cap) => mkRound({
    openedAt: day(d) + i * 600_000, closedAt: day(d) + i * 600_000 + 60_000,
    pnlSol: cap / 100, peakPnlSol: 1.0,
  });
  const rounds = [
    at(0, 0, 90), at(0, 1, 90),                    // two rounds: not enough
    at(1, 0, 60), at(1, 1, 70), at(1, 2, 80),      // avg 70 — the high score
  ];
  const g = G.games(state(rounds), day(2)).find((x) => x.id === 'score-attack');
  assert.ok(g.best, 'a qualifying day exists');
  assert.ok(Math.abs(g.best.score - 70) < 1e-9);
  assert.equal(g.best.rounds, 3);
});

test('Journal Week advances only on traded days and never punishes a quiet day', () => {
  const base = new Date(2026, 6, 1, 10).getTime();
  const day = (n) => base + n * 24 * 60 * 60 * 1000;
  // Traded days 0,1,2 then a 4-day gap, then days 7,8 — all thesis'd.
  const rounds = [0, 1, 2, 7, 8].map((n) => mkRound({
    openedAt: day(n), closedAt: day(n) + 60_000, pnlSol: 0.1, peakPnlSol: 0.2,
  }));
  const c = G.challenges(state(rounds)).find((x) => x.id === 'journal-week');
  assert.equal(c.progress, 5, 'the calendar gap neither breaks nor advances the run');
  assert.equal(c.done, false);
});

/* ---------------- game sessions ---------------- */

test('a Gauntlet session scores only rounds closed since start, and a violation ends it', () => {
  const before = mkRound({ thesis: null });                 // pre-session junk must not count
  const t0 = before.closedAt + 60_000;
  const clean = (i) => mkRound({ openedAt: t0 + i * 120_000, closedAt: t0 + i * 120_000 + 60_000, pnlSol: -0.01, peakPnlSol: 0, troughPnlSol: -0.01 });
  const rounds = [before, clean(0), clean(1), clean(2)];
  const s = state(rounds);
  s.activeGame = { id: 'gauntlet', startedAt: t0 };
  const live = G.gameSession(s);
  assert.equal(live.status, 'live');
  assert.equal(live.progress, 3, 'the thesisless pre-session round is invisible to the session');

  const broken = mkRound({ thesis: null, openedAt: t0 + 10 * 120_000, closedAt: t0 + 10 * 120_000 + 60_000 });
  const s2 = state([...rounds, broken]);
  s2.activeGame = { id: 'gauntlet', startedAt: t0 };
  const failed = G.gameSession(s2);
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /no thesis/);
});

test('One-Shot: one qualifying round wins, a second busts, and no pointer means no session', () => {
  const t0 = 1_800_000_000_000;
  const shot = mkRound({ openedAt: t0 + 60_000, closedAt: t0 + 120_000, pnlSol: 0.7, peakPnlSol: 1.0 });
  const s = state([shot]);
  s.activeGame = { id: 'one-shot', startedAt: t0 };
  const won = G.gameSession(s);
  assert.equal(won.status, 'won');
  assert.ok(Math.abs(won.score - 70) < 1e-9);

  const second = mkRound({ openedAt: t0 + 200_000, closedAt: t0 + 260_000, pnlSol: 0.9, peakPnlSol: 1.0 });
  const s2 = state([shot, second]);
  s2.activeGame = { id: 'one-shot', startedAt: t0 };
  assert.equal(G.gameSession(s2).status, 'busted');

  assert.equal(G.gameSession(state([shot])), null, 'no active pointer, no session');
});

test('engine start/end own the pointer and nothing else', () => {
  const E = require('../engine.js');
  const s = state([]);
  assert.equal(E.startGame(s, 'not-a-game', 1), null, 'unknown ids are refused');
  const started = E.startGame(s, 'score-attack', 123);
  assert.deepEqual(started, { id: 'score-attack', startedAt: 123 });
  assert.deepEqual(s.activeGame, { id: 'score-attack', startedAt: 123 });
  const ended = E.endGame(s);
  assert.equal(ended.id, 'score-attack');
  assert.equal(s.activeGame, null);
  assert.equal(E.endGame(s), null, 'ending twice is a no-op');
});

/* ---------------- purity ---------------- */

test('gamify never mutates the state it reads', () => {
  const rounds = [
    mkRound({}),
    mkRound({ thesis: null, pnlSol: -0.2, peakPnlSol: 0.3, troughPnlSol: -0.2 }),
  ];
  const s = state(rounds);
  const before = JSON.stringify(s);
  G.roundGrade(s, s.rounds[0]);
  G.streaks(s);
  G.rank(s);
  G.reps(s, Date.now());
  G.badges(s);
  G.drills(s, Date.now());
  G.games(s, Date.now());
  G.challenges(s);
  assert.equal(JSON.stringify(s), before, 'derived means derived');
});

/* ---------------- streak ladder (ROADMAP.md item 7) ---------------- */

test('streak tiers: ember at 3, flame at 7, blaze at 14, torch at 30', () => {
  const mk = (n) => state(Array.from({ length: n }, (_, i) => mkRound({ closedAt: 1_800_000_000_000 + i * 3_600_000 })));
  assert.equal(G.streakLadder(mk(2), 'journal').tier, null, '2 is pre-ember: noise, not fire');
  assert.equal(G.streakLadder(mk(3), 'journal').tier, 'ember');
  assert.equal(G.streakLadder(mk(6), 'journal').tier, 'ember', '6 still ember');
  assert.equal(G.streakLadder(mk(7), 'journal').tier, 'flame');
  assert.equal(G.streakLadder(mk(14), 'journal').tier, 'blaze');
  assert.equal(G.streakLadder(mk(30), 'journal').tier, 'torch');
  assert.equal(G.streakLadder(mk(50), 'journal').tier, 'torch', 'torch is the summit');
});

test('ladder reports the distance to the next rung', () => {
  const st = state(Array.from({ length: 5 }, (_, i) => mkRound({ closedAt: 1_800_000_000_000 + i * 3_600_000 })));
  const lad = G.streakLadder(st, 'journal');
  assert.equal(lad.tier, 'ember');
  assert.equal(lad.toNext, 2, '5 + 2 = 7 = flame');
  assert.equal(lad.next.name, 'flame');
});

test('a broken streak drops to zero and the ladder follows', () => {
  const rounds = [
    ...Array.from({ length: 8 }, (_, i) => mkRound({ closedAt: 1_800_000_000_000 + i * 3_600_000 })),
    mkRound({ thesis: null, closedAt: 1_800_000_000_100 + 9 * 3_600_000 }), // breaks journal streak
    mkRound({ closedAt: 1_800_000_000_100 + 10 * 3_600_000 }),
  ];
  const lad = G.streakLadder(state(rounds), 'journal');
  assert.equal(lad.current, 1);
  assert.equal(lad.tier, null);
  assert.equal(lad.best, 8, 'the best run survives the break');
});

test('unknown kind degrades safely, not explosively', () => {
  const lad = G.streakLadder(state([mkRound()]), 'nope');
  assert.equal(lad.current, 0);
  assert.equal(lad.tier, null);
});

test('STREAK_TIERS is exported and monotonic', () => {
  assert.ok(Array.isArray(G.STREAK_TIERS));
  let prev = 0;
  for (const t of G.STREAK_TIERS) {
    assert.ok(t.at > prev, 'thresholds strictly increase');
    assert.ok(t.name && t.label, 'every tier has identity');
    prev = t.at;
  }
});

/* ---------------- Trench Season (ROADMAP.md item 1) ---------------- */

const DAY = 86_400_000;

/** A journaled, disciplined round at day-offset d (grade-friendly: thesis,
 *  normal size, clean exit path, +40% capture). */
function seasonRound(d, i) {
  return mkRound({
    closedAt: 1_800_000_000_000 + d * DAY + i * 3_600_000,
    openedAt: 1_800_000_000_000 + d * DAY + i * 3_600_000 - 600_000,
    peakPnlSol: 0.5, troughPnlSol: 0, pnlSol: 0.4,   // 80% capture
  });
}

test('season: three gates met within 7 days = won', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i)); // 14 rounds, all journaled
  const st = { ...state(rounds), activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 3 * DAY);
  assert.equal(s.id, 'season');
  assert.equal(s.status, 'won', '14 rounds, 100% journaled, grades S/A');
  assert.equal(s.rounds, 14);
  assert.equal(s.gates.played, true);
  assert.equal(s.gates.journaled, true);
  assert.equal(s.gates.graded, true);
});

test('season: journal coverage under 80% holds the gate open, stays live', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  // 4 thesisless of 16 total = 12/16 = 75% < 80% gate
  for (let i = 0; i < 4; i++) rounds.push(mkRound({ thesis: null, closedAt: 1_800_000_000_000 + 6.5 * DAY + i * 3_600_000 }));
  const st = { ...state(rounds), activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 6.9 * DAY);
  assert.equal(s.gates.played, true, '16 rounds clears the volume gate');
  assert.equal(s.gates.journaled, false, '12/16 = 75% coverage');
  assert.equal(s.status, 'live');
});

test('season: window closes as missed when gates unmet', () => {
  const rounds = [seasonRound(0, 0), seasonRound(1, 0)]; // only 2 rounds
  const st = { ...state(rounds), activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 8 * DAY);
  assert.equal(s.status, 'missed');
  assert.ok(s.detail.includes('window closed'));
});

test('season: rounds after the window do not count', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  rounds.push(seasonRound(9, 0)); // outside window
  const st = { ...state(rounds), activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 9.5 * DAY);
  assert.equal(s.rounds, 14, 'the post-window round is excluded');
  assert.equal(s.status, 'won');
});

test('games(): season card present with wins stat', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  const games = G.games(state(rounds), 1_800_000_000_000 + 8 * DAY);
  const season = games.find((g) => g.id === 'season');
  assert.ok(season, 'season card exists');
  assert.equal(season.wins, 1, 'one belt banked');
});

test('games(): short journal banks no belts', () => {
  const games = G.games(state([seasonRound(0, 0)]), 1_800_000_000_000 + DAY);
  const season = games.find((g) => g.id === 'season');
  assert.equal(season.wins, 0);
});

test('season headline in HUD body: won shows belt', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  const st = { ...state(rounds), activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 3 * DAY);
  assert.equal(s.status, 'won');
});

/* ---------------- Survival Season (ROADMAP item 5) ---------------- */

test('survival: normal winning week is unaffected by the elimination check', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  const st = { ...state(rounds), activeGame: { id: 'survival', startedAt: 1_800_000_000_000 - 1000 } };
  const s = G.gameSession(st, 1_800_000_000_000 + 3 * DAY);
  assert.equal(s.id, 'survival');
  assert.equal(s.status, 'won');
  assert.equal(s.elimination, null);
});

test('survival: equity blown to 20% busts the season immediately', () => {
  // Start with 10 SOL; lose 8.5 net across the season's rounds.
  const rounds = [
    mkRound({ investedSol: 5, pnlSol: -4.25, returnedSol: 0.75, closedAt: 1_800_000_000_000 + DAY }),
    mkRound({ investedSol: 5, pnlSol: -4.25, returnedSol: 0.75, closedAt: 1_800_000_000_000 + 2 * DAY }),
  ];
  const st = {
    rounds: rounds.slice().reverse(),
    journal: [], positions: {},
    cashSol: 10 - 8.5, // what's left after both losses
    activeGame: { id: 'survival', startedAt: 1_800_000_000_000 - 1000 },
  };
  const s = G.gameSession(st, 1_800_000_000_000 + 3 * DAY);
  assert.equal(s.status, 'busted');
  assert.ok(s.elimination.includes('stake blown'));
  assert.ok(s.detail.includes('stake blown'));
});

test('survival: equity above the line stays live even on a red week', () => {
  const rounds = [
    mkRound({ investedSol: 5, pnlSol: -1, returnedSol: 4, closedAt: 1_800_000_000_000 + DAY }),
  ];
  const st = {
    rounds: rounds.slice().reverse(),
    journal: [], positions: {},
    cashSol: 10 - 1,
    activeGame: { id: 'survival', startedAt: 1_800_000_000_000 - 1000 },
  };
  const s = G.gameSession(st, 1_800_000_000_000 + 2 * DAY);
  assert.equal(s.status, 'live');
  assert.equal(s.elimination, null);
});

test('survival: gates can still be won while riding the line', () => {
  const rounds = [];
  for (let d = 0; d < 7; d++) for (let i = 0; i < 2; i++) rounds.push(seasonRound(d, i));
  const st = {
    ...state(rounds),
    cashSol: 9.5, // small net loss, nowhere near the line
    activeGame: { id: 'survival', startedAt: 1_800_000_000_000 - 1000 },
  };
  const s = G.gameSession(st, 1_800_000_000_000 + 3 * DAY);
  assert.equal(s.status, 'won');
});

test('regular season ignores equity entirely (no elimination field leak)', () => {
  const rounds = [
    mkRound({ investedSol: 5, pnlSol: -4.25, returnedSol: 0.75, closedAt: 1_800_000_000_000 + DAY }),
  ];
  const st = {
    rounds: rounds.slice().reverse(),
    journal: [], positions: {},
    cashSol: 1.5,
    activeGame: { id: 'season', startedAt: 1_800_000_000_000 - 1000 },
  };
  const s = G.gameSession(st, 1_800_000_000_000 + 2 * DAY);
  assert.equal(s.status, 'live', 'equity never enters the standard season');
  assert.equal(s.elimination, null);
});
