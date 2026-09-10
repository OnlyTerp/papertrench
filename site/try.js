(() => {
  'use strict';

  const MINT = 'GfyVVfTSm1YTiuBH6EDAstGY3u9eoBF2HDQoRJaspump';
  const API = 'https://api.dexscreener.com/latest/dex/tokens/' + MINT;
  const SHUT = "Can't read a live rate. Ticket stays shut.";
  const QUOTE_TTL_MS = 30000;
  const REQUEST_TIMEOUT_MS = 8000;
  const DEMO_SEEDS = [
    'DEMO CHAIN 1',
    'DEMO CHAIN 2',
    'DEMO CHAIN 3',
    'DEMO CHAIN 4'
  ];

  const root = document.getElementById('try');
  const hud = root ? root.querySelector('.try-hud') : null;
  const quoteEl = root ? root.querySelector('.try-quote') : null;
  const priceEl = root ? root.querySelector('.try-hud-price') : null;
  const buyEl = root ? root.querySelector('.try-buy') : null;
  const cheatEl = root ? root.querySelector('.try-cheat') : null;
  const refreshEl = root ? root.querySelector('.try-refresh') : null;
  const reasonEl = root ? root.querySelector('.try-reason') : null;
  const noteEl = root ? root.querySelector('.try-note') : null;
  const chainEl = root ? root.querySelector('.try-chain') : null;
  const links = chainEl ? Array.from(chainEl.querySelectorAll('.try-link')) : [];
  const fillEl = root ? root.querySelector('.try-fill') : null;
  const sizeEls = root ? Array.from(root.querySelectorAll('.try-size')) : [];
  const copyEl = document.getElementById('copyExtensions');

  let quoted = null;
  let cheated = false;
  let sizeSol = '0.5';
  let quoteExpiry = null;
  let loading = false;
  const markedSize = sizeEls.find((el) => el.classList.contains('is-on'));
  if (markedSize && markedSize.getAttribute('data-sol')) {
    sizeSol = markedSize.getAttribute('data-sol');
  }

  function setSizesOpen(on) {
    sizeEls.forEach((el) => {
      el.disabled = !on;
    });
  }

  function markSize(btn) {
    const next = btn && btn.getAttribute('data-sol');
    if (!next) return;
    sizeSol = next;
    sizeEls.forEach((el) => {
      const on = el === btn;
      el.classList.toggle('is-on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function shortMint(mint) {
    if (!mint || mint.length < 8) return mint || '';
    return mint.slice(0, 4) + '…' + mint.slice(-4);
  }

  function paintHud() {
    if (hud) {
      hud.classList.toggle('is-live', !!quoted);
      hud.classList.toggle('is-cheated', cheated);
    }
  }

  function shutTicket(reason = SHUT) {
    quoted = null;
    window.clearTimeout(quoteExpiry);
    if (buyEl) buyEl.disabled = true;
    setSizesOpen(false);
    if (reasonEl) {
      reasonEl.hidden = false;
      reasonEl.textContent = reason;
    }
    if (priceEl) priceEl.textContent = '-';
    if (quoteEl) quoteEl.textContent = 'Dexscreener · no current quote';
    paintHud();
  }

  function openTicket(priceText) {
    quoted = { text: priceText, at: Date.now() };
    quoteExpiry = window.setTimeout(() => {
      shutTicket('Quote expired. Refresh to open the paper ticket.');
    }, QUOTE_TTL_MS);
    if (buyEl) buyEl.disabled = false;
    setSizesOpen(true);
    if (reasonEl) {
      reasonEl.hidden = true;
      reasonEl.textContent = '';
    }
    if (priceEl) priceEl.textContent = '$' + priceText;
    if (quoteEl) quoteEl.textContent = 'Dexscreener snapshot · valid for 30s · ' + shortMint(MINT);
    paintHud();
  }

  function livePrice(data) {
    let selected = null;
    let depth = -1;
    for (const pair of data && Array.isArray(data.pairs) ? data.pairs : []) {
      if (!pair || pair.chainId !== 'solana' || pair.baseToken?.address !== MINT) continue;
      const usd = Number(pair.priceUsd);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      const liquidity = Number(pair.liquidity?.usd);
      const rank = Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : 0;
      if (rank > depth) {
        selected = String(usd);
        depth = rank;
      }
    }
    return selected;
  }

  async function sha256Hex(text) {
    if (!window.crypto || !crypto.subtle) return null;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function demoChain() {
    const out = [];
    let prev = '';
    for (let i = 0; i < DEMO_SEEDS.length; i++) {
      const seed = DEMO_SEEDS[i];
      const hex = await sha256Hex(prev + seed);
      out.push(hex ? ('DEMO CHAIN · ' + hex.slice(0, 12)) : seed);
      if (hex) prev = hex;
    }
    return out;
  }

  async function loadQuote() {
    if (!root || loading) return;
    loading = true;
    shutTicket('Fetching a fresh quote…');
    if (refreshEl) {
      refreshEl.disabled = true;
      refreshEl.textContent = 'Refreshing…';
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('Quote unavailable');
      const priceText = livePrice(await res.json());
      if (!priceText) throw new Error('No matching quote');
      openTicket(priceText);
    } catch {
      shutTicket(SHUT + ' Try Refresh quote.');
    } finally {
      window.clearTimeout(timeout);
      loading = false;
      if (refreshEl) {
        refreshEl.disabled = false;
        refreshEl.textContent = 'Refresh quote';
      }
    }
  }

  if (refreshEl) refreshEl.addEventListener('click', loadQuote);

  if (buyEl) {
    buyEl.addEventListener('click', () => {
      if (!quoted || buyEl.disabled) return;
      // Background tabs can throttle timers. Freshness is a fill-time gate,
      // not just a visual timeout on the button.
      if (Date.now() - quoted.at >= QUOTE_TTL_MS || Date.now() < quoted.at) {
        shutTicket('Quote expired. Refresh to open the paper ticket.');
        return;
      }
      buyEl.disabled = true;
      setSizesOpen(false);
      const sol = sizeSol || '0.5';
      if (noteEl) {
        noteEl.hidden = false;
        noteEl.textContent = 'PAPER fill · ' + sol + ' SOL at $' + quoted.text + '. Dexscreener · $PT.';
      }
      if (fillEl) {
        fillEl.hidden = false;
        fillEl.textContent = 'PAPER · ' + sol + ' SOL at $' + quoted.text;
      }
    });
  }

  sizeEls.forEach((el) => {
    el.addEventListener('click', () => {
      if (!quoted || el.disabled) return;
      markSize(el);
    });
  });

  if (cheatEl) {
    cheatEl.addEventListener('click', async () => {
      if (!chainEl || links.length < 4) return;
      const labels = cheated ? null : await demoChain();
      if (labels) {
        links.forEach((el, i) => {
          el.textContent = labels[i] || DEMO_SEEDS[i];
        });
      }
      links.forEach((el, i) => {
        el.classList.toggle('is-ok', i === 0);
        el.classList.toggle('is-broken', i > 0);
      });
      chainEl.hidden = false;
      cheated = true;
      paintHud();
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.setAttribute('aria-hidden', 'true');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  if (copyEl) {
    const idle = copyEl.textContent;
    copyEl.addEventListener('click', () => {
      copyText('chrome://extensions').then(() => {
        copyEl.textContent = 'Copied';
      }).catch(() => {
        copyEl.textContent = 'Copy failed';
      });
      window.setTimeout(() => { copyEl.textContent = idle; }, 1600);
    });
  }

  loadQuote();
})();
