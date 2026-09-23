/* PaperTrench — /tournament.
 *
 * Two modes on one page:
 *   /tournament          — the directory: open + live brackets, and the
 *                          create form for a signed-in trader.
 *   /tournament?id=CODE  — one bracket: live standings polled every 8s,
 *                          a round-boundary clock folded from the server's
 *                          own timestamps, an elimination log, and the
 *                          spectate card behind any row click.
 *
 * The honesty rules carry over verbatim from arena.js: every number came
 * from the server or it is not rendered. Tournament P&L is recomputed from
 * server-stored chains whose fills passed independent re-pricing; the live
 * board is provisional until a boundary settles. Unreachable says unreachable;
 * a bracket that has not started says so rather than counting down to a guess.
 */
(() => {
  'use strict';
  const L = window.PTArena;
  const { esc, fmt, signed, dirClass, face, ago } = L;

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const CODE = params.get('id') || params.get('code') || '';

  const POLL_MS = 8000;
  const HOUR = 3600000;
  const DAY = 86400000;

  const boardEl = $('board');
  const boardStatusEl = $('board-status');
  const youEl = $('your-seat');
  const dirEl = $('directory');
  const dirStatusEl = $('dir-status');
  const elimPane = $('elim-pane');
  const elimEl = $('elim-list');
  const roundsPane = $('rounds-pane');
  const roundsEl = $('rounds-list');
  const specPane = $('spectate-pane');
  const specBody = $('spectate-body');
  const createPane = $('create-pane');
  const createBody = $('create-body');

  const segEls = { d: $('cd-d'), h: $('cd-h'), m: $('cd-m'), s: $('cd-s') };
  const clockEl = $('clock');
  const barEl = $('window-bar');
  const fillEl = $('window-fill');
  const captionEl = $('clock-caption');

  /* ------------------------------------------------------------- clock --- */

  let ticker = null;
  let lastCaption = '';
  let lastPercent = -1;
  // The board payload carries serverTime; the clock runs on the SERVER's
  // clock, so a visitor whose OS clock is off still sees the true boundary.
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;

  const pad = (n) => String(n).padStart(2, '0');

  function caption(text) {
    if (text === lastCaption) return;
    lastCaption = text;
    captionEl.textContent = text;
  }

  function stopClock() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  /** Count down to `endTs`, with `startTs`..`endTs` the window's full span. */
  function startClock(startTs, endTs, label) {
    const span = endTs - startTs;
    if (!Number.isFinite(span) || span <= 0) return;
    stopClock();
    barEl.hidden = false;

    const tick = () => {
      const left = endTs - now();
      if (left <= 0) {
        // The boundary passed while the page was open — the next poll brings
        // the new round; until then say the cut is landing, not that the
        // bracket ended.
        stopClock();
        segEls.d.textContent = '0';
        segEls.h.textContent = '00';
        segEls.m.textContent = '00';
        segEls.s.textContent = '00';
        clockEl.classList.remove('urgent');
        fillEl.style.width = '100%';
        barEl.setAttribute('aria-valuenow', '100');
        caption('The boundary is settling — the board refreshes with the new round in a few seconds.');
        return;
      }
      const d = Math.floor(left / DAY);
      const h = Math.floor((left % DAY) / HOUR);
      const m = Math.floor((left % HOUR) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      segEls.d.textContent = String(d);
      segEls.h.textContent = pad(h);
      segEls.m.textContent = pad(m);
      segEls.s.textContent = pad(s);
      clockEl.classList.toggle('urgent', left < HOUR);
      clockEl.setAttribute('aria-label',
        d + ' days, ' + h + ' hours, ' + m + ' minutes and ' + s + ' seconds ' + label);
      const percent = Math.min(100, Math.max(0, ((now() - startTs) / span) * 100));
      fillEl.style.width = percent.toFixed(2) + '%';
      const rounded = Math.round(percent);
      if (rounded !== lastPercent) {
        lastPercent = rounded;
        barEl.setAttribute('aria-valuenow', String(rounded));
      }
    };
    tick();
    ticker = setInterval(tick, 1000);
  }

  /** A clock that is not running a boundary: open, done, or cancelled. */
  function idleClock(text) {
    stopClock();
    barEl.hidden = true;
    segEls.d.textContent = '—';
    segEls.h.textContent = '—';
    segEls.m.textContent = '—';
    segEls.s.textContent = '—';
    clockEl.classList.remove('urgent');
    clockEl.setAttribute('aria-label', text);
    caption(text);
  }

  /* ----------------------------------------------------------- helpers --- */

  const fmtClock = (ms) => {
    if (!Number.isFinite(ms)) return '—';
    if (ms >= DAY) return fmt(ms / DAY, 1) + 'd';
    if (ms >= HOUR) return fmt(ms / HOUR, 1) + 'h';
    return fmt(ms / 60000, 0) + 'm';
  };

  function statusChip(t) {
    if (t.status === 'live') return '<span class="ar-chip alive">Live · R' + esc(t.currentRound) + '</span>';
    if (t.status === 'open') return '<span class="ar-chip waiting">Open</span>';
    if (t.status === 'done') return '<span class="ar-chip verified">Final</span>';
    return '<span class="ar-chip rejected">Cancelled</span>';
  }

  function seatChip(row) {
    const cut = !row.alive
      ? '<span class="ar-chip cut" title="Eliminated at the round ' +
        esc(row.eliminatedRound) + ' boundary">Cut R' + esc(row.eliminatedRound) + '</span>'
      : '<span class="ar-chip alive">In</span>';
    const finality = row.finality === 'final' ? 'final'
      : row.finality === 'forfeited' ? 'forfeited' : 'provisional';
    const label = finality === 'final' ? 'Final'
      : finality === 'forfeited' ? 'Forfeited' : 'Provisional';
    const title = finality === 'forfeited'
      ? (row.verified
        ? 'No post-boundary verified chain; the provisional entry only breaks non-final ties'
        : 'No post-boundary verified chain is available')
      : row.verified ? label + ' verified-chain entry'
        : label + ' — no verified submission is available';
    const unpriced = row.unpricedOpenPosition
      ? '<span class="ar-chip waiting" title="An open position had no independent candle at the bell; it was valued at gross cost">Unpriced open position</span>'
      : '';
    return cut + '<span class="ar-chip ' + (finality === 'final' ? 'verified'
      : finality === 'forfeited' ? 'rejected' : 'waiting') + '" title="' + esc(title) + '">' +
      label + '</span>' + unpriced;
  }

  /* --------------------------------------------------------- directory --- */

  function dirRow(t) {
    const seats = fmt(t.entrantCount, 0) + '/' + fmt(t.fieldSize, 0);
    const when = t.status === 'live'
      ? 'round ' + fmt(t.currentRound, 0)
      : t.status === 'open'
        ? (t.startWhenFull ? 'starts when full' : 'starts ' + new Date(t.startTs).toUTCString().slice(5, 22) + ' UTC')
        : t.status === 'done' ? 'finished' : 'cancelled';
    return `<a class="ar-titem" href="/tournament?id=${encodeURIComponent(t.code)}">
      <span style="min-width:0">
        <span class="tname">${esc(t.name)}</span>
        <span class="tmeta">${fmt(t.startStackSol, 1)} ◎ stack · ${fmtClock(t.roundMs)} rounds · cut ${fmt(t.cutPerRound, 0)}</span>
      </span>
      <span class="tseats">${statusChip(t)}</span>
      <span class="tright">${esc(seats)}<br>seats</span>
      <span class="tright">${esc(when)}</span>
    </a>`;
  }

  async function loadDirectory(session) {
    $('directory-pane').hidden = false;
    dirEl.innerHTML = L.skeleton(4);
    let body = null;
    try { body = await L.getOrThrow('/api/tournaments'); } catch { body = null; }
    if (!body || !Array.isArray(body.tournaments)) {
      dirEl.innerHTML = L.errorState(
        'The tournament server is unreachable, so no brackets are shown. Nothing here is cached or guessed.');
      dirStatusEl.textContent = 'Tournaments unavailable — the server could not be reached.';
      return;
    }
    const list = body.tournaments;
    if (!list.length) {
      dirEl.innerHTML = L.empty('🏆',
        'No tournaments yet.',
        'The first bracket has not been run. Sign in with X and start one — you set the field, the stack, the round length and the cut, and the server runs the clock.');
      dirStatusEl.textContent = 'No tournaments on record.';
    } else {
      dirEl.innerHTML = list.map(dirRow).join('');
      dirStatusEl.textContent = fmt(list.length, 0) + ' on the board · ' +
        fmt(list.filter((t) => t.status === 'live').length, 0) + ' live';
    }
    renderCreate(session);
  }

  /* ------------------------------------------------------------ create --- */

  function renderCreate(session) {
    if (!session || !session.signedIn) {
      createPane.hidden = true;
      return;
    }
    createPane.hidden = false;
    createBody.innerHTML = `
      <form class="ar-form" id="create-form">
        <label>Tournament name
          <input name="name" required minlength="3" maxlength="60" placeholder="Friday Night Trench">
        </label>
        <div class="frow">
          <label>Field size <small>seats, 4–250</small>
            <input name="fieldSize" type="number" min="4" max="250" value="25">
          </label>
          <label>Start stack <small>paper ◎ per seat</small>
            <input name="startStackSol" type="number" min="0.1" max="10000" step="0.1" value="10">
          </label>
        </div>
        <div class="frow">
          <label>Round length <small>hours per round</small>
            <input name="roundHours" type="number" min="1" max="168" step="1" value="24">
          </label>
          <label>Cut per round <small>eliminated at each boundary</small>
            <input name="cutPerRound" type="number" min="1" max="249" value="5">
          </label>
        </div>
        <div class="frow">
          <label>Prize pool <small>declared ◎, optional — payout is manual</small>
            <input name="prizePoolSol" type="number" min="0" step="0.01" placeholder="—">
          </label>
          <label>Start time <small>blank = starts when the field fills</small>
            <input name="startTs" type="datetime-local">
          </label>
        </div>
        <p class="ar-note">Prizes pay 50/30/20 down the final order. You hold seat one;
          leaving before the start cancels the bracket.</p>
        <button class="ar-btn primary" type="submit">Create tournament</button>
        <p class="ar-note" id="create-status" aria-live="polite"></p>
      </form>`;
    $('create-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const status = $('create-status');
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      status.textContent = 'Creating…';
      const startRaw = form.startTs.value;
      const payload = {
        name: form.name.value,
        fieldSize: Number(form.fieldSize.value),
        startStackSol: Number(form.startStackSol.value),
        roundHours: Number(form.roundHours.value),
        cutPerRound: Number(form.cutPerRound.value),
      };
      if (form.prizePoolSol.value !== '') payload.prizePoolSol = Number(form.prizePoolSol.value);
      if (startRaw) payload.startTs = new Date(startRaw).getTime();
      let result;
      try {
        result = await L.api('/api/tournament/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch {
        result = { status: 0, body: null };
      }
      btn.disabled = false;
      if (result.status === 200 && result.body && result.body.ok) {
        window.location.href = '/tournament?id=' + encodeURIComponent(result.body.code);
        return;
      }
      const reason = result.body && result.body.reason;
      status.textContent = reason === 'rate-limited' ? 'Slow down — too many creates this hour.'
        : reason === 'not-signed-in' ? 'Your session lapsed — sign in again.'
        : reason ? 'Refused: ' + reason.replace(/-/g, ' ') + '.'
        : 'The server could not be reached — nothing was created.';
    });
  }

  /* ------------------------------------------------------------- board --- */

  const THEAD = `<div class="ar-thead">
      <span>Pos</span>
      <span>Trader</span>
      <span>State</span>
      <span class="r ar-c-eq" title="ROI scaled to the tournament's common starting stack">P&amp;L on stack ◎</span>
      <span class="r ar-c-roi">ROI</span>
      <span class="r ar-c-push" title="When this verified chain was submitted">Verified</span>
    </div>`;

  function boardRow(item, index, youHandle, bubbleFrom) {
    const isYou = youHandle && String(item.handle).toLowerCase() === youHandle.toLowerCase();
    const bubble = item.alive && bubbleFrom != null && index >= bubbleFrom;
    return `<a class="ar-row${isYou ? ' is-you' : ''}${bubble ? ' on-the-bubble' : ''}"
       style="animation-delay:${Math.min(index * 26, 320)}ms"
       href="/tournament?id=${encodeURIComponent(CODE)}&watch=${encodeURIComponent(item.handle)}"
       data-handle="${esc(item.handle)}">
      <span class="pos">${item.finalRank != null ? '#' + item.finalRank : '#' + (index + 1)}</span>
      <span class="ar-who">
        ${face(item)}
        <span class="ar-handle">@${esc(item.handle)}</span>
        ${isYou ? '<span class="ar-you-tag">YOU</span>' : ''}
      </span>
      <span>${seatChip(item)}</span>
      <span class="val ${dirClass(item.pnlOnStackSol)} ar-c-eq">${esc(signed(item.pnlOnStackSol, 2))}</span>
      <span class="val ${dirClass(item.roiPct)} ar-c-roi">${esc(signed(item.roiPct, 1, '%'))}</span>
      <span class="val dim ar-c-push">${item.submittedAt ? esc(ago(item.submittedAt)) : '—'}</span>
    </a>`;
  }

  function renderBoard(body, youHandle) {
    const t = body.tournament;
    const rows = body.standings || [];
    $('board-pane').hidden = false;

    // Spec strip + clock card tell the truth about THIS bracket.
    $('spec-stack').textContent = fmt(t.startStackSol, 1) + ' ◎';
    $('spec-round').textContent = fmtClock(t.roundMs);
    $('spec-cut').textContent = 'bottom ' + fmt(t.cutPerRound, 0);
    $('spec-prize').textContent = (t.prizeSplit || []).join('/') + (t.prizePoolSol ? ' · ' + fmt(t.prizePoolSol, 1) + ' ◎' : '');
    $('round-no').textContent = t.status === 'live' ? 'R' + fmt(t.currentRound, 0)
      : t.status === 'done' ? 'Final' : '—';
    $('alive-count').textContent = fmt(t.aliveCount != null ? t.aliveCount : rows.filter((r) => r.alive).length, 0);

    if (t.status === 'live' && t.startTs) {
      const start = t.startTs + (t.currentRound - 1) * t.roundMs;
      const end = start + t.roundMs;
      const alive = rows.filter((r) => r.alive).length;
      const isFinal = alive <= t.cutPerRound;
      startClock(start, end, isFinal ? 'until the final settles' : 'until the next cut');
      caption(isFinal
        ? 'Final round · standings remain provisional until the 15-minute verified-chain grace closes.'
        : 'Round ' + t.currentRound + ' · bottom ' + t.cutPerRound + ' cut 15 minutes after the boundary.');
    } else if (t.status === 'open') {
      idleClock(t.startWhenFull
        ? 'Starts the instant the last seat fills — ' + fmt(t.entrantCount, 0) + ' of ' + fmt(t.fieldSize, 0) + ' in.'
        : 'Opens ' + new Date(t.startTs).toUTCString().slice(5, 22) + ' UTC — ' + fmt(t.entrantCount, 0) + ' of ' + fmt(t.fieldSize, 0) + ' seats taken.');
    } else if (t.status === 'done') {
      const winner = rows.find((r) => r.finalRank === 1);
      idleClock(winner ? 'Final — @' + winner.handle + ' took it.' : 'This tournament has finished.');
    } else {
      idleClock('This tournament was cancelled before it started.');
    }

    if (!rows.length) {
      boardEl.innerHTML = L.empty('🏁', 'No seats taken yet.',
        'The bracket is open and empty — someone has to sit down first.');
      boardStatusEl.textContent = 'Waiting for entrants.';
      return;
    }

    // The bubble: the seats the next boundary would cut, shaded on the board.
    const alive = rows.filter((r) => r.alive);
    const bubbleFrom = t.status === 'live' && alive.length > t.cutPerRound
      ? rows.findIndex((r, i) => r.alive && rows.slice(0, i + 1).filter((x) => x.alive).length > alive.length - t.cutPerRound)
      : null;

    boardEl.innerHTML = THEAD + rows.map((r, i) => boardRow(r, i, youHandle, bubbleFrom)).join('');
    const finalCount = rows.filter((r) => r.finality === 'final').length;
    const forfeitedCount = rows.filter((r) => r.finality === 'forfeited').length;
    const provisionalCount = rows.filter((r) => r.finality === 'provisional').length;
    const evidence = t.status === 'live' ? fmt(provisionalCount, 0) + ' provisional'
      : (finalCount || forfeitedCount)
        ? fmt(finalCount, 0) + ' final · ' + fmt(forfeitedCount, 0) + ' forfeited'
        : 'no settled cut';
    boardStatusEl.textContent = fmt(alive.length, 0) + ' still in · '
      + fmt(rows.length - alive.length, 0) + ' cut · ' + evidence;
  }

  function renderEliminations(body) {
    const list = body.eliminations || [];
    if (!list.length) { elimPane.hidden = true; return; }
    elimPane.hidden = false;
    elimEl.innerHTML = list.slice().reverse().map((e) =>
      `<div style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:var(--rail)">
        <span class="ar-chip cut" style="flex:none">R${esc(e.roundNo)}</span>
        <a href="/profile?handle=${encodeURIComponent(e.handle)}" style="font-weight:700">@${esc(e.handle)}</a>
        <span class="ar-note" style="margin-left:auto">${esc(signed(e.pnlOnStackSol, 2))} ◎ on stack · ${esc(ago(e.eliminatedAt))}</span>
      </div>`).join('');
  }

  function renderRounds(body) {
    const rounds = Array.isArray(body.rounds) ? body.rounds : [];
    if (!rounds.length) { roundsPane.hidden = true; return; }
    roundsPane.hidden = false;
    roundsEl.innerHTML = rounds.map((round) => `
      <div style="padding:10px 0;border-bottom:var(--rail)">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px">
          <span class="ar-chip waiting">Round ${esc(round.roundNo)}</span>
          <span class="ar-note">Settled ${esc(ago(round.settledAt))}</span>
        </div>
        <code style="display:block;overflow-wrap:anywhere;font-size:10px">${esc(round.standingsHash)}</code>
      </div>`).join('');
  }

  /* --------------------------------------------------------- your seat --- */

  function renderYou(session, body) {
    const t = body && body.tournament;
    if (!session || session.unreachable) {
      youEl.innerHTML = '<p class="ar-note">Sign-in is unreachable along with the server, so this page cannot tell whether you hold a seat.</p>';
      return;
    }
    if (!session.signedIn) {
      youEl.innerHTML = `<p class="ar-note" style="margin-bottom:12px">Sign in with X to take a
          seat. Your tournament ledger starts even with everyone else's — nothing from your
          main-board record carries in, and nothing here touches it.</p>
        <button class="ar-btn primary" id="signin-btn">𝕏 &nbsp;Sign in with X</button>`;
      $('signin-btn').addEventListener('click', L.signIn);
      return;
    }
    if (!body || !t) {
      youEl.innerHTML = '<p class="ar-note">The bracket did not load, so your seat is unknown right now — not absent, unknown.</p>';
      return;
    }
    const mine = (body.standings || []).find(
      (r) => String(r.handle).toLowerCase() === String(session.handle).toLowerCase());

    const head = `<div style="display:flex;align-items:center;gap:10px">
        ${face(session, 'ar-face')}
        <div style="min-width:0"><div style="font-weight:800">@${esc(session.handle)}</div></div>
      </div>`;

    if (mine) {
      let state;
      if (t.status === 'done') {
        state = mine.finalRank === 1 ? 'You won this tournament.'
          : 'Finished ' + (mine.finalRank ? '#' + mine.finalRank : 'unranked') + '.';
      } else if (!mine.alive) {
        state = 'Cut at the round ' + mine.eliminatedRound + ' boundary — final rank #' + (mine.finalRank || '—') + '.';
      } else if (t.status === 'live') {
        state = mine.verified
          ? 'Provisional — ' + signed(mine.pnlOnStackSol, 2) + ' ◎ on the tournament stack (' +
            signed(mine.roiPct, 1, '%') + ' ROI).'
          : 'Provisional — waiting for your first fully verified chain submission.';
        if (mine.unpricedOpenPosition) state += ' An open position had no candle at the last mark and is valued at gross cost.';
      } else {
        state = 'Seat held. The bracket has not started yet.';
      }
      const canLeave = t.status === 'open';
      const canCancel = canLeave && t.creatorHandle &&
        String(t.creatorHandle).toLowerCase() === String(session.handle).toLowerCase();
      youEl.innerHTML = head + `<p class="ar-note" style="margin-top:12px">${esc(state)}</p>
        ${canLeave ? '<button class="ar-btn" id="leave-btn" style="margin-top:12px">Leave tournament</button>' : ''}
        ${canCancel ? '<button class="ar-btn" id="cancel-btn" style="margin-top:10px">Cancel tournament</button>' : ''}`;
      if (canLeave) $('leave-btn').addEventListener('click', () => seatAction('leave'));
      if (canCancel) $('cancel-btn').addEventListener('click', () => seatAction('cancel'));
      return;
    }

    if (t.status === 'open') {
      const seats = fmt(t.entrantCount, 0) + ' of ' + fmt(t.fieldSize, 0) + ' seats taken';
      youEl.innerHTML = head + `<p class="ar-note" style="margin-top:12px">${esc(seats)}.
          Entry is one click — the ledger starts you even with the field.</p>
        <button class="ar-btn primary" id="join-btn" style="margin-top:12px">Join this tournament</button>`;
      $('join-btn').addEventListener('click', () => seatAction('join'));
      return;
    }
    youEl.innerHTML = head + '<p class="ar-note" style="margin-top:12px">You are not in this bracket, and it is no longer taking seats.</p>';
  }

  async function seatAction(action) {
    const btn = $('join-btn') || $('leave-btn') || $('cancel-btn');
    if (btn) btn.disabled = true;
    let result;
    try {
      result = await L.api('/api/tournament/' + encodeURIComponent(CODE) + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      result = { status: 0, body: null };
    }
    if (result.status === 200 && result.body && result.body.ok) {
      refresh();
      return;
    }
    if (btn) btn.disabled = false;
    const reason = result.body && result.body.reason;
    youEl.insertAdjacentHTML('beforeend',
      '<p class="ar-note" style="margin-top:10px">' +
      esc(reason === 'full' ? 'The field filled before your click landed.'
        : reason === 'not-open' ? 'This bracket is no longer open.'
        : reason === 'rate-limited' ? 'Slow down — too many joins this hour.'
        : reason ? 'Refused: ' + String(reason).replace(/-/g, ' ') + '.'
        : 'The server could not be reached — nothing changed.') + '</p>');
  }

  /* ----------------------------------------------------------- spectate --- */

  let watchHandle = null;
  let specTimer = null;

  function stopSpectate() {
    if (specTimer) { clearInterval(specTimer); specTimer = null; }
    watchHandle = null;
    specPane.hidden = true;
  }

  async function loadSpectate() {
    if (!watchHandle) return;
    let body = null;
    try {
      body = await L.getOrThrow('/api/tournament/' + encodeURIComponent(CODE) +
        '/trader?handle=' + encodeURIComponent(watchHandle));
    } catch { body = null; }
    if (!body || !body.trader) {
      specBody.innerHTML = '<p class="ar-note">That trader\'s live card is unreachable right now — the last known state stays on the board, and nothing here is guessed.</p>';
      return;
    }
    const tr = body.trader;
    const positions = Array.isArray(tr.openPositions) ? tr.openPositions : [];
    specBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        ${face(tr, 'ar-face')}
        <div style="min-width:0">
          <div style="font-weight:800">@${esc(tr.handle)}</div>
          <a class="ar-note" style="color:var(--orange2)" href="/profile?handle=${encodeURIComponent(tr.handle)}">Public profile →</a>
        </div>
        <span style="margin-left:auto">${seatChip(tr)}</span>
      </div>
      <div class="ar-stats">
        <div class="ar-stat"><div class="num ${dirClass(tr.pnlOnStackSol)}">${esc(signed(tr.pnlOnStackSol, 2))}</div><div class="lbl">P&amp;L on stack ◎</div></div>
        <div class="ar-stat"><div class="num ${dirClass(tr.roiPct)}">${esc(signed(tr.roiPct, 1, '%'))}</div><div class="lbl">ROI</div></div>
        <div class="ar-stat"><div class="num">${body.rank ? '#' + esc(body.rank) : '—'}</div><div class="lbl">of ${esc(fmt(body.fieldSize, 0))}</div></div>
      </div>
      ${tr.unpricedOpenPosition ? '<p class="ar-note" style="margin-top:10px">Unpriced open position — valued at gross cost at this bell.</p>' : ''}
      <div class="ar-spec-pos" style="margin-top:14px">
        <div class="prow phead"><span>Position</span><span class="r">Qty</span><span class="r">Value ◎</span></div>
        ${positions.length ? positions.map((p) => `
          <div class="prow"><span>${esc(String(p.mint || '').slice(0, 8) + '…')}${p.unpriced ? ' · unpriced' : ''}</span>
            <span class="r">${esc(fmt(p.qty, 2))}</span>
            <span class="r">${esc(fmt(p.valueSol, 3))}</span></div>`).join('')
        : '<p class="ar-note" style="padding:8px 0">' +
          (tr.verified ? 'No open positions in the latest verified entry.' : 'No verified entry is available yet.') + '</p>'}
      </div>
      <p class="ar-note" style="margin-top:12px">Computed from @${esc(tr.handle)}\'s server-verified chain
        ${tr.submittedAt ? '· submitted ' + esc(ago(tr.submittedAt)) : ''}. Open positions use independent
        candle ranges at the displayed mark time.</p>`;
  }

  function startSpectate(handle) {
    watchHandle = handle;
    specPane.hidden = false;
    loadSpectate();
    if (specTimer) clearInterval(specTimer);
    specTimer = setInterval(loadSpectate, POLL_MS);
    specPane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* -------------------------------------------------------------- boot --- */

  let pollTimer = null;
  let sessionCache = null;

  async function refresh() {
    let body = null;
    try {
      body = await L.getOrThrow('/api/tournament/' + encodeURIComponent(CODE) + '/board');
    } catch { body = null; }
    if (!body || !body.tournament) {
      boardEl.innerHTML = L.errorState(
        'The tournament server is unreachable, so this bracket is not shown. Nothing here is cached, carried over, or guessed.');
      boardStatusEl.textContent = 'Bracket unavailable — the server could not be reached.';
      idleClock('The server is unreachable, so the bracket clock is not shown rather than assumed.');
      renderYou(sessionCache, null);
      return;
    }
    if (Number.isFinite(Number(body.serverTime))) clockOffset = Number(body.serverTime) - Date.now();
    const youHandle = sessionCache && sessionCache.signedIn ? sessionCache.handle : null;
    renderBoard(body, youHandle);
    renderEliminations(body);
    renderRounds(body);
    renderYou(sessionCache, body);
  }

  (async () => {
    const sessionPromise = L.me();
    if (!CODE) {
      // Directory mode.
      $('board-pane').hidden = true;
      idleClock('Pick a bracket to see its clock.');
      const session = await sessionPromise;
      sessionCache = session;
      renderYou(session, null);
      await loadDirectory(session);
      return;
    }
    $('directory-pane').hidden = true;
    boardEl.innerHTML = L.skeleton(6);
    sessionCache = await sessionPromise;
    await refresh();
    pollTimer = setInterval(refresh, POLL_MS);

    // A ?watch=handle deep link opens the spectate card directly.
    const watch = params.get('watch');
    if (watch) startSpectate(watch);

    // Row clicks spectate in place rather than navigating.
    boardEl.addEventListener('click', (ev) => {
      const row = ev.target.closest('.ar-row[data-handle]');
      if (!row) return;
      ev.preventDefault();
      startSpectate(row.getAttribute('data-handle'));
    });
    $('spectate-close').addEventListener('click', stopSpectate);
  })();
})();
