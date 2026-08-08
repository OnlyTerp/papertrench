/* pt-recon — the AUTOMATED LIVE PASS.
 *
 * The doctrine says tests prove the contract and only the real site proves the
 * recon. That was true, and it made every landing wait on a human opening a
 * browser. This closes that loop: it loads the REAL built extension into a real
 * Chromium, drives it to REAL venue pages, and asserts what a human would
 * check — did the panel mount, is the SIMULATED badge there, does a price
 * tick, do the must-refuse routes stay clean.
 *
 * It reports what it SAW. A page it could not reach (geo-block, bot wall, a
 * dead route) is reported as BLOCKED, never as a pass — a live pass that
 * cannot see the site proves nothing, and saying so is the whole point.
 *
 *   cd tools/recon/.headless
 *   xvfb-run -a node livepass.mjs                 # every venue
 *   xvfb-run -a node livepass.mjs kalshi          # one venue
 *
 * Extensions need a real browser process, so this runs headed under xvfb
 * rather than in headless mode.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(HERE, '../../../extension');
const SHOTS = resolve(HERE, '_livepass');

/* The routes each venue must mount on, and the ones it must never touch.
 * Market URLs are re-resolved from the venue's own listing page when possible,
 * because a hardcoded market eventually resolves and 404s. */
const PLAN = {
  kalshi: {
    listing: 'https://kalshi.com/markets',
    marketPattern: /^\/markets\/[^/]+\/[^/]+\/[^/]+$/,
    fallbackMarket: 'https://kalshi.com/markets/kxgdp/us-gdp-growth/kxgdp-26oct30',
    refuse: ['https://kalshi.com/markets', 'https://kalshi.com/portfolio'],
  },
  polymarket: {
    listing: 'https://polymarket.com/',
    marketPattern: /^\/event\/[a-z0-9][a-z0-9-]{2,}$/,
    fallbackMarket: 'https://polymarket.com/event/kraken-ipo-in-2025',
    refuse: ['https://polymarket.com/', 'https://polymarket.com/leaderboard'],
  },
  limitless: {
    listing: 'https://limitless.exchange/',
    marketPattern: /^\/markets\/[a-z0-9][a-z0-9-]{2,}$/,
    fallbackMarket: null,
    refuse: ['https://limitless.exchange/', 'https://limitless.exchange/leaderboard'],
  },
  'hyperliquid-outcomes': {
    listing: 'https://app.hyperliquid.xyz/outcomes',
    marketPattern: /^\/outcomes\/[A-Z0-9]+$/,
    fallbackMarket: null,
    refuse: ['https://app.hyperliquid.xyz/trade/BTC', 'https://app.hyperliquid.xyz/portfolio'],
  },
};

const BLOCK_RE = /restricted jurisdiction|not available in your|unavailable in your (region|country)|access denied|verify you are human|enable javascript and cookies/i;

/* A login wall is not a failed mount — there is no token page behind it to
 * mount on. Reporting it as a defect would send someone hunting a bug that
 * does not exist; reporting it as a pass would be worse. It is its own
 * verdict, and it names the one-time action that clears it. */
const LOGIN_RE = /log ?in to your account|sign ?in to (your|continue)|enter your email to get started|connect wallet to continue|create your account to/i;

/* ── The TOKEN terminals ───────────────────────────────────────────────
 * Their URLs are not written here: they are asked of the SHIPPED
 * extension/sites.js at run time, so the harness can never drift from the
 * product it is checking. A refuse-route per site comes from the same file's
 * own doctrine — homepages and wallet routes must never mount.
 */
const PROBE_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const TOKEN_REFUSE = {
  axiom: 'https://axiom.trade/discover',
  padre: 'https://trade.padre.gg/',
  photon: 'https://photon-sol.tinyastro.io/en/discover',
  gmgn: 'https://gmgn.ai/?chain=sol',
  bullx: 'https://neo.bullx.io/',
  dexscreener: 'https://dexscreener.com/',
  birdeye: 'https://birdeye.so/',
  jupiter: 'https://jup.ag/',
  fomo: 'https://fomo.family/',
  pumpfun: 'https://pump.fun/board',
  lute: 'https://lute.gg/',
};

async function tokenPlan() {
  const mod = await import('node:module');
  const require_ = mod.createRequire(import.meta.url);
  const g = globalThis;
  const prevWindow = g.window;
  g.window = {};
  require_(resolve(EXT, 'sites.js'));
  const S = g.window.PaperTrenchSites;
  g.window = prevWindow;
  const out = [];
  for (const a of S.ADAPTERS) {
    let url = null;
    try { url = a.tokenUrl ? a.tokenUrl(PROBE_MINT, null, 'solana') : null; } catch { url = null; }
    if (url) out.push({ id: a.id, market: url, refuse: TOKEN_REFUSE[a.id] || null });
  }
  return out;
}

/** What the TOKEN overlay puts on the page. Its shadow root is OPEN, so the
 *  panel's own rendered price can be read directly — the number the user
 *  sees, not a proxy for it. */
async function inspectToken(page) {
  return page.evaluate(() => {
    const host = document.getElementById('papertrench-host');
    if (!host) return { host: false };
    const sh = host.shadowRoot;
    if (!sh) return { host: true, shadow: false };
    const priceEl = sh.getElementById('pt-price');
    const dot = sh.getElementById('pt-live-dot');
    // The host element is created up front, so its existence is NOT a mount —
    // what counts is whether the panel is actually rendering. But do NOT gate
    // on the host's own box: everything inside it is `position: fixed`, so the
    // host measures 0x0 on every site even when the panel is plainly visible.
    // Gating on it reported all ten terminals as "did not mount" while GMGN
    // was showing $221.79M on screen.
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01;
    };
    const panel = sh.querySelector('.pt-panel, #pt-panel, .pt-card') || (priceEl && priceEl.closest('div'));
    const panelVisible = visible(panel) || visible(priceEl);
    return {
      host: true,
      shadow: true,
      price: priceEl ? (priceEl.textContent || '').trim() : null,
      stale: priceEl ? priceEl.classList.contains('pt-price-stale') : null,
      dotClass: dot ? dot.className : null,
      hostExists: true,
      panelPresent: panelVisible,
      hiddenPanel: !!priceEl && !panelVisible,
    };
  });
}

/** What the extension puts on the page, and what a human looks for. */
async function inspect(page) {
  return page.evaluate(() => {
    const badge = [...document.querySelectorAll('div')]
      .find((d) => (d.textContent || '').trim() === 'SIMULATED · NO REAL MONEY');
    const ticket = document.getElementById('pt-predict-ticket');
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
    return {
      badge: !!badge,
      ticket: !!ticket,
      // A price the VENUE renders, used to tell a live page from a shell.
      venuePrices: (bodyText.match(/\b\d{1,2}(?:\.\d)?¢/g) || []).slice(0, 8),
      blockedText: bodyText.slice(0, 300),
    };
  });
}

async function visit(ctx, url, { settle = 9000 } = {}) {
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (/PaperTrench|pt-predict/i.test(t)) logs.push(t); });
  let status = null;
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    status = r && r.status();
    await page.waitForTimeout(settle);
  } catch (e) {
    return { page, url, status, error: e.message.slice(0, 120), logs, seen: null };
  }
  const seen = await inspect(page);
  const title = await page.title().catch(() => '');
  return {
    page, url, status, logs, seen,
    blocked: BLOCK_RE.test(seen.blockedText),
    // Cloudflare and friends answer 403 with an interstitial. That is the
    // venue refusing the robot, not the extension failing to mount.
    botWall: status === 403 || /just a moment|performing security verification|checking your browser/i.test(title + ' ' + seen.blockedText),
  };
}

/** Two reads of the venue's own prices, to prove the page is live, not frozen. */
async function ticks(page) {
  const a = await page.evaluate(() => (document.body.innerText || '').match(/\b\d{1,2}(?:\.\d)?¢/g) || []);
  await page.waitForTimeout(12000);
  const b = await page.evaluate(() => (document.body.innerText || '').match(/\b\d{1,2}(?:\.\d)?¢/g) || []);
  return { before: a.slice(0, 6), after: b.slice(0, 6), changed: JSON.stringify(a) !== JSON.stringify(b) };
}

/* The exact endpoints OUR adapters call — not merely the venue's API host.
 * The venues fetch their own books constantly (Kalshi's page uses
 * /v1/markets/order_books), so matching the host alone reports the site's own
 * traffic as proof our engine ran. These are the paths in predict-venues.js
 * and nothing else. */
const BOOK_HOST = {
  kalshi: /api\.elections\.kalshi\.com\/trade-api\/v2\/markets\/[^/]+\/orderbook/,
  polymarket: /clob\.polymarket\.com\/book\?token_id=/,
  limitless: /api\.limitless\.exchange\/orderbook\?marketId=/,
  'hyperliquid-outcomes': /api\.hyperliquid\.xyz\/info/,
};

async function probeQuote(page, venue) {
  const present = await page.evaluate(() => !!document.getElementById('pt-predict-ticket'));
  if (!present) return 'no ticket to click';

  // The host div is 0x0 — the visible panel is `position: fixed` INSIDE a
  // closed shadow root, so it has no layout box of its own and its nodes
  // cannot be queried. Click by the panel's own fixed geometry instead
  // (predict-ticket.js: bottom 40px, left 8px, width 280px), measuring rows up
  // from the bottom edge the same way the stylesheet lays them out.
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const X = 8 + 280 / 2;
  const yFromBottom = (px) => vp.height - px;

  const hits = [];
  const re = BOOK_HOST[venue];
  const onReq = (r) => { if (re && re.test(r.url())) hits.push(r.url()); };
  page.on('request', onReq);

  await page.mouse.click(83, yFromBottom(159)).catch(() => {});   // YES
  await page.waitForTimeout(300);
  await page.mouse.click(X, yFromBottom(123)).catch(() => {});    // quantity field
  await page.keyboard.type('10').catch(() => {});
  await page.waitForTimeout(300);
  await page.mouse.click(X, yFromBottom(86)).catch(() => {});     // Get Quote
  await page.waitForTimeout(9000);
  page.off('request', onReq);

  // The book is fetched by the SERVICE WORKER, which holds the host
  // permissions — so page-level network events never see it, and counting
  // them reported "no book request" while quotes were working. The ticket
  // publishes its state on the host element instead (data-pt-*), which is the
  // number actually on screen rather than a proxy for it.
  const st = await page.evaluate(() => {
    const el = document.getElementById('pt-predict-ticket');
    return el ? { ...el.dataset } : null;
  });
  if (!st) return 'ticket vanished';
  if (st.ptState === 'quoted') {
    return `QUOTED ${st.ptAvgPrice}c on ${st.ptMarket || '?'} (cost P$${st.ptCost})`
      + (hits.length ? ` [page also fetched ${hits.length}]` : '');
  }
  if (st.ptState === 'error') return `refused: ${st.ptError}`;
  return `no quote (state=${st.ptState || 'unknown'})`;
}

async function resolveMarket(ctx, plan) {
  const r = await visit(ctx, plan.listing, { settle: 10000 });
  if (r.blocked) { await r.page.close(); return { url: null, blocked: true, why: 'listing page is geo/bot blocked' }; }
  const href = await r.page.evaluate((src) => {
    const re = new RegExp(src);
    const a = [...document.querySelectorAll('a[href]')]
      .map((x) => x.getAttribute('href'))
      .filter((h) => h && h.startsWith('/') && re.test(h.split('?')[0]));
    return a[0] || null;
  }, plan.marketPattern.source).catch(() => null);
  const origin = new URL(plan.listing).origin;
  await r.page.close();
  if (href) return { url: origin + href, blocked: false, why: 'resolved from the venue listing' };
  if (plan.fallbackMarket) return { url: plan.fallbackMarket, blocked: false, why: 'listing yielded no link; used known market' };
  return { url: null, blocked: false, why: 'no market link found on the listing page' };
}

/** One token terminal: does the panel mount on a token page, does it show a
 *  price, does that price tick, and does it stay off the site's own homepage. */
async function runTokenSite(ctx, site) {
  const row = { venue: site.id, market: site.market, badge: null, ticket: null, priceTicks: null, refuses: [], notes: [] };
  const m = await visit(ctx, site.market, { settle: 13000 });
  if (m.error) { row.status = 'ERROR'; row.notes.push(m.error); await m.page.close(); return row; }
  if (m.blocked) { row.status = 'BLOCKED'; row.notes.push(m.seen ? m.seen.blockedText.slice(0, 90) : 'blocked'); await m.page.close(); return row; }

  // Distinguishing "we are broken" from "we were never shown the page" is the
  // difference between a report worth reading and one worth ignoring. A
  // REDIRECT to an auth route is the reliable signal — the wording of login
  // walls varies wildly ("Already have an account", "Connect your telegram",
  // "where traders become legends") and text matching misses most of it.
  const landed = m.page.url();
  const redirectedToAuth = /\/(sign-?in|sign-?up|login|auth|connect)(\b|\/|\?)/i.test(landed)
    || (new URL(landed).pathname === '/' && new URL(site.market).pathname !== '/');
  if (m.botWall) {
    row.status = 'BOT WALL — the venue blocked automation, not the extension';
    row.notes.push(`served a challenge instead of the page (${m.status})`);
    await m.page.close();
    return row;
  }
  if (redirectedToAuth || LOGIN_RE.test(m.seen.blockedText)) {
    row.status = 'LOGIN REQUIRED — seed a profile once with login.js, then this runs unattended';
    row.notes.push(`the venue sent us to ${landed.slice(0, 70)} — there is no token page behind it to mount on`);
    await m.page.screenshot({ path: resolve(SHOTS, `${site.id}-login.png`) }).catch(() => {});
    await m.page.close();
    return row;
  }

  const t0 = await inspectToken(m.page);
  row.ticket = !!t0.panelPresent;
  row.badge = !!t0.host;
  row.notes.push(`panel price: ${t0.price == null ? '(none)' : JSON.stringify(t0.price)}${t0.stale ? ' [STALE]' : ''}`);
  if (m.logs.length) row.notes.push('console: ' + m.logs.slice(0, 2).join(' | '));

  // Does the extension's OWN number move? A frozen panel next to a live site
  // is the failure this whole project exists to avoid.
  if (t0.panelPresent) {
    await m.page.waitForTimeout(14000);
    const t1 = await inspectToken(m.page);
    row.priceTicks = !!(t0.price && t1.price && t0.price !== t1.price);
    row.quote = t1.price && t1.price !== '—' ? `price ${t1.price}${t1.stale ? ' (stale-marked)' : ''}` : 'no price rendered';
  }
  await m.page.screenshot({ path: resolve(SHOTS, `${site.id}-token.png`) }).catch(() => {});
  await m.page.close();

  if (site.refuse) {
    const r = await visit(ctx, site.refuse, { settle: 9000 });
    if (r.error || r.blocked) row.refuses.push(`${site.refuse} → ${r.blocked ? 'blocked' : 'error'} (inconclusive)`);
    else {
      const rt = await inspectToken(r.page);
      row.refuses.push(`${site.refuse} → ${rt.panelPresent ? 'MOUNTED (must not)' : 'clean'}`);
    }
    await r.page.close();
  }

  const overMount = row.refuses.some((x) => x.includes('MOUNTED (must not)'));
  row.status = overMount ? 'FAIL — mounts on a refuse route'
    : row.ticket && row.priceTicks ? 'PASS'
    : row.ticket && row.quote && row.quote.startsWith('price') ? 'PASS (price shown; no tick observed in 14s)'
    : row.ticket ? 'PARTIAL — panel mounts but shows no price'
    : 'FAIL — panel did not mount';
  return row;
}

async function run(only, profileDir) {
  mkdirSync(SHOTS, { recursive: true });
  // A seeded profile (see login.js) carries logged-in sessions for the venues
  // that gate their token pages. Without one the pass still runs — it just
  // reports those sites as LOGIN REQUIRED instead of pretending.
  const userDataDir = profileDir || mkdtempSync(resolve(tmpdir(), 'ptlive-'));
  if (profileDir) mkdirSync(profileDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--no-first-run'],
    viewport: { width: 1280, height: 900 },
  });

  const results = [];

  // Token terminals first — they are the older, larger surface.
  for (const site of await tokenPlan()) {
    if (only && site.id !== only) continue;
    results.push(await runTokenSite(ctx, site));
  }
  for (const [venue, plan] of Object.entries(PLAN)) {
    if (only && venue !== only) continue;
    const row = { venue, market: null, badge: null, ticket: null, priceTicks: null, refuses: [], notes: [] };

    const found = await resolveMarket(ctx, plan);
    row.notes.push(found.why);
    if (!found.url) {
      row.status = found.blocked ? 'BLOCKED' : 'NO MARKET FOUND';
      results.push(row);
      continue;
    }
    row.market = found.url;

    const m = await visit(ctx, found.url, { settle: 11000 });
    if (m.error) { row.status = 'ERROR'; row.notes.push(m.error); await m.page.close(); results.push(row); continue; }
    if (m.blocked) { row.status = 'BLOCKED'; row.notes.push('market page: ' + m.seen.blockedText.slice(0, 90)); await m.page.close(); results.push(row); continue; }

    row.badge = m.seen.badge;
    row.ticket = m.seen.ticket;
    row.notes.push(`venue prices on page: ${m.seen.venuePrices.slice(0, 4).join(' ') || 'none'}`);
    if (m.logs.length) row.notes.push('console: ' + m.logs.slice(0, 2).join(' | '));

    const t = await ticks(m.page);
    row.priceTicks = t.changed;
    await m.page.screenshot({ path: resolve(SHOTS, `${venue}-market.png`) }).catch(() => {});

    // Does the ENGINE run, or does a panel merely appear? The ticket lives in
    // a CLOSED shadow root, so its internals cannot be queried — but a quote
    // must walk a real book, and that fetch is observable. Click through the
    // ticket's own coordinates and watch for the venue's book endpoint.
    row.quote = await probeQuote(m.page, venue).catch((e) => 'error: ' + e.message.slice(0, 60));
    await m.page.screenshot({ path: resolve(SHOTS, `${venue}-quote.png`) }).catch(() => {});
    await m.page.close();

    for (const url of plan.refuse) {
      const r = await visit(ctx, url, { settle: 7000 });
      if (r.error || r.blocked) { row.refuses.push(`${url} → ${r.blocked ? 'blocked' : 'error'} (inconclusive)`); }
      else row.refuses.push(`${url} → ${r.seen.badge || r.seen.ticket ? 'MOUNTED (must not)' : 'clean'}`);
      await r.page.close();
    }

    // An engine REFUSAL is not an integration failure — it is the product
    // working. "Larger than this market can absorb", "already priced as a
    // near-certainty", "no visible liquidity" all mean the book was fetched,
    // the engine ran, and a rule fired. Only a refusal that means the pipeline
    // never got a book is a defect. Conflating the two is how a harness starts
    // crying wolf and stops being read.
    const quoted = typeof row.quote === 'string' && row.quote.startsWith('QUOTED');
    const guarded = typeof row.quote === 'string' && /near-certainty|no visible liquidity|market can absorb|has closed|lost the live book|Minimum order/i.test(row.quote);
    const brokenPipe = typeof row.quote === 'string' && /No live book|not yet wired|not loaded|Unknown venue|ticket vanished|no quote \(/i.test(row.quote);
    row.status = row.badge && row.ticket && quoted ? 'PASS'
      : row.badge && row.ticket && guarded ? 'PASS (engine guard fired — pipeline healthy)'
      : row.badge && row.ticket && brokenPipe ? `FAIL — panel mounts but no book reaches it (${row.quote})`
      : row.badge && row.ticket ? `PARTIAL — ${row.quote}`
      : row.badge && !row.ticket ? 'PARTIAL — badge only, no ticket UI'
      : 'FAIL — nothing mounted';
    results.push(row);
  }

  await ctx.close();

  console.log('\n════ pt-recon live pass ════\n');
  for (const r of results) {
    console.log(`${r.venue}: ${r.status}`);
    if (r.market) console.log(`  market:   ${r.market}`);
    console.log(`  badge:    ${r.badge === null ? '—' : r.badge}`);
    console.log(`  ticket:   ${r.ticket === null ? '—' : r.ticket}`);
    console.log(`  ticks:    ${r.priceTicks === null ? '—' : r.priceTicks}`);
    if (r.quote) console.log(`  quote:    ${r.quote}`);
    for (const x of r.refuses) console.log(`  refuse:   ${x}`);
    for (const n of r.notes) console.log(`  note:     ${n}`);
    console.log('');
  }
  const bad = results.filter((r) => r.status && r.status !== 'PASS');
  if (bad.length) process.exitCode = 1;
}

const argv = process.argv.slice(2);
const profileArg = argv.indexOf('--profile');
const profile = profileArg >= 0 ? argv[profileArg + 1] : null;
const target = argv.filter((a, i) => !a.startsWith('--') && i !== profileArg + 1)[0] || null;
run(target, profile).catch((e) => { console.error('livepass failed:', e); process.exit(1); });
