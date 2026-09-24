/* C-32 — GMGN PONS supply-basis flip-flop, replayed through the real
 * content-script tick path.
 *
 * Fixture: %TEMP%\pt-pons\v3250\bridge.jsonl — the exact tick payloads the
 * bridge emitted during five minutes on gmgn.ai/robinhood/token/0x39dB…4571
 * (v3.25.0, live). Sanitized to candidates/mcap/mint/symbol/name/source —
 * no URLs, query strings, or frames.
 *
 * Live behavior then: the panel's accepted price flip-flopped between the
 * true $0.62 (token_activity USD ticks) and a phantom $0.91 (GMGN's 1B-
 * supply mcap candles divided through the resolver's ~684M-supply anchor) —
 * 78 samples >5% off, a buy at $0.6228 sold 3 s later at $0.9104 = +44%
 * booked on a flat market. With C-32 calibration the cap ticks convert
 * through the chart's own learned supply and the flip-flop is gone.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const URL_ = 'https://gmgn.ai/robinhood/token/' + PONS;
const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'gmgn-pons-ticks.json'), 'utf8'));

function loadGmgnHarness() {
  global.window = {};
  require('../engine.js');
  const E = global.window.PaperEngine;
  const source = fs.readFileSync(path.join(__dirname, 'statepersist.test.js'), 'utf8');
  const start = source.indexOf('function runOverlay');
  const end = source.indexOf('\n}\n\ntest(', start);
  const originalRead = fs.readFileSync;
  const runOverlaySource = source.slice(start, end + 2)
    .replace("const url = `https://trade.padre.gg/trade/${BONK}`;",
      'const url = options.url || `https://axiom.trade/meme/${BONK}`;')
    .replace("hostname: 'trade.padre.gg', pathname: `/trade/${BONK}`",
      'hostname: new URL(url).hostname, pathname: new URL(url).pathname, search: new URL(url).search')
    .replace("if (msg.type === 'pt_resolve') return R.resolve(msg.address);",
      "if (msg.type === 'pt_resolve') return Promise.resolve(null);")
    .replace("if (msg.type === 'pt_refresh') return R.refresh(msg.token);",
      "if (msg.type === 'pt_refresh') return Promise.resolve(typeof options.refresh === 'function' ? options.refresh(msg.token) : R.refresh(msg.token));")
    .replace("if (msg.type === 'pt_sol_usd') return R.solUsd();",
      "if (msg.type === 'pt_sol_usd') return R.solUsd();\n"
        + "          if (msg.type === 'pt_onchain_prewatch') return Promise.resolve(null);")
    .replace('return {\n    advance,', 'return {\n    win,\n    advance,');
  const runOverlay = new Function('ROOT', 'fs', 'path', 'vm', 'E', 'BONK',
    `${runOverlaySource}; return runOverlay;`)(ROOT, fs, path, vm, E, 'unused');
  fs.readFileSync = function (file, ...args) {
    let text = originalRead.call(fs, file, ...args);
    if (String(file).endsWith(path.join('extension', 'content.js'))) {
      text = text.replace('\n})();\n', [
        '\n  window.__ponsTest = {',
        ' getToken: () => token,',
        ' pageTick: (payload) => handlePageTick(payload),',
        ' requote: () => requote(),',
        ' chartSupply: () => {',
        '   const b = lastMcapSource ? chartSupplyState.get(lastMcapSource) : null;',
        '   return (b && b.supply) || null;',
        ' },',
        ' chartSupplyFor: (src) => {',
        '   const b = chartSupplyState.get(src);',
        '   return (b && b.supply) || null;',
        ' },',
        ' supplyUi: () => chartSupplyUi(),',
        ' };',
        '\n})();\n',
      ].join(''));
    }
    return text;
  };
  return { runOverlay, restore() { fs.readFileSync = originalRead; } };
}

async function settle(overlay) {
  for (let i = 0; i < 400; i++) await Promise.resolve();
  return overlay;
}

async function replayPons(loader, ticks) {
  const ov = loader.runOverlay([0.0001], {
    url: URL_,
    // The resolver anchor exactly as captured: cap on ~684M supply while
    // GMGN's chart caps are on ~1B.
    refresh: () => ({
      mint: PONS, symbol: 'PONS', name: 'Pons', chain: 'robinhood',
      priceNative: 0.005349462505228893, priceUsd: 0.62281152,
      mcap: 426071420.5389649, priceSource: 'resolver',
    }),
  });
  await settle(ov);
  const api = ov.win.__ponsTest;
  assert.equal(api.getToken().mint.toLowerCase(), PONS.toLowerCase());
  await api.requote();
  await settle(ov);
  const tok = api.getToken();
  assert.ok(Number(tok.anchor && tok.anchor.priceNative) > 0, 'resolver anchor installed');
  assert.equal(tok.anchor.mcap, 426071420.5389649);

  let calibratedAt = -1;
  const accepted = []; // { i, priceUsd, mcap }
  let prevAccepted = null;
  for (let i = 0; i < ticks.length; i++) {
    const rec = ticks[i];
    if (rec.dt > 0) await ov.advance(rec.dt);
    const before = Number(api.getToken().priceUsd) || null;
    api.pageTick(JSON.parse(JSON.stringify(rec.tick)));
    const after = Number(api.getToken().priceUsd) || null;
    if (after !== null && after !== before) {
      prevAccepted = after;
      accepted.push({ i, priceUsd: after, mcap: Number(api.getToken().mcap) || null });
    }
    if (calibratedAt < 0 && api.chartSupply() > 0) calibratedAt = i;
  }

  function wsMedianAt(idx) {
    const vals = [];
    for (let j = 0; j <= idx && vals.length < 5; j++) {
      const t = ticks[idx - j].tick;
      if (t.source === 'gmgn-ws-trade') {
        const c = (t.candidates || [])[0];
        if (c && c.unit === 'usd' && Number(c.value) > 0) vals.push(Number(c.value));
      }
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  }
  return { api, accepted, calibratedAt, wsMedianAt };
}

function assertStable(api, accepted, calibratedAt, wsMedianAt, supplySrc, allowedSupplies) {
  assert.ok(calibratedAt >= 0, 'chart supply was learned from the replayed feed');
  const learned = (supplySrc && api.chartSupplyFor(supplySrc)) || api.chartSupply();
  assert.ok(Math.abs(learned - 1e9) / 1e9 < 0.05,
    `learned supply ${learned} should be GMGN's ~1B convention`);
  const conventions = allowedSupplies || [learned];

  // After calibration every accepted price must sit within 10% of the
  // concurrent trade-feed level — judged against the rolling median of the
  // last few prints (a single live trade print legitimately deviates ~3%;
  // the bug's signature was a 46% scale jump). 10% is the field report's
  // own outlier threshold.
  const after = accepted.filter((a) => a.i >= calibratedAt && wsMedianAt(a.i) !== null);
  assert.ok(after.length > 50, 'enough post-calibration accepts to judge');
  for (const a of after) {
    const med = wsMedianAt(a.i);
    const rel = Math.abs(a.priceUsd - med) / med;
    assert.ok(rel <= 0.10, `tick ${a.i}: accepted ${a.priceUsd} vs ws median ${med} (${(rel * 100).toFixed(1)}%)`);
  }
  let postFlips = 0;
  for (let i = 1; i < after.length; i++) {
    const r = Math.max(after[i].priceUsd, after[i - 1].priceUsd)
      / Math.min(after[i].priceUsd, after[i - 1].priceUsd);
    if (r > 1.10) postFlips++;
  }
  assert.equal(postFlips, 0, 'no >10% flips after calibration');

  // The panel cap must stay on a real feed's convention — never a blended
  // one that no source actually plots.
  for (const a of after) {
    if (!(a.mcap > 0)) continue;
    const impliedSupply = a.mcap / a.priceUsd;
    assert.ok(conventions.some((s) => Math.abs(impliedSupply - s) / s < 0.10),
      `tick ${a.i}: implied supply ${impliedSupply} matched no feed convention`);
  }
}

test('C-32: replayed PONS ticks cannot flip the panel between supply conventions', async () => {
  const loader = loadGmgnHarness();
  try {
    const { api, accepted, calibratedAt, wsMedianAt } = await replayPons(loader, FIXTURE);
    assertStable(api, accepted, calibratedAt, wsMedianAt);
  } finally {
    loader.restore();
  }
});

test('C-32: a second cap feed on the resolver convention cannot poison the chart bucket', async () => {
  const loader = loadGmgnHarness();
  try {
    // Interleave a synthetic xhr cap tick on the resolver's ~684M convention
    // after every cap-carrying fixture tick. Shared-state calibration would
    // alternate 1B and 684M samples in one median and reopen the flip-flop;
    // per-source buckets keep each feed on its own learned convention.
    const mixed = [];
    for (const rec of FIXTURE) {
      mixed.push(rec);
      if (Number(rec.tick.mcap) > 0) {
        mixed.push({
          dt: 1,
          tick: { source: 'xhr', mcap: 426_500_000, mint: PONS, symbol: 'PONS' },
        });
      }
    }
    const { api, accepted, calibratedAt, wsMedianAt } = await replayPons(loader, mixed);
    assertStable(api, accepted, calibratedAt, wsMedianAt, 'chart-export',
      [api.chartSupplyFor('chart-export'), api.chartSupplyFor('xhr')].filter(Boolean));
    // The xhr bucket learns the resolver's own ~684M convention; the chart's
    // bucket must still hold ~1B. Either convention may legitimately own the
    // last cap verdict — what matters is prices never leave the trade scale.
    const xhrSupply = api.chartSupplyFor('xhr');
    assert.ok(Math.abs(xhrSupply - 6.84e8) / 6.84e8 < 0.10,
      `xhr bucket learned ${xhrSupply}, expected ~684M`);
  } finally {
    loader.restore();
  }
});
