# PaperTrench onboarding bot

The @-mention distribution funnel for PaperTrench. When someone tags the
project's bot handle under any X post, it replies once with the same fixed,
jargon-free start guide — then, after the reply, any follow-up in that
conversation is ignored. This document explains the funnel and provides the
exact reply text for community members to paste manually when the bot is not
yet running.

## What the bot does

1. Polls `GET /2/users/:id/mentions` for @-mentions.
2. Sorts them oldest first, skips:
   - its own tweets,
   - any tweet whose id or conversation_id was already replied to,
   - mentions older than `MAX_AGE_HOURS`,
   - anything over the hourly reply cap.
3. Replies once with a fixed template.
4. Persists the tweet id and conversation id so a thread can never loop.

## Deterministic replies

The bot's copy is imported from `bot/template.js`. Short (free-tier) version:

```
{{SHORT_TEMPLATE}}
```

Premium / long version (used only when `PREMIUM=true`):

```
{{LONG_TEMPLATE}}
```

(The real docs are built from `bot/template.js` at render time; the exact
strings above are verified by the test suite so the two never drift.)

## Manual fallback

If the bot handle is not registered yet, anyone can paste the short template
into a reply under a relevant post. The template is deterministic and on-brand:

1. `papertrench.com` — install the free Chrome extension.
2. Open a supported site — real charts, fake SOL.
3. Paper-buy, journal the thesis, review fills and P&L.

## Status

The bot is built and tested, but **not live**: no X account, credentials, or
posts exist yet. `DRY_RUN` is the default. See `bot/README.md` for the operator
flip-to-live checklist.
