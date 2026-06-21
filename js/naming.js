// Asset naming: decides where a downloaded file lands in the zip.
// Priority for extension detection: Content-Type header > byte-sniff of the
// actual content > URL path extension > generic kind-based fallback.
// This three-tier fallback exists because some CORS proxies strip or mangle
// headers on binary responses, so the header alone can't always be trusted.

export function guessExtFromUrl(url, fallback) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

const MIME_TO_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf',
  'application/font-woff2': 'woff2', 'application/font-woff': 'woff',
  'text/css': 'css', 'application/javascript': 'js', 'text/javascript': 'js',
};

export function extFromContentType(contentType) {
  if (!contentType) return null;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[mime] || null;
}

// Inspects the first bytes of a downloaded file against known binary
// signatures. Fallback of last resort for when Content-Type is missing
// or unreliable (which public CORS proxies sometimes cause on binaries).
export async function sniffExtFromBytes(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join('');

    if (hex.startsWith('89504e47')) return 'png';
    if (hex.startsWith('ffd8ff')) return 'jpg';
    if (hex.startsWith('47494638')) return 'gif';
    if (hex.startsWith('424d')) return 'bmp';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'webp'; // RIFF....WEBP
    if (hex.startsWith('00000100')) return 'ico';
    if (hex.startsWith('774f4632')) return 'woff2'; // 'wOF2'
    if (hex.startsWith('774f4646')) return 'woff';  // 'wOFF'
    if (hex.startsWith('00010000') || hex.startsWith('4f54544f')) return 'ttf'; // sfnt / OTTO

    const text = new TextDecoder().decode(head);
    if (text.trimStart().startsWith('<svg') || text.trimStart().startsWith('<?xml')) return 'svg';

    return null;
  } catch {
    return null;
  }
}

export function localAssetPath(absoluteUrl, kind, ext) {
  const u = new URL(absoluteUrl);
  const host = u.host.replace(/[^a-z0-9.-]/gi, '_');
  let name = u.pathname.split('/').filter(Boolean).pop() || 'file';
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!/\.[a-zA-Z0-9]{1,5}$/.test(name)) {
    name += '.' + (ext || guessExtFromUrl(absoluteUrl, kind === 'css' ? 'css' : kind === 'js' ? 'js' : 'bin'));
  }
  return { dir: 'assets/' + kind + '/' + host + '/', name };
}

// Tracks every path already used in a given zip run, so two different
// source URLs that would otherwise collide on the same filename get
// disambiguated with a numeric suffix instead of silently overwriting
// each other inside the zip.
export class PathDeduper {
  constructor() {
    this.usedPaths = new Set();
  }

  dedupe(dir, name) {
    let candidate = dir + name;
    if (!this.usedPaths.has(candidate)) {
      this.usedPaths.add(candidate);
      return candidate;
    }
    const dotIdx = name.lastIndexOf('.');
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';
    let i = 2;
    while (this.usedPaths.has(dir + base + '-' + i + ext)) i++;
    const final = dir + base + '-' + i + ext;
    this.usedPaths.add(final);
    return final;
  }
}
