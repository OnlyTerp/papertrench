const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname, 'orderrace.test.js'), 'utf8');
const harness = src.slice(0, src.indexOf('/* ---------------- the race'));
const mod = { exports: {} };
const fn = new Function('require', 'module', 'exports', '__harness', '__dirname',
  harness + '\n__harness.runOrderRace = runOrderRace;');
const h = {};
fn(require, mod, mod.exports, h, __dirname);

(async () => {
  const ov = h.runOrderRace({});
  await ov.settle();
  const E = require(path.join(__dirname, '..', 'engine.js'));
  const MINT = '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump';
  const base = E.resetState(E.defaultSettings());
  E.buy(base, E.defaultSettings(), { ts: 4000000, mint: MINT, site: 'padre', solAmount: 1, priceNative: 1e-9, priceUsd: 2e-7 });
  E.addOrder(base, MINT, { kind: 'tp', triggerPrice: 2e-9, sizePt: 50 }, 1e-9, 4100000);
  ov.seed(base);
  console.log('seeded. orders in seed:', JSON.stringify(Object.keys(base.orders || {})));
  ov.emitTick({ candidates: [{ value:  2.2e-9, unit: 'native' }] });
  await ov.settle();
  await ov.advance(2000);
  const st = ov.workerState();
  console.log('journal sells:', (st.journal || []).filter(t => t.side === 'sell').length);
  console.log('positions:', Object.keys(st.positions || {}));
  console.log('commits:', JSON.stringify(ov.commitLog()).slice(0, 400));
  try {
    console.log('token symbol:', vm.runInContext('typeof token !== "undefined" && token ? token.symbol : "none"', ov.sandbox));
    console.log('orders in live state:', vm.runInContext('typeof state !== "undefined" && state ? JSON.stringify(Object.keys(state.orders || {})) : "no state"', ov.sandbox));
    console.log('lastTickPrice:', vm.runInContext('typeof lastChartPrice !== "undefined" ? String(lastChartPrice) : "n/a"', ov.sandbox));
  } catch (e) { console.log('probe err:', e.message); }
  try {
    console.log('resolver type:', vm.runInContext('typeof PaperTrenchResolver', ov.sandbox));
    const r = await vm.runInContext('PaperTrenchResolver ? PaperTrenchResolver.resolve("3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump") : null', ov.sandbox);
    console.log('resolve result:', JSON.stringify(r).slice(0, 300));
  } catch (e) { console.log('probe err:', e.message); }
  process.exit(0);
})();
