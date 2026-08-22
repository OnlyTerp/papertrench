/* PaperTrench — papertrench.com page relay (content script, our site ONLY).
 *
 * The site cannot message an unpacked extension: chrome.runtime.sendMessage
 * from a page needs the extension's id, and unpacked installs get a
 * machine-specific one no site can know. This relay closes that gap from
 * the other direction — the extension already runs on every https page by
 * host permission, so a tiny script on our own site can carry the SAME two
 * bridge requests the externally_connectable path serves, plus one inbound
 * fact the page volunteers: "this browser just signed in as @handle".
 *
 * That inbound fact is what turns the dashboard's gray "not verified yet"
 * chip green the moment you sign in on papertrench.com (field report:
 * clicking sign-in "only takes me to the website" — the loop never closed).
 * It is DISPLAY-ONLY: the extension still never phones the server, and the
 * leaderboard goes by the site's word, not the chip.
 *
 * Trust boundary: page messages are untrusted input, even on our own site
 * (any script the page runs can postMessage). Everything is validated —
 * same-window source, same-origin, handle shaped like a real X handle —
 * and the background re-checks the SENDER url against the bridge-origin
 * allowlist, so no other page this extension runs on can replay these
 * message types. The record request stays behind the off-by-default
 * "Site sync" toggle exactly as it does on the external path.
 */
(() => {
  'use strict';

  // X handles: 1-15 word characters. Anything else is not an identity, it
  // is input to be refused.
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'pt_site_identity') {
      const handle = typeof data.handle === 'string' ? data.handle : '';
      if (!HANDLE_RE.test(handle)) return;
      chrome.runtime.sendMessage({ type: 'pt_site_identity', handle }).catch(() => {});
      return;
    }

    if (data.type === 'pt_site_bridge' && typeof data.nonce === 'string') {
      const op = data.request && data.request.type;
      // Closed set: the relay carries exactly what the external bridge
      // serves, nothing else can be smuggled through it.
      if (op !== 'pt_bridge_ping' && op !== 'pt_bridge_get_record') return;
      chrome.runtime.sendMessage({ type: op, viaSiteRelay: true })
        .catch(() => null)
        .then((reply) => {
          window.postMessage(
            { type: 'pt_site_bridge_reply', nonce: data.nonce, reply: reply || null },
            location.origin
          );
        });
    }
  });

  /* Live wallet, pushed rather than polled.
   *
   * The header chip would otherwise be a snapshot from page load: trade in
   * another tab and the number on papertrench.com quietly goes stale, which
   * is worse than not showing it — a wrong balance presented as current.
   *
   * chrome.storage is the same channel every other surface already watches,
   * so a fill anywhere reaches here with no polling and no network. The
   * SUMMARY is not computed here: the relay re-asks the background, so
   * bridgeWallet stays the one place that decides what a balance is, and the
   * Site-sync gate is applied in exactly one place too.
   */
  function pushWallet() {
    chrome.runtime.sendMessage({ type: 'pt_bridge_ping', viaSiteRelay: true })
      .catch(() => null)
      .then((reply) => {
        if (!reply || !reply.ok || !reply.bridgeEnabled || !reply.wallet) return;
        window.postMessage(
          { type: 'pt_site_wallet', wallet: reply.wallet },
          location.origin
        );
      });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // The wallet moves with state; the gate moves with settings. Both have
      // to re-push, or switching Site sync on would show nothing until the
      // next trade.
      if (changes.pt_state || changes.pt_settings) pushWallet();
    });
  }

  // Tell the page a relay exists, so its Sync button can distinguish
  // "extension not installed" from "reply still in flight".
  window.postMessage({ type: 'pt_site_bridge_ready' }, location.origin);
})();
