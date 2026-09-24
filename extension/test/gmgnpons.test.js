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
        ' chartSupply: () => (chartSupplyState && chartSupplyState.supply) || null,',
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

test('C-32: replayed PONS ticks cannot flip the panel between supply conventions', async () => {
  const loader = loadGmgnHarness();
  try {
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
    let lastWsUsd = null;
    const accepted = []; // { i, priceUsd, mcap }
    let prevAccepted = null;
    let flipsOver10 = 0;
    for (let i = 0; i < FIXTURE.length; i++) {
      const rec = FIXTURE[i];
      if (rec.dt > 0) await ov.advance(rec.dt);
      const before = Number(api.getToken().priceUsd) || null;
      api.pageTick(JSON.parse(JSON.stringify(rec.tick)));
      const after = Number(api.getToken().priceUsd) || null;
      if (rec.tick.source === 'gmgn-ws-trade') {
        const c = (rec.tick.candidates || [])[0];
        if (c && c.unit === 'usd' && Number(c.value) > 0) lastWsUsd = Number(c.value);
      }
      if (after !== null && after !== before) {
        if (prevAccepted !== null) {
          const r = Math.max(after, prevAccepted) / Math.min(after, prevAccepted);
          if (r > 1.10) flipsOver10++;
        }
        prevAccepted = after;
        accepted.push({ i, priceUsd: after, mcap: Number(api.getToken().mcap) || null });
      }
      if (calibratedAt < 0 && api.chartSupply() > 0) calibratedAt = i;
    }

    assert.ok(calibratedAt >= 0, 'chart supply was learned from the replayed feed');
    const learned = api.chartSupply();
    assert.ok(Math.abs(learned - 1e9) / 1e9 < 0.05,
      `learned supply ${learned} should be GMGN's ~1B convention`);

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
    const postFlips = flipsBetween(accepted.filter((a) => a.i >= calibratedAt));
    assert.equal(postFlips, 0, 'no >10% flips after calibration');

    // The panel cap must stay on ONE convention — the chart's.
    for (const a of after) {
      if (!(a.mcap > 0)) continue;
      const impliedSupply = a.mcap / a.priceUsd;
      assert.ok(Math.abs(impliedSupply - learned) / learned < 0.10,
        `tick ${a.i}: implied supply ${impliedSupply} drifted off the chart convention`);
    }

    function wsMedianAt(idx) {
      const vals = [];
      for (let j = 0; j <= idx && vals.length < 5; j++) {
        const t = FIXTURE[idx - j].tick;
        if (t.source === 'gmgn-ws-trade') {
          const c = (t.candidates || [])[0];
          if (c && c.unit === 'usd' && Number(c.value) > 0) vals.push(Number(c.value));
        }
      }
      if (!vals.length) return null;
      vals.sort((a, b) => a - b);
      return vals[vals.length >> 1];
    }
    function flipsBetween(list) {
      let flips = 0;
      for (let i = 1; i < list.length; i++) {
        const r = Math.max(list[i].priceUsd, list[i - 1].priceUsd)
          / Math.min(list[i].priceUsd, list[i - 1].priceUsd);
        if (r > 1.10) flips++;
      }
      return flips;
    }
  } finally {
    loader.restore();
  }
});
