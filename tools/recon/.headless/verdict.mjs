/* livepass predict verdict — pure, zero-dep, unit-tested.
 *
 * An engine REFUSAL is not an integration failure — it is the product
 * working. "Larger than this market can absorb", "already priced as a
 * near-certainty", "no visible liquidity" all mean the book was fetched,
 * the engine ran, and a rule fired. Only a refusal that means the pipeline
 * never got a book is a defect. Conflating the two is how a harness starts
 * crying wolf and stops being read.
 *
 * Two honesty rules live here:
 *  B1: a market reached via fallbackMarket is UNVERIFIED corpus. Only a
 *      QUOTE on it proves pipeline health; anything else is BLOCKED, never
 *      PASS (a dead fallback scored PASS) and never FAIL (a dead fallback
 *      URL would blame the product).
 *  B2: verdicts switch on refusal CODES first (data-pt-error-code), with the
 *      old prose regexes as legacy fallback for tickets that predate codes.
 */

// Guard codes: the engine ran on a real book and a rule fired. Pipeline healthy.
const GUARD_CODES = new Set(['resolution_lockout', 'no_liquidity', 'market_closed', 'depth_cap']);
// Pipeline codes: no book ever reached the engine. Defect (or venue-side outage).
const PIPE_CODES = new Set(['stale_book', 'unknown_venue', 'venue_error']);

const GUARDED_RE = /near-certainty|no visible liquidity|market can absorb|has closed|lost the live book|Minimum order/i;
const BROKEN_PIPE_RE = /No live book|not yet wired|not loaded|Unknown venue|ticket vanished|no quote \(/i;

export function predictVerdict({ badge, ticket, quote, quoteCode = null, viaFallback = false }) {
  const quoted = typeof quote === 'string' && quote.startsWith('QUOTED');
  if (viaFallback && !quoted) {
    return `BLOCKED — fallback corpus unverified (listing yielded no link; ${quote || 'no quote attempt'})`;
  }
  if (badge && ticket && quoted) return 'PASS';
  // A present code decides alone: prose regexes are legacy fallback, and a
  // stale/wrong sentence must never override the machine verdict.
  if (quoteCode) {
    if (GUARD_CODES.has(quoteCode)) return 'PASS (engine guard fired — pipeline healthy)';
    if (PIPE_CODES.has(quoteCode)) return `FAIL — panel mounts but no book reaches it (${quote})`;
    return `PARTIAL — ${quote}`;
  }
  const guarded = GUARDED_RE.test(quote || '');
  if (badge && ticket && guarded) return 'PASS (engine guard fired — pipeline healthy)';
  const brokenPipe = BROKEN_PIPE_RE.test(quote || '');
  if (badge && ticket && brokenPipe) return `FAIL — panel mounts but no book reaches it (${quote})`;
  if (badge && ticket) return `PARTIAL — ${quote}`;
  if (badge && !ticket) return 'PARTIAL — badge only, no ticket UI';
  return 'FAIL — nothing mounted';
}
