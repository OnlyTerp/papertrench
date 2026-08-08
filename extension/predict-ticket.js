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

  /* ── State ──────────────────────────────────────────────────────── */

  let state = {
    side: 'buy',
    outcome: 'yes',
    notional: null,
    qty: null,
    quote: null,
    loading: false,
    error: null,
  };

  let market = null;

  /* ── Actions ────────────────────────────────────────────────────── */

  function setSide(side) {
    state.side = side;
    state.quote = null;
    state.error = null;
    render();
  }

  function setOutcome(outcome) {
    state.outcome = outcome;
    state.quote = null;
    state.error = null;
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
      }
    } catch (e) {
      state.error = e.message || 'Network error';
    }

    state.loading = false;
    render();
  }

  async function submitOrder() {
    if (state.loading || !state.quote) return;

    state.loading = true;
    state.error = null;
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
      }
    } catch (e) {
      state.error = e.message || 'Network error';
    }

    state.loading = false;
    render();
  }

  /* ── Render ─────────────────────────────────────────────────────── */

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

    const q = state.quote;
    const hasQuote = !!q;

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
        .brand { font-size: 10px; color: #666; text-align: center; margin-top: 6px; }
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
        ${hasQuote ? `
          <div class="quote-row"><span>Avg price</span><span>${q.avgPrice.toFixed(1)}¢</span></div>
          <div class="quote-row"><span>Cost</span><span>P$${q.cost.toFixed(2)}</span></div>
          <div class="quote-row"><span>Fee</span><span>P$${q.fee.toFixed(2)}</span></div>
          <div class="quote-row"><span>Slippage</span><span>${q.slippageBps.toFixed(0)} bps</span></div>
        ` : ''}
        ${state.error ? `<div class="error">${state.error}</div>` : ''}
        <button class="submit" ${state.loading || (!state.qty && !state.notional) ? 'disabled' : ''} data-action="${hasQuote ? 'submit' : 'quote'}">
          ${state.loading ? '...' : hasQuote ? `${state.side === 'buy' ? 'BUY' : 'SELL'} ${state.outcome.toUpperCase()} @ ${q.avgPrice.toFixed(1)}¢` : 'Get Quote'}
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
