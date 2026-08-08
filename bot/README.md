# PaperTrench onboarding bot

An @-mention distribution funnel for PaperTrench. When someone tags the bot
under any X post, it replies once with a short, jargon-free, deterministic
onboarding message.

## Scope

- Builds the code, copy, docs, and local-only tests.
- **Does not create any X account, obtain credentials, post live, or deploy.**
- Runs in `DRY_RUN` mode by default.

## Setup (operator)

1. Create an X developer account and app.
   - VERIFY against current X API docs for the exact `tweet.fields` and
     `reply` payload shapes.
2. Enable pay-per-use or appropriate billing on the app.
   - Cost: at least one read per poll (`GET /2/users/:id/mentions`) plus one
     write per reply (`POST /2/tweets`). Verify current pricing on X's docs;
     do not trust a stale number in this file.
3. Set the account bio to disclose that the handle is a bot.
4. Configure environment variables in a `.env` file or shell:

```bash
X_BEARER_TOKEN=...
X_API_KEY=...
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...
BOT_HANDLE=PaperTrenchBot
DRY_RUN=true          # keep true until the flip-to-live checklist is done
POLL_SECONDS=60
BACKFILL=false
MAX_AGE_HOURS=24
MAX_REPLIES_PER_HOUR=15
```

## Run

```bash
# one cycle, DRY_RUN
DRY_RUN=true node bot/run.js --once

# loop
DRY_RUN=true node bot/run.js
```

## Deploy options

```systemd
# /etc/systemd/system/papertrench-bot.service
[Unit]
Description=PaperTrench onboarding bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/papertrench/bot
EnvironmentFile=/home/papertrench/bot/.env
ExecStart=/usr/bin/node run.js
Restart=on-failure
RestartSec=60

[Install]
WantedBy=multi-user.target
```

A cron-based alternative runs `node run.js --once` every minute.

## Flip-to-live checklist

- [ ] X API v2 field and endpoint names re-verified against current docs.
- [ ] OAuth request signing implemented in `bot/run.js` `xPost()` — the shipped
      function is a deliberate stub that throws (`live posting not
      implemented`). Fill it in with a verified library (e.g. `oauth-1.0a`)
      and test against the bot's own account first.
- [ ] Account bio discloses the bot.
- [ ] Billing / rate limits understood and budgeted.
- [ ] `DRY_RUN=false` set as the **last** change.

## Compliance

- Reply only when explicitly @-mentioned.
- One reply per conversation, ever.
- Deterministic fixed template; no LLM-generated or variable replies.
- Mentions beyond the hourly cap or older than `MAX_AGE_HOURS` are dropped,
  not queued — a mention burst is the scenario where silence is safer than a
  delayed flood.
