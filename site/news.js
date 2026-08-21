/* PaperTrench — news hub: the release archive.
 *
 * Every shipped version, newest first. This array is the ONLY thing that has
 * to change when a release goes out: add an entry at the top and the timeline,
 * the filters and the counts all follow.
 *
 * Rules for entries, so the archive stays worth trusting:
 *   - `v` and `date` must match the CHANGELOG.md heading exactly.
 *   - `points` are user-facing outcomes, not commit summaries.
 *   - No number appears here that isn't in the changelog. A patch-notes page
 *     that inflates its own numbers is the same failure as a terminal that
 *     inflates a fill price.
 *   - An entry appears only once the thing has actually SHIPPED. The extension
 *     ships by git tag; a version sitting in the changelog untagged is not a
 *     release and must not be logged here. (v2.11.1 is exactly that case at the
 *     time of writing — written up, not tagged, deliberately absent below.)
 *
 * Website releases carry `site: true` instead of a version, because the site
 * deploys continuously and has no version to name. They get a "Website" chip
 * rather than a `v…` one — inventing a version number for them, or filing them
 * under the next extension version, would both claim something untrue about
 * what a user has installed.
 *
 * tags: 'feature' | 'fix' | 'security' | 'speed'  (a release can carry several)
 */
(() => {
  'use strict';

  const RELEASES = [
    {
      v: '3.9.3', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'The discipline co-crown — P&L’s quiet rival',
      blurb: 'The KPI row now grades your process, not just your money. Lifetime discipline letter (S–D) with the honest /4 average sits right next to Realized P&L, same visual weight. Green letters mean the process holds when the tape goes against you.',
      points: [
        '<b>Co-crown, not replacement.</b> PnL KPIs stay exactly where they were; discipline joins them at equal weight. One is outcome, one is process — the product refuses to crown only one.',
        '<b>Lifetime average.</b> Every closed round graded through the same roundGrade engine the journal uses, letter-banded S/A/B/C/D with thresholds at 3.5/2.5/1.5/0.5.',
        '<b>Honest empty state.</b> No graded rounds yet → em-dash, never a fake B.',
        '<b>5 new tests</b> (1,636 total): KPI placement, derivation contract, em-dash branch, PnL-not-replaced guard, stable letter colors.',
      ],
    },
    {
      v: '3.9.2', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature', 'social'],
      title: 'Season share cards — no spoilers, all tease',
      blurb: 'The Wordle play: one image, legible in two seconds, and it never spoils. No PnL on the card, by construction — status word, three gate dots (count the filled ones), and the discipline lines. What you did with the money is your story for the replies.',
      points: [
        '<b>Spoiler-free by construction.</b> The card source has no PnL fields at all; the painter literally cannot draw what it never receives. Tests enforce it.',
        '<b>Three gate dots.</b> ● for each gate cleared. Which one is missing is your reply bait — the card never names it.',
        '<b>Share mid-season.</b> The session panel grows a Share card button while a season (or survival run) is active; busted survival cards wear the elimination line in red.',
        '<b>12 new tests</b> (1,631 total): spoiler-free contract on source and painter, gate dots, status text/colors, honest em-dashes, dashboard wiring.',
      ],
    },
    {
      v: '3.9.1', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature', 'game'],
      title: 'Survival Season — same belt, no net',
      blurb: 'The Trench Season with the safety off. Same three gates, same 7-day window — but drop to 20% of your season-start equity and you are eliminated on the spot: busted, no belt, season over. The line is reconstructed from your journal; nothing extra is tracked.',
      points: [
        '<b>20% is the line.</b> Equity at season start is reconstructed (cash then + entry cost of then-open positions); fall to a fifth of it and the season ends immediately.',
        '<b>The standard season is untouched.</b> Blow the whole account in a regular season and the gates just keep watching — survival is strictly opt-in.',
        '<b>5 new tests</b> (1,619 total): win-riding-the-line, bust-at-20%, red-but-alive, gates-won-near-line, standard-season isolation.',
      ],
    },
    {
      v: '3.9.0', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature', 'game'],
      title: 'Trench Season — the week-long league',
      blurb: 'A 7-day league over discipline, never profit. Opt in from the Game tab; the season watches your whole week through three gates: 10+ rounds played, 80%+ journaled, average grade B or better. Meet all three and the belt is yours immediately — the window stays open to raise the score. Miss them when it closes and the season files as missed: no extensions, same rules as the market.',
      points: [
        '<b>Three gates, one belt.</b> Volume (played), habit (journaled), quality (graded). All three in 7 days = won. The belt banks the moment you qualify — everything after is score polish.',
        '<b>Past belts derive from your journal.</b> Nothing extra is stored; any qualifying 7-day window in your history counts. A dominant fortnight banks two belts.',
        '<b>The HUD rides along.</b> ⚔ SEASON 6/10 on the chart while you trade; terminal states announce once, stay until dismissed.',
        '<b>7 new tests</b> (1,614 total): gate logic, window exclusion, miss-on-close, belt derivation, short-journal safety.',
      ],
    },
    {
      v: '3.8.2', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'The streak learns to burn — Ember, Flame, Blaze, Torch',
      blurb: 'Discipline streaks now climb a ladder instead of counting forever into the dark. Ember at 3, Flame at 7, Blaze at 14, Torch at 30. The chip wears the tier\u2019s glyph; the tooltip says how far to the next rung. Same doctrine as ever: streaks count discipline \u2014 journaled rounds, clean exits \u2014 never profit.',
      points: [
        '<b>Tier glyphs on the bar chip.</b> Ember (a coal), Flame, Blaze, Torch \u2014 identity you can see from across the screen, inline SVG so it stays crisp.',
        '<b>The next rung is always visible.</b> Hover the chip: \u201c2 to Flame\u201d. Duolingo\u2019s lesson is that the streak \u2014 not its difficulty \u2014 is what keeps people coming back.',
        '<b>5 new tests</b> (1,607 total): tier thresholds, rung distance, break-and-recover, unknown-kind safety, monotonic tiers.',
      ],
    },
    {
      v: '3.8.1', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'Your trench, your colors — panel themes',
      blurb: 'The overlay learns to match the dex you live in. Trench (default amber-on-slate), Lute (deep indigo, violet accents), and Solana (terminal green). Settings \u2192 Trade \u2192 Panel theme; it switches live, no reload, and the site\u2019s own page is never touched \u2014 only the panel\u2019s colors.',
      points: [
        '<b>Three skins.</b> Trench stays the default; Lute was asked for by a trader who lives there; Solana wears the network\u2019s phosphor green.',
        '<b>Live switch, no reload.</b> Theme rides a host attribute the panel\u2019s design tokens read \u2014 changing it never rebuilds the overlay, so nothing flickers mid-trade.',
        '<b>8 new tests</b> (1,602 total): theme contracts, color-safety (every override is a design token; the host page is provably untouched).',
      ],
    },
    {
      v: '3.8.0', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'The trainer that tells the truth — fees on the card, the chart you never saw',
      blurb: 'Two asks from the research pass. Every PnL card now prints the round trip\u2019s total simulated fees, so a 3x that nets 2.4x is explained on the artifact itself. And a one-tap list buy now opens the token\u2019s chart in a background tab — the position is one click from management.',
      points: [
        '<b>Fee honesty on the share card (#31 cousin).</b> The journey line now reads INCL 0.040 SOL FEES when the round recorded fees — the number is the journal\u2019s own sum, never invented. Rounds that predate fee recording stay fee-silent.',
        '<b>Chart tab after a list buy (#29).</b> A quick-buy chip on a screener list opens a NEW position whose chart you never saw. The chart opens backgrounded, on the site the position was opened on, never stealing focus. Off switch in Settings \u2192 Trade.',
        '<b>7 new tests</b> (1,594 total): list-chip tab behavior and card fee honesty.',
      ],
    },
    {
      v: '3.7.0', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'The update nudge — fixes can now reach the people who reported the bugs',
      blurb: 'Several field reports this week described bugs that were fixed days earlier — stale installs, no discovery path. PaperTrench ships as a zip, so Chrome never auto-updates it. The popup now checks GitHub once a day and tells you when a new release is out.',
      points: [
        '<b>One amber banner in the popup</b> when a newer release exists: the version, one line, a direct download link. Checked at most once a day, quiet after you dismiss it until the next release, and invisible when anything goes wrong — offline or rate-limited looks exactly like the old popup.',
      ],
    },
    {
      v: '3.6.1', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature'],
      title: 'Where your SOL sits — now on the stream overlay',
      blurb: 'ark_trades13 asked in the Discord: “can you get your total amount of SOL… on the display overlay?” The equity number was always there as one figure — the ask was seeing the split. Shipped same-day.',
      points: [
        '<b>The stream overlay shows the split now.</b> Two new tiles — <b>Cash ◎</b> (spendable) and <b>In positions</b> (open value) — beside the position count. Both re-sum to the equity number above them: same formula, so the split can never disagree with the hero. The tile grid went 4-up to a 3×2 so every label keeps its room, in card and bar layouts both.',
      ],
    },
    {
      v: '3.6.0', date: 'Aug 20, 2026', iso: '2026-08-20',
      tags: ['feature', 'fix'],
      title: 'The feedback batch — four UI asks and the three crash-level bugs',
      blurb: 'You talked in the Discord, we shipped: lifetime flow numbers whilst trading, thicker order lines, a quick-buy chip that stops covering the market cap — and the three bugs that made fills lie: snipes filling on one lagging quote, dead bags rendering gloriously green after a rug, and armed buys vanishing at pump.fun graduation.',
      points: [
        '<b>See how much you’ve bought, held, and sold — whilst trading.</b> Lifetime flow numbers are now on the dashboard sidebar and in the popup. Bought and sold are the order sizes you placed (not fee-shrunk); held is the surviving cost of open positions. Old wallets get correct numbers with no migration.',
        '<b>Thicker order lines.</b> TP/SL and average lines have a width setting (1–4 px) for dense charts — and changing it redraws lines you already placed.',
        '<b>The quick-buy chip no longer sits on top of the market cap</b> in ultra terminal format. It checks where it’s about to paint and drops to the bottom-right gutter if it would cover the row’s own content — on every site we inject into. Prefer it pinned there forever? New setting: chip placement → bottom-right.',
        '<b>Quick-buy chip size and position are both controllable now</b> — the size slider stays, placement is new.',
        '<b>A fresh-launch snipe no longer fills on the first price it sees.</b> Reported again and again: a snipe on a 20k-MC coin recorded at 6k. At bootstrap the first quote had nothing to disagree with, so it witnessed itself. An armed buy now needs corroboration — a second accepted tick or an independent resolver quote — before it may fill; a lone quote leaves the intent armed until its own TTL expires it visibly. Never a fill on a guess.',
        '<b>A dead bag can no longer render gloriously green.</b> The coin rugs, the pool drains to dust, and the next print out of that dust pool used to re-mark your open bag at an absurd price — “from 2.7 to +300”. You cannot sell into a drained pool at a higher price, so an up-print beyond +25% from a collapsed pool (under $2k liquidity) is refused and the position keeps its last honest mark. Down-prints always pass — a rug is supposed to hurt.',
        '<b>Your armed buy and your bag survive graduation.</b> When a pump.fun coin graduates, the terminal redirects to the pool page under a new address — and anything filed under the curve’s stand-in address was dropped in the move, as if you never armed or bought. The armed order and the position now ride across the redirect when the pool provably resolves to the same base coin, rekeyed to the real mint — and the armed buy revives and fires at the pool’s first honest quote. A different coin never inherits anything.',
      ],
    },
    {
      v: '3.5.0', date: 'Aug 11, 2026', iso: '2026-08-11',
      tags: ['fix', 'security'],
      title: 'The Arena repair — submissions accepted again, and the pipeline audited for prize money',
      blurb: 'The leaderboard broke the day v3.4.0 shipped: every submission was refused over a version stamp while every fill inside it verified. Fixing it became the full adversarial audit the paid tournaments were going to force anyway — eleven defects found, fixed, and locked with tests.',
      points: [
        '<b>Submitting your record works again.</b> A version bump meant for the fill format leaked onto the submission envelope, so the server refused every v3.4.0 sync as a format it didn’t know — the board sat empty while the chains inside were flawless. The two version numbers are now separate contracts, the server accepts the mislabeled exports already in the wild, and regression tests pin both sides so this class of break can’t ship twice.',
        '<b>Fresh-launch records rank correctly.</b> A position bought under a pool’s stand-in address and renamed to the real mint mid-round used to lose its exit on the server: the round never closed, and P&L, win rate and round count all understated — for exactly the traders who live on fresh launches. Every server walk now follows the same hash-committed session thread the engine itself uses, so a rename never orphans a round.',
        '<b>Cheating got materially harder, ahead of real prize money.</b> A fill’s committed cash must now be consistent with its own committed price (no more sells that “received” 25× their value), Sprint/duel/clan baselines derive purely from hash-committed fields (editing the unhashed copies used to inflate every windowed return), and fills are priced against the chain they committed to — failing closed on anything the verifier can’t check.',
        '<b>The board is fair at scale, and boring under load.</b> The 500-row cut goes by rank, not recency (past 500 entrants, the season’s best used to silently fall off); ties are deterministic — the earlier verification keeps the rank. Re-syncing an unchanged record is a no-op instead of a verification reset, everything a submission changes commits in one transaction, the rate limit is one atomic statement, and a record whose market data won’t load steps aside with a recorded reason instead of pinning the verification queue.',
        '<b>“Extension not detected” fixed for big records.</b> The Arena gave the extension 1.5 seconds to answer, but building the attestation for a long journal takes longer — so the more you traded, the more certainly the site said the extension wasn’t installed. Record requests now get the time they need; the quick presence check stays quick.',
      ],
    },
    {
      v: '3.4.0', date: 'Aug 11, 2026', iso: '2026-08-11',
      tags: ['fix', 'feature', 'speed'],
      title: 'Your entry is the number you clicked on',
      blurb: 'Every fix traces to one Discord feedback thread: entries that didn’t match the click, a hot bar disagreeing with the trade panel, positions that “wiped like I never bought” — plus instant thesis journaling with a chart snap, inside the trader.',
      points: [
        '<b>Fills price at the number on your screen.</b> A fill used to ask the chain first and let it price the trade whenever it sat within 6% of a fresh on-screen quote — so your recorded average entry routinely landed a few percent above or below the price you actually acted on. Now a sub-second-fresh on-screen price fills the trade, full stop; the chain prices fills only when the screen has gone quiet, and every candidate still passes the fill witness before it becomes money. Fresh-screen fills also skip the chain round trip entirely, so the common fill got faster on exactly the launches that move too fast.',
        '<b>The position that “wiped like you never bought” is fixed.</b> On pair-URL sites a fresh launch trades under the pool’s stand-in address until the coin’s real mint is discovered — and a buy made in that window vanished from the card the moment the coin learned its real name. The whole live record (position, armed orders, alerts, post-exit watch, the chart’s average-entry line) now follows the coin across that rename. Journal history is never rewritten — those rows are cryptographically attested — so round arithmetic matches fills by session instead.',
        '<b>The hot bar and the trade panel agree about your P&L.</b> The positions bar could keep marking the coin on your screen from an aggregator quote cached minutes ago while the panel marked the same bag from the live page feed — same position, two venues, two P&Ls. The bar now prices the on-screen coin from the same live feed the panel uses.',
        '<b>Instant thesis with a chart snap, inside the trader.</b> No separate tab: the ＋ Why this trade? composer in the instant trader now snaps the chart exactly as you see it and files the frame with your thesis — on by default when you save, one tap to opt out, honest about failures. Snaps land in the coach gallery and session replays, joined to the round they belong to.',
        '<b>Also first tagged build to carry:</b> the prediction-market engine (Kalshi, Polymarket, Hyperliquid outcomes, Limitless — written up under v3.3.0, shipping now), the launch-tweet hover card on verified quick-buy pills, and every defect closed since v3.2.2 — the register’s full sweep is in DEFECTS.md.',
      ],
    },
    {
      v: '3.2.1', date: 'Aug 7, 2026', iso: '2026-08-07',
      tags: ['fix', 'speed'],
      title: 'The last launchpad dead end, closed same-day',
      blurb: 'Fresh launches from launchpads we can’t decode still get their identity instantly — reported on Discord in the afternoon, shipped by evening.',
      points: [
        '<b>Unknown pools give up the coin’s identity and real supply.</b> On pair-address pages (Axiom’s /meme/), a brand-new coin whose pool belongs to a launchpad without a verified decoder used to be a full dead end: no price, and no mint either, so nothing could bootstrap. The vault scan now recovers identity and measured supply from any pool — those are protocol facts — and the page’s own feed prices the coin under the usual sanity discipline.',
        '<b>Price retries ask by mint, not by pool.</b> Aggregators index a fresh launch’s mint within seconds; the pool endpoint waits for the pool to be noticed. Once the coin is identified, retries switch to the fast question.',
        '<b>What still gets refused, on purpose:</b> the unverified pool’s own price. Bonding curves price on virtual reserves, so a vault ratio from an unknown layout would be an invented number — and an honest blank beats an invented number, every time.',
      ],
    },
    {
      v: '3.2.0', date: 'Aug 7, 2026', iso: '2026-08-07',
      tags: ['feature', 'fix', 'speed'],
      title: 'A twelfth terminal, fill receipts, and the quarter-second first quote',
      blurb: 'lute.gg joins at full parity, every fill now records where its price came from, and a brand-new coin prices in ~200ms — measured live on real launches, not asserted.',
      points: [
        '<b>lute.gg is a supported terminal now, at full parity.</b> Overlay, live fills on the chart, warm links, X-Ray. Lute is a social terminal, so the adapter ships with the pollution guards that keep other people’s entry prices and PnL — every price-shaped number in a holder row — treated as history, never as the market.',
        '<b>Fills carry receipts.</b> Every fill records where its price came from and how old each source was. They already caught a real one: a sell that booked ~20% under the chart (a win rendered as -9.6%) — value-lag wearing a fresh timestamp. The next “my fill was wrong” report comes with evidence attached.',
        '<b>The first quote on a brand-new coin lands in a quarter second.</b> The bottleneck was one silent RPC endpoint eating its full 4-second timeout before failover. The connection pool now hedges — a slow endpoint gets a racing competitor after half a second — and the sniping path stopped re-fetching state it already held. Measured live: 155–245ms on coins 30–74 seconds old, agreeing with an independent source to 0.06%.',
        '<b>If your region’s price connection is slow, PaperTrench tells you — with the fix.</b> Public RPC endpoints throttle by region. When the pool measures itself slow on real evidence, it says so once, with the number and a two-minute guide to a free personal endpoint. Nothing leaves your machine; found and first solved by a community member, credited in the guide.',
        '<b>The OFF switch turns everything off — including paper perps</b> (it used to leave the perps ticket mounted), <b>the speed feature never opens a tab you didn’t click for</b> (pre-created viewer tabs read as a malfunction twice — now every warm viewer is click-created), <b>the stream overlay bar stopped overlapping its own labels</b> in narrow OBS windows, and <b>the Fees &amp; costs dropdown is readable again</b>.',
      ],
    },
    {
      v: '3.1.0', date: 'Aug 6, 2026', iso: '2026-08-06',
      tags: ['fix', 'feature'],
      title: 'The users-found-it batch — every item traces to a named field report',
      blurb: 'Two of these guard the honesty of the numbers themselves: a fill can no longer execute at a resurrected dead price, and rapid buys can no longer vanish and come back wrong.',
      points: [
        '<b>A fill can no longer execute at a resurrected dead price.</b> Field report with screenshots: a coin crashed ~30K → ~8K, the DCA buy filled honestly at the crashed price, and the sell a minute later filled at the pre-crash level — a loss shown as +167%. Any fill price that contradicts what your own screen just accepted as market truth now needs a second, independent source to vouch for it; a refusal names both numbers. A real 4x pump is confirmed by any fresh source and fills normally.',
        '<b>Rapid buys can no longer vanish and come back wrong.</b> Two parts of the extension writing the wallet at the same moment could silently overwrite each other — positions disappeared, then returned with false P&L. Every wallet write now goes through one strictly-ordered commit with conflict detection; a write that loses the race adopts the winner and re-applies itself.',
        '<b>Brand-new coins are tradeable the moment you land on them — whatever launchpad they came from.</b> Every pending address is probed on-chain once: a decodable pool becomes a live price feed with an immediate first quote, and a bare mint gives up its real supply so the site’s own market-cap feed can price a non-pump launch honestly. The probe retries while the coin stays unindexed.',
        '<b>Signing in on the site links the extension by itself</b> — the dashboard’s chip goes green on its own, and one-click Sync now works for unpacked installs too (still behind the off-by-default Site-sync toggle). Chain-conflict rejections on the leaderboard carry a “delete my server record and start over” button.',
        '<b>The sell buttons stopped moving.</b> The P&L number above them wraps and un-wraps as it changes length, which shoved the quick-sell row around under your cursor. The card now reserves that space permanently.',
        '<b>X sign-in on papertrench.com sticks in every browser</b> — the session no longer depends on a cross-domain cookie that Safari, Firefox and private-mode Chromium drop. (Deployed site-side the same day; noted here because the extension release completes the loop.)',
      ],
    },
    {
      v: '3.0.0', date: 'Aug 6, 2026', iso: '2026-08-06',
      tags: ['feature', 'fix'],
      major: true,
      title: 'Paper perps on Hyperliquid and Jupiter — a second asset class',
      blurb: 'Leverage on the venues you actually use, with the venue’s own fees, funding and liquidation math. A major version because a liquidation can take your whole position — a different lesson from spot, announced as one.',
      article: 'news-perps.html',
      points: [
        '<b>Four numbers before every entry.</b> Position size, the fee to open, your liquidation price with how far away it is, and what the position costs per hour to hold. On Hyperliquid the liquidation distance is also shown in ATRs — “1.3 ATR away on the 5m” says whether ordinary noise reaches it.',
        '<b>Real venue costs, not a house average.</b> Hyperliquid’s own taker/maker fees and hourly funding at the live rate; Jupiter’s 6 bps base fee, its price-impact fee, and hourly borrow. If the venue’s live rate can’t be read, the ticket won’t open — a perp without funding is a fantasy where leverage is free.',
        '<b>Liquidation is modelled, not simulated loosely.</b> Isolated margin; Hyperliquid liquidations fill at the trigger and return what survives, Jupiter forfeits remaining collateral, as each venue does it. Away from the tab, funding accrues and gaps settle against the venue’s own history — reconstructed rounds say so, unobserved time is never invented.',
        '<b>Kept apart from your spot record on purpose.</b> A perps dashboard tab with its own balance and rounds; nothing leveraged ever flatters (or damages) the spot record you graduate against. The release notes lead with what perps do <em>not</em> model yet — seven named limits.',
        '<b>Market cap alerts.</b> “Tell me when it hits 500K” — armed from the panel, fires once as a real desktop notification, no position needed, and it reports the cap it actually saw.',
        '<b>Take profits and stops you drag on the chart.</b> The level means the same thing on every axis, and a stop that gaps fills where the market actually was.',
        '<b>Forge and Turbo II ride along</b>, with the fomo honesty pass and fixes: updates no longer half-kill open tabs, Birdeye works again, the entry line stopped teleporting, the Game tab shows up.',
      ],
    },
    {
      site: true, date: 'Aug 6, 2026', iso: '2026-08-06',
      tags: ['feature', 'security'],
      major: true,
      title: 'The Arena is open — and clans arrived with it',
      blurb: 'A leaderboard that cannot be faked: every fill re-hashed, every book replayed, every price re-checked against real market history. Plus team standings that nobody can buy.',
      points: [
        '<b>A verified leaderboard, live at papertrench.com/leaderboard.</b> Standings are recomputed server-side from your raw fills — never from a self-reported number — and every fill is re-priced against the token’s real traded range in that exact minute. Rank is ROI × ln(1+rounds) × discipline, five closed rounds minimum, so one lottery ticket does not top the board.',
        '<b>Only fully verified records take a position.</b> The hash chain proves a history is <em>consistent</em>, not that it happened, and attest.js is open source — so a record the re-pricer could not check is exactly the record a fabricator would build. Anything below verified is shown and labeled, but ranks nowhere. Reported by a user who edited an exported file to hand themselves an absurd P&amp;L.',
        '<b>Clans.</b> Found one or join with an invite code, and trade under a [TAG] that follows your handle across every board. A clan’s number is the <b>mean of its five best members</b>, and your rounds only count <b>from the day you joined</b> — so a lifetime record cannot be recruited in and donated. Extra members are free, so taking in beginners costs a clan nothing; and cutting a struggling member can never raise your score, only cost you the five-member minimum.',
        '<b>The weekly Trench Sprint and head-to-head duels.</b> Both are the same committed chain seen through a different window, so there is no second book to inflate. A duel settles only from a record submitted <em>after</em> its window closes — which kills the one trick the chain cannot: submitting while ahead, then going quiet.',
        '<b>Watch it verify.</b> The board’s hero is the verifier’s live output — chains accepted, records verified, submissions rejected, as they happen. Rejections appear <b>without a handle</b>: an automated verdict can fire on thin candle data as easily as on fraud, and must never publicly brand a named person a cheat.',
        '<b>Public profiles, process-only badges, and self-serve deletion.</b> No badge for profit, win streaks or volume — every one is a process claim carrying the evidence that earned it. Your record reaches the site only when you send it: a JSON export, or the Site sync toggle that is off by default. The extension still never phones home.',
      ],
    },
    {
      v: '2.11.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'fix'],
      title: 'The Game tab — and a round of community fixes',
      blurb: 'Three trading games played on the live charts you already trade, your full trench profile, and fixes straight from the Discord.',
      points: [
        '<b>A Game tab in the dashboard.</b> Your full trench profile: the tier ladder with every gate’s live progress, streaks, reps, the badge case, and your process distribution over the last 30 graded rounds.',
        '<b>Three trading games on live charts.</b> The Gauntlet (ten straight rounds, thesis written, no revenge), One-Shot (one entry, one exit for the whole day, 50%+ captured), Score Attack (best average capture across a 3+ round day). All derived from your journal — no start button, no stored game state, nothing to cheat.',
        '<b>Warm pump.fun/Solscan viewers respect a close</b> (reported by Eyes343): closing a warm viewer sticks — refreshing the DEX no longer reopens it; your next actual click brings it back.',
        '<b>Focus mode, round three</b> (toshi_100x): slimmer header, no subtitle, cost chips collapse — the ✎ still opens the editor.',
        '<b>fomo.family is a supported terminal.</b> Overlay, warm mirror, and X-Ray contract-address recognition on Fomo pages.',
        '<b>On the roadmap by community request</b> (TheRedShark123): a paper copy trader — mirror a wallet into a separate shadow book at your realistically-observed fills and get an honest verdict on whether it’s worth copying.',
      ],
    },
    {
      v: '2.10.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Trench Rank — discipline is now the game',
      blurb: 'Every closed round gets a process grade, S to F. A disciplined red grades S. A lucky win grades F — and gets called lucky.',
      article: 'news-trench-rank.html',
      points: [
        '<b>Process grades on every closed round.</b> Graded on your plan, your exit, your sizing, and whether the entry was revenge — never on P&amp;L. The grade lands on the close toast, the rounds table, the calendar, and the share card.',
        '<b>The Trench Rank ladder.</b> Six tiers from Fresh Meat to Graduated, staged over the graduation criteria with live progress bars. The summit is the graduation bar itself — the game ends on purpose.',
        '<b>Discipline streaks, daily drills, reps and badges.</b> Streak flames from 3 up; one rotating drill a day measured from your actual rounds; reps diminish after 10 a day because tired reps don’t count. Badges exist for the things that predict survival — deliberately none for profit, win streaks, or volume.',
        '<b>Zero new stored data.</b> Everything is derived live from the journal you already have. Your numbers are untouched — this update changes what gets celebrated, not what gets counted.',
        '<b>Also fixed:</b> the graduation bar’s thesis criterion could never pass (it counted a legacy data shape) — real journalers now measure true.',
      ],
    },
    {
      v: '2.9.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'The average line tells the truth again',
      blurb: 'Multichart layouts could land the average line a supply-factor off — and freeze it there.',
      points: [
        '<b>Average fill/exit lines no longer jump to absurd levels on mcap charts.</b> If you ran a multichart layout (or flipped a chart between price and market-cap mode), the level math trusted whichever data series ticked last — even when it was the same token in a different unit. Level math now vets every close by unit before using it, and draws no line at all rather than a wrong one until the right-unit data arrives.',
        '<b>DCA moves the line immediately.</b> Averaging in while the line was still being created no longer leaves it at the old average.',
      ],
    },
    {
      v: '2.9.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'The quick fixes live on the trading tab',
      blurb: 'Lev round two — the quick fixes now live where he meant them.',
      article: 'news-quickedit.html',
      points: [
        '<b>A pencil on the trading panel.</b> The ✎ in the panel header opens a compact inline editor right on the trading tab — buy presets, sell percents, and fee/gas/tip/slippage — with the same validation rulebook the dashboard and popup use. Your costs ride as Fee/Gas/Tip/Slip chips under the buy row, click-to-edit, in both modes.',
        '<b>Focus mode is genuinely Axiom-compact now.</b> No balance card (cash rides inline on the Buy label, refreshed per fill), and while one-tap presets are on the big BUY button gets out of the way — the preset chips ARE the buttons, and Enter in the amount box buys. Instant-buy off keeps the button.',
      ],
    },
    {
      v: '2.8.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'security'],
      title: 'The attestation chain lands whole',
      blurb: 'Update from v2.8.0 — it matters this time.',
      article: 'news-chain.html',
      points: [
        '<b>v2.8.0 shipped with attestation-chain recording broken.</b> That release accidentally carried half of an in-flight migration: fills asked for the new segmented chain store, which was not aboard, so every paper fill made on v2.8.0 failed to append to your local attestation chain. The honest "could not be added to the verification chain" toast fired each time — the failure was visible, the chain simply could not record.',
        '<b>Your wallet, balances and P&amp;L were never affected.</b> The chain is the tamper-evidence layer used by leaderboard verification. On v2.8.1 the chain records again; fills made during the v2.8.0 window are simply absent from it, and the verify panel shows that gap honestly rather than pretending it is not there.',
        '<b>The attestation chain grew up (F-14).</b> It moved out of the wallet state into a single-writer segmented store: a fill rewrites one small tail segment instead of the whole history, multi-tab chain races are gone, and no hash is ever truncated. Backups are downgrade-safe, resets clear the chain atomically with the wallet, and the leaderboard verifier format is unchanged.',
        '<b>For the record: v2.8.0 also contained the Turbo receipts card</b> — the Settings card counting warm vs cold opens, median routing latency and per-site main-thread stalls, measured locally and never sent anywhere. Its release notes did not mention it.',
      ],
    },
    {
      v: '2.8.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      superseded: 'Superseded by v2.8.1 — do not trade on this build',
      tags: ['feature', 'fix'],
      title: 'Fresh launches are snipeable, and the rug guard',
      blurb: 'Two from the maintainer\'s own trench session, same screenshot. Note: this build shipped with attestation-chain recording broken — use v2.8.1 or later.',
      article: 'news-rugguard.html',
      points: [
        '<b>"ARMED … ON FIRST QUOTE" actually fires now (F-34).</b> A 39-second-old pump.fun coin used to strand the armed buy forever: no aggregator had indexed it, and with the chart in MCap mode every close was refused as "no implied supply".',
        '<b>The bonding curve is read directly.</b> The moment a pending coin looks like pump.fun, PaperTrench finds its bonding curve on chain (derived from the mint, verified against five live mainnet curves), identifies the real mint from the curve\'s reserve account, and streams the curve as a live CHAIN ⚡ feed with an immediate first quote. The fill is chain state, not a guess.',
        '<b>MCap-mode charts can price pump coins.</b> Pump supply is a protocol constant, so an mcap-scale close IS a price. All four readings of an unlabelled chart value are judged against sane bands and the tick is used only when exactly one fits — ambiguity still refuses.',
        '<b>Rug guard (on by default).</b> When chain state says the float is in a handful of wallets, a paper BUY is refused with a toast that names the number — "🚩 RUG WARNING — top 10 wallets hold 47% of supply". It never blocks a SELL, and a failed chain read blocks nothing: a guard that cannot see is not allowed to invent.',
      ],
    },
    {
      v: '2.7.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'The complete v2.7.0 batch',
      blurb: 'Housekeeping with a straight face: v2.7.0 was tagged and published mid-batch, before the last five commits landed.',
      points: [
        '<b>If you downloaded 2.7.0, update.</b> That build is missing the Instant terminal links, the dashboard refresh fix ("stopped re-reading everything every 4 seconds"), and an X-Ray dock fix — all described in the v2.7.0 notes below.',
        'v2.7.1 is the complete batch; nothing else changed.',
      ],
    },
    {
      v: '2.7.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature', 'speed'],
      title: 'Community batch #2, Terminal Turbo, X-Ray dock, the floating Flex composer',
      blurb: 'The biggest batch so far: the fill-accuracy bug that could book you instant fake profit, then a whole pass on making every terminal feel fast.',
      articles: [
        { href: 'news-fills.html', label: 'The fill-accuracy story' },
        { href: 'news-turbo.html', label: 'Terminal Turbo, in full' },
      ],
      points: [
        '<b>Fills land on the chart you are looking at — the "instant +14%" is dead.</b> On migrated (AMM) tokens the on-chain feed could lose one side of every trade it watched, filling paper trades up to ~13% away from the live chart. The stale-frame guard is now per-vault, and every fill is reconciled against the price on your screen (F-33).',
        '<b>Instant terminal links (opt-in).</b> Axiom, Padre and GMGN token links clicked on another terminal open in that terminal\'s kept-warm viewer, and a positions-bar hop to another terminal no longer replaces the tab you are on.',
        '<b>Instant pump.fun &amp; Solscan links (opt-in).</b> The Instant X viewer idea, generalized — up to two muted background viewer tabs, already warm when you get there, with hover prefetch. Ctrl/click bypasses.',
        '<b>Turbo receipts.</b> The popup counts your warm vs cold opens and shows the median routing time — measured on your machine, stored locally, never sent anywhere.',
        '<b>PaperTrench off costs the page nothing.</b> When no consumer exists for price frames, the bridge drops them before the body copy and the JSON parse — zero parsing donated to the host site.',
        '<b>Chips stopped fighting the page for layout.</b> Chip positioning runs in read/write phases with diffed style writes, so screener chips no longer thrash layout at volume peaks.',
        '<b>The dashboard stopped re-reading everything every 4 seconds.</b> It refreshes the instant your data changes, naps while hidden, and leaves the recordings database alone unless a new replay landed.',
        '<b>Flex without leaving the terminal.</b> The Flex button opens the share composer as a floating window over the page — the SAME composer, with card math now in one shared derivation so a card can never show different numbers depending on where you opened it.',
        '<b>Close the hot X tab, it comes back</b>, and <b>your own X tab IS the warm tab now</b> — PaperTrench adopts the x.com tab you already keep open instead of opening a second one.',
        '<b>Quick settings in the popup.</b> Starting balance, quick-buy presets, quick-sell presets and a fees profile, editable without opening the dashboard.',
        '<b>The positions bar respects late headers,</b> measuring the site header until it settles so slow-painting headers no longer end up underneath it.',
      ],
    },
    {
      v: '2.6.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'X-Ray — instant account intel on X',
      blurb: 'Open any X profile or post and the intel is already on screen: bio and handle changes, every contract address the account has posted, and who big follows them.',
      article: 'news-xray.html',
      points: [
        '<b>Contract addresses posted.</b> Every CA the account has put out, dated by the post itself, newest first, click to copy — with a flag if one is sitting in the bio right now.',
        '<b>Bio, name and @handle changes,</b> counted separately, because a display-name swap and a rename are different tells.',
        '<b>Smart Following.</b> The biggest accounts following this one, ranked by follower count, with the ones you follow marked.',
        '<b>Every counter carries its watch window</b> — "no change seen · watching since Aug 5" — because nobody can tell you a bio changed on a day they never saw the bio.',
        'Suite: 749/749, including tests pinning that a first sighting can never be reported as a change and that a forged page-world digest cannot write a fake CA into the ledger.',
      ],
    },
    {
      v: '2.5.2', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature'],
      title: 'Resize un-stick, four corners, Flex on the closed card',
      blurb: 'Three fixes straight from the maintainer taking a live trade.',
      article: 'news-flex.html',
      points: [
        '<b>The resize grip can never stick again.</b> A cancelled gesture used to leave the drag latched, so the panel kept resizing with every mouse move. Pointer capture now guarantees a terminal event.',
        '<b>Resize from any corner.</b> All four corners are grips, anchored so the panel grows in the direction you drag.',
        '<b>Flex it — wins AND losses.</b> The Closed P&L card in the overlay gained a Flex button for that exact result.',
        '<b>The Closed P&L card stopped blinking.</b> It was being rebuilt on every heartbeat and re-running its entry animation each time.',
      ],
    },
    {
      v: '2.5.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Share an open position — the still-holding flex',
      blurb: 'The real terminals card an OPEN position and ours only carded closed rounds.',
      article: 'news-flex.html',
      points: [
        '<b>Live open positions on the Overview carry a Share button.</b> The card states OPEN, the middle column reads POSITION at the last recorded mark, and the journey line claims no EXIT that has not happened.',
        'USD figures appear only where fills and marks genuinely recorded them — same gallery, same Customize / Download / Copy, same un-removable branding.',
      ],
    },
    {
      v: '2.5.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'speed'],
      title: 'The Flex Pack share card',
      blurb: 'Flex your PaperTrench P&L — with the one thing that can never come off the card.',
      article: 'news-flex.html',
      points: [
        '<b>Terminal-grade share composer:</b> a huge ◎ SOL P&L, Invested / Returned / P&L% columns with honest USD sub-lines, the entry→exit→held journey line, and an observed-only After line no other terminal can print.',
        '<b>Backgrounds, yours.</b> Five built-in looks plus your own uploads — max 2 MB each, ten stored, saved between sessions.',
        '<b>The PAPER watermark and brand bar are drawn last by a code path that reads no settings</b> — verified by a test that drives every combination of options.',
        '<b>Instant X links now speak GMGN and Axiom.</b> GMGN community links and Axiom CA searches used to fall through to a cold tab; both warm-route now.',
        '<b>Hover preview cards (opt-in).</b> Hover an X link and the post renders on the page in ~200ms. A deleted post says "unavailable" — the rug signal before you spend a click.',
      ],
    },
    {
      v: '2.4.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'speed'],
      title: 'Instant X links + a real off switch',
      blurb: 'Traders vet a coin by clicking its X link — and then wait ~3.5 seconds for a cold tab to load.',
      article: 'news-instant-x.html',
      points: [
        '<b>Instant X links (opt-in).</b> X posts and profiles clicked on any supported trading site open in a kept-warm viewer tab via an in-page navigation: about half a second, and every follow-up click lands in the same already-hydrated tab.',
        '<b>Hover prefetch.</b> Rest the cursor on an X link for a tenth of a second and the hidden viewer starts navigating there before you click.',
        '<b>A real off switch.</b> A ⏻ button in the popup turns the whole extension dormant on every open tab, immediately — keeping your wallet, journal and every sub-setting for when you switch back on.',
        '<b>Honest costs, stated up front:</b> one muted background x.com tab while enabled, two passive bridge scripts on x.com, zero new permissions, no telemetry. Ctrl/Cmd/middle-click always bypasses the feature.',
      ],
    },
    {
      v: '2.3.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature'],
      title: 'Community feedback batch (thanks lev)',
      blurb: 'All four items, same day.',
      points: [
        '<b>The average line can never ride the candle again — by construction.</b> The recompute-per-second design was replaced outright: the line level is computed once and frozen, because an average IS a constant level in axis units.',
        '<b>Focus mode is genuinely compact now:</b> position-detail rows hide, unrealized P&L and quick sell stay.',
        '<b>Quick reset in focus mode, no popup.</b> Tap once to arm, tap again to reset. Streams keep their focus; fat fingers keep their journal.',
      ],
    },
    {
      v: '2.2.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Fees & costs emulation',
      blurb: 'Make paper fills cost what real fills cost.',
      article: 'news-fees.html',
      points: [
        '<b>A new settings card models the FULL cost of a real fill:</b> the platform percentage, plus a flat priority fee (gas) and a bribe/tip per transaction — the costs that dominate small entries.',
        '<b>The accounting is honest end to end.</b> Flat costs join the cost basis on buys and reduce net proceeds on sells, so per-sell P&L, rounds, the calendar, the equity curve and the verification chain all include them.',
        '<b>A dust exit can genuinely net negative</b> — you paid gas to leave a worthless bag, which is precisely the lesson.',
        'Defaults are zero, so existing wallets change nothing until you opt in.',
      ],
    },
    {
      v: '2.1.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'fix'],
      title: 'The After, Guardrails, CSV export, onboarding',
      blurb: 'The practice loop gets its most important missing organ, plus training wheels and data ownership.',
      article: 'news-the-after.html',
      points: [
        '<b>The After.</b> Every closed round watches its coin for the following hour and records what ACTUALLY happened after your exit — observed extremes, sample counts, no interpolation.',
        '<b>Guardrails (training wheels).</b> Opt-in and enforced at buy time: a tilt breaker, a max position size, and a daily loss limit.',
        '<b>Fill bubbles land on the candles</b> (community screenshot, fixed same day) — shapes now share the avg line level math and clamp to the newest bar.',
        '<b>CSV export</b> for the journal and rounds, RFC-4180-safe, After columns included.',
        '<b>Onboarding checklist</b> on Overview: first buy → thesis → first close → first After → review → the 50-round road to the graduation bar.',
      ],
    },
    {
      v: '2.0.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'A real position can no longer pollute the paper feed',
      blurb: 'First post-2.0 community report, fixed same-day.',
      points: [
        '<b>Holding a real position no longer confuses the paper numbers.</b> Sites stream your real entry average alongside the live price, and PaperTrench was accepting it as a market tick. Your own position data is now never treated as a market price.',
        '<b>The paper line can never impersonate the real one.</b> Average lines are labelled "PAPER Avg. Fill" / "PAPER Avg. Exit" — same doctrine as the P&L card watermark.',
      ],
    },
    {
      v: '2.0.0', date: 'Aug 5, 2026', iso: '2026-08-05', major: true,
      tags: ['fix', 'feature', 'security', 'speed'],
      title: 'Out of alpha',
      blurb: 'A four-track code audit produced a public, ranked defect register of 139 findings. v2.0.0 closes 116 of them — every one with a regression test that fails on the old code.',
      article: 'news-v2.html',
      points: [
        '<b>Fills can no longer execute at stale prices.</b> Chain state, then the click-time snapshot, then a fresh page tick, then one resolver refresh — beyond that the trade is refused with a visible reason. The old default path filled at prices up to 10 seconds old.',
        '<b>The average-entry line finally holds your entry</b> instead of riding the candle on market-cap charts.',
        '<b>Feeds that survive volume.</b> The GMGN high-volume fixes became the contract for every site, with a 10× stress harness in CI.',
        '<b>PaperTrench now runs ONLY on the nine supported trading sites</b> — never anywhere else, never on wallet, portfolio or EVM routes.',
        '<b>The graduation bar.</b> Seven criteria evaluated against your own journal, where missing evidence never counts as a pass.',
      ],
    },
    {
      v: '1.2.18', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'First fix batch from the public defect register',
      blurb: 'Six correctness fixes on the money paths, every one locked with a regression test.',
      points: [
        '<b>Fast navigation can no longer trade the wrong token.</b> Navigations that land mid-resolve are retried instead of silently swallowed.',
        '<b>Double-tap sells fill once.</b> Previously a second tap silently sold 50% of the remainder — 75% total — with two success toasts.',
        '<b>AI reviews and recording links stop vanishing from the dashboard.</b>',
        '<b>Backup restore sticks:</b> a restored wallet lands strictly ahead of every open tab’s write counter.',
        '<b>Screener quick-buy chips price honestly</b> — a chip tap demands a quote no older than 3 seconds.',
      ],
    },
    {
      v: '1.2.17', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'security'],
      title: 'Reliability hardening',
      blurb: 'No feature changes.',
      points: [
        '<b>Storage failures are no longer silently ignored.</b> A failed read falls back to safe defaults — never a fabricated wallet — and a failed write reports itself instead of pretending it worked.',
        '<b>Stale AI credentials are cleaned up</b> so an old key can never be silently sent to whatever endpoint gets configured next.',
      ],
    },
    {
      v: '1.2.16', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'Sell buttons no longer disappear',
      blurb: 'Reported on v1.2.13: "still having issues with that sell button disappearing".',
      points: [
        'Overlay teardown destroyed the shadow DOM but left the position-card cache pointing at detached nodes, so the rebuilt card came back without sell buttons. Both teardown paths now null the cache. Locked by a source-contract regression test.',
      ],
    },
    {
      v: '1.2.15', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Focus mode for the trade tab',
      blurb: 'Requested from the community: "make the trading tab like Axiom and other platforms for more optimised and less distracted trades".',
      points: [
        'A Focus mode toggle strips every decoration from the panel — banner, watermark, sparkline, thesis card, last-close card and footer — leaving token, price, balance and buy/sell controls.',
        'Opt-in; the full panel stays the default, and flipping the switch applies live on every open tab.',
      ],
    },
    {
      v: '1.2.14', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'speed'],
      title: 'GMGN high volume no longer kills the live feed',
      blurb: 'Reported from GMGN: "doesn’t work when volume is high". Two real causes, both fixed.',
      points: [
        'Realtime trade batches grow past the bridge’s 500KB frame guard exactly when volume peaks, and the guard dropped them before the trade feed could read them. Trade batches now bypass the guard; every other oversized frame stays dropped.',
        'Hot batches carry many tokens at once and the one on screen could get crowded out of the tick budget by batch order. The token you are watching is now always emitted first.',
      ],
    },
    {
      v: '1.2.13', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['feature'],
      title: 'The panel remembers its place',
      blurb: 'Drag it anywhere — the position is saved and restored on every refresh, new tab, and supported site.',
      points: [
        'Previously each page load snapped the panel back to the top-right corner.',
        'A saved position that would land off-screen on a smaller window is clamped back, so the panel always stays grabbable.',
      ],
    },
    {
      v: '1.2.12', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['fix', 'feature'],
      title: 'Honest average fills + a Quick-buy settings card',
      blurb: 'Community report round three, both points addressed.',
      points: [
        '<b>Average fill price is now honest on fresh launches.</b> The line used to be computed only from fills that happened to record a USD price, so on a fresh launch it quietly covered a subset of your fills. It now always covers every fill.',
        '<b>Quick-buy (QB) settings found at last.</b> The five toggles were buried mid-list inside "Wallet & Trading"; they now have their own settings card.',
      ],
    },
    {
      v: '1.2.11', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['fix'],
      title: 'Sell options no longer vanish on vault-style pools',
      blurb: 'Fixes GitHub issue #17 — a user’s sell options disappeared mid-session.',
      points: [
        'Constant-product vault tokens were priced from a description that never carried the token’s decimals, so the first live vault update crashed the price handler — and that crash killed the whole live-price stream.',
        '<b>The live-price stream can no longer die from a single bad frame.</b> The socket handler is crash-isolated: one weird token can’t take down everyone’s prices.',
      ],
    },
    {
      v: '1.2.10', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['fix'],
      title: 'Three real bugs from the second community audit',
      blurb: 'All fixed and locked in with regression tests.',
      points: [
        '<b>Reset no longer brings the old wallet back.</b> Resets now inherit the current write counter and land strictly ahead of every open tab.',
        '<b>Buy and sell failures finally say so.</b> A mutation helper swallowed its own errors, leaving the button doing nothing with no message.',
        '<b>Dashboard writes can no longer be clobbered by a lagging tab.</b>',
      ],
    },
    {
      v: '1.2.9', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['feature'],
      title: 'Backup & Restore — updating shouldn’t erase you',
      blurb: 'Unpacked extensions tie their data to the install folder, so a fresh unzip into a new folder looked like a brand new wallet.',
      points: [
        '<b>One click downloads your whole wallet</b> — positions, rounds, history, settings, frames, replays — as a single JSON file. Restore validates the file and confirms before overwriting anything.',
        '<b>The site now teaches same-folder updates:</b> unzip the new release over the folder you already loaded, hit Reload, and your data survives.',
      ],
    },
    {
      v: '1.2.8', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['security', 'fix'],
      title: 'The security patch',
      blurb: 'A sharp-eyed user reported three privacy/safety bugs; all three were confirmed real and all three are fixed here.',
      points: [
        '<b>Snapshots now photograph the tab that traded.</b> Frame captures used to grab whatever window happened to be focused — your email, another chart, anything.',
        '<b>Websites can no longer trigger paper trades.</b> Trade-bearing messages now require a genuine user gesture within the last 5 seconds and must come from the page’s own origin.',
        '<b>Verification no longer breaks for heavy traders.</b> The attest chain was silently capped at 5000 links, corrupting verification for anyone past that count even with nothing tampered.',
      ],
    },
    {
      v: '1.2.7', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['feature', 'fix'],
      title: 'The X-feedback batch',
      blurb: 'Four things you asked for, plus one layout fix.',
      points: [
        '<b>The positions bar finally stays hidden.</b> Your choice is a saved setting now, so hide-it-once means hidden everywhere.',
        '<b>Post-close notes on rounds.</b> The thesis is written before you know how it ends; the lesson usually arrives after. The AI coach reads the note too.',
        '<b>Leaderboard shows ROI on your bankroll,</b> so absolute SOL stops flattering whoever started with the biggest paper balance.',
        '<b>The AI coach explains itself</b> — "AI not working" usually meant "not configured yet", and the Test button now says exactly that.',
        '<b>Homepage goes full-bleed on wide monitors</b> (1440px container) after ultrawide users reported pillar-boxing.',
      ],
    },
    {
      v: '1.2.6', date: 'Aug 2026', iso: '2026-08-01',
      tags: ['feature', 'security'],
      title: 'Quick-buy toggles + SSRF hardening',
      blurb: '',
      points: [
        'Hide the whole Buy section in the trade tab, or just the one-tap preset row, from Settings. Live-applied, no reload.',
        '<b>SSRF hardening:</b> the AI endpoint ships empty, and localhost/LAN endpoints require an explicit opt-in toggle.',
      ],
    },
  ];

  const FILTERS = [
    { key: 'all', label: 'Everything' },
    { key: 'feature', label: 'New features' },
    { key: 'fix', label: 'Fixes' },
    { key: 'speed', label: 'Speed' },
    { key: 'security', label: 'Security & privacy' },
  ];

  const TAG_LABEL = { feature: 'Feature', fix: 'Fix', security: 'Security', speed: 'Speed' };

  const timeline = document.getElementById('timeline');
  const filterRow = document.getElementById('filterRow');
  const countEl = document.getElementById('filterCount');
  if (!timeline || !filterRow) return;

  /* ---------- render ---------- */
  function releaseCard(r) {
    const el = document.createElement('div');
    el.className = 'rel' + (r.major ? ' is-major' : '');
    el.dataset.tags = r.tags.join(' ');
    // Website releases have no version, so they get a stable slug instead of
    // `v` + undefined — which would have produced an id of "vundefined" and
    // silently broken deep links for every entry sharing it.
    el.id = r.site ? 'site-' + r.iso : 'v' + r.v.replace(/\./g, '-');

    const tags = r.tags.map(t => `<span class="tag ${t}">${TAG_LABEL[t]}</span>`).join('');
    const points = r.points.map(p => `<div class="rel-point"><span class="bullet"></span><span>${p}</span></div>`).join('');

    // A release can earn more than one deep-dive once it carries more than one
    // story — `articles` for those, `article` for the single-story common case.
    const links = r.articles || (r.article ? [{ href: r.article, label: 'Read the full story' }] : []);
    const more = links
      .map(l => `<a class="rel-more" href="${l.href}">${l.label} <span aria-hidden="true">→</span></a>`)
      .join('');
    const blurb = r.blurb ? `<p class="rel-blurb">${r.blurb}</p>` : '';

    // A build we tell people not to use has to LOOK like one. Burying that in
    // prose is how someone ends up trading on it.
    const warn = r.superseded
      ? `<div class="rel-warn"><span class="ic" aria-hidden="true">⚠</span>${r.superseded}</div>`
      : '';

    el.innerHTML = `
      <div class="rel-card${r.superseded ? ' is-superseded' : ''}">
        <div class="rel-head">
          <span class="ver-chip${r.major ? ' major' : ''}"${r.site ? ' title="Shipped to papertrench.com — the site deploys continuously and carries no version number"' : ''}>${r.site ? 'Website' : 'v' + r.v}</span>
          ${tags}
          <time class="rel-date" datetime="${r.iso}">${r.date}</time>
        </div>
        ${warn}
        <h3 class="rel-title">${r.title}</h3>
        ${blurb}
        <div class="rel-points">${points}</div>
        ${more}
      </div>`;
    return el;
  }

  for (const r of RELEASES) timeline.appendChild(releaseCard(r));

  // The hero's "releases logged" figure comes from the array, never from a
  // number typed into the HTML — those two disagree the first time anyone
  // adds a release and forgets, and this page has no business printing a
  // count of its own contents that is wrong.
  const relCount = document.getElementById('relCount');
  if (relCount) relCount.textContent = String(RELEASES.length);

  // "Just shipped": the hub's top strip mirrors the newest archive entries,
  // linking into their timeline anchors. Filled from RELEASES itself — a
  // hand-maintained copy up top is how v3.1.0–v3.2.1 shipped while the page
  // still led with v3.0.0 (maintainer report: "i dont see it"). The strip
  // reads the same array the timeline does, so it can never go stale.
  const latestGrid = document.getElementById('latestGrid');
  if (latestGrid) {
    for (const r of RELEASES.slice(0, 3)) {
      const a = document.createElement('a');
      a.className = 'latest-card reveal';
      a.href = '#' + (r.site ? 'site-' + r.iso : 'v' + r.v.replace(/\./g, '-'));
      a.innerHTML = `
        <div class="feat-meta">
          <span class="ver-chip${r.major ? ' major' : ''}">${r.site ? 'Website' : 'v' + r.v}</span>
          <time class="feat-date" datetime="${r.iso}">${r.date}</time>
        </div>
        <h3>${r.title}</h3>
        <p>${r.blurb || ''}</p>
        <span class="go">Read the notes ↓</span>`;
      latestGrid.appendChild(a);
    }
  }

  /* ---------- filters ---------- */
  let active = 'all';

  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-chip';
    b.textContent = f.label;
    b.dataset.key = f.key;
    b.setAttribute('aria-pressed', String(f.key === active));
    b.addEventListener('click', () => apply(f.key, true));
    filterRow.appendChild(b);
  }

  function apply(key, fromUser) {
    active = key;
    let shown = 0;
    for (const el of timeline.children) {
      const hit = key === 'all' || el.dataset.tags.split(' ').includes(key);
      el.hidden = !hit;
      if (hit) shown++;
    }
    for (const b of filterRow.children) b.setAttribute('aria-pressed', String(b.dataset.key === key));
    if (countEl) {
      countEl.textContent = key === 'all'
        ? `${RELEASES.length} releases · newest first`
        : `${shown} of ${RELEASES.length} releases`;
    }
    // A deep link to a release that the new filter hides would leave the URL
    // pointing at nothing, so a user-driven filter drops the stale anchor.
    if (fromUser && location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  /* Read the hash BEFORE the first apply() — a #v2-6-0 link has to survive
     rendering, since the cards are built after the browser gave up on it. */
  const wanted = location.hash ? location.hash.slice(1) : '';
  apply('all', false);
  if (wanted) {
    const target = document.getElementById(wanted);
    if (target) target.scrollIntoView({ block: 'center' });
  }
})();
