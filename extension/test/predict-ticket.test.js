/* predict-ticket dataset locks (B2).
 *
 * The ticket lives in a CLOSED shadow root; the host dataset is the machine
 * contract. Refusal CODES ride it (not just prose) so harnesses switch on
 * resolution_lockout | no_liquidity | market_closed | depth_cap instead of
 * regex-matching English sentences that the next copy tweak will break.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function bootTicket(sendMessageImpl) {
  const created = [];
  const sandbox = {
    console, JSON, Promise, Date, setTimeout: () => 0, clearTimeout: () => {},
    document: {
      createElement: () => {
        const el = { dataset: {}, style: {}, attachShadow() {
          const sh = { _h: '', querySelectorAll: () => [], querySelector: () => null };
          Object.defineProperty(sh, 'innerHTML', { set(v) { this._h = v; }, get() { return this._h; } });
          el._shadow = sh;
          return sh;
        } };
        created.push(el);
        return el;
      },
      body: { appendChild() {} },
    },
    chrome: { runtime: { sendMessage: sendMessageImpl, lastError: null } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  // Test seam, same technique as hostfacts: the IIFE's closing is patched
  // at load to export internals. Shipped code is untouched.
  const src = fs.readFileSync(path.join(ROOT, 'predict-ticket.js'), 'utf8')
    .replace('\n})();\n', '\n  window.__predictTicketTest = { requestQuote, setQty: setAmount };\n})();\n');
  vm.runInContext(src, ctx, { filename: 'predict-ticket.js' });
  sandbox.window.PaperPredictTicket.mount({ venue: 'kalshi', marketId: 'KX' });
  return { testApi: sandbox.window.__predictTicketTest, host: created[0] };
}

test('B2: a refused quote publishes its machine code on the host dataset', async () => {
  const { testApi, host } = bootTicket((msg, cb) => {
    cb({ ok: false, code: 'market_closed', message: 'This market has closed.' });
  });
  testApi.setQty(10);
  await testApi.requestQuote();
  assert.equal(host.dataset.ptState, 'error');
  assert.equal(host.dataset.ptError, 'This market has closed.');
  assert.equal(host.dataset.ptErrorCode, 'market_closed', 'the code must ride the dataset, not just the prose');
});

test('B2: a priced quote clears any previous error code', async () => {
  let fail = true;
  const { testApi, host } = bootTicket((msg, cb) => {
    cb(fail
      ? { ok: false, code: 'no_liquidity', message: 'No depth.' }
      : { ok: true, data: { avgPrice: 55, cost: 5.5, fee: 0.05, slippageBps: 12, resolvedMarketId: 'KX', quotedAt: new Date().toISOString() } });
  });
  testApi.setQty(10);
  await testApi.requestQuote();
  assert.equal(host.dataset.ptErrorCode, 'no_liquidity');
  fail = false;
  testApi.setQty(10);
  await testApi.requestQuote();
  assert.equal(host.dataset.ptState, 'quoted');
  assert.equal(host.dataset.ptErrorCode, undefined, 'a fresh quote must clear the stale code');
});

test('B6: the Market row names the picked market when resolution went via event/group', async () => {
  const quoted = (resolvedVia) => (msg, cb) => {
    cb({ ok: true, data: { avgPrice: 55, cost: 5.5, fee: 0.05, slippageBps: 12, resolvedMarketId: 'KX-T1', marketTitle: 'Deep second', resolvedVia, siblingCount: 2, quotedAt: new Date().toISOString() } });
  };
  for (const via of ['event', 'group']) {
    const { testApi, host } = bootTicket(quoted(via));
    testApi.setQty(10);
    await testApi.requestQuote();
    assert.match(host._shadow.innerHTML, /Deep second.*1 of 2/, `resolvedVia=${via} must name the market`);
  }
  const { testApi, host } = bootTicket(quoted('direct'));
  testApi.setQty(10);
  await testApi.requestQuote();
  assert.ok(!host._shadow.innerHTML.includes('quote-row market'), 'a direct quote names no other market');
});

test('B4: an aged quote renders stale, forces re-quote, and publishes quotedAt', async () => {
  const q = (quotedAt) => ({ ok: true, data: { avgPrice: 55, cost: 5.5, fee: 0.05, slippageBps: 12, resolvedMarketId: 'KX', quotedAt } });
  const fresh = new Date(Date.now() - 5000).toISOString();
  const aged = new Date(Date.now() - 60000).toISOString();
  const seen = [];
  const mk = (quotedAt) => bootTicket((msg, cb) => { seen.push(msg); cb(q(quotedAt)); });
  let t = mk(fresh);
  t.testApi.setQty(10);
  await t.testApi.requestQuote();
  assert.equal(t.host.dataset.ptQuotedAt, fresh, 'quotedAt rides the dataset for the live pass');
  assert.equal(t.host.dataset.ptStale, undefined);
  assert.ok(!t.host._shadow.innerHTML.includes('Re-quote'));
  t = mk(aged);
  t.testApi.setQty(10);
  await t.testApi.requestQuote();
  assert.equal(t.host.dataset.ptStale, 'true', 'a 60s-old quote (limit 30s) is stale');
  assert.ok(t.host._shadow.innerHTML.includes('Re-quote'), 'a stale quote forces re-quote, not submit');
  assert.ok(!t.host._shadow.innerHTML.includes('data-action="submit"'), 'no submit path off a stale price');
});
