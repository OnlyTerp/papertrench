/* PaperTrench — content script.
 *
 * Injected on supported trading sites. Detects the token on screen, pulls the
 * live price from the page itself (via price-bridge.js in the main world), and
 * renders a Shadow-DOM quick-trade panel. Zero paid API calls.
 */
(() => {
  'use strict';

  const E = window.PaperEngine;
  const S = window.PaperTrenchSites;
  const Q = window.PaperQuote;
  // The share-card module (pnlcard.js) — the SAME painter and source builders
  // the dashboard composer uses, so the in-page Flex composer can never show
  // different numbers than the dashboard would for the same result.
  const PC = window.PTPnlCard || null;
  // Price network calls are routed through the service worker, which has the
  // extension's host permissions and is not bound by the page origin's CORS.
  // Keep a reference to the in-page resolver so wiring tests still see it.
  const resolver = window.PaperTrenchResolver;
  function okOrNull(reply) {
    // The background answers failures and unknown types with { error: ... },
    // which must not be treated as a real token record.
    return (reply && typeof reply === 'object' && !reply.error) ? reply : null;
  }
  const R = {
    resolve: (address, opts) => sendMessage({ type: 'pt_resolve', address, maxAgeMs: opts && opts.maxAgeMs, chain: opts && opts.chain }).then(okOrNull),
    refresh: (token) => sendMessage({ type: 'pt_refresh', token }).then(okOrNull),
    solUsd: () => sendMessage({ type: 'pt_sol_usd' }).then((r) => (typeof r === 'number' && r > 0 ? r : 0)).catch(() => 0),
    onchainWatch: (mint, pool) => sendMessage({ type: 'pt_onchain_watch', mint, pool }).then(okOrNull),
    onchainPrewatch: (ids) => sendMessage({ type: 'pt_onchain_prewatch', pool: ids.pool || null, mint: ids.mint || null }).then(okOrNull),
    rugCheck: (mint) => sendMessage({ type: 'pt_rug_check', mint }).then(okOrNull),
    onchainUnwatch: (mint) => sendMessage({ type: 'pt_onchain_unwatch', mint }).catch(() => null),
    onchainQuote: (mint) => sendMessage({ type: 'pt_onchain_quote', mint }).then(okOrNull),
    batchPrices: (mints, chains) => sendMessage({ type: 'pt_batch_prices', mints, chains }).then((r) => (r && typeof r === 'object' && !r.error) ? r : {}),
    clearCache: () => { if (resolver && typeof resolver.clearCache === 'function') resolver.clearCache(); },
  };
  const HOST_ID = 'papertrench-host';
  const DETECT_MS = 800;
  // The heartbeat is a SAFETY NET only — it re-quotes when the feed is quiet
  // and re-renders in case a tick was missed. The primary render path is
  // event-driven: handlePageTick fires the instant the page's own feed or
  // DOM observer delivers a price, and renderPosition() runs right there.
  // 100ms heartbeat catches any missed tick within 1 frame.
  const PRICE_TICK_MS = 100;
  // While a brand-new coin is still unindexed, retry far faster than the
  // ordinary detect cadence, for a bounded window.
  const FAST_RETRY_MS = 250;
  const FAST_RETRY_WINDOW_MS = 90_000;
  const SERIES_CAP = 2400;

  let settings = E.defaultSettings();
  let state = E.defaultState(settings);
  let site = null;
  let token = null; // {kind, address, mint, pairAddress, symbol, priceNative, priceUsd, mcap, anchor}
  let series = [];
  let marks = [];
  let lastHref = '';
  let priceTimer = null;
  let lastPollAt = 0;
  let pollInFlight = false;
  let posEls = null;            // cached position-card nodes, updated in place
  let posOrderEls = null;       // cached TP/SL section nodes on that card
  let thesisEls = null;         // cached thesis card state
  let thesisEditing = false;
  // Wave 2 (F-B12, maintainer: "too big and clunky"): with no thesis yet the
  // panel shows ONE slim prompt line, not a full editor — the composer opens
  // on demand and closes back to the line on save or token change.
  let thesisComposerOpen = false;
  // A buy requested before the first quote existed, to be executed on arrival.
  let armedBuy = null;
  // P0-3: survives a graduation/navigation swap. When the URL changes to a
  // different address, detectLoop immediately swaps in a new pending
  // stand-in (the panel must react to the page, not wait on the network).
  // That swap drops the armed buy and orphans anything keyed to the old
  // identity — correct for a genuine coin switch, fatal for a pump.fun
  // graduation where the SAME coin reappears under its migration pool URL.
  // Shape: { fromMint, armedBuy, at }. Set at the swap, settled in
  // detectLoop once the resolver answers for the new page. Never restored
  // without proof; the armed TTL keeps bounding it the whole time.
  let swapStash = null;
  // F-54: how many prices this token has ACCEPTED since the panel attached.
  // The first bootstrap tick is self-witnessing — an armed buy must wait for
  // the second (the feed proving itself) or a resolver quote.
  let acceptedTickCount = 0;
  let lastTokenKey = '';
  // Trade ids already drawn on THIS page's chart. What makes journal replay
  // idempotent: state adoption re-runs it on every external write (a row
  // snipe in another tab), and a fill already on the chart must never draw
  // twice. Cleared exactly where the bridge is told to clear its marks.
  const drawnFillIds = new Set();
  const ARMED_BUY_TTL_MS = 60_000;
  // D-42: shared with the row-snipe adoption below (declared here so the
  // detectLoop's early use is inside the temporal-dead-zone-safe region).
  const ARMED_ROW_TTL_MS = 60_000;
  let lastRenderedPrice = null; // drives the tick flash
  let lastPriceAt = 0;
  // F-57: when the page's OWN feed last delivered an accepted tick. Kept apart
  // from lastPriceAt, which means "when token.priceNative was last written by
  // anybody" — resolver adoptions included. Only the fill path needs the
  // distinction, and it needs it absolutely (see pickQuoteForTrade).
  let lastPageTickAt = 0;
  let pageQuoteSeq = 0;
  const pageQuoteWaiters = new Set();
  let resolving = false;
  // True once live chain state is streaming for the token on screen.
  let onchainLive = false;
  // Fresh-launch tracking: how long the current address has been unresolved.
  let pendingSince = 0;
  let pendingAttempts = 0;
  let pendingSolUsd = 0;      // warmed SOL/USD rate for bootstrapping USD ticks
  let fastDetectTimer = null;
  let detectLoopTimer = null;
  let barScanTimer = null;
  // Liveness ping to the MAIN-world bridge, so it can tell an alive
  // extension from a dead one and stand its sweeps down (O-04/C-17).
  let bridgePingTimer = null;
  // O-15: re-arms the positions-bar header measurement after SPA navigations
  // (route changes rebuild headers). Assigned per mount, nulled on teardown.
  let restartBarSettle = null;
  let lastCmTickPrice = 0;
  // Sustained out-of-band tick rejections force an early anchor refresh
  // instead of waiting out the 30 s cadence (DEFECT F-10).
  const OOB_REJECTS_FOR_REANCHOR = 5;
  const OOB_REANCHOR_MIN_MS = 3000;
  let oobRejects = 0;
  let lastOobRequoteAt = 0;
  // Armed buys expire on QUIET, not on a clock alone (DEFECT F-16): while
  // validated mcap ticks prove the coin is actively trading, keep waiting for
  // the first fillable price. A hard cap still bounds the wait.
  const ARMED_BUY_MAX_TTL_MS = 300_000;
  let lastMcapTickAt = 0;
  // Track whether the main panel is collapsed to the mini pill.
  let panelMinimized = false;
  // Track an in-progress resize of the trade tab.
  let resizingOverlay = false;
  let resizeStart = null;
  const CM = window.PTChartMarkers; // chart bubble markers
  const TF = window.PTTitleFeed;    // zero-cost market-cap change signal

  /**
   * Return the trusted resolver anchor for the current token. Live chart ticks
   * are validated against this anchor, not against the last accepted tick, so a
   * single wrong page value cannot corrupt every following tick and P&L mark.
   */
  function tokenAnchor() {
    if (token && token.anchor && Number(token.anchor.priceNative) > 0) return token.anchor;
    return token;
  }
  // Which unit band accepted the site's chart ticks ('usd' | 'native' |
  // 'mcap' | 'native-mcap'). This is the ground truth for the chart's Y
  // axis, so average lines are drawn in exactly that unit.
  let chartAxisBasis = null;

  /**
   * Sites KNOWN to chart with TradingView, where PaperTrench draws NATIVE
   * marks and order lines instead of an SVG overlay, with no discovery wait.
   *
   * Native drawing is the only way markers stay glued to the candles when the
   * user pans, zooms, or the chart auto-scales. Padre and Axiom both load the
   * TradingView library and expose a widget with `activeChart()`, so one code
   * path serves both.
   */
  const NATIVE_TV_SITES = new Set(['padre', 'axiom']);
  /* DEFECT C-19: routing is CAPABILITY-based beyond that hardcoded set. The
   * bridge's TradingView discovery is site-agnostic and already runs on
   * Photon/BullX/DexScreener/…; when it reports a usable widget
   * (`nativeCapable` on padre-hook-status), markers and lines take the native
   * path there too. Until the report arrives, the native route is tried
   * optimistically for a bounded grace window; only when the window expires
   * with no widget does the site fall back to the honest SVG rail. GMGN keeps
   * its dedicated native path (gmgn-marker / gmgn-lines). */
  let bridgeNativeCapable = false;
  let nativeProbeStartedAt = 0;
  let nativeProbeTimer = null;
  let svgFallbackActive = false; // the grace window expired; the SVG rail owns rendering
  const NATIVE_PROBE_GRACE_MS = 8000;
  function nativeChartPending() {
    if (!site || bridgeNativeCapable) return false;
    if (NATIVE_TV_SITES.has(site.id) || site.id === 'gmgn') return false;
    return nativeProbeStartedAt > 0 && Date.now() - nativeProbeStartedAt < NATIVE_PROBE_GRACE_MS;
  }
  function usesNativeChart() {
    if (!site) return false;
    if (NATIVE_TV_SITES.has(site.id)) return true;
    if (site.id === 'gmgn') return false; // dedicated native path, never this one
    return bridgeNativeCapable || nativeChartPending();
  }
  /**
   * True only where fills/lines actually render through the generic SVG
   * overlay. GMGN draws natively through its React-held chart manager
   * (gmgn-marker / gmgn-lines), so mounting the SVG overlay there only
   * mutated the host chart container's style.position and burned a
   * MutationObserver + scan timer for markers that never render (DEFECT
   * C-20). Feeding it ticks would grow its price series for nothing.
   */
  function usesSvgMarkers() {
    return Boolean(CM) && !usesNativeChart() && !(site && site.id === 'gmgn');
  }

  /**
   * C-19: (re)arm the native-chart discovery window for a fresh token on a
   * site outside the known-native set. While the window is open the native
   * route is used optimistically (the bridge queues marks harmlessly); when
   * it expires with no widget reported, the SVG rail takes over and replays
   * the journal through itself.
   */
  function beginNativeProbe() {
    if (nativeProbeTimer) { clearTimeout(nativeProbeTimer); nativeProbeTimer = null; }
    svgFallbackActive = false;
    if (!site || NATIVE_TV_SITES.has(site.id) || site.id === 'gmgn' || bridgeNativeCapable) {
      nativeProbeStartedAt = 0;
      return;
    }
    nativeProbeStartedAt = Date.now();
    nativeProbeTimer = setTimeout(() => {
      nativeProbeTimer = null;
      if (contextDead || bridgeNativeCapable || !token) return;
      // No widget within the grace period: this page has no native chart.
      // Drop the optimistically-queued native marks and own the SVG rail.
      svgFallbackActive = true;
      sendPadreMarker('paper-marker-clear');
      sendPadreMarker('paper-lines-clear');
      drawnFillIds.clear(); // the bridge forgot; the replay ledger must too
      if (CM && usesSvgMarkers()) {
        CM.clearMarkers();
        CM.initChartMarkers();
        restoreMarkersFromJournal();
        syncAveragePriceLines();
      }
    }, NATIVE_PROBE_GRACE_MS);
  }
  // (The probe timer's teardown registration lives next to the other
  // onTeardown calls further down — teardownFns does not exist yet here.)

  /** C-19: the bridge found (or confirmed) a usable TradingView widget. */
  function noteNativeCapability(payload) {
    if (!payload || bridgeNativeCapable) return;
    if (!(payload.nativeCapable || payload.barsHooked || payload.marksHooked)) return;
    bridgeNativeCapable = true;
    if (nativeProbeTimer) { clearTimeout(nativeProbeTimer); nativeProbeTimer = null; }
    if (!site || NATIVE_TV_SITES.has(site.id) || site.id === 'gmgn') return;
    if (svgFallbackActive) {
      // The widget appeared after the grace window: hand rendering from the
      // SVG rail to the native chart and replay the journal natively.
      svgFallbackActive = false;
      if (CM) CM.destroyChartMarkers();
      // The rail's replay claimed these fills; the NATIVE chart has not
      // drawn them yet, so the ledger must forget before replaying — the
      // symmetric case to the probe-expiry handoff above.
      drawnFillIds.clear();
      restoreMarkersFromJournal();
      syncAveragePriceLines();
    }
  }
  const profitAlertLevels = new Map(); // mint -> highest threshold already handled
  // Positions bar: prices for tokens whose charts are NOT on screen.
  const BAR_HEIGHT_PX = 38;
  const BAR_POLL_MS = 6000;        // visible tab, off-screen positions
  const BAR_POLL_HIDDEN_MS = 30000; // background tab: stay polite
  let livePositionPrices = {};      // mint -> { priceNative, priceUsd }
  const barChips = new Map();       // mint -> cached chip nodes
  let barTotalEls = null;           // cached aggregate nodes
  let positionsBarHidden = false;
  let barOffsetApplied = false;
  let barPollAt = 0;
  let barPollInFlight = false;
  let audioContext = null;
  let audioPrimed = false;

  let host, shadow, els = {};

  /* -------------------- extension lifetime -------------------- */

  // Reloading or updating the extension kills this script's context, but the
  // already-injected copy keeps running in the page. Every chrome.* call then
  // throws "Extension context invalidated", and because this script is driven
  // by several timers that produced a rejection on EVERY tick plus a visibly
  // thrashing panel. The guard below turns that into a single clean shutdown.
  let contextDead = false;
  const teardownFns = [];

  /**
   * Liveness beacon for the background's re-injection sweep.
   *
   * Chrome does not re-inject content scripts into tabs that were already open
   * when the extension reloads or updates, and the ORPHANED instance left in
   * such a tab keeps every one of its globals — only its chrome.* handles are
   * invalidated. Presence therefore proves nothing; the chrome handle is the
   * only honest signal, so that is what this reports. An orphan answers false
   * and the background rebuilds the tab (background.js reinjectOpenTabs).
   */
  try {
    window.__ptAlive = () => {
      try {
        return !contextDead && Boolean(chrome.runtime && chrome.runtime.id);
      } catch (_) {
        return false;
      }
    };
  } catch (_) { /* a hostile page pinned the property: the sweep re-injects, which is safe */ }

  /** True while this content script may still talk to the extension. */
  function contextAlive() {
    if (contextDead) return false;
    try {
      // chrome.runtime.id becomes undefined the moment the context is gone.
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /** Register a cleanup action to run when the extension goes away. */
  function onTeardown(fn) { teardownFns.push(fn); }

  /* Listeners and timers created per MOUNT (createUI/bindUI/enableOverlay)
   * must die with that mount, not with the page: each overlay off→on cycle
   * used to leak a window mousemove+mouseup pair that survived shutdown()
   * (DEFECT O-26). disableOverlay() runs these; shutdown() runs them too via
   * the onTeardown registration below. */
  let mountCleanups = [];
  function onMountCleanup(fn) { mountCleanups.push(fn); }
  function runMountCleanups() {
    for (const fn of mountCleanups.splice(0)) {
      try { fn(); } catch (_) { /* keep cleaning */ }
    }
  }
  onTeardown(runMountCleanups);

  /**
   * Stop everything and remove our UI from the page.
   *
   * Idempotent: later timers that fire before they are cleared simply see
   * contextDead and return.
   */
  function shutdown(reason) {
    if (contextDead) return;
    contextDead = true;
    for (const fn of teardownFns.splice(0)) {
      try { fn(); } catch (_) { /* keep tearing down */ }
    }
    // DEFECTS O-04/C-17: extension reload/update must not leave chart
    // artifacts welded to the host page. destroyChartMarkers removes the SVG
    // overlay, its observers and its scan timer; the best-effort 'standdown'
    // tells the MAIN-world bridge — which cannot observe extension death
    // itself — to clear native marks/lines and stop re-asserting them.
    try { if (CM) CM.destroyChartMarkers(); } catch (_) {}
    try { sendPadreMarker('standdown'); } catch (_) {}
    try { window.removeEventListener('message', onBridgeMessage); } catch (_) {}
    // The composer's Escape listener rides on window — remove it with the
    // overlay; the modal nodes themselves die with the shadow root. (One
    // try: shutdown can fire before the composer bindings even evaluate.)
    try { closeFlexComposer(); flexEls = null; flexSource = null; flexModel = null; } catch (_) {}
    try { if (host && host.remove) host.remove(); } catch (_) {}
    host = null; shadow = null; els = {};
    posEls = null; alertEls = null; lastRenderedPrice = null;
    // One quiet line, not a per-tick error storm.
    try { console.info('PaperTrench: extension context ended (' + (reason || 'reloaded') + '); overlay removed.'); } catch (_) {}
  }

  /** setInterval that is registered for teardown and dies with the context. */
  function managedInterval(fn, ms) {
    const id = setInterval(() => {
      if (!contextAlive()) { shutdown('invalidated'); return; }
      fn();
    }, ms);
    onTeardown(() => clearInterval(id));
    return id;
  }

  /**
   * Storage access that fails soft.
   *
   * A dead context is an expected end-of-life condition, not an error worth
   * rejecting into the page's console on every heartbeat.
   *
   * get() resolves null when the read FAILED (dead context, lastError, or an
   * exception) and {} when it succeeded but nothing is stored. Callers must
   * never treat a failed read as "empty wallet" — that is how a transient
   * storage hiccup turns into a silent wipe of every open position.
   */
  const store = {
    get: (keys) => new Promise((resolve) => {
      if (!contextAlive()) { shutdown('invalidated'); resolve(null); return; }
      try {
        chrome.storage.local.get(keys, (value) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
          resolve(value || {});
        });
      } catch (_) { shutdown('invalidated'); resolve(null); }
    }),
    set: (obj) => new Promise((resolve) => {
      if (!contextAlive()) { shutdown('invalidated'); resolve(); return; }
      try {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
          resolve();
        });
      } catch (_) { shutdown('invalidated'); resolve(); }
    }),
  };

  /** Fire-and-forget message that never rejects into the page console. */
  function sendMessage(payload) {
    if (!contextAlive()) { shutdown('invalidated'); return Promise.resolve(null); }
    try {
      const result = chrome.runtime.sendMessage(payload);
      return result && typeof result.catch === 'function'
        ? result.catch(() => null)
        : Promise.resolve(result || null);
    } catch (_) {
      shutdown('invalidated');
      return Promise.resolve(null);
    }
  }

  // Exposed for tests so the in-flight storage/messaging paths can be driven
  // directly; harmless in a page (a plain reference on the isolated-world
  // global, which the host page cannot see).
  try { window.__ptStore = store; window.__ptSend = sendMessage; } catch (_) {}

  /* -------------------- MAIN-world bridge messages -------------------- */

  let padreHookStatus = { barsHooked: false, marksHooked: false, linesReady: false };
  let lastMarkerStatus = null;
  let lastLineStatus = null;

  /* A website must never be able to trade on its own. Bridge messages are
   * plain postMessage calls, and the page's own scripts can forge anything
   * the MAIN-world bridge emits. A trade-bearing message therefore requires
   * a recent, genuine user gesture — an isTrusted OS event — which page
   * scripts cannot fabricate. */
  const TRADE_GESTURE_WINDOW_MS = 5000;
  let lastGestureAt = 0;
  // isTrusted is the whole point: page scripts can dispatch synthetic
  // pointerdown events, but those always carry isTrusted=false, so only a
  // real OS gesture updates the window.
  const noteGesture = (ev) => { if (ev && ev.isTrusted) lastGestureAt = Date.now(); };
  window.addEventListener('pointerdown', noteGesture, true);
  window.addEventListener('keydown', noteGesture, true);

  /* SPA navigation: react to route changes the moment they happen instead of
   * waiting out the 800 ms detect poll (DEFECT O-14). pushState/replaceState
   * arrive as a bridge 'nav' message; popstate/hashchange fire here directly. */
  let navDetectTimer = null;
  function scheduleDetect() {
    if (navDetectTimer) return;
    navDetectTimer = setTimeout(() => {
      navDetectTimer = null;
      if (!contextAlive()) return;
      detectLoop();
    }, 30);
  }
  const onNavEvent = () => {
    scheduleDetect();
    if (restartBarSettle) restartBarSettle(); // O-15: headers rebuild on navs
  };
  window.addEventListener('popstate', onNavEvent, true);
  window.addEventListener('hashchange', onNavEvent, true);
  onTeardown(() => {
    window.removeEventListener('popstate', onNavEvent, true);
    window.removeEventListener('hashchange', onNavEvent, true);
    if (navDetectTimer) { clearTimeout(navDetectTimer); navDetectTimer = null; }
  });

  function onBridgeMessage(event) {
    // Same-origin only: foreign-origin and cross-window forges never read
    // as bridge traffic, whatever tag they paste on themselves.
    if (event.source !== window || !event.data || event.data.source !== 'papertrench-bridge') return;
    if (event.origin && event.origin !== location.origin) return;
    const ev = event.data;
    if (ev.type === 'tick') { noteRowPrice(ev.payload); handlePageTick(ev.payload); }
    else if (ev.type === 'facts') handleHostFacts(ev.payload);
    else if (ev.type === 'row-buy') {
      // A quick-buy chip injected by the MAIN-world bridge was tapped; the
      // fill pipeline itself lives here. The done-signal lets the bridge
      // clear the chip's busy state. A website posting this message itself
      // gets nothing: without a genuine recent gesture the fill is refused.
      if (Date.now() - lastGestureAt > TRADE_GESTURE_WINDOW_MS) {
        toast('Paper buy needs a real tap — websites cannot trigger fills');
        // The chip's busy state is cleared ONLY by row-buy-done; a refusal
        // that skipped it left the chip stuck forever (DEFECT F-08).
        sendPadreMarker('row-buy-done', null);
        return;
      }
      if (ev.payload && ev.payload.address) {
        doRowBuy(ev.payload.address, null)
          .finally(() => sendPadreMarker('row-buy-done', null));
      }
    }
    else if (ev.type === 'nav') {
      // The page's router moved (pushState/replaceState in the MAIN world);
      // re-detect immediately instead of waiting for the poll (DEFECT O-14).
      scheduleDetect();
      // O-15: a route change can rebuild the site header — re-measure the
      // positions bar's inset until it stabilizes again.
      if (restartBarSettle) restartBarSettle();
    }
    else if (ev.type === 'padre-hook-status') {
      padreHookStatus = { ...padreHookStatus, ...(ev.payload || {}) };
      // C-19: a reported widget flips this page onto the native route.
      noteNativeCapability(ev.payload);
      renderSiteStatus();
    } else if (ev.type === 'paper-marker-status') {
      lastMarkerStatus = ev.payload || null;
      renderSiteStatus();
    } else if (ev.type === 'paper-lines-status') {
      lastLineStatus = ev.payload || null;
      renderSiteStatus();
    } else if (ev.type === 'paper-order-moved') {
      // A drag landed on the chart. The bridge already refused anything it
      // could not convert back to a price, so an ok:false here means the
      // line snapped back and the wallet is unchanged — say so rather than
      // letting the user think a level moved when it did not.
      const p = ev.payload || {};
      if (p.ok && Number(p.triggerPrice) > 0) adoptDraggedOrder(p.id, Number(p.triggerPrice));
      else toast('That level could not be read off this chart — the line was put back');
    } else if (ev.type === 'paper-order-cancelled') {
      const p = ev.payload || {};
      if (p.id) cancelChartOrder(p.id);
    } else if (ev.type === 'paper-orders-status') {
      lastOrderStatus = ev.payload || null;
      // A chart with no draggable lines is a FACT about that build (F-39),
      // not a transient failure: stop offering the drag and say why once.
      if (ev.payload && ev.payload.reason === 'no-draggable-lines') chartOrdersDraggable = false;
      renderSiteStatus();
    } else if (ev.type === 'gmgn-lines-status') {
      // The GMGN bridge reports only lifecycle status; its labels live on the
      // native TradingView lines rather than in the PaperTrench card.
      renderSiteStatus();
    }
  }
  window.addEventListener('message', onBridgeMessage);

  const HOST_FACT_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const hostSupplyRefusals = new Set();

  function recordHostFactsDiagnostic(message, kind, details) {
    const EL = window.PTErrors;
    if (!EL || typeof EL.record !== 'function') return;
    try {
      EL.record(message, { scope: 'content', kind, ...(details || {}) });
    } catch (_) { /* diagnostics must never affect the trading path */ }
  }

  function refuseHostSupply(mint, facts) {
    if (hostSupplyRefusals.has(mint)) return;
    hostSupplyRefusals.add(mint);
    recordHostFactsDiagnostic('refused host supply for ' + mint
      + ' (mcap/priceUsd disagreed by more than 1%)', 'host-facts-supply-refused', {
      source: facts && facts.source,
      url: facts && facts.url,
      values: facts ? {
        priceUsd: facts.priceUsd, mcap: facts.mcap,
        supply: facts.supply, decimals: facts.decimals,
      } : null,
    });
  }

  function handleHostFacts(facts) {
    if (!facts || !token || !token.pending) return;

    const addresses = Array.isArray(facts.addresses) ? facts.addresses : [];
    const srcAddress = typeof token.srcAddress === 'string' ? token.srcAddress : '';
    const factMint = typeof facts.mint === 'string' ? facts.mint : '';
    if (addresses.indexOf(srcAddress) !== -1
      && HOST_FACT_ADDRESS_RE.test(factMint)
      && factMint !== srcAddress
      && token.mint !== factMint) {
      const oldMint = token.mint;
      if (armedBuy && armedBuy.mint === oldMint) armedBuy.mint = factMint;
      rekeyLiveState(oldMint, factMint);
      token.mint = factMint;
      token.pairAddress = facts.poolAddress || token.pairAddress || null;
      sendPadreMarker('paper-axis', { pairAddress: token.pairAddress, mint: token.mint });
    }

    if (factMint !== token.mint && addresses.indexOf(srcAddress) === -1) return;
    if (token.hostSupplyRejected) return;
    const priceUsd = Number(facts.priceUsd);
    const mcap = Number(facts.mcap);
    if (!(priceUsd > 0) || !(mcap > 0)) return;
    const implied = mcap / priceUsd;
    if (!(implied > 0) || !Number.isFinite(implied)) return;

    const hasSupply = facts.supply !== null && facts.supply !== undefined;
    const rawSupply = Number(facts.supply);
    let declaredUi = null;
    if (hasSupply) {
      if (!(rawSupply > 0) || !Number.isFinite(rawSupply)) {
        refuseHostSupply(token.mint, facts);
        return;
      }
      const decimals = Number(facts.decimals);
      declaredUi = Number.isInteger(decimals) && decimals >= 0
        ? rawSupply / (10 ** decimals) : rawSupply;
      if (!(declaredUi > 0) || !Number.isFinite(declaredUi)
        || Math.abs(implied - declaredUi) / declaredUi > 0.01) {
        refuseHostSupply(token.mint, facts);
        return;
      }
    }

    token.hostSupplyUi = declaredUi || implied;
    token.hostSupplyWitness = {
      source: facts.source || null,
      url: facts.url || null,
      keys: {
        priceUsd: facts.priceUsd,
        mcap: facts.mcap,
        supply: facts.supply,
        decimals: facts.decimals,
      },
      atMs: Date.now(),
    };
  }

  function sendPadreMarker(type, payload) {
    window.postMessage({ source: 'papertrench-content', type, payload: payload || null }, '*');
  }

  /**
   * Value model for the generic SVG overlay. GMGN is not a price chart:
   * its live iframe symbol is `sol/<mint>/USD/MCAP` and its candle endpoint
   * returns market-cap OHLC values. Thus markers must be placed with market
   * cap but continue to display the trader's USD token fill.
   */
  function genericChartPoint(priceNative, priceUsd, mcap) {
    // DEFECT C-09: a fill with null priceUsd must NOT have its market cap
    // derived by multiplying the SOL price into a USD-implied supply — that
    // silently substituted units and landed GMGN arrows ~150x below the
    // candle. Only a genuine USD price may meet the supply; with none, the
    // cap is honestly null and the fill waits until it can be priced (C-16).
    const usd = Number(priceUsd) > 0 ? Number(priceUsd) : null;
    const liveSupply = token && Number(token.mcap) > 0 && Number(token.priceUsd) > 0
      ? Number(token.mcap) / Number(token.priceUsd)
      : null;
    const chartMcap = Number(mcap) > 0 ? Number(mcap)
      : (liveSupply && usd > 0 ? usd * liveSupply : null);

    // The hover figure is the market cap of that fill whenever it is known,
    // because that is the number the trader remembers the entry by.
    if (chartMcap > 0) {
      const plot = site && site.id === 'gmgn' ? chartMcap : (usd || Number(priceNative));
      return { plot, display: chartMcap, currency: 'MCAP' };
    }
    const fallback = usd || Number(priceNative);
    return { plot: fallback, display: fallback, currency: usd ? 'USD' : 'SOL' };
  }

  /* -------------------- price handling -------------------- */

  /**
   * D-42 (Bug 5): last-resort identity from the page's own DOM. Every trade
   * venue headlines the coin it is showing — an h1-ish element near the top,
   * or the document title. Runs at most once per token (nameScraped), only
   * while identity is still unresolved, and returns null on any doubt: a
   * wrong name is worse than the short-CA fallback. The regex accepts ticker
   * symbols and human names but rejects sentences, prices, percentages and
   * addresses — the things venue headers also print.
   */
  function scrapePageTokenName() {
    try {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      const looksLikeIdentity = (s) => {
        if (!s || s.length < 2 || s.length > 48) return false;
        if (/[1-9A-HJ-NP-Za-km-z]{32,44}/.test(s)) return false; // an address
        if (s.includes('http') || /^[\d.,$%/:-]+$/.test(s)) return false; // url / number
        if (s.split(' ').length > 6) return false; // a sentence, not a name
        return true;
      };
      // 1) the page's own headline: the first short text in a header-ish
      //    element near the top of the page.
      const heads = document.querySelectorAll('h1, h2, [class*="token-name"], [class*="TokenName"], [class*="pair-name"], [data-testid*="token-name"]');
      for (const el of heads) {
        if (!el.textContent) continue;
        const r = el.getBoundingClientRect();
        if (r.top > 420) continue; // deep in the page = not the headline
        const t = clean(el.textContent);
        // Common venue headline shape "NAME ticker" — split it.
        const m = t.match(/^(.{2,40}?)\s+([A-Z0-9$]{2,12})$/);
        if (m && looksLikeIdentity(m[1]) && /^[A-Z0-9$]{2,12}$/.test(m[2])) {
          return { name: m[1], symbol: m[2] };
        }
        if (looksLikeIdentity(t)) return { name: t, symbol: null };
      }
      // 2) document.title as the final fallback — venue titles are
      //    "NAME price | ..." or "NAME ticker price ...".
      const ttl = clean(document.title).split(/\s[|·—-]\s/)[0];
      const m2 = ttl.match(/^(.{2,40}?)\s+([A-Z0-9$]{2,12})\s+(?:price|live)/i);
      if (m2 && looksLikeIdentity(m2[1])) return { name: m2[1], symbol: m2[2] };
      if (looksLikeIdentity(ttl) && !/price|chart|trade/i.test(ttl)) {
        return { name: ttl, symbol: null };
      }
      return null;
    } catch (_) { return null; }
  }

  /**
   * A tick from the page's own feed may only refine a price we already trust.
   *
   * For a brand-new coin with no anchor, the FIRST trustworthy on-screen price
   * is bootstrapped directly. This is what makes sniping possible before
   * Dexscreener or Jupiter have indexed the token.
   */
  function handlePageTick(payload) {
    if (!payload || !token) return;

    // Reject cross-token page ticks as early as possible. The bridge is
    // supposed to filter, but a preload chart or an unknown-symbol feed can
    // still leak through.
    if (payload.mint && payload.mint !== token.mint) return;
    if (payload.symbol && token.symbol
      && String(payload.symbol).toUpperCase() !== String(token.symbol).toUpperCase()) return;

    // Market-cap-only ticks (GMGN/Axiom pre-index) cannot price a fill, but
    // they PROVE the coin is actively trading — that keeps an armed buy
    // waiting for its first real price instead of expiring (DEFECT F-16).
    if (Number(payload.mcap) > 0) lastMcapTickAt = Date.now();

    let verdict = null;
    const anchor = tokenAnchor();
    if (Number(anchor && anchor.priceNative) > 0) {
      verdict = Q.validateTick(anchor, payload);
    } else {
      verdict = Q.bootstrapTick(token, payload, pendingSolUsd);
    }
    if (!verdict || !verdict.accepted) {
      // A RUN of out-of-band rejections is not noise — it is a genuine move
      // beyond the accept band (a fast runner can clear 20x inside the 30 s
      // anchor-refresh cadence). Waiting for the cadence froze the price at
      // the pre-move level exactly when it mattered most (DEFECT F-10).
      // Force an early re-anchor from the trusted resolver; requote() is
      // single-flight, and if the ticks were genuinely bogus the fresh anchor
      // simply keeps rejecting them.
      if (verdict && verdict.reason === 'out-of-band') {
        oobRejects += 1;
        if (oobRejects >= OOB_REJECTS_FOR_REANCHOR
          && Date.now() - lastOobRequoteAt > OOB_REANCHOR_MIN_MS) {
          lastOobRequoteAt = Date.now();
          oobRejects = 0;
          requote();
        }
      }
      return;
    }
    oobRejects = 0;

    // A live chart tick that validates tells us which unit the chart plots.
    if ((payload.source === 'padre-chart-bar' || payload.source === 'chart-export') && verdict.basis) {
      const basisChanged = chartAxisBasis !== verdict.basis;
      chartAxisBasis = verdict.basis;
      // DEFECT C-06: a chart unit toggle (Price⇄MCap, USD⇄SOL) surfaces here
      // as a basis change — the line spec must be re-posted IMMEDIATELY or
      // the bridge keeps re-asserting the old unit's level every second
      // until the next fill. This bypasses the price-repost throttle.
      if (basisChanged) syncAveragePriceLines();
    }

    // F-50 (lute, BONK): a tick can VALIDATE — the 20x anchor band is wide
    // on purpose — and still be the wrong SCALE (lute plots a ~10x supply
    // convention; the panel was watched flip-flopping $214M ⇄ $2.15B and an
    // immediate round trip booked -90.2%). A single tick may not re-scale
    // the market: reject a step beyond SCALE_STEP_RATIO from the freshest
    // accepted evidence unless the newcomer sits closer to the resolver
    // anchor than the stream does — then the STREAM was the wrong scale and
    // snapping back is the honest move.
    const scaleAnchor = tokenAnchor();
    if (Q.scaleStepVerdict(
      verdict.priceNative,
      lastAcceptedMarket && lastAcceptedMarket.priceNative,
      lastAcceptedMarket ? Date.now() - lastAcceptedMarket.at : Infinity,
      scaleAnchor ? Number(scaleAnchor.priceNative) : null
    ) === 'scale-step') {
      console.debug('PaperTrench: tick ' + verdict.priceNative + ' (' + (payload.source || 'page-feed')
        + ') rejected as scale-step vs accepted ' + lastAcceptedMarket.priceNative
        + ' — one tick may not re-scale the market (F-50)');
      return;
    }

    const oldNative = Number(token.priceNative);
    // Identity heals the same way: a brand-new coin's first ticks already
    // carry its symbol, but the panel record was created with symbol:null
    // (pending stand-in). Backfill once, then ticks stop touching identity.
    // The position's own label and the positions-bar chip heal with it —
    // "Bought 0.1 SOL of null" and "Unknown token" both die here.
    // D-42 (Bug 5): when the feed itself carries no identity (Padre ticks
    // are price-only), the page's own DOM still prints the coin's name —
    // every trade venue headlines it. Scrape it ONCE per unknown window as
    // the last resort so the header shows a name, not the short CA.
    if (!token.symbol) {
      let healed = false;
      if (typeof payload.symbol === 'string' && payload.symbol.trim()) {
        token.symbol = payload.symbol.trim().slice(0, 24);
        healed = true;
        if (!token.name && typeof payload.name === 'string' && payload.name.trim()) {
          token.name = payload.name.trim().slice(0, 48);
        }
      } else if (!token.nameScraped) {
        token.nameScraped = true; // one attempt per unknown window, ever
        const scraped = scrapePageTokenName();
        if (scraped) {
          token.name = scraped.name;
          if (scraped.symbol) token.symbol = scraped.symbol;
          healed = true;
        }
      }
      if (healed) {
        const pos = state.positions[token.mint];
        if (pos && !pos.symbol && token.symbol) pos.symbol = token.symbol;
        if (pos && !pos.name && token.name) pos.name = token.name;
        renderHeader();
      }
    }
    token.priceNative = verdict.priceNative;
    if (verdict.priceUsd) token.priceUsd = verdict.priceUsd;
    if (verdict.mcap) token.mcap = verdict.mcap;
    token.priceSource = payload.source || 'page-feed';
    // Market evidence for the fill witness (F-47): only prices the validator
    // actually ACCEPTED count — never a resolver adoption, which is exactly
    // the source class that once resurrected a pre-crash price.
    lastAcceptedMarket = { priceNative: verdict.priceNative, at: Date.now() };
    // F-54: track accepted-tick count per token (reset on token change).
    const tokenKey = String(token.mint || token.symbol || '');
    if (tokenKey !== lastTokenKey) {
      lastTokenKey = tokenKey;
      acceptedTickCount = 0;
    }
    acceptedTickCount += 1;

    // For a brand-new coin, the first accepted on-screen tick becomes the
    // anchor until the resolver catches up. For resolved coins the anchor is
    // only refreshed by requote()/setToken() so live ticks cannot drift it.
    if (!token.anchor && Number(token.priceNative) > 0) {
      token.anchor = {
        mint: token.mint,
        priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) || null,
        mcap: Number(token.mcap) || null,
      };
    }

    lastPriceAt = Date.now();
    // This is the one write that means "the screen just moved" (F-57).
    lastPageTickAt = lastPriceAt;
    pageQuoteSeq += 1;
    for (const resolve of pageQuoteWaiters) resolve();
    pageQuoteWaiters.clear();
    // The After: the on-screen feed prices any active post-exit watch for
    // this token for free.
    if (settings.postExitWatchEnabled !== false
      && E.notePostExitPrice(state, token.mint, verdict.priceNative, lastPriceAt)) {
      persistSoon();
    }
    flushArmedBuy();
    // Armed levels are judged against THIS observed price — the honest fill
    // rule depends on it being the tick that first crossed the level, so this
    // sits in the tick path and nowhere else.
    //
    // D-57: this MUST run before the duplicate-price early-return below. The
    // armed SET changes independently of the price: a stop dragged onto the
    // chart, an order restored when wallet state finished loading, or a level
    // added from another tab all arm against a price the feed has already
    // printed. Gating the evaluation on "the price moved" meant a level armed
    // after the last move waited for the NEXT distinct price to be judged —
    // and a feed printing a flat quote (a dead-quiet book, a rug where every
    // tick repeats the same number) never produces one. The stop sat armed
    // while the position bled out. triggeredOrders() is the only thing that
    // decides a fire, and it is idempotent, so running it on a repeat tick
    // costs one comparison and cannot double-book.
    evaluateChartOrders();
    // N2: armed limit buys fire on the SAME tick path, same honest-fill rule.
    evaluatePendingBuys();

    // A duplicate tick still proves the feed is alive, but it does not need a
    // position mark, storage write, or DOM render.
    if (token.priceNative === oldNative) return;

    series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
    if (series.length > SERIES_CAP) series.shift();
    E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
    maybeProfitAlert(token.mint);
    // DEFECT C-01: the line spec must track the market, throttled (see
    // maybeRepostAverageLines) — a spec frozen at fill time made mcap lines
    // ride the candle at ratio ≈ 1 instead of holding the entry level.
    maybeRepostAverageLines();
    // The token ON SCREEN is excluded from the batch poller (its price comes
    // from the page's own feed), so its alerts are judged here — otherwise
    // the one chart you are actually watching is the one that never pings.
    evaluateMcAlerts(token.mint, token);
    syncChartOrders();
    if (usesSvgMarkers()) CM.tickPrice(genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot);
    persistSoon();
    // Event-driven hot path: render in this same task, with no timer wait.
    renderHeader();
    renderPosition();
    renderBalance();
    renderLiveDot();
    // The on-screen token may also be held; keep its chip in step with the card.
    renderPositionsBar();
  }

  /* -------------------- rug guard -------------------- */

  // mint -> chain-read holder-concentration verdict. Refreshed when a token
  // is identified (resolve or prewatch); the background caches reads for a
  // minute, so this stays two RPC calls per coin per minute at most.
  const rugVerdicts = new Map();

  function refreshRugVerdict(mint) {
    if (!mint || settings.guardRugEnabled === false) return;
    R.rugCheck(mint).then((verdict) => {
      if (!verdict || !verdict.known) return;
      rugVerdicts.set(mint, verdict);
      if (rugVerdicts.size > 50) rugVerdicts.delete(rugVerdicts.keys().next().value);
      renderSiteStatus();
    }).catch(() => {});
  }

  /** The refusal line for the CURRENT token, or null when buying is fine.
   * Sells are deliberately never gated — exiting a rug is the right move. */
  function rugRefusalMessage() {
    if (!token || settings.guardRugEnabled === false) return null;
    const verdict = rugVerdicts.get(token.mint);
    if (!verdict || !verdict.known) return null;
    const threshold = Math.max(10, Math.min(90, Number(settings.guardRugTopPct) || 40));
    if (!(verdict.pct >= threshold)) return null;
    return `🚩 RUG WARNING — top ${verdict.holders} wallets hold ${verdict.pct}% of supply`
      + `${verdict.assumedPool ? ' (excl. the largest account, assumed pool)' : ' (excl. the pool)'}`
      + '. Paper buy refused — Settings → Guardrails → Rug guard to override.';
  }

  /* -------------------- detection -------------------- */

  // One prewatch per pending address; a failed prewatch is not retried — the
  // resolver's own retry loop stays the fallback path.
  let prewatchedAddress = null;
  // D-60 keeps a failed probe from latching, but that release lets the 800ms
  // detect loop re-probe immediately — and with the keyless pool refusing
  // heavy reads, the released latch became a retry STORM (ark_trades13
  // 2026-08-27: 56 background error groups, 'rpc pool cooling down' x243).
  // Back off per address, exponentially, with a cap: a coin that cannot be
  // priced on-chain yet stays pending on the page's own feed (or resolves
  // normally) instead of paying a failed probe twice a second. State is
  // keyed to the address being probed — a NEW address resets it, so one
  // coin's storm can never delay the next coin's first (fast) probe.
  let prewatchAttempts = 0;
  let prewatchLastTryAt = 0;
  let prewatchBackoffFor = null;
  const PREWATCH_BASE_MS = 2_000;
  const PREWATCH_MAX_MS = 30_000;

  function prewatchBackoffMs(address) {
    if (prewatchBackoffFor !== address) return 0; // new address: no inherited delay
    if (!prewatchAttempts) return 0;
    const wait = Math.min(PREWATCH_BASE_MS * Math.pow(2, prewatchAttempts - 1), PREWATCH_MAX_MS);
    return Math.max(0, prewatchLastTryAt + wait - Date.now());
  }

  /** Pre-index launch: identify and watch the on-chain market behind a
   * PENDING page right now, instead of waiting for an aggregator to index the
   * coin. The reply's primed price rides the normal tick pipeline, so the
   * anchor, staleness stamps, renders and the armed-buy flush behave
   * exactly as for any accepted first quote — this is what makes an armed
   * buy on a 39-second-old coin actually fire (maintainer report: Axiom
   * mcap-mode chart, "ARMED — ON FIRST QUOTE" forever). Every pending
   * Solana address is probed — one RPC read classifies it by account owner
   * (F-45: the page's kind label is a claim, not a fact). A pool with a
   * verified decoder comes back as a live feed; a bare mint comes back as
   * measured supply facts, which is what lets bootstrapTick price the
   * page's own mcap feed for launchpads with no derivable pool (the Padre
   * re-report: a non-pump launch on an MCap-mode chart could never
   * bootstrap, so the armed buy sat on a nondescript wait state forever).
   */
  function prewatchPending(candidate) {
    if (!candidate || prewatchedAddress === candidate.address) return;
    // Backoff gate (D-60 companion): a probe that failed moments ago is not
    // re-paid on every detect tick. The backoff is keyed to the address —
    // a different address is never delayed by a previous coin's failures.
    //
    // LIVE-MARKET EXCEPTION (Discord 2026-08-28, 4…/Gio): a coin whose
    // mcap ticks are FRESH is provably trading — the page's own feed says
    // so — so a failed probe must not bench its only on-chain price source
    // on the anti-storm timer. The backoff exists to stop a retry STORM on
    // a coin that cannot be priced; a live market is the opposite case.
    // While mcap ticks flow, probe immediately: the chain read is the only
    // thing that can turn those mcap ticks into a fillable price.
    const backoff = prewatchBackoffMs(candidate.address);
    const liveMarket = Date.now() - lastMcapTickAt <= 15_000;
    if (backoff > 0 && !liveMarket) return;
    prewatchBackoffFor = candidate.address;
    prewatchedAddress = candidate.address;
    prewatchLastTryAt = Date.now();
    const ids = candidate.kind === 'pair'
      ? { pool: candidate.address }
      : { mint: candidate.address };
    R.onchainPrewatch(ids).then((found) => {
      // D-60: a probe that answered NOTHING must not latch. The chain read
      // can fail for reasons that have nothing to do with this coin — a
      // throttled public RPC, a dropped socket, a slot the endpoint had not
      // caught up to. Leaving prewatchedAddress set meant that single blip
      // permanently disabled the one path that prices a brand-new launch,
      // and the coin then waited on an aggregator to index it: the
      // "'Fetching live price' 100% of the time, can only buy once the coin
      // has aged 20-30 seconds" report. Releasing the latch lets the detect
      // loop probe again on its next pass.
      if (!found || !found.mint) {
        if (prewatchedAddress === candidate.address) prewatchedAddress = null;
        // Re-arm the backoff from THIS failure: without this stamp the gate
        // only muzzles the loop INSIDE a window — the moment it expires,
        // every detect tick re-probes again (the D-60S test caught it).
        prewatchLastTryAt = Date.now();
        prewatchAttempts = Math.min(prewatchAttempts + 1, 6);
        return;
      }
      prewatchAttempts = 0; // a positive probe restores the fast cadence
      if (!token || !token.pending) return;
      if (token.srcAddress !== candidate.address && token.mint !== candidate.address) return;

      // Supply facts only — a bare mint account, or a pool whose layout has
      // no verified decoder (poolKind null: identity and supply are protocol
      // facts, its price is not). The coin stays pending, mcap-scale page
      // ticks become priceable through the measured supply, and on a
      // pair-address page (Axiom /meme/ on a launchpad we cannot decode)
      // the discovered mint replaces the stand-in so mint-tagged ticks
      // match and the resolver's Jupiter-by-mint fallback can engage —
      // this was the minute-plus wait-state residue on
      // fresh low-liq launches (Coja, Discord).
      if (!found.pool || found.poolKind == null) {
        if (found.mint !== token.mint) {
          if (armedBuy && armedBuy.mint === token.mint) armedBuy.mint = found.mint;
          // A fill may already sit under the stand-in address (F-51).
          rekeyLiveState(token.mint, found.mint);
          token.mint = found.mint;
          token.pairAddress = found.pool || token.pairAddress || null;
          sendPadreMarker('paper-axis', { pairAddress: token.pairAddress, mint: token.mint });
        }
        if (Number(found.supplyUi) > 0) {
          reconcileHostSupply(found.supplyUi);
          token.supplyUi = Number(found.supplyUi);
          token.decimals = Number(found.decimals);
        }
        refreshRugVerdict(found.mint);
        return;
      }

      // Positive identification: the stand-in address gives way to the real
      // mint. srcAddress keeps the URL identity, so the pending re-detect
      // and the eventual resolve both still recognize the token, and the
      // armed intent survives the rename the same way it survives resolve.
      if (armedBuy && armedBuy.mint === token.mint) armedBuy.mint = found.mint;
      // A fill may already sit under the stand-in address (F-51).
      rekeyLiveState(token.mint, found.mint);
      token.mint = found.mint;
      token.pairAddress = found.pool || token.pairAddress || null;
      // pumpCurve implies the protocol-constant 1e9 supply (quote.js
      // bootstrapSupply) — claiming it for a whirlpool- or vault-backed
      // coin would price mcap ticks against a supply nobody measured.
      token.pumpCurve = found.poolKind === 'pump-curve';
      onchainLive = true;
      if (Number(found.supplyUi) > 0) {
        reconcileHostSupply(found.supplyUi);
      }
      renderSiteStatus();
      refreshRugVerdict(found.mint);
      // Re-anchor the bridge with the full identity so chart ticks match.
      sendPadreMarker('paper-axis', { pairAddress: token.pairAddress, mint: token.mint });
      if (Number(found.priceNative) > 0) {
        handlePageTick({
          mint: found.mint,
          source: 'onchain-prewatch',
          candidates: [{ value: Number(found.priceNative), unit: 'native' }],
        });
      }
    }).catch(() => {
      // Same rule as the empty answer above: a thrown probe is a failure of
      // the READ, never proof about the coin. Release the latch so the next
      // detect pass can try again instead of stranding the token — under the
      // exponential backoff, not the old 800ms hammer.
      if (prewatchedAddress === candidate.address) prewatchedAddress = null;
      prewatchAttempts = Math.min(prewatchAttempts + 1, 6);
    });
  }

  async function detectLoop() {
    // A pending token still needs resolving, so do not treat "same URL" as
    // done until the address actually resolved. Without this a brand-new coin
    // would only retry when the URL changed — i.e. never.
    const settled = token && !token.pending;
    if (location.href === lastHref && settled) return;
    site = S.currentSite();
    const candidate = site.detect();
    if (!candidate) { lastHref = location.href; swapStash = null; setToken(null); return; }
    if (settled && (token.mint === candidate.address || token.pairAddress === candidate.address || token.srcAddress === candidate.address)) { lastHref = location.href; return; }
    // lastHref is only committed once this tick actually acts on the URL. If a
    // resolve is still in flight, leave it uncommitted so a navigation that
    // landed during the resolve is retried on the next tick instead of being
    // recorded as handled and then ignored forever.
    if (resolving) return;
    resolving = true;
    lastHref = location.href;
    const resolveHref = lastHref;

    // Show the pending state immediately so the panel is honest during the
    // resolve rather than displaying a fabricated number. Rebuilding this on
    // every retry would restart the card animation, so it is only set when the
    // address actually changes.
    // A prewatch may have swapped the stand-in pair address for the real
    // mint (srcAddress keeps the URL identity), so both count as "same".
    const alreadyPendingSame = token && token.pending
      && (token.mint === candidate.address || token.srcAddress === candidate.address);
    if (!alreadyPendingSame) {
      // P0-3: stash the identity being replaced (and any armed intent keyed
      // to it) so the resolve below can prove or disprove "same coin, new
      // home" — a pump.fun graduation reappears under its migration pool
      // URL. A plain navigation disproves it and drops the armed buy exactly
      // as before; only a proven re-appearance of the same mint restores it.
      if (token && token.mint && token.mint !== candidate.address) {
        swapStash = {
          fromMint: token.mint,
          armedBuy: (armedBuy && armedBuy.mint === token.mint) ? armedBuy : null,
          at: Date.now(),
        };
      } else {
        swapStash = null;
      }
      setToken({
        mint: candidate.address, srcAddress: candidate.address, symbol: null, name: null,
        priceNative: null, priceUsd: null, pending: true,
      });
      pendingSince = Date.now();
      pendingAttempts = 0;
      // Anchor the bridge to this token before the resolver finishes, so bars
      // and chart exports from a preloaded other-token chart do not leak in.
      sendPadreMarker('paper-axis', {
        pairAddress: candidate.kind === 'pair' ? candidate.address : null,
        mint: candidate.kind === 'mint' ? candidate.address : null,
      });
      // Warm the SOL/USD rate so a USD on-screen price can be filled the moment
      // it appears — and, multichain, so a foreign token's SOL price can be
      // derived. resolveViaJupiter also populates this cache shortly.
      R.solUsd().then((rate) => { if (rate > 0) pendingSolUsd = rate; }).catch(() => {});
      // The sniping path is SOLANA-ONLY machinery (bonding curves, on-chain
      // pool watching): a foreign-chain token skips it instead of failing it.
      if (!candidate.chain || candidate.chain === 'solana') prewatchPending(candidate);
    }

    try {
      // When the prewatch probe already identified the REAL mint behind a
      // pair-address page (unknown-layout pool: identity yes, price no),
      // retries resolve BY MINT — Jupiter indexes fresh launches by mint
      // within seconds, while the pair endpoint waits on Dexscreener to
      // notice the pool exists. srcAddress keeps the URL identity, so the
      // adoption checks below still recognize the answer.
      const resolveAddress = token && token.pending
        && token.srcAddress === candidate.address && token.mint !== candidate.address
        ? token.mint
        : candidate.address;
      const data = await R.resolve(resolveAddress, { chain: candidate.chain });
      // The page may have navigated while the resolve was in flight. Adopting
      // the result now would resurrect the old token on the new page — and
      // route fills to it. Bail; the next tick handles the current URL.
      if (location.href !== resolveHref) return;
      if (!data) {
        // NOT a teardown. A brand-new coin is simply not indexed yet, and
        // tearing the token down here is what caused the visible flashing:
        // each failed attempt cleared markers and stopped the price loop,
        // then the next tick rebuilt everything from scratch.
        pendingAttempts += 1;
        // A coin can be newer than its own accounts' visibility: the first
        // probe may land before the RPC node can see the mint or curve, and
        // a single-shot probe then leaves the whole pre-index window to the
        // aggregators — the exact window prewatch exists for. Re-probe on a
        // slow cadence while still unresolved; the address dedup makes each
        // retry one RPC read, and it stops the moment anything resolves.
        // D-60: two cadences, not one. If the last probe FAILED it released
        // the latch (prewatchedAddress === null), and there is no reason to
        // wait — retry on this very pass, because the failure was about the
        // read, not the coin. Only when a probe is still outstanding or
        // already answered do we fall back to the slow every-5th-attempt
        // net. Waiting ~4s to re-ask after a throttled RPC is what left
        // fresh coins on "Fetching live price" for 20-30 seconds.
        const probeFailed = prewatchedAddress === null;
        // LIVE-MARKET (Discord 2026-08-28): while fresh mcap ticks prove the
        // coin trades, a probe is always worth re-asking — the chain read is
        // the only thing that turns those ticks into a fillable price. The
        // every-5th net is for a coin whose feed is quiet; a live market is
        // the opposite case.
        const liveMarket = Date.now() - lastMcapTickAt <= 15_000;
        if (token && token.pending
          && (probeFailed || pendingAttempts % 5 === 0 || liveMarket)
          && (!candidate.chain || candidate.chain === 'solana')) {
          prewatchedAddress = null;
          prewatchPending(candidate);
        }
        renderHeader();
        // Re-evaluate the false-positive give-up (DEFECT O-10) as the
        // failure count grows; cheap, and reversible the moment it resolves.
        updateOverlayVisibility();
        return;
      }
      data.srcAddress = candidate.address;
      data.kind = candidate.kind;
      if (candidate.chain && !data.chain) data.chain = candidate.chain;
      setToken(data);
      // P0-3 graduation bridge: settle the swap stash (created at the swap,
      // above) now that the new page's identity is known. Dexscreener keeps
      // a graduated pump curve listed under the same base mint forever
      // (verified on-chain 2026-08-20), so resolving the OLD stand-in is a
      // deterministic identity check: it returns the real mint on BOTH sides
      // of a migration. Same mint => it was one coin all along => restore
      // the armed intent and rekey the bag from the stand-in to the real
      // mint. A different mint, or no answer, => a genuine coin switch; the
      // legacy drop semantics stand.
      // This must run AFTER setToken: the restore would otherwise be
      // re-dropped by setToken's rename logic, and the rekey targets the
      // STAND-IN key, not the pending intermediate identity setToken just
      // renamed away from.
      const stash = swapStash;
      swapStash = null;
      if (stash && stash.fromMint && data.mint) {
        let proven = stash.fromMint === data.mint;
        if (!proven) {
          try {
            const old = await R.resolve(stash.fromMint, { chain: candidate.chain, maxAgeMs: 30000 });
            if (old && old.mint && old.mint === data.mint) proven = true;
          } catch (e) { /* best-effort: unprovable keeps the legacy drop */ }
        }
        if (proven) {
          if (stash.armedBuy) {
            armedBuy = stash.armedBuy;
            armedBuy.mint = data.mint;
            renderBuyButton();
          }
          if (stash.fromMint !== data.mint) rekeyLiveState(stash.fromMint, data.mint);
        }
      }
      // F-61 backstop: heal stand-in-keyed bags at the graduation boundary.
      // A Pulse row buy that never resolved (row-feed fallback) commits under
      // the click address — the PAIR stand-in on Axiom. When the coin bonds,
      // the migration pool gets a NEW pair address; reopening the coin (from
      // the bonded listing or any pool URL) resolves the REAL mint, a key this
      // wallet never held: the card renders empty (jb, 8/17). Unlike the
      // in-context stash bridge above, nothing links the two sessions. The
      // resolver's own payload carries the proof for free: Dexscreener lists
      // EVERY pool for the base mint — including the graduated bonding-era
      // pair — so a position whose key appears among the pool list is the
      // same coin under its old stand-in. Deterministic identity proof, one
      // rekey, no network added.
      healStandInPositions(data);
      // Rug verdicts read Solana holder state — a foreign chain has no
      // verdict, and the guard stays silent rather than pretending.
      if (!data.chain || data.chain === 'solana') refreshRugVerdict(data.mint);
      // Tell the bridge which address this page is about, so ticks, exports
      // and drawing only come from the chart instance showing THIS token.
      sendPadreMarker('paper-axis', { pairAddress: data.pairAddress, mint: data.mint, symbol: data.symbol });
      // D-42 (Bug 3): adopt a row-snipe intent mirrored by the board tab
      // into the SW before this navigation killed it. The chip tap armed on
      // the board; the trader's next click opened THIS chart. Bind it to
      // this mint and run it through the panel's own D-39 armedBuy flush —
      // fromClick, so the first accepted quote fills with no corroboration
      // wait (the click already happened; nothing here narrates). TTL from
      // the ORIGINAL tap bounds it; a mismatched mint is not this intent.
      try {
        const intent = await sendMessage({ type: 'pt_armed_row_get' });
        if (intent && intent.address && intent.amount > 0) {
          const matches = intent.address === data.mint
            || intent.address === data.pairAddress
            || intent.address === data.srcAddress;
          if (matches && Date.now() - intent.at <= ARMED_ROW_TTL_MS) {
            if (!armedBuy) {
              armedBuy = {
                amount: intent.amount, usd: null, at: intent.at,
                mint: data.mint, fromClick: true,
                adoptedFromRow: true,
              };
              renderBuyButton();
              flushArmedBuy();
            }
            // Consumed either way: an intent the chart adopts is never
            // re-fillable by the (likely dead) board context.
            sendMessage({ type: 'pt_armed_row_clear' }).catch(() => {});
          }
        }
      } catch (_) { /* adoption is an enhancement, never a landing risk */ }
      // The site publishes its live market cap in document.title, which changes
      // the instant the page re-renders — cheaper and earlier than any network
      // read. It refreshes the DISPLAYED cap between chain updates; it never
      // prices a fill, and it is validated against chain state before use.
      startTitleSignal();
      // Start streaming live pool state. Until this connects, prices come from
      // the aggregator and are labelled as such rather than presented as live.
      // Solana RPC cannot watch a foreign chain's pool — skip, never fake.
      if (data.pairAddress && (!data.chain || data.chain === 'solana')) {
        R.onchainWatch(data.mint, data.pairAddress).then((reply) => {
          if (token && token.mint === data.mint) {
            onchainLive = Boolean(reply && reply.live);
            renderSiteStatus();
          }
        }).catch(() => {});
      }
      pendingSince = 0;
      pendingAttempts = 0;
      // After the token is resolved and state is current, restore any
      // existing trade markers from the journal (page reload scenario).
      await reloadState();
      restoreMarkersFromJournal();
      syncAveragePriceLines();
    } catch (e) {
      // Transient network failure: keep the pending token and retry, rather
      // than dropping a token the user may be about to snipe.
      pendingAttempts += 1;
    } finally {
      resolving = false;
      // The resolver warms the SOL/USD cache even when the token is still
      // unindexed; capture that rate for pending-token bootstraps.
      R.solUsd().then((rate) => { if (rate > 0) pendingSolUsd = rate; }).catch(() => {});
    }
  }



  /**
   * F-51 — carry every live mint-keyed structure across an identity upgrade.
   *
   * On pair-URL sites a fresh launch trades under the PAIR stand-in address
   * until the prewatch probe or the resolver discovers the real mint. A fill
   * committed in that window keys the position under the stand-in; when the
   * mint replaces it, the card looked the position up under the NEW key,
   * found nothing, and rendered empty — the "it just wipes the position like
   * i never bought" report. The armed-buy intent already survived this
   * rename; the position, orders, alerts and post-exit watches now do too.
   *
   * The in-memory move is synchronous so the very next render sees the bag;
   * the storage write rides the serialized CAS commit, re-applying itself on
   * contention like every other mutation (F-46).
   */
  /**
   * F-61: heal bags stranded under a stand-in key at the graduation boundary.
   * `tokenRecord` is a resolver record carrying `poolAddresses` — every pool
   * listed for the base mint. Any OPEN position keyed by one of those pool
   * addresses (but not the mint itself) is the same coin bought under its
   * bonding-era pair stand-in; rekey it onto the real mint so the card, the
   * bar chip, and the batch quote poller all see one bag under one key.
   * Idempotent; a no-op when no position matches.
   */
  function healStandInPositions(tokenRecord) {
    if (!tokenRecord || !tokenRecord.mint || !Array.isArray(tokenRecord.poolAddresses)) return;
    if (!state.positions) return;
    const stranded = Object.keys(state.positions).filter(
      (k) => k !== tokenRecord.mint && tokenRecord.poolAddresses.indexOf(k) !== -1
    );
    for (const standIn of stranded) rekeyLiveState(standIn, tokenRecord.mint);
  }

  function reconcileHostSupply(measuredSupplyUi) {
    if (!token || !(Number(token.hostSupplyUi) > 0)) return;
    const measured = Number(measuredSupplyUi);
    const host = Number(token.hostSupplyUi);
    if (!(measured > 0) || !Number.isFinite(measured)) return;
    if (Math.abs(measured - host) / host <= 0.02) {
      token.hostSupplyUi = null;
      token.hostSupplyWitness = null;
      return;
    }
    token.hostSupplyUi = null;
    token.hostSupplyWitness = null;
    token.hostSupplyRejected = true;
    recordHostFactsDiagnostic('host supply disagrees with measured supply',
      'host-facts-supply-mismatch', {
      mint: token.mint,
      hostSupplyUi: host,
      measuredSupplyUi: measured,
    });
  }

  function rekeyLiveState(oldMint, newMint) {
    if (!oldMint || !newMint || oldMint === newMint) return;
    const cached = livePositionPrices[oldMint];
    if (cached) {
      delete livePositionPrices[oldMint];
      if (!livePositionPrices[newMint]) livePositionPrices[newMint] = cached;
    }
    if (!E.rekeyMint(state, oldMint, newMint)) return;
    posEls = null; // the cached card nodes belong to the stand-in's render
    withState(async () => {
      const mutate = () => E.rekeyMint(state, oldMint, newMint);
      mutate();
      await persistStateNow(mutate);
    }).catch(() => {}).then(() => {
      renderPosition();
      renderBalance();
      renderPositionsBar();
      renderThesis();
      syncAveragePriceLines();
    });
  }

  function setToken(data) {
    const prevMint = token?.mint;
    const hadPrice = Boolean(token && token.priceNative);
    // Per-token feed counters must not leak across a token switch: stale mcap
    // activity could hold a NEW token's armed buy alive (F-16), and stale
    // out-of-band tallies could trigger a premature re-anchor (F-10).
    if (!data || data.mint !== prevMint) {
      lastMcapTickAt = 0;
      oobRejects = 0;
      hostSupplyRefusals.clear();
    }
    token = data;
    // Keep a separate resolver anchor for validation. This is the price we
    // trust until a newer resolver quote or a first on-chain observation
    // confirms the live level. Live chart ticks validate against this, so one
    // bogus tick does not become the new ground truth.
    if (token && Number(token.priceNative) > 0) {
      token.anchor = {
        mint: token.mint,
        priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) || null,
        mcap: Number(token.mcap) || null,
      };
    }
    // Navigating to a different token invalidates any armed intent. But a
    // pending pair address RESOLVING into its base mint is the same token
    // gaining its real identity, not a navigation: on pair-URL sites (Axiom,
    // Photon, BullX) the pending token's mint IS the pair address, and the
    // resolved record carries the base mint. Dropping the armed buy there
    // silently killed every snipe at exactly the moment the first quote
    // landed — the classic "ARMED … but nothing executed" report.
    if (token && prevMint && token.mint !== prevMint) {
      const sameTokenResolving = token.pairAddress === prevMint || token.srcAddress === prevMint;
      if (armedBuy) {
        if (sameTokenResolving && armedBuy.mint === prevMint) armedBuy.mint = token.mint;
        else armedBuy = null;
      }
      // The same rename that rebinds the armed intent must carry an already-
      // committed position with it, or the card wipes on the coin that was
      // just bought (F-51).
      if (sameTokenResolving) rekeyLiveState(prevMint, token.mint);
    }
    if (!token) armedBuy = null;
    void hadPrice;
    if (!token || token.mint !== prevMint) {
      // The cached card belongs to the previous token; force a rebuild.
      posEls = null;
      lastRenderedPrice = null;
    }
    if (prevMint && (!token || token.mint !== prevMint)) {
      // Release the previous token's chain subscription immediately; a stale
      // stream is both wasted bandwidth and a source of wrong-token prices.
      onchainLive = false;
      R.onchainUnwatch(prevMint);
      // The title signal is anchored to the previous token's cap; a stale
      // anchor would validate the new token's title against the wrong scale.
      stopTitleSignal();
    }
    if (token && token.mint !== prevMint) {
      // O-30: whatever batch quote the poller cached while this token was
      // off-screen is another venue's number. The page feed prices the token
      // on screen; a lingering entry would outrank it in the positions bar.
      delete livePositionPrices[token.mint];
      series = []; marks = [];
      lastPriceAt = 0;
      lastPageTickAt = 0;
      lastCmTickPrice = 0;
      chartAxisBasis = null;
      // C-01: the repost throttle is per token, like the spec it re-posts.
      lastLineSpecPostAt = 0;
      lastLineSpecPrice = 0;
      // C-19: a fresh token restarts the native-chart discovery window on
      // sites outside the known-native set.
      beginNativeProbe();
      drawnFillIds.clear(); // fills drawn for the previous token
      if (usesNativeChart()) {
        // Padre uses its own TradingView getMarks pipeline. Clear native paper
        // marks for the previous token; do not mount the generic SVG overlay.
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
        if (CM) CM.destroyChartMarkers();
      } else if (CM) {
        // The generic SVG state is token-scoped. GMGN also owns native
        // TradingView average lines, so clear those before reusing its chart.
        if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
        CM.clearMarkers();
        // GMGN never renders through the SVG overlay — do not mount it there
        // (it would mutate the chart container and observe it for nothing,
        // DEFECT C-20). Its fills/lines go through gmgn-marker/gmgn-lines.
        if (usesSvgMarkers()) CM.initChartMarkers();
      }
      startPriceLoop();
    }
    if (!token) {
      stopPriceLoop();
      drawnFillIds.clear();
      if (CM) CM.destroyChartMarkers();
      if (usesNativeChart()) {
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
      }
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
    }
    renderAll();
    // The resolver may have just supplied the first quote this coin ever had.
    flushArmedBuy();
    publishPageState();
  }

  /* Tell the MAIN-world bridge whether ANY tick consumer exists on this page
   * (Turbo). Ticks feed exactly two things: the page's resolved token and the
   * screener row chips. On every other page the bridge's transport taps parse
   * the site's frames for nobody — so the bridge gates parsing on this signal.
   * Sent only on change; the bridge's boot default is "wanted", so a missed
   * first message costs correctness nothing (it merely parses as before). */
  let lastWantsTicks = null;
  let lastFactsWanted = null;
  function publishPageState() {
    const chipPage = Boolean(site && site.rowBuy
      && settings.listQuickBuyEnabled !== false
      && site.rowBuy.listPaths.test(location.pathname));
    const wants = Boolean(token) || chipPage;
    const facts = Boolean(token && token.pending);
    if (wants === lastWantsTicks && facts === lastFactsWanted) return;
    lastWantsTicks = wants;
    lastFactsWanted = facts;
    sendPadreMarker('page-state', { wantsTicks: wants, factsWanted: facts });
  }

  /**
   * The live-price heartbeat.
   *
   * Runs on a short fixed tick. Every beat it re-renders the position so the
   * P&L reflects the newest price, and — when the page's own feed is not
   * supplying usable ticks — issues a fresh network quote. Q.shouldRequote()
   * owns that decision so the cadence is unit-testable.
   */
  function startPriceLoop() {
    stopPriceLoop();
    priceTimer = setInterval(() => {
      if (!contextAlive()) { shutdown('invalidated'); return; }
      if (!token || !token.mint) return;

      const now = Date.now();
      const watchingHiddenProfit = Boolean(
        document.hidden && settings.profitAlertsEnabled && state.positions && state.positions[token.mint]
      );
      // Normal hidden tabs do not poll. When hidden profit bells are enabled
      // for an open position, keep a low-rate 2s safety quote in case the
      // site's own feed pauses in the background. Live Padre bars still arrive
      // event-driven and suppress this fallback entirely.
      const backgroundCadenceDue = !watchingHiddenProfit || !lastPollAt || now - lastPollAt >= 2000;
      const hiddenBlocked = document.hidden && !watchingHiddenProfit;
      if (backgroundCadenceDue && Q.shouldRequote({
        lastPriceAt, lastPollAt, inFlight: pollInFlight, hidden: hiddenBlocked,
      }, now)) {
        lastPollAt = now;
        requote();
      }

      // Re-render every beat so the P&L reflects the newest price we hold.
      // Marking is done wherever a NEW price arrives (requote / page tick),
      // so there is nothing to re-mark here.
      // Only feed chart markers if the price actually changed, to avoid
      // unnecessary SVG rebuilds on every 100ms heartbeat.
      const chartPrice = genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot;
      if (usesSvgMarkers() && chartPrice > 0 && chartPrice !== lastCmTickPrice) {
        lastCmTickPrice = chartPrice;
        CM.tickPrice(chartPrice);
      }
      // Armed-buy watchdog: no matter which path a price arrives by (page
      // feed, resolver, a future source), the armed intent fires on the next
      // beat — and it also EXPIRES visibly. Before this existed, an armed buy
      // could sit on "ARMED … ON FIRST QUOTE" indefinitely when the quote
      // that landed never flowed through a flushing path.
      if (armedBuy) {
        if (token && Number(token.priceNative) > 0) {
          flushArmedBuy();
        } else if (armedBuyExpired()) {
          armedBuy = null;
          renderBuyButton();
          toast('Armed buy expired — no fillable quote arrived in time');
        }
      }
      // D-57: the same watchdog, for armed LEVELS. evaluateChartOrders() only
      // ran from the page-tick path, so an order that became armed while the
      // price stood still was never judged against a price already on screen.
      // Two ways that happens in the field, both reported as "my stop/TP
      // never fired":
      //   - wallet state finishes loading AFTER the first ticks arrive (the
      //     common one on a reload — the tick that could have fired the level
      //     ran while state.orders was still empty);
      //   - the level is armed from the chart, or by another tab, between two
      //     identical prints on a quiet or rugging book.
      // Both leave a level armed against a price that already crossed it.
      // triggeredOrders() decides every fire and is idempotent, so re-asking
      // each beat cannot double-book — it only closes the window where
      // nothing asked at all.
      if (token && Number(token.priceNative) > 0) {
        evaluateChartOrders();
        evaluatePendingBuys();
      }
      renderHeader();
      renderPosition();
    }, PRICE_TICK_MS);
  }

  /**
   * An armed buy expires only when the market has gone QUIET (no validated
   * mcap ticks for 15 s past the base TTL) or the hard cap is reached. On
   * GMGN/Axiom a pre-index launch emits mcap-only ticks that cannot price a
   * fill — expiring on the base clock alone made sniping structurally dead on
   * exactly those charts (DEFECT F-16).
   */
  function armedBuyExpired() {
    if (!armedBuy) return false;
    const age = Date.now() - armedBuy.at;
    if (age > ARMED_BUY_MAX_TTL_MS) return true;
    if (age <= ARMED_BUY_TTL_MS) return false;
    return Date.now() - lastMcapTickAt > 15_000;
  }

  /** Fetch a fresh anchor quote and adopt it if it is for this token. */
  async function requote() {
    if (pollInFlight || !token || !token.mint) return;
    pollInFlight = true;
    const forMint = token.mint;
    try {
      const fresh = await R.refresh(token);
      // The user may have navigated while this was in flight.
      if (!token || token.mint !== forMint) return;
      if (!fresh || !(fresh.priceNative > 0)) return;
      if (fresh.mint && fresh.mint !== token.mint) return;
      // F-61: a refresh re-quotes /tokens/<mint> — EVERY pool for this base
      // mint, including graduated bonding-era pairs. An initial resolve via
      // /pairs/<addr> carried only that one pool; adopt the full list so the
      // graduation backstop can see a stand-in-held bag.
      if (Array.isArray(fresh.poolAddresses)) {
        token.poolAddresses = fresh.poolAddresses;
        healStandInPositions(token);
      }

      // The resolver quote becomes the new anchor immediately. Live ticks
      // validate against this, so the anchor never lags behind real moves.
      token.anchor = {
        mint: token.mint,
        priceNative: Number(fresh.priceNative),
        priceUsd: Number(fresh.priceUsd) || null,
        mcap: Number(fresh.mcap) || null,
      };

      // When the page's own feed is live, the CHART owns the price level —
      // the P&L must stay pegged to what the trader sees on screen, not to
      // an aggregator's delayed quote. The network fetch then only refreshes
      // what the feed cannot supply: the SOL/USD rate and the implied
      // supply, both of which drift slowly over a session.
      const feedLive = lastPriceAt
        && Date.now() - lastPriceAt < Q.STALE_AFTER_MS
        && Number(token.priceNative) > 0
        && token.priceSource !== 'resolver';
      if (feedLive) {
        const rate = Number(fresh.priceUsd) > 0 ? fresh.priceUsd / fresh.priceNative : null;
        if (rate) token.priceUsd = token.priceNative * rate;
        if (Number(fresh.mcap) > 0 && Number(fresh.priceUsd) > 0 && Number(token.priceUsd) > 0) {
          const supply = fresh.mcap / fresh.priceUsd;
          token.mcap = token.priceUsd * supply;
        }
        // C-01: refreshed rate/supply changes the spec's conversions too.
        maybeRepostAverageLines();
        persistSoon();
        renderHeader();
        renderPosition();
        return;
      }

      token.priceNative = fresh.priceNative;
      if (fresh.priceUsd) token.priceUsd = fresh.priceUsd;
      if (fresh.mcap) token.mcap = fresh.mcap;
      token.priceSource = fresh.priceSource || 'resolver';

      lastPriceAt = Date.now();
      series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
      if (series.length > SERIES_CAP) series.shift();
      // F-55: this resolver adoption also re-marks any HELD position in this
      // token — the same dust-pool phantom guard applies before it may.
      {
        const pos55 = state.positions[token.mint];
        const guard55 = pos55
          ? Q.rugGuardVerdict(fresh.priceNative, pos55.lastPriceNative, fresh.liquidityUsd)
          : 'pass';
        if (guard55 === 'refuse') {
          console.debug('PaperTrench: refused phantom up-mark for ' + token.mint
            + ' from a collapsed pool (resolver refresh, ' + fresh.liquidityUsd
            + ' USD liq) F-55');
        } else {
          E.markPosition(state, token.mint, fresh.priceNative, fresh.priceUsd);
        }
      }
      maybeProfitAlert(token.mint);
      // A resolver quote is the only fresh cap a brand-new pair gets before
      // the site's feed is hookable; an alert armed on one must fire here too.
      evaluateMcAlerts(token.mint, token);
      // C-01: an adopted resolver quote moves the price like any tick does.
      maybeRepostAverageLines();
      // F-55 partner: the resolver path re-marks held positions below; the
      // batch-path guard comment applies identically here — see batch path.
      if (usesSvgMarkers()) CM.tickPrice(genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot);
      persistSoon();
      renderHeader();
      renderPosition();
      // The first trusted quote for a brand-new pair usually lands HERE — the
      // resolver indexes it before the site's chart feed is hookable — so an
      // armed buy must fire from this path too, or the button stays "ARMED"
      // forever while the price is plainly on screen.
      // F-54: a resolver quote IS the independent second source — it
      // corroborates whatever the bootstrap tick said (or provides the first
      // price itself, in which case the page feed will corroborate it).
      acceptedTickCount += 1;
      flushArmedBuy();
    } catch (e) {
      /* transient network failure; the next beat retries */
    } finally {
      pollInFlight = false;
    }
  }

  function stopPriceLoop() {
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = null;
    lastPollAt = 0;
  }
  // The heartbeat is recreated per token, so it is torn down explicitly rather
  // than registered once.
  onTeardown(stopPriceLoop);
  // C-19: the native-chart discovery grace timer dies with the context.
  onTeardown(() => { if (nativeProbeTimer) { clearTimeout(nativeProbeTimer); nativeProbeTimer = null; } });

  /* -------------------- optional fun + alerts -------------------- */

  function primeAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      if (!audioContext) audioContext = new AudioCtor();
      audioPrimed = true;
      if (audioContext.state === 'suspended' && audioContext.resume) {
        audioContext.resume().catch(() => {});
      }
      return audioContext;
    } catch (_) {
      return null;
    }
  }

  function playTone(ctx, frequency, start, duration, type, volume) {
    if (!ctx || !ctx.createOscillator || !ctx.createGain) return;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type || 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume || 0.06), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playTradeSound(side) {
    if (!settings.tradeSoundsEnabled) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    if (side === 'buy') {
      // Quick ascending major arpeggio.
      playTone(ctx, 523.25, now, 0.11, 'triangle', 0.055);
      playTone(ctx, 659.25, now + 0.07, 0.12, 'triangle', 0.06);
      playTone(ctx, 783.99, now + 0.14, 0.16, 'sine', 0.07);
    } else {
      // Crisp cash-out double chirp.
      playTone(ctx, 880, now, 0.10, 'triangle', 0.055);
      playTone(ctx, 659.25, now + 0.075, 0.14, 'sine', 0.065);
      playTone(ctx, 1046.5, now + 0.14, 0.10, 'sine', 0.04);
    }
  }

  function playProfitBell() {
    if (!settings.profitAlertsEnabled || !audioPrimed) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    // Two bell strikes with a quiet harmonic tail.
    playTone(ctx, 1046.5, now, 0.42, 'sine', 0.085);
    playTone(ctx, 1568, now, 0.30, 'sine', 0.035);
    playTone(ctx, 1174.66, now + 0.34, 0.46, 'sine', 0.09);
    playTone(ctx, 1760, now + 0.34, 0.32, 'sine', 0.035);
  }

  let effectRunId = 0;
  function runTradeEffect(side) {
    if (!settings.tradeEffectsEnabled || !els.effects) return;
    const root = els.effects;
    const runId = ++effectRunId;
    root.textContent = '';

    const flash = document.createElement('div');
    flash.className = `pt-fx-flash ${side === 'buy' ? 'buy' : 'sell'}`;
    root.appendChild(flash);

    const colors = side === 'buy'
      ? ['#3fb950', '#58d68d', '#f0883e', '#ffd166', '#ffffff']
      : ['#f85149', '#ff7b72', '#f0883e', '#ffffff', '#d29922'];
    for (let i = 0; i < 42; i++) {
      const particle = document.createElement('i');
      particle.className = 'pt-fx-particle';
      particle.style.left = `${15 + Math.random() * 70}%`;
      particle.style.top = `${25 + Math.random() * 35}%`;
      particle.style.background = colors[i % colors.length];
      particle.style.setProperty('--dx', `${(Math.random() - 0.5) * 360}px`);
      particle.style.setProperty('--dy', `${80 + Math.random() * 260}px`);
      particle.style.setProperty('--rot', `${Math.random() * 900 - 450}deg`);
      particle.style.setProperty('--delay', `${Math.random() * 120}ms`);
      particle.style.setProperty('--dur', `${650 + Math.random() * 450}ms`);
      root.appendChild(particle);
    }

    setTimeout(() => {
      if (runId === effectRunId) root.textContent = '';
    }, 1300);
  }

  function maybeProfitAlert(mint) {
    const pos = state.positions && state.positions[mint];
    if (!pos || !token || token.mint !== mint) {
      profitAlertLevels.delete(mint);
      return;
    }
    const mark = Q.positionMark(pos, token.priceNative, token.priceUsd);
    if (!mark) return;

    const interval = Math.max(1, Number(settings.profitAlertPct) || 10);
    const previous = profitAlertLevels.get(mint) || 0;
    const current = E.profitAlertLevel(mark.pnlPct, interval);

    // While visible, silently remember levels the trader already watched so
    // switching tabs cannot replay old alerts.
    if (!document.hidden) {
      if (current > previous) profitAlertLevels.set(mint, current);
      return;
    }
    if (!settings.profitAlertsEnabled) return;

    const crossed = E.crossedProfitAlert(previous, mark.pnlPct, interval);
    if (crossed === null) return;
    profitAlertLevels.set(mint, crossed);
    playProfitBell();
    toast(`${pos.symbol} crossed +${crossed * interval}% paper P&L 🔔`);
  }

  /**
   * Draw a fill on the site's own chart.
   *
   * Padre and Axiom take native TradingView marks; GMGN takes a native
   * execution shape positioned on its market-cap axis. Only sites with no
   * usable chart API fall back to the SVG overlay, because a native shape is
   * the only thing that stays glued to its candle through pan and zoom.
   */
  function drawFillOnChart(fill) {
    const markerTs = fill.ts;
    const point = genericChartPoint(fill.priceNative, fill.priceUsd, fill.mcap);

    if (usesNativeChart()) {
      sendPadreMarker('paper-marker', {
        ts: markerTs,
        // F-41: the trade's own id, so the bridge can recognize this exact
        // fill and never draw it twice.
        fillId: fill.fillId || null,
        priceNative: fill.priceNative,
        // The bridge picks whichever of these magnitudes matches the site
        // chart's Y axis (token USD price vs market cap) when it has to draw
        // the fill as a Y-anchored execution shape.
        priceUsd: fill.priceUsd || null,
        mcap: point.currency === 'MCAP' ? point.display : null,
        side: fill.side,
        solAmount: fill.solAmount,
        symbol: token && token.symbol,
      });
      return;
    }

    if (site && site.id === 'gmgn') {
      const hasCap = point.currency === 'MCAP';
      sendPadreMarker('gmgn-marker', {
        ts: markerTs,
        mcap: hasCap ? point.display : null,
        // C-16: a capless fill (priceUsd unknown at fill time, so no honest
        // mcap — see C-09) still carries its SOL price; the bridge queues it
        // and prices it from the live candle close when evidence arrives.
        priceNative: Number(fill.priceNative) > 0 ? Number(fill.priceNative) : null,
        side: fill.side,
        text: hasCap
          ? `${fill.side === 'buy' ? 'PT Buy' : 'PT Sell'} ${Q.formatMarketCap(point.display)}`
          : (fill.side === 'buy' ? 'PT Buy' : 'PT Sell'),
      });
      return;
    }

    if (CM) {
      CM.addMarker({
        ts: markerTs,
        price: point.plot,
        displayPrice: point.display,
        side: fill.side,
        solAmount: fill.solAmount,
        symbol: token && token.symbol,
        currency: point.currency,
      });
    }
  }

  /* -------------------- page-title market-cap signal -------------------- */

  let stopTitleListener = null;

  /**
   * Watch the site's own title for market-cap changes.
   *
   * This is a display accelerator, not a price source. The cap it produces is
   * validated against the market cap chain state already established, so a
   * mis-parse cannot move the number on screen, and it never touches a fill.
   */
  function startTitleSignal() {
    if (!TF || !site) return;
    stopTitleSignal();
    stopTitleListener = TF.onMarketCap((mcap) => {
      if (!token || !(mcap > 0)) return;
      // Supply is constant over a trade, so a cap move IS a price move. Scale
      // the held price by the same ratio to keep every figure consistent.
      const previous = Number(token.mcap);
      if (previous > 0 && Number(token.priceNative) > 0) {
        const ratio = mcap / previous;
        const impliedNative = Number(token.priceNative) * ratio;
        // F-50: the title carries the SITE'S scale (lute titles a ~10x
        // supply-convention cap). The same one-tick-cannot-re-scale rule
        // guards this rescale, and a refused cap must not become token.mcap
        // either — it would self-confirm every later title read.
        const titleScaleAnchor = tokenAnchor();
        if (Q.scaleStepVerdict(
          impliedNative,
          lastAcceptedMarket && lastAcceptedMarket.priceNative,
          lastAcceptedMarket ? Date.now() - lastAcceptedMarket.at : Infinity,
          titleScaleAnchor ? Number(titleScaleAnchor.priceNative) : null
        ) === 'scale-step') {
          console.debug('PaperTrench: title cap ' + mcap + ' rejected as scale-step (F-50)');
          return;
        }
        token.priceNative = impliedNative;
        if (Number(token.priceUsd) > 0) token.priceUsd = Number(token.priceUsd) * ratio;
      }
      token.mcap = mcap;
      renderHeader();
      renderPosition();
    });
    TF.start(site.id, () => (token && Number(token.mcap) > 0 ? Number(token.mcap) : null));
  }

  function stopTitleSignal() {
    if (stopTitleListener) { stopTitleListener(); stopTitleListener = null; }
    if (TF) TF.stop();
  }
  onTeardown(stopTitleSignal);

  /* -------------------- action-time quotes and fills -------------------- */

  // A displayed price is not automatically a tradeable price. A trade gets a
  // page quote only if it was received within this window; otherwise it waits
  // briefly for the site's live feed, then performs one direct resolver quote.
  const ACTION_QUOTE_MAX_AGE_MS = 350;
  const ACTION_PAGE_WAIT_MS = 175;
  // A fresh-launch coin has no Dexscreener/Jupiter quote yet, so the on-screen
  // price is the only price. Keep it tradeable a little longer while pending.
  const PENDING_ACTION_MAX_AGE_MS = 2000;
  // Last-resort bound for filling from the on-screen snapshot when every live
  // source failed. Aligned with the header's staleness marker (STALE_AFTER_MS
  // in quote.js): the moment the UI flags a price as stale, a fill at that
  // price would be a lie. The old 10 s window routinely filled 30-50% away
  // from the live market on a moving memecoin (DEFECT F-01).
  const STALE_FILL_MAX_AGE_MS = 3000;
  // An on-screen price at most this old is the price the trader is looking
  // at — it prices the fill directly (F-52), and it is what a chain read
  // must answer to when the two ever get compared (F-33 showed the chain
  // path CAN be wrong). Sub-second, so a stale display never rides it.
  const ONCHAIN_SCREEN_CHECK_MAX_AGE_MS = 600;

  function quoteSnapshot() {
    if (!token || !(Number(token.priceNative) > 0)) return null;
    return {
      mint: token.mint,
      priceNative: Number(token.priceNative),
      priceUsd: Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null,
      mcap: Number(token.mcap) > 0 ? Number(token.mcap) : null,
      source: token.priceSource || 'unknown',
      receivedAt: lastPriceAt,
    };
  }

  function waitForNewPageQuote(afterSeq, timeoutMs) {
    if (pageQuoteSeq > afterSeq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { pageQuoteWaiters.delete(done); resolve(pageQuoteSeq > afterSeq); };
      pageQuoteWaiters.add(done);
      setTimeout(done, timeoutMs);
    });
  }

  /**
   * Convert a live on-chain observation into a fill-ready quote.
   *
   * The chain gives a SOL-denominated price. USD and market cap are derived
   * from the same observation using the SOL/USD and supply ratios the resolver
   * already established, so the fill, the panel, the marker and the average
   * line can never disagree with each other.
   */
  function quoteFromOnchain(observation) {
    if (!observation || !(observation.priceNative > 0)) return null;
    if (!token || token.mint !== observation.mint) return null;

    const anchorNative = Number(token.priceNative);
    const anchorUsd = Number(token.priceUsd);
    const usdPerSol = anchorNative > 0 && anchorUsd > 0 ? anchorUsd / anchorNative : null;
    const priceUsd = usdPerSol ? observation.priceNative * usdPerSol : null;

    const anchorMcap = Number(token.mcap);
    const mcap = anchorMcap > 0 && anchorUsd > 0 && priceUsd
      ? anchorMcap * (priceUsd / anchorUsd)
      : null;

    return {
      mint: observation.mint,
      priceNative: observation.priceNative,
      priceUsd,
      mcap,
      slot: observation.slot,
      source: 'onchain',
      receivedAt: observation.observedAt,
    };
  }

  // The freshest price this tab accepted as MARKET truth (a validated tick,
  // or its own committed fill) — the evidence a fill-time candidate is
  // judged against (F-47). Deliberately NOT token.priceNative: requote()
  // writes resolver prices there, and a lagging aggregator is precisely the
  // witness problem, not its solution.
  let lastAcceptedMarket = null;
  let lastQuoteRefusal = null;

  /**
   * F-47 (chatcabal): the market crashed ~30K -> ~8K, the DCA buy filled
   * honestly at the crashed price, and the sell sixty seconds later filled
   * at the PRE-crash level — a loss rendered as +167%. Whatever source
   * served it, the shape is one: a fill candidate that contradicts market
   * evidence this tab just accepted as money. Such a candidate needs an
   * independent second source to vouch for it; no witness, or a dissenting
   * one, refuses the fill out loud. A real 4x move is confirmed by any
   * fresh witness and fills normally.
   */
  async function corroborateForFill(chosen) {
    lastQuoteRefusal = null;
    if (!chosen) return null;
    // F-56 (soramonk 8/21, AMERICOIN): the witness gate keyed ONLY on
    // lastAcceptedMarket — a page that never accepted a tick (fresh chart,
    // quiet feed) had NO evidence, so needsFillWitness() returned false and
    // a poisoned print priced a fill unchallenged (paper-sell at 1.6M MC on
    // a coin whose ATH was 113k — a 14x phantom). The position's own last
    // honest mark is evidence the wallet already stands behind: when the
    // chart page has none, use it as the anchor. Same window, same ratio —
    // a real 4x move still corroborates from any fresh second source; a
    // 14x dust-pool print with no vouch REFUSES like it always should have.
    // (state may be absent in isolated ladder tests — the anchor is then
    // simply not available and the pre-F-56 behavior stands there.)
    let posEvidence = null;
    try {
      posEvidence = token && state && state.positions[token.mint]
        ? state.positions[token.mint].lastPriceNative || null
        : null;
    } catch (_) { posEvidence = null; }
    const evidence = lastAcceptedMarket || (posEvidence > 0
      ? { priceNative: posEvidence, at: Date.now() }
      : null);
    const evidenceAge = evidence ? Date.now() - evidence.at : Infinity;
    // F-57: the band depends on where the candidate came from. A live feed
    // keeps the wide 2x window (real memecoin moves are violent); an
    // aggregator snapshot answers to a tight one, because its disagreements
    // are lag far more often than they are news.
    if (!Q.needsFillWitness(chosen.priceNative, evidence && evidence.priceNative,
      evidenceAge, chosen.source)) {
      return chosen;
    }
    // The witness must be INDEPENDENT of the candidate's own source. F-57:
    // this used to name ONE aggregator path ('action-resolver') and send
    // every other candidate to R.refresh() — which is the aggregator. So an
    // adopted 'resolver' or 'jupiter' price was witnessed by asking the same
    // service that served it, and a lagging read cheerfully confirmed
    // itself. Any aggregator-sourced candidate is now witnessed by the chain.
    let witnessNative = null;
    if (Q.isAggregatorSource(chosen.source)) {
      const obs = await R.onchainQuote(token && token.mint).catch(() => null);
      if (obs && obs.priceNative > 0) witnessNative = obs.priceNative;
    } else {
      const fresh = await R.refresh(token).catch(() => null);
      if (fresh && Number(fresh.priceNative) > 0) witnessNative = Number(fresh.priceNative);
    }
    if (Q.witnessAgrees(chosen.priceNative, witnessNative)) return chosen;
    lastQuoteRefusal = 'Price sources disagree ('
      + E.fmt(chosen.priceNative) + ' vs recent ' + E.fmt(evidence.priceNative)
      + (witnessNative ? ', witness ' + E.fmt(witnessNative) : ', no second source')
      + ') — paper fill refused. Try again in a moment.';
    console.debug('PaperTrench: fill witness refused', {
      candidate: chosen.priceNative, source: chosen.source,
      evidence: evidence.priceNative, evidenceAgeMs: evidenceAge,
      witness: witnessNative,
    });
    return null;
  }

  async function quoteForTrade() {
    return corroborateForFill(await pickQuoteForTrade());
  }

  async function pickQuoteForTrade() {
    const startMint = token && token.mint;
    if (!startMint) return null;

    // Snapshot BEFORE any async hop. The service-worker round trip below can
    // cost hundreds of ms on a cold worker — it must not consume the freshness
    // budget of the price the user actually clicked on (DEFECT F-13).
    const clickAt = Date.now();
    const atClick = quoteSnapshot();
    const atClickAge = atClick ? clickAt - atClick.receivedAt : Infinity;

    // F-52 (superski): a FRESH on-screen price is the price the trader
    // acted on, and it prices the fill — full stop. The chain used to be
    // asked first and win whenever it sat within the 6% agree band, so the
    // recorded entry routinely landed a few percent above or below the
    // number the trader clicked on ("it'll fill you in lower than ur
    // actual entry or higher sometimes"). F-33 already ruled that a fresh
    // screen beats a DISAGREEING chain read; trusting it only when the
    // chain was wrong by >6% while overriding it inside the band was the
    // inconsistency. The witness gate (F-47) still judges this candidate
    // against accepted market evidence, so a poisoned tick cannot ride the
    // fresh-screen path into a fill — and skipping the chain round trip
    // here makes the common fill faster, which is exactly what a fresh
    // launch needs.
    //
    // F-57 (field report, 8/22): "higher entry without wicks or anything, just
    // filled me at 35k while the coin is moving around 25k" — a 1.4x worse
    // entry on a chart that never printed that level. The F-52 fast path read
    // `atClickAge`, which is derived from lastPriceAt — and lastPriceAt is
    // bumped by RESOLVER ADOPTIONS too (the poll loop and requote both write
    // token.priceNative and re-stamp it). So a lagging aggregator quote that
    // landed inside the 600ms window was returned here AS the on-screen
    // price: the ladder was skipped, the chain was never asked, and the F-47
    // witness let it pass because 1.4x sits under the 2x ratio. The comment
    // above already named the field the evidence stream refuses to trust for
    // exactly this reason; the fast path was reading it anyway.
    //
    // The fix is provenance, not another ratio: this path exists because the
    // trader is looking at a moving chart, so it may only fire when the PAGE
    // FEED is what moved. A resolver adoption falls through to the chain read
    // below, which does answer to accepted evidence (F-48, 1.10 band).
    const screenFresh = atClick
      && atClickAge <= ONCHAIN_SCREEN_CHECK_MAX_AGE_MS
      && lastPageTickAt > 0
      && clickAt - lastPageTickAt <= ONCHAIN_SCREEN_CHECK_MAX_AGE_MS;
    if (screenFresh) return atClick;

    // The screen is quiet — chain state is the authority now. It is the only
    // source that is not behind by construction, but never blindly:
    // F-48 (Terp, lute.gg): under the 2x witness ratio nothing else examined
    // a chain read before it priced the fill — a 24%-lagging read booked a
    // win as -9.6%. Judge the candidate against the freshest evidence this
    // tab accepted as money (the F-47 stream); on contradiction the chain
    // read is DEMOTED, not trusted, and the ladder below re-prices from
    // sources that can vouch for themselves.
    const observation = await R.onchainQuote(startMint);
    if (!token || token.mint !== startMint) return null;
    const onchain = quoteFromOnchain(observation);
    if (onchain) {
      const acceptedEvidence = lastAcceptedMarket;
      const acceptedEvidenceAge = acceptedEvidence ? Date.now() - acceptedEvidence.at : Infinity;
      if (!Q.onchainContradictsEvidence(onchain.priceNative,
        acceptedEvidence && acceptedEvidence.priceNative, acceptedEvidenceAge)) {
        return onchain;
      }
      console.debug('PaperTrench: on-chain quote ' + onchain.priceNative
        + ' contradicts accepted market evidence ' + acceptedEvidence.priceNative
        + ' (' + acceptedEvidenceAge + 'ms old) on a quiet screen — re-pricing from the ladder');
    }

    // The freshest local price, judged by its age AT CLICK time — the round
    // trip above must not have aged it out of its own window.
    if (atClick && atClickAge <= ACTION_QUOTE_MAX_AGE_MS) return atClick;

    const seqAtClick = pageQuoteSeq;
    // Prefer an imminent site-feed update (Padre bar / GMGN worker) over an
    // aggregator response because it is the price represented by that chart.
    await waitForNewPageQuote(seqAtClick, ACTION_PAGE_WAIT_MS);
    if (!token || token.mint !== startMint) return null;
    const pageQuote = quoteSnapshot();
    if (pageQuote && pageQuoteSeq > seqAtClick && Date.now() - pageQuote.receivedAt <= ACTION_QUOTE_MAX_AGE_MS) {
      return pageQuote;
    }

    // A truly unresolved fresh launch has no aggregator to ask — the on-screen
    // price is the only price there is. Give it its own bounded window and
    // skip the refresh round trip that cannot succeed yet (the sniping case).
    if (token.pending) {
      const pendingQuote = quoteSnapshot();
      if (pendingQuote && Date.now() - pendingQuote.receivedAt <= PENDING_ACTION_MAX_AGE_MS) return pendingQuote;
    }

    // The feed is quiet. Take exactly one action-time resolver quote rather
    // than filling from the stale display snapshot. If the page ticks while it
    // is in flight, the newer page quote wins.
    const fresh = await R.refresh(token);
    if (!token || token.mint !== startMint) return null;
    if (pageQuoteSeq > seqAtClick) {
      const newerPageQuote = quoteSnapshot();
      if (newerPageQuote && Date.now() - newerPageQuote.receivedAt <= ACTION_QUOTE_MAX_AGE_MS) return newerPageQuote;
    }

    if (fresh && Number(fresh.priceNative) > 0 && (!fresh.mint || fresh.mint === startMint)) {
      // Keep GMGN's chart-scale market cap from its own market-cap feed when
      // it is available; Dexscreener is the fallback quote, not the chart
      // authority.
      const inheritedMcap = site && site.id === 'gmgn' && Number(token.mcap) > 0 && Number(token.priceUsd) > 0 && Number(fresh.priceUsd) > 0
        ? Number(token.mcap) * (Number(fresh.priceUsd) / Number(token.priceUsd))
        : Number(fresh.mcap) || null;
      return {
        mint: startMint,
        priceNative: Number(fresh.priceNative),
        priceUsd: Number(fresh.priceUsd) > 0 ? Number(fresh.priceUsd) : null,
        mcap: inheritedMcap,
        source: 'action-resolver',
        receivedAt: Date.now(),
      };
    }

    // Every live source failed (resolver outage, unindexed migration). The
    // on-screen snapshot may stand in — but only within the same bound the
    // header uses to flag a price as stale, and for EVERY price source alike.
    // Beyond that, the fill is refused with a visible reason instead of
    // executing at a price the UI itself no longer stands behind (F-01/F-20).
    const lastResort = quoteSnapshot();
    if (lastResort && Date.now() - lastResort.receivedAt <= STALE_FILL_MAX_AGE_MS) return lastResort;
    return null;
  }

  /* -------------------- fills -------------------- */

  let mutationChain = Promise.resolve();
  function withState(fn) {
    const run = mutationChain.then(async () => { await reloadState(); return fn(); });
    // Keep the chain itself resilient so one failed mutation never poisons
    // every later one — but hand the caller the REAL result or error. The old
    // `.catch(() => {})` on the returned promise swallowed fill failures
    // (insufficient balance, token changed, storage error) so the buy/sell
    // button did nothing with no toast. Errors must surface to the trader.
    mutationChain = run.catch(() => {});
    return run;
  }

  async function reloadState() {
    const stored = await store.get([E.STORAGE_KEYS.state, E.STORAGE_KEYS.settings]);
    // A failed read (null) must keep whatever state we already hold: swapping
    // in a fresh default here is how a transient storage error silently wipes
    // every open position — and the next heartbeat mark persists that wipe.
    if (stored === null) return;
    settings = E.mergeSettings(stored[E.STORAGE_KEYS.settings]);
    // A missing state key means "never stored"; the in-memory default is
    // already the correct value for that case, so never fabricate over a
    // state this session has since populated.
    if (stored[E.STORAGE_KEYS.state]) state = stored[E.STORAGE_KEYS.state];
    // D-56: first load of a LEGACY wallet (born before D-06's startSol
    // snapshot) re-derives its birth balance from the journal and freezes it
    // onto state. The in-memory write lands in storage with the next
    // heartbeat CAS — the derivation is stable across concurrent fills, so
    // no dedicated writer is needed here. Idempotent once startSol exists.
    E.backfillAnchor(state, settings);
  }

  /**
   * Adopt wallet state written elsewhere and re-render everything that
   * depends on it. Shared by the storage listener and the contention guard in
   * persistSoon, so both paths refresh the UI identically.
   */
  function adoptState(next) {
    const hadPosition = Boolean(token && state.positions && state.positions[token.mint]);
    state = next;
    // D-56: a state adopted from another writer (storage listener, CAS
    // contention) may be the first sighting of a legacy wallet — anchor it
    // before the re-render below, so the vs-start figures read the derived
    // birth instead of the live setting on this very paint.
    E.backfillAnchor(state, settings);
    const hasPosition = Boolean(token && state.positions && state.positions[token.mint]);
    // The card's structure only changes when a position appears or vanishes.
    if (hadPosition !== hasPosition) posEls = null;

    renderBalance();
    renderPosition();
    renderClosedPnl();
    // A fill in ANOTHER tab changes the portfolio too; without this the bar
    // would keep showing a chip for a position that is already closed.
    renderPositionsBar();
    // A close adopted from another tab moves the discipline streaks too —
    // this event-driven refresh is what keeps streak math out of the tick path.
    refreshTrenchCache();
    syncAveragePriceLines();
    // A fill adopted from another tab (row snipe on a list page while this
    // chart was open) must appear on THIS chart too — replay is idempotent
    // via drawnFillIds, so already-drawn fills never duplicate.
    restoreMarkersFromJournal();
  }

  /**
   * Stamp the current state as the newest version and COMMIT it through the
   * background's serialized compare-and-swap (pt_state_commit).
   *
   * `seq` is a monotonic write counter, and it used to be advisory: every
   * writer wrote the whole blob with a bare storage.set, so two writers
   * reading the same base both stamped seq N+1 and the second silently ate
   * the first — an ~800ms heartbeat in one tab could eat a fill just made
   * in another, which is exactly "several buys and the position vanished,
   * then came back with false P&L" (LYAR field report, twice). The worker
   * now refuses a write whose base is stale and hands back the current
   * state; this loop adopts it, re-applies what this tab genuinely owns —
   * its live marks, and the caller's own mutation via `remutate` — and
   * commits again. Nothing is ever overwritten unseen.
   *
   * `remutate` re-applies THIS call's state mutation onto the adopted base
   * (a fill, an order change). The heartbeat passes none: its marks are
   * re-applied here and there is nothing else it owns.
   */
  async function persistStateNow(remutate) {
    for (let attempt = 0; attempt < 4; attempt++) {
      state.seq = (Number(state.seq) || 0) + 1;
      state.updatedAt = Date.now();
      lastWrittenState = state;
      // F-41: chrome.storage.onChanged delivers a STRUCTURED CLONE, so an
      // identity check can never recognize our own write — every local
      // fill was being re-adopted (and, since F-40, replayed) as if another
      // tab had made it. The write STAMP survives cloning and does.
      lastWrittenStamp = `${state.seq}:${state.updatedAt}`;
      const reply = await sendMessage({
        type: 'pt_state_commit', state, expectedSeq: state.seq - 1,
      }).catch(() => null);
      if (reply && reply.ok) return;
      if (!reply || reply.reason !== 'stale' || !reply.current) {
        // The worker is unreachable (dying update, cold start failure). A
        // fill MUST NOT be droppable on availability grounds — fall back to
        // the direct write this function always did. The clobber window this
        // reopens is the width of a worker outage, not of every heartbeat.
        await store.set({ [E.STORAGE_KEYS.state]: state });
        return;
      }
      // Overtaken: someone landed between our base and our commit. Adopt
      // their truth, put back what is genuinely ours, try again.
      adoptState(reply.current);
      if (token && token.mint && Number(token.priceNative) > 0) {
        E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
      }
      for (const mint of Object.keys(livePositionPrices)) {
        const p = livePositionPrices[mint];
        if (p && Number(p.priceNative) > 0) E.markPosition(state, mint, p.priceNative, p.priceUsd);
      }
      if (remutate) await remutate();
    }
    // Live report 2026-08-22 (Trenches, 5 PT tabs live): every quick-buy chip
    // fill LOST all four CAS rounds — each tap opens a chart tab (#29), every
    // tab heartbeats ~800ms, and the losers threw here. The fill vanished
    // with a silent pageerror and the chart page had nothing to draw (the
    // exact "buy lines, bubbles and position missing" report). Policy:
    // a MUTATION (a fill — remutate present) must never be dropped; after
    // the loop its state is already last-adopted + re-applied, so one final
    // FORCED commit lands it with only a millisecond-wide clobber window.
    // A pure heartbeat (no remutate) has nothing unique — it walks away and
    // tries again next beat, which is what keeps the LYAR silent-eat class
    // dead: heartbeats never force.
    if (remutate) {
      state.seq = (Number(state.seq) || 0) + 1;
      state.updatedAt = Date.now();
      lastWrittenState = state;
      lastWrittenStamp = `${state.seq}:${state.updatedAt}`;
      const forced = await sendMessage({
        type: 'pt_state_commit', state, expectedSeq: state.seq - 1, force: true,
      }).catch(() => null);
      if (!forced || !forced.ok) {
        // SW unreachable: the direct-write fallback, same availability rule
        // as inside the loop. A fill is never droppable.
        await store.set({ [E.STORAGE_KEYS.state]: state });
      }
      return;
    }
    // Four consecutive losses means writers are landing every few ms —
    // something is wrong enough that pretending to have persisted is worse.
    throw new Error('The wallet kept changing under this write — please retry');
  }

  /**
   * Adopt wallet state written elsewhere (another tab, the popup, the
   * dashboard) so the position card and balance never show stale figures.
   *
   * Writes we originated are tagged and skipped, rather than gating on a
   * pending-write timer: the heartbeat persists marks continuously, so a timer
   * guard would suppress external updates almost permanently.
   */
  function watchStorage() {
    if (!contextAlive() || !chrome.storage || !chrome.storage.onChanged) return;
    const listener = (changes, area) => {
      if (contextDead || area !== 'local') return;

      const settingsChange = changes[E.STORAGE_KEYS.settings];
      if (settingsChange && settingsChange.newValue) {
        settings = E.mergeSettings(settingsChange.newValue);
        // Theme switches live on the attribute, not a remount — cheap and
        // flicker-free while the rest of the overlay stays mounted.
        applyTheme(settings.panelTheme);
        positionsBarHidden = settings.positionsBarHidden === true;
        // appEnabled is the app-wide master switch: when it is off, nothing
        // PaperTrench owns may exist on the page, whatever the sub-settings
        // say. disableOverlay() is the full teardown (panel, positions bar,
        // chart drawings, title signal, timers, pool subscriptions).
        if (settings.appEnabled !== false && settings.overlayEnabled) enableOverlay().catch(() => {});
        else disableOverlay();
        // The jank sampler is SPEED telemetry (Turbo receipts): it follows
        // the speed toggles, not the paper master — the maintainer's rule is
        // that "PaperTrench off" never takes the speed plane down.
        if (settings.warmXLinksEnabled || settings.warmEverywhereEnabled) startJankSampling();
        else stopJankSampling();
        if (els.buyPresets) renderPresets();
        syncAveragePriceLines();
        updateOverlayVisibility();
        applyOverlaySize();
        renderPositionsBar();
        // D-37: focus mode and the sell ladder must apply live, not at the
        // next card rebuild. applyFocusMode re-rides the .pt-focus class
        // cheaply; the sell buttons are built once per position card, so a
        // changed sellPcts list forces exactly one rebuild — renderPosition()
        // rebuilds via buildPositionCard when posEls is nulled.
        applyFocusMode();
        const prevSell = (settingsChange.oldValue && settingsChange.oldValue.sellPcts) || null;
        const nextSell = settings.sellPcts || null;
        if (JSON.stringify(prevSell) !== JSON.stringify(nextSell)) {
          posEls = null;
          renderPosition();
        }
        // A settings flip can change whether this page has tick consumers
        // (e.g. list quick-buy chips toggled) — republish the feed demand.
        publishPageState();
      }

      // The slow-pool notice (cojica456's report, solved for everyone): the
      // worker measured the public price connection as slow from this
      // machine and wrote the notice exactly once. Say it at the moment it
      // exists, in the place the user is trading.
      const rpcNotice = changes.pt_rpc_notice;
      if (rpcNotice && rpcNotice.newValue && !rpcNotice.oldValue) {
        const ms = Number(rpcNotice.newValue.bestMs) || 0;
        toast('Heads-up: the public price connection is slow from your region'
          + (ms ? ` (~${ms}ms)` : '')
          + '. A free personal endpoint makes new coins instant — Dashboard → Settings → Price connection.');
      }

      const stateChange = changes[E.STORAGE_KEYS.state];
      if (!stateChange) return;
      const next = stateChange.newValue;
      if (!next || next === state) return;
      if (lastWrittenState && next === lastWrittenState) return; // our own write
      // …and the same write after Chrome cloned it (F-41).
      if (lastWrittenStamp && `${next.seq}:${next.updatedAt}` === lastWrittenStamp) return;

      adoptState(next);
    };
    chrome.storage.onChanged.addListener(listener);
    onTeardown(() => {
      try { chrome.storage.onChanged.removeListener(listener); } catch (_) {}
    });
  }

  /**
   * Restore chart markers for the current token from the journal history.
   * Called after the token is resolved and state is loaded, so a page reload
   * doesn't lose the visual trade history.
   */
  function restoreMarkersFromJournal() {
    if (!token || !token.mint) return;
    const fills = (state.journal || []).filter(
      (t) => t.mint === token.mint && (t.side === 'buy' || t.side === 'sell')
    ).reverse(); // journal is newest-first; we want chronological
    for (const f of fills) {
      if (f.id && drawnFillIds.has(f.id)) continue;
      if (f.id) drawnFillIds.add(f.id);
      drawFillOnChart({
        ts: f.ts,
        fillId: f.id,
        side: f.side,
        priceNative: f.priceNative,
        priceUsd: f.priceUsd,
        mcap: f.mcap,
        solAmount: f.solGross,
      });
    }
  }

  /* DEFECT C-01: the paper-lines spec carries currentPrice* so the bridge can
   * hold mcap-axis lines at the ENTRY level (lastBarClose x avg/current).
   * When the spec was only posted at resolve/fill/settings time, `current`
   * froze there — the ratio pinned near 1 and the "average" line rode the
   * live candle no matter how far the coin ran. The spec is therefore
   * re-posted while prices move: at most every LINE_REPOST_MS, or immediately
   * on a move larger than LINE_REPOST_MOVE_PCT since the last post. An
   * axis-basis change re-posts immediately, bypassing the throttle (C-06).
   */
  const LINE_REPOST_MS = 2000;
  const LINE_REPOST_MOVE_PCT = 0.005; // 0.5 %
  let lastLineSpecPostAt = 0;
  let lastLineSpecPrice = 0;
  let lastLinesActive = false; // the previous sync actually produced lines

  function maybeRepostAverageLines() {
    // Only worth a post while lines are actually on screen — this must never
    // turn into a 2 s clear-message drip on tokens with no position.
    if (!lastLinesActive || !token || !(Number(token.priceNative) > 0)) return;
    const price = Number(token.priceNative);
    const now = Date.now();
    const moved = lastLineSpecPrice > 0
      && Math.abs(price / lastLineSpecPrice - 1) >= LINE_REPOST_MOVE_PCT;
    if (!moved && now - lastLineSpecPostAt < LINE_REPOST_MS) return;
    syncAveragePriceLines();
  }

  /* ---------------- chart orders: take profit / stop loss ----------------
   *
   * Arm a level by dragging a line on the chart; the position exits itself
   * when the market reaches it. The RULES live in the engine (see the
   * chart-orders note in engine.js) — this is the plumbing: post the armed
   * set to the MAIN-world bridge, take drags back from it, and fire.
   *
   * WHAT PRICE A FIRED ORDER FILLS AT. The triggering tick's price, exactly
   * as observed — NOT a freshly fetched quote, and NOT the trigger level.
   * Re-quoting would fill at a price the order never actually saw, and
   * filling at the level would hide the gap. The first tick on which the
   * condition holds IS the next observed price after the crossing, which is
   * the honest fill by construction.
   */

  let orderFireInFlight = false;
  let lastOrderSpecSignature = null;
  let lastOrderStatus = null;
  // Learned per page, never assumed: a chart proves it can carry a draggable
  // line by carrying one. Charts shipping TradingView's standalone build
  // throw on createOrderLine (F-39), and on those the drag is honestly
  // withdrawn instead of offered and silently doing nothing.
  let chartOrdersDraggable = true;

  function chartOrdersOn() {
    return settings.appEnabled !== false && settings.chartOrdersEnabled !== false;
  }

  /** The armed orders for the token on screen. */
  function currentOrders() {
    return token && token.mint ? E.ordersFor(state, token.mint) : [];
  }

  /**
   * Push the armed set to the bridge. Throttled by CONTENT, not by time: a
   * repost that would draw the same lines at the same levels is skipped, so
   * the ~800 ms heartbeat cannot fight a line the user is mid-drag on.
   */
  function syncChartOrders(force) {
    if (!usesNativeChart()) return;
    if (!chartOrdersOn() || !token || !token.mint) {
      if (lastOrderSpecSignature !== null) {
        lastOrderSpecSignature = null;
        sendPadreMarker('paper-orders-clear');
      }
      return;
    }
    const orders = currentOrders();
    if (!orders.length) {
      if (lastOrderSpecSignature !== null) {
        lastOrderSpecSignature = null;
        sendPadreMarker('paper-orders-clear');
      }
      return;
    }
    // D-42: the live price is needed to interpret the CURRENT axis (mcap
    // basis needs the bar close, USD basis needs the live rate), but it
    // must never move a level. The conversion anchor is frozen per post:
    // refPrice + the axis unit captured at the same instant. A ratio built
    // from two prices sampled at different times (stale ref vs live close)
    // drifts the line with the market — TP/SL are ABSOLUTE levels (D-42
    // report: "levels move with MC — should be fixed").
    const refPrice = Number(token.priceNative) || 0;
    if (!(refPrice > 0)) return;
    const refMcap = Number(token.mcap) || 0;
    const refPriceUsd = Number(token.priceUsd) || 0;

    // The signature covers everything the bridge draws from. The live price
    // is deliberately EXCLUDED: levels are absolute, so a moving price does
    // not move a line, and including it would repost on every tick.
    const orderLineWidth = Math.max(1, Math.min(4, Math.round(
      Number(settings.chartOrderLineThickness) || 2)));
    // Thickness rides the signature so a settings change alone redraws
    // (orders/axis unchanged otherwise would leave stale-width lines up).
    const signature = JSON.stringify(orders.map((o) => [o.id, o.kind, o.triggerPrice, o.sizePct]))
      + '|' + chartAxisBasis + '|' + orderLineWidth;
    if (!force && signature === lastOrderSpecSignature) return;
    lastOrderSpecSignature = signature;

    sendPadreMarker('paper-orders', {
      enabled: true,
      axisBasis: chartAxisBasis,
      refPrice,
      // D-42: the axis-unit snapshot taken with refPrice at post time. The
      // bridge draws level = unit × (trigger / refPrice) with BOTH factors
      // from the same instant, so the ratio (venue-units per price unit —
      // the supply, constant for a coin) is what converts, and the line
      // holds its level while the market moves.
      refMcap,
      refPriceUsd,
      // settings.chartOrderLineThickness (1..4): TP/SL line width on the
      // native TradingView chart. The bridge clamps; here it just rides.
      lineWidth: orderLineWidth,
      currentPriceNative: token.priceNative,
      currentPriceUsd: token.priceUsd,
      orders: orders.map((o) => ({
        id: o.id,
        kind: o.kind,
        triggerPrice: o.triggerPrice,
        sizePct: o.sizePct,
        label: orderLineLabel(o),
      })),
    });
  }

  /**
   * What the line says on the chart. Market cap first — it is how traders
   * quote a level ("out at 240K"), and matches the journal's own convention.
   */
  function orderLineLabel(order) {
    const kind = order.kind === 'tp' ? 'TP' : 'SL';
    const mcap = mcapAtPrice(order.triggerPrice);
    const level = mcap ? fmtMoney(mcap) : E.fmt(order.triggerPrice, 8) + ' SOL';
    // The % is measured from the AVERAGE ENTRY — the same number the average
    // fill line draws from, so the chart cannot show two different entries.
    // With no average yet, the label claims no percentage at all.
    const averages = token && token.mint ? E.averageFillPrices(state, token.mint) : null;
    const entry = averages && Number(averages.avgBuyNative) > 0 ? Number(averages.avgBuyNative) : null;
    const pct = entry ? ((order.triggerPrice - entry) / entry) * 100 : null;
    return pct === null
      ? `${kind} ${level}`
      : `${kind} ${level} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`;
  }

  /**
   * Fire every order this observed price has tripped.
   *
   * Called from the tick path. Sequential and guarded: two stops tripped by
   * one crash must not race each other through the wallet, and a re-entrant
   * tick must not double-fill the same level.
   */
  async function evaluateChartOrders() {
    if (orderFireInFlight || !chartOrdersOn() || !token || !token.mint) return;
    const observed = Number(token.priceNative);
    if (!(observed > 0)) return;
    const due = E.triggeredOrders(state, token.mint, observed);
    if (!due.length) return;

    orderFireInFlight = true;
    try {
      for (const order of due) {
        // Re-check against the live wallet: an earlier order in this same
        // batch may have closed the position out from under this one.
        if (!state.positions[token.mint]) break;
        if (!E.ordersFor(state, token.mint).some((o) => o.id === order.id)) continue;
        await fireChartOrder(order, observed);
      }
    } finally {
      orderFireInFlight = false;
    }
  }

  async function fireChartOrder(order, observedPrice) {
    const mint = token.mint;
    const priceUsd = Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null;
    const mcap = mcapAtPrice(observedPrice);
    try {
      const result = await withState(async () => {
        // Re-runnable mutation — see doBuy: a lost CAS race re-applies this
        // order fire on the adopted base. The position re-check runs every
        // attempt: the race that was lost may have been the user's own
        // manual close in another tab.
        let filled = null;
        const mutate = () => {
          filled = null;
          if (!state.positions[mint]) return;
          // D-58 / jb 2026-08-18: the position is NOT enough to decide this
          // is still ours to fire. A lost CAS race re-runs this mutation on
          // the winner's adopted state — and if the winning context already
          // spent this very order, re-applying the sell books the clip a
          // SECOND time: cash credited twice, the round's returnedSol
          // double-counts, paper equity inflates by a whole extra set of clip
          // proceeds (jb: +0.091 true, +9.109 shown). The order id is the
          // thing that must still be live, exactly as firePendingBuy
          // re-checks its armed buy still exists before re-applying.
          if (!E.ordersFor(state, mint).some((o) => o.id === order.id)) return;
          filled = E.sell(state, settings, {
            ts: Date.now(), mint, site: site && site.id,
            qtyFraction: order.sizePct / 100,
            priceNative: observedPrice,
            priceUsd,
            mcap,
            ...(feeContextForOrder() || {}),
            order,
          });
          // The order is spent whether or not it closed the round.
          E.removeOrder(state, mint, order.id);
          drawnFillIds.add(filled.trade.id);
        };
        mutate();
        if (!filled) return null;
        await persistStateNow(mutate);
        if (!filled) return null; // a retry found the position already gone
        const { trade, position, round } = filled;
        // Chain append after the wallet commit — see doBuy for the ordering.
        await commitFill(trade);
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'sell' });
        drawFillOnChart({
          ts: markerTs, fillId: trade.id, side: 'sell',
          priceNative: trade.priceNative, priceUsd: trade.priceUsd,
          mcap: trade.mcap, solAmount: trade.solGross,
        });
        syncAveragePriceLines();
        if (round) profitAlertLevels.delete(mint);
        return { trade, position, round };
      });
      if (!result) return;

      syncChartOrders(true);
      sendMessage({
        type: 'pt_trade_event', kind: 'sell', opened: false,
        session: summarizeSession(result.round || result.position),
        trade: summarizeTrade(result.trade),
        round: result.round ? summarizeRound(result.round) : null,
      }).catch(() => {});
      runTradeEffect('sell');
      playTradeSound('sell');
      announceOrderFill(order, result);
    } catch (err) {
      // A refused fill must not leave a level armed that the wallet has
      // already decided against — but it must also not vanish silently.
      toast(`${order.kind === 'tp' ? 'Take profit' : 'Stop loss'} could not fill: ${err.message || 'unknown error'}`);
    }
    renderAll();
  }

  /* ----------------- armed limit buys (N2) -----------------
   * Ideas channel (.dgreatest). Same doctrine as TP/SL fires: judged on the
   * tick that first crossed the level, filled at the observed price, locked
   * SOL released only by fill/cancel/expiry. The lock is checked at ARM
   * time against free cash so two bids cannot spend the same SOL. */

  let pendingBuyFireInFlight = false;

  async function evaluatePendingBuys() {
    if (pendingBuyFireInFlight || !token || !token.mint) return;
    const observed = Number(token.priceNative);
    if (!(observed > 0)) return;
    const due = E.triggeredPendingBuys(state, token.mint, observed);
    if (!due.length) return;
    pendingBuyFireInFlight = true;
    try {
      for (const buy of due) {
        if (!E.pendingBuysFor(state, token.mint).some((o) => o.id === buy.id)) continue;
        await firePendingBuy(buy, observed);
      }
    } finally {
      pendingBuyFireInFlight = false;
    }
  }

  async function firePendingBuy(buy, observedPrice) {
    const mint = token.mint;
    const priceUsd = Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null;
    const mcap = mcapAtPrice(observedPrice);
    try {
      const result = await withState(async () => {
        let filled = null;
        const mutate = () => {
          filled = null;
          // The armed entry is spent whether or not the wallet still wants
          // it — the guard inside E.buy is the FINAL word on cash.
          const armed = E.pendingBuysFor(state, mint).find((o) => o.id === buy.id);
          if (!armed) return;
          E.removePendingBuy(state, mint, buy.id);
          try {
            filled = E.buy(state, settings, {
              ts: Date.now(), mint, pairAddress: token.pairAddress,
              symbol: token.symbol, name: token.name, site: site && site.id,
              solAmount: armed.solAmount,
              priceNative: observedPrice, priceUsd, mcap,
              ...(feeContextForOrder() || {}),
            });
          } catch (err) {
            // Cash could not cover it (something else spent first): the
            // entry is dropped with a visible reason, never silently.
            toast(`Limit buy could not fill: ${err.message || 'wallet refused'}`);
            filled = { error: err.message || 'wallet refused' };
            return;
          }
          drawnFillIds.add(filled.trade.id);
        };
        mutate();
        if (!filled) return null;
        if (filled.error) return null;
        await persistStateNow(mutate);
        const { trade, position } = filled;
        await commitFill(trade);
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'buy' });
        drawFillOnChart({
          ts: markerTs, fillId: trade.id, side: 'buy',
          priceNative: trade.priceNative, priceUsd: trade.priceUsd,
          mcap: trade.mcap, solAmount: trade.solGross,
        });
        syncAveragePriceLines();
        if (filled.opened) profitAlertLevels.set(mint, 0);
        return filled;
      });
      if (result) {
        sendMessage({
          type: 'pt_trade_event', kind: 'buy', opened: result.opened,
          session: summarizeSession(result.position),
          trade: summarizeTrade({ ...result.trade, source: 'limit-buy' }),
        }).catch(() => {});
        runTradeEffect('buy');
        playTradeSound('buy');
        const askedMcap = mcapAtPrice(buy.triggerPrice);
        const asked = askedMcap ? `${fmtMoney(askedMcap)} MC` : `${E.fmt(buy.triggerPrice, 8)} SOL`;
        const slipPct = buy.triggerPrice > 0
          ? ((observedPrice - buy.triggerPrice) / buy.triggerPrice) * 100 : 0;
        toast(`Limit buy ${asked} fired — bought ${E.fmt(buy.solAmount, 3)} SOL${slipPct <= -0.1 ? ` (${slipPct.toFixed(1)}% vs asked)` : ''}`);
      }
    } catch (err) {
      toast(`Limit buy could not fill: ${err.message || 'unknown error'}`);
    }
    renderAll();
  }

  function armLimitBuy() {
    if (!token || !token.mint) return toast('Waiting for the token…');
    const price = Number(els.limitPrice && els.limitPrice.value);
    // Same amount read the BUY button uses: custom box wins, else the
    // selected preset chip.
    const custom = Number(els.custom && els.custom.value);
    const sel = els.buyPresets && els.buyPresets.querySelector('.pt-preset.sel');
    const amount = custom > 0 ? custom : sel ? Number(sel.dataset.amt) : 0;
    if (!(price > 0)) return toast('Type a limit price first (SOL)');
    if (!(amount > 0)) return toast('Pick a SOL amount first (presets or custom)');
    if (token.priceNative && price >= Number(token.priceNative)) {
      // A bid ABOVE the market is a market buy in disguise — refuse the
      // confusion and say why. Buy it now instead.
      return toast('That limit is at or above the live price — just press BUY');
    }
    try {
      const order = E.addPendingBuy(state, settings, token.mint, {
        ts: Date.now(), triggerPrice: price, solAmount: amount,
        symbol: token.symbol, name: token.name, site: site && site.id,
      });
      persistSoon();
      if (els.limitPrice) els.limitPrice.value = '';
      const askedMcap = mcapAtPrice(price);
      toast(`Limit buy armed${askedMcap ? ` at ${fmtMoney(askedMcap)} MC` : ''} — ${E.fmt(amount, 3)} SOL locked`);
      renderLimitBuys();
    } catch (err) {
      toast(err.message || 'Could not arm the limit buy');
    }
  }

  function cancelLimitBuy(id) {
    if (!token || !token.mint) return;
    withState(async () => {
      E.removePendingBuy(state, token.mint, id);
      return null;
    }).then(() => {
      persistSoon();
      renderLimitBuys();
      toast('Limit buy cancelled — SOL unlocked');
    }).catch(() => {});
  }

  function renderLimitBuys() {
    if (!els.limitList) return;
    const buys = token && token.mint ? E.pendingBuysFor(state, token.mint) : [];
    if (!buys.length) { els.limitList.innerHTML = ''; return; }
    els.limitList.innerHTML = buys.map((o) => {
      const mcap = mcapAtPrice(o.triggerPrice);
      const dist = token && Number(token.priceNative) > 0
        ? (((Number(token.priceNative) - o.triggerPrice) / o.triggerPrice) * 100).toFixed(1) : null;
      return `<div class="pt-limit-item" data-id="${o.id}">
        <span class="pt-limit-lv">${mcap ? fmtMoney(mcap) + ' MC' : E.fmt(o.triggerPrice, 8) + ' SOL'}</span>
        <span class="pt-limit-amt">${E.fmt(o.solAmount, 3)} SOL${dist !== null ? ` <small>(${dist}% above)</small>` : ''}</span>
        <button class="pt-limit-x" data-id="${o.id}" title="Cancel and unlock the SOL">×</button>
      </div>`;
    }).join('');
    for (const btn of els.limitList.querySelectorAll('.pt-limit-x')) {
      btn.addEventListener('click', () => cancelLimitBuy(btn.getAttribute('data-id')));
    }
  }

  /**
   * Say what was asked for AND what was given. The slip is the whole point:
   * a stop that gapped 14% past its level taught something, and a toast that
   * hides it teaches the opposite.
   */
  function announceOrderFill(order, result) {
    const kind = order.kind === 'tp' ? 'Take profit' : 'Stop loss';
    const slip = Number(result.trade.triggerSlipPct);
    const askedMcap = order.triggerMcap || mcapAtPrice(order.triggerPrice);
    const gotMcap = result.trade.mcap || mcapAtPrice(result.trade.priceNative);
    const asked = askedMcap ? `${fmtMoney(askedMcap)} MC` : `${E.fmt(order.triggerPrice, 8)} SOL`;
    const got = gotMcap ? `${fmtMoney(gotMcap)} MC` : `${E.fmt(result.trade.priceNative, 8)} SOL`;
    const gap = Number.isFinite(slip) && Math.abs(slip) >= 0.1
      ? ` — filled ${got} (${slip >= 0 ? '+' : ''}${slip.toFixed(1)}% vs asked)`
      : ' — filled at the level';
    toast(`${kind} ${asked} fired${gap}`);
    if (result.round) {
      const r = result.round;
      toast(`Round closed: ${r.pnlSol >= 0 ? '+' : ''}${E.fmt(r.pnlSol)} SOL (${r.pnlPct.toFixed(1)}%) paper`);
    }
  }

  /** Arm a level. Returns the order, or throws with a reason to show. */
  async function armChartOrder(kind, triggerPrice, sizePct) {
    if (!token || !token.mint) throw new Error('No token detected on this page');
    const order = await withState(async () => {
      let made = null;
      const mutate = () => {
        made = E.addOrder(state, token.mint, {
          kind,
          triggerPrice,
          triggerMcap: mcapAtPrice(triggerPrice),
          sizePct,
        }, Number(token.priceNative), Date.now());
      };
      mutate();
      await persistStateNow(mutate);
      return made;
    });
    syncChartOrders(true);
    renderAll();
    return order;
  }

  async function cancelChartOrder(id) {
    if (!token || !token.mint) return;
    await withState(async () => {
      const mutate = () => E.removeOrder(state, token.mint, id);
      mutate();
      await persistStateNow(mutate);
    });
    syncChartOrders(true);
    renderAll();
  }

  /** A drag landed: adopt the new level, then re-post so the wallet wins. */
  async function adoptDraggedOrder(id, triggerPrice) {
    if (!token || !token.mint) return;
    await withState(async () => {
      const mutate = () => E.moveOrder(state, token.mint, id, triggerPrice, mcapAtPrice(triggerPrice));
      mutate();
      await persistStateNow(mutate);
    });
    // Force a repost: the label carries the level and the % from entry, both
    // of which the drag just changed.
    syncChartOrders(true);
    renderAll();
  }

  function syncAveragePriceLines() {
    if (!settings.averagePriceLinesEnabled || !token || !token.mint) {
      lastLinesActive = false;
      if (usesNativeChart()) sendPadreMarker('paper-lines-clear');
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
      if (CM && site && !usesNativeChart()) CM.clearAverageLines();
      return;
    }

    const averages = E.averageFillPrices(state, token.mint);
    if (!averages) {
      lastLinesActive = false;
      if (usesNativeChart()) sendPadreMarker('paper-lines-clear');
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
      if (CM && site && !usesNativeChart()) CM.clearAverageLines();
      return;
    }
    // Stamp the throttle BEFORE routing: every path below posts a spec (or
    // repaints the rail) built from the price captured right here.
    lastLinesActive = true;
    lastLineSpecPostAt = Date.now();
    lastLineSpecPrice = Number(token.priceNative) || 0;

    const usdPerNative = Number(token.priceUsd) > 0 && Number(token.priceNative) > 0
      ? Number(token.priceUsd) / Number(token.priceNative)
      : null;
    const avgBuyUsd = Number(averages.avgBuyUsd) > 0
      ? averages.avgBuyUsd
      : (usdPerNative && Number(averages.avgBuyNative) > 0 ? averages.avgBuyNative * usdPerNative : null);
    const avgSellUsd = Number(averages.avgSellUsd) > 0
      ? averages.avgSellUsd
      : (usdPerNative && Number(averages.avgSellNative) > 0 ? averages.avgSellNative * usdPerNative : null);

    // Padre uses its native TradingView bridge for lines
    if (usesNativeChart()) {
      // Include the market-cap equivalents: Axiom (and Padre) can chart either
      // token USD price or market cap, and the bridge matches the line level
      // to the live bar close so it lands on the visible axis.
      const nativeSupply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
        ? Number(token.mcap) / Number(token.priceUsd)
        : null;
      sendPadreMarker('paper-lines', {
        enabled: true,
        // Ground truth from the live chart ticks: draw in exactly the unit
        // the chart's Y axis is showing (price vs MC, USD vs SOL).
        axisBasis: chartAxisBasis,
        // Average-line width rides the same thickness setting as TP/SL
        // lines (settings.chartOrderLineThickness); the bridge defaults
        // averages to 1 (their old look) when absent.
        lineWidth: Math.max(1, Math.min(4, Math.round(
          Number(settings.chartOrderLineThickness) || 2))),
        currentPriceNative: token.priceNative,
        currentPriceUsd: token.priceUsd,
        // F-35's close discriminator needs the resolver's live cap to prefer
        // a cap-unit close over a price-unit one (the gmgn spec always sent
        // this; the paper spec never did, leaving that branch dead).
        currentMcap: Number(token.mcap) > 0 ? Number(token.mcap) : null,
        avgBuyUsd,
        avgSellUsd,
        avgBuyMcap: nativeSupply && avgBuyUsd ? avgBuyUsd * nativeSupply : null,
        avgSellMcap: nativeSupply && avgSellUsd ? avgSellUsd * nativeSupply : null,
        // Axiom's chart can also be SOL-denominated (its USD/SOL toggle), so
        // the SOL price and the SOL-valued market cap go along as candidates;
        // the bridge picks whichever magnitude matches the live bar close.
        avgBuyNative: Number(averages.avgBuyNative) > 0
          ? averages.avgBuyNative
          : (usdPerNative && avgBuyUsd ? avgBuyUsd / usdPerNative : null),
        avgSellNative: Number(averages.avgSellNative) > 0
          ? averages.avgSellNative
          : (usdPerNative && avgSellUsd ? avgSellUsd / usdPerNative : null),
        avgBuyMcapNative: nativeSupply && Number(averages.avgBuyNative) > 0
          ? averages.avgBuyNative * nativeSupply
          : null,
        avgSellMcapNative: nativeSupply && Number(averages.avgSellNative) > 0
          ? averages.avgSellNative * nativeSupply
          : null,
      });
    }

    if (CM && !usesNativeChart()) {
      if (site && site.id === 'gmgn') {
        // GMGN's TradingView symbol ends in `/USD/MCAP`: its Y axis is market
        // cap. Scale the USD fill prices by GMGN's live implied supply, but
        // retain the true average token price in the line label.
        const supply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
          ? Number(token.mcap) / Number(token.priceUsd)
          : null;
        // GMGN's own chart manager is available through its React-held
        // TradingView instance. Ask the MAIN-world bridge to use native
        // order lines so panning, zooming, and auto-scale stay exact.
        // The spec is sent even before the supply is known: the current*
        // fields are what let the bridge scale resolver caps onto GMGN's own
        // candle-close axis (C-08) and price queued capless fills (C-16).
        sendPadreMarker('gmgn-lines', {
          enabled: true,
          avgBuyMcap: supply && avgBuyUsd ? avgBuyUsd * supply : null,
          avgSellMcap: supply && avgSellUsd ? avgSellUsd * supply : null,
          // D-64: the SOL averages — the bridge's native-ratio lane (C-16
          // parity) prices the line when the mcap average could not be
          // computed (fresh token, no priceUsd/mcap yet).
          avgBuyNative: Number(averages.avgBuyNative) > 0 ? averages.avgBuyNative : null,
          avgSellNative: Number(averages.avgSellNative) > 0 ? averages.avgSellNative : null,
          // GMGN's axis IS market cap, so the label states the cap the line
          // sits at — the same figure the trader would quote out loud.
          avgBuyText: supply && avgBuyUsd ? `PT Avg Buy ${Q.formatMarketCap(avgBuyUsd * supply)}` : '',
          avgSellText: supply && avgSellUsd ? `PT Avg Sell ${Q.formatMarketCap(avgSellUsd * supply)}` : '',
          currentMcap: Number(token.mcap) > 0 ? Number(token.mcap) : null,
          currentPriceNative: Number(token.priceNative) > 0 ? Number(token.priceNative) : null,
          currentPriceUsd: Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null,
        });
        CM.clearAverageLines();
      } else {
        // Non-GMGN generic adapters plot USD token price, but the LABEL still
        // reads in market cap so it matches how the entry is discussed.
        const supply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
          ? Number(token.mcap) / Number(token.priceUsd)
          : null;
        CM.setAverageLines({
          avgBuyPrice: avgBuyUsd,
          avgSellPrice: avgSellUsd,
          avgBuyLabel: supply && avgBuyUsd ? avgBuyUsd * supply : avgBuyUsd,
          avgSellLabel: supply && avgSellUsd ? avgSellUsd * supply : avgSellUsd,
          currency: supply ? 'MCAP' : 'USD',
        });
      }
    }
  }

  let persistTimer = null;
  let lastWrittenState = null;
  // "seq:updatedAt" of this tab's newest write — the clone-proof identity of
  // our own state, since the storage event never hands back our object.
  let lastWrittenStamp = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (!contextAlive()) { shutdown('invalidated'); return; }
      // This writer is blind: it debounces marks and knows nothing about what
      // happened during the wait. If another tab/popup/dashboard wrote a newer
      // state in the meantime (and the adoption event was missed or is still
      // racing), writing our copy would clobber it — that is exactly how an
      // open position silently vanished. Read first; when storage is ahead,
      // adopt it and re-apply only the live marks this tab actually owns.
      const stored = await store.get([E.STORAGE_KEYS.state]);
      if (stored === null) return; // storage unreadable: never write blind
      const storedState = stored[E.STORAGE_KEYS.state];
      if (storedState && Number(storedState.seq) > Number(state.seq)) {
        adoptState(storedState);
        if (token && token.mint && Number(token.priceNative) > 0) {
          E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
        }
        for (const mint of Object.keys(livePositionPrices)) {
          const p = livePositionPrices[mint];
          if (p && Number(p.priceNative) > 0) E.markPosition(state, mint, p.priceNative, p.priceUsd);
        }
      }
      // Heartbeat persistence must never surface as a pageerror: under
      // multi-tab contention this tab simply loses this round (persistStateNow
      // throws after its CAS retries when no remutate is present). Nothing
      // unique is lost — the marks re-apply next beat. The live Trenches
      // report (5 tabs) logged 40 of these as uncaught rejections.
      await persistStateNow().catch(() => {});
    }, 800);
  }

  // Re-entrancy guard: an instant preset tap (or a double-click) while a buy
  // is still pricing must not stack a second fill on top of the first.
  let buyInFlight = false;
  // D-41: set alongside the latch for the 1 s heartbeat's stuck-latch
  // hygiene (see enableOverlay). A live buy never ages 20 s.
  let buyInFlightAt = 0;

  /** One click-time acquisition beat (D-38). A click with no quote is a BUY,
   * not a registration: the chart on screen proves the terminal's own data
   * already prices this coin, so ask every resolver source fresh — the venue
   * quotation APIs (GMGN / pump.fun) index launches the aggregators still
   * miss — and adopt the first price for THIS token right now. Identity
   * upgrades are allowed only while the token is still pending (a pair
   * stand-in resolving to its real mint); a settled token is never renamed. */
  async function acquireClickQuote(addr, chain) {
    // D-39: the row that opened this chart already carried the site's own
    // realtime price (noteRowPrice). If it is still fresh, the click adopts
    // it INSTANTLY — the chart is up, the board printed it, so no resolver
    // or RPC round trip may gate the fill. F-59: the row's tick may be keyed
    // by EITHER identity (pulse frames often key by pair); try both plus
    // the raw address before deciding the board never printed this coin.
    let data = null;
    const row = (addr && recentRowPrices.get(addr))
      || null;
    if (row && row.usd > 0 && Date.now() - row.at < ROW_PRICE_TTL_MS) {
      const rate = await R.solUsd().catch(() => 0);
      if (rate > 0) {
        data = {
          mint: addr,
          pairAddress: null,
          symbol: row.symbol || null,
          name: row.name || null,
          priceNative: row.usd / rate,
          priceUsd: row.usd,
          mcap: null,
          priceSource: 'row-feed',
          resolvedAt: Date.now(),
        };
      }
    }
    if (!data || !(Number(data.priceNative) > 0)) {
      data = await R.resolve(addr, { maxAgeMs: 0, chain });
    }
    if (!data || !(Number(data.priceNative) > 0)) {
      // D-38: the aggregators and venue APIs still do not know a one-second-
      // old coin, but its pool / bonding curve is ALREADY on chain. Probe it
      // directly (prewatch does exactly this for the panel at detection) so
      // the buy never waits on an indexer. Price is chain state.
      //
      // D-60: this used to also require `token.pending`. That flag means "the
      // panel has never had a price", but the condition guarding this block
      // is already the stronger, more direct fact: no source produced a
      // usable price for THIS click. A token whose pending flag had been
      // cleared without a live price — a resolver answering with identity
      // but no number, a coin whose feed went quiet — could therefore never
      // reach the chain at all, which is the one source that always knows.
      // The chain is the authority on price; asking it is never wrong here.
      let found = await R.onchainPrewatch({ pool: addr }).catch(() => null);
      if (!found || !(Number(found.priceNative) > 0)) {
        found = await R.onchainPrewatch({ mint: addr }).catch(() => null);
      }
      if (found && found.mint && Number(found.priceNative) > 0) {
        data = {
          mint: found.mint,
          pairAddress: found.pool || null,
          symbol: null,
          name: null,
          priceNative: Number(found.priceNative),
          priceUsd: null,
          mcap: null,
          priceSource: 'chain',
          resolvedAt: Date.now(),
        };
      }
    }
    if (!data || !(Number(data.priceNative) > 0)) return null;
    if (!token) return null;
    if (token.mint !== addr && token.srcAddress !== addr) return null;
    const freshMint = data.mint || addr;
    if (token.mint && freshMint !== token.mint) {
      if (!token.pending) return null;
      if (token.srcAddress !== token.mint && token.pairAddress && token.pairAddress !== freshMint) return null;
      token.mint = freshMint;
    }
    token.priceNative = Number(data.priceNative);
    if (data.priceUsd) token.priceUsd = Number(data.priceUsd);
    if (data.mcap) token.mcap = Number(data.mcap);
    if (data.pairAddress) token.pairAddress = data.pairAddress;
    if (data.solUsdAtResolve) token.solUsdAtResolve = data.solUsdAtResolve;
    token.priceSource = data.priceSource || 'resolver';
    token.pending = false;
    lastPriceAt = Date.now();
    if (!token.anchor) {
      token.anchor = {
        mint: token.mint, priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) || null, mcap: Number(token.mcap) || null,
      };
    }
    if (token.mint) E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
    renderBuyButton();
    renderHeader();
    renderPosition();
    return data;
  }

  /**
   * Every buy — the big BUY button or a one-click preset tap — comes through
   * here so the pending-token arming and the in-flight guard apply equally.
   * `amt` is in PANEL units: SOL normally, dollars on a foreign-chain panel.
   */
  async function requestBuy(amt) {
    if (!(amt > 0)) return toast(panelUsd() ? 'Pick a dollar amount first' : 'Pick a SOL amount first');
    if (buyInFlight) return toast('Buy already in progress…');
    // Dollar panels convert to SOL book units at the recorded rate before
    // anything else sees the amount — the engine and guardrails only ever
    // speak the book's currency.
    let solAmount = amt;
    let quotedUsd = null;
    if (panelUsd()) {
      quotedUsd = amt;
      const rate = panelUsdRate();
      if (rate) {
        solAmount = amt / rate;
      } else if (token && token.priceNative) {
        // A resolved foreign token always carries its rate (the resolver
        // refuses rateless records) — reaching here means the record is
        // malformed. Refuse; never fill at a guessed rate.
        return toast('No SOL/USD rate for this chain — paper buy refused');
      } else {
        solAmount = null; // still resolving: arm in dollars, convert at fire
      }
    }
    // Guardrails: the trader's own opt-in rules, enforced while the money is
    // fake so the habit exists before the money is real. A dollar-armed buy
    // has no SOL amount yet; flushArmedBuy re-checks at fire time.
    if (solAmount != null) {
      const guard = E.guardCheck(state, settings, { solAmount });
      if (!guard.ok) return toast(guard.message);
    }
    // Rug guard (maintainer request): when chain state says the float is in
    // a handful of wallets, say RUG WARNING and refuse, before arming.
    const rugRefusal = rugRefusalMessage();
    if (rugRefusal) return toast(rugRefusal);
    primeAudio();

    // A brand-new coin may still be resolving. Rather than refusing the
    // click — which reads as broken — arm the buy and fire it the moment a
    // trusted price lands. But first, one acquisition beat: the chart on
    // screen proves the terminal's own data already prices this coin, so a
    // fresh resolver pass (venue APIs included) may land a quote RIGHT NOW —
    // and a quoted click fills on the spot instead of arming (D-38).
    // Only where literally no source knows the price does the buy arm.
    if (!token || !token.priceNative) {
      if (!token) return toast('No token detected on this page');
      if (token.mint || token.srcAddress) {
        buyInFlight = true;
        buyInFlightAt = Date.now();
        try {
          await acquireClickQuote(token.mint || token.srcAddress, token.chain);
        } catch (_) { /* a failed acquisition beat is not a teardown */ }
        buyInFlight = false;
        if (!contextAlive()) return shutdown('invalidated');
        if (solAmount == null && quotedUsd != null) {
          const rateNow = panelUsdRate();
          if (rateNow) solAmount = quotedUsd / rateNow;
        }
        if (token && Number(token.priceNative) > 0 && solAmount != null) {
          // The guard deferred because no SOL amount existed at click time
          // now has one — enforce it before the fill, like at fire time.
          const guardNow = E.guardCheck(state, settings, { solAmount });
          if (!guardNow.ok) return toast(guardNow.message);
          buyInFlight = true;
          buyInFlightAt = Date.now();
          doBuy(solAmount, quotedUsd).finally(() => { buyInFlight = false; });
          return;
        }
      }
      armedBuy = { amount: solAmount, usd: quotedUsd, at: Date.now(), mint: token.mint, fromClick: true };
      // D-39: a click-armed buy NEVER narrates its state (no arming toast
      // of any kind) and never waits for a second source — flushArmedBuy
      // fills it on the FIRST accepted quote. The only cue is the amber
      // pulse.
      renderBuyButton();
      return;
    }
    buyInFlight = true;
    buyInFlightAt = Date.now();
    doBuy(solAmount, quotedUsd).finally(() => { buyInFlight = false; });
  }

  async function doBuy(solAmount, quotedUsd) {
    if (!token) return toast('No token detected on this page');
    // The armed path skips requestBuy, and the verdict may have landed after
    // arming — re-check at fire time. Sells are never gated.
    const rugRefusal = rugRefusalMessage();
    if (rugRefusal) return toast(rugRefusal);
    const tClick = perfNow();
    const fillQuote = await quoteForTrade();
    if (!fillQuote) return toast(lastQuoteRefusal || 'Could not obtain a fresh price — paper buy not filled.');
    const tQuoted = perfNow();
    try {
      const result = await withState(async () => {
        // The mutation, re-runnable: a commit that loses the CAS race adopts
        // the winning state and applies this fill AGAIN on that fresh base —
        // same quote, new trade object; only the attempt that actually lands
        // is ever chained, drawn, or announced.
        let filled = null;
        const mutate = () => {
          if (!token || token.mint !== fillQuote.mint) throw new Error('Token changed before the paper buy could be filled');
          const hadPosition = Boolean(state.positions[token.mint]);
          filled = E.buy(state, settings, {
            ts: Date.now(), mint: token.mint, pairAddress: token.pairAddress,
            symbol: token.symbol, name: token.name, site: site.id,
            priceNative: fillQuote.priceNative, priceUsd: fillQuote.priceUsd, mcap: fillQuote.mcap,
            ...(feeContextForOrder() || {}),
            // F-48: which source priced this fill and how old that price was
            // at commit — the receipt that turns the next wrong-price field
            // report into a journal lookup instead of a screenshot forensic.
            priceSource: fillQuote.source || null,
            priceAgeMs: fillQuote.receivedAt > 0 ? Date.now() - fillQuote.receivedAt : null,
            chain: token.chain || 'solana',
            solAmount,
            // The dollar amount the trader actually tapped on a foreign-chain
            // panel — recorded so receipts echo the order as it was placed.
            quotedUsd: quotedUsd || undefined,
          });
          filled.opened = !hadPosition;
          // F-41: claim the fill in the replay ledger BEFORE anything can
          // observe it. E.buy has already put the trade in state.journal, and
          // the commit below fires the storage listener synchronously — so an
          // unclaimed fill gets replayed by adoptState and then drawn AGAIN
          // here, as two markers with different mcap inputs (the maintainer's
          // "a bubble above and below"). A retried attempt claims its new id
          // the same way; a superseded id in the set is inert.
          drawnFillIds.add(filled.trade.id);
        };
        mutate();
        await persistStateNow(mutate);
        const { trade, position, opened } = filled;
        // The evidence chain is appended AFTER the wallet commit: a chained
        // link for a fill the CAS could still reject would be a permanent
        // book/chain divergence, whereas a crash in the gap here leaves a
        // wallet fill whose link is missing — the exact class commitFill
        // already tolerates and reports (F-28's tell-the-user-once).
        await commitFill(trade);
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'buy' });
        drawFillOnChart({
          ts: markerTs,
          fillId: trade.id,
          side: 'buy',
          priceNative: trade.priceNative,
          priceUsd: trade.priceUsd,
          mcap: trade.mcap,
          solAmount,
        });
        syncAveragePriceLines();
        if (opened) profitAlertLevels.set(token.mint, 0);
        return { trade, position, opened };
      });
      const tCommitted = perfNow();
      if (result) {
        // A committed fill is money evidence for the witness (F-47).
        lastAcceptedMarket = { priceNative: result.trade.priceNative, at: Date.now() };
        sendMessage({
          type: 'pt_trade_event',
          kind: 'buy',
          opened: result.opened,
          session: summarizeSession(result.position),
          trade: summarizeTrade(result.trade),
        }).catch(() => {});
        runTradeEffect('buy');
        playTradeSound('buy');
        // Confirm the fill in the unit the trader thinks in: "at 240K",
        // and in the currency they ordered in ("$100" on a dollar panel).
        const atMcap = mcapAtPrice(result.trade.priceNative);
        const boughtText = quotedUsd
          ? `$${E.fmt(quotedUsd, quotedUsd < 10 ? 2 : 0)}`
          : `${E.fmt(solAmount, 3)} SOL`;
        // A just-launched coin may still be symbol-less at fill time; the
        // mint shortened reads as identity, "null" reads as broken (live
        // report). Same fallback order the engine stamps on positions.
        const sym = token.symbol || (token.mint && token.mint.length > 10
          ? token.mint.slice(0, 4) + '…' + token.mint.slice(-4) : '') || '?';
        toast(`Bought ${boughtText} of ${sym}${atMcap ? ` at ${fmtMoney(atMcap)} MC` : ''} (paper)`);
        noteFillTiming('buy', tClick, tQuoted, tCommitted);
      }
    } catch (err) { toast(err.message || 'Buy failed'); }
    renderAll();
  }

  // Re-entrancy guard for sells, mirroring buyInFlight. Without it a double-tap
  // on "SELL 50%" fills twice — the second tap sells 50% of the REMAINDER, so
  // 75% total leaves the position, silently, with two success toasts.
  let sellInFlight = false;
  // D-41: set alongside the latch for the heartbeat's stuck-latch hygiene.
  let sellInFlightAt = 0;

  /* ------------- Trench: close-time derived display (GAMIFY.md) -------------
   * Streaks and grades are O(rounds)-per-call scans over up to 500 stored
   * rounds. They are computed ONLY when state actually changes shape (a close
   * here, an external close adopted, a full renderAll) — never inside the
   * per-tick render path, which is the F-18 starvation class in the ISOLATED
   * world. Renderers read the cache; the cache never writes state.
   */
  let trenchStreaks = null;
  let trenchGauntlet = null;
  let trenchRoundsKey = null;
  let gameHudStatus = null; // last session status shown, so terminal states toast once

  /** Gaming Mode (corrected semantics, maintainer 2026-08-05): the toggle
   *  governs AMBIENT gamification on the trading sites — streak chips,
   *  grade toasts, closed-card grades. It does NOT govern the dashboard
   *  (always full-featured) and it does NOT govern the HUD of a game the
   *  user explicitly STARTED from the Game tab: a started session is a
   *  request, not furniture, so its HUD rides until ended or dismissed. */
  function gamingOn() {
    return settings.gamingModeEnabled === true;
  }

  function refreshTrenchCache() {
    const G = window.PTGamify;
    if (!G) {
      trenchStreaks = null;
      trenchGauntlet = null;
      trenchRoundsKey = null;
      updateTrenchBarChip();
      updateGameHud(null);
      return;
    }
    // adoptState fires on every ~800 ms persist echo while a position's mark
    // moves — not only on closes. Streaks depend ONLY on the closed-rounds
    // list (newest-first, engine unshift), so a cheap shape key gates the
    // O(rounds²) scan: it changes exactly when a round lands, never on a
    // mark/seq-only echo. Same fingerprint discipline as D-27/D-28. The
    // active-game pointer and the ambient toggle join the key so start/end
    // and a settings flip both reflect on the next event.
    const rounds = state.rounds || [];
    const game = state.activeGame;
    const key = `${rounds.length}|${rounds[0] ? Number(rounds[0].closedAt) || 0 : 0}|${game ? `${game.id}@${game.startedAt}` : ''}|${gamingOn() ? 1 : 0}`;
    if (key === trenchRoundsKey) return;
    trenchRoundsKey = key;
    trenchStreaks = gamingOn() ? G.streaks(state) : null;
    // gauntletRun/gameSession are Date-free by contract: day-bucketed games
    // are a dashboard concern, and the overlay harness stubs Date to {now}.
    trenchGauntlet = gamingOn() && typeof G.gauntletRun === 'function' ? G.gauntletRun(state) : null;
    updateTrenchBarChip();
    updateGameHud(typeof G.gameSession === 'function' ? G.gameSession(state) : null);
  }

  const GAME_HUD_LABEL = { gauntlet: 'GAUNTLET', 'one-shot': 'ONE-SHOT', 'score-attack': 'SCORE ATTACK', season: 'SEASON', survival: 'SURVIVAL' };

  /** The on-chart game HUD: one pill, built into the shadow, text-only
   *  updates, visible ONLY while Gaming Mode is on and a session exists.
   *  Terminal states stay on screen until dismissed from the Game tab —
   *  and announce themselves exactly once. */
  function updateGameHud(session) {
    if (!els.gameHud) return;
    if (!session) {
      gameHudStatus = null;
      els.gameHud.classList.add('pt-hidden');
      els.gameHud.textContent = '';
      return;
    }
    const label = GAME_HUD_LABEL[session.id] || session.id.toUpperCase();
    const body = session.id === 'gauntlet'
      ? `${session.progress}/${session.target}`
      : session.id === 'score-attack'
        ? (session.score === null ? `${session.rounds} rounds` : `${session.score.toFixed(0)}%`)
        : session.id === 'season' || session.id === 'survival'
          ? (session.status === 'won' ? 'belt won' : `${session.progress}/${session.target}`)
          : (session.status === 'live' ? 'take the shot' : session.detail);
    const statusText = session.status === 'live' ? '' : ` · ${session.status.toUpperCase()}`;
    els.gameHud.textContent = `⚔ ${label} ${body}${statusText}`;
    els.gameHud.classList.remove('pt-hidden');
    els.gameHud.classList.toggle('pt-game-won', session.status === 'won');
    els.gameHud.classList.toggle('pt-game-bad', session.status === 'failed' || session.status === 'busted' || session.status === 'missed');
    const statusKey = `${session.id}@${session.startedAt}:${session.status}`;
    if (gameHudStatus && gameHudStatus !== statusKey && session.status !== 'live') {
      toast(`${label} ${session.status.toUpperCase()} — ${session.detail}`);
    }
    gameHudStatus = statusKey;
  }

  /** Streak chip on the positions bar: visible from 3 up — below that it is
   *  noise, not fire. Built into the bar template; textContent-only updates.
   *  Ladder (ROADMAP.md item 7): the tier glyph + count carries identity
   *  (ember → flame → blaze → torch); "n to Flame" makes the next rung
   *  visible. Tier glyphs are inline SVG (crisp, inherit currentColor). */
  const STREAK_TIER_GLYPHS = {
    ember: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6" opacity="0.55"/><circle cx="12" cy="12" r="3.2"/></svg>',
    flame: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4-3 5.5-3 9a3 3 0 0 0 6 0c0-1.4-.6-2.4-1.2-3.4C15.8 9 18 10.5 18 14a6 6 0 0 1-12 0c0-5 5-7 6-12z"/></svg>',
    blaze: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1c.8 3.2-2.4 4.4-2.4 7.2a2.4 2.4 0 0 0 4.8 0c0-1.1-.5-1.9-1-2.7C15.4 7 17 8.4 17 11a5 5 0 0 1-10 0c0-4 4-6 5-10z"/><path d="M7 13c-.6 3.4 1.6 6 5 6s5.6-2.6 5-6c2.4 1.6 4 3.8 4 6.5 0 2-1.6 3.5-3.6 3.5H6.6C4.6 23 3 21.5 3 19.5 3 16.8 4.6 14.6 7 13z" opacity="0.75"/></svg>',
    torch: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9 2h6l-1 5h3l-8 15 2-9H8l1-13z"/></svg>',
  };

  function updateTrenchBarChip() {
    if (!els.barStreak) return;
    const st = trenchStreaks;
    const parts = [];
    let titleBits = [];
    const G = window.PTGamify;
    if (st && G && G.streakLadder) {
      for (const kind of ['journal', 'cleanExit']) {
        const lad = G.streakLadder(state, kind);
        if (lad.current >= 3) {
          const glyph = lad.tier ? (STREAK_TIER_GLYPHS[lad.tier] || '') : '';
          parts.push(`${glyph}${lad.current} ${kind === 'journal' ? 'journal' : 'clean'}`);
          if (lad.tier) titleBits.push(`${lad.label} ${kind} streak (${lad.current})` + (lad.toNext ? ` — ${lad.toNext} to ${lad.next.label}` : ' — summit tier'));
        }
      }
    }
    // A Gauntlet run within reach of the summit rides the same chip.
    if (trenchGauntlet && trenchGauntlet.current >= 3) {
      parts.push(`⚔ ${trenchGauntlet.current}/10 gauntlet`);
    }
    if (!parts.length) {
      els.barStreak.classList.add('pt-hidden');
      els.barStreak.textContent = '';
      return;
    }
    els.barStreak.classList.remove('pt-hidden');
    els.barStreak.innerHTML = parts.join('<span style="opacity:.45"> · </span>');
    if (titleBits.length) els.barStreak.title = titleBits.join(' · ');
  }

  async function doSell(fraction) {
    if (!token) return toast('No token detected on this page');
    if (sellInFlight) return toast('Sell already in progress…');
    sellInFlight = true;
    sellInFlightAt = Date.now();
    try {
      await doSellInner(fraction);
    } finally {
      sellInFlight = false;
    }
  }

  async function doSellInner(fraction) {
    const tClick = perfNow();
    const fillQuote = await quoteForTrade();
    if (!fillQuote) return toast(lastQuoteRefusal || 'Could not obtain a fresh price — paper sell not filled.');
    const tQuoted = perfNow();
    try {
      const result = await withState(async () => {
        // Re-runnable mutation — see doBuy: a lost CAS race re-applies this
        // sell on the adopted base; only the landing attempt is chained.
        let filled = null;
        const mutate = () => {
          if (!token || token.mint !== fillQuote.mint) throw new Error('Token changed before the paper sell could be filled');
          filled = E.sell(state, settings, {
            ts: Date.now(), mint: token.mint, site: site.id,
            qtyFraction: fraction, priceNative: fillQuote.priceNative, priceUsd: fillQuote.priceUsd, mcap: fillQuote.mcap,
            ...(feeContextForOrder() || {}),
            // F-48: fill price provenance — see doBuy.
            priceSource: fillQuote.source || null,
            priceAgeMs: fillQuote.receivedAt > 0 ? Date.now() - fillQuote.receivedAt : null,
          });
          // F-41: claimed before the journal can be observed (see doBuy).
          drawnFillIds.add(filled.trade.id);
        };
        mutate();
        await persistStateNow(mutate);
        const { trade, position, round } = filled;
        // Chain append after the wallet commit — see doBuy for the ordering.
        await commitFill(trade);
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'sell' });
        drawFillOnChart({
          ts: markerTs,
          fillId: trade.id,
          side: 'sell',
          priceNative: trade.priceNative,
          priceUsd: trade.priceUsd,
          mcap: trade.mcap,
          solAmount: trade.solGross,
        });
        syncAveragePriceLines();
        if (round) profitAlertLevels.delete(token.mint);
        return { trade, position, round };
      });
      const tCommitted = perfNow();
      if (result) {
        // A committed fill is money evidence for the witness (F-47).
        lastAcceptedMarket = { priceNative: result.trade.priceNative, at: Date.now() };
        sendMessage({
          type: 'pt_trade_event',
          kind: 'sell',
          opened: false,
          session: summarizeSession(result.round || result.position),
          trade: summarizeTrade(result.trade),
          round: result.round ? summarizeRound(result.round) : null,
        }).catch(() => {});
        runTradeEffect('sell');
        playTradeSound('sell');
        const pnl = result.trade.pnlSol;
        const exitMcap = mcapAtPrice(result.trade.priceNative);
        // Wave 1 (F-B9): a full close speaks ONCE — sold + round result in
        // one line instead of two stacked toasts. Partial sells keep the
        // single sold line; the grade line (gaming) stays its own thought.
        if (!result.round) {
          toast(`Sold ${Math.round(fraction * 100)}%${exitMcap ? ` at ${fmtMoney(exitMcap)} MC` : ''} — ${pnl >= 0 ? '+' : ''}${E.fmt(pnl)} SOL paper`);
        } else {
          toast(`Sold ${Math.round(fraction * 100)}%${exitMcap ? ` at ${fmtMoney(exitMcap)} MC` : ''} — round closed: ${result.round.pnlSol >= 0 ? '+' : ''}${E.fmt(result.round.pnlSol)} SOL (${result.round.pnlPct.toFixed(1)}%) paper`);
          // The grade toast judges PROCESS, decoupled from P&L on purpose: a
          // disciplined red earns its praise, a lucky win gets named as luck
          // (GAMIFY.md). Plain text — toast() renders textContent only.
          // Gaming Mode only: paper-only users never hear about grades.
          const grade = gamingOn() && window.PTGamify ? window.PTGamify.roundGrade(state, result.round) : null;
          if (grade) {
            const red = result.round.pnlSol < 0;
            const flavor = grade.luckyWin
              ? 'that habit pays until it doesn’t'
              : red && (grade.letter === 'S' || grade.letter === 'A')
                ? 'that’s the job'
                : grade.parts.length ? grade.parts[0].note : 'clean process';
            toast(`${red ? 'Red round' : 'Green round'}, ${grade.letter} process — ${flavor}`);
          }
        }
        noteFillTiming('sell', tClick, tQuoted, tCommitted);
      }
    } catch (err) { toast(err.message || 'Sell failed'); }
    renderAll();
  }

  function summarizeSession(value) {
    if (!value) return null;
    return {
      sessionId: value.sessionId,
      roundId: value.id || value.roundId || null,
      mint: value.mint,
      symbol: value.symbol,
      name: value.name || token?.name || '',
      site: value.site || site?.id || 'unknown',
      openedAt: value.openedAt,
      closedAt: value.closedAt || null,
    };
  }

  function summarizeTrade(t) {
    return {
      id: t.id,
      sessionId: t.sessionId,
      ts: t.ts,
      side: t.side,
      mint: t.mint,
      symbol: t.symbol,
      site: t.site,
      pairAddress: t.pairAddress || null,
      chain: t.chain || 'solana',
      // #29: 'list-chip' marks a fill whose origin was a screener-list
      // quick-buy chip — background uses it to open the chart tab. Panel
      // buys leave this absent: their chart is already on screen.
      source: t.source || null,
      qty: t.qty,
      priceNative: t.priceNative,
      priceUsd: t.priceUsd,
      solGross: t.solGross,
      solNet: t.solNet,
      feeSol: t.feeSol,
      pnlSol: t.pnlSol,
      mcap: t.mcap,
    };
  }

  function summarizeRound(r) {
    return {
      id: r.id,
      sessionId: r.sessionId,
      mint: r.mint,
      symbol: r.symbol,
      name: r.name || '',
      site: r.site,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      heldMs: r.heldMs,
      investedSol: r.investedSol,
      returnedSol: r.returnedSol,
      pnlSol: r.pnlSol,
      pnlPct: r.pnlPct,
    };
  }

  /* -------------------- UI -------------------- */

  /* Inline SVG beats emoji: it inherits currentColor, stays crisp at any DPI,
   * and renders identically across every host site's font stack. */
  const ICONS = {
    // The PaperTrench mark. Silhouette only — the two-tone brand version needs
    // gradient <defs>, and this one renders twice in the same shadow tree
    // (positions bar and panel header), which would collide their ids. Vertices
    // are the master's, traced in brand/mark.svg.
    mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 3.19 L1 10.56 L8.74 15.68 L9.2 18.24 L13.07 20.8 Z"/></svg>',
    chart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8 13 13.7l-3-3L6.3 14.4"/></svg>',
    minimize: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    grip: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.2"/><circle cx="7.5" cy="2.5" r="1.2"/><circle cx="2.5" cy="6" r="1.2"/><circle cx="7.5" cy="6" r="1.2"/><circle cx="2.5" cy="9.5" r="1.2"/><circle cx="7.5" cy="9.5" r="1.2"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    'eye-off': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.7 0 0 1 12 19c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94m2.8-2.8A16.46 16.46 0 0 1 21.94 4.06 18.45 18.45 0 0 1 23 12s-4 8-11 8a12.92 12.92 0 0 1-6.06-1.06M1 1l22 22"/></svg>',
    resize: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15l-6 6M16 10l-9 9M3 21V3h18"/></svg>',
  };

  // Panel themes (ark_trades13's ask, 8/17: "on Lute can you change the main
  // theme of the page?"). Lute's surface is a deep indigo; the overlay's own
  // tokens are re-skinned so the panel reads as native to whichever dex the
  // user lives in — the SITE's page is never touched, only our shadow DOM.
  // Add a theme = add one entry; every token below the fold.
  const THEMES = {
    trench: null, // default — the tokens in :host above
    lute: {
      label: 'Lute — deep indigo, violet accents',
      tokens: {
        '--pt-void': '#0A0714',
        '--pt-bg': '#100B1E',
        '--pt-surface': 'rgba(28, 20, 48, 0.86)',
        '--pt-raised': 'rgba(40, 30, 66, 0.72)',
        '--pt-amber': '#A78BFA',
        '--pt-amber-soft': 'rgba(167, 139, 250, 0.16)',
        '--pt-green': '#5EEAD4',
        '--pt-green-soft': 'rgba(94, 234, 212, 0.15)',
        '--pt-red': '#FB7185',
        '--pt-red-soft': 'rgba(251, 113, 133, 0.15)',
      },
    },
    solana: {
      label: 'Solana — void green, terminal phosphor',
      tokens: {
        '--pt-void': '#04120B',
        '--pt-bg': '#071B11',
        '--pt-surface': 'rgba(10, 36, 22, 0.88)',
        '--pt-raised': 'rgba(14, 50, 30, 0.74)',
        '--pt-amber': '#14F195',
        '--pt-amber-soft': 'rgba(20, 241, 149, 0.14)',
        '--pt-green': '#14F195',
        '--pt-green-soft': 'rgba(20, 241, 149, 0.15)',
        '--pt-red': '#FF6B6B',
        '--pt-red-soft': 'rgba(255, 107, 107, 0.15)',
        '--pt-dim': '#7FB99A',
        '--pt-faint': '#4E7A62',
      },
    },
    // away32 (bug-reports 8/22 02:01): "a feature maybe to choose a style for
    // the trade panel to be like padre, axiom — literally just maybe different
    // colors". The competitors he named, as skins: token overrides only, the
    // site's page is never touched. Axiom = its signature dark slate with
    // cyan accents; Padre = its warm near-black with amber terminals. The
    // shell tokens (--pt-shell-*, --pt-rim) re-paint the panel's own body
    // and rim so a skin never renders children-on-a-trench-shell.
    axiom: {
      label: 'Axiom — dark slate, cyan accents',
      tokens: {
        '--pt-void': '#0B0F14',
        '--pt-bg': '#10161D',
        '--pt-surface': 'rgba(18, 26, 35, 0.92)',
        '--pt-raised': 'rgba(26, 37, 50, 0.78)',
        '--pt-line': 'rgba(148, 190, 220, 0.10)',
        '--pt-line-2': 'rgba(148, 190, 220, 0.18)',
        '--pt-text': '#E6EDF3',
        '--pt-amber': '#3FA9F5',
        '--pt-amber-soft': 'rgba(63, 169, 245, 0.16)',
        '--pt-green': '#2BD9C7',
        '--pt-green-soft': 'rgba(43, 217, 199, 0.15)',
        '--pt-red': '#F4586E',
        '--pt-red-soft': 'rgba(244, 88, 110, 0.15)',
        '--pt-dim': '#8CA0B3',
        '--pt-faint': '#5B6B7A',
        '--pt-shell-hi': 'rgba(18, 26, 35, 0.96)',
        '--pt-shell-lo': 'rgba(9, 13, 18, 0.97)',
        '--pt-rim': 'linear-gradient(150deg, rgba(63, 169, 245, 0.75), rgba(63, 169, 245, 0.14) 34%, rgba(255, 255, 255, 0.07) 62%, rgba(43, 217, 199, 0.42))',
      },
    },
    padre: {
      label: 'Padre — warm near-black, amber accents',
      tokens: {
        '--pt-void': '#100E0B',
        '--pt-bg': '#171410',
        '--pt-surface': 'rgba(33, 28, 21, 0.92)',
        '--pt-raised': 'rgba(46, 39, 29, 0.78)',
        '--pt-line': 'rgba(232, 190, 120, 0.10)',
        '--pt-line-2': 'rgba(232, 190, 120, 0.18)',
        '--pt-red': '#E8564F',
        '--pt-red-soft': 'rgba(232, 86, 79, 0.15)',
        '--pt-green': '#E8BE78',
        '--pt-green-soft': 'rgba(232, 190, 120, 0.15)',
        '--pt-amber': '#E8BE78',
        '--pt-amber-soft': 'rgba(232, 190, 120, 0.15)',
        '--pt-text': '#F2EDE4',
        '--pt-dim': '#A89A85',
        '--pt-faint': '#6E6353',
        '--pt-shell-hi': 'rgba(26, 22, 17, 0.96)',
        '--pt-shell-lo': 'rgba(13, 11, 9, 0.97)',
        '--pt-rim': 'linear-gradient(150deg, rgba(232, 190, 120, 0.75), rgba(232, 190, 120, 0.14) 34%, rgba(255, 255, 255, 0.07) 62%, rgba(232, 190, 120, 0.42))',
      },
    },
  };

  // One CSS block with every theme's token overrides, gated on the host's
  // data-pt-theme attribute — injected once, switches live on attribute set.
  function themeCss() {
    let css = '\n    /* Panel themes — token overrides, live-switchable via data-pt-theme */\n';
    for (const [name, t] of Object.entries(THEMES)) {
      if (!t) continue;
      css += `    :host([data-pt-theme="${name}"]) {\n`;
      for (const [token, value] of Object.entries(t.tokens)) {
        css += `      ${token}: ${value};\n`;
      }
      css += '    }\n';
    }
    return css;
  }

  // Live theme application without remount: set the attribute, the token
  // cascade does the rest. The bar and every panel live inside the shadow
  // tree, so :host([data-pt-theme]) selectors read this one attribute —
  // nothing else needs touching. Unknown/absent theme = trench default.
  function applyTheme(name) {
    const theme = THEMES[name] ? name : 'trench';
    if (host) host.setAttribute('data-pt-theme', theme);
  }

  const CSS = `
    /* ============================================================
       PaperTrench overlay — design system
       Tokens first, then components. Every number uses tabular
       figures so digits never jitter as prices tick.
       ============================================================ */
    :host {
      all: initial;
      --pt-void: #07090D;
      --pt-bg: #0B0E14;
      --pt-surface: rgba(20, 24, 32, 0.86);
      --pt-raised: rgba(30, 36, 47, 0.72);
      --pt-line: rgba(255, 255, 255, 0.07);
      --pt-line-2: rgba(255, 255, 255, 0.13);
      --pt-text: #EAEFF7;
      --pt-dim: #8D97A9;
      --pt-faint: #5A6273;
      --pt-amber: #FF9D45;
      --pt-amber-soft: rgba(255, 157, 69, 0.16);
      --pt-green: #34D399;
      --pt-green-soft: rgba(52, 211, 153, 0.15);
      --pt-red: #FF5F56;
      --pt-red-soft: rgba(255, 95, 86, 0.15);
      --pt-r-lg: 18px;
      --pt-r-md: 12px;
      --pt-r-sm: 9px;
      --pt-ease: cubic-bezier(0.16, 1, 0.3, 1);
      /* Shell gradient tokens: the panel's own body+rim, so a theme skin
         re-paints the WHOLE panel, not its children on a trench shell. */
      --pt-shell-hi: rgba(17, 21, 28, 0.96);
      --pt-shell-lo: rgba(9, 11, 16, 0.97);
      --pt-rim: linear-gradient(150deg,
        rgba(255, 157, 69, 0.75), rgba(255, 157, 69, 0.14) 34%,
        rgba(255, 255, 255, 0.07) 62%, rgba(255, 157, 69, 0.42));
      --pt-sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
      --pt-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    }

    * { box-sizing: border-box; }
    button { font-family: inherit; }

    .pt-wrap {
      font-family: var(--pt-sans);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      font-variant-numeric: tabular-nums;
    }

    /* ---------------- panel shell ---------------- */

    .pt-box {
      position: fixed; top: 84px; right: 18px; z-index: 2147483647;
      width: 336px;
      min-width: 260px; max-width: 560px;
      /* Content-sized by design (maintainer + F-C8): a saved resize acts as
         a CAP, never a stretch — no dead space, no forced scroll on a panel
         that would have fit. The viewport is always a hard ceiling. */
      max-height: min(820px, 88vh);
      color: var(--pt-text);
      background:
        radial-gradient(120% 90% at 50% -10%, var(--pt-amber-soft), transparent 62%),
        linear-gradient(180deg, var(--pt-shell-hi), var(--pt-shell-lo));
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border-radius: var(--pt-r-lg);
      box-shadow:
        0 32px 70px -18px rgba(0, 0, 0, 0.85),
        0 8px 24px -8px rgba(0, 0, 0, 0.6),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      display: flex; flex-direction: column;
      overflow: hidden;
      animation: pt-enter 0.42s var(--pt-ease) both;
    }
    /* Hairline gradient rim — the "expensive" edge. */
    .pt-box::before {
      content: ''; position: absolute; inset: 0; z-index: 4;
      border-radius: inherit; padding: 1px; pointer-events: none;
      background: var(--pt-rim);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
    }
    @keyframes pt-enter {
      from { opacity: 0; transform: translateY(-10px) scale(0.975); }
      to   { opacity: 1; transform: none; }
    }
    .pt-resize {
      position: absolute; right: 4px; bottom: 4px; z-index: 6;
      width: 18px; height: 18px;
      display: flex; align-items: flex-end; justify-content: flex-end;
      color: rgba(255, 157, 69, 0.45);
      cursor: nwse-resize; pointer-events: auto;
      transition: color 0.12s;
    }
    /* Corner grips: every corner resizes. The three extra grips are
       invisible hit areas; the panel is right/top-anchored so width always
       grows leftward from the planted right edge, and top-corner drags move
       the top offset with the clamped height so the bottom edge stays
       planted. */
    .pt-rz-tl, .pt-rz-tr, .pt-rz-bl {
      position: absolute; z-index: 6; width: 14px; height: 14px;
      pointer-events: auto; background: transparent;
    }
    .pt-rz-tl { left: 0; top: 0; cursor: nwse-resize; }
    .pt-rz-tr { right: 0; top: 0; cursor: nesw-resize; }
    .pt-rz-bl { left: 0; bottom: 0; cursor: nesw-resize; }
    .pt-flex-btn {
      margin-left: 6px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
      background: rgba(144, 168, 250, 0.14); border: 1px solid rgba(144, 168, 250, 0.35);
      color: #B9C8FF; font-size: 8.5px; font-weight: 800; letter-spacing: 0.6px;
      font-family: inherit; text-transform: uppercase;
      transition: background 0.12s;
    }
    .pt-flex-btn:hover { background: rgba(144, 168, 250, 0.26);
    }
    .pt-resize:hover { color: var(--pt-amber); }
    .pt-resize:active { color: #fff; }

    /* ---------------- Flex composer ----------------
       The share card floats HERE, centered over the page, instead of
       bouncing to a dashboard tab. Same painter, same numbers — just
       without leaving the terminal. */
    .pt-flex-modal {
      position: fixed; inset: 0; z-index: 2147483647;
      display: none; align-items: center; justify-content: center;
      background: rgba(4, 6, 10, 0.66);
      font-family: var(--pt-sans); font-size: 13px; line-height: 1.45;
      -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
      color: var(--pt-text);
    }
    .pt-flex-modal.pt-open { display: flex; }
    .pt-flex-inner {
      width: min(720px, 94vw); max-height: 92vh; overflow: auto;
      background:
        radial-gradient(120% 90% at 50% -10%, rgba(255, 157, 69, 0.08), transparent 62%),
        linear-gradient(180deg, rgba(17, 21, 28, 0.98), rgba(9, 11, 16, 0.99));
      border: 1px solid rgba(255, 157, 69, 0.28);
      border-radius: var(--pt-r-lg);
      box-shadow: 0 32px 70px -18px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      padding: 14px;
      animation: pt-enter 0.32s var(--pt-ease) both;
    }
    .pt-flex-title {
      display: flex; justify-content: space-between; align-items: center;
      margin: 0 0 10px;
      font-family: var(--pt-mono); font-size: 10px; font-weight: 700;
      letter-spacing: 1.2px; text-transform: uppercase; color: var(--pt-dim);
    }
    .pt-flex-close {
      background: none; border: none; cursor: pointer; padding: 0 2px;
      color: var(--pt-dim); font-size: 16px; line-height: 1;
    }
    .pt-flex-close:hover { color: var(--pt-text); }
    .pt-flex-canvas { width: 100%; height: auto; display: block; border-radius: var(--pt-r-md); }
    .pt-flex-gallery { display: flex; gap: 7px; overflow-x: auto; margin-top: 10px; padding-bottom: 3px; }
    .pt-flex-thumb {
      position: relative; flex: 0 0 auto; width: 82px; height: 46px; padding: 0;
      border-radius: var(--pt-r-sm); overflow: hidden; cursor: pointer;
      border: 1px solid var(--pt-line-2); background: var(--pt-bg);
      color: var(--pt-dim);
    }
    .pt-flex-thumb.pt-selected { border-color: var(--pt-amber); box-shadow: 0 0 0 1px var(--pt-amber); }
    .pt-flex-thumb canvas, .pt-flex-thumb img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .pt-flex-thumb .pt-del {
      position: absolute; top: 1px; right: 1px; width: 15px; height: 15px;
      line-height: 14px; text-align: center; border-radius: 999px;
      background: rgba(0, 0, 0, 0.62); color: var(--pt-dim); font-size: 11px;
    }
    .pt-flex-thumb .pt-del:hover { color: var(--pt-red); }
    .pt-flex-up {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; width: 100%; height: 100%; font-size: 8.5px; text-align: center;
    }
    .pt-flex-controls { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; align-items: center; }
    .pt-fbtn {
      padding: 6px 12px; border-radius: 999px; cursor: pointer;
      font-size: 10px; font-weight: 800; letter-spacing: 0.6px; text-transform: uppercase;
      border: 1px solid var(--pt-line-2); background: rgba(255, 255, 255, 0.05);
      color: var(--pt-text); transition: background 0.12s;
    }
    .pt-fbtn:hover { background: rgba(255, 255, 255, 0.10); }
    .pt-fbtn.pt-primary { background: var(--pt-amber-soft); border-color: rgba(255, 157, 69, 0.5); color: var(--pt-amber); }
    .pt-fbtn.pt-primary:hover { background: rgba(255, 157, 69, 0.28); }
    .pt-flex-custom {
      display: flex; flex-wrap: wrap; gap: 5px 13px; margin-top: 11px;
      padding: 10px 11px; border-radius: var(--pt-r-md);
      background: rgba(255, 255, 255, 0.03); border: 1px solid var(--pt-line);
      font-size: 11.5px; color: var(--pt-dim);
    }
    .pt-flex-custom.pt-hidden { display: none; }
    .pt-flex-custom label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
    .pt-accent-swatch { width: 15px; height: 15px; border-radius: 999px; border: 2px solid transparent; cursor: pointer; padding: 0; }
    .pt-accent-swatch.pt-selected { border-color: rgba(255, 255, 255, 0.85); }
    .pt-flex-msg { margin: 9px 0 0; font-size: 11px; color: var(--pt-red); }
    .pt-flex-note { margin: 9px 0 0; font-size: 10.5px; color: var(--pt-faint); line-height: 1.5; }

    /* Axiom-style focus mode: decoration out, execution controls stay.
     * Toggle is settings.panelFocusMode (Dashboard → Settings). The class
     * rides on .pt-box so every rule below scopes to the panel. */
    .pt-box.pt-focus .pt-banner,
    .pt-box.pt-focus .pt-footer,
    .pt-box.pt-focus #pt-thesis,
    .pt-box.pt-focus #pt-closed { display: none; }
    /* Community (lev): focus mode should be genuinely COMPACT — hide the
       position-detail rows (P&L + quick sell carry the signal while
       streaming) and tighten the whole panel toward the size of the site's
       own terminal. */
    .pt-box.pt-focus .pt-pos .pt-detail { display: none; }
    .pt-box.pt-focus { font-size: 12px; }
    .pt-box.pt-focus .pt-body { padding: 6px 8px 8px; }
    .pt-box.pt-focus .pt-preset { padding: 5px 4px; font-size: 11px; }
    .pt-box.pt-focus .pt-buy { padding: 9px 0; font-size: 12.5px; }
    .pt-box.pt-focus .pt-custom { font-size: 11.5px; }
    .pt-box.pt-focus .pt-sell-row button { padding: 5px 0; font-size: 11px; }
    .pt-box.pt-focus .pt-label { margin-top: 5px; font-size: 9px; }
    /* Round 2 (lev, screenshot vs Axiom's own widget): "the less information
       in the tab the better". The balance CARD goes — cash rides inline on
       the Buy label (renderPresets/renderBalance keep it fresh). The custom
       amount slims down; with one-tap presets on, the big BUY button goes
       too — the chips ARE the buttons, and Enter in the amount box buys.
       Everything that remains is a chip row, like the terminal's own widget. */
    .pt-box.pt-focus.pt-focus-instant .pt-buy { display: none; }
    /* Round 3 (toshi_100x: "small sleek simple", "less info and few
       keywords"): the header slims to the drag strip it really is — the
       subtitle line goes, the icon shrinks — and the cost chips collapse
       out of focus mode entirely: the ✎ in the header stays the editor
       entry, so nothing is lost, just not narrated. */
    .pt-box.pt-focus #pt-subtitle { display: none; }
    .pt-box.pt-focus .pt-header { padding: 7px 10px 6px; gap: 8px; }
    .pt-box.pt-focus .pt-icon { width: 18px; height: 18px; font-size: 10px; border-radius: 6px; }
    .pt-box.pt-focus .pt-title { font-size: 12px; }
    .pt-box.pt-focus .pt-costs { display: none; }
    .pt-box.pt-focus .pt-custom { margin-top: 5px; padding: 6px 9px; }
    .pt-box.pt-focus .pt-token-row { margin-bottom: 4px; }
    /* Quick reset lives in the header ONLY in focus mode (lev streams fresh
       runs per coin). Two-step inline confirm instead of a popup: first tap
       arms it for 3 s, second tap resets. */
    /* Wave 1 (F-B14): the two-tap ⟲ is the ONLY reset on the panel now, in
       every mode — the footer's standing "Reset wallet" link with a native
       confirm() was a destructive control on a trading surface. */
    #pt-quickreset { display: inline-flex; }
    #pt-quickreset.armed { color: #FF5F56; font-weight: 800; }

    /* ---------------- micro mode (away32, 8/21) ----------------
     * "very big looks like ai slop… axiom or padre looks perfect" — after
     * FOCUS mode. The third density is not focus-but-tighter; it drops the
     * panel metaphor entirely: ONE strip, token+price left, buy chips and
     * sell chips right, wallet SOL always visible. No header chrome except
     * a single ◧ that cycles density, no banner, no card, no editor, no
     * ladder, no thesis — the dashboard owns everything that is not an
     * immediate execution decision. Toggled from the same header button:
     * standard → focus → micro → standard. */
    .pt-box.pt-micro { width: max-content; min-width: 0; max-width: 92vw; }
    .pt-box.pt-micro .pt-banner,
    .pt-box.pt-micro .pt-header .pt-title,
    .pt-box.pt-micro .pt-header #pt-edit,
    .pt-box.pt-micro .pt-header #pt-quickreset,
    .pt-box.pt-micro .pt-header #pt-visibility,
    .pt-box.pt-micro .pt-header #pt-dash,
    .pt-box.pt-micro .pt-header #pt-min,
    .pt-box.pt-micro #pt-costs,
    .pt-box.pt-micro #pt-custom,
    .pt-box.pt-micro .pt-buy,
    .pt-box.pt-micro .pt-limit-row,
    .pt-box.pt-micro #pt-thesis,
    .pt-box.pt-micro #pt-closed,
    .pt-box.pt-micro .pt-editor,
    .pt-box.pt-micro .pt-footer,
    .pt-box.pt-micro .pt-pos .pt-detail,
    .pt-box.pt-micro .pt-xray,
    .pt-box.pt-micro .pt-flex { display: none; }
    .pt-box.pt-micro { font-size: 12px; border-radius: 14px; }
    .pt-box.pt-micro .pt-header { padding: 4px 6px 4px 8px; gap: 0; }
    .pt-box.pt-micro .pt-icon {
      width: 14px; height: 14px; font-size: 8px; border-radius: 4px; margin-right: 6px;
    }
    .pt-box.pt-micro .pt-header .pt-grow { flex: 1 1 auto; }
    .pt-box.pt-micro .pt-header #pt-focus-toggle { width: 20px; height: 20px; font-size: 11px; }
    .pt-box.pt-micro .pt-body { padding: 5px 8px 7px; display: flex; flex-direction: column; gap: 5px; }
    .pt-box.pt-micro .pt-token-row { margin: 0; display: flex; align-items: baseline; gap: 8px; }
    .pt-box.pt-micro #pt-token-name { font-size: 12px; font-weight: 700; max-width: 26ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pt-box.pt-micro #pt-token-mint { display: none; }
    .pt-box.pt-micro .pt-price { align-items: baseline; flex-direction: row; gap: 5px; }
    .pt-box.pt-micro #pt-price { font-size: 12.5px; }
    .pt-box.pt-micro #pt-price-usd { font-size: 10px; }
    .pt-box.pt-micro #pt-live-dot { width: 5px; height: 5px; }
    .pt-box.pt-micro .pt-micro-wallet {
      margin-left: auto; flex: none;
      font: 700 10.5px/1 var(--pt-mono); color: var(--pt-dim);
      white-space: nowrap; cursor: default;
    }
    .pt-box.pt-micro .pt-micro-wallet b { color: var(--pt-text); font-weight: 800; }
    /* Micro strips the presets down to pills and puts sell % in the SAME row:
     * buy-left, sell-right — the Axiom widget shape. */
    .pt-box.pt-micro .pt-presets { margin: 0; gap: 4px; }
    .pt-box.pt-micro .pt-preset { padding: 4px 8px; font-size: 10.5px; border-radius: 7px; }
    .pt-box.pt-micro .pt-sell-row { margin: 0; }
    .pt-box.pt-micro .pt-sell-row button { padding: 4px 7px; font-size: 10px; }
    .pt-box.pt-micro .pt-pos { margin: 0; padding: 3px 6px; }


    /* ---------------- paper banner ----------------
     * The ONE honesty cue on the panel (UI-OVERHAUL Wave 1): the diagonal
     * watermark, the "(PAPER)" button suffix and the rest of the seven
     * restatements are gone — the banner carries it, stated once, clearly.
     * The PnL-card watermark doctrine is separate and untouched. */

    .pt-banner {
      position: relative; z-index: 2;
      display: flex; align-items: center; justify-content: center; gap: 7px;
      padding: 6px 10px;
      background: linear-gradient(90deg, rgba(255, 157, 69, 0.14), rgba(255, 157, 69, 0.28), rgba(255, 157, 69, 0.14));
      border-bottom: 1px solid rgba(255, 157, 69, 0.24);
      color: #FFC790;
      font-size: 9.5px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase;
      overflow: hidden;
    }
    .pt-banner::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.16) 50%, transparent 70%);
      transform: translateX(-100%);
      animation: pt-sheen 5.5s ease-in-out infinite;
    }
    @keyframes pt-sheen {
      0%, 62% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .pt-banner b { font-weight: 900; letter-spacing: 1.6px; }

    /* ---------------- header ---------------- */

    .pt-header {
      position: relative; z-index: 2;
      display: flex; align-items: center; gap: 10px;
      padding: 11px 12px 10px;
      border-bottom: 1px solid var(--pt-line);
      cursor: grab; user-select: none;
    }
    .pt-header:active { cursor: grabbing; }
    /* The mark, not a letter. Single-colour silhouette on the panel's own
       dark surface, inked with --pt-amber so it follows the panel theme —
       the five skins exist to blend with the host dex, and a hardcoded
       orange plane would sit wrong on the Solana and Axiom palettes. The
       two-tone brand version lives on our own surfaces, where the
       background is always brand-black. */
    .pt-icon {
      width: 30px; height: 30px; border-radius: 10px; flex: none;
      display: flex; align-items: center; justify-content: center;
      color: var(--pt-amber);
      background: var(--pt-void);
      border: 1px solid var(--pt-amber-soft);
      box-shadow: 0 4px 14px rgba(255, 157, 69, 0.28);
    }
    .pt-icon svg, .pt-bar-mark svg { width: 62%; height: 62%; fill: currentColor; display: block; }
    .pt-title { font-weight: 750; font-size: 13.5px; letter-spacing: -0.15px; min-width: 0; }
    .pt-title .sub {
      display: block; margin-top: 1px;
      font-size: 10px; font-weight: 500; color: var(--pt-faint);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pt-grow { flex: 1; }
    .pt-hbtn {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0;
      background: transparent; border: 1px solid transparent; border-radius: 8px;
      color: var(--pt-faint); font-size: 13px; cursor: pointer;
      transition: background 0.16s, color 0.16s, border-color 0.16s, transform 0.16s;
    }
    .pt-hbtn:hover { background: var(--pt-raised); border-color: var(--pt-line-2); color: var(--pt-text); }
    .pt-hbtn:active { transform: scale(0.92); }

    /* Jump-flash: one pulse on the section a header button lands you on. */
    @keyframes pt-jump-flash { 0%, 100% { box-shadow: none; } 25% { box-shadow: 0 0 0 3px var(--pt-amber-soft), 0 0 18px var(--pt-amber-soft); } }
    .pt-jump-flash { animation: pt-jump-flash 1.2s var(--pt-ease) 1; border-radius: var(--pt-r-sm); }
    /* Micro keeps the three jump/skin buttons (⚑ 🔔 ◍) — away32 asked for
       them "next to the Density button", and micro is HIS density. They
       shrink to the ◧'s 20px footprint so the strip stays a strip. */
    .pt-box.pt-micro .pt-header #pt-jump-orders,
    .pt-box.pt-micro .pt-header #pt-jump-alerts,
    .pt-box.pt-micro .pt-header #pt-theme-toggle { width: 20px; height: 20px; font-size: 11px; }

    /* ---------------- body ---------------- */

    .pt-body {
      position: relative; z-index: 2; padding: 10px 12px 11px;
      flex: 1; min-height: 0; overflow-y: auto;
    }

    /* Maintainer: NEVER a visible scrollbar, anywhere in the overlay. Wheel,
       touch and drag still scroll everything below; we sit on top of someone
       else's product and a stray OS scrollbar reads as our chrome leaking.
       This was per-element and drifted — the positions rail asked for a 4px
       dark thumb and got a full-size LIGHT one across a dark bar, because
       Chrome 121+ lets the standard scrollbar-width property SUPPRESS the
       ::-webkit-scrollbar rules entirely. Declaring both is not belt and
       braces; the modern one wins and the styling is silently dropped. So the
       rule lives in one place and every scrollable surface is listed here —
       a new one that forgets to opt in is the only way this can regress. */
    .pt-body,
    .pt-bar-rail,
    .pt-flex-gallery,
    .pt-flex-inner {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .pt-body::-webkit-scrollbar,
    .pt-bar-rail::-webkit-scrollbar,
    .pt-flex-gallery::-webkit-scrollbar,
    .pt-flex-inner::-webkit-scrollbar { width: 0; height: 0; display: none; }

    .pt-token-row {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      margin-bottom: 8px;
    }
    .pt-token { flex: 1; min-width: 0; }
    .pt-token > div:first-child {
      font-size: 17px; font-weight: 800; letter-spacing: -0.3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
    .pt-mint {
      display: inline-block; margin-top: 4px; padding: 2px 7px;
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--pt-mono); font-size: 9.5px; font-weight: 500; color: var(--pt-dim);
      background: var(--pt-raised); border: 1px solid var(--pt-line);
      border-radius: 999px;
    }
    .pt-price { text-align: right; flex: none; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .pt-price .num {
      font-size: 15px; font-weight: 800; letter-spacing: -0.3px;
      font-family: var(--pt-mono);
      transition: color 0.2s;
    }
    .pt-price .usd { margin-top: 3px; font-size: 10.5px; color: var(--pt-dim); }
    .pt-price-stale { color: var(--pt-amber) !important; }

    /* Wave 2 (F-B3/F-H2): the sparkline duplicated the chart the panel
       floats over, and the 23px balance hero out-shouted the live P&L.
       Both cards are gone: cash rides the Buy label, the type-scale crown
       belongs to the position's P&L, and the live dot sits by the price. */

    /* live status dot */
    .pt-dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: var(--pt-faint); box-shadow: 0 0 0 0 transparent;
    }
    .pt-dot.on { background: var(--pt-green); animation: pt-pulse 2.1s ease-out infinite; }
    .pt-dot.warn { background: var(--pt-amber); }
    @keyframes pt-pulse {
      0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
      70% { box-shadow: 0 0 0 7px rgba(52, 211, 153, 0); }
      100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
    }

    /* ---------------- labels ---------------- */

    .pt-label {
      display: flex; align-items: center; justify-content: space-between;
      margin: 8px 0 5px;
      font-size: 9.5px; font-weight: 700; letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--pt-faint);
    }

    /* ---------------- presets ---------------- */

    .pt-presets {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px;
      padding: 4px; border-radius: var(--pt-r-md);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
    }
    .pt-preset {
      position: relative;
      padding: 8px 2px; border: 1px solid transparent; border-radius: var(--pt-r-sm);
      background: transparent; color: var(--pt-dim);
      font-size: 11.5px; font-weight: 750; text-align: center; cursor: pointer;
      transition: color 0.16s, background 0.16s, border-color 0.16s, transform 0.12s;
    }
    .pt-preset:hover { color: var(--pt-text); background: var(--pt-raised); }
    .pt-preset:active { transform: scale(0.95); }
    .pt-preset.sel {
      color: #2A1400; border-color: transparent;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber));
      box-shadow: 0 4px 14px rgba(255, 157, 69, 0.3);
    }

    /* The simulated-cost strip: fee, gas, tip, slippage at a glance, exactly
       like the terminals' own widgets — honest costs should not need a trip
       to the dashboard to be seen. Clicking it opens the inline editor. */
    .pt-costs {
      display: flex; gap: 4px; margin-top: 5px; cursor: pointer;
      font-size: 10px; color: var(--pt-faint); font-variant-numeric: tabular-nums;
    }
    .pt-costs span {
      padding: 2px 6px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.25); border: 1px solid var(--pt-line);
      white-space: nowrap;
    }
    .pt-costs:hover span { color: var(--pt-dim); border-color: var(--pt-line-2, var(--pt-line)); }

    /* Inline preset editor (lev: "on the tab for quick fixes" — the TRADING
       tab, like the pencil on the site's own widget). One compact block:
       comma lists for the two preset rows, the four cost numbers, Save. */
    .pt-editor {
      margin-top: 6px; padding: 8px; border-radius: var(--pt-r-md);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
    }
    .pt-editor .row { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
    .pt-editor .row:last-child { margin-bottom: 0; }
    .pt-editor label {
      flex: 0 0 auto; min-width: 44px; font-size: 9.5px; font-weight: 700;
      letter-spacing: 0.4px; text-transform: uppercase; color: var(--pt-faint);
    }
    .pt-editor .row.costs label { min-width: 0; }
    .pt-editor input {
      flex: 1; min-width: 0; padding: 5px 7px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.35); border: 1px solid var(--pt-line);
      color: var(--pt-text); font: 11px var(--pt-mono, monospace);
    }
    .pt-editor input:focus { outline: none; border-color: rgba(255, 157, 69, 0.55); }
    .pt-editor .actions button {
      flex: 1; padding: 6px 0; border-radius: var(--pt-r-sm); cursor: pointer;
      font-size: 11px; font-weight: 750; border: 1px solid var(--pt-line);
      background: rgba(0, 0, 0, 0.3); color: var(--pt-dim);
    }
    .pt-editor .actions #pt-edit-save {
      color: #2A1400; border-color: transparent;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber));
    }

    .pt-custom {
      width: 100%; margin-top: 7px; padding: 10px 11px;
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      border-radius: var(--pt-r-sm); color: var(--pt-text);
      font-family: var(--pt-mono); font-size: 13px; outline: none;
      transition: border-color 0.16s, box-shadow 0.16s, background 0.16s;
    }
    .pt-custom::placeholder { color: var(--pt-faint); font-family: var(--pt-sans); }
    .pt-custom:focus {
      border-color: rgba(255, 157, 69, 0.6);
      box-shadow: 0 0 0 3px rgba(255, 157, 69, 0.13);
      background: rgba(0, 0, 0, 0.45);
    }

    /* ---------------- primary action ---------------- */

    .pt-buy {
      position: relative; overflow: hidden;
      width: 100%; margin-top: 7px; padding: 11px;
      border: none; border-radius: var(--pt-r-md);
      background: linear-gradient(180deg, #3FE49B, #22B573);
      color: #032B1B; font-size: 14.5px; font-weight: 850; letter-spacing: 0.4px;
      cursor: pointer;
      box-shadow: 0 8px 22px -6px rgba(34, 181, 115, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35);
      transition: transform 0.13s var(--pt-ease), box-shadow 0.2s, filter 0.16s;
    }
    .pt-buy::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.32) 50%, transparent 65%);
      transform: translateX(-100%);
      transition: transform 0.6s var(--pt-ease);
    }
    .pt-buy:hover { filter: brightness(1.06); box-shadow: 0 12px 28px -8px rgba(34, 181, 115, 0.68), inset 0 1px 0 rgba(255, 255, 255, 0.35); }
    .pt-buy:hover::after { transform: translateX(100%); }
    .pt-buy:active { transform: translateY(1px) scale(0.988); }
    /* Armed: the click already happened, we are waiting on the first quote. */
    .pt-buy-armed {
      background: linear-gradient(180deg, #FFC081, var(--pt-amber));
      color: #2A1400;
      box-shadow: 0 8px 22px -6px rgba(255, 157, 69, 0.55), inset 0 1px 0 rgba(255,255,255,0.35);
      animation: pt-armed-pulse 1.4s ease-in-out infinite;
    }
    @keyframes pt-armed-pulse {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }

    /* ---------------- limit buys (N2) ---------------- */

    .pt-limit-row {
      display: flex; gap: 5px; margin-top: 6px;
    }
    .pt-limit-row input {
      flex: 1; min-width: 0;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-sm);
      color: var(--pt-fg); font: 500 11.5px/1.2 var(--pt-sans);
      padding: 7px 9px; outline: none;
    }
    .pt-limit-row input::placeholder { color: var(--pt-faint); font-family: var(--pt-sans); }
    .pt-limit-row input:focus { border-color: var(--pt-amber); }
    .pt-limit-row button {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-sm);
      color: var(--pt-fg); font: 700 10.5px/1 var(--pt-sans);
      letter-spacing: 0.4px; padding: 0 10px; cursor: pointer;
    }
    .pt-limit-row button:hover { background: rgba(255, 192, 129, 0.16); border-color: var(--pt-amber); }
    .pt-limit-item {
      display: flex; align-items: center; gap: 7px;
      margin-top: 5px; padding: 5px 9px;
      background: rgba(255, 192, 129, 0.07);
      border: 1px dashed rgba(255, 192, 129, 0.35); border-radius: var(--pt-r-sm);
      font: 600 11px/1.3 var(--pt-sans); color: var(--pt-fg);
    }
    .pt-limit-item small { color: var(--pt-faint); font-weight: 500; }
    .pt-limit-lv { color: var(--pt-amber); }
    .pt-limit-amt { flex: 1; }
    .pt-limit-x {
      background: none; border: none; color: var(--pt-faint);
      font: 700 13px/1 var(--pt-sans); cursor: pointer; padding: 0 2px;
    }
    .pt-limit-x:hover { color: #FF6B5E; }

    /* ---------------- position card ---------------- */

    .pt-pos {
      margin-top: 8px; padding: 9px 11px;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012));
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-md);
      animation: pt-rise 0.32s var(--pt-ease) both;
    }
    @keyframes pt-rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    .pt-pos .row {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      padding: 5px 0;
    }
    .pt-pos .row + .row { border-top: 1px solid rgba(255, 255, 255, 0.045); }
    .pt-pos .k { font-size: 11px; color: var(--pt-dim); white-space: nowrap; flex: none; }
    .pt-pos .v {
      font-weight: 700; font-family: var(--pt-mono); font-size: 12px;
      text-align: right; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pt-pos .big { font-size: 14px; font-weight: 800; }
    /* The P&L row carries three values (SOL, %, USD) and is the one number
       that must never be clipped. It gets its own full-width line so the USD
       amount cannot be cut off on the right. */
    .pt-pos .row-pnl {
      display: block; padding-top: 7px;
    }
    .pt-pos .row-pnl .k { display: block; margin-bottom: 4px; }
    .pt-pos .pnl {
      display: block; width: 100%; padding: 5px 9px; border-radius: var(--pt-r-sm);
      /* Wave 2 (F-H1/H2): the live P&L wears the type-scale crown the old
         balance hero used to — mid-trade, this IS the panel's biggest number. */
      font-size: 21px; font-weight: 850; letter-spacing: -0.5px;
      text-align: left; white-space: normal; overflow: visible;
      line-height: 1.25; font-feature-settings: "tnum";
      /* The number wraps to a second line whenever it grows (a sign flip, an
         extra digit, the USD part) and un-wraps when it shrinks — and the
         quick-sell row sits directly below, so every wrap change moved the
         buttons UNDER THE CURSOR mid-aim ("the bottom click to sell keeps
         moving when i am in profit or not" — gibsonandjustin, Twitch). The
         two-line space is reserved permanently: a stable target beats a
         compact card for the row the trader is actively clicking. */
      min-height: calc(2 * 1.25em + 10px);
    }
    /* USD sits on its own line at narrow widths rather than being truncated. */
    .pt-pos .pnl .usd-part { opacity: 0.85; }

    /* ---------------- closed P&L ---------------- */

    .pt-closed {
      margin-top: 8px; padding: 9px 11px;
      background: linear-gradient(135deg, rgba(255, 157, 69, 0.11), rgba(11, 14, 20, 0.9));
      border: 1px solid rgba(255, 157, 69, 0.4); border-radius: var(--pt-r-md);
      animation: pt-rise 0.34s var(--pt-ease) both;
    }
    .pt-closed-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .pt-closed-title {
      font-size: 9.5px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--pt-amber);
    }
    .pt-closed-badge {
      padding: 2px 7px; border-radius: 999px;
      background: rgba(255, 157, 69, 0.14); border: 1px solid rgba(255, 157, 69, 0.28);
      font-size: 8.5px; font-weight: 800; letter-spacing: 0.6px; color: #FFC790;
    }
    .pt-closed-pnl { font-size: 21px; font-weight: 850; letter-spacing: -0.6px; line-height: 1.2; }
    .pt-closed-meta { margin-top: 3px; font-size: 10px; color: var(--pt-dim); }
    /* Process grade chip (GAMIFY.md): grades judge process, never P&L. */
    .pt-grade {
      margin-right: 6px; padding: 2px 7px; border-radius: 999px;
      font-family: var(--pt-mono); font-size: 9px; font-weight: 800; letter-spacing: 0.6px;
      border: 1px solid var(--pt-line-2); color: var(--pt-dim);
    }
    .pt-grade-s { color: #C9B2FF; border-color: rgba(183, 134, 255, 0.45); }
    .pt-grade-a { color: var(--pt-green); border-color: rgba(52, 211, 153, 0.4); }
    .pt-grade-b { color: #9CC2FF; border-color: rgba(106, 169, 255, 0.4); }
    .pt-grade-c { color: var(--pt-amber); border-color: rgba(255, 157, 69, 0.4); }
    .pt-grade-d, .pt-grade-f { color: var(--pt-red); border-color: rgba(255, 95, 86, 0.4); }

    /* ---------------- take profit / stop loss ---------------- */

    .pt-order-kind { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 6px; }
    .pt-okind {
      padding: 7px 2px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.03);
      color: var(--pt-dim); font-size: 10px; font-weight: 800; letter-spacing: 0.6px;
      cursor: pointer; transition: background 0.16s, color 0.16s, border-color 0.16s;
    }
    .pt-okind:hover { background: rgba(255, 255, 255, 0.07); color: #E6EDF3; }
    /* The armed side is unmistakable: green for a target, red for a stop. */
    .pt-okind-on[data-kind="tp"] {
      border-color: rgba(63, 185, 80, 0.45); background: rgba(63, 185, 80, 0.16); color: #7EE787;
    }
    .pt-okind-on[data-kind="sl"] {
      border-color: rgba(255, 95, 86, 0.45); background: rgba(255, 95, 86, 0.16); color: #FFB3AE;
    }
    .pt-order-pcts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 5px; }
    .pt-opct {
      padding: 7px 2px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
      color: #C9D1D9; font-size: 11px; font-weight: 800; cursor: pointer;
      transition: background 0.16s, transform 0.12s;
    }
    .pt-opct:hover { background: rgba(255, 255, 255, 0.09); }
    .pt-opct:active { transform: translateY(1px); }
    .pt-order-hint {
      margin-top: 5px; font-size: 9.5px; line-height: 1.45; color: var(--pt-faint);
    }
    .pt-order-row {
      display: flex; align-items: center; gap: 6px; margin-top: 5px;
      padding: 5px 7px; border-radius: var(--pt-r-sm);
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .pt-otag { font-size: 9px; font-weight: 900; letter-spacing: 0.7px; padding: 2px 5px; border-radius: 3px; }
    .pt-otag-tp { background: rgba(63, 185, 80, 0.18); color: #7EE787; }
    .pt-otag-sl { background: rgba(255, 95, 86, 0.18); color: #FFB3AE; }
    .pt-olevel { flex: 1; font-size: 11px; font-weight: 700; color: #E6EDF3; }
    .pt-okill {
      border: 0; background: transparent; color: var(--pt-faint);
      font-size: 12px; cursor: pointer; padding: 0 2px; line-height: 1;
    }
    .pt-okill:hover { color: #FFB3AE; }
    /* Focus mode strips the panel to execution only — the ladders go, but an
       ARMED level is still shown: a hidden stop is a dangerous stop. */
    .pt-box.pt-focus .pt-orders .pt-order-kind,
    .pt-box.pt-focus .pt-orders .pt-order-pcts,
    .pt-box.pt-focus .pt-orders .pt-order-hint { display: none; }

    /* ---------------- market-cap alerts ---------------- */

    .pt-alert-arm { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 6px; }
    .pt-akind {
      padding: 7px 2px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.03);
      color: var(--pt-dim); font-size: 10px; font-weight: 800; letter-spacing: 0.6px;
      cursor: pointer; transition: background 0.16s, color 0.16s, border-color 0.16s;
    }
    .pt-akind:hover { background: rgba(255, 255, 255, 0.07); color: #E6EDF3; }
    /* Direction, not profit: an alert makes no claim about a good or bad
       outcome, so it stays neutral blue rather than borrowing TP green and
       SL red. A "below" alert is often the one you WANT to hit. */
    .pt-akind-on {
      border-color: rgba(88, 166, 255, 0.45); background: rgba(88, 166, 255, 0.16); color: #A5D6FF;
    }
    .pt-alert-entry { display: grid; grid-template-columns: 1fr auto; gap: 5px; margin-top: 5px; }
    .pt-alert-input {
      padding: 7px 8px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(0, 0, 0, 0.25); color: #E6EDF3;
      font-size: 11.5px; font-weight: 700; font-family: inherit; width: 100%;
    }
    .pt-alert-input::placeholder { color: var(--pt-faint); font-weight: 600; }
    .pt-alert-add {
      padding: 7px 12px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(88, 166, 255, 0.35);
      background: rgba(88, 166, 255, 0.14); color: #A5D6FF;
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.5px; cursor: pointer;
    }
    .pt-alert-add:hover { background: rgba(88, 166, 255, 0.22); }
    .pt-alert-hint { margin-top: 5px; font-size: 9.5px; line-height: 1.45; color: var(--pt-faint); }
    .pt-alert-row {
      display: flex; align-items: center; gap: 6px; margin-top: 5px;
      padding: 5px 7px; border-radius: var(--pt-r-sm);
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
    }
    .pt-atag {
      font-size: 9px; font-weight: 900; letter-spacing: 0.7px; padding: 2px 5px; border-radius: 3px;
      background: rgba(88, 166, 255, 0.18); color: #A5D6FF;
    }
    .pt-atag-fired { background: rgba(255, 255, 255, 0.10); color: var(--pt-faint); }
    .pt-alevel { flex: 1; font-size: 11px; font-weight: 700; color: #E6EDF3; }
    .pt-alevel-fired { color: var(--pt-faint); text-decoration: line-through; }
    .pt-akill {
      border: 0; background: transparent; color: var(--pt-faint);
      font-size: 12px; cursor: pointer; padding: 0 2px; line-height: 1;
    }
    .pt-akill:hover { color: #FFB3AE; }
    /* The compact sizes drop the market-cap alert.

       Requested for both focus and micro: at those widths the arm row, the
       entry box and the hint are three lines of furniture for a feature you
       are not using in the moment you chose the smallest panel.

       Levels ALREADY ARMED still show, in both. Same rule as an armed stop,
       and for a stronger reason here: an alert is watching whether the panel
       displays it or not, and hiding a live one leaves the trader unable to
       see or cancel something that will fire at them. The label goes with the
       controls, so an armed list does not sit under a heading for a form that
       is not there. */
    .pt-box.pt-focus .pt-alerts .pt-alert-arm,
    .pt-box.pt-focus .pt-alerts .pt-alert-entry,
    .pt-box.pt-focus .pt-alerts .pt-alert-hint,
    .pt-box.pt-focus .pt-alerts > .pt-label,
    .pt-box.pt-micro .pt-alerts .pt-alert-arm,
    .pt-box.pt-micro .pt-alerts .pt-alert-entry,
    .pt-box.pt-micro .pt-alerts .pt-alert-hint,
    .pt-box.pt-micro .pt-alerts > .pt-label { display: none; }

    /* ---------------- sell row ---------------- */

    .pt-sell-initial {
      width: 100%; margin-top: 5px; padding: 7px 8px;
      font: inherit; font-size: 11px; font-weight: 750; cursor: pointer;
      color: var(--pt-green); background: rgba(52, 211, 153, 0.10);
      border: 1px solid rgba(52, 211, 153, 0.32); border-radius: 8px;
      transition: background 120ms linear, border-color 120ms linear;
    }
    .pt-sell-initial:hover { background: rgba(52, 211, 153, 0.18); border-color: rgba(52, 211, 153, 0.5); }
    .pt-sell-initial:active { transform: scale(0.98); }
    /* Refusing, not merely unavailable — it still says why. */
    .pt-sell-initial.pt-short {
      color: var(--pt-faint); background: rgba(255, 255, 255, 0.04);
      border-color: var(--pt-line); cursor: not-allowed;
    }
    /* Round ledger — what went in, what came back, what is still held. */
    /* Micro keeps the balance. It hid #pt-buy-label with the rest of the buy
       furniture, and that label is where cash on hand lives — so the smallest
       panel was the one that never showed how much paper SOL you had, on any
       site. Trimmed rather than dropped. */
    .pt-box.pt-micro #pt-buy-label {
      font-size: 9px; margin: 0 0 3px; letter-spacing: 0.4px;
    }
    /* Compact modes keep the ledger too, at two columns rather than four. */
    .pt-box.pt-micro .pt-ledger { grid-template-columns: repeat(2, 1fr); gap: 3px; }
    .pt-box.pt-micro .pt-led { padding: 4px 5px; }
    .pt-box.pt-micro .pt-led .k { font-size: 7.5px; }
    .pt-box.pt-micro .pt-led .v { font-size: 10px; }
    .pt-box.pt-focus .pt-ledger { gap: 3px; }
    /* Direction is colour before it is text: the buy chips read green, the
       sell ladder red, so a mis-click is visible before it is a fill. */
    .pt-preset { color: var(--pt-green); }
    .pt-buy { color: var(--pt-green); }
    .pt-sell { color: var(--pt-red); }
    .pt-sell:disabled, .pt-preset:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Sell-initial sits in the same row rhythm as the ladder above it. */
    .pt-sell-initial { margin-top: 4px; padding: 5px 8px; font-size: 10px; }
    .pt-sell-initial:disabled { opacity: 0.45; cursor: not-allowed; }
    /* One box per figure, with its own border. They were four labels sharing
       a background — reported as "thrown there" with nothing separating the
       numbers, and at a glance the value of one read as the label of the next. */
    .pt-ledger {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
      margin-top: 8px;
    }
    .pt-led {
      min-width: 0; padding: 5px 6px;
      display: flex; flex-direction: column; gap: 2px;
      background: rgba(0, 0, 0, 0.26);
      border: 1px solid var(--pt-line);
      border-radius: 7px;
    }
    .pt-led .k {
      font-size: 8.5px; font-weight: 700; letter-spacing: 0.7px;
      text-transform: uppercase; color: var(--pt-faint); white-space: nowrap;
    }
    .pt-led .v {
      font-size: 11.5px; font-weight: 750; font-variant-numeric: tabular-nums;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* The bag has already returned its cost — what is left is house money. */
    .pt-ledger.pt-house { border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.07); }
    .pt-sell-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 6px; }
    .pt-sell {
      padding: 9px 2px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 95, 86, 0.32);
      background: linear-gradient(180deg, rgba(255, 95, 86, 0.19), rgba(255, 95, 86, 0.09));
      color: #FFB3AE; font-size: 11.5px; font-weight: 800; cursor: pointer;
      transition: background 0.16s, color 0.16s, transform 0.12s, box-shadow 0.18s;
    }
    .pt-sell:hover {
      background: linear-gradient(180deg, #FF6B62, #E0433A);
      color: #fff; border-color: transparent;
      box-shadow: 0 6px 18px -6px rgba(255, 95, 86, 0.6);
    }
    .pt-sell:active { transform: scale(0.95); }

    /* ---------------- footer ---------------- */

    .pt-footer {
      position: relative; z-index: 2;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid var(--pt-line);
      background: rgba(0, 0, 0, 0.28);
      font-size: 10px; color: var(--pt-faint);
    }
    .pt-footer span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pt-footer a {
      color: var(--pt-dim); cursor: pointer; text-decoration: none;
      border-bottom: 1px dotted var(--pt-line-2);
      transition: color 0.16s, border-color 0.16s;
    }
    .pt-footer a:hover { color: var(--pt-amber); border-color: var(--pt-amber); }

    /* ---------------- semantic colors ---------------- */

    .pt-green { color: var(--pt-green); }
    .pt-red { color: var(--pt-red); }
    .pt-muted { color: var(--pt-dim); }
    .pt-pos .pnl.pt-green { background: var(--pt-green-soft); }
    .pt-pos .pnl.pt-red { background: var(--pt-red-soft); }
    .pt-hidden { display: none !important; }

    /* ---------------- minimized pill ---------------- */

    .pt-minipill {
      position: fixed; top: 84px; right: 18px; z-index: 2147483647;
      display: none; align-items: center; gap: 7px;
      padding: 9px 15px; border-radius: 999px;
      background: linear-gradient(180deg, rgba(20, 24, 32, 0.95), rgba(9, 11, 16, 0.95));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 157, 69, 0.55);
      color: var(--pt-amber); font-family: var(--pt-sans);
      font-size: 11.5px; font-weight: 800; letter-spacing: 0.6px; cursor: pointer;
      box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.8);
      transition: transform 0.18s var(--pt-ease), box-shadow 0.2s, border-color 0.2s;
    }
    .pt-minipill:hover { transform: translateY(-2px); border-color: var(--pt-amber); box-shadow: 0 18px 40px -10px rgba(0, 0, 0, 0.85); }
    .pt-minipill:active { transform: scale(0.96); }

    /* ---------------- toasts ---------------- */

    .pt-toast {
      position: fixed; top: 74px; right: 18px; z-index: 2147483647;
      max-width: 320px; padding: 10px 14px;
      background: linear-gradient(180deg, rgba(24, 28, 37, 0.97), rgba(13, 16, 22, 0.97));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--pt-line-2); border-left: 3px solid var(--pt-amber);
      border-radius: var(--pt-r-md); color: var(--pt-text);
      font-size: 12px; font-weight: 600;
      box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.8);
      animation: pt-toast-in 0.34s var(--pt-ease) both;
    }
    @keyframes pt-toast-in {
      from { opacity: 0; transform: translateX(22px) scale(0.97); }
      to { opacity: 1; transform: none; }
    }

    /* ---------------- celebration effects ---------------- */

    .pt-effects { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; overflow: hidden; }
    .pt-fx-flash { position: absolute; inset: 0; animation: pt-fx-flash 0.48s ease-out forwards; }
    .pt-fx-flash.buy { background: radial-gradient(circle at 50% 45%, rgba(52, 211, 153, 0.24), rgba(255, 157, 69, 0.09) 35%, transparent 72%); }
    .pt-fx-flash.sell { background: radial-gradient(circle at 50% 45%, rgba(255, 95, 86, 0.22), rgba(255, 157, 69, 0.07) 35%, transparent 72%); }
    .pt-fx-particle {
      position: absolute; width: 8px; height: 12px; border-radius: 2px;
      opacity: 0; animation: pt-fx-particle var(--dur) cubic-bezier(0.18, 0.72, 0.35, 1) var(--delay) forwards;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    }
    @keyframes pt-fx-flash { 0% { opacity: 0; } 18% { opacity: 1; } 100% { opacity: 0; } }
    @keyframes pt-fx-particle {
      0% { opacity: 0; transform: translate(0, -20px) rotate(0deg) scale(0.7); }
      12% { opacity: 1; }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(1); }
    }

    /* ---------------- tick flash ----------------
       Colored by TOTAL position P&L, never tick direction. */
    @keyframes pt-flash-up { from { background: rgba(52, 211, 153, 0.38); } to { background: var(--pt-green-soft); } }
    @keyframes pt-flash-down { from { background: rgba(255, 95, 86, 0.38); } to { background: var(--pt-red-soft); } }
    .pt-flash-up { animation: pt-flash-up 0.45s ease-out; border-radius: 7px; }
    .pt-flash-down { animation: pt-flash-down 0.45s ease-out; border-radius: 7px; }

    /* ---------------- trade thesis ---------------- */
    .pt-thesis {
      margin-top: 8px; padding: 9px 11px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-md);
    }
    /* The collapsed thesis line: one slim, full-width, honest prompt. */
    .pt-thesis-prompt {
      display: block; width: 100%; margin-top: 8px; padding: 7px 11px;
      background: transparent; border: 1px dashed var(--pt-line-2);
      border-radius: var(--pt-r-md); cursor: pointer;
      font: inherit; font-size: 11.5px; font-weight: 650; text-align: left;
      color: var(--pt-dim);
    }
    .pt-thesis-prompt:hover { color: var(--pt-amber); border-color: var(--pt-amber); }
    .pt-thesis-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-bottom: 8px;
    }
    .pt-thesis-title {
      font-size: 9.5px; font-weight: 700; letter-spacing: 1.1px;
      text-transform: uppercase; color: var(--pt-faint);
    }
    .pt-thesis textarea {
      width: 100%; min-height: 56px; resize: vertical;
      padding: 8px 10px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      color: var(--pt-text); font-family: var(--pt-sans); font-size: 12px;
      line-height: 1.45; outline: none;
      transition: border-color 0.16s, box-shadow 0.16s;
    }
    .pt-thesis textarea::placeholder { color: var(--pt-faint); }
    .pt-thesis textarea:focus {
      border-color: rgba(255, 157, 69, 0.55);
      box-shadow: 0 0 0 3px rgba(255, 157, 69, 0.12);
    }
    .pt-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .pt-tag {
      padding: 4px 9px; border-radius: 999px;
      background: transparent; border: 1px solid var(--pt-line);
      color: var(--pt-dim); font-size: 10.5px; font-weight: 650;
      cursor: pointer; font-family: inherit;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .pt-tag:hover { color: var(--pt-text); background: var(--pt-raised); }
    .pt-tag.on {
      color: #2A1400; border-color: transparent;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber));
    }
    .pt-thesis-row { display: flex; gap: 6px; margin-top: 8px; }
    .pt-thesis-row input {
      flex: 1; min-width: 0; padding: 7px 9px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      color: var(--pt-text); font-family: var(--pt-mono); font-size: 11.5px; outline: none;
    }
    .pt-thesis-row input:focus { border-color: rgba(255, 157, 69, 0.55); }
    .pt-thesis-saved {
      font-size: 11px; color: var(--pt-dim); line-height: 1.5;
      white-space: pre-wrap; word-break: break-word;
    }
    .pt-thesis-meta { margin-top: 6px; font-size: 10px; color: var(--pt-faint); }
    .pt-thesis-edit {
      background: none; border: none; padding: 0; cursor: pointer;
      color: var(--pt-amber); font-size: 10.5px; font-weight: 650; font-family: inherit;
    }

    /* ---------------- positions bar (Padre-style) ----------------
       A fixed top rail listing every open paper position, so P&L stays
       visible while the user is looking at a different token's chart. */
    /* Floats over the page rather than reflowing it.
       Anchored to the LEFT, tucked into the empty space beside the host site's
       logo, instead of the top-right where trading UIs put their own buttons
       (wallet, settings, connect) and an overlay would sit on top of them. */
    .pt-bar {
      position: fixed; top: var(--pt-bar-top, 7px); left: var(--pt-bar-left, 210px); right: auto; z-index: 2147483645;
      max-width: min(62vw, 760px);
      display: flex; align-items: stretch; gap: 0;
      min-height: 36px; padding: 0;
      font-family: var(--pt-sans); font-size: 12px;
      color: var(--pt-text);
      background: linear-gradient(180deg, rgba(13, 16, 23, 0.94), rgba(9, 11, 16, 0.92));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 157, 69, 0.3);
      border-radius: 12px;
      box-shadow: 0 14px 34px -14px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      overflow: hidden;
      animation: pt-bar-in 0.34s var(--pt-ease) both;
    }
    @keyframes pt-bar-in {
      from { opacity: 0; transform: translateY(-12px); }
      to { opacity: 1; transform: none; }
    }
    .pt-bar.pt-hidden { display: none !important; }

    .pt-bar-grip {
      display: flex; align-items: center; justify-content: center;
      flex: none; width: 18px; padding: 0 2px;
      color: var(--pt-faint); cursor: grab; user-select: none;
      border-right: 1px solid var(--pt-line);
    }
    .pt-bar-grip:hover { color: var(--pt-amber); }
    .pt-bar-grip:active { cursor: grabbing; }
    .pt-bar-brand {
      display: flex; align-items: center; gap: 7px; flex: none;
      padding: 0 12px;
      border-right: 1px solid var(--pt-line);
      cursor: pointer; user-select: none;
    }
    .pt-bar-brand:hover { background: rgba(255, 255, 255, 0.04); }
    .pt-bar-mark {
      width: 18px; height: 18px; border-radius: 5px; flex: none;
      display: flex; align-items: center; justify-content: center;
      color: var(--pt-amber);
      background: var(--pt-void);
      border: 1px solid var(--pt-amber-soft);
    }
    .pt-bar-label {
      font-size: 9px; font-weight: 800; letter-spacing: 1.1px;
      text-transform: uppercase; color: var(--pt-amber);
      white-space: nowrap;
    }

    /* aggregate segment */
    .pt-bar-total {
      display: flex; align-items: center; gap: 9px; flex: none;
      padding: 0 13px; border-right: 1px solid var(--pt-line);
      white-space: nowrap;
    }
    .pt-bar-total .k {
      font-size: 9px; font-weight: 700; letter-spacing: 0.9px;
      text-transform: uppercase; color: var(--pt-faint);
    }
    .pt-bar-total .v {
      font-family: var(--pt-mono); font-size: 12.5px; font-weight: 800;
      letter-spacing: -0.2px;
    }
    /* Discipline streak chip (GAMIFY.md): visible from 3 up, text-only. */
    .pt-bar-streak {
      display: flex; align-items: center; flex: none;
      padding: 0 11px; border-right: 1px solid var(--pt-line);
      font-family: var(--pt-mono); font-size: 10px; font-weight: 700;
      letter-spacing: 0.3px; color: var(--pt-amber); white-space: nowrap;
    }
    .pt-bar-streak.pt-hidden { display: none; }
    /* The on-chart game HUD (Gaming Mode only): one pill, fixed by the bar
       tab, click opens the Game tab. Terminal states recolor, never animate. */
    .pt-game-hud {
      position: fixed; top: 54px; right: 14px; z-index: 2147483000;
      padding: 6px 12px; border-radius: 999px; cursor: pointer;
      background: var(--pt-raised); border: 1px solid var(--pt-amber);
      font-family: var(--pt-mono); font-size: 10.5px; font-weight: 800;
      letter-spacing: 0.4px; color: var(--pt-amber); white-space: nowrap;
    }
    .pt-game-hud.pt-hidden { display: none; }
    .pt-game-hud.pt-game-won { border-color: var(--pt-green); color: var(--pt-green); }
    .pt-game-hud.pt-game-bad { border-color: var(--pt-red); color: var(--pt-red); }

    /* Scrolling chip rail. Scrollbar hidden by the house rule above; the
       overflow affordance is the fade below, which only paints when there is
       actually something past the edge — a permanent fade would dim the last
       chip on a bar that fits, which is a lie about there being more. */
    .pt-bar-rail {
      display: flex; align-items: center; gap: 6px;
      flex: 1; min-width: 0;
      padding: 5px 10px;
      overflow-x: auto; overflow-y: hidden;
      overscroll-behavior-x: contain;
    }
    .pt-bar-rail.pt-rail-more {
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 26px), transparent 100%);
      mask-image: linear-gradient(to right, #000 calc(100% - 26px), transparent 100%);
    }
    .pt-bar-rail.pt-rail-more.pt-rail-start {
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
      mask-image: linear-gradient(to right, transparent 0, #000 26px, #000 calc(100% - 26px), transparent 100%);
    }
    .pt-bar-rail.pt-rail-end {
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 26px);
      mask-image: linear-gradient(to right, transparent 0, #000 26px);
    }

    .pt-chip {
      display: flex; align-items: center; gap: 8px; flex: none;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid var(--pt-line);
      border-radius: 999px;
      color: var(--pt-text); font-family: inherit; font-size: 11.5px;
      cursor: pointer; white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, transform 0.15s var(--pt-ease);
    }
    .pt-chip:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: var(--pt-line-2);
      transform: translateY(-1px);
    }
    .pt-chip:active { transform: translateY(0) scale(0.98); }
    /* The token whose chart is on screen right now. */
    .pt-chip.active {
      border-color: rgba(255, 157, 69, 0.65);
      background: linear-gradient(135deg, rgba(255, 157, 69, 0.18), rgba(255, 157, 69, 0.05));
      box-shadow: 0 0 0 1px rgba(255, 157, 69, 0.12);
    }
    .pt-chip-sym { font-weight: 800; letter-spacing: -0.1px; }
    .pt-chip-pnl { font-family: var(--pt-mono); font-weight: 750; }
    .pt-chip-pct { font-family: var(--pt-mono); font-size: 10.5px; opacity: 0.75; }
    /* A position with no fresh quote must look different from a live one. */
    .pt-chip.stale .pt-chip-pnl, .pt-chip.stale .pt-chip-pct { opacity: 0.5; }
    .pt-chip-dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: currentColor;
      box-shadow: 0 0 6px currentColor;
    }
    .pt-chip.stale .pt-chip-dot { box-shadow: none; opacity: 0.45; }

    .pt-bar-empty {
      display: flex; align-items: center;
      padding: 0 12px; color: var(--pt-faint); font-size: 11.5px;
    }
    .pt-bar-actions {
      display: flex; align-items: center; gap: 4px; flex: none;
      padding: 0 8px; border-left: 1px solid var(--pt-line);
    }
    .pt-bar-btn {
      display: flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; padding: 0;
      background: transparent; border: 1px solid transparent; border-radius: 7px;
      color: var(--pt-faint); font-size: 12px; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .pt-bar-btn:hover { background: var(--pt-raised); border-color: var(--pt-line-2); color: var(--pt-text); }

    /* Restore tab shown when the bar is collapsed. */
    .pt-bar-tab {
      position: fixed; top: var(--pt-bar-top, 7px); left: var(--pt-bar-left, 210px); right: auto;
      z-index: 2147483645; display: none; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: linear-gradient(180deg, rgba(13, 16, 23, 0.94), rgba(9, 11, 16, 0.92));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 157, 69, 0.42);
      border-radius: 999px;
      color: var(--pt-amber); font-family: var(--pt-sans);
      font-size: 10px; font-weight: 800; letter-spacing: 0.7px;
      cursor: pointer;
      transition: transform 0.16s var(--pt-ease), border-color 0.16s;
    }
    .pt-bar-tab:hover { transform: translateY(1px); border-color: var(--pt-amber); }

    @media (prefers-reduced-motion: reduce) {
      .pt-bar, .pt-box, .pt-pos, .pt-closed, .pt-toast { animation: none; }
      .pt-banner::after, .pt-dot.on { animation: none; }
      .pt-chip:hover { transform: none; }
      .pt-buy::after { display: none; }
    }

    /* Focus morph: one soft pulse masks the relayout when the panel
       transforms between decorated and minimal. */
    @keyframes pt-morph { from { transform: scale(0.985); opacity: 0.72; } to { transform: scale(1); opacity: 1; } }
    .pt-box.pt-morph { animation: pt-morph 0.26s var(--pt-ease); }
    .pt-hbtn.on { color: var(--pt-amber); }

    /* One movement system (UI-OVERHAUL Wave 1): every drag handle refuses
       the browser's scroll gesture — pointer capture alone never did that
       (O-25's real completion) — and every draggable surface says so with
       its cursor instead of masquerading as a plain button. */
    .pt-header, .pt-bar-grip, .pt-minipill, .pt-bar-tab,
    .pt-resize, .pt-rz-tl, .pt-rz-tr, .pt-rz-bl { touch-action: none; }
    .pt-minipill, .pt-bar-tab { cursor: grab; user-select: none; }
  `;

  /* -------------------- ONE drag system --------------------
   *
   * Panel, minimized pill, positions bar and the collapsed POSITIONS tab all
   * drag through this single helper (DEFECTS O-16..O-21, O-25, O-26):
   *
   *  - pointer events + setPointerCapture, so touch drags work (O-25);
   *  - BOTH-bounds viewport clamping DURING the drag, so the drag handle can
   *    never leave the screen and persist there (O-16 bar, O-17 panel);
   *  - Number.isFinite position parsing — `parseInt(x) || fallback` treated
   *    a legitimate 0 as "use the default", so elements jumped when
   *    re-dragged from a screen edge (O-19);
   *  - window-level fallback listeners exist only while a drag is live and
   *    are also torn down with the mount (O-26);
   *  - both elements re-clamp on window resize (O-18).
   */

  /** Pixel-string → number with Number.isFinite semantics (DEFECT O-19). */
  function finitePx(value, fallback) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // Minimum sliver of a dragged element that must stay reachable on screen.
  const DRAG_KEEP_PX = 40;

  /**
   * Clamp the panel's (and pill's) right/top so its header stays reachable.
   * When the panel's width is measurable the WHOLE panel stays on screen;
   * the old mount rescue clamped right to innerWidth-40, which parked all
   * but a 40px sliver off the LEFT edge (DEFECT O-17).
   */
  function clampPanelPos(right, top) {
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    let w = 0;
    try {
      const rect = els.box && els.box.getBoundingClientRect && els.box.getBoundingClientRect();
      w = (rect && Number(rect.width)) || 0;
    } catch (_) { /* fall through to the sliver minimum */ }
    if (!(w > 0) && Number(settings.overlayWidth) > 0) w = Number(settings.overlayWidth);
    const keep = Math.max(DRAG_KEEP_PX, Math.min(w, vw));
    return {
      right: Math.max(0, Math.min(finitePx(right, 18), vw - keep)),
      top: Math.max(0, Math.min(finitePx(top, 84), vh - 48)),
    };
  }

  /**
   * Clamp the positions bar's left/top so its grip stays reachable. The grip
   * is the bar's LEFTMOST child, so left >= 0 keeps it on screen; the old
   * lower bound (4 - width) let the grip leave the viewport entirely — and
   * the position PERSISTED, leaving the bar unrecoverable (DEFECT O-16).
   */
  function clampBarPos(left, top) {
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;
    return {
      left: Math.max(0, Math.min(finitePx(left, 210), vw - DRAG_KEEP_PX)),
      top: Math.max(0, Math.min(finitePx(top, 7), vh - 20)),
    };
  }

  /** The panel's current right/top, parsed with Number.isFinite semantics. */
  function readPanelPos() {
    let style = null;
    try { style = els.box ? window.getComputedStyle(els.box) : null; } catch (_) {}
    return {
      right: finitePx(style && style.right, 18),
      top: finitePx(style && style.top, 84),
    };
  }

  /** Apply (and clamp) the panel position; the pill mirrors it (O-20). */
  function applyPanelPos(right, top) {
    if (!els.box) return null;
    const pos = clampPanelPos(right, top);
    els.box.style.right = pos.right + 'px';
    els.box.style.top = pos.top + 'px';
    els.box.style.left = 'auto';
    if (els.pill) {
      els.pill.style.right = pos.right + 'px';
      els.pill.style.top = pos.top + 'px';
      els.pill.style.left = 'auto';
    }
    return pos;
  }

  /** Re-clamp the panel into the current viewport (window resize, O-18).
   *  A clamp that cannot MEASURE must not move anything (the O-17 lesson,
   *  finished): with the box at zero width or no viewport, any math would
   *  relocate a legitimately parked panel — including a saved 0px (O-19). */
  function reclampPanel() {
    if (!els.box) return;
    if (!(els.box.offsetWidth > 0) || !(window.innerWidth > 0)) return;
    const pos = readPanelPos();
    applyPanelPos(pos.right, pos.top);
  }

  /**
   * Wire ONE drag handle. `spec` supplies the element-specific glue:
   *   start()             position captured at pointerdown
   *   move(start, dx, dy) apply the clamped position for this delta
   *   drop()              persist the position
   *   ignore(ev)          optional: true lets the event through untouched
   * Returns { justDragged() } so a click handler on the same element can
   * tell a drop from a tap (the pill and the POSITIONS tab are buttons).
   */
  function makeDraggable(handle, spec) {
    if (!handle || !handle.addEventListener) return { justDragged: () => false };
    let dragging = false;
    let sx = 0, sy = 0;
    let start = null;
    let moved = false;
    let droppedAt = 0;

    const onMove = (e) => {
      if (!dragging || !start) return;
      const dx = (e.clientX || 0) - sx;
      const dy = (e.clientY || 0) - sy;
      // 5px, not 2 (UI-OVERHAUL Wave 1): a shaky tap on a pill must still be
      // a tap — 2px swallowed clicks for anyone whose finger wobbled.
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (e.cancelable && e.preventDefault) e.preventDefault();
      spec.move(start, dx, dy);
    };
    const unbindWindow = () => {
      try { window.removeEventListener('pointermove', onMove); } catch (_) {}
      try { window.removeEventListener('pointerup', onUp); } catch (_) {}
      try { window.removeEventListener('pointercancel', onUp); } catch (_) {}
    };
    function onUp() {
      if (!dragging) return;
      dragging = false;
      start = null;
      unbindWindow();
      if (moved) droppedAt = Date.now();
      spec.drop();
    }
    const onDown = (e) => {
      if (spec.ignore && spec.ignore(e)) return;
      if (typeof e.button === 'number' && e.button !== 0) return;
      dragging = true;
      moved = false;
      sx = e.clientX || 0;
      sy = e.clientY || 0;
      start = spec.start();
      // Pointer capture keeps move/up flowing to the handle even when the
      // pointer leaves it — and it is what makes touch drags work (O-25).
      if (e.pointerId !== undefined && typeof handle.setPointerCapture === 'function') {
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      }
      // Window-level fallback for environments where capture fails. These
      // exist only while THIS drag is live and die with the mount (O-26).
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      if (e.cancelable && e.preventDefault) e.preventDefault();
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    onMountCleanup(() => {
      dragging = false;
      start = null;
      unbindWindow();
      if (handle.removeEventListener) {
        try { handle.removeEventListener('pointerdown', onDown); } catch (_) {}
        try { handle.removeEventListener('pointermove', onMove); } catch (_) {}
        try { handle.removeEventListener('pointerup', onUp); } catch (_) {}
        try { handle.removeEventListener('pointercancel', onUp); } catch (_) {}
      }
    });

    return { justDragged: () => moved && Date.now() - droppedAt < 400 };
  }

  // Drag controllers whose justDragged() is consulted by click handlers.
  let pillDrag = null;
  let barTabDrag = null;

  function createUI() {
    // Adopt-or-replace (DEFECT O-05): a leftover #papertrench-host — an
    // earlier mount that was never torn down, or a page-authored imposter —
    // used to cause an early return that left `host` null while
    // enableOverlay kept stacking fresh timers on every settings write.
    // Remove whatever is there and rebuild from scratch.
    const existing = document.getElementById(HOST_ID);
    if (existing && existing.remove) { try { existing.remove(); } catch (_) {} }
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    applyTheme(settings.panelTheme);
    shadow.innerHTML = `
      <style>${CSS}${themeCss()}</style>
      <div class="pt-wrap">
        <div class="pt-bar pt-hidden" id="pt-bar">
          <div class="pt-bar-grip" id="pt-bar-grip" title="Drag to move">${ICONS.grip}</div>
          <div class="pt-bar-brand" id="pt-bar-brand" title="Open PaperTrench dashboard">
            <span class="pt-bar-mark">${ICONS.mark}</span>
            <span class="pt-bar-label">Paper</span>
          </div>
          <div class="pt-bar-total" id="pt-bar-total"></div>
          <div class="pt-bar-streak pt-hidden" id="pt-bar-streak" title="Discipline streaks — journal · clean exits (from 3 up)"></div>
          <div class="pt-bar-rail" id="pt-bar-rail"></div>
          <div class="pt-bar-actions">
            <button class="pt-bar-btn" id="pt-bar-hide" title="Hide positions bar">${ICONS.minimize}</button>
          </div>
        </div>
        <button class="pt-bar-tab" id="pt-bar-tab" title="Show paper positions">POSITIONS</button>
        <button class="pt-game-hud pt-hidden" id="pt-game-hud" title="Game on — click to open the Game tab"></button>
        <div class="pt-box" id="pt-box">
          <div class="pt-banner"><b>Paper Trading</b> · Simulated Funds</div>
          <div class="pt-header" id="pt-drag">
            <div class="pt-icon">${ICONS.mark}</div>
            <div class="pt-title">PaperTrench<span class="sub" id="pt-subtitle">Quick paper buy box</span></div>
            <span class="pt-grow"></span>
            <button class="pt-hbtn" id="pt-jump-orders" title="Jump to take-profit / stop-loss presets" aria-label="Jump to take-profit and stop-loss">⚑</button>
            <button class="pt-hbtn" id="pt-jump-alerts" title="Jump to the market-cap alert" aria-label="Jump to market-cap alert">🔔</button>
            <button class="pt-hbtn" id="pt-theme-toggle" title="Cycle panel theme — trench / axiom / padre / lute / solana" aria-label="Cycle panel theme">◍</button>
            <button class="pt-hbtn" id="pt-focus-toggle" title="Toggle focus mode — the minimal panel" aria-label="Toggle focus mode">◧</button>
            <button class="pt-hbtn" id="pt-edit" title="Edit presets &amp; fees right here" aria-label="Edit presets and fees">✎</button>
            <button class="pt-hbtn" id="pt-quickreset" title="Reset paper wallet (tap twice)" aria-label="Quick reset">⟲</button>
            <button class="pt-hbtn" id="pt-visibility" title="Toggle auto-hide when no token" aria-label="Toggle visibility">${ICONS.eye}</button>
            <button class="pt-hbtn" id="pt-dash" title="Open dashboard">${ICONS.chart}</button>
            <button class="pt-hbtn" id="pt-min" title="Minimize">${ICONS.minimize}</button>
          </div>
          <div class="pt-body">
            <div class="pt-token-row">
              <div class="pt-token"><div id="pt-token-name">—</div><div class="pt-mint" id="pt-token-mint">waiting for token</div></div>
              <div class="pt-price"><span class="pt-dot" id="pt-live-dot"></span><div class="num ${!token || (!token.priceNative && !token.priceUsd) ? 'pt-price-stale' : ''}" id="pt-price">—</div><div class="usd" id="pt-price-usd"></div></div>
              <div class="pt-micro-wallet" id="pt-micro-wallet" title="Paper wallet SOL — free to deploy"></div>
            </div>
            <div class="pt-label" id="pt-buy-label">Quick buy (SOL)</div>
            <div class="pt-presets" id="pt-buy-presets"></div>
            <div class="pt-costs" id="pt-costs" title="Your simulated costs — click to edit"></div>
            <div class="pt-editor" id="pt-editor" style="display:none">
              <div class="row"><label>Buy SOL</label><input id="pt-edit-buy" type="text" inputmode="decimal" placeholder="0.1, 0.5, 1, 2"></div>
              <div class="row"><label>Sell %</label><input id="pt-edit-sell" type="text" inputmode="decimal" placeholder="25, 50, 75, 100"></div>
              <div class="row costs">
                <label>Fee %</label><input id="pt-edit-fee" type="number" min="0" max="10" step="0.05">
                <label>Gas</label><input id="pt-edit-gas" type="number" min="0" max="0.5" step="0.0001">
                <label>Tip</label><input id="pt-edit-tip" type="number" min="0" max="0.5" step="0.0001">
                <label>Slip %</label><input id="pt-edit-slip" type="number" min="0" max="20" step="0.1">
              </div>
              <div class="row actions">
                <button id="pt-edit-save">Save</button>
                <button id="pt-edit-cancel">Cancel</button>
              </div>
            </div>
            <input class="pt-custom" id="pt-custom" type="number" min="0" step="0.01" placeholder="Or type a custom SOL amount…" />
            <button class="pt-buy" id="pt-buy">BUY</button>
            <!-- N2 (limit buys): one compact arm-row directly under BUY.
                 Reads as "same money, but only at my price". -->
            <div class="pt-limit-row" id="pt-limit-row">
              <input id="pt-limit-price" type="number" min="0" step="any" placeholder="Limit price (SOL)…" title="Arm a limit buy at this SOL price — fills if the price drops to it" />
              <button id="pt-limit-arm" title="Arm the limit buy with the SOL amount above">ARM ↓</button>
            </div>
            <div id="pt-limit-list"></div>
            <!-- Position sits BELOW the buy cluster on purpose (maintainer):
                 inserting it above shifted the panel so sell buttons landed
                 where BUY had been — a double-click away from an accidental
                 exit. The P&L still wears the type-scale crown; hierarchy
                 comes from size, not from moving the ground under a click. -->
            <div id="pt-position"></div>
            <!-- Alerts sit OUTSIDE the position card on purpose: the token you
                 most want a market-cap ping on is the one you have not bought
                 yet, and the position card does not exist until you have. -->
            <div id="pt-alerts"></div>
            <div id="pt-thesis"></div>
            <div id="pt-closed"></div>
          </div>
          <div class="pt-footer">
            <span id="pt-site"></span>
            <span><a id="pt-settings">Settings</a></span>
          </div>
          <div class="pt-resize" id="pt-resize" data-corner="br" title="Resize">${ICONS.resize}</div>
          <div class="pt-rz-tl" data-corner="tl" title="Resize"></div>
          <div class="pt-rz-tr" data-corner="tr" title="Resize"></div>
          <div class="pt-rz-bl" data-corner="bl" title="Resize"></div>
        </div>
        <button class="pt-minipill" id="pt-pill"><span class="pt-dot on"></span><span id="pt-pill-text">PAPER</span></button>
        <div id="pt-toast-root"></div>
        <div class="pt-effects" id="pt-effects"></div>
      </div>
    `;
    document.body.appendChild(host);

    els.box = shadow.getElementById('pt-box');
    // Restore the dragged position saved by the panel's drop handler.
    // Settings are already loaded (init awaits reloadState before
    // enableOverlay). clampPanelPos keeps a position saved on a bigger
    // monitor fully reachable on a smaller window — the old rescue clamp
    // (right ≤ innerWidth-40) left the panel almost entirely off the LEFT
    // edge of the viewport (DEFECT O-17).
    const savedRight = typeof settings.panelRight === 'number' && Number.isFinite(settings.panelRight);
    const savedTop = typeof settings.panelTop === 'number' && Number.isFinite(settings.panelTop);
    if (savedRight || savedTop) {
      applyPanelPos(savedRight ? settings.panelRight : 18, savedTop ? settings.panelTop : 84);
    }
    els.pill = shadow.getElementById('pt-pill');
    els.tokenName = shadow.getElementById('pt-token-name');
    els.tokenMint = shadow.getElementById('pt-token-mint');
    els.microWallet = shadow.getElementById('pt-micro-wallet');
    els.price = shadow.getElementById('pt-price');
    els.priceUsd = shadow.getElementById('pt-price-usd');
    els.buyPresets = shadow.getElementById('pt-buy-presets');
    els.buyLabel = shadow.getElementById('pt-buy-label');
    els.custom = shadow.getElementById('pt-custom');
    els.costs = shadow.getElementById('pt-costs');
    els.editor = shadow.getElementById('pt-editor');
    els.editBuy = shadow.getElementById('pt-edit-buy');
    els.editSell = shadow.getElementById('pt-edit-sell');
    els.editFee = shadow.getElementById('pt-edit-fee');
    els.editGas = shadow.getElementById('pt-edit-gas');
    els.editTip = shadow.getElementById('pt-edit-tip');
    els.editSlip = shadow.getElementById('pt-edit-slip');
    els.btnBuy = shadow.getElementById('pt-buy');
    els.limitPrice = shadow.getElementById('pt-limit-price');
    els.limitArm = shadow.getElementById('pt-limit-arm');
    els.limitList = shadow.getElementById('pt-limit-list');
    els.position = shadow.getElementById('pt-position');
    els.alerts = shadow.getElementById('pt-alerts');
    els.thesis = shadow.getElementById('pt-thesis');
    els.closed = shadow.getElementById('pt-closed');
    els.effects = shadow.getElementById('pt-effects');
    els.footSite = shadow.getElementById('pt-site');
    els.subtitle = shadow.getElementById('pt-subtitle');
    els.bar = shadow.getElementById('pt-bar');
    els.barGrip = shadow.getElementById('pt-bar-grip');
    els.barTotal = shadow.getElementById('pt-bar-total');
    els.barStreak = shadow.getElementById('pt-bar-streak');
    els.gameHud = shadow.getElementById('pt-game-hud');
    els.barRail = shadow.getElementById('pt-bar-rail');
    els.barTab = shadow.getElementById('pt-bar-tab');
    els.liveDot = shadow.getElementById('pt-live-dot');
    els.visibility = shadow.getElementById('pt-visibility');
    els.pillText = shadow.getElementById('pt-pill-text');
    els.resize = shadow.getElementById('pt-resize');

    bindUI();
    renderPresets();
    renderAll();
    applyOverlaySize();
  }

  function bindUI() {
    // A user gesture unlocks Web Audio so a later hidden-tab profit bell is
    // allowed to play. Creating/resuming here is silent.
    els.box.addEventListener('pointerdown', primeAudio);

    if (els.visibility) els.visibility.addEventListener('click', toggleOverlayAutoHide);
    const quickReset = shadow.getElementById('pt-quickreset');
    if (quickReset) quickReset.addEventListener('click', () => onQuickResetTap(quickReset));
    // Every corner is a resize grip (reported: "should be able to be resized
    // from all four corners").
    shadow.querySelectorAll('[data-corner]').forEach((grip) =>
      grip.addEventListener('pointerdown', (e) => onOverlayResizeStart(e, grip.dataset.corner)));
    shadow.getElementById('pt-min').addEventListener('click', () => {
      panelMinimized = true;
      setPanelVisible(true);
    });
    els.pill.addEventListener('click', () => {
      // A drop at the end of a pill drag also fires click; only a TAP
      // restores the panel (O-20).
      if (pillDrag && pillDrag.justDragged()) return;
      panelMinimized = false;
      setPanelVisible(true);
    });
    // Positions bar controls.
    const barBrand = shadow.getElementById('pt-bar-brand');
    if (barBrand) barBrand.addEventListener('click', openDashboard);
    if (els.gameHud) els.gameHud.addEventListener('click', openDashboard);
    const barHide = shadow.getElementById('pt-bar-hide');
    if (barHide) barHide.addEventListener('click', () => {
      setBarHidden(true);
    });
    // The fade has to follow the scroll, not just the render, or it keeps
    // promising more chips after the user has already reached the last one.
    // Passive: this listener never calls preventDefault, and the rail is a
    // touch-scrolled surface where a non-passive listener costs scroll latency.
    if (els.barRail) els.barRail.addEventListener('scroll', syncRailFade, { passive: true });

    if (els.barTab) els.barTab.addEventListener('click', () => {
      // Same drop-vs-tap distinction as the pill: the collapsed tab is now a
      // drag handle too (O-21), and a drop must not re-expand the bar.
      if (barTabDrag && barTabDrag.justDragged()) return;
      setBarHidden(false);
    });
    setupBarDrag();

    shadow.getElementById('pt-dash').addEventListener('click', openDashboard);
    shadow.getElementById('pt-settings').addEventListener('click', openDashboard);
    // away32 (8/22 02:01): "a button to show this [take profit stop loss]… a
    // button to show the market cap alert (next to the Density button)". The
    // sections existed but lived below the fold — the header buttons JUMP to
    // them instead of duplicating controls: one source of truth per feature,
    // and the scroll teaches where they live. Honest refusal beats a dead
    // control: with no position there is no TP/SL card to jump to.
    const jumpOrders = shadow.getElementById('pt-jump-orders');
    if (jumpOrders) {
      jumpOrders.addEventListener('click', () => {
        // TP/SL presets render inside the position card's orders section; a
        // chart without draggable lines (F-39) still arms via percentages —
        // but with no position there is no card and no honest target.
        const target = shadow.querySelector('.pt-orders');
        if (!target) {
          if (!chartOrdersOn()) toast('TP/SL is off — enable chart orders in Settings');
          else toast('No open position yet — TP/SL lives on the position card');
          return;
        }
        jumpToSection(target, 'TP/SL');
      });
    }
    const jumpAlerts = shadow.getElementById('pt-jump-alerts');
    if (jumpAlerts) {
      jumpAlerts.addEventListener('click', () => {
        const target = els.alerts && els.alerts.querySelector('.pt-alerts');
        if (!target) {
          toast('No token on this page — alerts arm per token');
          return;
        }
        jumpToSection(target, 'Alerts');
      });
    }
    // Theme cycler ◍: trench → axiom → padre → lute → solana → trench (the
    // named looks first — that is what was asked for). Same preference the
    // dashboard's select owns; cycling here never desyncs it.
    const THEME_CYCLE = ['trench', 'axiom', 'padre', 'lute', 'solana'];
    const themeToggle = shadow.getElementById('pt-theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', async () => {
        const cur = THEMES[settings.panelTheme] ? settings.panelTheme : 'trench';
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
        settings = { ...settings, panelTheme: next };
        applyTheme(next);
        const label = (THEMES[next] && THEMES[next].label) || 'Trench';
        toast('Theme — ' + label.split(' — ')[0]);
        try { await store.set({ [E.STORAGE_KEYS.settings]: settings }); } catch (_) {}
      });
    }
    // In-panel density toggle (maintainer): ◧ cycles standard → focus →
    // micro in place, with a soft pulse — no dashboard round-trip. The choice
    // persists so every surface agrees. Micro (away32 8/21: "axiom or padre
    // looks perfect") is the Axiom-shaped execution strip.
    const focusToggle = shadow.getElementById('pt-focus-toggle');
    if (focusToggle) {
      focusToggle.addEventListener('click', async () => {
        const cur = settings.panelDensity === 'micro' ? 'micro'
          : settings.panelFocusMode === true ? 'focus' : 'standard';
        const next = cur === 'standard' ? 'focus' : cur === 'focus' ? 'micro' : 'standard';
        settings = {
          ...settings,
          panelDensity: next === 'standard' ? undefined : next,
          // Keep panelFocusMode true for both compact densities so the
          // dashboard's focus toggle and any legacy read stays coherent.
          panelFocusMode: next !== 'standard',
        };
        if (els.box) {
          els.box.classList.remove('pt-morph');
          void els.box.offsetWidth; // restart the pulse (the one sanctioned reflow)
          els.box.classList.add('pt-morph');
        }
        applyFocusMode();
        renderAll();
        try { await store.set({ [E.STORAGE_KEYS.settings]: settings }); } catch (_) {}
      });
    }
    // Wave 1: the footer "Reset wallet" link is gone — the header's two-tap
    // ⟲ (formerly focus-only) is the panel's one reset in every mode.
    // Wave 1 (F-B7): the mint pill earns its pixels — click copies the mint.
    if (els.tokenMint) {
      els.tokenMint.style.cursor = 'pointer';
      els.tokenMint.title = 'Click to copy the mint address';
      els.tokenMint.addEventListener('click', () => {
        if (!token || !token.mint) return;
        try {
          navigator.clipboard.writeText(token.mint).then(
            () => toast('Mint copied'),
            () => toast('Copy failed — clipboard blocked')
          );
        } catch (_) { toast('Copy failed — clipboard blocked'); }
      });
    }
    els.btnBuy.addEventListener('click', () => {
      const custom = Number(els.custom.value);
      const sel = els.buyPresets.querySelector('.pt-preset.sel');
      // Panel units throughout — dollars on a foreign-chain panel, SOL
      // otherwise; requestBuy owns the conversion.
      const amt = custom > 0 ? custom : sel ? Number(sel.dataset.amt) : 0;
      if (!(amt > 0)) return toast(panelUsd() ? 'Pick a dollar amount first' : 'Pick a SOL amount first');
      requestBuy(amt);
    });
    // N2: limit buys — ARM uses the same amount read as BUY; Enter in the
    // price box arms too (saves the mouse trip mid-dip).
    if (els.limitArm) els.limitArm.addEventListener('click', armLimitBuy);
    if (els.limitPrice) {
      els.limitPrice.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); armLimitBuy(); }
      });
    }
    // Enter in the amount box IS the buy — in compact focus mode the big
    // button is gone (the chips are the buttons), and in normal mode this
    // just saves a mouse trip.
    els.custom.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') els.btnBuy.click();
    });
    shadow.getElementById('pt-edit').addEventListener('click', () => togglePresetEditor());
    if (els.costs) els.costs.addEventListener('click', () => togglePresetEditor(true));
    shadow.getElementById('pt-edit-save').addEventListener('click', savePresetEditor);
    shadow.getElementById('pt-edit-cancel').addEventListener('click', () => togglePresetEditor(false));

    // "Make it remember its place" (levv6x): the dragged position must
    // survive page refreshes and new tabs. Persist it on drop and restore it
    // in createUI. The header is the handle; buttons on it are exempt.
    const drag = shadow.getElementById('pt-drag');
    const persistPanelPos = () => {
      const read = readPanelPos();
      const pos = clampPanelPos(read.right, read.top);
      // O-19: a legitimate 0 persists as 0 — never snapped to the default.
      settings.panelRight = pos.right;
      settings.panelTop = pos.top;
      try {
        store.set({ [E.STORAGE_KEYS.settings]: settings });
      } catch (_) {}
    };
    const panelSpec = {
      start: readPanelPos,
      move: (start, dx, dy) => applyPanelPos(start.right - dx, start.top + dy),
      drop: persistPanelPos,
    };
    makeDraggable(drag, {
      ...panelSpec,
      ignore: (e) => Boolean(e.target && e.target.closest && e.target.closest('button')),
    });
    // O-20: the minimized pill shares the panel's position and is a drag
    // handle itself — dragging it moves (and persists) the shared spot.
    pillDrag = makeDraggable(els.pill, panelSpec);
  }

  /** Let the user drag the positions bar (and its collapsed tab) anywhere. */
  function setupBarDrag() {
    const readBarPos = () => clampBarPos(
      typeof barPos.left === 'number' ? barPos.left : settings.positionsBarLeft,
      typeof barPos.top === 'number' ? barPos.top : settings.positionsBarTop
    );
    const persistBarPos = () => {
      const pos = readBarPos();
      settings.positionsBarLeft = pos.left;
      settings.positionsBarTop = pos.top;
      try {
        store.set({ [E.STORAGE_KEYS.settings]: settings });
      } catch (_) {}
    };
    const barSpec = {
      start: readBarPos,
      move: (start, dx, dy) => {
        const pos = clampBarPos(start.left + dx, start.top + dy);
        setBarPosition(pos.left, pos.top);
      },
      drop: persistBarPos,
    };
    if (els.barGrip) makeDraggable(els.barGrip, barSpec);
    // O-21: while the bar is collapsed its grip is not on screen — the
    // restore tab is all there is, so the tab itself is a drag handle. It
    // mirrors the same --pt-bar-* variables, so one position serves both.
    if (els.barTab) barTabDrag = makeDraggable(els.barTab, barSpec);
  }

  function openDashboard() { sendMessage({ type: 'pt_open_dashboard' }); }

  /**
   * Collapse or expand the positions bar and REMEMBER it. Persisting the
   * choice is what stops the bar from "following" a user who already hid it:
   * every new page and tab starts from the saved state.
   */
  function setBarHidden(hidden) {
    positionsBarHidden = hidden;
    settings = { ...settings, positionsBarHidden: hidden };
    store.set({ [E.STORAGE_KEYS.settings]: settings });
    renderPositionsBar();
  }

  /* ---------------- keyboard shortcuts ----------------
   *
   * Three bindings, and every one of them only moves PaperTrench's own
   * furniture: show the panel, show the positions bar, put the cursor in the
   * amount box. Deliberately nothing that trades and nothing that touches a
   * tab — a keystroke that fires an order is a keystroke that fires one by
   * accident, and opening or closing tabs from a key is exactly what this was
   * asked to stay away from.
   *
   * Off by default. Two schemes rather than a rebinding UI: these run on other
   * people's sites, where every plain key and most single-modifier combos are
   * already spoken for, so the choice that matters is which modifier is free
   * on the terminal you use — not which letter.
   */
  const SHORTCUT_SCHEMES = {
    alt: (e) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey,
    ctrlshift: (e) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey,
  };

  function onShortcutKey(event) {
    const test = SHORTCUT_SCHEMES[settings && settings.shortcutScheme];
    if (!test || masterOff || settings.overlayEnabled === false) return;
    if (event.repeat || !test(event)) return;

    // Never steal a key from something being typed into — the host site's
    // search box, a comment field, or our own amount input.
    const target = event.composedPath ? event.composedPath()[0] : event.target;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || '')
      || target.isContentEditable)) return;

    const key = String(event.key || '').toLowerCase();
    if (key === 'p') {
      panelMinimized = !panelMinimized;
      setPanelVisible(true);
    } else if (key === 'b') {
      setBarHidden(!positionsBarHidden);
    } else if (key === 'a') {
      panelMinimized = false;
      setPanelVisible(true);
      // The amount box is optional now, so this key falls through to the
      // first preset rather than becoming a key that does nothing.
      if (els.custom && els.custom.offsetParent !== null) {
        els.custom.focus();
        els.custom.select();
      } else {
        const first = els.buyPresets && els.buyPresets.querySelector('.pt-preset');
        if (!first) return;
        first.focus();
      }
    } else return;

    // Claimed only once we know we acted, so an unbound combo still reaches
    // whatever the site wanted it for.
    event.preventDefault();
    event.stopPropagation();
  }

  window.addEventListener('keydown', onShortcutKey, true);

  function renderPresets() {
    // Two user toggles strip the buy controls back: the preset row can be
    // hidden on its own, or the whole buy section (label, presets, custom
    // amount, BUY button) for a view-only trade tab. Hidden, not removed —
    // flipping either switch back on restores everything as it was.
    const sectionOn = settings.panelBuyEnabled !== false;
    const presetsOn = sectionOn && settings.panelPresetsEnabled !== false;
    if (els.buyLabel) els.buyLabel.style.display = sectionOn ? '' : 'none';
    // The free-text amount box is off by default now. It was three lines of
    // panel for a field the preset row already covers: those became eight
    // configurable boxes, so an arbitrary size is a setting away rather than
    // a permanent tax on every panel. Hidden, never removed — BUY and the
    // limit-arm both read it and both already fall back to the selected
    // preset when it is empty, so nothing downstream has to know.
    const customOn = sectionOn && settings.panelCustomAmount === true;
    if (els.custom) els.custom.style.display = customOn ? '' : 'none';
    if (els.btnBuy) els.btnBuy.style.display = sectionOn ? '' : 'none';
    if (els.buyPresets) els.buyPresets.style.display = presetsOn ? '' : 'none';

    // Chips carry PANEL units: SOL on Solana, dollars on foreign chains
    // (requestBuy converts at the recorded rate).
    const usdMode = panelUsd();
    const list = usdMode
      ? (settings.presetsBuyUsd || USD_PRESETS_DEFAULT)
      : (settings.presetsBuy || [0.1, 0.5, 1, 2]);
    const instant = settings.instantBuyEnabled !== false;
    if (sectionOn && els.buyLabel) els.buyLabel.textContent = buyLabelText();
    renderCosts();
    if (!presetsOn) return;
    // Wave 1: in instant mode a chip IS an order button — pre-highlighting
    // one the user never chose made "selected" and "tap = buy" conflicting
    // claims on the same pixel. Selection exists only in two-step mode.
    els.buyPresets.innerHTML = list.map((a, i) =>
      `<button class="pt-preset${!instant && i === 1 ? ' sel' : ''}" data-amt="${a}" title="${instant ? 'Buy this amount instantly' : 'Select this amount'}">${usdMode ? `$${a}` : `${a} SOL`}</button>`
    ).join('');
    els.buyPresets.querySelectorAll('.pt-preset').forEach((b) => {
      b.addEventListener('click', () => {
        els.buyPresets.querySelectorAll('.pt-preset').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel'); els.custom.value = '';
        // One-click quick buy: the tap IS the order, like Axiom and Padre.
        if (instant) requestBuy(Number(b.dataset.amt));
      });
    });
  }

  /** Micro-mode wallet readout (away32 8/21): idle SOL always visible on the
   *  strip — "overlay sol balance at the top without needing to open the
   *  ext". Locked limit-buy SOL is shown separately so the number can be
   *  trusted as deployable, never confused with the total. */
  function renderMicroWallet() {
    if (!els.microWallet) return;
    const micro = settings.panelDensity === 'micro';
    els.microWallet.style.display = micro ? '' : 'none';
    if (!micro || !state) return;
    // textContent only — no amount is ever markup.
    const locked = E.lockedBuySol(state);
    els.microWallet.textContent = '';
    const b = document.createElement('b');
    b.textContent = `${E.fmt(state.cashSol, 2)} ◎`;
    els.microWallet.appendChild(b);
    if (locked > 0) {
      const l = document.createElement('span');
      l.textContent = ` +${E.fmt(locked, 2)} armed`;
      els.microWallet.appendChild(l);
    }
  }

  /* ---------------- panel denomination ----------------
   * Foreign-chain panels denominate in DOLLARS. Read off the live site
   * (2026-08-05): fomo's own quick buys on a BNB token are $10/$100/$500/
   * $1000 with a $-prefixed amount box — the venue prices every non-Solana
   * chain in USD, so the paper panel speaks the same currency there.
   * Solana panels keep SOL: the book's own currency, and what the Solana
   * terminals themselves denominate in. Conversion to SOL book units
   * happens at order time at the token's RECORDED rate (solUsdAtResolve,
   * refreshed with every quote) — never a guessed rate, and no rate means
   * an honest refusal instead of a fill. */
  const USD_PRESETS_DEFAULT = [10, 100, 500, 1000];

  function panelUsd() {
    return Boolean(token && token.chain && token.chain !== 'solana');
  }

  function panelUsdRate() {
    const rate = Number(token && token.solUsdAtResolve);
    return rate > 0 ? rate : null;
  }

  /** The fee context an order carries so the engine can charge pump.fun's
   * real tiered schedule instead of the flat setting.
   *
   * Everything here comes from signals the resolver ALREADY establishes; no
   * new plumbing and nothing guessed:
   *
   *   graduated    — `token.pumpCurve` is true only while the coin sits on a
   *                  live pump bonding curve (poolKind 'pump-curve'; the feed
   *                  refuses a completed curve outright). A pump coin that is
   *                  NOT on a live curve has graduated to PumpSwap. Non-pump
   *                  venues are not pump.fun coins at all, so we stay silent
   *                  rather than claim a schedule that does not apply.
   *   canonical    — a graduated pump.fun coin trades in its canonical
   *                  PumpSwap pool, which is what findGraduatedPool locates.
   *   marketCapSol — the tier lookup is denominated in SOL but `token.mcap` is
   *                  USD. Converting needs the RECORDED rate
   *                  (solUsdAtResolve), never a guessed one. No rate means no
   *                  market cap, and fees.js then charges the most expensive
   *                  tier rather than flattering the trade.
   *
   * Returns null when the coin is not identifiably a pump.fun coin — the
   * engine then falls back to settings.feeBps exactly as before. */
  function feeContextForOrder() {
    if (!token) return null;
    // Only pump.fun coins follow this schedule. `pumpCurve` is set from the
    // chain's own pool classification, so an undefined value means the
    // resolver never reached the chain and we know nothing.
    if (token.pumpCurve === undefined || token.pumpCurve === null) return null;
    if (token.kind !== 'pump' && !String(token.mint || '').endsWith('pump')) return null;

    const graduated = token.pumpCurve !== true;
    const ctx = { graduated };
    if (graduated) {
      ctx.canonical = true;
      const rate = Number(token.solUsdAtResolve);
      const mcapUsd = Number(token.mcap);
      if (rate > 0 && mcapUsd > 0) ctx.marketCapSol = mcapUsd / rate;
    }
    return ctx;
  }

  /** The Buy label doubles as the balance line in compact focus mode — the
   * balance card is hidden there ("the less information in the tab the
   * better"), but cash on hand is execution information, not decoration. */
  function buyLabelText() {
    // Wave 2 (F-B6/F-H2): the balance CARD is gone — cash rides here in
    // every mode, and the label stops narrating what the chips already say.
    if (panelUsd()) {
      const rate = panelUsdRate();
      // Cash converted at the recorded rate, so the number is spendable
      // truth: $1000 shown means a $1000 preset fills.
      return rate ? `Buy ($) · $${E.fmt(state.cashSol * rate, 0)} cash` : 'Buy ($)';
    }
    return `Buy (SOL) · ${E.fmt(state.cashSol, 2)} cash`;
  }

  /** The simulated-cost strip under the presets: fee, gas, tip, slippage at
   * a glance, like the terminals' own widgets. Clicking it opens the inline
   * editor — these are the numbers people re-tune mid-session. */
  function renderCosts() {
    if (!els.costs) return;
    if (settings.panelBuyEnabled === false) { els.costs.style.display = 'none'; return; }
    els.costs.style.display = '';
    const feePct = (Number(settings.feeBps) || 0) / 100;
    const slipPct = (Number(settings.slippageBps) || 0) / 100;
    // Wave 1: only costs that EXIST get a chip — "Gas 0 · Tip 0 · Slip 0%"
    // was three no-op chips narrating settings forever. The full set always
    // lives in the ✎ editor; an all-zero setup shows one honest word.
    const chips = [];
    if (feePct > 0) chips.push(`Fee ${feePct}%`);
    if (Number(settings.gasSolPerTx) > 0) chips.push(`Gas ${settings.gasSolPerTx}`);
    if (Number(settings.tipSolPerTx) > 0) chips.push(`Tip ${settings.tipSolPerTx}`);
    if (slipPct > 0) chips.push(`Slip ${slipPct}%`);
    if (!chips.length) chips.push('No costs set');
    els.costs.innerHTML = chips.map((c) => `<span>${c}</span>`).join('');
  }

  /* -------------------- inline preset editor --------------------
   * lev, round two: "when i asked for this i didn't mean these to be added
   * in the extension but in the trading tab itself" — the pencil on the
   * panel header (and the cost strip) opens this. Same settings keys and
   * the SAME validation rules as the dashboard and popup (Q.parsePresetList
   * is the single source): a bad value keeps the saved value and says so. */

  function togglePresetEditor(force) {
    if (!els.editor) return;
    const open = force === undefined ? els.editor.style.display === 'none' : Boolean(force);
    if (open) {
      // The buy row edits the list the panel is SHOWING: dollar presets on
      // a foreign-chain panel, SOL presets otherwise.
      els.editBuy.value = (panelUsd()
        ? (settings.presetsBuyUsd || USD_PRESETS_DEFAULT)
        : (settings.presetsBuy || [0.1, 0.5, 1, 2])).join(', ');
      els.editSell.value = (settings.sellPcts || [25, 50, 75, 100]).join(', ');
      els.editFee.value = (Number(settings.feeBps) || 0) / 100;
      els.editGas.value = Number(settings.gasSolPerTx) > 0 ? settings.gasSolPerTx : '';
      els.editTip.value = Number(settings.tipSolPerTx) > 0 ? settings.tipSolPerTx : '';
      els.editSlip.value = (Number(settings.slippageBps) || 0) / 100;
    }
    els.editor.style.display = open ? '' : 'none';
  }

  async function savePresetEditor() {
    const notes = [];
    const patch = {};

    // Same row, two ledgers: dollar presets on foreign-chain panels (cap
    // $100k), SOL presets otherwise (cap 1000) — each saved to its own key
    // so switching chains never rewrites the other currency's list.
    const usdMode = panelUsd();
    const buyCap = usdMode ? 100000 : 1000;
    const buy = Q.parsePresetList(els.editBuy.value, buyCap);
    if (buy && buy.values.length) {
      patch[usdMode ? 'presetsBuyUsd' : 'presetsBuy'] = buy.values;
      if (buy.dropped > 0) notes.push(`${buy.dropped} buy preset(s) rejected (each must be > 0 and ≤ ${buyCap}, max 8)`);
    } else if (buy) {
      notes.push('buy presets: no valid entries — kept the saved list');
    }
    const sell = Q.parsePresetList(els.editSell.value, 100, { dedupe: true });
    if (sell && sell.values.length) {
      patch.sellPcts = sell.values;
      if (sell.dropped > 0) notes.push(`${sell.dropped} sell preset(s) rejected (1–100, no repeats, max 8)`);
    } else if (sell) {
      notes.push('sell presets: no valid entries — kept the saved list');
    }

    // Costs enter as the % the site UIs show; stored as bps like everywhere
    // else. Bounds mirror the dashboard exactly (D-11/D-23).
    const feePct = Number(els.editFee.value);
    if (String(els.editFee.value).trim() !== '' && Number.isFinite(feePct) && feePct >= 0) {
      patch.feeBps = Math.min(1000, Math.max(0, Math.round(feePct * 100)));
    }
    const gas = Number(els.editGas.value);
    patch.gasSolPerTx = Number.isFinite(gas) && gas > 0 ? Math.min(gas, 0.5) : 0;
    const tip = Number(els.editTip.value);
    patch.tipSolPerTx = Number.isFinite(tip) && tip > 0 ? Math.min(tip, 0.5) : 0;
    const slipPct = Number(els.editSlip.value);
    if (String(els.editSlip.value).trim() !== '' && Number.isFinite(slipPct) && slipPct >= 0) {
      patch.slippageBps = Math.min(2000, Math.max(0, Math.round(slipPct * 100)));
    }

    settings = { ...settings, ...patch };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
    // The sell row is built into the position card at mount; rebuild it so
    // new percents appear immediately, not on the next token switch.
    if (els.position) els.position.textContent = '';
    posEls = null;
    renderPresets();
    renderPosition();
    togglePresetEditor(false);
    toast(notes.length ? `Saved · ${notes.join(' · ')}` : 'Presets & fees saved — live everywhere');
  }

  /**
   * Show or hide only the main panel and its minimized pill. The positions bar
   * is intentionally left alone: it must remain visible on non-coin pages when
   * the user has open positions.
   */
  function applyOverlaySize() {
    if (!els.box || resizingOverlay) return;
    const w = settings.overlayWidth;
    const h = settings.overlayHeight;
    els.box.style.width = (w && Number(w) > 0) ? `${w}px` : '';
    // The saved height is a CAP, not a command: a panel with less content
    // stays content-sized (no dead space), a panel with more scrolls inside
    // it. "It even lets you size it wrong" — not anymore.
    els.box.style.height = '';
    els.box.style.maxHeight = (h && Number(h) > 0) ? `min(${h}px, 88vh)` : '';
  }

  const OVERLAY_MIN_W = 260;
  const OVERLAY_MAX_W = 560;
  const OVERLAY_MIN_H = 320;
  const OVERLAY_MAX_H = 820;

  function clampOverlaySize(w, h) {
    return {
      w: Math.max(OVERLAY_MIN_W, Math.min(OVERLAY_MAX_W, Math.round(w))),
      h: Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_MAX_H, Math.round(h))),
    };
  }

  function onOverlayResizeStart(e, corner) {
    if (!els.box) return;
    e.preventDefault();
    resizingOverlay = true;
    resizeStart = {
      x: e.clientX,
      y: e.clientY,
      w: els.box.offsetWidth,
      h: els.box.offsetHeight,
      top: readPanelPos().top,
      corner: corner || 'br',
      pointerId: e.pointerId,
      grip: e.currentTarget,
    };
    // Pointer CAPTURE is the un-stick fix (reported: a misclick "doesn't
    // actually unclick"): the old window-listener-only pattern waited for a
    // pointerup that never came when the gesture was cancelled (drag out of
    // window, context menu, touch cancel), leaving the drag latched on every
    // later mouse move. Capture guarantees a terminal event fires.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onOverlayResizeMove, { passive: false });
    window.addEventListener('pointerup', onOverlayResizeEnd);
    window.addEventListener('pointercancel', onOverlayResizeEnd);
  }

  function onOverlayResizeMove(e) {
    if (!resizingOverlay || !resizeStart || !els.box) return;
    e.preventDefault();
    const dx = e.clientX - resizeStart.x;
    const dy = e.clientY - resizeStart.y;
    const c = resizeStart.corner;
    // Right/top-anchored panel: width always adjusts the LEFT edge (the
    // right edge is planted), so left-corner drags invert dx. Top-corner
    // drags grow upward: `top` follows the clamped height so the bottom
    // edge stays planted.
    const wantW = (c === 'br' || c === 'tr') ? resizeStart.w + dx : resizeStart.w - dx;
    const wantH = (c === 'br' || c === 'bl') ? resizeStart.h + dy : resizeStart.h - dy;
    const { w, h } = clampOverlaySize(wantW, wantH);
    els.box.style.width = `${w}px`;
    els.box.style.height = `${h}px`;
    if (c === 'tr' || c === 'tl') {
      els.box.style.top = `${Math.max(0, resizeStart.top + (resizeStart.h - h))}px`;
    }
  }

  async function onOverlayResizeEnd() {
    window.removeEventListener('pointermove', onOverlayResizeMove);
    window.removeEventListener('pointerup', onOverlayResizeEnd);
    window.removeEventListener('pointercancel', onOverlayResizeEnd);
    const start = resizeStart;
    if (start && start.grip && start.pointerId !== undefined) {
      try { start.grip.releasePointerCapture(start.pointerId); } catch (_) {}
    }
    // DEFECT O-06: the flag must clear on EVERY exit path. The old early
    // return before it could latch resizingOverlay=true forever, permanently
    // disabling applyOverlaySize() for the rest of the page.
    resizingOverlay = false;
    resizeStart = null;
    if (!start || !els.box) return;
    const next = {
      ...settings,
      overlayWidth: els.box.offsetWidth,
      overlayHeight: els.box.offsetHeight,
    };
    if (start.corner === 'tr' || start.corner === 'tl') {
      const top = parseInt(els.box.style.top, 10);
      next.panelTop = Number.isFinite(top) ? Math.max(0, top) : start.top;
    }
    settings = next;
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
    // Wave 1 (F-D3): growing the right-anchored panel wider while parked
    // near the left edge pushed content past x=0 and nothing healed it
    // until the next drag. Resize ends clamped, like drags do.
    reclampPanel();
  }

  function setPanelVisible(visible) {
    if (!els.box || !els.pill) return;
    if (!visible) {
      els.box.classList.add('pt-hidden');
      els.pill.style.display = 'none';
      return;
    }
    if (panelMinimized) {
      // O-20: the pill appears where the panel is, not at a hardcoded
      // top-right. Read the position BEFORE hiding the box.
      const pos = readPanelPos();
      els.box.classList.add('pt-hidden');
      els.pill.style.right = pos.right + 'px';
      els.pill.style.top = pos.top + 'px';
      els.pill.style.left = 'auto';
      // O-27: the pill is styled as a flex row (dot + label); display:block
      // broke its centering.
      els.pill.style.display = 'flex';
    } else {
      els.box.classList.remove('pt-hidden');
      els.pill.style.display = 'none';
      // Wave 1 (F-D4): a pill parked at the far edge restored a panel that
      // hung mostly off-screen (the box measured width 0 while hidden, so
      // the clamp had used the 40px sliver). Restore with real geometry.
      reclampPanel();
    }
  }

  /**
   * Update the main panel visibility based on the auto-hide setting and the
   * presence of a token. The overlay is hidden when the user is on a non-coin
   * page and auto-hide is enabled, and reappears when a token is detected or
   * auto-hide is turned off.
   */
  function updateOverlayVisibility() {
    if (!host) return;
    // A pending token that keeps failing to resolve with no sign of market
    // activity is a false positive — an address-shaped but dead route. It
    // must count as "no token" or the panel pins open on non-trading pages
    // forever (DEFECT O-10). A YOUNG pending token stays visible: that is
    // the fresh-launch sniping window, and hiding it would kill the arm-buy
    // flow the pending state exists for.
    const unresolvable = token && token.pending
      && pendingAttempts > 40
      && !(Number(token.priceNative) > 0)
      && Date.now() - lastMcapTickAt > 15_000;
    const hide = settings.overlayHideWhenNoToken && (!token || unresolvable);
    setPanelVisible(!hide);
    renderVisibilityIcon();
  }

  function renderVisibilityIcon() {
    if (!els.visibility) return;
    // eye = always visible / auto-hide off. eye-off = hides on non-coin pages.
    const autoHide = settings.overlayHideWhenNoToken !== false;
    els.visibility.innerHTML = autoHide ? ICONS['eye-off'] : ICONS.eye;
    els.visibility.title = autoHide
      ? 'Overlay auto-hides when no token is detected'
      : 'Overlay is always visible';
  }

  async function toggleOverlayAutoHide() {
    settings = { ...settings, overlayHideWhenNoToken: !settings.overlayHideWhenNoToken };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
    // The storage listener will also refresh settings, but we update the UI
    // immediately so the icon and host display feel instant.
    updateOverlayVisibility();
  }

  async function toggleOverlayEnabled() {
    settings = { ...settings, overlayEnabled: !settings.overlayEnabled };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
  }

  function renderAll() {
    if (contextDead || !shadow) return;
    applyFocusMode();
    renderHeader();
    renderBalance();
    renderMicroWallet();
    renderPosition();
    renderAlerts();
    renderBuyButton();
    renderLimitBuys();
    renderThesis();
    renderClosedPnl();
    renderSiteStatus();
    renderLiveDot();
    updateOverlayVisibility();
    renderPositionsBar();
    // Event-driven, not per-tick: renderAll runs on boot, nav and fills.
    refreshTrenchCache();
  }

  /**
   * Axiom-style focus mode (settings.panelFocusMode): decoration hidden via
   * the .pt-focus CSS class on the box. Re-applied on every render so a
   * settings change from the dashboard flips it live, and so the class can
   * never drift from the setting.
   */
  function applyFocusMode() {
    if (!els.box || !els.box.classList) return;
    const micro = settings.panelDensity === 'micro';
    const focus = settings.panelFocusMode === true || micro;
    els.box.classList.toggle('pt-focus', focus && !micro);
    els.box.classList.toggle('pt-micro', micro);
    const ft = shadow && shadow.getElementById('pt-focus-toggle');
    if (ft) {
      ft.classList.toggle('on', focus);
      ft.title = micro ? 'Density: micro — click for standard'
        : focus ? 'Density: focus — click for micro' : 'Density: standard — click for focus';
      ft.setAttribute('aria-label', ft.title);
    }
    // With one-tap presets the chips ARE the buttons, so compact mode drops
    // the big BUY too; with instant buy off the (slim) button must stay or
    // select-then-buy has no trigger. Micro always hides it via CSS.
    els.box.classList.toggle('pt-focus-instant', focus && !micro && settings.instantBuyEnabled !== false);
  }

  /* Quick reset (focus mode): no popup — popups steal stream focus — but
   * never one accidental tap either. First tap arms for 3 s, second resets. */
  let quickResetArmedAt = 0;
  let quickResetTimer = null;

  function onQuickResetTap(btn) {
    const now = Date.now();
    if (now - quickResetArmedAt <= 3000 && quickResetArmedAt > 0) {
      quickResetArmedAt = 0;
      if (quickResetTimer) { clearTimeout(quickResetTimer); quickResetTimer = null; }
      btn.classList.remove('armed');
      btn.textContent = '⟲';
      quickResetWallet();
      return;
    }
    quickResetArmedAt = now;
    btn.classList.add('armed');
    btn.textContent = 'Sure?';
    if (quickResetTimer) clearTimeout(quickResetTimer);
    quickResetTimer = setTimeout(() => {
      quickResetArmedAt = 0;
      quickResetTimer = null;
      if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = '⟲'; }
    }, 3000);
  }

  async function quickResetWallet() {
    // Same semantics as the dashboard reset: the engine owns the seq bump so
    // an open tab elsewhere adopts the fresh wallet instead of resurrecting
    // the old one.
    const fresh = E.resetState(settings, state.seq);
    fresh.updatedAt = Date.now();
    state = fresh;
    livePositionPrices = {};
    posEls = null;
    // Forced commit: the reset IS the new truth by user intent, but it still
    // goes through the worker's write queue so it can never interleave with
    // a heartbeat commit and be half-resurrected. Stamp it as our own write
    // so the storage echo is not re-adopted (F-41).
    lastWrittenState = state;
    lastWrittenStamp = `${state.seq}:${state.updatedAt}`;
    const committed = await sendMessage({ type: 'pt_state_commit', state: fresh, force: true })
      .catch(() => null);
    if (!committed || !committed.ok) await store.set({ [E.STORAGE_KEYS.state]: fresh });
    await store.set({
      [E.STORAGE_KEYS.frames]: [],
      [E.STORAGE_KEYS.replays]: [],
    });
    sendMessage({ type: 'pt_clear_recordings' });
    sendMessage({ type: 'pt_settings_changed' });
    // Chart drawings belong to the old wallet.
    sendPadreMarker('paper-marker-clear');
    sendPadreMarker('paper-lines-clear');
    drawnFillIds.clear();
    if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
    if (CM && usesSvgMarkers()) { CM.clearMarkers(); CM.clearAverageLines(); }
    marks = [];
    renderAll();
    toast(`Paper wallet reset — fresh ${E.fmt(settings.balanceStartSol, 2)} SOL`);
  }

  function renderSiteStatus() {
    if (!els.footSite) return;
    if (!site) {
      els.footSite.textContent = '';
      if (els.subtitle) els.subtitle.textContent = 'Open a token page to begin';
      return;
    }
    // The price source is stated plainly. "CHAIN" means the fill price comes
    // from pool state at `processed` commitment; anything else is an
    // aggregator running behind, and the user deserves to know which.
    const feed = onchainLive ? ' · CHAIN ⚡' : '';
    // The rug flag is shown the moment the verdict lands, not only when a
    // buy is refused — the warning is worth more BEFORE the click.
    const rug = rugRefusalMessage() && token && rugVerdicts.get(token.mint)
      ? ` · 🚩 TOP ${rugVerdicts.get(token.mint).pct}%`
      : '';
    if (!usesNativeChart()) {
      els.footSite.textContent = `Site: ${site.name}${feed}${rug}`;
      if (els.subtitle) els.subtitle.textContent = site.name;
      return;
    }
    // Wave 1 (F-B4): feed health is ONE element now. The footer keeps only
    // what a trader acts on — site, on-chain feed, the rug flag. The hook
    // telemetry (marks/lines/bars status) is engineering truth, so it lives
    // in the live dot's tooltip and the devtools dataset, not on screen.
    const shapesOwn = lastMarkerStatus && lastMarkerStatus.shapeFallback;
    const lineOk = (lastLineStatus && lastLineStatus.ok) || padreHookStatus.linesReady;
    const lineReason = lastLineStatus && !lastLineStatus.ok && lastLineStatus.reason;
    els.footSite.textContent = `${site.name}${feed}${rug}`;
    const detail = [
      padreHookStatus.barsHooked ? 'feed: live' : 'feed: connecting',
      padreHookStatus.marksHooked ? 'marks: native' : (shapesOwn ? 'marks: shapes' : 'marks: connecting'),
      settings.averagePriceLinesEnabled
        ? (lineOk ? 'lines: ok' : `lines: ${lineReason || 'connecting'}`)
        : null,
    ].filter(Boolean).join(' · ');
    if (els.liveDot) els.liveDot.title = detail;
    els.footSite.title = detail;
    // One devtools glance = a diagnosis (the data-pt-dock pattern).
    try {
      els.footSite.dataset.ptMarks = padreHookStatus.marksHooked ? 'native' : (shapesOwn ? 'shapes' : 'connecting');
      els.footSite.dataset.ptLines = lineOk ? 'ok' : (lineReason || 'connecting');
    } catch (_) { /* dataset unavailable on exotic hosts */ }
    if (els.subtitle) {
      els.subtitle.textContent = padreHookStatus.barsHooked
        ? `${site.name} · live feed connected`
        : `${site.name} · connecting…`;
    }
  }

  /**
   * Header rendering is a thin projection of the pure headerFields() contract,
   * so what the user sees is exactly what the tests assert.
   */
  function renderHeader() {
    if (!els.tokenName) return;

    const f = Q.headerFields(token, { lastPriceAt, now: Date.now(), pendingSince });
    els.tokenName.textContent = f.title;
    // Distinct fields: the name goes above, the contract address below.
    els.tokenMint.textContent = token
      ? f.address
      : (site ? `${site.name} — open a token page` : 'Open a token page');
    els.price.textContent = f.priceText;
    // Amber for both "no price yet" and "price has gone stale" — either way the
    // number on screen is not currently live.
    els.price.classList.toggle('pt-price-stale', f.pending || f.stale);

    // The headline is market cap, so the second line carries the label and the
    // unit price rather than repeating the cap.
    // The old label read "MC · $0.0₄21" — which parses as "the MC IS $0.0₄21"
    // when it actually meant "the headline above is the MC; here is the unit
    // price". Say what the number IS (F-31, reported from a live screenshot).
    const secondary = f.priceIsMarketCap
      ? `Price ${f.priceUsdText || (f.hasTrustedPrice ? Q.formatPrice(token.priceNative) + ' SOL' : '')}`.trim()
      : (f.priceUsdText || '');
    els.priceUsd.textContent = f.stale ? `${secondary} · reconnecting…`.trim() : secondary;
  }

  function renderBalance() {
    // Wave 2 (F-H2): the 23px balance CARD is gone — the biggest number on
    // the panel was the least urgent one. Cash rides the Buy label in every
    // mode; a fill updates it in the same beat. Equity-vs-start lives on
    // the dashboard sidebar, where "am I actually up" is a browsing
    // question, not a mid-trade one.
    if (els.buyLabel && settings.panelBuyEnabled !== false) {
      els.buyLabel.textContent = buyLabelText();
    }
  }


  /**
   * Trade thesis: why this position was opened, captured while it is open and
   * the outcome is still unknown. That timing is the whole point — a reason
   * written after the result is hindsight, not a thesis.
   */
  function renderThesis() {
    if (!els.thesis) return;
    const pos = token && state.positions[token.mint];
    if (!pos) {
      if (els.thesis.childNodes.length) els.thesis.textContent = '';
      thesisEls = null;
      return;
    }

    if (thesisEls && thesisEls.mint !== token.mint) thesisComposerOpen = false;
    const saved = pos.thesis;
    // Rebuild only when switching between the saved, editing, and prompt
    // views, so typing is never interrupted by the heartbeat.
    const wantEditor = thesisEditing || (!saved && thesisComposerOpen);
    const wantPrompt = !saved && !wantEditor;
    if (thesisEls && thesisEls.editing === wantEditor && thesisEls.prompt === wantPrompt
      && thesisEls.mint === token.mint) return;

    els.thesis.textContent = '';

    if (wantPrompt) {
      const prompt = document.createElement('button');
      prompt.className = 'pt-thesis-prompt';
      prompt.textContent = '＋ Why this trade?';
      prompt.title = 'Write the setup before you know how it ends';
      prompt.addEventListener('click', () => {
        thesisComposerOpen = true;
        thesisEls = null;
        renderThesis();
      });
      els.thesis.appendChild(prompt);
      thesisEls = { editing: false, prompt: true, mint: token.mint };
      return;
    }

    const card = document.createElement('div');
    card.className = 'pt-thesis';

    if (!wantEditor) {
      card.innerHTML = `
        <div class="pt-thesis-head">
          <span class="pt-thesis-title">Thesis</span>
          <button class="pt-thesis-edit" data-f="edit">Edit</button>
        </div>
        <div class="pt-thesis-saved" data-f="text"></div>
        <div class="pt-tags" data-f="tags"></div>
        <div class="pt-thesis-meta" data-f="meta"></div>`;
      els.thesis.appendChild(card);

      card.querySelector('[data-f="text"]').textContent = saved.text || '(no note)';
      const tagWrap = card.querySelector('[data-f="tags"]');
      for (const tag of saved.tags || []) {
        const chip = document.createElement('span');
        chip.className = 'pt-tag on';
        chip.textContent = tag;
        tagWrap.appendChild(chip);
      }
      const bits = [];
      if (saved.plan) bits.push(saved.plan);
      if (saved.conviction) bits.push(`conviction ${saved.conviction}/5`);
      if (saved.targetPct) bits.push(`target +${saved.targetPct}%`);
      if (saved.stopPct) bits.push(`stop -${saved.stopPct}%`);
      if (saved.frameAt) bits.push('📸 chart snapped');
      card.querySelector('[data-f="meta"]').textContent = bits.join(' · ');
      card.querySelector('[data-f="edit"]').addEventListener('click', () => {
        thesisEditing = true;
        thesisEls = null;
        renderThesis();
      });
      thesisEls = { editing: false, prompt: false, mint: token.mint };
      return;
    }

    card.innerHTML = `
      <div class="pt-thesis-head">
        <span class="pt-thesis-title">Why this trade?</span>
        <button class="pt-thesis-edit" data-f="save">Save</button>
      </div>
      <textarea data-f="text" maxlength="${E.THESIS_MAX}" placeholder="What is the setup? Write it before you know how it ends."></textarea>
      <div class="pt-tags" data-f="tags"></div>
      <div class="pt-thesis-row">
        <input data-f="target" type="number" min="1" step="1" placeholder="target %">
        <input data-f="stop" type="number" min="1" step="1" placeholder="stop %">
      </div>
      <button class="pt-tag on" data-f="snap" title="Capture this chart as it looks right now and file it with the thesis — no other tab needed">📸 snap chart with save</button>`;
    els.thesis.appendChild(card);

    const textarea = card.querySelector('[data-f="text"]');
    const tagWrap = card.querySelector('[data-f="tags"]');
    const targetInput = card.querySelector('[data-f="target"]');
    const stopInput = card.querySelector('[data-f="stop"]');

    if (saved) {
      textarea.value = saved.text || '';
      targetInput.value = saved.targetPct || '';
      stopInput.value = saved.stopPct || '';
    }
    const chosen = new Set(saved ? saved.tags || [] : []);
    for (const tag of E.THESIS_TAGS) {
      const chip = document.createElement('button');
      chip.className = 'pt-tag' + (chosen.has(tag) ? ' on' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (chosen.has(tag)) chosen.delete(tag); else chosen.add(tag);
        chip.classList.toggle('on', chosen.has(tag));
      });
      tagWrap.appendChild(chip);
    }

    // "New pairs move too quick to open a completely separate tab" (superski):
    // the snap keeps the journal entry AND its chart context inside the
    // trader. On by default; one tap opts a save out.
    const snapBtn = card.querySelector('[data-f="snap"]');
    let snapWanted = true;
    snapBtn.addEventListener('click', () => {
      snapWanted = !snapWanted;
      snapBtn.classList.toggle('on', snapWanted);
    });

    card.querySelector('[data-f="save"]').addEventListener('click', async () => {
      // Snap FIRST so the frame's timestamp can ride the same thesis write.
      // The click is explicit intent, so the capture happens even when the
      // automatic coach frames are switched off (the background only honours
      // `explicit` from a user gesture like this one).
      let frameAt = null;
      const hasSubstance = textarea.value.trim().length > 0 || chosen.size > 0;
      if (snapWanted && hasSubstance) {
        const pos = state.positions[token.mint];
        const reply = await sendMessage({
          type: 'pt_snap_frame',
          kind: 'thesis',
          explicit: true,
          session: summarizeSession(pos),
        });
        if (reply && reply.ok && Number(reply.at) > 0) frameAt = Number(reply.at);
      }
      const payload = {
        text: textarea.value,
        tags: [...chosen],
        targetPct: Number(targetInput.value) || null,
        stopPct: Number(stopInput.value) || null,
        // A re-edit without a new snap keeps the original frame reference.
        frameAt: frameAt || (saved && saved.frameAt) || null,
      };
      try {
        await withState(async () => {
          const mutate = () => E.setThesis(state, token.mint, payload, Date.now());
          mutate();
          await persistStateNow(mutate);
        });
      } catch (err) {
        toast((err && err.message) || 'Could not save the thesis');
        return;
      }
      thesisEditing = false;
      thesisComposerOpen = false;
      thesisEls = null;
      renderThesis();
      toast(frameAt ? 'Thesis saved — chart snapped 📸'
        : (snapWanted && hasSubstance ? 'Thesis saved (chart snap failed)' : 'Thesis saved'));
    });

    thesisEls = { editing: true, prompt: false, mint: token.mint };
  }


  /**
   * Fire a buy that was requested before the coin had a tradeable price.
   *
   * The click already happened; all that was missing was a trusted quote. This
   * runs on the same event as the first accepted price, so the fill lands as
   * early as the data allows rather than waiting for another user action.
   */
  function flushArmedBuy() {
    if (!armedBuy || !token || !token.priceNative) return;
    // Only ever fill the token the user actually armed. Navigation already
    // clears this, but binding the mint makes that guarantee explicit rather
    // than dependent on ordering.
    if (armedBuy.mint && armedBuy.mint !== token.mint) {
      armedBuy = null;
      renderBuyButton();
      return;
    }
    if (armedBuyExpired()) {
      // Never execute a stale intent silently. F-16 made expiry quiet-aware
      // (mcap-only ticks extend the base TTL, hard cap ARMED_BUY_MAX_TTL_MS)
      // and the watchdog already uses that predicate — the FIRE path must use
      // it too, or a first price landing at 61–300 s on a live pre-index
      // launch is killed at the exact moment it becomes fillable (8/20 field
      // reports: armed intent that never fires while the chart visibly
      // trades — DEFECTS.md F-16 family, CHENG/SoranaSokan).
      armedBuy = null;
      renderBuyButton();
      toast('Armed buy expired — the quote took too long');
      return;
    }
    // F-54: on a fresh launch the FIRST accepted price is self-witnessing —
    // a lagging site feed can be minutes stale while the coin already ran.
    // Require corroboration: a second accepted tick OR two sources total
    // (bootstrap tick + resolver quote, in either order). The TTL expiry
    // above still bounds the wait; a genuinely new price fills one beat
    // later when its second source lands.
    //
    // D-39 (Terp 8/21, "no blockers or delays"): an EXPLICIT click-armed
    // intent supersedes that compromise. The chart is on screen — the
    // site's own data already prices the coin — so the first accepted
    // quote fills the click immediately. The corroboration gate survives
    // only for intents that were never clicked into existence.
    if (armedBuy.fromClick !== true && acceptedTickCount < 2) {
      renderBuyButton();
      return;
    }
    let amount = armedBuy.amount;
    const armedUsd = Number(armedBuy.usd) > 0 ? Number(armedBuy.usd) : null;
    armedBuy = null;
    renderBuyButton();
    // A dollar-armed buy could not convert at click time (no record yet).
    // The quote that fired this flush brought the recorded rate with it.
    if (!(amount > 0) && armedUsd) {
      const rate = panelUsdRate();
      if (!rate) { toast('No SOL/USD rate for this chain — armed buy dropped'); return; }
      amount = armedUsd / rate;
      // The guard that normally runs at request time was deferred for
      // exactly this path — the SOL amount only exists now.
      const guard = E.guardCheck(state, settings, { solAmount: amount });
      if (!guard.ok) { toast(guard.message); return; }
    }
    if (!(amount > 0)) return;
    doBuy(amount, armedUsd);
  }

  /**
   * The BUY button always reads plain "BUY" (Terp roll-on: a buy button
   * never changes its wording to narrate quote state). While a click-
   * triggered intent stays armed for its first price, the ONLY cue is the
   * amber pt-buy-armed class — the label never swaps again.
   */
  function renderBuyButton() {
    if (!els.btnBuy) return;
    els.btnBuy.textContent = 'BUY';
    if (armedBuy) els.btnBuy.classList.add('pt-buy-armed');
    else els.btnBuy.classList.remove('pt-buy-armed');
  }


  /**
   * Commit a fill to the tamper-evident chain.
   *
   * Done at fill time, before the outcome is known, so the chain records what
   * was actually decided rather than what the user later wishes they had done.
   *
   * The chain no longer rides inside pt_state (DEFECT F-14): the background
   * worker is its single writer, appending into segmented storage under one
   * serial lock. Sending the fill instead of rewriting the chain here is what
   * removed the multi-tab full-chain race AND the per-fill cost that grew
   * with lifetime fill count. The chain is still NEVER truncated — dropping
   * links would break verifyChain (the first kept link no longer chains from
   * GENESIS) and replayChain (derived P&L would silently drop early fills);
   * the worker's segmented store bounds the cost of keeping everything.
   *
   * Failure here must never block a trade — the trade is the product; the
   * chain is evidence for an optional leaderboard.
   */
  async function commitFill(trade) {
    if (!trade) return;
    const result = await sendMessage({ type: 'pt_attest_append', trade });
    if (!result || result.ok !== true) {
      /* evidence is best-effort; never interfere with trading — but say so
       * ONCE, or verifyChain later reports a mismatch the user cannot explain
       * (DEFECT F-28). */
      if (!attestFailureToasted) {
        attestFailureToasted = true;
        toast('Heads up: this fill could not be added to the verification chain');
      }
    }
  }
  let attestFailureToasted = false;

  /* -------------------- screener row quick buys --------------------
   *
   * Axiom Pulse, Padre Trenches and GMGN Trenches give every token row its
   * own one-click buy so a trade can be opened without loading the chart.
   * PaperTrench mirrors that: a small "P <amount>" chip is appended to every
   * token-row link on the screener pages, and tapping it paper-buys the
   * first preset amount. The fill lands in the positions bar immediately,
   * exactly like the site's own quick buy moves you to the position.
   */

  const ROW_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
  // Newest USD price per mint from the site's OWN realtime feed (GMGN's
  // token_activity ticks carry a mint). A row buy prefers this over a
  // network quote because the screener is showing that very price.
  const recentRowPrices = new Map(); // mint -> { usd, at }
  const ROW_PRICE_TTL_MS = 10_000;
  let rowBuyScanAt = 0;
  let rowBuyInFlight = false;
  // D-41: when the in-flight latch was SET, so the 1 s heartbeat can free a
  // latch whose await never settled (a hung resolver/SW RPC on a weird pair
  // once left "Row buy already in progress…" on every coin until reload —
  // live report). A settled finally clears the latch long before this ages.
  let rowBuyInFlightAt = 0;

  function noteRowPrice(payload) {
    if (!payload || typeof payload.mint !== 'string' || !ROW_ADDR_RE.test(payload.mint)) return;
    const cand = Array.isArray(payload.candidates)
      ? payload.candidates.find((c) => c && c.unit === 'usd' && Number(c.value) > 0)
      : null;
    if (!cand) return;
    recentRowPrices.set(payload.mint, {
      usd: Number(cand.value), at: Date.now(),
      symbol: typeof payload.symbol === 'string' ? payload.symbol : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    });
    if (recentRowPrices.size > 300) recentRowPrices.delete(recentRowPrices.keys().next().value);
    // D-40: a board tick while a row snipe is armed is the fastest possible
    // wake — the row the trader tapped just printed a price of its own.
    if (rowArmed) flushRowArmed();
  }

  /** The row's own live price when the resolver cannot answer — GMGN's
   * token_activity ticks are mint-tagged USD, the very number printed on
   * the row the trader just tapped. SOL/USD converts it to book units;
   * no rate means the honest refusal, never a guessed conversion. */
  async function rowLivePrice(addr) {
    const live = recentRowPrices.get(addr);
    if (!live || !(live.usd > 0) || Date.now() - live.at >= ROW_PRICE_TTL_MS) return null;
    const rate = await R.solUsd().catch(() => 0);
    if (!(rate > 0)) return null;
    return {
      priceNative: live.usd / rate,
      priceUsd: live.usd,
      symbol: live.symbol || null,
      name: live.name || null,
    };
  }

  /** The CHAIN layer for a row snipe (D-38). A pair on a new-coin board is
   * on-chain the second the card renders — the pool or bonding curve holds
   * a price long before any aggregator indexes it. The prewatch probe reads
   * it directly (pump curve from a mint; a pool from its account), exactly
   * as the panel's pending-token path does. An identity/supply-only answer
   * stays honest: no price, no fill. */
  async function rowChainQuote(addr, kind) {
    if (!addr || !ROW_ADDR_RE.test(addr)) return null;
    // D-39/D-40: probe BOTH shapes. The kind label guesses (pair -> pool,
    // mint -> mint), but a fresh Trenches row can be either: the chain
    // classifies the account, not the page's kind. Pool first (a live
    // pool carries the price), then the mint (the pump-curve derivation
    // path — a curve account signals itself).
    let ids = kind === 'pair' ? { pool: addr } : { mint: addr };
    let found = await R.onchainPrewatch(ids).catch(() => null);
    if (!found || !(Number(found.priceNative) > 0)) {
      ids = kind === 'pair' ? { mint: addr } : { pool: addr };
      found = await R.onchainPrewatch(ids).catch(() => null);
    }
    if (!found || !found.mint || !(Number(found.priceNative) > 0)) return null;
    return {
      mint: found.mint,
      pairAddress: found.pool || null,
      symbol: null,
      name: null,
      priceNative: Number(found.priceNative),
      priceUsd: null,
      mcap: null,
      priceSource: 'row-onchain',
    };
  }

  /**
   * Chips on screener rows are injected by the MAIN-world bridge (only it can
   * read React fibers, which rows without an address link need for their
   * token identity). This just forwards the scan request on a light cadence.
   */
  function scanRowBuys() {
    if (!site || !site.rowBuy || settings.listQuickBuyEnabled === false) return;
    if (!site.rowBuy.listPaths.test(location.pathname)) return;
    const now = Date.now();
    if (now - rowBuyScanAt < 350) return;
    rowBuyScanAt = now;

    sendPadreMarker('row-scan', {
      amount: (settings.presetsBuy || [0.1])[0],
      size: Math.max(0.6, Math.min(1.5, Number(settings.listQuickBuySize) || 1)),
      linkSelectors: site.rowBuy.linkSelectors,
      placement: site.rowBuy.placement,
      // F-53 (jb): 'auto' probes the default anchor and drops to the row's
      // bottom-right gutter when it lands on row content (Axiom/Padre
      // "ultra" compact format puts the MC exactly there); 'bottom' pins
      // the gutter everywhere. Null keeps the per-site default untouched.
      placementPref: settings.listQuickBuyPlacement === 'bottom' ? 'bottom'
        : settings.listQuickBuyPlacement === 'auto' ? 'auto' : null,
      buyButtonPattern: site.rowBuy.buyButtonPattern || null,
      containerMode: site.rowBuy.containerMode || 'heuristic',
    });
  }

  // Rows stream in continuously (virtualized lists, infinite scroll). A light
  // observer makes chips appear with the row instead of on the next poll.
  let rowBuyObserver = null;
  let rowBuyDebounce = null;
  function startRowBuyObserver() {
    if (rowBuyObserver || !document.body) return;
    rowBuyObserver = new MutationObserver(() => {
      if (rowBuyDebounce) return;
      rowBuyDebounce = setTimeout(() => {
        rowBuyDebounce = null;
        // DEFECTS O-29/O-07: the debounce used to fire one scan after
        // teardown, re-requesting chips into a page the overlay left.
        if (contextDead || !host) return;
        scanRowBuys();
      }, 200);
    });
    rowBuyObserver.observe(document.body, { childList: true, subtree: true });
    onTeardown(stopRowBuyObserver);
  }
  function stopRowBuyObserver() {
    if (rowBuyObserver) {
      try { rowBuyObserver.disconnect(); } catch (_) {}
      rowBuyObserver = null;
    }
    if (rowBuyDebounce) { clearTimeout(rowBuyDebounce); rowBuyDebounce = null; }
  }

  /**
   * D-40: an armed ROW snipe. The panel's D-39 doctrine, ported to the board:
   * the click already happened, so the intent is never refused — it arms and
   * fires the instant a fillable price arrives by ANY source (resolver, the
   * row's own feed tick, or the chain probe), with the same TTL honesty that
   * bounds the panel's armed buys.
   * Shape: { address, amount, at } — address is the row identity (mint or
   * pool) as the page printed it; the flush re-derives the canonical mint.
   */
  let rowArmed = null;
  let rowArmedFlushing = false;
  // D-42 (Bug 4): repeating armed-row probe — see doRowBuy's arm block.
  let rowArmedFlushTimer = null;
  // The armed intent is bounded by its TTL and by the content-script
  // lifetime: when this page context dies, the intent dies with it — never
  // a zombie fill from a detached page. (D-42: the SW mirror carries a copy
  // across navigations; ARMED_ROW_TTL_MS lives with the armed state above.)
  onTeardown(() => { rowArmed = null; });

  /** The row buy's commit core — shared by the direct fill and the armed
   * flush so both paths commit identically (same guard, same engine call,
   * same attestation chain, same rail refresh). Returns the result object or
   * null (guard refusal toasts its own message). */
  /**
   * F-59: the first-buy witness. A FIRST buy has no position to anchor on,
   * and the 8/16 pulse report showed exactly that hole: quick research,
   * instant buy, and the fill booked a lagging aggregator snapshot the row
   * on screen had long since moved past (entry MC 6k on a coin printing
   * 20k). The row's own recent print is the anchor instead — it is the
   * number the trader is LOOKING at. An aggregator candidate diverging >2x
   * from it needs the CHAIN to vouch (the resolver cannot witness itself).
   * Row-fed and chain-fed candidates are exempt: the row print IS their
   * source, and the chain is the authority this family already defers to.
   * Returns true when the fill may proceed; on refusal the toast is spoken
   * here and false is returned.
   */
  async function rowPrintVouchesFirstBuy(address, data, posAnchor) {
    if (posAnchor) return true; // an existing position anchors (F-56 above)
    if (!(Number(data.priceNative) > 0) || !(Number(data.priceUsd) > 0)) return true;
    if (data.priceSource === 'row-feed' || data.priceSource === 'row-onchain') return true;
    const rowPrint = (data.mint && recentRowPrices.get(data.mint))
      || (data.pairAddress && recentRowPrices.get(data.pairAddress))
      || (address && recentRowPrices.get(address));
    // A print this page made within the research window anchors; an ancient
    // one (coin long gone from the board) says nothing about the price now,
    // so it never gates.
    const ROW_ANCHOR_MAX_AGE_MS = 120_000;
    if (!rowPrint || !(rowPrint.usd > 0) || Date.now() - rowPrint.at > ROW_ANCHOR_MAX_AGE_MS) return true;
    const rate = Number(data.priceUsd) / Number(data.priceNative);
    const rowNative = rate > 0 ? rowPrint.usd / rate : 0;
    if (!(rowNative > 0)) return true;
    if (Math.max(rowNative / Number(data.priceNative), Number(data.priceNative) / rowNative) <= 2) return true;
    let witnessNative = null;
    try {
      const obs = await rowChainQuote(address, site && site.rowBuy && site.rowBuy.kind);
      if (obs && Number(obs.priceNative) > 0) witnessNative = Number(obs.priceNative);
    } catch (_) { /* witness lookup failed — treated as no witness */ }
    const vouched = witnessNative > 0
      && Math.max(witnessNative / Number(data.priceNative), Number(data.priceNative) / witnessNative) <= 1.6;
    if (!vouched) {
      toast('Price sources disagree — paper fill refused. Try again in a moment.');
      return false;
    }
    return true;
  }

  async function fillRowBuy(address, data, amount) {
    // F-56: a chip fill runs through the SAME honesty gates as a panel fill.
    // The row's own price used to price the trade blind — no witness, no
    // contradiction check — so a stale/wrong row print booked entries far
    // from the real market (pulse-page fills, "not accurate at all of my
    // real PNL", 8/16; the AMERICOIN 14x sell the same family). Two rules:
    // 1) an EXISTING position's last honest mark anchors the witness (the
    //    wallet already stands behind it), and
    // 2) a candidate that diverges >2x from that anchor needs a second,
    //    independent source to agree — resolver when the row came from the
    //    feed, row-feed when it came from the resolver. No vouch → refuse,
    //    visibly, exactly like a panel fill. A fresh coin with no anchor
    //    (no position yet, first buy) keeps the row price: the board feed
    //    is the primary source there and nothing better exists at t=0.
    const posAnchor = data.mint && state.positions[data.mint]
      ? state.positions[data.mint].lastPriceNative || null
      : null;
    if (posAnchor > 0 && Number(data.priceNative) > 0) {
      const ratio = Math.max(Number(data.priceNative) / posAnchor, posAnchor / Number(data.priceNative));
      if (ratio > 2) {
        let witnessNative = null;
        try {
          if (data.priceSource === 'row-feed' || !data.priceSource) {
            const obs = await R.resolve(address, { maxAgeMs: 3000 }).catch(() => null);
            if (obs && Number(obs.priceNative) > 0) witnessNative = Number(obs.priceNative);
          } else {
            const live = (data.mint && recentRowPrices.get(data.mint))
              || (data.pairAddress && recentRowPrices.get(data.pairAddress))
              || (address && recentRowPrices.get(address));
            if (live && Date.now() - live.at < ROW_PRICE_TTL_MS && Number(data.priceNative) > 0) {
              const rate = data.priceUsd / data.priceNative;
              witnessNative = live.usd / rate;
            }
          }
        } catch (_) { /* witness lookup failed — treated as no witness */ }
        const vouched = witnessNative > 0
          && Math.max(witnessNative / Number(data.priceNative), Number(data.priceNative) / witnessNative) <= 1.6;
        if (!vouched) {
          toast('Price sources disagree — paper fill refused. Try again in a moment.');
          return null;
        }
      }
    }
    // F-59: a FIRST buy has no position to anchor on — and the 8/16 pulse
    // report showed exactly that hole: quick research, instant buy, and the
    // fill booked a lagging aggregator snapshot the row on screen had long
    // since moved past (entry MC 6k on a coin printing 20k). The row's own
    // print is the anchor instead (see rowPrintVouchesFirstBuy).
    if (!(await rowPrintVouchesFirstBuy(address, data, posAnchor))) return null;
    // F-61: a row-fed candidate carries NO mint — the row feed keys its
    // ticks by whatever the board prints (on Axiom Pulse that is the PAIR
    // stand-in; F-59 saw the same keying). Committing under that key strands
    // the bag at the graduation boundary: the coin bonds, the page reopens
    // under the migration pool, and the resolver hands back the REAL mint —
    // a key the wallet never held (jb, 8/17: "buy via final stretch, hold
    // until bond, open from the bonding section: the buy does not show").
    // The chain classifies the click address the same way prewatch does —
    // one bounded read, never blocking the fill: a miss keeps the row's own
    // address as the key, exactly the honest legacy behavior.
    if (address && (!data.mint || data.mint === address)) {
      try {
        const found = await R.onchainPrewatch({ mint: address, pool: address }).catch(() => null);
        if (found && found.mint && found.mint !== data.mint) {
          data.mint = found.mint;
          if (!data.pairAddress && found.pool) data.pairAddress = found.pool;
        }
      } catch (_) { /* identity stays the row's own key */ }
    }
    // Guardrails apply to chip buys exactly like panel buys.
    const guard = E.guardCheck(state, settings, { solAmount: amount });
    if (!guard.ok) { toast(guard.message); return null; }
    const result = await withState(async () => {
      // Re-runnable mutation — see doBuy: a lost CAS race re-applies this
      // row buy on the adopted base; only the landing attempt is chained.
      let filled = null;
      const mutate = () => {
        const opened = !state.positions[data.mint];
        filled = E.buy(state, settings, {
          ts: Date.now(), mint: data.mint, pairAddress: data.pairAddress,
          symbol: data.symbol, name: data.name, site: site.id,
          solAmount: amount,
          priceNative: data.priceNative, priceUsd: data.priceUsd, mcap: data.mcap,
          ...(feeContextForOrder() || {}),
        });
        filled.opened = opened;
      };
      mutate();
      await persistStateNow(mutate);
      // Chain append after the wallet commit — see doBuy for the ordering.
      await commitFill(filled.trade);
      return { trade: filled.trade, position: filled.position, opened: filled.opened };
    });
    if (!result) return null;
    // #29: mark the fill's origin on the SUMMARY COPY only — the engine
    // trade was already hashed into the attestation chain inside
    // withState, so the committed object must not gain fields after the
    // fact. Background reads source to open the chart tab.
    sendMessage({
      type: 'pt_trade_event',
      kind: 'buy',
      opened: result.opened,
      session: summarizeSession(result.position),
      trade: summarizeTrade({ ...result.trade, source: 'list-chip' }),
    }).catch(() => {});
    runTradeEffect('buy');
    playTradeSound('buy');
    const atMcap = result.trade.mcap ? ` at ${fmtMoney(result.trade.mcap)} MC` : '';
    toast(`Bought ${E.fmt(amount, 3)} SOL of ${result.trade.symbol}${atMcap} (paper)`);
    if (result.opened) profitAlertLevels.set(data.mint, 0);
    // The positions bar is the screener's answer to a row buy: the new
    // position shows up in the rail instantly, chart one click away.
    pollPositionPrices();
    renderPositionsBar();
    // If this token's chart happens to be on screen, refresh the card too.
    if (token && token.mint === data.mint) renderAll();
    return result;
  }

  /** The D-40 armed-row flush: attempt a fill by every source in order; a
   * miss keeps the intent armed (the board feed, the resolver, and the chain
   * probe each get more chances until the TTL). */
  async function flushRowArmed() {
    if (!rowArmed || rowArmedFlushing) return;
    if (Date.now() - rowArmed.at > ARMED_ROW_TTL_MS) {
      rowArmed = null;
      sendPadreMarker('row-buy-done', null);
      toast('Armed row buy expired — no fillable price arrived in time');
      // D-42: expiry clears the SW mirror too, or the chart page would
      // adopt an intent the board already expired.
      sendMessage({ type: 'pt_armed_row_clear' }).catch(() => {});
      return;
    }
    rowArmedFlushing = true;
    const armed = rowArmed;
    try {
      // Same source order the click itself runs: freshest resolver read,
      // then the row's own feed, then the chain. The flush may only fire
      // once per wake; a miss leaves the intent armed.
      let data = await R.resolve(armed.address, { maxAgeMs: 3000 });
      if (!data || !(data.priceNative > 0)) data = await R.resolve(armed.address);
      if (!data || !(data.priceNative > 0)) data = await rowLivePrice(armed.address);
      if (!data || !(data.priceNative > 0)) {
        data = await rowChainQuote(armed.address, site && site.rowBuy && site.rowBuy.kind);
      }
      if (data && data.priceNative > 0) {
        // The screener's own realtime price wins when it is fresh: that is
        // the number the trader just looked at before tapping.
        // F-59: try every identity (see doRowBuy) and rescale the cap with
        // the price — a pair-keyed row tick used to miss the mint-only
        // lookup, and the stale resolver mcap rode along into the fill.
        const live = (data.mint && recentRowPrices.get(data.mint))
          || (data.pairAddress && recentRowPrices.get(data.pairAddress))
          || recentRowPrices.get(armed.address);
        if (live && Date.now() - live.at < ROW_PRICE_TTL_MS && Number(data.priceUsd) > 0) {
          const scale = live.usd / Number(data.priceUsd);
          data.priceUsd = live.usd;
          data.priceNative = Number(data.priceNative) * scale;
          if (Number(data.mcap) > 0) data.mcap = Number(data.mcap) * scale;
          data.priceSource = 'row-feed';
        }
        const result = await fillRowBuy(armed.address, data, armed.amount);
        if (result) {
          rowArmed = null;
          sendPadreMarker('row-buy-done', null);
          // D-42: the SW mirror dies with the local intent — a filled snipe
          // must never be adopted by the chart page and filled twice.
          sendMessage({ type: 'pt_armed_row_clear' }).catch(() => {});
        }
      }
    } catch (_) {
      // A transient failure keeps the intent armed — the next wake retries.
    } finally { rowArmedFlushing = false; }
  }

  /** Paper-buy the first preset amount of a screener row's token. */
  async function doRowBuy(address, button) {
    if (rowBuyInFlight) return toast('Row buy already in progress…');
    rowBuyInFlight = true;
    rowBuyInFlightAt = Date.now();
    if (button) button.classList.add('busy');
    primeAudio();
    try {
      const amount = (settings.presetsBuy || [0.1])[0];
      // Guardrails apply to chip buys exactly like panel buys.
      const guard = E.guardCheck(state, settings, { solAmount: amount });
      if (!guard.ok) { toast(guard.message); return; }
      // A screener chip fill must not price from a minute-old display cache
      // (the resolver keeps entries 60 s for display use). Demand a quote no
      // older than the live-feed staleness bound; the resolver refetches when
      // its entry is older — one short round trip instead of a stale fill.
      // D-38: a coin minutes old is unindexed by every aggregator while the
      // row's own realtime feed already prints it. Cascade: freshest network
      // read, then the 60 s display cache, then the row feed (GMGN
      // token_activity — mint-tagged USD), then the CHAIN — a new-coin row
      // is on-chain the second the card exists, and the prewatch probe
      // prices the pool/curve directly. D-40: a miss at the bottom no longer
      // refuses — it ARMS the click and fires on the first fillable price.
      // D-41: the whole cascade is raced against a hard bound — one hung
      // resolver/RPC on a weird pair once left the in-flight latch set on
      // every following buy ("Row buy already in progress…", live report);
      // nothing below may block this function's finally forever.
      const ROW_CASCADE_TIMEOUT_MS = 10_000;
      let data = null;
      try {
        data = await Promise.race([
          (async () => {
            let d = await R.resolve(address, { maxAgeMs: 3000 });
            if (!d || !(d.priceNative > 0)) d = await R.resolve(address);
            if (!d || !(d.priceNative > 0)) {
              const row = await rowLivePrice(address);
              if (row) {
                d = {
                  mint: address, pairAddress: null,
                  symbol: row.symbol, name: row.name,
                  priceNative: row.priceNative, priceUsd: row.priceUsd, mcap: null,
                  priceSource: 'row-feed',
                };
              }
            }
            if (!d || !(d.priceNative > 0)) {
              d = await rowChainQuote(address, site && site.rowBuy && site.rowBuy.kind);
            }
            return d;
          })(),
          new Promise((resolve) => setTimeout(() => resolve(null), ROW_CASCADE_TIMEOUT_MS)),
        ]);
      } catch (_) { data = null; }
      if (!data || !(data.priceNative > 0)) {
        // D-40 (Terp roll-on, board path): the click already happened — the
        // intent is NEVER refused. It arms exactly like the panel's D-39
        // doctrine and fires the instant a fillable price arrives by any
        // source: the row's own mint-tagged board tick (fastest wake), the
        // resolver's next pass, or a delayed chain re-probe. The same 60 s
        // TTL honesty bounds the wait; expiry says so instead of guessing.
        rowArmed = { address, amount, at: Date.now() };
        // D-42 (Bug 3): the trader's next move is to click the coin and open
        // its chart — which destroys THIS context and, before this line, the
        // armed intent with it (no fill, no position, no line: the live
        // report). Mirror the intent into the SW's session storage; the
        // coin's own page adopts it at detection and runs the SAME D-39
        // armedBuy flush. Both sides clear the SW copy on fill/expiry.
        sendMessage({
          type: 'pt_armed_row_arm',
          intent: { address, amount, at: rowArmed.at },
        }).catch(() => {});
        setTimeout(() => flushRowArmed(), 1200);
        setTimeout(() => flushRowArmed(), 4000);
        // D-42 (Bug 4): two one-shot timers left gaps where nothing probed —
        // a coin whose sources all miss at 1.2 s and 4 s then waited for the
        // next board tick to wake the flush ("some buys are still not
        // instant"). A repeating probe inside the TTL closes the gaps: every
        // 1.5 s, the full cascade (resolver, row feed, chain) gets another
        // chance until the intent fills or its TTL expires. The null-guard
        // self-clears; managedInterval already dies with the context.
        if (!rowArmedFlushTimer) {
          rowArmedFlushTimer = managedInterval(() => {
            if (!rowArmed) {
              clearInterval(rowArmedFlushTimer);
              rowArmedFlushTimer = null;
              return;
            }
            flushRowArmed();
          }, 1500);
        }
        return;
      }
      // The screener's own realtime price wins when it is fresh: that is the
      // number the user just looked at before tapping.
      // F-59: the lookup tries EVERY identity the token answers to. Pulse
      // frames key their records by whichever mint-shaped key they carry —
      // often the PAIR address — while `data.mint` is the resolver's MINT,
      // so a mint-only lookup missed the fresh row print entirely and the
      // fill booked the resolver's stale snapshot instead (8/16: row
      // printing 20k MC, fill booked 6k). The click's own address and the
      // resolver's pairAddress are tried before giving up.
      const live = (data.mint && recentRowPrices.get(data.mint))
        || (data.pairAddress && recentRowPrices.get(data.pairAddress))
        || (address && recentRowPrices.get(address));
      if (live && Date.now() - live.at < ROW_PRICE_TTL_MS && Number(data.priceUsd) > 0) {
        // F-59: the cap rides the price. The old override rewrote
        // priceUsd/priceNative and left `mcap` at the resolver's stale
        // value — the toast and the position then reported an entry MC the
        // market never printed at fill time. Supply is constant across the
        // two reads, so the cap scales by exactly the price ratio.
        const scale = live.usd / Number(data.priceUsd);
        data.priceUsd = live.usd;
        data.priceNative = Number(data.priceNative) * scale;
        if (Number(data.mcap) > 0) data.mcap = Number(data.mcap) * scale;
        data.priceSource = 'row-feed';
      }

      // D-40: the commit core is shared with the armed flush — one extractor,
      // identical guard/engine/attestation/rail behaviour on both paths.
      await fillRowBuy(address, data, amount);
    } catch (err) {
      toast(err.message || 'Row buy failed');
    } finally {
      rowBuyInFlight = false;
      if (button) button.classList.remove('busy');
    }
  }

  /* -------------------- positions bar -------------------- */

  /**
   * Render the Padre-style top rail listing every open paper position.
   *
   * Chips are updated IN PLACE rather than rebuilt, for the same reason the
   * position card is: this runs on every tick, and replacing innerHTML would
   * reset the rail's horizontal scroll and kill a click already in progress.
   */
  function renderPositionsBar() {
    if (contextDead || !els.bar || !els.barRail) return;

    // O-30: the on-screen token's chip must show the same number as the
    // position card, so it is marked from the page feed's own quote — never
    // from a batch entry cached while the token was off-screen. Bounded by
    // the same staleness mark the header uses; past it the stored mark (kept
    // in step by the same feed) stands in, exactly like the card.
    const activeQuote = token && Number(token.priceNative) > 0
      && lastPriceAt && Date.now() - lastPriceAt < Q.STALE_AFTER_MS
      ? {
        priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null,
      }
      : null;
    const rows = Q.positionRows(state, livePositionPrices, token && token.mint, activeQuote);
    const enabled = settings.positionsBarEnabled !== false;
    // away32 (8/21): "overlay sol balance at the top without needing to open
    // the ext" — with zero positions the bar used to vanish entirely, taking
    // the wallet readout with it. A new wallet (or a fully-closed book) now
    // keeps a one-chip bar: brand + idle SOL. Traders who close everything
    // mid-session keep their number; everyone else sees the same bar as
    // before once a single position exists.
    const show = enabled && !positionsBarHidden && (rows.length > 0 || E.densityWantsIdleSol(settings, state));

    // Release resources for tokens that are no longer held. This runs BEFORE
    // the early return so a closed position cannot leak a cached quote or a
    // detached chip while the bar happens to be collapsed or disabled.
    const held = new Set(rows.map((row) => row.mint));
    for (const [mint, chip] of barChips) {
      if (held.has(mint)) continue;
      chip.el.remove();
      barChips.delete(mint);
    }
    for (const mint of Object.keys(livePositionPrices)) {
      if (!held.has(mint)) delete livePositionPrices[mint];
    }

    const wasHidden = els.bar.classList.contains('pt-hidden');
    els.bar.classList.toggle('pt-hidden', !show);
    // Re-measure when the bar becomes visible: the host header has painted by
    // then, and SPA navigation can change its width.
    if (show && wasHidden) positionBar();
    if (els.barTab) {
      els.barTab.style.display = enabled && rows.length > 0 && positionsBarHidden ? 'flex' : 'none';
    }
    // Nudge the host page down so a fixed site header isn't covered.
    applyBarOffset(show);
    if (!show) return;

    const summary = Q.portfolioSummary(rows);
    if (els.barTotal) {
      // Built once, then updated via textContent only. Nothing derived from a
      // token's own metadata is ever interpreted as markup.
      if (!barTotalEls) {
        els.barTotal.textContent = '';
        const count = document.createElement('span');
        count.className = 'k';
        const sol = document.createElement('span');
        sol.className = 'v';
        const pct = document.createElement('span');
        pct.className = 'v';
        pct.style.fontSize = '11px';
        pct.style.opacity = '.75';
        els.barTotal.appendChild(count);
        els.barTotal.appendChild(sol);
        els.barTotal.appendChild(pct);
        barTotalEls = { count, sol, pct };
      }
      const sign = summary.up ? '+' : '';
      // N2: armed limit buys lock SOL — show it in the bar total so the
      // "missing" cash is explained where the trader looks for it.
      const locked = E.lockedBuySol(state);
      if (rows.length === 0) {
        // away32: the empty bar IS the wallet — "N ◎ idle" reads as the
        // number to deploy, not a position count pretending to be one.
        barTotalEls.count.textContent = 'wallet';
        barTotalEls.sol.textContent = `${E.fmt(state.cashSol, 3)} ◎ idle`;
        barTotalEls.sol.classList.remove('pt-green', 'pt-red');
        barTotalEls.pct.textContent = locked > 0 ? `${E.fmt(locked, 3)} armed` : '';
      } else {
        barTotalEls.count.textContent = `${rows.length} position${rows.length === 1 ? '' : 's'}${locked > 0 ? ` · ${E.fmt(locked, 3)} locked` : ''}`;
        barTotalEls.sol.textContent = `${sign}${E.fmt(summary.pnlSol, 3)} SOL`;
        barTotalEls.pct.textContent = `${sign}${summary.pnlPct.toFixed(1)}%`;
        for (const node of [barTotalEls.sol, barTotalEls.pct]) {
          node.classList.toggle('pt-green', summary.up);
          node.classList.toggle('pt-red', !summary.up);
        }
      }
    }

    for (const row of rows) {
      let chip = barChips.get(row.mint);
      if (!chip) {
        chip = buildChip(row);
        barChips.set(row.mint, chip);
        // Only touch DOM order when a chip is genuinely new. Re-appending on
        // every tick would reset the rail's scroll position mid-drag.
        els.barRail.appendChild(chip.el);
      }
      updateChip(chip, row);
    }

    // Re-order only when the intended order actually differs from the DOM.
    const desired = rows.map((row) => barChips.get(row.mint).el);
    const current = els.barRail.children;
    let ordered = desired.length === current.length;
    if (ordered) {
      for (let i = 0; i < desired.length; i++) {
        if (current[i] !== desired[i]) { ordered = false; break; }
      }
    }
    if (!ordered) desired.forEach((el) => els.barRail.appendChild(el));
    syncRailFade();
  }

  /**
   * Which edges of the positions rail have content past them.
   *
   * The scrollbar is gone (house rule), so this fade IS the overflow
   * affordance — and it has to be honest in both directions: a rail that fits
   * gets no fade at all, and a rail scrolled to its end stops claiming there
   * is more to the right. A permanently-faded edge would dim the last chip on
   * a bar with nothing hidden, which reads as "there's more" when there isn't.
   *
   * Tolerance of 1px because scrollWidth/clientWidth are fractional under
   * browser zoom and a strict compare leaves a hairline fade on a rail that is
   * actually at its end.
   */
  function syncRailFade() {
    const rail = els.barRail;
    if (!rail) return;
    let scrollLeft = 0; let scrollWidth = 0; let clientWidth = 0;
    try {
      scrollLeft = rail.scrollLeft; scrollWidth = rail.scrollWidth; clientWidth = rail.clientWidth;
    } catch (_) { return; }
    // A hidden rail measures 0 and would report "no overflow" — leave the
    // classes alone rather than clearing a state we cannot currently see.
    if (!(clientWidth > 0)) return;
    const overflowing = scrollWidth - clientWidth > 1;
    const atStart = scrollLeft <= 1;
    const atEnd = scrollLeft >= scrollWidth - clientWidth - 1;
    rail.classList.toggle('pt-rail-more', overflowing && !atEnd);
    rail.classList.toggle('pt-rail-start', overflowing && !atStart && !atEnd);
    rail.classList.toggle('pt-rail-end', overflowing && atEnd);
  }

  function buildChip(row) {
    const el = document.createElement('button');
    el.className = 'pt-chip';
    el.innerHTML =
      '<span class="pt-chip-dot"></span>' +
      '<span class="pt-chip-sym"></span>' +
      '<span class="pt-chip-pnl"></span>' +
      '<span class="pt-chip-pct"></span>';
    const chip = {
      el,
      dot: el.querySelector('.pt-chip-dot'),
      sym: el.querySelector('.pt-chip-sym'),
      pnl: el.querySelector('.pt-chip-pnl'),
      pct: el.querySelector('.pt-chip-pct'),
      mint: row.mint,
      lastPnl: null,
    };
    el.addEventListener('click', () => openPositionChart(chip.mint));
    return chip;
  }

  function updateChip(chip, row) {
    const sign = row.pnlSol >= 0 ? '+' : '';
    chip.mint = row.mint;
    chip.sym.textContent = row.symbol;
    chip.pnl.textContent = `${sign}${E.fmt(row.pnlSol, 3)}`;
    chip.pct.textContent = `${sign}${row.pnlPct.toFixed(1)}%`;

    // Color by TOTAL position P&L, never by the direction of the last tick.
    chip.el.classList.toggle('pt-green', row.up);
    chip.el.classList.toggle('pt-red', !row.up);
    chip.el.classList.toggle('active', row.active);
    chip.el.classList.toggle('stale', row.stale);
    chip.el.title = row.stale
      ? `${row.symbol} — ${E.fmt(row.valueSol, 4)} SOL · price not live yet`
      : `${row.symbol} — ${E.fmt(row.valueSol, 4)} SOL · click to open its chart`;

    if (chip.lastPnl !== null && row.pnlSol !== chip.lastPnl) {
      const cls = row.up ? 'pt-flash-up' : 'pt-flash-down';
      chip.el.classList.remove('pt-flash-up', 'pt-flash-down');
      void chip.el.offsetWidth;
      chip.el.classList.add(cls);
    }
    chip.lastPnl = row.pnlSol;
  }

  /** True while any closed round still has its post-exit watch running. */
  function postWatchActive() {
    return settings.postExitWatchEnabled !== false && E.postWatchMints(state).length > 0;
  }

  /** True while any token is waiting on a market-cap alert. */
  function alertsActive() {
    return mcAlertsOn() && E.alertMints(state).length > 0;
  }

  /**
   * Keep prices fresh for positions the user is NOT currently looking at.
   *
   * The on-screen token already streams from the page's own feed, so it is
   * excluded here; only off-screen mints are batched to Dexscreener. Requests
   * never stack, and a hidden tab backs off hard.
   */
  async function pollPositionPrices() {
    if (settings.positionsBarEnabled === false && !postWatchActive() && !alertsActive()) return;
    if (barPollInFlight) return;

    const positionMints = settings.positionsBarEnabled === false ? [] :
      Object.keys(state.positions || {}).filter(
        (mint) => !(token && token.mint === mint)
      );
    // The After: closed rounds keep their coins on watch for a bounded
    // window, riding the SAME batch request — near-zero extra cost for the
    // truth about what happened after the exit.
    const watchMints = settings.postExitWatchEnabled === false ? [] :
      E.postWatchMints(state).filter(
        (mint) => !(token && token.mint === mint) && !positionMints.includes(mint)
      );
    // Alerts ride the SAME batch request — the reason a market-cap alert
    // fires while you are looking at a different chart, with no background
    // poller, no alarm and no extra network cost when the mint is already
    // being watched for another reason.
    const alertMints = !mcAlertsOn() ? [] :
      E.alertMints(state).filter(
        (mint) => !(token && token.mint === mint)
          && !positionMints.includes(mint) && !watchMints.includes(mint)
      );
    const mints = positionMints.concat(watchMints, alertMints);
    if (!mints.length) {
      // Watches can expire with no fetch needed; still settle them.
      if (E.finalizePostWatches(state) > 0) persistSoon();
      return;
    }
    // Multichain: the batch parser must know each foreign mint's chain —
    // the same 0x address can exist on several EVM chains.
    const chains = {};
    for (const mint of mints) {
      const pos = state.positions && state.positions[mint];
      if (pos && pos.chain && pos.chain !== 'solana') { chains[mint] = pos.chain; continue; }
      // A watched mint has no position to read the chain from; the alert
      // recorded it at arm time precisely so this lookup has an answer.
      const armed = E.alertsFor(state, mint)[0];
      if (armed && armed.chain && armed.chain !== 'solana') chains[mint] = armed.chain;
    }

    const now = Date.now();
    const interval = document.hidden ? BAR_POLL_HIDDEN_MS : BAR_POLL_MS;
    if (barPollAt && now - barPollAt < interval) return;

    barPollInFlight = true;
    barPollAt = now;
    try {
      const prices = await R.batchPrices(mints, Object.keys(chains).length ? chains : undefined);
      let changed = false;
      // Collected rather than fired inline: triggeredAlerts is a pure read, but
      // FIRING one goes through withState, which re-reads storage and would
      // replace `state` mid-loop — dropping the marks set on the lines above.
      const dueAlerts = [];
      for (const mint of Object.keys(prices)) {
        const quote = prices[mint];
        if (!quote || !(quote.priceNative > 0)) continue;
        if (positionMints.includes(mint)) {
          // F-55: an up-print from a collapsed pool is a dust-pool phantom —
          // it may not re-mark a position (the rug-green-PnL bug). Down
          // prints pass: a rug is supposed to hurt.
          const pos55 = state.positions[mint];
          const guard55 = pos55
            ? Q.rugGuardVerdict(quote.priceNative, pos55.lastPriceNative, quote.liquidityUsd)
            : 'pass';
          if (guard55 === 'refuse') {
            console.debug('PaperTrench: refused phantom up-mark for ' + mint
              + ' from a collapsed pool (' + quote.liquidityUsd + ' USD liq, '
              + pos55.lastPriceNative + ' -> ' + quote.priceNative + ') F-55');
          } else {
            livePositionPrices[mint] = { priceNative: quote.priceNative, priceUsd: quote.priceUsd };
            // Mark the engine too, so peak/trough and equity stay truthful for
            // positions the user never has on screen.
            E.markPosition(state, mint, quote.priceNative, quote.priceUsd);
            changed = true;
          }
        }
        if (E.notePostExitPrice(state, mint, quote.priceNative, now)) changed = true;
        if (mcAlertsOn() && E.triggeredAlerts(state, mint, quote).length) dueAlerts.push([mint, quote]);
      }
      if (E.finalizePostWatches(state, now) > 0) changed = true;
      if (changed) {
        // A due alert flushes NOW rather than on the 800 ms debounce, so the
        // re-read inside withState below sees this poll's marks instead of
        // clobbering them with an older stored copy.
        if (dueAlerts.length) await persistStateNow();
        else persistSoon();
        renderPositionsBar();
        renderBalance();
      }
      for (const [mint, quote] of dueAlerts) await evaluateMcAlerts(mint, quote);
    } catch (e) {
      /* offline or rate-limited: keep the last marks and flag rows stale */
    } finally {
      barPollInFlight = false;
    }
  }

  /** Navigate to a held token's chart, preferring the site it was opened on. */
  function openPositionChart(mint) {
    if (!mint) return;
    if (token && token.mint === mint) return; // already here
    const pos = state.positions && state.positions[mint];
    // Bug 6 (Twitch 2026-08-22): the position's pairAddress was write-once —
    // a bag opened while a fresh pair was still pending carries null, and its
    // chip link fell back to the mint route, which on a brand-new pair is a
    // dead page. When THIS tab is showing the same token the live record has
    // the resolver's current identity (pool included); prefer it, and only
    // then fall back to the position's own stored pair.
    const livePair = token && token.mint === mint ? token.pairAddress : null;
    const url = S.tokenUrlFor(mint, {
      siteId: (pos && pos.site) || (site && site.id),
      pairAddress: livePair || (pos && pos.pairAddress),
      fallbackSite: site,
    });
    if (!url) return;
    // Turbo: a chip whose position lives on ANOTHER terminal used to replace
    // this tab with that terminal — the hop cost you the page you were on.
    // With Instant links enabled, a cross-terminal hop routes to that
    // terminal's kept-warm viewer instead and this tab stays put. Same-site
    // hops (and the feature off) keep the Padre-style same-tab swap.
    const WDs = window.PTWarmDest;
    if (WDs && settings.warmEverywhereEnabled) {
      const dest = WDs.classify(url);
      if (dest && WDs.familyOfHost(location.hostname) !== dest.family && contextAlive()) {
        try {
          chrome.runtime.sendMessage({ type: 'pt_warmdest_open', url: dest.url }).catch(() => {});
          return;
        } catch (_) { /* dead context: fall through to the native hop */ }
      }
    }
    // Same tab: this mirrors Padre's own bar, where a position swaps the chart.
    window.location.href = url;
  }

  /**
   * Find where the host site's own top-left branding ends, so the bar can sit
   * in the empty space beside it instead of on top of the site's controls.
   *
   * Measuring beats hardcoding: every site's header is a different width, and
   * a fixed offset that looks right on Padre would overlap something else on
   * Axiom or Photon. Falls back to a sane default if nothing is measurable.
   */
  const BAR_DEFAULT_LEFT = 210; // fallback when no header edge is measurable

  function measureBarLeft() {
    const DEFAULT_LEFT = BAR_DEFAULT_LEFT;
    const MIN_LEFT = 96;
    const MAX_LEFT = 460;
    try {
      // Sample the strip where a site header's logo lives and take the
      // right-most edge of the elements actually painted there.
      const probeY = 24;
      let edge = 0;
      for (let x = 8; x <= 420; x += 28) {
        const el = document.elementFromPoint(x, probeY);
        if (!el || el === document.body || el === document.documentElement) continue;
        // Ignore our own shadow host.
        if (host && (el === host || (host.contains && host.contains(el)))) continue;
        const rect = el.getBoundingClientRect();
        // Only consider compact header-ish elements, not full-width containers.
        if (rect.width > 0 && rect.width < 420 && rect.top < 60 && rect.right > edge) {
          edge = rect.right;
        }
      }
      if (edge > 0) return Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(edge + 18)));
    } catch (_) { /* cross-origin or exotic layout: use the default */ }
    return DEFAULT_LEFT;
  }

  // Runtime source of truth for the bar's position (the computed style of a
  // display:none bar is not reliably readable, and parseInt round trips are
  // exactly what DEFECT O-19 removed).
  let barPos = { left: null, top: null };

  /** Write the bar/tab position variables and remember them. */
  function setBarPosition(left, top) {
    barPos = { left, top };
    if (els.bar) {
      els.bar.style.setProperty('--pt-bar-left', left + 'px');
      els.bar.style.setProperty('--pt-bar-top', top + 'px');
    }
    if (els.barTab) {
      els.barTab.style.setProperty('--pt-bar-left', left + 'px');
      els.barTab.style.setProperty('--pt-bar-top', top + 'px');
    }
  }

  /** Position the bar once the page has painted its own header. The settle
   * loop passes its own measurement in so the probe never runs twice a beat. */
  function positionBar(measuredLeft) {
    if (!els.bar) return;
    const left = typeof settings.positionsBarLeft === 'number' && Number.isFinite(settings.positionsBarLeft)
      ? settings.positionsBarLeft
      : (Number.isFinite(measuredLeft) ? measuredLeft : measureBarLeft());
    const top = typeof settings.positionsBarTop === 'number' && Number.isFinite(settings.positionsBarTop)
      ? settings.positionsBarTop : 7;
    // DEFECT O-18: a saved coordinate from a bigger window is pulled back on
    // screen rather than re-asserted; the same path runs on window resize,
    // so shrinking the window can never strand the bar off-screen.
    const pos = clampBarPos(left, top);
    setBarPosition(pos.left, pos.top);
  }

  /**
   * The bar deliberately does NOT reflow the host page.
   *
   * The obvious approach — margin-top on <html> — is wrong: it does not move
   * `position: fixed` site headers, so on Padre (and most trading UIs, which
   * all pin their nav) the bar would sit ON TOP of the site's own controls and
   * make them unclickable. Verified visually against a fixed-header page.
   *
   * Instead the bar floats as an overlay and is inset from the left, leaving
   * the site's own top-left nav and logo visible and clickable underneath.
   * Nothing about the host layout is mutated, so there is also nothing to
   * revert or leak when the bar hides.
   */
  function applyBarOffset() { /* intentionally a no-op — see comment above */ }

  /**
   * Feed-health dot: green while ticks are arriving, amber the moment the
   * quote goes stale. It reads the same staleness contract the header uses,
   * so the dot can never disagree with the price it sits beside.
   */
  function renderLiveDot() {
    if (!els.liveDot) return;
    const hasPrice = Boolean(token && token.priceNative);
    const stale = !hasPrice || Q.isPriceStale(lastPriceAt, Date.now());
    els.liveDot.classList.toggle('on', hasPrice && !stale);
    els.liveDot.classList.toggle('warn', hasPrice && stale);
  }

  /**
   * Micro-sparkline of the recent price series, drawn as an SVG path.
   * Colored by move direction across the window, with a soft area fill and a
   * pulsing head so the newest tick is obvious in peripheral vision.
   */
  /* renderSparkline is gone (Wave 2, F-B3): a 26px copy of the chart the
   * panel floats over was decoration, not signal. */

  /**
   * Render the position card.
   *
   * This runs on every heartbeat, so the card is built ONCE and thereafter
   * only its numbers are updated in place. Rebuilding innerHTML twice a second
   * would rip out the sell buttons under the user's cursor and kill their
   * click, which is unacceptable on a panel whose whole job is fast exits.
   */
  function renderPosition() {
    if (!els.position) return;
    const pos = token && state.positions[token.mint];

    // The card is ALWAYS present, held or not. It used to be torn down the
    // moment a position closed, so the sell ladder and the round ledger
    // appeared and vanished — reported as the sell buttons not always being
    // there. An empty card states the shape of the thing and disables what
    // cannot be done; it never claims a number it does not have.
    if (!posEls) buildPositionCard(pos || null);

    if (!pos) {
      renderEmptyPosition();
      posOrderEls = null;
      return;
    }
    // Armed levels change from the chart (a drag, a cancel) and from the
    // wallet (an order firing), neither of which rebuilds the card.
    renderOrderList();

    const mark = Q.positionMark(pos, token.priceNative, token.priceUsd);
    if (!mark) return;

    // Re-arm whatever the empty state switched off — the card persists now,
    // so a disabled control would otherwise stay disabled after a buy.
    setSellLadderEnabled(true);
    if (posEls.orders) posEls.orders.classList.remove('pt-hidden');

    posEls.qty.textContent = `${E.fmt(mark.qty, 2)} ${pos.symbol}`;
    // "I got in at 240K" is how the entry is actually discussed, so the card
    // shows the market cap at entry whenever the cap is known.
    posEls.entry.textContent = entryText(mark.avgEntry);
    posEls.value.textContent = `${E.fmt(mark.valueSol, 4)} SOL`;

    const sign = mark.pnlSol >= 0 ? '+' : '';
    posEls.pnl.textContent =
      `${sign}${E.fmt(mark.pnlSol)} SOL (${mark.pnlPct.toFixed(1)}%)` +
      (mark.pnlUsd !== null ? ` · ${E.fmtUsd(mark.pnlUsd)}` : '');
    posEls.pnl.classList.toggle('pt-green', mark.up);
    posEls.pnl.classList.toggle('pt-red', !mark.up);

    // Flash when the underlying price moves, but color by TOTAL position P&L,
    // never by tick direction. A losing position stays red during a bounce;
    // a profitable position stays green during a pullback.
    if (lastRenderedPrice !== null && mark.price !== lastRenderedPrice) {
      const cls = mark.up ? 'pt-flash-up' : 'pt-flash-down';
      posEls.pnl.classList.remove('pt-flash-up', 'pt-flash-down');
      // Force a reflow so the animation restarts on consecutive ticks.
      void posEls.pnl.offsetWidth;
      posEls.pnl.classList.add(cls);
    }
    renderPositionLedger(pos, mark);
    renderSellInitial();
    lastRenderedPrice = mark.price;
  }

  /**
   * Invested / sold / remaining / change, for a round that has been sold into.
   *
   * Hidden until the first partial sell: before then it would restate the
   * Position size and Unrealized P&L rows directly above it in different
   * words. It earns its space the moment some of the bag has been returned,
   * which is when "am I ahead overall" stops being the same question as
   * "is this position up".
   */
  /** The live sell-initial plan for the open position, or null. */
  function currentInitialPlan() {
    const pos = token && state.positions[token.mint];
    if (!pos) return null;
    const mark = Q.positionMark(pos, token.priceNative, token.priceUsd);
    if (!mark) return null;
    const led = Q.positionLedger(state.journal, pos, mark.valueSol);
    return Q.sellInitialPlan(pos, led, mark.price, {
      feeBps: settings.feeBps,
      slippageBps: settings.slippageBps,
      flatSol: E.txCostSol(settings),
    });
  }

  /**
   * The sell-initial control.
   *
   * Absent while there is nothing to recover — a round already returning
   * more than it cost has no initial left to take off the table. Present but
   * refusing when the whole bag could not cover it: that is a fact about the
   * position worth stating, and a button that silently sold 100% while
   * calling it a recovery would be the exact lie this feature exists to
   * prevent.
   */
  function renderSellInitial() {
    if (!posEls || !posEls.initial) return;
    const btn = posEls.initial;
    const plan = currentInitialPlan();
    // Always on screen, never hidden — a control that comes and goes cannot
    // be reached for. It goes inert with a reason instead.
    btn.classList.remove('pt-hidden');
    if (!plan) {
      btn.disabled = true;
      btn.classList.remove('pt-short');
      btn.textContent = 'Sell init';
      btn.title = 'Nothing left to recover — the sells have already returned what went in.';
      return;
    }

    if (plan.shortfall) {
      btn.disabled = true;
      btn.classList.add('pt-short');
      btn.textContent = 'Sell init';
      btn.title = 'Selling the whole position would still return less than went in.';
      return;
    }
    btn.disabled = false;
    btn.classList.remove('pt-short');
    const pct = plan.fraction * 100;
    btn.textContent = `Sell init ${pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%`;
    btn.title = 'Sells just enough to take back what you put in, costs included — '
      + 'the rest of the bag becomes house money.';
  }
  /**
   * The card with nothing held.
   *
   * Every figure is an em dash rather than a zero. A zero is a measurement
   * — it says the position is worth nothing — and there is no position to
   * measure. The controls stay on screen and go inert, so the panel has one
   * shape whether or not a bag is open.
   */
  /** Arm or disarm the quick-sell ladder. Direct children, not a selector:
   *  the buttons are appended straight into the row, and reading them this
   *  way behaves identically in a real DOM and under test. */
  function setSellLadderEnabled(on) {
    if (!posEls || !posEls.sellRow) return;
    for (const b of Array.from(posEls.sellRow.children || [])) {
      if (b && b.className === 'pt-sell') b.disabled = !on;
    }
  }
  function renderEmptyPosition() {
    if (!posEls) return;
    const DASH = '—';
    posEls.qty.textContent = DASH;
    posEls.entry.textContent = DASH;
    posEls.value.textContent = DASH;
    posEls.pnl.textContent = DASH;
    posEls.pnl.classList.remove('pt-green', 'pt-red', 'pt-flash-up', 'pt-flash-down');

    if (posEls.ledger) {
      posEls.ledger.classList.remove('pt-hidden', 'pt-house');
      posEls.ledIn.textContent = DASH;
      posEls.ledOut.textContent = DASH;
      posEls.ledLeft.textContent = DASH;
      posEls.ledChg.textContent = DASH;
      posEls.ledChg.classList.remove('pt-green', 'pt-red');
    }
    if (posEls.initial) {
      posEls.initial.classList.remove('pt-hidden', 'pt-short');
      posEls.initial.disabled = true;
      posEls.initial.textContent = 'Sell init';
      posEls.initial.title = 'Nothing held yet — this sells just enough to take back what you put in.';
    }
    setSellLadderEnabled(false);
    if (posEls.orders) posEls.orders.classList.add('pt-hidden');
    lastRenderedPrice = null;
  }
  function renderPositionLedger(pos, mark) {
    if (!posEls || !posEls.ledger) return;
    const led = Q.positionLedger(state.journal, pos, mark.valueSol);
    // Always on screen. It used to appear only after the first partial sell,
    // so the row the trader was looking for arrived exactly when they were
    // busy. Before a sell, `sold` is honestly zero — money genuinely has not
    // come back — while invested and remaining are real from the first fill.
    posEls.ledger.classList.remove('pt-hidden');
    if (!led) return;

    // The panel speaks the venue's currency: dollars off Solana, SOL on it.
    const rate = panelUsd() ? panelUsdRate() : null;
    const money = (sol) => (rate ? E.fmtUsd(sol * rate) : `${E.fmt(sol, 3)} SOL`);

    posEls.ledIn.textContent = money(led.investedSol);
    posEls.ledOut.textContent = money(led.soldSol);
    posEls.ledLeft.textContent = money(led.remainingSol);

    const up = led.changeSol >= 0;
    posEls.ledChg.textContent = `${up ? '+' : ''}${money(led.changeSol)}`
      + ` (${up ? '+' : ''}${led.changePct.toFixed(0)}%)`;
    posEls.ledChg.classList.toggle('pt-green', up);
    posEls.ledChg.classList.toggle('pt-red', !up);
    // Once the sells alone cover what went in, the rest of the bag is
    // house money — worth saying, because it changes how it should be held.
    posEls.ledger.classList.toggle('pt-house', led.houseMoney);
  }
  /**
   * Keep the newest realized result visible after a sell. Full exits show the
   * complete round-trip result; partial exits show the realized slice.
   */
  let closedRenderKey = null;

  function renderClosedPnl() {
    if (!els.closed) return;
    const closed = token && E.latestClosedPnl(state, token.mint);
    if (!closed) {
      closedRenderKey = null;
      if (els.closed.childNodes.length) els.closed.textContent = '';
      return;
    }

    // Rebuilding the card on every heartbeat re-ran its entry animation —
    // the reported "blinking". Same result: only the ago-text updates,
    // in place; the card itself renders ONCE per close.
    const key = `${closed.kind}·${closed.closedAt}·${closed.pnlSol}`;
    if (key === closedRenderKey && els.closed.childNodes.length) {
      const agoMeta = els.closed.querySelector('.pt-closed-meta');
      if (agoMeta) agoMeta.textContent = `Returned ${E.fmt(closed.returnedSol, 4)} SOL · ${closedAgo(closed.closedAt)}`;
      return;
    }
    closedRenderKey = key;

    const sign = closed.pnlSol >= 0 ? '+' : '';
    const pctSign = closed.pnlPct >= 0 ? '+' : '';
    const badge = closed.kind === 'round' ? 'POSITION CLOSED' : 'PARTIAL EXIT';

    els.closed.textContent = '';
    const card = document.createElement('div');
    card.className = 'pt-closed';

    const head = document.createElement('div');
    head.className = 'pt-closed-head';
    const title = document.createElement('span');
    title.className = 'pt-closed-title';
    title.textContent = 'Closed P&L';
    const right = document.createElement('span');
    right.style.display = 'inline-flex';
    right.style.alignItems = 'center';
    const status = document.createElement('span');
    status.className = 'pt-closed-badge';
    status.textContent = badge;
    // Process grade chip (GAMIFY.md) — computed HERE, inside the once-per-
    // close keyed build, so the O(rounds) grade scan never rides a heartbeat.
    // Full closes only: partial exits are not rounds and are never graded.
    if (closed.kind === 'round' && gamingOn() && window.PTGamify && token) {
      const gradedRound = (state.rounds || []).find(
        (r) => r.mint === token.mint && Number(r.closedAt) === Number(closed.closedAt));
      const grade = gradedRound ? window.PTGamify.roundGrade(state, gradedRound) : null;
      if (grade) {
        const chip = document.createElement('span');
        chip.className = `pt-grade pt-grade-${grade.letter.toLowerCase()}`;
        chip.textContent = grade.luckyWin ? `${grade.letter} · LUCKY` : grade.letter;
        chip.title = grade.parts.length
          ? grade.parts.map((p) => p.note).join(' ')
          : (closed.pnlSol < 0 ? 'Red round, clean process — that’s the job.' : 'Clean process.');
        // right is still empty here — status/flex are appended below, so a
        // plain append yields chip → status → flex. (insertBefore(chip,
        // status) threw NotFoundError in real DOM: status was not yet a
        // child. The fake-DOM harness is lenient exactly where Chrome isn't.)
        right.appendChild(chip);
      }
    }
    // Flex the result — wins AND losses ("people might wanna flex their
    // losses also"). The composer floats right here, centered over the page
    // — no tab switch. It cards the newest round for the mint, or the open
    // position after a partial exit.
    const flex = document.createElement('button');
    flex.className = 'pt-flex-btn';
    flex.textContent = 'Flex';
    flex.title = 'Open the share card for this result';
    flex.addEventListener('click', () => {
      if (token && token.mint) openFlexComposer(token.mint);
    });
    right.appendChild(status);
    right.appendChild(flex);
    head.appendChild(title);
    head.appendChild(right);

    const pnl = document.createElement('div');
    pnl.className = `pt-closed-pnl ${closed.pnlSol >= 0 ? 'pt-green' : 'pt-red'}`;
    pnl.textContent = `${sign}${E.fmt(closed.pnlSol)} SOL (${pctSign}${closed.pnlPct.toFixed(1)}%)`;

    const meta = document.createElement('div');
    meta.className = 'pt-closed-meta';
    meta.textContent = `Returned ${E.fmt(closed.returnedSol, 4)} SOL · ${closedAgo(closed.closedAt)}`;

    card.appendChild(head);
    card.appendChild(pnl);
    card.appendChild(meta);
    els.closed.appendChild(card);
  }

  function closedAgo(ts) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  /* -------------------- Flex composer (in-page) --------------------
   *
   * The share-card composer floats over the terminal in a centered modal
   * instead of opening a dashboard tab. It is the SAME composer: pnlcard.js
   * builds the source and paints the canvas (identical numbers, identical
   * pixels), prefs persist to the same settings.cardPrefs, and uploaded
   * backgrounds live in the same extension-origin gallery — a content
   * script's IndexedDB belongs to the SITE origin, so gallery reads/writes
   * ride pt_cardbg_* messages through the service worker, which opens the
   * very database the dashboard reads directly.
   */
  let flexEls = null;      // built lazily on first Flex, dies with the shadow root
  let flexSource = null;
  let flexModel = null;
  let flexPrefs = null;    // working copy of settings.cardPrefs while open
  let flexMedia = null;    // Image element for an uploaded background
  let flexTrench = null;   // PTGamify-derived rank/grade/badges for the open card
  let flexUploads = [];    // [{id, name, dataUrl}] served by the worker

  const FLEX_FLAGS = [
    ['showSymbol', 'Symbol'],
    ['showInvested', 'Invested'],
    ['showReturned', 'Returned'],
    ['showPercent', 'P&L %'],
    ['showUsd', 'USD sub-lines'],
    ['showDate', 'Date'],
    ['showAfter', 'After-exit line'],
    ['showTrench', 'Rank & grade'],
  ];

  function onFlexKeydown(e) {
    if (e.key === 'Escape') closeFlexComposer();
  }

  function flexMsg(text) {
    if (!flexEls) return;
    flexEls.msg.textContent = text || '';
    flexEls.msg.style.display = text ? '' : 'none';
  }

  function buildFlexComposer() {
    if (!shadow || !PC) return;
    const wrap = document.createElement('div');
    wrap.className = 'pt-flex-modal';
    // Wave 1: a control that can never do anything must not render — the
    // trench flag only exists for gaming users.
    const flags = FLEX_FLAGS
      .filter(([key]) => key !== 'showTrench' || gamingOn())
      .map(([key, label]) => `<label><input type="checkbox" data-flag="${key}"> ${label}</label>`).join('');
    const accents = Object.keys(PC.ACCENTS).map((name) =>
      `<button class="pt-accent-swatch" data-accent="${name}" title="${name}" style="background:${PC.ACCENTS[name]}"></button>`).join('');
    wrap.innerHTML = `
      <div class="pt-flex-inner">
        <div class="pt-flex-title">
          <span>Share P&amp;L card</span>
          <button class="pt-flex-close" title="Close (Esc)">✕</button>
        </div>
        <canvas class="pt-flex-canvas" width="${PC.WIDTH}" height="${PC.HEIGHT}"></canvas>
        <div class="pt-flex-gallery"></div>
        <div class="pt-flex-controls">
          <button class="pt-fbtn pt-flex-customize">Customize</button>
          <button class="pt-fbtn pt-flex-copy">Copy</button>
          <button class="pt-fbtn pt-primary pt-flex-download">Download PNG</button>
          <input type="file" accept="image/*" style="display:none">
        </div>
        <div class="pt-flex-custom pt-hidden">${flags}
          <span style="display:inline-flex;gap:5px;align-items:center"><span style="font-size:10px">Trim</span>${accents}</span>
        </div>
        <p class="pt-flex-msg" style="display:none"></p>
        <p class="pt-flex-note">The <strong>PAPER</strong> watermark and the PaperTrench brand bar are
        always drawn — no setting turns them off — so a shared paper trade can never be mistaken
        for a real one. A GIF renders as a still (its first frame).</p>
      </div>`;
    shadow.appendChild(wrap);

    flexEls = {
      wrap,
      canvas: wrap.querySelector('.pt-flex-canvas'),
      gallery: wrap.querySelector('.pt-flex-gallery'),
      custom: wrap.querySelector('.pt-flex-custom'),
      msg: wrap.querySelector('.pt-flex-msg'),
      file: wrap.querySelector('input[type="file"]'),
      copy: wrap.querySelector('.pt-flex-copy'),
    };

    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeFlexComposer(); });
    wrap.querySelector('.pt-flex-close').addEventListener('click', closeFlexComposer);
    wrap.querySelector('.pt-flex-customize').addEventListener('click', () => {
      flexEls.custom.classList.toggle('pt-hidden');
    });
    flexEls.copy.addEventListener('click', copyFlexCard);
    wrap.querySelector('.pt-flex-download').addEventListener('click', downloadFlexCard);
    flexEls.file.addEventListener('change', () => {
      adoptFlexUpload(flexEls.file.files && flexEls.file.files[0]);
      // Re-picking the same file must fire change again.
      flexEls.file.value = '';
    });
    wrap.querySelectorAll('input[data-flag]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!flexPrefs) return;
        // Stored as false only when hidden — an absent key stays "shown".
        if (input.checked) delete flexPrefs[input.dataset.flag];
        else flexPrefs[input.dataset.flag] = false;
        paintFlexCard();
        persistFlexPrefs();
      });
    });
    wrap.querySelectorAll('.pt-accent-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        if (!flexPrefs) return;
        flexPrefs.accent = swatch.dataset.accent;
        syncFlexCustomize();
        paintFlexCard();
        persistFlexPrefs();
      });
    });
  }

  /**
   * Open the composer for a mint: the open position if one exists (the
   * partial-exit case — realized slice banked, still holding), else the
   * newest closed round. Same routing the dashboard uses.
   */
  function openFlexComposer(mint) {
    if (!PC || !shadow || !mint) return;
    const pos = state.positions && state.positions[mint];
    let source = null;
    let trenchRound = null;
    if (pos) {
      source = PC.positionCardSource(pos, state.journal, {
        pnlSol: E.unrealizedPnl(pos),
        pnlPct: E.positionPnlPct(pos),
        avgBuyNative: (E.averageFillPrices(state, mint) || {}).avgBuyNative,
      }, Date.now());
    } else {
      // state.rounds is newest-first (engine unshifts on close).
      const round = (state.rounds || []).find((r) => r.mint === mint);
      if (round) source = PC.roundCardSource(round, state.journal);
      trenchRound = round || null;
    }
    if (!source) return;

    // Same derived-display shape the dashboard composer passes — one
    // implementation (PTGamify), two callers, zero drift (GAMIFY.md).
    flexTrench = null;
    if (gamingOn() && window.PTGamify) {
      const G = window.PTGamify;
      const grade = trenchRound ? G.roundGrade(state, trenchRound) : null;
      const r = G.rank(state);
      const earned = G.badges(state).filter((b) => b.earned).slice(0, 4).map((b) => b.label);
      if (grade || r || earned.length) {
        flexTrench = {
          gradeLetter: grade ? grade.letter : null,
          luckyWin: Boolean(grade && grade.luckyWin),
          rankName: r ? r.name : null,
          badges: earned,
        };
      }
    }

    flexSource = source;
    flexPrefs = { ...(settings.cardPrefs || {}) };
    flexMedia = null;
    if (!flexEls) buildFlexComposer();
    if (!flexEls || !paintFlexCard()) return;
    flexEls.wrap.classList.add('pt-open');
    window.addEventListener('keydown', onFlexKeydown, true);
    flexMsg('');
    syncFlexCustomize();
    refreshFlexGallery();
  }

  function closeFlexComposer() {
    window.removeEventListener('keydown', onFlexKeydown, true);
    if (flexEls) flexEls.wrap.classList.remove('pt-open');
  }

  /** Rebuild the model and repaint — numbers still come only from the source. */
  function paintFlexCard() {
    if (!flexEls || !flexSource) return false;
    const ctx2d = flexEls.canvas.getContext && flexEls.canvas.getContext('2d');
    if (!ctx2d) return false;
    flexModel = PC.cardModel(flexSource, {
      handle: (settings.leaderboardIdentity || {}).handle || '',
      prefs: flexPrefs || settings.cardPrefs || {},
      trench: flexTrench,
    });
    if (!flexModel) return false;
    PC.drawCard(ctx2d, flexModel, flexMedia);
    return true;
  }

  /** Same key the dashboard composer persists — prefs follow the user. */
  function persistFlexPrefs() {
    if (!flexPrefs) return;
    settings.cardPrefs = { ...flexPrefs };
    store.set({ [E.STORAGE_KEYS.settings]: settings });
  }

  function syncFlexCustomize() {
    if (!flexEls) return;
    const prefs = flexPrefs || {};
    flexEls.wrap.querySelectorAll('input[data-flag]').forEach((input) => {
      input.checked = prefs[input.dataset.flag] !== false;
    });
    const active = PC.ACCENTS[prefs.accent] ? prefs.accent : 'amber';
    flexEls.wrap.querySelectorAll('.pt-accent-swatch').forEach((swatch) => {
      swatch.classList.toggle('pt-selected', swatch.dataset.accent === active);
    });
  }

  /** Load one stored upload (a data URL from the worker) into an Image. */
  function showFlexUpload(record) {
    return new Promise((resolve) => {
      if (!record || typeof record.dataUrl !== 'string' || !record.dataUrl) { resolve(false); return; }
      const img = new Image();
      img.onload = () => { flexMedia = img; resolve(true); };
      // A broken/unsupported file must not wipe the card.
      img.onerror = () => resolve(false);
      img.src = record.dataUrl;
    });
  }

  /** Adopt a gallery selection: a built-in id or 'upload:<id>'. */
  async function selectFlexBackground(choice) {
    if (!flexPrefs) return;
    if (String(choice).startsWith('upload:')) {
      const record = flexUploads.find((r) => 'upload:' + r.id === choice);
      if (!record || !(await showFlexUpload(record))) return;
    } else {
      flexMedia = null;
    }
    flexPrefs.background = choice;
    paintFlexCard();
    renderFlexGallery();
    persistFlexPrefs();
  }

  /** Pull the shared gallery from the worker, restore a persisted pick. */
  function refreshFlexGallery() {
    sendMessage({ type: 'pt_cardbg_list' }).then(async (res) => {
      if (res && res.ok && Array.isArray(res.items)) {
        flexUploads = res.items;
      } else {
        flexUploads = [];
        if (res && res.error) flexMsg('The background gallery is unavailable — built-ins still work.');
      }
      const chosen = flexPrefs && flexPrefs.background;
      if (typeof chosen === 'string' && chosen.startsWith('upload:')) {
        const record = flexUploads.find((r) => 'upload:' + r.id === chosen);
        if (record) {
          if (await showFlexUpload(record)) paintFlexCard();
        } else {
          // The stored pick was deleted elsewhere; fall back to the plain card.
          flexPrefs.background = null;
        }
      }
      renderFlexGallery();
    });
  }

  function renderFlexGallery() {
    if (!flexEls) return;
    const host = flexEls.gallery;
    const selected = (flexPrefs && flexPrefs.background) || 'void';
    host.textContent = '';
    for (const bg of PC.BACKGROUNDS) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pt-flex-thumb' + (bg.id === selected ? ' pt-selected' : '');
      tile.title = bg.name;
      const canvas = document.createElement('canvas');
      canvas.width = 120; canvas.height = 68;
      const tctx = canvas.getContext && canvas.getContext('2d');
      if (tctx) PC.paintBackground(tctx, bg.id, 120, 68);
      tile.appendChild(canvas);
      tile.addEventListener('click', () => { selectFlexBackground(bg.id); });
      host.appendChild(tile);
    }
    for (const record of flexUploads) {
      const choice = 'upload:' + record.id;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'pt-flex-thumb' + (choice === selected ? ' pt-selected' : '');
      tile.title = record.name;
      const img = document.createElement('img');
      img.src = record.dataUrl;
      img.alt = record.name;
      tile.appendChild(img);
      const del = document.createElement('span');
      del.className = 'pt-del';
      del.textContent = '×';
      del.title = 'Delete this background';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteFlexUpload(choice);
      });
      tile.appendChild(del);
      tile.addEventListener('click', () => { selectFlexBackground(choice); });
      host.appendChild(tile);
    }
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'pt-flex-thumb';
    up.innerHTML = `<span class="pt-flex-up"><span>Upload image</span><span>Max 2 MB · ${flexUploads.length}/${PC.MAX_UPLOADS}</span></span>`;
    up.addEventListener('click', () => { flexEls.file.click(); });
    host.appendChild(up);
  }

  async function deleteFlexUpload(choice) {
    const id = String(choice).replace(/^upload:/, '');
    await sendMessage({ type: 'pt_cardbg_remove', id });
    flexUploads = flexUploads.filter((r) => r.id !== id);
    if (flexPrefs && flexPrefs.background === choice) {
      // The selected background is gone; drop to the plain card, honestly.
      await selectFlexBackground('void');
    } else {
      renderFlexGallery();
    }
  }

  /**
   * A picked file goes THROUGH the shared gallery: admitted locally first
   * (PC.admitUpload — instant, visible refusals), shipped to the worker as a
   * data URL, re-checked there, persisted, then selected. If the gallery
   * itself fails, the image is still used for this one card.
   */
  function adoptFlexUpload(file) {
    if (!file) return;
    const verdict = PC.admitUpload(file, flexUploads.length);
    if (!verdict.ok) { flexMsg(verdict.reason); return; }
    flexMsg('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      sendMessage({
        type: 'pt_cardbg_add',
        name: String(file.name || 'background'),
        dataUrl,
      }).then((res) => {
        if (res && res.ok && res.record) {
          flexUploads.push(res.record);
          selectFlexBackground('upload:' + res.record.id);
          return;
        }
        if (res && res.reason) { flexMsg(res.reason); return; }
        flexMsg('Could not save to the gallery — using the image for this card only.');
        showFlexUpload({ dataUrl }).then((ok) => { if (ok) paintFlexCard(); });
      });
    };
    reader.onerror = () => flexMsg('That file could not be read.');
    reader.readAsDataURL(file);
  }

  /**
   * Copy the card PNG. The ClipboardItem is created inside the click gesture
   * with a Promise payload — awaiting toBlob first would leave the gesture
   * and Chrome would refuse the write (same discipline as the dashboard).
   */
  function copyFlexCard() {
    if (!flexEls || !flexModel) return;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
      flexMsg('Copying images is not supported in this browser — use Download PNG instead.');
      return;
    }
    const png = new Promise((resolve, reject) => {
      flexEls.canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG encode failed'));
      }, 'image/png');
    });
    navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      .then(() => {
        flexMsg('');
        flexEls.copy.textContent = 'Copied ✓';
        setTimeout(() => { if (flexEls) flexEls.copy.textContent = 'Copy'; }, 2000);
      })
      .catch(() => {
        flexMsg('Copy failed — the browser refused clipboard access. Use Download PNG instead.');
      });
  }

  function downloadFlexCard() {
    if (!flexEls || !flexModel) return;
    const link = document.createElement('a');
    link.download = `papertrench-${flexModel.symbol}-${flexModel.multipleText}.png`;
    link.href = flexEls.canvas.toDataURL('image/png');
    link.click();
  }

  /** Build the static structure of the position card exactly once. */
  function buildPositionCard(pos) {
    // Null the cache BEFORE clearing the container. Otherwise posEls keeps
    // referencing nodes from the previous card after textContent='' detaches
    // them, and every subsequent renderPosition() writes to ghosts while the
    // live card's sell buttons sit untouched. Reported: "sell button
    // disappearing" — the buttons were being built but never wired because
    // the stale cache short-circuited the rebuild.
    posEls = null;
    // Same reason as posEls above: the TP/SL nodes are about to be detached,
    // and a stale cache would leave renderOrderList writing into ghosts.
    posOrderEls = null;
    els.position.textContent = '';
    const card = document.createElement('div');
    card.className = 'pt-pos';
    card.innerHTML = `
      <div class="row pt-detail"><span class="k">Position size</span><span class="v big" data-f="qty"></span></div>
      <div class="row pt-detail"><span class="k">Avg entry</span><span class="v" data-f="entry"></span></div>
      <div class="row pt-detail"><span class="k">Value</span><span class="v" data-f="value"></span></div>
      <div class="row row-pnl"><span class="k">Unrealized P&amp;L</span><span class="v pnl" data-f="pnl"></span></div>
      <div class="pt-ledger" data-f="ledger">
        <div class="pt-led"><span class="k">Invested</span><span class="v" data-f="led-in"></span></div>
        <div class="pt-led"><span class="k">Sold</span><span class="v" data-f="led-out"></span></div>
        <div class="pt-led"><span class="k">Remaining</span><span class="v" data-f="led-left"></span></div>
        <div class="pt-led"><span class="k">P&amp;L change</span><span class="v" data-f="led-chg"></span></div>
      </div>
      <div class="pt-label" style="margin-top:10px">Quick sell</div>
      <div class="pt-sell-row" data-f="sell"></div>
      <button class="pt-sell-initial pt-hidden" data-f="initial" type="button"></button>
    `;
    els.position.appendChild(card);

    posEls = {
      qty: card.querySelector('[data-f="qty"]'),
      entry: card.querySelector('[data-f="entry"]'),
      value: card.querySelector('[data-f="value"]'),
      pnl: card.querySelector('[data-f="pnl"]'),
      ledger: card.querySelector('[data-f="ledger"]'),
      ledIn: card.querySelector('[data-f="led-in"]'),
      ledOut: card.querySelector('[data-f="led-out"]'),
      ledLeft: card.querySelector('[data-f="led-left"]'),
      ledChg: card.querySelector('[data-f="led-chg"]'),
      initial: card.querySelector('[data-f="initial"]'),
      sellRow: card.querySelector('[data-f="sell"]'),
    };

    const row = card.querySelector('[data-f="sell"]');
    (settings.sellPcts || [25, 50, 75, 100]).forEach((p) => {
      const b = document.createElement('button');
      b.className = 'pt-sell';
      b.textContent = p + '%';
      b.addEventListener('click', () => {
        primeAudio();
        doSell(p / 100);
      });
      row.appendChild(b);
    });

    // Sell exactly enough to have the money that went in back out.
    const initialBtn = card.querySelector('[data-f="initial"]');
    if (initialBtn) {
      initialBtn.addEventListener('click', () => {
        const plan = currentInitialPlan();
        // Refused rather than approximated: a shortfall sold as if it were a
        // recovery is the one outcome this button must never produce.
        if (!plan || plan.shortfall) return;
        primeAudio();
        doSell(plan.fraction);
      });
    }

    buildOrdersSection(card);
  }

  /**
   * The take-profit / stop-loss section of the position card.
   *
   * The chart is the primary surface — a tap here puts a DRAGGABLE line on
   * it, which is then moved to the exact level by hand, Padre style. The
   * percentages are the fast path, not the only path: nobody wants to type a
   * price for a coin quoted in nine decimal places.
   *
   * On a chart that cannot carry a draggable line (F-39), the section says
   * so plainly instead of offering a control that would silently do nothing.
   */
  function buildOrdersSection(card) {
    if (!chartOrdersOn()) return;

    const wrap = document.createElement('div');
    wrap.className = 'pt-orders';
    wrap.innerHTML = `
      <div class="pt-label" style="margin-top:10px">Take profit / Stop loss</div>
      <div class="pt-order-kind" data-f="kind">
        <button class="pt-okind pt-okind-on" data-kind="tp">TAKE PROFIT</button>
        <button class="pt-okind" data-kind="sl">STOP LOSS</button>
      </div>
      <div class="pt-order-pcts" data-f="pcts"></div>
      <div class="pt-order-hint" data-f="hint"></div>
      <div class="pt-order-list" data-f="list"></div>
    `;
    card.appendChild(wrap);

    let kind = 'tp';
    const kindRow = wrap.querySelector('[data-f="kind"]');
    const pctRow = wrap.querySelector('[data-f="pcts"]');
    const hint = wrap.querySelector('[data-f="hint"]');

    // Take profits are quoted as gains above entry, stops as losses below —
    // the ladders are NOT mirror images of each other, because nobody arms a
    // -200% stop and nobody arms a +10% take profit on a memecoin.
    const TP_STEPS = [25, 50, 100, 200];
    const SL_STEPS = [10, 20, 35, 50];

    const paintPcts = () => {
      pctRow.textContent = '';
      const steps = kind === 'tp' ? TP_STEPS : SL_STEPS;
      steps.forEach((pct) => {
        const b = document.createElement('button');
        b.className = 'pt-opct';
        b.textContent = (kind === 'tp' ? '+' : '−') + pct + '%';
        b.addEventListener('click', () => armFromPercent(kind, pct));
        pctRow.appendChild(b);
      });
    };

    kindRow.querySelectorAll('.pt-okind').forEach((b) => {
      b.addEventListener('click', () => {
        kind = b.dataset.kind;
        kindRow.querySelectorAll('.pt-okind').forEach((x) =>
          x.classList.toggle('pt-okind-on', x === b));
        paintPcts();
      });
    });

    paintPcts();
    hint.textContent = chartOrdersDraggable
      ? 'Tap a level, then drag the line on the chart to place it exactly.'
      : 'This chart cannot carry a draggable line — levels are set here.';

    posOrderEls = { list: wrap.querySelector('[data-f="list"]'), hint };
    renderOrderList();
  }

  /**
   * Arm a level a percentage away from the AVERAGE ENTRY.
   *
   * From entry, not from the live price: "+50%" means "up 50% on this trade",
   * which is the question a trader is actually asking. Measuring from the
   * live price would make the same button mean something different every
   * tick, and a +50% take profit could land BELOW the entry on a position
   * already deep in profit.
   */
  async function armFromPercent(kind, pct) {
    if (!token || !token.mint) return toast('No token detected on this page');
    const averages = E.averageFillPrices(state, token.mint);
    const entry = averages && Number(averages.avgBuyNative) > 0 ? Number(averages.avgBuyNative) : null;
    if (!entry) return toast('No average entry yet — set the level by dragging on the chart');
    const trigger = kind === 'tp' ? entry * (1 + pct / 100) : entry * (1 - pct / 100);
    try {
      await armChartOrder(kind, trigger, 100);
      const mcap = mcapAtPrice(trigger);
      toast(`${kind === 'tp' ? 'Take profit' : 'Stop loss'} armed at ${mcap ? fmtMoney(mcap) + ' MC' : E.fmt(trigger, 8) + ' SOL'}`
        + (chartOrdersDraggable ? ' — drag it on the chart to adjust' : ''));
    } catch (err) {
      toast(err.message || 'That level could not be armed');
    }
  }

  /** The armed set, listed under the buttons with a cancel on each. */
  function renderOrderList() {
    if (!posOrderEls || !posOrderEls.list) return;
    const orders = currentOrders();
    posOrderEls.list.textContent = '';
    if (!orders.length) return;

    orders.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'pt-order-row';

      const tag = document.createElement('span');
      tag.className = 'pt-otag ' + (o.kind === 'tp' ? 'pt-otag-tp' : 'pt-otag-sl');
      tag.textContent = o.kind === 'tp' ? 'TP' : 'SL';

      const level = document.createElement('span');
      level.className = 'pt-olevel';
      const mcap = mcapAtPrice(o.triggerPrice);
      level.textContent = (mcap ? fmtMoney(mcap) + ' MC' : E.fmt(o.triggerPrice, 8) + ' SOL')
        + (o.sizePct >= 100 ? '' : ` · ${o.sizePct}%`);

      const kill = document.createElement('button');
      kill.className = 'pt-okill';
      kill.textContent = '✕';
      kill.title = 'Cancel this order';
      kill.addEventListener('click', () => cancelChartOrder(o.id));

      row.append(tag, level, kill);
      posOrderEls.list.appendChild(row);
    });
  }

  /* -------------------- market-cap alerts -------------------- */

  // Structure is built once and the list repainted, so a half-typed level
  // survives the heartbeat's re-render.
  let alertEls = null;
  let alertKind = 'above';
  // Alert ids whose fire-claim is mid-flight. In memory only and deliberately
  // so: it guards one tab's re-entrancy, while the CROSS-tab claim is the seq
  // protocol in storage. Two different races, two different mechanisms.
  const alertClaimsInFlight = new Set();

  function mcAlertsOn() {
    return settings.appEnabled !== false && settings.mcAlertsEnabled !== false;
  }

  function currentAlerts() {
    return token && token.mint ? E.alertsFor(state, token.mint) : [];
  }

  /**
   * Read a market cap the way a trader types one: 500k, 1.2M, 850000, 2,4M.
   *
   * A bare number is taken at face value, so "500000" and "500k" agree. This
   * deliberately does NOT guess at a magnitude for small bare numbers —
   * reading "500" as 500K would silently arm a level a thousand times away
   * from the one that was typed.
   */
  function parseCapInput(raw) {
    if (typeof raw !== 'string') return null;
    // Comma as a decimal separator (2,4M) and as a thousands separator
    // (1,200,000) are both common; a comma followed by exactly one or two
    // digits at the end is a decimal, otherwise it is grouping.
    let text = raw.trim().toLowerCase().replace(/[$\s]/g, '');
    if (!text) return null;
    text = /,\d{1,2}[kmb]?$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');

    const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(text);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const scale = match[2] === 'b' ? 1e9 : match[2] === 'm' ? 1e6 : match[2] === 'k' ? 1e3 : 1;
    return value * scale;
  }

  /** The market cap the alert model should compare against, right now. */
  function liveCapReference() {
    return {
      mcap: Number(token && token.mcap) > 0 ? Number(token.mcap) : null,
      priceNative: Number(token && token.priceNative) > 0 ? Number(token.priceNative) : null,
    };
  }

  function renderAlerts() {
    if (!els.alerts) return;
    if (!mcAlertsOn() || !token || !token.mint) {
      els.alerts.textContent = '';
      alertEls = null;
      return;
    }
    if (!alertEls) buildAlertsSection();
    // Repainted every render, not just at build: the hint quotes the LIVE cap
    // ("Now $412.0K"), which is the number the user is about to type a level
    // relative to. Painting it once would freeze it at whatever the market
    // read when the panel mounted.
    paintAlertHint();
    paintAlertList();
  }

  function buildAlertsSection() {
    els.alerts.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'pt-alerts';
    wrap.innerHTML = `
      <div class="pt-label" style="margin-top:10px">Market cap alert</div>
      <div class="pt-alert-arm" data-f="kind">
        <button class="pt-akind pt-akind-on" data-kind="above">ALERT ABOVE</button>
        <button class="pt-akind" data-kind="below">ALERT BELOW</button>
      </div>
      <div class="pt-alert-entry">
        <input class="pt-alert-input" data-f="level" type="text" inputmode="decimal"
               placeholder="500K" aria-label="Alert market cap">
        <button class="pt-alert-add" data-f="add">ALERT ME</button>
      </div>
      <div class="pt-alert-hint" data-f="hint"></div>
      <div data-f="list"></div>
    `;
    els.alerts.appendChild(wrap);

    const kindRow = wrap.querySelector('[data-f="kind"]');
    kindRow.querySelectorAll('.pt-akind').forEach((b) => {
      b.addEventListener('click', () => {
        alertKind = b.dataset.kind;
        kindRow.querySelectorAll('.pt-akind').forEach((x) =>
          x.classList.toggle('pt-akind-on', x === b));
        paintAlertHint();
      });
    });

    const input = wrap.querySelector('[data-f="level"]');
    const add = wrap.querySelector('[data-f="add"]');
    add.addEventListener('click', () => armMcAlertFromInput(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); armMcAlertFromInput(input); }
    });

    alertEls = {
      wrap,
      kindRow,
      input,
      hint: wrap.querySelector('[data-f="hint"]'),
      list: wrap.querySelector('[data-f="list"]'),
    };
    // The stored preference survives a rebuild (nav, position open/close).
    kindRow.querySelectorAll('.pt-akind').forEach((x) =>
      x.classList.toggle('pt-akind-on', x.dataset.kind === alertKind));
    paintAlertHint();
  }

  /**
   * Say plainly where the ping will land, and — when the host page has no
   * notification permission to lend — say that too, BEFORE an alert is armed
   * rather than after one silently fails to arrive.
   */
  function paintAlertHint() {
    if (!alertEls || !alertEls.hint) return;
    const cap = Number(token && token.mcap) > 0 ? fmtMoney(token.mcap) : null;
    const where = cap ? `Now ${cap}. ` : '';
    alertEls.hint.textContent = where + (desktopAlertState() === 'denied'
      ? 'This site blocked notifications — alerts will show in the panel instead.'
      : 'Fires once, from any open terminal tab, whatever chart you are on.');
  }

  function paintAlertList() {
    if (!alertEls || !alertEls.list) return;
    const alerts = currentAlerts();
    alertEls.list.textContent = '';
    if (!alerts.length) return;

    alerts.forEach((a) => {
      const row = document.createElement('div');
      row.className = 'pt-alert-row';

      const tag = document.createElement('span');
      tag.className = 'pt-atag' + (a.firedAt ? ' pt-atag-fired' : '');
      tag.textContent = a.kind === 'above' ? '▲' : '▼';

      const level = document.createElement('span');
      level.className = 'pt-alevel' + (a.firedAt ? ' pt-alevel-fired' : '');
      // A fired alert reports the cap that actually tripped it beside the one
      // asked for — the same both-numbers rule a gapped stop follows.
      level.textContent = a.firedAt && a.firedAtMcap && a.firedAtMcap !== a.mcap
        ? `${fmtMoney(a.mcap)} → hit ${fmtMoney(a.firedAtMcap)}`
        : fmtMoney(a.mcap);

      const kill = document.createElement('button');
      kill.className = 'pt-akill';
      kill.textContent = '✕';
      kill.title = a.firedAt ? 'Clear this alert' : 'Cancel this alert';
      kill.addEventListener('click', () => cancelMcAlert(a.id));

      row.append(tag, level, kill);
      alertEls.list.appendChild(row);
    });
  }

  async function armMcAlertFromInput(input) {
    if (!token || !token.mint) return toast('No token detected on this page');
    const mcap = parseCapInput(input.value);
    if (!mcap) return toast('Type a market cap like 500K, 1.2M or 850000');

    // This click is the gesture that lets the chime play later; Web Audio
    // stays suspended until a user interaction unlocks it.
    primeAudio();

    // Ask for notification permission on the CLICK that arms the alert: this
    // is the only user gesture the flow has, and the browser requires one.
    // Declining is not an error — the panel toast is a working fallback.
    requestDesktopAlerts();

    try {
      const alert = await withState(async () => {
        let armed = null;
        const mutate = () => {
          armed = E.addAlert(state, token.mint, {
            kind: alertKind,
            mcap,
            symbol: token.symbol,
            chain: token.chain || 'solana',
          }, liveCapReference(), Date.now());
        };
        mutate();
        await persistStateNow(mutate);
        return armed;
      });
      input.value = '';
      renderAlerts();
      toast(`Alert armed — ${alertKind === 'above' ? 'above' : 'below'} ${fmtMoney(alert.mcap)} MC`);
    } catch (err) {
      toast(err.message || 'That alert could not be armed');
    }
  }

  async function cancelMcAlert(id) {
    if (!token || !token.mint) return;
    await withState(async () => {
      if (!E.removeAlert(state, token.mint, id)) return;
      await persistStateNow(() => E.removeAlert(state, token.mint, id));
    });
    renderAlerts();
  }

  /**
   * The host page's own notification permission is the delivery channel.
   *
   * This is how the terminals' own alerts reach you, and using the same road
   * is what lets PaperTrench ping a trader who has wandered off to another
   * chart WITHOUT asking for the `notifications` extension permission — the
   * Web Store listing's justification is unchanged by this whole feature.
   *
   * The trade-off is stated rather than hidden: the grant belongs to the
   * SITE, so a trader who has blocked notifications on that terminal gets
   * the in-panel toast instead, and the hint above the button says so before
   * an alert is ever armed.
   */
  function notificationCtor() {
    try {
      const N = window.Notification;
      // F-39 again: presence is not capability. Some hardened pages replace
      // the constructor with a stub that throws on construction, so anything
      // that is not a callable function is treated as absent HERE, rather
      // than trusted and thrown from in the middle of firing an alert.
      return typeof N === 'function' ? N : null;
    } catch (_) {
      return null;   // a page that traps property access on window
    }
  }

  function desktopAlertState() {
    const N = notificationCtor();
    if (!N) return 'unavailable';
    try {
      const p = N.permission;
      return p === 'granted' || p === 'denied' ? p : 'default';
    } catch (_) {
      return 'unavailable';
    }
  }

  /** Ask the page for notification rights. Must be called from a gesture. */
  function requestDesktopAlerts() {
    if (settings.mcAlertDesktopEnabled === false) return;
    const N = notificationCtor();
    if (!N || desktopAlertState() !== 'default') return;
    try {
      const result = N.requestPermission();
      if (result && typeof result.then === 'function') {
        result.then(() => paintAlertHint()).catch(() => {});
      }
    } catch (_) {
      /* callback-only legacy form, or a page that refuses: the toast covers it */
    }
  }

  /**
   * Hand the ping to the browser. Returns true ONLY when that succeeded, so
   * the caller never assumes a notification the trader could not have seen.
   */
  function postDesktopAlert(alert, body) {
    if (settings.mcAlertDesktopEnabled === false) return false;
    const N = notificationCtor();
    if (!N || desktopAlertState() !== 'granted') return false;
    const name = alert.symbol || E.short(alert.mint || '');
    try {
      new N(`${name} ${alert.kind === 'above' ? 'above' : 'below'} ${fmtMoney(alert.mcap)} MC`, {
        body,
        // Every open terminal tab runs this same watcher. The state claim
        // below settles which tab OWNS the fire, but two tabs can still read
        // "not yet fired" in the same instant; same-tag notifications REPLACE
        // each other, so that residual race can never show a trader two
        // pings for one level.
        tag: `pt-mc-${alert.id}`,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** A rising two-note, deliberately unlike the falling profit bell. */
  function playAlertChime() {
    if (!audioPrimed) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    playTone(ctx, 880, now, 0.24, 'sine', 0.07);
    playTone(ctx, 1318.51, now + 0.19, 0.36, 'sine', 0.08);
  }

  /**
   * Fire every alert this observation has tripped.
   *
   * Called from the two places a fresh cap can arrive: the tick path for the
   * token on screen (whose cap comes from the page's own feed) and the batch
   * poller for every other watched mint. That second path is what makes an
   * alert work while you are looking at a different chart entirely.
   */
  async function evaluateMcAlerts(mint, observed) {
    if (!mcAlertsOn() || !mint) return;
    // An alert stays "due" until markAlertFired reaches STORAGE, and every
    // tick inside that window would queue another withState — each of which
    // opens with a full state read. Crossing a level during a fast move is
    // precisely when the tab can least afford a burst of megabyte-scale
    // reads, so a claim already in flight is skipped rather than re-queued.
    //
    // Keyed by alert id rather than the single orderFireInFlight latch
    // evaluateChartOrders uses: the batch poller walks several mints in one
    // pass, and one global flag would stall a second coin's level behind the
    // first coin's storage round trip.
    const due = E.triggeredAlerts(state, mint, observed)
      .filter((a) => !alertClaimsInFlight.has(a.id));
    if (!due.length) return;

    for (const alert of due) {
      alertClaimsInFlight.add(alert.id);
      try {
        // withState re-reads storage before running, so a level another tab
        // already claimed reads as fired here and stays silent. markAlertFired
        // returning false IS the claim being lost.
        const won = await withState(async () => {
          if (!E.markAlertFired(state, mint, alert.id, Date.now(), observed)) return null;
          // Re-claim on a lost race: if the adopted state shows another tab
          // already fired this level, the re-claim returns false and the
          // adopted truth stands — one level, one ping, whoever wins.
          await persistStateNow(() => E.markAlertFired(state, mint, alert.id, Date.now(), observed));
          return E.alertsFor(state, mint).find((a) => a.id === alert.id) || null;
        });
        if (won) announceMcAlert(won, observed);
      } finally {
        // Released even when the write threw, so a transient storage failure
        // leaves the level armed and retryable instead of permanently stuck
        // behind a flag nothing will ever clear.
        alertClaimsInFlight.delete(alert.id);
      }
    }
    renderAlerts();
  }

  function announceMcAlert(alert, observed) {
    const name = alert.symbol || E.short(alert.mint || '');
    const hit = Number(observed && observed.mcap) > 0 ? fmtMoney(observed.mcap) : null;
    const armed = alert.armedAtMcap ? ` · armed at ${fmtMoney(alert.armedAtMcap)}` : '';

    postDesktopAlert(alert, hit ? `Now ${hit}${armed}` : `Level reached${armed}`);
    playAlertChime();
    // The panel says it too, ALWAYS — not only when the desktop notification
    // failed. A notification can be posted straight into a Do-Not-Disturb and
    // never seen, and the trader who armed the level is owed the answer on
    // the surface they armed it from.
    toast(`${name} ${alert.kind === 'above' ? 'above' : 'below'} ${fmtMoney(alert.mcap)} MC 🔔`
      + (hit ? ` — now ${hit}` : ''));
  }

  /* Toasts (DEFECT O-28). The old stack sat at top:74 — ON the panel header
   * (top:84) at the same z — and cycled 4 slots by modulo, so a 5th toast
   * within ~4 s overprinted the 1st. Now:
   *  - the stack anchors to the panel's CURRENT side of the screen (same
   *    `right` coordinate) and starts below the panel, so it follows a
   *    dragged panel and can never cover the header it is dragged by;
   *  - each toast owns its slot until it expires; when all slots are busy
   *    the message queues instead of overwriting one already on screen.
   */
  const TOAST_SLOT_COUNT = 8;
  const TOAST_LIFE_MS = 4200;
  const TOAST_STEP_PX = 52;
  const toastSlotBusy = new Array(TOAST_SLOT_COUNT).fill(false);
  const toastQueue = [];

  /** Where slot 0 goes right now: under the panel, on the panel's side. */
  function toastBase() {
    const vh = window.innerHeight || 600;
    let right = 18;
    let top = 74;
    if (els.box) {
      const pos = readPanelPos();
      right = pos.right;
      let panelH = 0;
      try {
        const hidden = els.box.classList && els.box.classList.contains('pt-hidden');
        const rect = !hidden && els.box.getBoundingClientRect ? els.box.getBoundingClientRect() : null;
        panelH = (rect && Number(rect.height)) || 0;
      } catch (_) { /* fall back to the header clearance */ }
      // Visible panel: start under it. Hidden/minimized: its saved spot is
      // free below the (absent) header, so only clear the header band.
      top = pos.top + (panelH > 0 ? panelH + 10 : 48);
    }
    // However tall the panel, keep at least two slots on screen.
    return { right, top: Math.max(8, Math.min(top, vh - 2 * TOAST_STEP_PX)) };
  }

  /**
   * Scroll a panel section into view and pulse it once (away32 8/22: the
   * TP/SL and alert controls existed but lived below the fold — the header
   * jump buttons land the eye ON them, then hand the shape back). scroll-
   * IntoView on the section is enough: the panel body is the scroll
   * container, so the page never moves under the user.
   */
  function jumpToSection(target, name) {
    try { target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    target.classList.remove('pt-jump-flash');
    void target.offsetWidth; // restart the animation on repeat jumps
    target.classList.add('pt-jump-flash');
    setTimeout(() => target.classList.remove('pt-jump-flash'), 1400);
    toast(name + ' — right here');
  }

  function toast(msg) {
    const root = shadow && shadow.getElementById('pt-toast-root');
    if (!root) return;
    const slot = toastSlotBusy.indexOf(false);
    if (slot === -1) {
      // Every slot is on screen: queue rather than overprint (O-28).
      if (toastQueue.length < 16) toastQueue.push(msg);
      return;
    }
    toastSlotBusy[slot] = true;
    const base = toastBase();
    const d = document.createElement('div');
    d.className = 'pt-toast';
    d.style.top = Math.round(base.top + slot * TOAST_STEP_PX) + 'px';
    d.style.right = Math.round(base.right) + 'px';
    d.textContent = msg;
    root.appendChild(d);
    setTimeout(() => {
      try { d.remove(); } catch (_) {}
      toastSlotBusy[slot] = false;
      if (toastQueue.length && !contextDead) toast(toastQueue.shift());
    }, TOAST_LIFE_MS);
  }

  /* N1: one update notice per page session. The SW's release check wrote
   * pt_update_notice (or not) long before this tab mounted; this only reads
   * it and says so — one toast when the panel mounts, never again on this
   * page even across token navigations. */
  let updateNoticeShown = false;
  async function notifyUpdateOnce() {
    if (updateNoticeShown) return;
    const stored = await store.get(['pt_update_notice']);
    const notice = stored && stored.pt_update_notice;
    if (!notice || !notice.latest) return;
    updateNoticeShown = true;
    const running = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    toast(`PaperTrench v${notice.latest} is out (you run v${running}) — grab it on GitHub`);
  }

  // Prices and market caps share one readable convention across the whole
  // overlay. Scientific notation ("3.97e-8") was reported as unreadable, so
  // sub-cent values use subscript-zero notation instead.
  function trimSci(p) { return Q.formatPrice(p); }
  function fmtMoney(n) { return Q.formatMarketCap(n); }

  /**
   * Market cap implied by a SOL-denominated price for the token on screen.
   *
   * Supply is constant on the timescale of a trade, so the live cap and the
   * live price move together. Scaling the current cap by the price ratio gives
   * the cap AT THAT PRICE without needing a second data source, which is what
   * keeps the entry figure consistent with the header.
   */
  function mcapAtPrice(priceNative) {
    if (!(priceNative > 0) || !token) return null;
    const nowPrice = Number(token.priceNative);
    const nowMcap = Number(token.mcap);
    if (!(nowPrice > 0) || !(nowMcap > 0)) return null;
    return nowMcap * (priceNative / nowPrice);
  }

  /** Entry figure in the unit traders actually use, price only as a fallback. */
  function entryText(priceNative) {
    const mcap = mcapAtPrice(priceNative);
    if (mcap) return `${fmtMoney(mcap)} MC`;
    return `${trimSci(priceNative)} SOL`;
  }

  if (contextAlive()) chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (contextDead) return undefined;
    if (msg?.type === 'pt_toggle_overlay') {
      // The popup / toolbar toggle flips the master overlay switch, so the
      // user can turn the whole thing on or off from the browser action.
      toggleOverlayEnabled().catch(() => {});
      return undefined;
    }
    if (msg?.type === 'pt_chip_debug') {
      // Share-debug-logs pull: the chip map lives in the MAIN-world bridge,
      // so relay the request over the postMessage bridge and hand back the
      // first answer. A page with no bridge (non-screener site) answers
      // nothing — resolve empty after a short deadline so the popup's
      // report never hangs on a tab that cannot answer.
      let done = false;
      const finish = (chips) => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onAnswer);
        try { respond({ ok: true, chips }); } catch (_) { /* popup gone */ }
      };
      const onAnswer = (event) => {
        if (event.source !== window || !event.data || event.data.source !== 'papertrench-bridge') return;
        const ev = event.data;
        if (ev.type === 'chip-debug') finish((ev.payload && ev.payload.chips) || []);
      };
      window.addEventListener('message', onAnswer);
      sendPadreMarker('chip-debug-request', null);
      setTimeout(() => finish([]), 400);
      return true; // async respond
    }
    return undefined;
  });

  function stopOverlays() {
    stopPriceLoop();
    if (fastDetectTimer) { clearInterval(fastDetectTimer); fastDetectTimer = null; }
    if (detectLoopTimer) { clearInterval(detectLoopTimer); detectLoopTimer = null; }
    if (barScanTimer) { clearInterval(barScanTimer); barScanTimer = null; }
    if (bridgePingTimer) { clearInterval(bridgePingTimer); bridgePingTimer = null; }
    stopRowBuyObserver();
  }

  async function enableOverlay() {
    // Idempotent (DEFECT O-05): watchStorage calls this on EVERY settings
    // write, including the overlay's own drag/resize persists. createUI now
    // always sets `host` (adopt-or-replace), so a live overlay returns here
    // and can never stack a second set of timers.
    if (host) return;
    createUI();
    if (!detectLoopTimer) detectLoopTimer = managedInterval(detectLoop, DETECT_MS);

    // DEFECT O-15: the host header may render after us, and two blind samples
    // (400 ms / 1500 ms) missed late-painting headers — the bar sat on the
    // site's own nav at the fallback inset until a window resize. Instead,
    // sample until the measurement STABILIZES: the same measured edge twice
    // in a row ends the loop; a user-saved coordinate needs no measuring at
    // all. Cost while settling is one probe pass per beat, cost after
    // settling is zero, and an SPA route change (header rebuilds) re-arms it.
    let barSettle = { last: null, until: 0, timer: 0 };
    const barSettleLoop = () => {
      barSettle.timer = 0;
      if (!contextAlive() || !host) return;
      if (typeof settings.positionsBarLeft === 'number') { positionBar(); return; }
      const measured = measureBarLeft();
      positionBar(measured);
      const settled = measured === barSettle.last && measured !== BAR_DEFAULT_LEFT;
      barSettle.last = measured;
      if (settled || Date.now() > barSettle.until) return;
      barSettle.timer = setTimeout(barSettleLoop, 700);
    };
    restartBarSettle = () => {
      clearTimeout(barSettle.timer);
      barSettle = { last: null, until: Date.now() + 10_000, timer: setTimeout(barSettleLoop, 400) };
    };
    restartBarSettle();
    onMountCleanup(() => { clearTimeout(barSettle.timer); restartBarSettle = null; });
    // O-18: shrinking the window re-clamps BOTH floating elements so neither
    // can be stranded off-screen. Registered per mount, torn down with it.
    // A narrower window can turn a rail that fitted into one that overflows
    // (and back), so the fade is re-evaluated with the other clamps.
    const onWindowResize = () => { positionBar(); reclampPanel(); syncRailFade(); };
    window.addEventListener('resize', onWindowResize);
    onMountCleanup(() => { try { window.removeEventListener('resize', onWindowResize); } catch (_) {} });

    // Cheap liveness heartbeat: the MAIN-world bridge stands its sweeps down
    // after 5 minutes without ANY content-script message (O-04/C-17), so an
    // alive-but-quiet overlay must keep speaking.
    if (!bridgePingTimer) bridgePingTimer = managedInterval(() => sendPadreMarker('bridge-ping'), 30_000);
    // Waking from sleep, the wall clock has jumped: the bridge reads the gap
    // as content-script silence and (Turbo) gates frame parsing on it. The
    // moment the tab is visible again, one ping restores the feed instead of
    // waiting out the 30 s heartbeat.
    const onVisibleAgain = () => { if (!document.hidden && contextAlive()) sendPadreMarker('bridge-ping'); };
    document.addEventListener('visibilitychange', onVisibleAgain);
    onMountCleanup(() => { try { document.removeEventListener('visibilitychange', onVisibleAgain); } catch (_) {} });

    // Sniping cadence: while an address is detected but not yet indexed by any
    // source, retry rapidly. This is the difference between being able to
    // paper-snipe a launch and watching it happen. It stops the moment the
    // token resolves, so steady-state cost is zero.
    if (!fastDetectTimer) fastDetectTimer = managedInterval(() => {
      if (!token || !token.pending || resolving) return;
      // Give up the rapid cadence after a while; the 800ms loop still retries.
      if (pendingSince && Date.now() - pendingSince > FAST_RETRY_WINDOW_MS) return;
      detectLoop();
    }, FAST_RETRY_MS);

    // The positions bar runs on its own cadence, independent of the price
    // heartbeat: it must keep working on pages where no token is detected at
    // all, which is exactly when the user is browsing for the next trade.
    if (!barScanTimer) barScanTimer = managedInterval(() => {
      pollPositionPrices();
      // Cheap no-op when nothing changed, so an idle bar does not churn the
      // DOM (and cannot fight the user's horizontal scroll or a live click).
      renderPositionsBar();
      // Screener rows render continuously; catch new ones on this cadence.
      scanRowBuys();
      // D-40 armed-row watchdog: the board's 1 s heartbeat keeps the armed
      // snipe honest — re-probing the sources while it waits and expiring it
      // visibly when the TTL passes (the panel's armed-buy watchdog, ported).
      if (rowArmed) flushRowArmed();
      // D-41 latch hygiene: an in-flight buy/sell whose await never settled
      // (hung resolver, dying SW) must not wedge every later trade behind
      // "already in progress". A live cascade never takes 20 s; if the
      // latch is that old the operation is dead, so free it. The eventual
      // finally is idempotent — it only clears, never re-arms.
      const LATCH_MAX_AGE_MS = 20_000;
      if (rowBuyInFlight && rowBuyInFlightAt && Date.now() - rowBuyInFlightAt > LATCH_MAX_AGE_MS) {
        rowBuyInFlight = false;
        rowBuyInFlightAt = 0;
        toast('A stuck row buy was released — try again');
      }
      if (buyInFlight && buyInFlightAt && Date.now() - buyInFlightAt > LATCH_MAX_AGE_MS) {
        buyInFlight = false;
        buyInFlightAt = 0;
        toast('A stuck buy was released — try again');
      }
      if (sellInFlight && sellInFlightAt && Date.now() - sellInFlightAt > LATCH_MAX_AGE_MS) {
        sellInFlight = false;
        sellInFlightAt = 0;
        toast('A stuck sell was released — try again');
      }
    }, 1000);
    pollPositionPrices();
    startRowBuyObserver();

    await detectLoop();
  }

  function disableOverlay() {
    if (!host) return;
    stopOverlays();
    // O-26: listeners registered per mount (drag wiring, resize re-clamp,
    // early positionBar timeouts) die with the mount, not with the page.
    runMountCleanups();
    // DEFECTS O-03/C-18: overlay OFF must erase everything the overlay put
    // on the page and release every per-token resource — the SVG chart
    // overlay with its observers and scan timer, native chart drawings in
    // the MAIN world, the title observer, and the background's pool
    // subscription for the token that was live.
    if (token && token.mint) R.onchainUnwatch(token.mint);
    onchainLive = false;
    stopTitleSignal();
    if (CM) CM.destroyChartMarkers();
    sendPadreMarker('paper-marker-clear');
    sendPadreMarker('paper-lines-clear');
    sendPadreMarker('gmgn-lines-clear');
    drawnFillIds.clear();
    // One belt-and-braces message that clears every bridge artifact and
    // stops its line re-assert sweep (see 'standdown' in price-bridge.js).
    sendPadreMarker('standdown');
    token = null;
    armedBuy = null;
    lastHref = '';
    // The standdown told the bridge "no consumers"; forget the last published
    // demand so a re-enable on the same page re-announces it fresh.
    lastWantsTicks = null;
    // C-19/C-01: per-page routing probe and line-repost state die with the
    // overlay (bridgeNativeCapable itself is a page property and survives).
    if (nativeProbeTimer) { clearTimeout(nativeProbeTimer); nativeProbeTimer = null; }
    nativeProbeStartedAt = 0;
    svgFallbackActive = false;
    lastLinesActive = false;
    try { host.remove(); } catch (_) {}
    host = null; shadow = null; els = {};
    // The cached position-card nodes belong to the shadow tree we just removed.
    // Without this, a subsequent enableOverlay() would skip buildPositionCard
    // (because posEls is still truthy) and write updates to detached ghosts
    // while the live card sits empty — reported as "sell button disappearing"
    // after toggling the overlay or switching sites.
    posEls = null;
    // Same reason, same failure: a stale alertEls would let a re-enabled
    // overlay skip buildAlertsSection and then paint armed levels into a
    // detached node, leaving the live panel's alert list permanently empty.
    alertEls = null;
    lastRenderedPrice = null;
  }

  /* -------------------- Turbo receipts: page jank sampling -------------------
   *
   * How much does the main thread actually stall on this site? A
   * PerformanceObserver counts the browser's own 'longtask' entries — any
   * main-thread task over 50 ms — and aggregates count + blocked time in
   * memory. Only VISIBLE time is measured: hidden tabs are throttled by the
   * browser, and folding their quiet minutes into the denominator would
   * dilute "long tasks per minute" into a flattering lie.
   *
   * Storage discipline: never a per-event write. The aggregate flushes as ONE
   * pt_turbo_jank message at most every JANK_FLUSH_MS — plus on pagehide and
   * on master-switch off — and the background folds it into
   * pt_turbo_stats.pageJank on the same write chain as the route timings.
   * An extension reload kills this context before it can flush; that sliver
   * of samples is simply lost, which beats writing storage every event.
   * Local only — the no-fetch source contract in warmdest.test.js covers
   * this block too. Unbuffered observe: counting starts when watching
   * starts, so numerator and denominator always cover the same span.
   */
  const JANK_FLUSH_MS = 60_000;
  let jankObserver = null;
  let jankCount = 0;         // long tasks seen since the last flush
  let jankBlockedMs = 0;     // their summed durations
  let jankVisibleMs = 0;     // closed visible-time windows since the last flush
  // performance.now() when the open window began; -1 while hidden/closed.
  // -1, not 0: zero is a valid page-epoch timestamp, and treating it as
  // "closed" would silently drop the whole first window's visible time.
  let jankVisibleSince = -1;
  let jankFlushTimer = null;

  /* Fill receipts. The product could time link routing and page jank but had
   * NO instrument on its most-felt interaction — the fill. Every argument about
   * whether the fill got faster was therefore an argument, which is the wrong
   * shape for this codebase.
   *
   * Three stages, measured on the real path, deliberately reported apart
   * because they are not all ours to fix:
   *   quote  — click → a fresh price in hand. Mostly the chain/aggregator
   *            round trip. NOT ours; showing it folded into a total would let
   *            us take credit for a fast RPC or get blamed for a slow one.
   *   commit — price → wallet written. The full-state read, the engine, the
   *            attestation append and the persist. This is OURS, and it is
   *            exactly the stage the pt_state heartbeat work would move.
   *   paint  — wallet written → the trader sees the confirmation.
   *
   * Two rules this obeys, both non-negotiable:
   *  - performance.now() deltas ONLY, never a wall clock. A fill already
   *    carries an attestation `ts`, and a second time-like number near it that
   *    could be mistaken for the fill's own timestamp is a footgun in the one
   *    record that must never be ambiguous.
   *  - Numbers and a fixed 'buy'/'sell' key only. No mint, no symbol, no
   *    hostname — nothing page-derived enters the receipts store at all, so
   *    there is no attacker-writable string to escape at render time.
   * Measurement must never move what it measures: this runs after the toast,
   * off the awaited path, and a failure to send is swallowed. */
  /** Monotonic clock, or NaN where there isn't one. NaN is deliberate: it
   * flows into noteFillTiming's validation and drops the receipt, so a
   * missing clock costs a measurement and never a fill. It must NOT fall back
   * to Date.now() — see the wall-clock rule above. */
  function perfNow() {
    return (typeof performance !== 'undefined' && performance
      && typeof performance.now === 'function') ? performance.now() : NaN;
  }

  function noteFillTiming(kind, tClick, tQuoted, tCommitted) {
    const painted = perfNow();
    const ms = (a, b) => Math.max(0, Math.round(b - a));
    if (!(tClick >= 0) || !(tQuoted >= tClick) || !(tCommitted >= tQuoted)) return;
    sendMessage({
      type: 'pt_turbo_fill',
      kind: kind === 'sell' ? 'sell' : 'buy',
      quoteMs: ms(tClick, tQuoted),
      commitMs: ms(tQuoted, tCommitted),
      paintMs: ms(tCommitted, painted),
      totalMs: ms(tClick, painted),
    }).catch(() => {});
  }

  /** Fold the currently open visible-time window into jankVisibleMs. */
  function jankCloseWindow() {
    if (jankVisibleSince >= 0) {
      jankVisibleMs += Math.max(0, performance.now() - jankVisibleSince);
      jankVisibleSince = -1;
    }
  }

  function onJankVisibility() {
    if (!jankObserver) return;
    if (document.hidden) jankCloseWindow();
    else if (jankVisibleSince < 0) jankVisibleSince = performance.now();
  }

  /** The ONLY path out of memory: one message per flush, nothing per event. */
  function flushJank() {
    jankCloseWindow();
    const count = jankCount;
    const blockedMs = Math.round(jankBlockedMs);
    const sampledMs = Math.round(jankVisibleMs);
    jankCount = 0; jankBlockedMs = 0; jankVisibleMs = 0;
    if (jankObserver && !document.hidden) jankVisibleSince = performance.now();
    // Under a second watched and nothing seen — no rate worth recording.
    if (sampledMs < 1000 && count === 0) return;
    sendMessage({ type: 'pt_turbo_jank', site: location.hostname, count, blockedMs, sampledMs });
  }

  /** Idempotent; a no-op where the browser has no longtask support. */
  function startJankSampling() {
    if (jankObserver) return;
    if (typeof PerformanceObserver === 'undefined') return;
    const supported = PerformanceObserver.supportedEntryTypes || [];
    if (!supported.includes('longtask')) return;
    try {
      jankObserver = new PerformanceObserver((list) => {
        // In-memory aggregation only — the flush cadence owns persistence.
        //
        // HONEST DENOMINATOR: the rate the dashboard prints is blockedMs over
        // sampledMs, and sampledMs counts VISIBLE time alone (jankCloseWindow).
        // So a long task may only be counted if it ran inside the visible
        // window that is currently open. Two things go wrong otherwise, both
        // inflating the published number for anyone who parks tabs — which is
        // every trader with five terminals open:
        //   - tasks that run while hidden have no visible time to divide by;
        //   - worse, a hidden tab's deferred entries are DELIVERED in a batch
        //     when it is re-shown, so checking document.hidden at delivery
        //     time would still fold a whole hidden stretch into the first
        //     visible window.
        // Attributing by entry.startTime handles both. The residue is a slight
        // UNDERCOUNT — a task that ran visibly but arrives after the window
        // closed is dropped — and a floor is the right way to be wrong about a
        // number we publish.
        if (jankVisibleSince < 0) return;
        for (const entry of list.getEntries()) {
          if (entry.startTime < jankVisibleSince) continue;
          jankCount += 1;
          jankBlockedMs += entry.duration;
        }
      });
      jankObserver.observe({ type: 'longtask' });
    } catch (_) { jankObserver = null; return; }
    jankVisibleSince = document.hidden ? -1 : performance.now();
    document.addEventListener('visibilitychange', onJankVisibility);
    window.addEventListener('pagehide', flushJank);
    jankFlushTimer = setInterval(() => {
      if (!contextAlive()) { shutdown('invalidated'); return; }
      flushJank();
    }, JANK_FLUSH_MS);
  }

  /** Stop watching, flush what was gathered, leave nothing on the page. */
  function stopJankSampling() {
    if (!jankObserver) return;
    try { jankObserver.disconnect(); } catch (_) {}
    if (jankFlushTimer) { clearInterval(jankFlushTimer); jankFlushTimer = null; }
    document.removeEventListener('visibilitychange', onJankVisibility);
    flushJank();
    jankObserver = null;
    jankVisibleSince = -1;
    window.removeEventListener('pagehide', flushJank);
  }
  onTeardown(stopJankSampling);

  async function init() {
    // price-bridge.js is declared by the manifest in MAIN world at
    // document_start, before Padre creates its WebSocket and TradingView feed.
    await reloadState();
    // N1: surface a shipped-but-not-installed release once per page session.
    // Users trade for days without opening the dashboard; the notice chip is
    // the only thing that reaches them on the chart. Fire-and-forget.
    notifyUpdateOnce().catch(() => {});
    // "Hide it once" must stick: the collapsed bar state is a saved setting,
    // not a per-page variable.
    positionsBarHidden = settings.positionsBarHidden === true;
    // Storage must be watched even when the overlay is disabled, so toggling
    // settings from the dashboard or popup reaches this tab immediately.
    watchStorage();
    // Jank sampling rides the master switch ALONE — it measures rather than
    // mounts, but "off means PaperTrench runs nothing on the page" is the
    // Speed telemetry rides the speed toggles (maintainer: paper off never
    // silences the speed plane). The overlay toggle below does not touch
    // it: a view-only page still has a main thread worth measuring.
    if (settings.warmXLinksEnabled || settings.warmEverywhereEnabled) startJankSampling();
    // The PAPER master switch outranks every paper sub-setting: off means
    // no paper surface mounts at all until the user turns it back on.
    if (settings.appEnabled === false || !settings.overlayEnabled) return;
    await enableOverlay();
  }

  /* -------------------- global error capture (page) --------------------
   * content.js has ~124 catch blocks that swallow silently. These listeners
   * catch what nothing else did. Guarded three ways because this runs inside
   * somebody else's page and must never break it:
   *   - the whole registration is wrapped,
   *   - the handler body is wrapped,
   *   - the listeners are PASSIVE observers: they never preventDefault and
   *     never stopPropagation, so the page's own error handling is untouched.
   * The recorder is same-world (ISOLATED), so nothing here is reachable from
   * page script. */
  try {
    const EL = window.PTErrors || null;
    if (EL && typeof window.addEventListener === 'function') {
      window.addEventListener('error', (event) => {
        try {
          EL.record((event && (event.error || event.message)) || 'unknown page error', {
            scope: 'content',
            kind: 'error',
            filename: (event && event.filename) || null,
            lineno: (event && event.lineno) || null,
          });
        } catch (_) { /* never break the host page */ }
      });
      window.addEventListener('unhandledrejection', (event) => {
        try {
          EL.record((event && event.reason) || 'unknown rejection', {
            scope: 'content',
            kind: 'unhandledrejection',
          });
        } catch (_) { /* never break the host page */ }
      });
      // Support pull: the worker asks, the page half answers with its own
      // already-redacted entries. Pull-only, no UI.
      if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
          try {
            if (msg && msg.type === 'pt_errors_snapshot_content') {
              respond({ ok: true, scope: 'content', entries: EL.snapshot() });
            }
          } catch (_) { respond && respond({ ok: false, entries: [] }); }
          return undefined;
        });
      }
    }
  } catch (_) { /* error capture is best-effort and never load-bearing */ }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
  else init().catch(() => {});
})();
