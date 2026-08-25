/* PaperTrench — bounded, deduping, secret-redacting error ring buffer.
 *
 * content.js has ~124 catch blocks and background.js ~114. Nearly all of them
 * swallow silently, which is correct for the running product (a failed tab
 * open must never fail a fill) and useless for triage: when a Discord report
 * says "it stopped working" there is nothing to read.
 *
 * This module is the black box. It is deliberately boring:
 *
 *   - FIXED capacity (256). Writes overwrite the oldest slot in O(1). The
 *     buffer can never grow, so a runaway error loop cannot become a memory
 *     leak on top of whatever it already broke.
 *   - DEDUPED. Identical message+context inside a sliding window bumps `count`
 *     and `lastTs` instead of appending. This is the single most important
 *     property: a 100ms loop throwing the same error is exactly when you most
 *     need the history that preceded it, and an un-deduped ring would evict
 *     all 256 slots in ~25 seconds and leave you with 256 copies of the noise.
 *   - REDACTED at the door. PaperTrench is paper-only and never touches key
 *     material, but an error message can quote whatever it was handed. Wallet
 *     addresses, private keys and bearer tokens are stripped BEFORE storage,
 *     so the secret is never in memory as part of a log entry at all.
 *   - It NEVER throws. A recorder that throws from inside a catch block turns
 *     a handled error into an unhandled one; that is strictly worse than
 *     having no recorder. Every public entry point is total.
 *
 * Dependency-free and safe to load in BOTH the service worker (self) and the
 * content script (window) — see the triple export at the bottom.
 */
(() => {
  'use strict';

  /** Ring capacity. Fixed forever — see the module header. */
  const CAPACITY = 256;
  /** Repeats of the same message+context inside this window collapse.
   *  The window SLIDES on every hit, so a continuously firing loop stays a
   *  single entry no matter how long it runs. */
  const DEDUPE_WINDOW_MS = 60_000;
  /** Stacks are truncated — a few frames identify the site; the rest is noise
   *  that would evict real history from a 256-slot buffer. */
  const MAX_STACK = 1200;
  const MAX_MESSAGE = 600;
  /** Context walk limits. Depth and breadth are both capped so a huge or
   *  hostile object cannot stall the recorder. */
  const MAX_CONTEXT_DEPTH = 4;
  const MAX_CONTEXT_KEYS = 24;
  const MAX_CONTEXT_STRING = 400;

  /* ------------------------------ redaction ------------------------------
   *
   * Order matters. The LONGEST secrets are matched first, because a 88-char
   * base58 private key contains substrings that also look like a 44-char
   * wallet address; matching the address pattern first would leave half the
   * key sitting in the log.
   *
   * The base58 rules require a digit AND both cases before redacting, which
   * keeps ordinary long identifiers (function names, file paths, CSS class
   * soup) readable while still catching every real Solana key or address —
   * those are effectively always mixed-case with digits.
   */
  const B58 = '[1-9A-HJ-NP-Za-km-z]';

  function looksLikeBase58Secret(s) {
    return /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);
  }

  const RULES = [
    // Explicit credential-bearing key/value shapes: authorization headers,
    // bearer tokens, api keys, "privateKey": "...". Value goes, label stays.
    {
      re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      fn: (m, label) => `${label} [REDACTED_TOKEN]`,
    },
    {
      re: /\b(authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret[_-]?key|private[_-]?key|secretkey|privatekey|mnemonic|seed[_-]?phrase)\b(\s*["']?\s*[:=]\s*["']?)([^\s"',;)}\]]{6,})/gi,
      fn: (m, label, sep, _val) => `${label}${sep}[REDACTED_TOKEN]`,
    },
    // A raw keypair dumped as a JSON byte array — the shape `solana-keygen`
    // writes. 32 bytes minimum, so a short numeric array is left alone.
    {
      re: /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g,
      fn: () => '[REDACTED_KEY]',
    },
    // Long hex blobs: 64 hex chars is a 32-byte key; also covers 0x-prefixed.
    {
      re: /\b(?:0x)?[0-9a-fA-F]{64,}\b/g,
      fn: () => '[REDACTED_KEY]',
    },
    // JWT-shaped triples (header.payload.signature).
    {
      re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
      fn: () => '[REDACTED_TOKEN]',
    },
    // base58 private key (64 bytes ≈ 87-88 chars). MUST precede the address
    // rule below.
    {
      re: new RegExp(`\\b${B58}{80,90}\\b`, 'g'),
      fn: (m) => (looksLikeBase58Secret(m) ? '[REDACTED_KEY]' : m),
    },
    // base58 wallet / mint address (32 bytes ≈ 32-44 chars).
    {
      re: new RegExp(`\\b${B58}{32,44}\\b`, 'g'),
      fn: (m) => (looksLikeBase58Secret(m) ? '[REDACTED_ADDR]' : m),
    },
  ];

  /** Strip anything that looks like key material from a string.
   *  Total: any failure yields the empty string rather than the raw input,
   *  because leaking on the error path is the one outcome worth avoiding. */
  function redact(text) {
    try {
      if (typeof text !== 'string' || !text) return '';
      let out = text;
      for (const rule of RULES) {
        // Fresh lastIndex each pass: these are /g regexes reused across calls.
        rule.re.lastIndex = 0;
        out = out.replace(rule.re, rule.fn);
      }
      return out;
    } catch (_) {
      return '';
    }
  }

  /* ------------------------------ coercion ------------------------------ */

  /** Pull a message out of literally anything without trusting a getter. */
  function messageOf(err) {
    try {
      if (err === null) return 'null';
      if (err === undefined) return 'undefined';
      if (typeof err === 'string') return err;
      if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
        return String(err);
      }
      if (typeof err === 'symbol') return err.toString();
      if (typeof err === 'function') return `[function ${err.name || 'anonymous'}]`;
      // Objects: prefer .message, then .name, then a shallow describe. Each
      // access is guarded because a getter can throw or be a Proxy trap.
      let msg = '';
      try { if (typeof err.message === 'string') msg = err.message; } catch (_) { /* hostile getter */ }
      if (!msg) {
        try { if (typeof err.name === 'string') msg = err.name; } catch (_) { /* hostile getter */ }
      }
      if (!msg) {
        try { msg = Object.prototype.toString.call(err); } catch (_) { msg = '[object]'; }
      }
      return msg || '[object]';
    } catch (_) {
      return '[unreadable]';
    }
  }

  function stackOf(err) {
    try {
      if (!err || typeof err !== 'object') return '';
      let st = '';
      try { if (typeof err.stack === 'string') st = err.stack; } catch (_) { return ''; }
      return st;
    } catch (_) {
      return '';
    }
  }

  /** Redact + bound a context value, tolerating cycles, getters and depth. */
  function cleanContext(value, depth, seen) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === 'string') return redact(value).slice(0, MAX_CONTEXT_STRING);
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'bigint') return String(value);
    if (t === 'symbol') return redact(value.toString());
    if (t === 'function') return `[function ${value.name || 'anonymous'}]`;
    if (t !== 'object') return null;

    if (depth >= MAX_CONTEXT_DEPTH) return '[depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const out = [];
        const n = Math.min(value.length, MAX_CONTEXT_KEYS);
        for (let i = 0; i < n; i += 1) out.push(cleanContext(value[i], depth + 1, seen));
        if (value.length > n) out.push(`[+${value.length - n} more]`);
        return out;
      }
      if (value instanceof Error) {
        return {
          message: redact(messageOf(value)).slice(0, MAX_CONTEXT_STRING),
          name: redact(String(value.name || 'Error')).slice(0, 64),
        };
      }
      const out = {};
      let keys = [];
      try { keys = Object.keys(value); } catch (_) { keys = []; }
      for (const k of keys.slice(0, MAX_CONTEXT_KEYS)) {
        let v;
        try { v = value[k]; } catch (_) { v = '[unreadable]'; }
        out[redact(String(k)).slice(0, 64)] = cleanContext(v, depth + 1, seen);
      }
      return out;
    } catch (_) {
      return '[unreadable]';
    } finally {
      seen.delete(value);
    }
  }

  /** A stable, bounded string identity for a context — the dedupe key half. */
  function contextKey(ctx) {
    try {
      if (ctx === null || ctx === undefined) return '';
      if (typeof ctx === 'string') return ctx;
      return stableString(ctx, 0, new Set());
    } catch (_) {
      return '';
    }
  }

  function stableString(v, depth, seen) {
    if (v === null || v === undefined) return String(v);
    const t = typeof v;
    if (t !== 'object') return String(v);
    if (depth >= MAX_CONTEXT_DEPTH) return '~';
    if (seen.has(v)) return '~circular';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        return `[${v.slice(0, MAX_CONTEXT_KEYS).map((x) => stableString(x, depth + 1, seen)).join(',')}]`;
      }
      let keys = [];
      try { keys = Object.keys(v).sort(); } catch (_) { keys = []; }
      const parts = [];
      for (const k of keys.slice(0, MAX_CONTEXT_KEYS)) {
        let val;
        try { val = v[k]; } catch (_) { val = '?'; }
        parts.push(`${k}=${stableString(val, depth + 1, seen)}`);
      }
      return `{${parts.join(',')}}`;
    } catch (_) {
      return '?';
    } finally {
      seen.delete(v);
    }
  }

  /* ------------------------------ the ring ------------------------------ */

  const buf = new Array(CAPACITY).fill(null);
  /** Absolute write counter. `seq % CAPACITY` is the slot; the absolute value
   *  is what makes a stale index entry detectable in O(1). */
  let seq = 0;
  /** key -> absolute seq of the entry holding it. Bounded by CAPACITY because
   *  eviction deletes the outgoing key. */
  const index = new Map();

  function now() {
    try {
      const t = Date.now();
      return Number.isFinite(t) ? t : 0;
    } catch (_) {
      return 0;
    }
  }

  /** The live entry for `key`, or null if it was evicted or the window closed. */
  function liveEntry(key, ts) {
    const at = index.get(key);
    if (at === undefined) return null;
    const slot = at % CAPACITY;
    const entry = buf[slot];
    // The slot may have been overwritten by a later, different error.
    if (!entry || entry.seq !== at || entry.key !== key) {
      index.delete(key);
      return null;
    }
    if (ts - entry.lastTs > DEDUPE_WINDOW_MS) {
      // Window closed: this is a NEW episode of the same fault, which is
      // worth its own entry with its own first-seen timestamp.
      index.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Record an error. Returns the stored entry (count === 1 means it is new),
   * or null if the input could not be recorded. NEVER throws.
   *
   * @param {*} err     Anything. Error, string, null, a Proxy that bites.
   * @param {*} context Optional tag — a string or a small plain object.
   */
  function record(err, context) {
    try {
      const ts = now();
      const message = redact(messageOf(err)).slice(0, MAX_MESSAGE);
      const ctx = cleanContext(context, 0, new Set());
      const key = `${message}\u0000${contextKey(ctx)}`.slice(0, 1024);

      const hit = liveEntry(key, ts);
      if (hit) {
        // The whole point: no new slot, no eviction, no lost history.
        hit.count += 1;
        hit.lastTs = ts;
        return hit;
      }

      const stack = redact(stackOf(err)).slice(0, MAX_STACK);
      const slot = seq % CAPACITY;
      const evicted = buf[slot];
      if (evicted && index.get(evicted.key) === evicted.seq) index.delete(evicted.key);

      const entry = {
        seq,
        key,
        ts,
        lastTs: ts,
        message,
        stack,
        context: ctx,
        count: 1,
      };
      buf[slot] = entry;
      index.set(key, seq);
      seq += 1;
      return entry;
    } catch (_) {
      // A recorder that throws from inside a catch block is worse than none.
      return null;
    }
  }

  /**
   * All live entries, newest activity first. Returns copies, so a caller
   * cannot mutate the ring (or the dedupe counters) by editing what it got.
   */
  function snapshot() {
    try {
      const live = [];
      for (let i = 0; i < CAPACITY; i += 1) if (buf[i]) live.push(buf[i]);
      // Most recently ACTIVE first. The seq tiebreak keeps the ordering total
      // and stable even under a coarse clock (Date.now() can repeat inside a
      // tight loop, and two entries in the same millisecond must still have a
      // defined order).
      live.sort((a, b) => (b.lastTs - a.lastTs) || (b.seq - a.seq));
      return live.map((e) => ({
        ts: e.ts,
        lastTs: e.lastTs,
        message: e.message,
        stack: e.stack,
        context: e.context,
        count: e.count,
      }));
    } catch (_) {
      return [];
    }
  }

  /** Drop everything. */
  function clear() {
    try {
      for (let i = 0; i < CAPACITY; i += 1) buf[i] = null;
      index.clear();
      seq = 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Number of live entries (never above CAPACITY). */
  function size() {
    try {
      let n = 0;
      for (let i = 0; i < CAPACITY; i += 1) if (buf[i]) n += 1;
      return n;
    } catch (_) {
      return 0;
    }
  }

  const api = {
    record,
    snapshot,
    clear,
    size,
    CAPACITY,
    DEDUPE_WINDOW_MS,
    // Exposed for tests.
    _redact: redact,
    _messageOf: messageOf,
  };

  // Runs in BOTH worlds: the content script (window) and the service worker
  // (self). Assigning only to window is the bug that shipped a dead on-chain
  // feed for a whole release — see onchain.js.
  if (typeof window !== 'undefined') window.PTErrors = api;
  if (typeof self !== 'undefined') self.PTErrors = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
