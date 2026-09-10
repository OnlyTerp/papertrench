/* Screen recordings in the replay view.
 *
 * Reported defect: a round WAS screen-recorded, but the dashboard replay still
 * showed only still frames. Cause — the recorder downloaded the video to disk
 * and stored just the filename string, so the dashboard had no video to play.
 *
 * These tests pin the pieces that make playback correct: the video is persisted,
 * a replay moment maps onto the right position inside it, and the video takes
 * precedence over screenshots when it exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RC = require('../recordings.js');

/* ---------------- mapping a moment onto the video ---------------- */

const RECORDING = { id: 'r1', startedAt: 1_000_000, endedAt: 1_300_000 }; // 5 min

test('a replay moment maps onto the matching position inside the video', () => {
  // Derived from the recording bounds, not pasted.
  assert.equal(RC.offsetForMoment(RECORDING, 1_000_000), 0, 'the start maps to 0s');
  assert.equal(RC.offsetForMoment(RECORDING, 1_060_000), 60, 'one minute in maps to 60s');
  assert.equal(RC.offsetForMoment(RECORDING, 1_300_000), 300, 'the end maps to the full length');
});

test('a moment outside the recorded window yields no seek rather than a wrong frame', () => {
  assert.equal(RC.offsetForMoment(RECORDING, 999_000), null,
    'before recording began there is nothing truthful to show');
  assert.equal(RC.offsetForMoment(RECORDING, 1_400_000), null,
    'after recording ended the video cannot depict the moment');
});

test('offsetForMoment refuses to guess when the bounds are unusable', () => {
  assert.equal(RC.offsetForMoment(null, 1_000_000), null);
  assert.equal(RC.offsetForMoment({ startedAt: 0 }, 1_000_000), null);
  assert.equal(RC.offsetForMoment(RECORDING, 0), null);
  assert.equal(RC.offsetForMoment(RECORDING, NaN), null);
});

test('a recording with no end bound still seeks forward', () => {
  // A recording interrupted by a crash may never get an end timestamp.
  const open = { id: 'r2', startedAt: 1_000_000, endedAt: 0 };
  assert.equal(RC.offsetForMoment(open, 1_090_000), 90);
});

/* ---------------- metadata never carries the blob ---------------- */

test('listed metadata excludes the video payload', () => {
  const entry = {
    id: 'r1', sessionId: 'pts-1', symbol: 'BONK', file: 'x.webm',
    startedAt: 1, endedAt: 2, mimeType: 'video/webm', size: 1234,
    savedAt: 9, blob: { size: 1234, type: 'video/webm' },
  };
  const meta = RC.meta(entry);
  assert.equal(meta.size, 1234);
  assert.equal(meta.file, 'x.webm');
  assert.equal(meta.blob, undefined,
    'metadata must not drag megabytes of video around');
});

/* ---------------- the recorder actually persists the video ---------------- */

test('the offscreen recorder stores the blob, not just a filename', () => {
  const src = fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8');

  assert.match(src, /PTRecordings/,
    'the recorder must hand the video to the store');
  assert.match(src, /startedAt/,
    'a start timestamp is required to seek into the recording later');
  assert.match(src, /blob,/,
    'the actual Blob must be persisted, not only its name');
});

test('the offscreen document loads the recording store before the recorder', () => {
  const html = fs.readFileSync(path.join(ROOT, 'offscreen.html'), 'utf8');
  const storeAt = html.indexOf('recordings.js');
  const recorderAt = html.indexOf('offscreen.js');
  assert.ok(storeAt >= 0, 'the offscreen page must load the recording store');
  assert.ok(storeAt < recorderAt, 'the store must be available when the recorder runs');
});

// Playable metadata (and its stored:false case) is exercised through the
// real worker in background.test.js, including concurrent fills and resets.

/* ---------------- the dashboard prefers video over stills ---------------- */

test('the replay view shows the recording instead of screenshots when one exists', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  // D-46: the dead renderMomentMedia copy was deleted; the LIVE media
  // renderer is syncReplayMedia, so the same contract is pinned there.
  const fn = src.slice(src.indexOf('function syncReplayMedia'), src.indexOf('function replayRecording'));
  assert.ok(fn.length > 0, 'the media renderer must exist');

  // The video branch must be reached BECAUSE a recording exists — not because
  // of source ordering. Guarding on a constant would silently disable it.
  const guard = /const useVideo = Boolean\(recording\) && !\(preferFrameOverVideo && relatedFrame\);/.exec(fn);
  assert.ok(guard,
    'the video branch must be entered whenever a recording exists and the ' +
    'user has not explicitly asked for the still frame');

  const videoAt = fn.indexOf('replay-video');
  const frameAt = fn.lastIndexOf('replay-frame');
  assert.ok(videoAt >= 0 && frameAt > videoAt,
    'a screen recording must take precedence over still frames');
  assert.match(fn, /offsetForMoment/,
    'the video must be seeked to the replayed moment, not started from zero');
});

test('the dashboard seeks the video to the selected moment', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(src, /currentTime = /,
    'scrubbing the timeline must move the video with it');
  assert.match(src, /loadedmetadata/,
    'seeking must wait for metadata rather than silently failing');
});

test('object URLs are created once per recording rather than per render', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  // D-46: the end marker was the dead renderReplayTape, now deleted.
  const fn = src.slice(src.indexOf('function recordingUrl'), src.indexOf('function eventIcon'));
  assert.match(fn, /recordingUrls\[recording\.id\]/,
    'the replay re-renders on every tick; minting a new URL each time would leak');
});

/* ---------------- the store must never hang its caller ---------------- */

/*
 * Found by loading the real dashboard in a headless browser: the page rendered
 * nothing at all, with no error in the console. `loadAll()` awaited the
 * recording store, the store awaited `indexedDB.open()`, and that open request
 * never fired success, error, OR blocked. Every promise in the chain stayed
 * pending, so the dashboard sat permanently blank.
 *
 * IndexedDB really does stall: another tab holding an older version open fires
 * `onblocked` and then waits forever, and private-mode / corrupt-profile /
 * file:// contexts can drop the request entirely. So the store must bound its
 * own wait, and the dashboard must not make the first paint depend on it.
 *
 * These tests drive the SHIPPED `openDb()` through `list()` against fake
 * IndexedDB objects that reproduce each stall.
 */

/** Swap in a fake indexedDB for one call, always restoring the real global. */
async function withIndexedDb(fake, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'indexedDB');
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = fake;
  try {
    return await run();
  } finally {
    if (had) globalThis.indexedDB = previous;
    else delete globalThis.indexedDB;
  }
}

/** Resolves to 'settled' if the promise finishes first, 'hung' if the clock wins. */
function raceAgainstClock(promise, ms) {
  let timer;
  const clock = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), ms); });
  return Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    clock,
  ]).finally(() => clearTimeout(timer));
}

test('an open request that never answers is abandoned instead of hanging forever', async () => {
  // The exact browser behaviour observed: open() returns a request whose
  // handlers are never invoked.
  const silent = { open: () => ({}) };

  const outcome = await withIndexedDb(silent, async () => {
    const started = Date.now();
    const result = await raceAgainstClock(RC.list(), 15_000);
    return { result, elapsed: Date.now() - started };
  });

  assert.equal(outcome.result, 'settled',
    'a silent IndexedDB must not leave the caller pending; the dashboard awaits this');
  assert.ok(outcome.elapsed < 15_000,
    `the store must give up on its own; waited ${outcome.elapsed}ms`);
});

test('a blocked open is surfaced rather than waited out', async () => {
  // Another tab holds an older version open: onblocked fires, nothing follows.
  const blocked = {
    open: () => {
      const request = {};
      setImmediate(() => { if (request.onblocked) request.onblocked(); });
      return request;
    },
  };

  const outcome = await withIndexedDb(blocked, async () => {
    const started = Date.now();
    const result = await raceAgainstClock(RC.list(), 4_000);
    return { result, elapsed: Date.now() - started };
  });

  assert.equal(outcome.result, 'settled', 'a blocked open must settle');
  assert.ok(outcome.elapsed < 3_000,
    `onblocked must resolve immediately, not fall through to the timeout; took ${outcome.elapsed}ms`);
});

test('an open() that throws outright fails fast, and the dashboard degrades to no recordings', async () => {
  // Some contexts throw synchronously from open() (a SecurityError in a
  // sandboxed or private-mode frame). The store must turn that into a rejected
  // promise immediately rather than leaving one pending behind the timeout.
  const throwing = { open: () => { throw new Error('SecurityError'); } };

  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const outcome = await withIndexedDb(throwing, async () => {
    const started = Date.now();
    let rejected = false;
    await RC.list().catch(() => { rejected = true; });
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    return { rejected, elapsed: Date.now() - started, pendingTimers: timersAfter - timersBefore };
  });

  assert.equal(outcome.rejected, true, 'an unusable store must report failure, not resolve with junk');
  assert.ok(outcome.elapsed < 1_000,
    `a synchronous throw must not wait out the open timeout; took ${outcome.elapsed}ms`);

  // The rejection alone is not enough: the open timeout must also be cleared.
  // A throw that escapes the executor rejects the promise but leaves the timer
  // armed, holding a callback (and in a browser, the closure it captures) for
  // the full timeout after the caller has already given up.
  assert.equal(outcome.pendingTimers, 0,
    'a failed open must not leave its timeout armed; the timer was still pending');

  // And the only consumer must survive that rejection.
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function loadRecordings'), src.indexOf('function recordingUrl'));
  assert.ok(fn.length > 0, 'loadRecordings must exist');
  assert.match(fn, /catch[\s\S]*recordings = \{\}/,
    'an IndexedDB failure must leave the dashboard with no recordings, not a broken page');
});

test('the dashboard paints before recordings finish loading', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function loadAll'), src.indexOf('async function saveSettings'));
  assert.ok(fn.length > 0, 'loadAll must exist');
  assert.ok(!/await\s+loadRecordings\(\)/.test(fn),
    'awaiting the recording store inside loadAll makes the first paint depend on ' +
    'IndexedDB; a stalled database then leaves the whole dashboard blank');
  assert.match(fn, /loadRecordings\(\)/,
    'recordings must still be loaded, just not blockingly');
});
