// bench-blob-1mb.js
// 1MB blob write + read round-trip via the object store.
// No specific budget called out in the spec; we record the timing for
// regression visibility and apply a generous default so spikes are caught.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ObjectStore } from "@agentgit/core";

export const NAME = "blob-1mb";
export const BUDGET_MS = 200;

const BLOB_BYTES = 1024 * 1024; // 1 MiB

let setupDir = null;
let payload = null;
let store = null;

export async function setup() {
  setupDir = join(tmpdir(), `agentgit-bench-blob-${process.pid}-${Date.now()}`);
  mkdirSync(setupDir, { recursive: true });
  store = new ObjectStore(setupDir);
  // Pseudo-random content keeps each run from hitting a fully-deduplicated path.
  const buf = Buffer.alloc(BLOB_BYTES);
  for (let i = 0; i < BLOB_BYTES; i++) buf[i] = (i * 1103515245 + 12345) & 0xff;
  payload = buf.toString("base64");
}

export async function run() {
  const t0 = performance.now();
  const hash = store.write({
    type: "blob",
    content: payload,
    size: BLOB_BYTES,
    encoding: "base64",
    mimeType: null,
  });
  const body = store.read(hash);
  const elapsed = performance.now() - t0;
  if (body.size !== BLOB_BYTES) {
    throw new Error(`round-trip mismatch: size=${body.size}`);
  }
  return elapsed;
}

export async function teardown() {
  if (setupDir !== null) {
    rmSync(setupDir, { recursive: true, force: true });
    setupDir = null;
  }
  store = null;
  payload = null;
}
