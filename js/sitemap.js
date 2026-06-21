// Sitemap-based page discovery. Often more complete and reliable than
// following <a> links, especially on sites with JS-driven navigation where
// menu items aren't plain anchor tags a crawler can see.

export function parseSitemapXml(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) return [];
    return Array.from(doc.querySelectorAll('url > loc'))
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Parses both a plain <urlset> sitemap and a <sitemapindex> (which points at
// other sitemap files — common on larger sites that split sitemaps by
// section). Sitemap indexes are followed one level deep only, to keep this
// bounded; deeply nested sitemap trees are rare in practice.
export async function parseSitemapAndFollow(xmlText, fetchFn, log, maxNestedFetches = 5) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

  const isIndex = doc.querySelector('sitemapindex') !== null;
  if (!isIndex) {
    return parseSitemapXml(xmlText);
  }

  const sitemapLocs = Array.from(doc.querySelectorAll('sitemap > loc'))
    .map((el) => el.textContent.trim())
    .slice(0, maxNestedFetches);

  if (log) log('Sitemap index found, following ' + sitemapLocs.length + ' nested sitemap(s).');

  let allUrls = [];
  for (const loc of sitemapLocs) {
    try {
      const res = await fetchFn(loc);
      if (!res.ok) continue;
      const text = await res.text();
      allUrls = allUrls.concat(parseSitemapXml(text));
    } catch {
      // one nested sitemap failing shouldn't abort the rest
    }
  }
  return allUrls;
}

// Tries /sitemap.xml first, then checks robots.txt for a Sitemap: directive
// (some sites point to a non-standard path or a sitemap index file).
export async function discoverSitemapUrls(siteOrigin, fetchFn, log) {
  const candidates = [new URL('/sitemap.xml', siteOrigin).toString()];

  try {
    const robotsUrl = new URL('/robots.txt', siteOrigin).toString();
    const res = await fetchFn(robotsUrl);
    if (res.ok) {
      const text = await res.text();
      const match = text.match(/^sitemap:\s*(\S+)/im);
      if (match && !candidates.includes(match[1])) {
        candidates.unshift(match[1]); // prefer robots.txt-declared sitemap if present
      }
    }
  } catch {
    // robots.txt unreachable — not fatal, just skip this hint
  }

  for (const url of candidates) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) continue;
      const text = await res.text();
      const urls = await parseSitemapAndFollow(text, fetchFn, log);
      if (urls.length > 0) {
        if (log) log('Found sitemap at ' + url + ' (' + urls.length + ' URL(s)).');
        return urls;
      }
    } catch {
      // this candidate failed, try the next
    }
  }

  return [];
}
