/// <reference lib="deno.worker" />
/**
 * Upload Worker — runs in a dedicated Deno Worker (separate V8 isolate).
 *
 * Owns a single backpressured stream → write + incremental SHA-256 pass.
 * Byte limits and stalled-body deadlines are enforced while consuming bytes.
 *
 * DB connection is set up at init depending on the mode sent by the pool:
 *
 *   dbMode: "local"  — receives a MessagePort (DbProxy over MessageChannel).
 *                      Main thread holds the real Client; this worker proxies
 *                      through it. Required because SQLite file handles cannot
 *                      cross V8 isolate boundaries.
 *
 *   dbMode: "remote" — receives dbUrl + dbAuthToken and constructs its own
 *                      DirectDbHandle wrapping a real libSQL Client. No
 *                      MessageChannel overhead — each worker talks to the
 *                      remote DB server directly.
 *
 * Worker code below the init handler is identical in both modes: it only
 * ever calls methods on IDbHandle and never inspects which implementation
 * is underneath.
 *
 * Throughput reporting:
 *   The worker accumulates bytes written across ALL concurrent jobs and posts
 *   a { type: "throughput", bytesPerSec } message to the pool once per
 *   throughputWindowMs. The pool uses this to route new jobs to the worker
 *   currently handling the least I/O load.
 *
 * Message protocol:
 *   IN  (once at init, local):  { type: "init", dbMode: "local", dbPort: MessagePort, throughputWindowMs: number }
 *   IN  (once at init, remote): { type: "init", dbMode: "remote", dbUrl: string, dbAuthToken?: string, throughputWindowMs: number }
 *   IN  (per upload):           { type: "job", id, stream, tmpPath, sizeHint, xSha256 }
 *   OUT (per upload):           { id, hash, size }   on success
 *                               { id, error }         on failure
 *   OUT (every throughputWindowMs): { type: "throughput", bytesPerSec: number }
 */

import { writeAndHash } from "../utils/upload-pipeline.ts";
import { DbProxy } from "../db/proxy.ts";
import { DirectDbHandle } from "../db/direct.ts";
import { createClient } from "@libsql/client";
import type { IDbHandle } from "../db/handle.ts";

// ---------------------------------------------------------------------------
// Worker state (persists across jobs)
// ---------------------------------------------------------------------------

// deno-lint-ignore no-unused-vars -- assigned at init for future job-side DB access
let db: IDbHandle | null = null;

// Aggregate byte counter across all concurrent jobs on this worker.
// Reset every throughputWindowMs by the heartbeat interval.
let _bytesThisWindow = 0;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface InitMessageLocal {
  type: "init";
  dbMode: "local";
  dbPort: MessagePort;
  throughputWindowMs: number;
}

interface InitMessageRemote {
  type: "init";
  dbMode: "remote";
  dbUrl: string;
  dbAuthToken?: string;
  throughputWindowMs: number;
}

type InitMessage = InitMessageLocal | InitMessageRemote;

interface JobMessage {
  type: "job";
  id: string;
  stream: ReadableStream<Uint8Array>;
  tmpPath: string;
  sizeHint: number | null;
  xSha256: string | null;
  maxBytes: number;
}

interface JobSuccess {
  id: string;
  hash: string;
  size: number;
}

/** Discriminated error types for status code mapping on the main thread. */
type WorkerErrorType = "HASH_MISMATCH" | "WRITE_ERROR" | "UNKNOWN";

interface JobError {
  id: string;
  error: string;
  errorType: WorkerErrorType;
}

interface ThroughputReport {
  type: "throughput";
  bytesPerSec: number;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

self.onmessage = async (event: MessageEvent<InitMessage | JobMessage>) => {
  const msg = event.data;
  if (msg.type === "init") {
    if (msg.dbMode === "local") {
      // SQLite: proxy all DB calls through the main thread via MessageChannel
      db = new DbProxy(msg.dbPort);
    } else {
      // Remote libSQL: open a direct connection inside this isolate
      const client = createClient({
        url: msg.dbUrl,
        authToken: msg.dbAuthToken,
      });
      db = new DirectDbHandle(client);
    }

    // Start the throughput heartbeat. Fires once per window regardless of how
    // many jobs are active — aggregate load, not per-job reporting.
    const windowMs = msg.throughputWindowMs;
    setInterval(() => {
      const bytesPerSec = Math.round(_bytesThisWindow * (1_000 / windowMs));
      _bytesThisWindow = 0;
      self.postMessage(
        { type: "throughput", bytesPerSec } satisfies ThroughputReport,
      );
    }, windowMs);

    return;
  }
  if (msg.type === "job") {
    await handleJob(msg);
  }
};

// ---------------------------------------------------------------------------
// Upload pipeline — bounded single-pass hash and write
// ---------------------------------------------------------------------------

async function handleJob(msg: JobMessage): Promise<void> {
  const { id, stream, tmpPath, xSha256 } = msg;

  try {
    const { hash, size: totalSize } = await writeAndHash(
      stream,
      tmpPath,
      msg.sizeHint,
      msg.maxBytes,
      60_000,
      3_600_000,
      (bytes) => {
        _bytesThisWindow += bytes;
      },
    );

    // Verify against declared hash if provided
    if (xSha256 !== null && hash !== xSha256) {
      await Deno.remove(tmpPath).catch(() => {});
      self.postMessage(
        {
          id,
          error: `Hash mismatch: declared ${xSha256}, computed ${hash}`,
          errorType: "HASH_MISMATCH",
        } satisfies JobError,
      );
      return;
    }

    self.postMessage({ id, hash, size: totalSize } satisfies JobSuccess);
  } catch (err) {
    await Deno.remove(tmpPath).catch(() => {});
    self.postMessage(
      {
        id,
        error: err instanceof Error ? err.message : String(err),
        errorType: "UNKNOWN",
      } satisfies JobError,
    );
  }
}
