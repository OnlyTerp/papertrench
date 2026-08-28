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
| `alarms` | Two named wakes, nothing else. **(1) `pt_update_check`** — twice a day the service worker asks GitHub's releases API whether a newer build exists, so the dashboard and panel can show an update banner (unpacked installs never auto-update; without this users traded for days on stale builds). Sends nothing but that one GET; fully disable-able via Settings → "Check for new versions". **(2) `pt_pending_buy_sweep`** — once a day, releases SOL locked by armed limit buys whose 24h TTL expired on coins whose tab never reopened. No polling of any market, venue, or third party happens on either wake. |
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
  script (`site-bridge.js`) loads on our own website, and nowhere else, to
  close the account-linking loop: after you sign in with X on
  papertrench.com, the page hands your handle to the extension so the
  dashboard's "Linked account" chip can go green — the direction that keeps
  the extension from ever calling a server itself. The same script relays
  the leaderboard's two existing Sync requests (install ping and, only when
  the off-by-default "Site sync" toggle is on, the signed record export),
  because unpacked installs have machine-specific ids the site cannot
  message directly. The relayed request set is closed and enforced by test:
  nothing else crosses, in either direction, and the background re-checks
  the sender's origin so no other site the extension runs on can use these
  message types.
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

- **No telemetry, no analytics, no phoning home.** The extension has no
  backend of its own and never uploads anything on its own initiative. The
  only network calls are: public price APIs (Dexscreener, Jupiter), public
  Solana RPC, `api.hyperliquid.xyz` for perps quotes (from the Hyperliquid
  page itself, the same host that page already talks to), endpoints you
  configured yourself, and — only when you enable the opt-in hover preview
  cards — X's public oEmbed endpoint (`publish.twitter.com/oembed`), called
  with `dnt=1` (do-not-track), no cookies and no login, only for post links
  you hover on a trading site, cached so each post is fetched at most once
  per session.
- **The leaderboard server is a separate, opt-in thing — and it is in this
  repo.** `server/` is the Arena verifier: it takes a chain you choose to
  submit and recomputes your standing from it, because a leaderboard that
  trusts a number the client displays is not a leaderboard
  (`docs/LEADERBOARD.md`). It is worth stating exactly where the boundary is:
  - The extension never talks to it. `papertrench.com` can *ask* the extension
    for your verified record when you click Sync on that page, and only if you
    turn on **Site sync** in settings, which ships off. `externally_connectable`
    restricts who may ask to `papertrench.com` alone; no other origin can.
    With it off, the hand-off is a file you export and carry yourself.
  - Signing in is X OAuth, and the account holds a public handle, a display
    name and an avatar URL — there is no password and no email to breach.
  - `POST /api/me/delete` erases the account and everything derived from it.
  - Everything the server does with a submitted chain is in `server/core/`,
    runs under `node --test`, and decides nothing the extension has not
    already committed to.
- **No real trading.** It cannot sign, send, or ask for a transaction. It has
  no wallet integration at all — that is the point.
- **No credentials.** Your AI API key, if you add one, is stored locally and
  sent only to the endpoint you configured (a settings migration clears keys
  left orphaned by an empty endpoint — see CHANGELOG v1.2.17).
- **No form filling, no page mutation beyond its own overlay containers.**
