import { extFromContentType, sniffExtFromBytes, localAssetPath, PathDeduper } from './naming.js';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024; // overall cap, prevents in-memory zip generation from crashing a phone tab

// AssetDownloader owns: per-URL dedup (so shared assets aren't fetched
// twice), the running asset count / total byte budget, and final filename
// resolution. One instance per clone run.
export class AssetDownloader {
  constructor(zip, fetcher, log) {
    this.zip = zip;
    this.fetcher = fetcher;
    this.log = log || (() => {});
    this.seen = new Map(); // absoluteUrl -> finalPath
    this.deduper = new PathDeduper();
    this.assetCount = 0;
    this.totalBytes = 0;
    this.totalBytesCapLogged = false;
    this.maxAssets = 60;
  }

  async download(absoluteUrl, kind) {
    if (this.seen.has(absoluteUrl)) return this.seen.get(absoluteUrl);
    if (this.assetCount >= this.maxAssets) return null;
    if (this.totalBytes >= MAX_TOTAL_BYTES) {
      if (!this.totalBytesCapLogged) {
        this.log('Reached total size cap (' + Math.round(MAX_TOTAL_BYTES / 1024 / 1024) + 'MB) — remaining assets skipped to avoid an oversized zip.', 'warn');
        this.totalBytesCapLogged = true;
      }
      return null;
    }

    try {
      const res = await this.fetcher.fetch(absoluteUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const contentType = res.headers.get('content-type');
      let ext = extFromContentType(contentType);

      const blob = await res.blob();
      if (blob.size > MAX_ASSET_BYTES) throw new Error('too large (' + Math.round(blob.size / 1024) + 'KB)');
      if (this.totalBytes + blob.size > MAX_TOTAL_BYTES) {
        throw new Error('would exceed total size cap — skipped');
      }

      const urlHasExt = /\.[a-zA-Z0-9]{1,5}(\?|$)/.test(absoluteUrl);
      if (!ext && !urlHasExt) {
        ext = await sniffExtFromBytes(blob);
        if (ext) this.log('Identified file type from content (' + ext + '): ' + absoluteUrl, 'ok');
      }

      const { dir, name } = localAssetPath(absoluteUrl, kind, ext);
      const finalPath = this.deduper.dedupe(dir, name);
      this.seen.set(absoluteUrl, finalPath);

      this.zip.file(finalPath, blob);
      this.assetCount++;
      this.totalBytes += blob.size;
      this.log('Saved ' + kind + ': ' + finalPath + ' (' + Math.round(blob.size / 1024) + 'KB)', 'ok');
      return finalPath;
    } catch (err) {
      this.log('Failed ' + kind + ' (' + absoluteUrl + '): ' + err.message, 'warn');
      return null;
    }
  }
}
