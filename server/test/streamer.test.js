/* Streamer applications are the first thing in this product that takes
 * personal contact details from people who are not users, and the first form
 * whose output a moderator reads in a browser. So every test here is an attack
 * on one of those two seams: get a script into the mod page, forge an answer
 * the form could not have produced, publish something the applicant wrote in
 * private, or reach the queue without being a moderator.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../core/streamer.js');
const { HATE_CODE } = require('../core/clan.js');

/** A minimal application that passes, so each test changes exactly one thing. */
const VALID = Object.freeze({
  name: 'ProfitableDegen',
  channelUrl: 'https://twitch.tv/ProfitableDegen',
  discord: 'degen',
  viewers: S.VIEWER_BUCKETS[1],
});
const withField = (patch) => Object.assign({}, VALID, patch);

test('the baseline application is accepted — otherwise every test below is vacuous', () => {
  assert.equal(S.applyProblem(VALID), null);
});

/* ---------------------------------------------------------------- the href */

test('a channel URL cannot carry a scheme that executes when a moderator clicks it', () => {
  // These strings become href on the mod page. The rejection has to happen
  // here, at the door, so no downstream renderer has to remember.
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(
      S.applyProblem(withField({ channelUrl: hostile })), 'channel-url-invalid',
      `${hostile} must not survive validation`);
    assert.equal(S.safeUrl(hostile, 200), null);
  }
});

test('the same scheme check guards the optional contact link', () => {
  // A second URL field is a second door; it was not obvious it had a lock.
  assert.equal(
    S.applyProblem(withField({ contactLink: 'javascript:alert(1)' })),
    'contact-link-invalid');
  // ...but leaving it blank is still fine, because it is optional.
  assert.equal(S.applyProblem(withField({ contactLink: '' })), null);
});

test('a bare host is assumed https rather than failed, and comes back normalized', () => {
  const url = S.safeUrl('twitch.tv/SomeName', 200);
  assert.equal(new URL(url).protocol, 'https:');
  assert.equal(new URL(url).hostname, 'twitch.tv');
});

test('a string with no dot in the host is not a channel', () => {
  assert.equal(S.safeUrl('notaurl', 200), null);
  assert.equal(S.safeUrl('https://localhost/x', 200), null);
});

/* ------------------------------------------------------------ closed sets */

test('viewer counts outside the form’s own dropdown are refused', () => {
  // Every accepted value is one the form can actually emit...
  for (const bucket of S.VIEWER_BUCKETS) {
    assert.equal(S.applyProblem(withField({ viewers: bucket })), null);
  }
  // ...and anything else did not come from our form.
  for (const forged of ['1000000', '', 'lots', '1-10', null]) {
    assert.equal(S.applyProblem(withField({ viewers: forged })), 'viewers-invalid');
  }
});

test('contact method is optional, but a present one must be from the dropdown', () => {
  for (const method of S.CONTACT_METHODS) {
    assert.equal(S.applyProblem(withField({ contactMethod: method })), null);
  }
  assert.equal(S.applyProblem(withField({ contactMethod: '' })), null);
  assert.equal(
    S.applyProblem(withField({ contactMethod: 'Carrier pigeon' })),
    'contact-method-invalid');
});

/* ------------------------------------------------------- invisible input */

test('invisible characters cannot make two names look identical', () => {
  // A zero-width space between letters renders as nothing, so "Deg<ZWSP>en"
  // and "Degen" are one name to a reader and two rows to a database.
  assert.equal(S.clean('Deg​en', 40), 'Degen');
  assert.equal(S.clean('﻿Degen', 40), 'Degen');
  assert.equal(S.clean('Deg‮en', 40), 'Degen');
});

test('a newline inside a single-line field becomes a space, not nothing', () => {
  // Deleting it outright welds two words together and silently changes the
  // name the applicant typed.
  assert.equal(S.clean('First\nLast', 40), 'First Last');
  assert.equal(S.clean('First\tLast', 40), 'First Last');
});

test('the notes field keeps its paragraphs but not a runaway of them', () => {
  assert.equal(S.cleanMultiline('a\n\n\n\n\nb', 100), 'a\n\nb');
  assert.equal(S.cleanMultiline('a b', 100), 'a\nb');
  assert.equal(S.cleanMultiline('  padded  ', 100), 'padded');
});

test('every field is capped at its declared limit', () => {
  const long = 'x'.repeat(5000);
  const app = S.normalizeApplication(withField({
    name: long, discord: long, blurb: long, notes: long, bestTime: long,
  }));
  assert.equal(app.name.length, S.LIMITS.name);
  assert.equal(app.discord.length, S.LIMITS.discord);
  assert.equal(app.blurb.length, S.LIMITS.blurb);
  assert.equal(app.notes.length, S.LIMITS.notes);
  assert.equal(app.bestTime.length, S.LIMITS.bestTime);
});

test('a name that is only whitespace is not a name', () => {
  for (const empty of ['', '   ', '\n\n', '​​', null, undefined]) {
    assert.equal(S.applyProblem(withField({ name: empty })), 'name-required');
  }
});

/* ------------------------------------------- what is public vs. what is not */

test('the two fields that get published face the content rule; the private one does not', () => {
  // name and blurb become a roster card on papertrench.com...
  assert.equal(S.applyProblem(withField({ name: `Stream ${HATE_CODE}` })), 'name-blocked');
  assert.equal(S.applyProblem(withField({ blurb: `gm ${HATE_CODE}` })), 'blurb-blocked');

  // ...notes is a message to the moderators, who are the ones deciding. It is
  // never published, so it is not filtered — if that ever stops being true,
  // this assertion is the thing that should fail first.
  assert.equal(S.applyProblem(withField({ notes: `gm ${HATE_CODE}` })), null);
});

test('notes and blurb are separate fields, so one cannot leak as the other', () => {
  // The roster serves `blurb`; the mod queue serves both. If normalization
  // ever folded notes into blurb, an applicant's private message would ship
  // to the public page the moment a moderator approved them.
  const app = S.normalizeApplication(withField({
    blurb: 'Daily challenge runs',
    notes: 'Please do not publish: my real name is redacted and I am 15.',
  }));
  assert.equal(app.blurb, 'Daily challenge runs');
  assert.notEqual(app.blurb, app.notes);
  assert.ok(!app.blurb.includes('redacted'));
});

/* ------------------------------------------------------------ twitch logins */

test('only Twitch URLs yield an embeddable login', () => {
  assert.equal(S.twitchLogin('https://twitch.tv/SomeName'), 'somename');
  assert.equal(S.twitchLogin('https://www.twitch.tv/SomeName?x=1'), 'somename');
  // Valid applications, but nothing the page can put in a Twitch player.
  assert.equal(S.twitchLogin('https://youtube.com/@someone'), null);
  assert.equal(S.twitchLogin('https://kick.com/someone'), null);
});

test('a login that is not a login is dropped, never salvaged', () => {
  // Same rule as normalizeLogin() in site/streams.js: if the two disagree,
  // the roster and the player disagree about who a card points at.
  assert.equal(S.twitchLogin('https://twitch.tv/ab'), null);        // too short
  assert.equal(S.twitchLogin('https://twitch.tv/' + 'a'.repeat(26)), null);
  assert.equal(S.twitchLogin('https://twitch.tv/has spaces'), null);
  assert.equal(S.twitchLogin('https://twitch.tv/'), null);
});

test('platform labels follow the host, not the text of the URL', () => {
  assert.equal(S.platformOf('https://twitch.tv/x'), 'twitch');
  assert.equal(S.platformOf('https://m.twitch.tv/x'), 'twitch');
  assert.equal(S.platformOf('https://youtu.be/x'), 'youtube');
  assert.equal(S.platformOf('https://kick.com/x'), 'kick');
  assert.equal(S.platformOf('https://example.com/twitch.tv'), 'other');
  assert.equal(S.platformOf('not a url'), 'other');
});

/* ------------------------------------------------------------- the mod gate */

test('an empty or missing allowlist authorises nobody', () => {
  // A deploy that forgets ADMIN_X_IDS must close the queue, not open it to
  // every signed-in visitor.
  for (const list of ['', '   ', null, undefined]) {
    assert.equal(S.isAdmin('123', list), false);
  }
});

test('moderator identity is matched whole, never as a prefix', () => {
  assert.equal(S.isAdmin('123', '123'), true);
  assert.equal(S.isAdmin('123', '123,456'), true);
  assert.equal(S.isAdmin('456', '123, 456'), true);
  assert.equal(S.isAdmin('123', '123456'), false);   // not a prefix
  assert.equal(S.isAdmin('12', '123'), false);       // not a substring
  assert.equal(S.isAdmin('', '123'), false);         // absent id is not a match
  assert.equal(S.isAdmin(null, '123'), false);
});

test('the allowlist tolerates the spellings a human will actually write', () => {
  const list = ' 111 , 222,333\n444 ';
  for (const id of ['111', '222', '333', '444']) assert.equal(S.isAdmin(id, list), true);
  assert.equal(S.isAdmin('555', list), false);
});

/* ------------------------------------------------- the page/server contract */

/* The form's dropdowns and this module's closed sets are the same list written
 * twice, in two files, in two languages. Nothing but this test connects them.
 *
 * The failure it exists for is silent and total: the buckets are spelled with
 * an EN DASH (U+2013), and a hyphen typed into the HTML looks identical in an
 * editor, in a diff, and in a browser. Every application would then fail
 * `viewers-invalid` on a value the applicant picked from our own menu, and the
 * form would reject everyone with a message about a field they cannot fix.
 */
const FORM_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', 'site', 'streamer-signup.html'), 'utf8');

/** The <option> texts of one named <select> in the signup form. */
function optionsOf(selectName) {
  const select = new RegExp(
    `<select[^>]*name="${selectName}"[^>]*>([\\s\\S]*?)</select>`).exec(FORM_HTML);
  assert.ok(select, `the form has no <select name="${selectName}">`);
  return [...select[1].matchAll(/<option(?![^>]*\b(?:disabled|value=""))[^>]*>([^<]*)<\/option>/g)]
    .map((m) => m[1].trim());
}

test('the viewer dropdown offers exactly the buckets the server accepts', () => {
  assert.deepEqual(optionsOf('viewers'), S.VIEWER_BUCKETS);
});

test('the contact-method dropdown offers exactly the methods the server accepts', () => {
  assert.deepEqual(optionsOf('contactMethod'), S.CONTACT_METHODS);
});

test('every form field stops at the length the server would truncate it to', () => {
  // A maxlength longer than the server's cap silently eats the tail of what
  // someone typed; shorter, and the form refuses input the server would take.
  const attrs = Object.fromEntries(
    [...FORM_HTML.matchAll(/name="(\w+)"[^>]*maxlength="(\d+)"/g)].map((m) => [m[1], Number(m[2])]));
  for (const [field, cap] of Object.entries(S.LIMITS)) {
    assert.equal(attrs[field], cap, `maxlength for ${field} must match LIMITS.${field}`);
  }
});

test('review statuses are a closed set, and pending is one of them', () => {
  // 'pending' has to be assignable: it is how a moderator undoes a decision.
  for (const status of ['pending', 'approved', 'rejected']) {
    assert.equal(S.isStatus(status), true);
  }
  for (const bogus of ['deleted', 'APPROVED', '', null, 'approved; DROP TABLE']) {
    assert.equal(S.isStatus(bogus), false);
  }
});

/* -------------------------------------------------- post-merge hardening */

test('an over-long URL is rejected whole, never stored as a broken prefix', () => {
  // Review nit fixed post-merge: safeUrl used to slice AFTER validation, and
  // worse, clean() pre-truncated before parsing — so an over-limit URL sailed
  // through as a valid-looking prefix pointing somewhere the applicant never
  // sent. Now the full string is validated and length is judged once, on the
  // normalized result.
  const at = 'https://twitch.tv/' + 'a'.repeat(180);   // exactly 200 raw
  const norm = S.safeUrl(at, 200);
  assert.ok(norm && norm.startsWith('https://twitch.tv/aaaa'), 'at-limit URL survives');
  assert.ok(norm.length <= 200, 'normalized form respects the cap');
  const over = 'https://twitch.tv/' + 'a'.repeat(200); // 219
  assert.equal(S.safeUrl(over, 200), null);
  // Whitespace around an over-limit URL must not mask the length: the padding
  // is stripped before judging, so this is still over.
  assert.equal(S.safeUrl('  ' + over + '  ', 200), null);
});
