const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PAIR = '1111111111111111111111111111111111111111111';
const MINT = '2222222222222222222222222222222222222222222';
const OTHER = '3333333333333333333333333333333333333333333';

function loadContentHarness() {
  global.window = {};
  require('../engine.js');
  const E = global.window.PaperEngine;
  const source = fs.readFileSync(path.join(__dirname, 'statepersist.test.js'), 'utf8');
  const start = source.indexOf('function runOverlay');
  const end = source.indexOf('\n}\n\ntest(', start);
  const originalRead = fs.readFileSync;
  const runOverlaySource = source.slice(start, end + 2)
    .replace("const url = `https://trade.padre.gg/trade/${BONK}`;",
      "const url = options.url || `https://axiom.trade/meme/${BONK}`;")
    .replace("if (msg.type === 'pt_resolve') return R.resolve(msg.address);",
      "if (msg.type === 'pt_resolve') return Promise.resolve(null);")
    .replace("if (msg.type === 'pt_refresh') return R.refresh(msg.token);",
      "if (msg.type === 'pt_refresh') return Promise.resolve(typeof options.refresh === 'function' ? options.refresh(msg.token) : R.refresh(msg.token));")
    .replace("if (msg.type === 'pt_sol_usd') return R.solUsd();",
      "if (msg.type === 'pt_sol_usd') return R.solUsd();\n"
        + "          if (msg.type === 'pt_onchain_prewatch') return Promise.resolve(typeof options.onchainPrewatch === 'function' ? options.onchainPrewatch(msg) : null);")
    .replace('return {\n    advance,', 'return {\n    win,\n    advance,');
  const runOverlay = new Function('ROOT', 'fs', 'path', 'vm', 'E', 'BONK',
    `${runOverlaySource}; return runOverlay;`)(ROOT, fs, path, vm, E, PAIR);
  fs.readFileSync = function (file, ...args) {
    let text = originalRead.call(fs, file, ...args);
    if (String(file).endsWith(path.join('extension', 'content.js'))) {
      text = text.replace('\n})();\n', [
        '\n  window.__hostFactsTest = {',
        ' getToken: () => token,',
        ' getState: () => state,',
        ' setArmed: (value) => { armedBuy = value; },',
        ' getArmed: () => armedBuy,',
        ' pageTick: (payload) => handlePageTick(payload),',
        ' setLastPriceAt: (value) => { lastPriceAt = value; },',
        ' doBuy: (amount, quotedUsd) => doBuy(amount, quotedUsd),',
        ' doSell: (fraction) => doSell(fraction),',
        ' reconcile: (measured) => reconcileHostSupply(measured),',
        ' prewatch: (candidate) => prewatchPending(candidate),',
        ' requote: () => requote(),',
        ' resetPrewatch: () => { prewatchedAddress = null; prewatchAttempts = 0; prewatchLastTryAt = 0; prewatchBackoffFor = null; }',
        ' };',
        '\n})();\n',
      ].join(''));
    }
    return text;
  };
  return { runOverlay, restore() { fs.readFileSync = originalRead; } };
}

async function settleOverlay(overlay) {
  for (let i = 0; i < 400; i++) await Promise.resolve();
  return overlay;
}

function runBridge(body) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const responseBody = JSON.stringify(body);
  const win = {
    fetch(url) {
      return Promise.resolve({
        url: String(url),
        headers: { get: () => 'application/json' },
        clone: () => ({ text: () => Promise.resolve(responseBody) }),
      });
    },
    XMLHttpRequest: function FakeXHR() {},
    WebSocket: function FakeWebSocket() {},
    SharedWorker: function FakeSharedWorker() {},
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.XMLHttpRequest.prototype.send = function () {};
  win.XMLHttpRequest.prototype.addEventListener = function () {};
  win.WebSocket.prototype.addEventListener = function () {};
  win.SharedWorker.prototype.port = {
    addEventListener() {},
    start() {},
  };
  win.window = win;
  const sandbox = {
    window: win,
    location: { href: 'https://axiom.trade/meme/' + PAIR, hostname: 'axiom.trade' },
    console,
    Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });
  for (const fn of timers.slice()) fn();
  return {
    emitted,
    sendContent(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    async fetch() {
      await win.fetch('https://axiom.trade/api/frame');
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

test('host identity facts are emitted for a pair-tied record', async () => {
  const env = runBridge({
    token: {
      mint: MINT,
      pairAddress: PAIR,
      symbol: 'FACT',
      supply: '1000000000',
      decimals: 9,
      priceUsd: 0.000001,
      marketCap: 1000,
    },
  });
  await env.fetch();
  const facts = env.emitted.find((message) => message.type === 'facts');
  assert.ok(facts);
  assert.equal(facts.payload.mint, MINT);
  assert.ok(facts.payload.addresses.includes(PAIR));
  assert.equal(facts.payload.poolAddress, PAIR);
  assert.equal(facts.payload.supply, 1000000000);
  assert.equal(facts.payload.decimals, 9);
  assert.equal(facts.payload.priceUsd, 0.000001);
});

test('quote-side host facts cannot rekey the page token', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const wsol = 'So11111111111111111111111111111111111111112';
    ov.dispatchBridge('facts', {
      mint: wsol, addresses: [PAIR, wsol], poolAddress: PAIR,
      priceUsd: null, mcap: null, supply: null, decimals: null,
    });
    assert.equal(api.getToken().mint, PAIR);
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], poolAddress: PAIR,
      priceUsd: null, mcap: null, supply: null, decimals: null,
    });
    assert.equal(api.getToken().mint, MINT);
  } finally {
    loader.restore();
  }
});

test('facts extraction keeps descendant addresses off the parent record', async () => {
  const env = runBridge({
    token: {
      mint: MINT,
      priceUsd: 0.000001,
      marketCap: 1000,
      nested: { pairAddress: PAIR },
    },
  });
  await env.fetch();
  const facts = env.emitted.find((message) => message.type === 'facts');
  assert.ok(facts);
  assert.equal(facts.payload.addresses.length, 1);
  assert.equal(facts.payload.addresses[0], PAIR);
  assert.equal(facts.payload.mint, MINT);
  assert.equal(facts.payload.poolAddress, PAIR);
});

test('unknown-unit chart closes never become priceUsd facts', async () => {
  const env = runBridge({
    token: {
      mint: MINT,
      marketCap: 1000,
      close: 0.000001,
      supply: 1000000000,
      decimals: 9,
    },
  });
  await env.fetch();
  const facts = env.emitted.find((message) => message.type === 'facts');
  assert.ok(facts);
  assert.equal(facts.payload.priceUsd, null);
});

test('facts are bounded to three records per frame and never become ticks', async () => {
  const body = {};
  for (const mint of [MINT, OTHER, '4444444444444444444444444444444444444444444', '5555555555555555555555555555555555555555555']) {
    body[mint] = { mint, supply: 1000000000, decimals: 9 };
  }
  const env = runBridge(body);
  await env.fetch();
  const facts = env.emitted.filter((message) => message.type === 'facts');
  assert.equal(facts.length, 3);
  assert.equal(env.emitted.filter((message) => message.type === 'tick').length, 0);
});

test('watched facts are emitted before unrelated records consume the cap', async () => {
  const body = {};
  for (const mint of [OTHER, '4444444444444444444444444444444444444444444', '5555555555555555555555555555555555555555555']) {
    body[mint] = { mint, supply: 1000000000, decimals: 9 };
  }
  body[MINT] = { mint: MINT, pairAddress: PAIR, supply: 1000000000, decimals: 9 };
  const env = runBridge(body);
  env.sendContent('paper-axis', { mint: MINT, pairAddress: PAIR });
  await env.fetch();
  const facts = env.emitted.filter((message) => message.type === 'facts');
  assert.equal(facts.length, 3);
  assert.equal(facts[0].payload.mint, MINT);
});

test('facts arrive before a same-response tick so a one-shot page can bootstrap', async () => {
  const env = runBridge({
    pair: {
      baseMint: MINT, pairAddress: PAIR, priceNative: 0.00001,
      priceUsd: 0.002, marketCap: 0.2, supply: 100, decimals: 0,
    },
  });
  env.sendContent('paper-axis', { mint: PAIR, pairAddress: PAIR });
  await env.fetch();
  const messages = env.emitted.filter((message) => message.type === 'facts'
    || message.type === 'tick');
  const factsIndex = messages.findIndex((message) => message.type === 'facts');
  const tickIndex = messages.findIndex((message) => message.type === 'tick');
  assert.ok(factsIndex >= 0 && factsIndex < tickIndex);

  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    for (const message of messages) ov.dispatchBridge(message.type, message.payload);
    assert.equal(ov.win.__hostFactsTest.getToken().mint, MINT);
    assert.ok(ov.win.__hostFactsTest.getToken().priceNative > 0);
  } finally {
    loader.restore();
  }
});

test('host facts do not merge arithmetic evidence across same-mint sibling nodes', async () => {
  const env = runBridge({
    quote: { mint: MINT, pairAddress: PAIR, priceUsd: 2 },
    stats: { mint: MINT, pairAddress: PAIR, mcap: 200, supply: 100, decimals: 0 },
  });
  env.sendContent('paper-axis', { mint: PAIR, pairAddress: PAIR });
  await env.fetch();
  const facts = env.emitted.filter((message) => message.type === 'facts');
  assert.equal(facts.length, 2);
  assert.ok(facts.every((message) => !(message.payload.priceUsd > 0
    && message.payload.mcap > 0 && message.payload.supply > 0)));

  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    for (const message of facts) ov.dispatchBridge('facts', message.payload);
    assert.equal(ov.win.__hostFactsTest.getToken().hostSupplyUi, undefined);
  } finally {
    loader.restore();
  }
});

test('pending content adopts a pair-tied mint and rewrites an armed buy', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], {
      url: 'https://axiom.trade/meme/' + PAIR,
    });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    assert.equal(api.getToken().pending, true);
    api.setArmed({ mint: PAIR });
    const originalRekey = ov.win.PaperEngine.rekeyMint;
    let rekeys = 0;
    ov.win.PaperEngine.rekeyMint = function (state, oldMint, newMint) {
      if (oldMint === PAIR && newMint === MINT) rekeys++;
      return originalRekey(state, oldMint, newMint);
    };
    ov.dispatchBridge('facts', {
      mint: MINT,
      addresses: [PAIR, MINT],
      poolAddress: PAIR,
      priceUsd: null,
      mcap: null,
      supply: null,
      decimals: null,
    });
    assert.equal(api.getToken().mint, MINT);
    assert.equal(api.getArmed().mint, MINT);
    assert.ok(rekeys >= 1);
    assert.deepEqual(JSON.parse(JSON.stringify(ov.posted.find((message) => message.type === 'paper-axis'
      && message.payload && message.payload.mint === MINT).payload)), {
      pairAddress: PAIR,
      mint: MINT,
    });
  } finally {
    loader.restore();
  }
});

test('host-facts decisions are pure and preserve the R1/R2 rules', () => {
  global.window = global.window || {};
  const Q = require('../quote.js');
  const token = { mint: PAIR, srcAddress: PAIR, pending: true };
  const tied = {
    mint: MINT, addresses: [PAIR, MINT], poolAddress: PAIR,
    priceUsd: 2, mcap: 200, supply: 1000000, decimals: 4,
  };
  assert.deepEqual(Q.hostFactsDecision(token, tied), {
    adoptMint: MINT, poolAddress: PAIR, supplyUi: 100,
    refused: false, reason: null,
  });
  assert.deepEqual(Q.hostFactsDecision(token, {
    mint: MINT, addresses: [OTHER], priceUsd: 2, mcap: 200, supply: 1000000,
  }), {
    adoptMint: null, poolAddress: null, supplyUi: null,
    refused: false, reason: 'not-our-record',
  });
  assert.deepEqual(Q.hostFactsDecision(token, {
    mint: 'So11111111111111111111111111111111111111112',
    addresses: [PAIR], poolAddress: PAIR,
  }), {
    adoptMint: null, poolAddress: null, supplyUi: null,
    refused: false, reason: 'quote-mint',
  });
  assert.deepEqual(Q.hostFactsDecision(token, {
    mint: MINT, addresses: [PAIR], priceUsd: 2, mcap: 200,
  }), {
    adoptMint: MINT, poolAddress: null, supplyUi: 100,
    refused: false, reason: null,
  });
  assert.deepEqual(Q.hostFactsDecision(token, {
    mint: MINT, addresses: [PAIR], priceUsd: 2, mcap: 200,
    supply: 1000000, decimals: 2,
  }), {
    adoptMint: MINT, poolAddress: null, supplyUi: null,
    refused: true, reason: 'no-reading-agreed',
  });
  assert.equal(Q.hostFactsDecision(
    { mint: PAIR, srcAddress: PAIR, pending: false }, tied
  ).reason, 'not-our-record');
});

test('pending content ignores screener facts not tied to the page address', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    ov.dispatchBridge('facts', {
      mint: MINT,
      addresses: [OTHER],
      poolAddress: OTHER,
      priceUsd: 2,
      mcap: 200,
      supply: 1000000,
      decimals: 4,
    });
    assert.equal(api.getToken().mint, PAIR);
    assert.equal(api.getToken().hostSupplyUi, undefined);
  } finally {
    loader.restore();
  }
});

test('pending content accepts corroborated declared and implied host supply', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
      supply: 1000000, decimals: 4, source: 'axiom', url: 'https://axiom.trade/meme/' + PAIR,
    });
    assert.equal(api.getToken().hostSupplyUi, 100);
    assert.equal(api.getToken().hostSupplyWitness.source, 'axiom');
    assert.equal(api.getToken().priceUsd, null);

    const loader2 = loadContentHarness();
    try {
      const ov2 = loader2.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
      await settleOverlay(ov2);
      const api2 = ov2.win.__hostFactsTest;
      ov2.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
        supply: null, decimals: null,
      });
      assert.equal(api2.getToken().hostSupplyUi, 100);
    } finally {
      loader2.restore();
    }
    const loader3 = loadContentHarness();
    try {
      const ov3 = loader3.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
      await settleOverlay(ov3);
      const api3 = ov3.win.__hostFactsTest;
      ov3.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
        supply: 100, decimals: 9,
      });
      assert.equal(api3.getToken().hostSupplyUi, 100);
    } finally {
      loader3.restore();
    }
  } finally {
    loader.restore();
  }
});

test('host supply accepts atomic and already-scaled readings', async () => {
  for (const supply of [100000000000, 100]) {
    const loader = loadContentHarness();
    try {
      const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
      await settleOverlay(ov);
      const api = ov.win.__hostFactsTest;
      ov.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
        supply, decimals: 9,
      });
      assert.equal(api.getToken().hostSupplyUi, 100);
    } finally {
      loader.restore();
    }
  }
});

test('pending content refuses mismatched host supply and unknown-unit prices', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const records = [];
    ov.win.PTErrors = { record: (message, details) => records.push({ message, details }) };
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
      supply: 1000000, decimals: 2,
    });
    assert.equal(api.getToken().hostSupplyUi, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].details.scope, 'content');
    assert.equal(records[0].details.kind, 'host-facts-supply-refused');
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], priceUsd: null, mcap: 200,
      supply: 1000000, decimals: 4,
    });
    assert.equal(api.getToken().hostSupplyUi, undefined);
  } finally {
    loader.restore();
  }
});

test('refusal diagnostics dedupe by evidence and cap at eight per token', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const records = [];
    ov.win.PTErrors = { record: (message, details) => records.push({ message, details }) };
    for (let i = 0; i < 10; i++) {
      ov.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], source: 'source-' + i,
        priceUsd: 2 + i, mcap: 200, supply: 1000000, decimals: 2,
      });
    }
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], source: 'source-0',
      priceUsd: 2, mcap: 200, supply: 1000000, decimals: 2,
    });
    assert.equal(records.length, 8);
  } finally {
    loader.restore();
  }
});

test('accepted bootstrap basis resets stale host provenance', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const Q = ov.win.PaperQuote;
    const originalBootstrap = Q.bootstrapTick;
    api.getToken().mint = MINT;
    api.getToken().hostSupplyUi = 100;
    api.getToken().hostSupplyWitness = { source: 'axiom', url: 'page' };
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.00001, priceUsd: 0.002,
      mcap: 0.2, basis: 'mcap', supplyBasis: 'host',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    assert.equal(api.getToken().hostSupplySource, 'site-facts');
    assert.ok(api.getToken().hostSupplyFillWitness);

    api.getToken().anchor = null;
    api.getToken().priceNative = null;
    api.getToken().priceUsd = null;
    api.getToken().mcap = null;
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.00002, priceUsd: 0.004,
      mcap: 0.4, basis: 'mcap', supplyBasis: 'pump-constant',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    assert.equal(api.getToken().hostSupplySource, null);
    assert.equal(api.getToken().hostSupplyFillWitness, null);
    Q.bootstrapTick = originalBootstrap;
  } finally {
    loader.restore();
  }
});

test('resolver replacement clears host-supply lineage', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], {
      url: 'https://axiom.trade/meme/' + PAIR,
      refresh: () => ({
        mint: MINT, priceNative: 0.00002, priceUsd: 0.004,
        mcap: 0.4, priceSource: 'resolver',
      }),
    });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const Q = ov.win.PaperQuote;
    const originalBootstrap = Q.bootstrapTick;
    api.getToken().mint = MINT;
    api.getToken().hostSupplyUi = 100;
    api.getToken().hostSupplyWitness = { source: 'axiom', url: 'page' };
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.00001, priceUsd: 0.002,
      mcap: 0.2, basis: 'mcap', supplyBasis: 'host',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    assert.equal(api.getToken().hostSupplySource, 'site-facts');

    api.setLastPriceAt(0);
    await api.requote();
    await settleOverlay(ov);
    assert.equal(api.getToken().hostSupplySource, null);
    assert.equal(api.getToken().hostSupplyFillWitness, null);
    Q.bootstrapTick = originalBootstrap;
  } finally {
    loader.restore();
  }
});

test('live-feed requote preserves host-supply lineage through later rejection', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], {
      url: 'https://axiom.trade/meme/' + PAIR,
      refresh: () => ({
        mint: MINT, priceNative: 0.00002, priceUsd: 0.004,
        mcap: 0.4, priceSource: 'resolver',
      }),
    });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const diagnostics = [];
    ov.win.PTErrors = { record(message, details) { diagnostics.push({ message, details }); } };
    const Q = ov.win.PaperQuote;
    const originalBootstrap = Q.bootstrapTick;
    const originalNeedsWitness = Q.needsFillWitness;
    const originalWitnessAgrees = Q.witnessAgrees;
    api.getToken().mint = MINT;
    api.getToken().hostSupplyUi = 100;
    api.getToken().hostSupplyWitness = { source: 'axiom', url: 'page' };
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.00001, priceUsd: 0.002,
      mcap: 0.2, basis: 'mcap', supplyBasis: 'host',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    assert.equal(api.getToken().hostSupplySource, 'site-facts');

    await api.requote();
    await settleOverlay(ov);
    assert.equal(api.getToken().hostSupplySource, 'site-facts');

    Q.needsFillWitness = () => true;
    Q.witnessAgrees = () => {
      api.reconcile(110);
      return true;
    };
    await api.doBuy(1, null);
    await settleOverlay(ov);
    assert.equal(api.getState().journal.filter((trade) => trade.mint === MINT).length, 0);
    assert.ok(diagnostics.some((entry) => entry.details && entry.details.kind === 'host-facts-fill-refused'));
    Q.bootstrapTick = originalBootstrap;
    Q.needsFillWitness = originalNeedsWitness;
    Q.witnessAgrees = originalWitnessAgrees;
  } finally {
    loader.restore();
  }
});

test('an in-flight host-supply buy is refused after reconciliation disproves it', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const diagnostics = [];
    ov.win.PTErrors = { record(message, details) { diagnostics.push({ message, details }); } };
    const Q = ov.win.PaperQuote;
    const originalBootstrap = Q.bootstrapTick;
    const originalNeedsWitness = Q.needsFillWitness;
    const originalWitnessAgrees = Q.witnessAgrees;
    api.getToken().mint = MINT;
    api.getToken().hostSupplyUi = 100;
    api.getToken().hostSupplyWitness = { source: 'axiom', url: 'page' };
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.0001, priceUsd: 0.002,
      mcap: 0.2, basis: 'mcap', supplyBasis: 'host',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', mcap: 0.2, candidates: [] });
    assert.equal(api.getToken().hostSupplySource, 'site-facts');
    Q.needsFillWitness = () => true;
    Q.witnessAgrees = () => {
      api.reconcile(110);
      return true;
    };
    await api.doBuy(1, null);
    await settleOverlay(ov);
    const state = api.getState();
    assert.equal(state.journal.filter((trade) => trade.mint === MINT).length, 0);
    assert.ok(diagnostics.some((entry) => entry.details && entry.details.kind === 'host-facts-fill-refused'));
    Q.bootstrapTick = originalBootstrap;
    Q.needsFillWitness = originalNeedsWitness;
    Q.witnessAgrees = originalWitnessAgrees;
  } finally {
    loader.restore();
  }
});

test('an in-flight host-supply sell still commits after reconciliation disproves it', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    const E = ov.win.PaperEngine;
    const Q = ov.win.PaperQuote;
    const originalBootstrap = Q.bootstrapTick;
    const originalNeedsWitness = Q.needsFillWitness;
    const originalWitnessAgrees = Q.witnessAgrees;
    api.getToken().mint = MINT;
    api.getToken().hostSupplyUi = 100;
    api.getToken().hostSupplyWitness = { source: 'axiom', url: 'page' };
    Q.bootstrapTick = () => ({
      accepted: true, priceNative: 0.0001, priceUsd: 0.002,
      mcap: 0.2, basis: 'mcap', supplyBasis: 'host',
    });
    api.pageTick({ mint: MINT, source: 'padre-chart-bar', candidates: [] });
    const settings = E.defaultSettings();
    E.buy(api.getState(), settings, {
      ts: Date.now(), mint: MINT, symbol: 'FACT', site: 'axiom',
      priceNative: 0.0001, priceUsd: 0.002, solAmount: 1,
    });
    ov.storage().pt_state = JSON.parse(JSON.stringify(api.getState()));
    Q.needsFillWitness = () => true;
    Q.witnessAgrees = () => {
      api.reconcile(110);
      return true;
    };
    await api.doSell(1);
    await settleOverlay(ov);
    const trades = api.getState().journal.filter((trade) => trade.mint === MINT);
    const sell = trades.find((trade) => trade.side === 'sell');
    assert.ok(sell);
    assert.equal(sell.supplySource, 'site-facts');
    assert.ok(sell.hostSupplyWitness);
    Q.bootstrapTick = originalBootstrap;
    Q.needsFillWitness = originalNeedsWitness;
    Q.witnessAgrees = originalWitnessAgrees;
  } finally {
    loader.restore();
  }
});

test('facts do not move the pending token price by themselves', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
      supply: null, decimals: null,
    });
    assert.equal(api.getToken().priceNative, null);
    assert.equal(api.getToken().priceUsd, null);
  } finally {
    loader.restore();
  }
});

test('resolved content does not adopt later host facts', async () => {
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], { url: 'https://axiom.trade/meme/' + PAIR });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    api.getToken().pending = false;
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], poolAddress: PAIR,
      priceUsd: 2, mcap: 200, supply: null, decimals: null,
    });
    assert.equal(api.getToken().mint, PAIR);
    assert.equal(api.getToken().hostSupplyUi, undefined);
  } finally {
    loader.restore();
  }
});

test('measured prewatch supply reconciles host supply and latches discrepancies', async () => {
  let measured = null;
  const loader = loadContentHarness();
  try {
    const ov = loader.runOverlay([0.0001], {
      url: 'https://axiom.trade/meme/' + PAIR,
      onchainPrewatch: () => measured && {
        mint: MINT, supplyUi: measured, decimals: 4, pool: null, poolKind: null,
      },
    });
    await settleOverlay(ov);
    const api = ov.win.__hostFactsTest;
    ov.dispatchBridge('facts', {
      mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
      supply: 1000000, decimals: 4,
    });
    measured = 101;
    api.resetPrewatch();
    api.prewatch({ kind: 'pair', address: PAIR });
    await settleOverlay(ov);
    assert.equal(api.getToken().supplyUi, 101);
    assert.equal(api.getToken().hostSupplyUi, null);
    assert.equal(api.getToken().hostSupplyRejected, undefined);

    const loader2 = loadContentHarness();
    try {
      const ov2 = loader2.runOverlay([0.0001], {
        url: 'https://axiom.trade/meme/' + PAIR,
        onchainPrewatch: () => measured && {
          mint: MINT, supplyUi: measured, decimals: 4, pool: PAIR, poolKind: 'pump-curve',
        },
      });
      await settleOverlay(ov2);
      const api2 = ov2.win.__hostFactsTest;
      api2.getState().positions[MINT] = { mint: MINT };
      api2.getState().journal.push({ mint: MINT, supplySource: 'site-facts' });
      const records2 = [];
      ov2.win.PTErrors = { record: (message, details) => records2.push({ message, details }) };
      ov2.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
        supply: 1000000, decimals: 4,
      });
      measured = 200;
      api2.resetPrewatch();
      api2.prewatch({ kind: 'pair', address: PAIR });
      await settleOverlay(ov2);
      assert.equal(api2.getToken().hostSupplyUi, null);
      assert.equal(api2.getToken().hostSupplyRejected, true);
      assert.equal(api2.getToken().supplyUi, undefined);
      assert.equal(api2.getState().positions[MINT].hostSupplyDiscrepancy, true);
      assert.equal(api2.getState().journal[0].supplySource, 'site-facts');
      assert.ok(records2.some((record) => record.details.kind === 'host-facts-supply-mismatch'));
      ov2.dispatchBridge('facts', {
        mint: MINT, addresses: [PAIR, MINT], priceUsd: 2, mcap: 200,
        supply: 1000000, decimals: 4,
      });
      assert.equal(api2.getToken().hostSupplyUi, null);
    } finally {
      loader2.restore();
    }
  } finally {
    loader.restore();
  }
});

test('bridge stops emitting facts after content publishes factsWanted false', async () => {
  const env = runBridge({
    token: MINT,
    supply: 1000000000,
    decimals: 9,
    priceUsd: 0.000001,
    marketCap: 1000,
  });
  env.sendContent('page-state', { wantsTicks: true, factsWanted: false });
  await env.fetch();
  assert.equal(env.emitted.filter((message) => message.type === 'facts').length, 0);
  assert.ok(env.emitted.some((message) => message.type === 'tick'),
    'tick collection must remain active when facts are not wanted');
});

test('bootstrapSupply precedence is measured, pump constant, then host', () => {
  global.window = global.window || {};
  const Q = require('../quote.js');
  const measured = { mint: 'plain-mint', supplyUi: 12, hostSupplyUi: 34 };
  assert.equal(Q.bootstrapSupply(measured), 12);
  const pump = { mint: 'anythingpump', supplyUi: null, hostSupplyUi: 34 };
  assert.equal(Q.bootstrapSupply(pump), 1e9);
  const host = { mint: 'plain-mint', hostSupplyUi: 34 };
  assert.equal(Q.bootstrapSupply(host), 34);
  assert.deepEqual(Q.bootstrapSupplyInfo(measured), { supplyUi: 12, basis: 'measured' });
  assert.deepEqual(Q.bootstrapSupplyInfo(pump), { supplyUi: 1e9, basis: 'pump-constant' });
  assert.deepEqual(Q.bootstrapSupplyInfo(host), { supplyUi: 34, basis: 'host' });
});

test('host-supply bootstrap reports its supply provenance', () => {
  global.window = global.window || {};
  const Q = require('../quote.js');
  const verdict = Q.bootstrapTick(
    { mint: 'plain-mint', hostSupplyUi: 100 },
    { mint: 'plain-mint', mcap: 0.006, source: 'padre-chart-bar' },
    2
  );
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.supplyBasis, 'host');
});
