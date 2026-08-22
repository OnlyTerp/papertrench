/* The paper-balance chip in the site header — live.
 *
 * The website cannot know your paper wallet on its own; it lives in the
 * extension, on your machine. It is asked for over the same bridge the
 * leaderboard Sync uses, which answers only when Site sync is switched on.
 *
 * So the chip is absent for most visitors, and that is correct: no extension,
 * or sync off, means the site genuinely does not know, and inventing a
 * balance would be the one thing this project refuses to do.
 *
 * Once shown it stays current. The relay pushes a fresh wallet whenever the
 * extension's state changes, so a fill in another tab moves this number
 * rather than leaving a stale one presented as though it were live.
 */
(() => {
  'use strict';

  const slot = document.getElementById('nav-wallet');
  if (!slot) return;

  const NONCE = 'ptw-' + Math.random().toString(36).slice(2);
  const PING_TIMEOUT_MS = 1500;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function fmt(sol) {
    const n = Number(sol) || 0;
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 100) return n.toFixed(1);
    return n.toFixed(2).replace(/\.00$/, '');
  }

  let chip = null;
  let panel = null;
  let last = null;

  function build() {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nav-wallet';
    chip.setAttribute('aria-expanded', 'false');
    // "Paper" is not decoration. This number sits in the same bar as a
    // leaderboard and a sign-in, and must never be mistaken for real money.
    chip.innerHTML = '<span class="nav-wallet-tag">PAPER</span>'
      + '<span class="nav-wallet-num"></span>';

    panel = document.createElement('div');
    panel.className = 'nav-wallet-panel';
    panel.hidden = true;

    chip.addEventListener('click', () => {
      const open = panel.hidden;
      panel.hidden = !open;
      chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (panel.hidden || slot.contains(e.target)) return;
      panel.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
    });

    slot.appendChild(chip);
    slot.appendChild(panel);
  }

  function render(wallet) {
    if (!wallet) return;                       // no answer: show nothing at all
    const equity = Number(wallet.equitySol);
    if (!Number.isFinite(equity)) return;
    if (!chip) build();

    const numEl = chip.querySelector('.nav-wallet-num');
    const next = fmt(equity) + ' SOL';
    if (numEl.textContent && numEl.textContent !== next) {
      // A number that changes under you should say it changed.
      const rising = last !== null && equity > last;
      numEl.classList.remove('up', 'down');
      void numEl.offsetWidth;                  // restart the animation
      numEl.classList.add(rising ? 'up' : 'down');
    }
    numEl.textContent = next;
    last = equity;

    const open = Number(wallet.openPositions) || 0;
    panel.innerHTML = `
      <div class="nwp-row"><span>Cash</span><b>${esc(fmt(wallet.cashSol))} SOL</b></div>
      <div class="nwp-row"><span>Open positions</span><b>${open}</b></div>
      ${wallet.marked === false
        ? '<div class="nwp-note">Some open positions have no recent price, so this total is partial.</div>'
        : ''}
      <div class="nwp-note">Paper money, read from the extension on this machine. Nothing here is real.</div>`;
  }

  /* ---------- first answer: ask ---------- */

  let answered = false;
  const onMessage = (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data) return;

    // Pushed updates, for as long as the page is open.
    if (data.type === 'pt_site_wallet') { answered = true; render(data.wallet); return; }

    if (data.type !== 'pt_site_bridge_reply' || data.nonce !== NONCE) return;
    answered = true;
    const reply = data.reply;
    if (reply && reply.ok && reply.bridgeEnabled) render(reply.wallet);
  };
  window.addEventListener('message', onMessage);

  window.postMessage(
    { type: 'pt_site_bridge', nonce: NONCE, request: { type: 'pt_bridge_ping' } },
    location.origin
  );

  // No extension, or it never answered. Nothing to say, so nothing is said —
  // but the listener stays, because the relay may push later (Site sync
  // switched on while this page was already open).
  setTimeout(() => { if (!answered) { /* silent */ } }, PING_TIMEOUT_MS);
})();
