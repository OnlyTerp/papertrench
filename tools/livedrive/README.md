# livedrive: live-site checks without tab spam

One background daemon owns one Chrome window with one tab, logged into the
venue (Axiom by default) with the extension loaded unpacked from
`extension/`. Every check goes through it, so tests navigate the site the way a
person does instead of opening a tab per probe.

Rules it enforces (not conventions):

- **One tab.** There is no "new page" command and no remote-debugging port. Any
  tab that appears anyway is closed at once and counted. If the page opened
  it (its opener is our tab), the command fails with `TAB_INVARIANT`. Tabs
  with no opener come from the extension or browser (the chart tab after a
  list buy that opens a new position, the what's-new page); they are closed
  and recorded as `tab-opened` events instead.
- **Code changes don't relaunch Chrome.** Commands live in `commands.mjs`,
  which the daemon re-imports on every call. Only `daemon.mjs` changes need a
  relaunch.
- **Move like a person.** `open` clicks a matching link on screen when there is
  one; otherwise it does a same-tab load on the same site. Full loads
  (`refresh`, URL load, `reload-ext`, and Chrome launches) spend a rolling
  budget, 5 per 10 minutes by default (`LIVEDRIVE_NAV_MAX`,
  `LIVEDRIVE_NAV_WINDOW_MS`). Chrome launches also have their own cap, 2 per
  hour (`LIVEDRIVE_LAUNCH_MAX`, `LIVEDRIVE_LAUNCH_WINDOW_MS`). Both budgets
  are saved on disk, so restarting the daemon doesn't reset them.
- **Bot checks freeze it.** Before and after every site action, and every
  5 s, the page is checked for a Cloudflare challenge. While one is up, site
  commands return `BLOCKED` (exit 2) and a screenshot lands in
  `shots/blocked.png`. The driver never touches the challenge; a person
  clears it in the window, and the next status check notices.
- **Background-safe.** Clicks go through the browser, not the OS cursor, so
  you can keep working. The window may sit behind others; `status` reports
  `visibility` and per-event ages so throttling shows up instead of being
  assumed. Don't minimize it.
- **Build-stamped.** Every buy result carries the loaded extension's version
  and file hash; `status` flags `stale` when the files on disk changed since
  the last `reload-ext`.

## Commands

```
node tools/livedrive/livedrive.mjs start
node tools/livedrive/livedrive.mjs status
node tools/livedrive/livedrive.mjs reload-ext                 # reload extension + one refresh
node tools/livedrive/livedrive.mjs refresh
node tools/livedrive/livedrive.mjs open --path /pulse?chain=sol
node tools/livedrive/livedrive.mjs open-row --mint <MINT>     # click a Pulse row
node tools/livedrive/livedrive.mjs back | forward             # refused if it would leave the site
node tools/livedrive/livedrive.mjs chips [--filter pump$]
node tools/livedrive/livedrive.mjs chip-buy --index 0 | --mint <MINT> | --unheld   # waits for the end state
node tools/livedrive/livedrive.mjs panel-click --label "0.1 SOL" --mint <MINT>
node tools/livedrive/livedrive.mjs events --types row-tick,row-buy --wait 15000
node tools/livedrive/livedrive.mjs journal --mint <MINT> --n 5
node tools/livedrive/livedrive.mjs positions
node tools/livedrive/livedrive.mjs eval-page "return document.title"
node tools/livedrive/livedrive.mjs eval-sw "return chrome.runtime.getManifest().version"
node tools/livedrive/livedrive.mjs screenshot --name pulse
node tools/livedrive/livedrive.mjs stop
```

Commands run one at a time in the order received. Recorders are installed once
and survive navigation: every `papertrench-bridge` / `papertrench-content`
window message, PaperTrench toasts, PaperTrench console lines and navigations
go into an 8000-event ring that `events` queries.

Exit codes: 0 ok, 1 error, 2 BLOCKED, 3 TAB_INVARIANT, 4 refused (budget, args,
not found), 5 daemon not running.

## Setup

- Playwright is borrowed from `C:/PaperTrench-livepass`
  (`LIVEDRIVE_PLAYWRIGHT_FROM` to change).
- Profile: `U:/scratch/PaperTrench/axiom-live/profile` (`LIVEDRIVE_PROFILE`).
  Log into the venue in that window once; cookies live only in the profile,
  never in the repo.
- State, action log (`actions.jsonl`), daemon log and screenshots:
  `U:/scratch/PaperTrench/livedrive` (`LIVEDRIVE_STATE`).
- Other knobs: `LIVEDRIVE_EXT`, `LIVEDRIVE_START`, `LIVEDRIVE_CHROME`,
  `LIVEDRIVE_WINDOW_POS` (e.g. `1600,0`).

Unit tests for the guards: `node --test tools/livedrive/test/guards.test.mjs`.

Live acceptance (paper buys, one refresh): `node tools/livedrive/acceptance.mjs`.
It asserts one tab throughout, page loads within budget, a deliberate
`window.open` caught as `TAB_INVARIANT`, and that chip taps on coins with no
position end in a fill or a message.

Stop the daemon when you're done (`stop`); it closes Chrome cleanly.
