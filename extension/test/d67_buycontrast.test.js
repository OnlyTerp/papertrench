/* D-67: the main BUY button's label went invisible — green text on its own
 * green gradient.
 *
 * Reported from the field (screenshot, Padre "Terminal" view): the panel's
 * primary buy button rendered as a solid green pill with no legible "BUY".
 *
 * Root cause, found by reading the two .pt-buy rules in order:
 *
 *   .pt-buy {                                    // the base rule
 *     background: linear-gradient(180deg, #3FE49B, #22B573);
 *     color: #032B1B;                             // dark, deliberately
 *   }
 *   ...
 *   .pt-buy { color: var(--pt-green); }           // --pt-green: #34D399
 *
 * Both selectors have equal specificity (one class each), so the LATER rule
 * wins by cascade order regardless of what the first one intended. The
 * override was written for the small preset chips and the sell ladder —
 * "the buy chips read green, the sell ladder red" — where it is legible
 * because those elements have a transparent or dark background, not one
 * drawn from the same swatch as the text sitting on it. .pt-buy was caught
 * in the same bare selector by accident and inherited a background it was
 * never designed against: #34D399 text on a #3FE49B→#22B573 background is
 * green-on-green, near-zero contrast.
 *
 * git blame: introduced by 92d11baf ("the panel keeps its shape, held or
 * not"), which added the direction-colour block without checking it against
 * .pt-buy's own earlier rule.
 *
 * Fix: .pt-buy is no longer in the override list. Locked here at the source
 * level so a future edit to that block cannot silently re-add it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

/** Every bare `.SELECTOR { ... }` rule, in source order, most-specific-last
 *  matching the exact class (not `.pt-buy-armed`, not `.pt-box .pt-buy`). */
function bareRules(selector) {
  const re = new RegExp(
    '(?<![.\\w-])' + selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}', 'g');
  return [...src.matchAll(re)].map((m) => m[1]);
}

test('D-67/1: no rule ever sets .pt-buy\'s text to --pt-green again', () => {
  const rules = bareRules('.pt-buy');
  assert.ok(rules.length >= 1, '.pt-buy must still exist');
  for (const body of rules) {
    assert.doesNotMatch(body, /color:\s*var\(--pt-green\)/,
      'green text on the button\'s own green gradient is the exact bug '
      + '(field report: the BUY label unreadable in Padre Terminal)');
  }
});

test('D-67/2: the base .pt-buy rule keeps its deliberate dark, high-contrast text', () => {
  const rules = bareRules('.pt-buy');
  const base = rules.find((body) => /background:\s*linear-gradient/.test(body));
  assert.ok(base, 'the base rule (the one with the green gradient) must exist');
  assert.match(base, /color:\s*#032B1B/,
    'dark text against the light green gradient is what makes the label legible');
});

test('D-67/3: the direction-colour block still colours what it can safely colour', () => {
  // The fix must be surgical: .pt-preset and .pt-sell keep their intended
  // colouring, only .pt-buy is excluded. Losing the other two would be
  // trading one regression for another.
  assert.match(src, /\.pt-preset\s*\{\s*color:\s*var\(--pt-green\)/,
    'preset chips must still read green — they have no background collision');
  assert.match(src, /\.pt-sell\s*\{\s*color:\s*var\(--pt-red\)/,
    'the sell ladder must still read red');
});

test('D-67/4: the armed state (a different class) is untouched by any of this', () => {
  // .pt-buy-armed is not `.pt-buy` and was never part of the bug — confirm
  // the fix did not accidentally touch it.
  const armed = bareRules('.pt-buy-armed');
  assert.ok(armed.length >= 1, '.pt-buy-armed must still exist');
  assert.match(armed[0], /color:\s*#2A1400/, 'armed keeps its own dark text');
});
