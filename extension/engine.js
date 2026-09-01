/* PaperTrench — portfolio engine.
 *
 * Pure functions over a serializable state object. No DOM, no chrome APIs —
 * the content script and the dashboard both load this and drive it with
 * storage reads/writes.
 *
 * All prices in SOL (priceNative). USD values are derived per-trade with the
 * priceUsd captured at that moment.
 */
(() => {
  'use strict';

  const STORAGE_KEYS = {
    state: 'pt_state',
    settings: 'pt_settings',
    frames: 'pt_frames',
    replays: 'pt_replays',
  };
  const EPS = 1e-9;

  // Bumped when a default changes in a way existing users should receive.
  // Stored settings normally win over defaults, so without this a user who
  // installed before the change would keep the old value forever.
  //
  // Declared HERE, above DEFAULT_SETTINGS, so the defaults can carry it
  // directly. That coupling is the fix for D-56: the constant used to live
  // below the defaults, which pinned `settingsRevision` to a literal (4)
  // that nobody remembered to bump alongside it. A FRESH install was
  // therefore born three revisions stale, and migrations written to repair
  // data from OLD builds ran against settings the user had just typed —
  // silently reverting them one read after "Saved." appeared. A brand-new
  // install has no legacy data, so no migration may ever apply to it.
  const SETTINGS_REVISION = 7;

  const DEFAULT_SETTINGS = {
    balanceStartSol: 10,
    presetsBuy: [0.1, 0.5, 1, 2],
    // Foreign-chain panels quick-buy in DOLLARS (fomo's own ladder on its
    // EVM chains, read off the live site 2026-08-05). Separate key so a
    // chain switch never rewrites the SOL list.
    presetsBuyUsd: [10, 100, 500, 1000],
    sellPcts: [25, 50, 75, 100],
    // One-click trading: a preset amount fires the buy immediately (Axiom /
    // Padre quick-buy behaviour) instead of only selecting it for the BUY
    // button. Off returns to the two-step select-then-confirm flow.
    instantBuyEnabled: true,
    // Paper quick-buy chip on every token row of the screener pages (Axiom
    // Pulse, Padre/GMGN Trenches), so a position can be opened without
    // loading the chart first. Fills at the first preset amount.
    listQuickBuyEnabled: true,
    // Scale factor for the screener row quick-buy chip. 1.0 is the default
    // compact size; users can make it larger on dense trench/pulse screens.
    listQuickBuySize: 1.0,
    // Where the screener row chip sits when the site default (float,
    // top-right) collides with that row format's own content — the Axiom
    // "ultra" compact terminal format puts the market cap exactly there.
    // 'auto' keeps the per-site default and only drops to the row's
    // bottom-right gutter when the anchor point lands on row content;
    // 'bottom' pins the gutter anchor everywhere. The maintainer default is
    // auto: the collision is the exception, not the rule.
    listQuickBuyPlacement: 'auto',
    // TradingView order/level line width for TP/SL and average-entry lines.
    // 1 = hairline (old hard-coded look), 2 = default, 3 = thick, easier to
    // read on dense charts and small screens. Same knob for both line
    // families so the chart reads as one system.
    chartOrderLineThickness: 2,
    // Master switch for the buy controls in the trade tab (presets, custom
    // amount, BUY button). Off makes the panel view-only for people who
    // never buy from the overlay.
    panelBuyEnabled: true,
    // The one-tap preset amount row inside the buy section. Can be hidden
    // on its own so traders who always type a custom amount keep the BUY
    // button.
    panelPresetsEnabled: true,
    feeBps: 100,          // 1% per side, roughly Padre/Axiom territory
    slippageBps: 0,       // extra simulated slippage, 0 = fill at tick price
    recordingEnabled: false,
    framesEnabled: true,  // capture page screenshots for the AI coach
    autoReview: false,    // auto-run AI review when a round trip closes
    overlayEnabled: true,
    // Axiom-style focus mode for the trade tab: strips every decoration and
    // info card (banner, watermark, sparkline, thesis, last-close card,
    // footer) and leaves only token, price, balance, buy and sell controls.
    // Requested from the community: "make the trading tab like axiom and
    // other platforms for more optimised and less distracted trades".
    // Opt-in — the decorated panel stays the default.
    panelFocusMode: false,
    // Gaming Mode (maintainer, 2026-08-05): gamification is INVISIBLE until
    // this is on — no Game tab, no grades, no streaks, no toasts, no card
    // line, nothing. Three personas share this extension (speed-only,
    // paper-only, paper+gaming) and no persona may see another's furniture.
    gamingModeEnabled: false,
    // Hide the overlay on pages where no token is detected (e.g., a project's
    // home page or a screener without a selected token). It pops back the
    // moment the user opens a coin page.
    overlayHideWhenNoToken: true,
    // Last user-resized width/height of the trade tab, in pixels. null means
    // use the CSS default (336px by content height).
    overlayWidth: null,
    overlayHeight: null,
    // Feedback features. On by default so a fill is unmistakable; every one
    // of them can be switched off individually in Settings.
    tradeEffectsEnabled: true,
    tradeSoundsEnabled: true,
    profitAlertsEnabled: false,
    profitAlertPct: 10,
    // Market-cap alerts. On by default: an armed alert is an explicit,
    // per-token act, so there is nothing to opt into until the trader arms
    // one, and a switch that silences a level they deliberately set is the
    // surprising default, not the safe one.
    mcAlertsEnabled: true,
    // Post a real desktop notification through the host page, the same way
    // the terminals' own alerts do. Off falls back to the in-page toast and
    // bell, which is also what happens when the page has no notification
    // permission to lend.
    mcAlertDesktopEnabled: true,
    averagePriceLinesEnabled: true,
    // A fresh install is CURRENT by construction — see SETTINGS_REVISION.
    settingsRevision: SETTINGS_REVISION,
    // Padre-style top rail listing every open paper position.
    positionsBarEnabled: true,
    // Saved left/top offsets for the draggable positions bar. null means the
    // bar should auto-measure against the host site header on first paint.
    positionsBarLeft: null,
    positionsBarTop: null,
    // Whether the positions bar is collapsed into its small POSITIONS tab.
    // Saved so "hide it once" sticks across pages, tabs and sessions instead
    // of the bar reappearing on every new page — the "it follows me
    // everywhere" complaint.
    positionsBarHidden: false,
    // AI backend (OpenAI-compatible). Empty by default; the user must set a
    // public endpoint or opt-in to local/private endpoints below.
    aiEndpoint: '',
    aiModel: '',
    aiApiKey: '',
    aiAllowLocalEndpoint: false,
    // Optional private Solana RPC. Empty means "use the built-in keyless
    // public pool", which is the default and needs no signup from anyone.
    // Public RPC limits are per IP, so the pool scales across every install.
    // Power users can paste their own endpoint here for extra headroom.
    rpcUrl: '',
    // Flat per-transaction costs, emulating what real trading actually costs
    // beyond the platform's percentage fee: a priority fee (gas) and a
    // bribe/tip per transaction. Small trades are DOMINATED by these — a
    // 0.1 SOL entry with 0.002 SOL of tx costs pays 2% before the platform
    // fee — so practicing without them teaches economics that don't exist.
    // Zero by default so existing wallets' math never changes silently; the
    // Fees & costs settings card nudges users to copy their real setup.
    gasSolPerTx: 0,
    tipSolPerTx: 0,
    // "The After": keep watching a coin for a bounded window after a round
    // closes and record the observed extremes on the round — measured truth
    // about what your exit actually did, instead of FOMO guesswork.
    postExitWatchEnabled: true,
    // Guardrails (training wheels). All opt-in; enforcement happens at buy
    // time with an honest toast, and each can be turned off in Settings —
    // the point is practicing the rules, not being jailed by them.
    guardTiltEnabled: false,
    guardTiltLosses: 4,
    guardTiltMinutes: 10,
    guardMaxPositionPct: null,   // % of current equity per buy; null = off
    guardDailyLossSol: null,     // paper SOL lost today stops the day; null = off
    // Rug guard — the one guardrail that is ON by default (maintainer call:
    // "when it's an obvious rug I'd rather it not let you buy"). Chain-read
    // holder concentration; refuses BUYS only, never sells, and only when
    // the chain was actually readable. Off-switch lives with the rest of
    // the Guardrails card.
    guardRugEnabled: true,
    guardRugTopPct: 40,          // top-10 holders (excl. pool) % threshold
    // Chart orders — drag a take profit or stop loss onto the chart, Padre
    // style. On by default: it is the exit half of paper trading, and it
    // costs nothing until a level is actually armed.
    chartOrdersEnabled: true,
    // Whether armed orders keep watching after the trading tab is closed.
    //
    // OFF by default, deliberately (maintainer call, 2026-08-06: "our default
    // setting is just non-aggressive, not too much, but people have the
    // ability"). With this off — the only behaviour that exists today — a
    // level is evaluated against prices a page in front of you is already
    // receiving: no background network, nothing running behind your back.
    //
    // NOT YET WIRED, and therefore NOT YET OFFERED in Settings: turning this
    // on needs the `alarms` permission (a Chrome Web Store listing change),
    // engine access inside the service worker, and seq-safe wallet writes
    // from a context that races open content tabs. The key lives here so the
    // poller has one home to read when it lands; until then no UI exposes it,
    // because a switch that does not do what it says is worse than no switch.
    ordersBackgroundArmEnabled: false,
    // Intended poll cadence in seconds for that future poller, bounded there
    // too — a user-set 1 s would be a self-inflicted rate limit, not a feature.
    ordersBackgroundPollSec: 30,
    // Forge — a Generate button inside the dex's own paid upload box, so a
    // header or icon can be made without leaving the checkout. OFF by
    // default and useless until the user brings their own key: it is the one
    // feature here that spends the user's money at someone else's API, so it
    // may never be something they discover by finding a charge.
    //
    // NOTHING is stored here that we would not want a hostile page to see —
    // except the keys, which is exactly why every provider call happens in
    // the service worker and never in a content script.
    forgeEnabled: false,
    // Lane 1, the "brain": reads the narrative and writes the art direction.
    // Optional — with no brain the user just describes the art themselves.
    forgeBrainProvider: 'xai',
    forgeBrainEndpoint: '',
    forgeBrainModel: '',
    forgeBrainKey: '',
    // Grok's Live Search over X is the whole reason to wire a brain at all;
    // it is still a toggle because it costs more per call and some keys are
    // not entitled to it.
    forgeSearchX: true,
    // Lane 2, the "hands": renders pixels. Required.
    forgeImageProvider: 'openai',
    forgeImageEndpoint: '',
    forgeImageModel: '',
    forgeImageKey: '',
    // The escape hatch for providers we ship no adapter for. Empty unless the
    // user picks the custom provider and writes a request template.
    forgeImageHeaders: '',
    forgeImageBody: '',
    forgeImagePath: '',
    forgeStyle: 'trench',
    forgeVariants: 2,
  };

  function defaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  /**
   * Merge stored settings over defaults, applying one-time migrations.
   *
   * Revision 2 turned trade effects, sounds, and average price lines on. Those
   * were previously off by default, so an existing install has `false` saved
   * for them — not because the user chose it, but because that was the default.
   * The migration adopts the new defaults ONCE and records that it ran, so a
   * deliberate opt-out afterwards is never overridden.
   *
   * Revision 3 starts hiding the overlay on pages without a detected token.
   *
   * Revision 4 removes the insecure default local AI endpoint and adds an
   * explicit opt-in for local/private AI endpoints. Existing installs that still
   * carry the old default have it cleared, and local/private access defaults off.
   *
   * Revision 5 adds the trade-tab buy toggles (whole buy section, and the
   * preset row on its own), both on by default.
   *
   * Revision 6 persists the positions bar's collapsed/expanded state, so
   * hiding it once keeps it hidden everywhere.
   *
   * Revision 7 clears orphaned AI credentials (apiKey/model) when the stored
   * endpoint is empty and no endpoint was explicitly configured, preventing
   * stale keys from being sent to whatever endpoint the user pastes next.
   */
  const OLD_LOCAL_AI_ENDPOINT = 'http://127.0.0.1:8765/v1';
  function mergeSettings(stored) {
    const merged = Object.assign(defaultSettings(), stored || {});
    if (!stored) return merged;

    const revision = Number(stored.settingsRevision) || 0;
    if (revision < 2) {
      merged.tradeEffectsEnabled = DEFAULT_SETTINGS.tradeEffectsEnabled;
      merged.tradeSoundsEnabled = DEFAULT_SETTINGS.tradeSoundsEnabled;
      merged.averagePriceLinesEnabled = DEFAULT_SETTINGS.averagePriceLinesEnabled;
    }
    if (revision < 3) {
      merged.overlayHideWhenNoToken = DEFAULT_SETTINGS.overlayHideWhenNoToken;
    }
    if (revision < 4) {
      if (merged.aiEndpoint === OLD_LOCAL_AI_ENDPOINT) {
        merged.aiEndpoint = '';
      }
      merged.aiAllowLocalEndpoint = false;
    }
    if (revision < 5) {
      merged.panelBuyEnabled = DEFAULT_SETTINGS.panelBuyEnabled;
      merged.panelPresetsEnabled = DEFAULT_SETTINGS.panelPresetsEnabled;
    }
    if (revision < 6) {
      merged.positionsBarHidden = DEFAULT_SETTINGS.positionsBarHidden;
    }
    // Revision 7: clear any orphaned AI credentials tied to the removed insecure
    // local endpoint. If the stored endpoint is the old default or empty and
    // aiAllowLocalEndpoint is off, the saved key/model are useless and
    // potentially leaked to whatever endpoint the user pastes next.
    if (revision < 7) {
      const endpointEmptyOrInsecure = merged.aiEndpoint === '' || merged.aiEndpoint === OLD_LOCAL_AI_ENDPOINT;
      if (endpointEmptyOrInsecure && !merged.aiAllowLocalEndpoint && (merged.aiApiKey || merged.aiModel)) {
        merged.aiApiKey = '';
        merged.aiModel = '';
      }
    }
    merged.settingsRevision = SETTINGS_REVISION;
    return merged;
  }

  function defaultState(settings = DEFAULT_SETTINGS) {
    return {
      version: 1,
      // Monotonic write counter bumped by the content script on every state
      // write. A fresh wallet starts at 0; a writer holding an older seq can
      // tell it has been overtaken and adopt instead of clobber.
      seq: 0,
      cashSol: settings.balanceStartSol,
      // D-06: the birth balance is SNAPSHOT here. settings.balanceStartSol
      // names what the NEXT wallet starts with; startSol is what THIS wallet
      // actually started with. Every "% return" denominator reads the
      // anchor (anchorStartSol) so editing the setting mid-wallet changes
      // the next wallet, never this wallet's history.
      startSol: settings.balanceStartSol,
      startedAt: Date.now(),
      positions: {},   // mint -> position
      // mint -> armed take-profit / stop-loss orders. Kept beside positions
      // rather than inside them so the background poller can enumerate the
      // whole work list without walking every position.
      orders: {},
      // N2: mint -> armed limit buys (entries, not exits). Cash locked by
      // these is part of cashSol but spendable nowhere until released.
      pendingBuys: {},
      // mint -> armed market-cap alerts. Watch-only, so unlike `orders` these
      // routinely name mints with no position at all — this map IS the
      // watchlist.
      alerts: {},
      rounds: [],      // closed round trips, newest first
      journal: [],     // every fill, newest first
      stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
      // The one deliberate exception to gamify's derived-only rule: a game
      // SESSION the user explicitly started ({ id, startedAt } or null).
      // Results are still derived from the rounds closed since startedAt —
      // this pointer only says which game is on and since when.
      activeGame: null,
    };
  }

  /* ---------------- game sessions (GAMIFY.md v2, Gaming Mode) ----------------
   * Started from the dashboard's Game tab, played on the live charts, shown
   * by the overlay HUD. The engine owns the pointer so every surface reads
   * one truth through the same seq-protocol state writes as everything else.
   */
  const GAME_IDS = ['gauntlet', 'one-shot', 'score-attack', 'season', 'survival'];

  function startGame(state, id, ts) {
    if (!state || GAME_IDS.indexOf(id) < 0) return null;
    state.activeGame = { id, startedAt: Number(ts) || Date.now() };
    return state.activeGame;
  }

  function endGame(state) {
    if (!state || !state.activeGame) return null;
    const ended = state.activeGame;
    state.activeGame = null;
    return ended;
  }

  /* ---------------- price helpers ---------------- */

  function applyBps(x, bps) { return x * (Number(bps) || 0) / 10000; }

  /* ---------------- pump.fun's real fee schedule ---------------- */

  /**
   * fees.js is loaded as a sibling global in the page and the worker, and as
   * a CommonJS module under Node. Resolved LAZILY, per call, because engine.js
   * loads BEFORE fees.js in the manifest's script list — capturing the global
   * at module-evaluation time would pin it to undefined forever and silently
   * demote every fill back to the flat configured fee.
   */
  function feesApi() {
    if (typeof window !== 'undefined' && window.PTFees) return window.PTFees;
    if (typeof self !== 'undefined' && self.PTFees) return self.PTFees;
    if (typeof globalThis !== 'undefined' && globalThis.PTFees) return globalThis.PTFees;
    if (typeof require === 'function') {
      try { return require('./fees.js'); } catch (e) { /* not available */ }
    }
    return null;
  }

  /**
   * The fee bps a fill actually pays.
   *
   * pump.fun charges 1.25% on the bonding curve and a market-cap-TIERED fee
   * (1.25% down to 0.30%) once a coin graduates, so a flat `settings.feeBps`
   * misprices nearly every fill. When the caller knows the token's state it
   * passes it through and the real schedule applies.
   *
   * When it does NOT — off-pump.fun venues (Axiom pairs, EVM chains), replays
   * of older fills, and every existing caller — there is no honest way to
   * pick a tier, so the user's configured `settings.feeBps` still rules. That
   * fallback is why the flat setting stays: it is the answer for tokens this
   * schedule does not describe, not dead weight.
   *
   * `o.mcap` is deliberately NOT consulted: it is a USD market cap, and the
   * tier table is denominated in SOL. Feeding dollars to a SOL table would
   * put almost every coin in the cheapest band.
   */
  function feeContext(o) {
    if (!o) return null;
    const known = o.graduated !== undefined
      || o.canonical !== undefined
      || o.marketCapSol !== undefined;
    if (!known) return null;
    return {
      graduated: o.graduated === true,
      canonical: o.canonical !== false,
      marketCapSol: o.marketCapSol,
    };
  }

  function effectiveFeeBps(settings, o) {
    const ctx = feeContext(o);
    if (!ctx) return settings ? settings.feeBps : 0;
    const F = feesApi();
    if (!F || typeof F.resolveFeeBps !== 'function') return settings ? settings.feeBps : 0;
    return F.resolveFeeBps(ctx);
  }

  /* ---------------- constant-product price impact ---------------- */

  /**
   * slippage.js, resolved lazily for the same reason feesApi() is: engine.js
   * is evaluated before its siblings in the manifest's script list, so a
   * global captured at module-evaluation time would be pinned to undefined.
   */
  function slippageApi() {
    if (typeof window !== 'undefined' && window.PTSlippage) return window.PTSlippage;
    if (typeof self !== 'undefined' && self.PTSlippage) return self.PTSlippage;
    if (typeof globalThis !== 'undefined' && globalThis.PTSlippage) return globalThis.PTSlippage;
    if (typeof require === 'function') {
      try { return require('./slippage.js'); } catch (e) { /* not available */ }
    }
    return null;
  }

  /**
   * The pool reserves a fill can be priced against, if the caller knows them.
   *
   * Accepted either flat on the order (`o.baseReserve` / `o.quoteReserve`) or
   * nested (`o.reserves`), because the on-chain feed hands the pool around as
   * one object. Both must be present and positive — a half-known pool is not
   * a pool, and guessing the missing side would invent the exact number this
   * product refuses to invent. Returns null when the fill has no pool context,
   * which is the signal to fall back to the flat `settings.slippageBps`.
   */
  function reserveContext(o) {
    const src = (o && o.reserves && typeof o.reserves === 'object') ? o.reserves : o;
    if (!src) return null;
    const baseReserve = Number(src.baseReserve);
    const quoteReserve = Number(src.quoteReserve);
    if (!Number.isFinite(baseReserve) || !(baseReserve > 0)) return null;
    if (!Number.isFinite(quoteReserve) || !(quoteReserve > 0)) return null;
    return { baseReserve, quoteReserve };
  }

  /**
   * Turn a constant-product quote into a multiplier on the LIVE tick.
   *
   * WHY a ratio rather than the pool's own avgPrice: the reserve snapshot and
   * the tick the trader is looking at are two different observations, seconds
   * apart and often in different unit scales (raw lamports vs UI SOL). Using
   * the pool's absolute avgPrice would silently re-price the fill to whatever
   * the stale snapshot thought the coin was worth. The RATIO avgPrice/spot is
   * unit-free and staleness-free — it is purely "how far into the curve this
   * size pushes" — so it can be applied to the price actually on screen.
   */
  function impactRatio(quote, pool) {
    if (!quote) return null;
    const S = slippageApi();
    const spot = S && typeof S.spotPrice === 'function' ? S.spotPrice(pool) : null;
    if (!(spot > 0)) return null;
    const ratio = quote.avgPrice / spot;
    if (!Number.isFinite(ratio) || !(ratio > 0)) return null;
    return ratio;
  }

  /**
   * Effective buy price.
   *
   * With pool reserves AND a trade size, the fill walks the constant-product
   * curve: size moves the price, exactly as it does on chain. A 50 SOL buy
   * into a 12 SOL pool no longer fills at the same price as a 0.01 SOL buy.
   *
   * Without them — off-pump.fun venues, replays, every pre-existing caller —
   * there is no curve to walk, so the user's configured `settings.slippageBps`
   * still rules. That fallback is why the flat setting stays: it is the answer
   * for fills whose pool we cannot see, not dead weight.
   *
   * `ctx.solIn` must already be NET OF FEES — fees are fees.js's concern and
   * folding them in here would double-charge them.
   */
  function buyPrice(px, settings, ctx) {
    const pool = reserveContext(ctx);
    const S = slippageApi();
    if (pool && S && typeof S.quoteBuy === 'function') {
      const solIn = Number(ctx && ctx.solIn);
      if (Number.isFinite(solIn) && solIn > 0) {
        const ratio = impactRatio(S.quoteBuy({
          solIn, baseReserve: pool.baseReserve, quoteReserve: pool.quoteReserve,
        }), pool);
        // The curve REPLACES the flat cushion rather than stacking on it:
        // slippageBps is a stand-in for impact we could not measure, and we
        // just measured it.
        if (ratio !== null) return px * ratio;
      }
    }
    return px * (1 + applyBps(1, settings.slippageBps));
  }

  /**
   * Effective sell price. Mirror of buyPrice: `ctx.tokensIn` is the quantity
   * being sold, already net of fees.
   */
  function sellPrice(px, settings, ctx) {
    const pool = reserveContext(ctx);
    const S = slippageApi();
    if (pool && S && typeof S.quoteSell === 'function') {
      const tokensIn = Number(ctx && ctx.tokensIn);
      if (Number.isFinite(tokensIn) && tokensIn > 0) {
        const ratio = impactRatio(S.quoteSell({
          tokensIn, baseReserve: pool.baseReserve, quoteReserve: pool.quoteReserve,
        }), pool);
        if (ratio !== null) return px * ratio;
      }
    }
    return px * (1 - applyBps(1, settings.slippageBps));
  }
  /** Flat per-transaction cost (priority fee + tip), sanity-bounded. */
  function txCostSol(settings) {
    const gas = clamp(Number(settings && settings.gasSolPerTx) || 0, 0, 0.5);
    const tip = clamp(Number(settings && settings.tipSolPerTx) || 0, 0, 0.5);
    return gas + tip;
  }

  /* ---------------- fills ---------------- */

  function getPosition(state, mint) {
    return state.positions[mint] || null;
  }

  /**
   * Buy `solAmount` gross SOL of the token. Returns {trade, state} or throws.
   */
  function buy(state, settings, o) {
    const sol = Number(o.solAmount);
    const flat = txCostSol(settings);
    if (!(sol > 0)) throw new Error('Buy amount must be > 0 SOL');

    // Fee FIRST, price second. The constant-product curve must be walked with
    // the SOL that actually reaches the pool, not the gross order: the fee is
    // skimmed before the swap, so charging impact on it would invent size that
    // never touched the reserves.
    const feeBps = effectiveFeeBps(settings, o);
    const fee = applyBps(sol, feeBps);
    const net = sol - fee;

    const px = buyPrice(Number(o.priceNative), settings, {
      baseReserve: o.baseReserve,
      quoteReserve: o.quoteReserve,
      reserves: o.reserves,
      solIn: net,
    });
    if (!(px > 0)) throw new Error('No live price available');
    if (sol + flat > state.cashSol + EPS) {
      throw new Error(flat > 0
        ? `Insufficient paper balance for ${fmt(sol)} SOL + ${fmt(flat)} SOL tx costs (${fmt(state.cashSol)} SOL left)`
        : `Insufficient paper balance (${fmt(state.cashSol)} SOL left)`);
    }

    const qty = net / px;

    let pos = state.positions[o.mint];
    if (!pos) {
      pos = state.positions[o.mint] = {
        mint: o.mint,
        symbol: o.symbol || short(o.mint),
        name: o.name || o.symbol || '',
        site: o.site || 'unknown',
        pairAddress: o.pairAddress || null,
        sessionId: replaySessionId(o.mint, o.ts),
        thesis: null,
        qty: 0,
        costSol: 0,          // net SOL spent on the open stack
        investedSol: 0,      // gross SOL spent (incl. fees) on this round
        netInvestedSol: 0,   // net SOL (gross minus buy fees) spent on this round
        peakPnlSol: 0,
        troughPnlSol: 0,
        openedAt: o.ts,
        lastPriceNative: px,
        lastPriceUsd: o.priceUsd || null,
        // Multichain: the chain the token lives on ('solana' default). Off-
        // Solana fills price in derived SOL (docs/MULTICHAIN.md) and the
        // batch poller needs the chain to re-quote the right family.
        chain: o.chain || 'solana',
      };
    }
    // Upgrade a legacy open position in place so replays can still be attached
    // after the extension updates from an older version.
    if (!pos.sessionId) pos.sessionId = replaySessionId(pos.mint, pos.openedAt || o.ts);

    // Bug 6 (Twitch 2026-08-22, "in the Positions section it's picking up
    // the links incorrectly"): on pair-URL sites (Axiom /meme/, Photon /lp/)
    // a brand-new pair trades under its PAIR stand-in while the position is
    // pending, so the buy that opens the bag records pairAddress: null. The
    // resolver learns the pool seconds later, but the position's own
    // pairAddress was write-once — every link built from it forever after
    // fell back to the mint route (axiom.trade/t/<mint>), which for a
    // brand-new pair does not exist yet. "Click a position to jump to its
    // chart" landed on a dead page. Every buy re-offers the page's CURRENT
    // identity: a null pairAddress heals, and a stale one is corrected to
    // the pool the chart is actually trading on.
    if (o.pairAddress && o.pairAddress !== pos.pairAddress) pos.pairAddress = o.pairAddress;

    pos.qty += qty;
    // Flat tx costs (gas + tip) join the COST BASIS: they bought no tokens,
    // but this trade cannot break even until the price covers them — which
    // is exactly what real fills feel like. Routing them through costSol
    // means per-sell P&L, rounds, the calendar, and the equity identity all
    // account for them with no special cases downstream.
    pos.costSol += net + flat;
    pos.investedSol += sol + flat;
    // D-08: total NET invested never shrinks (mirrors investedSol). costSol
    // DOES shrink proportionally on partial sells, so costSol/netInvestedSol
    // is the surviving fraction of the stack — which lets grossOpenCostSol()
    // recover the gross cost of what is still open. Legacy positions predate
    // the field; `|| 0` upgrades them in place on their next buy.
    pos.netInvestedSol = (Number(pos.netInvestedSol) || 0) + net + flat;
    pos.lastPriceNative = px;
    pos.lastPriceUsd = o.priceUsd || pos.lastPriceUsd;

    state.cashSol -= sol + flat;
    state.stats.totalBuys += 1;
    state.stats.feesPaidSol += fee + flat;

    const trade = {
      id: tradeId(o.ts),
      ts: o.ts,
      site: o.site || pos.site,
      mint: o.mint,
      symbol: pos.symbol,
      sessionId: pos.sessionId,
      side: 'buy',
      qty,
      priceNative: px,
      priceUsd: o.priceUsd || null,
      solGross: sol,
      feeSol: fee,
      txCostSol: flat,
      solNet: net,
      mcap: o.mcap || null,
      chain: pos.chain || o.chain || 'solana',
    };
    // Foreign-chain panels order in dollars; the tapped amount is recorded
    // so receipts echo the order as placed, not just its SOL conversion.
    if (Number(o.quotedUsd) > 0) trade.quotedUsd = Number(o.quotedUsd);
    // F-48: price provenance rides the journal row. Stored-not-committed
    // (the solNet pattern) — the attestation preimage is untouched.
    if (o.priceSource) trade.priceSource = String(o.priceSource);
    if (Number.isFinite(o.priceAgeMs)) trade.priceAgeMs = Math.max(0, Math.round(o.priceAgeMs));
    if (o.supplySource) trade.supplySource = String(o.supplySource);
    if (o.hostSupplyWitness) trade.hostSupplyWitness = o.hostSupplyWitness;
    state.journal.unshift(trade);
    pruneJournal(state);
    return { trade, position: pos };
  }

  /**
   * Sell `qtyFraction` (0..1) of the current position. Returns {trade, state}.
   * Closing the whole stack also closes the round trip and appends to rounds.
   */
  function sell(state, settings, o) {
    const pos = state.positions[o.mint];
    if (!pos || pos.qty <= EPS) throw new Error('No open paper position in this token');
    if (!pos.sessionId) pos.sessionId = replaySessionId(pos.mint, pos.openedAt || o.ts);

    let qty = Number(o.qty);
    if (!(qty > 0)) {
      const frac = clamp(Number(o.qtyFraction), 0, 1);
      qty = pos.qty * frac;
    }
    qty = Math.min(qty, pos.qty);
    if (qty <= EPS) throw new Error('Sell quantity is zero');

    const px = sellPrice(Number(o.priceNative), settings, {
      baseReserve: o.baseReserve,
      quoteReserve: o.quoteReserve,
      reserves: o.reserves,
      // The whole clip hits the pool at once, so the whole clip walks the
      // curve. Fees are taken from the PROCEEDS below (fees.js's concern),
      // which is why the gross quantity is the honest curve input here.
      tokensIn: qty,
    });
    if (!(px > 0)) throw new Error('No live price available');

    const gross = qty * px;
    const feeBps = effectiveFeeBps(settings, o);
    const fee = applyBps(gross, feeBps);
    const flat = txCostSol(settings);
    // Net proceeds pay the platform fee AND the flat tx costs. A dust sell
    // can genuinely net negative — you paid gas to exit a worthless bag,
    // which is precisely the lesson worth learning on paper.
    const net = gross - fee - flat;

    const costShare = pos.costSol * (qty / pos.qty);
    const pnl = net - costShare;

    pos.qty -= qty;
    pos.costSol -= costShare;
    pos.lastPriceNative = px;
    pos.lastPriceUsd = o.priceUsd || pos.lastPriceUsd;

    state.cashSol += net;
    state.stats.totalSells += 1;
    state.stats.feesPaidSol += fee + flat;
    state.stats.realizedPnlSol += pnl;

    const trade = {
      id: tradeId(o.ts),
      ts: o.ts,
      site: o.site || pos.site,
      mint: o.mint,
      symbol: pos.symbol,
      sessionId: pos.sessionId,
      side: 'sell',
      qty,
      priceNative: px,
      priceUsd: o.priceUsd || null,
      solGross: gross,
      feeSol: fee,
      txCostSol: flat,
      solNet: net,
      pnlSol: pnl,
      mcap: o.mcap || null,
      chain: pos.chain || 'solana',
    };
    // An exit fired by an armed order records what was ASKED for beside what
    // the market GAVE. Without both numbers the journal quietly implies the
    // stop filled where it was placed — see the chart-orders note above.
    if (o.order && o.order.kind) {
      trade.orderKind = o.order.kind;
      trade.triggerPrice = Number(o.order.triggerPrice) || null;
      trade.triggerMcap = Number(o.order.triggerMcap) || null;
      // Measured against the RAW observed price, not the post-slippage fill:
      // configured slippage is already its own line item (feeSol/txCostSol),
      // and counting it here would charge the user for it twice.
      trade.triggerSlipPct = orderSlipPct(o.order, Number(o.priceNative));
    }
    // F-48: price provenance — see buy().
    if (o.priceSource) trade.priceSource = String(o.priceSource);
    if (Number.isFinite(o.priceAgeMs)) trade.priceAgeMs = Math.max(0, Math.round(o.priceAgeMs));
    if (o.supplySource) trade.supplySource = String(o.supplySource);
    if (o.hostSupplyWitness) trade.hostSupplyWitness = o.hostSupplyWitness;
    state.journal.unshift(trade);
    pruneJournal(state);

    let round = null;
    if (pos.qty <= Math.max(pos.investedSol, 1) * 1e-9 || pos.qty <= EPS) {
      round = closeRound(state, pos, o.ts);
      delete state.positions[o.mint];
      // The bag is gone, so every level still armed against it is now an
      // order with nothing behind it. Leaving them would fire phantom sells
      // on the next tick — and would resurrect on the chart after a re-entry.
      clearOrders(state, o.mint);
      // The After: px is the effective exit price the trader actually got —
      // the honest reference for everything that happens next.
      if (!settings || settings.postExitWatchEnabled !== false) {
        beginPostWatch(state, round, px);
      }
    }
    return { trade, position: pos.qty > EPS ? pos : null, round };
  }

  /**
   * Does a journal fill belong to this open position's round?
   *
   * Matching by mint alone breaks on fresh launches: a fill committed while
   * the page still showed the PAIR stand-in address carries the stand-in as
   * its mint, and rekeyMint (F-51) deliberately never rewrites the journal —
   * fill rows are hashed into the attestation chain, so editing history
   * would fork the record. The sessionId is stamped on every fill at write
   * time and survives the rename; mint stays as the fallback for legacy
   * fills written before sessionIds existed.
   */
  function tradeInRound(trade, pos) {
    if (!trade || !(Number(trade.ts) >= Number(pos.openedAt))) return false;
    if (trade.sessionId && pos.sessionId) {
      if (trade.sessionId === pos.sessionId) return true;
      if (Array.isArray(pos.mergedSessionIds)
        && pos.mergedSessionIds.indexOf(trade.sessionId) !== -1) return true;
      // Fall through: same mint after openedAt is still this round (a fill
      // written by another context before it adopted the merged session).
    }
    return trade.mint === pos.mint;
  }

  function closeRound(state, pos, ts) {
    const sold = state.journal.filter((t) => t.side === 'sell' && tradeInRound(t, pos));
    const returned = sold.reduce((s, t) => s + t.solNet, 0);
    const round = {
      id: 'r' + ts.toString(36) + Math.random().toString(36).slice(2, 7),
      mint: pos.mint,
      symbol: pos.symbol,
      name: pos.name || '',
      site: pos.site,
      pairAddress: pos.pairAddress || null,
      sessionId: pos.sessionId || replaySessionId(pos.mint, pos.openedAt),
      // Preserved with the result so the plan can be graded against what
      // actually happened.
      thesis: pos.thesis || null,
      openedAt: pos.openedAt,
      closedAt: ts,
      heldMs: ts - pos.openedAt,
      chain: pos.chain || 'solana',
      investedSol: pos.investedSol,
      returnedSol: returned,
      pnlSol: returned - pos.investedSol,
      pnlPct: pos.investedSol > 0 ? (returned / pos.investedSol - 1) * 100 : 0,
      peakPnlSol: pos.peakPnlSol,
      troughPnlSol: pos.troughPnlSol,
      tradeIds: state.journal.filter((t) => tradeInRound(t, pos)).map((t) => t.id),
      aiReview: null,
      recordingFile: null,
    };
    state.rounds.unshift(round);
    if (state.rounds.length > 500) state.rounds.length = 500;
    return round;
  }

  /**
   * Entry / exit market caps for a closed round, derived from its journal
   * fills (U4 — 01jb, ideas 8/21: "trade history bought/held/sold" in the
   * words traders actually use: "bought at 40k, sold at 240k"). VWAP per side,
   * weighted by SOL spent/received so a scaled-out exit quotes its true
   * average, not the last leg. Old rounds whose journal has been pruned
   * return nulls — the column renders an em-dash, never a fabricated number.
   */
  function roundMcapPair(state, round) {
    if (!round || !state || !state.journal) return { entryMcap: null, exitMcap: null };
    const ids = new Set(round.tradeIds || []);
    let wSum = 0, mSum = 0, wSellSum = 0, mSellSum = 0;
    for (const t of state.journal) {
      if (!ids.has(t.id)) continue;
      const sol = Math.abs(Number(t.solNet)) || 0;
      const m = Number(t.mcap);
      if (!(sol > 0) || !(m > 0)) continue;
      if (t.side === 'buy') { wSum += sol; mSum += sol * m; }
      else if (t.side === 'sell') { wSellSum += sol; mSellSum += sol * m; }
    }
    return {
      entryMcap: wSum > 0 ? mSum / wSum : null,
      exitMcap: wSellSum > 0 ? mSellSum / wSellSum : null,
    };
  }

  /**
   * F-51 — a fresh-launch fill lands while the page still shows the PAIR
   * stand-in address, so the position is keyed under the stand-in. When the
   * prewatch probe or the resolver upgrades the token to its real mint, the
   * lookup key changes underneath the open position and the card renders
   * empty on the very coin that was just bought — "it just wipes the
   * position like i never bought" (cantstoplarping, Discord 2026-08-11).
   * The armed-buy intent already survived this rename; the position never
   * did.
   *
   * Rekeying moves every LIVE structure keyed by the stand-in: the position,
   * armed orders, alerts, and post-exit watches. The journal and closed
   * rounds are deliberately untouched — fill rows are hashed into the
   * attestation chain, so rewriting their mint would fork the record. Round
   * arithmetic instead matches fills by sessionId (tradeInRound), which
   * survives the rename.
   *
   * Returns true when anything moved, so callers know whether to persist.
   */
  function rekeyMint(state, oldMint, newMint) {
    if (!state || !oldMint || !newMint || oldMint === newMint) return false;
    let moved = false;

    const positions = state.positions || {};
    const pos = positions[oldMint];
    if (pos) {
      const existing = positions[newMint];
      if (existing) {
        // The same token held under both identities — an earlier stack under
        // the real mint, a fresh buy under the stand-in. One bag, one card.
        existing.qty += pos.qty;
        existing.costSol += pos.costSol;
        existing.investedSol += pos.investedSol;
        existing.netInvestedSol = (Number(existing.netInvestedSol) || 0)
          + (Number(pos.netInvestedSol) || 0);
        existing.openedAt = Math.min(existing.openedAt, pos.openedAt);
        // Same token, same price series: the combined extremes are at least
        // each stack's own. The exact combined series is unknowable after
        // the fact — these bounds are honest, a fabricated series is not.
        existing.peakPnlSol = Math.max(Number(existing.peakPnlSol) || 0, Number(pos.peakPnlSol) || 0);
        existing.troughPnlSol = Math.min(Number(existing.troughPnlSol) || 0, Number(pos.troughPnlSol) || 0);
        if (!existing.thesis) existing.thesis = pos.thesis;
        if (Number(pos.lastPriceNative) > 0) existing.lastPriceNative = pos.lastPriceNative;
        if (pos.lastPriceUsd) existing.lastPriceUsd = pos.lastPriceUsd;
        if (!existing.pairAddress) existing.pairAddress = pos.pairAddress;
        // The absorbed stack's fills still carry its sessionId — remember it
        // so tradeInRound keeps the round's money arithmetic whole.
        const absorbed = [pos.sessionId, ...(Array.isArray(pos.mergedSessionIds) ? pos.mergedSessionIds : [])];
        for (const sid of absorbed) {
          if (!sid || sid === existing.sessionId) continue;
          if (!Array.isArray(existing.mergedSessionIds)) existing.mergedSessionIds = [];
          if (existing.mergedSessionIds.indexOf(sid) === -1) existing.mergedSessionIds.push(sid);
        }
      } else {
        positions[newMint] = pos;
        pos.mint = newMint;
      }
      delete positions[oldMint];
      moved = true;
    }

    if (state.orders && state.orders[oldMint]) {
      const carried = ordersFor(state, oldMint).map((o) => ({ ...o, mint: newMint }));
      if (carried.length) state.orders[newMint] = [...ordersFor(state, newMint), ...carried];
      delete state.orders[oldMint];
      moved = true;
    }

    if (state.alerts && state.alerts[oldMint]) {
      const carried = alertsFor(state, oldMint).map((a) => ({ ...a, mint: newMint }));
      if (carried.length) state.alerts[newMint] = [...alertsFor(state, newMint), ...carried];
      delete state.alerts[oldMint];
      moved = true;
    }

    if (Array.isArray(state.postWatch)) {
      for (const w of state.postWatch) {
        if (w && w.mint === oldMint) { w.mint = newMint; moved = true; }
      }
    }

    return moved;
  }

  /* ---------------- post-exit truth ("The After") ----------------
   *
   * The most expensive lesson in this market is what happens AFTER you sell:
   * did it run without you, or did your exit dodge the dump? Guessing at that
   * is how revenge FOMO starts. When a round closes, the token stays on a
   * bounded watch list and the extremes we actually OBSERVE get recorded onto
   * the round. Observed means observed: sample counts are stored, a watch
   * that saw nothing records nothing, and no continuous series is invented.
   */
  const POST_WATCH_WINDOW_MS = 60 * 60 * 1000;
  const POST_WATCH_CAP = 12;

  function beginPostWatch(state, round, exitPriceNative) {
    if (!round || !(Number(exitPriceNative) > 0)) return;
    if (!Array.isArray(state.postWatch)) state.postWatch = [];
    state.postWatch = state.postWatch.filter((w) => w.roundId !== round.id);
    state.postWatch.unshift({
      roundId: round.id,
      mint: round.mint,
      exitPriceNative: Number(exitPriceNative),
      closedAt: round.closedAt,
      until: round.closedAt + POST_WATCH_WINDOW_MS,
      maxPriceNative: null,
      minPriceNative: null,
      samples: 0,
      lastSampleAt: 0,
    });
    if (state.postWatch.length > POST_WATCH_CAP) state.postWatch.length = POST_WATCH_CAP;
  }

  /** Feed an observed price into any active post-exit watches for the mint. */
  function notePostExitPrice(state, mint, priceNative, ts) {
    const list = Array.isArray(state.postWatch) ? state.postWatch : null;
    const p = Number(priceNative);
    if (!list || !list.length || !(p > 0)) return false;
    const now = Number(ts) || Date.now();
    let touched = false;
    for (const w of list) {
      if (w.mint !== mint || now > w.until || now < w.closedAt) continue;
      if (w.maxPriceNative === null || p > w.maxPriceNative) w.maxPriceNative = p;
      if (w.minPriceNative === null || p < w.minPriceNative) w.minPriceNative = p;
      w.samples += 1;
      w.lastSampleAt = now;
      touched = true;
    }
    return touched;
  }

  /**
   * Move expired watches onto their rounds as `afterExit`. A watch that never
   * saw a sample records nothing — an honest gap, not a guess.
   */
  function finalizePostWatches(state, now) {
    const list = Array.isArray(state.postWatch) ? state.postWatch : null;
    if (!list || !list.length) return 0;
    const ts = Number(now) || Date.now();
    let finalized = 0;
    state.postWatch = list.filter((w) => {
      if (ts <= w.until) return true;
      const round = (state.rounds || []).find((r) => r.id === w.roundId);
      if (round && w.samples > 0) {
        round.afterExit = {
          windowMs: POST_WATCH_WINDOW_MS,
          maxPriceNative: w.maxPriceNative,
          minPriceNative: w.minPriceNative,
          maxPct: (w.maxPriceNative / w.exitPriceNative - 1) * 100,
          minPct: (w.minPriceNative / w.exitPriceNative - 1) * 100,
          samples: w.samples,
          observedUntil: w.lastSampleAt,
        };
        finalized += 1;
      }
      return false;
    });
    return finalized;
  }

  /** Mints that post-exit watching still needs prices for. */
  function postWatchMints(state, now) {
    const list = Array.isArray(state.postWatch) ? state.postWatch : null;
    if (!list || !list.length) return [];
    const ts = Number(now) || Date.now();
    return [...new Set(list.filter((w) => ts <= w.until).map((w) => w.mint))];
  }

  /* ---------------- guardrails (training wheels) ----------------
   *
   * The three rules every surviving trader eventually adopts, enforceable
   * here while the money is fake: a tilt breaker, a position-size cap, and a
   * daily loss limit. Pure decision function — the caller shows the message.
   */
  function guardCheck(state, settings, o) {
    const now = Number(o && o.now) || Date.now();
    const sol = Number(o && o.solAmount) || 0;

    if (settings.guardTiltEnabled) {
      const losses = clamp(Number(settings.guardTiltLosses) || 4, 2, 10);
      const coolMs = clamp(Number(settings.guardTiltMinutes) || 10, 1, 120) * 60_000;
      const recent = (state.rounds || []).slice(0, losses);
      if (recent.length >= losses && recent.every((r) => Number(r.pnlSol) < 0)) {
        const remaining = (Number(recent[0].closedAt) || 0) + coolMs - now;
        if (remaining > 0) {
          return {
            ok: false, reason: 'tilt', remainingMs: remaining,
            message: 'Tilt guard: ' + losses + ' straight losses — paused '
              + Math.ceil(remaining / 60000) + ' more min. Breathe. (Settings → Guardrails)',
          };
        }
      }
    }

    if (Number(settings.guardMaxPositionPct) > 0 && sol > 0) {
      const eq = equitySol(state);
      const cap = eq * (Number(settings.guardMaxPositionPct) / 100);
      if (sol > cap + EPS) {
        return {
          ok: false, reason: 'size',
          message: 'Size guard: ' + fmt(sol) + ' SOL is over '
            + settings.guardMaxPositionPct + '% of your ' + fmt(eq)
            + ' SOL book (max ' + fmt(cap) + ' — Settings → Guardrails)',
        };
      }
    }

    if (Number(settings.guardDailyLossSol) > 0) {
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      const start = dayStart.getTime();
      const todayPnl = (state.journal || [])
        .filter((t) => t.side === 'sell' && Number(t.ts) >= start && t.pnlSol !== undefined)
        .reduce((s, t) => s + Number(t.pnlSol || 0), 0);
      if (todayPnl <= -Number(settings.guardDailyLossSol)) {
        return {
          ok: false, reason: 'dailyLoss',
          message: 'Daily loss guard: ' + fmt(todayPnl)
            + ' SOL today — that is the limit you set. Come back tomorrow. (Settings → Guardrails)',
        };
      }
    }

    return { ok: true };
  }

  /* ---------------- marks / analytics ---------------- */

  /** Mark an open position to the latest tick. Tracks peak/trough P&L. */
  function markPosition(state, mint, priceNative, priceUsd) {
    const pos = state.positions[mint];
    if (!pos) return null;
    pos.lastPriceNative = priceNative;
    if (priceUsd) pos.lastPriceUsd = priceUsd;
    const unrealized = pos.qty * priceNative - pos.costSol;
    if (unrealized > pos.peakPnlSol) pos.peakPnlSol = unrealized;
    if (unrealized < pos.troughPnlSol) pos.troughPnlSol = unrealized;
    return { unrealized, pos };
  }

  function unrealizedPnl(pos) {
    return pos.qty * pos.lastPriceNative - pos.costSol;
  }

  /* How far the derived curve anchor may sit from the caller's starting
   * balance before we conclude the journal does not account for all of
   * current equity. Float drift over thousands of fills is far below this;
   * a single dropped fill is far above it. */
  const CURVE_ANCHOR_EPS = 1e-6;

  /**
   * D-56: the per-fill equity step, in SOL.
   *
   * The ONE definition of "what this fill did to equity" — shared by the
   * curve walk (equityCurvePoints) and the birth backfill (derivedBirthSol)
   * so the two can never drift apart. A BUY debits its fee: the cash that
   * left the wallet to buy it was solGross, only solGross − fee became
   * position cost, and that missing sliver is the fee (feeSol, falling back
   * to solGross − solNet for fills recorded before the field existed; the
   * flat tx cost rides costSol, so it stays inside the open-position term
   * and is never stepped separately). A SELL credits its per-sell pnlSol —
   * net proceeds minus the position's cost share, so the whole open→closed
   * transition nets exactly to the banked pnl.
   */
  function stepOf(t) {
    if (t.side === 'buy') {
      const feeRaw = Number(t.feeSol);
      const fee = Number.isFinite(feeRaw) && feeRaw >= 0
        ? feeRaw
        : (Number.isFinite(Number(t.solNet))
          ? Math.max(0, (Number(t.solGross) || 0) - Number(t.solNet))
          : 0);
      return -fee;
    }
    if (t.side === 'sell') return Number(t.pnlSol) || 0;
    return 0;
  }

  function equitySol(state) {
    let eq = state.cashSol;
    for (const mint of Object.keys(state.positions)) {
      const p = state.positions[mint];
      eq += p.qty * (p.lastPriceNative || 0);
    }
    return eq;
  }

  /**
   * D-56: the wallet's BIRTH balance, re-derived from the fill journal alone.
   *
   * equityCurvePoints proves the identity: equity = birth + Σ stepOf(fills)
   * + openPnl, so birth = equity − Σ stepOf − openPnl. That derivation is
   * the wallet's own arithmetic — it needs no mark that the journal doesn't
   * already hold (an unmarked bag contributes lastPrice 0, exactly like
   * bridgeWallet), and it is stable across every writer that only appends
   * fills or moves marks.
   *
   * This is the anchor every legacy wallet (created before D-06's
   * state.startSol snapshot, v3.9.5) is missing. For those,
   * anchorStartSol was still reading the LIVE "Starting paper balance"
   * setting, so editing the form retroactively rewrote the whole session —
   * jb's 8/18 wallet: born 10, setting edited to 1, +0.091 SOL of real
   * profit displayed as +9.109 SOL (exactly the 10→1 gap).
   *
   * Returns the derived birth, or null when the derivation is not trustworthy
   * (no fills to derive from, or a non-finite result) — a null never
   * overwrites the setting fallback, it just defers to it.
   */
  function derivedBirthSol(state) {
    if (!state) return null;
    const journal = (state.journal || []).slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    if (!journal.length) return null;
    let openPnl = 0;
    for (const pos of Object.values(state.positions || {})) {
      if (pos && Number(pos.qty) > 0) openPnl += unrealizedPnl(pos);
    }
    let walked = 0;
    for (const t of journal) walked += stepOf(t);
    const derived = equitySol(state) - openPnl - walked;
    if (!Number.isFinite(derived)) return null;
    return derived;
  }

  /**
   * D-56: one-time birth-anchor backfill.
   *
   * Freezes the journal-derived birth balance onto state.startSol for wallets
   * created before D-06 snapshotted it at birth. Idempotent — a state that
   * already carries a positive startSol is left byte-for-byte untouched —
   * and conservative: it only writes when the derivation is finite and
   * clearly positive (well above float dust), so a wallet whose equity
   * drifted to zero is never anchored on noise, and an empty journal is
   * never anchored on nothing.
   *
   * Callers persist the returned state through their normal CAS writer; the
   * read-only surfaces (popup/overlay/bridge) that can't write use
   * anchorStartSol's derived layer directly.
   *
   * Returns true when a snapshot was written.
   */
  function backfillAnchor(state, settings) {
    if (!state || typeof state !== 'object') return false;
    const birth = Number(state.startSol);
    if (Number.isFinite(birth) && birth > 0) return false; // already anchored
    const derived = derivedBirthSol(state);
    if (derived === null || derived <= CURVE_ANCHOR_EPS) return false;
    state.startSol = derived;
    return true;
  }

  /**
   * D-01: the realized-equity timeline the dashboard curve draws.
   *
   * The old curve accumulated journal sell pnlSol only. That figure is net of
   * SELL fees but not BUY fees (sell(): pnl = net proceeds − NET cost share),
   * so the curve sat above true equity by the cumulative buy fees and
   * diverged monotonically from the equitySol KPI on the same screen.
   *
   * Each BUY therefore debits its fee as it is walked (trade.feeSol, falling
   * back to solGross − solNet for fills recorded before feeSol existed), and
   * each SELL credits its per-sell pnlSol. With the buy fee accounted at buy
   * time and open positions marked with the same net-basis unrealizedPnl(),
   * the identity is exact: the final point equals equitySol(state)
   * (cash + marked positions) whenever the journal covers every fill.
   *
   * D-51: the journal is CAPPED (pruneJournal keeps the newest 2000 fills),
   * so on any wallet past that cap it does NOT cover every fill — the
   * dropped fills' P&L is baked into cashSol but missing from the walk. The
   * curve's last point then froze while the equity KPI on the same screen
   * kept moving, and the gap grew with account age: the same monotonic
   * divergence this function was written to kill, reintroduced by
   * truncation.
   *
   * The anchor is therefore DERIVED rather than assumed. Walking the
   * retained journal backwards from equity known to be true gives the equity
   * at the oldest RETAINED fill, which needs none of the data the cap threw
   * away. When the journal does cover everything that derivation equals
   * startSol exactly, so a complete book draws precisely the curve it drew
   * before; when it does not, the curve starts at the oldest fill it can
   * honestly speak for instead of claiming the account began there.
   */
  function equityCurvePoints(state, startSol, opts) {
    const start = Number(startSol) || 0;
    const journal = ((state && state.journal) || []).slice().sort((a, b) => a.ts - b.ts);
    const startedAt = Number(state && state.startedAt)
      || (journal[0] ? Number(journal[0].ts) : Date.now());

    // D-56: the per-fill step is the shared stepOf — the curve and the birth
    // backfill must walk the journal by the same rule or the two anchors
    // drift apart.
    let openPnl = 0;
    const positions = (state && state.positions) || {};
    for (const mint of Object.keys(positions)) openPnl += unrealizedPnl(positions[mint]);

    let walked = 0;
    for (const t of journal) walked += stepOf(t);
    // Unwind backwards from equity that is true by construction.
    const derived = equitySol(state) - openPnl - walked;
    // A non-finite derivation is deliberately NOT rescued by falling back to
    // the caller's figure. It is tempting — it would keep the historical
    // points finite — but it is the wrong trade: when equity is unknowable
    // (a corrupt cashSol, a broken mark) a start-anchored walk draws a
    // confident line and a green/red verdict for a wallet whose equity
    // nobody can compute, while the KPI beside it honestly reads "—". The
    // renderer takes min/max across the series, so a single non-finite point
    // already yields an empty chart either way; propagating is what keeps an
    // unknowable equity ABSENT from the screen instead of plausible on it.
    const covers = Math.abs(derived - start) <= CURVE_ANCHOR_EPS;
    // A covered journal keeps the caller's own starting figure, so the
    // complete case is bit-identical to what it has always drawn.
    const anchorEq = covers ? start : derived;
    const anchorT = covers || !journal.length ? startedAt : Number(journal[0].ts);

    const pts = [{ t: anchorT, eq: anchorEq }];
    let pnl = 0;
    for (const t of journal) {
      pnl += stepOf(t);
      pts.push({ t: t.ts, eq: anchorEq + pnl });
    }
    pts.push({ t: Number(opts && opts.now) || Date.now(), eq: anchorEq + pnl + openPnl });
    return pts;
  }

  /**
   * D-08: the gross (fee-inclusive) cost of what is still open in a position.
   *
   * Closed rounds measure their percentage against GROSS invested
   * (closeRound: returned / investedSol − 1). The open-position percentage
   * used pnl / costSol — a NET-of-buy-fee denominator (and numerator) — so
   * the same trade's % dropped ~2×feeBps at the moment of close with no
   * price move at all.
   *
   * costSol shrinks proportionally on partial sells while netInvestedSol
   * (total net ever invested) does not, so costSol / netInvestedSol is the
   * surviving fraction of the stack and invested × that fraction is its
   * gross cost. Legacy positions predate netInvestedSol: without partial
   * sells costSol === net invested and the full investedSol is exact, so it
   * is the fallback.
   */
  function grossOpenCostSol(pos) {
    if (!pos) return 0;
    const invested = Number(pos.investedSol) || 0;
    const cost = Number(pos.costSol) || 0;
    const netInvested = Number(pos.netInvestedSol) || 0;
    if (netInvested > 0) return invested * (cost / netInvested);
    return invested;
  }

  /**
   * D-08: open-position P&L percentage on the same gross-invested basis as
   * closed rounds, so the % no longer jumps ~2×feeBps at close. The residual
   * move at close is the SELL fee alone — a real cost, not an accounting
   * artifact.
   */
  function positionPnlPct(pos) {
    if (!pos) return 0;
    const value = (Number(pos.qty) || 0) * (Number(pos.lastPriceNative) || 0);
    const gross = grossOpenCostSol(pos);
    return gross > 0 ? (value / gross - 1) * 100 : 0;
  }

  function solUsdRate(state, settings) {
    for (const mint of Object.keys(state.positions)) {
      const p = state.positions[mint];
      if (p.lastPriceNative > 0 && p.lastPriceUsd > 0) return p.lastPriceUsd / p.lastPriceNative;
    }
    return null; // caller may override with live rate
  }

  /**
   * D-06: the honest denominator for every "% since start" figure.
   *
   * The wallet's birth balance (state.startSol) when the state recorded one;
   * the setting only as a legacy fallback for states that predate the field
   * (or hand-built test states). Reading the LIVE setting fabricated P&L:
   * raise the setting mid-wallet and a +1 SOL session on a 10 SOL birth
   * became "+90%" against 1 — retroactively rewriting history with a
   * settings form. The anchor is frozen at birth; only a wallet reset moves
   * it.
   *
   * D-56: the middle layer. Legacy wallets (pre-v3.9.5) never got
   * state.startSol, so the raw setting fallback kept their % — and their
   * SOL-vs-start — welded to a live form. When the journal can re-derive
   * the birth balance (derivedBirthSol), trust THAT before the setting.
   * backfillAnchor() persists the derived value onto state.startSol so this
   * layer is only ever needed on the first read after an update.
   */
  function anchorStartSol(state, settings) {
    const birth = Number(state && state.startSol);
    if (Number.isFinite(birth) && birth > 0) return birth;
    const derived = derivedBirthSol(state);
    if (derived !== null && derived > CURVE_ANCHOR_EPS) return derived;
    const setting = Number(settings && settings.balanceStartSol);
    return Number.isFinite(setting) && setting > 0 ? setting : 0;
  }

  function sessionStats(state, settings) {
    // D-52: a break-even round (pnlSol === 0) is neither a win nor a loss —
    // the old `<= 0` filter branded scratched trades as losses and dragged
    // the win rate down. Break-evens count in neither bucket, and the win
    // rate is judged over decided rounds only (wins + losses).
    const wins = state.rounds.filter((r) => r.pnlSol > 0).length;
    const losses = state.rounds.filter((r) => r.pnlSol < 0).length;
    const decided = wins + losses;
    // D-02: realized P&L is the PER-SELL accumulator sell() maintains
    // (state.stats.realizedPnlSol), which credits partial exits the moment
    // they happen. The old rounds-only sum reported +0 for a trade that had
    // banked +2 on a 50% exit, while the calendar and journal — both fed by
    // per-sell pnlSol — showed the +2: the same trade, three numbers. The
    // attest chain replay (attest.js replayChain) computes exactly this
    // per-sell figure, so the leaderboard honesty check agrees by
    // construction. Legacy/restored states can miss the accumulator; the
    // journal's sell pnlSol entries are the same definition and back-fill it.
    const st = state.stats || {};
    let realized = Number(st.realizedPnlSol);
    if (!Number.isFinite(realized)) {
      realized = (state.journal || []).reduce(
        (s, t) => s + (t.side === 'sell' ? (Number(t.pnlSol) || 0) : 0), 0
      );
    }
    const eq = equitySol(state);
    return {
      rounds: state.rounds.length,
      wins,
      losses,
      winRate: decided > 0 ? (wins / decided) * 100 : 0,
      realizedPnlSol: realized,
      openPositions: Object.keys(state.positions).length,
      unrealizedSol: Object.values(state.positions).reduce((s, p) => s + unrealizedPnl(p), 0),
      equitySol: eq,
      equityVsStart: eq - anchorStartSol(state, settings),
      feesPaidSol: Number(st.feesPaidSol) || 0,
      trades: state.journal.length,
      // jb (#ideas): "able to see how much u've bought/held/sold whilst
      // trading". Bought/sold are the journal's NET SOL per fill (what the
      // wallet actually moved); held is open positions at cost basis —
      // the same basis the equity number itself uses.
      // solGross is the order size the user typed/tapped — what they mean
      // by "I bought 2 SOL" — not the fee-adjusted solNet.
      boughtSol: (state.journal || []).reduce(
        (s, t) => s + (t.side === 'buy' ? (Math.abs(Number(t.solGross) || Number(t.solNet) || 0)) : 0), 0),
      soldSol: (state.journal || []).reduce(
        (s, t) => s + (t.side === 'sell' ? (Math.abs(Number(t.solGross) || Number(t.solNet) || 0)) : 0), 0),
      heldSol: Object.values(state.positions).reduce(
        (s, p) => s + grossOpenCostSol(p), 0),
    };
  }

  /* ---------------- trade thesis ---------------- */

  const THESIS_MAX = 600;
  // A short, fixed vocabulary beats free text alone: it makes patterns
  // countable across many trades, which is the point of journaling.
  const THESIS_TAGS = [
    'narrative', 'volume-spike', 'chart-setup', 'insider-wallets',
    'social-buzz', 'dip-buy', 'momentum', 'fomo', 'revenge', 'gut',
  ];
  const THESIS_PLANS = ['scalp', 'swing', 'runner', 'scratch'];

  function clampText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  /**
   * Normalize a thesis written before a position is opened.
   *
   * Returns null when nothing meaningful was written, so an empty box never
   * becomes a fake journal entry.
   */
  function normalizeThesis(input, ts) {
    const raw = input && typeof input === 'object' ? input : { text: input };
    const text = clampText(raw.text, THESIS_MAX);
    const tags = Array.isArray(raw.tags)
      ? [...new Set(raw.tags.filter((tag) => THESIS_TAGS.includes(tag)))].slice(0, 6)
      : [];
    const plan = THESIS_PLANS.includes(raw.plan) ? raw.plan : null;
    const conviction = Number(raw.conviction);
    const target = Number(raw.targetPct);
    const stop = Number(raw.stopPct);

    if (!text && !tags.length && !plan) return null;

    return {
      text,
      tags,
      plan,
      conviction: conviction >= 1 && conviction <= 5 ? Math.round(conviction) : null,
      targetPct: target > 0 ? target : null,
      stopPct: stop > 0 ? stop : null,
      // When the overlay snapped the chart as the thesis was written, this is
      // the frame's capture timestamp. The image itself lives in pt_frames
      // (joined by sessionId + time) — embedding it here would balloon every
      // pt_state write with a JPEG.
      frameAt: Number(raw.frameAt) > 0 ? Number(raw.frameAt) : null,
      // Written BEFORE the outcome is known — that is what makes it evidence.
      at: Number(ts) || Date.now(),
    };
  }

  /* ---------------- chart orders: take profit & stop loss ----------------
   *
   * Padre's exit ergonomics, on paper: arm a level by dragging a line on the
   * chart (or typing it), and the position exits itself when the market gets
   * there. The order model lives here so the RULES are pure and testable —
   * the chart drag, the panel and the background poller are all just ways to
   * produce and consume these objects.
   *
   * THE FILL PRICE IS THE HONEST ONE (maintainer call, 2026-08-06).
   *
   * A stop does NOT fill at its level. It fills at the next price this
   * machine actually OBSERVED after the level was crossed, and the journal
   * records both, so the gap is visible instead of hidden:
   *
   *     stop 180K -> filled 154K (-14.4% worse than asked)
   *
   * On an illiquid memecoin that difference is the whole lesson. A paper
   * stop that always fills exactly where you put it teaches an exit quality
   * that does not exist, and this project treats flattering numbers as a
   * safety defect, not a UX nicety. The trigger price is what you ASKED for;
   * the fill price is what the market GAVE you. Both are recorded.
   *
   * Spot positions are long-only, so the rule is simply:
   *   take profit  fires when the observed price is at or ABOVE its level
   *   stop loss    fires when the observed price is at or BELOW its level
   */

  const ORDER_KINDS = ['tp', 'sl'];
  const MAX_ORDERS_PER_MINT = 8;

  function orderId(ts) {
    return `o${Number(ts) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Validate and clamp a raw order. Returns null for anything unusable —
   * an order that cannot be honestly evaluated must never be armed.
   *
   * `referencePrice` is the live price at arm time. A take profit BELOW it
   * (or a stop ABOVE it) would fire on the very next tick, which is not an
   * order, it is a market sell wearing an order's costume — those are
   * refused so the user is told, rather than surprised.
   */
  function normalizeOrder(raw, referencePrice, ts) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = ORDER_KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;

    const triggerPrice = Number(raw.triggerPrice);
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return null;

    const ref = Number(referencePrice);
    if (Number.isFinite(ref) && ref > 0) {
      if (kind === 'tp' && triggerPrice <= ref) return null;
      if (kind === 'sl' && triggerPrice >= ref) return null;
    }

    // Size is a percentage of whatever the position holds WHEN IT FIRES, not
    // a token count frozen at arm time: the user may sell part of the bag by
    // hand first, and "take profit on half" must still mean half.
    const sizePct = clamp(Math.round(Number(raw.sizePct)) || 100, 1, 100);

    return {
      id: raw.id || orderId(ts),
      kind,
      triggerPrice,
      // Display-only: the market cap the level represents, captured at arm
      // time. Never used for evaluation — mcap depends on a supply figure
      // that can change, price is the thing actually compared.
      triggerMcap: Number(raw.triggerMcap) > 0 ? Number(raw.triggerMcap) : null,
      sizePct,
      // The price the order was armed against, kept so the UI can show the
      // move it is waiting for without guessing at the entry.
      armedAtPrice: Number.isFinite(ref) && ref > 0 ? ref : null,
      createdAt: Number(ts) || Date.now(),
    };
  }

  /** Every armed order for a mint, oldest first. Never returns null. */
  function ordersFor(state, mint) {
    const all = (state && state.orders) || {};
    return Array.isArray(all[mint]) ? all[mint] : [];
  }

  /**
   * Arm an order against the open position for a mint.
   *
   * Refuses when there is no position to exit: an order with nothing behind
   * it would fire into empty air and log a phantom sell.
   */
  function addOrder(state, mint, raw, referencePrice, ts) {
    const pos = state && state.positions && state.positions[mint];
    if (!pos || pos.qty <= EPS) throw new Error('No open paper position to attach an order to');
    const order = normalizeOrder(raw, referencePrice, ts);
    if (!order) throw new Error('That level cannot be armed — a take profit must sit above the price and a stop below it');
    if (!state.orders || typeof state.orders !== 'object') state.orders = {};
    const list = ordersFor(state, mint);
    if (list.length >= MAX_ORDERS_PER_MINT) {
      throw new Error(`At most ${MAX_ORDERS_PER_MINT} orders per token`);
    }
    order.mint = mint;
    state.orders[mint] = [...list, order];
    return order;
  }

  /** Move an armed order to a new level (the chart drag lands here). */
  function moveOrder(state, mint, id, triggerPrice, triggerMcap) {
    const list = ordersFor(state, mint);
    const order = list.find((o) => o.id === id);
    if (!order) return null;
    const next = Number(triggerPrice);
    if (!Number.isFinite(next) || next <= 0) return null;
    order.triggerPrice = next;
    order.triggerMcap = Number(triggerMcap) > 0 ? Number(triggerMcap) : null;
    return order;
  }

  function removeOrder(state, mint, id) {
    const list = ordersFor(state, mint);
    const next = list.filter((o) => o.id !== id);
    if (!state.orders) state.orders = {};
    if (next.length) state.orders[mint] = next;
    else delete state.orders[mint];
    return next.length !== list.length;
  }

  /** Drop every order for a mint — used when the position is fully closed. */
  function clearOrders(state, mint) {
    if (!state || !state.orders) return false;
    if (!state.orders[mint]) return false;
    delete state.orders[mint];
    return true;
  }

  /**
   * Which armed orders does this observed price fire?
   *
   * Evaluated per tick. Because the FIRST tick on which the condition holds
   * is by definition the next price observed after the level was crossed,
   * filling at that tick is exactly the honest-fill rule — a gap straight
   * through a stop is reported at the price the gap actually landed on.
   *
   * Highest-priority first: if a crash trips two stops at once, the LOWER
   * one is the more urgent truth, and if a spike trips two take profits the
   * HIGHER one is. Callers fill in the returned order.
   */
  function triggeredOrders(state, mint, observedPrice) {
    const price = Number(observedPrice);
    if (!Number.isFinite(price) || price <= 0) return [];
    return ordersFor(state, mint)
      .filter((o) => (o.kind === 'tp' ? price >= o.triggerPrice : price <= o.triggerPrice))
      .sort((a, b) => (a.kind === 'sl' ? a.triggerPrice - b.triggerPrice : b.triggerPrice - a.triggerPrice));
  }

  /* -------------------- pending limit buys (N2) --------------------
   * Ideas channel (.dgreatest 8/18: "Bring limit order"). A limit BUY is an
   * entry, not an exit: no position required, cash is LOCKED at arm time so
   * two armed buys cannot both spend the same SOL, and the trigger fills
   * the buy at the observed price (the honest-fill rule that governs
   * TP/SL fires — a gap through the level fills where the gap landed).
   * Shape: state.pendingBuys = { [mint]: [{ id, ts, mint, triggerPrice,
   * solAmount, lockedSol }] }. Locked cash is tracked separately from
   * cashSol so the wallet screen can show it and the fire path cannot
   * overspend; unlocked on cancel, expiry, or successful fill. */

  const PENDING_BUY_TTL_MS = 24 * 60 * 60 * 1000;

  function pendingBuysFor(state, mint) {
    const all = (state && state.pendingBuys) || {};
    return Array.isArray(all[mint]) ? all[mint] : [];
  }

  function addPendingBuy(state, settings, mint, o) {
    const trigger = Number(o.triggerPrice);
    const amount = Number(o.solAmount);
    if (!(trigger > 0)) throw new Error('A limit buy needs a trigger price above zero');
    if (!(amount > 0)) throw new Error('A limit buy needs a SOL amount above zero');
    const cash = Number(state.cashSol);
    const locked = lockedBuySol(state);
    if (cash - locked < amount) {
      throw new Error(`Not enough free SOL — ${fmt(cash - locked, 3)} available, `
        + `${fmt(amount, 3)} asked (locked: ${fmt(locked, 3)})`);
    }
    if (!state.pendingBuys || typeof state.pendingBuys !== 'object') state.pendingBuys = {};
    const list = pendingBuysFor(state, mint);
    if (list.length >= MAX_ORDERS_PER_MINT) {
      throw new Error(`At most ${MAX_ORDERS_PER_MINT} armed entries per token`);
    }
    const order = {
      id: 'pb' + o.ts.toString(36) + Math.random().toString(36).slice(2, 6),
      ts: o.ts, mint, kind: 'lb',
      triggerPrice: trigger, solAmount: amount, lockedSol: amount,
      symbol: o.symbol || null, name: o.name || null, site: o.site || null,
    };
    state.pendingBuys[mint] = [...list, order];
    return order;
  }

  function removePendingBuy(state, mint, id) {
    const list = pendingBuysFor(state, mint);
    const next = list.filter((o) => o.id !== id);
    if (next.length !== list.length) {
      if (!state.pendingBuys) state.pendingBuys = {};
      if (next.length) state.pendingBuys[mint] = next;
      else delete state.pendingBuys[mint];
      return true;
    }
    return false;
  }

  /** Total SOL locked by armed limit buys (spendable nowhere until released). */
  function lockedBuySol(state) {
    const all = (state && state.pendingBuys) || {};
    let total = 0;
    for (const mint of Object.keys(all)) {
      for (const o of all[mint]) total += Number(o.lockedSol) || 0;
    }
    return total;
  }

  /** Does this surface WANT the idle-SOL readout even with zero positions?
   *  (away32 8/21 — "overlay sol balance at the top without needing to open
   *  the ext"). Micro density: always. Anywhere: the moment the wallet has
   *  a history (a fill ever happened, cash ever moved off the birth value,
   *  or an armed order exists), because a trader who just closed everything
   *  should not watch their balance vanish from the screen with it. A
   *  factory-fresh wallet in standard density stays invisible as before —
   *  no chrome until there is something to show. */
  function densityWantsIdleSol(settings, state) {
    if (settings && settings.panelDensity === 'micro') return true;
    if (!state) return false;
    if (state.seq > 0) return true;
    if (state.stats && (state.stats.totalBuys > 0 || state.stats.totalSells > 0)) return true;
    if (Object.keys(state.pendingBuys || {}).length > 0) return true;
    if (Object.keys(state.orders || {}).length > 0) return true;
    if (state.cashSol !== state.startSol) return true;
    return false;
  }

  /**
   * Which armed limit buys does this observed price fire?
   * A limit buy triggers when the price DROPS TO or below its level.
   * Highest level first: on a knife through several bids, the bid placed
   * closest to the top of the fall is the most urgent truth.
   */
  function triggeredPendingBuys(state, mint, observedPrice) {
    const price = Number(observedPrice);
    if (!Number.isFinite(price) || price <= 0) return [];
    return pendingBuysFor(state, mint)
      .filter((o) => price <= o.triggerPrice)
      .sort((a, b) => b.triggerPrice - a.triggerPrice);
  }

  /** Expire stale armed entries (returns expired count; caller persists). */
  function expirePendingBuys(state, now) {
    const all = (state && state.pendingBuys) || {};
    let expired = 0;
    for (const mint of Object.keys(all)) {
      const keep = all[mint].filter((o) => now - o.ts <= PENDING_BUY_TTL_MS);
      expired += all[mint].length - keep.length;
      if (keep.length) all[mint] = keep;
      else delete all[mint];
    }
    return expired;
  }

  /**
   * How much worse (or better) the fill was than the level asked for.
   *
   * Signed from the TRADER's point of view, not the number line: negative
   * always means "worse than you asked for", for both order kinds. A stop
   * that gapped down and a take profit that filled below its target are the
   * same kind of disappointment and must read the same way.
   */
  function orderSlipPct(order, filledPrice) {
    const filled = Number(filledPrice);
    const trigger = Number(order && order.triggerPrice);
    if (!(filled > 0) || !(trigger > 0)) return null;
    return ((filled - trigger) / trigger) * 100;
  }

  /**
   * Every mint holding an armed order — the work list for the background
   * poller, and for deciding whether a page needs a live feed at all.
   */
  function mintsWithOrders(state) {
    const all = (state && state.orders) || {};
    return Object.keys(all).filter((mint) => ordersFor(state, mint).length > 0);
  }

  /* -------------------- market-cap alerts -------------------- */

  /**
   * "Tell me when it hits 500K."
   *
   * An alert is NOT an order. It never touches the wallet, so it carries
   * none of an order's obligations — and that frees it from the two rules
   * that shape the order model above:
   *
   *   1. AN ALERT NEEDS NO POSITION. The token you most want a ping on is
   *      the one you have not bought yet. addOrder refuses a mint with no
   *      open position because an order with nothing behind it would log a
   *      phantom sell; an alert has nothing to sell, so it simply watches.
   *      This is the watchlist PaperTrench did not previously have.
   *
   *   2. AN ALERT IS EVALUATED ON MARKET CAP, NOT PRICE. Orders are
   *      deliberately price-anchored (see normalizeOrder's triggerMcap note)
   *      because a FILL must be reproducible and a supply figure can move
   *      under it. An alert makes no claim about a fill. The trader asked a
   *      question in market cap — "ping me at 500K" — and answering it in
   *      anything else would be answering a question nobody asked. So the
   *      cap is the compared quantity, and the arm-time price is kept only
   *      as a fallback basis for sources that quote a price with no cap.
   *
   * One-shot by design: an alert that re-fired every tick above its level
   * would train the trader to ignore it, which is worse than no alert.
   */

  const ALERT_KINDS = ['above', 'below'];
  const MAX_ALERTS_PER_MINT = 6;

  function alertId(ts) {
    return `a${Number(ts) || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * A market cap the way a trader says it out loud: 500K, 2.4M, 1.1B.
   *
   * Deliberately NOT fmtUsd, which signs its output (`+$500,000`) because it
   * exists to render P&L. A market cap has no sign, and "+$500,000 MC" reads
   * as a gain that never happened.
   */
  function fmtCap(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  /**
   * Validate a raw alert. Returns null for anything unusable.
   *
   * `reference` is what the market showed at arm time, `{ mcap, priceNative }`.
   * An "above" alert armed at or BELOW the current cap would fire on the very
   * next poll — that is not an alert, it is a notification with extra steps.
   * Refused, so the user is told rather than surprised, mirroring how a take
   * profit below the price is refused.
   */
  function normalizeAlert(raw, reference, ts) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = ALERT_KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;

    const mcap = Number(raw.mcap);
    if (!Number.isFinite(mcap) || mcap <= 0) return null;

    const refMcap = Number(reference && reference.mcap);
    if (Number.isFinite(refMcap) && refMcap > 0) {
      if (kind === 'above' && mcap <= refMcap) return null;
      if (kind === 'below' && mcap >= refMcap) return null;
    }

    // The price that corresponded to the armed cap at arm time. Used ONLY
    // when a later quote carries a price but no cap, so a source outage
    // downgrades the alert instead of silencing it.
    const refPrice = Number(reference && reference.priceNative);
    const basisPrice = Number.isFinite(refPrice) && refPrice > 0
      && Number.isFinite(refMcap) && refMcap > 0
      ? refPrice * (mcap / refMcap)
      : null;

    return {
      id: raw.id || alertId(ts),
      kind,
      mcap,
      basisPrice,
      // What the market read when the alert was armed, so the ping can say
      // "500K (armed at 210K)" without guessing after the fact.
      armedAtMcap: Number.isFinite(refMcap) && refMcap > 0 ? refMcap : null,
      symbol: typeof raw.symbol === 'string' ? raw.symbol.slice(0, 24) : null,
      chain: typeof raw.chain === 'string' ? raw.chain : 'solana',
      createdAt: Number(ts) || Date.now(),
      firedAt: null,
    };
  }

  /** Every alert for a mint, oldest first. Never returns null. */
  function alertsFor(state, mint) {
    const all = (state && state.alerts) || {};
    return Array.isArray(all[mint]) ? all[mint] : [];
  }

  /** Alerts still waiting on the market — the set worth spending a poll on. */
  function armedAlertsFor(state, mint) {
    return alertsFor(state, mint).filter((a) => !a.firedAt);
  }

  /**
   * Arm an alert on a mint. No position required — that is the whole point.
   */
  function addAlert(state, mint, raw, reference, ts) {
    if (!mint) throw new Error('No token to watch');
    const alert = normalizeAlert(raw, reference, ts);
    if (!alert) {
      const ref = Number(reference && reference.mcap);
      throw new Error(ref > 0
        ? `That level is already behind the market — it reads ${fmtCap(ref)} now`
        : 'That alert level cannot be read as a market cap');
    }
    if (!state.alerts || typeof state.alerts !== 'object') state.alerts = {};
    if (armedAlertsFor(state, mint).length >= MAX_ALERTS_PER_MINT) {
      throw new Error(`At most ${MAX_ALERTS_PER_MINT} alerts per token`);
    }
    alert.mint = mint;
    state.alerts[mint] = [...alertsFor(state, mint), alert];
    return alert;
  }

  /** Disarm one alert. Returns true when something was actually removed. */
  function removeAlert(state, mint, id) {
    const list = alertsFor(state, mint);
    const next = list.filter((a) => a.id !== id);
    if (next.length === list.length) return false;
    if (next.length) state.alerts[mint] = next;
    else delete state.alerts[mint];
    return true;
  }

  /** Disarm every alert on a mint. */
  function clearAlerts(state, mint) {
    if (!state.alerts || !state.alerts[mint]) return false;
    delete state.alerts[mint];
    return true;
  }

  /**
   * Every mint with an alert still waiting — the work list for the poller.
   *
   * Fired alerts are excluded: they cost a network slot and can never fire
   * again, and the batch request is shared with the positions bar.
   */
  function alertMints(state) {
    const all = (state && state.alerts) || {};
    return Object.keys(all).filter((mint) => armedAlertsFor(state, mint).length > 0);
  }

  /**
   * Which armed alerts does this observation trip?
   *
   * `observed` is a quote, `{ mcap, priceNative }`. The cap is compared when
   * the source supplied one; only when it did not does the arm-time basis
   * price stand in. An observation carrying neither trips nothing — a missing
   * number must never be read as a crossed level.
   */
  function triggeredAlerts(state, mint, observed) {
    const mcap = Number(observed && observed.mcap);
    const price = Number(observed && observed.priceNative);
    const haveMcap = Number.isFinite(mcap) && mcap > 0;
    const havePrice = Number.isFinite(price) && price > 0;
    if (!haveMcap && !havePrice) return [];

    return armedAlertsFor(state, mint).filter((a) => {
      const level = haveMcap ? a.mcap : a.basisPrice;
      const value = haveMcap ? mcap : price;
      if (!(level > 0)) return false;
      return a.kind === 'above' ? value >= level : value <= level;
    });
  }

  /**
   * Claim an alert as fired. Returns true only for the caller that won it.
   *
   * Every dex tab runs the same watcher, so without a claim a trader with
   * three terminals open gets three pings for one level. The winner is
   * whoever writes firedAt first; everyone else observes it already set and
   * stays quiet. Idempotent, so a replayed message cannot re-ping either.
   */
  function markAlertFired(state, mint, id, ts, observed) {
    const alert = alertsFor(state, mint).find((a) => a.id === id);
    if (!alert || alert.firedAt) return false;
    alert.firedAt = Number(ts) || Date.now();
    // The reading that actually tripped it, recorded beside the level asked
    // for. The same both-numbers rule the journal uses for a gapped stop:
    // a cap that jumped straight through 500K to 720K must say so.
    const mcap = Number(observed && observed.mcap);
    alert.firedAtMcap = Number.isFinite(mcap) && mcap > 0 ? mcap : null;
    return true;
  }

  /** Attach a thesis to the open position for a mint. */
  function setThesis(state, mint, thesis, ts) {
    const position = state && state.positions && state.positions[mint];
    if (!position) return null;
    const normalized = normalizeThesis(thesis, ts);
    position.thesis = normalized;
    return normalized;
  }

  /**
   * Grade a completed round against the plan its thesis declared.
   *
   * This is the learning loop: it reports whether the exit respected the stated
   * target and stop, without pretending a profitable accident was good process.
   */
  function gradeThesis(round) {
    const thesis = round && round.thesis;
    if (!thesis) return null;

    const pnlPct = Number(round.pnlPct);
    const peakPct = Number(round.investedSol) > 0
      ? (Number(round.peakPnlSol) / Number(round.investedSol)) * 100
      : null;
    const troughPct = Number(round.investedSol) > 0
      ? (Number(round.troughPnlSol) / Number(round.investedSol)) * 100
      : null;

    const notes = [];
    let followedPlan = null;

    if (thesis.targetPct !== null) {
      if (pnlPct >= thesis.targetPct) {
        notes.push(`Hit the ${thesis.targetPct}% target.`);
        followedPlan = followedPlan === false ? false : true;
      } else if (peakPct !== null && peakPct >= thesis.targetPct) {
        notes.push(`Reached ${thesis.targetPct}% in-trade but exited at ${pnlPct.toFixed(1)}%.`);
        followedPlan = false;
      } else {
        notes.push(`Never reached the ${thesis.targetPct}% target.`);
      }
    }

    if (thesis.stopPct !== null) {
      if (troughPct !== null && troughPct <= -thesis.stopPct && pnlPct < -thesis.stopPct) {
        notes.push(`Held past the ${thesis.stopPct}% stop and closed at ${pnlPct.toFixed(1)}%.`);
        followedPlan = false;
      } else if (troughPct !== null && troughPct <= -thesis.stopPct) {
        notes.push(`Dipped through the ${thesis.stopPct}% stop but recovered before the exit.`);
      }
    }

    return {
      followedPlan,
      pnlPct,
      peakPct,
      troughPct,
      notes,
      // A win on a broken plan is still a process failure worth seeing.
      luckyWin: followedPlan === false && pnlPct > 0,
    };
  }

  /* ---------------- exit quality ---------------- */

  /**
   * How good was the exit, measured against what the trade actually offered?
   *
   * The single most common beginner pattern is selling far below the peak the
   * position reached, then buying the next thing. Peak and trough are recorded
   * live on every tick, so this compares the realized result against the best
   * and worst the position was ever worth — no hindsight data required.
   */
  function exitQuality(round) {
    if (!round) return null;
    const invested = Number(round.investedSol);
    if (!(invested > 0)) return null;

    const pnl = Number(round.pnlSol) || 0;
    const peak = Number(round.peakPnlSol) || 0;
    const trough = Number(round.troughPnlSol) || 0;

    // What fraction of the maximum available gain was actually captured?
    const captured = peak > 0 ? Math.max(0, Math.min(1, pnl / peak)) : null;
    const leftOnTable = peak > 0 ? Math.max(0, peak - pnl) : 0;

    let verdict;
    if (peak <= 0) {
      verdict = pnl >= 0 ? 'no-run' : 'never-worked';
    } else if (captured !== null && captured >= 0.8) {
      verdict = 'excellent';
    } else if (captured !== null && captured >= 0.5) {
      verdict = 'good';
    } else if (pnl > 0) {
      verdict = 'early';
    } else {
      verdict = 'round-tripped';
    }

    return {
      verdict,
      capturedPct: captured === null ? null : captured * 100,
      leftOnTableSol: leftOnTable,
      peakPct: (peak / invested) * 100,
      troughPct: (trough / invested) * 100,
      pnlPct: (pnl / invested) * 100,
      // A position that went green then closed red is the costliest habit.
      roundTripped: peak > 0 && pnl < 0,
    };
  }

  /** Session-wide exit discipline, so the pattern is visible across trades. */
  function exitStats(state) {
    const rounds = (state && state.rounds) || [];
    const graded = rounds.map(exitQuality).filter(Boolean);
    if (!graded.length) {
      return { count: 0, avgCapturedPct: null, leftOnTableSol: 0, roundTripped: 0, byVerdict: {} };
    }

    const withCapture = graded.filter((g) => g.capturedPct !== null);
    const byVerdict = {};
    for (const g of graded) byVerdict[g.verdict] = (byVerdict[g.verdict] || 0) + 1;

    return {
      count: graded.length,
      avgCapturedPct: withCapture.length
        ? withCapture.reduce((s, g) => s + g.capturedPct, 0) / withCapture.length
        : null,
      leftOnTableSol: graded.reduce((s, g) => s + g.leftOnTableSol, 0),
      roundTripped: graded.filter((g) => g.roundTripped).length,
      byVerdict,
    };
  }

  /**
   * Risk sizing: what fraction of the book went into a single trade?
   *
   * Oversizing is the fastest way a learning trader blows up, and it is
   * invisible without comparing position size to equity at entry.
   */
  function riskProfile(state, settings) {
    const rounds = (state && state.rounds) || [];
    if (!rounds.length) return { count: 0, avgSizePct: null, maxSizePct: null, oversized: 0 };

    // D-06: size is judged against the wallet's BIRTH balance, not the live
    // setting — editing the setting mid-wallet must not re-grade old trades.
    const start = anchorStartSol(state, settings);
    if (!(start > 0)) return { count: 0, avgSizePct: null, maxSizePct: null, oversized: 0 };

    const sizes = rounds.map((r) => (Number(r.investedSol) || 0) / start * 100);
    return {
      count: sizes.length,
      avgSizePct: sizes.reduce((s, v) => s + v, 0) / sizes.length,
      maxSizePct: Math.max(...sizes),
      // A common rule of thumb: never risk more than a quarter of the book.
      oversized: sizes.filter((v) => v > 25).length,
    };
  }

  /** Aggregate thesis outcomes so recurring patterns become visible. */
  function thesisStats(state) {
    const rounds = (state && state.rounds) || [];
    const withThesis = rounds.filter((round) => round && round.thesis);
    const byTag = {};

    for (const round of withThesis) {
      for (const tag of round.thesis.tags || []) {
        const bucket = byTag[tag] || (byTag[tag] = { tag, count: 0, wins: 0, pnlSol: 0 });
        bucket.count += 1;
        if (Number(round.pnlSol) > 0) bucket.wins += 1;
        bucket.pnlSol += Number(round.pnlSol) || 0;
      }
    }

    const tags = Object.values(byTag)
      .map((bucket) => ({
        ...bucket,
        winRate: bucket.count ? (bucket.wins / bucket.count) * 100 : 0,
        avgPnlSol: bucket.count ? bucket.pnlSol / bucket.count : 0,
      }))
      .sort((a, b) => b.count - a.count || b.pnlSol - a.pnlSol);

    const graded = withThesis.map(gradeThesis).filter(Boolean);
    const followed = graded.filter((grade) => grade.followedPlan === true).length;
    const broken = graded.filter((grade) => grade.followedPlan === false).length;

    return {
      total: rounds.length,
      withThesis: withThesis.length,
      coverage: rounds.length ? (withThesis.length / rounds.length) * 100 : 0,
      followedPlan: followed,
      brokePlan: broken,
      luckyWins: graded.filter((grade) => grade.luckyWin).length,
      tags,
    };
  }

  /* ---------------- P&L calendar ----------------
   *
   * The daily performance view Axiom/Padre/GMGN popularized: a month grid
   * where each day shows the realized result of that day's trades. Their
   * backends bucket by the viewer's LOCAL day (Axiom passes the browser's
   * timezone offset to its API), so this does the same — days are local
   * calendar days, never UTC.
   *
   * Daily realized P&L is attributed per SELL (partial exits count on the
   * day they happen), which matches how those sites treat closes. Buys only
   * contribute counts and volume; they are not a result until closed.
   */

  /**
   * Build one month of calendar cells for the dashboard.
   *
   * @param {object} state portfolio state (journal + positions)
   * @param {number} year  full year, e.g. 2026
   * @param {number} month 0-based month index (Date convention)
   * @param {object} [opts] { now: ms } for deterministic tests
   */
  function pnlCalendar(state, year, month, opts) {
    const now = Number(opts && opts.now) || Date.now();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      days.push({
        day: d,
        hasTrades: false,
        realizedSol: 0,
        buys: 0,
        sells: 0,
        volumeBuySol: 0,
        volumeSellSol: 0,
        symbols: {},
      });
    }

    for (const t of (state && state.journal) || []) {
      const ts = Number(t.ts);
      if (!(ts > 0)) continue;
      const dt = new Date(ts);
      if (dt.getFullYear() !== year || dt.getMonth() !== month) continue;
      const cell = days[dt.getDate() - 1];
      cell.hasTrades = true;
      if (t.side === 'buy') {
        cell.buys += 1;
        cell.volumeBuySol += Number(t.solGross) || 0;
      } else if (t.side === 'sell') {
        cell.sells += 1;
        cell.volumeSellSol += Number(t.solGross) || 0;
        const pnl = Number(t.pnlSol) || 0;
        cell.realizedSol += pnl;
        const symbol = typeof t.symbol === 'string' && t.symbol ? t.symbol : '?';
        cell.symbols[symbol] = (cell.symbols[symbol] || 0) + pnl;
      }
    }

    // Monday-start week rows, the layout every one of those terminals uses.
    // fill() matters: bare new Array(n) creates HOLES, which .map() silently
    // skips — the blanks must be real elements or the whole grid shifts left.
    const leading = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
    const cells = new Array(leading).fill(undefined).concat(days);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) {
      const row = cells.slice(i, i + 7);
      while (row.length < 7) row.push(undefined);
      weeks.push({
        days: row,
        totalSol: row.reduce((sum, c) => sum + (c ? c.realizedSol : 0), 0),
        hasTrades: row.some((c) => c && c.hasTrades),
      });
    }

    const totals = {
      realizedSol: 0,
      winDays: 0,
      lossDays: 0,
      flatDays: 0,
      tradeDays: 0,
      buys: 0,
      sells: 0,
      volumeBuySol: 0,
      volumeSellSol: 0,
      bestDay: null,
      worstDay: null,
    };
    for (const c of days) {
      totals.realizedSol += c.realizedSol;
      totals.buys += c.buys;
      totals.sells += c.sells;
      totals.volumeBuySol += c.volumeBuySol;
      totals.volumeSellSol += c.volumeSellSol;
      if (!c.hasTrades) continue;
      totals.tradeDays += 1;
      if (c.realizedSol > 0) totals.winDays += 1;
      else if (c.realizedSol < 0) totals.lossDays += 1;
      else totals.flatDays += 1;
      if (c.sells > 0) {
        if (!totals.bestDay || c.realizedSol > totals.bestDay.pnlSol) {
          totals.bestDay = { day: c.day, pnlSol: c.realizedSol };
        }
        if (!totals.worstDay || c.realizedSol < totals.worstDay.pnlSol) {
          totals.worstDay = { day: c.day, pnlSol: c.realizedSol };
        }
      }
    }

    let openPnlSol = 0;
    const positions = (state && state.positions) || {};
    for (const mint of Object.keys(positions)) openPnlSol += unrealizedPnl(positions[mint]);

    const nowDate = new Date(now);
    const todayDay = nowDate.getFullYear() === year && nowDate.getMonth() === month
      ? nowDate.getDate()
      : null;

    return { year, month, days, weeks, totals, openPnlSol, todayDay };
  }

  /**
   * Oldest and newest months the journal covers, for calendar navigation.
   * With no fills yet the range collapses to the current month.
   */
  function pnlCalendarRange(state) {
    let minTs = Infinity;
    for (const t of (state && state.journal) || []) {
      const ts = Number(t.ts);
      if (ts > 0 && ts < minTs) minTs = ts;
    }
    const now = new Date();
    const max = { year: now.getFullYear(), month: now.getMonth() };
    if (!isFinite(minTs)) return { min: { year: max.year, month: max.month }, max };
    const first = new Date(minTs);
    return { min: { year: first.getFullYear(), month: first.getMonth() }, max };
  }

  /**
   * Quantity-weighted average paper fill prices for the token's current round,
   * or its most recently closed round when no position remains. Padre's native
   * lines use USD, while native SOL averages are retained as a fallback.
   */
  function averageFillPrices(state, mint) {
    if (!state || !mint) return null;
    const journal = state.journal || [];
    const position = state.positions && state.positions[mint];
    let fills;

    if (position) {
      // tradeInRound, not a bare mint match: a fresh-launch buy committed
      // under the PAIR stand-in address keeps feeding the average lines
      // after the position is rekeyed to its real mint (F-51).
      fills = journal.filter((t) => tradeInRound(t, position));
    } else {
      // Rounds are stored newest-first (unshift), so .find() over the raw
      // array already returns the most recent round for this mint.
      const round = (state.rounds || []).find((r) => r.mint === mint);
      if (!round) return null;
      const ids = new Set(round.tradeIds || []);
      fills = journal.filter((t) => ids.has(t.id));
    }

    function weighted(side, priceKey) {
      let value = 0;
      let quantity = 0;
      for (const fill of fills) {
        if (fill.side !== side) continue;
        const qty = Number(fill.qty);
        const price = Number(fill[priceKey]);
        if (!(qty > 0) || !(price > 0)) continue;
        value += qty * price;
        quantity += qty;
      }
      return quantity > 0 ? value / quantity : null;
    }

    function weightedUsd(side) {
      // A USD average is only honest if EVERY fill on that side recorded a
      // USD price. Fresh-launch fills often pre-date the USD tick and carry
      // priceUsd: null; weighting only the fills that happened to have USD
      // silently changes which fills the "average" covers — the reported
      // "avg fills not accurate". When the set is incomplete return null and
      // let the caller derive USD from the complete native average.
      const sideFills = fills.filter((fill) => fill.side === side && Number(fill.qty) > 0);
      if (!sideFills.length) return null;
      if (!sideFills.every((fill) => Number(fill.priceUsd) > 0)) return null;
      return weighted(side, 'priceUsd');
    }

    const buyQty = fills.filter((t) => t.side === 'buy').reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
    const sellQty = fills.filter((t) => t.side === 'sell').reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
    if (!(buyQty > 0) && !(sellQty > 0)) return null;

    return {
      avgBuyNative: weighted('buy', 'priceNative'),
      avgBuyUsd: weightedUsd('buy'),
      avgSellNative: weighted('sell', 'priceNative'),
      avgSellUsd: weightedUsd('sell'),
      buyQty,
      sellQty,
      fillCount: fills.length,
    };
  }

  /**
   * Return the realized result the overlay should show after the newest sell
   * for a token. A full exit uses the completed round-trip result; a partial
   * exit uses the realized P&L of that individual sell.
   */
  function latestClosedPnl(state, mint) {
    if (!state || !mint) return null;
    const sell = (state.journal || []).find((t) => t.mint === mint && t.side === 'sell');
    if (!sell) return null;

    const round = (state.rounds || []).find(
      (r) => r.mint === mint && Number(r.closedAt) === Number(sell.ts)
    );
    if (round) {
      return {
        kind: 'round',
        symbol: round.symbol || sell.symbol || '',
        closedAt: round.closedAt,
        pnlSol: Number(round.pnlSol) || 0,
        pnlPct: Number(round.pnlPct) || 0,
        returnedSol: Number(round.returnedSol) || 0,
        investedSol: Number(round.investedSol) || 0,
      };
    }

    const pnlSol = Number(sell.pnlSol) || 0;
    const returnedSol = Number(sell.solNet) || 0;
    // sell.pnlSol = net proceeds - cost basis closed by this sell.
    const closedCostSol = returnedSol - pnlSol;
    return {
      kind: 'partial',
      symbol: sell.symbol || '',
      closedAt: sell.ts,
      pnlSol,
      pnlPct: closedCostSol > 0 ? (pnlSol / closedCostSol) * 100 : 0,
      returnedSol,
      investedSol: closedCostSol,
    };
  }

  /**
   * Convert a positive unrealized P&L percentage into a 1-based alert level.
   * Example with a 10% interval: 9.9 -> 0, 10 -> 1, 27 -> 2.
   */
  function profitAlertLevel(pnlPct, intervalPct) {
    const pnl = Number(pnlPct);
    const interval = Number(intervalPct);
    if (!(pnl > 0) || !(interval > 0)) return 0;
    return Math.max(0, Math.floor((pnl + 1e-9) / interval));
  }

  /** Return the newly crossed level, or null when no new alert is due. */
  function crossedProfitAlert(previousLevel, pnlPct, intervalPct) {
    const previous = Math.max(0, Number(previousLevel) || 0);
    const current = profitAlertLevel(pnlPct, intervalPct);
    return current > previous ? current : null;
  }

  /** Reset everything back to a fresh wallet with the given settings. */
  function resetState(settings, baseSeq = 0) {
    const fresh = defaultState(settings);
    // A reset that starts back at seq 0 is OLDER than every state a running
    // tab still holds, so that tab's next heartbeat mark clobbers the reset
    // and the old wallet reappears — the reported "reset restores old data"
    // bug. The fresh state must be strictly newer than anything in flight.
    fresh.seq = (Number(baseSeq) || 0) + 1;
    return fresh;
  }

  /* ---------------- misc ---------------- */

  function tradeId(ts) {
    return 't' + ts.toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function replaySessionId(mint, ts) {
    const cleanMint = String(mint || '').replace(/[^A-Za-z0-9]/g, '');
    const stamp = Math.max(0, Number(ts) || Date.now()).toString(36);
    const tail = cleanMint ? cleanMint.slice(0, 5) + cleanMint.slice(-4) : 'unknown';
    return `pts-${stamp}-${tail}`;
  }

  function pruneJournal(state) {
    if (state.journal.length > 2000) state.journal.length = 2000;
  }

  function short(addr) {
    return addr && addr.length > 10 ? addr.slice(0, 4) + '…' + addr.slice(-4) : (addr || '?');
  }

  const EPS_ = 1e-9;

  function fmt(n, dp = 4) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
  }

  function fmtUsd(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return sign + '$' + Math.abs(Number(n)).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  const _PaperEngine = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    defaultSettings,
    mergeSettings,
    SETTINGS_REVISION,
    defaultState,
    startGame,
    endGame,
    GAME_IDS,
    resetState,
    buy,
    sell,
    // Exported so the panel can plan an exit against the SAME flat cost the
    // fill will charge. Re-deriving it there would be a second copy of the
    // clamp, free to drift from this one.
    txCostSol,
    // Exported for the same reason: the panel and the sell planner must quote
    // the fee the fill will ACTUALLY charge (tiered when the token's state is
    // known, the configured flat bps otherwise), not a second guess at it.
    effectiveFeeBps,
    // Exported so the panel/ticket can PREVIEW the fill a given size would
    // actually get — quoting the flat tick while the engine walks the curve
    // would put a number on screen that the fill then contradicts.
    buyPrice,
    sellPrice,
    getPosition,
    rekeyMint,
    markPosition,
    unrealizedPnl,
    equitySol,
    equityCurvePoints,
    stepOf,
    derivedBirthSol,
    backfillAnchor,
    grossOpenCostSol,
    positionPnlPct,
    beginPostWatch,
    notePostExitPrice,
    // Chart orders (take profit / stop loss)
    ORDER_KINDS,
    MAX_ORDERS_PER_MINT,
    normalizeOrder,
    ordersFor,
    addOrder,
    moveOrder,
    removeOrder,
    clearOrders,
    triggeredOrders,
    pendingBuysFor,
    addPendingBuy,
    removePendingBuy,
    lockedBuySol,
    densityWantsIdleSol,
    roundMcapPair,
    triggeredPendingBuys,
    expirePendingBuys,
    orderSlipPct,
    mintsWithOrders,
    // Market-cap alerts (watchlist; no position required)
    ALERT_KINDS,
    MAX_ALERTS_PER_MINT,
    normalizeAlert,
    alertsFor,
    armedAlertsFor,
    addAlert,
    removeAlert,
    clearAlerts,
    alertMints,
    triggeredAlerts,
    markAlertFired,
    finalizePostWatches,
    postWatchMints,
    guardCheck,
    POST_WATCH_WINDOW_MS,
    solUsdRate,
    sessionStats,
    anchorStartSol,
    pnlCalendar,
    pnlCalendarRange,
    averageFillPrices,
    exitQuality,
    exitStats,
    riskProfile,
    normalizeThesis,
    setThesis,
    gradeThesis,
    thesisStats,
    THESIS_TAGS,
    THESIS_PLANS,
    THESIS_MAX,
    latestClosedPnl,
    profitAlertLevel,
    crossedProfitAlert,
    replaySessionId,
    short,
    fmt,
    fmtUsd,
    clamp,
    EPS_,
  };

  if (typeof window !== 'undefined') {
    window.PaperEngine = _PaperEngine;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _PaperEngine;
  }

})();
