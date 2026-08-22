# PaperTrench — patch notes

Stream-style log of what shipped, newest first. User-facing wording; the gory
details live in the commit messages.

## v3.13.2 — 2026-08-22

**Trenches quick-buy: one button per card, and fills that actually stick.**
Two live reports from the Trenches screener, both fixed:

- **Every card showed TWO quick-buy buttons.** The site redesigned its card
  layout; two of its link anchors now climb to different containers that both
  look like "the row" to our scanner, and each got its own chip. Chips are now
  deduplicated per card — one button, one buy, no twins.

- **Buy from the list, open the chart, and your line/bubbles/position were
  missing.** Each quick-buy opens the coin's chart in a background tab by
  design — and with several PaperTrench tabs alive, the wallet's write race
  could starve a fresh fill on all its retries and silently drop it: the buy
  happened, the toast fired, but nothing reached the chart. A fill now lands
  with a final forced write instead of ever being dropped, and the losing
  background writes no longer surface as page errors.

## v3.13.1 — 2026-08-22

**Fresh-pair position links land on the chart, not a dead page.** On terminals
that route by pool address (Axiom's /meme/, Photon's /lp/), a brand-new pair
opens its page before the token has a mint route anywhere. A buy made in that
window recorded the position with no pool address — and the position's stored
address never updated after. Every "click a position to jump to its chart"
from the positions bar then fell back to the token route, which for a
just-launched pair doesn't exist yet: the click died on a "not found" page
(Twitch chat, 2026-08-22: "in the Positions section it's picking up the links
incorrectly, and because of that it doesn't work"). The position now adopts
the pool the chart is actually trading on — on every buy while it learns, and
at click time from the live page when the same token is open — and a
graduation or relist to a new pool updates the link instead of leaving it
pointing at the old one.

## v3.13.0 — 2026-08-22

**New look: the paper plane.** PaperTrench has a real mark now, and it replaces
the placeholder "P" everywhere it appeared — browser toolbar, popup, dashboard
header, the trade panel on every dex, and the stream overlay. On the trading
panel it takes the colour of whichever skin you're running, so it still looks
at home on the Axiom and Solana themes.

**Settings you can actually navigate.** Seventy-odd controls used to sit in one
unbroken run of cards, so finding a known setting meant scrolling and reading
every heading. They're now grouped — **Trading, Interface, Safety, Speed, Intel,
AI** — with a search box that reaches across all of them: type "fee", "sound" or
"overlay" and only matching controls stay on screen. Nothing moved out of Save's
reach; a filtered setting still holds its value.

**The Leaderboard tab starts with three steps, not a wall.** It used to open on
chain heads and six paragraphs of verification vocabulary for someone who hadn't
linked an account yet. Now it asks for three things, one at a time — link your X
account, make your first paper trade, turn on Site sync — and each says why it's
needed. Finish them and the full tab opens.

**Live standings, in the dashboard.** Once you're through those steps, the
Leaderboard tab shows the real board — top ten, plus your own row if you rank
below it — refreshed on demand. If you're outside the top ten you still see
where you stand. Before those steps, the extension makes no request at all: the
board is the one thing it ever reads from our server, and only after you've
linked an account and switched Site sync on yourself.

**Keyboard shortcuts, off by default.** Pick **Alt + key** or **Ctrl + Shift + key**
in Settings and three keys become available on any trading page: **P** shows or
hides the trade panel, **B** the positions bar, **A** jumps straight to the
amount box. Nothing here places an order and nothing opens or closes a tab, and
the keys stay out of the way entirely while you are typing in any field.

**Streamer signup lives on the site now.** "Sign up as a streamer" used to
hand you off to a Google Form; it now opens **papertrench.com/streamer-signup**
— the same questions, on the site, in the site's own styling. Applications go
straight into the leaderboard database instead of a spreadsheet.

**A moderator queue that isn't a shared password.** `/admin` lists every
application with Approve / Reject, gated on X sign-in against a list of
moderator accounts the server checks on every request. There is no password in
the page to leak, and no version of the page you can edit your way past.

**Approving somebody actually publishes them.** An approved Twitch application
becomes a card on the streams page within a minute — no deploy, no spreadsheet
cell, no republish interval. Channels that can't be embedded can't be approved
into a card that would never appear, so the button says so instead.

**Public answers and private ones are kept apart.** Every field on the form is
labelled Public or Private where you type it. The one-line blurb is the roster
card's text; your Discord handle, contact details and free-text notes are
served to moderators only — the public roster query doesn't select those
columns at all. We store a one-way hash of your IP for abuse triage, never the
address.

## v3.12.1 — 2026-08-22

**Lute is in the Instant-links list** (Terp: "instant link loading needs to
be setup for lute also, i think we jsu forgot to ad that feature for the
site"). Lute has actually had the full treatment since early August — token
links anywhere route to a kept-warm lute.gg viewer, and links on lute.gg to
other terminals route the same way. What was missing was the telling of it:
the Settings → "Instant terminal links" description listed every other
terminal and left Lute out, so the feature read as forgotten. The list now
names Lute, and a regression test re-derives the list from the actual
terminal registry so no terminal can be silently dropped from it again.

**The dashboard sidebar is alive again** (pre-existing, since 8/20). A
referenced-but-never-defined variable crashed the dashboard's first paint —
the sidebar's equity/PnL/discipline KPIs didn't appear until you clicked
into a section, and the season share card never opened at all. Both fixed;
the live gate now asserts a clean init with zero console errors.

## v3.12.0 — 2026-08-22

**Everything one tap from the header** (away32: "a button to show this [take
profit / stop loss]… a button to show the market cap alert… next to the
Density button"). Two new header buttons: **⚑** jumps straight to the TP/SL
presets (+25 / +50 / +100 / +200% and stop-losses) and **🔔** jumps to the
market-cap alert — each scrolls the section into view with a one-time pulse
so you see exactly where it lives. No position or no token? The button says
so plainly instead of scrolling you nowhere.

**Panel skins: the looks you asked for** (away32: "a feature maybe to choose
a style for the trade panel to be like padre, axiom — literally just maybe
different colors"). The **◍** header button cycles five full skins — Trench
(default) → **Axiom** (dark slate, cyan) → **Padre** (warm near-black, amber)
→ Lute → Solana — re-painting the whole panel including its shell and rim,
not just the buttons. The same choice lives in Settings, and the two stay in
sync. The site's page is never touched; only the panel's colors.

**Rug honesty, pinned** (remsonly1, sebaasumana: "when you get rugged your
PnL turns green and the percentage doubles or triples"). The wrong-price
fills behind that were fixed in v3.10.0 — this release adds a permanent
regression test so a rug can never again print a green round: a −98% exit
must close deeply red, on full and partial exits alike, while real winners
still print green.

## v3.11.1 — 2026-08-22

**Trade history in the words you actually trade in** (01jb: "bought, held,
sold"). The Rounds table gains a **Levels** column: entry → exit market cap
for every closed round — "40k → 240k" — VWAP'd per side from the round's own
fills, so a scaled-out exit quotes its true average, not the last print.
Rounds whose journal has been pruned show an honest em-dash, never an
invented number. The CSV export carries `entryMcapUsd` / `exitMcapUsd` too.

*(Also confirmed already in settings, for anyone who asked: TP/SL line
thickness on the chart is adjustable — `chartOrderLineThickness`, 1–4 — and
the list P-buttons have a size slider.)*

## v3.11.0 — 2026-08-22

**Micro mode — the Axiom-shaped strip** (away32: "very big, looks like AI
slop… Axiom or Padre looks perfect"). The ◧ button now cycles three
densities: standard → focus → micro. Micro is not a tighter panel; it drops
the panel metaphor — one strip with token, price, your wallet SOL always
visible, buy chips and sell controls. Nothing else. 229px tall on a live
chart vs ~600px for the full panel.

**Your SOL, always on screen** (away32: "overlay sol balance at the top
without needing to open the ext"). Two places now: the micro strip shows
idle SOL + armed limit-buy SOL inline, and the positions bar no longer
vanishes when you close your last position — it reads "wallet · N ◎ idle"
so your balance survives the book emptying. Fresh wallets in standard
density stay chrome-free until there's something to show.

## v3.10.0 — 2026-08-21

**Honest fills everywhere, limit buys, and the extension now tells you when
it's out of date.** Straight from the Discord feedback:

- **Quick-buys and sells priced at fantasy levels** (the 14x-ATH sell, the
  "not accurate at all of my real PNL" instant-buys). Board chip fills used
  the row's own price blind — no witness, no second opinion. A chip fill now
  runs the exact same honesty gates as a panel fill: a quote that diverges
  too far from your position's last honest mark needs an independent source
  to vouch for it, or the fill is refused — visibly, with the reason, and
  nothing booked.
- **Limit buys.** Arm a bid below the market on any chart page: pick your
  SOL amount, type the price, hit ARM. The SOL locks (you'll see "locked" in
  the positions bar) and the buy fires the moment price drops to your level
  — filled at the real observed price, honest-fill rules, slip reported.
  Cancel anytime with the ×. Unfilled bids expire after 24h and the SOL
  unlocks automatically.
- **Update notices.** Unpacked extensions never auto-update, and people were
  trading for days on stale builds. PaperTrench now asks GitHub twice a day
  whether a newer release exists and shows a banner (dashboard + panel
  toast) with the download link. One GET request, sends nothing, and you can
  turn it off in Settings if you want full no-phone-home mode.

## v3.9.17 — 2026-08-21

**Quick-buys mark the chart again.** Live report:

- **Bought on the board, opened the chart — no bubble, no line where you
  bought.** The chart's mark pipeline was accepting our fills but silently
  never drawing them — it kept reporting "native marks ready" the whole
  time. Fills now render as chart shapes that stay glued to their candle,
  and the chart can no longer claim a pipeline it doesn't actually draw
  from.

## v3.9.16 — 2026-08-21

**The snipe survives the click-through; TP/SL hold their line.** Four live
reports:

- **Bought on the board, opened the chart — nothing there.** The armed chip
  buy lived only in the board tab; clicking the coin killed it. The intent
  now mirrors into the extension itself and the coin's own page adopts it:
  the fill lands where you're looking, position and line included.
- **TP/SL lines moved as MC moved.** The chart draw re-derived the level
  from the live price every sweep. A level set at an MC is now pinned to
  that MC — the market can 4x under it and the line stays put.
- **Some coins still weren't instant.** The armed buy only probed twice;
  a coin whose sources missed both moments waited for the next board tick.
  It now re-probes every 1.5 s until it fills or the minute runs out.
- **The quickbuy box showed the CA.** Before falling back to the short
  mint, the panel now reads the coin's name off the page itself — every
  venue headlines what it's showing.

## v3.9.15 — 2026-08-21

**Identity heals; the buy latch can never wedge.** Two live reports from the
stream floor:

- Sniping a brand-new pair showed **"Unknown token"** as the panel title and
  **"Bought 0.1 SOL of (null)"** as the fill toast. The panel now backfills
  the coin's symbol/name from the page's own first symbol-carrying tick —
  header, toast, and positions bar all heal live — and before any symbol
  arrives the title shows the shortened mint (DezX…B263) instead of the
  dead-end string. `null` can never print again.
- One failed snipe on a weird pair left **"Row buy already in progress…"**
  on every following buy, on every coin, until reload. Root cause: the
  pricing cascade awaited with no bound, so a hung resolver/RPC never
  released the in-flight latch. The cascade is now raced against a hard 10s
  bound (a hung source falls through to the normal arm-and-fire), and the
  1-second heartbeat frees any buy/sell/row latch older than 20s with a
  visible "released — try again" toast. Belt and suspenders.

## v3.9.14 — 2026-08-21

**The board chip never refuses a fresh coin.** Tapping a quick-buy chip on
a coin seconds old used to answer "Could not price that token yet" — the
banned refusal — while the panel path already knew how to arm and fire.
Now the row path arms exactly like the panel: the cascade (freshest
network read → 60s display cache → the row's own realtime print → a direct
pool/bonding-curve probe) never ends in a refusal; a miss arms the trade,
and the armed intent fires the instant any leg lands a price — the board's
own mint tick, a resolver response, or the chain probe returning — within
a 60s TTL, after which it expires honestly with a toast instead of
trading stale. Measured live: a brand-new pair's chip filled in 1.85s with
zero refusals; the panel path re-verified at 0.5s on an established coin.

## v3.9.13 — 2026-08-21

**Click. Fill. No narration, no corroboration wait.** Buying a coin the
second its chart comes up now fills on the FIRST accepted price — the old
rule that held a click until a second source agreed is gone for clicks (it
survives only for intents that were never clicked into being). The quoted
click also adopts the board row's own realtime price the instant it can —
the chart is up, the site printed the price, so no resolver or chain round
trip gets to delay the fill. And the "Buy armed — fires the instant the
first quote lands" line is deleted, not hidden: an armed intent's only cue
is the amber button pulse. Measured on the live board: BUY clicked at
panel-mount filled in ~0.5s, no banner, no waiting state.

## v3.9.12 — 2026-08-21

**The BUY button reads plain "BUY" — always.** No more "Buy when quoted"
on a coin in its first seconds: a buy button buys, it never narrates. The
instant-buy engine is untouched (a tap on a just-listed coin still prices
straight from the pool / bonding curve in milliseconds), and a click whose
intent stays armed for its first quote still fires the second one lands —
the label just never changes to say so. The only cue an armed click gives
is the amber button pulse; the wording never swaps again.

## v3.9.11 — 2026-08-21

**"New coin — waiting for first quote…" is gone forever.** A coin in its
first second on screen used to read like the extension was broken while
the terminal already printed it. It never will again: until the first
price lands — the chain probe and the click's own chain bridge price a
just-listed coin in milliseconds — the panel header shows only the neutral
"Fetching live price…". The BUY is unfazed either way: the millisecond a
page loads you can buy, and the millisecond a board row appears you can
quick-buy; both fill straight from the pool / bonding curve.

## v3.9.10 — 2026-08-21

**The chart-panel BUY asks the chain too now.** 3.9.9 made the board chips
price straight from the pool / bonding curve; the BUY button on the coin
panel still leaned on aggregator indexes first, so a coin that was one
second old on screen could still read "waiting for first quote" when you
clicked. Now the click itself probes the chain (the same prewatch the
sniping path uses): if the pool or curve exists on-chain, the buy fills
from RPC state regardless of what any indexer has indexed. Verified on the
live logged-in terminal boards end to end (pt-verification harness, 8/8).

## v3.9.9 — 2026-08-21

**New-pairs sniping is chain-native now** — the board buys you're doing the
second a coin lists no longer depend on any aggregator.
- Screener quick-buys (the chips on the new-listed / about-to-bond / just
  graduated boards) now go straight to the CHAIN when the aggregators and
  the site API haven't indexed the coin yet: the same on-chain probe the
  chart panel uses reads the pool or bonding curve directly from RPC state
  and fills on tap — pump curves included. A coin on the board for one
  second prices on tap; the "open its chart to buy" refusal now only
  survives for something literally not on-chain.
- Panel buys keep the venue-quote + click-acquisition ladder from 3.9.8;
  the armed state remains the last resort.

## v3.9.8 — 2026-08-21

**Buying a coin that just came out now fills INSTANTLY — no more "waiting for
the first quote".** If the chart is up, the price exists, and the fill follows
the click:
- Screener quick-buys no longer say "Could not price that token yet — open its
  chart to buy" while the terminal's own live feed is printing that exact
  price on the row. The row buy now cascades: freshest network read → display
  cache → the row's own realtime price → refusal.
- The BUY button no longer parks on "ARMED — fires the instant the first quote
  lands" when the site's own data already prices the coin. The click itself
  drives one acquisition beat through every source — including the terminal's
  quotation API (GMGN / pump.fun), the same source the visible chart draws
  from — and the fill happens in that beat. Arming is now the last resort it
  was meant to be, and only a coin literally no source knows stays armed.

**Settings apply the moment you save** — changing focus mode or the sell
ladder in the dashboard used to silently need a reload; the open position's
sell buttons now rebuild immediately and focus mode re-rides live (D-37).
Test suite: 1,656.

**True-size equity curve** — after a wallet reset the equity canvas was
secretly drawn at a fallback size while the Overview tab was still hidden,
and never repainted at real size. The curve now refuses to paint the
invisible and repaints at true layout the moment Overview comes up (D-31).

**Honest start** — editing "Starting paper balance" no longer rewrites your
return. The wallet's birth balance is snapshotted the moment it's created;
every % you see — hero strip, leaderboard evidence card, standings row,
equity curve, sparkline, stream overlay, and the site-facing claim — is
judged against that snapshot. The setting now means exactly what it says:
what the NEXT wallet starts with. Editing it mid-wallet changes nothing
about the wallet you're running. Negative starting balances are also
rejected at save time. Nine new tests lock it; one old leaderboard test
that asserted the old behavior was rewritten to assert the honest one.

**Honest cards** — no more made-up market caps. If even one fill on a side of
the round happened before the market-cap feed woke up, the card now shows the
price line instead of a quietly wrong "in at 200K" that was really 240K. Same
all-or-nothing rule the USD figures always followed. Five new tests lock it.
Register catch-up: D-47/D-51/D-52 were already fixed in code but never marked
in DEFECTS.md — now they are.

## v3.9.3 — 2026-08-20

**Discipline co-crown** — the KPI row now grades your process, not just your
P&L. Next to Realized P&L sits the lifetime discipline grade: every round
graded S–D, averaged to a letter with the honest `/4` number under it. Green
letters mean the process holds even when the tape goes against you — that's
the crown PnL can't take away. The boards-side co-crown (two trophies, same
season) lands with the D1 leaderboard.

## v3.9.2 — 2026-08-20

**Season share cards** — the Wordle play. One image, legible in two seconds,
and it never spoils: no PnL anywhere on the card, by construction. Big status
word (SEASON — LIVE / BELT WON / WINDOW CLOSED / BUSTED), three gate dots
(count the filled ones — that's the tease), the discipline lines (rounds ·
journal coverage · average grade), streak, rank. What you did with the money
is your story to tell in the replies. Share it mid-season from the session
panel; survival busted cards wear the elimination line in red.

## v3.9.1 — 2026-08-20

**Survival Season** — the Trench Season with the safety off. Same three gates,
same 7-day window, one difference: your equity is on the line. Drop to 20% of
where the season started and you're eliminated — the season ends **busted**
on the spot, no gates, no belt. The line is reconstructed from your journal
(nothing extra tracked), and the standard season is untouched: blow the whole
account there and the gates just keep watching. Scarcity makes paper money
feel real; elimination is the honest lesson.

## v3.9.0 — 2026-08-20

**Trench Season** — a 7-day league, and the biggest game yet. Opt in from the
Game tab; the season watches your whole week through three gates: **10+ rounds
played, 80%+ journaled, average grade B or better.** Meet all three and the
belt is yours immediately — the window stays open to raise the score. Miss
them when the window closes and the season files as missed: no extensions,
no mercy, same rules as the market. Discipline is the only ranking surface —
profit never enters the score. Past belts are derived from your journal, so
a dominant fortnight can bank two.

## v3.8.2 — 2026-08-20

The streak learns to burn. Discipline streaks on the bar now climb a ladder —
**Ember** at 3, **Flame** at 7, **Blaze** at 14, **Torch** at 30 — with the
tier's glyph on the chip and the distance to the next rung in the tooltip.
Same doctrine as always: streaks count discipline (journaled rounds, clean
exits), never profit; a red round that followed the plan feeds the fire.

## v3.8.1 — 2026-08-20

Your trench, your colors. The overlay can now wear three skins: **Trench**
(the default amber-on-slate), **Lute** (deep indigo with violet accents —
asked for by a trader who lives there), and **Solana** (terminal green).
Settings → Trade → Panel theme; it switches live, no reload. The site's own
page is never touched — only the panel's colors.

## v3.8.0 — 2026-08-20

The trainer that tells the truth — and the chart you never saw.

- **A one-tap list buy now opens the token's chart (#29).** A quick-buy
  chip on a screener list opens a NEW position in a token whose chart you
  never saw. The chart now opens in a background tab — never stealing
  focus — on the site the position was opened on, so the position is one
  click from management. Off switch in Settings → Trade ("Open the chart
  tab after a list buy").
- **Every PnL card now prints its fees.** The share card's journey line
  shows the round trip's total simulated fees — `INCL 0.040 SOL FEES` —
  so a 3x that nets 2.4x is explained on the artifact itself. Rounds from
  before fees were recorded stay fee-silent; nothing is invented.
- 7 new tests (1,594 total): list-chip tab behavior (5) and card fee
  honesty (2).

## v3.7.0 — 2026-08-20

The last mile of the feedback batch: making sure the people who reported
bugs actually *get* the fixes.

- **The popup now tells you when a new PaperTrench is out.** PaperTrench
  installs from a zip — no Chrome Web Store — so Chrome never auto-updates
  it, and several field reports this week described bugs that were fixed
  days earlier: stale installs with no way to know. The popup now checks
  GitHub once a day and, if a newer release exists, shows one amber banner
  with the version and a direct download link. Dismiss it and it stays
  quiet until the *next* release. Offline, rate-limited, or any failure:
  the popup looks exactly as it always did.

## v3.6.1 — 2026-08-20

One ask, shipped same-day. ark_trades13: "Do yall know if you can get your
sol total amount of sol you have on the on the display overlay?" The equity
number at the top of the stream overlay has always been cash + positions as
one figure — the ask was seeing *where it sits*.

- **The stream overlay now shows the split.** Two new tiles: **Cash ◎**
  (spendable) and **In positions** (open value), beside the position count.
  Both re-sum to the equity number above them — same formula, so the split
  can never disagree with the hero. The tile grid went 4-up to a 3×2 so
  every label keeps its room; card and bar layouts both.

## v3.6.0 — 2026-08-20

The feedback batch. You talked in the Discord, we shipped: four of the most
requested UI pieces plus the three crash-level bugs (see the P0 notes below),
all locked with tests — the suite grew from 1,548 to 1,579.

- **See how much you've bought, held, and sold.** jb asked for lifetime flow
  numbers "whilst trading" — they're now on the dashboard sidebar and in the
  popup. Bought/sold are the order sizes you placed (not fee-shrunk), held is
  the surviving cost of open positions. Old wallets get correct numbers with
  no migration.
- **Thicker order lines.** TP/SL and average lines have a width setting now
  (1–4 px) for dense charts — and changing it redraws lines you already
  placed.
- **Quick-buy chip no longer sits on top of the MC in ultra terminal
  format** (jb, again). The chip checks where it's about to paint and drops
  to the bottom-right gutter if it would cover the row's own content — on
  every site format we inject into, Padre's pill included. Prefer it pinned
  there forever? New setting: Quick-buy chip placement → Bottom-right.
- **Quick-buy chip size + position**: the size slider you know
  (0.6–1.5×) stays, and placement is now controllable too.
- **A fresh-launch snipe no longer fills on the first price it sees.**
  Field reports (Terp ×3, rashawn; seeded by sednation): a snipe on a
  20k-MC coin recorded at 6k — the first quote after indexing lagged the
  market, and with no earlier price on file there was nothing to disagree
  with, so it witnessed itself. An armed buy now needs corroboration — a
  second accepted tick or an independent resolver quote — before it may
  fill. A lone quote leaves the intent armed until its own TTL expires it
  visibly. Never a fill on a guess.
- **A dead bag can no longer render gloriously green.** Field reports
  (Rems ×3/week, husm "from 2.7 to +300", Tanza): the coin rugs, the pool
  drains to dust, and the next print out of that dust pool re-marks your
  open bag at an absurd price — equity exploding on a coin that already
  died. Liquidity is the honest discriminator: you cannot sell into a
  drained pool at a higher price. An up-print beyond +25% from a
  collapsed pool (under $2k of liquidity) is refused and the position
  keeps its last honest mark; a down-print always passes, because a rug
  is supposed to hurt. Missing liquidity data means the guard stands
  aside — it never blocks on absence.
- **Your armed buy and your bag survive graduation.** When a pump.fun
  coin graduates, the terminal redirects from the curve page to the pool
  page under a new address — and an armed buy or open bag filed under the
  curve's stand-in address used to be dropped in the move, rendered as if
  you never armed or bought. The armed order and the position now ride
  across the redirect when the pool resolves to the same base coin
  (identity proven, never guessed), rekeyed to the real mint — and the
  armed buy revives and fires at the pool's first honest quote. A
  different coin never inherits anything.

## v3.5.0 — 2026-08-11

The Arena repair. The leaderboard broke the day v3.4.0 shipped — every
submission was being refused over a version stamp while every fill inside it
verified perfectly — and with paid tournaments coming, the whole pipeline got
the adversarial audit it was always going to need. Eleven defects found,
fixed, and locked with tests (L-01…L-11 in DEFECTS.md); the suite grew from
1,678 to 1,696.

- **Submitting your record works again.** A version bump meant for the fill
  format leaked onto the submission envelope, so the server refused every
  v3.4.0 sync as a format it didn't know — the board sat empty while the
  chains inside were flawless. The two version numbers are now separate
  contracts, the server accepts the mislabeled exports already in the wild,
  and a regression test pins each one so this class of break can't ship
  twice.

- **Fresh-launch records rank correctly now.** If a position was bought
  under a pool's stand-in address and rekeyed to the real mint mid-round
  (the v3.4.0 rename fix), the server matched its sells by mint, found
  nothing, and quietly dropped the round — undercounting P&L, win rate and
  round count for exactly the traders who live on fresh launches. Every
  server walk now follows the same hash-committed session thread the engine
  itself uses, so a rename never orphans an exit.

- **Cheating got materially harder, ahead of real prize money.** Three new
  server-side gates: a fill's committed cash must be consistent with its own
  committed price (you can no longer declare a sell that "received" 25× what
  it was worth), Sprint/duel/clan baselines are now derived purely from
  hash-committed fields (editing the unhashed copies used to inflate every
  windowed return), and a fill is priced against the chain it committed to,
  failing closed on any chain the verifier can't check.

- **The board is fair at scale.** The 500-row cut is now taken by rank, not
  by recency — past 500 entrants, the season's best score used to fall off
  the board if it hadn't resubmitted lately. Ties are deterministic: the
  earlier verification keeps the rank, so a later submitter can't displace
  you by equalling you.

- **Re-syncing an unchanged record is a no-op now.** It used to reset your
  verified status to pending and throw away every pricing verdict already
  earned — double-clicking Sync knocked you off the board for hours.

- **The verifier is harder to knock over.** Everything a submission changes
  commits in one transaction (no more half-written records if the worker is
  evicted mid-write), the submission rate limit is a single atomic statement
  (parallel requests can't slip past it together), and a record whose market
  data won't load steps aside with a recorded reason instead of silently
  pinning the verification queue forever.

- **"Extension not detected" fixed for big records.** The Arena gave the
  extension 1.5 seconds to answer, but building the attestation for a long
  journal takes longer than that — so the more you traded, the more
  certainly the site told you the extension wasn't installed. Record
  requests now get the time they need; the quick presence check stays quick.

## v3.4.0 — 2026-08-11

Every fix in this batch traces to one Discord feedback thread from the last
two days — average entries that didn't match the click, a hot bar that
disagreed with the trade panel, and positions that "wiped like I never
bought". The thread also asked for in-trader journaling; that shipped too.
This is also the first tagged build to carry the prediction-market engine
written up under v3.3.0 below, and everything fixed since v3.2.2.

- **Your entry is the number you clicked on.** A fill used to ask the chain
  first and let it price the trade whenever it sat within 6% of a fresh
  on-screen quote — so your recorded entry routinely landed a few percent
  above or below the price you actually acted on ("it'll fill you in lower
  than ur actual entry or higher sometimes"). Now a sub-second-fresh
  on-screen price fills the trade, full stop; the chain prices fills only
  when the screen has gone quiet, and every candidate still has to pass the
  fill witness before it becomes money. Bonus: fresh-screen fills skip the
  chain round trip entirely, so the common fill got faster on exactly the
  launches that move too fast.

- **The position that "wiped like you never bought" is fixed.** On pair-URL
  sites (Axiom's /meme/ and friends) a fresh launch trades under the pool's
  stand-in address until the coin's real mint is discovered. A buy in that
  window was filed under the stand-in — and the moment the coin learned its
  real name, the card looked your bag up under the new name, found nothing,
  and rendered empty over live money. The whole live record — position,
  armed orders, alerts, post-exit watch, the chart's average-entry line —
  now follows the coin across that rename. Your journal history is not
  rewritten (those rows are cryptographically attested); round arithmetic
  matches fills by session instead, which survives the rename.

- **The hot bar and the trade panel agree about your P&L now.** The
  positions bar could keep marking the coin on your screen from an
  aggregator quote cached minutes ago, while the panel an inch above it
  marked the same bag from the live page feed — same position, two venues,
  two P&Ls. The bar now prices the on-screen coin from the same live feed
  the panel uses, and sheds the stale cached quote the moment a coin comes
  on screen.

- **Instant thesis with a chart snap, inside the trader.** "U need to go
  into a separate tab… new pairs moves too quick" — you never did need the
  tab (the *＋ Why this trade?* composer has lived in the instant trader for
  a while), and now it does the one thing it couldn't: one tap snaps the
  chart exactly as you see it and files the frame with your thesis. On by
  default when you save, one tap to opt out, works even if automatic coach
  frames are off — an explicit snap is its own consent. Snaps land in the
  dashboard's coach gallery and session replays, joined to the round they
  belong to; the thesis itself still grades against what actually happened.

- **The launch tweet, on the button your cursor is already on.** Several
  terminals put their tweet preview behind a hotkey you have to HOLD. New
  opt-in: hover the terminal's *own* quick-buy pill and the tweet card
  appears in about a tenth of a second — no key held, no aiming at a 14px
  𝕏 icon, and the cursor never leaves the button it came for. Off by
  default; lives under Instant links in Settings.

  Two deliberate limits, both about a trigger that sits on a control which
  spends real money. The card is PaperTrench's own, not the terminal's
  native box: summoning the native one means firing synthetic keystrokes
  into a live trading app whose neighbouring keys buy things, and no
  amount of polish is worth that blast radius. And it only runs where the
  site's quick-buy pill is already verified — Axiom and Padre today —
  because deciding for ourselves which button spends money is exactly the
  kind of guess this codebase refuses. A terminal that earns a verified
  pill later gets this with no code change. The card is also placed clear
  of the pill in every viewport, so the buy click you were aiming at
  still lands.

## v3.3.0 — 2026-08-07

- **Prediction market engine.** Binary outcome contracts from four venues
  (Kalshi, Polymarket, Hyperliquid HIP-4 outcomes, Limitless) become a
  first-class PaperTrench instrument — a sibling family to tokens and
  perps, with its own fill engine, calibration scoring, and separate
  bankroll. The fill engine walks the venue's real order book (never
  beyond visible depth, 5% depth cap, latency replay, resolution
  lockout), and scores forecasts via Brier Skill Score against the
  market's own price. Prediction-market engine and venue contracts
  ported from amogus0471/Paper-Prediction @ e03f715 (MIT, contributed
  by Amogus).

## v3.2.1 — 2026-08-07

- **Fresh launches from launchpads we can't decode still get their
  identity instantly.** On pair-address pages (Axiom's /meme/), a
  brand-new coin whose pool belongs to a launchpad without a verified
  decoder used to be a full dead end — no price, and no mint either, so
  even the market-cap bootstrap couldn't engage. The vault scan now
  recovers the coin's identity and real supply from any pool (those are
  protocol facts), the page's own feed prices it under the usual
  sanity discipline, and price retries switch to asking by mint — which
  aggregators index within seconds of a launch. The pool's own price
  stays refused until its layout is verified: an unverified vault ratio
  would be an invented number.

## v3.2.0 — 2026-08-07

Every item traces to a named field report from the last two days — the
same-week batch continues, and it adds a twelfth supported terminal.

- **lute.gg is a supported terminal now, at full parity.** Overlay, live
  fills on the chart, warm links, X-Ray — the whole kit. Lute is a social
  terminal, so the adapter ships with the same pollution guards the fomo
  arc established: holder rows carry other people's entry prices and PnL,
  and every one of those price-shaped numbers is treated as someone's
  history, never as the market.

- **Fills carry receipts now — and they caught a real one.** A sell on
  lute booked ~20% under the chart (a win rendered as -9.6%): value-lag
  wearing a fresh timestamp, too small for the fill witness's ratio to
  challenge. Every fill now records where its price came from and how old
  each source was, so the next "my fill was wrong" report comes with the
  evidence attached instead of a shrug.

- **If your region's public price connection is slow, PaperTrench now tells
  you — with the fix.** A community member in the Balkans found every
  keyless public endpoint throttled from where they live, and solved it
  themselves by pasting a free personal RPC endpoint into Settings. Nobody
  should have to discover that alone: the extension now reads its own
  measured latency, and when the public pool stays slow on real evidence
  (and you haven't set an endpoint), it says so once — with the measured
  number and a two-minute guide (docs/RPC-SPEEDUP.md). Endpoint health now
  also survives restarts, so the fastest endpoint is known from the first
  click of every session. Nothing is sent anywhere: this is the extension
  reading its own numbers. (We checked every other keyless provider for
  the pool — all now dead or key-gated; the three shipped survivors are
  the whole keyless commons, which is why the honest fix is telling you.)

- **The first quote on a brand-new coin now lands in a quarter second.**
  Field report: "waiting for first quote… is it not for fast scalping?"
  Measured live against real launches: the on-chain first quote took
  ~3.7-4.3 seconds, almost all of it one silent RPC endpoint eating its
  full 4-second timeout before failover. The RPC pool now hedges — an
  endpoint that hasn't answered in half a second gets a racing competitor,
  first answer wins — and the sniping path stopped re-fetching state it
  already held (including a protocol constant it fetched over the
  network). Re-measured live: 155-245ms to a chain-read first quote on
  coins 30-74 seconds old, agreeing with the aggregator price to 0.06%.
  Slow endpoints now cost half a second everywhere, not four.

- **The OFF switch now turns everything off — including paper perps.** The
  perps ticket shipped after the master switch existed and never learned
  it, so "Turn PaperTrench on" could be showing while the ticket sat on
  Hyperliquid anyway (field report with the screenshot to prove it). Off
  now means off on every surface, and the ticket won't even flash in
  before the setting is read.

- **PaperTrench never opens a tab you didn't click for.** The speed
  feature used to pre-open hidden pump.fun and Solscan viewer tabs so your
  first click would land warm — and two users independently read the
  appearing tabs as a malfunction ("when i load up it randomly opens
  solscan and pump.fun"). Every warm viewer is now created only by your
  own click; the first click pays cold, every one after is instant, and
  hovering can only ever pre-navigate a tab your click already created.

- **The stream overlay bar stopped printing labels over each other.** In a
  narrow OBS window the bar's stat tiles crushed together (REALIZED / WIN
  RATE / ROUNDS overlapping). The bar now wraps to a second row instead of
  crushing — every label readable at any window width.

- **The Fees & costs dropdown is readable again.** The open dropdown list
  rendered white-on-white on Windows (the browser draws that list, and it
  ignored the panel's dark theme). Both the popup's quick settings and
  every dashboard dropdown now declare their color scheme.

## v3.1.0 — 2026-08-06

Every item in this release traces to a named field report from the last two
days — this is the users-found-it, we-fixed-it-same-week batch, and two of
the fixes guard the honesty of the numbers themselves.

- **A fill can no longer execute at a resurrected dead price.** Field
  report with screenshots: a coin crashed ~30K → ~8K, the DCA buy filled
  honestly at the crashed price, and the sell a minute later filled at the
  pre-crash level — a loss shown as +167%. Any fill price that contradicts
  what your own screen just accepted as market truth now needs a second,
  independent source to vouch for it; if none does, the fill is refused
  out loud with both numbers named, and you click again two seconds later.
  A real 4x pump is confirmed by any fresh source and fills normally.

- **Rapid buys can no longer vanish and come back wrong.** Field report,
  twice: several quick buys, the position disappears from the overlay,
  then returns "in the green" with false P&L and a cash/equity mismatch.
  Root cause: two parts of the extension writing the wallet at the same
  moment could silently overwrite each other. Every wallet write now goes
  through one strictly-ordered commit with conflict detection — a write
  that lost the race adopts the winner and re-applies itself instead of
  destroying anything.

- **The sell buttons stopped moving.** The P&L number above them wraps to
  a second line as it grows and un-wraps as it shrinks, which shoved the
  quick-sell row up and down under your cursor mid-aim. The card now
  reserves that space permanently.

- **Brand-new coins are tradeable the moment you land on them — whatever
  launchpad they came from.** The instant path used to exist only for
  pump.fun coins. Now every pending address is probed on-chain once: a pool
  we can decode (pump curve, Whirlpool/CLMM, Raydium/PumpSwap
  constant-product) becomes a live price feed with an immediate first quote,
  and a bare mint gives up its real supply — which is what lets the site's
  own market-cap feed price a letsbonk/Believe/Moonshot launch honestly
  before any aggregator has heard of it. The probe also retries while the
  coin stays unindexed, so landing a few seconds early no longer costs the
  window. Same discipline as always: a number is refused unless exactly one
  honest reading of it exists.

- **X sign-in on papertrench.com now sticks in every browser.** The session
  used to ride a cross-domain cookie that Safari blocks, Firefox partitions,
  and Brave/private-mode Chrome drops — so sign-in completed and the site
  still showed you signed out. The sign-in now hands the session token to
  the page directly. Worker and site both deployed 2026-08-06.

- **Signing in on the site now links the extension by itself.** The
  dashboard's "Sign in on papertrench.com" button was a one-way door: you
  signed in and the extension never heard about it, so its Linked-account
  chip stayed gray forever (field report). A small relay script on
  papertrench.com — our site only, enforced by test — now closes the loop:
  the signed-in page hands your handle to the extension and the chip goes
  green on its own, still without the extension ever calling a server. The
  same relay makes the leaderboard's one-click **Sync work for unpacked
  installs** (it used to need a store id no unpacked install can have),
  gated by the same off-by-default Site-sync toggle, and the
  chain-conflict rejections on the site now carry a "delete my server
  record and start over" button instead of a sentence pointing at a link.

## v3.0.0 — 2026-08-06

A major version because the product gained a second asset class. Perps can
take your whole position in a single move, which is a different lesson from
spot and deserves to be announced as one — so the perps notes below lead with
what is *not* modelled yet. The version also carries the extension half of the
Arena, Forge, Turbo II, market-cap alerts, and chart take-profit/stop orders.

Two things worth stating up front. **Older attestation chains keep verifying** —
the record format now commits which chain a fill belongs to, and the deployed
verifier accepts both the old and new formats, so nobody's submitted history is
invalidated. And **multichain does not ship in this release**; see What's next.

- **The Game tab actually shows up now.** v2.11.0 wired the tab's button,
  content, and renderer — but not the one hardcoded list that controls
  section visibility, so the tab rendered into an invisible container and
  the screen stayed empty. One line, plus a generic test so no future tab
  can repeat it. (This was written up as "v2.11.1", which was never
  released; it ships here.)

**Paper perps on Hyperliquid and Jupiter.** Leverage, on the venues you
actually use, with the venue's own costs. This is the first release with an
instrument that can take your entire position in a single move, so it ships
as a major version: perps are not spot with a bigger number, and the notes
below say plainly what is and isn't modelled yet. Open a paper long or short
from a ticket that sits on the
venue's own page, priced off the venue's own feed. $10 at 20x and $5 at 100x
are both one slider away — and the ticket shows you what each actually costs
before you click.

- **Four numbers before every entry.** Position size, the fee you'll pay to
  open, your liquidation price with how far away it is, and what the position
  costs you per hour to hold. On Hyperliquid the liquidation distance is also
  shown in ATRs — "1.3 ATR away on the 5m" tells you something a percentage
  can't: whether ordinary noise reaches it.
- **Real venue costs, not a house average.** Hyperliquid charges its own taker
  and maker fees and funds hourly at the venue's live rate; Jupiter charges its
  6 bps base fee, its own price-impact fee from the pool's published scalar,
  and borrow at the hourly rate the venue displays. Longs pay funding when the
  rate is positive and receive it when it's negative, exactly as the venue does
  it.
- **If the venue's live rate can't be read, the ticket won't open.** A perp
  without funding isn't the instrument — it's a fantasy where leverage is free.
  The ticket stays closed and says why.
- **Liquidation is modelled, not simulated loosely.** Isolated margin: the most
  a position can lose is the margin you put into it. Hyperliquid liquidations
  fill at the venue's trigger price and return whatever survives; on Jupiter, a
  liquidation forfeits all remaining collateral, which is what Jupiter does. The
  ticket says out loud that paper liquidations fill at the trigger and real ones
  usually fare worse.
- **Positions keep costing you while you're away.** Funding and borrow accrue
  while the tab is open, and when you come back after closing it, the position
  is settled against the venue's own funding history and candles. If the price
  crossed your liquidation while you were gone, the round is reconstructed from
  that data and labelled as reconstructed. If the venue's data doesn't cover the
  gap, nothing is invented — the time is recorded as unobserved and the row
  tells you your real cost would have been higher.
- **Your fills appear on the venue's chart.** Every entry, close and
  liquidation draws where it happened, with a line for your entry price and a
  line for your liquidation price — the number that actually decides a
  leveraged trade.
- **A perps tab in the dashboard, kept separate on purpose.** Balance, open
  positions, closed rounds, and fees, funding and borrow counted apart. Nothing
  from the perps book is ever added to a spot figure: a lucky leveraged run must
  not flatter the spot record you're graduating against, and a liquidation must
  not damage it. Equity there is marked at each position's last *observed*
  price and says so, because that page has no live venue feed.

**What perps does not do yet**

- **Hyperliquid and Jupiter Perps only.** Axiom's perps route isn't supported.
- **Isolated margin only.** No cross-margin.
- **Hyperliquid liquidations use base-tier maintenance margin.** Accurate at
  paper sizes; the tiers that apply to very large positions aren't modelled.
- **Jupiter fees cover the base and price-impact components.** The extra
  charge that applies when the pool's open interest is heavily imbalanced
  isn't included, so Jupiter costs can read slightly low in those conditions.
- **The TA strip is Hyperliquid-only**, because Jupiter has no candle source
  we've verified. On Jupiter it shows nothing rather than guessing.
- **Perps rounds don't affect your grades, streaks, rank or graduation.** The
  spot record stays the spot record.
- **A liquidation that happens while your browser is closed is discovered when
  you next open the page**, not at the moment it occurs.

**Market cap alerts — "tell me when it hits 500K."** Requested by
meestershrek. Arm an alert above or below any market cap from the panel and
get pinged when the market gets there. Type it the way you say it — `500K`,
`1.2M`, `850000` — and it fires once.

- **You do not have to own it.** An alert needs no position, which is the
  point: the coin you most want a ping on is the one you have not bought yet.
  This is the watchlist PaperTrench never had.
- **It fires while you are looking at something else.** Armed levels ride the
  same price request the positions bar already sends, so an alert on one coin
  still lands while you are deep in another chart on any open terminal tab.
- **The ping is a real desktop notification** — posted through the trading
  site's own notification permission, exactly the way its built-in alerts
  work. PaperTrench asks for no new browser permission to do this. If a site
  has notifications switched off, the alert still appears in the panel, and
  the panel says so *before* you arm one rather than after one fails to
  arrive.
- **One level, one ping.** Three terminals open is still one notification.
- **It reports what actually happened.** Memecoins do not stop politely at
  your level, so a fired alert shows the cap it *hit* beside the one you
  asked for — `500K → hit 1.18M` — the same both-numbers rule a gapped stop
  follows.

**Take profits and stops you drag on the chart.** The exit half of paper
trading, with a real terminal's ergonomics: arm a take profit or a stop and it
draws as a line you can grab and drop where you want out. They are the site's
own order lines — the same primitive its live trading uses — so they behave
the way your hands already expect.

- **The level means the same thing on every axis.** Market cap, USD, native
  SOL, or a perp's absolute USD — and you can flip mid-session. A drag hands
  back whatever unit the axis is currently in, and the conversion runs through
  a ratio rather than re-deriving the unit, so there is no per-axis special
  case to get wrong. When the unit genuinely cannot be established — no bar
  close yet, no rate — **no line is drawn and no drag is accepted**, rather
  than a level invented to fill the gap.
- **A stop that gaps fills where the market actually was**, not at the level
  you set, and the slip is recorded. A take profit that filled below its
  target reads negative the same way. Selling by hand first leaves the
  remaining percentage meaning what it says, and closing the position disarms
  everything attached to it.

**Fomo trades honestly now.** Fomo puts other people's numbers on every
surface — the social feed, the holder list, the thesis wall — and we were
reading some of them as live prices. Your P&L, your position value and your
average lines could all drift toward a stranger's entry from hours ago. Every
one of those surfaces is now treated as history, not as the market. If a
price is somebody's trade rather than the market's, it never touches your
numbers.

- **Your fills show up where they happened.** Fomo's chart doesn't offer the
  marker channel other terminals do, so buys and sells draw as chart shapes
  instead — and a sell no longer slides minutes into the past when the
  chart's live feed goes quiet.
- **The panel says what it's doing.** Instead of "connecting…" forever, the
  footer names the real state — including when fills are drawing as shapes,
  which is fomo's normal healthy mode — and says why an average line is
  missing when one is.

**Fixed**

- **Updates no longer leave your open tabs half-dead.** When the extension
  updated, Chrome left every already-open terminal tab running the old,
  disconnected copy: the panel was gone and nothing brought it back until you
  happened to reload the page. PaperTrench now restores itself in those tabs
  automatically — and only where the old copy is genuinely dead, so a working
  panel is never doubled up.
- **Birdeye pages work again.** Birdeye changed its address format, which
  quietly broke how we recognised its token pages.
- **The entry line stopped teleporting on fomo.** (Field report: "the avg
  fill line and where the entry thought it was just keeps teleporting
  everywhere — completely unusable.") The chart never declares whether its
  axis is a USD market cap or a SOL one — we infer it, and the boundary
  between the two moves with the SOL/USD rate, so a value sitting near it
  flips classification tick to tick while nothing about your position has
  changed. Each flip threw away the frozen level and recomputed it against a
  candle that had moved in the meantime, walking the line up the chart — a
  60% run dragged a 240k entry to 384k, with the fill bubbles riding along.
  A reclassification is no longer treated as a unit change. A real axis
  switch still re-projects, and a new average still moves the line. (F-43)
- **A fresh install keeps what your first save wrote.** Settings saved on a
  brand-new install could be partly reverted by migrations meant for old
  installs — including an AI endpoint and key entered together. Fresh
  installs now run no migrations at all, and old installs still get every
  one of them. (D-56)

**Forge — make the banner inside the dex's own checkout.** Community ask from
AmpBets: none of the tools generate the art for a dex banner, so you end up
pulling up Grok in another tab, going back and forth, and pasting a file into
a payment flow you already had open. Now when a paid upload box appears on a
dex — fund, boost, enhance token info — a **Generate** chip shows up on the
image slot itself.

- **Two AIs, because they do different jobs.** A *narrative* model reads what
  the coin is actually about and writes the art direction; an *image* model
  draws it. Grok is the interesting narrative pick: it runs xAI's server-side
  `x_search` tool and reads X before writing the brief, so the art matches the
  joke people are posting right now instead of a generic frog. The brief lands in an editable
  box — it is a starting point, not a decision made for you, and the sources
  it read are listed as clickable citations.
- **Bring any key.** OpenAI-compatible `/images/generations` (OpenAI, xAI, and
  the many hosts that copy that shape) works as-is; Gemini and Stability have
  their own adapters. For anything we ship no adapter for — Higgsfield, a
  private model, whatever launches next month — pick **Custom** and paste the
  endpoint, headers, a body template and where the image sits in the reply.
  No waiting on us to add your provider.
- **Fast, on purpose.** The narrative research starts the moment an upload box
  is spotted — and earlier still if you so much as hover the fund button — so
  the brief is usually home before you have finished reading the form. Options
  render in parallel, so four is barely slower than one.
- **It reads the box instead of guessing.** The required image size is lifted
  off the checkout's own copy at runtime, and the panel says whether the size
  came from that page or from our preset. We ship no table of per-site pixel
  requirements, because we would be inventing it.
- **It never lies about what landed.** The file is set on the upload input the
  way a real upload does it, with a drag-and-drop fallback for boxes that want
  one. If neither works, it says so and gives you the download — it will never
  print "dropped in" over an empty uploader you are about to pay for.
- **Off by default, and it never spends anything on its own.** No key, no
  feature. Keys live on your machine, are never synced, and every provider
  call happens in the extension's worker — a page can never read them out of
  the DOM. PaperTrench never submits the form and never pays for anything.
- Needs no new Chrome permissions: it runs inside the site access PaperTrench
  already has.

Turbo II — the speed pass, everywhere at once. Ask the Turbo receipts card
whether any of this is real; that is what it is for.

- **Every terminal is a warm destination now.** BullX, Photon, Dexscreener,
  Birdeye and Jupiter join Axiom, Padre, GMGN, Fomo, pump.fun and Solscan —
  the matrix is closed: a token link between ANY two supported sites routes
  through that family's kept-warm viewer instead of a cold tab. Same rules
  as before: token routes only (wallet/portfolio/EVM shapes never route),
  terminal viewers are click-created (no new pre-warmed tabs), and a closed
  viewer stays closed until you click that destination again.
- **Press-time prefetch.** By the time your button is down you have already
  decided; the release is pure latency (~60–120ms). The hidden viewer now
  starts navigating at pointerdown, so the click that follows finds a page
  that has been loading since the press. Hints only — a press that turns
  into a drag or a text-selection costs nothing and claims nothing.
- **Trajectory prefetch.** A cursor moving fast and straight AT a link is a
  hover announced early. PaperTrench projects the pointer ~200ms ahead and
  fires the same hover hint at the link it is going to land on — the dwell
  timer that used to start when you arrived has often already fired before
  you get there. Wandering, drifting, and flicking cursors never trigger it
  (the predictor is pure math with tests to that effect), a wrong guess
  costs one hidden hop, and all three signals — dwell, press, trajectory —
  share one hint budget, so stacking them never stacks traffic.
- **Instant links on Discord, Telegram Web — or every site (each opt-in,
  off by default).** Token and X links do not only live on trading sites;
  they get pasted into chats all day. Three new toggles register the link
  interceptor (classifiers + warm routing, nothing else — no overlay, no
  engine) on discord.com, web.telegram.org, or every https site. Only
  classified token/X links are ever touched; every other click stays native.
  This added the `scripting` permission — the runtime-registration API is
  what lets the manifest's own content scripts STAY narrow, and with the
  toggles off, nothing is injected anywhere (docs/PERMISSIONS.md has the
  full audit).

**What's next**

Multichain paper trading is built and waiting. It ships once each chain can
carry its own paper balance in its own coin — SOL on Solana, ETH on Base, BNB
on BSC — rather than converting everything into one SOL book. That is the
version worth having, so it lands next release instead of this one.

## Live on the website — 2026-08-06

Everything below is **deployed and live** at papertrench.com and the
verifier API — unlike the extension work above, which is committed but not
yet released. The two were sharing one "Unreleased" heading, which made a
shipped feature and an untagged one look like the same state.

The Arena — PaperTrench gets a social half, operated entirely through the
website so the extension stays lightweight, open-source and disconnected.

- **A real leaderboard server** (`server/`, Cloudflare Workers + D1). Your
  submitted chain is re-hashed link by link, replayed from the raw fills,
  and every price re-checked against the token's actual traded range that
  minute. Standings never rank a self-reported number, a replaced history,
  or a price that never existed.
- **papertrench.com/leaderboard** — season standings with X sign-in, one
  ranked record per verified account. Rank is process-weighted: ROI on
  your declared bankroll × sustained rounds × discipline (revenge
  re-entries and drawdown cost you). Five closed rounds minimum; one
  lottery ticket does not top this board. A podium for the top three, a
  timing tower for everyone else, and your own row highlighted wherever it
  lands.
- **Watch it verify.** The hero of the board is the verifier's live output:
  chains accepted, records verified, submissions rejected, as they happen.
  "We check everything" is a claim; watching the checks is evidence.
  Rejections are shown **without a handle** — an automated verdict can fire
  on thin candle data as easily as on fraud, and must never publicly brand
  a named person a cheat.
- **The weekly Trench Sprint** — UTC Monday-to-Monday, only rounds opened
  AND closed inside the window, scored by ROI on window-start equity so a
  10 ◎ bankroll races a whale evenly. Your normal practice is your entry.
- **Duels.** Challenge anyone with a share link: one opponent, one shared
  clock, 1 hour to 1 week. The interesting part is settlement — a duel
  settles only from a chain submitted AFTER the window closes. The chain is
  append-only and extend-only, so you cannot delete a losing round; that
  leaves exactly one trick, submitting while you are up and then going
  quiet, and post-close settlement kills it. Refusing to submit forfeits
  instead of freezing a flattering snapshot. Live standings during the
  window are shown and labeled provisional; they decide nothing. And
  because the window is just a slice of the same chain, there is no duel
  book to inflate.
- **Clans.** Found one, or join with an invite code, and trade under a
  `[TAG]` that follows your handle across every board. A clan keeps no book
  of its own: its number is the **mean of its five best members**, and a
  member's rounds only count **from the day they joined** — so a lifetime
  record cannot be recruited in and donated, and a round belongs to exactly
  one clan, the one you were in when you closed it. Two consequences worth
  knowing before you build a roster. Extra members are free, so taking in
  beginners never costs a clan anything (a board that charged clans for
  teaching would work against the entire point of this product). And
  **cutting a struggling member can never raise your score** — the top five
  is the top five whether or not the people below it are on the roster; all
  expelling someone can do is drop you under the five-member minimum. Under
  five qualified members a clan reads *forming*, with how many it still
  needs, rather than being shown with a zero. Clan pages attribute the
  number to the five names that make it. And clans inherit the verification
  bar the boards use: **only a fully verified record takes a position** —
  score, rounds and P&amp;L alike. A member still waiting on re-pricing appears
  on the roster, labeled, reading *not counted*, with no figures borrowed
  into the clan's totals. Without that a clan would have been the way to
  launder exactly the records the boards stopped ranking.
- **Clan names: swear freely, slurs are the line.** The narrowest filter that
  still means something. Profanity, crude humour, drugs, violence as market
  metaphor and trash talk about anyone all pass; slurs and sexualised-minor
  terms do not. That is the entire list, and the refusal never repeats the
  term back at you. Matching is on whole words rather than on the squashed
  string, because squashing invents collisions nobody typed — an earlier
  design rejected "Chin Kickers", "Flame Retardant" and "Spicy Gains", and a
  red team later caught it refusing "Filled at 14.88" because a hate code
  hides inside that price. Both failure directions are locked by a corpus of
  real names and mottos in the suite. It is a floor rather than a guarantee,
  and it says so out loud.
- **Achievements, on the house doctrine.** Badges derived from your
  committed fills — and, exactly as in the extension, **none for profit,
  win streaks, or volume.** Losses taken without chasing the mint that took
  them. A drawdown you actually traded back from. Sizing that did not grow
  after a loss. Every badge shows the evidence that earned it, and a badge
  you could earn by never being tested is not a badge: "Clean Hands" counts
  losses not chased, because a record with no losses has demonstrated
  nothing about revenge discipline.
- **Public profiles** with verification stated plainly (verified /
  verifying / partial data), the chain head, the score broken down into its
  three terms, the badge case, sprint history, and a share card you can
  download or copy.
- **Two ways to submit, both yours to initiate.** Export your record as a
  JSON file from the dashboard's Leaderboard tab, or flip the new
  **Site sync** toggle (off by default) and click Sync on the site — the
  extension answers papertrench.com only, and still never phones home.
- **Self-serve deletion** on the leaderboard page, and an updated privacy
  policy that states the split precisely: extension fully local, website
  leaderboard opt-in only.
- **The homepage stopped pretending.** Its leaderboard card used to show
  five invented traders and a ticker of random hex dressed as hash links.
  Both now render real standings and real verifier events — and say so
  plainly when there are none. A product whose whole claim is that its
  numbers are never wrong cannot open with fictional ones.
- **Only fully verified records take a position — anywhere.** Reported by
  a user who edited an exported file to hand themselves an absurd P&L: the
  hash chain proves a history is *consistent*, not that it *happened*, and
  attest.js is open source, so a fabricated history can hash perfectly.
  Re-pricing against real market data is the check that catches it — which
  made a record the re-pricer *could not* check (`partial`: unlisted
  mints, thin candle data) exactly the record a fabricator would choose.
  Now the season board, the Sprint, clan means and their volume lines, and
  duel settlement all count **verified records only**; anything less shows
  on your own profile, labeled, and decides nothing. Closed by the same
  report: a first submission can no longer declare a bankroll smaller than
  its own fills prove spending (`bankroll-too-small` — you cannot have
  spent 4 ◎ from a 0.01 ◎ balance).
- **What "verified" means, and what it does not.** Verified means every link
  in your chain was re-hashed, your book was replayed from the raw fills on
  our side rather than trusted from your file, and every fill's price was
  checked against what that token actually traded at that minute. It does not
  mean we watched you trade. A hash chain proves a history is internally
  consistent — that it has not been edited since it was written — and
  `attest.js` is open source, so someone determined can fabricate a history
  and compute perfectly valid hashes for it. Re-pricing against real market
  data is what catches that, and it catches exactly one thing: prices that
  never existed. Someone who fabricates using real prices at real times is
  claiming perfect hindsight, which the market bounds but cannot disprove.
  Two things make that expensive rather than free: your declared bankroll
  cannot be smaller than your own fills prove you spent, and once you have
  submitted, your chain can only ever be extended — never replaced — so
  hindsight is available before your first submission and never again. We
  would rather say this plainly than let one word carry more than it earns.
- **Paper trading is not trading.** No slippage on size you could never have
  filled, no failed transactions, no MEV, and none of the weight that arrives
  when the money is real. What it does rehearse is the part most accounts
  actually die of: sizing, exits, and not chasing the coin that just took
  your money.
- **One ranked record per X account is expensive to sybil, not impossible.**
  Ranking is bound to a real, public X account, so running ten identities
  costs ten accounts with ten histories. That is a price, not a wall.
- **Sign-in now sticks in every browser** (deployed later the same day).
  The Arena's API lives on a different domain than the site, and the
  session used to ride a cross-domain cookie that Safari blocks, Firefox
  partitions, and Brave/private-mode Chrome drops — you could complete the
  X sign-in and still land signed out. The sign-in now hands the session
  token to the page directly, so no cookie policy can eat it. The
  cookie-based path remains for a future same-site deploy, and the page
  still names the failure honestly if a session ever fails to stick.

## v2.11.0 — 2026-08-05

The Game tab — and a round of community fixes.

- **A Game tab in the dashboard.** Your full trench profile: the tier
  ladder with every gate's live progress, streaks, reps, the badge case,
  and your process distribution over the last 30 graded rounds.
- **Three trading games, played on the live charts you already trade.**
  The Gauntlet (ten straight rounds, thesis written, no revenge — break a
  rule and the run resets), One-Shot (one entry, one exit for the whole
  day, 50%+ captured; a second round busts it), and Score Attack (best
  average capture across a 3+ round day — the high score is a day, not a
  lucky exit). All derived live from your journal: no start button, no
  stored game state, nothing to cheat. A Gauntlet run from 3 up rides the
  positions bar.
- **Challenge tracks:** Journal Week (seven traded days, every round
  thesis'd — quiet days never break the run), Clean Sweep (15 rounds
  without a round-trip), Sniper Five, Cold Blood.
- **Warm pump.fun/Solscan viewers respect a close.** (Reported by
  Eyes343.) If you close a warm viewer tab, refreshing the DEX no longer
  reopens it — closed stays closed for the browser session, and your next
  actual pump.fun/Solscan click brings it back.
- **Focus mode, round three — toshi_100x's "small sleek simple".** The
  header slims to a drag strip (subtitle gone, icon smaller) and the cost
  chips collapse out of focus mode — the ✎ still opens the editor, so
  nothing is lost, just not narrated.
- **fomo.family is a supported terminal.** Overlay, warm mirror, and X-Ray
  contract-address recognition on Fomo pages.
- On the roadmap by community request (TheRedShark123): a **paper copy
  trader** — watch a wallet, mirror its trades into a separate shadow book
  at your realistically-observed fills, and get an honest verdict on
  whether it's worth copying. Design is in ROADMAP.md Phase 7.

## v2.10.0 — 2026-08-05

Trench Rank — discipline is now the game.

- **Every closed round gets a process grade, S to F.** Graded on your plan,
  your exit, your sizing, and whether the entry was revenge — never on
  P&L. A disciplined red round grades S. A lucky win can grade F: it gets
  called lucky in the rounds table and on the card, and the close toast
  names the habit out loud ("that habit pays until it doesn't").
- **Trench Rank ladder on the overview.** Six tiers from Fresh Meat to
  Graduated, staged over the graduation criteria with live progress bars.
  The summit is the graduation bar itself: the game ends on purpose.
- **Discipline streaks.** Journal, clean-exit and no-revenge streaks with
  flames from 3 up — on the dashboard and the positions bar.
- **Daily drills and reps.** One rotating drill a day, measured from your
  actual rounds; reps diminish after 10 a day because tired reps don't
  count — that's a lesson too.
- **Badges** for the things that predict survival (first thesis, cold
  streak survived without sizing up, 80%+ captures, 25 rounds without
  revenge). Deliberately none for profit, win streaks, or volume.
- **The share card carries your rank, grade and badges** inside the same
  PAPER frame — and now points at papertrench.com.
- **Calendar shows a per-day process dot** (the day's dominant grade;
  ties round DOWN to the worse letter).
- Everything is derived live from the journal you already have. Zero new
  stored data, nothing to migrate, nothing to cheat. Your numbers are
  untouched — this update changes what gets celebrated, not what gets
  counted.
- Also fixed: the graduation bar's thesis criterion could never pass
  (it counted a legacy data shape) — real journalers now measure true.

## v2.9.1 — 2026-08-05

The average line tells the truth again.

- **Average fill/exit lines no longer jump to absurd levels on mcap
  charts.** If you ran a multichart layout (or flipped a chart between
  price and market-cap mode), the line could land a supply-factor off and
  stick there — the level math trusted whichever data series ticked last,
  even when it was the same token in a different unit. Level math now vets
  every close by unit before using it, and draws no line at all rather
  than a wrong one until the right-unit data arrives.
- **DCA moves the line immediately.** Averaging in while the line was
  still being created no longer leaves it at the old average.

## v2.9.0 — 2026-08-05

Lev round two — the quick fixes now live where he meant them.

- **A pencil on the trading panel.** The ✎ in the panel header opens a
  compact inline editor right on the trading tab — buy presets, sell
  percents, and fee/gas/tip/slippage — with the same validation rulebook
  the dashboard and popup use. Your costs ride as Fee/Gas/Tip/Slip chips
  under the buy row, click-to-edit, in both modes.
- **Focus mode is genuinely Axiom-compact now.** No balance card (cash
  rides inline on the Buy label, refreshed per fill), and while one-tap
  presets are on the big BUY button gets out of the way — the preset chips
  ARE the buttons, and Enter in the amount box buys. Instant-buy off keeps
  the button.

## v2.8.1 — 2026-08-05

Update from v2.8.0 — it matters this time.

- **v2.8.0 shipped with attestation-chain recording broken.** The release
  accidentally carried half of an in-flight migration: fills asked for the
  new segmented chain store, which was not aboard, so every paper fill made
  on v2.8.0 failed to append to your local attestation chain (the honest
  "could not be added to the verification chain" toast fired each time —
  the failure was visible, the chain simply could not record).
  Your wallet, balances and P&L were never affected — the chain is the
  tamper-evidence layer used by leaderboard verification. On v2.8.1 the
  chain records again; fills made during the v2.8.0 window are simply
  absent from the chain, and the verify panel will honestly show that gap
  rather than pretend it is not there.
- **The attestation chain grew up (F-14).** It moved out of the wallet
  state into a single-writer segmented store: a fill now rewrites one small
  tail segment instead of the whole history, multi-tab chain races are
  gone, and no hash is ever truncated. Backups are downgrade-safe — a new
  backup restores intact on a pre-segmentation build. Resets clear the
  chain atomically with the wallet, and the leaderboard verifier format is
  unchanged.
- **For the record: v2.8.0 also contained the Turbo receipts card** (the
  Settings card counting warm vs cold opens, median routing latency, and
  per-site main-thread stalls — measured locally, never sent anywhere).
  Its release notes did not mention it; the feature description now lives
  in both entries, where it belongs.

## v2.8.0 — 2026-08-05

Two from the maintainer's own trench session, same screenshot.

- **Fresh launches are snipeable — "ARMED … ON FIRST QUOTE" actually fires
  now (F-34).** A 39-second-old pump.fun coin used to strand the armed buy
  forever: no aggregator had indexed it, and with the chart in MCap mode
  every close was refused as "no implied supply". Two fixes, layered:
  - **The bonding curve is read directly.** The moment a pending coin looks
    like pump.fun — the pair address on an Axiom page, or a mint ending in
    "pump" anywhere — PaperTrench finds its bonding curve on chain (derived
    from the mint via the program-address rules, verified against five live
    mainnet curves), identifies the real mint from the curve's reserve
    account, and streams the curve as a live CHAIN ⚡ feed with an immediate
    first quote. The armed buy fires seconds after launch, and the fill is
    chain state, not a guess.
  - **MCap-mode charts can price pump coins.** Pump supply is a protocol
    constant (1e9), so an mcap-scale close IS a price. All four readings of
    an unlabelled chart value (price vs cap, USD vs SOL) are judged against
    sane bands and the tick is used only when exactly one fits — ambiguity
    still refuses, per the F-25 discipline.
- **Rug guard (on by default).** Requested with a LOL, built with a straight
  face: when chain state says the float is in a handful of wallets, a paper
  BUY is refused with a toast that names the number — "🚩 RUG WARNING — top
  10 wallets hold 47% of supply". The check reads the 20 largest token
  accounts plus the mint supply, excludes the pool/curve reserve (and SAYS
  when it had to assume which account that was), flags the panel footer the
  moment the verdict lands, and never blocks a SELL — exiting a rug is the
  right move. A failed chain read blocks nothing: a guard that cannot see
  is not allowed to invent. Threshold and off-switch live in Settings →
  Guardrails; this is the one guardrail that ships ON, because the
  maintainer asked for exactly that.

## v2.7.1 — 2026-08-05

Housekeeping with a straight face: v2.7.0 was tagged and published
mid-batch, before the last five commits landed. If you downloaded 2.7.0,
update — it is missing the Instant terminal links, the dashboard
refresh fix ("stopped re-reading everything every 4 seconds"), and an
X-Ray dock fix, all described in the v2.7.0 notes below. v2.7.1 is the
complete batch; nothing else changed.

## v2.7.0 — 2026-08-05

Community feedback batch #2 (thanks again lev) — all four items, with the
video evidence doing the heavy lifting.

- **Fills land on the chart you are looking at — the "instant +14%" is dead.**
  On migrated (AMM) tokens, the on-chain price feed could silently lose one
  side of every trade it watched: both pool vaults change in the same slot,
  and the stale-frame guard threw the second one away as "old". One vault
  tracked the market, the other froze, and paper fills executed up to ~13%
  away from the live chart — booking instant fake profit that taught exactly
  the wrong lesson (F-33). The guard is now per-vault, with a regression test
  driving a real same-slot vault pair. And belt-and-braces: at fill time the
  chain price is reconciled against the price on your screen from the moment
  you clicked — if they ever disagree by more than any real sub-second move,
  the fill takes the on-screen price and logs the divergence. A paper fill
  can no longer be double digits away from the chart you clicked, no matter
  what breaks upstream.
- **Close the hot X tab, it comes back.** Accidentally closing the Instant X
  links viewer no longer degrades the feature until you rediscover the
  toggle: while the toggle is on and a trading tab is open, a fresh hidden
  viewer takes its place immediately. Turning the feature off remains the
  one way to not have a viewer (and a closing browser window never respawns
  anything).
- **Your own X tab IS the warm tab now.** With no registered viewer, a
  clicked X link — post, profile, or a token's community — used to open a
  separate tab right next to the x.com tab you already kept. Now PaperTrench
  adopts your existing X tab as the viewer and routes into it, community
  links included. It will never claim a tab you are looking at, a pinned
  tab, or one playing audio — and adopted tabs are yours: toggling the
  feature off never closes them.
- **Quick settings in the popup.** The knobs you actually re-tune
  mid-session — starting balance, quick-buy presets (SOL), quick-sell
  presets (%), and a fees profile (Axiom/Padre bot · aggressive sniper · no
  costs) — are now editable straight from the extension popup. Validation is
  the dashboard's, verbatim: a bad value keeps your saved value and says so;
  fee profile numbers are pinned by a test to match the dashboard's card.
  The full Fees & costs form stays on the dashboard.
- **Flex without leaving the terminal.** The Flex button on the closed P&L
  card now opens the share composer as a floating window centered over the
  page — no more bouncing to a dashboard tab. It is the SAME composer:
  identical card, backgrounds, customize toggles, Copy and Download, and the
  same shared background gallery (uploads made in the overlay appear in the
  dashboard composer and vice versa). Esc or a backdrop click closes it. The
  card math now lives in one shared derivation (pnlcard.js) used by both
  composers, so a card can never show different numbers depending on where
  you opened it. The PAPER watermark rides along, as always.
- **Instant pump.fun & Solscan links (opt-in).** The Instant X viewer idea,
  generalized: with the new toggle on, pump.fun and Solscan links from your
  terminal open into up to two muted background viewer tabs — already warm
  when you get there, with hover prefetch. Ctrl/click bypasses the viewer
  and opens a normal tab. Off by default; the toggle says what it costs.
- **PaperTrench off costs the page nothing.** The feed-demand gate: when no
  consumer exists for price frames (overlay disabled, wrong page, chips
  off), the bridge drops them before the body copy and the JSON parse —
  zero parsing donated to the host site.
- **Chips stopped fighting the page for layout.** Chip positioning now runs
  in read/write phases with diffed style writes, so screener chips no
  longer thrash layout at volume peaks.
- **Instant terminal links (opt-in).** Axiom, Padre and GMGN token links
  clicked on another terminal open in that terminal's kept-warm viewer, and
  a positions-bar hop to another terminal no longer replaces the tab you
  are on. Terminal viewers appear on first use (pump.fun and Solscan still
  pre-warm) — the cost stays up to two muted background tabs.
- **Turbo receipts.** The popup counts your warm vs cold opens and shows
  the median routing time — measured on your machine, stored locally,
  never sent anywhere.
- **The positions bar respects late headers.** It now measures the site
  header until it settles, so slow-painting headers no longer end up
  underneath it.
- **The dashboard stopped re-reading everything every 4 seconds.** It now
  refreshes the instant your data changes, naps while hidden, and leaves
  the recordings database alone unless a new replay landed.

## v2.6.0 — 2026-08-05

Requested by the maintainer: the X page you land on should already tell you
who you are looking at.

- **X-Ray (opt-in).** Open any X profile — or any post, where the card reads
  the author — and the intel is already on screen. No button, no "analyze",
  no waiting: PaperTrench remembers what it has seen about an account, so the
  card paints from local storage in the same frame the page routes, then
  fills in live as X's own data lands.
  - **Bio changes.** How many times the bio changed, when it last changed,
    and what it said before.
  - **Name and @handle changes.** Counted separately, because a display-name
    swap and a rename are different tells. Case-only differences are not
    renames — a fake counter is worse than no counter.
  - **Contract addresses posted.** Every CA the account has posted, dated by
    the post itself, newest first, click to copy. A CA sitting in the bio
    right now gets its own flag. Long posts are read past the 280-character
    fold, which is exactly where the address usually is.
  - **Smart Following.** The biggest accounts following this one, ranked by
    follower count, with the ones you personally follow marked as such.
- **Where the data comes from, exactly.** X-Ray reads the X app's own
  responses for a fixed allowlist of operations (profile, that account's
  posts, follower lists) as your browser receives them. Home timeline, DMs
  and notifications are never parsed. What leaves the page is a digest —
  dates, ids, addresses, follower counts — never the text of anyone's posts.
  The ledger is `chrome.storage.local` on your machine. No server, no shared
  database, no upload, no account of yours used to follow or interact with
  anything. Zero new extension permissions.
- **What it refuses to pretend.** Nobody can tell you a bio changed on a day
  they never saw the bio. Products that imply otherwise are reading someone
  else's surveillance database; PaperTrench does not have one and will not
  fake one. So every change counter on the card carries the window it was
  observed over — "no change seen · watching since Aug 5" — and CA history
  and Smart Following say which posts and lists they were built from. A floor,
  labeled as a floor, is worth more than a confident number that is wrong.
  The watch window starts the first time you view an account, so the card
  gets sharper the longer you use it.
- **Deep scan (on with X-Ray, separately switchable).** Lets the page re-issue
  a request it already made — the same one X fires when you scroll — to read a
  few more pages of posts or the follower list. Throttled by minimum spacing,
  a per-minute cap and a per-account cooldown; runs only while you are on that
  account; uses your existing X session against x.com itself. The service
  worker never contacts X. If X rotates its API, the deep scan quietly stops
  and the passive layer keeps working — the card degrades, it does not break.
- Suite: 749/749, including a hand-built DOM that drives the card end to end
  (an intel card that throws is an intel card that is not there) and tests
  pinning that a first sighting can never be reported as a change, that a
  sparse user object embedded in a tweet cannot register as "bio cleared",
  and that a forged page-world digest cannot write a fake contract address
  into the ledger.

## v2.5.2 — 2026-08-05

Three fixes straight from the maintainer taking a live trade.

- **The resize grip can never stick again.** A cancelled gesture (misclick,
  drag out of the window, context menu) used to leave the drag latched — the
  panel kept resizing with every mouse move. Pointer capture now guarantees
  a terminal event, and pointercancel ends the drag like pointerup.
- **Resize from any corner.** All four corners are grips. The panel is
  right/top-anchored, so left corners grow it leftward from the planted
  right edge, and top corners grow it upward while the bottom edge stays
  planted.
- **Flex it — wins AND losses.** The Closed P&L card in the overlay now has
  a Flex button that opens the share composer for that exact result (the
  newest round, or the open position after a partial exit). Losses are
  flexable by design; the PAPER watermark rides along either way.
- **The Closed P&L card stopped blinking.** It was being rebuilt on every
  heartbeat, re-running its entry animation each time. It now renders once
  per close; only the how-long-ago text updates in place.

## v2.5.1 — 2026-08-05

Spotted in the maintainer stream footage: the real terminals card an OPEN
position — the "still holding" flex — and ours only carded closed rounds.

- **Share an open position.** Live open positions on the Overview now carry
  a Share button. The card states OPEN, the middle column reads POSITION
  (live value at the last recorded mark), the journey line claims no EXIT
  that has not happened, and USD figures appear only where fills and marks
  genuinely recorded them. Same gallery, same Customize/Download/Copy —
  and the same un-removable PaperTrench branding.

## v2.5.0 — 2026-08-05

Requested by the maintainer: let people flex their PaperTrench P&L — with
the one thing that can never come off the card.

- **The share card grew up.** Terminal-grade composer: token symbol and
  multiple chip, a huge ◎ SOL P&L, Invested / Returned / P&L% columns with
  honest USD sub-lines (em-dash when a fill never had a USD price — never a
  fabricated conversion), the entry→exit→held journey line, and an
  observed-only After line ("−62% after exit — dodged") no other terminal
  can print, because no other terminal measures it.
- **Backgrounds, yours.** Five built-in looks plus your own uploads — max
  2 MB each, ten stored, saved between sessions, deletable. The drop zone
  still works and now remembers what you dropped.
- **Customize / Download / Copy.** Toggle which stats show, pick a trim
  accent, download a PNG, or copy straight to the clipboard for
  paste-and-go posting.
- **The non-negotiable, by construction:** the PAPER watermark and the
  PaperTrench brand bar are drawn last by a code path that reads no
  settings — verified by a test that drives every combination of options
  and asserts the branding survives all of them. Flex the result;
  never fake it.
- **Instant X links now speak GMGN and Axiom.** The first field report —
  "works on Padre, not the others" — came down to link forms: GMGN trench
  rows link a token's X *community* (`x.com/i/communities/…`) and Axiom's X
  affordance is a *search* for the CA, and both used to fall through to a
  cold tab. Both warm-route now. Interception also moved to the earliest
  point in the event chain and finds anchors through shadow DOM, and any X
  link form still unrecognized logs its exact URL to the service-worker
  console (locally) so the next gap names itself.
- **Hover preview cards (opt-in).** The terminals' own tweet previews are
  small and demand you hit a 14px icon. PaperTrench's card is big, readable,
  and IS the click target — hover an X link and the post renders right on
  the page (~200ms via X's public oEmbed endpoint, no login, do-not-track,
  cached); click anywhere on the card to open it instantly in the warm
  viewer. A deleted post says "unavailable" on the card — the rug signal
  before you spend a click. Communities and profiles get a slim click-through
  card. A second opt-in goes further: rest the cursor anywhere on a token
  ROW for a third of a second and its preview appears — no aiming at all.
  Both settings live in the dashboard, both off by default.
- **Deleted tweets are fast now.** A dead link used to trigger a pointless
  "repair": X rendered "this post doesn't exist", the extension mistook
  that for a failed hop, and full-reloaded the same dead URL — seconds to
  say the same thing. The error page now counts as arrival (a deleted
  launch tweet is signal — see it instantly); only an error that was
  already on screen before the hop still falls through to the repair.
  Also pinned by test: classification never rewrites a link — path and
  query pass through byte-for-byte, so PaperTrench can never be the reason
  a tweet looks dead.

## v2.4.0 — 2026-08-05

- **A real off switch.** The popup now has a ⏻ button (and the dashboard an
  "Enable PaperTrench" checkbox) that turns the whole extension dormant:
  no overlay, no positions bar, no chart drawings, no title feed, no instant
  X links — on every open tab, immediately, until you turn it back on.
  "Disable overlay" only ever hid the panel; this is the switch for
  "I don't want PaperTrench showing up anywhere right now." Your wallet,
  journal, and every sub-setting are kept, so switching back on restores
  exactly the setup you had.
- **Instant X links (opt-in).** Traders vet a coin by clicking its X link —
  and then wait ~3.5 seconds for a cold tab to load. With the new toggle in
  the popup, X posts and profiles clicked on any supported trading site open
  in a kept-warm viewer tab via an in-page navigation: about half a second,
  and every follow-up click lands in the same already-hydrated tab. If the
  fast route ever fails, it silently falls back to a normal load of the same
  URL — worst case is exactly what you have today.
- **Hover prefetch.** Rest the cursor on an X link for a tenth of a second
  and the hidden viewer starts navigating there before you click — so the
  click itself often just reveals an already-loaded post. Hovers never
  create tabs, never move a tab you are reading, and a hover that never
  becomes a click costs nothing.
- Honest costs, stated up front: while enabled, PaperTrench keeps ONE muted
  background x.com tab as the viewer (closed again if you turn the toggle
  off before using it). Two passive bridge scripts now load on x.com —
  they act only on PaperTrench's own messages and are pinned by a manifest
  test to never include the trading engine or overlay. Zero new extension
  permissions, no telemetry, no remote switches. Ctrl/Cmd/middle-click
  always bypasses the feature and opens a real background tab.

## v2.3.0 — 2026-08-05

Community feedback batch (thanks lev) — all four items, same day.

- **The average line can never ride the candle again — by construction.**
  After one user still saw the drift post-fix, the recompute-per-second
  design was replaced outright: the line level is computed once per spec
  and FROZEN (an average is a constant level in axis units). If any data
  link ever goes stale again, the line holds at its last correct level
  instead of chasing the price.
- **Focus mode is now genuinely compact**: the position-detail rows
  (size / avg entry / value) hide — unrealized P&L and quick sell stay —
  and the whole panel tightens toward the size of the site terminal.
- **Quick reset in focus mode, no popup**: a ⟲ button in the panel header
  (focus mode only). Tap once to arm — it turns into "Sure?" for three
  seconds — tap again to reset. Streams keep their focus; fat fingers
  keep their journal. Resets clear recordings and chart drawings like
  every other reset path.

## v2.2.0 — 2026-08-05

Requested by the maintainer: make paper fills cost what real fills cost.

- **Fees & costs emulation.** A new settings card models the FULL cost of a
  real fill: the platform percentage (as before), plus a flat priority fee
  (gas) and a bribe/tip per transaction — the costs that dominate small
  entries and that zero-cost practice quietly ignores. Quick fill-in
  presets give rough starting points; your own site settings are the truth.
- The accounting is honest end to end: flat costs join the cost basis on
  buys and reduce net proceeds on sells, so per-sell P&L, rounds, the
  calendar, the equity curve (still exact to the SOL), and the verification
  chain all include them. A dust exit can genuinely net negative — you paid
  gas to leave a worthless bag, which is precisely the lesson.
- Defaults are zero, so existing wallets change nothing until you opt in.

## v2.1.0 — 2026-08-05

The value release: the practice loop gets its most important missing organ,
plus training wheels, data ownership, and a same-day community fix.

- **The After.** Every closed round now watches its coin for the following
  hour and records what ACTUALLY happened after your exit — observed
  extremes, sample counts, no interpolation. The rounds table gains an
  "After (1h)" column (a −30%+ dump after you sold reads green: you dodged
  it; a big run without you reads red), and the discipline panel aggregates
  your median further-upside and dumps-dodged across the record. The most
  expensive guesswork in this market — and the #1 revenge-FOMO trigger —
  replaced with measured truth.
- **Guardrails (training wheels).** Opt-in, enforced at buy time: a tilt
  breaker (N straight losses → cooldown), a max position size (% of your
  live book), and a daily loss limit. The three rules every surviving
  trader eventually adopts, practicable while the money is fake.
- **Fill bubbles land on the candles (community screenshot, fixed same
  day).** On mcap charts the fill markers floated above the candles (raw
  resolver-implied cap vs the chart own cap scale) and could park past the
  final bar (clock skew on 1 s charts). Shapes now share the avg line
  close-corrected level math — supply cancels, the chart scale wins — and
  clamp to the newest bar. The mcap-headline sub-line also says "Price …"
  now instead of the ambiguous "MC · …".
- **CSV export** for the journal and rounds — your data, one click,
  RFC-4180-safe, After columns included.
- **Onboarding checklist** on Overview for newcomers: first buy → thesis →
  first close → first After → review → the 50-round road to the graduation
  bar. Dismissible; disappears on its own once you have done it all.
- **Sharper prices on fresh launches**: ambiguous unknown-unit ticks are now
  refused with a distinct reason instead of risking a double-converted
  price; GMGN markers snap to the bar grid; host-chart callbacks are
  hardened so a PaperTrench bug can never break the site own chart; backups
  say honestly that screen recordings stay on this machine; replay
  scrubbing is memoized; coach timestamps match the calendar day you see.

## v2.0.1 — 2026-08-05

First post-2.0 community report, fixed same-day.

- **Holding a real position no longer confuses the paper numbers.** When you
  hold a REAL position on the same token, the site streams your real entry
  average alongside the live price — and PaperTrench was accepting it as a
  market tick, so the paper P&L and the average line could blend your real
  buy with your paper buy. Your own position data is now never treated as a
  market price: the avgPrice key is excluded and anything inside a
  positions/holdings/portfolio subtree is identity-only.
- **The paper line can never impersonate the real one.** Our average lines
  are now labeled "PAPER Avg. Fill" / "PAPER Avg. Exit" — deliberately
  different from the site own real-position label, same doctrine as the P&L
  card watermark.

## v2.0.0 — 2026-08-05 · out of alpha

The production release. A full four-track code audit produced a public,
ranked defect register (`DEFECTS.md`, 139 findings); v2.0.0 closes 116 of
them — every wrong number, every silent death, every wrong presence — each
with a regression test that fails on the old code. The rest carry explicit
engineering dispositions or sit on an enumerated v2.1 backlog (friction and
polish only). Suite: 553 tests, green.

**Numbers you can trust (the S1 class):**
- Fills can no longer execute at stale prices: chain state first, then the
  click-time snapshot, then a fresh page tick, then one resolver refresh —
  and a 3-second last resort for every source, aligned with the header's own
  staleness mark. Beyond that, the trade is refused with a visible reason.
  The old default path filled at prices up to 10 seconds old.
- Price collection is per-token: a batched frame can never attribute one
  coin's price to another, and trade arrays are read newest-first.
- The average-entry line finally HOLDS YOUR ENTRY. It used to ride the
  candle on market-cap charts. Unit toggles re-draw it immediately; before
  any chart evidence exists there is no line rather than a wrong-unit line.
- GMGN markers and lines are corrected against the chart's own candle scale;
  a fill without a genuine USD price waits for one instead of drawing ~150×
  low. Fill markers survive chart remounts and resolution changes.
- Sites without a native chart hook get an honest marker rail — real fills,
  real levels, no fabricated Y positions pretending to be chart-accurate.
- Dashboard accounting is unified: the equity curve converges exactly to
  equity, realized P&L includes partial exits everywhere, the verification
  chain agrees with an honest wallet by construction, and open/closed %
  share one basis.

**Feeds that survive volume (the S2 class):**
- The high-volume fixes that used to exist only for GMGN's trade feed are
  now the contract for every site: bigger parse guard with a bounded
  collector walk, per-mint throttling, and a 10× stress harness in CI.
- A fast runner no longer freezes the feed: sustained out-of-band ticks
  force an immediate re-anchor. Armed buys wait while the market is visibly
  trading instead of expiring on a bare clock.
- The RPC pool stops eating itself: vault discovery costs one round trip
  (and is cached), and a fully benched pool cools down instead of hammering
  dead endpoints.
- Screener quick-buy chips fill on the first tap, price from fresh quotes
  only, never stick busy, and step aside when the panel covers them.

**An overlay that behaves (the S3/S4 classes):**
- PaperTrench now runs ONLY on the nine supported trading sites — never
  anywhere else. Wallet, portfolio, and EVM routes never mount the panel.
  Pump.fun is a first-class site with its own adapter.
- Navigation is instant (SPA route hooks instead of an 800 ms poll) and can
  never trade the previous token on a new page.
- One drag system: panel, positions bar, minimized pill, and the collapsed
  tab all drag with touch support, both-bounds clamps, and positions that
  can never be lost off-screen. Disabling the overlay removes everything,
  including chart drawings; reloading the extension leaves nothing behind.
- The dashboard stops fighting you: tables keep their scroll position, async
  results survive refreshes, settings saves can't clobber your layout, and
  every failure says so out loud.

**New: the graduation bar.** The coach view now evaluates the seven-criterion
bar from `docs/GRADUATION.md` against your own journal — expectancy that
survives removing your best round, loss sizing, hold symmetry, revenge
re-entries, thesis coverage, cold-streak discipline — and missing evidence
never counts as a pass. Paper failure is definitive; clearing the bar earns
a small, careful start.

**Also:** structured bug-report form, a 9-site release QA matrix, a preflight
script that gates every tag, a full permissions audit (`docs/PERMISSIONS.md`),
and the public roadmap + defect register linked from the README.

## v1.2.18 — 2026-08-05

First fix batch from the public defect register (`DEFECTS.md`) — six correctness
fixes on the money paths, every one locked with a regression test.

- **Fast navigation can no longer trade the wrong token.** Switching coins while
  the previous one was still resolving could leave the panel showing — and
  **buying** — the previous token on the new page. Navigations that land
  mid-resolve are now retried instead of silently swallowed, and a resolve that
  finishes after you've left the page is discarded instead of resurrecting the
  old token.
- **Double-tap sells fill once.** Sells carry the same in-flight guard buys
  always had. A second tap on "SELL 50%" while the first is filling is refused
  — previously it silently sold 50% of the *remainder* (75% total) with two
  success toasts.
- **AI reviews and recording links stop vanishing from the dashboard.** The
  background service worker now advances the wallet's write counter, so open
  trading tabs adopt its writes instead of overwriting them within a second.
- **Backup restore sticks.** A restored wallet lands strictly ahead of every
  open tab's write counter, so a live tab can no longer resurrect the wallet
  you just replaced.
- **Screener quick-buy chips price honestly.** A chip tap now demands a quote
  no older than 3 seconds; previously it could fill at a price from the
  resolver's 60-second display cache.

## v1.2.17 — 2026-08-05

Reliability hardening release — no feature changes.

- **Storage failures are no longer silently ignored.** The background service
  worker now checks every `chrome.storage` read and write for errors. A failed
  read falls back to safe defaults (never a fabricated wallet, never an invented
  AI endpoint) and a failed write reports itself instead of pretending it
  worked. Locked with new regression tests that simulate storage failure the
  way Chrome actually reports it.
- **Stale AI credentials are cleaned up.** Settings migration revision 7: if a
  saved AI API key/model was tied to the removed insecure local endpoint (or to
  no endpoint at all), it's cleared — so an old key can never be silently sent
  to whatever endpoint gets configured next. Deliberately configured endpoints
  and explicit local opt-ins are untouched.

## v1.2.16 — 2026-08-05

- **Sell buttons no longer disappear after overlay toggles or SPA navigations.**
  Reported on v1.2.13: "still having issues with that sell button
  disappearing". Root cause: `disableOverlay()` and `shutdown()` destroyed
  the shadow DOM but left the position-card cache (`posEls`) pointing at
  detached nodes. On re-enable, `renderPosition()` saw a truthy cache and
  skipped rebuilding the card — so the new card was created without sell
  buttons. Both teardown paths now null the cache so the card always
  rebuilds cleanly. Locked by a source-contract regression test.

## v1.2.15 — 2026-08-05

- **Focus mode for the trade tab.** Requested from the community: "make the
  trading tab like Axiom and other platforms for more optimised and less
  distracted trades". A new **Focus mode (Axiom-style)** toggle in Settings
  → Overlay strips every decoration from the panel — banner, watermark,
  sparkline, thesis card, last-close card and footer — and leaves only
  token, price, balance and buy/sell controls. Opt-in; the full panel stays
  the default, and flipping the switch applies live on every open tab.

## v1.2.14 — 2026-08-05

- **GMGN high volume no longer kills the live feed.** Reported from GMGN:
  "doesn't work when volume is high". Two real causes, both fixed:
  - GMGN's realtime trade batches grow past the bridge's 500KB frame guard
    exactly when volume peaks. The guard dropped those frames *before* the
    trade feed could read them, so the live price went silent at the worst
    possible moment. Trade batches now bypass the guard (which still
    protects the generic collector); every other oversized frame stays
    dropped.
  - Hot batches carry trades for many tokens at once, and the token you're
    watching could get crowded out of the 4-tick budget by random batch
    order. The token on screen is now always emitted first.

## v1.2.13 — 2026-08-04

- **The panel now remembers its place.** Drag the PaperTrench panel anywhere
  you like — the position is saved and restored on every refresh, new tab,
  and every supported site. Previously each page load snapped it back to the
  top-right corner. If a saved position would land off-screen on a smaller
  window, it's clamped back so the panel always stays grabbable.

## v1.2.12 — 2026-08-04

Community report round three, both points addressed.

- **Average fill price is now honest on fresh launches.** The "Avg. Fill
  Price" line used to be computed only from the fills that happened to record
  a USD price. On a fresh launch the first ticks often pre-date the USD feed,
  so those fills carried no USD — and the displayed average quietly covered a
  subset of your fills (say 1 of 3 buys). Now: when the USD set is
  incomplete, the overlay derives the USD average from the *complete*
  SOL-denominated average at the live SOL/USD rate, so the line always covers
  every fill. When every fill recorded USD, the recorded average is used
  directly, as before.
- **Quick-buy (QB) settings found at last.** The five QB toggles existed but
  were buried mid-list inside "Wallet & Trading" — a user looking for "the QB
  toggle" couldn't find them. They now live in their own settings card titled
  **Quick-buy (QB)**: presets, one-click buy, screener chips, chip size, and
  the trade-tab buy section.

## v1.2.11 — 2026-08-04

Fixes GitHub issue #17 — a user's sell options disappeared mid-session.

- **Sell options no longer vanish on vault-style pools.** Constant-product
  vault tokens were priced from a description that never carried the token's
  decimals, so the first live vault update crashed the price handler. That
  crash killed the whole live-price stream, and without prices the sell
  buttons had nothing to quote against. Vault tokens now carry full decimals
  (token + wrapped SOL) before they're ever watched.
- **The live-price stream can no longer die from a single bad frame.** The
  socket handler is now crash-isolated: a malformed or hostile update is
  dropped and the feed keeps streaming. One weird token can't take down
  everyone's prices anymore.

## v1.2.10 — 2026-08-03

Second community bug report, second full audit — this one found three real
bugs, all now fixed and locked in with regression tests.

- **Reset no longer brings the old wallet back.** Resetting from the popup or
  dashboard wrote the fresh wallet at write-counter zero, so a still-open
  trading tab (holding the pre-reset wallet at a higher counter) overwrote it
  with its next heartbeat and resurrected your old positions. Resets now
  inherit the current counter and land strictly ahead of every open tab.
- **Buy and sell failures finally say so.** A mutation helper swallowed its
  own errors, so a rejected fill — insufficient balance, token changed mid-fill,
  a storage hiccup — left the button doing nothing with no message. Errors now
  reach the toast that reports them.
- **Dashboard writes can no longer be clobbered by a lagging tab.** Notes and
  AI reviews written from the dashboard now advance the write counter, so a
  slow price-mark from an open tab can't silently erase them.

Prices were checked too: the on-chain feed's stale-slot guard and 2.5s
freshness window are intact and were already covered by tests.

## v1.2.9 — 2026-08-03

The "updating shouldn't erase you" release. Unpacked extensions tie their data
to the install folder, so a fresh unzip into a new folder looked like a brand
new wallet. Two fixes for that, plus the groundwork for a proper fix.

- **Backup & Restore in the popup.** One click downloads your whole wallet —
  positions, rounds, history, settings, frames, replays — as a single JSON
  file. Restore validates the file and confirms before overwriting anything.
  Moved folders, reinstalled, or switched machines? Two clicks and you're back.
- **The site now teaches same-folder updates.** Unzip the new release *over the
  folder you already loaded*, hit Reload, and your data survives. A new folder
  starts a blank wallet — now spelled out on the install page.

Coming next: Chrome Web Store listing, which makes updates automatic and this
whole class of problem disappear.

## v1.2.8 — 2026-08-03

The security patch. A sharp-eyed user reported three privacy/safety bugs; all
three were confirmed real and all three are fixed here.

- **Snapshots now photograph the tab that traded.** Frame captures (every
  30 s while recording, plus each fill snapshot) used to grab whatever window
  happened to be focused — your email, another chart, anything. Captures now
  resolve the trading tab's own window, and if that tab is hidden or closed
  the frame is skipped rather than guessing at some other screen.
- **Websites can no longer trigger paper trades.** Any script on the page
  could forge a bridge message and run a quick-buy fill with zero input from
  you. Trade-bearing messages now require a genuine user gesture within the
  last 5 seconds (`isTrusted` only — synthetic events don't count) and must
  come from the page's own origin; cross-origin posts are dropped outright.
  Real chip taps work exactly as before.
- **Verification no longer breaks for heavy traders.** The attest chain was
  silently capped at 5000 links, which corrupted chain verification and
  replay-derived P&L for anyone past that count — even with nothing tampered.
  The cap is gone; the full chain is retained (the extension already has
  unlimited storage permission).

## v1.2.7 — 2026-08-03

The X-feedback batch — four things you asked for, plus one layout fix.

- **The positions bar finally stays hidden.** Hiding it used to be a per-page
  mood: collapse it, open the next chart, and it was back. Your choice is now
  a saved setting, so hide-it-once means hidden everywhere — every page, every
  tab, every session. One click on the POSITIONS tab brings it back, and that
  choice is saved too.
- **Post-close notes on rounds.** The thesis is written before you know how it
  ends; the lesson usually arrives after. Every closed round now has a Notes
  column — add or edit a retrospective note any time. The AI coach reads it
  too: confirm it, correct it, or sharpen it.
- **Leaderboard shows ROI on your bankroll.** Absolute SOL flatters whoever
  started with the biggest paper balance, so every result now shows the return
  on your *declared starting balance* next to the raw number — and the bankroll
  itself is displayed so the percentage is checkable. Rankings compare like
  with like.
- **The AI coach explains itself.** Since the endpoint ships blank (the SSRF
  hardening), "AI not working" usually meant "not configured yet". The Test
  button now says exactly that and tells you what to paste — and the settings
  form spells out that blank means the coach is off, plus the local toggle for
  localhost/LAN endpoints.
- **Homepage goes full-bleed on wide monitors.** The site was pillar-boxed to
  1180px, which looked stranded on ultrawides. Content and nav now share one
  wider container (1440px) so nothing drifts out from under the navbar.

## v1.2.6

- Quick-buy toggles: hide the whole Buy section in the trade tab, or just the
  one-tap preset row, from Settings. Live-applied, no reload.
- SSRF hardening: the AI endpoint ships empty; localhost/LAN endpoints require
  an explicit opt-in toggle.

## Earlier

- Armed snipes survive pair→mint resolution on Axiom/Photon/BullX; heartbeat
  flushes and expires them; storage failures can no longer wipe your wallet.
- Overlay auto-hide when no token is detected, master overlay toggle,
  resizable trade tab, draggable positions bar, average fill/exit price lines,
  GMGN support, and the paper fill attest chain.
