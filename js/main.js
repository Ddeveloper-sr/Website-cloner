import { PROXIES, testProxy } from './proxy.js';
import { clampInt, formatBytes } from './urlUtils.js';
import { runCrawl } from './crawler.js';
import { extractComponent } from './componentMode.js';
import { runComparison } from './compareMode.js';
import { buildPreviewHtml } from './preview.js';

// --- shared elements ---
const proxySelect = document.getElementById('proxySelect');
const testProxyBtn = document.getElementById('testProxyBtn');
const proxyTestResult = document.getElementById('proxyTestResult');

const progressPanel = document.getElementById('progressPanel');
const statusBadge = document.getElementById('statusBadge');
const progressStats = document.getElementById('progressStats');
const requestCountEl = document.getElementById('requestCounter');
const barFill = document.getElementById('barFill');
const logWindow = document.getElementById('logWindow');
const copyLogBtn = document.getElementById('copyLogBtn');
const downloadRow = document.getElementById('downloadRow');
const downloadLink = document.getElementById('downloadLink');
const previewBtn = document.getElementById('previewBtn');
const previewFrameWrap = document.getElementById('previewFrameWrap');
const previewFrame = document.getElementById('previewFrame');

// --- populate proxy dropdown from the shared list ---
PROXIES.forEach((p) => {
  const opt = document.createElement('option');
  opt.value = p.value;
  opt.textContent = p.label;
  proxySelect.appendChild(opt);
});

// --- tab switching ---
const tabBtns = Array.from(document.querySelectorAll('.tab-btn'));
const modeViews = {
  clone: document.getElementById('view-clone'),
  component: document.getElementById('view-component'),
  compare: document.getElementById('view-compare'),
};
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(modeViews).forEach((v) => v.classList.remove('active'));
    modeViews[btn.dataset.mode].classList.add('active');
    downloadRow.style.display = 'none';
    previewFrameWrap.style.display = 'none';
  });
});

// --- shared log/progress helpers ---
function setError(elId, msg) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function setBadge(text, kind) {
  statusBadge.textContent = text;
  statusBadge.className = 'status-badge' + (kind === 'error' ? ' error' : '');
}

function log(msg, kind) {
  const div = document.createElement('div');
  div.className = 'line' + (kind ? ' ' + kind : '');
  div.textContent = msg;
  logWindow.appendChild(div);
  logWindow.scrollTop = logWindow.scrollHeight;
}

function setProgress(done, total, label) {
  progressStats.textContent = label || (done + ' / ' + total);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  barFill.style.width = pct + '%';
}

function resetRunUI() {
  progressPanel.style.display = 'block';
  downloadRow.style.display = 'none';
  previewFrameWrap.style.display = 'none';
  logWindow.innerHTML = '';
  setBadge('working');
  setProgress(0, 1, 'starting…');
  requestCountEl.textContent = '0 requests';
}

// --- proxy test ---
testProxyBtn.addEventListener('click', async () => {
  const proxyLabel = proxySelect.options[proxySelect.selectedIndex].textContent;
  proxyTestResult.className = 'proxy-test-result testing';
  proxyTestResult.textContent = 'Testing ' + proxyLabel + '…';
  testProxyBtn.disabled = true;
  const result = await testProxy(proxySelect.value);
  proxyTestResult.className = 'proxy-test-result ' + (result.ok ? 'ok' : 'fail');
  proxyTestResult.textContent = proxyLabel + ': ' + result.message;
  testProxyBtn.disabled = false;
});
proxySelect.addEventListener('change', () => {
  proxyTestResult.className = 'proxy-test-result';
  proxyTestResult.textContent = '';
});

// --- copy log ---
copyLogBtn.addEventListener('click', async () => {
  const text = Array.from(logWindow.querySelectorAll('.line')).map((el) => el.textContent).join('\n');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  copyLogBtn.textContent = 'Copied';
  copyLogBtn.classList.add('copied');
  setTimeout(() => { copyLogBtn.textContent = 'Copy log'; copyLogBtn.classList.remove('copied'); }, 1500);
});

// =====================================================================
// CLONE MODE
// =====================================================================
const MAX_PAGES_CEILING = 25;
const MAX_DEPTH_CEILING = 5;

const urlInput = document.getElementById('urlInput');
const maxPagesInput = document.getElementById('maxPagesInput');
const maxDepthInput = document.getElementById('maxDepthInput');
const useSitemapInput = document.getElementById('useSitemap');
const followLinksInput = document.getElementById('followLinks');
const startBtn = document.getElementById('startBtn');

let lastZip = null;
let lastRootPagePath = null;

startBtn.addEventListener('click', async () => {
  setError('errorMsg', '');
  const rawUrl = urlInput.value.trim();
  if (!rawUrl) { setError('errorMsg', 'Enter a URL to clone.'); return; }

  let parsed;
  try {
    parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    setError('errorMsg', 'Enter a valid URL, including https://');
    return;
  }

  const maxPages = clampInt(maxPagesInput.value, 1, MAX_PAGES_CEILING, 5);
  const maxDepth = clampInt(maxDepthInput.value, 0, MAX_DEPTH_CEILING, 1);
  saveCloneSettings();

  startBtn.disabled = true;
  startBtn.textContent = 'Cloning…';
  resetRunUI();
  setProgress(0, maxPages, '0 / ' + maxPages + ' pages');

  const zip = new JSZip();

  try {
    const result = await runCrawl({
      startUrl: parsed.toString(),
      options: { maxPages, maxDepth, followLinks: followLinksInput.checked, useSitemap: useSitemapInput.checked },
      zip,
      proxyPrefix: proxySelect.value,
      log,
      onProgress: (p) => {
        if (p.requestCount) requestCountEl.textContent = p.requestCount + ' request' + (p.requestCount === 1 ? '' : 's');
        if (p.pageCount !== undefined) setProgress(p.pageCount, p.maxPages, p.pageCount + ' / ' + p.maxPages + ' pages');
      },
    });

    log('Packaging zip…');
    setBadge('packaging');
    const blob = await zip.generateAsync({ type: 'blob' });
    const blobUrl = URL.createObjectURL(blob);

    downloadLink.href = blobUrl;
    downloadLink.download = parsed.host + '-clone.zip';
    downloadRow.style.display = 'flex';
    setBadge('done');

    const sizeLabel = formatBytes(result.totalBytes);
    setProgress(result.pageCount, maxPages, result.pageCount + ' pages · ' + result.assetCount + ' assets · ' + sizeLabel);
    log('Done. ' + result.pageCount + ' page(s), ' + result.assetCount + ' asset(s), ' + sizeLabel + ' total.', 'ok');

    lastZip = zip;
    lastRootPagePath = result.pageRecords.find((r) => r.pageName === 'index.html')
      ? 'pages/index.html'
      : (result.pageRecords[0] ? 'pages/' + result.pageRecords[0].pageName : null);
  } catch (err) {
    setBadge('error', 'error');
    const hint = (err.message || '').toLowerCase().includes('failed to fetch')
      ? '\nThis usually means the CORS proxy blocked or timed out the request — try the other proxy option above.'
      : '';
    setError('errorMsg', 'Clone failed: ' + err.message + hint);
    log('Fatal: ' + err.message, 'err');
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = 'Clone site';
  }
});

previewBtn.addEventListener('click', async () => {
  if (!lastZip || !lastRootPagePath) return;
  previewBtn.disabled = true;
  previewBtn.textContent = 'Building preview…';
  try {
    const url = await buildPreviewHtml(lastZip, lastRootPagePath);
    previewFrame.src = url;
    previewFrameWrap.style.display = 'block';
  } catch (err) {
    log('Preview failed: ' + err.message, 'warn');
  } finally {
    previewBtn.disabled = false;
    previewBtn.textContent = 'Preview before download';
  }
});

urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startBtn.click(); });

// =====================================================================
// COMPONENT MODE
// =====================================================================
const compUrlInput = document.getElementById('compUrlInput');
const compSelectorInput = document.getElementById('compSelectorInput');
const compStartBtn = document.getElementById('compStartBtn');

compStartBtn.addEventListener('click', async () => {
  setError('compErrorMsg', '');
  const rawUrl = compUrlInput.value.trim();
  const selector = compSelectorInput.value.trim();

  if (!rawUrl) { setError('compErrorMsg', 'Enter a page URL.'); return; }
  if (!selector) { setError('compErrorMsg', 'Enter a CSS selector, e.g. .pricing-card'); return; }

  let parsed;
  try {
    parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    setError('compErrorMsg', 'Enter a valid URL, including https://');
    return;
  }

  try {
    document.querySelector('body').querySelector(selector); // validate selector syntax against the live document (cheap sanity check)
  } catch {
    setError('compErrorMsg', 'That doesn\'t look like a valid CSS selector.');
    return;
  }

  compStartBtn.disabled = true;
  compStartBtn.textContent = 'Extracting…';
  resetRunUI();
  setProgress(0, 1, 'fetching…');

  const zip = new JSZip();

  try {
    const result = await extractComponent({
      pageUrl: parsed.toString(),
      selector,
      zip,
      proxyPrefix: proxySelect.value,
      log,
    });

    log('Packaging zip…');
    setBadge('packaging');
    const blob = await zip.generateAsync({ type: 'blob' });
    const blobUrl = URL.createObjectURL(blob);

    downloadLink.href = blobUrl;
    downloadLink.download = parsed.host + '-component.zip';
    downloadRow.style.display = 'flex';
    setBadge('done');
    setProgress(1, 1, result.assetCount + ' asset(s)');
    log('Done. Component extracted with ' + result.assetCount + ' asset(s).', 'ok');

    lastZip = zip;
    lastRootPagePath = null; // component.html isn't under pages/, preview button only wired for clone mode's path layout
  } catch (err) {
    setBadge('error', 'error');
    setError('compErrorMsg', 'Extraction failed: ' + err.message);
    log('Fatal: ' + err.message, 'err');
  } finally {
    compStartBtn.disabled = false;
    compStartBtn.textContent = 'Extract component';
  }
});

// =====================================================================
// COMPARE MODE
// =====================================================================
const cmpUrlAInput = document.getElementById('cmpUrlAInput');
const cmpUrlBInput = document.getElementById('cmpUrlBInput');
const cmpMaxPagesInput = document.getElementById('cmpMaxPagesInput');
const cmpMaxDepthInput = document.getElementById('cmpMaxDepthInput');
const cmpStartBtn = document.getElementById('cmpStartBtn');

cmpStartBtn.addEventListener('click', async () => {
  setError('cmpErrorMsg', '');
  const rawA = cmpUrlAInput.value.trim();
  const rawB = cmpUrlBInput.value.trim();
  if (!rawA || !rawB) { setError('cmpErrorMsg', 'Enter both URLs.'); return; }

  let parsedA, parsedB;
  try {
    parsedA = new URL(rawA);
    parsedB = new URL(rawB);
    if (!['http:', 'https:'].includes(parsedA.protocol) || !['http:', 'https:'].includes(parsedB.protocol)) throw new Error();
  } catch {
    setError('cmpErrorMsg', 'Enter two valid URLs, including https://');
    return;
  }

  const maxPages = clampInt(cmpMaxPagesInput.value, 1, 10, 3); // lower ceiling than clone mode since this runs two crawls
  const maxDepth = clampInt(cmpMaxDepthInput.value, 0, 3, 1);

  cmpStartBtn.disabled = true;
  cmpStartBtn.textContent = 'Comparing…';
  resetRunUI();
  setProgress(0, 1, 'starting…');

  const zip = new JSZip();

  try {
    const comparison = await runComparison({
      urlA: parsedA.toString(),
      urlB: parsedB.toString(),
      options: { maxPages, maxDepth, followLinks: true, useSitemap: false },
      zip,
      proxyPrefix: proxySelect.value,
      log,
    });

    log('Packaging zip…');
    setBadge('packaging');
    const blob = await zip.generateAsync({ type: 'blob' });
    const blobUrl = URL.createObjectURL(blob);

    downloadLink.href = blobUrl;
    downloadLink.download = 'site-comparison.zip';
    downloadRow.style.display = 'flex';
    setBadge('done');
    setProgress(1, 1, comparison.siteA.pageCount + ' vs ' + comparison.siteB.pageCount + ' pages');
    log('Comparison done.', 'ok');

    lastZip = zip;
    lastRootPagePath = null; // compare mode has its own comparison.html, not wired to the iframe preview path layout
  } catch (err) {
    setBadge('error', 'error');
    setError('cmpErrorMsg', 'Comparison failed: ' + err.message);
    log('Fatal: ' + err.message, 'err');
  } finally {
    cmpStartBtn.disabled = false;
    cmpStartBtn.textContent = 'Compare sites';
  }
});

// =====================================================================
// settings persistence (clone mode only — the mode most likely reused often)
// =====================================================================
const SETTINGS_KEY = 'site-cloner-settings';

function loadCloneSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.url) urlInput.value = s.url;
    if (s.proxy !== undefined) proxySelect.value = s.proxy;
    if (s.maxPages) maxPagesInput.value = s.maxPages;
    if (s.maxDepth !== undefined) maxDepthInput.value = s.maxDepth;
    if (s.followLinks !== undefined) followLinksInput.checked = s.followLinks;
    if (s.useSitemap !== undefined) useSitemapInput.checked = s.useSitemap;
  } catch {
    // corrupted or inaccessible storage — start fresh
  }
}

function saveCloneSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      url: urlInput.value.trim(),
      proxy: proxySelect.value,
      maxPages: maxPagesInput.value,
      maxDepth: maxDepthInput.value,
      followLinks: followLinksInput.checked,
      useSitemap: useSitemapInput.checked,
    }));
  } catch {
    // storage unavailable or full — non-critical
  }
}

loadCloneSettings();
