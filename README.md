<div align="center">

<img src="docs/assets/banner.svg" alt="PaperTrench" width="100%">

**Paper-trade Solana memecoins on the sites you already use.**
Real prices. Fake money. A record you can actually learn from.

[![License: MIT](https://img.shields.io/badge/License-MIT-FF9D45.svg?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1665%20passing-34D399?style=flat-square)](#tests)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-6AA9FF?style=flat-square)](#install)
[![No tracking](https://img.shields.io/badge/telemetry-none-8D97A9?style=flat-square)](#privacy)

</div>

<div align="center">

### [▶ Watch the launch video](https://papertrench.com/assets/launch.mp4)

<a href="https://papertrench.com/assets/launch.mp4"><img src="docs/assets/preview.gif" alt="PaperTrench launch video preview" width="82%"></a>

*(GitHub's file viewer can't stream the 15 MB mp4 — it plays on the site.)*

</div>

---

## What it is

PaperTrench is a Chrome extension that overlays a paper-trading terminal on **Axiom, Padre, Photon, GMGN, BullX, Dexscreener, Birdeye, Jupiter, Pump.fun, Fomo, and Lute**. You trade the real chart, at the real live price, with money that isn't real — then review exactly what you did and why.

It exists because the usual way people learn this market is to lose money finding out that they chase, oversize, and round-trip their winners. This tells you that in an afternoon instead.

<div align="center">
<img src="docs/assets/overlay.png" alt="The PaperTrench overlay on a live chart" width="86%">
</div>

## Why it's different

**It never invents a price.** Every fill uses a price validated against a trusted anchor. When no source has a price yet, the panel says so instead of showing a number.

**It measures process, not just P&L.** Anyone can get lucky. PaperTrench grades how much of each move your exit actually captured, how big your positions were relative to your book, and whether you followed the plan you wrote before entering.

**It works on brand-new launches.** Dexscreener doesn't index a coin until it has seen a pool — measurably after the coin exists. PaperTrench queries Jupiter in parallel and anchors off whichever resolves first, so a coin seconds old is tradeable.

---

## Features

### Trading

| | |
|---|---|
| **Live overlay** | Quick-buy presets, % sells, and a P&L that updates on the site's own price feed — event-driven, not polled. |
| **Positions bar** | Every open position pinned to the top of the page with live P&L. Click one to jump to its chart. |
| **Native chart fills** | On Padre, your paper buys and sells render as real TradingView markers with average fill/exit lines. |
| **Armed buys** | Click buy before a brand-new coin has a quote and the order arms, then fills the instant the first trusted price lands. |
| **Instant X links** | Opt-in: clicking an X post or profile on a trading site opens it in a kept-warm viewer tab in ~0.5s instead of a ~3.5s cold tab — and hovering a link first prefetches it, making the click near-instant. Costs one muted background x.com tab while enabled; Ctrl/Cmd/middle-click still opens normal tabs. |
| **Tweet on the buy button** | Opt-in: where a terminal hides the launch tweet behind a held hotkey, PaperTrench puts it on the control your cursor is already on — hover the site's *own* quick-buy pill and the tweet appears in about a tenth of a second, no key held. The card is always placed clear of the pill, never over it. Works where the site's pill is a verified one (Axiom, Padre). |
| **X-Ray** | Opt-in: land on any X profile or post and the intel card is already there — account age, bio / display-name / @handle changes, every contract address the account has posted, and Smart Following (its biggest followers). Built from the X page's own data, on your machine. It states what it cannot know: change history starts the first time your device sees an account, and the card prints that date. |

### Learning

| | |
|---|---|
| **Trade thesis** | Write why you're taking a trade *while the position is open* — before you know the outcome. Tag the setup, set a target and stop. |
| **Exit quality** | Every round graded `excellent` / `sold early` / `round-tripped`, with the SOL you left on the table quantified. |
| **Position sizing** | Average and largest trade as a share of your book, flagging anything over 25%. |
| **Setup performance** | Win rate and average P&L per setup tag — so `revenge` can be compared honestly against `narrative`. |
| **Session replay** | Scrub through any trade: every fill, chart frames, and the screen recording if you made one, all on one timeline. |
| **Shareable P&L cards** | Turn any closed round into a posting-ready image, with your own picture or GIF behind it. |
| **AI coaching** | Optional review of a round or a whole session through any OpenAI-compatible endpoint. Judges process against your stated plan. |

### Verifiable record

Every fill is committed to a hash chain the moment it happens, which makes three things checkable: **ordering** (no inserting or deleting trades afterwards), **pre-commitment** (no backdating a winner), and **price reality** (each fill records mint, price, and timestamp, so it can be re-checked against real history).

The dashboard re-derives your result from the chain and shows it beside the displayed number. If they disagree, the stored state was edited.

> **Stated plainly:** this is *evidence*, not proof. Anyone can run modified code locally. A leaderboard built on this must recompute standings server-side from the submitted chain — never from the number the app displays. See [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md) for the protocol.

---

## Install

PaperTrench is not on the Chrome Web Store yet. Loading it unpacked takes about thirty seconds.

1. **Download** — grab the latest [release zip](../../releases) and unzip it, or clone this repo.
2. Open **`chrome://extensions`** and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder that contains **`manifest.json`** — the unzipped release folder itself, or the **`extension/`** folder if you cloned the repo.
4. Pin PaperTrench so the popup is one click away.

> **Getting "Manifest file is missing or unreadable"?** The folder you selected doesn't have `manifest.json` at its top level. Open the folder you unzipped and select the level where `manifest.json` sits.

Open any supported token page and the overlay appears within a second or two.

<div align="center">
<img src="docs/assets/dashboard.png" alt="The PaperTrench dashboard" width="86%">
</div>

---

## First trade

1. Go to a token on any supported site, e.g. `https://trade.padre.gg/trade/solana/<mint>`.
2. Wait for the panel's status dot to turn green — that means a trusted price is live.
3. Pick a SOL amount and hit **BUY (PAPER)**. Your balance drops; a position card appears.
4. Write your thesis while it's open. *Why* this trade? What's the target?
5. Sell 25 / 50 / 75 / 100% when you're ready.
6. Open the dashboard to see the round graded — and what you left on the table.

---

## P&L cards

Every closed round has a **Share** button that opens a card composer. Drop in any
picture or GIF as the background — it's cover-fitted and scrimmed so the numbers stay
readable over a busy image — then download a 1200×675 PNG ready to post.

The numbers on the card are read straight from the engine's own round record, so a
shared card cannot show a result your journal doesn't contain.

The composer now works like the terminals people know: a background gallery
(built-in looks plus your own uploads, saved for next time), a Customize panel
for which stats show, and Download / **Copy to clipboard** for paste-and-go
posting. Two things are always drawn and cannot be customized away: the
**PAPER** watermark across the middle, and the full-width PaperTrench brand
bar with *"paper trading — not financial advice"* and the project URL. The
branding is drawn by a code path that reads no settings at all — there is no
combination of options that removes it. A simulated trade should never be
passable as a real one.

## Privacy

- **No account. No signup. No telemetry.** Nothing is sent anywhere about you.
- **A real off switch.** The ⏻ button in the popup turns PaperTrench fully dormant — nothing injected or rendered on any site, live in every open tab — until you turn it back on. Wallet and settings are kept.
- **Everything is local.** Trades, settings, replays, and recordings live in your browser's own storage.
- **Network calls are only:** the public Dexscreener and Jupiter price APIs; public Solana RPC endpoints (`solana-rpc.publicnode.com`, `api.mainnet-beta.solana.com`, `solana-mainnet.gateway.tatum.io`) for on-chain pricing; `api.hyperliquid.xyz` for perps quotes, from the Hyperliquid page itself; X's public oEmbed endpoint if you opt into hover tweet previews (no login, `dnt=1`, posts you hover only); and — only if *you* configure it — your own AI endpoint and your own private RPC.
- **Recordings never leave your machine.** They're stored in IndexedDB and saved to your downloads folder.
- **The leaderboard is opt-in and not automatic.** The extension never uploads your record. `papertrench.com` can *ask* the extension for your verified chain when you click Sync there, and only if you turn on **Site sync** in settings (off by default). No other origin can ask. Off, you export a file and carry it yourself.

### What the manifest asks for, and why

`storage` + `unlimitedStorage` for the wallet, journal and replays · `tabs` / `activeTab` for chart frames · `offscreen` for the optional recorder · `scripting` to register the opt-in Instant-Links bundle at runtime (all those toggles are off by default).

`host_permissions` is **`<all_urls>`**, and it is worth being plain about why: the service worker has to `fetch()` endpoints *you* choose — an OpenAI-compatible AI endpoint on any host, and an optional private Solana RPC — and those hosts cannot be known in advance. Those requests are SSRF-guarded (private ranges need an explicit opt-in; cloud metadata IPs are always blocked).

Broad host permissions are **not** broad content scripts. The overlay is injected only into the supported trading sites, never anywhere else — a property enforced by `scripts/preflight.sh` and a manifest test, because an earlier alpha did inject everywhere (`DEFECTS.md` O-09). The full permission-by-permission audit lives in [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md).

---

## Tests

```bash
cd extension && node --test    # 1665
cd server   && node --test     #  157
```

**1,665 extension tests** covering price resolution, tick validation, portfolio arithmetic, the Padre chart bridge, fresh-launch handling, the positions bar, session replay, the attestation chain, and browser-context loading.

**157 server tests** covering chain verification, re-pricing against market history, ranking, sprint and duel windows, and achievements — the leaderboard verifier in [`server/`](server/), which recomputes standings from submitted chains rather than trusting a submitted number.

The suite is mutation-tested: fixes were verified by reverting them and confirming the tests fail. The one test that hits a live API skips — rather than fails — when offline.

---

## Architecture

```
extension/
  manifest.json      MV3 manifest
  sites.js           per-site adapters (URL → token identity)
  quote.js           pure logic: pair selection, tick validation, P&L math
  resolver.js        Dexscreener + Jupiter lookups (raced)
  engine.js          portfolio engine: positions, fees, rounds, thesis, grading
  attest.js          tamper-evident fill chain
  replay.js          session replay model
  recordings.js      IndexedDB store for screen recordings
  price-bridge.js    MAIN-world hook into the site's own price feed
  content.js         Shadow-DOM overlay
  background.js      service worker: AI proxy, recording, frames
  dashboard.html/js  journal, rounds, replay, leaderboard, coach, settings
```

The decision logic is deliberately kept in pure functions (`quote.js`, `engine.js`, `attest.js`) so it can be tested without a browser — and so the code that runs in the page is the same code the tests exercise.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md) · [`CONTRIBUTING.md`](CONTRIBUTING.md)

## Transparency

Development runs against a public, ranked defect register: [`DEFECTS.md`](DEFECTS.md)
(139 findings from a full four-track code audit, severity-weighted so "a number is
wrong" outranks everything). The road out of alpha is [`ROADMAP.md`](ROADMAP.md);
every release checks off entries with a regression test per fix. If you find a bug,
[the report form](.github/ISSUE_TEMPLATE/bug_report.yml) asks for exactly what we
need to reproduce it.

**Thinking about going from paper to real money?** Read
[`docs/GRADUATION.md`](docs/GRADUATION.md) first — it is the honest version of
"am I ready?", and the product considers it a success when the answer is "not yet."

---

## Known limits

- Price anchoring needs a network call, so on a cold cache the header briefly reads **"Fetching live price…"**. Trading is disabled during that window by design.
- Ticks that disagree with the anchor by more than ~20x are dropped. During a genuinely violent move the overlay falls back to the periodic anchor refresh.
- Screen recording requires choosing a tab/window once per session — Chrome cannot do it silently.
- Some coins have no price on *any* source for their first moments. PaperTrench waits rather than inventing one.

<!-- ONBOARDING-BOT: disabled until the X handle is registered.
  This block is intentionally a comment so the site/README cannot promise a live
  @-mention bot before the account and credentials exist. To enable: register the
  handle, set the account bio to disclose the bot, run through the flip-to-live
  checklist in docs/ONBOARDING-BOT.md, then uncomment this section.

## Get the one-minute start guide

Tag **@PaperTrenchBot** under any X post about a memecoin and it will reply once
with the exact steps to start paper trading — real charts, fake SOL, no wallet,
no risk. See `docs/ONBOARDING-BOT.md` for how to paste the same copy manually
until the bot is live.
-->

---

## Contributing

Issues and PRs welcome. The one hard rule: **never fabricate a number.** If a price, a fill, or a statistic can't be derived from real data, the code says so instead of guessing.

---

## License

MIT — see [LICENSE](LICENSE).

<div align="center">
<sub>Paper money. Real lessons.</sub>
</div>
