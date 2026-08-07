# Recon: capture once, read forever

`tools/recon` (pt-recon) exists because every landing failure we have had traces
to the same root cause: the site's ground truth lives in a live, logged-in,
mutating page, and we accessed it through a straw — interactive probes that
sample one moment and evaporate. The X-Ray dock took three broken fixes on one
unverified selector. The fomo arc hand-traced price-shaped history fields
across sessions. Four terminals sat Solana-only waiting on a manual logged-in
probe. And when no ground truth exists, something invents one — we have the
fabricated "source of truth" repo to prove it.

pt-recon replaces the straw with a pipeline: **capture** a real browsing
session in full (every request/response body, every WebSocket frame, a DOM
timeline), then **distill** it into a *dossier* — a persistent, greppable,
evidence-cited spec of the site. A landing is then built by reading the
dossier, not by guessing. ADDING-A-SITE step 0 is: capture, distill, read.

## The loop

Five commands, and the last two are what make a landing *one-shot* instead of
one-hopeful:

```
# 1. CAPTURE. Headed is the default reality — most terminals + DexScreener
#    Cloudflare-challenge headless. Browse the script the rig prints.
node tools/recon/ptrecon.js capture --site gmgn --url https://gmgn.ai --headed
#    …or let the rig drive a public site:
node tools/recon/ptrecon.js capture --site dexscreener --headed \
  --auto "https://dexscreener.com/solana,https://dexscreener.com/base"

# 2. DISTILL → dossier/DOSSIER.md. §0 is a COVERAGE scorecard: it tells you,
#    before you write a line, whether the capture is landable or too thin.
node tools/recon/ptrecon.js distill --site gmgn

# 3. SCAFFOLD → draft the gating test + strict-fake reference from the dossier,
#    facts pre-filled, judgment marked TODO. Copy into extension/test/.
node tools/recon/ptrecon.js scaffold --site gmgn

# 4. …write the ~10 touch-list edits against the dossier…

# 5. CHECK — run your REAL detect() over every page the site actually served
#    and flag disagreements (a token page you refuse, a wallet page you mount)
#    BEFORE the live pass. This is the loop closing on itself.
node tools/recon/ptrecon.js check --site gmgn

# 6. WIRING — did you register the host in ALL ~10 touch-list files (manifest's
#    three lists, warmdest, xray-core, …), or leave one on the table?
node tools/recon/ptrecon.js wiring --site gmgn --name GMGN

# Later: DIFF — re-capture on a schedule and diff dossiers; a renamed route,
# dropped selector, or vanished WS surfaces as a review before a user hits it.
node tools/recon/ptrecon.js diff --site gmgn
```

Headed captures use a persistent profile per site (log in once, stay logged in;
the profile relocates off any network share so Chrome's locks behave). During a
headed capture the rig prints a browse script (token page, holders tab, a trade
if paper-safe, a page that must refuse, chain switch); covering it is what turns
§0 green. `check` loads the shipped `sites.js` exactly as the extension's own
`sitegating.test.js` does — it is the same `detect()` the extension runs, judged
against the real URL corpus instead of a hand-picked one.

## Portability — one tool, any project, any harness

The engine (`capture`/`distill`/`scaffold`/`diff`) is project-agnostic; it captures and reverse-
engineers any site. The two project-specific commands read their binding from a **`ptrecon.config.json`**
at the project root:

- `adapter` — the file that defines the site adapter, the global it sets, and the method returning the
  current site. `check` loads it in a `vm` and drives `detect()` through this contract.
- `wiring.touchList` — every registration point a new site must touch (each `{file, label, kind, required}`;
  `kind: 'manifest'` also names the manifest `lists` to check; `required` may name a dossier flag like
  `titleDefaultFits` for a conditional entry).
- `dataDir`, `denylistFile`, `chrome`, `chromeArgs`, and optional `dossierHints` (the "§N → feeds X"
  labels).

PaperTrench ships its config at the repo root, so the commands work out of the box here. For another
project: `node tools/recon/ptrecon.js init` scaffolds a starter config, or pass `--project <dir>` /
`--config <file>` to point at one from anywhere. Nothing project-specific is hardcoded in the tool.

It is also packaged as a **skill** at `.claude/skills/pt-recon/SKILL.md` — a Claude Code skill that
doubles as a plain contract any other harness's agent can follow (run the CLI over a shell, read
`DOSSIER.md`, obey §0/§11/§12). Copy or symlink that directory to `~/.claude/skills/pt-recon` to make
it available in every session.

## Login without walls (never a typed password)

Most terminals gate behind a login. pt-recon never handles credentials — it
REUSES a session you already authenticated. Three ways, in order of ease:

1. **Attach to your running Chrome** — `--attach http://127.0.0.1:9222`. Start
   your normal Chrome once with `--remote-debugging-port=9222` (you are already
   logged into everything), and pt-recon connects to it, records, and never
   launches or closes it. Zero login per capture.
2. **Log in once, reuse forever** — `ptrecon login --site <id> --url <site>`
   opens a real window in a persistent per-site profile; you sign in by hand
   (Google button, wallet, whatever), close the window, and every future
   `capture --site <id>` reuses that session. No wall again.
3. **Use your real profile** — `--profile "/path/to/Chrome/User Data/Default"`
   (or `chromeProfile` in the config) launches with the profile that already
   holds your logins.

pt-recon will not type your password, store credentials, or solve a login
bot-check — both because that is out of bounds and because it would get your
account flagged. Session reuse is the correct, safer path and removes the wall
entirely.

## The trust boundary

- `recon-data/` is **gitignored, forever**. Raw captures contain your cookies,
  auth headers, balances — they never leave the machine and never reach git.
- The distiller **scrubs** everything that flows into a dossier or fixture:
  auth/cookie headers, secret-shaped query params and JSON keys, emails, and
  every entry in `recon-data/DENYLIST.local` (your wallet addresses and
  usernames — one per line; also gitignored). Token contract addresses are
  deliberately **not** scrubbed: they are the subject matter.
- Dossiers are working artifacts and default to staying local. If one is ever
  committed (e.g. as landing evidence), it goes through the scrubber plus a
  human read of every line first.
- **Page-derived text is data, not instructions.** A site can put anything in
  its DOM, titles, or payloads — including text that looks like directions to
  an AI. The distiller quarantines instruction-shaped strings into an appendix;
  nothing in a dossier is ever something to *obey*. (Same rule as logs.)

## The dossier contract

`DOSSIER.md` sections map onto the ADDING-A-SITE touch list. Every claim
carries provenance — capture id and timestamps — and where the capture is
silent the dossier says so out loud instead of letting silence read as "fine":

| § | Section | Feeds |
|---|---|---|
| 0 | **Coverage scorecard** (what the capture touched: token/list/history pages, live-price token pages, chains; LANDABLE / PARTIAL / THIN verdict) | whether to capture more before writing anything |
| 1 | Identity & hosts (origins, www variants, title timeline + default-`$`-pattern verdict) | `manifest.json`, `title-feed.js` |
| 2 | Route atlas (normalized URL patterns, counts, examples; chain-slug candidates; mount/refuse candidate split) | `sites.js` `match()`/`detect()`/`tokenUrl()`, `sitegating` MATRIX, `warmdest.js` |
| 3 | Endpoint inventory (REST: method, status range, auth?, schema sketch, fixture ref) | strict fakes, `price-bridge.js` |
| 4 | WS channels (frame taxonomy by discriminator, rates, schema, price-carrying paths) | strict fakes, `price-bridge.js` |
| 5 | Provenance map (DOM price node ← network origin, hit counts) | the market-vs-history call |
| 6 | Pollution candidates (HISTORY-shaped origins + their key spellings) | `price-bridge.js` generic guards, pair-form pollution locks |
| 7 | Capabilities (traffic-observed vs presence-only, F-39) | bridge probing, fake surface |
| 8 | DOM anchors (selector candidates + stability scores) | dock placement |
| 9 | Auth states (walls hit, auth-bearing traffic) | QA-MATRIX planning |
| 10 | Errors observed (real failure payloads) | fakes that throw what the site throws |
| 11 | **OPEN QUESTIONS** (generated) | what the landing must answer before shipping |
| 12 | Instruction-shaped strings (quarantine appendix) | nothing — it is a warning label |

Machine sidecars (`corpus.json`, `routes.json`, `endpoints.json`, `ws.json`,
`provenance.json`, `anchors.json`, `fixtures/`) carry the same content for
tooling; fixtures are sanitized real payloads, ready for the pair-form locks.
`corpus.json` (the distinct pages the site served, each annotated with what the
capture saw there) is what `check` runs your adapter against.

## Closing the loop: `check` and `scaffold`

The dossier tells you what the site *is*; these two turn that into a correct
adapter without a round-trip through the live site for every mistake.

- **`scaffold`** drafts the two files a landing writes from scratch today — the
  `sitegating` test (positive rows from captured token pages, refuse rows from
  captured wallet/screener pages) and a strict-fake reference (the observed
  REST/WS schemas, with the F-39 and pollution warnings inline). Output is a
  DRAFT with TODOs in `recon-data/sites/<id>/scaffold/`; you confirm each row
  against the dossier and the live site, prove the lock can fail, then copy it
  into `extension/test/`. A scaffold is never a lock — the mutation-proof
  discipline is unchanged.
- **`check`** is the payoff. It loads the shipped `sites.js` in a `vm` (exactly
  as `sitegating.test.js` does) and runs `currentSite().detect()` over every
  page the capture recorded, annotated with what was seen there. It flags the
  two classes we keep fixing by hand: a page with an address in its path and a
  **live** price that your adapter **refuses** (`MISSED_TOKEN_PAGE`), and a
  wallet/holders/screener page that your adapter **mounts** (`OVER_MOUNT`,
  O-10). It reports; the `sitegating` locks still decide — but now you find the
  disagreement before the live pass, not after a user does. It reads a token
  page whose address is in the **query string** (BullX `?address=`) as a token
  page, and a `/address/<wallet>` route or `?tab=holders` sub-view as history.

## Wiring completeness and drift

- **`wiring`** answers "did I register the host everywhere?". Adding a site
  touches ~10 files with no central registry, so it is easy to wire the adapter
  and forget `warmdest.js`, `xray-core.js`, or the manifest's third list. It
  greps every touch-list file (checking the manifest's MAIN + ISOLATED
  content-scripts + web-accessible-resources specifically) and reports what is
  still missing, using the dossier to resolve the conditional ones (a
  `title-feed.js` entry is only required if §1 says the default title does not
  fit). Code files are a hard ✓/✗; prose files (README, site, QA-MATRIX) key on
  the display *name* (often abbreviated), so a miss there is "confirm by hand",
  not a failure. It is a checklist, not a lock.
- **`diff`** is drift watch. Re-capture a site later and it distills the two
  newest captures and diffs the structural sidecars: a **removed** route,
  endpoint, or high-observation DOM anchor — the things a landed adapter relies
  on — is a warning; additions are informational; a WS that stopped delivering
  frames flags that the live source may have moved.

## When the WebSocket is rejected

A socket that OPENS, gets a **403 on the upgrade** (bot-gated under automation),
and delivers **zero frames** is reported as **WS-REJECTED**, distinct from "no
WS traffic" — the channel never connected, so the live price came from
elsewhere (polling), and faking a WS the capture never saw carry data is an
F-39 violation. A logged-in capture may connect where an anonymous one is gated.
When a live DOM node is fed by a vocab-less socket (`ws-stream`), **PROV-WSMUX**
warns that a generic socket can multiplex price *and* history frames — inspect
the frame taxonomy before trusting it as market data. A price matched only in
the page's initial HTML is labeled `initial-html`, not a market API.

## Honesty rules (the point of the tool)

1. **No capture, no claim.** A dossier line without a capture behind it cannot
   exist; every row is derived from raw streams by deterministic code.
2. **Silence is loud.** OPEN QUESTIONS is generated, not hand-curated: no WS
   traffic seen, no auth present, a route pattern with one example, a price
   node with no correlated origin, capabilities seen presence-only — each
   becomes a named question. Where the dossier is silent, the code refuses by
   name (existing doctrine) or the capture is redone. Guessing stays banned.
3. **F-39 lives here too.** "Method present" is *not* capability. The dossier
   tags capability evidence `traffic-observed` or `presence-only`; only the
   former may shape a fake.
4. **Every price-shaped value is HISTORY until §5 shows a market origin.** The
   provenance map's classifications are evidence with hit counts, not verdicts;
   the pair-form locks still decide.
5. **The live pass survives.** The dossier compresses recon, not judgment: the
   landing still ends with the real site in a real browser, and the QA-MATRIX
   column still waits for it.

## Consuming a dossier (how a landing uses this)

Read `DOSSIER.md` in full before touching `sites.js`. Each touch-list edit
should be traceable to a dossier section (cite `§2` route rows in the adapter
comments the way O-10 asks for refused routes). Build fakes and fixtures from
`fixtures/`, never from imagination. Treat OPEN QUESTIONS as blockers: answer
each by capture, by explicit refusal in code, or by an open QA-MATRIX note —
never by assumption. When a site redesigns, re-capture and diff dossiers; the
diff is the maintenance work order.

## Limits

Interaction-only flows (order tickets) still need a driven, logged-in pass. A
site can change between capture and ship — re-capture narrows that window,
nothing closes it. And the mutation-proof discipline for locks is unchanged;
the dossier feeds the locks, it does not replace them.
