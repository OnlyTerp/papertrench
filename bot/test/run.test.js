/* PaperTrench onboarding bot — run.js wiring tests.
 *
 * Covers the three wiring defects found in the reliability wave:
 *   R-01  fetchMentions must paginate (meta.next_token) — a burst past the
 *         first page was silently dropped forever because since_id advanced
 *         past it in the same cycle.
 *   R-02  saveState must be atomic (tmp + rename) — a partial write must
 *         leave the PREVIOUS state intact, not corrupt it (a corrupted
 *         state.json loses the `replied` map => duplicate replies).
 *   R-03  backoff must log the real error (status/message), not [object Object].
 *
 * Run with:  cd bot && node --test
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { fetchMentions, saveState, loadState, backoff } = require('../run.js');

const CFG = {
  X_BEARER_TOKEN: 'test-bearer',
  POLL_SECONDS: 60,
};

/* ---- R-01: mention pagination -------------------------------------- */

test('fetchMentions follows meta.next_token pages instead of dropping them', async () => {
  const calls = [];
  const pageOne = {
    data: [
      { id: '301', author_id: 'a', conversation_id: 'c1', created_at: new Date().toISOString(), text: 'one' },
      { id: '300', author_id: 'a', conversation_id: 'c2', created_at: new Date().toISOString(), text: 'two' },
    ],
    meta: { next_token: 'PAGE2' },
  };
  const pageTwo = {
    data: [
      { id: '299', author_id: 'b', conversation_id: 'c3', created_at: new Date().toISOString(), text: 'three' },
    ],
    meta: {},
  };
  const orig = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    const isPage2 = String(url).includes('pagination_token=PAGE2');
    return {
      ok: true,
      status: 200,
      json: async () => (isPage2 ? pageTwo : pageOne),
    };
  };
  try {
    const out = await fetchMentions('12345', '250', CFG);
    assert.equal(out.length, 3, 'mentions from BOTH pages must come back (got ' + out.length + ')');
    assert.deepEqual(
      out.map((m) => m.id).sort(),
      ['299', '300', '301'],
      'every mention from every page arrives intact'
    );
    assert.equal(calls.length, 2, 'exactly two fetches (page 1 + page 2)');
    assert.ok(calls[1].includes('pagination_token=PAGE2'), 'second page requested with next_token');
  } finally {
    global.fetch = orig;
  }
});

/* ---- R-02: atomic state save --------------------------------------- */

test('saveState leaves the previous state readable when a write fails mid-way', () => {
  // The writer targets run.js's REAL STATE_DIR (bot/state) — which may hold a
  // live bot's state. The test never lets a byte reach it: every fs path that
  // points into the real state dir is REDIRECTED into a scratch dir at the fs
  // boundary. Pre-fix (direct STATE_FILE write) the ENOSPC lands ON the state
  // file and this test FAILS; post-fix (tmp+rename) the ENOSPC lands on the
  // tmp file and the state file survives byte-for-byte.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bot-state-'));
  const file = path.join(dir, 'state.json');
  const realStateDir = path.join(__dirname, '..', 'state');
  const realStateFile = path.join(realStateDir, 'state.json');
  const redirectTo = (p) => {
    const s = String(p);
    if (s === realStateFile) return file;
    if (s === realStateFile + '.tmp') return file + '.tmp';
    if (s === realStateDir) return dir;
    return p;
  };

  const good = { since_id: '100', replied: { 100: true }, bot_user_id: '42' };
  fs.writeFileSync(file, JSON.stringify(good) + '\n');

  const origWrite = fs.writeFileSync;
  const origExists = fs.existsSync;
  const origMkdir = fs.mkdirSync;
  const injected = path.join(dir, 'injected.tmp');
  fs.writeFileSync = (p, data, opts) => {
    const t = redirectTo(p);
    if (String(t).endsWith('.tmp')) {
      // Crash mid-write: half the bytes land, then the disk errors.
      origWrite(injected, String(data).slice(0, Math.floor(String(data).length / 2)));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return origWrite(t, data, opts);
  };
  fs.existsSync = (p) => origExists(redirectTo(p));
  fs.mkdirSync = (p, opts) => origMkdir(redirectTo(p), opts);
  try {
    assert.throws(() => saveState({ since_id: '200', replied: { 200: true } }), /ENOSPC/);
    const survived = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(survived.since_id, '100', 'previous state intact after failed save');
    assert.equal(survived.bot_user_id, '42', 'identity survives');
    assert.deepEqual(survived.replied, { 100: true }, 'replied map (duplicate-reply guard) survives');
    // The real state file must be untouched by the whole exercise.
    if (origExists(realStateFile)) {
      const live = JSON.parse(fs.readFileSync(realStateFile, 'utf8'));
      assert.notEqual(live.since_id, '200', 'test must never write the real bot state');
    }
  } finally {
    fs.writeFileSync = origWrite;
    fs.existsSync = origExists;
    fs.mkdirSync = origMkdir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run.js saveState uses tmp+rename (does not truncate the target on failure)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'run.js'), 'utf8');
  assert.ok(
    /renameSync|rename\(/.test(src),
    'saveState must write to a temp file and rename it over the target (atomic on POSIX and Windows)'
  );
  assert.ok(
    !new RegExp('writeFileSync\\(STATE_FILE').test(src),
    'saveState must not write STATE_FILE directly (non-atomic truncation-then-write)'
  );
});

/* ---- R-03: retry logging honesty ----------------------------------- */

test('backoff logs the real error, not [object Object]', async () => {
  const seen = [];
  const origErr = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  const origFetch = global.fetch;
  global.fetch = async () => { throw { retryAfterMs: 1, status: 429 }; };
  try {
    await assert.rejects(
      () => backoff(async () => { throw { retryAfterMs: 1, status: 429 }; }, CFG),
      /max retries/
    );
  } finally {
    console.error = origErr;
    global.fetch = origFetch;
  }
  const joined = seen.join('\n');
  assert.ok(!joined.includes('[object Object]'), 'retry log must not print [object Object]');
  assert.ok(joined.includes('429'), 'retry log must carry the HTTP status');
});
