/* livedrive guards — pure logic, unit-tested in test/guards.test.mjs.
 *
 * These are the rules that keep the live driver looking like one person
 * using one tab: a budget on full page loads, and a detector that freezes the
 * driver the moment a bot check shows up (the driver never touches one).
 */

/** Rolling-window budget for full page loads (refresh, URL load, extension
 *  reload). In-app clicks are free; hard loads are what a person does rarely. */
export class NavBudget {
  constructor({ max = 8, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.log = []; // { t, kind }
  }
  prune() {
    const cutoff = this.now() - this.windowMs;
    this.log = this.log.filter((e) => e.t > cutoff);
  }
  peek() {
    this.prune();
    const used = this.log.length;
    const retryInMs = used >= this.max ? this.log[0].t + this.windowMs - this.now() : 0;
    return { used, max: this.max, windowMs: this.windowMs, retryInMs };
  }
  /** Spend one load. Returns { ok, used, max, retryInMs }; nothing is spent when refused. */
  take(kind) {
    const state = this.peek();
    if (state.used >= this.max) return { ok: false, ...state };
    this.log.push({ t: this.now(), kind });
    return { ok: true, ...this.peek() };
  }
}

/** Is the page showing a bot / human check instead of the site?
 *  Returns a short reason string, or null. A Turnstile frame alone is not
 *  enough (sites embed it in normal forms); it needs the challenge wording. */
export function detectChallenge({ url = '', title = '', bodyText = '', hasChallengeFrame = false } = {}) {
  if (/^\s*just a moment/i.test(title)) return 'title: Just a moment';
  if (/attention required/i.test(title)) return 'title: Attention Required';
  if (/\/cdn-cgi\/challenge-platform|[?&]__cf_chl_/i.test(url)) return 'url: challenge platform';
  const text = String(bodyText).slice(0, 4000);
  const wording = /verify you are human|checking (if the site connection is secure|your browser)|performing security verification/i.exec(text);
  if (wording && hasChallengeFrame) return 'challenge frame: ' + wording[0];
  if (wording && /needs to review the security of your connection/i.test(text)) return 'interstitial: ' + wording[0];
  return null;
}

/** "$15.8K" / "15.8K" / "$1.2M" / "$987" -> number (USD), or null. */
export function parseMcap(text) {
  const m = /\$?\s*([\d.,]+)\s*([KMB])?/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return n * mult;
}

/** CLI args: `--key value`, `--flag`, `key=value`, bare positionals -> _[] */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) { out[key.slice(0, eq)] = coerce(key.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !/^[A-Za-z][\w-]*=/.test(next)) { out[key] = coerce(next); i++; } else out[key] = true;
    } else if (/^[A-Za-z][\w-]*=/.test(a)) {
      const eq = a.indexOf('=');
      out[a.slice(0, eq)] = coerce(a.slice(eq + 1));
    } else out._.push(a);
  }
  return out;
}
function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Same-site check for in-tab navigation: only the host the tab is already on. */
export function sameSiteTarget(currentUrl, target) {
  let cur;
  try { cur = new URL(currentUrl); } catch { return null; }
  let next;
  try { next = new URL(target, cur.origin); } catch { return null; }
  if (next.protocol !== 'https:' || next.hostname !== cur.hostname) return null;
  return next.href;
}
