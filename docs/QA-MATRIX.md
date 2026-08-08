# Release QA matrix

## The automated pass runs first

`tools/recon/.headless/livepass.mjs` loads the built extension into a real
Chromium and drives it to real pages on every site — token terminals and
prediction venues alike. It asks the shipped `sites.js` for each token URL, so
it cannot drift from the product it checks.

```bash
cd tools/recon/.headless
node livepass.mjs login          # ONE TIME: log into the gated sites, all in one window
xvfb-run -a node livepass.mjs    # everything — reuses that login automatically
xvfb-run -a node livepass.mjs gmgn   # one site
```

You log in **once**. `node livepass.mjs login` opens a single browser on the
persistent profile (`recon-data/profiles/live`, gitignored), walks every gated
site, and skips the ones you are already logged into — so re-running it after a
site logs you out only stops on that one. Every later run reuses the profile
with no flags. Run the `login` step **without** xvfb so the window is visible;
run the pass **with** xvfb.

It covers, per site: **panel mounts on a token/market page**, **panel does NOT
mount on home/screener/wallet routes**, **a price renders and ticks**, and for
prediction venues **a quote prices against the live book** (read from the
ticket's `data-pt-*` state, because the panel lives in a closed shadow root and
the book is fetched by the service worker where page-level network cannot see
it). Screenshots land in `_livepass/`.

It reports what it SAW. A venue that blocks automation or demands a login is
**not** a failed mount — there is no page behind the wall to mount on — and it
says so rather than inventing a defect or a pass.

### Last automated run — 2026-08-08

| Verdict | Sites |
|---|---|
| **PASS** | photon · gmgn · dexscreener · jupiter · pump.fun · kalshi · polymarket · limitless |
| **LOGIN REQUIRED** (seed once with `login.js`, then unattended) | axiom · padre · bullx · fomo · lute |
| **BOT WALL** (venue challenged the robot; passed on an earlier run) | birdeye |
| **NO MARKET FOUND** (venue geo-blocks this location — permanent here) | hyperliquid-outcomes |

No site mounted on a refuse route in any run. BONK's market cap agreed across
all six passing terminals ($221.1M–$221.8M), which is the cross-venue evidence
that the price layer is reading the right number.

The hand-run table below is what the automated pass does **not** yet cover:
fills and toasts, chart markers, average-line behaviour, drag/persist, and SPA
token-swaps. Those remain human until the harness grows to them.

---


Run before every release that touches `content.js`, `price-bridge.js`, `sites.js`,
or `chart-markers.js`. One row per site; every cell must pass or the failure gets a
DEFECTS.md entry before shipping. Copy this table into the release PR/notes and
check it off.

**Setup:** load the built zip unpacked (`chrome://extensions` → Load unpacked),
fresh profile preferred. Have one coin with an open paper position before starting.

| Check | Axiom | Padre | Photon | GMGN | BullX | DexScr | Birdeye | Jupiter | Pump.fun | Lute |
|---|---|---|---|---|---|---|---|---|---|---|
| Panel mounts on a token page | | | | | | | | | |
| Panel does NOT mount on home/screener | | | | | | | | | |
| Panel does NOT mount on wallet/portfolio routes | | | | | | | | | |
| Live price ticks and tracks the site's own number | | | | | | | | | |
| Live dot honest (green when ticking, warn when stale) | | | | | | | | | |
| Buy fills with toast; sell % fills once per tap | | | | | | | | | |
| Refusal toast (not silence) when no fresh price | | | | | | | | | |
| Fill markers land on the chart at the right level | | | | | | | | | |
| Average line holds the ENTRY level as price moves | | | | | | | | | |
| Positions bar shows the open position; chip navigates | | | | | | | | | |
| Panel/bar drag + persist + stay reachable | | | | | | | | | |
| SPA navigation between two tokens swaps the panel correctly | | | | | | | | | |
| Disable overlay removes panel AND chart drawings | | | | | | | | | |
| Re-enable restores everything incl. sell buttons | | | | | | | | | |

**Cross-site checks (once per release):**
- [ ] GMGN Trenches / Axiom Pulse: row quick-buy chip fills on first tap after >5 s idle; chip never sticks busy.
- [ ] High-volume coin (top trending): price keeps ticking through volume spikes; no silent freeze.
- [ ] Fast token flipping (10 coins in a minute): prices stay correct per coin, no cross-token bleed, RPC status recovers.
- [ ] Dashboard: numbers agree with panel (equity, realized P&L incl. partial exits); tables hold scroll position; AI review/note buttons behave.
- [ ] Popup: backup -> reset -> restore round-trips the wallet, and an open trading tab does NOT resurrect the old wallet.
- [ ] Extension reload with a position open: old overlay disappears cleanly, no duplicate markers, fresh one works.
- [ ] chrome://extensions shows no errors after the full pass.

---

## Prediction market QA matrix (v3.3.0)

**Status: OPEN -- live pass not yet run.** All cells empty until a headed
browser session confirms each venue. Kalshi has PARTIAL recon; the other
three have THIN recon and ship as `verified:false` stubs (panel will NOT
mount until a headed capture confirms the live price pipeline).

| Check | Kalshi | Polymarket | Hyperliquid | Limitless |
|---|---|---|---|---|
| SIMULATED badge visible on page | | | | |
| Panel mounts on a market page | | | | |
| Panel does NOT mount on homepage/portfolio | | | | |
| Quote walks a real book (latency replay) | | | | |
| price_moved rejection observable on fast market | | | | |
| Resolution lockout on 97c+ markets | | | | |
| Settlement sweep resolves past-close markets | | | | |
| Nothing renders on non-prediction sites | | | | |

**N/A for prediction (stated):** chart markers, average lines, positions bar
drag, SPA navigation between tokens, overlay toggle -- these are token-specific
features. Prediction has its own ticket UI with shadow-DOM isolation.
