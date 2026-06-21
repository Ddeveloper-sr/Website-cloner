# Site Cloner (browser-only, v2)

Clones a site's rendered design — HTML, CSS (including animations), images, fonts, scripts — into a downloadable zip, entirely from a browser tab. No backend, no install, no build step. Runs as-is in Spck Editor's static preview or any browser.
[Support Server](https://discord.gg/jJwrnJAEu9)

Three modes:
- **Clone** — full site crawl, optionally seeded from `sitemap.xml`, with link-following up to a configurable page/depth limit.
- **Component** — extract one element (by CSS selector) from a page, with its styles and assets, as an isolated snippet.
- **Compare** — clone two sites back to back and get a side-by-side size/page/asset summary.

## Running it

Open `index.html` in a browser, or load the project folder in Spck Editor and preview `index.html`. That's it — everything is plain ES modules loaded via `<script type="module">`, no bundler needed.

```
site-cloner-v2/
  index.html          UI shell, all three mode panels, shared progress/log panel
  js/
    main.js            Wires UI to the modules below, tab switching, settings persistence
    crawler.js          Clone-mode orchestrator: BFS queue, sitemap seeding, delay/backoff
    pageCloner.js        Per-page logic: fetch, parse, rewrite every asset reference
    componentMode.js     Component-extraction mode
    compareMode.js        Two-site comparison mode
    sitemap.js             sitemap.xml / sitemap index discovery and parsing
    navCheck.js              Flags <nav> links pointing outside the cloned page set
    preview.js                Builds an in-memory, self-contained preview before download
    assetDownloader.js         Download orchestration: dedup, size caps, naming
    naming.js                   Extension detection (Content-Type > byte-sniff > URL > fallback)
    cssRewriter.js                url()/@import/srcset parsing and rewriting
    proxy.js                       CORS proxy list, fetch+retry, rate-limit detection, reachability test
    urlUtils.js                     Normalization, same-origin link extraction, JS-render heuristic
```

## How cloning works

A CORS proxy is required because browsers block raw cross-origin `fetch()` — three public proxies are offered in the dropdown, plus a "Test" button that pings one to confirm it's alive before committing to a full crawl. The crawler fetches the target's raw HTML response (it does not execute the page's JavaScript — there's no real browser engine here, just `fetch` + `DOMParser`), finds every asset reference (`img`, `srcset`, `picture`/`source`, lazy-load `data-src` attributes, inline SVG `<use>` sprite refs, CSS `url()`/`@import`, favicons), downloads each one, and rewrites the references to local relative paths before saving.

**Sitemap mode**: checks `robots.txt` for a `Sitemap:` directive, falls back to `/sitemap.xml`, and follows one level of sitemap-index nesting if the site splits its sitemap into multiple files. Sitemap URLs are usually more complete than `<a>`-tag link-following, especially on sites with JS-driven navigation menus a plain HTML parse can't see.

**Nav check**: after a crawl finishes, every cloned page's `<nav>`/`[role=navigation]` elements are checked for same-origin links pointing at pages that weren't part of this crawl — those become dead ends once the zip is offline. Reported in the log and in `manifest.json`.

**Naming**: asset filenames are decided from the response's `Content-Type` header first; if that's missing or unreliable (some free CORS proxies strip headers on binary responses), the actual downloaded bytes are checked against known file signatures (PNG/JPEG/GIF/WebP/ICO/SVG/WOFF/WOFF2/TTF); only if both fail does it fall back to the URL's own extension or a generic one. Two different source URLs that would otherwise produce the same filename in the same folder get a `-2`, `-3` suffix instead of overwriting each other.

## Limits

- 60 assets and 80MB total per clone (compare mode applies this per site). Individual files over 8MB are skipped.
- Max pages: 25 (clone mode), 10 per side (compare mode, since it runs two crawls).
- A 350ms pause between page fetches, increasing to 3s automatically if the proxy returns HTTP 429.

## What won't work

**JavaScript-rendered content.** This tool fetches raw HTML and parses it — it does not run a browser engine, so it cannot execute the page's JavaScript. React/Vue/Next.js/Svelte sites that build their real content client-side will often come back as a near-empty HTML shell. The tool detects this heuristically (checking for `#root`/`#app`/`#__next` mount points with very little markup) and logs a warning, but cannot fix it — doing so would require a real headless browser (Playwright/Puppeteer), which needs a Node server behind it. A backend-based version of this tool exists with that capability but cannot run inside Spck Editor or any other browser-only environment, since those have no server process at all.

**Login-gated, paywalled, or anti-bot-protected content.** No session/auth handling exists, and sites with bot detection will simply block the proxy's requests.

**Backend logic of any kind.** This clones what a browser receives over HTTP — markup, styles, scripts, media. It cannot clone server-side code, databases, or APIs, because that code never leaves the origin server in the first place; there's nothing to extract.

## Files produced

**Clone mode**: `index.html` (browsable summary linking every page), `manifest.json` (machine-readable summary including nav-check results), `pages/*.html`, `assets/{css,js,img,font}/<host>/...`.

**Component mode**: `component.html` (standalone preview with inlined styles), `component-fragment.html` (just the element's HTML), `component-styles.css` (every stylesheet active on the source page — component styles usually depend on shared resets/custom properties, so this errs toward including more rather than guessing which ones matter), `manifest.json`.

**Compare mode**: `comparison.html` and `comparison.json` at the root, full clones of each site under `site-a/` and `site-b/`.

## Testing notes

This was built and tested in a sandboxed environment with no outbound network access, so live crawling against a real site couldn't be exercised end-to-end here. What was verified directly: every module passes `node --check` (syntax-valid), every cross-module `import` resolves to a real `export` (checked programmatically, not just by eye), and the pure logic that doesn't depend on browser-only APIs (`fetch`, `DOMParser`, `Blob`) — URL normalization, CSS `url()`/`@import` extraction, asset path naming and collision handling, byte-signature sniffing — was unit-tested directly with representative inputs. Code paths that require `DOMParser` (sitemap XML parsing, nav-link extraction, page parsing) could not be executed in this environment and should be treated as logically reviewed but not runtime-verified until tried against a real site in an actual browser.
