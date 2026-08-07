'use strict';
// The recorder. Attaches to every page/iframe/worker target, records network
// bodies, WebSocket frames, SSE messages, DOM snapshots, and the in-page probe
// streams into JSONL files under <capture>/raw/. Raw captures are trusted
// local material (cookies, auth, balances) — recon-data/ is gitignored and the
// scrubbing happens later, in the distiller, at the trust boundary.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { launchChrome, connectToRunning, CDPClient } = require('./cdp');
const { PROBE_SOURCE } = require('./pageprobe');

const BODY_CAP_XHR = 2 * 1024 * 1024;
const BODY_CAP_DOC = 512 * 1024;
const WS_PAYLOAD_CAP = 128 * 1024;
const SNAPSHOT_MIN_GAP_MS = 4000;
const SNAPSHOT_MAX_PER_SESSION = 100;
const SNAPSHOT_INTERVAL_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  return new Date().toISOString();
}

class Recorder {
  constructor(capDir) {
    this.capDir = capDir;
    this.rawDir = path.join(capDir, 'raw');
    this.blobDir = path.join(this.rawDir, 'blobs');
    this.snapDir = path.join(this.rawDir, 'snapshots');
    for (const d of [this.blobDir, this.snapDir]) fs.mkdirSync(d, { recursive: true });
    this.streams = {};
    this.streamErrors = [];
    for (const name of ['events', 'network', 'ws', 'domsig', 'mutations']) {
      const st = fs.createWriteStream(path.join(this.rawDir, `${name}.jsonl`), { flags: 'a' });
      // A stream 'error' with no listener is an uncaught exception that would
      // kill the whole capture (disk full, or a write-after-end at teardown).
      // Record it and keep going — a partial capture beats a crashed one.
      st.on('error', (e) => { this.streamErrors.push(`${name}: ${e.message}`); });
      this.streams[name] = st;
    }
    this.counts = { requests: 0, bodies: 0, wsFrames: 0, sseMessages: 0, sigTicks: 0, snapshots: 0, pages: 0 };
    this.blobSeq = 0;
  }

  line(stream, obj) {
    this.streams[stream].write(JSON.stringify(obj) + '\n');
  }

  writeBlob(prefix, data) {
    const file = `${String(++this.blobSeq).padStart(5, '0')}-${prefix.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)}.bin`;
    fs.writeFileSync(path.join(this.blobDir, file), data);
    return path.join('blobs', file);
  }

  writeSnapshot(html, reason, sid) {
    const file = `${Date.now()}-${reason}-${sid.slice(0, 6)}.html.gz`;
    fs.writeFileSync(path.join(this.snapDir, file), zlib.gzipSync(html));
    this.counts.snapshots++;
    return path.join('snapshots', file);
  }

  async closeStreams() {
    await Promise.all(
      Object.values(this.streams).map(
        (s) => new Promise((resolve) => s.end(resolve)),
      ),
    );
  }
}

async function runCapture(opts) {
  const { site, capDir, chrome, profileDir, headless, startUrl, autoUrls, minutes, lingerSec = 25, attach = null } = opts;
  if (!attach) fs.mkdirSync(profileDir, { recursive: true });
  const rec = new Recorder(capDir);
  const startedAt = nowIso();
  fs.writeFileSync(
    path.join(capDir, 'manifest-open.json'),
    JSON.stringify({ rig: 'pt-recon/0.1.0', site, startedAt, chrome, headless: !!headless, startUrl, autoUrls }, null, 2),
  );

  // ATTACH mode reuses the user's already-running, already-logged-in Chrome; we
  // do not launch or own it (and must never close it). Otherwise we launch a
  // dedicated automation Chrome with a per-site persistent profile.
  let proc = null;
  let cdp;
  const owned = !attach;
  if (attach) {
    const conn = await connectToRunning(attach);
    cdp = conn.cdp;
  } else {
    const launched = await launchChrome({
      chrome,
      profileDir,
      headless,
      startUrl: autoUrls ? 'about:blank' : startUrl,
    });
    proc = launched.proc;
    cdp = await CDPClient.connect(launched.wsUrl);
    // Keep draining Chrome stderr to a log so a renderer crash / GPU fault is
    // diagnosable after the fact instead of vanishing.
    proc.stderr.on('data', (c) => { try { fs.appendFileSync(path.join(capDir, 'chrome.log'), c); } catch { /* best effort */ } });
  }

  const sessions = new Map(); // sessionId -> state
  let mainSessionId = null;
  let finished = false;
  let finishResolve;
  const finishedPromise = new Promise((r) => (finishResolve = r));

  const sessionState = (sid) => sessions.get(sid);

  async function setupSession(sessionId, targetInfo) {
    const kind = targetInfo.type;
    const state = {
      sessionId,
      targetId: targetInfo.targetId,
      kind,
      url: targetInfo.url,
      req: new Map(),
      wsUrls: new Map(),
      lastSnapshotAt: 0,
      snapshotCount: 0,
      timers: [],
    };
    sessions.set(sessionId, state);
    try {
      await cdp.send('Network.enable', { maxTotalBufferSize: 268435456, maxResourceBufferSize: 33554432 }, sessionId);
      if (kind === 'page' || kind === 'iframe') {
        rec.counts.pages++;
        if (!mainSessionId && kind === 'page') mainSessionId = sessionId;
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Runtime.addBinding', { name: '__ptrecon' }, sessionId);
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE, runImmediately: true }, sessionId);
        // The current document predates the injection hook — install directly too.
        cdp.send('Runtime.evaluate', { expression: PROBE_SOURCE }, sessionId).catch(() => {});
        state.timers.push(setInterval(() => snapshot(sessionId, 'interval'), SNAPSHOT_INTERVAL_MS));
      }
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
    } catch (e) {
      rec.line('events', { t: Date.now(), ev: 'setup-error', sid: sessionId, kind, error: e.message });
    }
  }

  async function snapshot(sessionId, reason) {
    const state = sessionState(sessionId);
    if (!state || finished) return;
    const now = Date.now();
    if (now - state.lastSnapshotAt < SNAPSHOT_MIN_GAP_MS) return;
    if (state.snapshotCount >= SNAPSHOT_MAX_PER_SESSION) return;
    state.lastSnapshotAt = now;
    state.snapshotCount++;
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
      }, sessionId);
      const html = r && r.result && typeof r.result.value === 'string' ? r.result.value : '';
      if (html.length < 100) return;
      const file = rec.writeSnapshot(html, reason, sessionId);
      rec.line('events', { t: now, ev: 'snapshot', sid: sessionId, reason, file, bytes: html.length, url: state.url });
    } catch (e) {
      rec.line('events', { t: now, ev: 'snapshot-error', sid: sessionId, error: e.message });
    }
  }

  // --- target lifecycle ------------------------------------------------------
  cdp.on('Target.attachedToTarget', (p) => {
    const t = p.targetInfo;
    if (!['page', 'iframe', 'worker', 'service_worker', 'shared_worker'].includes(t.type)) return;
    setupSession(p.sessionId, t);
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const state = p.sessionId && sessions.get(p.sessionId);
    if (!state) return;
    for (const timer of state.timers) clearInterval(timer);
    sessions.delete(p.sessionId);
  });

  // --- network ---------------------------------------------------------------
  cdp.on('Network.requestWillBeSent', (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    rec.counts.requests++;
    state.req.set(p.requestId, {
      url: p.request.url,
      method: p.request.method,
      resourceType: p.type,
      t: Date.now(),
      postData: typeof p.request.postData === 'string' ? p.request.postData.slice(0, 65536) : undefined,
      reqHeaders: p.request.headers,
    });
  });
  cdp.on('Network.responseReceived', (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    const meta = state.req.get(p.requestId);
    if (!meta) return;
    meta.status = p.response.status;
    meta.mimeType = p.response.mimeType;
    meta.resHeaders = p.response.headers;
    meta.remoteIP = p.response.remoteIPAddress;
  });
  cdp.on('Network.loadingFinished', async (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    const meta = state.req.get(p.requestId);
    if (!meta) return;
    state.req.delete(p.requestId);
    const rt = meta.resourceType || '';
    const mime = meta.mimeType || '';
    const wantBody =
      (['XHR', 'Fetch', 'EventSource', 'Other'].includes(rt) && /json|text|javascript|xml|form|urlencoded/i.test(mime) && p.encodedDataLength <= BODY_CAP_XHR) ||
      (rt === 'Document' && /html|json|text/i.test(mime) && p.encodedDataLength <= BODY_CAP_DOC);
    const lineObj = {
      t: meta.t,
      tDone: Date.now(),
      sid,
      url: meta.url,
      method: meta.method,
      resourceType: rt,
      status: meta.status,
      mimeType: mime,
      reqHeaders: meta.reqHeaders,
      resHeaders: meta.resHeaders,
      postData: meta.postData,
      encodedBytes: p.encodedDataLength,
    };
    if (wantBody && !finished) {
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sid);
        const buf = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
        lineObj.bodyFile = rec.writeBlob(p.requestId, buf);
        lineObj.bodyBytes = buf.length;
        rec.counts.bodies++;
      } catch (e) {
        lineObj.bodyError = e.message.slice(0, 120);
      }
    }
    rec.line('network', lineObj);
  });
  cdp.on('Network.loadingFailed', (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    const meta = state.req.get(p.requestId);
    if (!meta) return;
    state.req.delete(p.requestId);
    rec.line('network', {
      t: meta.t, tDone: Date.now(), sid,
      url: meta.url, method: meta.method, resourceType: meta.resourceType,
      failed: p.errorText, canceled: !!p.canceled,
    });
  });

  // --- websockets + sse ------------------------------------------------------
  cdp.on('Network.webSocketCreated', (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    state.wsUrls.set(p.requestId, p.url);
    rec.line('ws', { t: Date.now(), ev: 'open', sid, wsId: p.requestId, url: p.url });
  });
  const wsFrame = (dir) => (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    rec.counts.wsFrames++;
    const payload = p.response.payloadData || '';
    rec.line('ws', {
      t: Date.now(), dir, sid, wsId: p.requestId,
      url: state.wsUrls.get(p.requestId),
      opcode: p.response.opcode,
      payload: payload.length > WS_PAYLOAD_CAP ? payload.slice(0, WS_PAYLOAD_CAP) : payload,
      truncated: payload.length > WS_PAYLOAD_CAP ? payload.length : undefined,
    });
  };
  cdp.on('Network.webSocketFrameReceived', wsFrame('in'));
  cdp.on('Network.webSocketFrameSent', wsFrame('out'));
  cdp.on('Network.webSocketClosed', (p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    rec.line('ws', { t: Date.now(), ev: 'close', sid, wsId: p.requestId, url: state.wsUrls.get(p.requestId) });
  });
  cdp.on('Network.webSocketFrameError', (p, sid) => {
    rec.line('ws', { t: Date.now(), ev: 'error', sid, wsId: p.requestId, error: p.errorMessage });
  });
  cdp.on('Network.eventSourceMessageReceived', (p, sid) => {
    rec.counts.sseMessages++;
    rec.line('ws', {
      t: Date.now(), dir: 'in', proto: 'sse', sid, wsId: p.requestId,
      eventName: p.eventName, payload: (p.data || '').slice(0, WS_PAYLOAD_CAP),
    });
  });

  // --- page lifecycle --------------------------------------------------------
  cdp.on('Page.frameNavigated', (p, sid) => {
    const state = sessionState(sid);
    if (!state || p.frame.parentId) return;
    state.url = p.frame.url;
    rec.line('events', { t: Date.now(), ev: 'nav', sid, url: p.frame.url });
    setTimeout(() => snapshot(sid, 'nav'), 2500);
  });
  cdp.on('Page.loadEventFired', (_p, sid) => {
    const state = sessionState(sid);
    if (!state) return;
    rec.line('events', { t: Date.now(), ev: 'load', sid, url: state.url });
    setTimeout(() => snapshot(sid, 'load'), 1500);
  });

  // --- probe stream ----------------------------------------------------------
  cdp.on('Runtime.bindingCalled', (p, sid) => {
    if (p.name !== '__ptrecon') return;
    let msg;
    try {
      msg = JSON.parse(p.payload);
    } catch {
      return;
    }
    msg.sid = sid;
    if (msg.k === 'sig') {
      rec.counts.sigTicks++;
      rec.line('domsig', msg);
    } else if (msg.k === 'mut') {
      rec.line('mutations', msg);
    } else {
      rec.line('events', { ev: msg.k, ...msg });
      if (msg.k === 'act' && msg.type === 'click') setTimeout(() => snapshot(sid, 'click'), 800);
    }
  });
  cdp.on('Runtime.consoleAPICalled', (p, sid) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const text = (p.args || [])
      .slice(0, 3)
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(' ')
      .slice(0, 240);
    rec.line('events', { t: Date.now(), ev: 'console', level: p.type, sid, text });
  });
  cdp.on('Runtime.exceptionThrown', (p, sid) => {
    const d = p.exceptionDetails || {};
    const text = `${d.text || ''} ${(d.exception && d.exception.description) || ''}`.trim().slice(0, 300);
    rec.line('events', { t: Date.now(), ev: 'exception', sid, text });
  });

  // --- finish ----------------------------------------------------------------
  async function finish(reason) {
    if (finished) return;
    finished = true;
    for (const [, state] of sessions) for (const timer of state.timers) clearInterval(timer);
    clearInterval(statusTimer);
    rec.line('events', { t: Date.now(), ev: 'finish', reason });
    await sleep(300); // let in-flight handlers land their lines
    if (owned) {
      // We launched this browser — close and kill it.
      try { await Promise.race([cdp.send('Browser.close'), sleep(2000)]); } catch { /* already gone */ }
      cdp.close();
      if (proc) setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 2500).unref();
    } else {
      // Attached to the USER'S browser — detach only, never close it.
      cdp.close();
    }
    await rec.closeStreams();
    // A capture that never attached a page or recorded nothing is structurally
    // valid but empty — flag it so a downstream reader does not mistake it for a
    // clean, complete capture of a quiet site.
    const thin = rec.counts.pages === 0 || (rec.counts.requests === 0 && rec.counts.sigTicks === 0);
    const manifest = {
      rig: 'pt-recon/0.1.0',
      site,
      mode: attach ? 'attach' : autoUrls ? 'auto' : 'headed',
      startUrl,
      autoUrls,
      chrome: attach ? `attach:${attach}` : chrome,
      headless: !!headless,
      startedAt,
      endedAt: nowIso(),
      endReason: reason,
      thin,
      streamErrors: rec.streamErrors && rec.streamErrors.length ? rec.streamErrors : undefined,
      counts: rec.counts,
    };
    fs.writeFileSync(path.join(capDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.rmSync(path.join(capDir, 'manifest-open.json'), { force: true });
    finishResolve(manifest);
  }

  if (proc) proc.on('exit', (code) => finish(`browser-closed(${code})`));
  cdp.onClose(() => finish(`cdp-closed(${cdp.lastClose ? cdp.lastClose.code + ':' + cdp.lastClose.reason : '?'})`));
  process.once('SIGINT', () => finish('sigint'));
  if (minutes) setTimeout(() => finish('minutes-elapsed'), minutes * 60 * 1000).unref();

  const statusTimer = setInterval(() => {
    const c = rec.counts;
    process.stderr.write(`[pt-recon] req=${c.requests} bodies=${c.bodies} wsFrames=${c.wsFrames} sig=${c.sigTicks} snaps=${c.snapshots}\n`);
  }, 30000);

  // --- kick off --------------------------------------------------------------
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const existing = await cdp.send('Target.getTargets');
  for (const t of existing.targetInfos || []) {
    if (t.type === 'page' && !t.attached) {
      await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
    }
  }

  // Attach mode with a target URL: navigate the user's active tab there once, so
  // the capture lands on the page without them hunting for it. Without a URL they
  // just browse their own logged-in session and we record it.
  if (attach && !autoUrls && startUrl && startUrl !== 'about:blank') {
    await sleep(500);
    if (mainSessionId) cdp.send('Page.navigate', { url: startUrl }, mainSessionId).catch(() => {});
  }

  if (autoUrls && autoUrls.length) {
    await sleep(1000);
    for (const url of autoUrls) {
      if (finished) break;
      if (!mainSessionId) { await sleep(2000); }
      if (!mainSessionId) break;
      rec.line('events', { t: Date.now(), ev: 'auto-visit', url });
      const loaded = new Promise((resolve) => {
        // Remove the handler once done — otherwise every URL leaves a stale
        // load listener that fires on all subsequent navigations.
        const h = (_p, sid) => { if (sid === mainSessionId) { cdp.off('Page.loadEventFired', h); resolve(); } };
        cdp.on('Page.loadEventFired', h);
        setTimeout(() => { cdp.off('Page.loadEventFired', h); resolve(); }, 15000);
      });
      try {
        await cdp.send('Page.navigate', { url }, mainSessionId);
      } catch (e) {
        rec.line('events', { t: Date.now(), ev: 'auto-nav-error', url, error: e.message });
        continue;
      }
      await loaded;
      await sleep(6000);
      for (let i = 0; i < 3 && !finished; i++) {
        cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, Math.round(window.innerHeight*0.9))' }, mainSessionId).catch(() => {});
        await sleep(1200);
      }
      await sleep(3000);
    }
    if (!finished) {
      rec.line('events', { t: Date.now(), ev: 'auto-linger', seconds: lingerSec });
      await sleep(lingerSec * 1000);
      await finish('auto-complete');
    }
  }

  return finishedPromise;
}

module.exports = { runCapture };
