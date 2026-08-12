/* PaperTrench — trade attestation.
 *
 * A paper-trading leaderboard is trivially cheatable: every number lives on the
 * user's own machine, so self-reported P&L is worth nothing. This module does
 * not pretend to make cheating impossible. It produces EVIDENCE that a server
 * can independently verify, and it is explicit about what that evidence does
 * and does not prove.
 *
 * What the chain proves:
 *   - Ordering. Each fill commits to the hash of the previous one, so a trade
 *     cannot be inserted, removed, or reordered after the fact without breaking
 *     every link that follows it.
 *   - Pre-commitment. A fill is hashed at the moment it is made, before its
 *     outcome is known. Backdating a winning entry invalidates the chain.
 *   - Price claims. Every fill records mint, side, quantity, price and
 *     timestamp, so a verifier can re-fetch the historical price for that mint
 *     at that second and reject fills at prices that never existed.
 *
 * What it does NOT prove:
 *   - That the user ran unmodified code. A determined attacker can always forge
 *     a locally-consistent chain. That is why ranking must be server-verified
 *     against real price history, and why identity is bound to an X account:
 *     forging costs a real, rate-limited, publicly visible identity.
 */
(() => {
  'use strict';

  // v2 (F-44) commits the fill's CHAIN. v1 did not, which left the label
  // recorded-but-unhashed: editable while every digest still verified. See
  // fillPreimage for why the bump is safe for chains already in the wild.
  const VERSION = 2;
  // The submission ENVELOPE format — a different contract from VERSION above,
  // and the distinction is written in blood. VERSION is the fill-link
  // preimage contract and bumps whenever the hashed bytes change; the
  // envelope (version/claim/chain/head) has carried the same five fields
  // since day one. buildSubmission used to stamp VERSION onto the envelope,
  // so when F-44 moved VERSION to 2 every v3.4.0 export and site sync was
  // refused by the server's shape gate as `shape:unknown-version` — 40 of
  // the last 40 production submissions — while every link inside verified
  // perfectly, and the board sat empty (DEFECT L-01). Links carry their own
  // versions; this number only moves when the ENVELOPE shape itself does.
  const SUBMISSION_VERSION = 1;
  const GENESIS = 'papertrench-genesis-v1';
  // How many independent link digests verifyChain may have in flight at once.
  // Bounds both concurrency and peak preimage memory on the shared server path
  // (see verifyChain). Large enough that the parallel win is fully realised.
  const DIGEST_BATCH = 512;

  function subtle() {
    const c = (typeof crypto !== 'undefined' && crypto) || null;
    return c && c.subtle ? c.subtle : null;
  }

  function bytes(text) {
    return new TextEncoder().encode(text);
  }

  function hex(buffer) {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function sha256(text) {
    const api = subtle();
    if (!api) throw new Error('WebCrypto unavailable');
    return hex(await api.digest('SHA-256', bytes(text)));
  }

  /**
   * The exact bytes a fill commits to.
   *
   * Deterministic and explicit: a verifier must be able to reproduce this
   * string from the public fill record alone, so field order and formatting are
   * part of the contract rather than an implementation detail.
   */
  /**
   * The chain a link belongs to, decided by its VERSION rather than by reading
   * its label.
   *
   * A v1 link predates the committed field, so its `chain` property is
   * unhashed — editable without breaking a single digest. It is therefore not
   * evidence, and must never be consulted. Every v1 fill was written by a
   * Solana-only build, so v1 IS Solana, by definition and not by inspection.
   *
   * This is the rule that stops the bump from being cosmetic: real chains SPAN
   * the upgrade — v1 links sitting beside v2 links in one wallet — and a
   * consumer that reads `link.chain` uniformly would inherit the exact hole the
   * bump closes, on every historical link, while the new ones looked correct.
   */
  function chainOf(link) {
    const version = Number(link && link.version) || 1;
    if (version < 2) return 'solana';
    const value = link && link.chain;
    return typeof value === 'string' && value ? value : 'solana';
  }

  function fillPreimage(fill, previousHash) {
    // Version DISPATCH, never a constant. A wallet that traded before v2 and
    // after it holds both formats, so each link must be re-hashed under the
    // rules it was WRITTEN with; `'v' + VERSION` here would invalidate every
    // chain in existence the moment VERSION moved — including the ones already
    // submitted to the leaderboard. Absent field means the original format.
    const version = Number(fill && fill.version) || 1;
    const fields = [
      'v' + version,
      previousHash,
      String(fill.id || ''),
      String(fill.sessionId || ''),
      String(fill.mint || ''),
      String(fill.side || ''),
      // Fixed precision keeps the digest stable across float formatting.
      Number(fill.qty || 0).toFixed(12),
      Number(fill.priceNative || 0).toExponential(12),
      // Cash-basis amount: gross on buy, net on sell.
      Number(fill.side === 'buy'
        ? (fill.solGross !== undefined ? fill.solGross : fill.solNet)
        : (fill.solNet !== undefined ? fill.solNet : fill.solGross)
      ).toFixed(12),
      String(Math.trunc(Number(fill.ts) || 0)),
    ];
    // APPENDED, not inserted: a v1 preimage must stay byte-identical forever or
    // every chain written before today stops verifying. v2 adds one field at
    // the end and changes nothing before it.
    if (version >= 2) fields.push(chainOf(fill));
    return fields.join('|');
  }

  /** Append one fill to the chain, returning its link. */
  async function appendFill(previousHash, fill) {
    const prev = previousHash || GENESIS;
    // Stamp the version onto the object the preimage is built from, so the
    // digest and the stored link can never disagree about which format this
    // link is in.
    const preimage = fillPreimage({ ...fill, version: VERSION }, prev);
    const hash = await sha256(preimage);
    return {
      version: VERSION,
      seq: null, // assigned by the caller that owns the chain
      id: String(fill.id || ''),
      sessionId: String(fill.sessionId || ''),
      mint: String(fill.mint || ''),
      side: String(fill.side || ''),
      qty: Number(fill.qty) || 0,
      priceNative: Number(fill.priceNative) || 0,
      solGross: Number(fill.solGross) || 0,
      solNet: Number(fill.solNet !== undefined ? fill.solNet : fill.solGross) || 0,
      // Flat per-transaction cost (gas + tip emulation). Stored like solNet —
      // uncommitted but replayed — so the chain-derived P&L keeps agreeing
      // with an honest wallet when cost emulation is on.
      txCostSol: Number(fill.txCostSol) || 0,
      // Multichain: which chain the fill's token lives on. COMMITTED as of v2
      // (F-44) — a verifier prices the fill against the right chain's history,
      // so the label decides which candles judge it and must not be editable.
      // It was previously stored under the solNet pattern, but that precedent
      // is safe for the opposite reason: committedAmount() refuses to read
      // solNet. A field the verifier is MEANT to consume has to be hashed.
      chain: chainOf({ ...fill, version: VERSION }),
      amount: Number(fill.side === 'buy'
        ? (fill.solGross !== undefined ? fill.solGross : fill.solNet)
        : (fill.solNet !== undefined ? fill.solNet : fill.solGross)
      ) || 0,
      ts: Math.trunc(Number(fill.ts) || 0),
      prev,
      hash,
    };
  }

  /**
   * Verify a chain end to end.
   *
   * Returns every problem found rather than the first, because a verifier
   * showing "3 fills were altered" is far more useful than "invalid".
   */
  async function verifyChain(links) {
    const list = Array.isArray(links) ? links : [];
    const problems = [];
    let previous = GENESIS;

    // Every digest is INDEPENDENT: the preimage is built from the link's own
    // stored `prev`, never from the running `previous` below. So the hashes are
    // computed in parallel instead of one awaited digest per link, which is
    // what made verification O(chain) round trips through WebCrypto and left
    // "Checking your trade chain…" on screen after every fill. The loop that
    // follows is unchanged and still strictly sequential, so the chaining
    // check, the timestamp check and the ORDER problems are reported in are
    // all exactly as before.
    //
    // BATCHED, not one big Promise.all, because this module is shared: the
    // leaderboard server imports this exact file (server/core/chain.js) so the
    // hash contract cannot fork between the client that commits a fill and the
    // server that ranks it — and that server accepts chains up to 50,000 links
    // inside one request's CPU budget. An unbounded map would launch 50,000
    // concurrent digests AND materialise 50,000 preimages before the first one
    // resolved. The batch bounds both; at any realistic chain length it is
    // indistinguishable from the unbounded form.
    const expectedHashes = [];
    for (let start = 0; start < list.length; start += DIGEST_BATCH) {
      const batch = await Promise.all(
        list.slice(start, start + DIGEST_BATCH).map((entry) => {
          const link = entry || {};
          return sha256(fillPreimage(link, link.prev || GENESIS));
        }),
      );
      for (const hash of batch) expectedHashes.push(hash);
    }

    for (let i = 0; i < list.length; i++) {
      const link = list[i] || {};
      if (link.prev !== previous) {
        problems.push({ index: i, id: link.id, reason: 'broken-link' });
      }
      if (expectedHashes[i] !== link.hash) {
        problems.push({ index: i, id: link.id, reason: 'hash-mismatch' });
      }
      // Time must move forward; a backdated fill is the classic cheat.
      if (i > 0 && Number(link.ts) < Number(list[i - 1].ts)) {
        problems.push({ index: i, id: link.id, reason: 'out-of-order-timestamp' });
      }
      previous = link.hash;
    }

    return {
      valid: problems.length === 0,
      length: list.length,
      head: list.length ? list[list.length - 1].hash : GENESIS,
      problems,
    };
  }

  /**
   * Build the payload a leaderboard server would verify.
   *
   * It deliberately carries the full chain rather than a summary: a server that
   * only receives "I made 4.2 SOL" has nothing to check. With the chain it can
   * recompute the result AND re-price every fill against real history.
   */
  function buildSubmission(opts) {
    const options = opts || {};
    const chain = Array.isArray(options.chain) ? options.chain : [];
    const stats = options.stats || {};
    return {
      version: SUBMISSION_VERSION,
      submittedAt: Date.now(),
      identity: options.identity || null,
      // Claimed result — treated as untrusted until the server recomputes it.
      claim: {
        equitySol: Number(stats.equitySol) || 0,
        realizedPnlSol: Number(stats.realizedPnlSol) || 0,
        rounds: Number(stats.rounds) || 0,
        wins: Number(stats.wins) || 0,
        losses: Number(stats.losses) || 0,
        startingBalanceSol: Number(options.startingBalanceSol) || 0,
      },
      chain,
      head: chain.length ? chain[chain.length - 1].hash : GENESIS,
      // Stated plainly so no one mistakes local evidence for proof.
      trustModel: 'client-generated evidence; server must re-verify every fill price',
    };
  }

  /**
   * Recompute a result from the chain alone.
   *
   * This is the function a server runs instead of trusting `claim`. It is
   * exported so the client can show the user the same number a verifier would
   * compute — if the two disagree, the local state has been tampered with.
   */
  function replayChain(links, startingBalanceSol) {
    const list = Array.isArray(links) ? links : [];
    let cash = Number(startingBalanceSol) || 0;
    // Positions are found by sessionId FIRST, mint second — the same priority
    // the engine's tradeInRound uses, for the same reason (DEFECT L-02). The
    // sessionId is hash-committed on every link (field four of the preimage)
    // and survives a rekeyMint rename (F-51): a fresh-launch buy is committed
    // under the PAIR stand-in address while the sells that close it are
    // committed under the real mint, so a replay that matches by mint alone
    // silently drops the exit — the realized P&L vanishes, the round never
    // closes, and an honest wallet reads as tampered the moment it trades a
    // fresh launch. Chains that predate sessionIds fall back to mint intact,
    // and a bag remembers every identity it has traded under so late fills
    // land on it whichever label they carry.
    const bySession = new Map(); // sessionId -> held bag
    const byMint = new Map();    // mint -> held bag
    const open = new Set();      // distinct open bags
    let realized = 0;
    let wins = 0;
    let losses = 0;

    const sessionOf = (link) =>
      (typeof link.sessionId === 'string' && link.sessionId ? link.sessionId : null);
    const findHeld = (link) => {
      const sid = sessionOf(link);
      if (sid && bySession.has(sid)) return bySession.get(sid);
      return byMint.get(link.mint) || null;
    };
    const adopt = (link, held) => {
      const sid = sessionOf(link);
      if (sid && bySession.get(sid) !== held) {
        held.sessions.push(sid);
        bySession.set(sid, held);
      }
      if (byMint.get(link.mint) !== held) {
        held.mints.push(link.mint);
        byMint.set(link.mint, held);
      }
    };
    const drop = (held) => {
      open.delete(held);
      for (const sid of held.sessions) if (bySession.get(sid) === held) bySession.delete(sid);
      for (const mint of held.mints) if (byMint.get(mint) === held) byMint.delete(mint);
    };

    for (const link of list) {
      const qty = Number(link.qty) || 0;
      const price = Number(link.priceNative) || 0;
      const amount = Number(link.amount !== undefined
        ? link.amount
        : (link.side === 'buy' ? link.solGross : link.solNet)
      ) || 0;
      if (!(qty > 0) || !(price > 0)) continue;

      if (link.side === 'buy') {
        cash -= amount;
        let held = findHeld(link);
        if (!held) {
          held = { qty: 0, cost: 0, sessions: [], mints: [] };
          open.add(held);
        }
        held.qty += qty;
        // D-02/D-03: the cost basis accumulates at the NET amount (gross
        // minus the buy fee) because that is exactly how the engine books it
        // (sell(): pnl = net proceeds − net cost share, accumulated into
        // stats.realizedPnlSol). Replaying at GROSS cost made the derived
        // realized P&L sit below an honest client's displayed figure by its
        // cumulative buy fees, so claimMatchesChain flagged every untampered
        // wallet as edited the moment it paid a fee. Every link stores
        // solNet; only `amount` (gross on buys) is hash-committed, which is
        // acceptable under the stated trust model — the chain is evidence,
        // not proof, and a server re-verifies every fill against real price
        // history anyway. Links without solNet (foreign/minimal fills) fall
        // back to the committed gross amount, preserving old behaviour.
        // Buy-side flat tx costs join the basis exactly as the engine books
        // them (costSol += net + flat); sell-side flats already flow through
        // the sell link's solNet.
        held.cost += (Number(link.solNet) > 0 ? Number(link.solNet) : amount)
          + (Number(link.txCostSol) || 0);
        adopt(link, held);
      } else if (link.side === 'sell') {
        const held = findHeld(link);
        if (!held || held.qty <= 0) continue;
        // Remember the sell's identifiers too: after a rekey the position's
        // remaining fills may arrive under either label.
        adopt(link, held);
        const share = Math.min(1, qty / held.qty);
        const costOut = held.cost * share;
        cash += amount;
        realized += amount - costOut;
        held.qty -= qty;
        held.cost -= costOut;
        if (held.qty <= 1e-12) {
          drop(held);
          if (amount - costOut > 0) wins += 1; else losses += 1;
        }
      }
    }

    return {
      cashSol: cash,
      openPositions: open.size,
      realizedPnlSol: realized,
      wins,
      losses,
      rounds: wins + losses,
    };
  }

  /**
   * Does the locally displayed result match what the chain actually implies?
   *
   * A mismatch means stored state disagrees with the committed history — the
   * signature of hand-edited storage.
   */
  function claimMatchesChain(claim, links, startingBalanceSol, tolerance) {
    const replayed = replayChain(links, startingBalanceSol);
    const tol = Number(tolerance) > 0 ? Number(tolerance) : 1e-6;
    const diff = Math.abs(replayed.realizedPnlSol - (Number(claim.realizedPnlSol) || 0));
    return {
      ok: diff <= tol,
      diff,
      replayed,
    };
  }

  /* ---------------- segmented chain storage (DEFECT F-14) ----------------
   *
   * The chain used to ride inside pt_state, so EVERY state write — every
   * fill, every heartbeat mark — serialized the full lifetime chain, and
   * fill latency grew forever. It now lives in its own append-only keys:
   *
   *   pt_attest_seg_<n>  — up to CHAIN_SEG_SIZE links each, never rewritten
   *                        once full
   *   pt_attest_meta     — { segCount, length, head }
   *
   * An append reads the meta and the TAIL segment only, so per-fill cost is
   * bounded by the segment size no matter how long the record grows. The
   * chain is still NEVER truncated — dropping links would break verifyChain
   * (the first kept link no longer chains from GENESIS) and replayChain
   * (derived P&L would silently lose early fills). Segmentation bounds the
   * cost of keeping everything instead.
   *
   * The helpers are storage-agnostic: callers pass async get(keys)/set(obj)
   * so the same code runs in the service worker, the dashboard, and the
   * popup. A get that yields null/undefined is a FAILED read and throws —
   * treating it as "empty" would re-anchor the next append at GENESIS and
   * fork the chain, the same class of bug as D-15's fabricated wallet.
   */
  const CHAIN_META_KEY = 'pt_attest_meta';
  const CHAIN_SEG_PREFIX = 'pt_attest_seg_';
  const CHAIN_SEG_SIZE = 500;

  function chainSegKey(n) { return CHAIN_SEG_PREFIX + n; }

  function normalizeChainMeta(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    return {
      segCount: Number.isInteger(m.segCount) && m.segCount > 0 ? m.segCount : 0,
      length: Number.isInteger(m.length) && m.length > 0 ? m.length : 0,
      head: typeof m.head === 'string' && m.head ? m.head : GENESIS,
    };
  }

  /** Every storage key the chain currently occupies (meta included). */
  function chainStorageKeys(meta) {
    const m = normalizeChainMeta(meta);
    const keys = [CHAIN_META_KEY];
    for (let i = 0; i < m.segCount; i++) keys.push(chainSegKey(i));
    return keys;
  }

  async function readChainMeta(get) {
    const stored = await get([CHAIN_META_KEY]);
    if (stored === null || stored === undefined) throw new Error('attest meta unreadable');
    return normalizeChainMeta(stored[CHAIN_META_KEY]);
  }

  /** The full chain, in seq order — the exact array verifyChain/replayChain
   * and buildSubmission have always consumed. */
  async function readChainStore(get) {
    const meta = await readChainMeta(get);
    if (!meta.segCount) return { meta, chain: [] };
    const keys = [];
    for (let i = 0; i < meta.segCount; i++) keys.push(chainSegKey(i));
    const stored = await get(keys);
    if (stored === null || stored === undefined) throw new Error('attest segments unreadable');
    const chain = [];
    for (const key of keys) {
      const seg = stored[key];
      if (Array.isArray(seg)) chain.push(...seg);
    }
    return { meta, chain };
  }

  /**
   * Append one fill: meta + tail segment in, tail segment + meta out.
   * O(segment size), never O(chain length) — that bound IS the F-14 fix.
   */
  async function appendToChainStore(get, set, fill) {
    const meta = await readChainMeta(get);
    let segIndex = meta.segCount ? meta.segCount - 1 : 0;
    let tail = [];
    if (meta.segCount) {
      const key = chainSegKey(segIndex);
      const stored = await get([key]);
      if (stored === null || stored === undefined) throw new Error('attest tail unreadable');
      tail = Array.isArray(stored[key]) ? stored[key] : [];
    }
    if (!meta.segCount || tail.length >= CHAIN_SEG_SIZE) {
      segIndex = meta.segCount;
      tail = [];
    }
    const link = await appendFill(meta.head, fill);
    link.seq = meta.length;
    tail.push(link);
    // One write carries both keys, so a reader can never observe a segment
    // whose meta has not caught up.
    await set({
      [chainSegKey(segIndex)]: tail,
      [CHAIN_META_KEY]: { segCount: segIndex + 1, length: meta.length + 1, head: link.hash },
    });
    return link;
  }

  /**
   * Re-segment a complete chain (migration, backup restore). Returns the
   * storage-write object — segments plus meta — with every hash preserved
   * exactly as committed; this function must never re-derive a link.
   */
  function chainSegments(links) {
    const list = Array.isArray(links) ? links : [];
    const write = {};
    let segCount = 0;
    for (let i = 0; i < list.length; i += CHAIN_SEG_SIZE) {
      write[chainSegKey(segCount)] = list.slice(i, i + CHAIN_SEG_SIZE);
      segCount++;
    }
    write[CHAIN_META_KEY] = {
      segCount,
      length: list.length,
      head: list.length ? list[list.length - 1].hash : GENESIS,
    };
    return write;
  }

  const api = {
    VERSION, SUBMISSION_VERSION, GENESIS,
    sha256, fillPreimage, appendFill, verifyChain, chainOf,
    buildSubmission, replayChain, claimMatchesChain,
    CHAIN_META_KEY, CHAIN_SEG_PREFIX, CHAIN_SEG_SIZE,
    chainSegKey, normalizeChainMeta, chainStorageKeys,
    readChainMeta, readChainStore, appendToChainStore, chainSegments,
  };

  if (typeof window !== 'undefined') window.PTAttest = api;
  if (typeof self !== 'undefined') self.PTAttest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
