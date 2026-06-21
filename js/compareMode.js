import { runCrawl } from './crawler.js';
import { formatBytes } from './urlUtils.js';

// Runs two independent clone jobs (sequentially, to stay within proxy rate
// limits rather than doubling concurrent load) and writes a comparison
// summary alongside both clones' files, each under its own subfolder.
export async function runComparison({ urlA, urlB, options, zip, proxyPrefix, log }) {
  log('--- Cloning site A: ' + urlA + ' ---');
  const zipA = zip.folder('site-a');
  const resultA = await runCrawl({ startUrl: urlA, options, zip: zipA, proxyPrefix, log: (m, k) => log('[A] ' + m, k) });

  log('--- Cloning site B: ' + urlB + ' ---');
  const zipB = zip.folder('site-b');
  const resultB = await runCrawl({ startUrl: urlB, options, zip: zipB, proxyPrefix, log: (m, k) => log('[B] ' + m, k) });

  const comparison = {
    generatedAt: new Date().toISOString(),
    siteA: {
      url: urlA,
      pageCount: resultA.pageCount,
      assetCount: resultA.assetCount,
      totalBytes: resultA.totalBytes,
      navIssueCount: resultA.navIssues.reduce((s, r) => s + r.deadLinks.length, 0),
    },
    siteB: {
      url: urlB,
      pageCount: resultB.pageCount,
      assetCount: resultB.assetCount,
      totalBytes: resultB.totalBytes,
      navIssueCount: resultB.navIssues.reduce((s, r) => s + r.deadLinks.length, 0),
    },
  };

  zip.file('comparison.json', JSON.stringify(comparison, null, 2));
  zip.file('comparison.html', buildComparisonHtml(comparison));

  log('Comparison complete.', 'ok');
  return comparison;
}

function buildComparisonHtml(c) {
  const row = (label, a, b) => '<tr><td>' + label + '</td><td>' + a + '</td><td>' + b + '</td></tr>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Site comparison</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px}' +
    'table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px 12px;border-bottom:1px solid #ddd;text-align:left}' +
    'th{color:#666;font-size:13px;text-transform:uppercase;letter-spacing:0.04em}</style></head><body>' +
    '<h1>Site comparison</h1>' +
    '<table><tr><th></th><th>Site A</th><th>Site B</th></tr>' +
    row('URL', c.siteA.url, c.siteB.url) +
    row('Pages cloned', c.siteA.pageCount, c.siteB.pageCount) +
    row('Assets', c.siteA.assetCount, c.siteB.assetCount) +
    row('Total size', formatBytes(c.siteA.totalBytes), formatBytes(c.siteB.totalBytes)) +
    row('Nav issues', c.siteA.navIssueCount, c.siteB.navIssueCount) +
    '</table>' +
    '<p style="margin-top:24px;color:#666;font-size:14px">Full clones for each site are in the <code>site-a/</code> and <code>site-b/</code> folders.</p>' +
    '</body></html>';
}
