/* The detect() contract, pinned for its consumers.
 *
 * sites.js is a shared surface: content.js drives the overlay from it, and
 * Forge (forge.js `readFacts`) reads it to learn which token a banner is
 * about. Forge's own tests FAKE `window.PaperTrenchSites`, so a breaking
 * change to detect()'s shape sails straight through their suite and lands in
 * production — the same gap as a DOM fake that accepts a selector the real
 * page would refuse.
 *
 * The consumer cannot see the break, so the producer pins it. Everything here
 * runs the SHIPPED sites.js; nothing is faked.
 *
 * Why it matters beyond a type error: Forge hands these facts to an image
 * model. Before `chain` was exposed it assumed 'solana' and could state
 * "Chain: solana" about a Base token — a fabrication with a confident face,
 * which is the failure class this project exists to refuse. The contract
 * below is what keeps that honest, so it is worth failing loudly over.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** The fields sites.js PROMISES on a detection record. Adding one is safe;
 *  removing or renaming one breaks a consumer that cannot test for it. */
const GUARANTEED_FIELDS = new Set(['kind', 'address', 'chain']);
const VALID_KINDS = new Set(['mint', 'pair']);

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { site, token: site.detect() };
}

/* One live token page per shipped adapter — all Solana, because that is what
 * ships today (foreign chains are gated; see chainrouting.test.js). */
const PAGES = [
  ['axiom', `https://axiom.trade/meme/${MINT}`],
  ['padre', `https://trade.padre.gg/trade/solana/${MINT}`],
  ['photon', `https://photon-sol.tinyastro.io/en/lp/${MINT}`],
  ['gmgn', `https://gmgn.ai/sol/token/${MINT}`],
  ['bullx', `https://neo.bullx.io/terminal?chainId=1399811149&address=${MINT}`],
  ['dexscreener', `https://dexscreener.com/solana/${MINT}`],
  ['birdeye', `https://birdeye.so/solana/token/${MINT}`],
  ['jupiter', `https://jup.ag/swap?inputMint=So11111111111111111111111111111111111111112&outputMint=${MINT}`],
  ['fomo', `https://fomo.family/tokens/solana/${MINT}`],
  ['pumpfun', `https://pump.fun/coin/${MINT}`],
  ['lute', `https://lute.gg/trade/${MINT}`],
  ['debot', `https://debot.ai/token/solana/${MINT}`],
];

test('every shipped adapter detects a token page into the promised shape', () => {
  for (const [id, href] of PAGES) {
    const { site, token } = detectAt(href);
    assert.equal(site.id, id, `${href} must route to the ${id} adapter`);
    assert.ok(token, `${id}: a real token page must produce a detection`);

    assert.ok(VALID_KINDS.has(token.kind),
      `${id}: kind must be 'mint' or 'pair', got ${JSON.stringify(token.kind)} — `
      + 'Forge branches on this to decide whether it knows the chain');
    assert.equal(typeof token.address, 'string',
      `${id}: address must be a string — Forge assigns it straight to facts.mint`);
    assert.ok(token.address.length > 0, `${id}: address must not be empty`);
    if (token.chain !== undefined) {
      assert.equal(typeof token.chain, 'string', `${id}: chain must be a string when present`);
      assert.equal(token.chain, token.chain.toLowerCase(),
        `${id}: chain must be lowercase — it is a map key in quote.js CHAIN_MAP`);
    }
  }
});

test('a non-token page yields null, never a half-built record', () => {
  // A consumer checks `det && det.address`. A record with a missing address
  // would pass the truthiness test and put `undefined` into a banner fact.
  for (const href of [
    'https://axiom.trade/pulse',
    'https://trade.padre.gg/trenches',
    'https://gmgn.ai/',
    'https://dexscreener.com/gainers',
    'https://fomo.family/u/sometrader',
    'https://pump.fun/board',
  ]) {
    const { token } = detectAt(href);
    assert.equal(token, null, `${href} must return exactly null`);
  }
});

test('Forge reads only fields sites.js guarantees', () => {
  // Scanned from the shipped forge.js rather than described, so this fails if
  // either side moves: if Forge starts reading a field we do not promise, or
  // if a field it reads disappears from the contract above.
  const forge = fs.readFileSync(path.join(ROOT, 'forge.js'), 'utf8');
  const read = new Set([...forge.matchAll(/\bdet\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  assert.ok(read.size > 0,
    'forge.js must still consume detect() through `det.` — if this moved, re-point this test');
  for (const field of read) {
    assert.ok(GUARANTEED_FIELDS.has(field),
      `forge.js reads det.${field}, which sites.js does not guarantee. Either add it to the `
      + 'contract (and produce it in every adapter) or stop reading it.');
  }
  // And the reverse: the fields Forge depends on must actually be produced.
  const { token } = detectAt(`https://fomo.family/tokens/solana/${MINT}`);
  for (const field of read) {
    assert.ok(field in token,
      `forge.js reads det.${field} but a real detection does not carry it`);
  }
});

test('Forge never has to invent a chain for a token we detected', () => {
  // Forge's fallback is `det.chain || (det.kind === 'pair' ? '' : 'solana')`.
  // That is honest only while a MINT detection without a chain really is
  // Solana. Any adapter that can emit a foreign-chain mint must therefore
  // always carry `chain`, or Forge will state "solana" about a Base token.
  for (const [id, href] of PAGES) {
    const { token } = detectAt(href);
    if (token.kind !== 'mint') continue;
    const forgeWouldSay = token.chain || 'solana';
    assert.equal(forgeWouldSay, 'solana',
      `${id}: a mint detection that omits chain makes Forge assert "solana". `
      + 'If this adapter can ever detect a foreign chain, it must always set chain.');
  }
});
