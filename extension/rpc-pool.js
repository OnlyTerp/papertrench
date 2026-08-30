/* PaperTrench — keyless RPC endpoint pool.
 *
 * WHY THERE IS NO API KEY HERE
 *
 * An extension bundle is public. Anyone can unzip a published build and grep
 * it in under a minute, which is how Avast (7M users), Awesome Screen Recorder
 * (3M) and Equatio (5M) all leaked live credentials. A shipped key is a public
 * key, and one shared key would also mean one shared rate limit for every user
 * of the product.
 *
 * Public Solana RPC limits are enforced PER IP, not per key:
 *
 *   100 requests / 10s per IP
 *   5 concurrent WebSocket subscriptions per IP
 *
 * Every user has their own IP, so a keyless endpoint scales to any number of
 * installs — each install gets its own budget. PaperTrench needs one or two
 * subscriptions for the token on screen, comfortably inside the per-IP cap.
 *
 * Endpoints do go down and do throttle: publicnode streamed nine updates in one
 * probe and zero in the next. So this is a POOL, not a URL. It scores endpoints
 * on observed health and moves on the moment one stops delivering.
 *
 * A user can still point PaperTrench at their own private endpoint in Settings,
 * and it will be preferred. Nobody is required to.
 */
(() => {
  'use strict';

  /**
   * Verified keyless mainnet endpoints. Each was probed live for HTTP account
   * reads and WebSocket `accountSubscribe` streaming. Order is the starting
   * preference only — real ordering comes from measured health.
   */
  const PUBLIC_ENDPOINTS = [
    { id: 'publicnode', http: 'https://solana-rpc.publicnode.com', ws: 'wss://solana-rpc.publicnode.com' },
    { id: 'solana-labs', http: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
    { id: 'tatum', http: 'https://solana-mainnet.gateway.tatum.io', ws: null },
  ];

  // An endpoint that fails is benched, not discarded; transient 429s recover.
  const COOLDOWN_MS = 60_000;
  const THROTTLE_DEFAULT_MS = 2_000;
  const THROTTLE_MAX_MS = 15_000;
  const PROBE_TIMEOUT_MS = 4000;
  // Heavy reads (getProgramAccounts over the whole PumpSwap program) legiti-
  // mately take longer than the ordinary 4s ceiling from THIS machine. A
  // timeout on such a read is OUR ceiling being wrong, not the endpoint dying
  // — measured 2026-08-28: one real gPA benched all three endpoints inside
  // two calls purely via 'This operation was aborted'. Methods that match
  // get a longer ceiling. (DEFECT F-62)
  const PROBE_TIMEOUT_SLOW_MS = 15_000;
  const SLOW_METHODS = new Set(['getProgramAccounts', 'getMultipleAccounts', 'getSignatureStatuses']);
  function timeoutFor(method) {
    return SLOW_METHODS.has(method) ? PROBE_TIMEOUT_SLOW_MS : PROBE_TIMEOUT_MS;
  }
  // A policy refusal (HTTP 403) is not a transient strike: it is the endpoint
  // saying 'not for you', and it does not heal. Treating it as transient made
  // one gPA-403 from the pool head drag the whole pool into cooldown while
  // the honest calls kept failing over into the same bench (ark_trades13
  // 2026-08-27 debug log: 56 error groups, 'rpc pool cooling down' x243).
  // (DEFECT F-63)
  const METHOD_BLOCK_MS = 30 * 60_000;
  // Evidence law for method blocks (feed4/final2 lessons, 2026-08-28): these
  // keyless endpoints run WAFs that burst-block ANY method under rapid
  // multi-call traffic — publicnode served getMultipleAccounts fine when calm
  // and 403'd it seconds later mid-prewatch. So ONE 403 must NOT bench the
  // endpoint and must NOT hard-block the method: it DEMOTES the endpoint to
  // the back of the ranking for DEMOTE_MS (hostile-to-this-client-right-now)
  // and arms pending evidence. A SECOND 403 on the same (endpoint, method)
  // inside the evidence window confirms real policy and blocks the method
  // for METHOD_BLOCK_MS. Any success clears the demotion and the pending
  // evidence instantly. (DEFECT F-63, refined twice)
  const METHOD_EVIDENCE_MS = 10 * 60_000;
  // D-65 refusal memory: a HARD policy refusal (ark_trades13 2026-08-30: 1801
  // identical 'http 403 getMultipleAccounts @ publicnode' across 6.5h) should
  // not be re-paid every batch read while the two-strike evidence law waits
  // for confirmation. The FIRST 403 on (endpoint, method) records a sliding
  // refusal-memory entry: the endpoint ranks LAST for that method (behind the
  // healthy hedge) until the window lapses. Any later 403 refreshes it; any
  // success clears it. Unlike methodBlocks this never feeds the pool-wide
  // fast-fail — the other endpoints stay first-class.
  const REFUSAL_MEMORY_MS = 10 * 60_000;
  const DEMOTE_MS = 45_000;
  // Failed strikes forgive after two quiet minutes: a single blip right
  // after a bench expiry used to re-bench an endpoint for another full
  // minute, forever. (part of F-63)
  const FAILURE_DECAY_MS = 120_000;
  // The half-open probe rotates through the pool instead of always trusting
  // the head; one dead head used to re-probe itself forever while healthy
  // endpoints stayed benched behind it. The F-09 contract ('exactly one
  // endpoint touched') still holds — rotation changes WHICH one, not HOW
  // MANY. (part of F-63)
  let probeCursor = 0;

  const health = new Map(); // id -> { failures, benchedUntil, latencyMs, samples }
  let userEndpoint = null;

  /* Health persists across service-worker restarts. MV3 kills the worker
   * constantly, and an in-memory map made every wake re-learn which
   * endpoint is fast — a user whose region throttles the pool re-paid the
   * discovery cost dozens of times a session. Geography changes rarely;
   * the map is tiny; storage.local it is. Node (the test runner) has no
   * chrome — persistence degrades to a no-op there, never a throw. */
  const HEALTH_KEY = 'pt_rpc_health';
  let healthSaveTimer = null;
  function persistHealthSoon() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      if (healthSaveTimer) return;
      healthSaveTimer = setTimeout(() => {
        healthSaveTimer = null;
        const out = {};
        for (const [id, s] of health) {
          out[id] = { latencyMs: s.latencyMs, failures: s.failures, samples: s.samples || 0, methodBlocks: s.methodBlocks || {} };
        }
        try { chrome.storage.local.set({ [HEALTH_KEY]: out }); } catch (_) {}
      }, 500);
    } catch (_) {}
  }
  (function restoreHealth() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get([HEALTH_KEY], (value) => {
        if (chrome.runtime && chrome.runtime.lastError) return;
        const saved = value && value[HEALTH_KEY];
        if (!saved || typeof saved !== 'object') return;
        for (const id of Object.keys(saved)) {
          const s = saved[id];
          // Merge only where this session has learned nothing yet — live
          // observations always beat a restored estimate. Benches never
          // restore: a 60s cooldown from a dead worker is ancient history.
          const cur = stateFor(id);
          if (cur.latencyMs == null && typeof s.latencyMs === 'number') cur.latencyMs = s.latencyMs;
          if (typeof s.samples === 'number') cur.samples = Math.max(cur.samples || 0, s.samples);
          if (s.methodBlocks && typeof s.methodBlocks === 'object') {
            cur.methodBlocks = Object.assign({}, cur.methodBlocks, s.methodBlocks);
          }
        }
      });
    } catch (_) {}
  })();

  function stateFor(id) {
  if (!health.has(id)) health.set(id, { failures: 0, benchedUntil: 0, throttledUntil: 0, latencyMs: null, samples: 0, methodBlocks: {}, methodEvidence: {}, refusals: {}, demotedUntil: 0, lastFailureAt: 0 });
  return health.get(id);
  }

  /** A user-supplied endpoint always wins over the public pool. */
  function setUserEndpoint(url) {
    if (!url || typeof url !== 'string') { userEndpoint = null; return; }
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) { userEndpoint = null; return; }
    userEndpoint = {
      id: 'user',
      http: trimmed,
      ws: trimmed.replace(/^http/i, 'ws'),
    };
  }

  function hasUserEndpoint() { return Boolean(userEndpoint); }

  /**
   * Endpoints in preference order: healthiest first, benched ones last.
   *
   * Sorting rather than filtering matters — if every endpoint is benched we
   * still return the least-bad one instead of leaving the user with no feed.
   */
  function ranked(opts) {
    const needsWs = Boolean(opts && opts.websocket);
    const method = opts && opts.method ? String(opts.method) : null;
    const now = Date.now();
    const list = [];
    if (userEndpoint && (!needsWs || userEndpoint.ws)) list.push(userEndpoint);

    const pool = PUBLIC_ENDPOINTS
      .filter((endpoint) => !needsWs || endpoint.ws)
      .slice()
      .sort((a, b) => {
        const sa = stateFor(a.id);
        const sb = stateFor(b.id);
        const benchedA = sa.benchedUntil > now ? 1 : 0;
        const benchedB = sb.benchedUntil > now ? 1 : 0;
        if (benchedA !== benchedB) return benchedA - benchedB;
        // A method-block is worse than a bench: even after the bench lapses
        // this endpoint still refuses this method, so for THIS call it ranks
        // behind endpoints that merely throttled. (F-63)
        const blockedA = method && sa.methodBlocks[method] > now ? 1 : 0;
        const blockedB = method && sb.methodBlocks[method] > now ? 1 : 0;
        if (blockedA !== blockedB) return blockedA - blockedB;
        // D-65 refusal memory: a live (endpoint, method) refusal entry ranks
        // the endpoint behind any healthy one — same treatment as a confirmed
        // method block, but armed by the FIRST 403, not the second. Sliding:
        // any later 403 refreshes the window; a 200 clears it.
        const refusedA = method && (sa.refusals[method] || 0) > now ? 1 : 0;
        const refusedB = method && (sb.refusals[method] || 0) > now ? 1 : 0;
        if (refusedA !== refusedB) return refusedA - refusedB;
        // A fresh 403 demotes to the back of the line for DEMOTE_MS: the
        // endpoint just called this client hostile — the next call should
        // start elsewhere. Any success lifts it. (F-63 refined)
        const demotedA = sa.demotedUntil > now ? 1 : 0;
        const demotedB = sb.demotedUntil > now ? 1 : 0;
        if (demotedA !== demotedB) return demotedA - demotedB;
        const throttledA = sa.throttledUntil > now ? 1 : 0;
        const throttledB = sb.throttledUntil > now ? 1 : 0;
        if (throttledA !== throttledB) return throttledA - throttledB;
        if (sa.failures !== sb.failures) return sa.failures - sb.failures;
        // Prefer a measured-fast endpoint; unmeasured sorts after measured.
        const la = sa.latencyMs == null ? Infinity : sa.latencyMs;
        const lb = sb.latencyMs == null ? Infinity : sb.latencyMs;
        return la - lb;
      });

    return list.concat(pool);
  }

  function reportSuccess(id, latencyMs, opts) {
    const state = stateFor(id);
    state.failures = 0;
    state.benchedUntil = 0;
    if (!(opts && opts.transport === 'ws')) state.throttledUntil = 0;
    state.lastFailureAt = 0;
    // A success is proof the endpoint serves — pending method-block evidence
    // was a WAF blip, not policy. Disarm it, and lift the 403 demotion.
    if (state.methodEvidence && Object.keys(state.methodEvidence).length) state.methodEvidence = {};
    // D-65: a 200 also clears refusal memory — the batch lane is restored
    // the moment the endpoint actually answers.
    if (state.refusals && Object.keys(state.refusals).length) state.refusals = {};
    if (state.demotedUntil) state.demotedUntil = 0;
    if (latencyMs != null) {
      // Smooth the estimate so one slow response cannot demote a good endpoint.
      state.latencyMs = state.latencyMs == null
        ? latencyMs
        : state.latencyMs * 0.7 + latencyMs * 0.3;
      state.samples = (state.samples || 0) + 1;
    }
    persistHealthSoon();
  }

  function reportFailure(id, opts) {
    const state = stateFor(id);
    const now = Date.now();
    const kind = opts && opts.kind ? opts.kind : 'transient';
    const method = opts && opts.method ? String(opts.method) : null;

    if (kind === 'method') {
      // Policy refusal, evidence-gated (F-63 refined twice): ONE 403 = a
      // DEMOTION to the back of the line for DEMOTE_MS (the endpoint just
      // called this client hostile) + pending evidence. It does NOT take a
      // transient strike — that is what re-benched publicnode twice and
      // left the whole pool benched in the ark_trades13 spiral. A SECOND
      // 403 on the same (endpoint, method) inside the evidence window
      // confirms real policy: block the method for METHOD_BLOCK_MS.
      state.lastFailureAt = now;
      state.demotedUntil = now + DEMOTE_MS;
      if (method) {
        // D-65: first offence ALSO records refusal memory (sliding window) —
        // the endpoint drops behind the healthy hedge for this method right
        // away, instead of after the two-strike confirmation. Every later 403
        // refreshes the window; a 200 clears it entirely.
        state.refusals = state.refusals || {};
        state.refusals[method] = now + REFUSAL_MEMORY_MS;
        state.methodEvidence = state.methodEvidence || {};
        const armedAt = state.methodEvidence[method];
        if (armedAt && now - armedAt <= METHOD_EVIDENCE_MS) {
          // CONFIRMED policy: hard-block this method on this endpoint.
          state.methodBlocks = state.methodBlocks || {};
          state.methodBlocks[method] = now + METHOD_BLOCK_MS;
          delete state.methodEvidence[method];
        } else {
          // First offence: demotion only, evidence armed, no block.
          state.methodEvidence[method] = now;
        }
      }
      persistHealthSoon();
      return;
    }

    if (kind === 'throttle') {
      const retryAfter = Number(opts && opts.retryAfterMs);
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(THROTTLE_MAX_MS, Math.max(THROTTLE_DEFAULT_MS, retryAfter))
        : THROTTLE_DEFAULT_MS;
      // A 429 is not a strike: leave the decay clock untouched.
      state.throttledUntil = now + delay;
      persistHealthSoon();
      return;
    }

    // Strikes forgive: a failure older than the decay window stops counting.
    // Without this, one blip right after a bench expiry re-benched the
    // endpoint for another full minute, forever.
    if (state.lastFailureAt && now - state.lastFailureAt > FAILURE_DECAY_MS) state.failures = 0;
    state.lastFailureAt = now;
    state.failures += 1;
    // Two strikes benches an endpoint; a single blip is not worth losing it.
    if (state.failures >= 2) state.benchedUntil = now + COOLDOWN_MS;
    persistHealthSoon();
  }

  /** True when every pool endpoint currently refuses this method (F-63). */
  function methodBlockedEverywhere(method) {
    if (!method) return false;
    const now = Date.now();
    return PUBLIC_ENDPOINTS.every((e) => (stateFor(e.id).methodBlocks[method] || 0) > now);
  }

  /** D-65: true when every POOL endpoint carries LIVE refusal memory for this
   * method (the sliding 10-minute entries). Softer than
   * methodBlockedEverywhere: it says the batch attempt is currently hopeless
   * and callers with a cheaper fallback lane should skip straight to it. A
   * user endpoint is deliberately excluded — it outranks the pool and may
   * serve the method fine. */
  function refusalMemoryLive(method) {
    if (!method) return false;
    const now = Date.now();
    return PUBLIC_ENDPOINTS.length > 0 && PUBLIC_ENDPOINTS.every((e) => (stateFor(e.id).refusals[method] || 0) > now);
  }

  /**
   * The pool's honest self-assessment: the smoothed latency of the BEST
   * public endpoint, and how much evidence sits behind it. This is what
   * lets the product notice "the keyless pool is slow from HERE" and say
   * the fix out loud instead of every user in a throttled region
   * rediscovering it alone (field report: cojica456, Balkans — all three
   * public endpoints slow; a free personal endpoint made launches
   * instant). Null until anything is measured.
   */
  /**
   * How much of the pool's RECENT traffic is failing.
   *
   * poolLatency() below can only see calls that SUCCEEDED — latencyMs and
   * samples are written in reportSuccess() and nowhere else — so a throttled
   * or policy-blocked endpoint contributes no sample at all. That makes the
   * pool look FAST precisely when it is failing: the one endpoint still
   * answering reports its own healthy latency while the others 429/403 into
   * the bench, and any measure built on latency alone reads "fine".
   *
   * The attempt log is the honest record, because a failure is written there
   * with its status. A user whose console is full of
   * "http 429 getMultipleAccounts @ tatum" / "http 403 … @ publicnode"
   * (ticket-0010, fomo.family, 2026-08-29) is in exactly that state, and
   * nothing keyed off latency will ever notice.
   */
  function poolStress() {
    const attempts = attemptLog.length;
    if (!attempts) return { attempts: 0, failures: 0, failRate: 0 };
    let failures = 0;
    for (const entry of attemptLog) {
      // 200 is the only success the log records; every other status is a
      // failed attempt (403/429/5xx, 'rpc-policy', 'rpc-error', 'timeout',
      // 'rejected'). Counting anything-not-200 keeps new statuses honest.
      if (entry && entry.status !== 200) failures += 1;
    }
    return { attempts, failures, failRate: failures / attempts };
  }

  function poolLatency() {
    let best = null;
    let samples = 0;
    for (const endpoint of PUBLIC_ENDPOINTS) {
      const s = health.get(endpoint.id);
      if (!s || s.latencyMs == null) continue;
      samples += s.samples || 0;
      if (best == null || s.latencyMs < best) best = s.latencyMs;
    }
    return best == null ? null : { bestMs: Math.round(best), samples };
  }

  /**
   * Perform an RPC call against the first endpoint that answers.
   *
   * Failover is the entire point: a keyless endpoint WILL throttle, and the
   * user must never see that as a dead price feed.
   */
  // Circuit breaker: once every endpoint is benched, more traffic resets
  // nothing — it keeps the strikes coming and the pool benched forever
  // (DEFECT F-09 cascade). Fail fast during the cooldown and let one
  // half-open probe through periodically to discover recovery.
  let lastBenchedProbeAt = 0;
  const BENCHED_PROBE_MS = 5000;

  /* Flight recorder: the last ATTEMPT_LOG_MAX attempts, for forensics. The
   * ark_trades13 debug export showed errors with no attempt context, which
   * turned a 5-minute diagnosis into an archaeology dig. Exposed via
   * _attempts() for scenarios and the share-debug blob; capped, no growth. */
  const ATTEMPT_LOG_MAX = 60;
  const attemptLog = [];
  function logAttempt(entry) {
    attemptLog.push(Object.assign({ t: Date.now() }, entry));
    if (attemptLog.length > ATTEMPT_LOG_MAX) attemptLog.shift();
  }

  // Hedged failover: a HANGING endpoint is worse than a failing one — a hard
  // failure steps to the next endpoint immediately, but a hang used to eat
  // the full PROBE_TIMEOUT before failover. Measured live on the sniping
  // path: an identical getMultipleAccounts cost 422ms, then 4159ms, then
  // 75ms — the middle call was one silent endpoint consuming its whole 4s.
  // Now an attempt that has not answered within HEDGE_MS gets a parallel
  // competitor on the next-ranked endpoint; the first success wins and
  // aborts the losers. Hedges only fire when the primary is already slow,
  // so the extra traffic exists exactly when the pool is misbehaving.
  const HEDGE_MS = 500;

  function attemptEndpoint(endpoint, method, params, controllers, race) {
    const started = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller && controllers) controllers.push(controller);
    const timer = controller ? setTimeout(() => controller.abort(), timeoutFor(method)) : null;
    const isLoser = () => Boolean(race && race.winner != null && race.winner !== endpoint.id);
    return fetch(endpoint.http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller ? controller.signal : undefined,
    }).then(async (response) => {
      if (!response.ok) {
        // 403 is a policy refusal, not a throttle (F-63): record it as a
        // method block rather than a transient strike. The error carries
        // method+endpoint so debug exports name the culprit (ark_trades13
        // taught this: 'http 403' with no method cost a full diagnosis).
        if (response.status === 403) {
          logAttempt({ endpoint: endpoint.id, method, status: 403, ms: Date.now() - started });
          reportFailure(endpoint.id, { kind: 'method', method });
          const err = new Error('http 403 ' + method + ' @ ' + endpoint.id);
          err.kind = 'method';
          // Already classified + reported + logged: the catch below must not
          // reportFailure AGAIN, or one WAF blip arms evidence twice and
          // confirms a 30-minute block from a single 403 (caught by F-63 NC).
          err.reported = true;
          err.logged = true;
          throw err;
        }
        if (response.status === 429) {
          let rawRetryAfter = null;
          try {
            rawRetryAfter = response.headers
              && response.headers.get
              && response.headers.get('retry-after');
          } catch (_) {}
          const retryAfterSeconds = Number(rawRetryAfter);
          const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
            ? Math.min(THROTTLE_MAX_MS, Math.max(
              THROTTLE_DEFAULT_MS, retryAfterSeconds * 1000))
            : THROTTLE_DEFAULT_MS;
          logAttempt({ endpoint: endpoint.id, method, status: 429, ms: Date.now() - started });
          reportFailure(endpoint.id, { kind: 'throttle', method, retryAfterMs });
          const err = new Error('http 429 ' + method + ' @ ' + endpoint.id);
          err.kind = 'throttle';
          err.reported = true;
          err.logged = true;
          throw err;
        }
        logAttempt({ endpoint: endpoint.id, method, status: response.status, ms: Date.now() - started });
        throw new Error('http ' + response.status + ' ' + method + ' @ ' + endpoint.id);
      }
      const json = await response.json();
      if (json.error) {
        // Some providers answer 200 with an rpc-level policy refusal
        // (tatum: 'paid plans only'). Message-shape classification keeps
        // those out of the transient bucket too.
        const msg = String((json.error && json.error.message) || 'rpc error');
        if (/method not found|not allowed|forbidden|blocked|unauthor|paid plan/i.test(msg)) {
          logAttempt({ endpoint: endpoint.id, method, status: 'rpc-policy', ms: Date.now() - started });
          reportFailure(endpoint.id, { kind: 'method', method });
          const err = new Error(msg);
          err.kind = 'method';
          // Same double-report guard as the HTTP-403 branch above.
          err.reported = true;
          err.logged = true;
          throw err;
        }
        logAttempt({ endpoint: endpoint.id, method, status: 'rpc-error', ms: Date.now() - started });
        throw new Error(msg);
      }
      race && (race.winner = endpoint.id);
      logAttempt({ endpoint: endpoint.id, method, status: 200, ms: Date.now() - started });
      reportSuccess(endpoint.id, Date.now() - started);
      return json.result;
    }).catch((error) => {
      // A hedged LOSER was aborted because a sibling already answered —
      // that says nothing about this endpoint's health, and striking it
      // made winning a race cost the loser a bench (F-63). Timeouts and
      // real rejections still report.
      if (isLoser()) { throw error; }
      if (!(error && error.logged)) {
        logAttempt({ endpoint: endpoint.id, method, status: error && error.name === 'AbortError' ? 'timeout' : 'rejected', ms: Date.now() - started });
      }
      if (!(error && error.reported)) {
        reportFailure(endpoint.id, { kind: error && error.kind, method });
      }
      throw error;
    }).finally(() => {
      // The abort timer must clear on EVERY path — a rejected fetch used
      // to leak it until it fired (DEFECT F-27).
      if (timer) clearTimeout(timer);
    });
  }

  async function call(method, params, opts) {
    // A method every pool endpoint refuses is a known policy, not a flake —
    // burning the hedge walk on it every 800ms detect tick only rebuilt the
    // cooldown chatter (ark_trades13: 'rpc pool cooling down' x243). Fail
    // honestly and instantly; the callers own the fallback. (F-63)
    if (!hasUserEndpoint() && methodBlockedEverywhere(method)) {
      const blocked = new Error('rpc method blocked by every endpoint: ' + method);
      // D-62: stamped so callers can distinguish policy (fallback lanes may
      // engage) from a transient fault (retry is the honest move).
      blocked.kind = 'method';
      throw blocked;
    }
    let endpoints = ranked(Object.assign({}, opts, { method }));
    const now = Date.now();
    if (endpoints.length && endpoints.every((e) => stateFor(e.id).benchedUntil > now)) {
      if (now - lastBenchedProbeAt < BENCHED_PROBE_MS) {
        throw new Error('rpc pool cooling down');
      }
      lastBenchedProbeAt = now;
      // The single half-open probe ROTATES (F-63): one dead head used to
      // re-probe itself forever while healthy endpoints sat benched behind
      // it. Still exactly one endpoint per probe window (F-09 contract).
      const probeIndex = probeCursor % endpoints.length;
      probeCursor += 1;
      endpoints = endpoints.slice(probeIndex, probeIndex + 1);
    }
    if (!endpoints.length) throw new Error('no rpc endpoint available');

    const controllers = [];
    const race = { winner: null };
    return await new Promise((resolve, reject) => {
      let settled = false;
      let pending = 0;
      let index = 0;
      let hedgeTimer = null;
      let lastError = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
        // Losers stop spending the endpoint's rate limit on an answer
        // nobody will read.
        for (const c of controllers) { try { c.abort(); } catch (_) {} }
        fn(value);
      };

      const launchNext = () => {
        hedgeTimer = null;
        if (settled || index >= endpoints.length) return;
        const endpoint = endpoints[index++];
        pending += 1;
        attemptEndpoint(endpoint, method, params, controllers, race).then(
          (result) => { pending -= 1; finish(resolve, result); },
          (error) => {
            pending -= 1;
            lastError = error;
            if (settled) return;
            if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
            if (index < endpoints.length) launchNext(); // hard failure: step on immediately
            else if (pending === 0) finish(reject, lastError || new Error('no rpc endpoint available'));
          }
        );
        // A slow (not failed) attempt earns a competitor.
        if (!settled && index < endpoints.length) hedgeTimer = setTimeout(launchNext, HEDGE_MS);
      };

      launchNext();
    });
  }

  /** WebSocket URLs in preference order, for the streaming feed to walk. */
  function websocketUrls() {
    return ranked({ websocket: true }).map((endpoint) => ({ id: endpoint.id, url: endpoint.ws }));
  }

  const api = {
    PUBLIC_ENDPOINTS, COOLDOWN_MS, THROTTLE_DEFAULT_MS, THROTTLE_MAX_MS,
    setUserEndpoint, hasUserEndpoint,
    ranked, call, websocketUrls, poolLatency, poolStress,
    reportSuccess, reportFailure, methodBlockedEverywhere, refusalMemoryLive,
    _health: health,
    _attempts: () => attemptLog.slice(),
    _reset: () => { health.clear(); userEndpoint = null; probeCursor = 0; },
  };

  if (typeof self !== 'undefined') self.PTRpcPool = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
