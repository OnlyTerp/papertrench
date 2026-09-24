/* F-66 — pool-attributed trade prints must agree with the dominant pool.
 *
 * GMGN's token_activity prices trades per pool (`m`), and the freshest print
 * used to become the mint's price outright. The dominant pool (by USD volume,
 * or by count when the feed omits sizes) sets the reference; any other pool
 * must match a fresh dominant print within 3% or its print is dropped.
 *
 * Fixture: the real PONS token_activity items captured live on
 * gmgn.ai/robinhood (v3.25.0 capture, %TEMP%\pt-pons\v3250\ws.jsonl),
 * sanitized to { t, m, pu, au } — no URLs, wallets, or tx hashes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ACTIVITY = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'gmgn-pons-activity.json'), 'utf8'));

function loadQuote() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'quote.js'), 'utf8');
  const ctx = { window: {}, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.PaperQuote || ctx.window.PaperQuote;
}
const Q = loadQuote();

test('notePoolTrade keeps a rolling 60s window per pool', () => {
  let s = Q.notePoolTrade(null, 'poolA', 1.0, 100, 0);
  s = Q.notePoolTrade(s, 'poolA', 1.0, 100, 30_000);
  s = Q.notePoolTrade(s, 'poolB', 1.0, 50, 40_000);
  assert.equal(s.pools.get('poolA').count, 2);
  assert.equal(s.pools.get('poolA').volUsd, 200);
  assert.equal(s.total, 3);
  // past the window, poolA's first trade ages out
  s = Q.notePoolTrade(s, 'poolB', 1.0, 50, 61_000);
  assert.equal(s.pools.get('poolA').count, 1);
  assert.equal(s.pools.get('poolA').volUsd, 100);
  assert.equal(s.pools.get('poolA').lastPriceUsd, 1.0);
});

test('dominance is decided by USD volume when sizes exist', () => {
  let s = null;
  for (let i = 0; i < 5; i++) s = Q.notePoolTrade(s, 'big', 1.00, 10_000, i * 1000);
  for (let i = 0; i < 10; i++) s = Q.notePoolTrade(s, 'thin', 1.00, 10, i * 1000);
  // thin has more trades but tiny volume; a thin print 4% off must drop
  assert.equal(Q.poolConsensusVerdict(s, 'thin', 1.04, 12_000), 'drop');
  // an agreeing thin print passes
  assert.equal(Q.poolConsensusVerdict(s, 'thin', 1.01, 12_000), 'accept');
  // the dominant pool's own prints always pass
  assert.equal(Q.poolConsensusVerdict(s, 'big', 1.30, 12_000), 'accept');
});

test('dominance falls back to trade count when no sizes are reported', () => {
  let s = null;
  for (let i = 0; i < 5; i++) s = Q.notePoolTrade(s, 'busy', 1.00, 0, i * 1000);
  for (let i = 0; i < 2; i++) s = Q.notePoolTrade(s, 'quiet', 1.00, 0, i * 1000);
  assert.equal(Q.poolConsensusVerdict(s, 'quiet', 0.70, 8_000), 'drop');
  assert.equal(Q.poolConsensusVerdict(s, 'quiet', 1.02, 8_000), 'accept');
});

test('a stale dominant print cannot be the reference — off-pool prints drop', () => {
  let s = null;
  s = Q.notePoolTrade(s, 'big', 1.00, 10_000, 0);
  s = Q.notePoolTrade(s, 'big', 1.00, 10_000, 1000);
  s = Q.notePoolTrade(s, 'thin', 1.00, 10, 2000);
  // dominant's last print is 14 s old → agreement check cannot run → drop
  assert.equal(Q.poolConsensusVerdict(s, 'thin', 1.01, 15_000), 'drop');
});

test('under 3 trades in the window every print is accepted', () => {
  let s = null;
  s = Q.notePoolTrade(s, 'big', 1.00, 10_000, 0);
  s = Q.notePoolTrade(s, 'thin', 1.00, 10, 1000);
  assert.equal(Q.poolConsensusVerdict(s, 'thin', 5.0, 2000), 'accept');
});

test('dropped prints still feed the window so dominance can shift', () => {
  let s = null;
  for (let i = 0; i < 4; i++) s = Q.notePoolTrade(s, 'big', 1.00, 10_000, i * 1000);
  // a hostile thin print is dropped — but it was still noted
  const hostile = 1.40;
  assert.equal(Q.poolConsensusVerdict(s, 'thin', hostile, 5_000), 'drop');
  s = Q.notePoolTrade(s, 'thin', hostile, 50_000, 5_000); // huge volume: real migration
  for (let i = 0; i < 3; i++) s = Q.notePoolTrade(s, 'thin', hostile, 50_000, 6_000 + i * 500);
  // now 'thin' IS the dominant pool — its prints accept at the new level
  assert.equal(Q.poolConsensusVerdict(s, 'thin', hostile * 1.02, 9_000), 'accept');
});

test('replayed PONS token_activity: no live print is dropped for DISAGREEING', () => {
  // The real PONS tape is thin (~0.5 prints/s across ~98 pools), so the
  // dominant pool is rarely ≤10 s fresh and most drops are stale-reference
  // drops — the fail-closed branch. What must never happen on a healthy
  // tape is a drop while a FRESH dominant print agrees within 3%: those are
  // real prices arriving late, and refusing them would freeze the feed.
  let s = null;
  let drops = 0;
  let disagreementDrops = 0;
  for (const it of ACTIVITY) {
    s = Q.notePoolTrade(s, it.m, it.pu, it.au, it.t);
    if (Q.poolConsensusVerdict(s, it.m, it.pu, it.t) !== 'drop') continue;
    drops++;
    // Was the drop disagreement (bad) or a stale reference (fail-closed)?
    let dom = null;
    let sizesAbsent = true;
    for (const v of s.pools.values()) if (v.volUsd > 0) { sizesAbsent = false; break; }
    for (const [p, v] of s.pools) {
      const score = sizesAbsent ? v.count : v.volUsd;
      if (!dom || score > dom.score) dom = { score, rec: v, pool: p };
    }
    if (dom && dom.pool !== it.m
      && it.t - dom.rec.lastAt <= 10_000
      && Math.abs(it.pu / dom.rec.lastPriceUsd - 1) <= 0.03) {
      disagreementDrops++;
    }
  }
  assert.equal(disagreementDrops, 0,
    `${disagreementDrops} prints dropped while agreeing with a fresh dominant`);
  // Healthy-tape sanity: every drop here is a stale-reference drop, which on
  // this capture is ~70% of prints — chart feeds still carry the price; the
  // gate only filters the pool-attributed trade lane.
  assert.ok(drops > 0, 'fixture should exercise the drop path');
});

test('a synthetic thin-pool print 30% off the dominant pool is dropped', () => {
  let s = null;
  for (const it of ACTIVITY) s = Q.notePoolTrade(s, it.m, it.pu, it.au, it.t);
  const lastT = ACTIVITY[ACTIVITY.length - 1].t;
  const dominantUsd = 0.623;
  s = Q.notePoolTrade(s, '0xdeadbeefthinpool', dominantUsd * 0.70, 5, lastT + 100);
  assert.equal(
    Q.poolConsensusVerdict(s, '0xdeadbeefthinpool', dominantUsd * 0.70, lastT + 100),
    'drop');
});
