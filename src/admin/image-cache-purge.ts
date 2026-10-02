import type { Client } from "@libsql/client";
import type { Config } from "../config/schema.ts";

/** Only this deployment's canonical Blossom hosts can be submitted to Vercel. */
export function imagePurgeSources(
  hash: string,
  config: Config,
  observed: string[],
): string[] {
  if (!/^[a-f0-9]{64}$/.test(hash)) return [];
  const hosts = [config.publicDomain, config.blobDomain].filter(Boolean);
  const allowed = new Set(hosts);
  const sources = new Set<string>();
  for (const host of hosts) {
    for (
      const ext of [
        "",
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".gif",
        ".avif",
        ".svg",
        ".bmp",
        ".ico",
      ]
    ) {
      const source = `https://${host}/${hash}${ext}`;
      sources.add(source);
      sources.add(`${source}?ff-blossom-read=1`);
    }
  }
  for (const source of observed) {
    try {
      const url = new URL(source);
      if (
        ["https:", "http:"].includes(url.protocol) && !url.username &&
        !url.password &&
        allowed.has(url.host) &&
        new RegExp(`^/${hash}(?:\\.[A-Za-z0-9]+)?$`).test(url.pathname)
      ) {
        url.hash = "";
        sources.add(url.toString());
      }
    } catch { /* Ignore malformed indexed event URLs. */ }
  }
  return [...sources];
}

/** Single-instance background outbox: bounded work, durable retries, no request-path provider calls. */
export async function processImageCachePurges(
  db: Client,
  config: Config,
  request: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const settings = config.dashboard.imageCachePurge;
  if (!settings?.enabled) return;
  const jobs = await db.execute({
    sql:
      "SELECT sha256, generation, attempts FROM image_cache_purge WHERE state='pending' AND next_attempt<=? ORDER BY next_attempt, sha256 LIMIT 3",
    args: [now],
  });
  for (const job of jobs.rows) {
    const hash = String(job.sha256);
    const observed = await db.execute({
      sql:
        "SELECT source FROM blossom_image_sources WHERE sha256=? ORDER BY source LIMIT 2000",
      args: [hash],
    });
    const sources = imagePurgeSources(
      hash,
      config,
      observed.rows.map((row) => String(row.source)),
    );
    let error = "";
    try {
      if (!sources.length || observed.rows.length >= 2000) {
        throw new Error("Source coverage needs review");
      }
      const endpoint = new URL(
        "https://api.vercel.com/v1/edge-cache/dangerously-delete-by-src-images",
      );
      endpoint.searchParams.set("projectIdOrName", settings.project);
      if (settings.teamId) endpoint.searchParams.set("teamId", settings.teamId);
      for (let i = 0; i < sources.length; i += 50) {
        const response = await request(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${settings.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ srcImages: sources.slice(i, i + 50) }),
          signal: AbortSignal.timeout(10_000),
        });
        await response.body?.cancel();
        if (response.status !== 200) {
          throw new Error(`Vercel returned HTTP ${response.status}`);
        }
      }
    } catch (cause) {
      // Never persist provider response bodies or fetch exception messages: they may contain secrets.
      error = cause instanceof Error &&
          /^(Vercel returned HTTP \d{3}|Source coverage needs review)$/.test(
            cause.message,
          )
        ? cause.message
        : "Vercel purge request failed";
    }
    const attempts = Number(job.attempts) + 1;
    await db.execute({
      sql:
        "UPDATE image_cache_purge SET state=?, attempts=?, next_attempt=?, last_error=?, completed_at=? WHERE sha256=? AND generation=?",
      args: [
        error ? "pending" : "completed",
        attempts,
        error ? now + Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7)) : 0,
        error,
        error ? null : now,
        hash,
        Number(job.generation),
      ],
    });
  }
}

/** The status describes submitted known sources, never universal cache removal. */
export async function imageCachePurgeStatus(
  db: Client,
  hash: string,
  config: Config,
): Promise<string> {
  const result = await db.execute({
    sql: "SELECT state, last_error FROM image_cache_purge WHERE sha256=?",
    args: [hash],
  });
  const row = result.rows[0];
  if (!row) return "";
  if (!config.dashboard.imageCachePurge?.enabled) {
    return "Image cache purge queued · Vercel integration not configured";
  }
  if (row.state === "completed") {
    return "Vercel deletion accepted for known Blossom image URLs";
  }
  return row.last_error
    ? `Image cache purge pending retry · ${String(row.last_error)}`
    : "Image cache purge queued";
}
