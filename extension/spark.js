/* PaperTrench extension — Daily Spark (DELIGHT-MAP.md A2) client.
 *
 * A blind puzzle: the dashboard shows the day's chart up to the reveal
 * moment T, the player picks a buy/sell moment, then gets a process grade
 * (S/A/B/C/D/F + tone axes) — NEVER a PnL figure. The whole point is the
 * discipline of a call, not the money on it.
 *
 * Two responsibilities, mirroring pnlcard.js:
 *   - sparkModel(api)   — pure: turns the /api/spark/today payload into the
 *                         exact strings/colors/visibility the UI shows.
 *                         No DOM, no canvas.
 *   - renderSpark(el)   — paints that model into the dashboard section.
 *
 * The share card reuses the existing PTPnlCard painter via
 * sparkCardModel(): it ONLY paints the process-grade story, never a PnL.
 */
(() => {
  'use strict';

  const API = 'https://papertrench-api.onerobby.workers.dev';

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

  /** Pure: payload -> display model. Returns null on any invalid shape. */
  function sparkModel(api) {
    if (!api || typeof api !== 'object') return null;
    if (!api.ok || !api.day || !api.mint || !api.tTs) return null;
    if (!Array.isArray(api.bars) || !api.bars.length) return null;
    const bars = api.bars
      .map((b) => ({
        ts: num(b.ts), o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c),
      }))
      .filter((b) => b.ts !== null && b.o !== null && b.h !== null && b.l !== null && b.c !== null)
      .sort((a, b) => a.ts - b.ts);
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

  /** Render the spark section into `el` (a #spark-section container). */
  function renderSpark(el, model) {
    if (!el || !model) return;
    el.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'spark-head';
    head.innerHTML = `
      <div class="spark-title">DAILY SPARK</div>
      <div class="spark-date">${model.dateText}</div>
    `;
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'spark-body';
    body.innerHTML = `
      <div class="spark-chart">
        <canvas class="spark-canvas" width="640" height="220"></canvas>
        <div class="spark-chart-legend">
          <span class="spark-legend-item"><i style="background:${TONE.green.color}"></i> entry</span>
          <span class="spark-legend-item"><i style="background:${TONE.yellow.color}"></i> exit</span>
        </div>
      </div>
      <div class="spark-actions">
        <button type="button" class="spark-btn spark-buy">BUY</button>
        <button type="button" class="spark-btn spark-sell">SELL</button>
        <button type="button" class="spark-btn spark-reveal" disabled>REVEAL GRADE</button>
      </div>
      <div class="spark-verdict" hidden></div>
    `;
    el.appendChild(body);

    drawChart(body.querySelector('.spark-canvas'), model.bars, model.tTs);

    const buyBtn = body.querySelector('.spark-buy');
    const sellBtn = body.querySelector('.spark-sell');
    const revealBtn = body.querySelector('.spark-reveal');
    const verdictBox = body.querySelector('.spark-verdict');

    const state = { buy: null, sell: null };

    const updateButtons = () => {
      buyBtn.classList.toggle('armed', Boolean(state.buy));
      sellBtn.classList.toggle('armed', Boolean(state.sell));
      revealBtn.disabled = !(state.buy && state.sell);
    };

    buyBtn.addEventListener('click', () => {
      state.buy = Date.now();
      updateButtons();
    });
    sellBtn.addEventListener('click', () => {
      state.sell = Date.now();
      updateButtons();
    });
    revealBtn.addEventListener('click', async () => {
      if (!state.buy || !state.sell) return;
      revealBtn.disabled = true;
      revealBtn.textContent = 'GRADING…';
      try {
        const res = await fetch(API + '/api/spark/grade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            day: model.day,
            mint: model.mint,
            actions: [
              { type: 'buy', ts: state.buy },
              { type: 'sell', ts: state.sell },
            ],
          }),
        });
        const bodyJson = await res.json();
        if (!res.ok) throw new Error((bodyJson && bodyJson.reason) || 'HTTP ' + res.status);
        const card = sparkCardModel(bodyJson.verdict, bodyJson.day);
        if (!card) throw new Error('unexpected verdict shape');
        showVerdict(verdictBox, card);
      } catch (err) {
        verdictBox.hidden = false;
        verdictBox.innerHTML = `<p class="spark-error">Couldn't grade just now — ${String(err.message || err)}</p>`;
      } finally {
        revealBtn.textContent = 'REVEAL GRADE';
        revealBtn.disabled = false;
      }
    });
  }

  /** Draw the blind chart: bars up to T, with the reveal line at T. */
  function drawChart(canvas, bars, tTs) {
    if (!canvas || !bars || !bars.length) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pad = 8;
    const min = Math.min(...bars.map((b) => b.l));
    const max = Math.max(...bars.map((b) => b.h));
    const span = max - min || 1;
    const x = (i) => pad + (i / (bars.length - 1)) * (W - pad * 2);
    const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);

    ctx.clearRect(0, 0, W, H);
    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 5; g++) {
      const gy = pad + (g / 4) * (H - pad * 2);
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(W - pad, gy);
      ctx.stroke();
    }
    // Candles
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const cx = x(i);
      const bodyTop = y(Math.max(b.o, b.c));
      const bodyBottom = y(Math.min(b.o, b.c));
      const wickTop = y(b.h);
      const wickBottom = y(b.l);
      const color = b.c >= b.o ? 'rgba(52,211,153,0.85)' : 'rgba(255,95,86,0.85)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, wickTop);
      ctx.lineTo(cx, wickBottom);
      ctx.stroke();
      const bw = Math.max(2, (W - pad * 2) / bars.length * 0.6);
      ctx.fillRect(cx - bw / 2, bodyTop, bw, Math.max(1, bodyBottom - bodyTop));
    }
    // Reveal line at T
    const tIdx = bars.findIndex((b) => b.ts >= tTs);
    if (tIdx >= 0) {
      const tx = x(tIdx);
      ctx.strokeStyle = 'rgba(255,157,69,0.9)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx, pad);
      ctx.lineTo(tx, H - pad);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Last close marker
    const last = bars[bars.length - 1];
    ctx.fillStyle = 'rgba(234,239,247,0.9)';
    ctx.font = '600 12px ui-monospace, Menlo, monospace';
    ctx.fillText(fmtPrice(last.c), W - pad - 70, H - pad - 4);
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
    sparkModel,
    sparkCardModel,
    renderSpark,
    drawChart,
    fmtPrice,
  };

  if (typeof window !== 'undefined') window.PTSpark = api;
  if (typeof self !== 'undefined') self.PTSpark = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();