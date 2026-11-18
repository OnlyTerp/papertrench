/* X-Ray — the card itself (v2.6.0).
 *
 * The render path IS the product surface of this feature: a throw inside it
 * means no card at all, which reads to a user as "PaperTrench does nothing on
 * X". The suite has no browser and the project has no dependencies, so the
 * panel is driven here against a hand-built DOM and asserted on the text a
 * user would actually read — including the honesty labels that must survive
 * every future refactor:
 *
 *   - a change counter NEVER appears without the window it was observed over
 *   - CA history and Smart Following always state where they came from
 *   - X's own system pages get no card at all
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadCore() {
  const sandbox = {
    self: {}, URL, URLSearchParams, Set, Map, String, RegExp, JSON, Math, Date,
    Number, Array, Object, Boolean, isNaN, parseInt,
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-core.js'), 'utf8'), sandbox, { filename: 'xray-core.js' });
  return sandbox.self.PTXRay;
}

const XR = loadCore();
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CA2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;

function userNodeCore() {
  return {
    __typename: 'User',
    rest_id: '1450000000000000001',
    is_blue_verified: true,
    core: { created_at: 'Wed Oct 10 20:19:24 +0000 2018', name: 'Degen Labs', screen_name: 'degenlabs' },
    avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a.jpg' },
    legacy: {
      description: 'building in the trenches ' + CA,
      entities: { description: { urls: [{ expanded_url: 'https://pump.fun/coin/' + CA2 }] } },
      followers_count: 128_400,
      friends_count: 312,
    },
  };
}

function tweetNode(id, text, createdAt) {
  return {
    rest_id: id,
    legacy: {
      full_text: text,
      user_id_str: '1450000000000000001',
      created_at: createdAt,
      entities: { urls: [] },
    },
  };
}

function follower(id, handle, followers) {
  return {
    restId: id, handle, name: handle, followers, following: 100,
    verified: true, avatar: null, bio: null, urls: [], createdAt: null,
  };
}

/* ---------------- a DOM, by hand ---------------- */

function makeNode(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: '', id: '', textContent: '', title: '', href: '', src: '', alt: '',
    referrerPolicy: '', isConnected: false, parentNode: null, shadow: null,
    style: { cssText: '' },
    children: [],
    attrs: {},
  };
  node.classList = {
    add(c) { node.className += ' ' + c; },
    remove() {},
    toggle(c, on) { if (on) node.classList.add(c); },
    contains: (c) => node.className.includes(c),
  };
  node.appendChild = (child) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    node.children.push(child);
    child.parentNode = node;
    child.isConnected = node.isConnected;
    return child;
  };
  node.insertBefore = (child, ref) => {
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = ref ? node.children.indexOf(ref) : -1;
    if (i === -1) node.children.push(child); else node.children.splice(i, 0, child);
    child.parentNode = node;
    child.isConnected = node.isConnected;
    return child;
  };
  Object.defineProperty(node, 'nextSibling', {
    get: () => {
      const p = node.parentNode;
      if (!p) return null;
      const i = p.children.indexOf(node);
      return i === -1 ? null : (p.children[i + 1] || null);
    },
  });
  node.append = (...kids) => { for (const k of kids) node.appendChild(k); };
  node.removeChild = (child) => {
    const i = node.children.indexOf(child);
    if (i !== -1) node.children.splice(i, 1);
    child.parentNode = null;
    child.isConnected = false;
    return child;
  };
  node.replaceChildren = (...kids) => { node.children = []; for (const k of kids) node.appendChild(k); };
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
  node.getAttribute = (k) => (Object.hasOwn(node.attrs, k) ? node.attrs[k] : null);
  node.addEventListener = () => {};
  node.attachShadow = () => { node.shadow = makeNode('#shadow'); node.shadow.isConnected = true; return node.shadow; };
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  return node;
}

/** Every string the user would read, in document order. */
function visibleText(node) {
  if (!node) return '';
  const own = node.textContent || '';
  const inner = node.shadow ? visibleText(node.shadow) : '';
  const kids = (node.children || []).map(visibleText).join(' ');
  return [own, inner, kids].filter(Boolean).join(' ');
}

/** A profile header shaped like the real x.com markup (verified 2026-08-05):
 * the Posts/Replies bar is a DIV with role=tablist whose tab links carry the
 * profile's own handle (/degenlabs, /degenlabs/with_replies), wrapped in a
 * <nav>, sitting after the header content in the column flow. The tab links
 * are the ONLY thing the dock reads — so they are the only thing the fake
 * models faithfully. */
function installProfileHeader(doc, spec = {}) {
  const column = makeNode('div');
  const headerArea = makeNode('div');   // banner/name/bio stack, opaque to the dock
  const nav = makeNode('nav');
  const tabs = makeNode('div');
  const links = (spec.tabHrefs || ['/degenlabs', '/degenlabs/with_replies']).map((href) => {
    const a = makeNode('a');
    a.setAttribute('href', href);
    return a;
  });
  tabs.querySelectorAll = (sel) => (sel.includes('a[href]') ? links : []);
  tabs.closest = (sel) => (sel === 'nav' && !spec.noNav ? nav : null);
  doc.body.appendChild(column);
  column.append(headerArea, nav);
  nav.appendChild(tabs);
  doc.querySelectorAll = (sel) => (sel.includes('tablist') ? [tabs] : []);
  return { column, headerArea, nav, tabs };
}

function mountPanel(opts = {}) {
  const doc = {};
  doc.createElement = (tag) => makeNode(tag);
  doc.body = makeNode('body');
  doc.body.isConnected = true;
  const header = opts.header ? installProfileHeader(doc, opts.header === true ? {} : opts.header) : null;

  const listeners = { message: [] };
  const posted = [];
  const sent = [];
  const timers = [];
  const pathname = opts.path || '/degenlabs';

  const win = {
    location: { pathname, search: '', href: 'https://x.com' + pathname, origin: 'https://x.com' },
    scrollX: 0,
    scrollY: opts.scrollY || 0,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    postMessage: (data) => posted.push(data),
  };
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win, self: win, document: doc, location: win.location,
    navigator: { clipboard: { writeText: () => {} } },
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => { timers.push({ kind: 'timeout', fn }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn) => { timers.push({ kind: 'interval', fn }); return timers.length; },
    clearInterval: () => {},
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp, Error, Set, Map, URL,
    chrome: {
      runtime: {
        id: 'papertrench-test',
        sendMessage: (msg) => {
          sent.push(msg);
          if (msg.type === 'pt_xray_get') return Promise.resolve({ ok: true, intel: opts.intel || null });
          if (msg.type === 'pt_xray_observe') return Promise.resolve({ ok: true, intel: opts.observedIntel || null });
          if (msg.type === 'pt_xray_plan') return Promise.resolve({ ok: true, scan: opts.scan || null });
          return Promise.resolve({});
        },
      },
      storage: {
        local: {
          get: (keys, cb) => cb({ pt_settings: opts.settings || { appEnabled: true, xrayEnabled: true } }),
          set: () => {},
        },
        onChanged: { addListener: () => {} },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-panel.js'), 'utf8'), sandbox, { filename: 'xray-panel.js' });

  return {
    doc, sent, posted, timers, header,
    text() { return visibleText(doc.body); },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
    fireMessage(data) { for (const fn of listeners.message) fn({ source: win, data }); },
    card() {
      const find = (n) => {
        if (!n) return null;
        if (n.id === 'papertrench-xray') return n;
        for (const k of n.children || []) { const hit = find(k); if (hit) return hit; }
        return null;
      };
      return find(doc.body);
    },
    wrap() { const c = this.card(); return c && c.shadow ? c.shadow.children[1] : null; },
  };
}

/** A realistic intel object, produced by the REAL view model and passed
 * through JSON exactly as a chrome.runtime message would be. */
function intelFixture() {
  const record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  XR.observeTweets(record, [
    XR.tweetFromNode(tweetNode('1800000000000000001', 'launch ' + CA, 'Fri May 02 18:30:00 +0000 2025')),
  ], T0);
  XR.mergeSmart(record, [
    follower('900', 'whale', 3_000_000),
    follower('901', 'smallish', 4_000),
  ], 'you_follow', T0);
  return plain(XR.assembleIntel(record, T0 + DAY));
}

/* ---------------- tests ---------------- */

test('a profile with nothing known yet gets a card that says what it is doing', async () => {
  const panel = mountPanel({ intel: null });
  await panel.settle();
  const text = panel.text();
  assert.match(text, /X-Ray/);
  assert.match(text, /@degenlabs/, 'the header names the account the card is about');
  assert.match(text, /Give it a second/, 'an empty state — never a blank box');
  assert.ok(panel.sent.some((m) => m.type === 'pt_xray_get' && m.handle === 'degenlabs'),
    'stored intel is asked for immediately — that is what makes the card instant');
});

test('the full intel view renders, honesty labels included', async () => {
  const panel = mountPanel({ intel: intelFixture() });
  await panel.settle();
  const text = panel.text();

  assert.match(text, /@degenlabs/);
  assert.match(text, /Created/, 'account age is stated');
  assert.match(text, /128\.4K followers/);
  assert.match(text, /No change seen/, 'an unchanged bio says so plainly');
  assert.match(text, /watching since/,
    'a change counter must NEVER appear without the window it was observed over');
  assert.match(text, /1 CA found/);
  assert.match(text, /DezX…B263/, 'the address is shown in a copyable chip');
  assert.match(text, /Smart Following/);
  assert.match(text, /★/, 'the genuinely big follower is marked');
  assert.match(text, /whale/);
  assert.match(text, /from followers you know/, 'provenance for the follower list');
  assert.match(text, /from posts read back to/, 'and for the CA history');
});

test('a bio edit and a live bio CA surface as the loud items they are', async () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const edited = userNodeCore();
  edited.legacy.description = 'new thing incoming';
  edited.core.name = 'Trench Capital';
  record = XR.observeUser(record, XR.userFromNode(edited), T0 + DAY).record;

  const panel = mountPanel({ intel: plain(XR.assembleIntel(record, T0 + DAY)) });
  await panel.settle();
  const text = panel.text();
  assert.match(text, /1 change seen/);
  assert.match(text, /was: building in the trenches/, 'the previous bio is shown, not just a count');
  assert.match(text, /CA in bio right now/, 'the bio link still carries a contract address');
});

test('X system pages get no card at all', async () => {
  for (const route of ['/home', '/messages', '/i/communities/123', '/settings/account', '/explore', '/']) {
    const panel = mountPanel({ path: route, intel: intelFixture() });
    await panel.settle();
    assert.equal(panel.text().trim(), '', route + ' must render no card');
    assert.equal(panel.sent.length, 0, route + ' must not even ask for intel');
  }
});

test('a post page shows the author of the post being read', async () => {
  const panel = mountPanel({ path: '/degenlabs/status/1800000000000000001', intel: intelFixture() });
  await panel.settle();
  assert.match(panel.text(), /@degenlabs/,
    'vetting a launch tweet is exactly when the poster\'s history matters most');
});

test('with the feature off — or PaperTrench off — the panel does nothing at all', async () => {
  const off = mountPanel({ settings: { appEnabled: true, xrayEnabled: false }, intel: intelFixture() });
  await off.settle();
  assert.equal(off.text().trim(), '');
  assert.equal(off.sent.length, 0);

  const master = mountPanel({ settings: { appEnabled: false, xrayEnabled: true }, intel: intelFixture() });
  await master.settle();
  assert.equal(master.text().trim(), '', 'the master switch outranks the feature toggle');
});

test('digests from the page world are forwarded and repaint the card in place', async () => {
  const panel = mountPanel({ intel: null, observedIntel: intelFixture() });
  await panel.settle();
  assert.doesNotMatch(panel.text(), /whale/);

  panel.fireMessage({ source: 'papertrench-xray-digest', digest: { op: 'UserByScreenName', users: [], tweets: [] } });
  await panel.settle();

  const forwarded = panel.sent.find((m) => m.type === 'pt_xray_observe');
  assert.ok(forwarded, 'the digest must reach the background');
  assert.equal(forwarded.handle, 'degenlabs', 'tagged with the route it was seen on');
  assert.match(panel.text(), /whale/, 'and the returned intel repaints the card');

  const before = panel.sent.length;
  panel.fireMessage({ source: 'something-else', digest: { op: 'UserTweets' } });
  await panel.settle();
  assert.equal(panel.sent.length, before, 'messages that are not X-Ray digests are ignored');
});

/* ---------------- placement ----------------
 *
 * On a profile the card is a real block in the header flow, inserted above
 * the Posts/Replies bar so it is part of the page and pushes the timeline
 * down — never a box floating over content. Floating survives only where
 * there is no profile tab bar at all, and always names its reason. */

test('on a profile the card is inserted into the header flow above the tab bar', async () => {
  const panel = mountPanel({ intel: intelFixture(), header: true });
  await panel.settle();
  const host = panel.card();
  const { column, nav } = panel.header;
  assert.equal(host.parentNode, column, 'the card lives inside the profile column, not <body>');
  assert.equal(host.nextSibling, nav, 'seated directly above the Posts/Replies bar');
  assert.doesNotMatch(host.style.cssText, /fixed|absolute/,
    'in the flow — the page makes room for it, nothing is covered');
  assert.ok(panel.wrap().classList.contains('dock'),
    'inline, the card wears X\'s native-card styling — no overlay shadow');
  assert.equal(panel.wrap().style.maxHeight, '420px',
    'the header grows by a bounded amount; the card scrolls inside');
  assert.equal(host.getAttribute('data-pt-dock'), 'inline',
    'the host says so inspectably — every placement is readable from devtools');
  assert.match(panel.text(), /@degenlabs/, 'and it is still the same card');
});

test('the tab bar proves whose profile it is — a lingering bar never seats the card', async () => {
  // During SPA navigation the previous profile's tab bar can still be in the
  // DOM. Its tab links carry the old handle, so it fails the match and the
  // card floats for a beat rather than joining the wrong profile.
  const panel = mountPanel({
    intel: intelFixture(),
    header: { tabHrefs: ['/someoneelse', '/someoneelse/with_replies'] },
  });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:fixed/);
  assert.equal(panel.card().parentNode, panel.doc.body);
  assert.equal(panel.card().getAttribute('data-pt-dock'), 'float:no-tabs',
    'every float names its reason on the host, readable from devtools');
});

test('a shell that skips the <nav> wrapper still seats the card above the tabs', async () => {
  // x.com's logged-out shell renders the tab strip without a <nav> around it
  // (seen live 2026-08-05); the strip itself then marks the insertion slot.
  const panel = mountPanel({ intel: intelFixture(), header: { noNav: true } });
  await panel.settle();
  const host = panel.card();
  assert.equal(host.parentNode, panel.header.nav, 'inserted beside the strip, inside its parent');
  assert.equal(host.nextSibling, panel.header.tabs);
  assert.equal(host.getAttribute('data-pt-dock'), 'inline');
});

test('post pages and headerless moments keep the floating card', async () => {
  const post = mountPanel({
    path: '/degenlabs/status/1800000000000000001',
    intel: intelFixture(),
    header: true,
  });
  await post.settle();
  assert.match(post.card().style.cssText, /position:fixed/,
    'a post page has no profile header to join, even if a tab bar is in the DOM');
  assert.equal(post.card().getAttribute('data-pt-dock'), 'float:route');

  const bare = mountPanel({ intel: intelFixture() });
  await bare.settle();
  assert.match(bare.card().style.cssText, /position:fixed/,
    'before the header renders the card still paints — instantly, floating');
});

test('the observer is told the toggle state so it can stop reading responses', async () => {
  const panel = mountPanel({ intel: null });
  await panel.settle();
  const state = panel.posted.find((m) => m && m.source === 'papertrench-xray-state');
  assert.ok(state, 'the panel must report the toggle to the MAIN world');
  assert.equal(state.enabled, true);
});

/* ---------------- ticket-0014 ---------------- */

test('a first visit plans a scan once the account is recognised, not only on later visits', async () => {
  const panel = mountPanel({ intel: null, observedIntel: intelFixture() });
  await panel.settle();
  assert.ok(!panel.sent.some((m) => m.type === 'pt_xray_plan'), 'nothing to plan before the account is known');
  panel.fireMessage({ source: 'papertrench-xray-digest', digest: { op: 'UserByScreenName', users: [], tweets: [] } });
  await panel.settle();
  for (const t of panel.timers.filter((x) => x.kind === 'timeout')) { try { await t.fn(); } catch (_) {} }
  await panel.settle();
  assert.ok(panel.sent.some((m) => m.type === 'pt_xray_plan'),
    'the digest that first names the account must schedule the plan');
});

test('unread follower lists, missing counts and unread posts are stated, never shown as loading or as a clean result', async () => {
  const intel = intelFixture();
  intel.smart = []; intel.smartAt = null;
  intel.followers = null; intel.following = null;
  intel.cas = []; intel.casDropped = 0; intel.bioCas = [];
  intel.newestTweetAt = null; intel.scannedBackTo = null;
  const panel = mountPanel({ intel });
  await panel.settle();
  const text = panel.text();
  assert.doesNotMatch(text, /Reading follower lists/, 'nothing is being read: do not say it is');
  assert.match(text, /Followers tab/, 'say how the lists get read');
  assert.doesNotMatch(text, /— followers/, 'a dash is not a count');
  assert.match(text, /counts not/i);
  assert.doesNotMatch(text, /None found/, 'no posts read is not "no contract addresses"');
  assert.match(text, /No posts read yet/);
});
