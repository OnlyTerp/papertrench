/* PaperTrench server — clans.
 *
 * A clan is NOT a book. It is a question asked of records that already exist:
 * "how do these people's committed chains look, over this window, counted only
 * from the moment each of them joined?" Every number a clan shows is somebody's
 * window entry (window.js) — the same slice the Sprint and duels use — so there
 * is no clan-side ledger to inflate and nothing new to trust.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT MAKE THIS UNCHEATABLE
 *
 * 1. YOU BRING YOUR FUTURE, NOT YOUR PAST.
 *
 *    A member's contribution window starts at their join time. Rounds closed
 *    before they joined count for nothing here. Without this, the dominant
 *    strategy is obvious and fatal: recruit a strong trader for one day and
 *    their entire lifetime record lands on your board, then repeat before every
 *    weekly close. With it, a round counts for at most one clan — the one you
 *    were actually in when you closed it — and joining a clan the night before
 *    the bell contributes exactly nothing.
 *
 * 2. THE SCORE IS THE MEAN OF THE TOP FIVE, AND A CLAN NEEDS FIVE TO RANK.
 *
 *    Summing member scores makes this a recruiting contest: the biggest roster
 *    wins regardless of skill. Averaging the WHOLE roster is worse in a way
 *    that matters more — it charges a clan for every beginner it takes in, and
 *    a product that exists to give newcomers somewhere to practice must not
 *    make teaching them expensive. The mean of the top five does neither.
 *    Extra members are free, so recruit and teach all you like; one hero cannot
 *    carry a clan, because five people have to clear the bar.
 *
 *    It has a third property worth stating out loud, because it is the reason
 *    to prefer it over anything cleverer: CUTTING A STRUGGLING MEMBER CAN NEVER
 *    RAISE A CLAN'S SCORE. The top five is the top five whether or not the
 *    people below it are on the roster; expelling them can only cost the clan
 *    its roster minimum. There is no version of this board where kicking the
 *    worst trader is the winning move.
 *
 * The honest cost, stated rather than hidden: depth is a mild advantage. A
 * clan with thirty qualified members has more chances at five strong ones than
 * a clan with exactly five. That advantage has to be earned five verified
 * records at a time, which is the point.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { windowEntry } = require('./window.js');
const { MIN_RANKED_ROUNDS } = require('./ranking.js');

/** How many member scores make a clan's number. */
const COUNTING_MEMBERS = 5;

/**
 * Roster cap.
 *
 * Not an anti-cheat measure — the top-five mean already makes hoarding
 * pointless — but a roster page has to stay readable, and the depth advantage
 * above should not grow without bound.
 */
const MAX_MEMBERS = 50;

/** Rounds a member needs inside the window before they can be one of the five.
 * The season floor is the individual board's floor: five closed rounds is a
 * record, four is a sample. A week is short, so a single closed round counts
 * there — the same bar the individual Sprint board uses. */
const MIN_SEASON_ROUNDS = MIN_RANKED_ROUNDS;
const MIN_WEEK_ROUNDS = 1;

/** The largest timestamp a Date can hold — the season's open right edge. */
const SEASON_END_TS = 8640000000000000;
const SEASON_WINDOW = { startTs: 0, endTs: SEASON_END_TS };

/* ------------------------------------------------------------- identity -- */
/*
 * Clan names and tags are the only user-authored strings this product renders
 * next to verified numbers, so they are validated like input rather than
 * accepted like content: a narrow ASCII charset (no homoglyph or zero-width
 * impersonation of another clan), a normalised uniqueness key so "Trench Rats"
 * and "trenchrats" cannot both exist, and a short reserved list so nobody can
 * imply they speak for PaperTrench.
 */

const TAG_RE = /^[A-Z0-9]{2,5}$/;
const RESERVED_TAGS = new Set([
  'ADMIN', 'MOD', 'MODS', 'STAFF', 'TEAM', 'OWNER', 'PT', 'ARENA', 'NULL', 'NONE',
]);

const NAME_MIN = 3;
const NAME_MAX = 24;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'&!-]*[A-Za-z0-9.!]$/;
const RESERVED_NAME_KEYS = ['papertrench'];

const MOTTO_MAX = 120;
const MOTTO_RE = /^[A-Za-z0-9 .,!?'"&:;()\/-]*$/;

/* ----------------------------------------------------------- moderation -- */
/*
 * THE NARROWEST FILTER THAT STILL MEANS SOMETHING.
 *
 * Scope, set deliberately: slurs and sexualised-minor terms. Nothing else.
 * Profanity is allowed. Crude sexual humour is allowed. Drug references,
 * nihilism, hostility to regulators, exchanges, whales and each other are all
 * allowed. "Provocative" is the register this product is written in, and a
 * filter that sanded that off would be a worse failure than one that let a
 * rude clan name through.
 *
 * WHY TOKENS, NOT SUBSTRINGS. `nameKey()` strips every separator, so matching
 * blocked terms as substrings of it manufactures collisions nobody typed:
 * "Chin Kickers" collapses to "chinkickers", "Flame Retardant" contains the
 * ableist term, "Spicy Gains" contains an ethnic one. A design that matched
 * the collapsed key was measured against a corpus of 50 legitimate names and
 * rejected between 10 and 23 of them. So matching happens on TOKENS — a
 * blocked term must BE a word here, not merely hide inside one — with one
 * closed set of suffixes so plurals cannot walk through.
 *
 * Substring matching survives for exactly one tier: terms with no innocent
 * host word in English, listed individually and audited by hand. It is not a
 * length heuristic; it is a list, and it is short on purpose.
 *
 * WHAT THIS DOES NOT DO. It does not detect intent, sentiment, or a slur
 * spelled in a way nobody has thought of yet. It is a floor, not a guarantee,
 * and the maintainer's ability to delete a clan is the real backstop. Saying
 * so here is cheaper than implying a coverage nobody has.
 */

/** Blocked as whole tokens (plus SUFFIXES below). Every entry is a term with
 * no ordinary use as a standalone word in this product's register. */
const BLOCKED_TOKENS = new Set([
  // Racial and ethnic.
  'nigga', 'niggas', 'niggaz', 'nigg', 'nigar', 'nigars', 'nlgar', 'nlgaar',
  'n1gar', 'nlgga', 'n1gga', 'coon', 'spic', 'wetback', 'chink',
  'gook', 'kike', 'kaffir', 'paki', 'raghead', 'towelhead', 'beaner',
  'gyppo', 'pikey', 'wog', 'darkie', 'squaw', 'zipperhead', 'slopehead',
  // Homophobic and transphobic. The anti-lesbian term is deliberately ABSENT:
  // it is an ordinary English noun (an embankment), a common surname, and
  // heavily reclaimed — "Van Dyke Traders" was a measured false positive. It is
  // the one entry whose cost exceeded its value under a minimum-moderation
  // mandate, and it is left out as a decision rather than an oversight.
  'faggot', 'fag', 'tranny', 'shemale',
  // Ableist. 'mong' is deliberately absent: it makes "fear monger" and "war
  // mongers" collide through the suffix rule, and it is the mildest term here.
  'retard', 'retarded', 'tard', 'spastic', 'spaz', 'spazz', 'mongoloid',
  'jap', 'wop', 'dago', 'jigaboo', 'nggr',
  // Sexualised minors — the one category the mandate names outright, so
  // completeness here is cheap and worth having. 'cp' is absent: two letters,
  // and a legitimate abbreviation for half a dozen things.
  'pedo', 'paedo', 'pedophile', 'paedophile', 'pedobear', 'hebephile',
  'loli', 'lolicon', 'shota', 'shotacon', 'jailbait',
  // Explicit hate-group signalling. The bare 2-digit component is NOT here:
  // it is an ordinary number, and blocking it would be pure over-blocking.
  // The 4-digit code is handled by HATE_CODE, not here — see the note there.
  'heilhitler', 'siegheil',
]);

/**
 * Blocked anywhere, even inside a longer word.
 *
 * Reserved for terms whose only English hosts are listed in ALLOWED_SUBSTRINGS
 * below. Each one earns its place individually — this is the tier that produces
 * false positives, so it stays at the size where every entry can be argued for
 * out loud. Substring matching is what catches the compounds ("…naut", "…ry",
 * "…tron") that no closed suffix set can, and the space-splits that tokens miss.
 *
 * 'nigar' is the single-g respelling of the first entry: not a word in any
 * register, and the spelling that carried a slur clan onto the live board
 * (2026-08-09) because the list held only the standard spellings. It sits in
 * both tiers for the same reason 'nigga' does — the token tier refuses it as a
 * whole word, the substring tier refuses the compounds and space-splits.
 */
const BLOCKED_SUBSTRINGS = [
  'nigger', 'nigga', 'nigar', 'faggot', 'childporn', 'childrape',
];
