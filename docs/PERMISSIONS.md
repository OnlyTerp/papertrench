# Permissions audit

Everything PaperTrench requests, why, and what it deliberately does not do.
Kept current for Chrome Web Store review and for anyone auditing the source.

## Permissions

| Permission | Why |
|---|---|
| `storage` + `unlimitedStorage` | The paper wallet, settings, journal, replays, and (optional) capture frames live in `chrome.storage.local`, on your machine, only. Frames and screen recordings can exceed the default quota, hence `unlimitedStorage`. |
| `offscreen` | Optional screen recording uses an offscreen document for `getDisplayMedia` — MV3 service workers cannot record directly. Only created when you start a recording. |
| `tabs` | Two uses: capturing a snapshot frame of the trading tab (only the tab that traded, only when frames are enabled), and broadcasting settings/recording status to open trading tabs. |
| `activeTab` | Popup interactions with the current tab (overlay toggle). |
| `alarms` | Named wakes only. **(1) `pt_update_check`** — every six hours the service worker asks GitHub's releases API whether a newer build exists; disable-able in Settings. **(2) `pt_pending_buy_sweep`** — twice a day, releases SOL locked by expired armed limit buys. **(3) `pt_tournament_sync`** — every five minutes only while a join-time tournament-sync grant exists; it calls `/api/tournament/mine` and submits only a changed chain head. One-shot cut alarms fire at +30s, +3m and +8m inside the 15-minute grace, and are cleared after acceptance or revocation. With no grant there are zero tournament mine/submit requests. |
| `scripting` | Two uses. **(1) Opt-in Instant Links.** The "Instant links on Discord / Telegram / every site" toggles (all off by default) register the small link-interceptor bundle on those sites at runtime. Nothing is ever registered while the toggles are off, and turning one off unregisters it. Runtime registration is why the manifest's own content scripts can STAY narrow (the O-09 property) while the user can still opt sites in. **(2) Recovery after an update.** Chrome does not re-inject content scripts into tabs that were already open when an extension updates or reloads, which leaves those tabs running a disconnected copy — the overlay is gone until the user happens to reload the page. On install/update PaperTrench therefore re-runs *the manifest's own* content scripts, in tabs the manifest *already* matches, and only where the resident copy proves it is dead. This use registers nothing persistent, adds no host, reaches no site the manifest does not already list, and touches only the ISOLATED-world entries; it restores what Chrome dropped rather than extending where we run. |
| `sidePanel` | Shows the docked PaperTrench desk (panel.html) next to whatever tab you're on: your active round, discipline streaks, and the After feed (what a coin did after you exited). Opened only by your click on "Open desk (side panel)" in the popup or from the panel's own dashboard link; reads the same local `chrome.storage` as the popup — no new hosts, no network calls, no content scripts. |

## Host permissions vs. content scripts

- **Content scripts are narrow.** The trading overlay is injected ONLY into
  the supported trading sites (axiom.trade, padre.gg, tinyastro.io, gmgn.ai,
  bullx.io, dexscreener.com, birdeye.so, jup.ag, pump.fun, fomo.family, lute.gg).
  (Earlier alphas
  injected everywhere; fixed as DEFECTS.md O-09 and enforced by
  `scripts/preflight.sh` and a manifest test.)
- **Paper perpetual futures (v3.0.0).** A second, separate content-script
  entry loads the perps stack on the two venues it simulates:
  **app.hyperliquid.xyz** and jup.ag. It is the same paper-trading engine —
  it reads the venue's own prices and funding to price a SIMULATED position,
  places no real order, and touches no wallet or order control. This is the
  only host the extension has added since v2.4.0, and it is listed here
  because a permissions document that omits a host we inject into is simply
  wrong, whatever the injected code does.
- **Prediction markets (v3.3.0).** A third content-script entry loads the
  prediction stack on four binary-outcome venues: **kalshi.com**,
  **polymarket.com**, **app.hyperliquid.xyz** (outcomes path — shares the
  host with perps; each module's `detect()` decides whether to mount), and
  **limitless.exchange**. The engine reads each venue's public order book
  (no auth, no API key), prices SIMULATED fills against it, and scores
  calibration via Brier Skill Score. No real order is placed and no wallet
  is involved. Venues with insufficient recon coverage (all except Kalshi)
  ship as `verified:false` stubs that mount nothing until a headed capture
  confirms the live price pipeline.

  The book/meta/resolution reads go to these public API hosts, and only
  these — all unauthenticated, all read-only:

  | Host | Used for |
  |---|---|
  | `gamma-api.polymarket.com` | Polymarket event and market metadata |
  | `clob.polymarket.com` | Polymarket order books, price history |
  | `api.elections.kalshi.com` | Kalshi markets, order books, resolutions |
  | `api.hyperliquid.xyz` | Hyperliquid `l2Book` / `allMids` / `spotMeta` |
  | `api.limitless.exchange` | Limitless markets and order books |

  Hyperliquid deliberately uses the **documented** `api.hyperliquid.xyz`,
  the same host the perps stack already reads, rather than the
  `api-ui.hyperliquid.xyz` host the venue's own frontend calls. Both were
  probed live on 2026-08-08 and return identical data; an undocumented
  frontend host is free to change or rate-limit on its own schedule, and one
  Hyperliquid host is one thing to reason about instead of two.
- **papertrench.com / www.papertrench.com (site relay).** One small content
  script (`site-bridge.js`) runs only on our website. It relays the existing
  manual Site-sync requests, and the explicit tournament-sync grant/revoke
  hand-off, because unpacked installs have machine-specific IDs the site
  cannot message directly. The page may grant a 30-day token only after the
  user opts in on a tournament; the token is stored in `chrome.storage.local`,
  never synced, exported or placed in the debug report. The closed relay op
  set and same-origin checks are tested, and the background re-checks every
  sender URL so no other site can grant or revoke sync.
- **Forge (v3.0.0).** The banner generator runs inside the dex upload boxes
  on sites already listed above and adds NO new host or API permission: it
  reads the page's own size hints and sets a file on the page's existing
  upload input. The image model is the user's own BYOK endpoint, called with
  the user's own key.
- **Opt-in Instant Links spread (Turbo II).** Three off-by-default toggles
  (Discord, Telegram Web, every site) register ONE bundle at runtime via
  `chrome.scripting`: the two URL classifiers, the trajectory predictor, and
  the click/hover interceptor — ISOLATED world, no MAIN-world hook, no
  overlay, no trading engine. The bundle acts only on links its classifiers
  recognize (X posts/profiles/communities, and token pages on the supported
  destinations); every other click is untouched and native. The "every site"
  registration excludes the terminals and x.com (their static built-ins own
  those). Toggling off unregisters immediately; with the toggles off this
  feature has zero footprint, which is how the O-09 property survives.
- **x.com / twitter.com (v2.4.0, warm links).** Two small bridge scripts load
  on X for the opt-in "Instant X links" feature. They are passive: they do
  nothing until the background routes a click from a trading site into the
  warm viewer tab, they read nothing from your X session, and they send
  nothing anywhere (the only messages are the extension's own
  navigation-request/result pair). The feature is off by default; while
  enabled it keeps one muted background x.com tab as the viewer. A manifest
  test pins that these entries carry ONLY the two bridge scripts — the
  trading engine and overlay can never run on X.
- **x.com / twitter.com (v2.6.0, X-Ray).** Two further scripts load on X for
  the opt-in "X-Ray" account-intel card. What they do, precisely:
  - The observer runs in the page world and watches the X app's OWN GraphQL
    responses for a fixed allowlist of operations: the profile lookups, the
    account's public posts, and follower lists. Home timeline, DMs,
    notifications, ads, and everything else are never parsed. Responses are
    passed to the page untouched (the observer reads a clone).
  - What crosses out of the page is a DIGEST, not a payload: user field
    snapshots, post ids and dates, and the contract addresses a post
    carries. Raw post text never leaves the page context.
  - The ledger lives in `chrome.storage.local` on your machine. There is no
    server, no shared database, and no upload. Change history is what YOUR
    device has observed, which is why the card always prints the date it
    started watching an account.
  - "Deep scan" (on by default while X-Ray is on, separately switchable) lets
    the page re-issue a request it already made — the same call X makes when
    you scroll — to read a few more pages of posts or the follower list.
    It is throttled (minimum spacing, a per-minute cap, a per-account
    cooldown), it uses only your existing X session against x.com itself,
    and it happens only while you are looking at that account. The service
    worker itself never contacts X. If X changes its API, the deep scan
    stops working and the passive layer carries on.
  - X-Ray never follows, likes, posts, blocks, or changes anything on your
    account. It reads.
- **`host_permissions` stays broad** because the background service worker
  must `fetch()` endpoints the *user* configures: an OpenAI-compatible AI
  endpoint (any host they choose) and an optional private Solana RPC. Those
  requests carry only what the feature needs (chat prompts / RPC calls),
  go only to the endpoint the user typed in, and are SSRF-guarded
  (localhost/private ranges require an explicit opt-in; cloud metadata IPs
  are always blocked).

## What PaperTrench never does

- **No unrequested trading-data uploads.** Wallet, journal, theses, replays
  and recordings stay local by default. Network calls include our quote service
  (`papertrench-api.onerobby.workers.dev/api/quote`, token addresses + chain,
  no account/cookies; server request logs may include URL/IP metadata and are
  kept for up to 7 days); public price APIs and Solana RPC; venue APIs on their
  own pages; opt-out GitHub release checks; Daily Spark when played; configured
  AI/private-RPC endpoints; and opted-in X oEmbed previews.
- **The leaderboard server is optional and verified.** `server/` recomputes
  standings from submitted chains, never a client amount (`docs/LEADERBOARD.md`).
  - Manual Sync asks the extension for the chain only after **Site sync** is
    enabled and the user clicks on papertrench.com; otherwise export a file.
  - Tournament auto-sync is a separate join-time consent. With a live seat,
    the extension sends the verified chain every five minutes and after cuts,
    using a 30-day token scoped to `/api/submit` and `/api/tournament/mine`.
    The token is local-only, omitted from backup/debug exports, and revoked on
    the tournament page or when the account is erased. No other origin can ask.
  - Signing in is X OAuth, and the account holds a public handle, a display
    name and an avatar URL — there is no password and no email to breach.
  - `POST /api/me/delete` erases the account, sync tokens, active tournament
    seats/entries and mutable history. Settled hashes keep IDs-only facts and
    render an erased participant as `deleted trader`.
  - Everything the server does with a submitted chain is in `server/core/`,
    runs under `node --test`, and decides nothing the extension has not
    already committed to.
- **No real trading.** It cannot sign, send, or ask for a transaction. It has
  no wallet integration at all — that is the point.
- **No credentials.** Your AI API key, if you add one, is stored locally and
  sent only to the endpoint you configured (a settings migration clears keys
  left orphaned by an empty endpoint — see CHANGELOG v1.2.17).
- **No form filling, no page mutation beyond its own overlay containers.**
