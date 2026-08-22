/* U7 — brand mark, settings grouping, and the leaderboard onboarding gate.
 *
 * The gate tests are the load-bearing ones. This change introduces the FIRST
 * request the extension makes to papertrench's own server, against a privacy
 * page that says in two places that the extension "never phones home". What
 * keeps that true is the fence: the board is fetched only after the user has
 * linked an identity and switched Site sync on. A refactor that renders the
 * live card one step early, or calls the fetch from boot, breaks a published
 * promise rather than a layout — so it is asserted here rather than trusted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const dashHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

/** Slice a top-level function body (these files close functions at col 0). */
function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/* ------------------------------------------------ the onboarding gate ----- */

/**
 * lbSteps + lbReady, evaluated against a supplied `settings`.
 *
 * `steps` returns the done-flags as a plain host array. Values built inside a
 * vm context belong to that realm, so a raw result compares unequal to an
 * ordinary array literal even when every element matches — "same structure but
 * not reference-equal", which reads as a logic failure and is not one.
 */
function gate(settings) {
  const ctx = { settings, module: {} };
  vm.createContext(ctx);
  vm.runInContext(
    fnBlock(dashJs, 'function lbSteps(')
    + '\n' + /const lbReady = [^;]+;/.exec(dashJs)[0]
    + '\nmodule.steps = lbSteps; module.ready = lbReady;', ctx);
  return {
    raw: ctx.module.steps,
    ready: (s) => ctx.module.ready(s),
    steps: (identity, chainLen) => [...ctx.module.steps(identity, chainLen)],
  };
}

test('a fresh install has all three steps outstanding', () => {
  const { steps, ready } = gate({});
  const s = steps(null, 0);
  assert.equal(s.length, 3, 'exactly three steps — the flow is capped at three');
  assert.deepEqual(s.map((x) => x.done), [false, false, false]);
  assert.equal(ready(s), false);
});

test('each step is satisfied by its own signal, independently', () => {
  const { steps } = gate({});
  // Linking alone
  assert.deepEqual(steps({ handle: 'a' }, 0).map((x) => x.done), [true, false, false]);
  // A chain alone — you can trade before ever linking
  assert.deepEqual(steps(null, 5).map((x) => x.done), [false, true, false]);
  // Site sync alone
  assert.deepEqual(gate({ leaderboardBridge: true }).steps(null, 0).map((x) => x.done),
    [false, false, true]);
});

test('the gate opens only when all three are done', () => {
  const { steps, ready } = gate({ leaderboardBridge: true });
  assert.equal(ready(steps({ handle: 'a' }, 1)), true);
  assert.equal(ready(steps({ handle: 'a' }, 0)), false, 'no chain, no record to rank');
  assert.equal(ready(steps(null, 1)), false, 'no identity to rank under');
  const off = gate({ leaderboardBridge: false });
  assert.equal(off.ready(off.steps({ handle: 'a' }, 1)), false,
    'without Site sync the board can never read the record');
});

test('Site sync must be exactly true — a truthy leftover must not open the gate', () => {
  // leaderboardBridge is written as a boolean, but settings survive upgrades
  // and backups. A stray "false" string would be truthy and would silently
  // enable a network call the user never agreed to.
  for (const value of ['false', 1, 'yes', {}]) {
    const { steps, ready } = gate({ leaderboardBridge: value });
    assert.equal(ready(steps({ handle: 'a' }, 1)), false,
      `leaderboardBridge=${JSON.stringify(value)} must not count as consent`);
  }
});

/* ------------------------------------------- the fence around the fetch --- */

test('the board is fetched from exactly one place, and that place is the gated one', () => {
  const calls = [...dashJs.matchAll(/fetch\(\s*LB_API/g)];
  assert.equal(calls.length, 1, 'LB_API must be fetched from a single function');
  const loader = fnBlock(dashJs, 'async function loadLiveBoard(');
  assert.ok(loader.includes('fetch(LB_API'), 'the one call must live in loadLiveBoard');
});

test('nothing calls loadLiveBoard without first proving the gate is passed', () => {
  const callers = [...dashJs.matchAll(/loadLiveBoard\(/g)];
  // definition + the guarded call + the refresh button + the retry link
  assert.ok(callers.length >= 2, 'loadLiveBoard must actually be used');

  const bind = fnBlock(dashJs, 'async function bindLeaderboard(');
  const guard = bind.indexOf("querySelector('#lb-live')");
  const call = bind.indexOf('loadLiveBoard(el)');
  assert.ok(guard !== -1, 'bindLeaderboard must test for the gated element');
  assert.ok(guard < call, 'the presence test must gate the call, not follow it');
});

test('the live card exists only on the far side of the gate', () => {
  const render = fnBlock(dashJs, 'function renderLeaderboard(');
  const early = render.indexOf('return renderLbWizard');
  const live = render.indexOf('id="lb-live"');
  assert.ok(early !== -1, 'renderLeaderboard must bail to the wizard');
  assert.ok(live !== -1, 'the finished tab must carry the live card');
  assert.ok(early < live, 'the wizard return must come BEFORE the live markup');

  // ...and the wizard itself must not contain it, or the bail would be moot.
  const wizard = fnBlock(dashJs, 'function renderLbWizard(');
  assert.ok(!wizard.includes('lb-live'), 'the wizard must not render the live card');
  assert.ok(!wizard.includes('LB_API'), 'the wizard must not reference the API at all');
});

test('the board request carries no credentials', () => {
  const loader = fnBlock(dashJs, 'async function loadLiveBoard(');
  assert.match(loader, /credentials:\s*'omit'/,
    'a read of a public board must not attach cookies');
});

test('an unreachable board is reported as unreachable, never as an empty board', () => {
  // "No entries" is a claim about the world; a failed fetch has not earned it.
  const loader = fnBlock(dashJs, 'async function loadLiveBoard(');
  // The catch block only — sliced to the empty-state branch that follows it,
  // or the "no records" copy further down lands inside the sample and the
  // assertion below can never fail.
  const from = loader.indexOf('} catch');
  const to = loader.indexOf('if (!entries.length)');
  assert.ok(from !== -1 && to > from, 'loadLiveBoard must catch, then handle empty');
  const katch = loader.slice(from, to);

  assert.ok(/Couldn.t reach/.test(katch), 'the failure path must say the read failed');
  assert.ok(!/No verified records/.test(katch), 'the failure path must not claim emptiness');
  assert.ok(/return/.test(katch), 'the failure path must stop, not fall through to a render');
});

/* --------------------------------------------------- settings grouping ---- */

test('every settings card is placed in exactly one group', () => {
  const render = fnBlock(dashJs, 'function renderSettings(');
  const panes = [...render.matchAll(/<section class="set-pane" data-group="([a-z]+)"/g)];
  assert.ok(panes.length >= 5, 'settings must be split into groups');

  // Every <h3> card heading must fall inside a pane, and the save bar must not.
  const firstPane = render.indexOf('<section class="set-pane"');
  for (const m of render.matchAll(/<h3>([^<]+)<\/h3>/g)) {
    assert.ok(m.index > firstPane, `card "${m[1]}" is outside every group pane`);
  }
  assert.ok(render.indexOf('id="save-settings"') > render.lastIndexOf('</section>'),
    'the save bar must stay pinned outside the groups');
});

test('filtering hides fields, and never removes them from the form', () => {
  // A filter that detached inputs would drop whatever the user had scrolled
  // past from the next Save — silently reverting settings they never touched.
  const filter = fnBlock(dashJs, 'function bindSettingsFilter(');
  assert.ok(/\.hidden\s*=/.test(filter), 'filtering must work through .hidden');
  for (const banned of ['.remove()', 'removeChild', 'innerHTML =', '.disabled = true']) {
    assert.ok(!filter.includes(banned), `filtering must not use ${banned}`);
  }
});

test('a search outranks the group tabs', () => {
  // Otherwise a match in Trading is invisible while Safety is selected, and
  // the page looks like it has no answer to a term it can see.
  const filter = fnBlock(dashJs, 'function bindSettingsFilter(');
  assert.match(filter, /one-group['"]?,\s*!searching/,
    'group narrowing must be suspended while a search is running');
});

test('the settings search box and its empty state are styled', () => {
  for (const sel of ['#set-search', '.set-tab', '.set-pane', '.set-none']) {
    assert.ok(dashHtml.includes(sel), `dashboard.html must style ${sel}`);
  }
});

/* ------------------------------------------------------------- the mark --- */

test('no surface still shows the placeholder letter', () => {
  const surfaces = ['dashboard.html', 'overlay.html', 'popup.html'];
  for (const f of surfaces) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/<div class="(brand-)?mark">P<\/div>/.test(html),
      `${f} still renders the letter placeholder`);
    assert.ok(/<svg[^>]*viewBox="0 0 24 24"/.test(html), `${f} must carry the mark`);
  }
  assert.ok(!contentJs.includes('<div class="pt-icon">P</div>'), 'panel icon still a letter');
  assert.ok(!contentJs.includes('<span class="pt-bar-mark">P</span>'), 'bar mark still a letter');
});

test('the injected mark follows the panel theme instead of hardcoding orange', () => {
  // The five panel skins exist to blend with the host dex; a fixed orange
  // plane sits wrong on the Solana and Axiom palettes.
  assert.match(contentJs, /\.pt-icon\s*\{[^}]*color:\s*var\(--pt-amber\)/,
    'the panel icon must ink from the theme token');
  assert.match(contentJs, /\.pt-icon svg[^{]*\{[^}]*fill:\s*currentColor/,
    'the mark must inherit that colour');
});

test('the injected mark carries no gradient ids', () => {
  // It renders twice in one shadow tree (positions bar + panel header); two
  // copies of the same <defs> would collide their ids.
  const mark = /mark:\s*'([^']+)'/.exec(contentJs);
  assert.ok(mark, 'ICONS.mark must exist');
  assert.ok(!mark[1].includes('id='), 'the injected mark must not define ids');
});

test('every icon in the repo still matches brand/logo.png', () => {
  // The icons are generated, so they can drift from the master the moment
  // someone edits one by hand or replaces the logo without rerunning the tool.
  const out = execFileSync(process.execPath,
    [path.join(REPO, 'scripts', 'make-icons.js'), '--check'],
    { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /all icons match the master/);
});

test('onboarding shows one step at a time, and it is the current one', () => {
  // The list form rendered all three, two of which could not be acted on.
  const wizard = fnBlock(dashJs, 'function renderLbWizard(');
  assert.match(wizard, /const step = steps\[current\];/,
    'exactly one step is selected for rendering');
  assert.ok(!/steps\.map\(\(s, i\) =>/.test(wizard),
    'the every-step list must be gone, or two of them are unreachable furniture');
  // The finished ones survive as a summary, so progress is still visible.
  assert.match(wizard, /steps\.filter\(\(x\) => x\.done\)/,
    'completed steps are still shown, as a recap rather than as steps');
});

test('the step count and the pips agree with the step being shown', () => {
  const wizard = fnBlock(dashJs, 'function renderLbWizard(');
  assert.match(wizard, /Step \$\{current \+ 1\} of \$\{steps\.length\}/,
    'the counter is derived from the same index that picked the step');
  assert.match(wizard, /i === current \? 'now'/,
    'and the pips mark that same index as current');
});

test('the onboarding card is centred', () => {
  assert.match(dashHtml, /\.lb-onboard \{[^}]*margin: 40px auto 0;[^}]*text-align: center;/,
    'the request was specifically that the questions be centred');
});

/* ---------------- the tab once onboarding is done ---------------- */

test('the board comes before the vocabulary that explains it', () => {
  const render = fnBlock(dashJs, 'function renderLeaderboard(');
  const board = render.indexOf('id="lb-live"');
  const evidence = render.indexOf('The evidence behind your row');
  assert.ok(board !== -1 && evidence !== -1, 'both sections must exist');
  assert.ok(board < evidence, 'standings must render above the chain evidence');
});

test('the chain vocabulary is folded away, not deleted', () => {
  const render = fnBlock(dashJs, 'function renderLeaderboard(');
  // Density was the complaint; losing the evidence would be a different bug.
  for (const kept of ['Committed fills', 'Derived from chain', 'Chain head', 'lb-head', 'lb-derived']) {
    assert.ok(render.includes(kept), kept + ' must survive the redesign');
  }
  const foldAt = render.indexOf('<details class="lb-fold"');
  assert.ok(foldAt !== -1 && foldAt < render.indexOf('Chain head'),
    'and it must sit inside a collapsed disclosure');
});

test('the post-gate view no longer carries the never-linked branch', () => {
  const render = fnBlock(dashJs, 'function renderLeaderboard(');
  // Unreachable by construction: the gate cannot be passed without an
  // identity, so a 'link your account' form here is dead markup that still
  // has to be read past.
  assert.ok(!render.includes('id="lb-handle"'),
    'the link form belongs to onboarding, not to the finished tab');
});

test('the hero states the return without making the reader derive it', () => {
  const render = fnBlock(dashJs, 'function renderLeaderboard(');
  assert.match(render, /lb-hero-roi/, 'the headline number is the return on bankroll');
  assert.match(render, /roiPct\.toFixed\(1\)/);
  // D-06: that percentage denominates on the wallet's birth anchor.
  assert.match(render, /E\.anchorStartSol\(state, settings\)/,
    'and it must keep using the birth anchor, never the live setting');
});
