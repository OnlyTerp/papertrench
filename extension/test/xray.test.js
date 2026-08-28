/* X-Ray — account intel on x.com (v2.6.0).
 *
 * The feature makes claims about other people's accounts, so the tests are
 * mostly about what it is NOT allowed to say:
 *
 *  - A first sighting is never a change. The competing products imply a
 *    surveillance history they do have; X-Ray only has what this device saw,
 *    and the view model must carry the watch-window date with every counter.
 *  - Change counts stay exact even when old snapshots are dropped for space.
 *  - A sparse user object embedded in a tweet must not register as "bio
 *    cleared" — the most dangerous false positive available here, since an
 *    emptied bio reads as a rug tell.
 *  - Nothing outside the operation allowlist is parsed at all, and no raw
 *    tweet text leaves the page world.
 *  - Page-adjacent input is revalidated at the worker boundary: a forged
 *    digest cannot write junk (or a fake contract address) into the ledger.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function loadCore() {
  const sandbox = {
    self: {}, URL, URLSearchParams, Set, Map, String, RegExp, JSON, Math, Date,
    Number, Array, Object, Boolean, isNaN, parseInt,
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-core.js'), 'utf8'), sandbox, { filename: 'xray-core.js' });
  return sandbox.self.PTXRay;
}

const XR = loadCore();

/** Values built inside the vm realm carry a foreign Object/Array prototype,
 * which deepEqual treats as a mismatch. Compare structurally instead. */
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* A real contract address shape (base58, 44 chars) and a real X id. */
const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CA2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const API = 'https://x.com/i/api/graphql/AbC123xyz/';

/* ---------------- operation allowlist ---------------- */

test('only profile/tweet/follower operations are looked at — never the rest of X', () => {
  assert.deepEqual(plain(XR.interestingOp(API + 'UserByScreenName?variables=%7B%7D')),
    { queryId: 'AbC123xyz', op: 'UserByScreenName' });
  assert.equal(XR.interestingOp(API + 'UserTweets').op, 'UserTweets');
  assert.equal(XR.interestingOp(API + 'FollowersYouKnow').op, 'FollowersYouKnow');

  // The user's own life on X is not X-Ray's business. These carry DMs,
  // the home feed, notifications and ads — never parsed, so their contents
  // cannot even be reached by a bug downstream.
  for (const op of ['HomeTimeline', 'HomeLatestTimeline', 'DMInbox', 'DmAllSearchSlice',
    'NotificationsTimeline', 'AudioSpaceById', 'Viewer', 'useFetchProfileSections']) {
    assert.equal(XR.interestingOp(API + op), null, op + ' must not be parsed');
  }
  assert.equal(XR.interestingOp('https://x.com/i/api/1.1/jot/client_event.json'), null);
  assert.equal(XR.interestingOp(''), null);

  // X fires these as same-origin relative URLs; those must still classify.
  assert.equal(XR.interestingOp('/i/api/graphql/QID/UserTweets?variables=%7B%7D').op, 'UserTweets');

  // Any site can serve a path shaped like X's GraphQL route. Reading a
  // response from one would be both wrong and a privacy hole.
  for (const href of [
    'https://evil.example/i/api/graphql/x/UserTweets',
    'https://x.com.evil.example/i/api/graphql/x/UserTweets',
    'http://x.com/i/api/graphql/x/UserTweets',
  ]) {
    assert.equal(XR.interestingOp(href), null, href + ' must not be treated as X\'s API');
  }
});

test('request variables are read from the GraphQL query string', () => {
  const url = API + 'UserByScreenName?variables=' + encodeURIComponent(JSON.stringify({ screen_name: 'degenlabs' }));
  assert.equal(XR.requestVariables(url).screen_name, 'degenlabs');
  assert.equal(XR.requestVariables(API + 'UserTweets'), null);
  assert.equal(XR.requestVariables(API + 'UserTweets?variables=not-json'), null);
});

/* ---------------- contract-address detection ---------------- */

test('contract addresses are found in post text without inventing them', () => {
  assert.deepEqual(plain(XR.casFromText('launching ' + CA + ' now')), [CA]);
  assert.deepEqual(plain(XR.casFromText(CA + '\n\n' + CA)), [CA], 'the same CA twice is one CA');
  assert.deepEqual(plain(XR.casFromText('CA: ' + CA + ' and ' + CA2)), [CA, CA2]);

  for (const text of [
    'gm frens wagmi lfg',                                    // ordinary post
    'https://t.co/aBcDeFgHiJ',                               // X's own shortener
    '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',            // an EVM address
    '0X71C7656EC7AB88B098DEFB751B7401B5F6D8976F',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',                        // 30 chars: too short
    '0OIl'.repeat(12),                                       // base58-illegal chars throughout
  ]) {
    assert.deepEqual(plain(XR.casFromText(text)), [], JSON.stringify(text.slice(0, 24)) + ' must not yield a CA');
  }
  assert.deepEqual(plain(XR.casFromText(null)), []);
});

test('links are mined for CAs only on hosts where a base58 segment IS an address', () => {
  assert.deepEqual(plain(XR.casFromUrls(['https://pump.fun/coin/' + CA])), [CA]);
  assert.deepEqual(plain(XR.casFromUrls(['https://dexscreener.com/solana/' + CA2])), [CA2]);
  assert.deepEqual(plain(XR.casFromUrls(['https://gmgn.ai/sol/token/' + CA + '?ref=x'])), [CA]);

  // A random long id on an unrelated host is not a contract address, and
  // printing one as this account's CA would be a lie the user acts on.
  assert.deepEqual(plain(XR.casFromUrls(['https://drive.google.com/file/d/' + CA + '/view'])), []);
  assert.deepEqual(plain(XR.casFromUrls(['https://youtube.com/watch?v=' + CA])), []);
  assert.deepEqual(plain(XR.casFromUrls(['not a url', null, 42])), []);
});

/* ---------------- payload extraction ---------------- */

function userNodeCore(overrides = {}) {
  return {
    __typename: 'User',
    id: 'VXNlcjoxMjM=',
    rest_id: '1450000000000000001',
    is_blue_verified: true,
    core: { created_at: 'Wed Oct 10 20:19:24 +0000 2018', name: 'Degen Labs', screen_name: 'degenlabs' },
    avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a.jpg' },
    legacy: {
      description: 'building in the trenches ' + CA,
      entities: { description: { urls: [{ expanded_url: 'https://pump.fun/coin/' + CA2 }] } },
      followers_count: 128_400,
      friends_count: 312,
    },
    ...overrides,
  };
}

function userNodeLegacy() {
  return {
    __typename: 'User',
    rest_id: '1450000000000000002',
    legacy: {
      created_at: 'Mon Mar 03 11:00:00 +0000 2014',
      name: 'Old Shape',
      screen_name: 'oldshape',
      description: 'classic payload',
      followers_count: 900,
      friends_count: 10,
      verified: true,
    },
  };
}

function tweetNode(id, text, opts = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      full_text: text,
      user_id_str: opts.authorId || '1450000000000000001',
      created_at: opts.createdAt || 'Fri May 02 18:30:00 +0000 2025',
      entities: { urls: (opts.urls || []).map((u) => ({ expanded_url: u })) },
    },
    ...(opts.note ? {
      note_tweet: { note_tweet_results: { result: { text: opts.note, entity_set: { urls: [] } } } },
    } : {}),
  };
}

test('a user is read from both the current and the legacy payload shape', () => {
  const modern = XR.userFromNode(userNodeCore());
  assert.equal(modern.restId, '1450000000000000001');
  assert.equal(modern.handle, 'degenlabs');
  assert.equal(modern.name, 'Degen Labs');
  assert.match(modern.bio, /^building in the trenches/);
  assert.equal(modern.followers, 128_400);
  assert.equal(modern.verified, true);
  assert.equal(modern.createdAt, Date.parse('Wed Oct 10 20:19:24 +0000 2018'));

  const legacy = XR.userFromNode(userNodeLegacy());
  assert.equal(legacy.handle, 'oldshape');
  assert.equal(legacy.name, 'Old Shape');
  assert.equal(legacy.createdAt, Date.parse('Mon Mar 03 11:00:00 +0000 2014'));

  // A tweet node is not a user node, however deep the walk goes.
  assert.equal(XR.userFromNode(tweetNode('1', 'hi')), null);
  assert.equal(XR.userFromNode({ rest_id: 'not-an-id', core: { screen_name: 'x' } }), null);
  assert.equal(XR.userFromNode({ rest_id: '12', core: { screen_name: 'way_too_long_handle_here' } }), null);
});

test('a long post is read past the 280-character fold, where the CA usually is', () => {
  const short = 'the ticker is $TRENCH, contract below 👇 https://t.co/abc';
  const full = short + ' ' + CA;
  const t = XR.tweetFromNode(tweetNode('1800000000000000001', short + '…', { note: full }));
  assert.deepEqual(plain(t.cas), [CA], 'the note_tweet body must be what is scanned');
  assert.equal(t.id, '1800000000000000001');
  assert.equal(t.createdAt, Date.parse('Fri May 02 18:30:00 +0000 2025'));
});

test('one walk over a timeline payload yields users, tweets and the paging cursor', () => {
  const payload = {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: [
                  {
                    entryId: 'tweet-1800000000000000001',
                    content: { itemContent: { tweet_results: { result: Object.assign(
                      tweetNode('1800000000000000001', 'first CA ' + CA),
                      { core: { user_results: { result: userNodeCore() } } }
                    ) } } },
                  },
                  {
                    entryId: 'tweet-1800000000000000002',
                    content: { itemContent: { tweet_results: { result:
                      tweetNode('1800000000000000002', 'no address here', { urls: ['https://pump.fun/coin/' + CA2] }) } } },
                  },
                  {
                    entryId: 'cursor-bottom-0',
                    content: { entryType: 'TimelineTimelineCursor', value: 'DAABCgABGx_x', cursorType: 'Bottom' },
                  },
                  {
                    entryId: 'cursor-top-0',
                    content: { entryType: 'TimelineTimelineCursor', value: 'TOP-CURSOR', cursorType: 'Top' },
                  },
                ],
              }],
            },
          },
        },
      },
    },
  };

  const { users, tweets, cursor } = XR.extract(payload);
  assert.equal(users.length, 1, 'the embedded author is found');
  assert.equal(users[0].handle, 'degenlabs');
  assert.equal(tweets.length, 2);
  assert.deepEqual(plain(tweets[0].cas), [CA]);
  assert.deepEqual(plain(tweets[1].cas), [CA2], 'a CA reached only through a pump.fun link still counts');
  assert.equal(cursor, 'DAABCgABGx_x', 'the BOTTOM cursor is what pages further back');
});

test('extraction is bounded, so a hostile payload costs bounded CPU', () => {
  let deep = { rest_id: '1', legacy: { full_text: 'x' } };
  for (let i = 0; i < 400; i++) deep = { nest: deep };
  assert.doesNotThrow(() => XR.extract(deep));

  const wide = { list: [] };
  for (let i = 0; i < 5000; i++) wide.list.push(tweetNode(String(1800000000000000000 + i), 'post ' + i));
  const got = XR.extract(wide);
  assert.ok(got.tweets.length <= XR.LIMITS.maxTweetsPerDigest,
    'a huge payload must not produce an unbounded digest');
});

/* ---------------- the honesty contract ---------------- */

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;

test('a first sighting is never a change — the counter starts at zero', () => {
  const user = XR.userFromNode(userNodeCore());
  const { record } = XR.observeUser(null, user, T0);
  const intel = XR.assembleIntel(record, T0 + DAY);

  assert.equal(intel.bio.changes, 0);
  assert.equal(intel.name.changes, 0);
  assert.equal(intel.handleHist.changes, 0);
  assert.equal(intel.bio.lastChangeAt, null);
  assert.equal(intel.firstSeenAt, T0, 'the view model must carry when watching began');
  assert.equal(intel.watchedMs, DAY, 'and how long that has been');
  assert.equal(intel.bio.current, user.bio);
});

test('seeing the same account again changes nothing', () => {
  const user = XR.userFromNode(userNodeCore());
  let record = XR.observeUser(null, user, T0).record;
  const second = XR.observeUser(record, XR.userFromNode(userNodeCore()), T0 + DAY);
  record = second.record;
  assert.equal(second.changed, false);
  assert.equal(XR.assembleIntel(record, T0 + DAY).bio.changes, 0);
  assert.equal(record.firstSeenAt, T0, 'the first-seen stamp is never overwritten');
});

test('an actual bio edit is counted once, with the previous text kept', () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const edited = userNodeCore();
  edited.legacy.description = 'now shilling something else';
  record = XR.observeUser(record, XR.userFromNode(edited), T0 + DAY).record;

  const intel = XR.assembleIntel(record, T0 + DAY);
  assert.equal(intel.bio.changes, 1);
  assert.equal(intel.bio.lastChangeAt, T0 + DAY);
  assert.equal(intel.bio.current, 'now shilling something else');
  assert.match(intel.bio.previous[0].v, /^building in the trenches/);
  // The CA that was in the old bio TEXT is gone; the one behind the profile
  // link is still live, so it stays. "CA in bio right now" must describe the
  // bio as it is now, not as it was when we first met the account.
  assert.deepEqual(plain(intel.bioCas), [CA2]);
});

test('a display-name change and a rename are tracked separately', () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const renamed = userNodeCore();
  renamed.core.name = 'Trench Capital';
  renamed.core.screen_name = 'trenchcap';
  record = XR.observeUser(record, XR.userFromNode(renamed), T0 + DAY).record;

  const intel = XR.assembleIntel(record, T0 + DAY);
  assert.equal(intel.name.changes, 1);
  assert.equal(intel.handleHist.changes, 1);
  assert.equal(intel.handleHist.previous[0].v, 'degenlabs');
  assert.equal(intel.handle, 'trenchcap');
});

test('a handle that differs only in case is not a rename', () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const recased = userNodeCore();
  recased.core.screen_name = 'DegenLabs';
  record = XR.observeUser(record, XR.userFromNode(recased), T0 + DAY).record;
  assert.equal(XR.assembleIntel(record, T0 + DAY).handleHist.changes, 0);
});

test('a sparse user embedded in a tweet cannot register as "bio cleared"', () => {
  // THE dangerous false positive: an emptied bio reads as a rug tell, and
  // tweet payloads carry author objects with no description field at all.
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const sparse = {
    rest_id: '1450000000000000001',
    core: { name: 'Degen Labs', screen_name: 'degenlabs' },
    legacy: { followers_count: 128_500 },
  };
  record = XR.observeUser(record, XR.userFromNode(sparse), T0 + DAY).record;

  const intel = XR.assembleIntel(record, T0 + DAY);
  assert.equal(intel.bio.changes, 0, 'a missing field is not an emptied field');
  assert.match(intel.bio.current, /^building in the trenches/);
  assert.equal(intel.followers, 128_500, 'but the counts that WERE present still update');
});

test('the change count stays exact after old snapshots are dropped for space', () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const edits = XR.LIMITS.bioKeep + 5;
  for (let i = 0; i < edits; i++) {
    const next = userNodeCore();
    next.legacy.description = 'edit number ' + i;
    record = XR.observeUser(record, XR.userFromNode(next), T0 + (i + 1) * DAY).record;
  }
  const intel = XR.assembleIntel(record, T0 + 99 * DAY);
  assert.equal(intel.bio.changes, edits, 'dropping snapshots must not drop the count');
  assert.ok(record.bios.length <= XR.LIMITS.bioKeep, 'storage stays capped');
  assert.match(record.bios[0].v, /^building in the trenches/,
    'the FIRST observed value survives — it is what the watch window is anchored to');
});

/* ---------------- CA history ---------------- */

test('posted CAs are indexed by the date of the post, not the day we read it', () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const may = Date.parse('Fri May 02 18:30:00 +0000 2025');
  const june = Date.parse('Mon Jun 02 18:30:00 +0000 2025');
  const tweets = [
    XR.tweetFromNode(tweetNode('1800000000000000001', 'first ' + CA, { createdAt: 'Fri May 02 18:30:00 +0000 2025' })),
    XR.tweetFromNode(tweetNode('1800000000000000002', 'again ' + CA, { createdAt: 'Mon Jun 02 18:30:00 +0000 2025' })),
    XR.tweetFromNode(tweetNode('1800000000000000003', 'other ' + CA2, { createdAt: 'Mon Jun 02 18:30:00 +0000 2025' })),
    XR.tweetFromNode(tweetNode('1800000000000000004', 'someone else ' + CA2, { authorId: '999', createdAt: 'Mon Jun 02 18:30:00 +0000 2025' })),
  ];
  XR.observeTweets(record, tweets, T0);

  const intel = XR.assembleIntel(record, T0);
  assert.equal(intel.cas.length, 2, 'a tweet by a DIFFERENT author is not this account\'s CA');
  const first = intel.cas.find((c) => c.address === CA);
  assert.equal(first.firstAt, may);
  assert.equal(first.lastAt, june);
  assert.equal(intel.scannedBackTo, may, 'the card can state how far back the posts were read');

  // Re-reading the same page must not double-count anything.
  XR.observeTweets(record, tweets, T0 + DAY);
  assert.equal(XR.assembleIntel(record, T0).cas.length, 2);
});

test('a CA sitting in the bio right now is surfaced from the bio itself', () => {
  const record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const intel = XR.assembleIntel(record, T0);
  assert.ok(intel.bioCas.includes(CA), 'the CA in the bio text');
  assert.ok(intel.bioCas.includes(CA2), 'and the one behind the bio link');
});

/* ---------------- smart following ---------------- */

function follower(id, handle, followers) {
  return {
    restId: id, handle, name: handle, followers, following: 100,
    verified: true, avatar: null, bio: null, urls: [], createdAt: null,
  };
}

test('Smart Following ranks by follower count and marks the genuinely big ones', () => {
  const record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  XR.mergeSmart(record, [
    follower('11', 'smallfry', 1_200),
    follower('12', 'whale', 2_400_000),
    follower('13', 'midcurve', 60_000),
    follower('14', 'noise', 40),          // below the storage floor
  ], 'followers', T0);

  const intel = XR.assembleIntel(record, T0);
  assert.deepEqual(plain(intel.smart.map((s) => s.handle)), ['whale', 'midcurve', 'smallfry']);
  assert.deepEqual(plain(intel.smart.map((s) => s.big)), [true, true, false]);
  assert.deepEqual(plain(intel.smartSources), ['followers']);

  // The followers-you-know edge is better provenance and upgrades the entry.
  XR.mergeSmart(record, [follower('13', 'midcurve', 61_000)], 'you_follow', T0 + DAY);
  const after = XR.assembleIntel(record, T0 + DAY);
  assert.equal(after.smart.find((s) => s.handle === 'midcurve').src, 'you_follow');
  assert.equal(after.smart.length, 3, 'merging by id, not appending duplicates');
  assert.ok(after.smartSources.includes('you_follow'));
});

test('the notable-follower list is capped and keeps the biggest', () => {
  const record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const many = [];
  for (let i = 0; i < 60; i++) many.push(follower('2' + i, 'acct' + i, 1_000 + i * 1_000));
  XR.mergeSmart(record, many, 'followers', T0);
  assert.ok(record.smart.length <= XR.LIMITS.smartKeep);
  assert.equal(record.smart[0].followers, 1_000 + 59 * 1_000, 'the biggest survives the cap');
});

/* ---------------- ledger housekeeping ---------------- */

test('the ledger evicts oldest-touched accounts and sweeps their handle index', () => {
  const ledger = XR.emptyLedger();
  const cap = XR.LIMITS.accountsKeep;
  for (let i = 0; i < cap + 3; i++) {
    const id = String(1000 + i);
    ledger.accounts[id] = { restId: id, handle: 'acct' + i };
    ledger.handleIdx['acct' + i] = id;
    XR.touchAccount(ledger, id);
  }
  assert.equal(ledger.order.length, cap);
  assert.equal(ledger.accounts['1000'], undefined, 'the least recently touched is gone');
  assert.equal(ledger.handleIdx.acct0, undefined, 'and its handle no longer points at a missing record');
  assert.ok(ledger.accounts[String(1000 + cap + 2)], 'the most recent survives');
});

/* ---------------- privacy shape ---------------- */

test('a digest carries derived facts only — never the text of anyone\'s posts', () => {
  const payload = { entries: [tweetNode('1800000000000000009', 'private thoughts about ' + CA)] };
  const digest = XR.extract(payload);
  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes('private thoughts'),
    'raw post text must never be part of what crosses out of the page world');
  assert.ok(serialized.includes(CA), 'the derived fact — the address — is what travels');
});

test('the MAIN-world observer parses nothing outside the allowlist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'xray-main.js'), 'utf8');
  assert.match(src, /XR\.interestingOp\(/, 'every hook must gate on the allowlist');

  // Every call into the digester passes an op that came OUT of the allowlist
  // check — there is no path from a raw response body to the parser that
  // skips it. Pinned at the call sites so a future hook cannot quietly add
  // one (the parse itself lives inside digestText, one function).
  const callers = [...src.matchAll(/(?<!function )digestText\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(callers.length >= 2, 'expected the fetch and XHR paths to both digest');
  for (const arg of callers) {
    assert.ok(arg === 'found' || arg === 'tag.found',
      `digestText must be called with an allowlisted op, got ${JSON.stringify(arg)}`);
  }
  // The observer reads responses; it must never send one anywhere but the
  // page's own window (the panel then forwards a digest to the extension).
  assert.doesNotMatch(src, /chrome\.runtime/, 'the MAIN world has no extension access at all');
  assert.match(src, /window\.postMessage\(/);
});

/* ---------------- wiring ---------------- */

test('the X-Ray scripts are wired into the right worlds, in the right order', () => {
  const mainEntry = manifest.content_scripts.find((cs) => (cs.js || []).includes('xray-main.js'));
  assert.ok(mainEntry, 'the observer must be declared');
  assert.equal(mainEntry.world, 'MAIN', 'it hooks the page\'s own fetch/XHR');
  assert.equal(mainEntry.run_at, 'document_start',
    'the hooks must be installed before X issues its first profile request');
  assert.ok(mainEntry.js.indexOf('xray-core.js') < mainEntry.js.indexOf('xray-main.js'),
    'the observer needs the extractors loaded before it');
  assert.ok(mainEntry.matches.every((m) => /https:\/\/(\*\.)?(x|twitter)\.com\/\*/.test(m)),
    'X-Ray runs on X and nowhere else');

  const panelEntry = manifest.content_scripts.find((cs) => (cs.js || []).includes('xray-panel.js'));
  assert.equal((panelEntry.world || 'ISOLATED'), 'ISOLATED', 'the panel needs chrome.runtime');
  assert.ok(panelEntry.matches.every((m) => /https:\/\/(\*\.)?(x|twitter)\.com\/\*/.test(m)));

  // The trading surface must not gain X-Ray, and X must not gain the engine.
  const trading = manifest.content_scripts.filter((cs) => cs.matches.some((m) => m.includes('pump.fun')));
  for (const entry of trading) {
    assert.ok(!entry.js.some((f) => f.startsWith('xray-')), 'X-Ray is an X-page feature only');
  }
  for (const entry of [mainEntry, panelEntry]) {
    assert.ok(!entry.js.includes('content.js') && !entry.js.includes('engine.js'),
      'the trading engine must never load on X');
  }
});

test('X-Ray adds no permissions and no web-accessible resources', () => {
  // The pinned list gained `scripting` in Turbo II (the opt-in Instant Links
  // spread — see warmlinks.test.js for the why). X-Ray's own claim stands:
  // none of these permissions exist FOR X-Ray.
  assert.deepEqual([...manifest.permissions].sort(),
    ['activeTab', 'alarms', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage'].sort());
  for (const war of manifest.web_accessible_resources || []) {
    assert.ok(!(war.resources || []).some((r) => r.startsWith('xray-')),
      'no X-Ray file is exposed to page scripts');
  }
});

test('every X-Ray message type sent has a handler on the other side', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'xray-panel.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'xray-main.js'), 'utf8');

  for (const type of ['pt_xray_observe', 'pt_xray_get', 'pt_xray_plan']) {
    assert.match(panel, new RegExp(`type: '${type}'`), `the panel must send ${type}`);
    assert.match(background, new RegExp(`case '${type}'`), `background must handle ${type}`);
  }
  // The two window.postMessage channels must agree tag for tag, or the panel
  // and the observer talk past each other in silence.
  for (const tag of ['papertrench-xray-digest', 'papertrench-xray-scan', 'papertrench-xray-state']) {
    assert.ok(main.includes(tag) && panel.includes(tag), `both sides must know ${tag}`);
  }
  assert.match(background, /xray-core\.js/, 'the worker must import the shared extractors');
});

/* ---------------- background: revalidation and budget ---------------- */

function xrayWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false, recordingEnabled: false, autoReview: false,
      xrayEnabled: opts.enabled !== false,
      xrayDeepScanEnabled: opts.deepScan !== false,
      ...(opts.settings || {}),
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
    ...(opts.values || {}),
  };
  const session = {};
  let messageListener = null;

  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => { throw new Error('X-Ray must never make the worker fetch anything'); },
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(values, update); if (callback) callback(); },
        },
        session: {
          get: (keys, callback) => callback({}),
          set: (u, cb) => { Object.assign(session, u); if (cb) cb(); },
          remove: (k, cb) => { if (cb) cb(); },
        },
      },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (fn) => { messageListener = fn; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        create: async () => ({ id: 1 }), update: async () => ({}), get: async () => { throw new Error('none'); },
        remove: async () => {}, query: (q, cb) => cb([]), sendMessage: async () => ({}),
        captureVisibleTab: async () => '',
        onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => {} },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return { values, get listener() { return messageListener; } };
}

function send(listener, message, sender = { tab: { id: 7, windowId: 1, index: 0 } }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const async = listener(message, sender, (response) => { clearTimeout(timeout); resolve(response); });
    assert.equal(async, true, 'background messages must keep the response channel open');
  });
}

function digestOf(users, tweets, extra = {}) {
  return {
    op: 'UserByScreenName', users, tweets, cursor: null,
    subjectRestId: users.length ? users[0].restId : null,
    followersTarget: null, scan: null, opShape: null, ...extra,
  };
}

const SUBJECT = {
  restId: '1450000000000000001', handle: 'degenlabs', name: 'Degen Labs',
  bio: 'building ' + CA, urls: [], avatar: 'https://pbs.twimg.com/a.jpg',
  createdAt: Date.UTC(2018, 9, 10), followers: 128_400, following: 312, verified: true,
};

test('with the feature off, nothing is stored and no intel is returned', async () => {
  const worker = xrayWorker({ enabled: false });
  const observed = await send(worker.listener, { type: 'pt_xray_observe', digest: digestOf([SUBJECT], []), handle: 'degenlabs' });
  assert.equal(observed.ok, false);
  assert.equal(worker.values.pt_xray, undefined, 'the ledger is never written while off');
  const got = await send(worker.listener, { type: 'pt_xray_get', handle: 'degenlabs' });
  assert.equal(got.ok, false);
});

test('an observed profile comes back as intel and is there on the next visit', async () => {
  const worker = xrayWorker();
  const observed = await send(worker.listener, {
    type: 'pt_xray_observe', digest: digestOf([SUBJECT], []), handle: 'degenlabs',
  });
  assert.equal(observed.ok, true);
  assert.equal(observed.intel.handle, 'degenlabs');
  assert.equal(observed.intel.bio.changes, 0);
  assert.ok(observed.intel.bioCas.includes(CA));

  // The next page view renders from storage before any request goes out —
  // this is what makes the card appear instantly rather than after a fetch.
  const cached = await send(worker.listener, { type: 'pt_xray_get', handle: 'DegenLabs' });
  assert.equal(cached.ok, true);
  assert.equal(cached.intel.restId, SUBJECT.restId);
  assert.equal(cached.intel.followers, 128_400);
});

test('a forged digest cannot write junk into the ledger', async () => {
  const worker = xrayWorker();
  // Page-controlled input: bad ids, an oversized bio, a fake "CA" that is not
  // a Solana address, and an avatar pointing at an attacker's http endpoint.
  const forged = digestOf([{
    restId: 'not-an-id', handle: '../../etc/passwd', name: 'x'.repeat(9000),
    bio: 'y'.repeat(90_000), urls: [], avatar: 'http://evil.example/track.gif',
    createdAt: 99e15, followers: -5, following: 1e12, verified: 'yes',
  }], []);
  const observed = await send(worker.listener, { type: 'pt_xray_observe', digest: forged, handle: 'degenlabs' });
  assert.equal(observed.ok, true);
  assert.equal(observed.intel, null, 'nothing resolvable, so nothing to show');
  assert.deepEqual(plain(worker.values.pt_xray.accounts), {}, 'and nothing stored');

  const badCa = digestOf([SUBJECT], [{
    id: '1800000000000000001', authorId: SUBJECT.restId, createdAt: Date.UTC(2026, 4, 2),
    cas: ['definitely-not-base58!!', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', CA],
  }]);
  const second = await send(worker.listener, { type: 'pt_xray_observe', digest: badCa, handle: 'degenlabs' });
  assert.deepEqual(plain(second.intel.cas.map((c) => c.address)), [CA],
    'only real Solana addresses survive the boundary');

  const wrongOp = await send(worker.listener, {
    type: 'pt_xray_observe', digest: digestOf([SUBJECT], [], { op: 'HomeTimeline' }), handle: 'degenlabs',
  });
  assert.equal(wrongOp.ok, false, 'an op outside the allowlist is refused at the worker too');
});

test('a follower list only becomes Smart Following for the account it is about', async () => {
  const worker = xrayWorker();
  await send(worker.listener, { type: 'pt_xray_observe', digest: digestOf([SUBJECT], []), handle: 'degenlabs' });

  const others = [
    { ...SUBJECT },
    { ...follower('900', 'whale', 3_000_000), bio: null, urls: [], createdAt: null },
    { ...follower('901', 'midcurve', 44_000), bio: null, urls: [], createdAt: null },
  ];
  const observed = await send(worker.listener, {
    type: 'pt_xray_observe',
    digest: digestOf(others, [], {
      op: 'FollowersYouKnow', subjectRestId: null, followersTarget: SUBJECT.restId,
    }),
    handle: 'degenlabs',
  });
  assert.deepEqual(plain(observed.intel.smart.map((s) => s.handle)), ['whale', 'midcurve']);
  assert.deepEqual(plain(observed.intel.smartSources), ['you_follow']);

  // Every user seen anywhere gets its own record, so clicking through to a
  // notable follower shows their history immediately too.
  const whale = await send(worker.listener, { type: 'pt_xray_get', handle: 'whale' });
  assert.equal(whale.intel.restId, '900');
});

test('the deep scan is budgeted, needs a learned request shape, and never fetches from the worker', async () => {
  const worker = xrayWorker();
  await send(worker.listener, { type: 'pt_xray_observe', digest: digestOf([SUBJECT], []), handle: 'degenlabs' });

  // No shape learned yet: nothing to replay, and the card still works.
  const noShape = await send(worker.listener, { type: 'pt_xray_plan', restId: SUBJECT.restId, handle: 'degenlabs' });
  assert.equal(noShape.scan, null);

  // The page fires its own UserTweets; that teaches the shape.
  await send(worker.listener, {
    type: 'pt_xray_observe',
    digest: digestOf([SUBJECT], [], {
      op: 'UserTweets',
      opShape: {
        op: 'UserTweets',
        url: 'https://x.com/i/api/graphql/QID/UserTweets?variables=%7B%22userId%22%3A%221%22%7D',
        headers: { authorization: 'Bearer AAAA', 'x-twitter-auth-type': 'OAuth2Session' },
      },
    }),
    handle: 'degenlabs',
  });
  const planned = await send(worker.listener, { type: 'pt_xray_plan', restId: SUBJECT.restId, handle: 'degenlabs' });
  assert.equal(planned.scan.op, 'UserTweets');
  assert.equal(planned.scan.userId, SUBJECT.restId);
  assert.equal(planned.scan.shape.headers.authorization, 'Bearer AAAA');

  // Immediately asking again is refused — one account cannot spin the budget.
  const again = await send(worker.listener, { type: 'pt_xray_plan', restId: SUBJECT.restId, handle: 'degenlabs' });
  assert.equal(again.scan, null);

  // Deep scan off: the passive layer keeps working, the extra request does not.
  const quiet = xrayWorker({ deepScan: false });
  await send(quiet.listener, { type: 'pt_xray_observe', digest: digestOf([SUBJECT], []), handle: 'degenlabs' });
  const refused = await send(quiet.listener, { type: 'pt_xray_plan', restId: SUBJECT.restId, handle: 'degenlabs' });
  assert.equal(refused.scan, null);
});

test('a scan shape that stops working is forgotten rather than retried forever', async () => {
  const worker = xrayWorker();
  await send(worker.listener, {
    type: 'pt_xray_observe',
    digest: digestOf([SUBJECT], [], {
      op: 'UserTweets',
      opShape: {
        op: 'UserTweets',
        url: 'https://x.com/i/api/graphql/QID/UserTweets?variables=%7B%7D',
        headers: { authorization: 'Bearer AAAA' },
      },
    }),
    handle: 'degenlabs',
  });
  const planned = await send(worker.listener, { type: 'pt_xray_plan', restId: SUBJECT.restId, handle: 'degenlabs' });
  assert.ok(planned.scan);

  // X rotated its query id: the replay 404s and the shape is dropped.
  await send(worker.listener, {
    type: 'pt_xray_observe',
    digest: digestOf([], [], { op: 'UserTweets', scan: { requestId: planned.scan.requestId, status: 404 } }),
    handle: 'degenlabs',
  });
  assert.equal(worker.values.pt_xray.ops.UserTweets, undefined,
    'a shape that answered 404 must not be replayed on the next visit');
});

test('the panel refuses to run on X system pages and off-profile routes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'xray-panel.js'), 'utf8');
  // The route reader is the gate: reserved first segments (home, messages,
  // settings, i/…) must never resolve to an "account" the card claims to
  // describe. Pinned structurally — the same reserved set as the link
  // classifier, which the warm-links suite pins in full.
  for (const reserved of ['home', 'messages', 'settings', 'notifications', 'i', 'explore']) {
    assert.match(src, new RegExp(`'${reserved}'`), `the panel's reserved set must include ${reserved}`);
  }
  assert.match(src, /xrayEnabled/, 'the panel must gate on the feature toggle');
  assert.match(src, /appEnabled !== false/, 'and obey the app-wide master switch');
});
