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
  return { page, url, status, logs, seen, blocked: BLOCK_RE.test(seen.blockedText) };
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
  await page.waitForTimeout(7000);
  page.off('request', onReq);

  return hits.length ? `book fetched (${hits.length}) e.g. ${hits[0].slice(0, 78)}` : 'no venue book request seen';
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

async function run(only) {
  mkdirSync(SHOTS, { recursive: true });
  const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'ptlive-')), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--no-first-run'],
    viewport: { width: 1280, height: 900 },
  });

  const results = [];
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

    row.status = row.badge && row.ticket ? 'PASS'
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

run(process.argv[2] || null).catch((e) => { console.error('livepass failed:', e); process.exit(1); });
