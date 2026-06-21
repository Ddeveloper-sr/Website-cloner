import { normalizeUrl, formatBytes } from './urlUtils.js';
import { cloneOnePage, runNavCheck } from './pageCloner.js';
import { discoverSitemapUrls } from './sitemap.js';
import { AssetDownloader } from './assetDownloader.js';
import { ProxyFetcher, sleep, PROXIES } from './proxy.js';

const PAGE_DELAY_MS = 350;
const RATE_LIMIT_DELAY_MS = 3000;
const BLOCK_STATUS_CODES = [403, 401, 429, 503]; // status codes consistent with bot-protection / WAF blocking rather than a generic error

// Tries the root page through the requested proxy first; if that specific
// fetch fails with a status code typical of bot-protection blocking, retries
// against the other proxies in the list (skipping the one already tried and
// "None") before giving up. Returns the proxy prefix that actually worked,
// or null if every option failed — in which case the caller should treat
// the run as fully blocked, not as a generic/unknown failure.
async function findWorkingProxyForRootPage(normalizedUrl, preferredProxyPrefix, log) {
  const candidates = [preferredProxyPrefix, ...PROXIES.map((p) => p.value).filter((v) => v && v !== preferredProxyPrefix)];

  for (let i = 0; i < candidates.length; i++) {
    const proxyPrefix = candidates[i];
    const proxyLabel = PROXIES.find((p) => p.value === proxyPrefix)?.label || '(no proxy)';
    const probeFetcher = new ProxyFetcher(proxyPrefix, () => {});

    try {
      const res = await probeFetcher.fetch(normalizedUrl);
      if (res.ok) {
        if (i > 0) log('Switched to ' + proxyLabel + ' after the first proxy was blocked — this worked.', 'ok');
        return { proxyPrefix, status: res.status };
      }
      if (BLOCK_STATUS_CODES.includes(res.status)) {
        log((i === 0 ? '' : 'Also blocked: ') + proxyLabel + ' returned HTTP ' + res.status + ' on the target site — trying another proxy…', 'warn');
        continue; // try next candidate
      }
      // Non-block error (e.g. 404, 500) — switching proxies won't fix this, stop trying.
      return { proxyPrefix, status: res.status, nonBlockError: true };
    } catch (err) {
      log((i === 0 ? '' : 'Also failed: ') + proxyLabel + ': ' + err.message, 'warn');
      continue;
    }
  }

  return null; // every proxy failed with a block-like status
}

// Runs a full clone: optionally seeds the crawl queue from sitemap.xml,
// otherwise (or additionally) discovers pages by following same-origin
// links breadth-first up to maxDepth/maxPages. Returns everything a caller
// needs to build the manifest, show a summary, and run the nav check.
export async function runCrawl({ startUrl, options, zip, proxyPrefix, log, onProgress }) {
  const {
    maxPages = 5,
    maxDepth = 1,
    followLinks = false,
    useSitemap = false,
  } = options;

  const normalized = normalizeUrl(startUrl);
  const origin = new URL(normalized).origin;

  // Before committing to a full crawl, confirm the root page is actually
  // reachable — and if the chosen proxy is blocked, automatically try the
  // others rather than burning the whole run on a page that was never
  // going to load. This is the single most common failure mode (a site
  // with bot protection rejecting recognized proxy/datacenter traffic).
  log('Checking root page is reachable…');
  const probeResult = await findWorkingProxyForRootPage(normalized, proxyPrefix, log);

  if (!probeResult) {
    const err = new Error('blocked-on-all-proxies');
    err.isBlocked = true;
    err.detail = 'The target site rejected every available proxy (HTTP ' + BLOCK_STATUS_CODES.join('/') + ' — typical of bot/WAF protection). This is not a bug in the tool; the site is actively blocking automated/proxy traffic, and switching proxies further is unlikely to help.';
    throw err;
  }
  if (probeResult.nonBlockError) {
    const err = new Error('HTTP ' + probeResult.status + ' fetching root page');
    throw err;
  }

  const effectiveProxyPrefix = probeResult.proxyPrefix;
  const fetcher = new ProxyFetcher(effectiveProxyPrefix, (count) => onProgress && onProgress({ requestCount: count }));
  const downloader = new AssetDownloader(zip, fetcher, log);

  const visited = new Set([normalized]);
  const queue = [{ url: normalized, depth: 0, isRoot: true }];

  if (useSitemap) {
    log('Checking for a sitemap…');
    const sitemapUrls = await discoverSitemapUrls(origin, (u) => fetcher.fetch(u), log);
    if (sitemapUrls.length === 0) {
      log('No sitemap found — falling back to link-following only.', 'warn');
    } else {
      let added = 0;
      for (const raw of sitemapUrls) {
        if (added >= maxPages - 1) break; // -1 to leave room for the root page already queued
        try {
          const norm = normalizeUrl(raw);
          if (new URL(norm).origin !== origin) continue; // sitemap occasionally lists cross-origin/CDN URLs
          if (visited.has(norm)) continue;
          visited.add(norm);
          queue.push({ url: norm, depth: 0, isRoot: false }); // sitemap entries treated as depth 0 (top-level, not discovered via link-following)
          added++;
        } catch {
          // malformed sitemap entry, skip
        }
      }
      log('Queued ' + added + ' page(s) from sitemap.');
    }
  }

  const pageRecords = [];
  let pageCount = 0;
  let isFirstFetch = true;

  while (queue.length > 0 && pageCount < maxPages) {
    if (!isFirstFetch) {
      await sleep(fetcher.rateLimited ? RATE_LIMIT_DELAY_MS : PAGE_DELAY_MS);
    }
    isFirstFetch = false;

    const item = queue.shift();
    let result;
    try {
      result = await cloneOnePage({ pageUrl: item.url, isRoot: item.isRoot, zip, downloader, fetcher, log });
    } catch (err) {
      log('Failed page ' + item.url + ': ' + err.message, 'warn');
      continue;
    }

    pageCount++;
    pageRecords.push(result);
    if (onProgress) onProgress({ pageCount, maxPages, assetCount: downloader.assetCount, totalBytes: downloader.totalBytes });

    if (!followLinks) continue;
    if (item.depth >= maxDepth) continue;
    if (pageCount >= maxPages) break;

    for (const link of result.links) {
      const norm = normalizeUrl(link);
      if (visited.has(norm)) continue;
      if (visited.size >= maxPages) break;
      visited.add(norm);
      queue.push({ url: norm, depth: item.depth + 1, isRoot: false });
    }
  }

  // Nav dead-link check runs after the full crawl, once we know the
  // complete set of pages that actually got cloned.
  const crawledUrlSet = new Set(pageRecords.map((r) => normalizeUrl(r.pageUrl)));
  const navIssues = runNavCheck(pageRecords, crawledUrlSet, normalizeUrl, log);

  const manifest = {
    sourceUrl: normalized,
    clonedAt: new Date().toISOString(),
    pageCount,
    assetCount: downloader.assetCount,
    assetBytes: downloader.totalBytes,
    options: { maxPages, maxDepth, followLinks, useSitemap },
    proxyUsed: effectiveProxyPrefix || '(none)',
    navIssues: navIssues.map((r) => ({ pageUrl: r.pageUrl, deadLinkCount: r.deadLinks.length })),
    note: 'Cloned client-side via browser fetch + CORS proxy. JS-rendered content may be missing.',
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const indexLinks = pageRecords
    .map((r) => '<li><a href="pages/' + r.pageName + '">' + r.pageUrl + '</a>' + (r.jsRenderWarning ? ' <em>(may be JS-rendered, possibly incomplete)</em>' : '') + '</li>')
    .join('\n');
  const navWarningHtml = navIssues.length > 0
    ? '<p style="color:#b45309">' + navIssues.reduce((s, r) => s + r.deadLinks.length, 0) + ' navigation link(s) point outside this clone — see manifest.json for details.</p>'
    : '';
  zip.file('index.html', '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cloned site: ' + normalized + '</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;line-height:1.6;padding:0 20px}</style></head><body>' +
    '<h1>Cloned site</h1><p>Source: <a href="' + normalized + '">' + normalized + '</a></p>' +
    navWarningHtml +
    '<p>' + pageCount + ' page(s) cloned, ' + downloader.assetCount + ' asset(s), ' + formatBytes(downloader.totalBytes) + ' total.</p>' +
    '<ul>' + indexLinks + '</ul></body></html>');

  return { pageRecords, pageCount, assetCount: downloader.assetCount, totalBytes: downloader.totalBytes, navIssues, manifest, fetcher, proxyUsed: effectiveProxyPrefix };
}
