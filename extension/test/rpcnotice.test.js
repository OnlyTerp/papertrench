const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Notice = require('../rpc-notice.js');

const ROOT = path.join(__dirname, '..');
const NOW = 1_800_000_000_000;

function entry(endpoints, options = {}) {
  const lastTs = options.lastTs === undefined ? NOW : options.lastTs;
  return [{
    ts: lastTs,
    lastTs,
    context: {
      kind: 'rpc-pool-status',
      pool: { mode: options.mode || 'keyless', method: 'getMultipleAccounts', endpoints },
    },
  }];
}

function endpoint(id, refusalCount, lastSuccessAgeMs, extra = {}) {
  return {
    id, method: 'getMultipleAccounts', refusalCount, lastSuccessAgeMs, endpointLastSuccessAgeMs: lastSuccessAgeMs,
    benchedUntil: 0, blockedUntil: 0, ...extra,
  };
}

test('keyless refusal notice requires at least 12 recent refusals and no success in ten minutes', () => {
  const failing = entry([
    endpoint('publicnode', 7, 600_001),
    endpoint('solana-labs', 5, null),
    endpoint('tatum', 0, null),
  ]);
  assert.equal(Notice.shouldShow({}, failing, NOW), true);

  const eleven = entry([
    endpoint('publicnode', 6, 600_001),
    endpoint('solana-labs', 5, null),
    endpoint('tatum', 0, null),
  ]);
  assert.equal(Notice.shouldShow({}, eleven, NOW), false);

  const recovered = entry([
    endpoint('publicnode', 7, 600_001),
    endpoint('solana-labs', 5, 599_999),
    endpoint('tatum', 0, null),
  ]);
  assert.equal(Notice.shouldShow({}, recovered, NOW), false);
  assert.equal(Notice.shouldShow({}, entry(failing[0].context.pool.endpoints, { lastTs: NOW - 600_001 }), NOW), false);
  assert.equal(Notice.shouldShow({}, [], NOW), false);
});

test('all public endpoints currently benched or method-blocked also shows the notice', () => {
  const down = entry([
    endpoint('publicnode', 0, 100, { benchedUntil: NOW + 1_000 }),
    endpoint('solana-labs', 0, 100, { blockedUntil: NOW + 1_000 }),
    endpoint('tatum', 0, 100, { benchedUntil: NOW + 1_000 }),
  ]);
  assert.equal(Notice.shouldShow({}, down, NOW), true);
  down[0].context.pool.endpoints[2].benchedUntil = 0;
  assert.equal(Notice.shouldShow({}, down, NOW), false, 'one available endpoint keeps the pool available');
});

test('personal RPC mode and a saved endpoint suppress the keyless notice', () => {
  const failing = entry([
    endpoint('publicnode', 12, 700_000),
    endpoint('solana-labs', 0, null),
  ]);
  assert.equal(Notice.shouldShow({ rpcUrl: 'https://rpc.example.test' }, failing, NOW), false);
  failing[0].context.pool.mode = 'personal';
  assert.equal(Notice.shouldShow({}, failing, NOW), false);
});

test('dashboard Settings and popup Setup bind the persistent notice and guide without a toast', () => {
  const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const pool = fs.readFileSync(path.join(ROOT, 'rpc-pool.js'), 'utf8');
  const copy = 'The free price connection is being refused right now, so brand-new coins can take longer to price. A free personal endpoint fixes it in about two minutes.';

  assert.ok(dashboard.includes(copy) && dashboard.includes('docs/RPC-SPEEDUP.md'));
  assert.ok(popupHtml.includes(copy) && popupHtml.includes('docs/RPC-SPEEDUP.md'));
  assert.ok(dashboardHtml.includes('src="rpc-notice.js"'));
  assert.ok(popupHtml.includes('src="rpc-notice.js"'));
  assert.ok(dashboard.includes("PTRpcNotice.watch('dashboard-rpc-pool-notice')"));
  assert.ok(popup.includes("PTRpcNotice.watch('popup-rpc-pool-notice')"));
  assert.doesNotMatch(background, /maybeNoteSlowPool|pt_rpc_slow_told|pt_rpc_notice/);
  assert.doesNotMatch(content, /pt_rpc_notice|Heads-up: the public price connection/);
  assert.match(pool, /pt_rpc_pool_status_changed/);
});
