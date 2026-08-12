/* PaperTrench server — chain contract, re-exported.
 *
 * The server verifies the SAME bytes the extension commits. Importing the
 * extension's attest.js (storage-agnostic by design) instead of copying it
 * means the preimage format cannot drift between the two halves: a change to
 * the contract breaks one shared test suite, not a silent fork.
 */
'use strict';

const AT = require('../../extension/attest.js');

module.exports = {
  VERSION: AT.VERSION,
  SUBMISSION_VERSION: AT.SUBMISSION_VERSION,
  GENESIS: AT.GENESIS,
  sha256: AT.sha256,
  fillPreimage: AT.fillPreimage,
  // The ONLY sanctioned way to ask which chain a link belongs to: on a v1 link
  // the stored label is unhashed and therefore not evidence, so it resolves to
  // Solana by definition. Never read `link.chain` directly server-side.
  chainOf: AT.chainOf,
  appendFill: AT.appendFill,
  verifyChain: AT.verifyChain,
  replayChain: AT.replayChain,
  claimMatchesChain: AT.claimMatchesChain,
  buildSubmission: AT.buildSubmission,
};
