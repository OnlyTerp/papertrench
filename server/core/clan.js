/* PaperTrench server — clans.
 *
 * A clan stores NO results. That is the whole design, and everything below is
 * downstream of it.
 *
 * `clan_members.joined_at` is the only new fact a clan introduces into the
 * system. Its entire job is to BOUND what an already-committed chain
 * contributes: a clan sees the slice of your chain that falls after you joined
 * it, and nothing before. So joining a clan cannot import a back catalogue of
 * wins, leaving and rejoining cannot launder a bad week, and there is no clan
 * book to forge because a clan never has a book — it has an aggregate of the
 * same window slices the Sprint and duels already compute (window.js).
 *
 * Two rules follow from that and are enforced here rather than at the call
 * site, because a rule that lives in a handler is a rule the next handler
 * forgets:
 *
 *   1. A member who was not in the clan for ANY of a window contributes
 *      `null`, not a zeroed entry. Zero says "was here, did nothing"; null
 *      says "was not here". Storing the first for the second is a fabricated
 *      number, which this project does not do.
 *
 *   2. A clan ranks on its COUNTING_MEMBERS best qualified members, not on its
 *      roster average and not on its total. A total rewards recruiting; an
 *      average punishes a clan for carrying a beginner. Top-N does neither,
 *      and it means a fifty-person clan and a five-person clan are ranked on
 *      the same quantity.
 */
'use strict';

const { windowEntry } = require('./window.js');

/** Season = all of time. A clan's season slice is bounded by joined_at alone. */
const SEASON_WINDOW = { startTs: 0, endTs: Number.MAX_SAFE_INTEGER };

/** Roster cap. Large enough for a real community, small enough that the top-N
 * scoring rule still means something. */
const MAX_MEMBERS = 50;

/** How many members make up a clan's score. */
const COUNTING_MEMBERS = 5;

/** Closed rounds a member needs in a window before they can be one of the
 * counting five. Without a floor, a clan could field five accounts with one
 * lucky round each and outrank a clan that actually traded. */
const MIN_SEASON_ROUNDS = 10;
const MIN_WEEK_ROUNDS = 3;

const TAG_MIN = 2;
const TAG_MAX = 5;
const NAME_MIN = 3;
const NAME_MAX = 32;
const MOTTO_MAX = 80;

/* ---------------- naming ---------------- */

/** Tags are uppercase A-Z0-9, and that is the whole alphabet — a tag is read
 * aloud on streams and retyped from screenshots. */
function normalizeTag(tag) {
  return String(tag == null ? '' : tag).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, TAG_MAX);
}

/** Names keep their spacing and case for display; only the edges are trimmed
 * and runs of whitespace collapsed. */
function normalizeName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * The uniqueness key for a name.
 *
 * Case, spacing and punctuation are folded away, and the handful of glyphs
 * that exist to look like other glyphs are folded with them. "Trench Rats",
 * "trenchrats" and "TrenchR4ts" are the same name for the purpose of taking
 * it. This is impersonation defence, not tidiness: a clan tag and name are
 * immutable after creation precisely so a roster cannot be collected under one
 * identity and then renamed into another one, and that guarantee is worth
 * nothing if a confusable name was available in the first place.
 */
const CONFUSABLE = { 0: 'O', 1: 'I', 3: 'E', 4: 'A', 5: 'S', 7: 'T', 8: 'B' };

function nameKey(name) {
  return normalizeName(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/[0134578]/g, (char) => CONFUSABLE[char] || char);
}

/** Invite codes are matched case- and separator-insensitively, because they
 * arrive pasted out of chat clients that helpfully "fix" them. */
function normalizeCode(code) {
  const text = String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return text ? 'CLAN-' + text.replace(/^CLAN/, '') : '';
}

/** Mottos are display-only and never interpolated as markup by the server, but
 * control characters are stripped so nobody can smuggle layout — or a second
 * apparent line — into a roster listing. */
function cleanMotto(motto) {
  return String(motto == null ? '' : motto)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MOTTO_MAX);
}

/* ---------------- validation ---------------- */

/** Why a motto is refused, or null. */
function mottoProblem(motto) {
  if (motto == null || motto === '') return null;
  if (typeof motto !== 'string') return 'motto-invalid';
  // Generous relative to MOTTO_MAX, which truncates rather than refuses: this
  // rejects only a payload that is obviously not a motto.
  if (motto.length > MOTTO_MAX * 4) return 'motto-too-long';
  return null;
}

/** Why a clan may not be created, or null when it may. */
function createProblem(input) {
  const request = input || {};
  if (request.alreadyInClan) return 'already-in-a-clan';
  const raw = String(request.tag == null ? '' : request.tag).replace(/\s/g, '');
  if (raw.length > TAG_MAX) return 'tag-too-long';
  const tag = normalizeTag(request.tag);
  if (tag.length < TAG_MIN) return 'tag-too-short';
  const name = normalizeName(request.name);
  if (name.length < NAME_MIN) return 'name-too-short';
  // A name that folds to nothing is punctuation wearing a name's clothes.
  if (!nameKey(name)) return 'name-invalid';
  return mottoProblem(request.motto);
}

/**
 * Why a join is refused, or null when it may proceed.
 *
 * `clan` is { open, joinCode } or null when no clan matched. `size` is the
 * current roster count. The caller passes the RAW code the user typed so that
 * "you gave a code and it was wrong" is distinguishable from "you gave no code
 * to a clan that requires one" — two different things to tell a person.
 */
function joinProblem(clan, size, context) {
  const ctx = context || {};
  if (ctx.alreadyInClan) return 'already-in-a-clan';
  if (!clan) return 'not-found';
  if (Number(size) >= MAX_MEMBERS) return 'clan-full';
  if (!clan.open) {
    const given = normalizeCode(ctx.code);
    if (!given) return 'invite-only';
    if (given !== normalizeCode(clan.joinCode)) return 'bad-code';
  }
  return null;
}

/** Why a kick is refused, or null. Only the founder may kick, and never
 * themselves — leaving is a different action with different consequences for
 * the clan (see `successor`). */
function kickProblem(clan, actorId, targetId) {
  if (Number((clan || {}).founderId) !== Number(actorId)) return 'not-founder';
  if (Number(actorId) === Number(targetId)) return 'cannot-kick-yourself';
  return null;
}

/**
 * Who inherits a clan when `leavingUserId` goes.
 *
 * The longest-standing remaining member, which is the only ordering that needs
 * no judgement call and cannot be gamed by the departing founder. Returns null
 * when nobody is left — the caller disbands rather than leaving an ownerless
 * shell holding a name nobody can reclaim.
 */
function successor(members, leavingUserId) {
  const remaining = (Array.isArray(members) ? members : [])
    .filter((m) => Number(m.userId) !== Number(leavingUserId))
    .sort((a, b) => (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0));
  return remaining.length ? remaining[0] : null;
}

/* ---------------- contribution ---------------- */

/**
 * One member's contribution to their clan over one window.
 *
 * The window is intersected with "since you joined". A member who joined
 * halfway through a week contributes the second half of that week and nothing
 * before it, and a member who joined after the window closed contributes
 * `null` — see rule 1 in the header. Returning null is load-bearing: the
 * caller must not write a row, because a zeroed row would claim they were
 * present and idle.
 */
function memberEntry(chain, startingSol, joinedAt, window) {
  const joined = Math.trunc(Number(joinedAt) || 0);
  const start = Math.max(Number(window.startTs) || 0, joined);
  const end = Number(window.endTs) || 0;
  if (start >= end) return null;
  return Object.assign(
    windowEntry(chain, startingSol, { startTs: start, endTs: end }),
    { joinedAt: joined, countsFrom: start });
}

/**
 * A clan's standing over one window, from its members' entries.
 *
 * `members` is [{ handle, avatarUrl, status, joinedAt, entry }]; entry may be
 * null (never in the window) or an entry with zero rounds (present, idle).
 *
 * A clan ranks only once COUNTING_MEMBERS members clear `minRounds`. Until
 * then it is unranked with a `needed` count, rather than being given a score
 * computed from two people and presented next to clans of five — an
 * apples-to-oranges number is worse than an honest absence of one.
 */
function standing(members, options) {
  const list = Array.isArray(members) ? members : [];
  const minRounds = Number((options || {}).minRounds) || 0;

  const present = list.filter((m) => m.entry);
  const active = present.filter((m) => Number(m.entry.rounds) > 0);
  const qualified = present
    .filter((m) => Number(m.entry.rounds) >= minRounds)
    .sort((a, b) => Number(b.entry.score) - Number(a.entry.score));

  const counting = qualified.slice(0, COUNTING_MEMBERS);
  const ranked = counting.length >= COUNTING_MEMBERS;

  // Totals describe the WHOLE clan and are always honest to report; the score
  // describes only the counting five. They are deliberately different numbers,
  // and the payload carries both so a page never has to imply one from the
  // other.
  let rounds = 0;
  let pnlSol = 0;
  for (const member of present) {
    rounds += Number(member.entry.rounds) || 0;
    pnlSol += Number(member.entry.pnlSol) || 0;
  }

  const score = ranked
    ? counting.reduce((sum, m) => sum + (Number(m.entry.score) || 0), 0) / counting.length
    : null;

  return {
    roster: list.length,
    active: active.length,
    qualified: qualified.length,
    needed: Math.max(0, COUNTING_MEMBERS - qualified.length),
    ranked,
    score,
    counting: counting.map((m) => ({
      handle: m.handle,
      avatarUrl: m.avatarUrl || null,
      status: m.status || 'pending',
      score: m.entry.score,
      rounds: m.entry.rounds,
      pnlSol: m.entry.pnlSol,
      roiPct: m.entry.roiPct,
    })),
    rounds,
    pnlSol,
  };
}

module.exports = {
  SEASON_WINDOW,
  MAX_MEMBERS, COUNTING_MEMBERS, MIN_SEASON_ROUNDS, MIN_WEEK_ROUNDS,
  TAG_MIN, TAG_MAX, NAME_MIN, NAME_MAX, MOTTO_MAX,
  normalizeTag, normalizeName, nameKey, normalizeCode, cleanMotto,
  mottoProblem, createProblem, joinProblem, kickProblem, successor,
  memberEntry, standing,
};
