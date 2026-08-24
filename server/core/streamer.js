/* Streamer applications — validation and normalization, pure.
 *
 * This replaces the Google Form + approval-sheet pipeline documented in
 * docs/STREAMS.md. The rules live here rather than in the Worker so the
 * suite can attack them without D1 or a fetch, same as every other core
 * module.
 *
 * An approved application becomes a public roster card on the streams page,
 * so the fields that surface there are held to the same content rule as clan
 * names — the mod queue is a human gate, not a reason to skip the machine one.
 */
'use strict';

const { blockedContent } = require('./clan.js');

// Dropdowns are closed sets: an answer outside them did not come from our
// form, so it is a bug or a forgery either way. Stored verbatim as shown.
const VIEWER_BUCKETS = ['1–10', '10–50', '50–100', '100+'];
const CONTACT_METHODS = ['Discord DM', 'Email', 'Twitter/X', 'Other'];

const LIMITS = {
  name: 40,
  channelUrl: 200,
  discord: 40,
  blurb: 160,
  notes: 1000,
  contactLink: 200,
  bestTime: 100,
};

// Invisible characters that are NOT whitespace: C0 controls except tab/LF/CR,
// DEL, zero-width joiners and marks, the bidi overrides and isolates, and the
// BOM. Written as escapes rather than literals so the intent survives an
// editor that renders them as nothing.
//
// The bidi range (U+202A–U+202E, U+2066–U+2069) is the one that matters most
// here. U+202E reverses everything after it, so a stored name and the name a
// moderator reads on screen can be different strings — the trick that makes
// "exe.txt" out of "txt.exe". These names render on a public roster card and
// in the mod queue, and a moderator approving what they see must be approving
// what is stored.
//
// Whitespace is deliberately left in for the caller to collapse. Deleting a
// newline outright would weld two words into one ("First\nLast" -> "FirstLast");
// collapsing it to a space keeps what the applicant meant.
const STRIP_INVISIBLE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F'
  + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]', 'g');

const trim = (v) => String(v == null ? '' : v).trim();

/**
 * Collapse whitespace and strip invisible characters.
 *
 * Applications are typed by hand and pasted from Discord, so they arrive with
 * newlines inside single-line fields and the occasional zero-width character
 * carried in from a nickname. Both render as something other than what the
 * applicant sees in the box, and one of these fields ends up on a public card.
 */
function clean(value, max) {
  return trim(value)
    .replace(STRIP_INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Same as clean() but keeps paragraph breaks — the notes field is a textarea. */
function cleanMultiline(value, max) {
  return trim(value)
    .replace(STRIP_INVISIBLE, '')
    // U+2028 / U+2029 are line separators the browser renders as breaks; fold
    // them into real newlines rather than leaving two spellings in the data.
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/**
 * A URL we are willing to store and later render as a link.
 *
 * Returns the normalized href, or null. The scheme allowlist is the point:
 * these strings become `href` on the mod page, and `javascript:` in an href
 * is a click away from running in a moderator's session. Rejecting at the
 * door means no downstream renderer has to remember.
 */
function safeUrl(raw, max) {
  // Validate the FULL string, never a pre-truncated copy: clean() would slice
  // it to `max` before parsing, so an over-long URL would sail through as a
  // valid-looking broken prefix. Length is judged once, at the end, on the
  // normalized result.
  let text = trim(raw).replace(STRIP_INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // A bare "twitch.tv/name" is what people actually type; assume https rather
  // than failing them for it.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.')) return null;
  // Reject over-length rather than truncating: a sliced URL stores a
  // valid-looking prefix that points somewhere the applicant never sent us.
  if (url.toString().length > max) return null;
  return url.toString();
}

/* The contact answer is not always a URL.
 *
 * The form asks "how should we reach you?" and relabels itself per method:
 * Email wants an address, Twitter/X wants a profile link, and Other wants
 * whatever the applicant actually uses ("Telegram @me"). Demanding a parseable
 * URL for all three refused two of them — an applicant who picked Other and
 * answered the question honestly got `contact-link-invalid` and no way to
 * proceed.
 *
 * So the rule is about what we are willing to RENDER, not about shape: an
 * answer carrying an explicit scheme has to be one we would put in an href,
 * because that is the string a moderator clicks. Everything else is stored as
 * text and rendered as text — site/admin.js only builds an <a> when the value
 * re-parses as http(s), so a plain answer can never become a live link.
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a contact answer is unusable, or null. */
function contactProblem(raw) {
  const text = trim(raw);
  if (!text) return null;
  // Whitespace settles it: no URL contains a raw space, so "IG: someone" is
  // prose, not a scheme claim. Checking the scheme first would read the "IG:"
  // as one and refuse a perfectly good answer.
  if (/\s/.test(text)) return null;
  // An explicit scheme IS a claim to be a link; hold it to the href rule.
  // Validate the untruncated original so an over-long URL still fails.
  if (HAS_SCHEME.test(text) && !safeUrl(raw, LIMITS.contactLink)) return 'contact-link-invalid';
  return null;
}

/** The contact answer to store: a normalized URL when it is one, else text. */
function contactAnswer(raw) {
  const text = clean(raw, LIMITS.contactLink);
  if (!text) return null;
  // An address is an address. Left alone, safeUrl would turn it into
  // "https://you@example.com/" — a userinfo URL pointing at a host nobody meant.
  if (LOOKS_LIKE_EMAIL.test(text)) return text;
  if (/\s/.test(text)) return text;                       // free-text answer
  return safeUrl(raw, LIMITS.contactLink) || text;
}

/** Which platform a channel URL points at — a label for the mod queue. */
function platformOf(channelUrl) {
  let host = '';
  try {
    host = new URL(channelUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return 'other'; }
  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'twitch';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'kick.com' || host.endsWith('.kick.com')) return 'kick';
  return 'other';
}

/**
 * The Twitch login inside a channel URL, or null.
 *
 * Only Twitch gets a login because only Twitch is embeddable on the streams
 * page — a YouTube or Kick application is still valid, it just cannot become
 * a player card. Deliberately the same rules as normalizeLogin() in
 * site/streams.js: 3–25 chars of [a-z0-9_], nothing salvaged.
 */
function twitchLogin(channelUrl) {
  if (platformOf(channelUrl) !== 'twitch') return null;
  let path = '';
  try { path = new URL(channelUrl).pathname; } catch { return null; }
  const first = path.split('/').filter(Boolean)[0];
  if (!first) return null;
  const lower = first.toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(lower) ? lower : null;
}

/**
 * Why this application cannot be accepted, or null when it can.
 *
 * Reason codes, not sentences: the page owns the wording, and the tests
 * assert on something that does not move when the copy is edited.
 */
function applyProblem(fields) {
  const f = fields || {};
  const name = clean(f.name, LIMITS.name);
  if (name.length < 2) return 'name-required';
  // The creator name is what a public roster card is titled with.
  if (blockedContent(name)) return 'name-blocked';

  if (!safeUrl(f.channelUrl, LIMITS.channelUrl)) return 'channel-url-invalid';

  const discord = clean(f.discord, LIMITS.discord);
  if (discord.length < 2) return 'discord-required';

  if (!VIEWER_BUCKETS.includes(trim(f.viewers))) return 'viewers-invalid';

  // Optional from here down: absent is fine, present-and-wrong is not.

  // The blurb is the other field that becomes a public roster card, so it
  // faces the same content rule as the name. `notes` deliberately does not:
  // it is a private message to the mod queue and is never published.
  if (blockedContent(clean(f.blurb, LIMITS.blurb))) return 'blurb-blocked';

  const method = trim(f.contactMethod);
  if (method && !CONTACT_METHODS.includes(method)) return 'contact-method-invalid';

  const contact = contactProblem(f.contactLink);
  if (contact) return contact;
  return null;
}

/**
 * The row to store. Call only after applyProblem() returns null — it assumes
 * the shape is already legal and does not re-check.
 */
function normalizeApplication(fields) {
  const f = fields || {};
  const channelUrl = safeUrl(f.channelUrl, LIMITS.channelUrl);
  return {
    name: clean(f.name, LIMITS.name),
    channelUrl,
    platform: platformOf(channelUrl),
    twitchLogin: twitchLogin(channelUrl),
    discord: clean(f.discord, LIMITS.discord),
    viewers: trim(f.viewers),
    // blurb is published on approval; notes is mod-queue-only. Two fields,
    // because one field cannot be both consented-to-publish and confidential.
    blurb: clean(f.blurb, LIMITS.blurb),
    notes: cleanMultiline(f.notes, LIMITS.notes),
    contactMethod: trim(f.contactMethod) || null,
    contactLink: contactAnswer(f.contactLink),
    bestTime: clean(f.bestTime, LIMITS.bestTime),
  };
}

const STATUSES = ['pending', 'approved', 'rejected'];
const isStatus = (s) => STATUSES.includes(trim(s));

/**
 * Is this X user id a moderator?
 *
 * Matched on x_id, never on handle: schema.sql calls x_id "immutable X user
 * id; handles can change", and a handle that changes is a handle someone else
 * can register. Allowlisting @somemod would hand the mod queue to whoever
 * claims that name after they drop it.
 */
function isAdmin(xId, allowlist) {
  const id = trim(xId);
  if (!id) return false;
  return String(allowlist || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .includes(id);
}

module.exports = {
  VIEWER_BUCKETS,
  CONTACT_METHODS,
  LIMITS,
  STATUSES,
  clean,
  cleanMultiline,
  safeUrl,
  contactProblem,
  contactAnswer,
  platformOf,
  twitchLogin,
  applyProblem,
  normalizeApplication,
  isStatus,
  isAdmin,
};
