/* PaperTrench — X-Ray: account intel computed from X's own page traffic.
 *
 * Pure logic for the X-Ray feature, loaded in three worlds: the x.com MAIN
 * world (digesting the page's own GraphQL responses), the background worker
 * (ledger reducers + intel assembly), and the test suite. Dependency-free and
 * side-effect-free on purpose: every function takes its inputs — including
 * `now` — as arguments, so all of it runs under `node --test` without a
 * browser.
 *
 * The honesty contract this module enforces:
 *  - Bio / display-name / @handle history CANNOT be known retroactively
 *    without someone else's surveillance database. X-Ray records what THIS
 *    device observes, from the first sighting onward, and the view model
 *    carries `firstSeenAt` so the UI can say exactly that. No fabricated
 *    "changed recently" from data we never saw.
 *  - CA history and notable followers ARE computable from real data (the
 *    account's own tweets and follower lists), so those are shown with their
 *    observed bounds ("back to <date>", "from lists this device has seen"),
 *    never presented as exhaustive.
 *  - Every stored value comes from an X API response the logged-in page
 *    itself produced. Nothing is guessed, scraped from HTML, or fetched from
 *    a third party.
 */
(() => {
  'use strict';
  const root = typeof self !== 'undefined' ? self : window;
  if (root.PTXRay) return;

  /* -------------------- operation allowlist -------------------- */

  // GraphQL operations worth reading. Everything else on the wire (home
  // timeline, DMs, notifications, ads) is none of our business and is never
  // parsed — the allowlist is the privacy boundary as much as the CPU budget.
  const OPS = new Set([
    'UserByScreenName', 'UserByRestId',
    'UserTweets', 'UserTweetsAndReplies', 'UserMedia',
    'TweetDetail', 'SearchTimeline',
    'Followers', 'BlueVerifiedFollowers', 'FollowersYouKnow',
  ]);

  // Ops whose request shape (URL + public headers) is worth remembering so a
  // budgeted deep scan can replay them with different variables. The shape of
  // an op the page never fired this session can come from the ledger, learned
  // on an earlier visit.
  const REPLAY_OPS = new Set([
    'UserTweets', 'UserTweetsAndReplies',
    'FollowersYouKnow', 'Followers', 'BlueVerifiedFollowers',
  ]);

  // Ops whose response is a follower list OF the account in the request
  // variables (rather than content BY it).
  const FOLLOWER_OPS = new Set(['Followers', 'BlueVerifiedFollowers', 'FollowersYouKnow']);

  const OP_RE = /\/i\/api\/graphql\/([^/?#]+)\/([A-Za-z0-9_]+)/;

  // X's own API hosts. The path alone is not enough: any site can serve a
  // path shaped like X's GraphQL route, and digesting a third party's
  // response would be both wrong and a privacy hole.
  const API_HOSTS = new Set([
    'x.com', 'www.x.com', 'mobile.x.com', 'api.x.com',
    'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'api.twitter.com',
  ]);

  function interestingOp(url) {
    const raw = String(url || '');
    const m = OP_RE.exec(raw);
    if (!m || !OPS.has(m[2])) return null;
    // X issues these as same-origin relative URLs; an absolute one has to
    // prove it is X over https before anything is read from its response.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) {
      let parsed;
      try { parsed = new URL(raw, 'https://x.com'); } catch (_) { return null; }
      if (parsed.protocol !== 'https:' || !API_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    }
    return { queryId: m[1], op: m[2] };
  }

  /** The request's GraphQL variables (userId / screen_name / focalTweetId /
   * cursor live here), straight from the URL's query string. */
  function requestVariables(url) {
    try {
      const raw = new URL(String(url)).searchParams.get('variables');
      if (!raw) return null;
      const vars = JSON.parse(raw);
      return vars && typeof vars === 'object' ? vars : null;
    } catch (_) {
      return null;
    }
  }

  /* -------------------- limits -------------------- */

  const LIMITS = {
    maxPayloadChars: 3_000_000, // a response bigger than this is not a profile
    maxNodes: 60_000,
    maxDepth: 24,
    maxUsersPerDigest: 120,
    maxTweetsPerDigest: 120,
    bioChars: 1_000,
    nameChars: 120,
    // History snapshots kept per account: the FIRST observed value plus the
    // most recent (keep-1). Overflow bumps a counter, so the change COUNT
    // stays exact even when old intermediate values are dropped.
    bioKeep: 7,
    nameKeep: 10,
    handleKeep: 10,
    casKeep: 40,
    smartKeep: 16,
    smartShow: 8,
    smartMinFollowers: 25_000, // "big account" threshold for the ⭐ marker
    smartFloorFollowers: 1_000, // below this a follower is not worth storing
    tweetRing: 400,
    accountsKeep: 1_500,
  };

  /* -------------------- small helpers -------------------- */

  function str(v, cap) {
    return typeof v === 'string' ? v.slice(0, cap) : null;
  }
  function num(v) {
    return Number.isFinite(v) && v >= 0 ? v : null;
  }
  /** X's legacy date format ("Wed Oct 10 20:19:24 +0000 2018") → ms, or null.
   * V8 parses this form; anything it refuses stays null rather than NaN. */
  function parseXDate(v) {
    if (typeof v !== 'string' || !v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  function isRestId(v) {
    return typeof v === 'string' && /^\d{1,25}$/.test(v);
  }
  function isHandle(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(v);
  }

  /* -------------------- CA detection -------------------- */

  // A Solana address is 32-44 base58 characters. In free text, a base58 run
  // of that length is an address for all practical purposes — English does
  // not produce 32-character words, and X shortens URLs to t.co in the text
  // itself (expanded URLs are scanned separately, host-gated below).
  const CA_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;

  // PaperTrench is a Solana trainer; an EVM address pasted as "0xABC…" would
  // otherwise match from the 'x' onward (hex ⊂ base58 minus '0'). Refuse
  // candidates that are hex-shaped — precision over recall, per the mission.
  const EVM_RE = /^[xX]?[0-9a-fA-F]{32,}$/;

  // Expanded URLs are only mined on hosts where a base58 path/query segment
  // IS a token or pair address. A generic scan would false-positive on
  // random web IDs (Drive links and the like), and a wrong CA chip is a lie.
  const CA_HOST_RE = /(^|\.)(pump\.fun|dexscreener\.com|gmgn\.ai|birdeye\.so|axiom\.trade|bullx\.io|tinyastro\.io|jup\.ag|solscan\.io|raydium\.io|meteora\.ag|geckoterminal\.com|dextools\.io|bags\.fm|letsbonk\.fun|fomo\.family|lute\.gg)$/i;

  function casFromText(text) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    const matches = text.match(CA_RE) || [];
    for (const m of matches) {
      if (!EVM_RE.test(m) && !out.includes(m)) out.push(m);
    }
    return out;
  }

  function casFromUrls(urls) {
    const out = [];
    if (!Array.isArray(urls)) return out;
    for (const u of urls) {
      if (typeof u !== 'string') continue;
      let host = '';
      try { host = new URL(u).hostname; } catch (_) { continue; }
      if (!CA_HOST_RE.test(host)) continue;
      for (const ca of casFromText(u)) {
        if (!out.includes(ca)) out.push(ca);
      }
    }
    return out;
  }

  /* -------------------- payload extraction -------------------- */

  function expandedUrls(entities) {
    const out = [];
    const push = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const e of arr) {
        if (e && typeof e.expanded_url === 'string') out.push(e.expanded_url.slice(0, 600));
      }
    };
    if (entities && typeof entities === 'object') {
      push(entities.urls);
      if (entities.description) push(entities.description.urls);
      if (entities.url) push(entities.url.urls);
    }
    return out;
  }

  /** A user object, in either wire shape: classic (everything under
   * `legacy`) or current (`core` carries name/screen_name/created_at while
   * `legacy` keeps counts and description). Missing fields come back null —
   * a sparse user embedded in a tweet must never register as "bio changed
   * to empty". */
  function userFromNode(node) {
    if (!isRestId(node.rest_id)) return null;
    const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : null;
    const core = node.core && typeof node.core === 'object' ? node.core : null;
    if (legacy && typeof legacy.full_text === 'string') return null; // that's a tweet
    const handle = (core && str(core.screen_name, 20)) || (legacy && str(legacy.screen_name, 20));
    if (!isHandle(handle)) return null;

    const profileBio = node.profile_bio && typeof node.profile_bio === 'object' ? node.profile_bio : null;
    const bio = (profileBio && str(profileBio.description, LIMITS.bioChars))
      ?? (legacy && str(legacy.description, LIMITS.bioChars));
    const urls = [
      ...expandedUrls(legacy && legacy.entities),
      ...expandedUrls(profileBio && profileBio.entities),
    ];
    const avatar = (legacy && str(legacy.profile_image_url_https, 300))
      || (node.avatar && str(node.avatar.image_url, 300));

    return {
      restId: node.rest_id,
      handle,
      name: (core && str(core.name, LIMITS.nameChars)) ?? (legacy && str(legacy.name, LIMITS.nameChars)),
      bio,
      urls,
      avatar,
      createdAt: parseXDate((core && core.created_at) || (legacy && legacy.created_at)),
      followers: num(legacy && legacy.followers_count),
      following: num(legacy && legacy.friends_count),
      verified: node.is_blue_verified === true || (legacy && legacy.verified === true) || false,
    };
  }

  /** A tweet, reduced to what X-Ray keeps: identity, author, date, and the
   * CAs it carries. Long posts hide their full text in note_tweet — the
   * 280-char `full_text` is truncated with an ellipsis, and a CA past the
   * fold would be silently missed without it. */
  function tweetFromNode(node) {
    if (!isRestId(node.rest_id)) return null;
    const legacy = node.legacy;
    if (!legacy || typeof legacy !== 'object' || typeof legacy.full_text !== 'string') return null;

    let text = legacy.full_text;
    let noteUrls = [];
    const note = node.note_tweet && node.note_tweet.note_tweet_results
      && node.note_tweet.note_tweet_results.result;
    if (note && typeof note.text === 'string') {
      text = note.text;
      noteUrls = expandedUrls(note.entity_set);
    }
    const urls = [...expandedUrls(legacy.entities), ...noteUrls];
    const cas = [...new Set([...casFromText(text), ...casFromUrls(urls)])];

    return {
      id: node.rest_id,
      authorId: isRestId(legacy.user_id_str) ? legacy.user_id_str : null,
      createdAt: parseXDate(legacy.created_at),
      cas,
    };
  }

  /** One pass over a GraphQL payload: every user, every tweet, and the
   * bottom pagination cursor. Bounded by node and depth caps so a
   * pathological payload costs bounded CPU, never a hung tab. */
  function extract(payload) {
    const users = [];
    const tweets = [];
    let cursor = null;
    let nodes = 0;
    const seenUsers = new Set();
    const seenTweets = new Set();

    (function walk(node, depth) {
      if (!node || typeof node !== 'object') return;
      if (++nodes > LIMITS.maxNodes || depth > LIMITS.maxDepth) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      if (users.length < LIMITS.maxUsersPerDigest) {
        const u = userFromNode(node);
        if (u && !seenUsers.has(u.restId)) {
          seenUsers.add(u.restId);
          users.push(u);
        }
      }
      if (tweets.length < LIMITS.maxTweetsPerDigest) {
        const t = tweetFromNode(node);
        if (t && !seenTweets.has(t.id)) {
          seenTweets.add(t.id);
          tweets.push(t);
        }
      }
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') {
        cursor = node.value.slice(0, 400);
      }
      for (const k in node) walk(node[k], depth + 1);
    })(payload, 0);

    return { users, tweets, cursor };
  }

  /* -------------------- SSR (window.$R) extraction --------------------
   * X increasingly serves profiles server-side: the first paint hydrates
   * from an inline `window.$R` relay graph and NO allowlisted GraphQL call
   * ever fires, which made X-Ray blind exactly where it matters most — the
   * first view of a profile. Everything below reads that SAME graph the
   * page itself renders from. Same honesty contract as the fetch path:
   * derived facts only, nothing outside the profile/tweet shapes, bounded
   * walk so a hostile payload costs bounded CPU.
   *
   * The graph has two kinds of indirection:
   *  - relay records, keyed by `__id` ("client:VXNlcjo0NDE5…"), pointed at
   *    by `{ __ref: <that id> }` / `{ __refs: [<ids>] }` wrappers;
   *  - the live `window.$R` object itself, where numeric keys hold the
   *    hydration payload (route matches, dehydrated data) as real objects.
   * Users come from two places: the route-match record of a profile route
   * (`restId`/`screenName`/counts, self-contained) and `__typename:"User"`
   * relay records (post pages, where the author has no route record).
   * Tweets are relay records `__typename:"Tweet"`: `rest_id`, a `core`
   * ref back to the author User, and a `details` (TBirdData) ref with
   * `full_text` + `created_at_ms`.
   */

  function relayResolve(relay, obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > LIMITS.maxDepth) return obj;
    if (typeof obj.__ref === 'string') {
      const hit = relay && Object.prototype.hasOwnProperty.call(relay, obj.__ref)
        ? relay[obj.__ref] : null;
      return relayResolve(relay, hit, depth + 1);
    }
    return obj;
  }

  function ssrUserFromRoute(route) {
    if (!route || typeof route !== 'object') return null;
    if (!isRestId(route.restId) || !isHandle(route.screenName)) return null;
    return {
      restId: route.restId,
      handle: route.screenName,
      name: str(route.name, LIMITS.nameChars),
      bio: str(route.description, LIMITS.bioChars),
      urls: [],
      avatar: str(route.avatarUrl, 300),
      createdAt: Number.isFinite(route.createdAtMs) && route.createdAtMs > 0
        ? route.createdAtMs : null,
      followers: num(route.followers),
      following: num(route.following),
      verified: route.isVerified === true,
    };
  }

  function ssrUserFromRelay(relay, node) {
    if (!node || typeof node !== 'object' || node.__typename !== 'User') return null;
    if (!isRestId(node.rest_id)) return null;
   const legacy = relayResolve(relay, node.legacy, 0);
   const core = relayResolve(relay, node.core, 0);
   const counts = relayResolve(relay, node.relationship_counts, 0);
   // Two record generations share this shape: the classic GraphQL user
   // (everything under `legacy`, counts suffixed `_count`) and the new
   // per-aspect layout X's server render now hydrates from — `core` is a
   // UserCore, bio/avatar/verification/counts are separate aspect records
   // named without the `_count` suffix. Read both, prefer whichever
   // actually carries the field; a field neither generation carries stays
   // null (sparse records must never read as "cleared").
   const bioNode = node.profile_bio
     ? relayResolve(relay, node.profile_bio, 0)
     : (legacy && legacy.profile_bio ? relayResolve(relay, legacy.profile_bio, 0) : null);
   const bio = str(bioNode && bioNode.description, LIMITS.bioChars)
     ?? str(legacy && legacy.description, LIMITS.bioChars);
   const handle = str(core && core.screen_name, 20) || str(legacy && legacy.screen_name, 20);
   if (!isHandle(handle)) return null;
   const verification = relayResolve(relay, node.verification, 0);
   return {
     restId: node.rest_id,
     handle,
     name: str(core && core.name, LIMITS.nameChars) || str(legacy && legacy.name, LIMITS.nameChars),
     bio,
     urls: [...expandedUrls(legacy && legacy.entities),
       ...expandedUrls(bioNode && bioNode.entities)],
     avatar: str(legacy && legacy.profile_image_url_https, 300)
       || (node.avatar
         ? str((relayResolve(relay, node.avatar, 0) || {}).image_url, 300)
         : null),
     createdAt: parseXDate((core && core.created_at) || (legacy && legacy.created_at))
       ?? num(core && core.created_at_ms),
     followers: num(legacy && legacy.followers_count) ?? num(counts && counts.followers_count)
       ?? num(counts && counts.followers),
     following: num(legacy && legacy.friends_count) ?? num(counts && counts.following_count)
       ?? num(counts && counts.following),
     verified: node.is_blue_verified === true || (verification && verification.is_blue_verified === true)
       || (legacy && legacy.verified === true) || false,
   };
}

  function ssrTweetFromRelay(relay, node) {
    if (!node || typeof node !== 'object' || node.__typename !== 'Tweet') return null;
    if (!isRestId(node.rest_id)) return null;
    const details = relayResolve(relay, node.details, 0);
    const text = details && typeof details.full_text === 'string' ? details.full_text : null;
    const createdAt = details && Number.isFinite(details.created_at_ms)
      && details.created_at_ms > 0 ? details.created_at_ms : null;
    // authorId comes from the core ref (UserResults → result → User).
    const results = relayResolve(relay, node.core, 0);
    const result = relayResolve(relay, results && results.result, 0);
    const author = result && result.__typename === 'User' && isRestId(result.rest_id)
      ? result.rest_id
      : (relayResolve(relay, result && result.core, 0), null);
    return {
      id: node.rest_id,
      authorId: isRestId(author) ? author : null,
      createdAt,
      cas: text ? casFromText(text) : [],
    };
  }

  /** One pass over the live `window.$R` hydration graph: every user (from
   * profile route matches and User relay records), every tweet relay
   * record, bounded like extract(). */
  function ssrExtract(root) {
    const users = [];
    const tweets = [];
    let nodes = 0;
    const seenUsers = new Set();
    const seenTweets = new Set();
    let relay = null;

    const takeUser = (u) => {
      if (u && !seenUsers.has(u.restId) && users.length < LIMITS.maxUsersPerDigest) {
        seenUsers.add(u.restId);
        users.push(u);
      }
    };
    const takeTweet = (t) => {
      if (t && !seenTweets.has(t.id) && tweets.length < LIMITS.maxTweetsPerDigest) {
        seenTweets.add(t.id);
        tweets.push(t);
      }
    };

    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || ++nodes > LIMITS.maxNodes
          || depth > LIMITS.maxDepth) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      if (node.__typename === 'User') takeUser(ssrUserFromRelay(relay, node));
      else if (node.__typename === 'Tweet') takeTweet(ssrTweetFromRelay(relay, node));
      else if (isRestId(node.restId) && isHandle(node.screenName)) {
        takeUser(ssrUserFromRoute(node));
      }
      if (node.relayRecords && typeof node.relayRecords === 'object' && !relay) {
        relay = node.relayRecords;
      }
      for (const k in node) walk(node[k], depth + 1);
    })(root, 0);

    return { users, tweets };
  }

  /* -------------------- ledger reducers -------------------- */

  function newRecord(user, now) {
    return {
      restId: user.restId,
      handle: user.handle.toLowerCase(),
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: user.createdAt,
      followers: user.followers,
      following: user.following,
      verified: user.verified,
      avatar: user.avatar || null,
      // Snapshot lists start with whatever the first sighting carried; a
      // change is only ever recorded against an actually-observed prior.
      names: user.name !== null ? [{ v: user.name, at: now }] : [],
      handles: [{ v: user.handle, at: now }],
      bios: user.bio !== null ? [{ v: user.bio, at: now }] : [],
      namesDropped: 0,
      handlesDropped: 0,
      biosDropped: 0,
      bioCas: user.bio !== null
        ? [...new Set([...casFromText(user.bio), ...casFromUrls(user.urls)])]
        : [],
      cas: {},
      casDropped: 0,
      tweetRing: [],
      oldestTweetAt: null,
      newestTweetAt: null,
      smart: [],
      smartAt: null,
      smartSources: [],
      scanCursor: null,
      lastDeepScanAt: 0,
    };
  }

  /** Append `value` to a snapshot list if it differs from the latest entry.
   * Overflow drops the SECOND-oldest entry (the first sighting is part of the
   * honesty story and is never dropped) and bumps the overflow counter, so
   * `list.length - 1 + dropped` is always the exact observed change count.
   *
   * `eq` exists for @handle, which is compared case-insensitively: X returns
   * screen_name in the case the owner typed, and a payload that differs only
   * in case is the same handle. Counting that as a rename would print a
   * fabricated "1 change seen" on an account that never changed anything. */
  function trackValue(list, value, at, keep, eq) {
    const last = list[list.length - 1];
    const same = eq || ((a, b) => a === b);
    if (last && same(last.v, value)) return 0;
    list.push({ v: value, at });
    if (list.length > keep) {
      list.splice(1, 1);
      return 2; // changed AND dropped
    }
    return 1; // changed
  }

  /** Fold one observed user object into its record. Returns the (possibly
   * new) record and whether anything the panel shows actually changed. */
  function observeUser(record, user, now) {
    if (!record) return { record: newRecord(user, now), changed: true };
    let changed = false;

    if (user.name !== null) {
      const r = record.names.length
        ? trackValue(record.names, user.name, now, LIMITS.nameKeep)
        : (record.names.push({ v: user.name, at: now }), 1);
      if (r === 2) record.namesDropped += 1;
      changed = changed || r > 0;
    }
    const r2 = trackValue(record.handles, user.handle, now, LIMITS.handleKeep,
      (a, b) => String(a).toLowerCase() === String(b).toLowerCase());
    if (r2 === 2) record.handlesDropped += 1;
    changed = changed || r2 > 0;
    record.handle = user.handle.toLowerCase();

    if (user.bio !== null) {
      const r3 = record.bios.length
        ? trackValue(record.bios, user.bio, now, LIMITS.bioKeep)
        : (record.bios.push({ v: user.bio, at: now }), 1);
      if (r3 === 2) record.biosDropped += 1;
      if (r3 > 0) {
        changed = true;
        record.bioCas = [...new Set([...casFromText(user.bio), ...casFromUrls(user.urls)])];
      }
    }

    if (user.createdAt !== null) record.createdAt = user.createdAt;
    if (user.followers !== null) record.followers = user.followers;
    if (user.following !== null) record.following = user.following;
    if (user.avatar) record.avatar = user.avatar;
    record.verified = user.verified;
    record.lastSeenAt = now;
    return { record, changed };
  }

  /** Fold the account's own tweets into its CA index. Tweet dates — not
   * observation time — are what the index stores: "posted a CA on May 2" is
   * a fact from the tweet itself and stays true however late we read it. */
  function observeTweets(record, tweets, now) {
    let changed = false;
    for (const t of tweets) {
      if (t.authorId !== record.restId) continue;
      if (record.tweetRing.includes(t.id)) continue;
      record.tweetRing.unshift(t.id);
      if (record.tweetRing.length > LIMITS.tweetRing) record.tweetRing.pop();

      if (t.createdAt !== null) {
        if (record.oldestTweetAt === null || t.createdAt < record.oldestTweetAt) {
          record.oldestTweetAt = t.createdAt;
          changed = true;
        }
        if (record.newestTweetAt === null || t.createdAt > record.newestTweetAt) {
          record.newestTweetAt = t.createdAt;
        }
      }
      for (const ca of t.cas) {
        const at = t.createdAt !== null ? t.createdAt : now;
        const entry = record.cas[ca];
        if (!entry) {
          record.cas[ca] = { firstAt: at, lastAt: at, tweetId: t.id };
          changed = true;
        } else {
          if (at < entry.firstAt) entry.firstAt = at;
          if (at > entry.lastAt) { entry.lastAt = at; entry.tweetId = t.id; }
        }
      }
    }
    // Cap the CA index by recency; the count stays exact via the counter.
    const keys = Object.keys(record.cas);
    if (keys.length > LIMITS.casKeep) {
      keys.sort((a, b) => record.cas[a].lastAt - record.cas[b].lastAt);
      for (const k of keys.slice(0, keys.length - LIMITS.casKeep)) {
        delete record.cas[k];
        record.casDropped += 1;
      }
    }
    return changed;
  }

  /** Merge a batch of observed followers into the account's notable list.
   * `source` is provenance, kept per entry so the UI can say where a name
   * came from ('you_follow' = the followers-you-know edge, 'followers' = a
   * follower page). Ranked by follower count — an honest, computable proxy
   * for "big account"; X-Ray has no secret smart-money list to consult. */
  function mergeSmart(record, followers, source, now) {
    let changed = false;
    const byId = new Map(record.smart.map((s) => [s.restId, s]));
    for (const f of followers) {
      if (f.restId === record.restId) continue;
      if (!(f.followers >= LIMITS.smartFloorFollowers)) continue;
      const prev = byId.get(f.restId);
      if (prev) {
        prev.followers = Math.max(prev.followers, f.followers);
        prev.handle = f.handle;
        prev.name = f.name !== null ? f.name : prev.name;
        prev.verified = f.verified;
        if (f.avatar) prev.avatar = f.avatar;
        prev.at = now;
        if (source === 'you_follow') prev.src = 'you_follow';
      } else {
        byId.set(f.restId, {
          restId: f.restId,
          handle: f.handle,
          name: f.name,
          followers: f.followers,
          verified: f.verified,
          avatar: f.avatar || null,
          src: source,
          at: now,
        });
        changed = true;
      }
    }
    record.smart = [...byId.values()]
      .sort((a, b) => b.followers - a.followers)
      .slice(0, LIMITS.smartKeep);
    record.smartAt = now;
    if (!record.smartSources.includes(source)) record.smartSources.push(source);
    return changed;
  }

  /* -------------------- ledger root + LRU -------------------- */

  function emptyLedger() {
    return { accounts: {}, handleIdx: {}, order: [], ops: {} };
  }

  /** Mark an account recently used and evict beyond the cap. Eviction also
   * sweeps handle-index entries pointing at the evicted account. */
  function touchAccount(ledger, restId) {
    const i = ledger.order.indexOf(restId);
    if (i !== -1) ledger.order.splice(i, 1);
    ledger.order.push(restId);
    while (ledger.order.length > LIMITS.accountsKeep) {
      const evict = ledger.order.shift();
      delete ledger.accounts[evict];
      for (const h of Object.keys(ledger.handleIdx)) {
        if (ledger.handleIdx[h] === evict) delete ledger.handleIdx[h];
      }
    }
  }

  /* -------------------- intel view model -------------------- */

  function histView(list, dropped) {
    if (!list.length) return { current: null, changes: 0, lastChangeAt: null, previous: [] };
    return {
      current: list[list.length - 1].v,
      changes: list.length - 1 + dropped,
      lastChangeAt: list.length > 1 ? list[list.length - 1].at : null,
      previous: list.slice(0, -1).slice(-3).reverse().map((e) => ({ v: e.v, at: e.at })),
    };
  }

  /** Everything the panel renders, honesty labels included. Pure: the panel
   * formats, this decides. */
  function assembleIntel(record, now) {
    const cas = Object.keys(record.cas)
      .map((address) => ({ address, ...record.cas[address] }))
      .sort((a, b) => b.lastAt - a.lastAt);
    return {
      restId: record.restId,
      handle: record.handle,
      avatar: record.avatar,
      followers: record.followers,
      following: record.following,
      verified: record.verified,
      createdAt: record.createdAt,
      firstSeenAt: record.firstSeenAt,
      watchedMs: Math.max(0, now - record.firstSeenAt),
      name: histView(record.names, record.namesDropped),
      handleHist: histView(record.handles, record.handlesDropped),
      bio: histView(record.bios, record.biosDropped),
      bioCas: record.bioCas.slice(0, 8),
      cas,
      casDropped: record.casDropped,
      scannedBackTo: record.oldestTweetAt,
      newestTweetAt: record.newestTweetAt,
      smart: record.smart.slice(0, LIMITS.smartShow).map((s) => ({
        ...s,
        big: s.followers >= LIMITS.smartMinFollowers,
      })),
      smartAt: record.smartAt,
      smartSources: record.smartSources.slice(),
    };
  }

  root.PTXRay = {
    LIMITS,
    OPS,
    REPLAY_OPS,
    FOLLOWER_OPS,
    interestingOp,
    requestVariables,
    casFromText,
    casFromUrls,
    userFromNode,
    tweetFromNode,
    extract,
    ssrExtract,
    newRecord,
    observeUser,
    observeTweets,
    mergeSmart,
    emptyLedger,
    touchAccount,
    assembleIntel,
  };
})();
