/* PaperTrench server — submission pipeline.
 *
 * The server-side half of docs/LEADERBOARD.md, as one pure orchestration:
 *
 *   1. shape gate        — malformed or absurd payloads never reach crypto
 *   2. verifyChain       — every link re-hashed, order enforced
 *   3. head monotonicity — a later submission must EXTEND the chain already
 *                          committed to; swapping in a fresh, luckier history
 *                          is the oldest cheat on any self-reported board
 *   4. replay            — standings come from replayChain, never `claim`;
 *                          a claim/replay mismatch is recorded as a signal
 *   5. re-pricing        — separate, resumable phase (pricing.js) because it
 *                          costs external lookups; a record ranks as
 *                          'verified' only after it survives this
 *
 * Pure: no storage, no fetch. The worker owns persistence and rate limits.
 */
'use strict';

const { verifyChain, replayChain } = require('./chain.js');
const { recordStats, minCashDuringReplay, committedAmount } = require('./ranking.js');
const { priceChain, recordVerdict } = require('./pricing.js');

const MAX_CHAIN_LINKS = 50000;
const MAX_STARTING_SOL = 100000;

/**
 * Envelope versions actually minted by any client that has ever shipped.
 *
 * 1 is the envelope's real version — its shape has never changed. 2 exists
 * because buildSubmission used to stamp the fill-LINK contract version
 * (attest.js VERSION) onto the envelope, so the F-44 link bump silently
 * relabelled every v3.4.0 export and site sync as an envelope nobody had
 * defined — and this gate, doing exactly what it was told, refused all of
 * them as `shape:unknown-version` while every link inside verified. The
 * board sat empty for days (DEFECT L-01). Those v2-labelled exports are in
 * the wild and byte-identical to v1, so both are accepted by name; anything
 * else remains refused, because an envelope we have never defined is not
 * one we can claim to have checked.
 */
const ENVELOPE_VERSIONS = new Set([1, 2]);

/** Cheap structural gate. Returns null when acceptable, else a reason. */
function shapeProblem(payload) {
  if (!payload || typeof payload !== 'object') return 'not-an-object';
  if (!ENVELOPE_VERSIONS.has(payload.version)) return 'unknown-version';
  if (!Array.isArray(payload.chain)) return 'chain-missing';
  if (!payload.chain.length) return 'chain-empty';
  if (payload.chain.length > MAX_CHAIN_LINKS) return 'chain-too-long';
  const start = Number(payload.claim && payload.claim.startingBalanceSol);
  if (!(start > 0) || start > MAX_STARTING_SOL) return 'starting-balance-invalid';
  if (typeof payload.head !== 'string' || !payload.head) return 'head-missing';
  const tail = payload.chain[payload.chain.length - 1];
  if (!tail || tail.hash !== payload.head) return 'head-mismatch';
  return null;
}

/* The committed amount must be consistent with the committed qty × price.
 *
 * Re-pricing proves a fill's PRICE existed; nothing proved its CASH matched
 * that price. The preimage commits one money field per fill — gross on a
 * buy, net on a sell — and the replay books exactly that cash, so a chain
 * forged with honest mints, timestamps and prices (all of which survive
 * re-pricing) could still declare a sell that "received" a hundred times
 * what qty × price is worth, or a buy that cost nothing, and walk straight
 * onto the board (DEFECT L-03).
 *
 * The engine's own arithmetic makes the honest bounds exact and one-sided:
 * a buy's committed gross is qty × price PLUS the fee (never less), and a
 * sell's committed net is qty × price MINUS fees and tx costs (never more).
 * Fees only ever push in the honest direction, so no fee or slippage
 * setting a real user can choose lands outside these bounds — the checks
 * reject only the two directions that mint money.
 */
const AMOUNT_REL_TOL = 1e-6; // float formatting headroom, far below any fee
const AMOUNT_ABS_TOL = 1e-9;

function amountProblems(links) {
  const problems = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i] || {};
    const qty = Number(link.qty) || 0;
    const price = Number(link.priceNative) || 0;
    if (!(qty > 0) || !(price > 0)) continue; // the replay skips these too
    const value = qty * price;
    const amount = committedAmount(link);
    if (link.side === 'buy' && amount < value * (1 - AMOUNT_REL_TOL) - AMOUNT_ABS_TOL) {
      problems.push({ index: i, id: link.id, reason: 'buy-cheaper-than-priced' });
    } else if (link.side === 'sell' && amount > value * (1 + AMOUNT_REL_TOL) + AMOUNT_ABS_TOL) {
      problems.push({ index: i, id: link.id, reason: 'sell-exceeds-priced-value' });
    }
  }
  return problems;
}

/**
 * The fast checks (1–4). `previous` is the stored record for this identity
 * ({ head, chainLen }) or null on first submission.
 *
 * Returns { accepted, reason?, stats?, replayed?, claimMismatch? }.
 */
async function fastChecks(payload, previous) {
  const shape = shapeProblem(payload);
  if (shape) return { accepted: false, reason: 'shape:' + shape };

  const verification = await verifyChain(payload.chain);
  if (!verification.valid) {
    return {
      accepted: false,
      reason: 'chain-invalid',
      problems: verification.problems.slice(0, 20),
    };
  }

  if (previous && previous.head && previous.chainLen > 0) {
    if (payload.chain.length < previous.chainLen) {
      return { accepted: false, reason: 'chain-shrunk' };
    }
    const anchor = payload.chain[previous.chainLen - 1];
    if (!anchor || anchor.hash !== previous.head) {
      return { accepted: false, reason: 'chain-replaced' };
    }
    // The declared bankroll is the denominator of ROI and therefore of the
    // whole score, and it is the ONE input the chain cannot prove. Left free,
    // a resubmission of the same fills with a smaller bankroll multiplies the
    // return arbitrarily — the cheapest possible way to top the board. So it
    // is pinned at first submission; changing it means deleting the server
    // record and starting over, which is self-serve and visible.
    if (Number.isFinite(previous.startingSol) && previous.startingSol > 0) {
      const declared = Number(payload.claim.startingBalanceSol);
      if (Math.abs(declared - previous.startingSol) > 1e-9) {
        return { accepted: false, reason: 'bankroll-changed' };
      }
    }
  }

  const badAmounts = amountProblems(payload.chain);
  if (badAmounts.length) {
    return {
      accepted: false,
      reason: 'amount-implausible',
      problems: badAmounts.slice(0, 20),
    };
  }

  const start = Number(payload.claim.startingBalanceSol);

  // The bankroll is the denominator of every ranked figure and the one input
  // the chain cannot prove — so it is pinned across submissions above, and
  // floored by the chain itself here. Declaring a tiny balance to multiply the
  // return is the cheapest possible cheat and needs no forgery at all: just
  // edit the exported file before uploading it. But the committed fills show
  // what was actually spent, and cash that goes negative is proof the declared
  // balance never existed.
  if (minCashDuringReplay(payload.chain, start) < -1e-9) {
    return { accepted: false, reason: 'bankroll-too-small' };
  }

  const replayed = replayChain(payload.chain, start);
  const claimedPnl = Number(payload.claim.realizedPnlSol) || 0;
  const claimMismatch = Math.abs(replayed.realizedPnlSol - claimedPnl) > 1e-6;
  const stats = recordStats(payload.chain, start);

  return { accepted: true, stats, replayed, claimMismatch };
}

/**
 * The pricing phase (5), resumable. `progress` is null on first call or the
 * previous call's return value; the runtime persists it between cron runs.
 */
async function priceRecord(payload, getCandles, progress, opts) {
  const options = opts || {};
  const prior = progress && Array.isArray(progress.verdicts) ? progress : { cursor: 0, verdicts: [] };
  const run = await priceChain(payload.chain, getCandles, {
    startAt: prior.cursor,
    maxLookups: options.maxLookups,
    tolerance: options.tolerance,
  });
  // priceChain judges from startAt onward, so the slices never overlap.
  const merged = prior.verdicts.concat(run.verdicts);
  const done = merged.length === payload.chain.length;
  const result = {
    done,
    cursor: run.cursor,
    verdicts: merged,
  };
  if (done) result.verdict = recordVerdict(merged, { minCoverage: options.minCoverage });
  return result;
}

module.exports = {
  MAX_CHAIN_LINKS, MAX_STARTING_SOL, ENVELOPE_VERSIONS,
  shapeProblem, amountProblems, fastChecks, priceRecord,
};
