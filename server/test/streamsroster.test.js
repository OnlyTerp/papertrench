/* site/streams.js — the roster actually renders what it claims.
 *
 * There was no coverage on this file at all, which is how issue #64 could
 * describe a Kick creator being "accepted by a moderator and then silently
 * never appearing anywhere". The roster is also the one page where a wrong
 * answer is a dead embed: `login` means "mountable Twitch player", and
 * inventing one for a Kick channel puts a broken player on the page.
 *
 * These tests BOOT THE REAL SCRIPT in a DOM stub and read the resulting
 * markup. A string assertion against the source ("is 'ark1317' in the file?")
 * would pass just as happily with the card never rendering.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'streams.js'), 'utf8');

/** The smallest DOM the page actually touches. */
function makeElement(id) {
  const el = {
    id,
    innerHTML: '',
    className: '',
    style: {},
    children: [],
    dataset: {},
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
  };
  return el;
}

/**
 * Boot the page with no network (both remote roster sources fail, which is
 * the documented "hand-maintained list stands alone" path) and hand back the
 * elements it rendered into.
 */
async function bootPage() {
  const els = new Map();
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeElement(id));
    return els.get(id);
  };

  const sandbox = {
    console,
    // Both remote sources refused: the page must still render the manual list.
    fetch: () => Promise.reject(new Error('offline in test')),
    setTimeout: (fn) => { void fn; return 0; },      // never run timers
    clearTimeout() {},
    setInterval: () => 0,                            // no live-poll loop
    clearInterval() {},
    Image: function () { this.addEventListener = () => {}; },
    // The page lazy-reveals cards; nothing here scrolls, so the observer is
    // inert and every card is treated as already visible.
    IntersectionObserver: function () {
      this.observe = () => {};
      this.unobserve = () => {};
      this.disconnect = () => {};
    },
    encodeURIComponent,
    document: {
      getElementById: getEl,
      // Selector-addressed elements resolve to their own stub, keyed by the
      // selector text — enough for the page's classList/style toggles.
      querySelector: (sel) => getEl('sel:' + sel),
      querySelectorAll: () => [],
      createElement: () => makeElement('created'),
      addEventListener() {},
      readyState: 'complete',
      body: makeElement('body'),
    },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    URLSearchParams,
    URL,
    location: { href: 'https://papertrench.com/streams', search: '' },
    navigator: { userAgent: 'node' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'streams.js' });

  // boot() is async (it awaits the two optional remote rosters). Let the
  // rejected fetches settle so the final render has happened.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return { grid: getEl('streamerGrid'), els };
}

test('every roster entry becomes a card on the page (issue #64)', async () => {
  const { grid } = await bootPage();
  const html = grid.innerHTML;
  assert.ok(html.length > 0, 'the grid must render even with both remote rosters down');

  for (const name of ['OnlyTerp', 'ProfitableDegen', 'Chillygmi', 'plahstickk', 'Zurp52', 'Ark1317']) {
    assert.ok(html.includes(name), `${name} must appear on the page`);
  }
});

test('a Kick creator renders as a link-out card, not a dead player (issue #64)', async () => {
  const { grid } = await bootPage();
  const html = grid.innerHTML;

  // The card must point at the real channel...
  assert.ok(html.includes('https://kick.com/ark1317'),
    'the Kick card must link to the channel it names');
  // ...and must NOT have been given an invented Twitch login, which is
  // exactly what would mount a player for a channel that does not exist.
  assert.ok(!html.includes('twitch.tv/ark1317'),
    'a Kick channel must never be linked as a Twitch one');
  assert.ok(!/ark1317[^"]*\.jpg/i.test(html),
    'a Kick channel has no Twitch preview thumbnail to show');
});

test('a Twitch entry keeps its embeddable login (issue #64)', async () => {
  const { grid } = await bootPage();
  assert.ok(grid.innerHTML.includes('twitch.tv/zurp52'),
    'a Twitch streamer must link to their Twitch channel');
});

test('the roster carries no duplicate identities', async () => {
  // Two cards for one channel is the visible symptom of a manual entry
  // colliding with an approved application. Count CARDS, not mentions — a
  // single card legitimately names its channel several times (href, preview
  // image, alt text).
  const { grid } = await bootPage();
  const hrefs = [...grid.innerHTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const channels = hrefs.filter((h) => /twitch\.tv\/|kick\.com\//.test(h));
  assert.ok(channels.length >= 6, 'every roster entry links somewhere');
  assert.equal(new Set(channels).size, channels.length,
    'each channel gets exactly one card');
});
