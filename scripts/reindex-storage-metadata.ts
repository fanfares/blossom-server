#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

import { S3Client } from "@bradenmacdonald/s3-lite-client";
import { contentType } from "@std/media-types";
import { loadConfig } from "../src/config/loader.ts";
import { initDb } from "../src/db/client.ts";
import { insertBlob } from "../src/db/blobs.ts";

type StorageObjectLike = {
  key?: unknown;
  name?: unknown;
  objectName?: unknown;
  size?: unknown;
  lastModified?: unknown;
  lastModifiedAt?: unknown;
};

function printHelp(): void {
  console.log(
    "Usage: deno run --allow-net --allow-read --allow-write --allow-env scripts/reindex-storage-metadata.ts [configPath] [--owner=<pubkey>] [--since=<unix>] [--limit=<n>] [--dry-run]",
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  deno run --allow-net --allow-read --allow-write --allow-env scripts/reindex-storage-metadata.ts config.cloudflare.yml --owner=recovered-r2",
  );
  console.log(
    "  deno run --allow-net --allow-read --allow-write --allow-env scripts/reindex-storage-metadata.ts config.cloudflare.yml --dry-run",
  );
}

function parseArgs(args: string[]): {
  configPath: string;
  owner: string;
  since?: number;
  limit?: number;
  dryRun: boolean;
} {
  let configPath = "config.yml";
  let owner = "recovered-r2";
  let since: number | undefined;
  let limit: number | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      printHelp();
      Deno.exit(0);
    }
    if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length);
      continue;
    }
    if (arg.startsWith("--since=")) {
      const value = Number(arg.slice("--since=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--since must be a non-negative unix timestamp");
      }
      since = Math.floor(value);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = Math.floor(value);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      configPath = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!owner.trim()) {
    throw new Error("--owner cannot be empty");
  }

  return { configPath, owner, since, limit, dryRun };
}

function readObjectKey(obj: StorageObjectLike): string | null {
  const candidate = obj.key ?? obj.name ?? obj.objectName;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function readObjectSize(obj: StorageObjectLike): number | null {
  const value = obj.size;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "bigint" && value >= 0n) {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function readUploadedTs(obj: StorageObjectLike): number {
  const raw = obj.lastModified ?? obj.lastModifiedAt;
  if (raw instanceof Date) {
    return Math.floor(raw.getTime() / 1000);
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function parseHashAndType(key: string): { sha256: string; mime: string | null } | null {
  const base = key.split("/").pop() ?? key;
  const match = /^([a-f0-9]{64})(?:\.([a-zA-Z0-9]+))?$/.exec(base);
  if (!match) return null;

  const sha256 = match[1];
  const ext = match[2]?.toLowerCase();
  const mime = ext ? (contentType(ext) ?? null) : null;
  return { sha256, mime };
}

async function main(): Promise<void> {
  const opts = parseArgs(Deno.args);
  const config = await loadConfig(opts.configPath);

  if (config.storage.backend !== "s3" && config.storage.backend !== "r2") {
    throw new Error(
      `storage.backend must be s3 or r2 for reindexing, got ${config.storage.backend}`,
    );
  }

  const db = await initDb(config.database);

  const storageCfg = config.storage.backend === "s3"
    ? {
      endpoint: config.storage.s3!.endpoint,
      bucket: config.storage.s3!.bucket,
      accessKey: config.storage.s3!.accessKey,
      secretKey: config.storage.s3!.secretKey,
      region: config.storage.s3!.region ?? "us-east-1",
    }
    : {
      endpoint: `https://${config.storage.r2!.accountId}.r2.cloudflarestorage.com`,
      bucket: config.storage.r2!.bucket,
      accessKey: config.storage.r2!.accessKey,
      secretKey: config.storage.r2!.secretKey,
      region: "auto",
    };

  const client = new S3Client({
    endPoint: storageCfg.endpoint,
    bucket: storageCfg.bucket,
    accessKey: storageCfg.accessKey,
    secretKey: storageCfg.secretKey,
    region: storageCfg.region,
    pathStyle: true,
  });

  const startedAt = Date.now();
  let seen = 0;
  let parsed = 0;
  let skipped = 0;
  let sizeMissing = 0;
  let inserted = 0;

  console.log(`Reindex start: backend=${config.storage.backend} bucket=${storageCfg.bucket}`);
  if (opts.dryRun) {
    console.log("Mode: dry-run (database writes disabled)");
  }

  for await (const raw of client.listObjects({ maxResults: 1000 })) {
    if (opts.limit !== undefined && seen >= opts.limit) break;
    seen += 1;

    const obj = raw as StorageObjectLike;
    const key = readObjectKey(obj);
    if (!key) {
      skipped += 1;
      continue;
    }

    const parsedKey = parseHashAndType(key);
    if (!parsedKey) {
      skipped += 1;
      continue;
    }

    const uploaded = readUploadedTs(obj);
    if (opts.since !== undefined && uploaded < opts.since) {
      skipped += 1;
      continue;
    }

    const size = readObjectSize(obj);
    if (size === null) {
      sizeMissing += 1;
      skipped += 1;
      continue;
    }

    parsed += 1;

    if (!opts.dryRun) {
      await insertBlob(
        db,
        {
          sha256: parsedKey.sha256,
          size,
          type: parsedKey.mime,
          uploaded,
        },
        opts.owner,
      );
    }

    inserted += 1;

    if (seen % 1000 === 0) {
      console.log(`Progress: seen=${seen} parsed=${parsed} inserted=${inserted} skipped=${skipped}`);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("Reindex done");
  console.log(`  seen=${seen}`);
  console.log(`  parsed=${parsed}`);
  console.log(`  inserted_or_touched=${inserted}`);
  console.log(`  skipped=${skipped}`);
  console.log(`  skipped_missing_size=${sizeMissing}`);
  console.log(`  elapsed_ms=${elapsedMs}`);
}

if (import.meta.main) {
  await main();
}
