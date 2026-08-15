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

/**
 * The innocent hosts, removed from the key before the substring test runs.
 *
 * The tier above was first written claiming its entries had "no innocent host
 * in English". A scan of all 104,334 words in the system dictionary proved that
 * false: snigger/sniggers/sniggered/sniggering and the niggard family are real
 * words, and "Snigger Squad" is a name a British trader would plausibly pick.
 * The claim is now enforced by carve-out rather than asserted by comment.
 *
 * One removal pass is deliberate and sufficient: "sniggernigger" still blocks,
 * because removing the host leaves the term behind.
 */
const ALLOWED_SUBSTRINGS = ['snigger', 'niggard'];

/**
 * The four-digit hate code, matched ONLY as a bare unseparated word.
 *
 * It lived in the token list until a red team pointed out that tokenize()
 * strips the separators inside a word, so "14.88" — a price — became the token
 * 1488 and got a motto refused. On a product whose entire pitch is that its
 * numbers are true, refusing someone for typing a price is the worst-placed
 * false positive available. "1488 gang" still blocks; "Filled at 14.88",
 * "1,488 percent" and "Sharpe of 1.488" do not.
 */
const HATE_CODE = '1488';

/**
 * Tokens that pass even though the suffix rule would otherwise catch them.
 *
 * Each is a real word that happens to be a blocked term plus a suffix:
 * "spic"+y, "tard"+y. Without these the filter rejects "Spicy Gains", which
 * is exactly the kind of refusal that makes a product feel hostile.
 */
const ALLOWED_TOKENS = new Set([
  'spicy', 'spice', 'spices', 'spicier', 'spiced', 'spicer', 'spicers', 'spicing',
  'tardy', 'tardies',
  // The -ing/-er forms of the ableist term are machinery vocabulary (an engine
  // retarder, a retarding agent) and are not used as insults in any register.
  // Same decision already made for "retardant" by leaving 'ant' out of SUFFIXES.
  'retarding', 'retarder', 'retarders',
  // Jape is an ordinary word for a prank; it is the only English host of the
  // ethnic term above plus a suffix from the closed set.
  'jape', 'japes', 'japed', 'japing',
]);

/** Suffixes a blocked token may carry and still be the same word. Closed set:
 * anything longer is a different word ("retard" + "ant" is a fire retardant). */
const SUFFIXES = ['', 's', 'z', 'es', 'ed', 'er', 'ers', 'ing', 'y', 'ies'];

/**
 * Digits read as letters, and the option of reading them as nothing at all.
 *
 * Only digits: NAME_RE, MOTTO_RE and TAG_RE admit no `$` or `@`, so folding
 * those would be dead code. Deletion matters as much as substitution —
 * "n1gger" folds to the term, but "nig0ger" only reaches it by dropping the
 * digit, and both spellings are one keystroke apart for whoever is trying.
 */
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', 2: 'z' };
/** Bound on the per-digit and per-run expansions, so a token of nothing but
 * digits cannot make this explode. Six is far past any real spelling. */
const MAX_LEET_DIGITS = 6;
const MAX_RUNS = 6;
const MAX_READINGS = 4096;

/**
 * Every plausible reading of one token.
 *
 * Two expansions, and BOTH were wrong in the first version — a red team caught
 * each by running it rather than reading it.
 *
 * DIGITS get three states, not two: kept, read as a letter, or read as
 * NOTHING. Deletion was documented from the start and was dead code: the fold
 * was `LEET[c] || ''` and LEET maps all ten digits, so the fallback could never
 * fire and "nig0ger" sailed through the exact case the comment named. Insertion
 * is the highest-value bypass there is and it has no dictionary surface at all.
 *
 * RUNS of a repeated character are emitted at BOTH one and two characters. The
 * first version collapsed runs of 3+ down to one, which missed plain doubling
 * ("niigger") and — worse — made tripling *easier* than doubling, because
 * "niggger" collapsed to a harmless "niger". Emitting both lengths handles the
 * padded spellings without destroying legitimate double letters.
 */
function tokenReadings(token) {
  const digits = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i] >= '0' && token[i] <= '9') digits.push(i);
  }
  const capped = digits.slice(0, MAX_LEET_DIGITS);

  // Base-3 over the capped digits: 0 = keep, 1 = fold to a letter, 2 = drop.
  const folded = new Set();
  let combos = 1;
  for (let i = 0; i < capped.length; i++) combos *= 3;
  for (let n = 0; n < combos; n++) {
    let out = '';
    let code = n;
    const state = [];
    for (let i = 0; i < capped.length; i++) { state.push(code % 3); code = Math.floor(code / 3); }
    for (let i = 0; i < token.length; i++) {
      const slot = capped.indexOf(i);
      if (slot === -1) { out += token[i]; continue; }
      if (state[slot] === 0) out += token[i];
      else if (state[slot] === 1) out += LEET[token[i]] || '';
      // state 2 appends nothing — the digit is read as padding.
    }
    folded.add(out);
  }

  const readings = new Set();
  for (const candidate of folded) {
    readings.add(candidate);
    // Runs at both lengths. `runs` holds [start, length] for each run of 2+.
    const runs = [];
    for (let i = 0; i < candidate.length;) {
      let j = i;
      while (j < candidate.length && candidate[j] === candidate[i]) j++;
      if (j - i >= 2) runs.push([i, j - i]);
      i = j;
    }
    const used = runs.slice(0, MAX_RUNS);
    const variants = 1 << used.length;
    for (let mask = 0; mask < variants; mask++) {
      let out = '';
      let cursor = 0;
      used.forEach(([start, length], index) => {
        out += candidate.slice(cursor, start);
        out += candidate[start].repeat((mask >> index) & 1 ? 2 : 1);
        cursor = start + length;
      });
      out += candidate.slice(cursor);
      readings.add(out);
      if (readings.size > MAX_READINGS) return readings;
    }
  }
  return readings;
}

const INTRA_WORD = /[._'&!,?"();:/-]/g;

/**
 * The token sets a name is judged on.
 *
 * TWO tokenizations, because either alone leaves a hole. Splitting on
 * whitespace and then dropping separators inside each word catches "j.a.p";
 * splitting on separators too catches "Team.Jap.Squad". Neither ever joins
 * across a space, which is what keeps "Ape Exit" from becoming "apexit".
 *
 * Runs of single-character tokens are also joined, because "C H I N K" is a
 * spelling, not five words.
 */
function tokenize(raw) {
  const lower = squash(raw).toLowerCase();
  const tokens = new Set();

  const bySpace = lower.split(' ').filter(Boolean);
  for (const word of bySpace) {
    const stripped = word.replace(INTRA_WORD, '');
    if (stripped) tokens.add(stripped);
    for (const piece of word.split(INTRA_WORD)) if (piece) tokens.add(piece);
  }

  let run = [];
  const flush = () => { if (run.length >= 3) tokens.add(run.join('')); run = []; };
  for (const word of bySpace) {
    const stripped = word.replace(INTRA_WORD, '');
    if (stripped.length === 1) run.push(stripped);
    else flush();
  }
  flush();

  return tokens;
}

/**
 * Why a user-authored string is refused, or null.
 *
 * Returns only that something was blocked — never which term matched. Naming
 * it turns every refusal into an oracle for probing the list, and tells a user
 * acting in good faith something they did not ask to read.
 */
function blockedContent(raw) {
  // The hate code, and ONLY as a bare word — see HATE_CODE. Checked against the
  // raw whitespace split so that "14.88" keeps its separator and stays a price.
  for (const word of squash(raw).toLowerCase().split(' ')) {
    if (word === HATE_CODE) return true;
  }

  // The substring tier sees TWO things, and the split between them is the whole
  // point:
  //
  //   1. The collapsed key, read LITERALLY. Collapsing joins words, which is
  //      what catches a term split across a space ("Nig Gas" -> "niggas").
  //   2. Each token's leet readings, which catch a digit hidden inside one word
  //      ("Ni0gger" -> "nigger").
  //
  // What it must NEVER see is leet readings OF the collapsed key. That combines
  // both powers and invents terms nobody typed: "moon 1664 soon" collapses to
  // "moon1664soon", the digits fold 1->i 6->g 4->a, and a slur appears across a
  // junction between two innocent words. It refused fourteen out of fourteen
  // ordinary price lines in production before this was caught — "green 1664",
  // "run 1664 up", "turn 1664 into 5k". The module header above makes exactly
  // this argument for the token tier; the substring tier had quietly broken it.
  const literalKey = nameKey(raw);
  const candidates = [literalKey];
  for (const token of tokenize(raw)) {
    for (const reading of tokenReadings(token)) candidates.push(reading);
  }
  for (const candidate of candidates) {
    // Strip the known innocent hosts first. Removing them leaves any genuine
    // occurrence behind, so this cannot be used as cover.
    let scrubbed = candidate;
    for (const host of ALLOWED_SUBSTRINGS) scrubbed = scrubbed.split(host).join('');
    for (const bad of BLOCKED_SUBSTRINGS) if (scrubbed.includes(bad)) return true;
  }

  for (const token of tokenize(raw)) {
    if (ALLOWED_TOKENS.has(token)) continue;
    for (const reading of tokenReadings(token)) {
      if (ALLOWED_TOKENS.has(reading)) continue;
      for (const suffix of SUFFIXES) {
        if (!reading.endsWith(suffix)) continue;
        const stem = suffix ? reading.slice(0, -suffix.length) : reading;
        if (!stem) continue;
        if (BLOCKED_TOKENS.has(stem)) return true;
        // "-ies" is the one suffix that rewrites its stem: trannies -> tranny.
        if (suffix === 'ies' && BLOCKED_TOKENS.has(stem + 'y')) return true;
      }
    }
  }
  return false;
}

/**
 * Collapse every run of whitespace to one plain space, then trim.
 *
 * `\s` catches the invisible ones — U+00A0, U+2009 and friends — which is the
 * point: normalising them means two clans cannot differ only by a character
 * nobody can see, and it fixes a paste rather than rejecting it.
 */
function squash(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

const normalizeTag = (raw) => squash(raw).toUpperCase();
const normalizeName = (raw) => squash(raw);
const normalizeCode = (raw) => squash(raw).toUpperCase();
const cleanMotto = (raw) => squash(raw);

/** The uniqueness key for a name: lowercase, alphanumerics only. */
const nameKey = (raw) => normalizeName(raw).toLowerCase().replace(/[^a-z0-9]/g, '');

function tagProblem(raw) {
  const tag = normalizeTag(raw);
  if (!TAG_RE.test(tag)) return 'tag-shape';
  if (RESERVED_TAGS.has(tag)) return 'tag-reserved';
  // A tag is a single token by construction (2-5 alphanumerics, no separators),
  // so this is an exact match against the list once digits are read as letters.
  // Kept as a separate code from 'tag-reserved' so the two stay distinguishable.
  if (blockedContent(tag)) return 'tag-blocked';
  return null;
}

function nameProblem(raw) {
  const name = normalizeName(raw);
  if (name.length < NAME_MIN) return 'name-too-short';
  if (name.length > NAME_MAX) return 'name-too-long';
  if (!NAME_RE.test(name)) return 'name-charset';
  const key = nameKey(name);
  // A name that is almost entirely punctuation has a uniqueness key too short
  // to distinguish it from anything else, so it is refused for the same reason
  // a two-letter name is.
  if (key.length < NAME_MIN) return 'name-too-short';
  if (RESERVED_NAME_KEYS.some((reserved) => key.includes(reserved))) return 'name-reserved';
  if (blockedContent(name)) return 'name-blocked';
  return null;
}

function mottoProblem(raw) {
  const motto = cleanMotto(raw);
  if (motto.length > MOTTO_MAX) return 'motto-too-long';
  if (!MOTTO_RE.test(motto)) return 'motto-charset';
  // The motto is the one field a founder can change after creation, so it is
  // also the one that could be laundered past a create-time check. Same rule,
  // same list — `handleClanUpdate` already routes through here.
  if (blockedContent(motto)) return 'motto-blocked';
  return null;
}

/* -------------------------------------------------------- contribution --- */

/**
 * The slice of a mode window a member's fills may count toward this clan.
 *
 * Rule 1 above, made concrete: the window's own start, or the moment they
 * joined, whichever is later. Everything downstream is `windowEntry` over this
 * — no new math, which is exactly why there is no new way to cheat.
 */
function contributionWindow(joinedAt, window) {
  const joined = Math.trunc(Number(joinedAt) || 0);
  return {
    startTs: Math.max(Math.trunc(Number(window && window.startTs) || 0), joined),
    endTs: Math.trunc(Number(window && window.endTs) || 0),
  };
}

/**
 * One member's contribution to one clan window, from their full chain.
 *
 * Returns null when the slice is empty — someone who joined after a window
 * closed contributed nothing to it, and null says that. A zeroed entry would
 * claim they showed up and did nothing, which is a different fact.
 */
function memberEntry(links, startingSol, joinedAt, window) {
  const slice = contributionWindow(joinedAt, window);
  if (!(slice.endTs > slice.startTs)) return null;
  return Object.assign(
    { startTs: slice.startTs, endTs: slice.endTs },
    windowEntry(links, startingSol, slice)
  );
}

/* ------------------------------------------------------------ standing --- */

/**
 * A clan's standing for one window, from its members' contribution entries.
 *
 * `members` is [{ handle, userId, status, joinedAt, entry }] where `entry` is
 * `memberEntry` output (or null). `status` is the verification tier of that
 * member's own record, and only 'verified' contributes — the boards' rule
 * (worker: WHERE r.status = 'verified'), enforced here for the same reason:
 * attest.js is open source, so fabricated fills can carry valid hashes, and
 * a chain of unlisted mints re-prices to all 'no-data' → 'partial' with
 * nothing disproved. A tier below verified is the one class of record the
 * server could not check; admitting it to the clan mean — or to the clan
 * page's printed volume lines — would make clans the laundering path for
 * exactly the records the boards stopped ranking. Unverified members still
 * appear on the roster, labeled; they take no position in any aggregate.
 *
 * An unranked clan gets `score: null`, never a zero. Zero is a result; not
 * having fielded five qualified members yet is an absence, and this product
 * does not print one as the other.
 */
function standing(members, options) {
  const opts = options || {};
  const minRounds = Number.isFinite(Number(opts.minRounds))
    ? Number(opts.minRounds) : MIN_SEASON_ROUNDS;
  const roster = Array.isArray(members) ? members : [];

  const eligible = roster.filter((m) => m && m.entry && m.status === 'verified');
  const active = eligible.filter((m) => Number(m.entry.rounds) > 0);
  const qualified = eligible
    .filter((m) => (Number(m.entry.rounds) || 0) >= minRounds)
    .sort((a, b) => (Number(b.entry.score) || 0) - (Number(a.entry.score) || 0));

  const counting = qualified.slice(0, COUNTING_MEMBERS);
  const ranked = counting.length >= COUNTING_MEMBERS;
  const total = counting.reduce((sum, m) => sum + (Number(m.entry.score) || 0), 0);

  return {
    roster: roster.length,
    active: active.length,
    qualified: qualified.length,
    needed: Math.max(0, COUNTING_MEMBERS - qualified.length),
    ranked,
    score: ranked ? total / COUNTING_MEMBERS : null,
    // Who currently makes the number, best first. Shown on the clan page so a
    // clan's score is never a figure nobody can attribute.
    counting: counting.map((m) => ({
      handle: m.handle,
      status: m.status || 'pending',
      joinedAt: Number(m.joinedAt) || 0,
      score: Number(m.entry.score) || 0,
      roiPct: Number(m.entry.roiPct) || 0,
      rounds: Number(m.entry.rounds) || 0,
    })),
    // Volume figures span everyone who traded in the window, not just the five.
    // They describe the clan's activity; they never feed the score.
    rounds: active.reduce((sum, m) => sum + (Number(m.entry.rounds) || 0), 0),
    pnlSol: active.reduce((sum, m) => sum + (Number(m.entry.pnlSol) || 0), 0),
  };
}

/* ---------------------------------------------------------- membership --- */

/** Why a create attempt is refused, or null when it may proceed. */
function createProblem(input) {
  const form = input || {};
  if (form.alreadyInClan) return 'already-in-a-clan';
  return tagProblem(form.tag) || nameProblem(form.name) || mottoProblem(form.motto);
}

/**
 * Why a join attempt is refused, or null.
 *
 * An invite-only clan needs the code; an open clan needs nothing but an
 * account. A clan with no code stored can never be joined by code — the empty
 * string must not match the empty string.
 */
function joinProblem(clan, memberCount, options) {
  const opts = options || {};
  if (opts.alreadyInClan) return 'already-in-a-clan';
  if (!clan) return 'not-found';
  if ((Number(memberCount) || 0) >= MAX_MEMBERS) return 'clan-full';
  if (!clan.open) {
    const want = normalizeCode(clan.joinCode);
    if (!want || normalizeCode(opts.code) !== want) return 'bad-code';
  }
  return null;
}

/** Why a kick is refused, or null. Founders only, and never themselves. */
function kickProblem(clan, actorId, targetId) {
  if (!clan) return 'not-found';
  if (Number(clan.founderId) !== Number(actorId)) return 'not-founder';
  if (Number(targetId) === Number(clan.founderId)) return 'cannot-kick-founder';
  return null;
}

/**
 * Who inherits a clan when its founder leaves: the earliest-joined member
 * still standing, ties broken by user id so the answer is deterministic.
 * Null means the clan is now empty and should be disbanded rather than left
 * as an ownerless shell.
 */
function successor(members, leavingUserId) {
  const rest = (Array.isArray(members) ? members : [])
    .filter((m) => Number(m.userId) !== Number(leavingUserId));
  if (!rest.length) return null;
  return rest.slice().sort((a, b) =>
    (Number(a.joinedAt) || 0) - (Number(b.joinedAt) || 0) ||
    (Number(a.userId) || 0) - (Number(b.userId) || 0))[0];
}

/**
 * What a clan payload may carry for one member's window slice: their entry
 * when their record is verified, nothing otherwise.
 *
 * Below verified the figures are WITHHELD, not just unlabeled. standing()
 * already refuses them a position in any aggregate, but a payload that still
 * carries numbers no client may legitimately display is a loaded gun for the
 * next consumer — the clan page shipped exactly that defect once, printing a
 * partial member's rounds and return pixel-identical to a contributor's.
 * `status` on the member row is what tells a page to render "not counted";
 * it needs no figures to do it, and their real record stays on their own
 * profile, labeled.
 */
function publicEntry(status, entry) {
  return status === 'verified' ? (entry || null) : null;
}

module.exports = {
  COUNTING_MEMBERS, MAX_MEMBERS, MIN_SEASON_ROUNDS, MIN_WEEK_ROUNDS,
  SEASON_END_TS, SEASON_WINDOW,
  TAG_RE, NAME_MIN, NAME_MAX, MOTTO_MAX, RESERVED_TAGS,
  BLOCKED_TOKENS, BLOCKED_SUBSTRINGS, ALLOWED_SUBSTRINGS, ALLOWED_TOKENS,
  HATE_CODE, blockedContent, tokenize,
  normalizeTag, normalizeName, normalizeCode, cleanMotto, nameKey,
  tagProblem, nameProblem, mottoProblem,
  contributionWindow, memberEntry, standing, publicEntry,
  createProblem, joinProblem, kickProblem, successor,
};
