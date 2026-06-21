// URL helpers shared across crawling, comparison, and component-extraction modes.

export function normalizeUrl(rawUrl) {
  const u = new URL(rawUrl);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

export function pageUrlToFileName(pageUrl, isRoot) {
  if (isRoot) return 'index.html';
  const u = new URL(pageUrl);
  let p = u.pathname.replace(/^\/|\/$/g, '');
  if (!p) return 'index.html';
  const safe = p.replace(/[^a-zA-Z0-9]+/g, '_');
  return safe + '.html';
}

export function extractSameOriginLinks(doc, pageUrl, resolveBase) {
  const origin = new URL(pageUrl).origin;
  const base = resolveBase || pageUrl;
  const out = new Set();
  Array.from(doc.querySelectorAll('a[href]')).forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const abs = new URL(href, base).toString();
      const u = new URL(abs);
      u.hash = '';
      if (u.origin === origin) out.add(u.toString());
    } catch {
      // malformed href, skip
    }
  });
  return Array.from(out);
}

// Heuristic check for whether a page looks like it depends on client-side
// JS to render its real content (React/Vue/Next.js etc). Not a guarantee —
// just a useful warning signal since a browser-fetch clone can't run JS.
export function detectLikelyJsRendered(doc, scriptCount) {
  const bodyText = (doc.body && doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  const elementCount = doc.body ? doc.body.querySelectorAll('*').length : 0;
  const hasRootDiv = !!doc.querySelector('#root, #app, #__next, #__nuxt');

  const looksEmpty = bodyText.length < 200 && elementCount < 15;
  const looksLikeKnownFramework = hasRootDiv && elementCount < 10;

  if (looksLikeKnownFramework) {
    return 'page body is a near-empty mount point (#root/#app/#__next) — this is almost certainly a JS-rendered app; the cloned HTML will likely look blank.';
  }
  if (looksEmpty && scriptCount > 0) {
    return 'page has very little text/markup but ' + scriptCount + ' script tag(s) — content is likely built by JavaScript after load, so this clone may look incomplete.';
  }
  return null;
}
