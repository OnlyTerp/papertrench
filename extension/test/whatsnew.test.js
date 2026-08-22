/* "What's new", once per version.
 *
 * An unpacked install has no update channel and no store listing, so someone
 * who replaces the folder has nowhere to learn what they just got. The notes
 * are baked into the build rather than fetched: the extension does not call
 * home to read its own release notes, and a baked file is true of the build
 * actually running rather than of whatever is newest on GitHub.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const notes = JSON.parse(fs.readFileSync(path.join(ROOT, 'whatsnew.json'), 'utf8'));

function fn() {
  const start = dashJs.indexOf('async function renderWhatsNew(');
  assert.ok(start !== -1, 'renderWhatsNew must exist');
  return dashJs.slice(start, dashJs.indexOf('\n}', start) + 2);
}

test('the baked notes describe the version that is actually shipping', () => {
  assert.equal(notes.version, manifest.version,
    'whatsnew.json must be regenerated whenever the manifest version moves');
  assert.ok(Array.isArray(notes.entries) && notes.entries.length,
    'a release with no notes tells the user nothing');
});

test('whatsnew.json is exactly what CHANGELOG.md says — no hand edits', () => {
  // It is generated, so it can drift the moment someone edits either side.
  execFileSync(process.execPath,
    [path.join(REPO, 'scripts', 'make-whatsnew.js'), '--check'],
    { cwd: REPO, encoding: 'utf8' });
});

test('the notes are read from the build, never from the network', () => {
  const body = fn();
  assert.match(body, /chrome\.runtime\.getURL\('whatsnew\.json'\)/,
    'the notes must come from the packaged file');
  for (const banned of ['api.github.com', 'https://papertrench-api', 'releases/latest']) {
    assert.ok(!body.includes(banned), `what's-new must not reach for ${banned}`);
  }
});

test('a first install is not treated as an update', () => {
  // Opening a brand-new dashboard to a changelog for a version you have never
  // not had is noise, not news.
  const body = fn();
  assert.match(body, /if \(!seen\)/, 'an unseen-version marker means first run');
  assert.match(body, /pt_whatsnew_seen: version/, 'and is recorded silently');
});

test('it shows once, and only after the version actually changes', () => {
  const body = fn();
  assert.match(body, /if \(seen === version\) return;/,
    'the same version must never show twice');
});

test('acknowledgement happens on close, not on show', () => {
  // A dashboard opened and abandoned should still get one chance to be read.
  const body = fn();
  const showAt = body.indexOf('document.body.appendChild(wrap)');
  const markAt = body.indexOf('const close =');
  assert.ok(showAt !== -1 && markAt > showAt,
    'the seen-marker write must live in the close handler, after the render');
});

test('a stale or mismatched notes file says nothing rather than the wrong thing', () => {
  const body = fn();
  assert.match(body, /notes\.version !== version/,
    'notes baked for another version must not be shown as this one');
});

test('applicant-facing text is escaped', () => {
  // The notes come from CHANGELOG.md, which is ours — but it is markdown full
  // of quotes and angle brackets, and this renders through innerHTML.
  const body = fn();
  assert.match(body, /esc\(e\.title\)/, 'titles must be escaped');
  assert.match(body, /esc\(e\.text\)/, 'and so must bodies');
});

test('the dialog can be dismissed by every route a user will try', () => {
  const body = fn();
  assert.match(body, /#wn-close/, 'the × closes it');
  assert.match(body, /#wn-done/, 'the button closes it');
  assert.match(body, /e\.target === wrap/, 'clicking the backdrop closes it');
  assert.match(body, /'Escape'/, 'Escape closes it');
});
