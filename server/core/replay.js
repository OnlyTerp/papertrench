/* PaperTrench server — real-wallet trade replay engine (pure core).
 *
 * The on-chain replay feature reconstructs a wallet's journey on one token:
 * given the token's trades (from Indeix, each carrying the sender wallet, side,
 * USD + SOL amounts, timestamp) and the token's OHLCV candles, it produces the
 * bar-by-bar position and PnL curve that the Replay chart draws, plus the
 * leaderboard-style per-wallet ranking.
 *
 * This module is PURE — no fetch, no env, no I/O. It runs identically under
 * `node --test` and inside the Worker. Everything that decides WHETHER a
 * number is honest lives here; worker/index.js only routes bytes.
 *
 * Accounting doctrine (ported from Trickshot's proven model, adapted to Indeix):
 *   - cash-flow  pnl = cash + qty * price. Order-independent; ranks the board.
 *   - avg-cost   splits that into realized + unrealized; order-dependent, so it
 *                is only folded where stream order is known (the wallet replay).
 *   - A transfer (no money moved) moves qty but creates NO cost basis — a
 *     wallet handed 32M tokens must not rank as a winner on the gift.
 *   - Unknown-basis is summed and excluded from the mark, not a hard discard.
 *
 * Honesty rules be[to the user-visible number]: never fabricate a fill price.
 * A trade with no USD amount is priced from the bar mark (the candle close at
 * its minute) — and only when that close exists.
 */
'use strict';

/** True Solana base58 address. */
function isAddress(v) {
  return typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num0(v) {
  const n = num(v);
  return n && n > 0 ? n : 0;
}

/**
 * Normalize one raw trade from Indeix's /2/token/trades into a Fill.
 *
 * Returns null when the trade cannot be priced (no amount, no bar mark) — an
 * unpriced trade must not be silently dropped nor fabricated.
 */
function normalizeTrade(item, candleByMinute) {
  if (!item || typeof item !== 'object') return null;
  const mint = isAddress(item.address || item.mint) ? (item.address || item.mint) : null;
  if (!mint) return null;
  const wallet = isAddress(item.transactionSenderAddress || item.swapSenderAddress)
    ? (item.transactionSenderAddress || item.swapSenderAddress) : null;
  if (!wallet) return null;

  const base = item.baseToken || {};
  const quote = item.quoteToken || {};
  const baseAddress = isAddress(base.address) ? base.address : '';
  const quoteAddress = isAddress(quote.address) ? quote.address : '';

  let tokenRaw = null, otherRaw = null;
  if (baseAddress === mint) { tokenRaw = num0(item.baseTokenAmountRaw); otherRaw = num0(item.quoteTokenAmountRaw); }
  else if (quoteAddress === mint) { tokenRaw = num0(item.quoteTokenAmountRaw); otherRaw = num0(item.baseTokenAmountRaw); }
  else { return null; } // not about this mint

  const usd = num(item.baseTokenAmountUSD) || (baseAddress === mint ? num(item.baseTokenAmountUSD) : num(item.quoteTokenAmountUSD));
  const solLamports = num0(item.solLamports) || num0(item.solAmount) || 0;
  const ts = num(item.blockTime) || num(item.timestamp);
  if (!(ts > 0)) return null;
  // Unify to MILLISECONDS. Indeix's blockTime is seconds; candles come in ms.
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  const minuteMs = Math.floor(tsMs / 60000) * 60000;

  const side = (baseAddress === mint)
    ? (String(item.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy')
    : (String(item.side || '').toLowerCase() === 'buy' ? 'sell' : 'buy');

  // A transfer (token moved, no SOL leg) has no price. Priced only from the
  // bar mark if this is genuinely a transfer; else it is a swap.
  const isTransfer = solLamports <= 0 && !(usd > 0);
  let priceUsd = usd > 0 && tokenRaw > 0 ? usd / tokenRaw : null;
  if (!(priceUsd > 0) && isTransfer) {
    const bar = candleByMinute && candleByMinute.get(minuteMs);
    if (bar && num0(bar.c) > 0) priceUsd = num(bar.c); // mark at the bar close
  }
  if (!(priceUsd > 0) && tokenRaw > 0) {
    // No USD and not a transfer we can mark — price from the bar close if known.
    const bar = candleByMinute && candleByMinute.get(minuteMs);
    if (bar && num0(bar.c) > 0) priceUsd = num(bar.c);
  }
  if (!(priceUsd > 0)) return null;

  const usdValue = tokenRaw * priceUsd;
  return {
    ts: tsMs, wallet, side, base: tokenRaw, usd: usdValue,
    solLamports, isTransfer, priceUsd, mint,
  };
}

/**
 * Fold a wallet's fills into a live Position, in stream order.
 *
 * Mirrors Trickshot's PositionBook.apply: cash-flow and avg-cost kept side by
 * side, transfers move qty but not basis, unknown-basis is tracked and summed.
 */
function foldFills(fills) {
  const p = {
    qty: 0, cash: 0, costBasis: 0, realized: 0, buys: 0, sells: 0,
    boughtUsd: 0, boughtBase: 0, soldUsd: 0, soldBase: 0,
    firstTs: 0, lastTs: 0, unknownBase: 0, unknownUsd: 0, unknownHeld: 0,
  };
  for (const f of fills) {
    if (!f) continue;
    if (!p.firstTs || f.ts < p.firstTs) p.firstTs = f.ts;
    if (f.ts > p.lastTs) p.lastTs = f.ts;

    if (f.isTransfer) {
      if (f.side === 'buy') {
        p.qty += f.base; p.unknownBase += f.base; p.unknownHeld += f.base;
      } else {
        const sent = Math.min(f.base, p.qty);
        if (sent > 0 && p.qty > 0) {
          const avgCost = p.costBasis / p.qty;
          const proceeds = f.usd * (sent / f.base);
          const giftSent = (p.unknownHeld / p.qty) * sent;
          const giftUsd = giftSent > 0 ? proceeds * (giftSent / sent) : 0;
          p.unknownUsd += giftUsd; p.cash += proceeds;
          p.realized += proceeds - avgCost * sent - giftUsd;
          p.unknownHeld -= giftSent; p.costBasis -= avgCost * sent; p.qty -= sent;
        }
      }
      continue;
    }

    if (f.side === 'buy') {
      p.qty += f.base; p.cash -= f.usd; p.costBasis += f.usd;
      p.buys += 1; p.boughtUsd += f.usd; p.boughtBase += f.base;
    } else {
      p.cash += f.usd; p.sells += 1; p.soldUsd += f.usd; p.soldBase += f.base;
      const sold = Math.min(f.base, p.qty);
      if (sold > 0) {
        const avgCost = p.costBasis / p.qty;
        const proceeds = f.usd * (sold / f.base);
        const giftSold = (p.unknownHeld / p.qty) * sold;
        const giftUsd = giftSold > 0 ? proceeds * (giftSold / sold) : 0;
        p.unknownUsd += giftUsd; p.realized += proceeds - avgCost * sold - giftUsd;
        p.unknownHeld -= giftSold; p.costBasis -= avgCost * sold; p.qty -= sold;
      }
      const unmatched = f.base - sold;
      if (unmatched > 1e-9) {
        p.unknownBase += unmatched;
        p.unknownUsd += f.usd * (unmatched / f.base);
      }
    }
  }
  return p;
}

/** Position PnL at a given price. `unknownHeld` tokens are not marked to market. */
function pnlAt(p, price) {
  const priced = Math.max(0, p.qty - p.unknownHeld);
  const unrealized = priced * price - p.costBasis;
  const total = p.cash - p.unknownUsd + priced * price;
  return { realized: p.realized, unrealized, total };
}

/**
 * Minute-by-minute replay curve for ONE wallet on ONE token.
 *
 * Re-folds the wallet's fills against the token's 1m closes so realized and
 * unrealized are both correct as of each minute (not back-projected from the
 * current position). Returns points aligned to candle minutes.
 */
function replayCurve(fills, candles) {
  const ordered = (fills || []).filter(Boolean).slice().sort((a, b) => a.ts - b.ts);
  const minutes = (candles || []).map((c) => {
    const t = num(c.ts); const ts = t < 1e12 ? t * 1000 : t;
    return {
      ts: Math.floor(ts / 60000) * 60000, c: num0(c.c), o: num0(c.o), h: num0(c.h), l: num0(c.l),
    };
  }).sort((a, b) => a.ts - b.ts);
  if (!ordered.length || !minutes.length) return [];

  const points = [];
  let fi = 0;
  const position = {
    qty: 0, cash: 0, costBasis: 0, realized: 0, buys: 0, sells: 0,
    boughtUsd: 0, soldUsd: 0, unknownHeld: 0, unknownUsd: 0,
  };
  const apply = (f, sign) => {
    // sign +1 to fold onto the running position, -1 to unfold (used when a
    // fill is replayed as of a later minute — not needed here since we walk
    // forward, but kept for parity/clarity of the fold model).
    if (sign < 0) return;
    const r = foldFills([f]);
    position.qty += r.qty; position.cash += r.cash; position.costBasis += r.costBasis;
    position.realized += r.realized; position.buys += r.buys; position.sells += r.sells;
    position.boughtUsd += r.boughtUsd; position.soldUsd += r.soldUsd;
    position.unknownHeld += r.unknownHeld; position.unknownUsd += r.unknownUsd;
  };

  for (const bar of minutes) {
    // Fold every fill that belongs to this bar's window [bar.ts, bar.ts+60000)
    // or was earlier — i.e. any fill strictly before the NEXT minute boundary.
    // `<= bar.ts` was wrong: a fill seconds into the minute has ts > bar.ts
    // (the minute's start), so it never matched its own bar and the position
    // lagged one bar behind the price it traded at.
    const windowEnd = bar.ts + 60000;
    while (fi < ordered.length && ordered[fi].ts < windowEnd) {
      apply(ordered[fi], 1); fi++;
    }
    const pnl = pnlAt(position, bar.c);
    points.push({
      ts: bar.ts, price: bar.c,
      qty: position.qty, realized: pnl.realized, unrealized: pnl.unrealized, total: pnl.total,
      boughtUsd: position.boughtUsd, soldUsd: position.soldUsd,
    });
  }
  return points;
}

/**
 * Rank wallets on a token by lifetime cash-flow PnL at the final price.
 * Returns top and bottom N. Transfers never rank as wins (see foldFills).
 */
function leaderboard(fillsByWallet, finalPrice, limit = 10) {
  const rows = [];
  for (const [wallet, fills] of Object.entries(fillsByWallet || {})) {
    const p = foldFills(fills);
    const price = num0(finalPrice);
    const pnl = pnlAt(p, price || 0);
    const unknown = p.unknownBase > 0 || p.unknownUsd > 0;
    const traded = p.buys > 0 || p.sells > 0;
    rows.push({
      wallet, qty: p.qty, buys: p.buys, sells: p.sells,
      boughtUsd: p.boughtUsd, soldUsd: p.soldUsd,
      realized: pnl.realized, unrealized: pnl.unrealized, total: pnl.total,
      unknownBasis: unknown, traded, unpricedBase: p.unknownBase, unpricedValue: p.unknownBase * price,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return { top: rows.slice(0, limit), bottom: rows.slice(-limit).reverse(), wallets: rows.filter((r) => r.traded).length };
}

/** Group normalized fills by wallet. */
function groupByWallet(fills) {
  const byWallet = {};
  for (const f of (fills || []).filter(Boolean)) {
    (byWallet[f.wallet] = byWallet[f.wallet] || []).push(f);
  }
  return byWallet;
}

const api = {
  isAddress, num, num0, normalizeTrade, foldFills, pnlAt, replayCurve, leaderboard, groupByWallet,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
