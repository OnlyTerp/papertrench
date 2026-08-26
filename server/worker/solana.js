/* PaperTrench worker - Solana chain lane for wallet replay.
 *
 * WHY (learned from the live wire 8/26): Indeix's /2/token/trades is a
 * firehose of the token's last ~50-100 trades (~90 seconds of a hot coin) and
 * its walletAddress filter silently ignores the filter; /2/wallet/trades
 * returns an empty snapshot for wallets it has not indexed. So a wallet's
 * FULL history on a mint cannot come from Indeix - it lives on chain.
 *
 * This lane rebuilds it first-principles from public RPC:
 *   wallet+mint -> ATA (getTokenAccountsByOwner / PDA probe)
 *   -> getSignaturesForAddress(ATA)  (full life of the token account)
 *   -> getTransaction(sig) x N       (parsed, balance deltas)
 *   -> fills: token delta on the wallet's ATA + SOL/WSOL counter-delta
 * Price per fill = |counterUsd| / |tokenDelta| when the counter leg moved,
 * else the bar mark at that minute (core/replay.js applies the same doctrine).
 *
 * Public RPCs rotate on failure; all calls are bounded by a budget so a whale
 * wallet cannot burn the worker's CPU time (Workers get ~50 subrequests).
 */
'use strict';

// Public RPC pool. Workers egress from Cloudflare datacenter IPs, which some
// public RPCs 403 (publicnode and mainnet-beta both do - verified via the
// worker's own error surface 8/26). Order matters: first success wins, and
// the pool leads with endpoints known to accept datacenter traffic.
const RPCS = [
  'https://solana.drpc.org',
  'https://rpc.ankr.com/solana',
  'https://solana-mainnet.gateway.tatum.io',
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
];

async function rpcCall(method, params, budget) {
  let lastErr = null;
  for (const base of RPCS) {
    if (budget && budget.used >= budget.max) {
      const err = new Error('rpc-budget-exhausted');
      err.code = 'rpc-budget-exhausted';
      throw err;
    }
    if (budget) budget.used += 1;
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) { lastErr = new Error(`rpc-http-${res.status}`); continue; }
      const body = await res.json();
      if (body.error) { lastErr = new Error(body.error.message || 'rpc-error'); continue; }
      return body.result;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('rpc-failed');
}

const WSOL = 'So11111111111111111111111111111111111111112';

/** The wallet's token accounts (ATAs) for a mint. Usually exactly one. */
async function tokenAccounts(wallet, mint, budget) {
  const out = await rpcCall('getTokenAccountsByOwner',
    [wallet, { mint }, { encoding: 'jsonParsed' }], budget);
  return ((out && out.value) || []).map((a) => a.pubkey);
}

/** Full signature list for an account, oldest last. Bounded by maxPages. */
async function signaturesFor(address, budget, maxPages = 3) {
  const sigs = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const opts = { limit: 1000 };
    if (before) opts.before = before;
    const batch = await rpcCall('getSignaturesForAddress', [address, opts], budget);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const s of batch) if (!s.err) sigs.push(s);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
  }
  return sigs;
}

/**
 * Decode one parsed transaction into a fill from `wallet`'s perspective on
 * `mint`. Returns null when the tx moved no tokens for this wallet.
 */
function decodeFill(tx, wallet, mint) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const meta = tx.meta;
  const bal = (rows) => {
    let sum = 0;
    for (const b of rows || []) {
      if (b.owner === wallet && b.mint === mint) {
        sum += Number((b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0);
      }
    }
    return sum;
  };
  const tokenDelta = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
  if (!(Math.abs(tokenDelta) > 0)) return null;

  // Counter leg: the wallet's native SOL delta (fees included) plus any WSOL
  // token delta - swaps route through either. Fees are part of the price a
  // trader actually paid, so leaving them in is honest for PnL purposes.
  const msg = tx.transaction && tx.transaction.message;
  const keys = ((msg && msg.accountKeys) || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const wi = keys.indexOf(wallet);
  let solDelta = wi >= 0 ? (meta.postBalances[wi] - meta.preBalances[wi]) / 1e9 : 0;
  for (const b of meta.postTokenBalances || []) {
    if (b.owner === wallet && b.mint === WSOL) {
      const pre = (meta.preTokenBalances || []).find((p) => p.accountIndex === b.accountIndex);
      solDelta += Number((b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0)
        - Number(((pre || {}).uiTokenAmount || {}).uiAmount || 0);
    }
  }

  const ts = Number(tx.blockTime || 0) * 1000;
  if (!(ts > 0)) return null;
  return {
    ts,
    side: tokenDelta > 0 ? 'buy' : 'sell',
    base: Math.abs(tokenDelta),
    solDelta, // signed; buy is negative (SOL out)
    sig: (tx.transaction.signatures || [])[0] || '',
  };
}

/**
 * A wallet's complete fill history on one mint, priced in USD.
 * `solUsdAt(tsMs)` supplies the SOL/USD mark for a minute (from candles the
 * caller already holds, or a flat spot price - honesty degrades gracefully).
 */
async function walletFills(wallet, mint, budget, solUsdAt, txCap = 25) {
  const atas = await tokenAccounts(wallet, mint, budget);
  if (!atas.length) return { fills: [], truncated: false, txSeen: 0 };
  const sigSet = new Map();
  for (const ata of atas.slice(0, 2)) {
    for (const s of await signaturesFor(ata, budget)) sigSet.set(s.signature, s);
  }
  const ordered = [...sigSet.values()].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
  // Cap parsed txs: take the FIRST fills (entries) and the LAST (exits) - the
  // story of a position is its opening and its closing; the middle churn
  // matters less than blowing the subrequest budget and returning nothing.
  let picked = ordered;
  let truncated = false;
  if (ordered.length > txCap) {
    const head = ordered.slice(0, Math.ceil(txCap / 2));
    const tail = ordered.slice(-Math.floor(txCap / 2));
    picked = [...head, ...tail];
    truncated = true;
  }
  const fills = [];
  for (const s of picked) {
    let tx = null;
    try {
      tx = await rpcCall('getTransaction',
        [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], budget);
    } catch (err) {
      if (err && err.code === 'rpc-budget-exhausted') { truncated = true; break; }
      continue;
    }
    const f = decodeFill(tx, wallet, mint);
    if (!f) continue;
    const solUsd = solUsdAt ? solUsdAt(f.ts) : 0;
    const counterUsd = Math.abs(f.solDelta) * (solUsd || 0);
    fills.push({
      ts: f.ts,
      wallet,
      side: f.side,
      base: f.base,
      usd: counterUsd, // 0 when no SOL mark; core prices from the bar then
      solLamports: Math.round(Math.abs(f.solDelta) * 1e9),
      isTransfer: Math.abs(f.solDelta) < 1e-6, // no counter leg moved
      priceUsd: counterUsd > 0 && f.base > 0 ? counterUsd / f.base : null,
      mint,
      sig: f.sig,
    });
  }
  return { fills, truncated, txSeen: ordered.length };
}

export { rpcCall, tokenAccounts, signaturesFor, decodeFill, walletFills, WSOL, RPCS };
