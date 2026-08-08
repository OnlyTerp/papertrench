#!/usr/bin/env node
'use strict';
// pt-recon — capture a real browsing session in full, distill it into a
// read-first, evidence-cited site dossier. See docs/RECON.md.
//
// Zero dependencies. Node >= 22 (global WebSocket), any Chrome/Chromium binary.
//
//   node tools/recon/ptrecon.js capture --site <id> [--url U | --auto U1,U2]
//                                       [--headless] [--minutes N] [--chrome PATH]
//   node tools/recon/ptrecon.js distill --site <id> [--capture DIR]
//   node tools/recon/ptrecon.js list

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runCapture } = require('./lib/capture');
const { distill } = require('./lib/distill');
const { runVerify, assembleExamples } = require('./lib/verify');
const { makeScrubber, loadDenylist } = require('./lib/scrub');
const { scaffold } = require('./lib/scaffold');
const { checkWiring } = require('./lib/wiring');
const { diffDossiers } = require('./lib/driftdiff');
const { loadConfig, writeInitConfig, mergeDenylists } = require('./lib/config');

// The tool's own location — the fallback project root (so PaperTrench's config
// at the repo root is found even when invoked from elsewhere in the tree).
const TOOL_ROOT = path.resolve(__dirname, '..', '..');

// Run context, set by main() from ptrecon.config.json. PROJECT_ROOT anchors all
// config-relative paths; DATA_ROOT holds captures/dossiers (gitignore it).
// Raw captures hold cookies/auth/balances — PT_RECON_DATA moves the whole store
// off the repo tree entirely, preferred so secrets never sit in a public copy.
let PROJECT_ROOT = TOOL_ROOT;
let CONFIG = null;
let DATA_ROOT = null;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    CONFIG && CONFIG.chrome,
    process.env.PT_RECON_CHROME,
    process.env.CHROME_PATH,
    // Playwright's cached Chromium (present on this machine).
    ...playwrightChromium(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // WSL-visible Windows Chrome (for a Linux node).
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    // Native Windows paths (for a win32 node, e.g. the split-brain shim here).
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  throw new Error('no Chrome/Chromium found — pass --chrome PATH or set PT_RECON_CHROME');
}

function playwrightChromium() {
  const base = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
  const out = [];
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-') || dir.includes('headless')) continue;
      const bin = path.join(base, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(bin)) out.push(bin);
    }
  } catch { /* no playwright cache */ }
  return out;
}

function siteDir(site) {
  if (!site || site === true) throw new Error('--site <id> is required');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(site)) throw new Error(`bad --site id: ${site}`);
  return path.join(DATA_ROOT, 'sites', site);
}

function stamp() {
  // Filesystem-safe sortable timestamp. Date is allowed here (real CLI run).
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function loadDenylistText() {
  const rel = (CONFIG && CONFIG.denylistFile) || 'recon-data/DENYLIST.local';
  // Merge every candidate (see mergeDenylists) so an empty leftover can never
  // shadow the real, populated denylist in a relocated data store.
  return mergeDenylists([path.resolve(PROJECT_ROOT, rel), path.join(DATA_ROOT, 'DENYLIST.local')]);
}

async function cmdCapture(args) {
  const site = args.site;
  const sd = siteDir(site);
  // ATTACH to the user's already-running, already-logged-in Chrome — the
  // frictionless path: no launch, no login, no wall. They start Chrome once with
  // --remote-debugging-port=<port>; we connect to http://127.0.0.1:<port>.
  const attach = args.attach && args.attach !== true ? String(args.attach)
    : (CONFIG && CONFIG.attach ? String(CONFIG.attach) : null);
  const chrome = attach ? null : findChrome(args.chrome);

  // Profile precedence: --profile > config.chromeProfile (the user's REAL Chrome
  // profile, already logged in) > a STABLE per-site automation profile that keeps
  // its login across captures (log in once via `login`, reused forever after).
  let profileDir = args.profile && args.profile !== true ? path.resolve(String(args.profile))
    : (CONFIG && CONFIG.chromeProfile ? path.resolve(PROJECT_ROOT, CONFIG.chromeProfile) : path.join(sd, 'profile'));
  // Chrome's profile (LevelDB, singleton locks) is unreliable on the WSL 9P
  // share seen as a UNC path by a win32 Chrome — relocate to native temp.
  if (!attach && !(args.profile || (CONFIG && CONFIG.chromeProfile)) && process.platform === 'win32' && /^\\\\/.test(path.resolve(profileDir))) {
    profileDir = path.join(os.tmpdir(), 'ptrecon-profiles', site);
  }
  const capDir = path.join(sd, 'captures', stamp());
  fs.mkdirSync(capDir, { recursive: true });

  const autoUrls = args.auto && args.auto !== true
    ? String(args.auto).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const startUrl = args.url && args.url !== true ? String(args.url) : (autoUrls ? autoUrls[0] : 'about:blank');
  // Auto mode defaults to headless, but Cloudflare/DataDome-protected sites
  // (most terminals) challenge headless — `--headed` forces a real window so
  // the passive bot check passes. `--headless` forces the reverse. Attach uses
  // whatever window the user already has open.
  const headless = args.headed ? false : (!!args.headless || !!autoUrls);
  const minutes = args.minutes && args.minutes !== true ? Number(args.minutes) : (autoUrls ? 0 : 15);

  process.stderr.write(`\n[pt-recon] capture → ${path.relative(PROJECT_ROOT, capDir)}\n`);
  process.stderr.write(attach ? `[pt-recon] mode: ATTACH → ${attach} (your logged-in Chrome; not launched, not closed)\n`
    : `[pt-recon] chrome: ${chrome}\n[pt-recon] mode: ${autoUrls ? 'auto (' + autoUrls.length + ' urls)' : 'headed'}${headless ? ' [headless]' : ''}   profile: ${profileDir}\n`);
  if (!autoUrls) {
    process.stderr.write('\n  BROWSE THE SITE to cover the dossier. Suggested script:\n');
    for (const step of [
      'Home / discover page.',
      'A token/pair page — sit on it ~30s so the live price ticks.',
      'The holders / top-traders tab (this is the HISTORY that must not price).',
      'Trade-history or your positions view if present.',
      'A second chain, if multichain (the chain-slug vocabulary).',
      'A URL that must NOT mount (settings, docs) — the refuse corpus.',
      'A logged-out → login wall, if you can, for the auth diff.',
    ]) process.stderr.write(`    • ${step}\n`);
    process.stderr.write('\n  Close the browser window (or Ctrl-C here) when done.\n\n');
  }

  const manifest = await runCapture({ site, capDir, chrome, profileDir, headless, startUrl, autoUrls, minutes, attach });
  process.stderr.write(`\n[pt-recon] capture complete: ${JSON.stringify(manifest.counts)}\n`);
  process.stderr.write(`[pt-recon] next: node tools/recon/ptrecon.js distill --site ${site}\n`);
}

// `login` — open the site in the persistent per-site profile so the user can log
// in ONCE (Google button, whatever). The profile keeps that session for every
// future `capture`, so login is never a per-capture wall again. It is just a
// capture with no time limit that waits for the window to close; the recording
// is harmless (and gitignored/scrubbed) — the point is the persisted cookies.
async function cmdLogin(args) {
  const url = args.url && args.url !== true ? String(args.url) : null;
  if (!url) throw new Error('login needs --url <the site login page>, e.g. --url https://gmgn.ai');
  process.stderr.write('\n[pt-recon] Opening a real browser window in this site\'s persistent profile.\n');
  process.stderr.write('  → Log in however you normally do (Google, wallet, whatever). pt-recon does NOT\n');
  process.stderr.write('    touch your credentials — you sign in by hand, once. When you are logged in and\n');
  process.stderr.write('    the page has settled, CLOSE the window. Every future `capture --site ' + (args.site || '<id>') + '`\n');
  process.stderr.write('    reuses this session — no login wall again.\n');
  await cmdCapture({ ...args, headed: true, url, minutes: '30' });
}

function newestCapture(site) {
  const capsDir = path.join(siteDir(site), 'captures');
  const dirs = fs.existsSync(capsDir)
    ? fs.readdirSync(capsDir).filter((d) => fs.existsSync(path.join(capsDir, d, 'manifest.json')))
    : [];
  if (!dirs.length) return null;
  dirs.sort();
  return path.join(capsDir, dirs[dirs.length - 1]);
}

async function cmdDistill(args) {
  const site = args.site;
  const capDir = args.capture && args.capture !== true
    ? path.resolve(String(args.capture))
    : newestCapture(site);
  if (!capDir) throw new Error(`no completed capture for site "${site}" — run capture first`);
  const outDir = path.join(siteDir(site), 'dossier');
  process.stderr.write(`[pt-recon] distilling ${path.relative(PROJECT_ROOT, capDir)} → ${path.relative(PROJECT_ROOT, outDir)}\n`);
  const res = distill(capDir, outDir, { denylistText: loadDenylistText(), hints: (CONFIG && CONFIG.dossierHints) || {} });
  if (res.captureBlocked) {
    process.stderr.write(`\n[pt-recon] ⚠️  CAPTURE VOID — the site served a bot challenge, not the app.\n`);
    process.stderr.write(`[pt-recon]     This dossier describes the challenge page. Re-run HEADED:\n`);
    process.stderr.write(`[pt-recon]     node tools/recon/ptrecon.js capture --site ${site} --url <URL> --headed\n`);
  }
  process.stderr.write(`\n[pt-recon] dossier written:\n`);
  process.stderr.write(`  endpoints=${res.counts.endpoints} ws=${res.counts.wsChannels} routes=${res.counts.routes} provNodes=${res.counts.provenanceNodes}\n`);
  process.stderr.write(`  chainSlugs=${res.counts.chainSlugs} redactions=${res.counts.redactions} injectionFlags=${res.counts.injectionHits}\n`);
  process.stderr.write(`  OPEN QUESTIONS: ${res.counts.openQuestions}\n`);
  for (const q of res.questions) process.stderr.write(`    [${q.id}] ${q.text.slice(0, 90)}…\n`);
  process.stderr.write(`\n[pt-recon] read: ${path.relative(PROJECT_ROOT, path.join(outDir, 'DOSSIER.md'))}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return out;
}

async function cmdCheck(args) {
  const site = args.site;
  const capDir = args.capture && args.capture !== true ? path.resolve(String(args.capture)) : newestCapture(site);
  if (!capDir) throw new Error(`no completed capture for site "${site}" — run capture first`);
  const dossierDir = path.join(siteDir(site), 'dossier');
  const corpusPath = path.join(dossierDir, 'corpus.json');
  if (!fs.existsSync(corpusPath)) throw new Error(`no corpus.json — run distill --site ${site} first`);

  // Per-site adapter contract. A project can ship more than one adapter shape
  // (token terminals vs prediction venues); `adapter.bySite[<id>]` declares
  // which one this site speaks. Declared, never sniffed — see lib/verify.js.
  const adapterBase = (CONFIG && CONFIG.adapter) || {};
  const bySite = (adapterBase.bySite || {})[site];
  const adapterCfg = { ...adapterBase, ...(bySite || {}) };
  delete adapterCfg.bySite;
  const adapterPath = args.adapter && args.adapter !== true
    ? path.resolve(String(args.adapter))
    : (adapterCfg.file ? path.join(PROJECT_ROOT, adapterCfg.file) : null);
  if (!adapterPath) throw new Error('no adapter configured — set adapter.file in ptrecon.config.json or pass --adapter PATH');
  if (!fs.existsSync(adapterPath)) throw new Error(`adapter not found: ${adapterPath} (config adapter.file, or pass --adapter PATH)`);
  const adapterSrc = fs.readFileSync(adapterPath, 'utf8');

  // Raw nav/doc URLs (unscrubbed, local only) give detect() faithful input;
  // the corpus supplies the annotations and the scrubber the display form.
  const events = readJsonl(path.join(capDir, 'raw', 'events.jsonl'));
  const network = readJsonl(path.join(capDir, 'raw', 'network.jsonl'));
  // Tab titles the capture actually recorded, keyed by the URL they were seen
  // on. A prediction adapter may read the title (Hyperliquid carries the market
  // there), so the verifier must feed it the real one — last non-empty title
  // wins, since a SPA sets a placeholder before the market's own title lands.
  const titleByUrl = new Map();
  for (const e of events) {
    const href = e.href || e.url;
    if (!href || typeof e.title !== 'string' || !e.title) continue;
    titleByUrl.set(href, e.title);
  }
  const rawUrls = [
    ...events.filter((e) => e.ev === 'nav' && (e.href || e.url)).map((e) => ({ url: e.href || e.url, title: titleByUrl.get(e.href || e.url) })),
    ...network.filter((n) => n.resourceType === 'Document' && n.url).map((n) => ({ url: n.url, title: titleByUrl.get(n.url) })),
  ];
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const scrubber = makeScrubber(loadDenylist(loadDenylistText()));

  const examples = assembleExamples(rawUrls, corpus.urls || [], scrubber);
  if (!examples.length) throw new Error(`no testable nav/doc URLs in capture ${path.basename(capDir)} (raw events.jsonl + network.jsonl) — capture a token page and re-run`);
  const { rows, summary } = runVerify(adapterSrc, examples, adapterCfg);

  process.stderr.write(`\n[pt-recon] check — ${path.relative(PROJECT_ROOT, adapterPath)} vs ${examples.length} real pages from ${path.basename(capDir)}\n\n`);
  const predictionShape = summary.shape === 'prediction';
  const icon = (r) => r.error ? '⚠️ ' : r.mounted ? '● MOUNT ' : '○ refuse';
  for (const r of rows) {
    const detail = r.error ? r.error
      : r.mounted && predictionShape ? `${r.venue || '?'} ${r.kind}=${short(r.address)} verified=${r.verified === undefined ? '—' : r.verified}`
      : r.mounted ? `${r.kind || '?'} ${short(r.address)} chain=${r.chain || '—'}` : '';
    const tag = predictionShape
      ? (r.ann.looksAuthPage ? '[auth]' : r.ann.looksHistoryPage ? '[wallet]' : r.ann.looksListPage ? '[list]' : r.ann.hadLivePrice ? '[market]' : '[other]')
      : (r.ann.looksTokenPage ? '[token]' : r.ann.looksHistoryPage ? '[history]' : r.ann.looksListPage ? '[list]' : '[other]');
    process.stderr.write(`  ${icon(r)} ${tag}${r.ann.hadLivePrice ? '·live' : ''}  ${short(r.display, 66)}\n`);
    if (detail) process.stderr.write(`           → ${detail}\n`);
    for (const f of r.flags) process.stderr.write(`           ${f.level === 'high' ? '🔴' : f.level === 'medium' ? '🟡' : f.level === 'error' ? '⚠️ ' : '·'} ${f.code}: ${f.why}\n`);
  }
  process.stderr.write(`\n[pt-recon] ${summary.verdict}\n`);
  process.stderr.write(`  ${summary.subjectNoun || 'token page'}s mounted: ${summary.subjectMounted}/${summary.subjectTotal} · refuse-candidates refused: ${summary.refuseCandidatesRefused}/${summary.refuseCandidatesTotal}\n`);
  process.stderr.write(`  flags: ${summary.high} high, ${summary.medium} medium${summary.errors ? ', ' + summary.errors + ' adapter errors' : ''}\n`);
  if (summary.high || summary.errors) process.exitCode = 1;
}

function short(s, n = 44) {
  if (!s) return '—';
  s = String(s);
  return s.length > n ? '…' + s.slice(-n) : s;
}

function twoNewestCaptures(site) {
  const capsDir = path.join(siteDir(site), 'captures');
  const dirs = fs.existsSync(capsDir)
    ? fs.readdirSync(capsDir).filter((d) => fs.existsSync(path.join(capsDir, d, 'manifest.json'))).sort()
    : [];
  return dirs.slice(-2).map((d) => path.join(capsDir, d));
}

function cmdDiff(args) {
  const site = args.site;
  let oldDir, newDir;
  if (args.old && args.old !== true && args.new && args.new !== true) {
    oldDir = path.resolve(String(args.old));
    newDir = path.resolve(String(args.new));
  } else {
    const caps = twoNewestCaptures(site);
    if (caps.length < 2) throw new Error(`need two captures for "${site}" to diff — capture again over time (have ${caps.length})`);
    // Distill each into a temp dossier so we compare like-for-like.
    const denylistText = loadDenylistText();
    const tmp = path.join(os.tmpdir(), 'ptrecon-diff-' + site);
    oldDir = path.join(tmp, 'old');
    newDir = path.join(tmp, 'new');
    process.stderr.write(`[pt-recon] distilling ${path.basename(caps[0])} (old) and ${path.basename(caps[1])} (new)…\n`);
    distill(caps[0], oldDir, { denylistText });
    distill(caps[1], newDir, { denylistText });
  }

  const d = diffDossiers(oldDir, newDir);
  process.stderr.write(`\n[pt-recon] drift: ${path.basename(oldDir)} → ${path.basename(newDir)}\n\n`);
  const section = (title, items, sev) => {
    if (!items.length) return;
    process.stderr.write(`  ${sev} ${title}:\n`);
    for (const it of items.slice(0, 20)) process.stderr.write(`      ${typeof it === 'string' ? it : (it.path ? short(it.path, 60) + ` (was seen ${it.count}x)` : JSON.stringify(it))}\n`);
  };
  section('routes REMOVED', d.routes.removed, '⚠️ ');
  section('endpoints REMOVED', d.endpoints.removed, '⚠️ ');
  section('WS channels REMOVED', d.ws.removed, '⚠️ ');
  section('stable DOM anchors GONE (dock/selectors may break)', d.anchorsGone, '⚠️ ');
  for (const s of d.shifts.filter((x) => x.severity === 'warn')) process.stderr.write(`  ⚠️  ${s.what}\n`);
  section('routes added', d.routes.added, '·');
  section('endpoints added', d.endpoints.added, '·');
  section('WS channels added', d.ws.added, '·');
  for (const s of d.shifts.filter((x) => x.severity === 'info')) process.stderr.write(`  ·  ${s.what}\n`);
  process.stderr.write(`\n[pt-recon] ${d.verdict}\n`);
  if (d.removedCount > 0) process.exitCode = 1;
}

function cmdWiring(args) {
  const site = args.site;
  const dossierDir = site ? path.join(siteDir(site), 'dossier') : null;
  let dossier = null;
  if (dossierDir && fs.existsSync(path.join(dossierDir, 'summary.json'))) {
    dossier = JSON.parse(fs.readFileSync(path.join(dossierDir, 'summary.json'), 'utf8'));
  }
  const host = args.host && args.host !== true ? String(args.host) : (dossier && dossier.primaryHost);
  if (!host) throw new Error('need a host: pass --host <host> or --site <id> (after distill, which writes the primary host)');
  const name = args.name && args.name !== true ? String(args.name) : null;

  const res = checkWiring(PROJECT_ROOT, host, dossier, name, CONFIG && CONFIG.wiring);
  process.stderr.write(`\n[pt-recon] wiring check for \`${host}\`${name ? ' (' + name + ')' : ''} across the touch list:\n\n`);
  for (const r of res.rows) {
    // ✓ present · optional/absent ? prose-unconfirmed ✗ required-code-missing
    const mark = r.status ? '✓' : r.need === 'optional' ? '·' : r.kind === 'prose' ? '?' : '✗';
    const tag = r.status ? '' : r.need === 'optional' ? ' (optional)' : r.kind === 'prose' ? ' (confirm)' : ' (REQUIRED)';
    process.stderr.write(`  ${mark} ${r.file}${tag}\n`);
    process.stderr.write(`      ${r.label}\n`);
    if (r.note && !(r.status && r.kind === 'prose')) process.stderr.write(`      → ${r.note}\n`);
  }
  if (res.priceBridgeNote) process.stderr.write(`\n  note: ${res.priceBridgeNote}\n`);
  process.stderr.write(`\n[pt-recon] ${res.verdict}\n`);
  if (res.missingRequired.length) {
    process.stderr.write('  still to wire (code): ' + res.missingRequired.map((r) => r.file).join(', ') + '\n');
  }
  if (res.proseUnconfirmed.length) {
    process.stderr.write('  confirm by hand (prose): ' + res.proseUnconfirmed.map((r) => r.file).join(', ') + '\n');
  }
  if (res.missingRequired.length) process.exitCode = 1;
}

function cmdScaffold(args) {
  const site = args.site;
  const dossierDir = path.join(siteDir(site), 'dossier');
  if (!fs.existsSync(path.join(dossierDir, 'corpus.json'))) throw new Error(`no dossier for "${site}" — run distill --site ${site} first`);
  const outDir = path.join(siteDir(site), 'scaffold');
  const res = scaffold(dossierDir, outDir, site, CONFIG && CONFIG.adapter);
  process.stderr.write(`\n[pt-recon] scaffold → ${path.relative(PROJECT_ROOT, outDir)}\n`);
  for (const f of res.files) process.stderr.write(`  ${f}\n`);
  process.stderr.write(`  from: ${res.tokenPages} token page(s), ${res.refuseRoutes} refuse route(s), ${res.endpoints} endpoint(s), ${res.wsChannels} WS channel(s)\n`);
  if (!res.tokenPages) process.stderr.write(`  ⚠️  no token page captured — the gating test has no positive rows. Capture one and re-run.\n`);
  process.stderr.write(`  These are DRAFTS with TODOs — confirm against the dossier + live site, prove the lock can fail, then copy into your test suite.\n`);
}

function cmdList() {
  const sitesDir = path.join(DATA_ROOT, 'sites');
  if (!fs.existsSync(sitesDir)) { process.stderr.write('(no captures yet)\n'); return; }
  for (const site of fs.readdirSync(sitesDir).sort()) {
    const capsDir = path.join(sitesDir, site, 'captures');
    const caps = fs.existsSync(capsDir) ? fs.readdirSync(capsDir).sort() : [];
    const hasDossier = fs.existsSync(path.join(sitesDir, site, 'dossier', 'DOSSIER.md'));
    process.stderr.write(`${site}: ${caps.length} capture(s)${hasDossier ? ', dossier ✓' : ''}\n`);
  }
}

function cmdInit(args) {
  const dest = args.project && args.project !== true ? String(args.project) : process.cwd();
  const { dest: file, created } = writeInitConfig(dest);
  if (created) {
    process.stderr.write(`[pt-recon] wrote ${file}\n  Edit it: set adapter.file/global and wiring.touchList for your project, then\n  add its dataDir to .gitignore. capture/distill work immediately; check/wiring use the config.\n`);
  } else {
    process.stderr.write(`[pt-recon] ${file} already exists — not overwriting.\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  // `init` writes a config; it must run BEFORE config resolution.
  if (cmd === 'init') { cmdInit(args); return; }

  // Resolve the project binding: --config, --project, walk-up from cwd, else the
  // tool's own repo (PaperTrench). Sets the run context every command reads.
  const resolved = loadConfig(args, TOOL_ROOT);
  PROJECT_ROOT = resolved.projectRoot;
  CONFIG = resolved.config;
  DATA_ROOT = process.env.PT_RECON_DATA
    ? path.resolve(process.env.PT_RECON_DATA)
    : path.join(PROJECT_ROOT, CONFIG.dataDir || 'recon-data');
  if (!resolved.found && ['check', 'wiring'].includes(cmd)) {
    process.stderr.write('[pt-recon] no ptrecon.config.json found — check/wiring need one. Run `ptrecon init`, or pass --project <dir>.\n');
  }

  fs.mkdirSync(DATA_ROOT, { recursive: true });
  try {
    if (cmd === 'capture') await cmdCapture(args);
    else if (cmd === 'login') await cmdLogin(args);
    else if (cmd === 'distill') await cmdDistill(args);
    else if (cmd === 'check') await cmdCheck(args);
    else if (cmd === 'scaffold') cmdScaffold(args);
    else if (cmd === 'wiring') cmdWiring(args);
    else if (cmd === 'diff') cmdDiff(args);
    else if (cmd === 'list') cmdList();
    else {
      process.stderr.write('pt-recon — capture a site, distill an evidence-cited dossier, verify your adapter.\n');
      process.stderr.write(`  project: ${resolved.found ? CONFIG.project || PROJECT_ROOT : '(none — run `init`)'}   data: ${DATA_ROOT}\n\n`);
      process.stderr.write('  capture  --site <id> [--url U | --auto U1,U2] [--headed] [--attach http://127.0.0.1:9222] [--profile DIR]\n');
      process.stderr.write('  login    --site <id> --url <U>                  # log in ONCE in a persistent profile; reused by every capture\n');
      process.stderr.write('  distill  --site <id> [--capture DIR]\n');
      process.stderr.write('  scaffold --site <id>                            # draft the gating test + fake from the dossier\n');
      process.stderr.write('  check    --site <id> [--adapter PATH]           # run your detect() over the real captured pages\n');
      process.stderr.write('  wiring   --site <id> | --host <host> [--name N] # is the host in every touch-list file?\n');
      process.stderr.write('  diff     --site <id>                            # drift: diff the two newest captures\n');
      process.stderr.write('  init     [--project DIR]                        # scaffold a ptrecon.config.json for a project\n');
      process.stderr.write('  list\n\n');
      process.stderr.write('  Global flags: --project <dir> | --config <file> select the project binding.\n');
      process.stderr.write('  See docs/RECON.md and .claude/skills/pt-recon/SKILL.md.\n');
      process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    process.stderr.write(`\n[pt-recon] ERROR: ${e.message}\n`);
    process.exitCode = 1;
  }
}

main();
