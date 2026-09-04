/* PaperTrench — warm X links, trading-site side (ISOLATED world).
 *
 * Six jobs:
 *  1. Keep the MAIN-world hook told whether the user's opt-in is on (the hook
 *     itself cannot read extension storage).
 *  2. Intercept plain-anchor clicks on X post/profile links at the capture
 *     phase and route them to the background's warm viewer tab. Capture phase
 *     matters twice over: it runs before the site's own delegated handlers
 *     (several of these sites preventDefault + window.open themselves, so
 *     stopping propagation here is what prevents a double open), and it is the
 *     only place a target="_blank" anchor can be caught at all — those never
 *     call window.open.
 *  3. Relay the MAIN-world hook's programmatic opens to the background.
 *  4. Prefetch AHEAD of the click (Turbo II): on pointerdown — the press is
 *     the commitment, the release is pure latency — and on a cursor
 *     trajectory aimed straight at a link (trajectory.js), the same hover
 *     hint fires early. Hints only; a guess never reveals anything.
 *  5. Run anywhere the user opted in: the terminals load this bundle
 *     statically, and the background registers the same files on Discord /
 *     Telegram / every site (each behind its own toggle). The classifiers
 *     make the extra surface inert except on the exact links this file
 *     exists for — an unclassified click is a native click, everywhere.
 *  6. Warm the socket pool (Turbo III): with a toggle on, preconnect every
 *     other destination family plus x.com — no tabs, no requests, just warm
 *     sockets — so the first cross-site click skips DNS+TLS. A press on an
 *     unclassified cross-origin link preconnects its origin the same way.
 *
 * Modified clicks (ctrl / cmd / shift / alt / non-primary button) are passed
 * through untouched — "open in a real background tab and keep reading" is a
 * workflow, not a bug. Middle clicks fire auxclick, which is not listened to,
 * so they are native by construction.
 */
(() => {
  'use strict';
  if (window.__ptWarmLinks) return;
  window.__ptWarmLinks = true;

  const HOOK_TAG = 'papertrench-warmhook';
  const STATE_TAG = 'papertrench-warmstate';

  let enabled = false;
  let cardsEnabled = false;    // tweet preview card on X-link hover (opt-in)
  let rowHoverEnabled = false; // trigger the preview from anywhere on a row (opt-in)
  let buyHoverEnabled = false; // trigger it from the SITE's own quick-buy pill (opt-in)
  let everywhereEnabled = false; // pump.fun / Solscan warm viewers (opt-in, Turbo)

  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function pushStateToPage() {
    window.postMessage({ source: STATE_TAG, enabled }, window.location.origin);
  }

  function setEnabled(next) {
    const on = next === true;
    const turnedOn = on && !enabled;
    enabled = on;
    pushStateToPage();
    // Pre-warm as soon as a trading tab knows the feature is on, so the FIRST
    // X click of the session is already warm — the reference design only
    // warmed after a click, making every first open a cold one.
    if (turnedOn && contextAlive()) {
      chrome.runtime.sendMessage({ type: 'pt_warm_prewarm' }).catch(() => {});
    }
  }

  // Both switches must be up: the feature's own toggle AND the app-wide
  // master switch — "PaperTrench off" includes link interception. The three
  // hover-preview settings (icon card, whole row, quick-buy pill) are opt-in
  // refinements under the same umbrella.
  function applySettings(settings) {
    // Maintainer (2026-08-05): the master switch is the PAPER switch — speed
    // features live on their own toggles and survive "PaperTrench off".
    const on = !!(settings && settings.warmXLinksEnabled);
    cardsEnabled = !!(settings && settings.warmHoverCardsEnabled);
    rowHoverEnabled = !!(settings && settings.warmHoverRowEnabled);
    buyHoverEnabled = !!(settings && settings.warmHoverBuyEnabled);
    const everywhereOn = !!(settings && settings.warmEverywhereEnabled);
    everywhereEnabled = everywhereOn;
    // No prewarm ping here anymore: destination viewers are click-created
    // only (TRNC/Eyes343 — tabs appearing without a click read as a bug,
    // however warm they made the first open).
    setEnabled(on);
    // Socket pre-warm follows the toggles: hints go in with Turbo/X on, come
    // back out with both off.
    syncPreconnects();
  }

  chrome.storage.local.get(['pt_settings'], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) return;
    applySettings(value.pt_settings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pt_settings) return;
    applySettings(changes.pt_settings.newValue);
  });

  function requestWarmOpen(url) {
    if (!contextAlive()) return false;
    try {
      chrome.runtime.sendMessage({ type: 'pt_warm_open', url }).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  function requestWarmDestOpen(url) {
    if (!contextAlive()) return false;
    try {
      chrome.runtime.sendMessage({ type: 'pt_warmdest_open', url }).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Classify a link into a warm DESTINATION (pump.fun / Solscan), applying
   * the same-site guard: on pump.fun itself, pump.fun links stay native —
   * the site's own SPA router beats a tab swap. */
  function destTargetFor(href) {
    if (!everywhereEnabled) return null;
    const WDs = window.PTWarmDest;
    if (!WDs) return null;
    const target = WDs.classify(href, window.location.href);
    if (!target) return null;
    if (WDs.familyOfHost(window.location.hostname) === target.family) return null;
    return target;
  }
  /* ---- socket pre-warm (Turbo III) --------------------------------------
   * Hover/press hints warm the VIEWER's page; nothing warms the first
   * click's DNS+TCP+TLS — until now. With a toggle on, preconnect every
   * other destination family plus x.com: no tabs, no requests, no cookies,
   * just warm sockets in the browser's shared pool, so the first cross-site
   * click and every viewer navigation skip connection setup. Same-family is
   * excluded (same-origin sockets are already warm). The tags come back out
   * the moment both toggles go off — "off" means nothing injected. */
  const PRECONNECT_MARK = 'data-pt-preconnect';
  const PRESS_PRECONNECT_MAX = 24;
  const pressPreconnected = new Set();

  function preconnectOrigin(origin) {
    try {
      if (typeof origin !== 'string' || origin.indexOf('https://') !== 0) return false;
      if (!document.head) return false;
      if (document.head.querySelector('link[' + PRECONNECT_MARK + '="' + origin + '"]')) return true;
      const pc = document.createElement('link');
      pc.setAttribute('rel', 'preconnect');
      pc.setAttribute('href', origin);
      pc.setAttribute(PRECONNECT_MARK, origin);
      const dns = document.createElement('link');
      dns.setAttribute('rel', 'dns-prefetch');
      dns.setAttribute('href', origin);
      dns.setAttribute(PRECONNECT_MARK, origin);
      document.head.append(pc, dns);
      return true;
    } catch (_) { return false; }
  }

  /** Origins worth warming for the current toggle state: the X origins when X
   * links are on, every other destination family when Turbo is on. The X list
   * lives in one place (warmdest.js) so the toggle filter can never drift
   * from the injected set. */
  function wantedPreconnects() {
    const WDs = window.PTWarmDest;
    const xOrigins = (WDs && Array.isArray(WDs.X_PRECONNECT_ORIGINS) && WDs.X_PRECONNECT_ORIGINS.length)
      ? WDs.X_PRECONNECT_ORIGINS
      : ['https://x.com'];
    const out = [];
    if (enabled) {
      for (const o of xOrigins) if (!out.includes(o)) out.push(o);
    }
    if (everywhereEnabled) {
      if (WDs && typeof WDs.preconnectTargets === 'function') {
        try {
          for (const o of WDs.preconnectTargets(window.location.hostname)) {
            if (!enabled && xOrigins.includes(o)) continue;
            if (!out.includes(o)) out.push(o);
          }
        } catch (_) {}
      }
    }
    return out;
  }

  function syncPreconnects() {
    try {
      if (!document.head) {
        // document_start race on dynamically registered pages: retry once the
        // tree exists rather than silently staying cold.
        document.addEventListener('DOMContentLoaded', () => syncPreconnects(), { once: true });
        return;
      }
      const want = wantedPreconnects();
      if (!everywhereEnabled) dropPrefetchRule();
      if (!want.length) {
        const stale = document.head.querySelectorAll('link[' + PRECONNECT_MARK + '],script[' + PRECONNECT_MARK + ']');
        for (const el of stale) el.remove();
        pressPreconnected.clear();
        return;
      }
      for (const o of want) preconnectOrigin(o);
    } catch (_) {}
  }

  /** Press-time catch-all for links no viewer will take: the click still
   * opens a tab that shares the socket pool, so warming its origin now
   * skips that tab's DNS+TLS. Bounded and deduped; never touches the
   * click, the hint budget, or same-origin links. */
  function pressPreconnect(href) {
    if (pressPreconnected.size >= PRESS_PRECONNECT_MAX) return;
    let url = null;
    try { url = new URL(href, window.location.href); } catch (_) { return; }
    if (!url || url.protocol !== 'https:' || url.origin === window.location.origin) return;
    if (pressPreconnected.has(url.origin)) return;
    if (preconnectOrigin(url.origin)) pressPreconnected.add(url.origin);
  }
  /* ---- same-site dwell prefetch (Turbo III, round 2) ----------------------
   * Cross-site links get a viewer; same-site token links stay native by
   * design — but when the click IS a real navigation, a prefetch started
   * during the hover dwell puts the document in HTTP cache before the
   * button comes back up. Dwell-gated only (a press gives ~100ms, never
   * enough for a document to complete — that would be pure waste), one
   * rule slot latest-wins, Turbo-gated, scoped to five terminals, strict
   * same-origin. Where the site routes internally (pushState), the
   * prefetched document is simply never used. The href is page-controlled:
   * textContent (never innerHTML) keeps it inert, and the classifier plus
   * the same-origin gate bound what can be named. */
  const SAME_SITE_PREFETCH_FAMILIES = ['gmgn', 'axiom', 'padre', 'lute', 'fomo'];
  let prefetchTimer = 0;
  let prefetchRuleEl = null;
  let prefetchUrl = '';

  function sameSitePrefetchTarget(href) {
    if (!everywhereEnabled) return null;
    const WDs = window.PTWarmDest;
    if (!WDs || typeof WDs.sameSitePrefetchable !== 'function') return null;
    let url = null;
    try {
      url = WDs.sameSitePrefetchable(href, window.location.href, window.location.hostname, SAME_SITE_PREFETCH_FAMILIES);
    } catch (_) { return null; }
    if (!url) return null;
    try {
      if (new URL(url, window.location.href).origin !== window.location.origin) return null;
    } catch (_) { return null; }
    return url;
  }

  function dropPrefetchRule() {
    try {
      prefetchUrl = '';
      if (prefetchRuleEl) { prefetchRuleEl.remove(); prefetchRuleEl = null; }
    } catch (_) { prefetchRuleEl = null; }
  }

  function prefetchSameSite(url) {
    if (!url || url === prefetchUrl) return;
    try {
      if (typeof HTMLScriptElement !== 'undefined' && HTMLScriptElement.supports
          && !HTMLScriptElement.supports('speculationrules')) return;
      dropPrefetchRule();
      const el = document.createElement('script');
      el.setAttribute('type', 'speculationrules');
      el.setAttribute(PRECONNECT_MARK, url);
      el.textContent = JSON.stringify({ prefetch: [{ source: 'list', urls: [url], eagerness: 'immediate' }] });
      (document.head || document.documentElement).appendChild(el);
      prefetchRuleEl = el;
      prefetchUrl = url;
    } catch (_) {}
  }



  /** The anchor a pointer event is really aimed at. composedPath() beats
   * target.closest() twice over: shadow DOM retargets `target` to the shadow
   * HOST for listeners out here (hiding the anchor from closest), and the
   * path is computed at dispatch, so it survives sites that re-render the
   * row mid-click. Falls back to closest() where composedPath is missing. */
  function anchorFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path) {
      for (const node of path) {
        if (node && String(node.tagName).toUpperCase() === 'A'
            && node.getAttribute && node.getAttribute('href')) return node;
      }
      return null;
    }
    const target = event.target;
    return target && target.closest ? target.closest('a[href]') : null;
  }

  // WINDOW capture, not document: the window is the first node of the
  // capture path, so no site handler registered deeper (several of these
  // terminals stop propagation aggressively) can eat the click before this
  // sees it.
  window.addEventListener('click', (event) => {
    if ((!enabled && !everywhereEnabled) || event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = anchorFromEvent(event);
    if (!anchor) return;
    const X = window.PTXLinks;
    const href = anchor.getAttribute('href');
    const target = enabled && X ? X.classify(href, window.location.href) : null;
    if (target) {
      // Only claim the click once the message is actually away — with a dead
      // extension context the native navigation must win, not a swallowed click.
      if (!requestWarmOpen(target.url)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const dest = destTargetFor(href);
    if (dest) {
      if (!requestWarmDestOpen(dest.url)) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (enabled) {
      // An X-host link in a form the classifier refused: log it locally, so
      // "warm links don't work on <site>" comes with the exact URL shape.
      try {
        const u = new URL(href, window.location.href);
        if (X && X.isXHost(u.hostname)) {
          console.debug('PaperTrench warm links: unhandled X link form, opening natively: ' + u.href);
        }
      } catch (_) {}
    }
  }, true);

  /* Hover prefetch. A trader hovers a link a beat before clicking it — that
   * dwell is free latency budget. After 120ms on an X link, hint the
   * background: it silently SPA-navigates the HIDDEN viewer to the target, so
   * the eventual click is nothing but "reveal the tab" (~0ms perceived). A
   * hover that never becomes a click costs nothing — the hidden tab is simply
   * parked on a different X page, which is an equally warm place to wait.
   * The hint also wakes the MV3 service worker off the click's critical path.
   * The background enforces the safety rules (never redirect a viewer the
   * user is actually looking at; a hover never creates tabs). */
  const HINT_DWELL_MS = 120;
  const HINT_REPEAT_MS = 5000;
  let hintTimer = 0;
  let hintUrl = '';
  let lastHint = { url: '', t: 0 };

  /** Send the X-viewer hint for a classified target. Deduped: one hint per
   * URL per HINT_REPEAT_MS no matter which signal asked — hover dwell,
   * pointer press, and trajectory share one budget on purpose, so stacking
   * the signals can never stack the traffic. */
  function sendXHint(target) {
    const now = Date.now();
    if (lastHint.url === target.url && now - lastHint.t < HINT_REPEAT_MS) return;
    lastHint = { url: target.url, t: now };
    if (contextAlive()) {
      try { chrome.runtime.sendMessage({ type: 'pt_warm_hint', url: target.url }).catch(() => {}); } catch (_) {}
    }
  }

  /** Same contract for warm destinations (pump.fun / Solscan / terminals). */
  function sendDestHint(dest) {
    const now = Date.now();
    if (lastHint.url === dest.url && now - lastHint.t < HINT_REPEAT_MS) return;
    lastHint = { url: dest.url, t: now };
    if (contextAlive()) {
      try { chrome.runtime.sendMessage({ type: 'pt_warmdest_hint', url: dest.url }).catch(() => {}); } catch (_) {}
    }
  }

  /* ---- preview card (opt-in) --------------------------------------------
   * The terminals' own tweet previews are small and demand pixel-precise
   * hovering on a 14px icon. This card is big, styled for reading, and is
   * itself the click target — clicking anywhere on it warm-opens the target,
   * so nobody has to aim at the icon twice. Post cards render the tweet via
   * the background's oEmbed fetch (cached; a deleted post shows "unavailable"
   * BEFORE anyone spends a click on it). Communities and profiles have no
   * public content endpoint, so they get a slim type card that is still a
   * big click-through. Remote text goes in via textContent only — page-world
   * data never touches innerHTML. */
  let cardHost = null;
  let cardBody = null;
  let cardPendingUrl = '';
  let hideTimer = 0;

  function hideCard() {
    cardPendingUrl = '';
    if (cardHost) cardHost.style.display = 'none';
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 200);
  }

  function ensureCard() {
    if (cardHost && cardHost.isConnected) return true;
    if (!document.body || !document.createElement) return false;
    cardHost = document.createElement('div');
    cardHost.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483646;display:none;';
    const shadow = cardHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '.card{width:440px;max-width:calc(100vw - 24px);box-sizing:border-box;',
      'background:#0E1219;border:1px solid rgba(255,255,255,.13);border-radius:12px;',
      'padding:13px 15px;color:#EAEFF7;cursor:pointer;',
      'font:13.5px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;',
      'box-shadow:0 14px 44px -10px rgba(0,0,0,.75)}',
      '.card:hover{border-color:rgba(255,157,69,.45)}',
      '.author{font-weight:750;font-size:13.5px}',
      '.author.gone{color:#FFB3AE}',
      '.text{margin-top:5px;white-space:pre-wrap;overflow-wrap:break-word;max-height:190px;overflow:hidden}',
      '.date{margin-top:6px;font-size:11.5px;color:#8D97A9}',
      '.foot{margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07);',
      'font-size:11px;color:#FF9D45;font-weight:700}',
    ].join('');
    cardBody = document.createElement('div');
    cardBody.className = 'card';
    shadow.append(style, cardBody);
    cardHost.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    cardHost.addEventListener('mouseleave', scheduleHide);
    cardHost.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = cardHost.getAttribute('data-url');
      hideCard();
      if (url) requestWarmOpen(url);
    }, true);
    document.body.appendChild(cardHost);
    return true;
  }

  /* Where the card goes. Pure geometry, split out from showCard because the
   * quick-buy trigger turns placement into a SAFETY rule rather than a taste
   * one: that trigger sits on the site's real-money buy button, and this card
   * is itself a click target, so a card overlapping the button would eat the
   * click the trader aimed at the button. `avoid` (when given) is that
   * button's rect, and the returned box is guaranteed not to intersect it.
   *
   * Preference order for an avoided placement: LEFT of the button, then
   * right, then below, then above. Left first because every terminal that
   * declares a quick-buy pill puts it at the right edge of the row — the
   * space the cursor did NOT come from and will not travel through. */
  function placeCard(rect, size, view, avoid) {
    const M = 8;   // viewport margin
    const GAP = 10; // clearance from the avoided control
    const clampX = (x) => Math.max(M, Math.min(x, view.width - size.width - M));
    const clampY = (y) => Math.max(M, Math.min(y, view.height - size.height - M));
    const overlaps = (box) => !!avoid && box.left < avoid.right && box.left + size.width > avoid.left
      && box.top < avoid.bottom && box.top + size.height > avoid.top;

    if (avoid) {
      const midY = clampY(avoid.top + (avoid.bottom - avoid.top) / 2 - size.height / 2);
      const midX = clampX(avoid.left + (avoid.right - avoid.left) / 2 - size.width / 2);
      const candidates = [
        { left: avoid.left - GAP - size.width, top: midY },  // left of the pill
        { left: avoid.right + GAP, top: midY },              // right of it
        { left: midX, top: avoid.bottom + GAP },             // below
        { left: midX, top: avoid.top - GAP - size.height },  // above
      ];
      for (const c of candidates) {
        if (c.left < M || c.left + size.width > view.width - M) continue;
        if (c.top < M || c.top + size.height > view.height - M) continue;
        if (!overlaps(c)) return c;
      }
      // Nothing fits cleanly (tiny viewport). Clamp into view, then shove the
      // card off the button's axis — a clamped box that still overlaps is the
      // one case this function exists to prevent, so it never returns one.
      const fallback = { left: clampX(avoid.left - GAP - size.width), top: clampY(midY) };
      if (!overlaps(fallback)) return fallback;
      fallback.top = avoid.bottom + GAP + size.height > view.height - M
        ? Math.max(M, avoid.top - GAP - size.height)
        : avoid.bottom + GAP;
      return fallback;
    }

    // No control to protect: the historical behavior, unchanged — below the
    // anchor, flipped above when the viewport bottom is closer.
    const left = clampX(rect.left);
    let top = rect.bottom + M;
    if (top + size.height > view.height - M) top = Math.max(M, rect.top - size.height - M);
    return { left, top };
  }

  function showCard(rect, target, data, avoid) {
    if (!ensureCard()) return;
    while (cardBody.firstChild) cardBody.removeChild(cardBody.firstChild);
    const row = (cls, text) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      cardBody.appendChild(el);
      return el;
    };
    if (target.kind === 'post') {
      if (!data) return;
      if (data.gone) {
        row('author gone', '𝕏 Post unavailable');
        row('text', 'Deleted or restricted. For a launch tweet, that is a signal by itself.');
      } else {
        row('author', data.authorName || 'Post');
        row('text', data.text || '');
        if (data.date) row('date', data.date);
      }
    } else if (target.kind === 'community') {
      row('author', '𝕏 Community');
      row('text', 'The token’s X community — prefetched in the warm viewer.');
    } else if (target.kind === 'profile') {
      row('author', '@' + (target.handle || ''));
      row('text', 'X profile — prefetched in the warm viewer.');
    } else {
      return;
    }
    row('foot', 'Click to open instantly →');
    cardHost.setAttribute('data-url', target.url);
    cardHost.style.display = 'block';
    const size = { width: 452, height: cardHost.getBoundingClientRect().height || 160 };
    const view = { width: window.innerWidth, height: window.innerHeight };
    const box = placeCard(rect, size, view, avoid);
    cardHost.style.left = box.left + 'px';
    cardHost.style.top = box.top + 'px';
  }

  /** `avoid` (optional) is a control the card must not cover — the quick-buy
   * pill. Passing it also RE-ANCHORS the card onto that control (placeCard
   * positions relative to `avoid` when given), which is the behavior the pill
   * trigger needs: the row's X icon is 14px, can sit anywhere in the row, and
   * a card that appears somewhere the cursor is not reads as a glitch. */
  function requestCard(anchor, target, avoid) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    cardPendingUrl = target.url;
    if (target.kind === 'post') {
      if (!contextAlive()) return;
      try {
        chrome.runtime.sendMessage({ type: 'pt_warm_oembed', url: target.url }).then((data) => {
          // Cursor may have moved on while the fetch ran; a stale card is
          // worse than no card.
          if (cardPendingUrl !== target.url) return;
          if (data && data.ok) showCard(rect, target, data, avoid);
        }).catch(() => {});
      } catch (_) {}
    } else {
      showCard(rect, target, null, avoid);
    }
  }

  /** Row mode (opt-in): resolve the hovered element's token row — the nearest
   * ancestor containing 1-3 X links — and preview its best link (post over
   * community over profile) without the cursor ever touching the icon.
   * Runs only after the dwell, walks at most 8 ancestors, and refuses
   * containers with more than 3 X links (that is the list, not a row). */
  function resolveRow(el) {
    const X = window.PTXLinks;
    if (!X) return null;
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
      if (!node.querySelectorAll) continue;
      const found = [];
      for (const a of node.querySelectorAll('a[href]')) {
        const t = X.classify(a.getAttribute('href'), window.location.href);
        if (t) {
          found.push({ a, t });
          if (found.length > 3) return null;
        }
      }
      if (found.length) {
        const pick = found.find((f) => f.t.kind === 'post')
          || found.find((f) => f.t.kind === 'community')
          || found[0];
        return { row: node, anchor: pick.a, target: pick.t };
      }
    }
    return null;
  }

  function fireHover(anchor, target, viaRow, avoid) {
    sendXHint(target);
    if (cardsEnabled || viaRow) requestCard(anchor, target, avoid);
  }

  const ROW_DWELL_MS = 350;
  let rowTimer = 0;
  let currentRow = null;

  /* ---- quick-buy hover (opt-in) -----------------------------------------
   *
   * Field request (2026-08-11): several terminals put their tweet preview
   * behind a HELD hotkey, and the control a trader's cursor is already on at
   * decision time is the site's own quick-buy pill. So make the pill the
   * trigger — rest on it and the tweet is simply there. No key held, no 14px
   * icon to aim at, and the cursor never leaves the button it came for.
   *
   * This shows PaperTrench's own card, not the terminal's native box. Firing
   * a synthetic keystroke into a live trading terminal to summon ITS popup
   * would mean shipping a guessed per-site hotkey table into an app where the
   * neighbouring keys spend real money; the card is the same information with
   * none of that blast radius.
   *
   * WHICH button is a quick-buy button is not guessed either: it comes from
   * sites.js `rowBuy.buyButtonPattern`, the same live-verified contract the
   * paper-buy chip already places itself against. A site that declares no
   * pattern gets no feature here — inert beats invented. Today that means
   * Axiom and Padre; any site that later earns a verified pattern gets this
   * for free, with no code change.
   */
  const BUY_DWELL_MS = 110;
  // A pill reads "0.5 SOL" or "Buy 1 SOL". Anything long enough to be prose
  // is a panel, a banner or a whole card that happens to contain the word —
  // never the pill, and the loosest declared pattern (Padre's \bSOL\b) needs
  // that ceiling to stay honest.
  const BUY_TEXT_MAX = 40;
  let buyTimer = 0;
  let currentBuyBtn = null;
  let buyPattern = null;
  let buyPatternRead = false;

  /** The current site's declared quick-buy pill pattern, or null. Read once:
   * the adapter is chosen by hostname, which cannot change without a reload. */
  function quickBuyPattern() {
    if (buyPatternRead) return buyPattern;
    buyPatternRead = true;
    try {
      const S = window.PaperTrenchSites;
      const site = S && typeof S.currentSite === 'function' ? S.currentSite() : null;
      const raw = site && site.rowBuy && site.rowBuy.buyButtonPattern;
      buyPattern = raw ? new RegExp(raw, 'i') : null;
    } catch (_) {
      buyPattern = null;
    }
    return buyPattern;
  }

  /** The site's own quick-buy button under this event, or null. PaperTrench's
   * paper-buy chip is excluded by construction: the request was explicitly
   * about the terminal's pill, and our chip already opens the trade panel. */
  function quickBuyFromEvent(event) {
    const pattern = quickBuyPattern();
    if (!pattern) return null;
    let btn = null;
    const el = event.target;
    if (el && el.closest) btn = el.closest('button,[role="button"]');
    if (!btn && typeof event.composedPath === 'function') {
      // Shadow retargeting points event.target at the host, exactly as it does
      // for anchors (anchorFromEvent) — the pill can be inside a component.
      for (const node of event.composedPath()) {
        if (!node || !node.tagName) continue;
        const role = node.getAttribute ? node.getAttribute('role') : null;
        if (node.tagName === 'BUTTON' || role === 'button') { btn = node; break; }
      }
    }
    if (!btn) return null;
    if (btn.closest && btn.closest('#pt-rowbuy-layer')) return null; // ours, not theirs
    const text = (btn.textContent || '').trim();
    if (!text || text.length > BUY_TEXT_MAX) return null;
    return pattern.test(text) ? btn : null;
  }

  // Destination hovers navigate a hidden viewer through a FULL page load, so
  // their dwell is a touch longer than the X SPA hop — a list being skimmed
  // should not chain-navigate the viewer on every row the cursor crosses.
  const DEST_HINT_DWELL_MS = 180;

  window.addEventListener('mouseover', (event) => {
    if (!enabled && !everywhereEnabled) return;
    // Inside the card: it stays.
    if (cardHost && typeof event.composedPath === 'function' && event.composedPath().includes(cardHost)) {
      clearTimeout(hideTimer);
      return;
    }
    const anchor = anchorFromEvent(event);
    const X = window.PTXLinks;
    const target = enabled && anchor && X ? X.classify(anchor.getAttribute('href'), window.location.href) : null;

    if (target) {
      clearTimeout(hideTimer);
      if (target.url === hintUrl) return; // dwell already running/sent for this
      clearTimeout(hintTimer);
      hintUrl = target.url;
      hintTimer = setTimeout(() => fireHover(anchor, target, false), HINT_DWELL_MS);
      return;
    }

    const dest = anchor ? destTargetFor(anchor.getAttribute('href')) : null;
    if (dest) {
      clearTimeout(hideTimer);
      if (dest.url === hintUrl) return; // dwell already running/sent for this
      clearTimeout(hintTimer);
      hintUrl = dest.url;
      hintTimer = setTimeout(() => sendDestHint(dest), DEST_HINT_DWELL_MS);
      return;
    }

    // Same-site token link (stays native by design): dwell-prefetch its
    // document underneath. Falls through on purpose — row previews and the
    // buy pill keep working above it; a prefetch is invisible either way.
    const sameSite = anchor ? sameSitePrefetchTarget(anchor.getAttribute('href')) : null;
    if (sameSite && sameSite !== prefetchUrl) {
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => prefetchSameSite(sameSite), DEST_HINT_DWELL_MS);
    }

    // The site's own quick-buy pill, ranked ABOVE row mode: it is the most
    // specific thing the cursor can be on, and its dwell is deliberately the
    // shortest of the three. This trigger stands in for a HELD KEY, so it has
    // to answer like one — a third of a second would feel like a bug here,
    // and unlike a bare row hover, resting on a buy button is never accidental.
    const buyBtn = (buyHoverEnabled && enabled) ? quickBuyFromEvent(event) : null;
    if (buyBtn) {
      clearTimeout(hideTimer);
      if (buyBtn === currentBuyBtn) return; // already pending/showing for this pill
      currentBuyBtn = buyBtn;
      clearTimeout(buyTimer);
      buyTimer = setTimeout(() => {
        // Rows recycle under a virtualized list: the pill this dwell started
        // on may already belong to a different token, or be gone entirely.
        if (currentBuyBtn !== buyBtn || buyBtn.isConnected === false) return;
        const hit = resolveRow(buyBtn);
        if (!hit) return;
        currentRow = hit.row;
        fireHover(hit.anchor, hit.target, true, buyBtn.getBoundingClientRect());
      }, BUY_DWELL_MS);
      return;
    }
    currentBuyBtn = null;
    clearTimeout(buyTimer);

    scheduleHide();
    if (!rowHoverEnabled || !enabled) return; // row previews are X machinery
    if (currentRow && currentRow.contains && currentRow.contains(event.target)) return; // same row: keep waiting/showing
    currentRow = null;
    clearTimeout(rowTimer);
    const from = event.target;
    rowTimer = setTimeout(() => {
      const hit = resolveRow(from);
      if (!hit) return;
      currentRow = hit.row;
      fireHover(hit.anchor, hit.target, true);
    }, ROW_DWELL_MS);
  }, true);

  /* Press-time prefetch (Turbo II). By pointerdown the user has committed;
   * the click event is still a button-release away (~60-120ms). Fire the
   * HINT now — the hidden viewer starts navigating while the button travels
   * back up, and the click that follows finds a warmer page. Strictly a
   * hint: nothing reveals, so a press that becomes a drag or a cancelled
   * click costs nothing visible (the viewer parks on the pressed target, an
   * equally warm place to wait). The click path is untouched — a press never
   * claims the click, which is why no preventDefault lives here. */
  window.addEventListener('pointerdown', (event) => {
    if ((!enabled && !everywhereEnabled) || event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = anchorFromEvent(event);
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    const X = window.PTXLinks;
    const target = enabled && X ? X.classify(href, window.location.href) : null;
    if (target) { sendXHint(target); return; }
    const dest = destTargetFor(href);
    if (dest) { sendDestHint(dest); return; }
    // Unclassified cross-origin press: no viewer will take this click, but the
    // new tab shares the socket pool — a preconnect now still skips its DNS+TLS.
    pressPreconnect(href);
  }, true);

  /* Trajectory prefetch (Turbo II). A cursor moving decisively AT a link
   * telegraphs the hover before it lands: feed samples to the pure predictor
   * (trajectory.js), project ~200ms ahead, and hint whatever classified link
   * sits at the projected point. Only ever the same hint the dwell would
   * send, on the same dedup budget — a wrong guess costs one hidden hop and
   * nothing visible. Hit tests are throttled to one per TRAJ_CHECK_MS and
   * only run while the predictor calls the motion fast and straight enough
   * to mean something; idle and wandering cursors never reach
   * elementFromPoint. */
  const TRAJ_HORIZON_MS = 200;
  const TRAJ_CHECK_MS = 90;
  let trajTracker = null;
  let trajLastCheck = 0;
  window.addEventListener('mousemove', (event) => {
    if (!enabled && !everywhereEnabled) return;
    const T = window.PTTrajectory;
    if (!T) return;
    if (!trajTracker) trajTracker = T.createTracker();
    const now = Date.now();
    trajTracker.sample(event.clientX, event.clientY, now);
    if (now - trajLastCheck < TRAJ_CHECK_MS) return;
    trajLastCheck = now;
    const p = trajTracker.predict(TRAJ_HORIZON_MS);
    if (!p) return;
    const x = Math.max(0, Math.min(p.x, window.innerWidth - 1));
    const y = Math.max(0, Math.min(p.y, window.innerHeight - 1));
    const el = document.elementFromPoint(x, y);
    const anchor = el && el.closest ? el.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    const X = window.PTXLinks;
    const target = enabled && X ? X.classify(href, window.location.href) : null;
    if (target) { sendXHint(target); return; }
    const dest = destTargetFor(href);
    if (dest) sendDestHint(dest);
  }, { capture: true, passive: true });

  // A scrolling list slides the row out from under the card; a stale card
  // floating over the wrong row misleads, so any scroll dismisses it.
  window.addEventListener('scroll', () => { if (cardHost) hideCard(); }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cardHost) hideCard();
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOOK_TAG || data.type !== 'warm-open') return;
    if (!enabled || typeof data.url !== 'string') return;
    // MAIN-world data is page-controlled: re-classify rather than trust it.
    const X = window.PTXLinks;
    const target = X ? X.classify(data.url, window.location.href) : null;
    if (target) requestWarmOpen(target.url);
  });
})();
