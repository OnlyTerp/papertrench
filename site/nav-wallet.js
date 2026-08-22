/* The paper-balance chip in the site header.
 *
 * The website cannot know your paper wallet on its own — it lives in the
 * extension, on your machine. It is asked for over the same bridge the
 * leaderboard Sync uses, which answers only when Site sync is switched on.
 *
 * So the chip is absent for most visitors, and that is correct: no extension,
 * or sync off, means the site genuinely does not know, and inventing a
 * balance would be the one thing this project refuses to do.
 */
(() => {
  'use strict';

  const slot = document.getElementById('nav-wallet');
  if (!slot) return;

  const NONCE = 'ptw-' + Math.random().toString(36).slice(2);
  const TIMEOUT_MS = 1500;

  function fmt(sol) {
    const n = Number(sol) || 0;
    if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (n >= 100) return n.toFixed(1);
    return n.toFixed(2).replace(/\.00$/, '');
  }

  function render(wallet) {
    if (!wallet) return;                       // no answer: show nothing at all
    const equity = Number(wallet.equitySol);
    if (!Number.isFinite(equity)) return;

    const chip = document.createElement('span');
    chip.className = 'nav-wallet';
    // "Paper" is not decoration. This number sits in the same bar as a
    // leaderboard and a sign-in, and must never be mistaken for real money.
    chip.innerHTML = '<span class="nav-wallet-tag">PAPER</span>'
      + '<span class="nav-wallet-num"></span>';
    chip.querySelector('.nav-wallet-num').textContent = fmt(equity) + ' SOL';
    chip.title = wallet.openPositions
      ? `${fmt(wallet.cashSol)} SOL cash · ${wallet.openPositions} open position`
        + `${wallet.openPositions === 1 ? '' : 's'}`
        + (wallet.marked ? '' : ' · some positions have no recent price, so this is partial')
      : 'Your paper wallet, read from the extension on this machine.';
    slot.appendChild(chip);
  }

  // The relay only answers a page on its own origin, and only for the two
  // request types it allow-lists. Ping is the cheap one; the wallet rides on it.
  let done = false;
  const onReply = (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'pt_site_bridge_reply' || data.nonce !== NONCE) return;
    window.removeEventListener('message', onReply);
    if (done) return;
    done = true;
    const reply = data.reply;
    if (reply && reply.ok && reply.bridgeEnabled) render(reply.wallet);
  };
  window.addEventListener('message', onReply);

  window.postMessage(
    { type: 'pt_site_bridge', nonce: NONCE, request: { type: 'pt_bridge_ping' } },
    location.origin
  );

  // No extension, or it never answered. Nothing to say, so nothing is said.
  setTimeout(() => {
    if (done) return;
    done = true;
    window.removeEventListener('message', onReply);
  }, TIMEOUT_MS);
})();
