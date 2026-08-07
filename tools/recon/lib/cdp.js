'use strict';
// Zero-dependency Chrome DevTools Protocol client. Node >= 22 (global WebSocket).
// Launches a Chrome/Chromium binary with a debugging port and speaks flat-mode
// CDP: one socket, per-target sessions multiplexed by sessionId.

const { spawn } = require('node:child_process');

const LAUNCH_TIMEOUT_MS = 30000;

// Attach to an ALREADY-RUNNING Chrome — the user's own browser, already logged
// in — instead of launching a fresh one. `endpoint` is either a ws:// browser
// URL or an http origin like http://127.0.0.1:9222 (we resolve /json/version for
// the webSocketDebuggerUrl). No credentials are ever handled: the live session
// is whatever the user is already signed into. The caller must NOT close this
// browser — it belongs to the user.
async function connectToRunning(endpoint) {
  let wsUrl = endpoint;
  if (!/^wss?:\/\//i.test(endpoint)) {
    const base = (/^https?:\/\//i.test(endpoint) ? endpoint : 'http://' + endpoint).replace(/\/+$/, '');
    let j;
    try {
      const res = await fetch(base + '/json/version');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      j = await res.json();
    } catch (e) {
      throw new Error(`could not reach a running Chrome at ${base} — start Chrome with --remote-debugging-port=<port> and confirm the port (${e.message})`);
    }
    wsUrl = j && j.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error(`${base}/json/version returned no webSocketDebuggerUrl`);
  }
  const cdp = await CDPClient.connect(wsUrl);
  return { cdp, wsUrl };
}

function launchChrome({ chrome, profileDir, headless, startUrl, extraArgs = [] }) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-crash-reporter',
    // Capture must keep ticking while the window is unfocused or occluded.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // A recon browser renders nothing a human needs. Force software rendering:
    // headed Chrome launched from a service/sandboxed context often cannot spin
    // up a GPU process and FATALs ("GPU process isn't usable. Goodbye."),
    // dropping the CDP socket mid-capture. Software raster is stable and enough.
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    // Run the GPU in-process so a separate GPU-process crash cannot FATAL the
    // whole browser (headed in a no-GPU service session), and force software GL.
    '--in-process-gpu',
    '--use-angle=swiftshader',
    '--use-gl=angle',
    ...(headless ? ['--headless=new', '--window-size=1440,900'] : []),
    ...extraArgs,
    startUrl || 'about:blank',
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill();
      reject(new Error(`chrome did not report a DevTools endpoint in ${LAUNCH_TIMEOUT_MS}ms\n${err.slice(-2000)}`));
    }, LAUNCH_TIMEOUT_MS);
    const onData = (chunk) => {
      err += chunk.toString();
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m && !done) {
        done = true;
        clearTimeout(timer);
        // Detach: leaving this attached would re-scan the whole growing buffer
        // on every stderr chunk for the entire capture (unbounded mem + O(n^2)).
        // The caller re-attaches its own drain.
        proc.stderr.removeListener('data', onData);
        err = '';
        resolve({ proc, wsUrl: m[1] });
      }
    };
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`chrome exited (code ${code}) before the DevTools endpoint appeared\n${err.slice(-2000)}`));
    });
  });
}

class CDPClient {
  constructor(ws) {
    this._ws = ws;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, method}
    this._handlers = new Map(); // method -> Set<fn(params, sessionId)>
    this._closeHandlers = new Set();
    this.lastClose = null;
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', (ev) => { this.lastClose = { code: ev && ev.code, reason: ev && ev.reason ? String(ev.reason).slice(0, 200) : '' }; this._onClose(); });
    ws.addEventListener('error', (ev) => { this.lastClose = { code: 'error', reason: ev && ev.message ? String(ev.message).slice(0, 200) : 'ws error' }; this._onClose(); });
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolve(new CDPClient(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`websocket connect failed: ${wsUrl}`)), { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = this._nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      // Per-command timeout: a command Chrome never answers must not stall the
      // awaiting code forever (it used to hang until the socket happened to close).
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        this._ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this._handlers.has(method)) this._handlers.set(method, new Set());
    this._handlers.get(method).add(fn);
  }

  off(method, fn) {
    const set = this._handlers.get(method);
    if (set) set.delete(fn);
  }

  onClose(fn) {
    this._closeHandlers.add(fn);
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    const set = this._handlers.get(msg.method);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(msg.params, msg.sessionId);
      } catch (e) {
        // A recorder callback must never take the socket down with it.
        process.stderr.write(`[cdp] handler error for ${msg.method}: ${e.message}\n`);
      }
    }
  }

  _onClose() {
    for (const [, p] of this._pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error('cdp socket closed')); }
    this._pending.clear();
    for (const fn of this._closeHandlers) {
      try { fn(); } catch { /* closing */ }
    }
    this._closeHandlers.clear();
  }

  close() {
    try { this._ws.close(); } catch { /* already closed */ }
  }
}

module.exports = { launchChrome, connectToRunning, CDPClient };
