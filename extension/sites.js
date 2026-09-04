/* PaperTrench — site adapters.
 *
 * Each adapter knows how to figure out WHICH token the user is currently
 * looking at on a given trading site. Almost all of these are SPAs that put
 * either a token mint or an LP/pair address in the URL, so adapters parse the
 * URL first and fall back to scanning for a Solana base58 address as a last
 * resort. The price layer resolves both mints and pair addresses through the
 * free Dexscreener API.
 */
(() => {
  'use strict';

  const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

  /* ---------------- multichain vocabulary ----------------
   *
   * Each terminal spells chains its own way. Adapters translate their site's
   * slug into the CANONICAL name (Dexscreener's chainId vocabulary, which
   * quote.js prices against) so nothing downstream has to know which site a
   * token came from. Every mapping below was verified against the live site
   * on the date noted; an unlisted slug fails closed, because a chain we
   * cannot name is a chain we cannot honestly price.
   */
  const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

  /* ---------------- the multichain gate ----------------
   *
   * SUPERSEDED 2026-09-04 (Terp order, .contracts/validation-contract-multichain.md):
   * the gate is OPEN. Robinhood Chain is popping off (mainnet 7/1/2026, GMGN
   * full support, Axiom 7/11, Lute live; Padre has NO robinhood — it gets
   * ethereum/base/bnb instead) and the demand is heavy. The original 8/6
   * closure waited for per-chain native balances (design B); the intervening
   * sessions hardened design A instead (multichain.test.js: foreign price =
   * priceUsd/solUsd with the rate RECORDED, never the gas-token priceNative;
   * refusal memory; D-62 fallback lane), so the wallet books foreign fills
   * honestly in derived SOL today. Design B remains a future MIGRATION of the
   * book model — it does not gate this feature anymore.
   *
   * What stays true from the original decision:
   *   - Every route SHAPE is still validated per chain (O-11 survives as
   *     shape-strictness: base58 under an EVM slug is refused, hex under the
   *     solana slug is refused, an unknown slug fails closed).
   *   - The whole pricing path (quote.js chain handling, resolver chain
   *     filtering, multichain.test.js) is untouched.
   *   - Foreign chains price from Dexscreener ONLY: Jupiter is SOLANA-ONLY
   *     (resolver.js skips it for foreign tokens), and the Solana RPC pool
   *     never watches a foreign pool — onchainLive stays false and the panel
   *     says so rather than faking it.
   */
  const MULTICHAIN_ENABLED = true;

  /** A chain we are not currently trading is refused at DETECTION, so the
   *  panel never mounts somewhere it cannot honestly keep a book. */
  function chainTradable(chain) {
    return chain === 'solana' || MULTICHAIN_ENABLED;
  }

  // GMGN (live-verified 2026-08-06: all four token pages rendered; robinhood
  // slug live 2026-09-04 — gmgn.ai blog "Robinhood Chain is live on GMGN" and
  // indexed token page gmgn.ai/robinhood/token/0xcd1c…).
  const GMGN_CHAIN_BY_SLUG = { sol: 'solana', eth: 'ethereum', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
  const GMGN_SLUG_BY_CHAIN = { solana: 'sol', ethereum: 'eth', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };

  // fomo (docs/MULTICHAIN.md corpus). Its detect() keeps its own slug as the
  // chain string for continuity with the landed contract, so the reverse map
  // is what a chip needs to build a fomo URL for a foreign-chain position.
  const FOMO_SLUG_BY_CHAIN = {
    solana: 'solana', bsc: 'bnb', bnb: 'bnb', ethereum: 'ethereum',
    robinhood: 'robinhood', base: 'base', monad: 'monad', hyperliquid: 'hyperliquid',
  };

  // Padre (Terminal) — its own slug IS the canonical name (identity map,
  // live-verified 2026-09-04 from padre.gg's chain copy: Solana, Ethereum,
  // Base, BNB — no robinhood).
  const PADRE_CHAIN_BY_SLUG = { solana: 'solana', ethereum: 'ethereum', base: 'base', bnb: 'bsc', bsc: 'bsc' };
  const PADRE_SLUG_BY_CHAIN = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'bnb' };

  // Birdeye (live-verified 2026-08-06): the site MOVED to /<chain>/token/<addr>
  // and 308-redirects the old ?chain= form onto it. Its slugs are already the
  // canonical names, so the map is an identity — but an explicit one, so an
  // unrecognised slug still fails closed.
  const BIRDEYE_CHAIN_BY_SLUG = {
    solana: 'solana', ethereum: 'ethereum', bsc: 'bsc', base: 'base',
    arbitrum: 'arbitrum', avalanche: 'avalanche', optimism: 'optimism', polygon: 'polygon',
  };

  // DexScreener (slugs harvested from its own chain nav, 2026-08-06). These
  // ARE the canonical chainIds — DexScreener is where the price layer looks
  // them up — so the adapter accepts exactly the ones we can price.
  const DEXSCREENER_CHAINS = [
    'solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'avalanche', 'optimism',
    'polygon', 'sui', 'ton', 'tron', 'hyperliquid', 'monad', 'robinhood',
    'unichain', 'sonic', 'cronos', 'pulsechain', 'abstract', 'hyperevm',
  ];
  const DEXSCREENER_CHAIN_BY_SLUG = {};
  for (const c of DEXSCREENER_CHAINS) DEXSCREENER_CHAIN_BY_SLUG[c] = c;

  // Axiom (live-verified 2026-08-07 from a LOGGED-IN capture via pt-recon). A
  // token page is axiom.trade/meme/<address>?chain=<slug> — the chain lives in
  // the QUERY, not the path, so an adapter that ignored ?chain= read every page
  // as Solana. The slugs come straight off the captured URL's chain/pulseChains/
  // trackerChains params: sol, bnb, eth, robinhood (robinhood CONFIRMED
  // shipped 2026-07-11 — chain selector SOL/HOOD/BNB/ETH). Mapped to
  // Dexscreener's canonical chainIds; an unlisted slug fails closed.
  const AXIOM_CHAIN_BY_SLUG = { sol: 'solana', bnb: 'bsc', eth: 'ethereum', robinhood: 'robinhood' };
  const AXIOM_SLUG_BY_CHAIN = { solana: 'sol', bsc: 'bnb', ethereum: 'eth', robinhood: 'robinhood' };

  /**
   * Validate an address against the shape its OWN chain uses, and return the
   * detection record. This is how O-11 survives multichain: instead of one
   * global "must be base58" rule, each chain refuses the other family's
   * shape — so a hex address that happens to pass base58 can never be
   * mistaken for a Solana mint, it simply routes to its own chain.
   */
  function tokenForSlug(slugMap, slug, address, kind) {
    const chain = slugMap[slug];
    if (!chain) return null;
    const shapeOk = chain === 'solana'
      ? SOLANA_ADDRESS_RE.test(address)
      : EVM_ADDRESS_RE.test(address);
    if (!shapeOk) return null;
    // Shape is validated BEFORE the gate on purpose: while the gate is closed
    // this is a deliberate, chain-named refusal rather than a lucky parse
    // failure, and when it opens nothing about the shape rules changes.
    if (!chainTradable(chain)) return null;
    return { kind: kind || 'mint', address, chain };
  }

  function firstBase58(text) {
    if (!text) return null;
    BASE58_RE.lastIndex = 0;
    const m = BASE58_RE.exec(text);
    return m ? m[0] : null;
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  // pathTail: returns last non-empty path segment that matches base58
  function pathTail() {
    const parts = location.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const cand = firstBase58(parts[i]);
      if (cand) return cand;
    }
    return null;
  }

  const ADAPTERS = [
    {
      id: 'axiom',
      name: 'Axiom',
      // Axiom routes by pair address; fall back to its token search by mint.
      // MULTICHAIN: the chain rides the query — axiom's own slug vocabulary
      // (AXIOM_SLUG_BY_CHAIN), no ?chain= meaning Solana, matching detect().
      tokenUrl: (mint, pairAddress, chain) => {
        const slug = AXIOM_SLUG_BY_CHAIN[chain || 'solana'] || 'sol';
        return pairAddress
          ? 'https://axiom.trade/meme/' + pairAddress + '?chain=' + slug
          : 'https://axiom.trade/t/' + mint + '?chain=' + slug;
      },
      match: (h) => /(^|\.)axiom\.trade$/.test(h),
      // axiom.trade/meme/<address>?chain=<slug> (a pair page) and
      // axiom.trade/t/<address>?chain=<slug> (a mint). The chain lives in the
      // QUERY — verified live logged-in 2026-08-07 (pt-recon): the captured URL
      // was /meme/<addr>?chain=sol&pulseChains=sol,robinhood,bnb&trackerChains=
      // sol,robinhood,bnb,eth. No ?chain= means Solana, so old links still work.
      //
      // No bare path-tail fallback: Axiom's wallet-tracker and profile routes
      // also end in base58 addresses, and treating those as tokens pinned the
      // panel open on non-trading pages forever (DEFECTS O-10/O-11). The /t/
      // route carries a MINT and used to be mislabeled as a pair (O-13); those
      // kinds are UNCHANGED here — the capture confirmed the routes, not a new
      // pair/mint split, so this pass adds chain-awareness and nothing else.
      //
      // O-11 survives multichain the same way it does on GMGN/fomo: the slug
      // picks the shape (sol=base58, bnb/eth/robinhood=0x40-hex) and refuses the
      // other family, and a foreign chain is DECLINED by chainTradable() while
      // the multichain gate is shut — recognised and refused, never misparsed.
      detect: () => {
        const slug = queryParam('chain') || 'sol';
        const meme = location.pathname.match(/^\/meme\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (meme) return tokenForSlug(AXIOM_CHAIN_BY_SLUG, slug, meme[1], 'pair');
        const t = location.pathname.match(/^\/t\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (t) return tokenForSlug(AXIOM_CHAIN_BY_SLUG, slug, t[1], 'mint');
        return null;
      },
      // Pulse / Discover rows carry anchors to /meme/<pair> plus small
      // pump.fun icon links; the row's own instant-buy button is the anchor
      // point for the chip (inserted just left of it).
      rowBuy: {
        listPaths: /^\/(pulse|discover)?\/?$/,
        linkSelectors: ['a[href^="/meme/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        placement: 'before-buy-button',
        // The instant-buy pill reads "0 SOL" / "0.5 ETH" (older UI: "Buy x SOL").
        buyButtonPattern: '^(Buy\\s|[\\d.,]+[KMB]?\\s*(SOL|ETH|BNB|USD)$)',
        containerMode: 'group',
        kind: 'pair',
      },
    },
    {
      id: 'padre',
      name: 'Padre / Terminal',
      // MULTICHAIN (2026-09-04): Padre (Terminal) trades Solana, Ethereum,
      // Base and BNB (its own copy + docs) — NO robinhood. A position's chain
      // picks the slug; solana keeps the historical route shape.
      tokenUrl: (mint, pairAddress, chain) => 'https://trade.padre.gg/trade/'
        + (PADRE_SLUG_BY_CHAIN[chain || 'solana'] || 'solana') + '/' + (pairAddress || mint),
      match: (h) => /(^|\.)padre\.gg$/.test(h),
      // trade.padre.gg/trade/<chain>/<address> (and legacy /trade/solana/<mint>
      // plus legacy terminal routes). Only /trade/ and /terminal/ routes are
      // token pages — Padre's wallet, portfolio and leaderboard routes also
      // end in base58 addresses and must never mount the panel (O-10/O-11).
      // Multichain: the chain slug is part of the address grammar now —
      // a slug we cannot name fails closed (tokenForSlug), and each slug
      // takes ONLY its own chain's address shape.
      detect: () => {
        // /trade/<chain>/<addr> — the multichain grammar. Each slug takes ONLY
        // its own chain's address shape; an unknown slug fails closed.
        const m = location.pathname.match(/^\/(?:trade|terminal)\/([a-z0-9-]+)\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (m) return tokenForSlug(PADRE_CHAIN_BY_SLUG, m[1], m[2]);
        // /trade/<base58> with NO chain segment — the SHIPPED shape (Padre's
        // own Trenches links and every position chip built before this change
        // use it; the old adapter only ever knew this form). Solana.
        const t = location.pathname.match(/^\/trade\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[\/?#])/);
        if (t) return { kind: 'mint', address: t[1], chain: 'solana' };
        // Legacy /terminal/<mint> without a chain segment: Solana.
        const u = location.pathname.match(/^\/terminal\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[\/?#])/);
        return u ? { kind: 'mint', address: u[1], chain: 'solana' } : null;
      },
      // Trenches cards link (absolute) to the token's trade page and also
      // carry pump.fun icon links.
      rowBuy: {
        listPaths: /^\/(trenches|terminal|feed)?\/?$/,
        linkSelectors: ['a[href*="/trade/solana/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        // Every Trenches card has Padre's own SOL quick-buy pill at the
        // bottom — the chip sits immediately left of it, covering nothing.
        placement: 'before-buy-button',
        buyButtonPattern: '\\bSOL\\b',
        containerMode: 'heuristic',
        kind: 'mint',
      },
    },
    {
      id: 'photon',
      name: 'Photon',
      tokenUrl: (mint, pairAddress) => (pairAddress
        ? 'https://photon-sol.tinyastro.io/en/lp/' + pairAddress
        : 'https://photon-sol.tinyastro.io/en/r/' + mint),
      match: (h) => /(^|\.)tinyastro\.io$/.test(h),
      // photon-sol.tinyastro.io/en/lp/<pairAddress> and /en/r/<mint> — the
      // second is Photon's own mint-route shape, which tokenUrl() emits when
      // no pair is known; not detecting it meant the extension could navigate
      // a user to a page it then refused to recognize (DEFECT O-12).
      detect: () => {
        const lp = location.pathname.match(/\/lp\/($|[A-Za-z0-9]+)/);
        const lpAddr = lp && lp[1] && firstBase58(lp[1]);
        if (lpAddr) return { kind: 'pair', address: lpAddr };
        const r = location.pathname.match(/\/r\/($|[A-Za-z0-9]+)/);
        const rAddr = r && r[1] && firstBase58(r[1]);
        if (rAddr) return { kind: 'mint', address: rAddr };
        return null;
      },
    },
    {
      id: 'gmgn',
      name: 'GMGN',
      // MULTICHAIN: a chip returns to the chain its position was opened on.
      tokenUrl: (mint, pairAddress, chain) => 'https://gmgn.ai/'
        + (GMGN_SLUG_BY_CHAIN[chain || 'solana'] || 'sol') + '/token/' + mint,
      match: (h) => /(^|\.)gmgn\.ai$/.test(h),
      // gmgn.ai/<chainSlug>/token/<addr>. All four slugs were rendered live
      // on 2026-08-06 (sol/eth/bsc/base — GMGN's own copy says "Solana, BSC,
      // Base, and Ethereum"), so EVM token pages mount instead of being
      // refused (maintainer order, docs/MULTICHAIN.md).
      //
      // O-11 survives multichain as SHAPE-STRICTNESS PER SLUG rather than as
      // a Solana-only gate: the sol slug takes base58 only, an EVM slug takes
      // 0x40-hex only, and an unknown slug fails closed. That is strictly
      // safer than before — an EVM address whose hex passes base58 (~13% of
      // them) used to reach the SOLANA resolver; now it can only ever be
      // priced on its own chain. Wallet-analysis routes (/sol/address/<w>)
      // still never mount (O-10).
      detect: () => {
        const m = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (!m) return null;
        return tokenForSlug(GMGN_CHAIN_BY_SLUG, m[1], m[2]);
      },
      // Trenches is GMGN's home feed; cards navigate by JS but carry
      // pump.fun/coin/<mint> icon links (and some /sol/token/ anchors).
      rowBuy: {
        listPaths: /^\/(trenches)?\/?$/,
        linkSelectors: ['a[href*="/sol/token/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        placement: 'badge',
        containerMode: 'heuristic',
        kind: 'mint',
      },
    },
    {
      id: 'bullx',
      name: 'BullX NEO',
      tokenUrl: (mint, pairAddress) => 'https://neo.bullx.io/terminal?chainId=1399811149&address=' + (pairAddress || mint),
      match: (h) => /(^|\.)bullx\.io$/.test(h),
      // bullx.io/terminal?chainId=...&address=<pair>. The address param must
      // be a WHOLE base58 value: an EVM 0x address can contain a 32+ char
      // base58 run inside it (~13% of addresses) and used to be sent to the
      // Solana resolver as a pair (DEFECT O-11). Solana's chainId is
      // 1399811149; any other explicit chainId is not ours.
      detect: () => {
        const chainId = queryParam('chainId');
        if (chainId && chainId !== '1399811149') return null;
        const param = queryParam('address') || '';
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(param)) return null;
        return { kind: 'pair', address: param };
      },
    },
    {
      id: 'dexscreener',
      name: 'Dexscreener',
      tokenUrl: (mint, pairAddress, chain) => 'https://dexscreener.com/'
        + (DEXSCREENER_CHAIN_BY_SLUG[chain] || 'solana') + '/' + (pairAddress || mint),
      match: (h) => /(^|\.)dexscreener\.com$/.test(h),
      // dexscreener.com/<chain>/<pairAddress> (live-verified 2026-08-06).
      // DexScreener's slugs ARE the chainIds the price layer queries, so the
      // adapter accepts exactly the chains we can actually price and fails
      // closed on anything else. Requiring a whole address in the second
      // segment is also what keeps utility routes (/gainers, /watchlist,
      // /multicharts) from ever mounting the panel (O-10), and per-chain
      // shape strictness replaces the old Solana-only prefix gate (O-11).
      detect: () => {
        const m = location.pathname.match(/^\/([a-z0-9]+)\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (!m) return null;
        return tokenForSlug(DEXSCREENER_CHAIN_BY_SLUG, m[1], m[2], 'pair');
      },
    },
    {
      id: 'birdeye',
      name: 'Birdeye',
      tokenUrl: (mint, pairAddress, chain) => 'https://birdeye.so/'
        + (BIRDEYE_CHAIN_BY_SLUG[chain] ? chain : 'solana') + '/token/' + mint,
      match: (h) => /(^|\.)birdeye\.so$/.test(h),
      // birdeye.so/<chain>/token/<addr> — the LIVE scheme as of 2026-08-06.
      //
      // Birdeye moved off `?chain=` and now 308-redirects that form onto the
      // path form, which had quietly turned our chain gate into DEAD CODE:
      // the guard read a query parameter the site no longer emits, so the
      // only thing keeping an EVM address out of the Solana resolver was hex
      // failing base58 — which our own O-11 note puts at ~13% of addresses.
      // The chain now comes from the path and decides the address shape, so
      // an EVM page is either priced on its own chain or not at all.
      //
      // The legacy /token/<addr>?chain=<c> form is still accepted for old
      // links and bookmarks. Profile routes never mount (O-10).
      detect: () => {
        const live = location.pathname.match(/^\/([a-z0-9]+)\/token\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (live) return tokenForSlug(BIRDEYE_CHAIN_BY_SLUG, live[1], live[2]);
        const legacy = location.pathname.match(/^\/token\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (!legacy) return null;
        const slug = (queryParam('chain') || 'solana').toLowerCase();
        return tokenForSlug(BIRDEYE_CHAIN_BY_SLUG, slug, legacy[1]);
      },
    },
    {
      id: 'jupiter',
      name: 'Jupiter',
      tokenUrl: (mint) => 'https://jup.ag/swap?inputMint=' + WSOL_MINT + '&outputMint=' + mint,
      match: (h) => /(^|\.)jup\.ag$/.test(h),
      // jup.ag/swap/SOL-<mint>, jup.ag/tokens/<mint>, or the newer
      // ?inputMint=...&outputMint=... form. After redirects the page may rewrite
      // itself to ?buy=...&sell=... (usually SOL/USDC), so prefer the original
      // output/input token and ignore stable/quote addresses.
      detect: () => {
        const pathBase58 = /^\/(?:swap|tokens|limit|dca)\//.test(location.pathname)
          ? firstBase58(location.pathname)
          : null; // portfolio/<wallet> and other routes are not token pages (O-10)
        const candidates = [
          firstBase58(queryParam('outputMint') || ''),
          firstBase58(queryParam('inputMint') || ''),
          firstBase58(queryParam('buy') || ''),
          firstBase58(queryParam('sell') || ''),
          pathBase58,
        ].filter(Boolean);
        const tok = candidates.find((addr) => !QUOTE_MINTS.has(addr)) || null;
        return tok ? { kind: 'mint', address: tok } : null;
      },
    },
    {
      id: 'fomo',
      name: 'Fomo',
      // MULTICHAIN: fomo speaks its own slugs, so a chip for an EVM position
      // must translate back into them — /tokens/solana/<0x…> is a dead page.
      tokenUrl: (mint, pairAddress, chain) => 'https://fomo.family/tokens/'
        + (FOMO_SLUG_BY_CHAIN[chain || 'solana'] || 'solana') + '/' + mint,
      match: (h) => /(^|\.)fomo\.family$/.test(h),
      // fomo.family/tokens/<chainSlug>/<tokenAddress>. The route shape and
      // the live URL corpus are in docs/MULTICHAIN.md (harvested from the
      // real site 2026-08-05: solana=base58, robinhood/bnb/ethereum=0x40hex).
      // MULTICHAIN (maintainer order): every corpus slug mounts the panel,
      // with per-chain address validation — the O-11 rule survives as
      // shape-strictness per slug: a solana slug never accepts an EVM run,
      // an EVM slug never accepts base58. Profile and user routes
      // (/u/<handle>, /profile/<handle>) and ticker-slug /prices/ pages
      // carry handles and tickers, not mints, and never mount (O-10).
      detect: () => {
        const m = location.pathname.match(/^\/tokens\/([a-z-]+)\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (!m) return null;
        const chain = m[1];
        const addr = m[2];
        if (chain === 'solana') {
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return null;
          return { kind: 'mint', address: addr, chain: 'solana' };
        }
        const EVM_SLUGS = ['base', 'monad', 'bnb', 'ethereum', 'hyperliquid', 'robinhood'];
        if (EVM_SLUGS.indexOf(chain) < 0) return null;
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
        // Gated off for v3.0.0 — see MULTICHAIN_ENABLED above. fomo is the
        // chain-densest terminal (its own /token entry lands users on EVM
        // pages routinely), so this branch is where the gate is felt most.
        if (!chainTradable(chain)) return null;
        return { kind: 'mint', address: addr, chain };
      },
    },
    {
      id: 'pumpfun',
      name: 'Pump.fun',
      tokenUrl: (mint) => 'https://pump.fun/coin/' + mint,
      match: (h) => /(^|\.)pump\.fun$/.test(h),
      // pump.fun/coin/<mint>, plus the legacy bare /<mint> route. Pump.fun
      // was in the product description from day one but had NO adapter — it
      // fell to the generic fallback (DEFECT F-24).
      detect: () => {
        const m = location.pathname.match(/^\/coin\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'mint', address: addr };
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length === 1 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[0])) {
          return { kind: 'mint', address: parts[0] };
        }
        return null;
      },
    },
    {
      id: 'lute',
      name: 'Lute',
      tokenUrl: (mint) => 'https://lute.gg/trade/' + mint,
      match: (h) => /(^|\.)lute\.gg$/.test(h),
      // lute.gg/trade/<base58Address> — Solana token page. Named routes
      // under /trade/ (compass, momentum, portfolio, discover) and non-trade
      // routes (/, /login, /signup) are never token pages (O-10). The
      // {32,44} length constraint naturally rejects short named routes.
      //
      // Lute supports Robinhood Chain + ETH as a VENUE (its own X, 2026),
      // but its public token-URL shape for foreign chains is NOT verifiable
      // without an account: every /trade/<addr> 307s to /login anonymously
      // (probed 2026-09-04, both a Solana mint and an 0x address — same
      // redirect). Guessing the shape would be the O-11 failure class, so
      // detection stays Solana-only; foreign-chain positions still LINK to
      // Lute through the generic rule only if a future session verifies it.
      detect: () => {
        const m = location.pathname.match(/^\/trade\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[\/?#])/);
        return m ? { kind: 'mint', address: m[1], chain: 'solana' } : null;
      },
    },
  ];

  function currentSite() {
    const h = location.hostname.replace(/^www\./, '');
    for (const a of ADAPTERS) {
      try {
        if (a.match(h)) return a;
      } catch (e) { /* ignore */ }
    }
    // Generic fallback: any page; treat last base58 in URL as a candidate mint.
    return {
      id: 'generic',
      name: h || 'Unknown site',
      match: () => true,
      detect: () => {
        const tail = firstBase58(location.href);
        // Avoid matching random hashes in fragments that aren't tokens; caller
        // verifies candidates against Dexscreener before accepting.
        return tail ? { kind: 'mint', address: tail } : null;
      },
      // Unknown host: Dexscreener always resolves a Solana mint.
      tokenUrl: (mint, pairAddress) => 'https://dexscreener.com/solana/' + (pairAddress || mint),
    };
  }

  /**
   * Where a positions-bar chip should navigate for a given token.
   *
   * Preference order: the site the position was opened on, then the site the
   * user is currently on, then Dexscreener. Keeping the position's own site
   * first means a chip opened on Photon returns to Photon, which is where its
   * chart and the user's muscle memory already are.
   */
  function tokenUrlFor(mint, opts) {
    if (!mint) return null;
    const options = opts || {};
    const wanted = options.siteId;
    const pairAddress = options.pairAddress || null;
    // MULTICHAIN: the position's chain rides along, because a chip that
    // returns to the wrong chain is a link to a different token. Absent a
    // chain the answer stays exactly what it has always been: Solana.
    const chain = options.chain || 'solana';

    let adapter = null;
    if (wanted) adapter = ADAPTERS.find((a) => a.id === wanted) || null;
    if (!adapter && options.fallbackSite && typeof options.fallbackSite.tokenUrl === 'function') {
      adapter = options.fallbackSite;
    }

    if (adapter && typeof adapter.tokenUrl === 'function') {
      try {
        const url = adapter.tokenUrl(mint, pairAddress, chain);
        if (url) return url;
      } catch (e) { /* fall through to the universal link */ }
    }
    // The universal link must name the token's own chain too — DexScreener
    // is multichain, and /solana/<evm address> is a page about nothing.
    const fallbackChain = DEXSCREENER_CHAIN_BY_SLUG[chain] || 'solana';
    return 'https://dexscreener.com/' + fallbackChain + '/' + (pairAddress || mint);
  }

  const api = { ADAPTERS, currentSite, firstBase58, BASE58_RE, tokenUrlFor };
  if (typeof window !== 'undefined') window.PaperTrenchSites = api;
  if (typeof self !== 'undefined') self.PaperTrenchSites = api;
})();
