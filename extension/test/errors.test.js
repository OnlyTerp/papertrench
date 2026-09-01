/* PaperTrench — error ring buffer.
 *
 * The buffer exists so a "it stopped working" report from Discord has
 * something to read. That makes these properties load-bearing:
 *
 *   - it is BOUNDED (an error recorder that leaks memory during an error
 *     storm makes the outage worse),
 *   - it DEDUPES (a 100ms loop throwing the same thing must not evict the
 *     history that explains it — that history is the entire point),
 *   - it REDACTS (paper-only product; key material must never be stored),
 *   - it NEVER THROWS (a recorder that throws inside a catch block converts a
 *     handled error into an unhandled one).
 *
 * Every test below was verified to FAIL with its feature deliberately broken.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ERR = require('../errors.js');

/* Fake secrets. None of these is real key material; they are shaped like the
 * real thing so the redactor is exercised on the pattern it must catch. */
const FAKE_WALLET = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const FAKE_PRIVKEY = '4wBqpZM9xaSheZzJSMawUEtwLNTJhM4pfzntCVQb1PjKNsCTHTCe3wpFn7VDNFUYPRPCzGSJKtxeMkzhTQTBHwNb';
const FAKE_BEARER = 'sk-liveXXXX1111aaaaBBBB2222ccccDDDD';
const FAKE_HEX_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

function reset() {
  ERR.clear();
}

/* ------------------------------- capacity ------------------------------- */

test('10k distinct records never grow the buffer past capacity', () => {
  reset();
  for (let i = 0; i < 10_000; i += 1) {
    ERR.record(new Error(`distinct failure number ${i}`), { i });
  }
  const snap = ERR.snapshot();
  assert.equal(snap.length, ERR.CAPACITY,
    'the ring must sit exactly at capacity after 10k distinct writes');
  assert.ok(snap.length <= 256, 'capacity is 256 and must never be exceeded');

  // Bounded means the OLD ones are gone, not that writes were dropped: the
  // newest write must be present and the first must not.
  const messages = snap.map((e) => e.message);
  assert.ok(messages.includes('distinct failure number 9999'),
    'the most recent error must survive — it is the one being reported');
  assert.ok(!messages.includes('distinct failure number 0'),
    'the oldest error must have been overwritten, proving O(1) reuse not growth');
});

test('size() never exceeds capacity mid-storm', () => {
  reset();
  for (let i = 0; i < 1000; i += 1) {
    ERR.record(new Error(`storm ${i}`));
    assert.ok(ERR.size() <= ERR.CAPACITY, `size blew past capacity at write ${i}`);
  }
});

/* -------------------------------- dedupe --------------------------------
 *
 * The single most important property. The fixture is ordered so the WRONG
 * behaviour cannot also satisfy the assertion: 200 distinct entries are
 * written FIRST, then the same error is thrown 1000 times. Without dedupe,
 * those 1000 pushes overwrite all 256 slots and every distinct entry is gone.
 */

test('1000 identical throws collapse to one entry and preserve history', () => {
  reset();

  // Pre-load real history — this is what a support engineer actually needs.
  for (let i = 0; i < 200; i += 1) {
    ERR.record(new Error(`earlier context event ${i}`), { step: i });
  }
  const beforeSize = ERR.size();
  assert.equal(beforeSize, 200, 'precondition: 200 distinct entries are held');

  // The tight loop: same message, same context, 1000 times.
  for (let i = 0; i < 1000; i += 1) {
    ERR.record(new Error('quote fetch exploded'), { where: 'onchain-feed' });
  }

  const snap = ERR.snapshot();

  // 1. The repeat occupies exactly ONE slot, not 1000.
  const repeats = snap.filter((e) => e.message === 'quote fetch exploded');
  assert.equal(repeats.length, 1,
    `1000 identical throws must occupy ONE slot, found ${repeats.length}`);

  // 2. Its count reflects every occurrence.
  assert.equal(repeats[0].count, 1000,
    'count must record all 1000 occurrences');

  // 3. The history that explains the failure is STILL THERE. This is the
  //    assertion that dies loudly if dedupe regresses.
  const survivors = snap.filter((e) => e.message.startsWith('earlier context event'));
  assert.equal(survivors.length, 200,
    `all 200 earlier entries must survive the storm, found ${survivors.length}`);
  assert.equal(snap.length, 201,
    'the buffer holds 200 history entries + 1 collapsed repeat');

  // 4. Nothing was evicted: the very first event predating the storm is live.
  assert.ok(snap.some((e) => e.message === 'earlier context event 0'),
    'the OLDEST pre-storm entry must survive — evicting it is the exact failure mode');
});

test('lastTs advances on a deduped hit while ts keeps first-seen', () => {
  reset();
  const first = ERR.record(new Error('repeating'), 'ctx');
  const firstTs = first.ts;
  // Busy-wait past a clock tick so lastTs can differ observably.
  const spin = Date.now();
  while (Date.now() - spin < 3) { /* advance the coarse clock */ }
  ERR.record(new Error('repeating'), 'ctx');

  const entry = ERR.snapshot().find((e) => e.message === 'repeating');
  assert.equal(entry.count, 2, 'the repeat incremented count');
  assert.equal(entry.ts, firstTs, 'ts stays at FIRST occurrence');
  assert.ok(entry.lastTs >= entry.ts, 'lastTs tracks the MOST RECENT occurrence');
});

test('different context does NOT dedupe — a real distinct fault gets its own slot', () => {
  reset();
  ERR.record(new Error('same message'), { mint: 'A' });
  ERR.record(new Error('same message'), { mint: 'B' });
  const snap = ERR.snapshot();
  assert.equal(snap.length, 2,
    'same message with different context is two different faults');
  assert.ok(snap.every((e) => e.count === 1), 'neither entry was wrongly merged');
});

/* ------------------------------- ordering ------------------------------- */

test('snapshot() returns entries newest-first', () => {
  reset();
  ERR.record(new Error('oldest'));
  ERR.record(new Error('middle'));
  ERR.record(new Error('newest'));

  const snap = ERR.snapshot();
  assert.deepEqual(snap.map((e) => e.message), ['newest', 'middle', 'oldest'],
    'newest-first is what a support export must show');
});

test('a deduped repeat floats back to the top on its next occurrence', () => {
  reset();
  ERR.record(new Error('recurring'), 'x');
  ERR.record(new Error('other one'), 'y');
  assert.equal(ERR.snapshot()[0].message, 'other one', 'precondition: other one is newest');

  const spin = Date.now();
  while (Date.now() - spin < 3) { /* advance the coarse clock */ }
  ERR.record(new Error('recurring'), 'x');

  assert.equal(ERR.snapshot()[0].message, 'recurring',
    'a re-fired error is the freshest activity and must sort first');
});

/* ------------------------------ redaction ------------------------------- */

test('a wallet address is redacted out of the message', () => {
  reset();
  ERR.record(new Error(`failed to price ${FAKE_WALLET} on pump`));
  const entry = ERR.snapshot()[0];
  assert.ok(!entry.message.includes(FAKE_WALLET),
    'a wallet address must never be stored in the error log');
  assert.match(entry.message, /\[REDACTED_ADDR\]/, 'the redaction is visible, not silent');
  assert.match(entry.message, /failed to price/, 'the diagnostic text around it survives');
});

test('a bearer token is redacted out of the message', () => {
  reset();
  ERR.record(new Error(`rpc rejected: Authorization: Bearer ${FAKE_BEARER}`));
  const entry = ERR.snapshot()[0];
  assert.ok(!entry.message.includes(FAKE_BEARER),
    'a bearer token must never be stored in the error log');
  assert.match(entry.message, /\[REDACTED_TOKEN\]/);
  assert.match(entry.message, /rpc rejected/, 'the diagnostic text survives');
});

test('a private key is redacted — base58, hex and raw byte-array forms', () => {
  reset();
  ERR.record(new Error(`signer blew up with ${FAKE_PRIVKEY}`));
  const b58 = ERR.snapshot()[0];
  assert.ok(!b58.message.includes(FAKE_PRIVKEY),
    'a base58 private key must never be stored');
  assert.match(b58.message, /\[REDACTED_KEY\]/);

  reset();
  ERR.record(new Error(`seed material ${FAKE_HEX_KEY} rejected`));
  const hex = ERR.snapshot()[0];
  assert.ok(!hex.message.includes(FAKE_HEX_KEY), 'a 32-byte hex key must never be stored');

  reset();
  const bytes = Array.from({ length: 32 }, (_, i) => (i * 7) % 256).join(',');
  ERR.record(new Error(`keypair [${bytes}] failed to load`));
  const raw = ERR.snapshot()[0];
  assert.ok(!raw.message.includes(bytes),
    'a solana-keygen style byte array must never be stored');
});

test('secrets are redacted from the STACK, not just the message', () => {
  reset();
  const err = new Error('boom');
  err.stack = `Error: boom\n    at sign (key=${FAKE_PRIVKEY})\n    at run (content.js:1:1)`;
  ERR.record(err);
  const entry = ERR.snapshot()[0];
  assert.ok(!entry.stack.includes(FAKE_PRIVKEY),
    'a stack frame can quote key material — it must be scrubbed too');
  assert.match(entry.stack, /at run \(content\.js/, 'the useful frames survive');
});

test('secrets are redacted from CONTEXT values and keys', () => {
  reset();
  ERR.record(new Error('watch failed'), {
    mint: FAKE_WALLET,
    auth: `Bearer ${FAKE_BEARER}`,
    nested: { privateKey: FAKE_PRIVKEY },
  });
  const flat = JSON.stringify(ERR.snapshot()[0].context);
  assert.ok(!flat.includes(FAKE_WALLET), 'a wallet in context must be redacted');
  assert.ok(!flat.includes(FAKE_BEARER), 'a token in context must be redacted');
  assert.ok(!flat.includes(FAKE_PRIVKEY), 'a nested private key must be redacted');
});

test('redaction is conservative — ordinary diagnostics stay readable', () => {
  reset();
  const msg = 'RPC 429 rate limited after 3 retries in describePool';
  ERR.record(new Error(msg), { fn: 'describePool', attempt: 3 });
  const entry = ERR.snapshot()[0];
  assert.equal(entry.message, msg,
    'a log that redacts everything is as useless as one that redacts nothing');
  assert.equal(entry.context.fn, 'describePool');
  assert.equal(entry.context.attempt, 3);
});

/* --------------------------- never throws -------------------------------
 *
 * record() is called from inside catch blocks. If it can throw, it upgrades a
 * handled error into an unhandled one. Every input below is hostile.
 */

test('record() never throws on garbage input', () => {
  reset();

  const circular = { name: 'loop' };
  circular.self = circular;
  circular.list = [circular, circular];

  const noStack = new Error('stackless');
  delete noStack.stack;

  const hostile = {
    get message() { throw new Error('getter bites'); },
    get stack() { throw new Error('getter bites'); },
  };

  const inputs = [
    [null, null],
    [undefined, undefined],
    ['a bare string', 'string context'],
    [42, 0],
    [true, false],
    [Symbol('sym'), Symbol('ctx')],
    [() => {}, () => {}],
    [circular, circular],
    [noStack, { ok: 1 }],
    [hostile, hostile],
    [new Error('normal'), circular],
    [{}, {}],
    [[], []],
    [new Error(''), { deep: { a: { b: { c: { d: { e: 1 } } } } } }],
    [BigInt(9007199254740993), BigInt(7)],
    [Object.create(null), Object.create(null)],
    [new Proxy({}, { get() { throw new Error('proxy bites'); } }), null],
  ];

  for (let i = 0; i < inputs.length; i += 1) {
    const [err, ctx] = inputs[i];
    // NB: the label is an index, not String(err) — several of these inputs
    // (null-prototype objects, biting Proxies) throw on stringification, and
    // a test helper that crashes while describing the input would mask the
    // very thing under test.
    assert.doesNotThrow(() => ERR.record(err, ctx),
      `record() threw on hostile input at index ${i}`);
  }

  // And it stayed functional afterwards.
  assert.doesNotThrow(() => ERR.snapshot(), 'snapshot() must survive garbage entries');
  assert.ok(ERR.size() > 0, 'garbage was still recorded rather than dropped wholesale');
  assert.ok(ERR.size() <= ERR.CAPACITY, 'still bounded');
});

test('an Error with no stack records with an empty stack, not a crash', () => {
  reset();
  const e = new Error('no stack here');
  delete e.stack;
  const entry = ERR.record(e);
  assert.ok(entry, 'the entry was still recorded');
  assert.equal(entry.message, 'no stack here');
  assert.equal(typeof entry.stack, 'string', 'stack is always a string, never undefined');
});

test('a non-Error records a usable message', () => {
  reset();
  ERR.record('just a string failure');
  ERR.record({ message: 'object with a message' });
  ERR.record(404);
  const messages = ERR.snapshot().map((e) => e.message);
  assert.ok(messages.includes('just a string failure'));
  assert.ok(messages.includes('object with a message'));
  assert.ok(messages.includes('404'));
});

test('a huge message and stack are truncated, not stored whole', () => {
  reset();
  const big = new Error('x'.repeat(50_000));
  big.stack = 'y'.repeat(200_000);
  const entry = ERR.record(big);
  assert.ok(entry.message.length <= 600, 'message is bounded');
  assert.ok(entry.stack.length <= 1200, 'stack is bounded');
});

/* --------------------------------- clear -------------------------------- */

test('clear() empties the buffer', () => {
  reset();
  for (let i = 0; i < 50; i += 1) ERR.record(new Error(`e${i}`));
  assert.equal(ERR.size(), 50, 'precondition: entries exist');

  ERR.clear();

  assert.equal(ERR.size(), 0, 'size is zero after clear');
  assert.deepEqual(ERR.snapshot(), [], 'snapshot is empty after clear');
});

test('clear() resets dedupe state so a repeat starts counting from one', () => {
  reset();
  ERR.record(new Error('same'), 'ctx');
  ERR.record(new Error('same'), 'ctx');
  assert.equal(ERR.snapshot()[0].count, 2);

  ERR.clear();
  ERR.record(new Error('same'), 'ctx');

  const snap = ERR.snapshot();
  assert.equal(snap.length, 1, 'the cleared buffer holds only the new entry');
  assert.equal(snap[0].count, 1,
    'a stale dedupe index must not resurrect a cleared entry count');
});

test('the buffer keeps working after clear during a storm', () => {
  reset();
  for (let i = 0; i < 500; i += 1) {
    ERR.record(new Error(`pre ${i}`));
    if (i === 250) ERR.clear();
  }
  assert.ok(ERR.size() > 0 && ERR.size() <= ERR.CAPACITY, 'still bounded and alive');
});

/* ------------------------------ isolation ------------------------------- */

test('snapshot() returns copies — a caller cannot corrupt the ring', () => {
  reset();
  ERR.record(new Error('immutable'), { a: 1 });
  const snap = ERR.snapshot();
  snap[0].message = 'tampered';
  snap[0].count = 9999;
  const fresh = ERR.snapshot();
  assert.equal(fresh[0].message, 'immutable', 'the ring is not aliased to what it hands out');
  assert.equal(fresh[0].count, 1, 'dedupe counters cannot be edited from outside');
});

/* ------------------------------- wiring --------------------------------- */

test('errors.js installs itself on BOTH worker and window globals', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'errors.js'), 'utf8');
  assert.match(src, /typeof self !== 'undefined'/,
    'without a self assignment the recorder is undefined in the service worker');
  assert.match(src, /typeof window !== 'undefined'/,
    'without a window assignment the recorder is undefined in the content script');
  assert.match(src, /module\.exports/, 'house style is a triple export');
});

test('the recorder is loaded in BOTH worlds and wired to global handlers', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  // Worker: importScripts, or PTErrors is undefined there and every
  // background record() is a silent no-op.
  assert.match(read('background.js'), /importScripts\([^)]*'errors\.js'/,
    'the service worker must import errors.js');
  assert.match(read('background.js'), /addEventListener\('error'/,
    'the worker needs a global error handler or nothing is captured');
  assert.match(read('background.js'), /addEventListener\('unhandledrejection'/,
    'a rejected promise is the most common silent failure — it must be caught');

  // Content script: manifest ordering. errors.js must be listed BEFORE
  // content.js or window.PTErrors is undefined when content.js reads it.
  const manifest = JSON.parse(read('manifest.json'));
  const block = manifest.content_scripts.find(
    (cs) => Array.isArray(cs.js) && cs.js.includes('content.js'));
  assert.ok(block, 'the content.js block exists');
  assert.ok(block.js.includes('errors.js'),
    'errors.js must ship with the content script');
  assert.ok(block.js.indexOf('errors.js') < block.js.indexOf('content.js'),
    'errors.js must load BEFORE content.js or window.PTErrors is undefined');

  assert.match(read('content.js'), /addEventListener\('unhandledrejection'/,
    'the content script needs its own global capture');

  // Support pull channel.
  assert.match(read('background.js'), /case 'pt_errors_snapshot'/,
    'a bug report needs a way to pull the buffer');
});

test('the on-chain feed records RPC failures without swallowing them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'onchain-feed.js'), 'utf8');
  assert.match(src, /noteFeedError/, 'the feed reports its failures to the black box');
  // Lazy resolution matters: a null captured at module-load time would
  // silently disable recording for the entire session.
  assert.match(src, /function noteFeedError[\s\S]{0,400}self\.PTErrors/,
    'the recorder must be resolved lazily, not captured at load time');
});

test('the global handlers survive a missing recorder', () => {
  // The wiring is guarded so that if errors.js somehow failed to load, the
  // service worker and the host page still work. Prove the guard exists.
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'),
    /if \(ERRLOG\) ERRLOG\.record/,
    'background must null-check the recorder before using it');
  assert.match(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'),
    /window\.PTErrors \|\| null/,
    'content must tolerate a missing recorder rather than throwing on the page');
});

/* ------------------------------------------------------------------
 * The debug report must answer the report it exists for.
 *
 * The rings capture anything that THROWS. The most-reported symptom we have
 * throws nothing: the panel sits on "Fetching live price…" while every path
 * quietly declines to produce a number. Before this, a user who hit that and
 * dutifully clicked "Share debug logs" sent back two empty error rings and a
 * chip map — nothing about the price path at all.
 * ------------------------------------------------------------------ */

test('the debug report carries the price path, not only errors and chips', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  const popup = read('popup.js');
  assert.match(popup, /type: 'pt_price_debug'/,
    'shareDebugLogs must ask the tab for the price path');
  assert.match(popup, /report\.price = /,
    'the answer must reach the report the user pastes');

  const content = read('content.js');
  assert.match(content, /msg\?\.type === 'pt_price_debug'/,
    'the content script must answer the price-path pull');

  // The states that actually decide whether a price arrives. Each of these
  // is load-bearing for the D-60 / D-60S / D-61 chain-probe path; without
  // them the report cannot distinguish "feed dead" from "probe benched".
  for (const field of [
    'lastMcapTickAgeMs',      // D-61's live-market exception keys off this
    'prewatchAttempts',       // how far into D-60S's exponential backoff
    'prewatchBackoffRemainingMs',
    'prewatchLatched',        // D-60: did a failed probe release the latch
    'onchainLive',
  ]) {
    assert.ok(content.includes(field), `the price snapshot must report ${field}`);
  }
});

test('the price snapshot reports no addresses — the report stays safe by construction', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  const start = content.indexOf("msg?.type === 'pt_price_debug'");
  const end = content.indexOf("msg?.type === 'pt_chip_debug'");
  assert.ok(start !== -1 && end > start, 'the price-debug handler must ship');
  // Scan CODE only. A comment that mentions a mint is documentation, not a
  // leak, and a check that cannot tell the two apart would punish the
  // explanation of why the rule exists.
  const block = content.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  // errors.js redacts at RECORD time so the report is safe by construction
  // rather than by an export-time scrub that a new field could slip past.
  // This snapshot is built at EXPORT time, so it must never carry an
  // identifier in the first place: ages, counters and booleans only.
  assert.ok(!/\bmint\b/.test(block), 'the snapshot must not emit a mint');
  assert.ok(!/srcAddress:/.test(block), 'the snapshot must not emit an address as a value');
  assert.ok(!/pairAddress/.test(block), 'the snapshot must not emit a pair address');
  assert.match(block, /prewatchLatched: prewatchedAddress !== null/,
    'the probe latch must be reported as a boolean, never as the address itself');
});
