#!/usr/bin/env bash
# Release preflight: everything that used to be a manual checklist item that
# someone (always) forgets. Run from the repo root:  bash scripts/preflight.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

# POSIX sed rather than `grep -oP`: -P is a GNU extension that macOS grep does
# not have at all, and that GNU grep itself refuses under a non-UTF-8 locale
# ("-P supports only unibyte and UTF-8 locales"). A release check that only
# runs on one machine is a release check nobody runs.
version_of() { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' "$1" | head -1; }
MANIFEST_V=$(version_of extension/manifest.json)
PACKAGE_V=$(version_of extension/package.json)

echo "manifest: $MANIFEST_V  package: $PACKAGE_V"
[ "$MANIFEST_V" = "$PACKAGE_V" ] || fail "manifest.json ($MANIFEST_V) != package.json ($PACKAGE_V)"

grep -q "## v$MANIFEST_V" CHANGELOG.md || fail "CHANGELOG.md has no entry for v$MANIFEST_V"
# Download CTAs must point at /releases/latest and never pin a versioned zip,
# which 404s until the release asset exists (policy since f23df6c).
grep -q 'github.com/OnlyTerp/papertrench/releases/latest' site/index.html \
  || fail "site/index.html has no /releases/latest download link"
if grep -Eq 'papertrench-[0-9]+\.[0-9]+\.[0-9]+\.zip' site/index.html; then
  fail "site/index.html contains a version-pinned papertrench-X.Y.Z.zip URL (must use /releases/latest)"
fi

# Every page's nav must reach every destination.
#
# This drifted twice. The Arena shipped five pages and fifteen others kept a
# nav that predated them — first pointing "Leaderboard" at the marketing
# anchor instead of the board, then reaching the board but not Sprint or
# Duels. Both times the site advertised features two thirds of it could not
# navigate to, and both times it was caught by a person rather than a check.
# Same failure mode as the version-pinned download link above: a rule that
# lives only in someone's memory.
# Extensionless: GitHub Pages resolves /leaderboard to leaderboard.html, and
# the pages link that spelling. The .html form still resolves, so this list is
# what decides which one the site is actually built out of.
NAV_DESTS="/leaderboard /sprint /duels /clans"
NAV_MISSING=""
for page in site/*.html; do
  # Article pages and the Arena family all carry the same nav block.
  grep -q 'class="nav-links"' "$page" || continue
  # Match inside <nav>…</nav> ONLY. Grepping the whole file passed vacuously on
  # every page that links these destinations from body copy — which is all six
  # Arena pages, since they cross-link each other (duel.html alone has seven
  # body links to duels.html). A page could lose two nav entries and still
  # report OK. The 15 legacy pages happened to be protected because they carry
  # no such body links, which is also why a mutation test against news.html
  # could not tell the two implementations apart.
  nav=$(sed -n '/<nav\( [^>]*\)\?>/,/<\/nav>/p' "$page")
  for dest in $NAV_DESTS; do
    printf '%s' "$nav" | grep -q "href=\"$dest\"" \
      || NAV_MISSING="$NAV_MISSING $(basename "$page"):$dest"
  done
done
[ -z "$NAV_MISSING" ] || fail "nav is missing destinations —$NAV_MISSING"
echo "nav OK ($(grep -lc 'class="nav-links"' site/*.html | wc -l) pages reach $NAV_DESTS)"

# Every page carries the same accessibility landmarks.
#
# A skip link is the first tab stop; without it, reaching page content by
# keyboard means tabbing through eleven nav links on every navigation. It
# needs a <main id="main"> to land on, and the primary <nav> needs a name so
# a screen reader can tell it from the ones inside the page.
#
# Checked rather than remembered, for the same reason as the nav destinations
# above: 20 of 27 pages had no landmark at all until this pass, because
# nothing said they should.
A11Y_MISSING=""
for page in site/*.html; do
  grep -q 'class="nav-links"' "$page" || continue
  grep -q 'class="skip-link"' "$page" || A11Y_MISSING="$A11Y_MISSING $(basename "$page"):skip-link"
  grep -q 'id="main"'         "$page" || A11Y_MISSING="$A11Y_MISSING $(basename "$page"):main"
  grep -q '<nav aria-label='   "$page" || A11Y_MISSING="$A11Y_MISSING $(basename "$page"):nav-label"
done
[ -z "$A11Y_MISSING" ] || fail "pages missing accessibility landmarks —$A11Y_MISSING"
echo "a11y OK (skip link, main landmark and named nav on $(grep -lc 'class="skip-link"' site/*.html | wc -l) pages)"

# The profile control is on every page or it is on none: a header that shows
# who you are on the leaderboard and not on a news article reads as a bug in
# the sign-in, not as a missing include.
PROFILE_MISSING=""
for page in site/*.html; do
  grep -q 'class="nav-links"' "$page" || continue
  grep -q 'id="nav-profile"' "$page" || PROFILE_MISSING="$PROFILE_MISSING $(basename "$page"):slot"
  grep -q 'nav-profile.js' "$page"    || PROFILE_MISSING="$PROFILE_MISSING $(basename "$page"):script"
  grep -q 'id="nav-wallet"' "$page"  || PROFILE_MISSING="$PROFILE_MISSING $(basename "$page"):wallet-slot"
  grep -q 'nav-wallet.js' "$page"     || PROFILE_MISSING="$PROFILE_MISSING $(basename "$page"):wallet-script"
done
[ -z "$PROFILE_MISSING" ] || fail "pages missing the header profile control —$PROFILE_MISSING"
echo "profile control OK (slot + script on every page)"

# Every public page must be in sitemap.xml, or deliberately named as excluded.
#
# A sitemap is the one file that rots without any symptom: pages get added, the
# sitemap stays as it was, and nothing anywhere reports that search engines are
# being handed a stale map. The failure is invisible until someone wonders why a
# page never appeared in results. So the exclusions are enumerated HERE rather
# than left implicit — adding a page forces a decision about it.
#
#   admin            noindex — moderator queue
#   clan/duel/profile parameterised; without a query string they are empty states
#   404              error page
SITEMAP_SKIP="admin clan duel profile 404"
SITEMAP_MISSING=""
for page in site/*.html; do
  slug=$(basename "$page" .html)
  case " $SITEMAP_SKIP " in *" $slug "*) continue ;; esac
  # index is published as the bare origin, every other page as /<slug>.
  if [ "$slug" = "index" ]; then want="<loc>https://papertrench.com/</loc>"
  else want="<loc>https://papertrench.com/$slug</loc>"; fi
  grep -qF "$want" site/sitemap.xml || SITEMAP_MISSING="$SITEMAP_MISSING $slug"
done
[ -z "$SITEMAP_MISSING" ] || fail "sitemap.xml is missing pages —$SITEMAP_MISSING"

# ...and the reverse: a <loc> whose page was deleted or renamed points crawlers
# at a 404, which costs more than the missing entry above.
SITEMAP_STALE=""
for loc in $(sed -n 's,.*<loc>https://papertrench\.com/\([a-z0-9-]*\)</loc>.*,\1,p' site/sitemap.xml); do
  [ -z "$loc" ] && continue   # the bare origin, which is index.html
  [ -f "site/$loc.html" ] || SITEMAP_STALE="$SITEMAP_STALE $loc"
done
[ -z "$SITEMAP_STALE" ] || fail "sitemap.xml lists pages that do not exist —$SITEMAP_STALE"
echo "sitemap OK ($(grep -c '<loc>' site/sitemap.xml) urls, all resolve to a page)"

# The manifest must never regress to <all_urls> content scripts (DEFECT O-09).
if grep -q '"<all_urls>"' extension/manifest.json; then
  # host_permissions may legitimately stay broad (user-configured AI/RPC
  # endpoints are fetched by the service worker) — content_scripts must not.
  python3 - <<'PY' || exit 1
import json, sys
m = json.load(open('extension/manifest.json'))
for cs in m.get('content_scripts', []):
    if '<all_urls>' in cs.get('matches', []):
        sys.exit('PREFLIGHT FAIL: content_scripts matches <all_urls> — see DEFECTS.md O-09')
for war in m.get('web_accessible_resources', []):
    if '<all_urls>' in war.get('matches', []):
        sys.exit('PREFLIGHT FAIL: web_accessible_resources matches <all_urls>')
print('manifest scope OK (host_permissions broad by design, content scripts narrow)')
PY
fi

echo "Running test suite..."
(cd extension && node --test > /tmp/pt-preflight-tests.log 2>&1) \
  || { grep -E '^not ok|✖' /tmp/pt-preflight-tests.log | head -10; \
       tail -40 /tmp/pt-preflight-tests.log; fail "test suite not green"; }
tail -8 /tmp/pt-preflight-tests.log | grep -E "pass|fail"

# The server suite is NOT in CI (.github/workflows/test.yml runs the extension
# suite only), so this is the only gate on it before a release.
echo "Running server suite..."
(cd server && node --test > /tmp/pt-preflight-server.log 2>&1) \
  || { grep -E '^not ok|✖' /tmp/pt-preflight-server.log | head -10; \
       tail -40 /tmp/pt-preflight-server.log; fail "server suite not green"; }
tail -8 /tmp/pt-preflight-server.log | grep -E "pass|fail"

# The bot suite guards the X onboarding funnel's copy locks (template length
# with t.co accounting, sites-named-in-copy, docs drift). Small, but it is the
# only gate on public-facing reply text, so it rides preflight like the others.
echo "Running bot suite..."
(cd bot && node --test > /tmp/pt-preflight-bot.log 2>&1) \
  || { grep -E '^not ok|✖' /tmp/pt-preflight-bot.log | head -10; \
       tail -40 /tmp/pt-preflight-bot.log; fail "bot suite not green"; }
tail -8 /tmp/pt-preflight-bot.log | grep -E "pass|fail"

# The news hero prints "TESTS PASSING" and "AUDITED DEFECTS CLOSED" as
# hand-typed numbers, on a page whose next stat reads "0 NUMBERS INVENTED".
# They sat at 872/116 while the real figures moved to 1212/131. Nobody noticed
# because nothing checked — the same failure mode as the nav and the download
# link above. Gate on the parsed FAIL COUNT, never on a pipeline exit code:
# `node --test | grep` exits 0 even at 1105/1108.
# Node ≤22's spec reporter prints "ℹ pass N"; Node 24 prints "# pass N".
# awk on $2 == "pass" matches both without depending on how the shell's
# locale decodes the multi-byte ℹ inside a grep bracket expression.
EXT_PASS=$(awk '$2=="pass"{print $3; exit}' /tmp/pt-preflight-tests.log)
EXT_FAIL=$(awk '$2=="fail"{print $3; exit}' /tmp/pt-preflight-tests.log)
SRV_PASS=$(awk '$2=="pass"{print $3; exit}' /tmp/pt-preflight-server.log)
SRV_FAIL=$(awk '$2=="fail"{print $3; exit}' /tmp/pt-preflight-server.log)
BOT_PASS=$(awk '$2=="pass"{print $3; exit}' /tmp/pt-preflight-bot.log)
BOT_FAIL=$(awk '$2=="fail"{print $3; exit}' /tmp/pt-preflight-bot.log)
[ -n "$EXT_PASS" ] && [ -n "$SRV_PASS" ] && [ -n "$BOT_PASS" ] || fail "could not parse suite totals"
[ "$EXT_FAIL" = "0" ] && [ "$SRV_FAIL" = "0" ] && [ "$BOT_FAIL" = "0" ] \
  || fail "suite fail count non-zero (extension $EXT_FAIL, server $SRV_FAIL, bot $BOT_FAIL)"
# Same asymmetry as the trading-sites gate below, and for the same reason.
# Claiming MORE tests than exist is a lie and fails the release. Claiming fewer
# is merely stale, and staleness is the normal state of this number while other
# sessions are landing tests all day — the first version of this gate went red
# within the hour because a concurrent session added sixteen tests, which is
# ordinary development rather than a release blocker.
TESTS_REAL=$((EXT_PASS + SRV_PASS + BOT_PASS))
# POSIX sed, not grep -oP: -P is a GNU extension that a non-UTF-8 locale
# refuses outright ("supports only unibyte and UTF-8 locales") — the same
# portability rule as version_of() above. CI runners and fresh shells do not
# guarantee a UTF-8 locale, and this gate must not depend on one.
for page in site/news.html site/index.html; do
  shown=$(sed -n 's/.*data-check="tests">\([0-9]*\).*/\1/p' "$page" | head -1)
  [ -n "$shown" ] || fail "$page has no data-check=\"tests\" figure to verify"
  [ "$shown" -le "$TESTS_REAL" ] \
    || fail "$page claims $shown tests passing; the suites report only $TESTS_REAL ($EXT_PASS + $SRV_PASS + $BOT_PASS)"
  [ "$shown" = "$TESTS_REAL" ] \
    || echo "  note: $page says $shown tests, suites now report $TESTS_REAL — bump it when this ships"
done

# The homepage's "TRADING SITES" figure must never exceed what the build
# actually supports — over-claiming advertises a capability the user does not
# have. Under-claiming is tolerated on purpose: between a commit and its tag,
# the manifest legitimately runs ahead of what anyone can install.
SITES_REAL=$(python3 - <<'PY'
import json
m = json.load(open('extension/manifest.json'))
hosts = set()
for cs in m.get('content_scripts', []):
    for pat in cs.get('matches', []):
        h = pat.split('://')[-1].split('/')[0].replace('*.', '')
        if h != '*':
            hosts.add(h)
# x is the warm-viewer surface and papertrench.com is the site relay —
# neither is a trading site a user can trade on, and counting our own
# domain as one would inflate the hero stat.
print(len(hosts - {'x.com', 'twitter.com', 'papertrench.com', 'www.papertrench.com'}))
PY
)
SITES_SHOWN=$(sed -n 's/.*data-check="sites">\([0-9]*\).*/\1/p' site/index.html | head -1)
[ "$SITES_SHOWN" -le "$SITES_REAL" ] \
  || fail "site/index.html claims $SITES_SHOWN trading sites; the manifest supports $SITES_REAL"
[ "$SITES_SHOWN" = "$SITES_REAL" ] \
  || echo "  note: index.html says $SITES_SHOWN trading sites, manifest now has $SITES_REAL — bump it when this ships"

DEFECTS_REAL=$(grep -cE 'fixed v[0-9]' DEFECTS.md)
DEFECTS_SHOWN=$(sed -n 's/.*data-check="defects">\([0-9]*\).*/\1/p' site/news.html | head -1)
[ "$DEFECTS_SHOWN" = "$DEFECTS_REAL" ] \
  || fail "site/news.html says $DEFECTS_SHOWN defects closed; DEFECTS.md marks $DEFECTS_REAL"
echo "news stats OK (tests $TESTS_REAL = $EXT_PASS + $SRV_PASS + $BOT_PASS, defects closed $DEFECTS_REAL)"

# ---------------------------------------------------------------- live claims
# CHANGELOG's "Live on the website" heading promises "you can use this today".
# That is the one section a deploy backlog can turn into a lie without anyone
# editing a word: the text stays true of `main` and goes false in production.
# It happened — a Pages outage froze the site while two bullets described page
# behaviour that had only landed in the repo.
#
# So each claim names a stable TOKEN in the deployed artifact, never its prose:
# copy gets reworded at cut time by whoever edits voice, and a gate that trips
# on a comma is a gate people learn to bypass.
#
# The check runs BOTH directions, because a one-way check only fixes today's
# sign of the error:
#   1. a claim not findable in production, with nothing flagging it  -> FAIL
#   2. an exception block still standing once its claims ARE live    -> FAIL
# Direction 2 is the one a human sweep forgets, precisely because everything
# looks fixed by then. A note that self-removes on a condition nobody re-tests
# is just a note.
#
# Rows: token|path|claim
LIVE_CLAIMS="
cookieBlocked|/arena.js|a blocked cross-domain sign-in explains itself
uncounted|/clan.html|sub-verified clan members read 'not counted'
"
LIVE_SITE="https://papertrench.com"
CLAIMS_MISSING=""
CLAIMS_LIVE=0
CLAIMS_TOTAL=0
LIVE_SKIP=""

if ! command -v curl >/dev/null 2>&1; then
  LIVE_SKIP="curl not installed"
fi

while IFS='|' read -r token path claim; do
  [ -n "$token" ] || continue
  [ -n "$LIVE_SKIP" ] && continue
  CLAIMS_TOTAL=$((CLAIMS_TOTAL + 1))
  # Cache-bust: Pages serves max-age=600, and a stale edge copy is
  # indistinguishable from an undeployed one. A deploy younger than the CDN
  # window can still read as missing — this is a pre-TAG gate, not a monitor.
  body=$(curl -s --max-time 10 -w '\n%{http_code}' "$LIVE_SITE$path?preflight=$$" 2>/dev/null)
  status=$(printf '%s' "$body" | tail -1)
  # "I could not check" is never allowed to masquerade as either verdict — the
  # same three-state rule the pricing layer uses for a failed lookup.
  if [ "$status" != "200" ]; then
    LIVE_SKIP="$LIVE_SITE$path returned ${status:-no response}"
    continue
  fi
  if printf '%s' "$body" | grep -q "$token"; then
    CLAIMS_LIVE=$((CLAIMS_LIVE + 1))
  else
    CLAIMS_MISSING="$CLAIMS_MISSING\n    - $claim (no '$token' in $path)"
  fi
done <<EOF
$LIVE_CLAIMS
EOF

# Structural, not prose: any blockquote inside the section is an exception
# being flagged. Matching the block's wording would fail the same way matching
# a claim's wording would.
LIVE_SECTION=$(sed -n '/^## Live on the website/,/^## v/p' CHANGELOG.md)
EXCEPTIONS_FLAGGED=$(printf '%s' "$LIVE_SECTION" | grep -c '^> ' || true)

if [ -n "$LIVE_SKIP" ]; then
  echo "  note: LIVE-CLAIM CHECK SKIPPED — $LIVE_SKIP"
  echo "        Could not verify the 'Live on the website' bullets against"
  echo "        production. This is not a pass: re-run with the network up,"
  echo "        or curl each claim by hand before tagging."
elif [ -n "$CLAIMS_MISSING" ] && [ "$EXCEPTIONS_FLAGGED" -eq 0 ]; then
  # shellcheck disable=SC2059
  fail "$(printf "CHANGELOG says these are live on the website; production disagrees, and nothing flags them:$CLAIMS_MISSING\n    Deploy the site, or flag them in the section as exceptions.")"
elif [ -z "$CLAIMS_MISSING" ] && [ "$EXCEPTIONS_FLAGGED" -gt 0 ]; then
  fail "the 'Live on the website' exception block is stale: all $CLAIMS_TOTAL claims ARE in production now. Delete the block — it currently tells users a shipped feature has not shipped."
else
  echo "live claims OK ($CLAIMS_LIVE/$CLAIMS_TOTAL in production$([ "$EXCEPTIONS_FLAGGED" -gt 0 ] && echo ", remainder flagged as exceptions"))"
fi

echo
echo "PREFLIGHT OK for v$MANIFEST_V"
echo "Remaining manual steps:"
echo "  1. docs/QA-MATRIX.md pass on the built zip (content/bridge changes only)"
echo "  2. git tag v$MANIFEST_V && git push origin main --tags  (CI builds + releases)"
echo "  3. Verify the release asset hash against SHA256SUMS.txt"
