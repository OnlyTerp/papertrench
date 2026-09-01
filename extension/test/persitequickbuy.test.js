/* Per-site list quick-buy settings stay sparse, bounded and live. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

function fnBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `missing ${signature}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${signature}`);
}

test('per-site list chip overrides sanitize on settings read', () => {
  assert.deepEqual(E.DEFAULT_SETTINGS.listQuickBuyBySite, {});
  const merged = E.mergeSettings({
    listQuickBuySize: 1.2,
    listQuickBuyPlacement: 'bottom',
    listQuickBuyBySite: {
      axiom: { size: 2, placement: 'auto' },
      padre: { size: 0.4, placement: 'corner' },
      gmgn: { size: 'not-a-number', placement: 'bottom' },
      empty: { placement: 'junk' },
      malformed: 'ignore me',
      stringSize: { size: '1.15', placement: 'auto' },
    },
  });
  assert.deepEqual(merged.listQuickBuyBySite, {
    axiom: { size: 1.5, placement: 'auto' },
    padre: { size: 0.6 },
    gmgn: { placement: 'bottom' },
    stringSize: { placement: 'auto' },
  });
});

test('list scan preferences use per-site fields, then global fields, then defaults', () => {
  const helper = fnBlock(content, 'function listQuickBuyPrefs(');
  const prefs = vm.runInNewContext(`(${helper})`);
  assert.deepEqual(JSON.parse(JSON.stringify(prefs({
    listQuickBuySize: 1.2, listQuickBuyPlacement: 'bottom',
    listQuickBuyBySite: { axiom: { size: 0.7, placement: 'auto' } },
  }, 'axiom'))), { size: 0.7, placementPref: 'auto' });
  assert.deepEqual(JSON.parse(JSON.stringify(prefs({
    listQuickBuySize: 1.2, listQuickBuyPlacement: 'bottom',
    listQuickBuyBySite: {},
  }, 'padre'))), { size: 1.2, placementPref: 'bottom' });
  assert.deepEqual(JSON.parse(JSON.stringify(prefs({
    listQuickBuySize: 1.2, listQuickBuyPlacement: 'bottom',
    listQuickBuyBySite: { gmgn: { placement: 'auto' } },
  }, 'gmgn'))), { size: 1.2, placementPref: 'auto' });
  assert.deepEqual(JSON.parse(JSON.stringify(prefs({
    listQuickBuySize: 0, listQuickBuyPlacement: 'invalid',
    listQuickBuyBySite: { gmgn: { size: 99, placement: 'invalid' } },
  }, 'gmgn'))), { size: 99, placementPref: null });
  const scan = fnBlock(content, 'function scanRowBuys()');
  assert.match(scan, /Math\.max\(0\.6, Math\.min\(1\.5, listPrefs\.size\)\)/,
    'the bridge payload retains the outgoing size clamp');
});

test('dashboard renders row-buy adapters dynamically and saves a sparse map', () => {
  assert.match(dashboard, /window\.PaperTrenchSites\.ADAPTERS|window\.PaperTrenchSites && window\.PaperTrenchSites\.ADAPTERS/);
  assert.match(dashboard, /\.filter\(\(adapter\) => adapter && adapter\.id && adapter\.rowBuy\)/,
    'site controls must derive from adapters that have rowBuy');
  assert.match(dashboard, /Use the default/);
  assert.match(dashboard, />Auto<\/option>/);
  assert.match(dashboard, />Corner<\/option>/);
  assert.match(dashboard, /LIST_QUICK_BUY_SIZE_OPTIONS = \[0\.7, 0\.85, 1, 1\.15, 1\.3, 1\.5\]/,
    'the size selector offers the specified choices');
  const overridesHelper = fnBlock(dashboard, 'function listQuickBuyOverridesFromForm(');
  const overridesFromForm = vm.runInNewContext(`(${overridesHelper})`);
  const values = {
    'set-list-quick-buy-placement-axiom': 'auto',
    'set-list-quick-buy-size-axiom': '0.7',
    'set-list-quick-buy-placement-padre': '',
    'set-list-quick-buy-size-padre': '',
    'set-list-quick-buy-placement-gmgn': 'bottom',
    'set-list-quick-buy-size-gmgn': '',
  };
  const sparse = overridesFromForm(
    [{ id: 'axiom' }, { id: 'padre' }, { id: 'gmgn' }],
    (id) => values[id],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(sparse)), {
    axiom: { placement: 'auto', size: 0.7 },
    gmgn: { placement: 'bottom' },
  }, 'default/default sites are omitted so old overrides are deleted');
  const gather = fnBlock(dashboard, 'function gatherSettingsFromForm(');
  const overrideHelper = fnBlock(dashboard, 'function listQuickBuyOverridesFromForm(');
  assert.match(overrideHelper, /const overrides = \{\};/);
  assert.match(overrideHelper, /if \(Object\.keys\(override\)\.length\) overrides\[adapter\.id\] = override;/,
    'both default selects omit the site and delete an old override on save');
  assert.match(gather, /listQuickBuyBySite,/);
  assert.ok(dashboardHtml.indexOf('<script src="sites.js"></script>')
    < dashboardHtml.indexOf('<script src="dashboard.js"></script>'),
  'sites.js must load before the dashboard');
});

test('settings changes merge live before the next throttled row scan', () => {
  const listener = fnBlock(content, 'function watchStorage(');
  assert.match(listener, /settings = E\.mergeSettings\(settingsChange\.newValue\)/,
    'storage changes replace content settings with the sanitized merged map');
  assert.match(listener, /publishPageState\(\)/,
    'the existing live settings publication path remains active');
  assert.match(content, /if \(now - rowBuyScanAt < 350\) return;/,
    'the next eligible scan, without reload, forwards the refreshed settings');
});
