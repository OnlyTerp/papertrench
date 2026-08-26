/* PaperTrench Replay - the theater player.
 *
 * The chart is TradingView's lightweight-charts (self-hosted /vendor/lwc.js).
 * The playback model is ported from Trickshot (github.com/nathanliow/trickshot,
 * MIT) and rebuilt for our wire shape:
 *   - the current bar FORMS: its close walks open->close on a smoothstep, the
 *     high/low revealed as it goes - a live candle, not a slideshow tick;
 *   - a fill washes the chart in its colour and floats its size over the
 *     screen; a new fill displaces the old label rather than stacking;
 *   - sound through Web Audio: a till ring for every bar that sold, a fanfare
 *     each time total PnL climbs another $20K (armed at the opening bar so a
 *     wallet already up $80K does not open with four blasts);
 *   - candles denominate in MARKET CAP when supply is known - "$4.1M" reads,
 *     "0.0000041" does not.
 * Honesty rules unchanged: no invented prices, degraded upstream said out
 * loud, an empty board is an empty board.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  /* ---------------- constants (Trickshot-calibrated) ---------------- */

  const STEP_MS = 600;           // one bar per 600ms at 1x
  const SPEEDS = [1, 2, 4, 8];
  const FLASH_MS = 1400;         // how long a fill label holds the screen
  const FANFARE_AT = 20000;      // fanfare each time total PnL gains $20K
  const BAR_SPACING = 9;

  let chart = null, candleSeries = null, pnlSeries = null, volSeries = null, basisSeries = null;
  let basisPoints = [];           // avg-cost line, precomputed per build
  let state = {
    candles: [], fills: [], curve: [], board: [], pnl: {},
    mint: null, wallet: null, token: null, supply: 0,
  };
  let capMode = false;           // candles denominated in market cap
  let playing = false, rafId = null, clipMs = 0, lastFrame = 0;
  let painted = -1;              // last fully-painted bar (seek guard)
  let playIdx = 0;               // current bar index
  let speedIdx = 1;              // default 2x
  let fanfareTier = 0;           // high-water $20K step already sounded
  let flashId = 0, flashes = []; // floating fill labels
  let markers = [];              // precomputed chart markers (all bars)
  let filledBars = new Set();    // bar indexes that contain fills
  let recording = false, recorder = null, chunks = [], recTimer = null;

  /* The site is static GitHub Pages - there is no /api on this origin. All
   * API traffic goes to the worker, same origin arena.js uses. Local dev
   * (127.0.0.1 harness) keeps same-origin so mocks can intercept. */
  const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '' : 'https://papertrench-api.onerobby.workers.dev';

  /* ---------------- stored toggles ---------------- */

  function storedFlag(key, dflt) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? dflt : v === '1';
    } catch { return dflt; }
  }
  function storeFlag(key, v) {
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private */ }
  }
  let soundOn = storedFlag('pt-replay-sound', true);
  let fxOn = storedFlag('pt-replay-fx', true);

  /* ---------------- sound (Web Audio; fails quietly) ---------------- */

  const SFX = { kaching: '/sfx/kaching.mp3', bandos: '/sfx/bandos.mov' };
  let audioCtx = null, master = null, sfxLoading = null;
  const sfxBuffers = new Map();

  function audio() {
    if (audioCtx) return audioCtx;
    try {
      audioCtx = new AudioContext();
      master = audioCtx.createGain();
      master.gain.value = 0.6;
      master.connect(audioCtx.destination);
      return audioCtx;
    } catch { return null; }
  }
  /** Decode both clips once, on a user gesture (build click). */
  function prepareSfx() {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    sfxLoading = sfxLoading || Promise.all(Object.keys(SFX).map(async (cue) => {
      try {
        const res = await fetch(SFX[cue]);
        if (!res.ok) return;
        sfxBuffers.set(cue, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch { /* a clip that will not decode simply never plays */ }
    }));
  }
  /** Fire a cue. Overlapping calls each get their own voice. */
  function playCue(cue, gain) {
    if (!soundOn || !audioCtx || !master) return;
    const buffer = sfxBuffers.get(cue);
    if (!buffer) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      if (Number.isFinite(gain) && gain > 0 && gain !== 1) {
        const g = audioCtx.createGain();
        g.gain.value = Math.min(gain, 1.6);
        src.connect(g); g.connect(master);
      } else src.connect(master);
      src.start();
    } catch { /* the replay carries on silently */ }
  }

  /**
   * A buy doesn't ring the till - it thocks. Two-oscillator synth blip, no
   * asset to load, distinct from the sell's kaching at any speed.
   */
  function playBuyBlip(gain) {
    if (!soundOn || !audioCtx || !master) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    try {
      const t = audioCtx.currentTime;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.min(0.5 * (gain || 1), 0.9), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      const o1 = audioCtx.createOscillator();
      o1.type = 'sine';
      o1.frequency.setValueAtTime(660, t);
      o1.frequency.exponentialRampToValueAtTime(990, t + 0.09);
      const o2 = audioCtx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.setValueAtTime(330, t);
      o1.connect(g); o2.connect(g); g.connect(master);
      o1.start(t); o2.start(t);
      o1.stop(t + 0.25); o2.stop(t + 0.25);
    } catch { /* silent */ }
  }

  /* ---------------- parsing + formatting ---------------- */

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
  const trim1 = (n) => n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  /** $412K, $1.2M - the market-cap / volume convention. */
  function usdCompact(v) {
    const a = Math.abs(Number(v) || 0);
    if (a >= 1e9) return '$' + trim1(a / 1e9) + 'B';
    if (a >= 1e6) return '$' + trim1(a / 1e6) + 'M';
    if (a >= 1e3) return '$' + trim1(a / 1e3) + 'K';
    return '$' + Math.round(a);
  }
  /** $1.24M / $61.4K - a cap or price at a glance. */
  function capLabel(v) {
    if (!Number.isFinite(v) || v <= 0) return '$0';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }
  function fmtPrice(p) {
    if (p >= 1) return p >= 10000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(p >= 100 ? 1 : 3);
    return p.toExponential(2);
  }

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
    stopPlay(); stopRecord(); clearFlashes();
    t.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => { t.hidden = true; }, 220);
  }

  /* ---------------- chart ---------------- */

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
        vertLines: { color: 'rgba(255,255,255,.04)' },
        horzLines: { color: 'rgba(255,255,255,.04)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,.08)',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,.08)',
        timeVisible: true, secondsVisible: false,
        /* Fixed spacing with the newest bar mid-chart and room ahead of it -
         * the way a live chart behaves. fitContent() every frame rescales the
         * whole range each step, which reads as bars shrinking, not time
         * passing. */
        barSpacing: BAR_SPACING,
        rightOffset: Math.round((el.clientWidth || 900) / BAR_SPACING / 2),
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
      priceFormat: { type: 'price', precision: 10, minMove: 1e-10 },
    });
    // Volume histogram along the floor - the texture every serious chart has.
    // Its own hidden scale; candles keep the right axis to themselves.
    volSeries = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      priceLineVisible: false, lastValueVisible: false,
    });
    chart.priceScale('vol').applyOptions({ visible: false, scaleMargins: { top: 0.82, bottom: 0 } });
    // The wallet's average cost, as a line the price crosses: every candle
    // above it is unrealized profit, every sell above it a booked win. Drawn
    // only when a wallet with priced buys is loaded.
    basisSeries = chart.addLineSeries({
      color: 'rgba(251,191,36,.85)', lineWidth: 1,
      lineStyle: 2 /* dashed */,
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: 'avg cost',
      priceFormat: { type: 'custom', formatter: (v) => capMode ? capLabel(v) : fmtPrice(v) },
    });
    pnlSeries = chart.addLineSeries({
      priceScaleId: 'pnl',
      color: 'rgba(255,157,69,.95)', lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: (v) => usdCompact(v) },
    });
    chart.priceScale('pnl').applyOptions({ visible: false, scaleMargins: { top: 0.6, bottom: 0.02 } });
    new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    }).observe(el);
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }

  /** Market cap when supply is known, price otherwise - set once per build. */
  function applyDenomination() {
    if (!candleSeries) return;
    candleSeries.applyOptions({
      priceFormat: capMode
        ? { type: 'custom', formatter: capLabel, minMove: 1 }
        : { type: 'price', precision: 10, minMove: 1e-10 },
    });
  }

  /** Candle value in the axis denomination. */
  const denom = (v) => capMode ? Number(v) * state.supply : Number(v);

  const toBar = (c) => ({
    time: Math.floor(Number(c.ts) / 1000),
    open: denom(c.o), high: denom(c.h), low: denom(c.l), close: denom(c.c),
  });

  /**
   * The index of the bar a moment falls in, FOUND rather than computed -
   * nothing assumes even spacing. Returns -1 before the first bar.
   */
  function barAt(ts) {
    const cs = state.candles;
    if (!cs.length || ts < Number(cs[0].ts)) return -1;
    let lo = 0, hi = cs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Number(cs[mid].ts) <= ts) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The bar being replayed, part-formed: close walks open->real close on a
   * smoothstep, high/low revealed as it goes - exactly how a live candle
   * behaves while trades land in it.
   */
  function formingRow(bar, p) {
    const b = state.candles[bar];
    const eased = p * p * (3 - 2 * p);
    const o = denom(b.o), h = denom(b.h), l = denom(b.l), c = denom(b.c);
    const close = o + (c - o) * eased;
    return {
      time: Math.floor(Number(b.ts) / 1000),
      open: o,
      high: Math.max(o, close, o + (h - o) * eased),
      low: Math.min(o, close, o + (l - o) * eased),
      close,
    };
  }

  /** Volume row for a bar, tinted by the bar's direction, dimmed history. */
  function toVol(c) {
    const up = Number(c.c) >= Number(c.o);
    return {
      time: Math.floor(Number(c.ts) / 1000),
      value: Number(c.v) || 0,
      color: up ? 'rgba(52,211,153,.28)' : 'rgba(255,92,122,.28)',
    };
  }

  /**
   * Put the chart exactly where a moment says it should be. Structural work
   * (history, markers) only when the bar changes; the forming update runs
   * every frame.
   */
  function seek(bar, p) {
    const b = state.candles[bar];
    if (!chart || !b) return;
    if (painted !== bar) {
      if (bar > 0 && painted === bar - 1) {
        candleSeries.update(toBar(state.candles[bar - 1])); // finish the old bar
        volSeries.update(toVol(state.candles[bar - 1]));
      } else {
        candleSeries.setData(state.candles.slice(0, bar).map(toBar));
        volSeries.setData(state.candles.slice(0, bar).map(toVol));
        chart.timeScale().scrollToRealTime();
      }
      const t = Math.floor(Number(b.ts) / 1000);
      candleSeries.setMarkers(markers.filter((m) => m.time <= t));
      basisSeries.setData(basisPoints.filter((x) => x.time <= t));
      if (state.curve.length) {
        const pts = state.curve.slice(0, bar + 1)
          .filter((x) => Number.isFinite(Number(x.total)) && Number.isFinite(Number(x.ts)))
          .map((x) => ({ time: Math.floor(Number(x.ts) / 1000), value: Number(x.total) }));
        pnlSeries.setData(pts);
      }
      painted = bar;
      onBarEntered(bar);
    }
    candleSeries.update(formingRow(bar, p));
    volSeries.update(toVol(b));
    chart.timeScale().scrollToRealTime();
  }

  /* ---------------- fills per bar, markers, effects ---------------- */

  function fillsInBar(bar) {
    const out = [];
    for (const f of state.fills || []) {
      if (barAt(Number(f.ts)) === bar && Number.isFinite(Number(f.usd)) && Number(f.usd) > 0) out.push(f);
    }
    return out;
  }

  /** Precompute chart markers + which bars carry fills, once per build. */
  function prepareMarks() {
    filledBars = new Set();
    // Each fill learns what it REALIZED, by cumulative fold - the same
    // accounting core the server tests pin. A sell's bubble shows the profit
    // it booked against the running cost basis; a buy realizes nothing.
    const inOrder = (state.fills || []).slice().sort((a, b) => a.ts - b.ts);
    if (window.ReplayCore) {
      let prev = 0;
      for (let i = 0; i < inOrder.length; i++) {
        const pos = ReplayCore.foldFills(inOrder.slice(0, i + 1));
        inOrder[i]._realized = (pos.realized || 0) - prev;
        prev = pos.realized || 0;
      }
    }
    const rows = [];
    for (const f of state.fills || []) {
      const bar = barAt(Number(f.ts));
      if (bar < 0) continue;
      filledBars.add(bar);
      rows.push({
        time: Math.floor(Number(state.candles[bar].ts) / 1000),
        position: f.side === 'sell' ? 'aboveBar' : 'belowBar',
        color: f.side === 'sell' ? '#ff5c7a' : '#34d399',
        shape: f.side === 'sell' ? 'arrowDown' : 'arrowUp',
        text: usdCompact(f.usd),
        usd: Number(f.usd) || 0,
      });
    }
    /* The space goes to the trades worth reading: the six biggest keep their
     * label, the rest stay arrows. Ascending time - the library requires it. */
    const bySize = rows.slice().sort((a, b) => b.usd - a.usd);
    const labeled = new Set(bySize.slice(0, 6));
    markers = rows
      .sort((a, b) => a.time - b.time)
      .map((m) => ({ time: m.time, position: m.position, color: m.color, shape: m.shape, text: labeled.has(m) ? m.text : '' }));

    // Average cost per bar, for the basis line: fold fills up to each bar
    // once (O(n) - walk fills and bars together), price = costUsd/qty while
    // the wallet holds. Zero-position bars carry no line.
    basisPoints = [];
    if (window.ReplayCore && inOrder.length && state.wallet) {
      let fi = 0, qty = 0, cost = 0;
      for (const c of state.candles) {
        const barEnd = Number(c.ts) + 60000;
        while (fi < inOrder.length && Number(inOrder[fi].ts) < barEnd) {
          const f = inOrder[fi++];
          const b = Number(f.base) || 0, u = Number(f.usd) || 0;
          if (f.side === 'sell') {
            const avg = qty > 0 ? cost / qty : 0;
            const sold = Math.min(b, qty);
            qty -= sold; cost -= sold * avg;
            if (qty <= 1e-9) { qty = 0; cost = 0; }
          } else { qty += b; cost += u; }
        }
        if (qty > 1e-9 && cost > 0) {
          const px = cost / qty;
          basisPoints.push({ time: Math.floor(Number(c.ts) / 1000), value: capMode ? px * state.supply : px });
        }
      }
    }
  }

  /**
   * A fill lands: wash the chart, float the number. A new fill pushes the
   * previous label OUT rather than stacking on it - at 8x a busy wallet lands
   * fills faster than a label can finish leaving.
   */
  function spawnFlashes(bar) {
    if (!fxOn) return;
    const inBar = fillsInBar(bar);
    if (!inBar.length) return;
    const layer = $('fx');
    // Whatever is on screen makes way.
    for (const f of flashes) retireFlash(f, true);
    flashes = [];
    const cap = denom(state.candles[bar].c);
    inBar.slice(0, 3).forEach((f, slot) => {
      const el = document.createElement('div');
      const isBuy = f.side !== 'sell';
      el.className = 'rp-flash ' + (isBuy ? 'buy' : 'sell');
      el.style.top = (30 + slot * 44) + 'px';
      el.innerHTML = usdCompact(f.usd) + ' ' + (isBuy ? 'BUY' : 'SELL') +
        '<span class="cap">(' + capLabel(cap) + (capMode ? ' MC' : '') + ')</span>';
      layer.appendChild(el);
      const wash = document.createElement('div');
      wash.className = 'rp-wash ' + (isBuy ? 'buy' : 'sell');
      layer.appendChild(wash);
      setTimeout(() => wash.remove(), 950);
      const rec = { el, born: Date.now(), gone: false };
      flashes.push(rec);
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-shown')));
      setTimeout(() => { if (!rec.gone) retireFlash(rec, false); }, FLASH_MS);
    });
    // Sells that booked PnL get a bubble pinned to the bar itself, and a
    // profitable one rains confetti - the Trickshot move, sized to ours.
    for (const f of inBar) {
      if (f.side !== 'sell') continue;
      const realized = Number(f._realized);
      if (!Number.isFinite(realized) || Math.abs(realized) < 0.5) continue;
      spawnPnlBubble(bar, realized);
      if (realized > 0) spawnConfetti(bar, realized);
      break; // one bubble per bar - routers split sells into many fills
    }
  }

  /** Chart-space anchor for a bar: x from the time scale, y above the high.
   * Clamped to the PANE - the drawable area left of the price axis - so a
   * label never covers the axis or hangs off an edge. */
  function barAnchor(bar) {
    try {
      const b = state.candles[bar];
      const x = chart.timeScale().timeToCoordinate(Math.floor(Number(b.ts) / 1000));
      const y = candleSeries.priceToCoordinate(denom(b.h));
      if (x === null || y === null) return null;
      const wrap = $('rp-chart-wrap');
      let axisW = 56;
      try { axisW = chart.priceScale('right').width() || 56; } catch { /* keep guess */ }
      const paneW = (wrap.clientWidth || 900) - axisW;
      const paneH = wrap.clientHeight || 500;
      return {
        x: Math.min(Math.max(x, 60), paneW - 60),
        y: Math.min(Math.max(y, 46), paneH - 60),
      };
    } catch { return null; }
  }

  /**
   * The number that matters, where it happened: "+$1.2K" springs out of the
   * sell bar and drifts up. Anchored one frame LATE - the chart scrolls to
   * real time after the bar paints, and an anchor read before that settles
   * lands a bar-width to the right of the candle it belongs to. Only one
   * bubble lives at a time; a new sell displaces the old (8x tapes land
   * sells faster than a 1.9s drift can finish).
   */
  let liveBubble = null;
  function spawnPnlBubble(bar, realized) {
    requestAnimationFrame(() => {
      if (liveBubble) { liveBubble.remove(); liveBubble = null; }
      const layer = $('fx');
      const el = document.createElement('div');
      const up = realized >= 0;
      el.className = 'rp-pnl-pop ' + (up ? 'up' : 'down');
      el.textContent = (up ? '+' : '\u2212') + usdCompact(Math.abs(realized));
      const a = barAnchor(bar);
      if (a) {
        el.style.left = a.x + 'px';
        el.style.top = a.y + 'px';
      } else {
        el.style.left = '50%';
        el.style.top = '18%';
      }
      layer.appendChild(el);
      liveBubble = el;
      requestAnimationFrame(() => el.classList.add('is-live'));
      setTimeout(() => { if (liveBubble === el) liveBubble = null; el.remove(); }, 1900);
    });
  }

  /**
   * Confetti for a green sell. DOM particles, ~26 of them, one-shot;
   * transform+opacity only so the compositor does the work. Count scales
   * gently with the win so a $50 scalp doesn't celebrate like a $50K exit.
   * Same one-frame delay as the bubble: they must agree on the origin.
   */
  function spawnConfetti(bar, realized) {
    requestAnimationFrame(() => {
      const layer = $('fx');
      const a = barAnchor(bar);
      const wrap = $('rp-chart-wrap');
      const ox = a ? a.x : wrap.clientWidth / 2;
      const oy = a ? a.y : 40;
      const n = Math.min(18 + Math.floor(Math.log10(Math.max(realized, 10)) * 8), 46);
      const colors = ['#34d399', '#a7f3d0', '#fbbf24', '#f9fafb', '#6ee7b7'];
      for (let i = 0; i < n; i++) {
        const p = document.createElement('div');
        p.className = 'rp-confetti';
        const ang = (Math.random() * Math.PI) - Math.PI / 2 - Math.PI / 2; // up half
        const v = 60 + Math.random() * 150;
        p.style.background = colors[i % colors.length];
        p.style.left = ox + 'px';
        p.style.top = oy + 'px';
        p.style.setProperty('--dx', (Math.cos(ang) * v).toFixed(0) + 'px');
        p.style.setProperty('--dy', (Math.sin(ang) * v - 40).toFixed(0) + 'px');
        p.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
        p.style.animationDelay = (Math.random() * 120) + 'ms';
        layer.appendChild(p);
        setTimeout(() => p.remove(), 1500);
      }
    });
  }
  function retireFlash(rec, displaced) {
    if (rec.gone) return;
    rec.gone = true;
    rec.el.classList.add('is-out');
    setTimeout(() => rec.el.remove(), displaced ? 260 : 700);
  }
  function clearFlashes() {
    for (const f of flashes) { f.gone = true; f.el.remove(); }
    flashes = [];
    const layer = $('fx');
    if (layer) layer.querySelectorAll('.rp-wash').forEach((w) => w.remove());
  }

  /** Sound + effects + ledger, once per bar the playhead ENTERS. */
  function onBarEntered(bar) {
    spawnFlashes(bar);
    // One cue per side per bar - a router splitting a sale across pools
    // would fire a dozen tills at once. Volume scales with the bar's biggest
    // fill: a $40 nibble whispers, a $40K exit slams the drawer.
    const inBar = fillsInBar(bar);
    const sells = inBar.filter((f) => f.side === 'sell');
    const buys = inBar.filter((f) => f.side !== 'sell');
    const sizeGain = (fs) => {
      const usd = Math.max(...fs.map((f) => Number(f.usd) || 0), 1);
      return 0.45 + Math.min(Math.log10(usd) / 5, 1) * 0.9; // $1->0.45, $100K->1.35
    };
    if (sells.length) playCue('kaching', sizeGain(sells));
    else if (buys.length) playBuyBlip(sizeGain(buys));
    const total = Number((state.curve[bar] || {}).total);
    if (Number.isFinite(total)) {
      const reached = Math.max(Math.floor(total / FANFARE_AT), 0);
      if (reached > fanfareTier) { fanfareTier = reached; playCue('bandos'); }
      else if (reached < fanfareTier) fanfareTier = reached; // re-arm after a dip
    }
    ledgerAt(bar); markTape(bar); headlineAt(bar);
    playIdx = bar;
    $('scrub').value = bar;
    $('tlabel').textContent = (bar + 1) + ' / ' + state.candles.length;
  }

  /* ---------------- frame loop ---------------- */

  function loop(now) {
    if (!playing) return;
    const dt = Math.min(now - lastFrame, 100); // a background tab does not fast-forward
    lastFrame = now;
    clipMs += dt * SPEEDS[speedIdx];
    const stepMs = STEP_MS;
    const exact = clipMs / stepMs;
    const bar = Math.floor(exact);
    const last = state.candles.length - 1;
    if (bar > last) {
      seek(last, 1);
      stopPlay();
      showCredits();
      return;
    }
    seek(bar, Math.min(exact - bar, 1));
    rafId = requestAnimationFrame(loop);
  }

  /**
   * The tape ran out: roll credits. A verdict card over the chart - total
   * PnL, money in/out, best single exit - built ONLY from the folded fills
   * already on screen. Dismissed by scrub, rebuild, or its replay button.
   */
  function showCredits() {
    dropCredits();
    if (!state.wallet || !state.fills.length || !window.ReplayCore) return;
    const pos = ReplayCore.foldFills(state.fills);
    const lastBar = state.candles[state.candles.length - 1];
    const pnl = ReplayCore.pnlAt(pos, lastBar ? Number(lastBar.c) : 0);
    const total = Number(pnl.total) || 0;
    const up = total >= 0;
    const sells = state.fills.filter((f) => f.side === 'sell' && Number.isFinite(Number(f._realized)));
    const best = sells.length ? Math.max(...sells.map((f) => Number(f._realized))) : null;
    const el = document.createElement('div');
    el.className = 'rp-credits ' + (up ? 'up' : 'down');
    el.id = 'rp-credits';
    el.innerHTML =
      '<div class="verdict">' + (up ? 'CAME OUT UP' : 'PAID THE CHAIN') + '</div>' +
      '<div class="big">' + (up ? '+' : '\u2212') + usdCompact(Math.abs(total)) + '</div>' +
      '<div class="row"><span>In ' + usdCompact(pos.boughtUsd || 0) + '</span>' +
      '<span>Out ' + usdCompact(pos.soldUsd || 0) + '</span>' +
      (best !== null && best > 0 ? '<span>Best exit +' + usdCompact(best) + '</span>' : '') +
      '</div>' +
      '<button type="button" class="again" id="rp-again">\u21bb Run it back</button>';
    $('fx').appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
    el.querySelector('#rp-again').addEventListener('click', () => {
      dropCredits();
      clipMs = 0; painted = -1; playIdx = 0; fanfareTier = armTier(0);
      startPlay();
    });
    if (up && total > 0) spawnConfetti(state.candles.length - 1, total);
  }
  function dropCredits() {
    const el = document.getElementById('rp-credits');
    if (el) el.remove();
  }
  function startPlay() {
    if (playing || !state.candles.length) return;
    dropCredits();
    if (playIdx >= state.candles.length - 1) { clipMs = 0; painted = -1; fanfareTier = armTier(0); }
    playing = true;
    lastFrame = performance.now();
    $('ic-play').style.display = 'none'; $('ic-pause').style.display = '';
    rafId = requestAnimationFrame(loop);
  }
  function stopPlay() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    $('ic-play').style.display = ''; $('ic-pause').style.display = 'none';
  }

  /** The fanfare tier the replay OPENS at - armed, not sounded. */
  function armTier(bar) {
    const t = Number((state.curve[bar] || {}).total);
    return Number.isFinite(t) ? Math.max(Math.floor(t / FANFARE_AT), 0) : 0;
  }

  /* ---------------- build ---------------- */

  async function build(walletOverride) {
    const mint = parseMint($('mint').value);
    const wallet = walletOverride !== undefined ? walletOverride : parseAddr($('wallet').value);
    if (!mint) { setStatus('Enter a valid mint address or pump.fun link.', 'err'); return; }
    if (walletOverride !== undefined) $('wallet').value = walletOverride || '';
    prepareSfx(); // user gesture: the only moment a browser lets audio start
    setStatus('Rebuilding the chain - first load takes a few seconds\u2026', 'busy');
    $('build').disabled = true;
    try {
      const hist = await api('history', { mint, chain: 'solana' });
      state.mint = mint;
      state.candles = hist.candles || [];
      state.board = (hist.leaderboard && (hist.leaderboard.top || [])) || [];
      state.token = hist.token || null;
      state.supply = (state.token && Number(state.token.supply)) || 0;
      capMode = state.supply > 0;
      state.wallet = wallet || null;
      if (wallet) {
        const wd = await api('wallet', { mint, wallet, chain: 'solana' });
        state.fills = wd.fills || [];
        state.curve = wd.curve || [];
        state.pnl = wd.pnl || {};
        // The worker's chain lane runs from datacenter IPs that public Solana
        // RPCs 403. When it comes back empty, THIS browser retries the same
        // rebuild from the user's own IP - and folds the fills with the same
        // shipped accounting core the server tests prove (vendor/replay-core).
        if (!state.fills.length && window.ReplayChain && window.ReplayCore) {
          setStatus('Reading the wallet\u2019s history from the chain\u2026', 'busy');
          try {
            const lane = await ReplayChain.walletFills(wallet, mint, state.candles, {});
            if (lane.fills.length) {
              state.fills = lane.fills;
              state.curve = ReplayCore.replayCurve(lane.fills, state.candles);
              const pos = ReplayCore.foldFills(lane.fills);
              const last = state.candles[state.candles.length - 1];
              state.pnl = ReplayCore.pnlAt(pos, last ? Number(last.c) : 0);
            }
          } catch (err) { /* chain lane is best-effort; the page stays honest */ }
        }
      } else { state.fills = []; state.curve = []; state.pnl = {}; }

      stopPlay(); clearFlashes(); dropCredits();
      odo.live = false; // new film: the counter must not roll over from the last one
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

      ensureChart();
      applyDenomination();
      // The token's ticker, huge and faint behind the candles - the theater
      // marquee. Built-in LWC watermark: zero DOM, scales with the pane.
      chart.applyOptions({
        watermark: {
          visible: !!(state.token && state.token.symbol),
          text: state.token && state.token.symbol ? String(state.token.symbol).toUpperCase() : '',
          color: 'rgba(255,255,255,.045)',
          fontSize: 96,
          fontFamily: '"Space Grotesk", system-ui, sans-serif',
          horzAlign: 'center', vertAlign: 'center',
        },
      });
      prepareMarks();
      painted = -1; clipMs = 0; playIdx = 0;
      fanfareTier = armTier(0);
      if (chart) { candleSeries.setData([]); pnlSeries.setData([]); volSeries.setData([]); basisSeries.setData([]); candleSeries.setMarkers([]); }

      rememberBuild(mint, wallet);
      const qs = new URLSearchParams({ mint });
      if (wallet) qs.set('wallet', wallet);
      history.replaceState(null, '', '/replay?' + qs.toString());
      setStatus('');
      // The FIRST play always happens - a replay that opens paused on an
      // empty frame reads as broken.
      startPlay();
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
    const label = state.token && state.token.symbol ? state.token.symbol : null;
    shelf.unshift({ mint, wallet: wallet || null, at: Date.now(), sym: label });
    shelf = shelf.slice(0, 8);
    try { localStorage.setItem(SHELF_KEY, JSON.stringify(shelf)); } catch { /* private mode */ }
    renderShelf();
  }
  function renderShelf() {
    const shelf = readShelf();
    $('shelf-head').hidden = !shelf.length;
    $('shelf').innerHTML = shelf.map((s) => {
      const who = s.wallet ? '<span class="w">' + short(s.wallet) + '</span>' : '<span class="w dim">whole cast</span>';
      const name = s.sym ? '<span class="m">' + String(s.sym).replace(/[<>&"]/g, '') + '</span>' : '<span class="m">' + short(s.mint) + '</span>';
      return '<button type="button" class="rp-reel" data-mint="' + s.mint + '" data-wallet="' + (s.wallet || '') + '">' +
        name + who + '</button>';
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
    const tok = state.token;
    const name = tok && tok.symbol
      ? '<span class="tkr">' + String(tok.symbol).replace(/[<>&"]/g, '') + '</span><span class="dim"> ' + short(state.mint) + '</span>'
      : '<span class="tkr">' + short(state.mint) + '</span>';
    const icon = tok && tok.icon ? '<img class="rp-token-icon" src="' + tok.icon + '" alt="" referrerpolicy="no-referrer">' : '';
    const who = state.wallet ? ' \u00b7 ' + short(state.wallet) : '';
    t.innerHTML = icon + name + who;
    headlineAt(state.candles.length - 1);
  }

  /** The big number: wallet total PnL when replaying one, last cap otherwise.
   * The PnL number ROLLS - it tweens from where it was to where it is, so a
   * spike reads as a climb, not a cut. */
  let odo = { shown: 0, target: 0, raf: null, live: false };
  function paintOdo() {
    const lp = $('live-price');
    const up = odo.shown >= 0;
    lp.className = 'rp-live-price big ' + (up ? 'up' : 'down');
    lp.innerHTML = '<b>' + (up ? '+' : '\u2212') + usdCompact(Math.abs(odo.shown)) + '</b><span class="cap-l">total pnl</span>';
  }
  function rollOdo() {
    const gap = odo.target - odo.shown;
    if (Math.abs(gap) < Math.max(Math.abs(odo.target) * 0.002, 0.01)) {
      odo.shown = odo.target; paintOdo(); odo.raf = null; return;
    }
    odo.shown += gap * 0.18; // exponential chase: fast when far, soft landing
    paintOdo();
    odo.raf = requestAnimationFrame(rollOdo);
  }
  function headlineAt(bar) {
    const lp = $('live-price');
    if (state.wallet && state.curve.length) {
      const pt = state.curve[Math.min(bar, state.curve.length - 1)] || {};
      const total = Number(pt.total);
      if (Number.isFinite(total)) {
        if (!odo.live) { odo.shown = total; odo.live = true; } // first paint: no roll-in from 0
        odo.target = total;
        if (!odo.raf) odo.raf = requestAnimationFrame(rollOdo);
        return;
      }
    }
    odo.live = false;
    const c = state.candles[Math.min(bar, state.candles.length - 1)];
    if (c && Number.isFinite(Number(c.c))) {
      const first = state.candles[0];
      const up = Number(c.c) >= Number(first ? first.o : c.c);
      lp.className = 'rp-live-price ' + (up ? 'up' : 'down');
      lp.innerHTML = (capMode ? 'cap <b>' + capLabel(denom(c.c)) + '</b>' : 'last <b>' + fmtPrice(Number(c.c)) + '</b>');
    } else lp.textContent = '';
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
    box.innerHTML = list.slice().sort((a, b) => b.ts - a.ts).map((f) => {
      const side = f.side === 'sell' ? 'sell' : 'buy';
      const qty = Number(f.base).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const t = new Date(Number(f.ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div class="rp-fill ' + side + ' is-future" data-ts="' + f.ts + '">' +
        '<span class="chip">' + (side === 'sell' ? 'S' : 'B') + '</span>' +
        '<span class="qty">' + qty + '</span>' +
        '<span class="usd">' + fmtUsd(f.usd) + '</span>' +
        '<span class="at">' + t + '</span></div>';
    }).join('');
  }

  function renderLedger() { ledgerAt(0); }

  function ledgerAt(bar) {
    const pt = (state.wallet && state.curve.length)
      ? state.curve[Math.min(bar, state.curve.length - 1)] || {}
      : (state.wallet ? state.pnl : {});
    const cells = [['led-real', pt.realized], ['led-unreal', pt.unrealized], ['led-total', pt.total]];
    for (const [id, v] of cells) {
      const el = $(id);
      if (!state.wallet || v === undefined || v === null || !Number.isFinite(Number(v))) {
        el.textContent = '--'; el.className = 'v dim'; continue;
      }
      const n = Number(v);
      el.textContent = fmtUsd(n);
      el.className = 'v ' + (n >= 0 ? 'up' : 'down');
    }
    const lf = $('led-fills');
    lf.textContent = state.wallet ? String((state.fills || []).length) : '--';
    lf.className = 'v ' + (state.wallet ? '' : 'dim');
  }

  function markTape(bar) {
    const curT = state.candles[Math.min(bar, state.candles.length - 1)];
    if (!curT) return;
    const nextT = state.candles[Math.min(bar + 1, state.candles.length - 1)];
    const curTs = bar >= state.candles.length - 1 ? Infinity : Number(nextT.ts);
    $('fills').querySelectorAll('.rp-fill').forEach((el) => {
      el.classList.toggle('is-future', Number(el.dataset.ts) >= curTs);
    });
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
  $('play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
  $('scrub').addEventListener('input', (e) => {
    stopPlay();
    dropCredits();
    const bar = Number(e.target.value);
    clipMs = bar * STEP_MS;
    painted = -1; // scrubbing rebuilds; cheap at these sizes
    fanfareTier = armTier(bar); // a scrub is not a gain; do not fanfare it
    clearFlashes();
    seek(bar, 1);
  });
  $('speed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    $('speed').textContent = SPEEDS[speedIdx] + 'x';
  });
  function paintToggles() {
    $('sound').classList.toggle('is-on', soundOn);
    $('sound').setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    $('fx-toggle').classList.toggle('is-on', fxOn);
    $('fx-toggle').setAttribute('aria-pressed', fxOn ? 'true' : 'false');
  }
  $('sound').addEventListener('click', () => {
    soundOn = !soundOn; storeFlag('pt-replay-sound', soundOn);
    if (soundOn) prepareSfx();
    paintToggles();
  });
  $('fx-toggle').addEventListener('click', () => {
    fxOn = !fxOn; storeFlag('pt-replay-fx', fxOn);
    if (!fxOn) clearFlashes();
    paintToggles();
  });
  $('record').addEventListener('click', () => (recording ? stopRecord() : startRecord()));
  $('theater-close').addEventListener('click', closeTheater);
  $('theater-backdrop').addEventListener('click', closeTheater);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('theater').hidden) closeTheater();
    else if (e.key === ' ' && !$('theater').hidden && !$('play').disabled &&
      !/INPUT|BUTTON/.test(document.activeElement.tagName)) {
      e.preventDefault(); (playing ? stopPlay() : startPlay());
    }
  });

  paintToggles();
  $('speed').textContent = SPEEDS[speedIdx] + 'x';
  renderShelf();

  // Deep link: /replay?mint=...&wallet=... builds on arrival.
  const qs = new URLSearchParams(location.search);
  if (qs.get('mint')) {
    $('mint').value = qs.get('mint');
    if (qs.get('wallet')) $('wallet').value = qs.get('wallet');
    build();
  }
})();
