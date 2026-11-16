#!/usr/bin/env node
/* livedrive CLI — talks to the background daemon that owns the live Chrome.
 *
 *   node livedrive.mjs start            # launch the daemon detached (one Chrome, one tab)
 *   node livedrive.mjs status
 *   node livedrive.mjs chips
 *   node livedrive.mjs chip-buy --index 0
 *   node livedrive.mjs events --types row-tick --wait 15000
 *   node livedrive.mjs stop
 *
 * Exit codes: 0 ok, 1 error, 2 BLOCKED (bot check: a person must clear it),
 * 3 TAB_INVARIANT (something opened a tab), 4 refused (budget, args, not found),
 * 5 daemon not running.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib/guards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.LIVEDRIVE_STATE || 'U:/scratch/PaperTrench/livedrive';
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function call(cmd, args) {
  const st = readState();
  if (!st || !st.port || !alive(st.pid)) { console.error('livedrive is not running (node livedrive.mjs start)'); process.exit(5); }
  const res = await fetch(`http://127.0.0.1:${st.port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-livedrive-token': st.token },
    body: JSON.stringify({ cmd, args }),
    signal: AbortSignal.timeout(Number(process.env.LIVEDRIVE_TIMEOUT_MS || 180_000)),
  });
  return res.json();
}

async function start() {
  const st = readState();
  if (st && alive(st.pid)) {
    if (st.port) { console.log(`already running (pid ${st.pid}, port ${st.port})`); return; }
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(path.join(STATE_DIR, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'daemon.mjs')], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const s = readState();
    if (s && s.pid === child.pid && s.phase === 'ready') { console.log(`ready: pid ${s.pid} port ${s.port} build ${s.build.version}/${s.build.hash}`); return; }
    if (!alive(child.pid)) { console.error('daemon exited during start; see ' + path.join(STATE_DIR, 'daemon.log')); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('daemon did not report ready within 120s');
  process.exit(1);
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (!cmd || cmd === 'help') { console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8')); process.exit(0); }
if (cmd === 'start') { await start(); process.exit(0); }
const args = parseArgs(argv);
if (args._.length && !args.code) args.code = args._.join(' ');
delete args._;
const out = await call(cmd, args);
console.log(JSON.stringify(out.ok ? out.result : out, null, 2));
if (out.ok) process.exit(0);
process.exit({ BLOCKED: 2, TAB_INVARIANT: 3, NAV_BUDGET: 4, BAD_ARGS: 4, NOT_FOUND: 4, OFF_SITE: 4, UNKNOWN: 4 }[out.code] || 1);
