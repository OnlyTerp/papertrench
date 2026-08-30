# D-66 Validation Contract — identity-gated quick buy

Defect (harisx1, Discord #bug-reports 2026-08-30T11:15Z): "Can we have the new
pairs pause for quick buy? it doesnt pause when quick buying so u end up
buying wrong quick buy."

## Root cause (code-verified)

`requestBuy()` (extension/content.js) fills INSTANTLY whenever `token` carries
a `priceNative`. On a brand-new pair page there is a window between the
navigation landing and the detect loop's next tick (`detectLoop()`, ~800ms
cadence) where `token` is still the PREVIOUS coin — fully resolved, priced,
and quick-buyable. A rapid quick-buy in that window fills the coin the user
already left (S1: a fill against the wrong token corrupts the paper book).
The pending-token path itself is safe (it arms via the D-38/D-39 armedBuy
doctrine and re-keys on discovery), so the gate must close only the
stale-identity instant-fill window — without regressing the existing armed
behavior.

## Entry points inventoried

1. Panel preset chips, instant mode — `renderPresets()` → `requestBuy(amt)`
   (content.js ~:5701).
2. Panel BUY button (+ Enter in the amount box, + keyboard shortcut focusing
   then clicking it) — `els.btnBuy` click → `requestBuy(amt)` (~:5510).
   All panel paths funnel through `requestBuy` — one gate covers them all.
3. List quick-buy (screener row chips) — `doRowBuy(address)` (~:6947) and its
   armed flush `flushRowArmed()` (~:6894). Identity is bound to the CLICKED
   row address, not panel page state, and both fill and flush re-derive the
   canonical mint (F-59/F-61/onchainPrewatch; SW-mirror adoption binds
   `data.mint` at content.js ~:1185). Audited: already identity-safe; no gate
   needed there. Pinned structurally in the test so a future refactor that
   loosens the binding is caught.

## Requirements

- D-66-R1 (panel identity gate): `requestBuy` must NOT fire an instant fill
  when the page URL no longer matches the URL the current token was detected
  on (navigation in flight, token not yet swapped). It refuses with a visible
  toast. Once the detect loop swaps in the pending token, a click arms
  normally (existing doctrine — no third pattern).
- D-66-R2 (no armed-behavior regression): a quick-buy on a PENDING token
  still arms (fromClick) and flushes on the first accepted quote for the
  discovered mint; discovery re-keying (prewatch, resolve, swap stash)
  is untouched.
- D-66-R3 (stale armed drop): an armed buy whose token identity changed
  without re-key proof is dropped, never silently filled (existing setToken
  / flushArmedBuy mint binding — pinned, not changed).

## Validation

- VAL-1: `extension/test/d66_quickbuy_gate.test.js` — structural pins on the
  panel gate and the row-path identity binding. Negative control: with the
  fix stashed, D-66/1 fails (recorded below).
- VAL-2: behavioral — via the real content script in the freshlaunch vm
  harness: (a) a pending coin + quick-buy click produces NO fill record while
  unindexed; (b) after indexing + first quote, the armed fill lands under the
  DISCOVERED mint; (c) a URL change without a detect tick yet refuses the
  instant fill (no journal entry for the OLD mint).
- VAL-3: full extension suite green (count recorded in the task report).
- VAL-4: negative control recorded here.

## VAL-4 negative control record

Run 2026-08-30, branch wt/t_7ef82ff0, fix stashed via
`git stash push -- extension/content.js`:

    node --test test/d66_quickbuy_gate.test.js
    ✖ D-66/1: requestBuy gates the instant fill on token-identity freshness
    ✖ D-66/2: the identity anchor is stamped by the detect loop, not by renders
    tests 6  pass 4  fail 2

With the fix restored: tests 6 pass 6 fail 0. The structural pins go red
exactly on the stashed fix (VAL-4 satisfied).

