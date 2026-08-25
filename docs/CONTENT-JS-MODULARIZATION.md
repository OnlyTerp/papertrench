# Modularizing content.js

**Status:** plan only. Nothing here has been executed. `content.js` is
untouched at 9,215 lines (9,169 before the error-capture listeners landed).

Every number below was measured against the working tree, not estimated.

---

## 1. Why the obvious plan is wrong

The instinct is "split it into ES modules and `import` them." That cannot work
here, for two independently fatal reasons:

**The manifest declares classic content scripts.** There is no
`"type": "module"` anywhere in `manifest.json`. Content scripts listed in
`manifest.json` are injected as classic scripts — `import`/`export` is a syntax
error in that context. Chrome MV3 *can* load an ES module content script, but
only via `chrome.scripting.registerContentScripts({world, ...})` at runtime, or
by making the entry a module and dynamically importing. Changing that is a
delivery-mechanism change, not a refactor, and it would alter injection timing
on every venue at once.

**The whole file is one IIFE.** Line 7 opens `(() => {` and `'use strict'`
follows on line 8. Everything in the file shares one closure. That closure is
not incidental — it is what keeps ~61 module-scope bindings off the page's
global object, in a content script that runs inside somebody else's page.

So the unit of extraction is **not** a module. It is a **factory function that
takes its dependencies as arguments**, loaded as an additional classic script
before `content.js`, exactly like the existing `errors.js` / `fees.js` /
`slippage.js` do (`window.PTFees = api`).

---

## 2. The real blocker: ambient mutable state

Measured reference counts for module-scope `let` bindings:

| Binding | Line | References |
|---|---|---|
| `token` | 55 | **654** |
| `state` | 53 | **218** |
| `settings` | 52 | **195** |
| `site` | 54 | **140** |
| `posEls` | 62 | 63 |
| `armedBuy` | 71 | 42 |
| `marks` | 57 | 30 |

61 module-scope `let`/`var` bindings are declared in the first 600 lines alone.

`token`, `state`, `settings`, and `site` are **reassigned**, not just read. Any
function moved out of the closure loses its live view of them. Passing them once
at construction time captures a stale snapshot — the extracted code would keep
trading against a token the user navigated away from.

This is the single fact that determines the whole approach: **extract leaves
first, and only extract things that do not read ambient mutable state.**

---

## 3. Seams the author already marked

`content.js` contains 45 top-level banner comments. They are genuine boundaries,
already grouped by concern:

| Line | Section | Approx size |
|---|---|---|
| 273 | extension lifetime | 150 |
| 423 | MAIN-world bridge messages | 145 |
| 568 | price handling | 252 |
| 820 | rug guard | 30 |
| 850 | detection | 720 |
| 1570 | optional fun + alerts | 184 |
| 1806 | action-time quotes and fills | 286 |
| 2092 | fills | 283 |
| 2375 | chart orders: TP/SL | 226 |
| 2601 | armed limit buys (N2) | 680 |
| 3565–4753 | UI (panel shell, header, body, presets, position card, sell row, …) | ~1,200 |
| 4958 | ONE drag system | 584 |
| 5542 | keyboard shortcuts | — |

The UI block (3565–4753) is ~25 sub-sections averaging under 60 lines each —
these are already small and cohesive.

---

## 4. Extraction order

Strictly leaves-first. Each step must ship independently and stay green.

### Step 1 — `panel-css.js` (recommended first move)

The theme/CSS generation (`themeCss()` and the style blocks it composes) is the
only large region that is **pure**: tokens in, CSS string out. It touches none of
`token`/`state`/`settings`/`site`.

Why it is the right first step:
- pure function, no ambient state, no DOM
- large enough to prove the pattern is worth it
- failure is loud and instant (unstyled panel), never subtle
- zero risk to order execution

Shape, mirroring the existing `fees.js` convention:

```js
// panel-css.js — classic script, loaded BEFORE content.js
(() => {
  const api = { themeCss, panelCss };
  if (typeof window !== 'undefined') window.PTPanelCss = api;
  if (typeof self !== 'undefined') self.PTPanelCss = api;
})();
```

and in `content.js`, inside the IIFE:

```js
const CSS = (typeof window !== 'undefined' && window.PTPanelCss) || null;
const themeCss = CSS ? CSS.themeCss : legacyThemeCss;  // fallback stays
```

**Manifest order matters.** `panel-css.js` must precede `content.js` in the
`"js"` array, the same way `errors.js`/`fees.js`/`slippage.js` precede
`engine.js` today. Get it backwards and it is a ReferenceError on every page
load.

### Step 2 — `drag.js` (584 lines, "ONE drag system")

Self-describing as one system, and it is about pointer geometry, not trading. It
does touch DOM elements but reads little ambient state. Extract as a factory:

```js
window.PTDrag.create({ getEls: () => posEls, onMove, onEnd })
```

Accessors, not values — this is what preserves the live view of reassigned
bindings.

### Step 3 — `detect.js` (720 lines, line 850)

Largest single win, but it reads `site` and `token` heavily. Only attempt after
steps 1–2 have validated the accessor pattern.

**Do not extract:** `fills`, `armed limit buys`, `chart orders`, or
`price handling`. They are the trading core, they mutate `state` and `token`
constantly, and a subtle break there costs a user a position. The file being
long is not a reason to touch them.

---

## 5. What will fight you: 78 source-text assertions

19 test files read `content.js` off disk with `readFileSync` and assert on its
**source text** — 78 such assertions:

| File | Assertions |
|---|---|
| `u5-jump-themes-rug.test.js` | 16 |
| `errors.test.js` | 7 |
| `freshlaunch.test.js` | 7 |
| `positionsbar.test.js` | 7 |
| `u7-brand-ux.test.js` | 7 |
| `flexcard.test.js` | 6 |
| `load.test.js` | 6 |
| `livepnl.test.js` | 4 |

Example:

```js
assert.ok(content.includes('.pt-box.pt-micro .pt-header #pt-jump-orders'),
          'micro rule exists');
```

Move that CSS rule into `panel-css.js` — behavior byte-identical — and the test
goes red. Nothing broke; the test was pinned to a location, not a behavior.

**This is the same class of weakness the harness work just eliminated.** A
string assertion on source passes while the page is broken, and fails while the
page is fine. It measures text, not truth.

**Rule for every extraction step:** when a source-text assertion fails only
because code moved, do not delete it and do not "fix" it by re-pointing the
regex at the new file — that just re-pins the same weakness to a new location.
Replace it with a behavioral check:

- CSS/DOM rules → assert in the Node-vm DOM harness that the element actually
  receives the computed style
- copy/prose → assert the rendered text node, not the source literal
- function presence → call it and assert its result

If a behavioral replacement is not practical for a given assertion, that is a
signal the extraction is not safe yet.

---

## 6. Verification contract per step

Every step must clear all four before the next begins:

1. **Unit** — `cd /c/PaperTrench/extension && node --test < /dev/null` .
   Baseline is **2063 pass / 0 fail**. The `< /dev/null` is mandatory; without
   it Node 24 prints `stdin is not a tty` and exits 1. Never pipe through
   `tail` — the pipe reports tail's exit code and hides the verdict.
2. **Harness** — `pt-test.mjs scenarios/smoke-token.mjs` must exit 0 with its
   `expect(n)` contract met and `faults: []`. Run `selftest/run.mjs` first; a
   rotted verdict makes the harness gate meaningless.
3. **Negative control** — revert the extraction, confirm the new tests FAIL,
   restore byte-identical (`git diff --stat` empty). A test that passes both
   with and without the change proves nothing.
4. **Byte-identical CSS/DOM where claimed** — for `panel-css.js`, diff the
   generated string before and after. "Should be the same" is not evidence.

---

## 7. Honest cost/benefit

- Steps 1–2 remove roughly **900 lines** (~10%) from `content.js` at low risk.
- Step 3 could remove another 720, at meaningfully higher risk.
- The trading core — the majority of the remaining bulk — should stay.

A realistic ceiling is **~9,215 → ~7,500 lines**, not a dramatic teardown. The
genuine wins are that CSS and drag become independently testable, and the
78 source-text assertions get converted to behavioral ones along the way.

If the goal is faster navigation rather than architecture, the cheaper answer is
better section markers and editor folding — not a split. The file's real problem
is 654 references to a reassigned `token` binding, and splitting the file does
not fix that. Only threading state explicitly would, and that is a much larger
change than this document proposes.
