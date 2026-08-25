/* PaperTrench — live on-chain price feed (service worker).
 *
 * Holds one WebSocket to a Solana RPC and `accountSubscribe`s to the pool
 * backing the token on screen, at `processed` commitment (~400ms) rather than
 * `confirmed` (~2-3s, what aggregators publish from).
 *
 * Decoding lives in onchain.js and every offset there was verified against
 * mainnet. This file is transport and lifecycle only.
 *
 * Invariants:
 *   - A notification from an older slot never replaces a newer one.
 *   - A pool whose owner program has no verified decoder produces no on-chain
 *     quote at all. It falls back to the aggregator and says so.
 *   - The socket reconnects with backoff and resubscribes; a dead socket must
 *     never look like a quiet market.
 */
(() => {
  'use strict';

  const O = (typeof self !== 'undefined' && self.PTOnchain)
    || (typeof window !== 'undefined' && window.PTOnchain)
    || (typeof require === 'function' ? require('./onchain.js') : null);
  const POOL = (typeof self !== 'undefined' && self.PTRpcPool)
    || (typeof window !== 'undefined' && window.PTRpcPool)
    || (typeof require === 'function' ? require('./rpc-pool.js') : null);

  // A missing dependency previously surfaced as watch() quietly returning
  // false, which looked identical to "this pool has no decoder" and hid the
  // real fault for an entire release. Fail loudly instead.
  if (!O || !POOL) {
    try {
      console.error('PaperTrench: on-chain feed disabled — missing',
        !O ? 'PTOnchain' : '', !POOL ? 'PTRpcPool' : '');
    } catch (_) {}
  }

  const COMMITMENT = 'processed';
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 15000;
  // A quote older than this is not fresh enough to fill against.
  const QUOTE_STALE_MS = 2500;

  let socket = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let nextRequestId = 1;
  // Index into the ranked WebSocket list, so a dead endpoint is stepped past
  // rather than retried forever.
  let wsIndex = 0;
  let activeWsId = null;

  // mint -> { pool, kind, decimals, subId, quote }
  const watched = new Map();
  // subscription id -> mint
  const subToMint = new Map();
  const pending = new Map();
  const listeners = new Set();

  /**
   * Point the feed at a user-supplied endpoint. Entirely optional — the
   * keyless public pool is the default and requires no setup from anyone.
   */
  function configure(opts) {
    if (!opts || !POOL) return;
    POOL.setUserEndpoint(opts.rpcUrl || null);
    // A changed endpoint invalidates the current socket.
    if (socket) { try { socket.close(); } catch (_) {} socket = null; }
    wsIndex = 0;
  }

  function onQuote(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function emit(quote) {
    for (const fn of listeners) {
      try { fn(quote); } catch (_) { /* one bad listener must not stop the feed */ }
    }
  }

  /* ---------------- HTTP RPC ---------------- */

  /** Every HTTP read goes through the pool, so one throttled endpoint is survivable. */
  function rpc(method, params) {
    return POOL.call(method, params);
  }

  async function getAccounts(addresses) {
    if (!addresses.length) return [];
    const result = await rpc('getMultipleAccounts', [
      addresses, { encoding: 'base64', commitment: COMMITMENT },
    ]);
    return (result && result.value) || [];
  }

  /** Like getAccounts, but keeps the response's slot — needed when a read is
   * about to SEED price state (a seeded amount without its slot would defeat
   * the per-leg ordering guard the moment live frames arrive). */
  async function getAccountsWithSlot(addresses) {
    if (!addresses.length) return { slot: 0, accounts: [] };
    const result = await rpc('getMultipleAccounts', [
      addresses, { encoding: 'base64', commitment: COMMITMENT },
    ]);
    return {
      slot: Number(result && result.context && result.context.slot) || 0,
      accounts: (result && result.value) || [],
    };
  }

  /* ---------------- pool resolution ---------------- */

  /**
   * Inspect a pool account once to learn how it must be decoded and which
   * accounts have to be watched for live price.
   */
  async function describePool(poolAddress, mint) {
    const [account] = await getAccounts([poolAddress]);
    if (!account) return null;

    const kind = O.poolKindForOwner(account.owner);
    if (!kind) return null; // no verified layout -> no on-chain quote

    const bytes = O.bytesFromBase64(account.data[0]);
    if (kind === 'whirlpool' || kind === 'clmm') {
      const pool = O.decodeWhirlpool(bytes);
      if (!pool) return null;
      const decimals = await mintDecimals([pool.mintA, pool.mintB]);
      if (decimals[pool.mintA] == null || decimals[pool.mintB] == null) return null;
      return { kind, watch: poolAddress, pool, decimals, mint };
    }
    if (kind === 'pump-curve') {
      // Every pump.fun mint has exactly 6 decimals — a rule of the program,
      // verified live (the constant already prices curves in onchain.js).
      // Fetching a protocol constant over RPC cost the sniping path a full
      // round trip on the keyless public pool (measured live: ~700ms of a
      // 3.7s first quote on a 48-second-old coin).
      return { kind, watch: poolAddress, decimals: { [mint]: O.PUMP_TOKEN_DECIMALS }, mint };
    }
    // Constant product: the price lives in the two vaults, so those are what
    // must be watched, not the pool header. The decimals map is required to
    // turn vault balances into a price — omitting it crashed priceFromEntry
    // on the first vault update (issue #17: sell options disappeared because
    // the dead price stream starved the overlay).
    const vaults = await findVaults(bytes, mint, poolAddress);
    if (!vaults) return null;
    // Both the token and WSOL decimals are needed to turn vault balances into
    // a price — fetch them here so priceFromEntry never sees a gap.
    const decimals = await mintDecimals([mint, O.WSOL_MINT]);
    if (decimals[mint] == null || decimals[O.WSOL_MINT] == null) return null;
    return { kind, watch: vaults.base, watchQuote: vaults.quote, vaults, decimals, mint };
  }

  const decimalsCache = new Map();

  async function mintDecimals(mints) {
    const out = {};
    const missing = [];
    for (const m of mints) {
      if (decimalsCache.has(m)) out[m] = decimalsCache.get(m);
      else missing.push(m);
    }
    if (missing.length) {
      const accounts = await getAccounts(missing);
      accounts.forEach((account, i) => {
        if (!account) return;
        const info = O.decodeMint(O.bytesFromBase64(account.data[0]));
        if (info) {
          decimalsCache.set(missing[i], info.decimals);
          out[missing[i]] = info.decimals;
        }
      });
    }
    return out;
  }

  /**
   * Locate a constant-product pool's two vaults by scanning the pool account
   * for embedded pubkeys and keeping the largest token account per mint.
   * Layouts differ per program; the vaults themselves are always plain SPL
   * token accounts, which is what makes this reliable.
   */
  // Session cache: re-visiting a coin must not re-derive its vaults — the
  // scan below is the single most RPC-expensive thing the feed does, and a
  // trader flipping through ten coins a minute used to exhaust the keyless
  // pool budget on it alone (DEFECT F-09).
  const vaultCache = new Map(); // poolAddress -> { base, quote }
  const VAULT_CACHE_CAP = 100;

  async function findVaults(poolBytes, mint, poolAddress) {
    if (!poolBytes) return null;
    if (poolAddress && vaultCache.has(poolAddress)) return vaultCache.get(poolAddress);

    const scan = async (step) => {
      const candidates = [];
      const seen = new Set();
      for (let offset = 0; offset + 32 <= poolBytes.length; offset += step) {
        const key = O.readPubkey(poolBytes, offset);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(key);
      }
      let base = null;
      let quote = null;
      for (let i = 0; i < candidates.length; i += 100) {
        const chunk = candidates.slice(i, i + 100);
        const accounts = await getAccounts(chunk);
        accounts.forEach((account, index) => {
          if (!account) return;
          if (account.owner !== O.TOKEN_PROGRAM && account.owner !== O.TOKEN_2022_PROGRAM) return;
          const decoded = O.decodeTokenAccount(O.bytesFromBase64(account.data[0]));
          if (!decoded) return;
          const address = chunk[index];
          if (decoded.mint === mint && (!base || decoded.amount > base.amount)) {
            base = { address, amount: decoded.amount };
          } else if (decoded.mint === O.WSOL_MINT && (!quote || decoded.amount > quote.amount)) {
            quote = { address, amount: decoded.amount };
          }
        });
      }
      return base && quote ? { base: base.address, quote: quote.address } : null;
    };

    // Pass 1: 8-byte-aligned offsets. Anchor structs and Raydium v4 both
    // align pubkeys to 8 bytes, so this finds the vaults with ~8x fewer
    // candidates — one getAccounts round trip instead of eight to fifteen
    // (DEFECT F-09). Pass 2 keeps the exhaustive scan as a fallback for
    // exotic byte-packed layouts, bounded to small pool accounts so the
    // worst case stays cheap.
    let found = await scan(8);
    if (!found && poolBytes.length <= 1024) found = await scan(1);

    if (found && poolAddress) {
      vaultCache.set(poolAddress, found);
      if (vaultCache.size > VAULT_CACHE_CAP) {
        vaultCache.delete(vaultCache.keys().next().value);
      }
    }
    return found;
  }

  /* ---------------- pricing ---------------- */

  function priceFromEntry(entry) {
    if (!entry || !entry.desc) return null;
    const d = entry.desc;
    // A malformed or partial desc must yield "no price yet", never a throw:
    // a throw inside the socket handler kills live prices for every token.
    if (!d.decimals || d.decimals[d.mint] == null) return null;
    if (d.kind === 'whirlpool' || d.kind === 'clmm') {
      if (!entry.raw) return null;
      const pool = O.decodeWhirlpool(entry.raw);
      return O.priceFromSqrtPrice(pool, d.mint, d.decimals);
    }
    if (d.kind === 'pump-curve') {
      if (!entry.raw) return null;
      const curve = O.decodePumpCurve(entry.raw);
      if (!curve || curve.complete) return null; // migrated: price the AMM pool
      return O.priceFromPumpCurve(curve, d.decimals[d.mint]);
    }
    if (entry.baseAmount == null || entry.quoteAmount == null) return null;
    return O.priceFromVaults(
      entry.baseAmount, d.decimals[d.mint],
      entry.quoteAmount, d.decimals[O.WSOL_MINT]
    );
  }

  /* ---------------- socket ---------------- */

  function ensureSocket() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return socket;

    const candidates = POOL.websocketUrls();
    if (!candidates.length) return null;
    // Walk the ranked list rather than hammering one endpoint. A public node
    // that streams fine one minute can go quiet the next.
    const candidate = candidates[wsIndex % candidates.length];
    activeWsId = candidate.id;

    socket = new WebSocket(candidate.url);
    socket.onopen = () => {
      reconnectAttempt = 0;
      POOL.reportSuccess(candidate.id, null);
      for (const mint of watched.keys()) subscribe(mint);
    };
    socket.onmessage = (event) => handleMessageSafe(event.data);
    socket.onclose = () => {
      socket = null;
      subToMint.clear();
      for (const entry of watched.values()) entry.subIds = [];
      scheduleReconnect();
    };
    socket.onerror = () => {
      POOL.reportFailure(candidate.id);
      // Advance so the next attempt tries a different provider.
      wsIndex += 1;
      try { socket.close(); } catch (_) {}
    };
    return socket;
  }

  function scheduleReconnect() {
    if (reconnectTimer || !watched.size) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt++), RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureSocket(); }, delay);
  }

  function send(payload) {
    const ws = ensureSocket();
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(payload)); return true; }
    return false;
  }

  function subscribe(mint) {
    const entry = watched.get(mint);
    if (!entry || !entry.desc) return;
    for (const account of accountsToWatch(entry.desc)) {
      const id = nextRequestId++;
      // Register the pending ack only when the frame actually went out. The
      // first subscribe after every connect used to land on a CONNECTING
      // socket: send() returned false, the entry stayed orphaned forever, and
      // the map grew without bound across a long session (DEFECT F-21).
      // onopen re-subscribes everything, so a dropped frame loses nothing.
      const sent = send({
        jsonrpc: '2.0', id, method: 'accountSubscribe',
        params: [account, { encoding: 'base64', commitment: COMMITMENT }],
      });
      if (sent) pending.set(id, { mint, account });
    }
  }

  function accountsToWatch(desc) {
    return desc.watchQuote ? [desc.watch, desc.watchQuote] : [desc.watch];
  }

  function handleMessage(data) {
    let message;
    try { message = JSON.parse(data); } catch (_) { return; }

    // Subscription acknowledgement.
    if (message.id != null && pending.has(message.id)) {
      const info = pending.get(message.id);
      pending.delete(message.id);
      if (typeof message.result === 'number') {
        subToMint.set(message.result, info);
        const entry = watched.get(info.mint);
        if (entry) entry.subIds = (entry.subIds || []).concat(message.result);
      }
      return;
    }

    if (message.method !== 'accountNotification') return;
    const params = message.params || {};
    const info = subToMint.get(params.subscription);
    if (!info) return;

    const result = params.result || {};
    const slot = result.context && result.context.slot;
    const value = result.value;
    if (!value || !value.data) return;

    const entry = watched.get(info.mint);
    if (!entry) return;

    const bytes = O.bytesFromBase64(value.data[0]);
    const desc = entry.desc;

    if (desc.kind === 'cp-vaults') {
      // A trade moves BOTH vaults in the SAME slot, and they arrive as two
      // separate notifications. The out-of-order guard is therefore
      // per-vault, never per-entry: a shared entry.slot accepted whichever
      // leg landed first and then dropped its sibling as "old", so one vault
      // tracked every trade while the other stayed frozen at its last lucky
      // first-arrival — and the price walked away from the chart by the full
      // drift between them (reported at ~13% low on a fast Padre runner,
      // filling paper buys with instant fake profit).
      if (!(slot > 0)) return;
      const legKey = info.account === desc.watch ? 'baseSlot' : 'quoteSlot';
      if (entry[legKey] > 0 && slot < entry[legKey]) return;
      const decoded = O.decodeTokenAccount(bytes);
      if (!decoded) return;
      if (info.account === desc.watch) entry.baseAmount = decoded.amount;
      else entry.quoteAmount = decoded.amount;
      entry[legKey] = slot;
    } else {
      // Single-account pools: out-of-order frames must never overwrite
      // fresher state.
      if (!O.isNewerObservation(slot, entry.slot)) return;
      entry.raw = bytes;
    }

    const priceNative = priceFromEntry(entry);
    if (!(priceNative > 0)) return;

    entry.slot = Math.max(Number(entry.slot) || 0, slot);
    entry.priceNative = priceNative;
    entry.observedAt = Date.now();

    emit({
      mint: info.mint,
      priceNative,
      slot,
      source: 'onchain',
      poolKind: desc.kind,
      observedAt: entry.observedAt,
    });
  }

  /**
   * One malformed or hostile frame must never kill the stream. handleMessage
   * runs inside the WebSocket onmessage path, so an uncaught throw there
   * silently ends every live price in the session (issue #17). Isolate it.
   */
  function handleMessageSafe(data) {
    try { handleMessage(data); } catch (_) { /* drop the frame, keep the feed */ }
  }

  /* ---------------- pre-index prewatch (the sniping case) ----------------
   *
   * A brand-new coin has no aggregator quote for its first minutes, but its
   * market is ALREADY on chain. prewatch turns whatever single address the
   * page has — a pump bonding curve, any pool with a verified decoder, or
   * the bare mint — into the best instant answer that address supports:
   *
   *   pool with a verified decoder -> live watched feed + IMMEDIATE quote
   *   plain mint account           -> measured supply + decimals, which is
   *                                   what lets bootstrapTick price the
   *                                   page's own mcap feed for launchpads
   *                                   with no derivable pool (letsbonk,
   *                                   Believe, Moonshot, ...)
   *
   * The address is classified by its account OWNER, never by the page's
   * kind label — F-45 established that a site's URL slot can carry a pool
   * where the adapter says mint, and the chain's answer costs one read.
   *
   * Refusals are as important as the path itself: a completed (migrated)
   * curve, a pool without a WSOL side, an account that is neither a known
   * pool nor a plain mint — all return null, and the caller falls back to
   * the aggregator path rather than guessing.
   */

  /** The mint held by a curve's reserve token account (largest balance wins;
   * the curve's only token account IS the reserve). */
  async function curveMint(poolAddress) {
    for (const program of [O.TOKEN_PROGRAM, O.TOKEN_2022_PROGRAM]) {
      let result = null;
      try {
        result = await rpc('getTokenAccountsByOwner', [
          poolAddress, { programId: program },
          { encoding: 'jsonParsed', commitment: COMMITMENT },
        ]);
      } catch (_) { result = null; }
      const accounts = (result && result.value) || [];
      let best = null;
      for (const entry of accounts) {
        const info = entry && entry.account && entry.account.data
          && entry.account.data.parsed && entry.account.data.parsed.info;
        const mint = info && info.mint;
        const amount = Number(info && info.tokenAmount && info.tokenAmount.amount) || 0;
        if (typeof mint === 'string' && (!best || amount > best.amount)) {
          best = { mint, amount, reserveAccount: entry.pubkey };
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Seed a freshly-watched pool of ANY decodable kind with a price read
   * RIGHT NOW, so the first quote exists before the first post-watch trade
   * lands. Mirrors handleMessage's state rules exactly — including the
   * per-leg slot guard for vault pairs — so a socket frame racing the prime
   * can never be overwritten by older state. */
  async function primeEntry(mint) {
    const entry = watched.get(mint);
    if (!entry || !entry.desc) return null;
    const desc = entry.desc;
    const { slot, accounts } = await getAccountsWithSlot(accountsToWatch(desc));
    if (!(slot > 0)) return null;

    if (desc.kind === 'cp-vaults') {
      const base = accounts[0] && O.decodeTokenAccount(O.bytesFromBase64(accounts[0].data[0]));
      const quote = accounts[1] && O.decodeTokenAccount(O.bytesFromBase64(accounts[1].data[0]));
      if (!base || !quote) return null;
      if (!(entry.baseSlot > slot)) { entry.baseAmount = base.amount; entry.baseSlot = slot; }
      if (!(entry.quoteSlot > slot)) { entry.quoteAmount = quote.amount; entry.quoteSlot = slot; }
    } else {
      const account = accounts[0];
      if (!account) return null;
      if (!O.isNewerObservation(slot, entry.slot)) return currentQuote(mint);
      entry.raw = O.bytesFromBase64(account.data[0]);
    }

    const priceNative = priceFromEntry(entry);
    if (!(priceNative > 0)) return null; // malformed, or an already-complete curve
    entry.slot = Math.max(Number(entry.slot) || 0, slot);
    entry.priceNative = priceNative;
    entry.observedAt = Date.now();
    const quote = {
      mint, priceNative, slot,
      source: 'onchain', poolKind: desc.kind, observedAt: entry.observedAt,
    };
    emit(quote);
    return quote;
  }

  /** The non-WSOL side of a SOL-quoted whirlpool/CLMM, or null. A pool
   * between two non-SOL tokens is refused — nothing says which side the
   * page is charting. */
  function whirlpoolTokenMint(pool) {
    if (!pool) return null;
    if (pool.mintA === O.WSOL_MINT) return pool.mintB;
    if (pool.mintB === O.WSOL_MINT) return pool.mintA;
    return null;
  }

  /**
   * Identify which mint a constant-product pool trades against SOL, from the
   * pool bytes alone (the caller knows only the pool address). Same scan as
   * findVaults and the same largest-balance rule curveMint uses: embedded
   * pubkeys -> plain SPL token accounts -> the largest WSOL holder proves
   * the pool is SOL-quoted, the largest non-WSOL holder names the token.
   * No WSOL side -> null, refused rather than guessed.
   */
  async function discoverPoolMint(poolBytes) {
    if (!poolBytes) return null;
    const scan = async (step) => {
      const candidates = [];
      const seen = new Set();
      for (let offset = 0; offset + 32 <= poolBytes.length; offset += step) {
        const key = O.readPubkey(poolBytes, offset);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(key);
      }
      let base = null;
      let quote = null;
      for (let i = 0; i < candidates.length; i += 100) {
        const chunk = candidates.slice(i, i + 100);
        const accounts = await getAccounts(chunk);
        accounts.forEach((account, index) => {
          if (!account) return;
          if (account.owner !== O.TOKEN_PROGRAM && account.owner !== O.TOKEN_2022_PROGRAM) return;
          const decoded = O.decodeTokenAccount(O.bytesFromBase64(account.data[0]));
          if (!decoded) return;
          if (decoded.mint === O.WSOL_MINT) {
            if (!quote || decoded.amount > quote.amount) quote = decoded;
          } else if (!base || decoded.amount > base.amount) {
            base = { mint: decoded.mint, amount: decoded.amount, address: chunk[index] };
          }
        });
      }
      return base && quote ? base.mint : null;
    };
    let found = await scan(8);
    if (!found && poolBytes.length <= 1024) found = await scan(1);
    return found;
  }

  /**
   * SPL mint layouts only: a classic mint account is EXACTLY 82 bytes, and a
   * token-2022 mint with extensions declares AccountType::Mint (1) at offset
   * 165. A 165-byte token ACCOUNT would sail through decodeMint's length
   * check and yield garbage supply — and a wrong supply becomes a wrong fill
   * price, so ambiguity here is refused, not tolerated.
   */
  function mintFactsFromAccount(account, address) {
    if (!account) return null;
    if (account.owner !== O.TOKEN_PROGRAM && account.owner !== O.TOKEN_2022_PROGRAM) return null;
    const bytes = O.bytesFromBase64(account.data[0]);
    if (!bytes) return null;
    const isMintLayout = bytes.length === 82
      || (bytes.length > 165 && bytes[165] === 1);
    if (!isMintLayout) return null;
    const info = O.decodeMint(bytes);
    if (!info || !(info.supply > 0) || !(info.decimals >= 0)) return null;
    decimalsCache.set(address, info.decimals);
    return {
      mint: address,
      pool: null,
      poolKind: null,
      priceNative: null,
      decimals: info.decimals,
      // Whole tokens — the divisor an mcap reading needs (quote.js
      // bootstrapSupply). u64 supply over up to 9 decimals fits a double
      // with room to spare for any real memecoin.
      supplyUi: info.supply / Math.pow(10, info.decimals),
    };
  }

  /** Watch + prime a pool of any decodable kind. `knownMint` is the page's
   * claim when it has one; it is trusted only where the pool corroborates
   * it. `preread` avoids a second fetch when the caller already holds the
   * pool account (with its read slot, when the caller kept it).
   *
   * Latency is the point of this function — measured live on a 48-second
   * pump launch, the original sequence cost ~3.7s over the keyless public
   * pool: five round trips, two of them re-reading state already in hand
   * and one fetching a protocol constant. Now: single-account pools prime
   * from the FIRST read's bytes+slot (no re-read), and the reserve-account
   * scan runs in the background when the page already named the mint —
   * the rug guard reads reserveAccounts() lazily and tolerates it landing
   * a beat later. */
  async function prewatchPool(poolAddress, knownMint, preread, prereadSlot) {
    let account = preread || null;
    let readSlot = Number(prereadSlot) || 0;
    if (!account) {
      const { slot, accounts } = await getAccountsWithSlot([poolAddress]);
      account = accounts[0];
      readSlot = slot;
    }
    if (!account) return null;
    const kind = O.poolKindForOwner(account.owner);
    if (!kind) return null;
    const bytes = O.bytesFromBase64(account.data[0]);

    let realMint = knownMint || null;
    let reserveLater = null;

    if (kind === 'pump-curve') {
      const curve = O.decodePumpCurve(bytes);
      if (!curve || curve.complete) return null; // migrated: the resolver path owns it
      // The reserve token account identifies the mint when only the pool was
      // known, and the rug guard must exclude it from holder concentration.
      // When the page already named the mint, the scan need not block the
      // first quote.
      if (realMint) {
        reserveLater = curveMint(poolAddress).catch(() => null);
      } else {
        const found = await curveMint(poolAddress);
        reserveLater = Promise.resolve(found);
        realMint = (found && found.mint) || null;
      }
    } else if (kind === 'whirlpool' || kind === 'clmm') {
      const decoded = O.decodeWhirlpool(bytes);
      if (!decoded) return null;
      if (realMint && realMint !== decoded.mintA && realMint !== decoded.mintB) return null;
      realMint = realMint || whirlpoolTokenMint(decoded);
    } else {
      realMint = realMint || (await discoverPoolMint(bytes));
    }
    if (!realMint) return null;

    const live = await watch(realMint, poolAddress);
    if (!live) return null;
    const entry = watched.get(realMint);
    if (entry && reserveLater) {
      reserveLater.then((found) => {
        if (found && found.reserveAccount && entry.desc) entry.desc.reserveAccount = found.reserveAccount;
      }).catch(() => {});
    }

    // Prime from the read this function already made. Single-account pools
    // (curve, whirlpool/CLMM) carry their whole price in the bytes in hand;
    // only vault pairs still need primeEntry's own read. Same slot guards as
    // the socket path — a frame that raced us is never overwritten by older
    // state.
    let quote = null;
    if (entry && kind !== 'cp-vaults' && readSlot > 0 && O.isNewerObservation(readSlot, entry.slot)) {
      entry.raw = bytes;
      const priceNative = priceFromEntry(entry);
      if (priceNative > 0) {
        entry.slot = readSlot;
        entry.priceNative = priceNative;
        entry.observedAt = Date.now();
        quote = {
          mint: realMint, priceNative, slot: readSlot,
          source: 'onchain', poolKind: kind, observedAt: entry.observedAt,
        };
        emit(quote);
      }
    }
    if (!quote) quote = await primeEntry(realMint);
    return {
      mint: realMint,
      pool: poolAddress,
      poolKind: kind,
      priceNative: quote ? quote.priceNative : null,
    };
  }

  /** A plausible base58 account address. Local to the feed so the module
   * stays standalone (background.js has its own copy for message validation). */
  function isAddress(s) {
    return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  }

  /**
   * The PumpSwap pool a graduated pump.fun coin trades in, or null.
   *
   * A completed bonding curve stops carrying a price — that is what
   * graduation MEANS — so `prewatchPool` refuses it and the coin used to fall
   * through to the mint-facts path, which yields supply and identity but no
   * price. On a just-migrated coin no aggregator has indexed the new pool
   * yet either, so the panel sat on "Fetching live price…" for the exact
   * minutes the coin was most tradable (cheng.4848 2026-08-24 "difficult to
   * make purchases in time after the currency migration"; ark_trades13
   * "only on migrated tokens").
   *
   * getProgramAccounts filtered on the base-mint offset is the authoritative
   * lookup — it asks the chain which pool holds this coin rather than
   * guessing a PDA whose seeds (creator, index) we do not know. The filter is
   * an indexed memcmp on a single program, so it is cheap.
   *
   * Only a WSOL-quoted pool is usable: the whole feed prices in SOL, and a
   * USDC-quoted pool would silently be a different unit. Where several
   * qualify, the deepest one wins — that is the pool the router fills
   * against, and a dust pool would quote a price nobody can trade.
   */
  async function findGraduatedPool(mint) {
    if (!O || !isAddress(mint)) return null;
    let found;
    try {
      found = await rpc('getProgramAccounts', [O.PUMP_AMM_PROGRAM, {
        encoding: 'base64',
        commitment: COMMITMENT,
        filters: [{ memcmp: { offset: O.PUMPSWAP_BASE_MINT, bytes: mint } }],
      }]);
    } catch (_) { return null; }
    // Some providers answer gPA with the payload stripped; re-read by address
    // rather than trusting a shape we did not get.
    const entries = Array.isArray(found) ? found : (found && found.value) || [];
    if (!entries.length) return null;
    const addresses = entries.map((e) => e && e.pubkey).filter(isAddress).slice(0, 12);
    if (!addresses.length) return null;

    const accounts = await getAccounts(addresses);
    const candidates = [];
    for (let i = 0; i < addresses.length; i++) {
      const account = accounts[i];
      if (!account || O.poolKindForOwner(account.owner) !== 'cp-vaults') continue;
      const decoded = O.decodePumpSwapPool(O.bytesFromBase64(account.data[0]));
      if (!decoded) continue;
      if (decoded.baseMint !== mint) continue;
      if (decoded.quoteMint !== O.WSOL_MINT) continue;
      candidates.push({ pool: addresses[i], decoded });
    }
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].pool;

    // Depth decides. One read for every quote vault at once.
    const vaults = await getAccounts(candidates.map((c) => c.decoded.quoteVault));
    let best = null;
    for (let i = 0; i < candidates.length; i++) {
      const account = vaults[i];
      if (!account) continue;
      const token = O.decodeTokenAccount(O.bytesFromBase64(account.data[0]));
      if (!token || !(token.amount > 0)) continue;
      if (!best || token.amount > best.amount) best = { pool: candidates[i].pool, amount: token.amount };
    }
    return best ? best.pool : candidates[0].pool;
  }

  /**
   * Turn whichever single address the page has into the best instant answer
   * it supports. Returns { mint, pool, poolKind, priceNative } for a live
   * watched pool, { mint, supplyUi, decimals } for a bare mint account, or
   * null (nothing on chain answers for this address yet).
   */
  async function prewatch({ pool, mint }) {
    if (!O || !POOL) return null;
    try {
      // Which address (if any) has already paid for the heavy PumpSwap
      // program scan on this lookup, so it is never run twice.
      let scannedFor = null;
      // A pump-suffixed mint: the derived curve is the strongest answer (a
      // live PRICE, not just supply facts), so try it first.
      if (!pool && typeof mint === 'string' && /pump$/.test(mint)) {
        const curveAddress = await O.derivePumpCurve(mint);
        if (curveAddress) {
          const found = await prewatchPool(curveAddress, mint);
          if (found) return found;
        }
        // Not a live curve (migrated, or a non-pump.fun coin that merely
        // ends in "pump"). A GRADUATED coin still has a real, priceable pool
        // — the PumpSwap AMM it migrated into — and that pool is exactly
        // where the volume is in the minutes after migration. Ask the chain
        // for it rather than waiting on an aggregator to index it.
        scannedFor = mint;
        const graduated = await findGraduatedPool(mint);
        if (graduated) {
          const found = await prewatchPool(graduated, mint);
          if (found) return found;
        }
        // Still nothing priceable — the mint account may hold supply facts.
      }

      const address = pool || mint;
      if (!address) return null;
      const { slot, accounts } = await getAccountsWithSlot([address]);
      const account = accounts[0];
      if (!account) return null;

      // The chain's classification, not the page's kind label (F-45).
      if (O.poolKindForOwner(account.owner)) {
        const hint = typeof mint === 'string' && mint !== address ? mint : null;
        return await prewatchPool(address, hint, account, slot);
      }
      const facts = mintFactsFromAccount(account, address);
      if (facts) {
        // The address IS a mint, and no curve answered for it — either it
        // never had one, or it graduated. A PumpSwap pool holding this mint
        // is a live price; supply facts alone are not. Worth one lookup
        // before settling for the weaker answer, and this is the path
        // non-"pump"-suffixed launchpads (Bags, Believe, moonshot) take.
        //
        // A pump-suffixed mint may already have paid for this scan in the
        // branch above; `getProgramAccounts` is the heaviest read the module
        // makes and the public endpoint is keyless, so never run it twice
        // for one lookup.
        const graduated = scannedFor === address ? null : await findGraduatedPool(address);
        if (graduated) {
          const found = await prewatchPool(graduated, address);
          if (found) return found;
        }
        return facts;
      }

      // A pool whose owner program has NO verified decoder (a launchpad we
      // have not verified — LaunchLab, DBC, whatever ships next week) used
      // to be a dead end: no price, and no MINT either, so a pair-address
      // page (Axiom /meme/) could not even take the supply-facts bootstrap
      // path — a wait-state lasting over a minute on exactly the
      // fresh low-liq launches scalpers care about (Coja, Discord). The
      // WSOL-anchored vault scan needs no pool layout at all: the vaults
      // are plain SPL token accounts embedded in the pool bytes. So an
      // unknown pool still yields IDENTITY and measured supply — protocol
      // facts — while its PRICE stays refused: bonding curves price on
      // VIRTUAL reserves (onchain.js's own warning), so a vault ratio from
      // an unverified layout would be exactly the invented number this
      // product never shows. The page's own feed prices the coin through
      // bootstrapTick's sane-band discipline instead.
      const bytes = O.bytesFromBase64(account.data[0]);
      const discovered = await discoverPoolMint(bytes);
      if (!discovered) return null;
      const [mintAccount] = await getAccounts([discovered]);
      const mintFacts = mintFactsFromAccount(mintAccount, discovered);
      if (!mintFacts) return null;
      return {
        mint: discovered,
        pool: address,
        poolKind: null, // known pool location, UNKNOWN layout: never watched, never priced
        priceNative: null,
        decimals: mintFacts.decimals,
        supplyUi: mintFacts.supplyUi,
      };
    } catch (error) {
      try { console.debug('PaperTrench: prewatch failed:', error && error.message); } catch (_) {}
      return null;
    }
  }

  /** The known pool/curve reserve token accounts for a watched mint — the
   * holders that are LIQUIDITY, not people (used by the rug guard). */
  function reserveAccounts(mint) {
    const entry = watched.get(mint);
    if (!entry || !entry.desc) return [];
    const desc = entry.desc;
    const out = [];
    if (desc.reserveAccount) out.push(desc.reserveAccount);
    if (desc.kind === 'cp-vaults' && desc.watch) out.push(desc.watch);
    return out;
  }

  /* ---------------- public API ---------------- */

  /** Begin streaming live on-chain prices for `mint` via `poolAddress`. */
  async function watch(mint, poolAddress) {
    if (!mint || !poolAddress) return false;
    if (!O || !POOL) return false;
    const existing = watched.get(mint);
    if (existing && existing.desc && existing.desc.watch) return true;

    // A thrown error here means a real fault (missing dependency, RPC down),
    // not "unsupported pool". Swallowing it silently is what let a dead feed
    // ship looking exactly like a pool we simply cannot decode.
    let desc = null;
    try {
      desc = await describePool(poolAddress, mint);
    } catch (error) {
      try { console.error('PaperTrench: on-chain watch failed:', error && error.message); } catch (_) {}
      return false;
    }
    if (!desc) return false;

    watched.set(mint, { desc, slot: 0, subIds: [] });
    ensureSocket();
    subscribe(mint);
    return true;
  }

  /** Stop streaming a mint and release its subscriptions. */
  function unwatch(mint) {
    const entry = watched.get(mint);
    if (!entry) return;
    for (const subId of entry.subIds || []) {
      send({ jsonrpc: '2.0', id: nextRequestId++, method: 'accountUnsubscribe', params: [subId] });
      subToMint.delete(subId);
    }
    watched.delete(mint);
    if (!watched.size && socket) { try { socket.close(); } catch (_) {} socket = null; }
  }

  /** The newest on-chain quote for a mint, or null if none is fresh enough. */
  function currentQuote(mint) {
    const entry = watched.get(mint);
    if (!entry || !(entry.priceNative > 0)) return null;
    if (Date.now() - entry.observedAt > QUOTE_STALE_MS) return null;
    return {
      mint,
      priceNative: entry.priceNative,
      slot: entry.slot,
      source: 'onchain',
      poolKind: entry.desc.kind,
      observedAt: entry.observedAt,
    };
  }

  function isLive(mint) { return Boolean(currentQuote(mint)); }

  /** Which provider is currently streaming, for status display. */
  function activeEndpoint() { return activeWsId; }

  const api = {
    configure, watch, unwatch, currentQuote, isLive, onQuote, activeEndpoint,
    prewatch, reserveAccounts,
    QUOTE_STALE_MS, COMMITMENT,
    // Exposed for tests.
    _describePool: describePool,
    _handleMessage: handleMessage,
    _watched: watched,
    _subToMint: subToMint,
    _priceFromEntry: priceFromEntry,
    _mintFactsFromAccount: mintFactsFromAccount,
    _discoverPoolMint: discoverPoolMint,
    _primeEntry: primeEntry,
    _findGraduatedPool: findGraduatedPool,
  };

  if (typeof self !== 'undefined') self.PTOnchainFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
