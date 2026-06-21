// Navigation fidelity check: finds <nav>/role=navigation elements on a page
// and reports which of their links point at pages that were NOT part of the
// crawl — those will be dead ends once the zip is offline, since only
// crawled pages get downloaded and rewritten to local paths.

export function findNavElements(doc) {
  return Array.from(doc.querySelectorAll('nav, [role="navigation"]'));
}

// crawledUrlSet: a Set of normalized URLs that were actually downloaded
// during this run (pass the same normalization used by the crawl queue).
export function analyzeNavLinks(doc, pageUrl, crawledUrlSet, normalizeFn) {
  const navEls = findNavElements(doc);
  if (navEls.length === 0) {
    return { navCount: 0, totalLinks: 0, deadLinks: [] };
  }

  const origin = new URL(pageUrl).origin;
  const seen = new Set();
  const deadLinks = [];
  let totalLinks = 0;

  for (const nav of navEls) {
    const anchors = Array.from(nav.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

      let absolute;
      try {
        absolute = new URL(href, pageUrl).toString();
      } catch {
        continue;
      }

      if (seen.has(absolute)) continue;
      seen.add(absolute);
      totalLinks++;

      // External links (different origin) are expected to be "dead" in an
      // offline clone — that's normal, not worth flagging.
      if (new URL(absolute).origin !== origin) continue;

      const normalized = normalizeFn ? normalizeFn(absolute) : absolute;
      if (!crawledUrlSet.has(normalized)) {
        deadLinks.push({ href, absolute, text: (a.textContent || '').trim().slice(0, 60) });
      }
    }
  }

  return { navCount: navEls.length, totalLinks, deadLinks };
}
