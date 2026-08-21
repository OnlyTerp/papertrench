/* Every table the Worker reads or writes must exist in server/schema.sql.
 *
 * This exists because code and schema drift apart silently. The pure core
 * suite never touches D1, so a query against a table nobody created is green
 * all the way through CI and only becomes a 500 when a visitor hits the route.
 * That is the worst possible place to find out, and it is what happened with
 * the clan tables: three tables queried by the leaderboard, the sprint board
 * and every profile page, none of them in the schema this repo ships.
 *
 * Run from the repo root:  node scripts/check-schema-drift.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WORKER_DIR = 'server/worker';
const SCHEMA = 'server/schema.sql';

/**
 * Comments carry prose — "derived FROM an honest record", "fold INTO one" —
 * which is not a table reference. Stripping them is what keeps this check at
 * zero false positives, and a check that cries wolf gets switched off.
 *
 * Three kinds, and the third is the one that bites: SQL `--` comments live
 * INSIDE the template literals, so a JS-only stripper leaves them in and the
 * scan reads the English after them as schema.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // JS block
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // JS line (not a :// in a URL)
    .replace(/--\s[^\n]*/g, ' ');           // SQL line, inside query strings
}

const schema = fs.readFileSync(SCHEMA, 'utf8');
const known = new Set([...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)]
  .map((m) => m[1].toLowerCase()));

const referenced = new Map();
for (const file of fs.readdirSync(WORKER_DIR).filter((f) => f.endsWith('.js'))) {
  const code = stripComments(fs.readFileSync(path.join(WORKER_DIR, file), 'utf8'));
  for (const match of code.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = match[1].toLowerCase();
    // `FROM (SELECT ...)` subqueries and `ON CONFLICT DO UPDATE SET` upserts.
    if (name === 'select' || name === 'set') continue;
    if (!referenced.has(name)) referenced.set(name, file);
  }
}

const missing = [...referenced].filter(([name]) => !known.has(name));
console.log(`schema: ${known.size} tables · worker references: ${referenced.size}`);
for (const [name, file] of missing) {
  console.log(`::error file=${WORKER_DIR}/${file}::table "${name}" is queried but absent from ${SCHEMA}`);
  console.error(`SCHEMA DRIFT: ${WORKER_DIR}/${file} queries "${name}", which ${SCHEMA} never creates.`);
}
if (missing.length) process.exit(1);
console.log('every queried table is in the schema');
