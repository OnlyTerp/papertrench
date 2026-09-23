/* The keyless-pool notice is a view of the rolling error status, never a fill toast. */
(() => {
  'use strict';

  const MIN_REFUSALS = 12;
  const FAILURE_WINDOW_MS = 10 * 60_000;
  const REFRESH_MS = 5_000;
  const watched = new Map();

  function latestPoolStatus(entries) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && entry.context?.kind === 'rpc-pool-status')
      .sort((a, b) => (Number(b.lastTs || b.ts) || 0) - (Number(a.lastTs || a.ts) || 0))[0] || null;
  }

  function allEndpointsUnavailable(endpoints, now) {
    const byId = new Map();
    for (const endpoint of endpoints) {
      const id = endpoint && endpoint.id;
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(endpoint);
    }
    if (!byId.size) return false;
    return [...byId.values()].every((rows) => {
      if (rows.some((row) => Number(row.benchedUntil) > now)) return true;
      const methodRows = rows.filter((row) => row.method);
      return methodRows.length > 0 && methodRows.every((row) => Number(row.blockedUntil) > now);
    });
  }

  function shouldShow(settings, entries, now = Date.now()) {
    if (String(settings?.rpcUrl || '').trim()) return false;
    const entry = latestPoolStatus(entries);
    const pool = entry && entry.context && entry.context.pool;
    if (!pool || pool.mode !== 'keyless' || !Array.isArray(pool.endpoints) || !pool.endpoints.length) return false;

    const snapshotAt = Number(entry.lastTs || entry.ts) || now;
    const snapshotAgeMs = Math.max(0, now - snapshotAt);
    const endpoints = pool.endpoints;
    const refusalCount = endpoints.reduce((sum, endpoint) => sum + (Number(endpoint.refusalCount) || 0), 0);
    const noRecentSuccess = endpoints.every((endpoint) => {
      const ageAtSnapshot = endpoint.endpointLastSuccessAgeMs;
      return ageAtSnapshot == null
        || !Number.isFinite(Number(ageAtSnapshot))
        || Number(ageAtSnapshot) + snapshotAgeMs >= FAILURE_WINDOW_MS;
    });
    const repeatedRefusals = snapshotAgeMs <= FAILURE_WINDOW_MS
      && refusalCount >= MIN_REFUSALS && noRecentSuccess;
    return repeatedRefusals || allEndpointsUnavailable(endpoints, now);
  }

  async function refresh(id) {
    const node = document.getElementById(id);
    if (!node) return;
    try {
      const stored = await chrome.storage.local.get(['pt_settings']);
      const settings = stored.pt_settings || {};
      if (String(settings.rpcUrl || '').trim()) {
        node.hidden = true;
        return;
      }
      const reply = await chrome.runtime.sendMessage({ type: 'pt_errors_snapshot' });
      node.hidden = !shouldShow(settings, reply && reply.entries, Date.now());
    } catch (_) {
      node.hidden = true;
    }
  }

  function watch(id) {
    if (!id || typeof document === 'undefined' || typeof chrome === 'undefined') return;
    if (watched.has(id)) {
      watched.get(id)();
      return;
    }
    const update = () => { refresh(id).catch(() => {}); };
    const onStorage = (changes, area) => {
      if (area === 'local' && changes.pt_settings) update();
    };
    const onMessage = (message) => {
      if (message && message.type === 'pt_rpc_pool_status_changed') update();
    };
    const timer = window.setInterval(update, REFRESH_MS);
    chrome.storage.onChanged?.addListener(onStorage);
    chrome.runtime.onMessage?.addListener(onMessage);
    window.addEventListener('pagehide', () => {
      window.clearInterval(timer);
      watched.delete(id);
    }, { once: true });
    watched.set(id, update);
    update();
  }

  const api = { shouldShow, watch };
  if (typeof window !== 'undefined') window.PTRpcNotice = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
