// CSS url()/@import extraction and rewriting. @import is checked first and
// its matched span excluded from the url() pass, so `@import url('x.css')`
// is only counted once (a real bug this fixes, not just defensive coding).

export function extractCssRefs(cssText) {
  const refs = [];
  const importSpans = [];
  const importRe = /@import\s+(?:url\()?\s*(['"]?)([^'")]+)\1\s*\)?\s*;?/gi;
  let m;
  while ((m = importRe.exec(cssText)) !== null) {
    refs.push({ raw: m[0], value: m[2].trim(), kind: 'import' });
    importSpans.push([m.index, m.index + m[0].length]);
  }
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  while ((m = urlRe.exec(cssText)) !== null) {
    const v = m[2].trim();
    if (v.startsWith('data:')) continue;
    const insideImport = importSpans.some(([s, e]) => m.index >= s && m.index < e);
    if (insideImport) continue;
    refs.push({ raw: m[0], value: v, kind: 'url' });
  }
  return refs;
}

export async function rewriteCss(cssText, baseUrl, downloadFn) {
  const refs = extractCssRefs(cssText);
  let out = cssText;
  for (const ref of refs) {
    try {
      const absolute = new URL(ref.value, baseUrl).toString();
      const kind = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(absolute) ? 'font'
        : /\.css(\?|$)/i.test(absolute) ? 'css' : 'img';
      const localPath = await downloadFn(absolute, kind);
      if (!localPath) continue;
      const rel = '../../../' + localPath; // assets/css/<host>/file.css -> back to zip root
      if (ref.kind === 'url') out = out.split(ref.raw).join('url("' + rel + '")');
      else out = out.split(ref.raw).join('@import url("' + rel + '");');
    } catch {
      // skip malformed reference
    }
  }
  return out;
}

// srcset="url1 1x, url2 2x, url3 480w" -> download each candidate, rewrite
// to a relative path, preserve its size/density descriptor.
export async function rewriteSrcset(srcsetValue, baseUrl, downloadFn) {
  const parts = srcsetValue.split(',').map((p) => p.trim()).filter(Boolean);
  const rewritten = [];
  for (const part of parts) {
    const spaceIdx = part.search(/\s/);
    const url = spaceIdx === -1 ? part : part.slice(0, spaceIdx);
    const descriptor = spaceIdx === -1 ? '' : part.slice(spaceIdx + 1).trim();
    if (!url || url.startsWith('data:')) {
      rewritten.push(part);
      continue;
    }
    try {
      const absolute = new URL(url, baseUrl).toString();
      const localPath = await downloadFn(absolute, 'img');
      if (!localPath) {
        rewritten.push(part);
        continue;
      }
      const rel = '../' + localPath; // pages/index.html -> back to zip root
      rewritten.push(descriptor ? rel + ' ' + descriptor : rel);
    } catch {
      rewritten.push(part);
    }
  }
  return rewritten.join(', ');
}
