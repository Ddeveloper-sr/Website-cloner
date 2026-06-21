// CORS proxy handling: prefixing requests, fetch with timeout + single retry,
// and a reachability test users can run before committing to a full crawl.

export const PROXIES = [
  { label: 'corsproxy.io', value: 'https://corsproxy.io/?url=' },
  { label: 'allorigins.win', value: 'https://api.allorigins.win/raw?url=' },
  { label: 'thingproxy', value: 'https://thingproxy.freeboard.io/fetch/' },
  { label: 'None (direct fetch — only works if target allows CORS)', value: '' },
];

const FETCH_TIMEOUT_MS = 15000;
const PROXY_TEST_TARGET = 'https://example.com/';
const PROXY_TEST_TIMEOUT_MS = 8000;

export function proxify(url, proxyPrefix) {
  if (!proxyPrefix) return url;
  if (proxyPrefix.endsWith('/fetch/')) return proxyPrefix + url; // thingproxy appends raw URL, no encoding
  return proxyPrefix + encodeURIComponent(url);
}

// Stateful fetcher: tracks request count and whether rate-limiting (HTTP 429)
// has been seen, so callers can back off for the remainder of a run.
export class ProxyFetcher {
  constructor(proxyPrefix, onRequest) {
    this.proxyPrefix = proxyPrefix;
    this.onRequest = onRequest || (() => {});
    this.requestCount = 0;
    this.rateLimited = false;
  }

  async fetch(url, opts, retryOnFail) {
    this.requestCount++;
    this.onRequest(this.requestCount);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(proxify(url, this.proxyPrefix), { ...(opts || {}), signal: controller.signal });
      if (res.status === 429) this.rateLimited = true;
      return res;
    } catch (err) {
      if (retryOnFail !== false) {
        clearTimeout(t);
        return this.fetch(url, opts, false); // one retry only
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

// One-off reachability check, independent of a running crawl. Tests against
// a small known-good page rather than the user's target URL, so the result
// reflects proxy health rather than target-site availability.
export async function testProxy(proxyPrefix) {
  if (!proxyPrefix) {
    return { ok: false, message: 'No proxy selected — direct fetch only works if the target site explicitly allows CORS, which most don\'t. Nothing to test.' };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
  const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());

  try {
    const res = await fetch(proxify(PROXY_TEST_TARGET, proxyPrefix), { signal: controller.signal });
    const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    if (res.ok) {
      return { ok: true, message: 'Reachable (' + elapsed + 'ms).' };
    }
    return { ok: false, message: 'Responded with HTTP ' + res.status + ' — try another proxy.' };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    return { ok: false, message: 'Unreachable (' + reason + ') — try another proxy.' };
  } finally {
    clearTimeout(t);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
