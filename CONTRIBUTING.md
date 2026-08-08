# Contributing to PaperTrench

Thanks for helping. This is a tool people use to learn how to trade, so the
bar is correctness first and polish second.

## The one hard rule

**Never fabricate a number.** If a price, a fill, or a statistic cannot be
derived from real data, the code must say so rather than guess. A wrong number
shown confidently is worse than an honest "waiting for a quote" — it silently
corrupts every P&L that follows, and it teaches the user the wrong lesson.

## Running the tests

There are two suites, and CI runs both:

```bash
cd extension && node --test    # 1104 tests — overlay, engine, price resolution
cd server   && node --test     #  103 tests — chain verification, pricing, boards
```

All must pass. The single live-API test skips (never fails) when offline.

Before a release — or any change to `server/` or `site/`:

```bash
bash scripts/preflight.sh              # version, CHANGELOG, download link, nav
node scripts/check-schema-drift.js     # every queried table exists in schema.sql
```

The pure core suites never import the Worker entry or touch D1, so a broken
import or a query against a table nobody created is green all the way through
them. CI covers that gap separately (`.github/workflows/test.yml`).

## Writing tests

Two things make a test worth having:

1. **Derive expectations from inputs.** Compute the expected value in the test
   from the same inputs the code gets, rather than pasting a number from a run.
   A pasted literal blesses whatever the code did, including bugs.
2. **Prove it can fail.** After writing a test for a fix, revert the fix and
   confirm the test goes red. A test that passes either way is not a test.
   Several tests in this repo exist because that check caught a weak assertion.

## Structure

Decision logic lives in pure functions (`quote.js`, `engine.js`, `attest.js`)
with no DOM and no network, so the code the tests exercise is exactly the code
that runs in the browser. Keep it that way — push I/O to the edges.

## Style

- Comments explain *why*, not *what*. Skip them when the code is obvious.
- Prefer clear names over clever ones.
- UI changes: check the rendering, don't assume the CSS is right.
