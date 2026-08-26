/* PaperTrench Replay - client chain lane.
 *
 * The Worker cannot rebuild wallet history: Cloudflare egress IPs are 403'd
 * outright by public Solana RPCs. The BROWSER is allowed further in - probed
 * live 8/26 from this very page: publicnode serves getSignaturesForAddress
 * and getTransaction to residential IPs, and gates only "indexed" methods
 * (getTokenAccountsByOwner: "Indexed requests require a personal token").
 *
 * So the one indexed call is replaced with math: an associated token account
 * is a PDA - sha256(wallet || tokenProgram || mint || bump || ataProgram ||
 * "ProgramDerivedAddress") walked down from bump 255 to the first hash that
 * is NOT an ed25519 curve point. WebCrypto does the sha256; the on-curve
 * check is 30 lines of BigInt field math (decompress per RFC 8032). Both
 * classic SPL-Token and Token-2022 ATAs are derived and probed - pump.fun
 * graduates hold Token-2022 accounts (POOL-LAYOUTS doctrine).
 *
 * Decode doctrine mirrors worker/solana.js exactly: token delta on the
 * wallet's accounts = side/qty; SOL + WSOL delta = counter leg; price = bar
 * mark of the fill's minute first (of the fill's era), SOL-spot x counter-leg
 * only for fills < 48h old; unpriceable trades dropped honestly.
 */
(function () {
  'use strict';

  const RPCS = [
    'https://solana-rpc.publicnode.com',
    'https://api.mainnet-beta.solana.com',
  ];
  const WSOL = 'So11111111111111111111111111111111111111112';
  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

  /* ---- base58 <-> bytes (bitcoin alphabet) ---- */
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B58_MAP = {}; for (let i = 0; i < B58.length; i++) B58_MAP[B58[i]] = BigInt(i);

  function b58decode(s) {
    let n = 0n;
    for (const ch of s) {
      const v = B58_MAP[ch];
      if (v === undefined) throw new Error('bad base58');
      n = n * 58n + v;
    }
    const out = [];
    while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
    for (const ch of s) { if (ch === '1') out.unshift(0); else break; }
    while (out.length < 32) out.unshift(0);
    return new Uint8Array(out);
  }

  function b58encode(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
  }

  /* ---- ed25519 on-curve test (RFC 8032 decompression, existence only) ---- */
  const P = 2n ** 255n - 19n;
  const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

  function pow(base, exp) {
    let r = 1n; base %= P;
    while (exp > 0n) {
      if (exp & 1n) r = (r * base) % P;
      base = (base * base) % P; exp >>= 1n;
    }
    return r;
  }

  function isOnCurve(bytes) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] & (i === 31 ? 0x7f : 0xff));
    if (y >= P) return false;
    const yy = (y * y) % P;
    const u = (yy - 1n + P) % P;
    const v = (D * yy + 1n) % P;
    // candidate x = u * v^3 * (u * v^7)^((p-5)/8)
    const v3 = (v * v % P) * v % P;
    const v7 = (v3 * v3 % P) * v % P;
    let x = (u * v3 % P) * pow((u * v7) % P, (P - 5n) / 8n) % P;
    const vxx = (v * x % P) * x % P;
    if (vxx === u) return true;
    if (vxx === (P - u) % P) return true; // x * 2^((p-1)/4) fixes the sign
    return false;
  }

  async function sha256(bytes) {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(d);
  }

  /** findProgramAddress for the ATA seeds; returns base58 or null. */
  async function deriveAta(wallet, mint, tokenProgram) {
    const seeds = [b58decode(wallet), b58decode(tokenProgram), b58decode(mint)];
    const pid = b58decode(ATA_PROGRAM);
    const marker = new TextEncoder().encode('ProgramDerivedAddress');
    for (let bump = 255; bump >= 0; bump--) {
      const buf = new Uint8Array(32 * 3 + 1 + 32 + marker.length);
      let o = 0;
      for (const s of seeds) { buf.set(s, o); o += 32; }
      buf[o++] = bump;
      buf.set(pid, o); o += 32;
      buf.set(marker, o);
      const h = await sha256(buf);
      if (!isOnCurve(h)) return b58encode(h);
    }
    return null;
  }

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
    // USDC/USDT counter-leg: routers frequently swap token<->stable with ZERO
    // native SOL movement on the wallet (seen live 8/26 - every fill of the
    // CATE tape's top trader was vs USDC). A stable delta IS a dollar price.
    const STABLES = {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1, // USDC
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1, // USDT
    };
    let stableUsd = 0;
    const deltaFor = (mintAddr) => {
      let d = 0;
      for (const b of meta.postTokenBalances || []) {
        if (b.owner === wallet && b.mint === mintAddr) {
          const pre = (meta.preTokenBalances || []).find((p) => p.accountIndex === b.accountIndex);
          d += Number((b.uiTokenAmount || {}).uiAmount || 0) - Number(((pre || {}).uiTokenAmount || {}).uiAmount || 0);
        }
      }
      // an account emptied to zero can vanish from postTokenBalances
      for (const p of meta.preTokenBalances || []) {
        if (p.owner === wallet && p.mint === mintAddr
          && !(meta.postTokenBalances || []).some((b) => b.accountIndex === p.accountIndex)) {
          d -= Number((p.uiTokenAmount || {}).uiAmount || 0);
        }
      }
      return d;
    };
    for (const sm of Object.keys(STABLES)) stableUsd += Math.abs(deltaFor(sm)) * STABLES[sm];
    solDelta += deltaFor(WSOL);
    const ts = Number(tx.blockTime || 0) * 1000;
    if (!(ts > 0)) return null;
    return { ts, side: tokenDelta > 0 ? 'buy' : 'sell', base: Math.abs(tokenDelta), solDelta, stableUsd };
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
   * Rebuild a wallet's fills on a mint straight from the chain, priced
   * against the candles the page already holds.
   * Returns { fills, txSeen, truncated }.
   */
  async function walletFills(wallet, mint, candles, opts) {
    const budget = { used: 0, max: (opts && opts.maxRpc) || 60 };
    const txCap = (opts && opts.txCap) || 40;

    // Derive both possible ATAs locally - zero indexed RPC calls.
    const atas = [];
    for (const prog of [TOKEN_PROGRAM, TOKEN_2022]) {
      try { const a = await deriveAta(wallet, mint, prog); if (a) atas.push(a); } catch { /* skip */ }
    }
    if (!atas.length) return { fills: [], txSeen: 0, truncated: false };

    const sigSet = new Map();
    for (const ata of atas) {
      let before;
      for (let page = 0; page < 3; page++) {
        const o = { limit: 1000 };
        if (before) o.before = before;
        let batch;
        try {
          batch = await rpcCall('getSignaturesForAddress', [ata, o], budget);
        } catch { break; } // an ATA that never existed still answers []; a dead RPC should not kill the other ATA
        if (!Array.isArray(batch) || !batch.length) break;
        for (const s of batch) if (!s.err) sigSet.set(s.signature, s);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1].signature;
      }
    }
    const ordered = [...sigSet.values()].sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));
    let picked = ordered, truncated = false;
    if (ordered.length > txCap) {
      // Keep the story's ends: entries at the start, exits at the end.
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
      } catch { truncated = true; break; }
      const f = decodeFill(tx, wallet, mint);
      if (!f) continue;
      // Price doctrine, in order of honesty:
      // 1. stable counter-leg (USDC/USDT delta IS dollars, any era)
      // 2. bar mark of the fill's minute (of the fill's era)
      // 3. SOL counter-leg x today's spot, only for fills < 48h old
      let usd = 0;
      if (f.stableUsd > 0.01) usd = f.stableUsd;
      if (!(usd > 0)) {
        const bar = byMinute.get(Math.floor(f.ts / 60000) * 60000);
        if (bar && Number(bar.c) > 0) usd = f.base * Number(bar.c);
      }
      if (!(usd > 0) && Math.abs(f.solDelta) > 1e-6 && spot > 0 && (now - f.ts) < SPOT_HONEST_MS) {
        usd = Math.abs(f.solDelta) * spot;
      }
      const isTransfer = Math.abs(f.solDelta) < 1e-6 && !(f.stableUsd > 0.01);
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

  const api = { walletFills, decodeFill, rpcCall, deriveAta, isOnCurve, b58encode, b58decode, RPCS };
  if (typeof window !== 'undefined') window.ReplayChain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
