import { rewriteCss, rewriteSrcset } from './cssRewriter.js';
import { pageUrlToFileName, extractSameOriginLinks, detectLikelyJsRendered } from './urlUtils.js';
import { analyzeNavLinks } from './navCheck.js';
import { localAssetPath } from './naming.js';

const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-original'];

// Clones a single page: fetches HTML, rewrites every asset reference to a
// local path, detects <base href>, downloads favicons/images/scripts/fonts,
// and returns the parsed doc plus discovered same-origin links for the
// crawl queue to follow. Nav-link dead-end checking is deferred to a second
// pass after the full crawl completes (see navCheckPass in crawler.js),
// since we don't know the full crawled set until the crawl is done.
export async function cloneOnePage({ pageUrl, isRoot, zip, downloader, fetcher, log }) {
  log('Fetching: ' + pageUrl);
  const res = await fetcher.fetch(pageUrl);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching page');
  const html = await res.text();

  const doc = new DOMParser().parseFromString(html, 'text/html');

  const baseTag = doc.querySelector('base[href]');
  let resolveBase = pageUrl;
  if (baseTag) {
    try {
      resolveBase = new URL(baseTag.getAttribute('href'), pageUrl).toString();
      log('Found <base href>: resolving relative URLs against ' + resolveBase);
    } catch {
      // malformed base href, fall back to pageUrl
    }
  }

  const dl = (url, kind) => downloader.download(url, kind);

  // stylesheets — fetched directly (not via downloader.download) because we
  // need the text content to rewrite its internal url()/@import refs before
  // writing it to the zip; downloader.download() only stores raw blobs.
  for (const el of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    try {
      const absolute = new URL(el.getAttribute('href'), resolveBase).toString();
      if (downloader.seen.has(absolute)) {
        el.setAttribute('href', '../' + downloader.seen.get(absolute));
        continue;
      }
      const res2 = await fetcher.fetch(absolute);
      if (!res2.ok) throw new Error('HTTP ' + res2.status);
      let cssText = await res2.text();
      cssText = await rewriteCss(cssText, absolute, dl);

      const { dir, name } = localAssetPath(absolute, 'css', null);
      const finalPath = downloader.deduper.dedupe(dir, name);
      downloader.seen.set(absolute, finalPath);
      downloader.assetCount++;

      zip.file(finalPath, cssText);
      log('Saved css: ' + finalPath, 'ok');
      el.setAttribute('href', '../' + finalPath);
    } catch (err) {
      log('Failed stylesheet: ' + err.message, 'warn');
    }
  }

  // favicons
  for (const el of Array.from(doc.querySelectorAll('link[rel*="icon"][href]'))) {
    try {
      const absolute = new URL(el.getAttribute('href'), resolveBase).toString();
      const localPath = await downloader.download(absolute, 'img');
      if (localPath) el.setAttribute('href', '../' + localPath);
    } catch {}
  }

  // images — src plus common lazy-load attributes (sites swap the real src
  // in via JS, so the raw src is often a 1x1 placeholder without these)
  for (const el of Array.from(doc.querySelectorAll('img'))) {
    try {
      const srcAttr = LAZY_ATTRS.find((a) => el.hasAttribute(a) && el.getAttribute(a)) || (el.hasAttribute('src') ? 'src' : null);
      if (srcAttr) {
        const absolute = new URL(el.getAttribute(srcAttr), resolveBase).toString();
        const localPath = await downloader.download(absolute, 'img');
        if (localPath) {
          el.setAttribute('src', '../' + localPath);
          LAZY_ATTRS.forEach((a) => el.removeAttribute(a));
        }
      }
    } catch {}
  }

  // srcset on <img> / <source>, plus plain <source src> for <picture> fallbacks
  for (const el of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
    try {
      const rewritten = await rewriteSrcset(el.getAttribute('srcset'), resolveBase, dl);
      el.setAttribute('srcset', rewritten);
    } catch {}
  }
  for (const el of Array.from(doc.querySelectorAll('source[src]'))) {
    try {
      const absolute = new URL(el.getAttribute('src'), resolveBase).toString();
      const localPath = await downloader.download(absolute, 'img');
      if (localPath) el.setAttribute('src', '../' + localPath);
    } catch {}
  }

  // inline SVG <use href> — icon/emoji sprite sheets
  for (const el of Array.from(doc.querySelectorAll('use'))) {
    try {
      const hrefAttr = el.hasAttribute('href') ? 'href' : el.hasAttribute('xlink:href') ? 'xlink:href' : null;
      if (!hrefAttr) continue;
      const raw = el.getAttribute(hrefAttr);
      if (!raw || raw.startsWith('#')) continue;
      const [urlPart, fragment] = raw.split('#');
      const absolute = new URL(urlPart, resolveBase).toString();
      const localPath = await downloader.download(absolute, 'img');
      if (localPath) el.setAttribute(hrefAttr, '../' + localPath + (fragment ? '#' + fragment : ''));
    } catch {}
  }

  // <object data> / <embed src> for SVG
  for (const el of Array.from(doc.querySelectorAll('object[type="image/svg+xml"][data], embed[src$=".svg"]'))) {
    try {
      const attr = el.tagName.toLowerCase() === 'object' ? 'data' : 'src';
      const absolute = new URL(el.getAttribute(attr), resolveBase).toString();
      const localPath = await downloader.download(absolute, 'img');
      if (localPath) el.setAttribute(attr, '../' + localPath);
    } catch {}
  }

  // scripts
  const scriptEls = Array.from(doc.querySelectorAll('script[src]'));
  for (const el of scriptEls) {
    try {
      const absolute = new URL(el.getAttribute('src'), resolveBase).toString();
      const localPath = await downloader.download(absolute, 'js');
      if (localPath) el.setAttribute('src', '../' + localPath);
    } catch {}
  }

  // inline style="" with url(...)
  for (const el of Array.from(doc.querySelectorAll('[style*="url("]'))) {
    try {
      const rewritten = await rewriteCss(el.getAttribute('style'), resolveBase, dl);
      el.setAttribute('style', rewritten);
    } catch {}
  }

  const jsRenderWarning = detectLikelyJsRendered(doc, scriptEls.length);
  if (jsRenderWarning) {
    log('Heads up — ' + pageUrl + ': ' + jsRenderWarning, 'warn');
  }

  const pageName = pageUrlToFileName(pageUrl, isRoot);
  zip.file('pages/' + pageName, '<!DOCTYPE html>\n' + doc.documentElement.outerHTML);
  log('Saved page: pages/' + pageName, 'ok');

  const discoveredLinks = extractSameOriginLinks(doc, pageUrl, resolveBase);

  return { doc, pageUrl, pageName, links: discoveredLinks, jsRenderWarning };
}

// Second pass run after the full crawl completes, once we know the full set
// of pages that actually got cloned — checks each cloned page's <nav>
// elements for links pointing at pages outside that set (dead ends offline).
export function runNavCheck(pageRecords, crawledUrlSet, normalizeFn, log) {
  const results = [];
  for (const record of pageRecords) {
    const report = analyzeNavLinks(record.doc, record.pageUrl, crawledUrlSet, normalizeFn);
    if (report.deadLinks.length > 0) {
      results.push({ pageUrl: record.pageUrl, ...report });
    }
  }

  if (results.length === 0) {
    log('Nav check: all in-site navigation links resolve to cloned pages.', 'ok');
  } else {
    const totalDead = results.reduce((sum, r) => sum + r.deadLinks.length, 0);
    log('Nav check: ' + totalDead + ' nav link(s) across ' + results.length + ' page(s) point to pages outside this clone (dead ends offline).', 'warn');
  }

  return results;
}
