/* PaperTrench onboarding bot — reply copy.
 *
 * Single source of truth for every message the @-mention bot (or a human
 * fallback) posts. Keep templates deterministic, on-brand, and verifiable:
 * every product claim must match a feature in the extension repo.
 */

'use strict';

function BOT_HANDLE(config) {
  return (config && config.BOT_HANDLE) || 'PaperTrenchBot';
}

/* Supported trading sites named in the reply copy. Keep this in sync with
 * extension/sites.js; the test suite enforces that every name here has an
 * adapter there. Pump.fun is supported by the extension but deliberately NOT
 * named here: X auto-links any bare domain with a valid TLD (.fun qualifies),
 * so "Pump.fun" would count as a second 23-char t.co URL — pushing the short
 * post past the 280-char free-tier limit and doubling per-post URL pricing. */
const SITES_LINE = 'Axiom, Padre, GMGN, BullX, Dexscreener, Birdeye';

/* Free-tier post (≤ 280 chars, one URL at the end).
 * X wraps EVERY autolinkable bare domain in a 23-char t.co link — not just the
 * CTA. The test suite counts all TLD-shaped tokens as 23 chars each; keep the
 * copy free of accidental domains (see the SITES_LINE note above). */
const SHORT_TEMPLATE = [
  'Curious about a memecoin? Paper-trade it first.',
  '1. Install the free Chrome ext.',
  '2. Open ' + SITES_LINE + ' — real charts, fake SOL.',
  '3. Paper-buy, journal thesis, review fills and P&L.',
  'No wallet. No risk. Real lessons.',
  'papertrench.com',
].join('\n');

/* Premium / long variant: only used when config.PREMIUM=true. Includes the
 * manual install steps and a graduation line that does not promise success. */
const LONG_TEMPLATE = [
  'Curious about a memecoin? Paper-trade it first.',
  '1. papertrench.com → install the free Chrome extension.',
  '   - chrome://extensions → turn on Developer mode → Load unpacked.',
  '   - Select the folder that contains manifest.json.',
  '2. Open ' + SITES_LINE + ' — real charts, fake SOL.',
  '3. Paper-buy, journal your thesis, review fills and P&L.',
  'No wallet. No risk. Real lessons.',
  "When you're ready for real size you'll already know the game.",
  'papertrench.com',
].join('\n');

module.exports = { BOT_HANDLE, SITES_LINE, SHORT_TEMPLATE, LONG_TEMPLATE };
