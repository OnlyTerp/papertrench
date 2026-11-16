/* livedrive acceptance: drives the live tab through the checks the release
 * needs and asserts the driver's own rules held the whole time.
 *
 *   node tools/livedrive/acceptance.mjs            # paper buys included
 *
 * Asserts: one tab after every step, no tab opened by the driver except the
 * deliberate negative control (which must be caught as TAB_INVARIANT), page
 * loads within budget. A bot check stops the run as BLOCKED, never a pass.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'livedrive.mjs');
function ld(...args) {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 180_000 })) };
  } catch (e) {
    let out = null;
    try { out = JSON.parse(e.stdout); } catch { /* not json */ }
    return { code: e.status, out };
  }
}

const results = [];
let failed = false;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}
function step(name, ...args) {
  const r = ld(...args);
  if (r.code === 2) { console.log(`BLOCKED at ${name}: a person must clear the bot check`); process.exit(2); }
  const pages = r.out && (r.out.pages ?? (r.out.result && r.out.result.pages));
  check(`${name}: one tab`, pages === 1, { pages, code: r.code });
  return r;
}

const s0 = ld('status').out;
if (!s0) { console.log('daemon not running'); process.exit(5); }
check('build loaded matches disk', !s0.build.stale, s0.build);
const opened0 = s0.tabs.driverOpened;

const chips = step('list chips', 'chips', '--filter', 'pump$').out.chips || [];
check('Pulse chips visible', chips.length > 0, { n: chips.length });

const ticks = step('row-tick feed', 'events', '--types', 'row-tick', '--wait', '6000', '--limit', '1');
check('row-tick events arriving', ticks.out && ticks.out.count > 0, { count: ticks.out && ticks.out.count });

if (chips[0]) {
  const buy = step('chip buy', 'chip-buy', '--index', '0', '--filter', 'pump$', '--watch', '10000');
  const o = buy.out || {};
  const outcome = (o.fills && o.fills.length) ? 'filled' : (o.toasts && o.toasts.length ? 'messaged' : 'silent');
  check('chip tap ends in a fill or a message (never silent)', outcome !== 'silent', { rowMc: o.rowMcAtTap, fills: o.fills, toasts: o.toasts });
}

const target = chips[1] || chips[0];
if (target) {
  const open = step('open coin by clicking its row', 'open-row', '--mint', target.mint);
  check('row click opened the coin in this tab', open.code === 0 && /\/(token|meme|t)\//.test(open.out.url || ''), open.out);
  if (open.code === 0) {
    const buy = step('panel buy', 'panel-click', '--label', '0.1 SOL', '--mint', target.mint, '--watch', '10000');
    check('panel buy filled', buy.code === 0 && buy.out.fills.length > 0, buy.out && { fills: buy.out.fills, toasts: buy.out.toasts });
    const back = step('back to Pulse', 'back');
    check('back stayed on the site', back.code === 0 && /\/pulse/.test(back.out.url || ''), back.out);
  }
}

// Negative control: a deliberate popup must be caught and closed.
const neg = ld('eval-page', '--code', "window.open('about:blank', '_blank'); return 1");
check('negative control: popup caught as TAB_INVARIANT', neg.code === 3, neg.out && { code: neg.out.code });

const s1 = ld('status').out;
check('one tab at the end', s1.pages === 1, { pages: s1.pages });
check('only the negative control opened a tab', s1.tabs.driverOpened - opened0 === 1, { opened: s1.tabs.driverOpened - opened0 });
check('page loads within budget', s1.navBudget.used <= s1.navBudget.max, s1.navBudget);
check('no bot check at the end', !s1.blocked, s1.blocked);

console.log(failed ? 'ACCEPTANCE: FAIL' : 'ACCEPTANCE: PASS');
process.exit(failed ? 1 : 0);
