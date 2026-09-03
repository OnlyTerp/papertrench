/* PaperTrench extension — Daily Spark (DELIGHT-MAP.md A2) client.
 *
 * A blind puzzle: the dashboard shows the day's chart up to the reveal
 * moment T, the player marks an entry (and an exit, or neither) INSIDE the
 * sixty minutes after T — the hour they never get to see — then gets a
 * process grade (S/A/B/C/D/F + tone axes). NEVER a PnL figure. The whole
 * point is the discipline of a call, not the money on it.
 *
 * How a pick is made: taps (or the +/- steppers) place minutes-after-T, so
 * every action the server receives is bar-aligned and inside its window by
 * construction. The wall-clock is never sent — the puzzle's tape is history,
 * and "now" has nothing to do with it.
 *
 * Two responsibilities, mirroring pnlcard.js:
 *   - pure helpers (sparkModel, planActions, chartGeom, revealModel,
 *     gradeErrorCopy) — no DOM, no canvas, behaviour-tested in test/.
 *   - renderSpark(el) — paints the puzzle and owns its interaction.
 *
 * The share card reuses the existing PTPnlCard painter via
 * sparkCardModel(): it ONLY paints the process-grade story, never a PnL.
 */
(() => {
  'use strict';

  const API = 'https://papertrench-api.onerobby.workers.dev';

  const MIN_MS = 60000;
  // The server grades exactly sixty one-minute bars after the cutoff
  // (core/spark.js AFTERMATH_BARS). The lane is that hour, drawn.
  const FUTURE_MIN = 60;

  const GRADE_STYLE = {
    S: { color: '#7C3AED', label: 'S — flawless read' },
    A: { color: '#34D399', label: 'A — strong read' },
    B: { color: '#6AA9FF', label: 'B — solid' },
    C: { color: '#FF9D45', label: 'C — sloppy' },
    D: { color: '#FF5F56', label: 'D — broke the rules' },
    F: { color: '#FF2D2D', label: 'F — no discipline' },
  };
  const TONE = {
    green: { color: '#34D399', label: 'good' },
    yellow: { color: '#FF9D45', label: 'okay' },
    red: { color: '#FF5F56', label: 'bad' },
  };
  const ENTRY_COLOR = '#34D399';
  const EXIT_COLOR = '#FFC24B';

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Compact price, same spirit as PTPnlCard.formatPrice. */
  function fmtPrice(value) {
    const price = num(value);
    if (!(price > 0)) return '—';
    if (price >= 0.001) return String(Number(price.toPrecision(6)));
    const exponent = Math.floor(Math.log10(price));
    const leadingZeros = -exponent - 1;
    if (leadingZeros < 4) return String(Number(price.toPrecision(4)));
    const significant = price / Math.pow(10, exponent);
    return '0.' + '0'.repeat(leadingZeros) + String(Number(significant.toFixed(3))).replace('.', '');
  }

  /** Normalize an OHLC array: finite numbers only, ascending by ts. */
  function normBars(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map((b) => ({
        ts: num(b && b.ts), o: num(b && b.o), h: num(b && b.h), l: num(b && b.l), c: num(b && b.c),
      }))
      .filter((b) => b.ts !== null && b.o !== null && b.h !== null && b.l !== null && b.c !== null)
      .sort((a, b) => a.ts - b.ts);
  }

  /** Pure: /api/spark/today payload -> display model. Returns null on any invalid shape. */
  function sparkModel(api) {
    if (!api || typeof api !== 'object') return null;
    if (!api.ok || !api.day || !api.mint || !api.tTs) return null;
    const bars = normBars(api.bars);
    if (!bars.length) return null;
    const last = bars[bars.length - 1];
    const first = bars[0];
    return {
      day: String(api.day),
      mint: String(api.mint),
      tTs: num(api.tTs),
      bars,
      lastClose: last.c,
      firstClose: first.c,
      changePct: first.c > 0 ? ((last.c - first.c) / first.c) * 100 : 0,
      dateText: new Date(num(api.tTs)).toISOString().slice(0, 10),
    };
  }

  /** Pure: grade response -> the aftermath the lane reveals. Null on bad shape. */
  function revealModel(api) {
    if (!api || typeof api !== 'object' || !api.ok) return null;
    const bars = normBars(api.reveal && api.reveal.bars);
    return bars.length ? { bars } : null;
  }

  /* ---------------- the plan (pure) ----------------
   *
   * A plan is { pass, entryMin, exitMin } — minutes AFTER the cutoff, 1..60.
   * Invariants: exit, when set, is strictly after entry; pass clears picks.
   * planActions() turns a plan into exactly the action list the server's
   * validateActions accepts: [{pass}] | [{buy}] | [{buy},{sell}].
   */
  function clampMinute(k) {
    return Math.max(1, Math.min(FUTURE_MIN, Math.round(Number(k) || 0)));
  }

  /** Place an entry; keeps the exit invariant (clamps it forward, or drops
   * it when an entry on the last minute leaves no legal exit after it). */
  function planWithEntry(plan, minute) {
    const entryMin = clampMinute(minute);
    const next = { pass: false, entryMin, exitMin: plan.exitMin };
    if (next.exitMin !== null && next.exitMin <= entryMin) {
      next.exitMin = entryMin < FUTURE_MIN ? entryMin + 1 : null;
    }
    return next;
  }

  /** Place an exit; ignored (null) when there is no entry to exit from, or
   * when the entry is on the last minute — there is no legal later exit. */
  function planWithExit(plan, minute) {
    if (plan.entryMin === null) return null;
    if (plan.entryMin >= FUTURE_MIN) return null;
    const exitMin = clampMinute(Math.max(minute, plan.entryMin + 1));
    return { pass: false, entryMin: plan.entryMin, exitMin };
  }

  /** The action list for the grader, or null when the plan has nothing to send. */
  function planActions(plan, tTs) {
    if (!plan || !Number.isFinite(tTs)) return null;
    if (plan.pass) return [{ type: 'pass', ts: tTs + MIN_MS }];
    if (plan.entryMin === null) return null;
    const actions = [{ type: 'buy', ts: tTs + plan.entryMin * MIN_MS }];
    if (plan.exitMin !== null) actions.push({ type: 'sell', ts: tTs + plan.exitMin * MIN_MS });
    return actions;
  }

  /* ---------------- geometry (pure) ----------------
   *
   * One continuous time axis: the cutoff T sits at 3/4 of the width, the
   * unknown hour fills the rest. Drawing, hit-testing and markers all read
   * the same geom, so a tap and its marker can never disagree.
   */
  function chartGeom(w, h, nBars) {
    const pad = 8;
    // The lane is the PLAYING FIELD — every tap the game accepts lands in it,
    // and it has to hold sixty distinct minutes. At a quarter of the width it
    // was ~2.5px per minute on the shipped canvas: placing a specific minute
    // meant nudging with the steppers because the tap could not be aimed.
    // Giving it over a third makes the target real, and it also stops the
    // board reading as "a chart, with a sliver of something at the end".
    const laneFrac = 0.38;
    const tX = pad + (w - pad * 2) * (1 - laneFrac);
    return {
      w, h, pad, tX,
      minuteX: (k) => tX + (k / FUTURE_MIN) * (w - pad - tX),
    };
  }

  /** Canvas x -> minute after the cutoff (1..60), or null when the tap fell
   * on the seen tape (left of the line) where there is nothing to place. */
  function xToMinute(px, geom) {
    const rel = (px - geom.tX) / (geom.w - geom.pad - geom.tX);
    if (rel < 0) return null;
    return clampMinute(rel * FUTURE_MIN);
  }

  /** Price range over seen bars plus aftermath (when revealed) for one y axis. */
  function priceRange(bars, aftermath) {
    let min = Infinity;
    let max = -Infinity;
    for (const b of bars) {
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
    }
    for (const b of aftermath || []) {
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
    return { min, max: max === min ? min + 1 : max };
  }

  /* ---------------- error copy (pure) ---------------- */

  const GRADE_ERROR = {
    'wrong-day': "This puzzle has ended — a new day's chart is live. Reload the dashboard to play today's.",
    'no-data': "The grader couldn't load today's chart. Try again in a minute.",
    'no-window': "This puzzle has ended — reload the dashboard for today's chart.",
    'rate-limited': "Too many grades in a row — wait a minute and try again.",
    'busy': "The grader is busy right now — try again in a moment.",
  };
  // Everything the validator can throw at a well-formed plan means the picks
  // and the window disagreed — one sentence covers them all.
  const PLAN_MISMATCH = "Your picks didn't line up with the puzzle's window — start over and place them again.";
  const NETWORK_ERROR = "Couldn't reach the grader — check your connection and try again.";
  const FALLBACK_ERROR = "Couldn't grade just now — try again in a moment.";

  function gradeErrorCopy(reason) {
    if (reason === 'network') return NETWORK_ERROR;
    if (GRADE_ERROR[reason]) return GRADE_ERROR[reason];
    if (['bad-action', 'action-out-of-window', 'empty', 'pass-not-alone', 'must-open', 'must-close', 'too-many', 'non-monotonic'].includes(reason)) {
      return PLAN_MISMATCH;
    }
    return FALLBACK_ERROR;
  }

  /** The share-card model: process-grade story ONLY, never a PnL figure. */
  function sparkCardModel(verdict, day) {
    if (!verdict || typeof verdict !== 'object') return null;
    const grade = String(verdict.grade || '').toUpperCase();
    if (!GRADE_STYLE[grade]) return null;
    const style = GRADE_STYLE[grade];
    const axes = Array.isArray(verdict.axes) ? verdict.axes : [];
    const axisLine = axes
      .map((a) => {
        const tone = TONE[a.tone] || TONE.green;
        return `${a.label}: ${tone.label}`;
      })
      .join(' · ');
    return {
      kind: 'spark',
      grade,
      gradeColor: style.color,
      gradeLabel: style.label,
      axisLine,
      day: String(day || ''),
      story: typeof verdict.story === 'string' ? verdict.story : '',
      handle: '',
    };
  }

  /* ---------------- rendering ---------------- */

  /** A fresh practice-seed: any 31-bit number; the server pins a puzzle to
   * it, so the same number is always the same chart. */
  function practiceSeed() {
    return Math.floor(Math.random() * 2 ** 31);
  }

  /** Fetch a practice puzzle for `seed` and render it over the section.
   * Self-contained so BOTH the practice button and the daily view's
   * load-failure fallback can offer a round without the dashboard mount
   * knowing practice exists. Returns a promise for testability. */
  async function loadPractice(el, seed) {
    const s = Number.isInteger(seed) ? seed : practiceSeed();
    try {
      const res = await fetch(API + '/api/spark/practice?seed=' + s, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        throw Object.assign(new Error((body && body.reason) || 'HTTP ' + res.status), {
          sparkReason: (body && body.reason) || 'HTTP ' + res.status,
        });
      }
      const model = sparkModel(body);
      if (!model) throw new Error('bad-payload');
      renderSpark(el, model, { practice: true });
    } catch (err) {
      console.warn('PaperTrench: spark practice failed —', err && err.sparkReason ? err.sparkReason : err);
      if (el) {
        // "Try again in a moment" is only true for a TRANSIENT failure. When
        // the grader answers 404/not-found the practice route is not there to
        // be retried — the server is older than this build — and inviting a
        // retry that can never work is how a broken feature reads as a flaky
        // one. Say which it is, and only offer the retry when retrying can
        // actually change the answer.
        const reason = String((err && err.sparkReason) || '');
        const missing = /404|not-found/.test(reason);
        el.innerHTML = missing
          ? '<p class="spark-error">Practice rounds aren\'t available on the server yet — '
            + 'today\'s puzzle still works. <button type="button" class="linkish" '
            + 'id="spark-practice-retry">Check again</button></p>'
          : '<p class="spark-error">Couldn\'t load a practice round — the grader didn\'t answer. '
            + '<button type="button" class="linkish" id="spark-practice-retry">Try again</button></p>';
        const retry = el.querySelector('#spark-practice-retry');
        if (retry) retry.addEventListener('click', () => loadPractice(el));
      }
    }
  }

  /** Render the spark section into `el` (a #spark-section container).
   * opts.practice marks a practice round: the seed becomes the headline and
   * the loop button reads NEXT PUZZLE. */
  function renderSpark(el, model, opts) {
    if (!el || !model) return;
    const practice = !!(opts && opts.practice);
    el.innerHTML = '';
    const stage = document.createElement('div');
    stage.className = 'spark-stage';
    el.appendChild(stage);

    const head = document.createElement('div');
    head.className = 'spark-head';
    head.innerHTML = `
      <div class="spark-title">${practice ? 'Practice Round' : 'Daily Spark'}</div>
      <div class="spark-date"><span class="dot"></span>${practice
        ? 'Seed ' + String(model.day).replace(/^practice-/, '')
        : model.dateText}</div>
    `;
    stage.appendChild(head);

    // One sentence. The step rail below teaches the rest, in the order it is
    // needed — the old paragraph explained the whole game up front and was
    // the first thing standing between a player and the board.
    const about = document.createElement('p');
    about.className = 'spark-about';
    about.innerHTML = practice
      ? 'A real launch with its name hidden. Guess <b>when you\'d buy</b> — and when you\'d sell — in the hour the chart doesn\'t show you.'
      : 'One real launch a day, name hidden. Guess <b>when you\'d buy</b> — and when you\'d sell — in the hour the chart doesn\'t show you.';
    stage.appendChild(about);

    // The wait people fear does not exist: the tape is history the server
    // already holds, so the grade is one request away. Saying so here is the
    // difference between a daily puzzle and a daily errand.
    const instant = document.createElement('div');
    instant.style.textAlign = 'center';
    instant.innerHTML = '<span class="spark-instant">'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">'
      + '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>'
      + 'Graded the moment you commit — no waiting</span>';
    stage.appendChild(instant);

    const body = document.createElement('div');
    body.className = 'spark-body';
    body.innerHTML = `
      <div class="spark-steps">
        <div class="spark-step" data-step="1"><span class="n">1</span><span>Pick your buy</span></div>
        <div class="spark-step" data-step="2"><span class="n">2</span><span>Pick your sell <span style="opacity:.65">(optional)</span></span></div>
        <div class="spark-step" data-step="3"><span class="n">3</span><span>See your grade</span></div>
      </div>
      <div class="spark-chart">
        <canvas class="spark-canvas" width="1120" height="420" role="img"></canvas>
        <div class="spark-chart-legend">
          <span class="spark-legend-item"><i style="background:${TONE.green.color}"></i> your buy</span>
          <span class="spark-legend-item"><i style="background:${EXIT_COLOR}"></i> your sell</span>
          <span class="spark-legend-item"><i class="spark-lane-key"></i> the hidden hour — tap in here</span>
        </div>
      </div>
      <p class="spark-hint" role="status" aria-live="polite"></p>
      <div class="spark-picks"></div>
      <div class="spark-actions">
        <button type="button" class="spark-btn primary spark-reveal" disabled>SEE MY GRADE</button>
        <button type="button" class="spark-btn spark-pass">I'd skip this one</button>
        <button type="button" class="spark-btn spark-reset" hidden>Play again</button>
        <button type="button" class="spark-btn spark-practice" title="${practice ? 'Another random blind chart' : 'Unlimited rounds on random blind charts'}">${practice ? 'New puzzle' : 'Practice round'}</button>
      </div>
      <p class="spark-error" hidden></p>
      <div class="spark-verdict" hidden></div>
    `;
    stage.appendChild(body);

    const canvas = body.querySelector('.spark-canvas');
    const hintEl = body.querySelector('.spark-hint');
    const picksEl = body.querySelector('.spark-picks');
    const passBtn = body.querySelector('.spark-pass');
    const resetBtn = body.querySelector('.spark-reset');
    const revealBtn = body.querySelector('.spark-reveal');
    const practiceBtn = body.querySelector('.spark-practice');
    const errorEl = body.querySelector('.spark-error');
    const verdictBox = body.querySelector('.spark-verdict');

    const geom = chartGeom(canvas.width, canvas.height, model.bars.length);
    let plan = { pass: false, entryMin: null, exitMin: null };
    let aftermath = null; // bars revealed with the verdict
    let locked = false;   // the round is committed; picks are final

    const paint = () => {
      drawChart(canvas, model.bars, model.tTs, {
        futureMin: FUTURE_MIN,
        aftermath: aftermath ? aftermath.bars : null,
        entryMin: plan.entryMin,
        exitMin: plan.exitMin,
      });
      const label = `Blind chart: ${model.bars.length} one-minute candles ending at the cutoff line. `
        + `The shaded lane is the next ${FUTURE_MIN} minutes.`
        + (plan.pass ? ' You chose to sit this one out.'
          : plan.entryMin === null ? ''
            : ` Entry ${plan.entryMin} minutes after the cutoff.`
              + (plan.exitMin === null ? ' Holding to the end of the window.' : ` Exit ${plan.exitMin} minutes after the cutoff.`));
      canvas.setAttribute('aria-label', label);
    };

    const hintFor = () => {
      if (aftermath) return 'That\'s the hour you couldn\'t see — your call was graded against exactly this tape.';
      if (plan.pass) return 'You\'re skipping this one. Hit SEE MY GRADE to find out whether that was the right call.';
      if (plan.entryMin === null) return 'Tap anywhere in the shaded lane — that\'s the hidden hour. Where would you have bought?';
      if (plan.exitMin === null) return `Buying ${plan.entryMin} min in. Now tap where you'd sell — or just hit SEE MY GRADE to hold to the end.`;
      return `Buy at +${plan.entryMin} min, sell at +${plan.exitMin} min. Tap near a marker to move it.`;
    };

    /* Committed state, held as DATA rather than applied once.
     *
     * setLocked used to disable the controls directly, and every later sync()
     * put them straight back: sync() rebuilds the pick rows from scratch, so
     * the fresh +/-/x buttons came back enabled, and the grade handler's
     * `finally` re-enabled the reveal button after setLocked(true) had just
     * disabled it. The round was therefore never actually committed — you
     * could nudge an entry after seeing the grade and re-reveal, fishing for
     * a better one. Keeping it as state and applying it at the END of sync
     * is what makes "committed" mean committed. */
    const setLocked = (value) => { locked = value; };
    const applyLock = () => {
      // The practice button is deliberately NOT locked: the loop is the
      // feature — a verdict never traps the player, another round is always
      // one click away.
      for (const b of [passBtn, ...picksEl.querySelectorAll('button')]) b.disabled = locked;
      if (locked) revealBtn.disabled = true;
      resetBtn.hidden = !locked;
    };

    const renderPicks = () => {
      picksEl.innerHTML = '';
      const mkRow = (name, color, minute, onNudge, onClear) => {
        const row = document.createElement('div');
        row.className = 'spark-pick';
        row.innerHTML = `
          <span class="spark-pick-name"><i style="background:${color}"></i> ${name}</span>
          <span class="spark-pick-min">+${minute} min</span>
          <span class="spark-pick-ctl">
            <button type="button" aria-label="${name} one minute earlier" title="One minute earlier">−</button>
            <button type="button" aria-label="${name} one minute later" title="One minute later">+</button>
            <button type="button" aria-label="Clear ${name.toLowerCase()}" title="Clear">×</button>
          </span>`;
        const [minus, plus, clear] = row.querySelectorAll('button');
        minus.addEventListener('click', () => onNudge(-1));
        plus.addEventListener('click', () => onNudge(1));
        clear.addEventListener('click', onClear);
        return row;
      };
      if (plan.pass) {
        const row = document.createElement('div');
        row.className = 'spark-pick';
        row.innerHTML = '<span class="spark-pick-name"><i style="background:#8b93a7"></i> Skipping</span>'
          + '<span class="spark-pick-min">no trade</span>';
        picksEl.appendChild(row);
        return;
      }
      if (plan.entryMin !== null) {
        picksEl.appendChild(mkRow('Buy', ENTRY_COLOR, plan.entryMin, (d) => {
          plan = plan.entryMin + d >= 1
            ? planWithEntry(plan, plan.entryMin + d)
            : plan;
          sync();
        }, () => { plan = { ...plan, entryMin: null, exitMin: null }; sync(); }));
      }
      if (plan.exitMin !== null) {
        picksEl.appendChild(mkRow('Sell', EXIT_COLOR, plan.exitMin, (d) => {
          const next = planWithExit(plan, plan.exitMin + d);
          if (next && next.exitMin > plan.entryMin) { plan = next; sync(); }
        }, () => { plan = { ...plan, exitMin: null }; sync(); }));
      }
    };

    /* Which step the player is actually on, so the rail says where they are
     * rather than lighting everything at once. A pass skips straight to the
     * commit — sitting out IS a complete answer. */
    const syncSteps = () => {
      const steps = body.querySelectorAll('.spark-step');
      const state = aftermath ? 'done'
        : plan.pass ? 'commit'
          : plan.entryMin === null ? 'entry'
            : plan.exitMin === null ? 'exit' : 'commit';
      const at = { entry: 1, exit: 2, commit: 3, done: 4 }[state];
      steps.forEach((s) => {
        const n = Number(s.dataset.step);
        s.classList.toggle('on', n === at);
        s.classList.toggle('done', n < at);
      });
    };

    const sync = () => {
      passBtn.classList.toggle('armed', plan.pass);
      const ready = plan.pass || plan.entryMin !== null;
      revealBtn.disabled = !ready;
      // A disabled control that will not say what it wants is a dead end.
      revealBtn.title = ready
        ? 'Grade this call now'
        : 'Tap the shaded lane to pick your buy first — or choose "I\'d skip this one"';
      hintEl.textContent = hintFor();
      renderPicks();
      syncSteps();
      paint();
      // Last: renderPicks() has just built fresh controls, so the lock has to
      // be applied after them or a committed round hands back live steppers.
      applyLock();
    };

    canvas.addEventListener('click', (e) => {
      if (aftermath) return;
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const minute = xToMinute(px, geom);
      if (minute === null) {
        hintEl.textContent = 'Pick a spot in the shaded lane — right of the line. That hour is the puzzle.';
        return;
      }
      if (plan.pass) plan = { pass: false, entryMin: null, exitMin: null };
      if (plan.entryMin === null) {
        plan = planWithEntry(plan, minute);
      } else if (plan.exitMin === null) {
        const next = planWithExit(plan, minute);
        if (!next) { sync(); return; }
        plan = next;
      } else {
        // Move whichever marker the tap landed nearest.
        const dEntry = Math.abs(minute - plan.entryMin);
        const dExit = Math.abs(minute - plan.exitMin);
        plan = dEntry <= dExit ? planWithEntry(plan, minute) : (planWithExit(plan, minute) || plan);
      }
      sync();
    });

    passBtn.addEventListener('click', () => {
      if (plan.pass) { plan = { pass: false, entryMin: null, exitMin: null }; } // toggle off
      else plan = { pass: true, entryMin: null, exitMin: null };
      sync();
    });

    resetBtn.addEventListener('click', () => {
      plan = { pass: false, entryMin: null, exitMin: null };
      aftermath = null;
      verdictBox.hidden = true;
      verdictBox.innerHTML = '';
      errorEl.hidden = true;
      setLocked(false);
      revealBtn.textContent = 'SEE MY GRADE';
      sync();
    });

    practiceBtn.addEventListener('click', () => loadPractice(el));

    revealBtn.addEventListener('click', async () => {
      const actions = planActions(plan, model.tTs);
      if (!actions) return;
      errorEl.hidden = true;
      revealBtn.disabled = true;
      revealBtn.textContent = 'GRADING…';
      try {
        const res = await fetch(API + '/api/spark/grade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: model.day, mint: model.mint, actions }),
        });
        const bodyJson = await res.json().catch(() => null);
        if (!res.ok || !bodyJson || !bodyJson.ok) {
          throw Object.assign(new Error((bodyJson && bodyJson.reason) || 'HTTP ' + res.status), {
            sparkReason: (bodyJson && bodyJson.reason) || 'HTTP ' + res.status,
          });
        }
        const card = sparkCardModel(bodyJson.verdict, bodyJson.day);
        if (!card) throw new Error('unexpected verdict shape');
        aftermath = revealModel(bodyJson);
        setLocked(true);
        showVerdict(verdictBox, card);
        sync();
      } catch (err) {
        // The raw reason is for the console; the sentence is for the human.
        console.warn('PaperTrench: spark grade failed —', err && err.sparkReason ? err.sparkReason : err);
        const isNetwork = err instanceof TypeError;
        errorEl.textContent = gradeErrorCopy(isNetwork ? 'network' : (err && err.sparkReason) || '');
        errorEl.hidden = false;
      } finally {
        // Restore the label, then let sync() decide whether the button may be
        // pressed again. Forcing `disabled = false` here is what un-committed
        // a graded round: a failed grade must be retryable, a successful one
        // must not, and only the lock knows which happened.
        revealBtn.textContent = 'SEE MY GRADE';
        sync();
      }
    });

    sync();
  }

  /** Draw the blind chart: candles up to T, the unknown-hour lane after it.
   * opts: { futureMin, aftermath (bars revealed with the verdict),
   * entryMin, exitMin } — markers and lane draw only when asked for. */
  function drawChart(canvas, bars, tTs, opts) {
    if (!canvas || !bars || !bars.length) return;
    const o = opts || {};
    const futureMin = o.futureMin || 0;
    const aftermath = o.aftermath || null;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const geom = chartGeom(W, H, bars.length);
    const { min, max } = priceRange(bars, aftermath);
    const span = max - min || 1;
    const pad = geom.pad;
    const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);
    const xTs = (ts) => geom.minuteX((ts - tTs) / MIN_MS);

    ctx.clearRect(0, 0, W, H);
    // Grid across the whole width, lane included — one chart, not two.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 5; g++) {
      const gy = pad + (g / 4) * (H - pad * 2);
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(W - pad, gy);
      ctx.stroke();
    }

    // The unknown hour: shaded, empty until the verdict hands over its bars.
    if (futureMin > 0) {
      ctx.fillStyle = 'rgba(255,157,69,0.05)';
      ctx.fillRect(geom.tX, pad, W - pad - geom.tX, H - pad * 2);
    }

    const drawCandle = (x, b, alpha) => {
      const color = b.c >= b.o ? 'rgba(52,211,153,0.85)' : 'rgba(255,95,86,0.85)';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y(b.h));
      ctx.lineTo(x, y(b.l));
      ctx.stroke();
      const bw = Math.max(2, ((geom.tX - pad) / bars.length) * 0.6);
      const bodyTop = y(Math.max(b.o, b.c));
      const bodyBottom = y(Math.min(b.o, b.c));
      ctx.fillRect(x - bw / 2, bodyTop, bw, Math.max(1, bodyBottom - bodyTop));
      ctx.globalAlpha = 1;
    };
    for (const b of bars) drawCandle(xTs(b.ts), b, 1);
    if (aftermath) for (const b of aftermath) drawCandle(xTs(b.ts), b, 0.45);

    // The cutoff line at T.
    ctx.strokeStyle = 'rgba(255,157,69,0.9)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(geom.tX, pad);
    ctx.lineTo(geom.tX, H - pad);
    ctx.stroke();
    ctx.setLineDash([]);

    // Markers: dotted drop-lines in the lane, triangles on the baseline.
    const marker = (k, color, up) => {
      const x = geom.minuteX(k);
      ctx.strokeStyle = color;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, H - pad);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath();
      const by = up ? H - pad - 2 : pad + 2;
      if (up) {
        ctx.moveTo(x, by - 8);
        ctx.lineTo(x - 5, by);
        ctx.lineTo(x + 5, by);
      } else {
        ctx.moveTo(x, by + 8);
        ctx.lineTo(x - 5, by);
        ctx.lineTo(x + 5, by);
      }
      ctx.closePath();
      ctx.fill();
      ctx.font = '600 11px ui-monospace, Menlo, monospace';
      ctx.fillStyle = 'rgba(234,239,247,0.9)';
      ctx.textAlign = 'center';
      ctx.fillText('+' + k + 'm', x, up ? by - 12 : by + 20);
      ctx.textAlign = 'left';
    };
    if (o.entryMin != null) marker(o.entryMin, ENTRY_COLOR, true);
    if (o.exitMin != null) marker(o.exitMin, EXIT_COLOR, false);

    // Last seen close, bottom-right of the SEEN tape (not the lane).
    const last = bars[bars.length - 1];
    ctx.fillStyle = 'rgba(234,239,247,0.9)';
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillText(fmtPrice(last.c), geom.tX - 70, H - pad - 4);
  }

  /** Show the verdict card in the section. */
  function showVerdict(box, card) {
    box.hidden = false;
    box.innerHTML = `
      <div class="spark-grade" style="color:${card.gradeColor}">${card.grade}</div>
      <div class="spark-grade-label">${card.gradeLabel}</div>
      <div class="spark-axis-line">${card.axisLine}</div>
      ${card.story ? `<div class="spark-story">${card.story}</div>` : ''}
      <div class="spark-share-row">
        <button type="button" class="spark-btn spark-share">SHARE CARD</button>
      </div>
    `;
    const share = box.querySelector('.spark-share');
    if (share) {
      share.addEventListener('click', () => {
        // The painter owns the canvas (pnlcard.js drawSeasonCard-style).
        // sparkCardModel() above is what the painter consumes; a dashboard
        // hook wires it to the share flow. Nothing here touches PnL.
        if (typeof window !== 'undefined' && window.PTPnlCard && window.PTPnlCard.drawSparkCard) {
          window.PTPnlCard.drawSparkCard(card);
        }
      });
    }
  }

  const api = {
    API,
    GRADE_STYLE,
    TONE,
    FUTURE_MIN,
    sparkModel,
    revealModel,
    sparkCardModel,
    planWithEntry,
    planWithExit,
    planActions,
    chartGeom,
    xToMinute,
    gradeErrorCopy,
    practiceSeed,
    loadPractice,
    renderSpark,
    drawChart,
    fmtPrice,
  };

  if (typeof window !== 'undefined') window.PTSpark = api;
  if (typeof self !== 'undefined') self.PTSpark = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
