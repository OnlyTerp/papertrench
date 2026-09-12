/* PaperTrench — prediction trade ticket.
 *
 * The on-page ticket for placing prediction market orders. Renders inside
 * the shadow root on supported venue pages.
 *
 * Contract: every price-bearing surface shows the SIMULATED badge. The
 * ticket never computes a price itself — it sends the intent to the
 * background worker and renders whatever comes back.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT).
 */
(() => {
  'use strict';

  const BRAND_NAME = 'PaperTrench';

  /* B4: a quote is a 30-second promise, not a price tag. The engine refuses
   * to price off a book older than MAX_BOOK_AGE_MS; the ticket must refuse
   * to DISPLAY (and, when fills land, to fill off) a quote older than the
   * same limit, or calibration data gets poisoned by stale fills. The limit
   * is read off the engine when present so the two can never disagree. */
  function maxQuoteAgeMs() {
    try {
      const ms = self.PaperPredictEngine && self.PaperPredictEngine.MAX_BOOK_AGE_MS;
      return ms > 0 ? ms : 30000;
    } catch (e) { return 30000; }
  }

  function quoteStale() {
    const q = state.quote;
    if (!q || !q.quotedAt) return false;
    const t = new Date(q.quotedAt).getTime();
    return isFinite(t) && (Date.now() - t > maxQuoteAgeMs());
  }

  let staleTimer = null;
  function armStaleTimer() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    const q = state.quote;
    if (!q || !q.quotedAt) return;
    const age = Date.now() - new Date(q.quotedAt).getTime();
    if (!isFinite(age)) return;
    const wait = maxQuoteAgeMs() - age;
    if (wait <= 0) return; // already stale: this render shows it
    staleTimer = setTimeout(() => { staleTimer = null; render(); }, wait + 50);
  }
  /* ── State ──────────────────────────────────────────────────────── */

  let state = {
    side: 'buy',
    outcome: 'yes',
    notional: null,
    qty: null,
    quote: null,
    loading: false,
    error: null,
    errorCode: null,
  };

  let market = null;

  /* ── Actions ────────────────────────────────────────────────────── */

  function setSide(side) {
    state.side = side;
    state.quote = null;
    state.error = null;
    state.errorCode = null;
    render();
  }

  function setOutcome(outcome) {
    state.outcome = outcome;
    state.quote = null;
    state.error = null;
    state.errorCode = null;
    render();
  }

  function setAmount(value) {
    const n = Number(value);
    state.qty = Number.isFinite(n) && n > 0 ? n : null;
    state.notional = null;
    state.quote = null;
    render();
  }

  function setNotional(value) {
    const n = Number(value);
    state.notional = Number.isFinite(n) && n > 0 ? n : null;
    state.qty = null;
    state.quote = null;
    render();
  }

  async function requestQuote() {
    if (state.loading) return;
    if (!state.qty && !state.notional) return;

    state.loading = true;
    state.error = null;
    state.errorCode = null;
    render();

    try {
      // Send to background worker
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'PREDICT_QUOTE',
          venue: market?.venue,
          marketId: market?.marketId || market?.eventSlug || market?.marketSlug,
          side: state.side,
          outcome: state.outcome,
          qty: state.qty,
          notional: state.notional,
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });

      if (response?.ok) {
        state.quote = response.data;
      } else {
        state.error = response?.message || 'Quote failed';
        state.errorCode = response?.code || null;
      }
    } catch (e) {
      state.error = e.message || 'Network error';
      state.errorCode = null;
    }

    state.loading = false;
    render();
  }

  async function submitOrder() {
    // B4: a stale quote can never become a fill — not even via a raced
    // click between renders. Drop it and show the re-quote state.
    if (state.quote && quoteStale()) { state.quote = null; render(); return; }
    if (state.loading || !state.quote) return;
    state.loading = true;
    state.error = null;
    state.errorCode = null;
    render();

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'PREDICT_SUBMIT',
          quote: state.quote,
          venue: market?.venue,
          marketId: market?.marketId || market?.eventSlug || market?.marketSlug,
        }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res);
        });
      });

      if (response?.ok) {
        state.quote = null;
        state.qty = null;
        state.notional = null;
      } else {
        state.error = response?.message || 'Order failed';
        state.errorCode = response?.code || null;
      }
    } catch (e) {
      state.error = e.message || 'Network error';
      state.errorCode = null;
    }

    state.loading = false;
    render();
  }

  /* ── Render ─────────────────────────────────────────────────────── */

  // Market titles and error strings arrive from venue APIs and go into
  // innerHTML. They are venue-controlled text, not ours, so they are escaped
  // before they are ever interpolated.
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let container = null;
  let shadow = null;

  function initContainer() {
    if (container) return;
    container = document.createElement('div');
    container.id = 'pt-predict-ticket';
    shadow = container.attachShadow({ mode: 'closed' });
    document.body.appendChild(container);
  }

  function render() {
    if (!shadow) return;
    armStaleTimer();

    const q = state.quote;
    const hasQuote = !!q;
    const stale = quoteStale();
    const quotable = hasQuote && !stale;

    // The panel lives in a CLOSED shadow root, so nothing outside it can read
    // what it is showing — including the automated live pass, which would
    // otherwise have to judge a quote by pixels. The host element carries the
    // same facts as data-* attributes (the house data-pt-* convention): what
    // state the ticket is in, which market the price is FOR, and the price
    // itself. Observable, not internal — these are the numbers already on
    // screen, and a wrong one here is a wrong one there.
    if (container && container.dataset) {
      container.dataset.ptState = state.loading ? 'loading' : hasQuote ? 'quoted' : state.error ? 'error' : 'idle';
      if (hasQuote) {
        container.dataset.ptAvgPrice = String(q.avgPrice);
        container.dataset.ptMarket = String(q.resolvedMarketId || '');
        container.dataset.ptCost = String(q.cost);
        // B4: the quote's birth certificate — the live pass asserts freshness
        // off this, and ptStale names the verdict so no clock math is needed.
        if (q.quotedAt) container.dataset.ptQuotedAt = String(q.quotedAt);
        else delete container.dataset.ptQuotedAt;
        if (stale) container.dataset.ptStale = 'true';
        else delete container.dataset.ptStale;
      } else {
        delete container.dataset.ptAvgPrice;
        delete container.dataset.ptMarket;
        delete container.dataset.ptCost;
        delete container.dataset.ptQuotedAt;
        delete container.dataset.ptStale;
      }
      if (state.error) container.dataset.ptError = String(state.error);
      else delete container.dataset.ptError;
      // B2: machines switch on the code (resolution_lockout | no_liquidity
      // | market_closed | depth_cap vs stale_book | unknown_venue); prose
      // is for users and the next copy tweak must not break the harness.
      if (state.errorCode) container.dataset.ptErrorCode = String(state.errorCode);
      else delete container.dataset.ptErrorCode;
    }

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, system-ui, sans-serif; }
        .ticket {
          position: fixed; bottom: 40px; left: 8px; z-index: 2147483646;
          width: 280px; background: #1a1a2e; color: #e0e0e0;
          border: 1px solid #333; border-radius: 8px; padding: 12px;
          font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .row { display: flex; gap: 6px; margin-bottom: 8px; }
        .btn {
          flex: 1; padding: 6px 0; border: 1px solid #444; border-radius: 4px;
          background: #2a2a3e; color: #e0e0e0; cursor: pointer; font-size: 12px;
          text-align: center; transition: all 0.15s;
        }
        .btn:hover { background: #3a3a5e; }
        .btn.active { border-color: #3b82f6; background: #1e3a5f; color: #60a5fa; }
        .btn.buy { border-color: #22c55e; }
        .btn.buy.active { background: #14532d; color: #4ade80; border-color: #22c55e; }
        .btn.sell { border-color: #ef4444; }
        .btn.sell.active { background: #7f1d1d; color: #f87171; border-color: #ef4444; }
        input {
          width: 100%; padding: 6px 8px; background: #0f0f23; border: 1px solid #444;
          border-radius: 4px; color: #e0e0e0; font-size: 12px; margin-bottom: 8px;
        }
        input:focus { border-color: #3b82f6; outline: none; }
        .submit {
          width: 100%; padding: 8px; border: none; border-radius: 4px;
          background: ${state.side === 'buy' ? '#22c55e' : '#ef4444'}; color: #fff;
          font-weight: 600; cursor: pointer; font-size: 13px;
        }
        .submit:disabled { opacity: 0.5; cursor: not-allowed; }
        .error { color: #f87171; font-size: 11px; margin-top: 4px; }
        .quote-row { display: flex; justify-content: space-between; font-size: 11px; color: #9ca3af; margin-top: 2px; }
        .quote.stale .quote-row { opacity: 0.45; }
        .stale-note { font-size: 11px; color: #f59e0b; margin-top: 4px; text-align: center; }
      </style>
      <div class="ticket">
        <div class="row">
          <button class="btn ${state.side === 'buy' ? 'buy active' : ''}" data-action="side" data-value="buy">BUY</button>
          <button class="btn ${state.side === 'sell' ? 'sell active' : ''}" data-action="side" data-value="sell">SELL</button>
        </div>
        <div class="row">
          <button class="btn ${state.outcome === 'yes' ? 'active' : ''}" data-action="outcome" data-value="yes">YES</button>
          <button class="btn ${state.outcome === 'no' ? 'active' : ''}" data-action="outcome" data-value="no">NO</button>
        </div>
        <input type="number" placeholder="Quantity" min="1" step="1" value="${state.qty || ''}" data-action="qty" />
        ${hasQuote && q.resolvedVia && q.resolvedVia !== 'direct' && q.marketTitle ? `
          <div class="quote-row market"><span>Market</span><span>${escapeHtml(q.marketTitle)}${q.siblingCount > 1 ? ` (1 of ${q.siblingCount})` : ''}</span></div>
        ` : ''}
        ${hasQuote ? `
        <div class="quote${stale ? ' stale' : ''}">
          <div class="quote-row"><span>Avg price</span><span>${q.avgPrice.toFixed(1)}¢</span></div>
          <div class="quote-row"><span>Cost</span><span>P$${q.cost.toFixed(2)}</span></div>
          <div class="quote-row"><span>Fee</span><span>P$${q.fee.toFixed(2)}</span></div>
          <div class="quote-row"><span>Slippage</span><span>${q.slippageBps.toFixed(0)} bps</span></div>
        </div>
        ${stale ? `<div class="stale-note">Price expired — re-quote for a live price.</div>` : ''}
        ` : ''}
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}
        <button class="submit" ${state.loading || (!state.qty && !state.notional) ? 'disabled' : ''} data-action="${quotable ? 'submit' : 'quote'}">
          ${state.loading ? '...' : stale ? 'Re-quote' : quotable ? `${state.side === 'buy' ? 'BUY' : 'SELL'} ${state.outcome.toUpperCase()} @ ${q.avgPrice.toFixed(1)}¢` : 'Get Quote'}
        </button>
        <div class="brand">${BRAND_NAME} · SIMULATED</div>
      </div>
    `;

    // Bind events
    shadow.querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', (e) => {
        const action = el.dataset.action;
        const value = el.dataset.value;
        if (action === 'side') setSide(value);
        else if (action === 'outcome') setOutcome(value);
        else if (action === 'quote') requestQuote();
        else if (action === 'submit') submitOrder();
      });
    });

    const qtyInput = shadow.querySelector('[data-action="qty"]');
    if (qtyInput) {
      qtyInput.addEventListener('input', (e) => setAmount(e.target.value));
    }
  }

  /* ── Public API ─────────────────────────────────────────────────── */

  function mount(marketInfo) {
    market = marketInfo;
    initContainer();
    render();
  }

  function unmount() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    shadow = null;
  }

  const api = { mount, unmount };

  if (typeof window !== 'undefined') window.PaperPredictTicket = api;
  if (typeof self !== 'undefined') self.PaperPredictTicket = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
