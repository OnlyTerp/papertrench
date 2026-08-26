/* The browser ships a copy of core/replay.js (site/vendor/replay-core.js) so
 * the client chain lane uses the SAME accounting the server tests prove.
 * A drifted copy = two PnL doctrines = silent wrong numbers. Byte equality. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('site/vendor/replay-core.js is byte-identical to core/replay.js', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'core', 'replay.js'), 'utf8');
  const shipped = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'vendor', 'replay-core.js'), 'utf8');
  assert.strictEqual(shipped, core, 'run: cp server/core/replay.js site/vendor/replay-core.js');
});
