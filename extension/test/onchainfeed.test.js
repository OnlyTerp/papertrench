/* On-chain feed robustness — issue #17.
 *
 * A user reported the sell options disappearing mid-session with a console
 * trace at onchain-feed.js:206: `Cannot read properties of undefined
 * (reading '<mint>')`. Root cause: the constant-product (cp-vaults) branch
 * of describePool returned a desc with NO decimals map, so the first vault
 * update crashed priceFromEntry. That throw ran inside the WebSocket
 * onmessage handler and silently ended live prices for every watched token —
 * starving the overlay until sell looked broken.
 *
 * Three fixes, three pinned behaviors:
 *   1. cp-vaults descs carry a full decimals map (token + WSOL).
 *   2. priceFromEntry returns null on a partial desc instead of throwing.
 *   3. The socket handler is isolated: one bad frame cannot kill the feed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// The feed resolves PTOnchain/PTRpcPool from globals or require(). Requiring
// it in Node pulls in the real onchain.js and rpc-pool.js modules, so these
// tests run the production decoders, not mocks.
const Feed = require('../onchain-feed.js');

test('a cp-vaults desc without a decimals map yields null price, never a throw (issue #17)', () => {
  // This is the exact shape that crashed in production: desc.kind is
  // cp-vaults, entry has vault amounts, but desc.decimals is undefined.
  const entry = {
    desc: { kind: 'cp-vaults', watch: 'baseVault', watchQuote: 'quoteVault', mint: 'SOMEmint11111111111111111111111111111111' },
    baseAmount: 1000000,
    quoteAmount: 5000000000,
  };

  let price;
  assert.doesNotThrow(() => { price = Feed._priceFromEntry(entry); },
    'a malformed desc must not throw inside the price path');
  assert.equal(price, null, 'no decimals -> no price, not a crash');
});

test('priceFromEntry tolerates a decimals map missing the WSOL entry', () => {
  const entry = {
    desc: { kind: 'cp-vaults', watch: 'b', watchQuote: 'q', mint: 'TokMint11111111111111111111111111111111111', decimals: { TokMint11111111111111111111111111111111111: 6 } },
    baseAmount: 1000000,
    quoteAmount: 5000000000,
  };

  let price;
  assert.doesNotThrow(() => { price = Feed._priceFromEntry(entry); });
  assert.equal(price, null, 'missing WSOL decimals -> null, not NaN/crash');
});

test('the cp-vaults branch of describePool must attach a decimals map', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  const cp = src.slice(src.indexOf('Constant product:'), src.indexOf('decimalsCache'));
  assert.ok(cp.length > 0, 'the cp-vaults branch of describePool must be locatable');
  // The returned desc object for the vaults branch must include decimals.
  assert.match(cp, /watchQuote: vaults\.quote, vaults, decimals, mint/,
    'cp-vaults desc must carry the decimals map');
  // And it must fetch both mints: the token and WSOL.
  assert.match(cp, /mintDecimals\(\[mint, O\.WSOL_MINT\]\)/,
    'vault pricing needs the token AND WSOL decimals');
});

test('one hostile frame must not kill the live-price stream', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  // The onmessage path must go through the isolated wrapper, never the raw
  // handler: an uncaught throw there silently ends every live price.
  assert.match(src, /socket\.onmessage = \(event\) => handleMessageSafe\(event\.data\)/,
    'the WebSocket handler must be crash-isolated');
  assert.match(src, /function handleMessageSafe\(data\) \{\s*try \{ handleMessage\(data\); \}/,
    'handleMessageSafe must wrap handleMessage in try/catch');
});

/* ---------------- DEFECTS F-09 / F-21: RPC amplification ---------------- */

test("F-09: vault discovery is cached per pool and scans aligned offsets first", () => {
  const src = fs.readFileSync(path.join(ROOT, "onchain-feed.js"), "utf8");
  const fnStart = src.indexOf("async function findVaults(");
  assert.ok(fnStart !== -1);
  const block = src.slice(fnStart, src.indexOf("\n  }", fnStart) + 4);

  assert.match(block, /vaultCache\.has\(poolAddress\)/,
    "revisiting a coin must not re-derive its vaults (the scan is the most RPC-expensive call in the feed)");
  assert.match(block, /await scan\(8\)/,
    "the first pass must scan 8-byte-aligned offsets — one round trip instead of eight to fifteen");
  assert.match(block, /poolBytes\.length <= 1024[\s\S]*?scan\(1\)/,
    "the exhaustive fallback must be bounded to small pool accounts");
  // The caller must actually pass the pool address or the cache never hits.
  assert.match(src, /findVaults\(bytes, mint, poolAddress\)/,
    "describePool must key the vault cache by pool address");
});

test("F-21: a subscribe on a cold socket must not orphan a pending entry", () => {
  const src = fs.readFileSync(path.join(ROOT, "onchain-feed.js"), "utf8");
  const fnStart = src.indexOf("function subscribe(");
  const block = src.slice(fnStart, src.indexOf("\n  }", fnStart) + 4);
  assert.match(block, /const sent = send\(/,
    "the send result must be observed");
  assert.match(block, /if \(sent\) pending\.set\(/,
    "pending acks are registered only for frames that actually went out — onopen resubscribes the rest");
  assert.doesNotMatch(block, /pending\.set\([\s\S]*?send\(\{/,
    "the old set-before-send order must be gone");
});

/* ---------------- F-33: per-vault slot guard (lev, stale Padre fills) ----
 *
 * A swap moves BOTH vaults of a constant-product pool in the SAME slot, and
 * the RPC delivers them as two separate accountNotifications carrying that
 * same slot. The old guard compared each frame against one shared entry.slot,
 * so the first leg of every trade was accepted and its sibling was dropped as
 * out-of-order. Whichever vault kept losing the race stayed frozen at its
 * last first-arrival while the other tracked every trade — the computed
 * price walked away from the chart by the whole drift between them. Reported
 * from a live Padre session as paper buys filling ~13% below the on-screen
 * chart with instant fake profit.
 */

const Onchain = require('../onchain.js');

function tokenAccountB64(amount) {
  // 165-byte SPL token account: mint pubkey at 0 (zeroed — decoder tolerates
  // it), u64 LE amount at 64.
  const bytes = Buffer.alloc(165);
  bytes.writeBigUInt64LE(BigInt(amount), 64);
  return bytes.toString('base64');
}

function vaultNotification(subscription, slot, amount) {
  return JSON.stringify({
    method: 'accountNotification',
    params: {
      subscription,
      result: { context: { slot }, value: { data: [tokenAccountB64(amount)] } },
    },
  });
}

function seedCpPool(mint) {
  Feed._watched.set(mint, {
    desc: {
      kind: 'cp-vaults', watch: 'BASEVAULT', watchQuote: 'QUOTEVAULT', mint,
      decimals: { [mint]: 6, [Onchain.WSOL_MINT]: 9 },
    },
    slot: 0,
    subIds: [901, 902],
  });
  Feed._subToMint.set(901, { mint, account: 'BASEVAULT' });
  Feed._subToMint.set(902, { mint, account: 'QUOTEVAULT' });
}

function cleanupCpPool(mint, off) {
  Feed._watched.delete(mint);
  Feed._subToMint.delete(901);
  Feed._subToMint.delete(902);
  if (off) off();
}

test('F-33: the second vault leg of a same-slot trade must be accepted, not dropped', () => {
  const MINT = 'LevMint111111111111111111111111111111111111';
  const quotes = [];
  const off = Feed.onQuote((q) => { if (q.mint === MINT) quotes.push(q); });
  seedCpPool(MINT);
  try {
    // One swap: both vault frames carry slot 100.
    Feed._handleMessage(vaultNotification(901, 100, 1_000_000_000_000)); // 1M tokens (6dp)
    Feed._handleMessage(vaultNotification(902, 100, 5_000_000_000));     // 5 SOL (9dp)

    // Both legs present -> the price MUST exist and be quote/base.
    const entry = Feed._watched.get(MINT);
    assert.equal(entry.baseAmount, 1_000_000_000_000,
      'the base leg must be recorded');
    assert.equal(entry.quoteAmount, 5_000_000_000,
      'the quote leg of the SAME slot must be recorded — this is the frame the old shared-slot guard dropped');
    assert.ok(quotes.length >= 1, 'a complete vault pair must emit a quote');
    const last = quotes[quotes.length - 1];
    assert.ok(Math.abs(last.priceNative - 5 / 1_000_000) < 1e-12,
      'price must be computed from the same-slot vault PAIR');

    // Next swap, slot 101: the quote leg arrives FIRST this time. Both must
    // land regardless of arrival order.
    Feed._handleMessage(vaultNotification(902, 101, 6_000_000_000));
    Feed._handleMessage(vaultNotification(901, 101, 900_000_000_000));
    assert.ok(Math.abs(entry.priceNative - 6 / 0.9 / 1_000_000) < 1e-12,
      'both legs of the next slot must update the price');

    // A genuinely stale frame (older slot for a leg we already saw) is
    // still refused — per leg.
    Feed._handleMessage(vaultNotification(901, 99, 111));
    assert.equal(entry.baseAmount, 900_000_000_000,
      'an out-of-order frame for a leg must not rewind that leg');

    const fresh = Feed.currentQuote(MINT);
    assert.ok(fresh, 'a just-updated pool must serve a fill-fresh quote');
    assert.ok(Math.abs(fresh.priceNative - 6 / 0.9 / 1_000_000) < 1e-12);
  } finally {
    cleanupCpPool(MINT, off);
  }
});

test('F-33: single-account pools keep the strict newer-slot guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  const fnStart = src.indexOf('function handleMessage(');
  const block = src.slice(fnStart, src.indexOf('\n  }', fnStart) + 4);
  // The per-entry guard must survive for whirlpool/CLMM/pump-curve (one
  // account = one frame per slot), and the cp branch must guard per leg.
  assert.match(block, /isNewerObservation\(slot, entry\.slot\)/,
    'single-account pools still refuse out-of-order frames');
  assert.match(block, /legKey/,
    'cp-vaults frames must be guarded per vault leg, not per entry');
});

/* ---------------- F-34: prewatch — a curve address becomes a live feed -----
 *
 * The sniping case end to end at the feed layer: a bare pool address (all an
 * Axiom /meme/ page knows pre-index) is identified as a live pump curve, its
 * mint is discovered from the reserve token account, the mint is watched,
 * and a first quote is PRIMED from the curve account read itself — no trade
 * needs to land before the first price exists.
 */

const vm2 = require('node:vm');

function feedWithRpc(handler) {
  const sandbox = {
    console, Date, JSON, Math, Number, String, Array, Object, Boolean,
    Promise, Map, Set, URL, TextEncoder, Uint8Array, BigInt, isFinite,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: require('node:crypto').webcrypto,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    WebSocket: function () { this.readyState = 3; },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm2.createContext(sandbox);
  vm2.runInContext(fs.readFileSync(path.join(ROOT, 'onchain.js'), 'utf8'), ctx, { filename: 'onchain.js' });
  sandbox.PTRpcPool = {
    call: handler,
    websocketUrls: () => [],
    setUserEndpoint() {}, reportSuccess() {}, reportFailure() {},
  };
  vm2.runInContext(fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8'), ctx, { filename: 'onchain-feed.js' });
  return sandbox.PTOnchainFeed;
}

function curveAccountB64({ virtualToken, virtualSol, complete }) {
  const bytes = Buffer.alloc(64);
  bytes.writeBigUInt64LE(BigInt(virtualToken), 8);
  bytes.writeBigUInt64LE(BigInt(virtualSol), 16);
  bytes[48] = complete ? 1 : 0;
  return bytes.toString('base64');
}

function mintAccountB64({ supply, decimals }) {
  const bytes = Buffer.alloc(82);
  bytes.writeBigUInt64LE(BigInt(supply), 36);
  bytes[44] = decimals;
  return bytes.toString('base64');
}

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const CURVE_ADDR = 'CurveAddr1111111111111111111111111111111111';
const RESERVE_ADDR = 'ReserveAddr111111111111111111111111111111111';
const FRESH_MINT = 'FreshMint111111111111111111111111111111pump';

test('F-34: prewatch turns a bare curve address into a watched mint with a primed quote', async () => {
  // 30 virtual SOL over 1e9 virtual tokens (6dp) -> price 3e-8 SOL.
  const curveB64 = curveAccountB64({
    virtualToken: 1_000_000_000_000_000, virtualSol: 30_000_000_000, complete: false,
  });
  const rpcLog = [];
  const feed = feedWithRpc(async (method, params) => {
    rpcLog.push(method);
    if (method === 'getMultipleAccounts') {
      const addresses = params[0];
      return {
        context: { slot: 4321 },
        value: addresses.map((address) => {
          if (address === CURVE_ADDR) return { owner: PUMP_PROGRAM_ID, data: [curveB64] };
          if (address === FRESH_MINT) return { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] };
          return null;
        }),
      };
    }
    if (method === 'getTokenAccountsByOwner') {
      return {
        value: [{
          pubkey: RESERVE_ADDR,
          account: { data: { parsed: { info: { mint: FRESH_MINT, tokenAmount: { amount: '793000000000000' } } } } },
        }],
      };
    }
    throw new Error('unexpected rpc ' + method);
  });

  const quotes = [];
  feed.onQuote((q) => quotes.push(q));
  const found = await feed.prewatch({ pool: CURVE_ADDR });

  assert.ok(found, 'a live pump curve must prewatch');
  assert.equal(found.mint, FRESH_MINT, 'the mint is discovered from the reserve account');
  assert.equal(found.pool, CURVE_ADDR);
  assert.ok(Math.abs(found.priceNative - 3e-8) < 1e-18, 'the primed price is the curve price');

  const live = feed.currentQuote(FRESH_MINT);
  assert.ok(live, 'the primed quote is immediately servable to a fill');
  assert.equal(live.poolKind, 'pump-curve');
  assert.equal(live.slot, 4321, 'the primed quote carries its read slot for the ordering guard');
  assert.ok(quotes.some((q) => q.mint === FRESH_MINT), 'the primed quote is emitted like any live one');
  // vm-realm arrays carry a foreign prototype; compare structurally.
  assert.deepEqual(JSON.parse(JSON.stringify(feed.reserveAccounts(FRESH_MINT))), [RESERVE_ADDR],
    'the reserve account is remembered — the rug guard must not count liquidity as a holder');
});

test('F-34: a completed (migrated) curve refuses prewatch — the resolver path owns it', async () => {
  const curveB64 = curveAccountB64({
    virtualToken: 1_000_000_000_000_000, virtualSol: 115_000_000_000, complete: true,
  });
  const feed = feedWithRpc(async (method, params) => {
    if (method === 'getMultipleAccounts') {
      return { context: { slot: 1 }, value: [{ owner: PUMP_PROGRAM_ID, data: [curveB64] }] };
    }
    throw new Error('unexpected rpc ' + method);
  });
  assert.equal(await feed.prewatch({ pool: CURVE_ADDR }), null);
});

test('F-34: a non-pump pool refuses prewatch rather than guessing', async () => {
  const feed = feedWithRpc(async (method) => {
    if (method === 'getMultipleAccounts') {
      return { context: { slot: 1 }, value: [{ owner: 'SomeOtherProgram1111111111111111111111111111', data: [curveAccountB64({ virtualToken: 1, virtualSol: 1, complete: false })] }] };
    }
    throw new Error('unexpected rpc ' + method);
  });
  assert.equal(await feed.prewatch({ pool: CURVE_ADDR }), null);
});

/* ---------------- probe-everything prewatch (the Padre re-report) ----------
 *
 * The original prewatch only ever answered for pump.fun bonding curves, and
 * the content script only probed pump-suffixed mint addresses at all. A
 * brand-new NON-pump launch (letsbonk and friends) on an MCap-mode chart
 * therefore had no instant path whatsoever: no curve to derive, no supply to
 * price mcap ticks with, no aggregator that had heard of the coin — the
 * armed buy sat on "waiting for first quote" indefinitely.
 *
 * prewatch now classifies whatever single address the page has by its
 * account OWNER (F-45: the page's kind label is a claim, not a fact) and
 * returns the best instant answer that address supports: a live primed feed
 * for any pool with a verified decoder, or measured supply facts for a bare
 * mint account.
 */

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL = 'So11111111111111111111111111111111111111112';

/** A guaranteed-round-trippable base58 address from 32 bytes of `fill`. */
function addrOf(fill) {
  return Onchain.readPubkey(Buffer.alloc(32, fill), 0);
}

function writePubkey(buf, offset, base58) {
  const bytes = Onchain.b58decode(base58);
  for (let i = 0; i < 32; i++) buf[offset + i] = bytes[i];
}

/** Like tokenAccountB64 above, but with a real mint pubkey at offset 0 (the
 * discovery scan classifies vaults BY their mint) and a nonzero OWNER pubkey
 * at 32 — real token accounts always have one, and it matters here: bytes
 * 36..43 of a token account sit inside the owner key, which is exactly where
 * decodeMint would misread a "supply" from. A zeroed owner would let a
 * missing layout gate pass on the supply-zero guard instead — a vacuous
 * lock (caught by mutation-testing this file). */
function splAccountB64(mint, amount) {
  const bytes = Buffer.alloc(165);
  writePubkey(bytes, 0, mint);
  writePubkey(bytes, 32, addrOf(0x42));
  bytes.writeBigUInt64LE(BigInt(amount), 64);
  return bytes.toString('base64');
}

/** Map-driven RPC fake: unknown addresses answer null, like a real node. */
function feedWithAccounts(accountsByAddress) {
  return feedWithRpc(async (method, params) => {
    if (method === 'getMultipleAccounts') {
      return {
        context: { slot: 7000 },
        value: params[0].map((address) => accountsByAddress[address] || null),
      };
    }
    if (method === 'getTokenAccountsByOwner') return { value: [] };
    throw new Error('unexpected rpc ' + method);
  });
}

test('an address the page labeled "mint" that is really a pump curve still prewatches (F-45)', async () => {
  // Identical on-chain state to the bare-curve test above — only the label
  // differs. The owner program decides the path, never the label.
  const curveB64 = curveAccountB64({
    virtualToken: 1_000_000_000_000_000, virtualSol: 30_000_000_000, complete: false,
  });
  const feed = feedWithRpc(async (method, params) => {
    if (method === 'getMultipleAccounts') {
      return {
        context: { slot: 4321 },
        value: params[0].map((address) => {
          if (address === CURVE_ADDR) return { owner: PUMP_PROGRAM_ID, data: [curveB64] };
          if (address === FRESH_MINT) return { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] };
          return null;
        }),
      };
    }
    if (method === 'getTokenAccountsByOwner') {
      return {
        value: [{
          pubkey: RESERVE_ADDR,
          account: { data: { parsed: { info: { mint: FRESH_MINT, tokenAmount: { amount: '793000000000000' } } } } },
        }],
      };
    }
    throw new Error('unexpected rpc ' + method);
  });
  const found = await feed.prewatch({ mint: CURVE_ADDR });
  assert.ok(found, 'the mislabel must not cost the sniping window');
  assert.equal(found.mint, FRESH_MINT);
  assert.equal(found.pool, CURVE_ADDR);
  assert.equal(found.poolKind, 'pump-curve');
  assert.ok(Math.abs(found.priceNative - 3e-8) < 1e-18);
});

test('a bare non-pump mint account answers with measured supply facts', async () => {
  const PLAIN_MINT = addrOf(11);
  const feed = feedWithAccounts({
    [PLAIN_MINT]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
  });
  const found = await feed.prewatch({ mint: PLAIN_MINT });
  assert.ok(found, 'a visible mint account is an answer, not a refusal');
  assert.equal(found.mint, PLAIN_MINT);
  assert.equal(found.pool, null, 'no pool was identified and none may be implied');
  assert.equal(found.priceNative, null, 'supply facts are not a price');
  assert.equal(found.decimals, 6);
  assert.ok(Math.abs(found.supplyUi - 1e9) < 1e-6,
    'supplyUi is the raw u64 supply over its decimals — whole tokens');
  assert.equal(feed.currentQuote(PLAIN_MINT), null,
    'no live feed exists for a poolless mint; nothing must pretend one does');
});

test('a 165-byte token ACCOUNT is refused as mint facts — garbage supply prices garbage fills', async () => {
  const NOT_A_MINT = addrOf(12);
  const feed = feedWithAccounts({
    [NOT_A_MINT]: { owner: TOKEN_PROGRAM_ID, data: [splAccountB64(addrOf(8), 5)] },
  });
  assert.equal(await feed.prewatch({ mint: NOT_A_MINT }), null,
    'decodeMint would happily misread a token account; the layout gate must refuse it');
});

test('a SOL-quoted whirlpool prewatches from the bare pool address with a primed quote', async () => {
  const WP_POOL = addrOf(3);
  const TOK_MINT = addrOf(9);
  // sqrtPrice 2^60 exactly: ratio (2^60/2^64)^2 = 1/256 B-per-A raw, and at
  // 6dp token / 9dp WSOL the native price is 1/256 * 10^-3 = 3.90625e-6.
  const wp = Buffer.alloc(256);
  wp.writeBigUInt64LE(BigInt(2) ** BigInt(60), 65);   // sqrtPrice low u64
  wp.writeBigUInt64LE(BigInt(0), 73);                 // sqrtPrice high u64
  writePubkey(wp, 101, TOK_MINT);
  writePubkey(wp, 181, WSOL);
  const feed = feedWithAccounts({
    [WP_POOL]: { owner: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', data: [wp.toString('base64')] },
    [TOK_MINT]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
    [WSOL]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1, decimals: 9 })] },
  });
  const found = await feed.prewatch({ pool: WP_POOL });
  assert.ok(found, 'a decodable SOL-quoted pool must prewatch whatever its program is');
  assert.equal(found.mint, TOK_MINT, 'the token is the non-WSOL side');
  assert.equal(found.poolKind, 'whirlpool');
  assert.ok(Math.abs(found.priceNative - 3.90625e-6) < 1e-18, 'the primed price is the pool price');
  const live = feed.currentQuote(TOK_MINT);
  assert.ok(live && live.poolKind === 'whirlpool', 'the primed quote is immediately servable');
});

test('a constant-product pool discovers its mint through the WSOL-anchored vault scan', async () => {
  const CP_POOL = addrOf(4);
  const BASE_VAULT = addrOf(5);
  const QUOTE_VAULT = addrOf(6);
  const TOK_MINT = addrOf(8);
  const pool = Buffer.alloc(512);
  writePubkey(pool, 40, BASE_VAULT);
  writePubkey(pool, 72, QUOTE_VAULT);
  const feed = feedWithAccounts({
    [CP_POOL]: { owner: 'CPMMoo8L3F4NbTegBCKVNunggL7H1Zpdmwpwh8KMoZ0F', data: [pool.toString('base64')] },
    // 7e8 tokens against 21 SOL -> 3e-8 SOL each.
    [BASE_VAULT]: { owner: TOKEN_PROGRAM_ID, data: [splAccountB64(TOK_MINT, 700_000_000_000_000)] },
    [QUOTE_VAULT]: { owner: TOKEN_PROGRAM_ID, data: [splAccountB64(WSOL, 21_000_000_000)] },
    [TOK_MINT]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
    [WSOL]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1, decimals: 9 })] },
  });
  const found = await feed.prewatch({ pool: CP_POOL });
  assert.ok(found, 'the WSOL side proves the quote; the other side names the token');
  assert.equal(found.mint, TOK_MINT);
  assert.equal(found.poolKind, 'cp-vaults');
  assert.ok(Math.abs(found.priceNative - 3e-8) < 1e-18);
  assert.deepEqual(JSON.parse(JSON.stringify(feed.reserveAccounts(TOK_MINT))), [BASE_VAULT],
    'the base vault is liquidity, not a holder — the rug guard must exclude it');
});

test('an UNKNOWN-layout pool yields identity and supply — never a price, never a watch', async () => {
  // The Coja residue: Axiom /meme/<pair> on a launchpad with no verified
  // decoder. The WSOL-anchored vault scan works on any pool bytes (vaults
  // are plain SPL accounts), so the coin's IDENTITY and measured supply
  // are recoverable — protocol facts. Its price is not: bonding curves
  // price on VIRTUAL reserves, so a vault ratio from an unverified layout
  // would be an invented number. poolKind null says exactly that.
  const MYSTERY_POOL = addrOf(21);
  const BASE_VAULT = addrOf(22);
  const QUOTE_VAULT = addrOf(23);
  const TOK_MINT = addrOf(24);
  const pool = Buffer.alloc(512);
  writePubkey(pool, 40, BASE_VAULT);
  writePubkey(pool, 72, QUOTE_VAULT);
  const feed = feedWithAccounts({
    [MYSTERY_POOL]: { owner: 'LaunchLabDoesNotHaveAVerifiedDecoder11111111', data: [pool.toString('base64')] },
    [BASE_VAULT]: { owner: TOKEN_PROGRAM_ID, data: [splAccountB64(TOK_MINT, 700_000_000_000_000)] },
    [QUOTE_VAULT]: { owner: TOKEN_PROGRAM_ID, data: [splAccountB64(WSOL, 21_000_000_000)] },
    [TOK_MINT]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
  });
  const found = await feed.prewatch({ pool: MYSTERY_POOL });
  assert.ok(found, 'identity and supply are recoverable from any pool');
  assert.equal(found.mint, TOK_MINT, 'the WSOL side proves the quote; the other side names the token');
  assert.equal(found.poolKind, null, 'an unverified layout is named as such');
  assert.equal(found.priceNative, null, 'no decoder, no price — a vault ratio would be invented');
  assert.ok(Math.abs(found.supplyUi - 1e9) < 1e-6, 'measured supply rides along for the mcap bootstrap');
  assert.equal(feed.currentQuote(TOK_MINT), null, 'nothing is ever watched on an unverified layout');
});

test('a pool between two non-SOL tokens is refused — nothing says which side the page charts', async () => {
  const WP_POOL = addrOf(13);
  const wp = Buffer.alloc(256);
  wp.writeBigUInt64LE(BigInt(2) ** BigInt(60), 65);
  writePubkey(wp, 101, addrOf(14));
  writePubkey(wp, 181, addrOf(15));
  // Both mints are fully resolvable — decimals, supply, everything a watch
  // would need. The ONLY thing standing between this pool and a wrong-side
  // quote is the WSOL-anchor refusal itself; a fake that starved the
  // decimals fetch instead let a mutated guard pass on the downstream
  // failure (the vacuous-lock trap, caught by mutation-testing this file).
  const feed = feedWithAccounts({
    [WP_POOL]: { owner: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', data: [wp.toString('base64')] },
    [addrOf(14)]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
    [addrOf(15)]: { owner: TOKEN_PROGRAM_ID, data: [mintAccountB64({ supply: 1_000_000_000_000_000, decimals: 6 })] },
  });
  assert.equal(await feed.prewatch({ pool: WP_POOL }), null);
});

/* ---------------- D-62: a thrown probe must RESOLVE null, never reject ------
 *
 * Field report (vro, Discord 8/26): "it wont let u buy half the time" on
 * fresh coins. One of the legs: prewatch()'s catch block referenced
 * `address`, a const declared INSIDE the try — so any thrown RPC (429 from
 * a keyless public endpoint, dropped socket) raised a ReferenceError inside
 * the error handler itself. The promise REJECTED instead of resolving the
 * designed null: pt_onchain_prewatch's own try/catch masked it to null one
 * layer up, but noteFeedError never recorded the real fault, and any direct
 * caller of prewatch() (tests, future code) saw an unhandled rejection.
 * The negative control for this test: revert the hoist and it fails with
 * "ReferenceError: address is not defined".
 */
test('D-62: a throwing RPC makes prewatch resolve null — not reject from its own catch', async () => {
  const BOOM_MINT = 'BoomMint11111111111111111111111111111111111';
  const feed = feedWithRpc(async () => { throw new Error('429 Too Many Requests'); });
  let result = 'unset';
  let rejection = null;
  try {
    result = await feed.prewatch({ mint: BOOM_MINT });
  } catch (e) {
    rejection = e;
  }
  assert.equal(rejection, null,
    `prewatch must swallow probe faults and resolve; it rejected with: ${rejection && rejection.message}`);
  assert.equal(result, null, 'the designed answer for an unreachable chain is null');
});
