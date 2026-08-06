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
| `scripting` | One use: the opt-in "Instant links on Discord / Telegram / every site" toggles (all off by default) register the small link-interceptor bundle on those sites at runtime. Nothing is ever registered while the toggles are off, and turning one off unregisters it. Runtime registration is why the manifest's own content scripts can STAY narrow (the O-09 property) while the user can still opt sites in. |

## Host permissions vs. content scripts

- **Content scripts are narrow.** The trading overlay is injected ONLY into
  the supported trading sites (axiom.trade, padre.gg, tinyastro.io, gmgn.ai,
  bullx.io, dexscreener.com, birdeye.so, jup.ag, pump.fun, fomo.family).
  (Earlier alphas
  injected everywhere; fixed as DEFECTS.md O-09 and enforced by
  `scripts/preflight.sh` and a manifest test.)
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
