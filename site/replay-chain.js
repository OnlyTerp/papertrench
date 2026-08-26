/* PaperTrench Replay - client chain lane.
 *
 * The Worker rebuilds a wallet's fills from public Solana RPC, but Cloudflare
 * egress IPs are 403'd by every keyless RPC (verified via the worker's own
 * error surface 8/26: rpc-http-403 across the whole pool). The BROWSER is not
 * a datacenter - the same calls succeed from the user's IP. So when the
 * worker's chain lane comes back empty-with-error, the page rebuilds the
 * history itself: wallet+mint -> ATA -> signatures -> parsed txs -> fills,
 * then folds them with the SAME shipped accounting core the server tests
 * prove (vendor/replay-core.js, byte-identical to core/replay.js).
 *
 * Decode doctrine mirrors worker/solana.js exactly:
 *   token delta on the wallet's ATA = side/qty; SOL + WSOL delta = counter
 *   leg; price = bar mark of the fill's minute first (of the fill's era),
 *   SOL-spot x counter-leg only for fills < 48h old; unpriceable trades are
 *   dropped honestly, never fabricated.
 */
(function () {
  'use strict';

  const RPCS = [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
    'https://solana.drpc.org',
  ];
  const WSOL = 'So11111111111111111111111111111111111111112';

  async function rpcCall(method, params, budget) {
    let lastErr = null;
    for (const base of RPCS) {
      if (budget.used >= budget.max) throw Object.assign(new Error('rpc-budget'), { code: 'rpc-budget' });
      budget.used += 1;
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!res.ok) { lastErr = new Error('rpc-http-' + res.status); continue; }
        const body = await res.json();
        if (body.error) { lastErr = new Error(body.error.message || 'rpc-error'); continue; }
        return body.result;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('rpc-failed');
  }

  function decodeFill(tx, wallet, mint) {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const meta = tx.meta;
    const bal = (rows) => {
      let sum = 0;
      for (const b of rows || []) {
        if (b.owner === wallet && b.mint === mint) sum += Number((b.uiTokenAmount || {}).uiAmount || 0);
      }
      return sum;
    };
    const tokenDelta = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
    if (!(Math.abs(tokenDelta) > 0)) return null;
    const msg = tx.transaction && tx.transaction.message;
    const keys = ((msg && msg.accountKeys) || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
    const wi = keys.indexOf(wallet);
    let solDelta = wi >= 0 ? (meta.postBalances[wi] - meta.preBalances[wi]) / 1e9 : 0;
    for (const b of meta.postTokenBalances || []) {
      if (b.owner === wallet && b.mint === WSOL) {
        const pre = (meta.preTokenBalances || []).find((p) => p.accountIndex === b.accountIndex);
        solDelta += Number((b.uiTokenAmount || {}).uiAmount || 0) - Number(((pre || {}).uiTokenAmount || {}).uiAmount || 0);
      }
    }
    const ts = Number(tx.blockTime || 0) * 1000;
    if (!(ts > 0)) return null;
    return { ts, side: tokenDelta > 0 ? 'buy' : 'sell', base: Math.abs(tokenDelta), solDelta };
  }

  /** SOL/USD spot from Jupiter's free endpoint; 0 on any failure. */
  async function solSpot() {
    try {
      const r = await fetch('https://lite-api.jup.ag/price/v3?ids=' + WSOL);
      if (!r.ok) return 0;
      const j = await r.json();
      return Number(((j || {})[WSOL] || {}).usdPrice) || 0;
    } catch { return 0; }
  }

  /**
   * Rebuild a wallet's fills on a mint from the chain, priced against the
   * candles the page already holds. Returns { fills, txSeen, truncated }.
   */
  async function walletFills(wallet, mint, candles, opts) {
    const budget = { used: 0, max: (opts && opts.maxRpc) || 60 };
    const txCap = (opts && opts.txCap) || 40;
    const atasRes = await rpcCall('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }], budget);
    const atas = ((atasRes && atasRes.value) || []).map((a) => a.pubkey);
    if (!atas.length) return { fills: [], txSeen: 0, truncated: false };

    const sigSet = new Map();
    for (const ata of atas.slice(0, 2)) {
      let before;
      for (let page = 0; page < 3; page++) {
        const o = { limit: 1000 };
        if (before) o.before = before;
        const batch = await rpcCall('getSignaturesForAddress', [ata, o], budget);
        if (!Array.isArray(batch) || !batch.length) break;
        for (const s of batch) if (!s.err) sigSet.set(s.signature, s);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1].signature;
      }
    }
    const ordered = [...sigSet.values()].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
    let picked = ordered, truncated = false;
    if (ordered.length > txCap) {
      picked = [...ordered.slice(0, Math.ceil(txCap / 2)), ...ordered.slice(-Math.floor(txCap / 2))];
      truncated = true;
    }

    const byMinute = new Map();
    for (const c of candles || []) {
      const t = Number(c.ts);
      byMinute.set(Math.floor((t < 1e12 ? t * 1000 : t) / 60000) * 60000, c);
    }
    const spot = await solSpot();
    const SPOT_HONEST_MS = 48 * 3600 * 1000;
    const now = Date.now();

    const fills = [];
    for (const s of picked) {
      let tx = null;
      try {
        tx = await rpcCall('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], budget);
      } catch (err) { truncated = true; break; }
      const f = decodeFill(tx, wallet, mint);
      if (!f) continue;
      let usd = 0;
      const bar = byMinute.get(Math.floor(f.ts / 60000) * 60000);
      if (bar && Number(bar.c) > 0) usd = f.base * Number(bar.c);
      if (!(usd > 0) && Math.abs(f.solDelta) > 1e-6 && spot > 0 && (now - f.ts) < SPOT_HONEST_MS) {
        usd = Math.abs(f.solDelta) * spot;
      }
      const isTransfer = Math.abs(f.solDelta) < 1e-6;
      if (!(usd > 0) && !isTransfer) continue; // unpriceable: drop honestly
      fills.push({
        ts: f.ts, wallet, side: f.side, base: f.base, usd,
        solLamports: Math.round(Math.abs(f.solDelta) * 1e9),
        isTransfer, priceUsd: usd > 0 && f.base > 0 ? usd / f.base : null, mint,
      });
    }
    fills.sort((a, b) => a.ts - b.ts);
    return { fills, txSeen: ordered.length, truncated };
  }

  window.ReplayChain = { walletFills, decodeFill, rpcCall, RPCS };
})();
