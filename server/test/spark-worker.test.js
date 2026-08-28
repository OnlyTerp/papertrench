'use strict';
/* Daily Spark worker tests (DELIGHT-MAP.md A2) — server/worker/spark.js.
 *
 * Drives the REAL worker entry (worker.fetch) through a scripted D1 fake and
 * a mocked upstream, exactly like server/test/worker.test.js. Pins:
 *   - the blind law: /api/spark/today NEVER returns a bar after tTs
 *   - the memo law: the day's mint + T are pinned in D1, same for everyone
 *   - the grade law: deterministic verdict on (day, actions), no PnL figure
 *   - honesty: no pool / no data / no pick all return 404 with a reason
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const sparkWorker = require('../worker/spark.js');
const spark = require('../core/spark.js');

/* ---------------- harness ---------------- */

const ORIGIN = 'https://papertrench.com';
const MIN = 60000;

/** A chart with a real shape: flat, dip, run, giveback. */
function shapeChart({ bars = 200, flat = 120, dipLow = 90, runHigh = 140, endClose = 135, start = 1_700_000_000_000 } = {}) {
  const out = [];
  const dipAt = Math.floor(bars * 0.4);
  const topAt = Math.floor(bars * 0.75);
  for (let i = 0; i < bars; i++) {
    let c = flat;
    if (i < dipAt) {
      // linear bleed into the dip
      c = flat - ((dipAt - i) / dipAt) * (flat - dipLow);
    } else if (i < topAt) {
      // linear run to the top
      c = dipLow + ((i - dipAt) / (topAt - dipAt)) * (runHigh - dipLow);
    } else {
      // giveback toward endClose
      c = runHigh - ((i - topAt) / (bars - topAt)) * (runHigh - endClose);
    }
    const o = i === 0 ? flat : out[i - 1].c;
    const h = Math.max(o, c) * 1.005;
    const l = Math.min(o, c) * 0.995;
    out.push({ ts: start + i * MIN, o, h, l, c, v: 1000 + i });
  }
  return out;
}

/** Scripted D1: `route(sql, args)` decides every answer, and everything the
 * worker does is written to `log` so a test can assert HOW the store was
 * driven (same shape as worker.test.js's fakeDB). */
function fakeDB(route) {
  const log = [];
  const batches = [];
  const statement = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      get args() { return bound; },
      bind(...args) { bound = args; return stmt; },
      async first() { log.push({ sql, args: bound, via: 'first' }); return route(sql, bound) || null; },
      async all() {
        log.push({ sql, args: bound, via: 'all' });
        const rows = route(sql, bound);
        return { results: Array.isArray(rows) ? rows : [] };
      },
      async run() {
        log.push({ sql, args: bound, via: 'run' });
        const out = route(sql, bound);
        return out && out.meta ? out : { meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  return {
    log,
    batches,
    prepare: statement,
    batch: async (statements) => {
      batches.push(statements.map((s) => ({ sql: s.sql, args: s.args })));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function makeEnv(db) {
  return { DB: db, SITE_ORIGIN: ORIGIN, SITE_ORIGIN_ALT: '' };
}

async function loadWorker() {
  globalThis.caches = globalThis.caches || {
    default: { match: async () => undefined, put: async () => {} },
  };
  return (await import('../worker/index.js')).default;
}

/** Mock the upstream chart source: Indeix + GeckoTerminal both answer from
 * `charts` (mint -> chart). Records every upstream URL hit. */
function mockUpstream(charts) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const u = String(url);
    // Indeix ohlcv-history
    if (u.includes('/2/token/ohlcv-history')) {
      const address = new URL(u).searchParams.get('address');
      const chart = charts[address];
      if (!chart) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => chart };
    }
    // GeckoTerminal fallback (pools + ohlcv)
    if (u.includes('/pools?page=1')) {
      const mint = decodeURIComponent(u.split('/tokens/')[1].split('/')[0]);
      const pool = charts[mint] ? 'pool-' + mint : null;
      return { ok: true, status: 200, json: async () => ({ data: pool ? [{ attributes: { address: pool } }] : [] }) };
    }
    if (u.includes('/ohlcv/minute')) {
      const poolId = decodeURIComponent(u.split('/pools/')[1].split('/')[0]);
      const mint = poolId.replace('pool-', '');
      const chart = charts[mint];
      if (!chart) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({
        data: { attributes: { ohlcv_list: chart.map((c) => [c.ts / 1000, c.o, c.h, c.l, c.c, c.v]) } },
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

/* ---------------- tests ---------------- */

test('spark/today: blind law — no bar after the reveal moment', async () => {
  const chart = shapeChart();
  const db = fakeDB(() => null); // no memo, no pools rows yet
  const upstream = mockUpstream({ MintA: chart });
  try {
    const worker = await loadWorker();
    const env = makeEnv(db);
    // First: no memo, no pools -> no-pool 404 (honest).
    let res = await worker.fetch(new Request('https://api.test/api/spark/today'), env, { waitUntil: () => {} });
    assert.equal(res.status, 404);
    let body = await res.json();
    assert.equal(body.reason, 'no-pool');

    // Now a pools row exists (the replay feature resolved one) -> pick + memo.
    const db2 = fakeDB((sql) => {
      if (sql.includes('FROM pools')) return [{ mint: 'MintA' }];
      return null;
    });
    const env2 = makeEnv(db2);
    res = await worker.fetch(new Request('https://api.test/api/spark/today'), env2, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mint, 'MintA');
    assert.ok(body.tTs > 0, 'reveal moment is present');
    // BLIND LAW: every bar is at or before tTs.
    for (const bar of body.bars) {
      assert.ok(bar.ts <= body.tTs, 'bar after reveal moment leaked: ' + bar.ts);
    }
    assert.ok(body.bars.length >= 30, 'blind window is a real window');
    // The memo row was written.
    const memoWrites = db2.log.filter((l) => l.sql.includes('INSERT INTO spark_days'));
    assert.equal(memoWrites.length, 1, 'day memo must be written once');
    assert.equal(memoWrites[0].args[0], body.day);
    assert.equal(memoWrites[0].args[1], 'MintA');
  } finally {
    upstream.restore();
    delete globalThis.caches;
  }
});

test('spark/today: memo pins the day — same mint + T across requests', async () => {
  const chart = shapeChart();
  // The memo row exists from an earlier request.
  const tTs = chart[90].ts;
  const db = fakeDB((sql) => {
    if (sql.includes('FROM spark_days')) return { day: '2026-08-28', mint: 'MintA', t_ts: tTs };
    if (sql.includes('FROM pools')) return [];
    return null;
  });
  const upstream = mockUpstream({ MintA: chart });
  try {
    const worker = await loadWorker();
    const env = makeEnv(db);
    const res = await worker.fetch(new Request('https://api.test/api/spark/today'), env, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mint, 'MintA');
    assert.equal(body.tTs, tTs);
    // Blind law holds even on the memo path.
    for (const bar of body.bars) assert.ok(bar.ts <= tTs);
  } finally {
    upstream.restore();
    delete globalThis.caches;
  }
});

test('spark/grade: deterministic verdict, no PnL figure', async () => {
  const chart = shapeChart();
  const tTs = chart[90].ts;
  const db = fakeDB((sql) => {
    if (sql.includes('FROM spark_days')) return { day: '2026-08-28', mint: 'MintA', t_ts: tTs };
    return null;
  });
  const upstream = mockUpstream({ MintA: chart });
  try {
    const worker = await loadWorker();
    const env = makeEnv(db);
    const actions = [
      { type: 'buy', ts: tTs + MIN },
      { type: 'sell', ts: chart[150].ts },
    ];
    const res = await worker.fetch(new Request('https://api.test/api/spark/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ day: '2026-08-28', mint: 'MintA', actions }),
    }), env, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mint, 'MintA');
    assert.ok(['S', 'A', 'B', 'C', 'D', 'F'].includes(body.verdict.grade));
    assert.ok(body.verdict.axes && body.verdict.axes.length >= 2, 'axes present');
    assert.ok(!('pnl' in body.verdict) && !('profit' in body.verdict), 'NO PnL figure ever');
    // Determinism: same actions twice => same grade.
    const res2 = await worker.fetch(new Request('https://api.test/api/spark/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ day: '2026-08-28', mint: 'MintA', actions }),
    }), env, { waitUntil: () => {} });
    const body2 = await res2.json();
    assert.equal(body2.verdict.grade, body.verdict.grade);
  } finally {
    upstream.restore();
    delete globalThis.caches;
  }
});

test('spark/grade: wrong day / bad actions are honest 400s', async () => {
  const chart = shapeChart();
  const tTs = chart[90].ts;
  const db = fakeDB((sql) => {
    if (sql.includes('FROM spark_days')) return { day: '2026-08-28', mint: 'MintA', t_ts: tTs };
    return null;
  });
  const upstream = mockUpstream({ MintA: chart });
  try {
    const worker = await loadWorker();
    const env = makeEnv(db);
    // Wrong mint for the day.
    let res = await worker.fetch(new Request('https://api.test/api/spark/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ day: '2026-08-28', mint: 'MintB', actions: [{ type: 'buy', ts: tTs + MIN }] }),
    }), env, { waitUntil: () => {} });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'wrong-day');
    // Actions outside the window.
    res = await worker.fetch(new Request('https://api.test/api/spark/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ day: '2026-08-28', mint: 'MintA', actions: [{ type: 'buy', ts: tTs + 999 * MIN }] }),
    }), env, { waitUntil: () => {} });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'action-out-of-window');
  } finally {
    upstream.restore();
    delete globalThis.caches;
  }
});

test('spark/today: no upstream data is an honest 404, not a fabrication', async () => {
  const db = fakeDB((sql) => {
    if (sql.includes('FROM pools')) return [{ mint: 'MintA' }];
    return null;
  });
  const upstream = mockUpstream({}); // no charts at all
  try {
    const worker = await loadWorker();
    const env = makeEnv(db);
    const res = await worker.fetch(new Request('https://api.test/api/spark/today'), env, { waitUntil: () => {} });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).reason, 'no-data');
  } finally {
    upstream.restore();
    delete globalThis.caches;
  }
});