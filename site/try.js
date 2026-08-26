(() => {
  'use strict';

  const MINT = 'GfyVVfTSm1YTiuBH6EDAstGY3u9eoBF2HDQoRJaspump';
  const API = 'https://api.dexscreener.com/latest/dex/tokens/' + MINT;
  const SHUT = "Can't read a live rate. Ticket stays shut.";
  const DEMO_SEEDS = [
    'DEMO CHAIN 1',
    'DEMO CHAIN 2',
    'DEMO CHAIN 3',
    'DEMO CHAIN 4'
  ];

  const root = document.getElementById('try');
  const quoteEl = root ? root.querySelector('.try-quote') : null;
  const buyEl = root ? root.querySelector('.try-buy') : null;
  const cheatEl = root ? root.querySelector('.try-cheat') : null;
  const reasonEl = root ? root.querySelector('.try-reason') : null;
  const noteEl = root ? root.querySelector('.try-note') : null;
  const chainEl = root ? root.querySelector('.try-chain') : null;
  const links = chainEl ? Array.from(chainEl.querySelectorAll('.try-link')) : [];
  const fillEl = root ? root.querySelector('.try-fill') : null;
  const copyEl = document.getElementById('copyExtensions');

  let quoted = null;
  let cheated = false;

  function shortMint(mint) {
    if (!mint || mint.length < 8) return mint || '';
    return mint.slice(0, 4) + '…' + mint.slice(-4);
  }

  function line(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el;
  }

  function shutTicket() {
    quoted = null;
    if (buyEl) buyEl.disabled = true;
    if (reasonEl) {
      reasonEl.hidden = false;
      reasonEl.textContent = SHUT;
    }
    if (quoteEl) quoteEl.replaceChildren(line('PAPER · DEMO'));
  }

  function openTicket(priceText) {
    quoted = { text: priceText };
    if (buyEl) buyEl.disabled = false;
    if (reasonEl) {
      reasonEl.hidden = true;
      reasonEl.textContent = '';
    }
    if (!quoteEl) return;
    quoteEl.replaceChildren(
      line('PAPER · DEMO'),
      line('Dexscreener · $PT'),
      line('$' + priceText),
      line(shortMint(MINT))
    );
  }

  function livePrice(data) {
    const pair = data && Array.isArray(data.pairs) ? data.pairs[0] : null;
    if (!pair || pair.priceUsd == null || pair.priceUsd === '') return null;
    const usd = Number(pair.priceUsd);
    if (!Number.isFinite(usd) || usd <= 0) return null;
    return typeof pair.priceUsd === 'string' ? pair.priceUsd : String(pair.priceUsd);
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
    if (!root) return;
    shutTicket();
    let data;
    try {
      const res = await fetch(API, { cache: 'no-store' });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    const priceText = livePrice(data);
    if (!priceText) return;
    openTicket(priceText);
  }

  if (buyEl) {
    buyEl.addEventListener('click', () => {
      if (!quoted || buyEl.disabled) return;
      buyEl.disabled = true;
      if (noteEl) {
        noteEl.hidden = false;
        noteEl.textContent = 'PAPER fill at $' + quoted.text + '. Dexscreener · $PT.';
      }
      if (fillEl) {
        fillEl.hidden = false;
        fillEl.textContent = 'PAPER $' + quoted.text;
      }
    });
  }

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
