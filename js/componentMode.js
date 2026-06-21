import { rewriteCss, rewriteSrcset } from './cssRewriter.js';
import { AssetDownloader } from './assetDownloader.js';
import { ProxyFetcher } from './proxy.js';
import { normalizeUrl } from './urlUtils.js';

// Extracts a single component (matched by CSS selector) from a page: its
// HTML, all stylesheets active on the page (component CSS is rarely fully
// self-contained — it depends on shared base styles, custom properties,
// resets, etc., so pulling every linked stylesheet is the safer default
// rather than guessing which rules apply), and every asset the component
// references directly.
export async function extractComponent({ pageUrl, selector, zip, proxyPrefix, log }) {
  const fetcher = new ProxyFetcher(proxyPrefix, () => {});
  const downloader = new AssetDownloader(zip, fetcher, log);
  const normalized = normalizeUrl(pageUrl);

  log('Fetching: ' + normalized);
  const res = await fetcher.fetch(normalized);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching page');
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const target = doc.querySelector(selector);
  if (!target) {
    throw new Error('No element matched selector "' + selector + '" on this page.');
  }

  const baseTag = doc.querySelector('base[href]');
  const resolveBase = baseTag ? new URL(baseTag.getAttribute('href'), normalized).toString() : normalized;
  const dl = (url, kind) => downloader.download(url, kind);

  // Pull every page stylesheet — see function comment for why this isn't
  // scoped down to "only rules touching the component".
  const cssBlocks = [];
  for (const el of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    try {
      const absolute = new URL(el.getAttribute('href'), resolveBase).toString();
      const cssRes = await fetcher.fetch(absolute);
      if (!cssRes.ok) continue;
      let cssText = await cssRes.text();
      cssText = await rewriteCss(cssText, absolute, dl);
      cssBlocks.push('/* from ' + absolute + ' */\n' + cssText);
    } catch (err) {
      log('Failed stylesheet: ' + err.message, 'warn');
    }
  }

  // Any <style> blocks in <head> — common for component-scoped or
  // critical-path CSS that isn't in an external file at all.
  for (const styleEl of Array.from(doc.querySelectorAll('head style'))) {
    cssBlocks.push('/* inline <style> */\n' + styleEl.textContent);
  }

  // Images/srcset/lazy-attrs within just the matched element
  for (const el of Array.from(target.querySelectorAll('img'))) {
    try {
      const srcAttr = ['data-src', 'data-lazy-src', 'data-original'].find((a) => el.hasAttribute(a) && el.getAttribute(a)) || (el.hasAttribute('src') ? 'src' : null);
      if (srcAttr) {
        const absolute = new URL(el.getAttribute(srcAttr), resolveBase).toString();
        const localPath = await downloader.download(absolute, 'img');
        if (localPath) {
          el.setAttribute('src', localPath);
          ['data-src', 'data-lazy-src', 'data-original'].forEach((a) => el.removeAttribute(a));
        }
      }
      if (el.hasAttribute('srcset')) {
        const rewritten = await rewriteSrcset(el.getAttribute('srcset'), resolveBase, dl);
        el.setAttribute('srcset', rewritten);
      }
    } catch {}
  }

  // inline style="" with url(...) inside the component
  for (const el of Array.from(target.querySelectorAll('[style*="url("]'))) {
    try {
      const rewritten = await rewriteCss(el.getAttribute('style'), resolveBase, dl);
      el.setAttribute('style', rewritten);
    } catch {}
  }

  const componentHtml = target.outerHTML;
  const combinedCss = cssBlocks.join('\n\n');

  const previewHtml = '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n' +
    '<title>Component: ' + selector + '</title>\n' +
    '<style>\n' + combinedCss + '\n</style>\n' +
    '</head><body>\n' + componentHtml + '\n</body></html>';

  zip.file('component.html', previewHtml);
  zip.file('component-fragment.html', componentHtml);
  zip.file('component-styles.css', combinedCss);
  zip.file('manifest.json', JSON.stringify({
    sourceUrl: normalized,
    selector,
    clonedAt: new Date().toISOString(),
    assetCount: downloader.assetCount,
    note: 'Component-only extraction. Includes all page stylesheets since component styles usually depend on shared base CSS, resets, and custom properties.',
  }, null, 2));

  log('Component extracted: ' + selector, 'ok');
  return { assetCount: downloader.assetCount };
}
