'use strict';
// The trust boundary. Raw captures hold cookies, auth headers, balances, wallet
// addresses. Nothing reaches a dossier or fixture without passing through here.
// The scrubber is deny-by-shape for the categories we can name, plus an exact
// denylist for the identifiers only the operator knows (wallets, usernames).
//
// DELIBERATELY NOT scrubbed: token contract/mint addresses. They are the
// subject matter of a memecoin dossier. That is why wallet redaction is
// denylist-driven (operator-supplied) and not "redact anything base58-shaped":
// a blanket address scrub would erase the very data we capture sites to learn.

const REDACT = '«redacted»';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Header names whose *values* are always secret-bearing.
const SECRET_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-access-token', 'x-session-token',
  'x-csrf-token', 'x-xsrf-token', 'x-secret', 'api-key', 'apikey',
  'x-supabase-auth', 'sec-websocket-key', 'sec-websocket-accept',
]);

// JSON keys / query params whose values are secret-bearing regardless of shape.
// NOTE: bare `token` is DELIBERATELY absent — on a memecoin site a field keyed
// `token`/`tokenAddress` holds the token's MINT, which is subject matter, not a
// secret. Real auth tokens are caught by the specific *_token keys below AND by
// value shape (JWT/bearer/sk) regardless of key name.
const SECRET_KEY_RE = /^(.*[-_.])?(auth|authorization|access_token|auth_token|bearer_token|refresh_token|id_token|secret|password|passwd|pwd|apikey|api_key|api-key|access_key|private_key|privatekey|session|sessionid|sid|jwt|bearer|signature|csrf|xsrf|cookie|credential|otp|mnemonic|seed|seed_phrase|privkey)([-_.].*)?$/i;

// Value-shaped secrets that can appear anywhere in a string.
const ADDR_SHAPE_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/; // token mint / EVM address — NOT a secret
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SK_RE = /\b(sk|pk|rk|ey|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g;
const HEX_KEY_RE = /\b0x[a-fA-F0-9]{64}\b/g; // 32-byte private-key-length hex (NOT 40-char EVM addresses)

function normLine(s) {
  return s.replace(/\r?\n/g, '').trim();
}

function loadDenylist(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(normLine)
    .filter((l) => l && !l.startsWith('#'))
    .sort((a, b) => b.length - a.length); // longest-first so substrings don't shadow
}

function makeScrubber(denyEntries = []) {
  const deny = Array.isArray(denyEntries) ? denyEntries : loadDenylist(denyEntries);
  const state = { redactions: 0 };

  const bump = (n = 1) => { state.redactions += n; };

  function scrubString(s) {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s;
    for (const re of [JWT_RE, BEARER_RE, SK_RE, HEX_KEY_RE, EMAIL_RE]) {
      out = out.replace(re, () => { bump(); return REDACT; });
    }
    for (const entry of deny) {
      if (!entry) continue;
      // Case-insensitive, literal match via a regex. This is position-correct by
      // construction — the old manual index-into-lowercased-copy / slice-the-
      // original approach misaligned when a character's lowercase changed length
      // (e.g. U+0130 'İ' → 'i̇'), UNDER-scrubbing the secret. A regex never does.
      const re = new RegExp(escapeRegExp(entry), 'gi');
      out = out.replace(re, () => { bump(); return REDACT; });
    }
    return out;
  }

  function scrubHeaders(headers) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      if (SECRET_HEADERS.has(k.toLowerCase())) { out[k] = REDACT; bump(); }
      else out[k] = scrubString(String(v));
    }
    return out;
  }

  // Recursively scrub any JSON-ish value; key-name awareness lets us redact a
  // secret value even when its own shape is innocuous (e.g. a short token).
  // Depth-capped so a pathologically deep payload cannot blow the stack.
  function scrubValue(val, keyName, depth = 0) {
    if (keyName && SECRET_KEY_RE.test(keyName)) {
      if (val !== null && val !== undefined && typeof val !== 'object') { bump(); return REDACT; }
    }
    // Any key that IS or ENDS IN `token` (token, tokenId, api_token, oauth_token,
    // user_token, access-token, x-access-token) is an ambiguous credential field:
    // usually an opaque auth token, but a bare `token` on a memecoin API can hold
    // the MINT. Redact a long non-address string value; a real mint (address
    // shape) or a short symbol is preserved. `tokenAddress`/`tokenSymbol` end in
    // address/symbol, not token, so they are NOT matched.
    if (keyName && /(^|[-_.])tokens?(id)?$/i.test(keyName) && typeof val === 'string' && val.length >= 16 && !ADDR_SHAPE_RE.test(val)) {
      bump(); return REDACT;
    }
    if (typeof val === 'string') return scrubString(val);
    if (depth >= 200 && typeof val === 'object' && val !== null) return '«depth-truncated»';
    if (Array.isArray(val)) return val.map((x) => scrubValue(x, keyName, depth + 1));
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = scrubValue(v, k, depth + 1);
      return out;
    }
    return val;
  }

  // Scrub a URL: query-param values by key name, plus value-shaped secrets.
  function scrubUrl(u) {
    if (typeof u !== 'string') return u;
    const qIdx = u.indexOf('?');
    if (qIdx === -1) return scrubString(u);
    const base = u.slice(0, qIdx);
    const query = u.slice(qIdx + 1);
    const parts = query.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      const rawKey = decodeURIComponent(key.replace(/\+/g, ' '));
      if (SECRET_KEY_RE.test(rawKey)) { bump(); return `${key}=${REDACT}`; }
      return `${key}=${scrubString(pair.slice(eq + 1))}`;
    });
    return scrubString(base) + '?' + parts.join('&');
  }

  return {
    scrubString,
    scrubHeaders,
    scrubValue,
    scrubUrl,
    stats: () => ({ ...state }),
    REDACT,
  };
}

module.exports = { makeScrubber, loadDenylist, REDACT, SECRET_HEADERS, SECRET_KEY_RE };
