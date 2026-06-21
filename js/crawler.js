import { normalizeUrl, formatBytes } from './urlUtils.js';
import { cloneOnePage, runNavCheck } from './pageCloner.js';
import { discoverSitemapUrls } from './sitemap.js';
import { AssetDownloader } from './assetDownloader.js';
import { ProxyFetcher, sleep } from './proxy.js';

const PAGE_DELAY_MS = 350;
const RATE_LIMIT_DELAY_MS = 3000;

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

  const fetcher = new ProxyFetcher(proxyPrefix, (count) => onProgress && onProgress({ requestCount: count }));
  const downloader = new AssetDownloader(zip, fetcher, log);

  const normalized = normalizeUrl(startUrl);
  const origin = new URL(normalized).origin;

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

  return { pageRecords, pageCount, assetCount: downloader.assetCount, totalBytes: downloader.totalBytes, navIssues, manifest, fetcher };
}
