/* pt-recon — the FEATURE PASS: the QA-MATRIX rows the live pass called human.
 *
 * livepass.mjs proves a panel mounts and a price ticks. This drives the rows
 * that needed hands: a buy that fills with a toast and a receipt, a positions
 * bar that appears and drags and persists, a one-tap sell that closes the
 * round near zero P&L (an immediate round trip that books ±12% means a price
 * layer LIED — this is the standing F-48 tripwire), and a token swap that
 * must not bleed state.
 *
 * Every fill happens in THIS harness's own browser profile with paper money —
 * the operator's real journal, stats and Arena record are never touched.
 * Assertions read the engine's own storage through the extension's dashboard
 * page (chrome.storage), not pixels: the number asserted is the number the
 * product recorded.
 *
 *   cd tools/recon/.headless
 *   node featurepass.mjs             # default site (gmgn — no login needed)
 *   node featurepass.mjs lute        # any adapter id; gated sites need the
 *                                    # login profile seeded by livepass login
 *
 * Not covered here, said out loud (the harness never claims what it didn't
 * see): the refusal toast on a dead feed (needs a feed-kill rig), the popup
 * master-switch teardown, and chart-marker geometry (locked by the bridge
 * suites; drawing coordinates live inside the venue's own chart iframe).
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// The refusal rig must starve the SERVICE WORKER's fetches too (the resolver
// and chain reads live there); Playwright only routes SW traffic behind this
// flag, and it must be set before any browser launches. Chromium-only, which
// is what this harness runs.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.PT_LIVEPASS_EXT || resolve(HERE, '../../../extension');
const SHOTS = process.env.PT_LIVEPASS_SHOTS || resolve(HERE, '_livepass');
const DATA = process.env.PT_LIVEPASS_DATA || resolve(HERE, '../../../recon-data');
const DEFAULT_PROFILE = resolve(DATA, 'profiles', 'live');

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

// Loaded ONCE: require caches the module, so a second require would not
// re-execute sites.js and window.PaperTrenchSites would come back empty.
let SITES_API = null;
async function loadSites() {
  if (SITES_API) return SITES_API;
  const mod = await import('node:module');
  const require_ = mod.createRequire(import.meta.url);
  const g = globalThis;
  const prev = g.window;
  g.window = {};
  require_(resolve(EXT, 'sites.js'));
  SITES_API = g.window.PaperTrenchSites;
  g.window = prev;
  return SITES_API;
}

async function tokenUrlFor(siteId, mint) {
  const S = await loadSites();
  const a = S.ADAPTERS.find((x) => x.id === siteId);
  if (!a) throw new Error(`no adapter with id "${siteId}"`);
  return a.tokenUrl(mint, null, 'solana');
}

/* ── shadow-DOM helpers: the panel's root is OPEN by design ─────────── */

function inPanel(page, fn, arg) {
  return page.evaluate(({ src, a }) => {
    const host = document.getElementById('papertrench-host');
    const sh = host && host.shadowRoot;
    if (!sh) return { __noPanel: true };
    // eslint-disable-next-line no-new-func
    return new Function('sh', 'arg', `return (${src})(sh, arg);`)(sh, a);
  }, { src: fn.toString(), a: arg ?? null });
}

const readPanel = (page) => inPanel(page, (sh) => {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
  };
  const price = sh.getElementById('pt-price');
  const bar = sh.getElementById('pt-bar');
  const grip = sh.getElementById('pt-bar-grip');
  const gripRect = grip ? grip.getBoundingClientRect() : null;
  const barRect = bar ? bar.getBoundingClientRect() : null;
  return {
    mounted: vis(price),
    price: price ? (price.textContent || '').trim() : null,
    priceStale: price ? price.classList.contains('pt-price-stale') : null,
    dotClass: (sh.getElementById('pt-live-dot') || {}).className || null,
    tokenName: (sh.getElementById('pt-token-name') || {}).textContent || null,
    tokenMint: (sh.getElementById('pt-token-mint') || {}).textContent || null,
    barVisible: vis(bar),
    barRect: barRect ? { x: barRect.x, y: barRect.y } : null,
    gripRect: gripRect ? { x: gripRect.x + gripRect.width / 2, y: gripRect.y + gripRect.height / 2 } : null,
    buyReady: (() => { const b = sh.getElementById('pt-buy'); return b ? (b.textContent || '').trim() : null; })(),
    sellButtons: sh.querySelectorAll('.pt-sell-row .pt-sell, .pt-sell').length,
    toasts: [...sh.querySelectorAll('#pt-toast-root .pt-toast')].map((t) => (t.textContent || '').trim()),
  };
});

const clickPanel = (page, which) => inPanel(page, (sh, w) => {
  // #pt-buy is THE buy button, but it refuses without a SELECTED amount
  // chip (.pt-preset.sel) — a fresh profile has none selected, exactly like
  // a fresh user. Pick the first (smallest) chip, then buy. The sell row's
  // percent buttons render inside the position card once a position opens.
  const el = w === 'buy' ? (() => {
    if (!sh.querySelector('#pt-buy-presets .pt-preset.sel')) {
      const chip = sh.querySelector('#pt-buy-presets .pt-preset');
      if (chip) chip.click();
    }
    return sh.getElementById('pt-buy');
  })()
    : w === 'sell-last' ? [...sh.querySelectorAll('.pt-sell-row .pt-sell, .pt-sell')].pop()
    : null;
  if (!el) return { clicked: false };
  const label = (el.textContent || '').trim();
  el.click();
  return { clicked: true, label };
}, which);

async function waitFor(page, probe, ms, every = 400) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await probe();
    if (last && last.ok) return last;
    await page.waitForTimeout(every);
  }
  return last || { ok: false };
}

/** A toast whose text matches, seen within the window (they animate away). */
async function waitToast(page, re, ms) {
  return waitFor(page, async () => {
    const p = await readPanel(page);
    const hit = (p.toasts || []).find((t) => re.test(t));
    return { ok: !!hit, toast: hit || null, toasts: p.toasts };
  }, ms, 250);
}

/* ── engine truth, read from the product's own storage ──────────────── */

async function readState(ctx, extId) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/dashboard.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const all = await page.evaluate(() => chrome.storage.local.get(null));
  await page.close();
  const state = all.pt_state || null;
  const settingsKey = Object.keys(all).find((k) => all[k] && typeof all[k] === 'object' && 'positionsBarLeft' in all[k]);
  return { state, settings: settingsKey ? all[settingsKey] : null, keys: Object.keys(all) };
}

/* ── the pass ───────────────────────────────────────────────────────── */

const results = [];
const note = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok === null ? '·' : ok ? '✓' : '✗'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * QA row: "Refusal toast (not silence) when no fresh price." Mount honestly,
 * then cut EVERYTHING — abort all new requests (the SW-events flag makes that
 * reach the service worker's resolver and chain fetches) and go offline (which
 * severs the site's established price WebSockets). Past the 3s staleness
 * bound, a buy click must produce a visible refusal and NO journal row. A
 * silent no-op or, worse, a fill from the dead snapshot is the F-01/F-20
 * regression this stage exists to catch.
 */
async function refusalStage(siteId, url) {
  const ctx = await chromium.launchPersistentContext(DEFAULT_PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--no-first-run'],
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const mounted = await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: p.mounted && p.price && /\d/.test(p.price) && !/fetch/i.test(p.price), ...p };
    }, 30000);
    if (!mounted.ok) { note('refusal rig: panel re-mounts', false, 'could not reach a live panel'); return; }

    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    const extId = sw ? new URL(sw.url()).host : null;
    const before = extId ? await readState(ctx, extId) : null;
    const jBefore = before && before.state ? before.state.journal.length : null;

    await ctx.route('**/*', (r) => r.abort().catch(() => {}));
    await ctx.setOffline(true).catch(() => {});
    await page.waitForTimeout(4500); // beyond STALE_FILL_MAX_AGE_MS with margin

    await clickPanel(page, 'buy');
    const refusal = await waitToast(page,
      /Could not obtain a fresh price|not filled|refused|sources disagree/i, 9000);
    const wrongFill = await waitToast(page, /^Bought /, 500);
    await page.screenshot({ path: resolve(SHOTS, `fp-${siteId}-refusal.png`) }).catch(() => {});
    note('starved feed: buy refuses OUT LOUD', refusal.ok && !wrongFill.ok,
      refusal.toast || (wrongFill.ok ? `FILLED from a dead snapshot: ${wrongFill.toast}` : 'no toast at all — silence is the defect'));

    await ctx.setOffline(false).catch(() => {});
    await ctx.unroute('**/*').catch(() => {});
    if (extId && jBefore !== null) {
      const after = await readState(ctx, extId);
      note('starved feed: no journal row written', after.state.journal.length === jBefore,
        `journal ${jBefore} → ${after.state.journal.length}`);
    } else {
      note('starved feed: no journal row written', null, 'engine storage unreachable in this session');
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  const siteId = process.argv[2] || 'gmgn';
  mkdirSync(SHOTS, { recursive: true });
  const urlA = await tokenUrlFor(siteId, BONK);
  const urlB = await tokenUrlFor(siteId, WIF);

  console.log(`\n════ pt-recon feature pass — ${siteId} ════\n`);
  const ctx = await chromium.launchPersistentContext(DEFAULT_PROFILE, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--no-first-run'],
    viewport: { width: 1440, height: 900 },
  });

  try {
    // ── mount on token A ────────────────────────────────────────────
    const page = await ctx.newPage();
    await page.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const mounted = await waitFor(page, async () => {
      const p = await readPanel(page);
      // A real price has digits; "Fetching live price…" and "—" do not count.
      return { ok: p.mounted && p.price && /\d/.test(p.price) && !/fetch/i.test(p.price), ...p };
    }, 30000);
    if (!mounted.ok) {
      const landed = page.url();
      const gated = /\/(sign-?in|sign-?up|login|log-?in|auth|connect|onboard)(\b|\/|\?|$)/i.test(new URL(landed).pathname);
      note('panel mounts with a live price', false, gated
        ? `LOGIN REQUIRED — the venue sent us to ${landed.slice(0, 60)}; seed with \`node livepass.mjs login ${siteId}\``
        : `no rendered price after 30s (url now ${landed.slice(0, 60)})`);
      await page.screenshot({ path: resolve(SHOTS, `fp-${siteId}-nomount.png`) }).catch(() => {});
      return;
    }
    note('panel mounts with a live price', true, `${mounted.price}`);
    note('live dot present', /pt-dot/.test(mounted.dotClass || ''), mounted.dotClass || '(none)');

    // ── the price is LIVE (30s window) ──────────────────────────────
    // A changed value is the clean pass. A HELD value is still live when the
    // pipeline keeps re-confirming it — dot on, never stale-marked — because
    // a slow market plus display rounding can sit on one quantum for a while
    // (photon held BONK's cap for 14s doing exactly that, honestly). The
    // failure this check exists for is the third case: a frozen panel that
    // CLAIMS to be live next to a moving site.
    const p0 = mounted.price;
    let wentStale = false;
    const ticked = await waitFor(page, async () => {
      const p = await readPanel(page);
      if (p.priceStale || /warn/.test(p.dotClass || '')) wentStale = true;
      return { ok: p.price && /\d/.test(p.price) && p.price !== p0, price: p.price };
    }, 30000, 1000);
    if (ticked.ok) note('price is live', true, `${p0} → ${ticked.price}`);
    else if (!wentStale) note('price is live', true, `held ${p0} for 30s but re-confirmed fresh throughout (dot on, never stale-marked)`);
    else note('price is live', false, `held ${p0} and went stale/warn during the window — the feed is not healthy here`);

    // ── extension id via its own service worker ─────────────────────
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!sw) { note('reach engine storage (service worker)', false, 'no service worker appeared'); return; }
    const extId = new URL(sw.url()).host;
    const before = await readState(ctx, extId);
    const jBefore = (before.state && before.state.journal || []).length;
    const roundsBefore = (before.state && before.state.rounds || []).length;

    // ── BUY: the BUY button (whatever preset is selected), toast, receipt ──
    const buyReady = await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: p.buyReady === 'BUY', label: p.buyReady };
    }, 10000);
    const buy = await clickPanel(page, 'buy');
    if (!buy.clicked) { note('buy button exists', false, 'no #pt-buy in the panel'); return; }
    if (!buyReady.ok) note('buy button reached quoted-ready state', null, `label was "${buyReady.label}" — clicked anyway`);
    const boughtToast = await waitToast(page, /^Bought .*\(paper\)$/, 8000);
    note(`buy fills with a toast (preset "${buy.label}")`, boughtToast.ok,
      boughtToast.toast || `no Bought-toast in 8s (saw: ${JSON.stringify(boughtToast.toasts || [])})`);
    await page.screenshot({ path: resolve(SHOTS, `fp-${siteId}-buy.png`) }).catch(() => {});

    const afterBuy = await readState(ctx, extId);
    const jBuy = (afterBuy.state && afterBuy.state.journal || []);
    const buyRow = jBuy[0];
    const buyOk = jBuy.length === jBefore + 1 && buyRow && buyRow.side === 'buy' && buyRow.mint === BONK;
    note('journal gained exactly one buy row', buyOk,
      buyRow ? `side=${buyRow.side} sol=${buyRow.solGross} @ ${buyRow.priceNative}` : 'no row');
    note('fill carries its receipt (F-48)',
      !!(buyRow && buyRow.priceSource && Number.isFinite(buyRow.priceAgeMs)),
      buyRow ? `priceSource=${buyRow.priceSource || '(absent)'} priceAgeMs=${buyRow.priceAgeMs ?? '(absent)'}` : 'no row');
    note('receipt age is a fill-fresh number', !!(buyRow && buyRow.priceAgeMs >= 0 && buyRow.priceAgeMs <= 5000),
      buyRow ? `${buyRow.priceAgeMs}ms` : 'no row');

    // ── positions bar appears; drag it; it persists ─────────────────
    const barShown = await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: p.barVisible, ...p };
    }, 8000);
    note('positions bar appears with the open position', barShown.ok);
    let dragChecked = null;
    if (barShown.ok && barShown.gripRect) {
      // Drag TOWARD the viewport center. The profile persists the bar's spot
      // across runs, so a fixed rightward drag eventually pinned it against
      // the edge — where the product's reachability clamp correctly held it
      // and the old direction-blind assertion read the CLAMP as a failure.
      // And drag with SYNTHETIC PointerEvents, not the real mouse: the grip
      // listens for pointerdown on itself and pointermove/up on WINDOW, and a
      // real cursor path crossing the venue's chart IFRAME never reaches the
      // window listener (dexscreener stalled every drag exactly that way).
      const vp = page.viewportSize() || { width: 1440, height: 900 };
      const dir = barShown.barRect.x > vp.width / 2 ? -1 : 1;
      await inPanel(page, (sh, a) => {
        const grip = sh.getElementById('pt-bar-grip');
        if (!grip) return { dragged: false };
        const r = grip.getBoundingClientRect();
        const x0 = r.x + r.width / 2;
        const y0 = r.y + r.height / 2;
        const ev = (type, x, y) => new PointerEvent(type, {
          bubbles: true, composed: true, cancelable: true,
          clientX: x, clientY: y, button: 0, pointerId: 7, isPrimary: true,
        });
        grip.dispatchEvent(ev('pointerdown', x0, y0));
        for (let i = 1; i <= 8; i++) window.dispatchEvent(ev('pointermove', x0 + (a.dx * i) / 8, y0));
        window.dispatchEvent(ev('pointerup', x0 + a.dx, y0));
        return { dragged: true };
      }, { dx: dir * 136 });
      await page.waitForTimeout(1200);
      const afterDrag = await readState(ctx, extId);
      const persisted = afterDrag.settings && typeof afterDrag.settings.positionsBarLeft === 'number';
      await page.reload({ waitUntil: 'domcontentloaded' });
      const reMounted = await waitFor(page, async () => {
        const p = await readPanel(page);
        return { ok: p.mounted && p.barVisible, ...p };
      }, 25000);
      const target = barShown.barRect.x + dir * 8 * 17;
      const moved = reMounted.ok && reMounted.barRect
        && Math.abs(reMounted.barRect.x - target) < 40;
      dragChecked = persisted && moved;
      note('bar drag persists across a reload', dragChecked,
        `saved=${persisted} rect ${Math.round(barShown.barRect.x)} → ${reMounted.barRect ? Math.round(reMounted.barRect.x) : '?'} (target ${dir > 0 ? '+' : '−'}136)`);
    } else {
      note('bar drag persists across a reload', null, 'skipped — bar/grip not measurable');
    }

    // ── master switch: disable removes the panel, re-enable restores it
    //    WITH the sell buttons (the position is open right now, which is
    //    exactly when a broken restore would strand a trader) ───────────
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const clickToggle = () => popup.evaluate(() => { document.getElementById('toggle').click(); });
    await clickToggle();
    const torn = await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: !p.mounted };
    }, 10000);
    note('master switch OFF removes the panel', torn.ok,
      torn.ok ? 'panel gone from the token page' : 'panel still rendering after disable');
    await clickToggle();
    const restored = await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: p.mounted && p.sellButtons > 0, sells: p.sellButtons };
    }, 15000);
    note('master switch ON restores panel incl. sell buttons', restored.ok,
      restored.ok ? `${restored.sells} sell buttons back with the open position` : 'panel or sell row did not return');
    await popup.close();

    // ── SELL 100%: once per tap, round closes near zero ─────────────
    await waitFor(page, async () => {
      const p = await readPanel(page);
      return { ok: p.sellButtons > 0 };
    }, 8000);
    const sell = await clickPanel(page, 'sell-last');
    if (!sell.clicked) { note('sell button exists', false, 'no .pt-sell rendered with the open position'); return; }
    const soldToast = await waitToast(page, /^Sold 100%/, 8000);
    note(`sell fills with a toast ("${sell.label}")`, soldToast.ok,
      soldToast.toast || `no Sold-toast in 8s (saw: ${JSON.stringify(soldToast.toasts || [])})`);
    await page.screenshot({ path: resolve(SHOTS, `fp-${siteId}-sell.png`) }).catch(() => {});

    const afterSell = await readState(ctx, extId);
    const jSell = (afterSell.state && afterSell.state.journal || []);
    const sells = jSell.filter((t) => t.side === 'sell' && t.mint === BONK && t.ts >= (buyRow ? buyRow.ts : 0));
    note('one tap, exactly one sell fill', sells.length === 1, `${sells.length} sell rows for this round`);
    note('position closed', !(afterSell.state.positions && afterSell.state.positions[BONK]),
      afterSell.state.positions && afterSell.state.positions[BONK] ? 'position still open' : 'gone');

    // Rounds are newest-FIRST like the journal. The first lute run proved why
    // this must never index the tail: the tripwire read a stale gmgn round's
    // -2.08% while THIS round closed at -90.2% one line above it.
    const rounds = afterSell.state.rounds || [];
    const round = rounds.length > roundsBefore
      ? rounds.reduce((a, b) => ((a && a.ts) >= (b.ts || 0) ? a : b), rounds[0])
      : null;
    if (round && Number.isFinite(round.pnlPct)) {
      // THE F-48 TRIPWIRE: an immediate buy→sell round trip can only lose
      // fees+slippage. Booking beyond ±12% means some layer priced a lie.
      note('immediate round trip books ~zero P&L (F-48 tripwire)', Math.abs(round.pnlPct) <= 12,
        `${round.pnlPct.toFixed(2)}% (fees+slippage only is the honest cost)`);
    } else {
      note('immediate round trip books ~zero P&L (F-48 tripwire)', null, 'round row not found');
    }
    const sellRow = jSell[0];
    note('sell carries its receipt too', !!(sellRow && sellRow.side === 'sell' && sellRow.priceSource),
      sellRow ? `priceSource=${sellRow.priceSource || '(absent)'}` : 'no row');

    // ── swap to token B: identity and price must follow ─────────────
    await page.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const swapped = await waitFor(page, async () => {
      const p = await readPanel(page);
      // Identity AND a real resolved price — the "Fetching…" placeholder is
      // not a price, and "Unknown token" is not an identity.
      return {
        ok: p.mounted && p.tokenMint && p.tokenMint.slice(0, 4) === WIF.slice(0, 4)
          && p.price && /\d/.test(p.price) && !/fetch/i.test(p.price)
          && p.tokenName && !/unknown/i.test(p.tokenName),
        ...p,
      };
    }, 30000);
    note('token swap: panel follows to the new token', swapped.ok,
      swapped.ok ? `${swapped.tokenName} ${swapped.price}` : `panel still shows ${swapped.tokenMint || '(nothing)'}`);
    note('no cross-token bleed', swapped.ok && !(afterSell.state.positions && afterSell.state.positions[WIF]),
      'closed BONK round must not resurrect on WIF');
    await page.screenshot({ path: resolve(SHOTS, `fp-${siteId}-swap.png`) }).catch(() => {});

    // ── the refusal rig: starve every source, demand a refusal OUT LOUD ──
    // A separate session so the starvation cannot contaminate the matrix
    // above. The profile lock demands the first browser closes first.
    await ctx.close().catch(() => {});
    await refusalStage(siteId, urlA);

    console.log('\n  not covered (needs its own rig, said honestly): chart-marker');
    console.log('  geometry and average-line visuals — the bridge suites own those.');
  } finally {
    await ctx.close().catch(() => {});
    const bad = results.filter((r) => r.ok === false);
    console.log(`\n════ ${bad.length ? `${bad.length} FAILED` : 'ALL CHECKS PASSED'} (${results.filter((r) => r.ok).length}/${results.filter((r) => r.ok !== null).length}) ════\n`);
    if (bad.length) process.exitCode = 1;
  }
}

main().catch((e) => { console.error('featurepass failed:', e); process.exit(1); });
