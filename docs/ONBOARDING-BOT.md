# PaperTrench onboarding bot

The @-mention distribution funnel for PaperTrench. When someone tags the
project's bot handle under any X post, it replies once with the same fixed,
jargon-free start guide — then, after the reply, any follow-up in that
conversation is ignored. This document explains the funnel and provides the
exact reply text for community members to paste manually while the bot is not
yet running.

## What the bot does

1. Polls `GET /2/users/:id/mentions` for @-mentions.
2. Sorts them oldest first, skips:
   - its own tweets,
   - any tweet whose id or conversation_id was already replied to,
   - mentions older than `MAX_AGE_HOURS`,
   - anything over the hourly reply cap (dropped, not queued — a mention burst
     is exactly the scenario where silence is safer than a delayed flood).
3. Replies once with a fixed template.
4. Persists the tweet id and conversation id so a thread can never loop.

## Deterministic replies

The copy below is pasted verbatim from `bot/template.js`; the test suite fails
if the two ever drift (`bot/test/xbot.test.js`, docs copy lock). Short
(free-tier) version:

```
Curious about a memecoin? Paper-trade it first.
1. Install the free Chrome ext.
2. Open Axiom, Padre, GMGN, BullX, Dexscreener, Birdeye — real charts, fake SOL.
3. Paper-buy, journal thesis, review fills and P&L.
No wallet. No risk. Real lessons.
papertrench.com
```

Premium / long version (used only when `PREMIUM=true`):

```
Curious about a memecoin? Paper-trade it first.
1. papertrench.com → install the free Chrome extension.
   - chrome://extensions → turn on Developer mode → Load unpacked.
   - Select the folder that contains manifest.json.
2. Open Axiom, Padre, GMGN, BullX, Dexscreener, Birdeye — real charts, fake SOL.
3. Paper-buy, journal your thesis, review fills and P&L.
No wallet. No risk. Real lessons.
When you're ready for real size you'll already know the game.
papertrench.com
```

Pump.fun is fully supported by the extension but deliberately not named in the
reply: X auto-links `.fun` domains, and a second t.co URL would push the short
post past the 280-character free-tier limit (and double the per-post URL
pricing).

## Manual fallback

While the bot handle is not registered, anyone can paste the short template
above — verbatim, including the final `papertrench.com` line — into a reply
under a relevant post.

## Status

The bot is built and unit-tested, but **not live**: no X account, credentials,
or posts exist yet. OAuth 1.0a signing is implemented (`bot/oauth.js`) and
locked against X's documented signature example, but no credentialed post has
ever been sent. `DRY_RUN` is the default. See `bot/README.md` for the operator
flip-to-live checklist.
