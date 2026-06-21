"use strict";

const fs = require("fs/promises");
const path = require("path");
const { assetUrlToLocalPath } = require("./urlUtils");

/**
 * AssetStore tracks every remote asset URL we've decided to download,
 * de-duplicates across pages (so shared CSS/JS/images are only fetched once),
 * and writes files to disk under outDir.
 */
class AssetStore {
  constructor(outDir, { maxAssetBytes = 15 * 1024 * 1024 } = {}) {
    this.outDir = outDir;
    this.maxAssetBytes = maxAssetBytes;
    this.urlToLocalPath = new Map(); // remoteUrl -> local relative path
    this.inFlight = new Map(); // remoteUrl -> Promise
  }

  /**
   * Ensure an asset is downloaded, returning its local relative path
   * (e.g. "assets/css/example.com/style.css"). Safe to call concurrently
   * for the same URL; will only fetch once.
   */
  async ensure(assetUrl, kind, request) {
    if (this.urlToLocalPath.has(assetUrl)) {
      return this.urlToLocalPath.get(assetUrl);
    }
    if (this.inFlight.has(assetUrl)) {
      return this.inFlight.get(assetUrl);
    }

    const promise = this._download(assetUrl, kind, request)
      .then((localPath) => {
        this.urlToLocalPath.set(assetUrl, localPath);
        this.inFlight.delete(assetUrl);
        return localPath;
      })
      .catch((err) => {
        this.inFlight.delete(assetUrl);
        // Don't crash the whole crawl over one bad asset; log and skip.
        console.warn(`[asset] failed: ${assetUrl} (${err.message})`);
        return null;
      });

    this.inFlight.set(assetUrl, promise);
    return promise;
  }

  async _download(assetUrl, kind, request) {
    const localRelPath = assetUrlToLocalPath(assetUrl, kind);
    const fullPath = path.join(this.outDir, localRelPath);

    const res = await request(assetUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > this.maxAssetBytes) {
      throw new Error(`asset too large (${buf.byteLength} bytes)`);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, Buffer.from(buf));

    return localRelPath;
  }

  get count() {
    return this.urlToLocalPath.size;
  }
}

module.exports = { AssetStore };
