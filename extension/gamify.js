/* PaperTrench — gamification derived from the journal (docs/GAMIFY.md).
 *
 * Pure functions over the serializable state object, like mastery.js: no DOM,
 * no chrome APIs, no timers. Every mechanic is DERIVED — nothing here writes
 * state, so there is nothing to migrate and nothing to cheat that the
 * attestation chain does not already cover.
 *
 * Doctrine (GAMIFY.md): discipline is the loop, never volume, never luck.
 * A red round can grade A; a lucky win can grade F. No mechanic may alter or
 * reinterpret a number surfaced elsewhere.
 */
(() => {
  'use strict';

  const REVENGE_WINDOW_MS = 10 * 60 * 1000;
  const REVENGE_SIZE_RATIO = 1.5;
  const OUTSIZED_RATIO = 2;
  const OUTSIZED_MIN_PRIORS = 5;

  const GRADE_BANDS = [
    ['S', 92], ['A', 80], ['B', 68], ['C', 55], ['D', 40], ['F', -Infinity],
  ];
  const NO_THESIS_CAP = 67; // a thesisless round can never out-grade a C

  const REP_WEIGHT = { S: 1.5, A: 1.25, B: 1, C: 0.75, D: 0.5, F: 0.25 };
  const REP_FULL_PER_DAY = 10;
  const REP_HALF_PER_DAY = 20;
  const REP_LEVEL_DIVISOR = 3;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  /** Engine/mastery are load-order globals in the browser and requires in
   *  node; resolve lazily so gamify.js can load before either. */
  function deps() {
    if (typeof module !== 'undefined' && module.exports) {
      return { E: require('./engine.js'), M: require('./mastery.js') };
    }
    const g = typeof window !== 'undefined' ? window : self;
    return { E: g.PaperEngine, M: g.PTMastery };
  }

  function closedRounds(state) {
    const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];
    return rounds.filter((r) => r && num(r.pnlSol) !== null);
  }

  /** Oldest-first copy; storage order is newest-first (engine unshift). */
  function chronological(state) {
    return closedRounds(state).slice().reverse();
  }

  /* ---------------- revenge detection (per round) ---------------- */

  /**
   * Was THIS round opened as a revenge re-entry: within the window after a
   * red close of the same mint, sized at >= ratio x that round's stake?
   * (mastery.countRevenge asks the mirrored question — "was this loss
   * revenged" — for the graduation bar; the grade needs it per-entry.)
   */
  function isRevengeEntry(state, round) {
    const openedAt = num(round && round.openedAt);
    const invested = num(round && round.investedSol);
    if (openedAt === null || invested === null || !round.mint) return false;
    return closedRounds(state).some((prior) => prior !== round
      && prior.mint === round.mint
      && num(prior.pnlSol) < 0
      && num(prior.closedAt) !== null
      && num(prior.closedAt) <= openedAt
      && openedAt - num(prior.closedAt) <= REVENGE_WINDOW_MS
      && num(prior.investedSol) !== null
      && invested >= num(prior.investedSol) * REVENGE_SIZE_RATIO);
  }

  /** Mean invested across the rounds closed BEFORE this one opened. */
  function trailingMeanInvested(state, round) {
    const openedAt = num(round && round.openedAt);
    if (openedAt === null) return null;
    const priors = closedRounds(state)
      .filter((r) => r !== round && num(r.closedAt) !== null && num(r.closedAt) <= openedAt)
      .map((r) => num(r.investedSol))
      .filter((x) => x !== null && x > 0);
    if (priors.length < OUTSIZED_MIN_PRIORS) return null;
    return priors.reduce((s, x) => s + x, 0) / priors.length;
  }

  /* ---------------- round grades ---------------- */

  function letterFor(score) {
    for (const [letter, floor] of GRADE_BANDS) if (score >= floor) return letter;
    return 'F';
  }

  /**
   * Grade one closed round's PROCESS. Every deduction names its evidence;
   * the parts array is the receipt the UI and the coach both read.
   */
  function roundGrade(state, round) {
    if (!round || num(round.pnlSol) === null) return null;
    const { E } = deps();
    const parts = [];
    let score = 100;
    const deduct = (id, delta, note) => { score += delta; parts.push({ id, delta, note }); };

    const hasThesis = Boolean(round.thesis
      && (typeof round.thesis === 'object' || String(round.thesis).trim().length));
    if (!hasThesis) {
      deduct('no-thesis', -30, 'No written thesis — clicking, not trading a plan.');
    }

    const plan = hasThesis && E && typeof E.gradeThesis === 'function' ? E.gradeThesis(round) : null;
    if (plan && plan.followedPlan === false) {
      deduct('plan-broken', -25, plan.notes && plan.notes.length
        ? plan.notes.join(' ')
        : 'The exit did not respect the stated plan.');
    }

    const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(round) : null;
    if (exit) {
      if (exit.verdict === 'round-tripped') {
        deduct('round-trip', -30, 'Green in-trade, closed red — the costliest habit.');
      } else if (exit.verdict === 'early') {
        deduct('exit-early', -12, `Captured ${exit.capturedPct === null ? '?' : exit.capturedPct.toFixed(0)}% of the peak.`);
      } else if (exit.verdict === 'good') {
        deduct('exit-good', -5, `Captured ${exit.capturedPct === null ? '?' : exit.capturedPct.toFixed(0)}% of the peak.`);
      }
    }

    if (isRevengeEntry(state, round)) {
      deduct('revenge', -35, 'Re-entered the same coin within minutes of a loss, bigger.');
    }

    const meanInvested = trailingMeanInvested(state, round);
    const invested = num(round.investedSol);
    if (meanInvested !== null && invested !== null && invested > meanInvested * OUTSIZED_RATIO) {
      deduct('outsized', -12, `Stake ${(invested / meanInvested).toFixed(1)}x your recent normal size.`);
    }

    score = Math.max(0, Math.min(100, score));
    if (!hasThesis && score > NO_THESIS_CAP) score = NO_THESIS_CAP;

    const letter = letterFor(score);
    const luckyWin = num(round.pnlSol) > 0
      && (Boolean(plan && plan.followedPlan === false) || !hasThesis || parts.some((p) => p.id === 'revenge'));
    return {
      score,
      letter,
      parts,
      luckyWin,
      capturedPct: exit ? exit.capturedPct : null,
      verdict: exit ? exit.verdict : null,
    };
  }

  /* ---------------- discipline streaks ---------------- */

  function streakOver(rounds, qualifies) {
    let current = 0;
    let best = 0;
    for (const r of rounds) {
      if (qualifies(r)) { current += 1; if (current > best) best = current; } else { current = 0; }
    }
    return { current, best };
  }

  /** Current/best streaks over closed rounds, oldest to newest. */
  function streaks(state) {
    const { E } = deps();
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    const notRoundTripped = (r) => {
      const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
      return !(exit && exit.roundTripped);
    };
    return {
      journal: streakOver(rounds, hasThesis),
      cleanExit: streakOver(rounds, notRoundTripped),
      noRevenge: streakOver(rounds, (r) => !isRevengeEntry(state, r)),
    };
  }

  /* ---------------- streak ladder (ROADMAP.md item 7) ---------------- */

  /** Tier names are the visible identity — ember (finding the habit) →
   *  flame (owning it) → blaze (protecting it). Thresholds deliberately
   *  generous: Duolingo's finding is that the STREAK, not its difficulty,
   *  is what retains. */
  const STREAK_TIERS = [
    { at: 3, name: 'ember',  label: 'Ember' },
    { at: 7, name: 'flame',  label: 'Flame' },
    { at: 14, name: 'blaze', label: 'Blaze' },
    { at: 30, name: 'torch', label: 'Torch' },
  ];

  /** The tier a streak of `n` currently holds (highest threshold <= n). */
  function streakTier(n) {
    let tier = null;
    for (const t of STREAK_TIERS) if (n >= t.at) tier = t;
    return tier;
  }

  /** Ladder view over a streak. Deliberately NO day-based freeze mechanic:
   *  PaperTrench streaks count ROUNDS, not days — a trader who takes a week
   *  off loses nothing (only an undisciplined round breaks the run). Duolingo
   *  needs freezes because its streaks punish absence; ours never do. */
  function streakLadder(state, kind) {
    const st = streaks(state);
    const s = st[kind];
    if (!s || !s.current || s.current < STREAK_TIERS[0].at) {
      return { kind, current: s ? s.current : 0, best: s ? s.best : 0,
        tier: null, next: STREAK_TIERS[0], toNext: STREAK_TIERS[0].at - (s ? s.current : 0),
        frozen: false, label: null };
    }
    const tier = streakTier(s.current);
    const next = STREAK_TIERS.find((t) => t.at > s.current) || null;
    return {
      kind, current: s.current, best: s.best,
      tier: tier.name, label: tier.label,
      next, toNext: next ? next.at - s.current : 0,
      frozen: false,
    };
  }

  /* ---------------- Trench Rank ---------------- */

  const RANKS = [
    { tier: 0, name: 'Fresh Meat' },
    { tier: 1, name: 'Journaler' },
    { tier: 2, name: 'Survivor' },
    { tier: 3, name: 'Operator' },
    { tier: 4, name: 'Veteran' },
    { tier: 5, name: 'Graduated' },
  ];

  const frac = (value, target) => {
    if (value === null || !(target > 0)) return 0;
    return Math.max(0, Math.min(1, value / target));
  };

  /**
   * The graduation bar (mastery.js) staged into a ladder, so there is always
   * a visible next gate. Requirements report progress fractions the UI can
   * draw; an unknown criterion is 0 progress, never a free pass.
   */
  function rank(state) {
    const { M } = deps();
    if (!M) return null;
    const grad = M.graduation(state);
    const s = grad.stats;
    const byId = {};
    for (const c of grad.criteria) byId[c.id] = c;
    const pass = (id) => Boolean(byId[id] && byId[id].status === 'pass');

    const gates = [
      null, // tier 0 is unconditional
      [
        { label: '10+ closed rounds', done: s.totalRounds >= 10, progress: frac(s.totalRounds, 10) },
        { label: 'Thesis on 60% of recent rounds', done: pass('thesis'), progress: frac(s.thesisCoverage, 0.6) },
      ],
      [
        { label: '25+ closed rounds', done: s.totalRounds >= 25, progress: frac(s.totalRounds, 25) },
        { label: 'Average loss smaller than average win', done: pass('lossSize'), progress: pass('lossSize') ? 1 : 0 },
      ],
      [
        { label: '35+ closed rounds', done: s.totalRounds >= 35, progress: frac(s.totalRounds, 35) },
        { label: 'No revenge re-entries in the window', done: pass('revenge'), progress: pass('revenge') ? 1 : 0 },
        { label: 'Losers not held 3x longer than winners', done: pass('holdSymmetry'), progress: pass('holdSymmetry') ? 1 : 0 },
      ],
      [
        { label: '50+ closed rounds', done: pass('sample'), progress: frac(s.totalRounds, M.SAMPLE_MIN) },
        { label: 'Survived a cold streak without sizing up', done: pass('coldStreak'), progress: pass('coldStreak') ? 1 : 0 },
      ],
      [
        { label: 'The full graduation bar', done: grad.overall, progress: frac(grad.criteria.filter((c) => c.status === 'pass').length, grad.criteria.length) },
      ],
    ];

    let tier = 0;
    for (let t = 1; t < gates.length; t += 1) {
      if (gates[t].every((g) => g.done)) tier = t; else break;
    }
    const next = tier + 1 < RANKS.length
      ? { name: RANKS[tier + 1].name, requirements: gates[tier + 1] }
      : null;
    return { tier, name: RANKS[tier].name, next, graduated: grad.overall };
  }

  /* ---------------- reps & level ---------------- */

  /** Local calendar day of a timestamp — reps diminish per DAY on purpose. */
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * One closed graded round = one rep, weighted by grade. Diminishing per
   * day: full credit for the first 10, half to 20, zero past 20 — tired reps
   * don't count, and that is itself the lesson.
   */
  function reps(state, now) {
    const nowTs = num(now) !== null ? num(now) : Date.now();
    const rounds = chronological(state);
    const perDay = {};
    let total = 0;
    for (const r of rounds) {
      const closedAt = num(r.closedAt);
      if (closedAt === null) continue;
      const key = dayKey(closedAt);
      const nth = (perDay[key] = (perDay[key] || 0) + 1);
      if (nth > REP_HALF_PER_DAY) continue;
      const grade = roundGrade(state, r);
      if (!grade) continue;
      const weight = REP_WEIGHT[grade.letter] || 0;
      total += nth > REP_FULL_PER_DAY ? weight / 2 : weight;
    }
    const level = Math.floor(Math.sqrt(total / REP_LEVEL_DIVISOR));
    const nextLevelAt = REP_LEVEL_DIVISOR * (level + 1) * (level + 1);
    const todayCount = perDay[dayKey(nowTs)] || 0;
    return {
      total,
      level,
      nextLevelAt,
      today: {
        count: todayCount,
        counted: Math.min(todayCount, REP_HALF_PER_DAY),
        capped: todayCount >= REP_HALF_PER_DAY,
        diminished: todayCount >= REP_FULL_PER_DAY,
      },
    };
  }

  /* ---------------- badges ---------------- */

  /**
   * Earned/unearned with dates where the journal can actually date them.
   * Doctrine: no profit badges, no win-streak badges, no volume badges —
   * those train the habits this product exists to break.
   */
  function badges(state) {
    const { E } = deps();
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    const capture = (r) => {
      const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
      return exit ? exit.capturedPct : null;
    };
    const st = streaks(state);
    const firstWhere = (pred) => rounds.find(pred) || null;

    const firstThesis = firstWhere(hasThesis);
    const firstSniper = firstWhere((r) => capture(r) !== null && capture(r) >= 80);
    const sniperCount = rounds.filter((r) => capture(r) !== null && capture(r) >= 80).length;
    const last25 = rounds.slice(-25);
    const planRun = streakOver(rounds.filter(hasThesis), (r) => {
      const plan = E && typeof E.gradeThesis === 'function' ? E.gradeThesis(r) : null;
      return Boolean(plan && plan.followedPlan === true);
    });
    const { M } = deps();
    const cold = M ? M.stats(state).coldStreak : { length: 0, disciplined: null };

    const badge = (id, label, detail, earned, earnedAt) => (
      { id, label, detail, earned: Boolean(earned), earnedAt: earned && earnedAt ? earnedAt : null }
    );
    return [
      badge('first-thesis', 'On the record', 'Wrote a thesis before an entry.',
        Boolean(firstThesis), firstThesis && num(firstThesis.closedAt)),
      badge('journal-10', 'Ten on the record', '10 consecutive rounds with a written thesis.',
        st.journal.best >= 10, null),
      badge('cold-blooded', 'Cold-blooded', 'Survived a real losing streak without sizing up.',
        cold.length >= 3 && cold.disciplined === true, null),
      badge('fifty-club', 'Fifty club', '50 closed round trips — a sample that starts to mean something.',
        rounds.length >= 50, null),
      badge('sniper', 'Sniper exit', 'Captured 80%+ of what a trade offered.',
        Boolean(firstSniper), firstSniper && num(firstSniper.closedAt)),
      badge('sniper-10', 'Ten clean exits', '10 rounds capturing 80%+ of the peak.',
        sniperCount >= 10, null),
      badge('no-revenge-25', 'Held the line', '25 straight rounds without a revenge re-entry.',
        last25.length >= 25 && last25.every((r) => !isRevengeEntry(state, r)), null),
      badge('plan-master', 'Plan master', '10 consecutive rounds that respected their written plan.',
        planRun.best >= 10, null),
    ];
  }

  /* ---------------- daily drills ---------------- */

  const DRILLS = [
    {
      id: 'capture-day',
      label: 'Capture day',
      detail: 'Close 3 rounds capturing at least 50% of the peak.',
      minRounds: 3,
      evaluate(E, todays) {
        const hits = todays.filter((r) => {
          const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
          return exit && exit.capturedPct !== null && exit.capturedPct >= 50;
        }).length;
        return { progress: Math.min(hits, 3), target: 3, done: hits >= 3 };
      },
    },
    {
      id: 'journal-day',
      label: 'Journal day',
      detail: 'Every round today carries a written thesis (at least 3).',
      minRounds: 3,
      evaluate(E, todays) {
        const withThesis = todays.filter((r) => Boolean(r.thesis
          && (typeof r.thesis === 'object' || String(r.thesis).trim().length))).length;
        const done = todays.length >= 3 && withThesis === todays.length;
        return { progress: withThesis, target: Math.max(3, todays.length), done };
      },
    },
    {
      id: 'flat-size-day',
      label: 'Flat-size day',
      detail: 'Keep every stake within 1.25x of today\'s average (at least 3 rounds).',
      minRounds: 3,
      evaluate(_E, todays) {
        const stakes = todays.map((r) => num(r.investedSol)).filter((x) => x !== null && x > 0);
        if (stakes.length < 3) return { progress: stakes.length, target: 3, done: false };
        const mean = stakes.reduce((s, x) => s + x, 0) / stakes.length;
        const done = Math.max(...stakes) <= mean * 1.25;
        return { progress: stakes.length, target: stakes.length, done };
      },
    },
    {
      id: 'stop-respect-day',
      label: 'Stop-respect day',
      detail: 'No written stop gets held through (at least 2 thesis rounds).',
      minRounds: 2,
      evaluate(E, todays) {
        const planned = todays.filter((r) => r.thesis && typeof r.thesis === 'object');
        const breached = planned.filter((r) => {
          const plan = E && typeof E.gradeThesis === 'function' ? E.gradeThesis(r) : null;
          return Boolean(plan && plan.notes && plan.notes.some((n) => n.indexOf('Held past') === 0));
        }).length;
        return { progress: planned.length, target: 2, done: planned.length >= 2 && breached === 0 };
      },
    },
  ];

  /** Deterministic small hash so the day's drill is stable all day. */
  function drillIndexFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h % DRILLS.length;
  }

  /** Today's drill and honest progress against it. */
  function drills(state, now) {
    const { E } = deps();
    const nowTs = num(now) !== null ? num(now) : Date.now();
    const key = dayKey(nowTs);
    const todays = chronological(state).filter((r) => num(r.closedAt) !== null && dayKey(num(r.closedAt)) === key);
    const drill = DRILLS[drillIndexFor(key)];
    const result = drill.evaluate(E, todays);
    return {
      id: drill.id,
      label: drill.label,
      detail: drill.detail,
      day: key,
      roundsToday: todays.length,
      progress: result.progress,
      target: result.target,
      done: result.done,
    };
  }

  /* ---------------- trading games (GAMIFY.md: played on live charts) ------
   * A "game" here is a RULESET over real paper trading on real charts —
   * never a synthetic market, never a guess-the-candle machine. All three
   * are always-on and fully derived from the journal: no start button, no
   * stored game state, nothing to migrate, nothing to cheat.
   */

  /** Non-overlapping qualifying runs: current streak, best, and how many
   *  times a full `target`-length run completed (streak resets on completion
   *  so the next run starts clean). */
  function runsOver(rounds, qualifies, target) {
    let current = 0;
    let best = 0;
    let completions = 0;
    for (const r of rounds) {
      if (qualifies(r)) {
        current += 1;
        if (current > best) best = current;
        if (current >= target) { completions += 1; current = 0; }
      } else {
        current = 0;
      }
    }
    return { current, best, completions };
  }

  function captureOf(E, round) {
    const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(round) : null;
    return exit ? exit.capturedPct : null;
  }

  /** Rounds bucketed by LOCAL close day, in day order (D-49 bucketing). */
  function dayBuckets(rounds) {
    const byDay = new Map();
    for (const r of rounds) {
      const closedAt = num(r.closedAt);
      if (closedAt === null) continue;
      const key = dayKey(closedAt);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    }
    return byDay; // Map preserves insertion order; rounds arrive chronological
  }

  /** The Gauntlet alone, Date-free on purpose: the overlay computes it in
   *  its event-driven cache, and the overlay harnesses stub Date down to
   *  {now} — day-bucketed games stay a dashboard concern. */
  function gauntletRun(state) {
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    return runsOver(rounds, (r) => hasThesis(r) && !isRevengeEntry(state, r), 10);
  }

  function games(state, now) {
    const { E } = deps();
    const nowTs = num(now) !== null ? num(now) : Date.now();
    const rounds = chronological(state);
    const today = dayKey(nowTs);
    const byDay = dayBuckets(rounds);

    // The Gauntlet: ten straight rounds, each with a written thesis and no
    // revenge entry. The discipline streak, made a summit.
    const gauntlet = gauntletRun(state);

    // One-Shot: a day with EXACTLY one round, capturing 50%+ of what it
    // offered. One entry, one exit, no second helpings.
    let oneShotWins = 0;
    for (const [key, dayRounds] of byDay) {
      if (key === today) continue; // today is judged live below, not banked
      const c = dayRounds.length === 1 ? captureOf(E, dayRounds[0]) : null;
      if (c !== null && c >= 50) oneShotWins += 1;
    }
    const todayRounds = byDay.get(today) || [];
    let oneShotToday = null;
    if (todayRounds.length === 1) {
      const c = captureOf(E, todayRounds[0]);
      oneShotToday = c !== null && c >= 50 ? 'won' : 'missed';
    } else if (todayRounds.length > 1) {
      oneShotToday = 'busted';
    }

    // Score Attack: a day's average capture across 3+ graded rounds. The
    // high score is a DAY, not a trade — consistency beats one hero exit.
    let bestDay = null;
    for (const [key, dayRounds] of byDay) {
      const caps = dayRounds.map((r) => captureOf(E, r)).filter((c) => c !== null);
      if (caps.length < 3) continue;
      const avg = caps.reduce((s, c) => s + c, 0) / caps.length;
      if (!bestDay || avg > bestDay.score) bestDay = { day: key, score: avg, rounds: caps.length };
    }
    const todayCaps = todayRounds.map((r) => captureOf(E, r)).filter((c) => c !== null);

    // Trench Seasons won (card stat). Past seasons aren't stored (doctrine
    // §4: derive, don't store) — a won season is visible in the journal as
    // any 7 consecutive days meeting all three gates. This counts every
    // qualifying window, so a dominant fortnight can bank two belts.
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    let seasonWins = 0;
    const days = [...byDay.keys()];
    for (let i = 0; i < days.length; i++) {
      const windowDays = days.slice(i, i + 7);
      if (windowDays.length < 7) continue;
      const windowRounds = windowDays.flatMap((k) => byDay.get(k));
      if (windowRounds.length < 10) continue;
      const journaled = windowRounds.filter(hasThesis).length / windowRounds.length;
      if (journaled < 0.8) continue;
      const pts = windowRounds.map((r) => {
        const g = roundGrade(state, r);
        return g ? ({ S: 4, A: 3, B: 2, C: 1, D: 0, F: 0 }[g.letter] ?? null) : null;
      }).filter((p) => p !== null);
      if (!pts.length || pts.reduce((s, p) => s + p, 0) / pts.length < 2) continue;
      seasonWins += 1;
    }

    return [
      {
        id: 'gauntlet',
        label: 'The Gauntlet',
        detail: 'Ten straight rounds, each with a written thesis and no revenge entry. Break one rule and the run resets.',
        progress: gauntlet.current,
        target: 10,
        best: gauntlet.best,
        completions: gauntlet.completions,
      },
      {
        id: 'one-shot',
        label: 'One-Shot',
        detail: 'One entry, one exit for the whole day, capturing 50%+ of what the trade offered. A second round busts the day.',
        wins: oneShotWins,
        today: { rounds: todayRounds.length, verdict: oneShotToday },
      },
      {
        id: 'score-attack',
        label: 'Score Attack',
        detail: 'Average capture across 3+ closed rounds in one day. The high score is a day, not a lucky exit.',
        best: bestDay,
        today: {
          rounds: todayCaps.length,
          avg: todayCaps.length ? todayCaps.reduce((s, c) => s + c, 0) / todayCaps.length : null,
        },
      },
      {
        id: 'season',
        label: 'Trench Season',
        detail: 'A 7-day league over discipline, never profit: 10+ rounds, 80%+ journaled, avg grade B or better. Qualify and the belt is yours — the window stays open to raise the score.',
        wins: seasonWins,
        best: null,
      },
    ];
  }

  /**
   * Score the game session the user explicitly started (state.activeGame,
   * engine.startGame). Deliberately Date-free: only closedAt comparisons, so
   * the overlay HUD can call it inside its event-driven cache. The pointer
   * stays until the player ends it — a terminal status (won/failed/busted/
   * missed) keeps showing on the HUD until dismissed from the Game tab.
   */
  function gameSession(state, now) {
    const active = state && state.activeGame;
    if (!active || !active.id || !(num(active.startedAt) > 0)) return null;
    const { E } = deps();
    const startedAt = num(active.startedAt);
    const rounds = chronological(state)
      .filter((r) => num(r.closedAt) !== null && num(r.closedAt) >= startedAt);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));

    if (active.id === 'gauntlet') {
      let clean = 0;
      let broken = null;
      for (const r of rounds) {
        if (hasThesis(r) && !isRevengeEntry(state, r)) { clean += 1; }
        else { broken = !hasThesis(r) ? 'no thesis written' : 'revenge re-entry'; break; }
        if (clean >= 10) break;
      }
      const status = broken ? 'failed' : clean >= 10 ? 'won' : 'live';
      return {
        id: 'gauntlet', startedAt, rounds: rounds.length, status,
        progress: clean, target: 10,
        detail: broken || (status === 'won' ? 'ten clean rounds' : 'thesis written, no revenge'),
      };
    }

    if (active.id === 'one-shot') {
      let status = 'live';
      let capture = null;
      if (rounds.length === 1) {
        capture = captureOf(E, rounds[0]);
        status = capture !== null && capture >= 50 ? 'won' : 'missed';
      } else if (rounds.length > 1) {
        status = 'busted';
      }
      return {
        id: 'one-shot', startedAt, rounds: rounds.length, status,
        progress: Math.min(rounds.length, 1), target: 1,
        score: capture,
        detail: status === 'busted' ? 'second round busted the shot'
          : status === 'missed' ? 'under 50% captured'
            : status === 'won' ? `${capture.toFixed(0)}% captured` : 'one entry, one exit, 50%+',
      };
    }

    if (active.id === 'score-attack') {
      const caps = rounds.map((r) => captureOf(E, r)).filter((c) => c !== null);
      const avg = caps.length ? caps.reduce((s, c) => s + c, 0) / caps.length : null;
      return {
        id: 'score-attack', startedAt, rounds: rounds.length, status: 'live',
        progress: Math.min(caps.length, 3), target: 3,
        score: avg,
        detail: caps.length >= 3
          ? `${avg.toFixed(0)}% avg over ${caps.length}`
          : `${caps.length}/3 rounds banked${avg === null ? '' : ` · ${avg.toFixed(0)}% avg`}`,
      };
    }

    /* Trench Season (ROADMAP.md item 1): a 7-day opted-in league over
     * discipline, never PnL. Three gates — played (10+ rounds), journaled
     * (80%+ theses), graded (avg grade ≥ B). Broad-win design (Moomoo's
     * 150k→350k lesson): qualifying EARLY shows 'won' immediately — the
     * window stays open to raise the score, but the belt is already yours.
     * Timebox check uses the explicit `now` arg; the HUD cache may lag a
     * pure-time flip until the next storage event — the dashboard is the
     * surface that never lags. */
    if (active.id === 'season') {
      const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const windowEnd = startedAt + WINDOW_MS;
      const inWindow = rounds.filter((r) => num(r.closedAt) < windowEnd);
      const total = inWindow.length;
      const journaled = inWindow.filter(hasThesis).length;
      const coverage = total ? journaled / total : 0;
      const GRADE_POINTS = { S: 4, A: 3, B: 2, C: 1, D: 0, F: 0 };
      const grades = inWindow.map((r) => {
        const g = roundGrade(state, r);
        return g && GRADE_POINTS[g.letter] !== undefined ? GRADE_POINTS[g.letter] : null;
      }).filter((p) => p !== null);
      const avgGrade = grades.length ? grades.reduce((s, p) => s + p, 0) / grades.length : null;
      const gates = {
        played: total >= 10,
        journaled: coverage >= 0.8,
        graded: avgGrade !== null && avgGrade >= 2,
      };
      const nowTs = num(now) !== null ? num(now) : null;
      const windowClosed = nowTs !== null && nowTs >= windowEnd;
      let status = 'live';
      if (gates.played && gates.journaled && gates.graded) status = 'won';
      else if (windowClosed) status = 'missed';
      const gateBits = [
        `${total}/10 rounds`,
        `${Math.round(coverage * 100)}% journaled`,
        avgGrade === null ? 'no grades yet' : `avg ${avgGrade.toFixed(1)}`,
      ];
      return {
        id: 'season', startedAt, rounds: total, status,
        progress: Math.min(total, 10), target: 10,
        score: avgGrade,
        gates,
        detail: status === 'won'
          ? `season won — ${gateBits.join(' · ')}`
          : status === 'missed'
            ? `window closed — ${gateBits.join(' · ')}`
            : `${gateBits.join(' · ')} · ${Math.max(0, Math.ceil((windowEnd - (nowTs || startedAt)) / 86400000))}d left`,
      };
    }

    return null;
  }

  /** Longer-horizon discipline tracks. Days without trades never break a
   *  day-scoped run — a challenge must never nudge anyone into overtrading. */
  function challenges(state) {
    const { E, M } = deps();
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));

    // Journal Week: 7 consecutive TRADED days where every round has a thesis.
    let dayRun = 0;
    let dayBest = 0;
    let weekCompletions = 0;
    for (const [, dayRounds] of dayBuckets(rounds)) {
      if (dayRounds.every(hasThesis)) {
        dayRun += 1;
        if (dayRun > dayBest) dayBest = dayRun;
        if (dayRun >= 7) { weekCompletions += 1; dayRun = 0; }
      } else {
        dayRun = 0;
      }
    }

    const sweep = runsOver(rounds, (r) => {
      const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
      return !(exit && exit.roundTripped);
    }, 15);

    const snipers = rounds.filter((r) => {
      const c = captureOf(E, r);
      return c !== null && c >= 80;
    }).length;

    const cold = M ? M.stats(state).coldStreak : { length: 0, disciplined: null };

    return [
      {
        id: 'journal-week',
        label: 'Journal Week',
        detail: 'Seven traded days in a row where every round carries a written thesis. Quiet days don’t break the run — this is never a reason to force a trade.',
        progress: dayRun,
        target: 7,
        done: dayBest >= 7,
        completions: weekCompletions,
      },
      {
        id: 'clean-sweep',
        label: 'Clean Sweep',
        detail: 'Fifteen straight rounds without round-tripping a green position to red.',
        progress: sweep.current,
        target: 15,
        done: sweep.best >= 15,
        completions: sweep.completions,
      },
      {
        id: 'sniper-five',
        label: 'Sniper Five',
        detail: 'Five rounds capturing 80%+ of the move on offer.',
        progress: Math.min(snipers, 5),
        target: 5,
        done: snipers >= 5,
      },
      {
        id: 'cold-blooded',
        label: 'Cold Blood',
        detail: 'Survive a real losing streak (3+) without sizing up. Unlocked by adversity, not by volume.',
        progress: cold.length >= 3 && cold.disciplined === true ? 1 : 0,
        target: 1,
        done: cold.length >= 3 && cold.disciplined === true,
      },
    ];
  }

  const api = {
    roundGrade, streaks, rank, reps, badges, drills, games, challenges, gauntletRun,
    gameSession,
    isRevengeEntry,
    streakLadder, STREAK_TIERS,
    RANKS, GRADE_BANDS, REP_FULL_PER_DAY, REP_HALF_PER_DAY,
    REVENGE_WINDOW_MS, REVENGE_SIZE_RATIO,
  };

  if (typeof window !== 'undefined') window.PTGamify = api;
  if (typeof self !== 'undefined') self.PTGamify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
