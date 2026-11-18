/* B19 — "Opera blocked it for some reason" (gymbro23_, 9/17): clicking
 * Settings did nothing. chrome.runtime.openOptionsPage is the one call some
 * Chromium browsers refuse for an unpacked extension; the dashboard is an
 * ordinary extension page and can always be opened as a tab. Runs the
 * shipped function from each surface against a stubbed chrome. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function load(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in ${file}`);
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  return (chrome) => new Function('chrome', src.slice(start, end) + `\nreturn ${name};`)(chrome);
}

function chromeStub(mode) {
  const opened = [];
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => 'chrome-extension://id/' + p,
      sendMessage: (m) => { opened.push('msg:' + (m && m.type)); },
      openOptionsPage: (cb) => {
        if (mode === 'throws') throw new Error('blocked');
        if (mode === 'rejects') return Promise.reject(new Error('blocked'));
        if (mode === 'lastError') { chrome.runtime.lastError = { message: 'Could not create an options page.' }; if (cb) cb(); chrome.runtime.lastError = null; return undefined; }
        opened.push('options'); if (cb) cb(); return undefined;
      },
    },
    tabs: { create: (o) => { opened.push(o.url); } },
  };
  return { chrome, opened };
}

for (const [file, name] of [['background.js', 'openDashboard'], ['popup.js', 'openDashboardPage'], ['panel.js', 'openDashboardPage']]) {
  test(`${file}: Settings opens the options page when the browser allows it`, async () => {
    const { chrome, opened } = chromeStub('ok');
    load(file, name)(chrome)();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(opened, ['options']);
  });
  for (const mode of ['throws', 'rejects', 'lastError']) {
    test(`${file}: when openOptionsPage ${mode}, the dashboard still opens as a tab`, async () => {
      const { chrome, opened } = chromeStub(mode);
      load(file, name)(chrome)();
      await new Promise((r) => setImmediate(r));
      // The side panel opens no tabs itself; it asks the background worker.
      assert.deepEqual(opened, [file === 'panel.js' ? 'msg:pt_open_dashboard' : 'chrome-extension://id/dashboard.html']);
    });
  }
}
