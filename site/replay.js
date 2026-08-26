/* PaperTrench Replay - the film room player.
 *
 * Pure browser logic, no chart library. Fetches /api/replay/history (candles +
 * leaderboard) and /api/replay/wallet (fills + stepping PnL) and projects:
 *   - the token's 1m candles revealed by a playhead,
 *   - the wallet's buy/sell markers landing on their bars,
 *   - a PnL line stepping on its own right-hand scale,
 * with play/scrub/speed transport and MediaRecorder canvas-to-webm export.
 *
 * Honesty rules mirror the server: no invented prices, degraded upstream is
 * said out loud, and an empty board is an empty board.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('chart'), ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;

  let state = { candles: [], fills: [], curve: [], board: [], pnl: {}, mint: null, wallet: null };
  let playIdx = 0, playing = false, timer = null;
  let speedIdx = 0; const SPEEDS = [1, 2, 4, 8];
  let recording = false, recorder = null, chunks = [];

  const API_BASE = '';

  function parseMint(v) {
    const s = String(v || '').trim();
    const m = s.match(/\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m) return m[1];
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : null;
  }
  function parseAddr(v) {
    const s = String(v || '').trim();
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : null;
  }
  const short = (a) => a ? a.slice(0, 5) + '\u2026' + a.slice(-4) : '';
  const fmtUsd = (v, d = 2) => '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d });

  async function api(path, params) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/api/replay/${path}?${q}`, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.reason || `HTTP ${res.status}`);
    return data;
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text || '';
    el.className = 'rp-status' + (kind ? ' ' + kind : '');
  }

  const FRIENDLY = {
    'replay-degraded': 'Chain data provider is temporarily down - try again in a minute.',
    'replay-unconfigured': 'Replay is not configured on this deployment yet.',
    'replay-auth': 'Replay provider rejected our key - flag it in the Discord.',
    'bad-address': 'That mint or wallet address is not a valid Solana address.',
    'busy': 'Too many builds at once - try again in a moment.',
    'no-data': 'The chain has no trade history for that mint yet.',
  };

  async function build(walletOverride) {
    const mint = parseMint($('mint').value);
    const wallet = walletOverride !== undefined ? walletOverride : parseAddr($('wallet').value);
    if (!mint) { setStatus('Enter a valid mint address or pump.fun link.', 'err'); return; }
    if (walletOverride !== undefined) $('wallet').value = walletOverride || '';
    setStatus('Rebuilding the chain - first load takes a few seconds\u2026', 'busy');
    $('build').disabled = true;
    try {
      const hist = await api('history', { mint, chain: 'solana' });
      state.mint = mint;
      state.candles = hist.candles || [];
      state.board = (hist.leaderboard && (hist.leaderboard.top || [])) || [];
      state.wallet = wallet || null;
      if (wallet) {
        const wd = await api('wallet', { mint, wallet, chain: 'solana' });
        state.fills = wd.fills || [];
        state.curve = wd.curve || [];
        state.pnl = wd.pnl || {};
      } else { state.fills = []; state.curve = []; state.pnl = {}; }

      playIdx = state.candles.length ? state.candles.length - 1 : 0;
      playing = false; stopTick();
      renderTitle(); renderBoard(); renderFills(); renderLedger();

      if (!state.candles.length) {
        showEmpty('The chain has no candle history for that mint.');
        setTransport(false);
        setStatus('');
        return;
      }
      hideEmpty();
      setTransport(true);
      $('scrub').max = Math.max(0, state.candles.length - 1);
      $('scrub').value = playIdx;
      updateScrub();
      draw();
      setStatus('');
    } catch (e) {
      const reason = typeof e === 'string' ? e : (e && e.message) || '';
      setStatus(FRIENDLY[reason] || ('Build failed: ' + reason), 'err');
    } finally { $('build').disabled = false; }
  }

  function showEmpty(msg) {
    const el = $('chartMsg');
    el.style.display = '';
    if (msg) el.querySelector('p').innerHTML = '<strong>' + msg + '</strong>';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  function hideEmpty() { $('chartMsg').style.display = 'none'; }

  function setTransport(on) {
    for (const id of ['play', 'scrub', 'speed', 'record']) $(id).disabled = !on;
  }

  function renderTitle() {
    const t = $('film-title');
    if (!state.mint) { t.textContent = 'No film loaded'; return; }
    const who = state.wallet ? ' \u00b7 ' + short(state.wallet) : '';
    t.innerHTML = '<span class="tkr">' + short(state.mint) + '</span>' + who;
    const lp = $('live-price');
    const last = state.candles[state.candles.length - 1];
    if (last && Number.isFinite(last.c)) {
      const first = state.candles[0];
      const up = last.c >= (first ? first.o : last.c);
      lp.className = 'rp-live-price ' + (up ? 'up' : 'down');
      lp.innerHTML = 'last <b>' + fmtPrice(last.c) + '</b>';
    } else { lp.textContent = ''; }
  }

  function renderBoard() {
    const box = $('board');
    $('cast-note').textContent = state.board.length ? state.board.length + ' wallets' : '';
    if (!state.board.length) {
      box.innerHTML = '<div class="rp-cast-empty">No traders ranked for this mint yet - the chain window may be too fresh.</div>';
      return;
    }
    box.innerHTML = state.board.map((r, i) => {
      const total = Number(r.total || 0);
      const cls = total >= 0 ? 'up' : 'down';
      const live = state.wallet === r.wallet ? ' is-live' : '';
      const gift = r.unknownBasis ? ' \u00b7 gift' : '';
      return '<button type="button" class="rp-actor' + live + '" data-wallet="' + r.wallet + '" aria-label="Replay wallet ' + short(r.wallet) + '">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="who"><span class="addr">' + short(r.wallet) + '</span>' +
        '<span class="meta">' + (r.buys + r.sells) + ' trades' + gift + '</span></span>' +
        '<span class="pnl ' + cls + '">' + fmtUsd(total, 0) +
        '<span class="sub">' + fmtUsd(r.boughtUsd, 0) + ' in</span></span></button>';
    }).join('');
    box.querySelectorAll('.rp-actor').forEach((el) => {
      el.addEventListener('click', () => build(el.dataset.wallet));
    });
  }

  function renderFills() {
    const box = $('fills');
    const list = state.fills || [];
    $('tape-note').textContent = list.length ? list.length + ' fills' : '';
    if (!list.length) {
      box.innerHTML = '<div class="rp-tape-empty">' +
        (state.wallet ? 'No priced fills for that wallet on this token.'
          : 'Load a wallet to see its buys and sells. Rows light up as the playhead reaches them.') +
        '</div>';
      return;
    }
    const curT = state.candles[Math.min(playIdx, state.candles.length - 1)];
    const curTs = curT ? Number(curT.ts) + 60000 : Infinity;
    box.innerHTML = list.slice().sort((a, b) => b.ts - a.ts).map((f) => {
      const side = f.side === 'sell' ? 'sell' : 'buy';
      const future = Number(f.ts) >= curTs ? ' is-future' : '';
      const qty = Number(f.base).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const t = new Date(Number(f.ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div class="rp-fill ' + side + future + '" data-ts="' + f.ts + '">' +
        '<span class="chip">' + (side === 'sell' ? 'S' : 'B') + '</span>' +
        '<span class="qty">' + qty + '</span>' +
        '<span class="usd">' + fmtUsd(f.usd) + '</span>' +
        '<span class="at">' + t + '</span></div>';
    }).join('');
  }

  function renderLedger() {
    const p = state.pnl || {};
    const cells = [
      ['led-real', p.realized], ['led-unreal', p.unrealized], ['led-total', p.total],
    ];
    for (const [id, v] of cells) {
      const el = $(id);
      if (!state.wallet || v === undefined || v === null) { el.textContent = '--'; el.className = 'v dim'; continue; }
      const n = Number(v);
      el.textContent = fmtUsd(n);
      el.className = 'v ' + (n >= 0 ? 'up' : 'down');
    }
    const lf = $('led-fills');
    lf.textContent = state.wallet ? String((state.fills || []).length) : '--';
    lf.className = 'v ' + (state.wallet ? '' : 'dim');
  }

  // ---- projection ----
  function draw() {
    const cw = canvas.clientWidth, chh = canvas.clientHeight;
    canvas.width = cw * DPR; canvas.height = chh * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, cw, chh);
    const candles = state.candles;
    if (!candles.length) return;
    const visible = candles.slice(0, playIdx + 1);
    if (!visible.length) return;

    const padL = 64, padR = 64, padT = 18, padB = 26;
    const w = cw - padL - padR, h = chh - padT - padB;
    let lo = Infinity, hi = -Infinity;
    for (const c of visible) {
      if (Number.isFinite(c.l)) lo = Math.min(lo, c.l);
      if (Number.isFinite(c.h)) hi = Math.max(hi, c.h);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad; hi += pad;
    const y = (p) => padT + (hi - p) / (hi - lo) * h;
    const x = (i) => padL + (i / Math.max(1, visible.length - 1)) * w;
    const cwpx = Math.max(2, w / visible.length * 0.6);

    ctx.strokeStyle = 'rgba(141,151,169,.08)';
    ctx.fillStyle = 'rgba(141,151,169,.8)';
    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const gp = lo + (hi - lo) * i / 5, gy = y(gp);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(cw - padR, gy); ctx.stroke();
      ctx.fillText(fmtPrice(gp), 6, gy + 3);
    }
    for (let i = 0; i < visible.length; i++) {
      const c = visible[i], cx = x(i), up = c.c >= c.o;
      const col = up ? '#34d399' : '#ff8a80';
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillRect(cx - cwpx / 2, top, cwpx, Math.max(1, bot - top));
    }
    if (state.curve.length) {
      const pv = state.curve.slice(0, playIdx + 1).filter((p) => Number.isFinite(p.total));
      if (pv.length > 1) {
        let plo = Infinity, phi = -Infinity;
        for (const p of pv) { plo = Math.min(plo, p.total); phi = Math.max(phi, p.total); }
        const span = (phi - plo) || 1; const py = (v) => padT + (1 - (v - plo) / span) * h;
        ctx.strokeStyle = 'rgba(255,157,69,.9)'; ctx.lineWidth = 2; ctx.beginPath();
        pv.forEach((p, i) => { const px = x(i); i ? ctx.lineTo(px, py(p.total)) : ctx.moveTo(px, py(p.total)); });
        ctx.stroke();
        const lastP = pv[pv.length - 1];
        ctx.fillStyle = 'rgba(255,157,69,.95)';
        ctx.font = '700 10px "IBM Plex Mono", monospace';
        ctx.textAlign = 'right';
        ctx.fillText(fmtUsd(lastP.total), cw - 6, py(lastP.total) + 3);
        ctx.textAlign = 'left';
      }
    }
    const barByTs = new Map(visible.map((c, i) => [Math.floor(Number(c.ts) / 60000) * 60000, i]));
    for (const f of (state.fills || [])) {
      const bi = barByTs.get(Math.floor(Number(f.ts) / 60000) * 60000);
      if (bi === undefined || bi > playIdx) continue;
      const cx = x(bi), cy = y(Number(f.priceUsd));
      const up = f.side !== 'sell';
      ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, 7);
      ctx.fillStyle = up ? '#34d399' : '#ff8a80'; ctx.fill();
      ctx.strokeStyle = '#05070b'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#05070b'; ctx.font = '800 8px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(up ? 'B' : 'S', cx, cy + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    ctx.fillStyle = 'rgba(141,151,169,.8)';
    ctx.font = '10px "IBM Plex Mono", monospace';
    const last = visible[visible.length - 1];
    const tt = new Date(Number(last.ts));
    ctx.fillText(tt.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      tt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), padL, chh - 8);
  }

  function fmtPrice(p) {
    if (p >= 1) return p >= 10000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(p >= 100 ? 1 : 3);
    return p.toExponential(2);
  }

  // ---- stepping PnL under the playhead ----
  function ledgerAtPlayhead() {
    if (!state.wallet || !state.curve.length) return;
    const pt = state.curve[Math.min(playIdx, state.curve.length - 1)];
    if (!pt) return;
    const cells = [['led-real', pt.realized], ['led-unreal', pt.unrealized], ['led-total', pt.total]];
    for (const [id, v] of cells) {
      const el = $(id);
      if (v === undefined || v === null || !Number.isFinite(Number(v))) { el.textContent = '--'; el.className = 'v dim'; continue; }
      const n = Number(v);
      el.textContent = fmtUsd(n);
      el.className = 'v ' + (n >= 0 ? 'up' : 'down');
    }
  }

  function markTapeProgress() {
    const curT = state.candles[Math.min(playIdx, state.candles.length - 1)];
    if (!curT) return;
    const curTs = Number(curT.ts) + 60000;
    $('fills').querySelectorAll('.rp-fill').forEach((el) => {
      el.classList.toggle('is-future', Number(el.dataset.ts) >= curTs);
    });
  }

  // ---- transport ----
  function tick() {
    if (!playing) return;
    if (playIdx < state.candles.length - 1) {
      playIdx++;
      draw(); ledgerAtPlayhead(); updateScrub(); markTapeProgress();
    } else stopTick();
  }
  function startTick() {
    if (timer) return;
    if (playIdx >= state.candles.length - 1) { playIdx = 0; }
    playing = true;
    $('ic-play').style.display = 'none'; $('ic-pause').style.display = '';
    timer = setInterval(tick, 300 / SPEEDS[speedIdx]);
  }
  function stopTick() {
    playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    $('ic-play').style.display = ''; $('ic-pause').style.display = 'none';
  }
  function updateScrub() {
    $('scrub').value = playIdx;
    $('tlabel').textContent = (playIdx + 1) + ' / ' + state.candles.length;
  }

  // ---- record ----
  function startRecord() {
    if (recording) return;
    chunks = [];
    const stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'papertrench-replay-' + Date.now() + '.webm'; a.click();
      URL.revokeObjectURL(url);
      $('record').classList.remove('is-on');
      $('record').lastChild.textContent = 'Record';
    };
    recorder.start();
    recording = true;
    $('record').classList.add('is-on');
    $('record').lastChild.textContent = 'Stop';
  }
  function stopRecord() { if (recording && recorder.state !== 'inactive') recorder.stop(); recording = false; }

  // ---- wire ----
  $('build').addEventListener('click', () => build());
  $('mint').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('wallet').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('play').addEventListener('click', () => (playing ? stopTick() : startTick()));
  $('scrub').addEventListener('input', (e) => {
    playIdx = Number(e.target.value);
    draw(); ledgerAtPlayhead(); updateScrub(); markTapeProgress();
  });
  $('speed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    $('speed').textContent = SPEEDS[speedIdx] + 'x';
    if (playing) { stopTick(); startTick(); }
  });
  $('record').addEventListener('click', () => (recording ? stopRecord() : startRecord()));
  window.addEventListener('resize', () => draw());

  // Deep link: /replay?mint=...&wallet=... builds on arrival.
  const qs = new URLSearchParams(location.search);
  if (qs.get('mint')) {
    $('mint').value = qs.get('mint');
    if (qs.get('wallet')) $('wallet').value = qs.get('wallet');
    build();
  }
})();
