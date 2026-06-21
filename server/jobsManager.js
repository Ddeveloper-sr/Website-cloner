"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const { nanoid } = require("nanoid");
const { runCloneJob } = require("./crawler");

const DATA_ROOT = path.join(__dirname, "..", "..", "data");
const JOBS_DIR = path.join(DATA_ROOT, "jobs");
const ZIPS_DIR = path.join(DATA_ROOT, "zips");

// jobId -> job state object
const jobs = new Map();

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(ZIPS_DIR, { recursive: true });
}

function createJob(targetUrl, options) {
  const id = nanoid(10);
  const job = {
    id,
    targetUrl,
    options,
    status: "queued", // queued -> running -> packaging -> done -> error
    log: [],
    progress: { visited: 0, total: 1, assets: 0 },
    outDir: path.join(JOBS_DIR, id),
    zipPath: path.join(ZIPS_DIR, `${id}.zip`),
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

async function startJob(job) {
  try {
    await ensureDirs();
    await runCloneJob(job, job.targetUrl, job.options);
    await zipDirectory(job.outDir, job.zipPath);
    job.status = "done";
    job.log.push("Done. Zip ready for download.");
  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.log.push(`Fatal error: ${err.message}`);
  }
}

function zipDirectory(sourceDir, outZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Periodically clean up old jobs (data + zip) to avoid unbounded disk usage.
 * Call this on an interval from the server entrypoint.
 */
async function cleanupOldJobs(maxAgeMs = 1000 * 60 * 60 * 2) {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > maxAgeMs) {
      await fsp.rm(job.outDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(job.zipPath, { force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}

module.exports = { createJob, getJob, startJob, cleanupOldJobs, ZIPS_DIR };
