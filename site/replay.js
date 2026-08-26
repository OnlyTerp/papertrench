/* PaperTrench Replay - the theater player.
 *
 * The chart is TradingView's open-source lightweight-charts (self-hosted in
 * /vendor/lwc.js) - the same engine class the terminals use, so the candles
 * read like a real chart, not a science project. The player lives in a
 * theater overlay that pops over the page; the page itself stays a simple
 * loader + a shelf of recent builds.
 *
 * Honesty rules mirror the server: no invented prices, degraded upstream is
 * said out loud, and an empty board is an empty board.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let chart = null, candleSeries = null, pnlSeries = null;
  let state = { candles: [], fills: [], curve: [], board: [], pnl: {}, mint: null, wallet: null };
  let playIdx = 0, playing = false, timer = null;
  let speedIdx = 0; const SPEEDS = [1, 2, 4, 8];
  let recording = false, recorder = null, chunks = [], recTimer = null;
  let fullRange = null;

  /* The site is static GitHub Pages - there is no /api on this origin. All
   * API traffic goes to the worker, same origin arena.js uses. Local dev
   * (127.0.0.1 harness) keeps same-origin so mocks can intercept. */
  const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '' : 'https://papertrench-api.onerobby.workers.dev';

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

  /* ---------------- theater ---------------- */

  function openTheater() {
    const t = $('theater');
    if (!t.hidden) return;
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
    ensureChart();
  }
  function closeTheater() {
    const t = $('theater');
    if (t.hidden) return;
    stopTick(); stopRecord();
    t.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => { t.hidden = true; }, 220);
  }

  /* ---------------- chart (lightweight-charts) ---------------- */

  function ensureChart() {
    if (chart || typeof LightweightCharts === 'undefined') return;
    const el = $('chart');
    chart = LightweightCharts.createChart(el, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: 'rgba(141,151,169,.9)',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(141,151,169,.06)' },
        horzLines: { color: 'rgba(141,151,169,.06)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(141,151,169,.15)',
        scaleMargins: { top: 0.08, bottom: 0.18 },
      },
      timeScale: {
        borderColor: 'rgba(141,151,169,.15)',
        timeVisible: true, secondsVisible: false,
        rightOffset: 2, fixLeftEdge: true,
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Magnet,
        vertLine: { color: 'rgba(255,157,69,.35)', labelBackgroundColor: '#1a1e26' },
        horzLine: { color: 'rgba(255,157,69,.35)', labelBackgroundColor: '#1a1e26' },
      },
      handleScroll: true, handleScale: true,
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: '#34d399', downColor: '#ff5c7a',
      wickUpColor: 'rgba(52,211,153,.7)', wickDownColor: 'rgba(255,92,122,.7)',
      borderVisible: false,
      priceFormat: { type: 'price', precision: 10, minMove: 0.0000000001 },
    });
    pnlSeries = chart.addLineSeries({
      priceScaleId: 'pnl',
      color: 'rgba(255,157,69,.95)', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: (v) => fmtUsd(v, 0) },
    });
    chart.priceScale('pnl').applyOptions({ visible: false, scaleMargins: { top: 0.55, bottom: 0.03 } });
    new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    }).observe(el);
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }

  const toBar = (c) => ({
    time: Math.floor(Number(c.ts) / 1000),
    open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c),
  });

  /** Push the state at playIdx into the chart: visible candles, markers up to
   * the playhead, and the PnL line stepping alongside. The time range is
   * pinned to the whole film so bars sweep left-to-right into empty space. */
  function sync() {
    if (!chart) return;
    const visible = state.candles.slice(0, playIdx + 1);
    candleSeries.setData(visible.map(toBar));

    const curTs = visible.length ? Number(visible[visible.length - 1].ts) + 60000 : 0;
    const markers = (state.fills || [])
      .filter((f) => Number(f.ts) < curTs && Number.isFinite(Number(f.priceUsd)))
      .sort((a, b) => a.ts - b.ts)
      .map((f) => ({
        time: Math.floor(Number(f.ts) / 1000),
        position: f.side === 'sell' ? 'aboveBar' : 'belowBar',
        color: f.side === 'sell' ? '#ff5c7a' : '#34d399',
        shape: f.side === 'sell' ? 'arrowDown' : 'arrowUp',
        text: f.side === 'sell' ? 'S' : 'B',
      }));
    candleSeries.setMarkers(markers);

    if (state.curve.length) {
      const pts = state.curve.slice(0, playIdx + 1)
        .filter((p) => Number.isFinite(Number(p.total)) && Number.isFinite(Number(p.ts)))
        .map((p) => ({ time: Math.floor(Number(p.ts) / 1000), value: Number(p.total) }));
      pnlSeries.setData(pts);
    } else pnlSeries.setData([]);

    if (fullRange) chart.timeScale().setVisibleRange(fullRange);
  }

  /* ---------------- build ---------------- */

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

      openTheater();
      renderTitle(); renderBoard(); renderFills(); renderLedger();

      if (!state.candles.length) {
        $('chartMsg').hidden = false;
        setTransport(false);
        setStatus('');
        return;
      }
      $('chartMsg').hidden = true;
      setTransport(true);
      $('scrub').max = Math.max(0, state.candles.length - 1);
      $('scrub').value = playIdx;
      updateScrub();

      // Establish the full time range once, then sync at the playhead.
      ensureChart();
      if (chart) {
        candleSeries.setData(state.candles.map(toBar));
        chart.timeScale().fitContent();
        const r = chart.timeScale().getVisibleRange();
        fullRange = r ? { from: r.from, to: r.to } : null;
      }
      sync();
      rememberBuild(mint, wallet);
      const qs = new URLSearchParams({ mint });
      if (wallet) qs.set('wallet', wallet);
      history.replaceState(null, '', '/replay?' + qs.toString());
      setStatus('');
    } catch (e) {
      const reason = typeof e === 'string' ? e : (e && e.message) || '';
      setStatus(FRIENDLY[reason] || ('Build failed: ' + reason), 'err');
    } finally { $('build').disabled = false; }
  }

  function setTransport(on) {
    for (const id of ['play', 'scrub', 'speed', 'record']) $(id).disabled = !on;
  }

  /* ---------------- shelf (recent builds) ---------------- */

  const SHELF_KEY = 'pt-replay-shelf';
  function readShelf() {
    try { return JSON.parse(localStorage.getItem(SHELF_KEY)) || []; } catch { return []; }
  }
  function rememberBuild(mint, wallet) {
    let shelf = readShelf().filter((s) => !(s.mint === mint && (s.wallet || null) === (wallet || null)));
    shelf.unshift({ mint, wallet: wallet || null, at: Date.now() });
    shelf = shelf.slice(0, 8);
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf)); } catch { /* private mode */ }
    renderShelf();
  }
  function renderShelf() {
    const shelf = readShelf();
    $('shelf-head').hidden = !shelf.length;
    $('shelf').innerHTML = shelf.map((s) => {
      const who = s.wallet ? '<span class="w">' + short(s.wallet) + '</span>' : '<span class="w dim">whole cast</span>';
      return '<button type="button" class="rp-reel" data-mint="' + s.mint + '" data-wallet="' + (s.wallet || '') + '">' +
        '<span class="m">' + short(s.mint) + '</span>' + who + '</button>';
    }).join('');
    $('shelf').querySelectorAll('.rp-reel').forEach((el) => {
      el.addEventListener('click', () => {
        $('mint').value = el.dataset.mint;
        $('wallet').value = el.dataset.wallet || '';
        build(el.dataset.wallet || null);
      });
    });
  }

  /* ---------------- panes ---------------- */

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

  function fmtPrice(p) {
    if (p >= 1) return p >= 10000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(p >= 100 ? 1 : 3);
    return p.toExponential(2);
  }

  /* ---------------- stepping PnL under the playhead ---------------- */

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

  /* ---------------- transport ---------------- */

  function frame() { sync(); ledgerAtPlayhead(); updateScrub(); markTapeProgress(); }
  function tick() {
    if (!playing) return;
    if (playIdx < state.candles.length - 1) { playIdx++; frame(); }
    else stopTick();
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

  /* ---------------- record (composite canvas at 30fps) ---------------- */

  function startRecord() {
    if (recording || !chart) return;
    chunks = [];
    const rc = document.createElement('canvas');
    const wrap = $('rp-chart-wrap');
    rc.width = wrap.clientWidth * 2; rc.height = wrap.clientHeight * 2;
    const rctx = rc.getContext('2d');
    recTimer = setInterval(() => {
      try {
        const shot = chart.takeScreenshot();
        rctx.fillStyle = '#0a0d12';
        rctx.fillRect(0, 0, rc.width, rc.height);
        rctx.drawImage(shot, 0, 0, rc.width, rc.height);
      } catch { /* mid-frame */ }
    }, 33);
    const stream = rc.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      clearInterval(recTimer); recTimer = null;
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
  function stopRecord() { if (recording && recorder && recorder.state !== 'inactive') recorder.stop(); recording = false; }

  /* ---------------- wire ---------------- */

  $('build').addEventListener('click', () => build());
  $('mint').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('wallet').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('play').addEventListener('click', () => (playing ? stopTick() : startTick()));
  $('scrub').addEventListener('input', (e) => {
    playIdx = Number(e.target.value);
    frame();
  });
  $('speed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    $('speed').textContent = SPEEDS[speedIdx] + 'x';
    if (playing) { stopTick(); startTick(); }
  });
  $('record').addEventListener('click', () => (recording ? stopRecord() : startRecord()));
  $('theater-close').addEventListener('click', closeTheater);
  $('theater-backdrop').addEventListener('click', closeTheater);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('theater').hidden) closeTheater();
    else if (e.key === ' ' && !$('theater').hidden && !$('play').disabled &&
      !/INPUT|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault(); (playing ? stopTick() : startTick());
    }
  });

  renderShelf();

  // Deep link: /replay?mint=...&wallet=... builds on arrival.
  const qs = new URLSearchParams(location.search);
  if (qs.get('mint')) {
    $('mint').value = qs.get('mint');
    if (qs.get('wallet')) $('wallet').value = qs.get('wallet');
    build();
  }
})();
