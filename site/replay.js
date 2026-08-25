/* PaperTrench Replay — canvas candlestick chart + wallet replay.
 *
 * Pure browser logic, no chart library. Fetches /api/replay/history (candles +
 * leaderboard) and /api/replay/wallet (fills + stepping PnL) and draws:
 *   - the token's 1m candles,
 *   - the wallet's buy (green) / sell (red) markers on the bars,
 *   - a PnL line price-guarded to the right axis,
 * with a play/scrub control that steps through the bars, and MediaRecorder
 * canvas→webm export.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('chart'), ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;

  let state = { candles: [], fills: [], curve: [], board: [], pnl: {} };
  let playIdx = 0, playing = false, timer = null;
  let recording = false, recorder = null, chunks = [];

  const API_BASE = '';

  /** A pump.fun link → mint; a bare address → itself. */
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

  async function api(path, params) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/api/replay/${path}?${q}`, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.reason || `HTTP ${res.status}`);
    return data;
  }

  async function build() {
    const mint = parseMint($('mint').value);
    const wallet = parseAddr($('wallet').value);
    $('status').textContent = '';
    $('chartMsg').textContent = '';
    if (!mint) { $('status').textContent = 'Enter a valid mint address or pump.fun link.'; return; }
    $('status').textContent = 'Reconstructing chain history… (first load ~10s)';
    $('build').disabled = true;
    try {
      const hist = await api('history', { mint, chain: 'solana' });
      state.candles = hist.candles || [];
      state.board = (hist.leaderboard && (hist.leaderboard.top || [])) || [];
      let walletData = null;
      if (wallet) {
        walletData = await api('wallet', { mint, wallet, chain: 'solana' });
        state.fills = walletData.fills || [];
        state.curve = walletData.curve || [];
        state.pnl = walletData.pnl || {};
      } else { state.fills = []; state.curve = []; state.pnl = {}; }
      renderBoard();
      if (walletData) renderFills();
      else renderFills([]);
      playIdx = 0; playing = false; stopTick();
      if (!state.candles.length) { $('chartMsg').textContent = 'No candle history for that mint.'; return; }
      $('scrub').max = Math.max(0, state.candles.length - 1);
      $('scrub').value = 0;
      draw(false);
      $('status').textContent = '';
    } catch (e) {
      const reason = typeof e === 'string' ? e : (e && e.message) || '';
      $('status').textContent = {
        'replay-degraded': 'Chain data provider is temporarily down — try again in a minute.',
        'replay-unconfigured': 'Replay is not configured on this deployment yet.',
        'replay-auth': 'Replay provider rejected our key — flag it in #bug-reports.',
        'bad-address': 'That mint or wallet address is not a valid Solana address.',
        'busy': 'Too many builds at once — try again in a moment.',
      }[reason] || ('Build failed: ' + reason);
    } finally { $('build').disabled = false; }
  }

  function renderFills(fills) {
    const box = $('fills');
    const list = fills || state.fills || [];
    if (!list.length) { box.innerHTML = ''; return; }
    const rows = list.slice().reverse().map((f) => {
      const flag = f.side === 'sell' ? 'sell' : 'buy';
      const usd = Number(f.usd).toFixed(2);
      const qty = Number(f.base).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const t = new Date(Number(f.ts)).toLocaleTimeString();
      return `<div class="fill-row"><span><span class="tag ${flag}">${flag === 'sell' ? 'S' : 'B'}</span>${qty} · $${usd}</span><span class="${flag}">${t}</span></div>`;
    }).join('');
    box.innerHTML = rows;
  }

  function renderBoard() {
    const box = $('board');
    if (!state.board.length) { box.innerHTML = '<div class="empty">No traders ranked for this mint yet.</div>'; return; }
    let rows = state.board.map((r, i) => {
      const total = Number(r.total || 0);
      const cls = total >= 0 ? 'pos-positive' : 'pos-negative';
      return `<tr><td><span class="addr">#${i + 1} ${r.wallet.slice(0, 6)}…${r.wallet.slice(-4)}</span></td>
        <td class="${cls}">$${total.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
        <td>${r.buys + r.sells}</td><td>${r.unknownBasis ? '<span title="tokens never bought">gift</span>' : ''}</td></tr>`;
    }).join('');
    box.innerHTML = `<table><thead><tr><th>Wallet</th><th>PnL</th><th>Trades</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function draw(full) {
    const cw = canvas.clientWidth, chh = canvas.clientHeight;
    canvas.width = cw * DPR; canvas.height = chh * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, cw, chh);
    const candles = state.candles;
    if (!candles.length) return;
    // The playhead reveals bars up to playIdx (a "replay", not a full chart).
    const visible = candles.slice(0, playIdx + 1);
    if (!visible.length) return;

    const padL = 62, padR = 62, padT = 16, padB = 24;
    const w = cw - padL - padR, h = chh - padT - padB;
    // price range from visible candles
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

    // grid + price axis
    ctx.strokeStyle = 'rgba(141,151,169,.08)'; ctx.fillStyle = 'rgba(141,151,169,.8)';
    ctx.font = '10px JetBrains Mono'; ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const gp = lo + (hi - lo) * i / 5, gy = y(gp);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(cw - padR, gy); ctx.stroke();
      ctx.fillText(fmtPrice(gp), 4, gy + 3);
    }
    // candles
    for (let i = 0; i < visible.length; i++) {
      const c = visible[i], cx = x(i), up = c.c >= c.o;
      ctx.strokeStyle = up ? '#34d399' : '#e0433a';
      ctx.fillStyle = up ? '#34d399' : '#e0433a';
      ctx.beginPath();
      ctx.moveTo(cx, y(c.h)); ctx.lineTo(cx, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      ctx.fillRect(cx - cwpx / 2, top, cwpx, Math.max(1, bot - top));
    }
    // PnL curve (rhs, price-scaled to its own range) — only when a wallet is replayed
    if (state.curve.length) {
      const pv = state.curve.slice(0, playIdx + 1).filter((p) => Number.isFinite(p.total));
      if (pv.length > 1) {
        let plo = Infinity, phi = -Infinity;
        for (const p of pv) { plo = Math.min(plo, p.total); phi = Math.max(phi, p.total); }
        const span = (phi - plo) || 1; const py = (v) => padT + (1 - (v - plo) / span) * h;
        ctx.strokeStyle = 'rgba(167,139,250,.9)'; ctx.lineWidth = 2; ctx.beginPath();
        pv.forEach((p, i) => { const px = x(i); i ? ctx.lineTo(px, py(p.total)) : ctx.moveTo(px, py(p.total)); });
        ctx.stroke();
      }
    }
    // wallet fill markers on their bars
    const barByTs = new Map(visible.map((c, i) => [Math.floor(Number(c.ts) / 60000) * 60000, i]));
    for (const f of (state.fills || [])) {
      const bi = barByTs.get(Math.floor(Number(f.ts) / 60000) * 60000);
      if (bi === undefined || bi > playIdx) continue;
      const cx = x(bi), cy = y(Number(f.priceUsd));
      const up = f.side !== 'sell';
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 7); ctx.fillStyle = up ? '#34d399' : '#e0433a'; ctx.fill();
      ctx.strokeStyle = '#07090e'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#07090e'; ctx.font = '700 8px Inter'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(up ? 'B' : 'S', cx, cy + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    // time axis
    ctx.fillStyle = 'rgba(141,151,169,.8)';
    const last = visible[visible.length - 1];
    const tt = new Date(Number(last.ts));
    ctx.fillText(tt.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      tt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), padL, chh - 6);
  }

  function fmtPrice(p) {
    if (p >= 1) return p >= 10000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p.toFixed(p >= 100 ? 1 : 3);
    return p.toExponential(2);
  }

  function renderPnl() {
    const p = state.pnl || {};
    const real = Number(p.realized || 0), unreal = Number(p.unrealized || 0), total = Number(p.total || 0);
    const cls = (v) => v >= 0 ? 'pos-positive' : 'pos-negative';
    $('pnl').innerHTML = `
      <div class="pnl-cell"><div class="l">Realized</div><div class="v ${cls(real)}">$${real.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div></div>
      <div class="pnl-cell"><div class="l">Unrealized</div><div class="v ${cls(unreal)}">$${unreal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div></div>
      <div class="pnl-cell"><div class="l">Total PnL</div><div class="v ${cls(total)}">$${total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div></div>
      <div class="pnl-cell"><div class="l">Fills</div><div class="v">${state.fills.length}</div></div>`;
  }

  // ---- playback ----
  function tick() {
    if (!playing) return;
    if (playIdx < state.candles.length - 1) { playIdx++; draw(true); renderPnl(); updateScrub(); }
    else stopTick();
  }
  function startTick() { if (timer) return; playing = true; $('play').textContent = '⏸ Pause'; timer = setInterval(tick, 300); }
  function stopTick() { playing = false; if (timer) { clearInterval(timer); timer = null; } $('play').textContent = '▶ Play'; }
  function updateScrub() { const s = $('scrub'); s.value = playIdx; $('tlabel').textContent = `${playIdx + 1} / ${state.candles.length}`; }

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
      a.href = url; a.download = `papertrench-replay-${Date.now()}.webm`; a.click();
      URL.revokeObjectURL(url); $('record').textContent = '● Record'; $('record').classList.remove('secondary');
    };
    recorder.start();
    recording = true; $('record').textContent = '⏹ Stop'; $('record').classList.add('secondary');
  }
  function stopRecord() { if (recording && recorder.state !== 'inactive') recorder.stop(); recording = false; }

  // ---- wire ----
  $('build').addEventListener('click', build);
  $('mint').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('wallet').addEventListener('keydown', (e) => { if (e.key === 'Enter') build(); });
  $('play').addEventListener('click', () => (playing ? stopTick() : startTick()));
  $('scrub').addEventListener('input', (e) => { playIdx = Number(e.target.value); draw(true); renderPnl(); updateScrub(); });
  $('record').addEventListener('click', () => (recording ? stopRecord() : startRecord()));
  window.addEventListener('resize', () => draw(true));

  renderPnl();
})();
