import { useCallback, useEffect, useRef, useState } from "@hono/hono/jsx/dom";
import type { BlobDescriptor, FileStatus, UploadFile } from "./types.ts";
import { blobExists, HttpError, preflightUpload, xhrUpload } from "./api.ts";
import { hashBatch, MAX_X_TAGS_PER_EVENT, signBatch } from "./auth.ts";
import {
  createClientId,
  friendlyErrorMessage,
  isMediaFile,
} from "./helpers.ts";
import { FileRow } from "./FileRow.tsx";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const PREFLIGHT_CONCURRENCY = 10;

function isRetryable(status: number): boolean {
  return status === 429 || status === 503;
}

function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter) return retryAfter * 1000;
  return RETRY_BASE_MS * Math.pow(2, attempt);
}

export function UploadForm({
  requireAuth,
  mediaEnabled,
  mediaRequireAuth,
  onQueueChange,
}: {
  requireAuth: boolean;
  mediaEnabled: boolean;
  mediaRequireAuth: boolean;
  onQueueChange: (hasItems: boolean) => void;
}) {
  const [queue, setQueue] = useState<UploadFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [globalOptimize, setGlobalOptimize] = useState(false);
  const [concurrency, setConcurrency] = useState(3);
  const [lightningInvoice, setLightningInvoice] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [paymentNotice, setPaymentNotice] = useState("");
  const [paymentPhase, setPaymentPhase] = useState<
    "idle" | "invoice" | "verifying" | "verified"
  >("idle");
  const [pollSeq, setPollSeq] = useState(0);
  const pollInFlight = useRef(false);
  const activeCount = useRef<number>(0);
  const queueRef = useRef<UploadFile[]>([]);
  queueRef.current = queue;

  const isPaymentGateActive = Boolean(lightningInvoice && paymentId);

  useEffect(() => {
    onQueueChange(queue.length > 0);
  }, [queue.length, onQueueChange]);

  const patchFile = useCallback((id: string, patch: Partial<UploadFile>) => {
    setQueue((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const newItems: UploadFile[] = arr.map((file) => ({
        id: createClientId(),
        file,
        status: "pending" as FileStatus,
        progress: 0,
        optimize: globalOptimize && mediaEnabled && isMediaFile(file),
      }));
      setQueue((prev) => [...prev, ...newItems]);
    },
    [globalOptimize, mediaEnabled],
  );

  useEffect(() => {
    setQueue((prev) =>
      prev.map((f) =>
        f.status === "pending"
          ? {
            ...f,
            optimize: globalOptimize && mediaEnabled && isMediaFile(f.file),
          }
          : f
      )
    );
  }, [globalOptimize, mediaEnabled]);

  const removeFile = useCallback(
    (id: string) => setQueue((prev) => prev.filter((f) => f.id !== id)),
    [],
  );

  const clearDone = useCallback(() => {
    setQueue((prev) =>
      prev.filter((f) =>
        !["done", "exists", "skipped", "error"].includes(f.status)
      )
    );
  }, []);

  const copyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url).catch(() => {});
  }, []);

  const copyToClipboard = useCallback((value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragging(false), []);

  const handleInputChange = useCallback(
    (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (files?.length) {
        addFiles(files);
        (e.target as HTMLInputElement).value = "";
      }
    },
    [addFiles],
  );

  /** Run preflight HEAD check for a single file. */
  const checkOne = useCallback(
    async (
      uf: UploadFile,
      sha256: string,
      authHeader: string | undefined,
    ): Promise<boolean> => {
      const endpoint = uf.optimize ? "/media" : "/upload";
      if (!isPaymentGateActive) {
        patchFile(uf.id, { status: "checking" });
      }

      // Dedup check: HEAD /<sha256> tells us whether the server already has
      // this blob. /media optimizes the original, so the output hash is
      // unknown until processing — skip the dedup check there.
      if (!uf.optimize) {
        try {
          if (await blobExists(sha256)) {
            const blobUrl = `${location.origin}/${sha256}`;
            const syntheticResult: BlobDescriptor = {
              sha256,
              size: uf.file.size,
              type: uf.file.type || "application/octet-stream",
              url: blobUrl,
            };
            patchFile(uf.id, { status: "exists", result: syntheticResult });
            return false;
          }
        } catch {
          // Existence check failure shouldn't block the upload — fall through.
        }
      }

      try {
        const hadPaymentId = Boolean(paymentId);
        const pre = await preflightUpload(
          endpoint,
          sha256,
          uf.file.type || "application/octet-stream",
          uf.file.size,
          authHeader,
          paymentId || undefined,
        );

        if (pre.status === 402) {
          if (pre.xLightning) setLightningInvoice(pre.xLightning);
          if (pre.paymentId) setPaymentId(pre.paymentId);
          setPaymentNotice(pre.reason ?? "Waiting for payment verification");
          setPaymentPhase(hadPaymentId ? "verifying" : "invoice");

          patchFile(uf.id, {
            // Keep the file queued so the user can retry after payment.
            status: "pending",
            error: hadPaymentId
              ? "Waiting for payment verification..."
              : "Payment required. Pay the invoice below.",
          });
          return false;
        }

        if (pre.status === 200) {
          if (paymentId) {
            setPaymentPhase("verified");
            setPaymentNotice("Payment verified. Uploading now...");
          }
          return true;
        }

        patchFile(uf.id, {
          status: "skipped",
          error: friendlyErrorMessage(pre.status, pre.reason),
        });
        return false;
      } catch {
        return true;
      }
    },
    [patchFile, paymentId, isPaymentGateActive],
  );

  /** Upload a single file with auto-retry for 429/503. */
  const uploadOne = useCallback(
    async (uf: UploadFile, authHeader: string | undefined) => {
      const endpoint = uf.optimize ? "/media" : "/upload";
      const headers: Record<string, string> = {
        "Content-Type": uf.file.type || "application/octet-stream",
      };
      if (authHeader) headers["Authorization"] = authHeader;
      if (paymentId) headers["X-Payment-Id"] = paymentId;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          patchFile(uf.id, {
            status: attempt > 0 ? "retrying" : "uploading",
            progress: 0,
          });
          const { descriptor, status } = await xhrUpload(
            endpoint,
            uf.file,
            headers,
            (pct) => patchFile(uf.id, { progress: pct }),
          );
          patchFile(uf.id, {
            status: status === 200 ? "exists" : "done",
            progress: 100,
            result: descriptor,
          });
          return;
        } catch (err) {
          if (err instanceof HttpError && err.status === 402) {
            patchFile(uf.id, {
              status: "pending",
              error:
                "Payment still pending. Wait for invoice confirmation, then click Upload again.",
            });
            return;
          }

          if (
            err instanceof HttpError && isRetryable(err.status) &&
            attempt < MAX_RETRIES
          ) {
            patchFile(uf.id, { status: "retrying" });
            await new Promise<void>((res) =>
              setTimeout(res, retryDelay(attempt, err.retryAfter))
            );
            continue;
          }
          patchFile(uf.id, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    },
    [patchFile, paymentId],
  );

  const runQueue = useCallback(async () => {
    const currentQueue = queueRef.current;
    const pending = currentQueue?.filter((f) => f.status === "pending") ?? [];
    if (pending.length === 0) return;

    const needsAuth = pending.some((
      f,
    ) => (f.optimize ? mediaRequireAuth : requireAuth));

    if (!needsAuth) {
      const hashes = await hashBatch(
        pending,
        (id, status) => {
          if (
            isPaymentGateActive &&
            (status === "hashing" || status === "checking")
          ) {
            return;
          }
          patchFile(id, { status });
        },
      );

      // Phase 1: Preflight all files concurrently
      const toUpload: UploadFile[] = [];
      const preflightBatch = async (uf: UploadFile) => {
        const proceed = await checkOne(uf, hashes.get(uf.id)!, undefined);
        if (proceed) toUpload.push(uf);
      };
      for (let i = 0; i < pending.length; i += PREFLIGHT_CONCURRENCY) {
        await Promise.all(
          pending.slice(i, i + PREFLIGHT_CONCURRENCY).map(preflightBatch),
        );
      }

      // Phase 2: Upload files that passed preflight
      const uploadWithSlot = (uf: UploadFile) => {
        activeCount.current = (activeCount.current ?? 0) + 1;
        return uploadOne(uf, undefined).finally(() => {
          activeCount.current = (activeCount.current ?? 0) - 1;
        });
      };
      for (let i = 0; i < toUpload.length; i += concurrency) {
        await Promise.all(
          toUpload.slice(i, i + concurrency).map(uploadWithSlot),
        );
      }
      return;
    }

    // deno-lint-ignore no-explicit-any
    const nostr = (globalThis as any).nostr;
    if (!nostr) {
      for (const uf of pending) {
        patchFile(uf.id, {
          status: "error",
          error: "No Nostr extension detected. Install Alby or nos2x.",
        });
      }
      return;
    }

    const regularPending = pending.filter((f) => !f.optimize);
    const mediaPending = pending.filter((f) => f.optimize);

    for (
      const [group, verb, content] of [
        [regularPending, "upload", "Upload files"] as const,
        [mediaPending, "media", "Optimize and upload media"] as const,
      ]
    ) {
      if (group.length === 0) continue;

      const hashes = await hashBatch(
        group,
        (id, status) => {
          if (
            isPaymentGateActive &&
            (status === "hashing" || status === "checking" ||
              status === "signing")
          ) {
            return;
          }
          patchFile(id, { status });
        },
      );

      for (let i = 0; i < group.length; i += MAX_X_TAGS_PER_EVENT) {
        const batch = group.slice(i, i + MAX_X_TAGS_PER_EVENT);
        const batchHashes = batch.map((f) => hashes.get(f.id)!);

        if (!isPaymentGateActive) {
          for (const uf of batch) patchFile(uf.id, { status: "signing" });
        }

        let authHeader: string;
        try {
          authHeader = await signBatch(nostr, batchHashes, verb, content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          for (const uf of batch) {
            patchFile(uf.id, { status: "error", error: msg });
          }
          continue;
        }

        // Preflight with auth
        const toUpload: UploadFile[] = [];
        const preflightBatch = async (uf: UploadFile) => {
          const proceed = await checkOne(uf, hashes.get(uf.id)!, authHeader);
          if (proceed) toUpload.push(uf);
        };
        for (let j = 0; j < batch.length; j += PREFLIGHT_CONCURRENCY) {
          await Promise.all(
            batch.slice(j, j + PREFLIGHT_CONCURRENCY).map(preflightBatch),
          );
        }

        // Upload files that passed preflight
        const uploadWithSlot = async (uf: UploadFile) => {
          while ((activeCount.current ?? 0) >= concurrency) {
            await new Promise<void>((res) => setTimeout(res, 50));
          }
          activeCount.current = (activeCount.current ?? 0) + 1;
          try {
            await uploadOne(uf, authHeader);
          } finally {
            activeCount.current = (activeCount.current ?? 0) - 1;
          }
        };

        await Promise.all(toUpload.map(uploadWithSlot));
      }
    }
  }, [
    requireAuth,
    mediaRequireAuth,
    concurrency,
    patchFile,
    uploadOne,
    checkOne,
    isPaymentGateActive,
  ]);

  const handleUpload = useCallback(() => runQueue(), [runQueue]);

  const TERMINAL_STATUSES: FileStatus[] = [
    "done",
    "exists",
    "skipped",
    "error",
  ];
  const WORKING_STATUSES: FileStatus[] = [
    "hashing",
    "checking",
    "signing",
    "uploading",
    "retrying",
  ];

  const isWorking = queue.some((f) => WORKING_STATUSES.includes(f.status));
  const hasDoneOrError = queue.some((f) =>
    TERMINAL_STATUSES.includes(f.status)
  );
  const hasPending = queue.some((f) => f.status === "pending");
  const showOptimizeToggle = mediaEnabled &&
    queue.some((f) => isMediaFile(f.file));
  const allDone = queue.length > 0 &&
    queue.every((f) => TERMINAL_STATUSES.includes(f.status));
  const canUpload = hasPending && !isWorking;

  // Self-rescheduling payment verification poll.
  // After each attempt (paid or not), pollSeq increments which re-triggers this
  // effect and schedules the next 2.5 s window. Stops when paymentId is cleared.
  useEffect(() => {
    if (!paymentId || !lightningInvoice) return;
    if (!hasPending) return;
    if (pollInFlight.current) return;

    const delay = pollSeq === 0 ? 500 : 2500;
    const timer = setTimeout(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      setPaymentPhase("verifying");
      setPaymentNotice("Verifying payment...");
      try {
        await runQueue();
      } catch {
        // ignore
      } finally {
        pollInFlight.current = false;
        setPollSeq((n) => n + 1);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [paymentId, lightningInvoice, hasPending, runQueue, pollSeq]);

  const clearPaymentState = useCallback(() => {
    setPaymentId("");
    setLightningInvoice("");
    setPaymentNotice("");
    setPaymentPhase("idle");
    setPollSeq(0);
    pollInFlight.current = false;
  }, []);

  useEffect(() => {
    if (queue.length === 0) {
      clearPaymentState();
      return;
    }

    const hasPendingNow = queue.some((f) => f.status === "pending");
    const hasWorkingNow = queue.some((f) =>
      WORKING_STATUSES.includes(f.status)
    );
    if (!hasPendingNow && !hasWorkingNow && paymentPhase === "verified") {
      clearPaymentState();
    }
  }, [queue, paymentPhase, clearPaymentState]);

  const successUrls = queue
    .filter((f) => (f.status === "done" || f.status === "exists") && f.result)
    .map((f) => f.result!.url);

  const copyAllUrls = useCallback(() => {
    navigator.clipboard.writeText(successUrls.join("\n")).catch(() => {});
  }, [successUrls]);

  const doneCount = queue.filter((f) => f.status === "done").length;
  const existsCount = queue.filter((f) => f.status === "exists").length;
  const skippedCount = queue.filter((f) => f.status === "skipped").length;
  const errorCount = queue.filter((f) => f.status === "error").length;

  return (
    <div class="p-6 space-y-4">
      {queue.length > 0 && (
        <div class="flex flex-wrap items-center gap-4">
          <label class="flex items-center gap-2 text-sm text-gray-400">
            <span>Concurrent uploads</span>
            <input
              type="number"
              min="1"
              max="10"
              value={concurrency}
              disabled={isWorking}
              class="w-14 bg-gray-800 border border-gray-700 text-white rounded px-2 py-1 text-sm text-center disabled:opacity-50"
              onChange={(e) => {
                const v = parseInt((e.target as HTMLInputElement).value, 10);
                if (v >= 1 && v <= 10) setConcurrency(v);
              }}
            />
          </label>
          {showOptimizeToggle && (
            <label class="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-400">
              <input
                type="checkbox"
                class="w-4 h-4 rounded accent-blue-500"
                checked={globalOptimize}
                disabled={isWorking}
                onChange={(e) =>
                  setGlobalOptimize((e.target as HTMLInputElement).checked)}
              />
              <span>
                Optimize media
                <span class="ml-1 text-gray-500 text-xs">(via /media)</span>
              </span>
            </label>
          )}
          {hasDoneOrError && !isWorking && (
            <button
              type="button"
              class="ml-auto text-xs text-gray-500 hover:text-gray-300 underline"
              onClick={clearDone}
            >
              Clear finished
            </button>
          )}
        </div>
      )}

      <label
        class={`block border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-950"
            : "border-gray-700 hover:border-gray-500"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          multiple
          class="sr-only"
          onChange={handleInputChange}
        />
        {queue.length > 0
          ? <p class="text-sm text-gray-400">Drop more files or click to add</p>
          : (
            <div class="space-y-2">
              <p class="text-gray-300">Drop files here or click to select</p>
              <p class="text-xs text-gray-500">
                {requireAuth
                  ? "Nostr extension required to sign uploads"
                  : "No auth required"}
              </p>
            </div>
          )}
      </label>

      {queue.length > 0 && (
        <div class="space-y-2">
          {lightningInvoice && (
            <div class="rounded-3xl border border-cyan-400/20 bg-white/[0.03] p-6 space-y-4 shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_18px_48px_rgba(0,0,0,0.45)]">
              <p class="text-sm text-cyan-100 font-semibold tracking-wide">
                Payment required before upload
              </p>
              <div
                class="rounded-2xl bg-black/40 border border-white/10 p-4 flex flex-col items-center gap-3 cursor-pointer group"
                onClick={() => copyToClipboard(lightningInvoice)}
                title="Click to copy invoice"
              >
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=340x340&margin=8&data=${
                    encodeURIComponent(`lightning:${lightningInvoice}`)
                  }`}
                  alt="Lightning invoice QR"
                  class="w-72 h-72 max-w-full rounded-2xl bg-white p-3"
                />
                <p class="text-xs text-gray-400 group-hover:text-cyan-300 transition-colors">
                  Scan to pay · click to copy invoice
                </p>
              </div>
              <div class="text-xs text-cyan-100 rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3 py-2">
                {paymentNotice || "Waiting for payment verification..."}
                {paymentPhase === "verifying" && (
                  <span class="ml-2 inline-flex items-center gap-2">
                    <span class="h-2 w-2 rounded-full bg-cyan-300 animate-pulse" />
                    Verifying payment
                  </span>
                )}
              </div>
            </div>
          )}
          {queue.map((uf) => (
            <FileRow
              key={uf.id}
              uf={uf}
              onRemove={removeFile}
              onCopy={copyUrl}
            />
          ))}
        </div>
      )}

      {queue.length > 0 && (
        <button
          type="button"
          class={`w-full py-3 rounded-xl font-semibold transition-colors ${
            canUpload
              ? "bg-blue-600 hover:bg-blue-500 text-white cursor-pointer"
              : "bg-gray-800 text-gray-500 cursor-not-allowed"
          }`}
          onClick={handleUpload}
          disabled={!canUpload}
        >
          {isWorking
            ? "Uploading\u2026"
            : canUpload
            ? `Upload ${
              queue.filter((f) => f.status === "pending").length
            } file${
              queue.filter((f) => f.status === "pending").length === 1
                ? ""
                : "s"
            }`
            : allDone
            ? "All done"
            : "Upload"}
        </button>
      )}

      {allDone && (
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm text-gray-500">
            {[
              doneCount > 0 && `${doneCount} uploaded`,
              existsCount > 0 && `${existsCount} already existed`,
              skippedCount > 0 && `${skippedCount} skipped`,
              errorCount > 0 && `${errorCount} failed`,
            ]
              .filter(Boolean)
              .join(" \u00b7 ")}
          </p>
          {successUrls.length > 0 && (
            <button
              type="button"
              class="shrink-0 text-sm bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1.5 rounded-lg border border-gray-700"
              onClick={copyAllUrls}
            >
              Copy all URLs
            </button>
          )}
        </div>
      )}
    </div>
  );
}
