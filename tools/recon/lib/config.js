'use strict';
// Project binding for pt-recon. The capture/distill/scaffold ENGINE is site- and
// project-agnostic; the two project-specific commands (`check`, `wiring`) read
// their coupling from a `ptrecon.config.json` at the project root. This keeps
// one portable tool that serves any project — PaperTrench ships as the default
// config; another repo declares its own adapter contract and touch list.

const fs = require('node:fs');
const path = require('node:path');

// The generic skeleton. A real project overrides these. Everything a project
// might couple to lives here — nothing project-specific is hardcoded elsewhere.
const DEFAULTS = {
  project: null,
  // Where raw captures + dossiers live, relative to the project root (gitignore
  // it). PT_RECON_DATA env still wins if set (keeps secrets off a public tree).
  dataDir: 'recon-data',
  denylistFile: 'recon-data/DENYLIST.local',
  chrome: null,        // explicit Chrome/Chromium path; null = auto-discover
  chromeArgs: [],      // extra launch flags appended to the safe defaults
  // Login-frictionless options (never handle credentials — reuse a live session):
  attach: null,        // http origin of a user-started Chrome (--remote-debugging-port); attach instead of launching
  chromeProfile: null, // path to the user's REAL Chrome profile dir (already logged in) to launch with
  // `check`: how to load the project's site-adapter and call its detector.
  adapter: {
    file: null,               // e.g. 'extension/sites.js' (relative to project root)
    global: null,             // the global the adapter sets, e.g. 'PaperTrenchSites'
    currentSite: 'currentSite', // API method returning { id, detect() }
  },
  // `wiring`: the registration points a new site must touch. Each entry:
  //   { file, label, kind: 'code'|'prose'|'manifest', required: true|false|'<flag>' }
  // required may name a dossier-summary flag (e.g. 'titleDefaultFits' → required
  // only when that flag is FALSE). A 'manifest' entry also carries { lists }.
  wiring: {
    touchList: [],
    priceBridgeNote: null,    // reminder shown under the checklist (optional)
  },
  // Optional per-section "→ feeds X" hints for the DOSSIER (cosmetic). Any key
  // omitted falls back to a generic phrase.
  dossierHints: {},
};

// Returns { value } on success, { error } if the file exists but is malformed,
// or null if the file is absent. A malformed config must be LOUD, not silently
// treated as "no config" (which would fall back to defaults and run check/wiring
// against the wrong binding).
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: e.message }; }
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// Walk up from `start` looking for a ptrecon.config.json.
function discoverUp(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    const cand = path.join(dir, 'ptrecon.config.json');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Resolve the config for a run. Precedence: --config, --project/<root>, walk-up
// from cwd, then the tool's bundled default (fallbackRoot). Returns the merged
// config plus the resolved project root (all config paths are relative to it).
function loadConfig(args, fallbackRoot) {
  let configPath = null;
  let projectRoot = null;
  if (args && args.config && args.config !== true) {
    configPath = path.resolve(String(args.config));
    projectRoot = path.dirname(configPath);
  } else if (args && args.project && args.project !== true) {
    projectRoot = path.resolve(String(args.project));
    const cand = path.join(projectRoot, 'ptrecon.config.json');
    configPath = fs.existsSync(cand) ? cand : null;
  } else {
    configPath = discoverUp(process.cwd());
    if (!configPath && fallbackRoot && fs.existsSync(path.join(fallbackRoot, 'ptrecon.config.json'))) {
      configPath = path.join(fallbackRoot, 'ptrecon.config.json');
    }
    if (configPath) projectRoot = path.dirname(configPath);
  }
  if (!projectRoot) projectRoot = fallbackRoot || process.cwd();

  const r = configPath ? readJson(configPath) : null;
  if (r && r.error) {
    // Present-but-broken: fail loud rather than silently running on defaults.
    throw new Error(`ptrecon.config.json at ${configPath} is malformed JSON: ${r.error}`);
  }
  const raw = r ? r.value : null;
  const config = deepMerge(DEFAULTS, raw || {});
  return { projectRoot, configPath, config, found: !!raw };
}

const INIT_TEMPLATE = {
  project: 'my-project',
  dataDir: 'recon-data',
  denylistFile: 'recon-data/DENYLIST.local',
  chrome: null,
  chromeArgs: [],
  adapter: {
    file: 'src/adapters.js',
    global: 'MyAdapters',
    currentSite: 'currentSite',
  },
  wiring: {
    touchList: [
      { file: 'src/adapters.js', label: 'the site adapter (match/detect)', kind: 'code', required: true },
      { file: 'manifest.json', label: 'origin in the extension manifest', kind: 'manifest', required: true, lists: ['content_scripts', 'web_accessible_resources'] },
      { file: 'README.md', label: 'supported-sites list', kind: 'prose', required: true },
    ],
    priceBridgeNote: null,
  },
  dossierHints: {},
};

// Merge every candidate denylist file, skipping empty/whitespace-only ones. Do
// NOT return the first readable file: an empty leftover would SHADOW a populated
// list elsewhere (e.g. a relocated PT_RECON_DATA store), making the scrubber
// inert and leaking operator identifiers. Merging can never miss a populated
// source.
function mergeDenylists(files) {
  const seen = new Set();
  const parts = [];
  for (const f of files || []) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    try { const t = fs.readFileSync(f, 'utf8'); if (t.trim()) parts.push(t); } catch { /* absent */ }
  }
  return parts.join('\n');
}

// Write a starter config for a new project (does not overwrite an existing one).
function writeInitConfig(destDir) {
  const dest = path.join(path.resolve(destDir), 'ptrecon.config.json');
  if (fs.existsSync(dest)) return { dest, created: false };
  fs.writeFileSync(dest, JSON.stringify(INIT_TEMPLATE, null, 2) + '\n');
  return { dest, created: true };
}

module.exports = { loadConfig, writeInitConfig, mergeDenylists, discoverUp, deepMerge, DEFAULTS, INIT_TEMPLATE };
