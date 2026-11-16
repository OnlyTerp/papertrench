/* livedrive daemon — the ONLY owner of the live test Chrome.
 *
 * One Chrome, one tab, driven like a person: in-app clicks are free, full
 * page loads (refresh / URL load / extension reload) spend a small rolling
 * budget, nothing ever opens a second tab, and a bot check freezes every
 * site action until a human clears it. There is no remote-debugging port:
 * the only way in is this daemon's localhost API (token-guarded), so no
 * probe script can quietly open tabs behind its back.
 *
 * Start it with `node livedrive.mjs start` (detached) or `node daemon.mjs`
 * (foreground). See README.md.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NavBudget, detectChallenge } from './lib/guards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = process.env;
const STATE_DIR = ENV.LIVEDRIVE_STATE || 'U:/scratch/PaperTrench/livedrive';
const PROFILE = ENV.LIVEDRIVE_PROFILE || 'U:/scratch/PaperTrench/axiom-live/profile';
const EXT = path.resolve(ENV.LIVEDRIVE_EXT || path.join(HERE, '../../extension'));
const PW_FROM = ENV.LIVEDRIVE_PLAYWRIGHT_FROM || 'C:/PaperTrench-livepass/package.json';
const CHROME = ENV.LIVEDRIVE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const START_URL = ENV.LIVEDRIVE_START || 'https://axiom.trade/pulse?chain=sol';
const NAV_MAX = Number(ENV.LIVEDRIVE_NAV_MAX || 5);
// Chrome launches get their own, much tighter cap: three in a few minutes drew
// an interactive Cloudflare check on 2026-11-16 with only one tab ever open.
const LAUNCH_MAX = Number(ENV.LIVEDRIVE_LAUNCH_MAX || 2);
const LAUNCH_WINDOW_MS = Number(ENV.LIVEDRIVE_LAUNCH_WINDOW_MS || 60 * 60_000);
const NAV_WINDOW_MS = Number(ENV.LIVEDRIVE_NAV_WINDOW_MS || 10 * 60_000);
const RING_MAX = 8000;

fs.mkdirSync(path.join(STATE_DIR, 'shots'), { recursive: true });
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const ACTIONS = path.join(STATE_DIR, 'actions.jsonl');

// ---- single instance -------------------------------------------------------
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
try {
  const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (prev.pid && prev.pid !== process.pid && alive(prev.pid)) {
    console.error(`livedrive already running (pid ${prev.pid}, port ${prev.port})`);
    process.exit(4);
  }
} catch { /* no state: fine */ }
const TOKEN = crypto.randomBytes(16).toString('hex');
const writeState = (extra) => fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, token: TOKEN, ...extra }, null, 2));
writeState({ phase: 'starting', startedAt: Date.now() });

const logAction = (rec) => fs.appendFileSync(ACTIONS, JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');

// ---- build identity --------------------------------------------------------
function buildOnDisk() {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'test' || ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p); else files.push(p);
    }
  };
  walk(EXT);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(path.relative(EXT, f)); h.update(fs.readFileSync(f)); }
  const version = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
  return { version, hash: h.digest('hex').slice(0, 12) };
}

// ---- browser ---------------------------------------------------------------
// The load budget outlives the daemon: a Chrome relaunch is the heaviest
// "load" there is, so it is counted too, and refused when the budget is spent.
const NAVLOG = path.join(STATE_DIR, 'navlog.json');
const budget = new NavBudget({ max: NAV_MAX, windowMs: NAV_WINDOW_MS });
try { budget.log = JSON.parse(fs.readFileSync(NAVLOG, 'utf8')); } catch { /* first run */ }
const saveBudget = () => fs.writeFileSync(NAVLOG, JSON.stringify(budget.log));
{
  const LAUNCHES = path.join(STATE_DIR, 'launches.json');
  const launches = new NavBudget({ max: LAUNCH_MAX, windowMs: LAUNCH_WINDOW_MS });
  try { launches.log = JSON.parse(fs.readFileSync(LAUNCHES, 'utf8')); } catch { /* first run */ }
  const l = launches.take('launch');
  if (!l.ok && !ENV.LIVEDRIVE_FORCE_LAUNCH) {
    console.error(`refusing to relaunch Chrome: ${l.used}/${l.max} launches in the last ${Math.round(l.windowMs / 60000)} min; retry in ${Math.ceil(l.retryInMs / 60000)} min (LIVEDRIVE_FORCE_LAUNCH=1 overrides)`);
    try { fs.unlinkSync(STATE_FILE); } catch { /* fine */ }
    process.exit(6);
  }
  fs.writeFileSync(LAUNCHES, JSON.stringify(launches.log));
  const slot = budget.take('launch');
  if (!slot.ok) {
    console.error(`refusing to relaunch Chrome: ${slot.used}/${slot.max} page loads in the last ${Math.round(slot.windowMs / 60000)} min; retry in ${Math.ceil(slot.retryInMs / 1000)}s`);
    try { fs.unlinkSync(STATE_FILE); } catch { /* fine */ }
    process.exit(6);
  }
  saveBudget();
}
const { chromium } = createRequire(PW_FROM)('playwright');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  args: [
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--window-size=1500,950',
    ...(ENV.LIVEDRIVE_WINDOW_POS ? [`--window-position=${ENV.LIVEDRIVE_WINDOW_POS}`] : []),
    // Keep the tab live when the window sits behind other windows, so the
    // driver can run in the background without its feeds being throttled.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

const cdp = await ctx.browser().newBrowserCDPSession();
const loaded = await cdp.send('Extensions.loadUnpacked', { path: EXT });
const EXT_ID = loaded.id;
let loadedBuild = buildOnDisk();
// Page-world scripts (price-bridge etc.) only change with a new document;
// an extension reload re-injects the isolated scripts but leaves these as
// they were when the page last loaded.
function mainWorldHash() {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const files = [...new Set((m.content_scripts || []).filter((c) => c.world === 'MAIN').flatMap((c) => c.js || []))].sort();
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f); h.update(fs.readFileSync(path.join(EXT, f))); }
  return h.digest('hex').slice(0, 12);
}
let pageMainHash = null;

async function extensionWorker(timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const w = ctx.serviceWorkers().find((s) => s.url().startsWith(`chrome-extension://${EXT_ID}/`));
    if (w) return w;
    if (Date.now() - t0 > timeoutMs) throw new Error('extension service worker did not start');
    await new Promise((r) => setTimeout(r, 250));
  }
}
let sw = await extensionWorker();

// The one tab. Anything else that shows up is closed and counted.
const pages = ctx.pages();
const main = pages[0] || await ctx.newPage(); // the only newPage in this file: an empty profile window
const tabEvents = { driverOpened: 0, extensionOpened: 0, startupExtra: 0, log: [] };
for (const extra of pages.slice(1)) { tabEvents.startupExtra++; await extra.close().catch(() => {}); }
// Who opened it decides whose fault it is: a tab whose opener is our tab came
// from the page (a click, window.open) and breaks the one-tab rule; a tab with
// no opener came from the extension or browser (chrome.tabs.create, e.g. the
// chart tab PaperTrench opens after a list buy that starts a new position).
// Both are closed; only the first fails the command.
tabEvents.pending = 0;
ctx.on('page', async (p) => {
  if (p === main) return;
  tabEvents.pending++;
  try {
    const opener = await p.opener().catch(() => null);
    const url = p.url();
    const fromPage = opener === main;
    if (fromPage) tabEvents.driverOpened++; else tabEvents.extensionOpened++;
    tabEvents.log.push({ t: Date.now(), url, opener: fromPage ? 'page' : 'none' });
    if (tabEvents.log.length > 50) tabEvents.log.shift();
    record({ kind: 'tab', type: 'tab-opened', payload: { url, opener: fromPage ? 'page' : 'none' } });
    await p.close().catch(() => {});
  } finally { tabEvents.pending--; }
});

// ---- passive recorders (installed once, survive navigation) -----------------
const ring = [];
const lastByType = {};
let seq = 0;
function record(ev) {
  ev.seq = ++seq;
  ev.t = ev.t || Date.now();
  lastByType[ev.type] = ev.t;
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}
await main.exposeFunction('__ldEmit', (raw) => {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  record(ev);
});
const RECORDER = `(() => {
  if (window.__ldRec) return; window.__ldRec = 1;
  const send = (o) => { try { const s = JSON.stringify(o); window.__ldEmit(s.length > 12000 ? JSON.stringify({ ...o, payload: { truncated: true, head: s.slice(0, 3000) } }) : s); } catch (e) {} };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.source !== 'papertrench-bridge' && d.source !== 'papertrench-content') return;
    send({ kind: 'bridge', src: d.source, type: d.type, payload: d.payload });
  });
  // Every toast the extension shows, verbatim (O-28 slots: .pt-toast in #pt-toast-root).
  const seen = new WeakSet();
  setInterval(() => {
    const h = document.getElementById('papertrench-host');
    const root = h && h.shadowRoot && h.shadowRoot.getElementById('pt-toast-root');
    if (!root) return;
    for (const el of root.querySelectorAll('.pt-toast')) {
      if (seen.has(el)) continue;
      seen.add(el);
      send({ kind: 'toast', type: 'toast', payload: { text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) } });
    }
  }, 150);
})();`;
await main.addInitScript(RECORDER);
// Console from EVERY world in the tab. Playwright's page 'console' event drops
// the extension's isolated world, which is where content.js logs (row-buy
// timing lines etc.), so listen on a raw CDP session instead.
const pageCdp = await ctx.newCDPSession(main);
const worlds = new Map(); // executionContextId -> world name ('' = page)
pageCdp.on('Runtime.executionContextCreated', ({ context }) => worlds.set(context.id, (context.auxData && context.auxData.type === 'isolated') ? (context.name || 'isolated') : ''));
pageCdp.on('Runtime.executionContextsCleared', () => worlds.clear());
pageCdp.on('Runtime.consoleAPICalled', (ev) => {
  const text = (ev.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
  const world = worlds.get(ev.executionContextId) || '';
  const ours = world.toLowerCase().includes('papertrench') || /papertrench|row-buy|\[PT/i.test(text);
  if (ev.type === 'error' || ours) record({ kind: 'console', type: 'console', payload: { level: ev.type, world: world || 'page', text: text.slice(0, 600) } });
});
await pageCdp.send('Runtime.enable');
main.on('framenavigated', (f) => { if (f === main.mainFrame()) record({ kind: 'nav', type: 'nav', payload: { url: f.url() } }); });

// ---- bot-check gate ------------------------------------------------------------
let blocked = null;
async function checkChallenge() {
  const snap = await main.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body && document.body.innerText || '').slice(0, 4000),
    hasChallengeFrame: !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #cf-challenge-running'),
  })).catch(() => null);
  if (!snap) return blocked;
  const reason = detectChallenge(snap);
  if (reason && !blocked) {
    blocked = { since: Date.now(), reason, url: snap.url };
    record({ kind: 'gate', type: 'blocked', payload: blocked });
    logAction({ event: 'BLOCKED', ...blocked });
    await main.screenshot({ path: path.join(STATE_DIR, 'shots', 'blocked.png') }).catch(() => {});
  } else if (!reason && blocked) {
    record({ kind: 'gate', type: 'unblocked', payload: { after: Date.now() - blocked.since } });
    logAction({ event: 'UNBLOCKED', after: Date.now() - blocked.since });
    blocked = null;
  }
  return blocked;
}
setInterval(() => { checkChallenge().catch(() => {}); }, 5000).unref();

// ---- helpers -----------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
class Refusal extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }

function spend(kind) {
  const r = budget.take(kind);
  if (!r.ok) throw new Refusal('NAV_BUDGET', `full page load refused: ${r.used}/${r.max} used in the window, retry in ${Math.ceil(r.retryInMs / 1000)}s`, r);
  saveBudget();
  logAction({ nav: kind, used: r.used, max: r.max });
  return r;
}

// MV3 workers idle out and restart; never trust a cached handle.
async function swEval(fn, arg) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < 15_000) {
    const w = ctx.serviceWorkers().filter((s) => s.url().startsWith(`chrome-extension://${EXT_ID}/`)).pop();
    if (w) {
      try { sw = w; return await w.evaluate(fn, arg); }
      catch (e) { lastErr = e; if (!/closed|Target|destroyed/i.test(e.message)) throw e; }
    }
    await wait(300);
  }
  throw lastErr || new Error('extension service worker unavailable for 15s');
}


// Live context handed to commands.mjs (re-imported on every call).
const D = {
  ctx, main, pageCdp, EXT_ID, STATE_DIR, ring, tabEvents, lastByType, budget,
  get sw() { return sw; }, set sw(v) { sw = v; },
  get loadedBuild() { return loadedBuild; }, set loadedBuild(v) { loadedBuild = v; },
  mainWorldHash, get pageMainHash() { return pageMainHash; }, set pageMainHash(v) { pageMainHash = v; },
  get blocked() { return blocked; },
  buildOnDisk, swEval, spend, wait, Refusal, shutdown: () => shutdown(),
};

// ---- serial executor with invariant checks ------------------------------------
let chain = Promise.resolve();
function run(name, args) {
  const job = chain.then(async () => {
    const CMD_FILE = path.join(HERE, 'commands.mjs');
    const mod = await import(pathToFileURL(CMD_FILE).href + '?v=' + fs.statSync(CMD_FILE).mtimeMs);
    const SITE_SAFE = mod.SITE_SAFE;
    const fn = mod.makeCommands(D)[name];
    if (!fn) throw new Refusal('UNKNOWN', `unknown command ${name}`);
    if (!SITE_SAFE.has(name) && await checkChallenge()) throw new Refusal('BLOCKED', `bot check on the page (${blocked.reason}); a person has to clear it in the livedrive window`, blocked);
    const before = tabEvents.driverOpened;
    const t0 = Date.now();
    const result = await fn(args || {});
    await wait(150); // let a stray popup surface before counting
    for (let i = 0; i < 20 && tabEvents.pending > 0; i++) await wait(50);
    if (!SITE_SAFE.has(name)) await checkChallenge();
    if (tabEvents.driverOpened > before) throw new Refusal('TAB_INVARIANT', `${name} opened ${tabEvents.driverOpened - before} extra tab(s); closed`, tabEvents.log.slice(-3));
    if (ctx.pages().length > 1) await wait(300);
    return { ms: Date.now() - t0, pages: ctx.pages().length, blocked: !!blocked, ...result };
  });
  chain = job.catch(() => {});
  return job;
}

// ---- API -------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.headers['x-livedrive-token'] !== TOKEN) return reply(403, { ok: false, code: 'TOKEN' });
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let msg;
    try { msg = JSON.parse(body || '{}'); } catch { return reply(400, { ok: false, code: 'BAD_JSON' }); }
    const { cmd, args } = msg;
    const t0 = Date.now();
    try {
      const result = await run(cmd, args);
      logAction({ cmd, args, ok: true, ms: Date.now() - t0, url: main.url(), pages: ctx.pages().length });
      reply(200, { ok: true, cmd, result });
    } catch (e) {
      const code = e.code || 'ERROR';
      logAction({ cmd, args, ok: false, code, error: String(e.message).slice(0, 300) });
      reply(200, { ok: false, cmd, code, error: e.message, extra: e.extra });
    }
  });
});
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  // First load of the session: the start page, in the tab Chrome opened.
  // The one load the driver starts itself: the extension can only be added
  // after Chrome is up, so the session's first page comes after it.
  await main.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch((e) => record({ kind: 'nav', type: 'nav-error', payload: { error: e.message } }));
  pageMainHash = mainWorldHash();
  await wait(3000);
  await checkChallenge();
  writeState({ phase: 'ready', port, extId: EXT_ID, build: loadedBuild, startedAt: Date.now() });
  logAction({ event: 'READY', port, build: loadedBuild, blocked });
  console.log(`livedrive ready on 127.0.0.1:${port} ext ${EXT_ID} build ${loadedBuild.version}/${loadedBuild.hash}${blocked ? ' BLOCKED: ' + blocked.reason : ''}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logAction({ event: 'STOP' });
  try { await ctx.close(); } catch { /* already gone */ }
  try { fs.unlinkSync(STATE_FILE); } catch { /* fine */ }
  server.close();
  process.exit(0);
}
ctx.on('close', () => { if (!shuttingDown) { logAction({ event: 'BROWSER_CLOSED' }); try { fs.unlinkSync(STATE_FILE); } catch {} process.exit(0); } });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
