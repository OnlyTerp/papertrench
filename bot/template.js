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

/* Supported trading sites. Keep this in sync with extension/sites.js; the
 * test suite enforces that every name here is exported by that module. */
const SITES_LINE = 'Axiom, Pump.fun, Padre, GMGN, BullX, Dexscreener, Birdeye';

/* Free-tier post (≤ 280 chars, one URL at the end).
 * X counts any URL as 23 characters via t.co wrapping, so the limit below is
 * enforced in character-count logic as: 280 - 23 + actual_url_length. */
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
