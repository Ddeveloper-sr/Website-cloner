// Builds a previewable blob URL for a cloned page so the user can sanity
// check the result in an iframe before downloading the zip. Since assets
// were rewritten to relative paths during cloning, and a blob: URL has no
// real directory structure to resolve those relative paths against, this
// works by inlining the page's CSS and swapping image src/srcset to data:
// URIs pulled from the in-memory zip — turning it into a single
// self-contained HTML document for preview purposes only (the actual
// zip output still uses normal relative file paths).
export async function buildPreviewHtml(zip, pageRelPath) {
  const pageFile = zip.file(pageRelPath);
  if (!pageFile) throw new Error('Page not found in zip: ' + pageRelPath);

  let html = await pageFile.async('string');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const pageDir = pageRelPath.split('/').slice(0, -1).join('/'); // e.g. "pages"

  async function resolveAndInline(relHref) {
    const resolved = normalizeZipPath(pageDir, relHref);
    const file = zip.file(resolved);
    if (!file) return null;
    return file;
  }

  // Inline stylesheets directly into a <style> tag (preview only — the
  // actual zip keeps them as separate files).
  const linkEls = Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'));
  for (const el of linkEls) {
    try {
      const file = await resolveAndInline(el.getAttribute('href'));
      if (!file) continue;
      const cssText = await file.async('string');
      const styleEl = doc.createElement('style');
      styleEl.textContent = cssText;
      el.replaceWith(styleEl);
    } catch {
      // leave the link tag as-is if inlining fails; preview just won't be fully styled
    }
  }

  // Swap image src to data: URIs so they render without a real filesystem
  const imgEls = Array.from(doc.querySelectorAll('img[src]'));
  for (const el of imgEls) {
    try {
      const file = await resolveAndInline(el.getAttribute('src'));
      if (!file) continue;
      const base64 = await file.async('base64');
      const mime = guessMimeFromPath(el.getAttribute('src'));
      el.setAttribute('src', 'data:' + mime + ';base64,' + base64);
    } catch {
      // leave broken if it fails — preview is best-effort
    }
  }

  const finalHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  const blob = new Blob([finalHtml], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

// Resolves a relative path like "../assets/css/example.com/main.css" against
// the directory the referencing file lives in, returning a normalized
// zip-internal path with no ".." segments left.
function normalizeZipPath(fromDir, relPath) {
  const parts = (fromDir ? fromDir.split('/') : []).concat(relPath.split('/'));
  const stack = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function guessMimeFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  };
  return map[ext] || 'application/octet-stream';
}
