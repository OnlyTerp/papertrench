#!/usr/bin/env node
/* Bake the running version's patch notes into the extension.
 *
 *   node scripts/make-whatsnew.js          write extension/whatsnew.json
 *   node scripts/make-whatsnew.js --check  verify it matches CHANGELOG.md
 *
 * The dashboard shows these once after an update. Baked at build time rather
 * than fetched, for two reasons: an unpacked install has no update channel to
 * ask, and the doctrine is that the extension does not call home to read its
 * own release notes. The file is small, it is the truth as shipped, and it
 * works with the network off.
 *
 * "Unreleased" is deliberately skipped — it describes work that is not in the
 * build the user is running, and showing it would be the release-notes version
 * of a wrong number.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');
const OUT = path.join(ROOT, 'extension', 'whatsnew.json');

const version = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;
const md = fs.readFileSync(CHANGELOG, 'utf8').replace(/\r\n/g, '\n');

/** The body of `## v<version> — <date>`, up to the next `## `. */
function sectionFor(v) {
  const re = new RegExp(`^## v${v.replace(/\./g, '\\.')}(?:\\s+—\\s+(\\S+))?\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const from = m.index + m[0].length;
  const next = md.indexOf('\n## ', from);
  return { date: m[1] || null, body: md.slice(from, next === -1 ? undefined : next).trim() };
}

/**
 * Markdown -> the small shape the dashboard renders.
 *
 * Each entry in this changelog is a **bold lead-in** followed by prose, so the
 * lead-in becomes the headline and the rest the detail. Anything that does not
 * fit that shape is kept as a plain paragraph rather than dropped — release
 * notes that silently omit an item are worse than ones that look uneven.
 */
function parseEntries(body) {
  return body.split(/\n\s*\n/).map((para) => {
    const flat = para.replace(/\n/g, ' ').trim();
    if (!flat) return null;
    const lead = /^\*\*(.+?)\*\*\s*(.*)$/.exec(flat);
    if (lead) return { title: lead[1].trim(), text: lead[2].trim() };
    return { title: null, text: flat };
  }).filter(Boolean);
}

const section = sectionFor(version);
if (!section) {
  console.error(`CHANGELOG.md has no "## v${version}" section — release notes cannot be baked.`);
  process.exit(1);
}

const payload = {
  version,
  date: section.date,
  entries: parseEntries(section.body),
};
const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (current !== json) {
    console.error('extension/whatsnew.json is stale — run: node scripts/make-whatsnew.js');
    process.exit(1);
  }
  console.log(`whatsnew OK (v${version}, ${payload.entries.length} entries)`);
} else {
  fs.writeFileSync(OUT, json);
  console.log(`wrote extension/whatsnew.json (v${version}, ${payload.entries.length} entries)`);
}
