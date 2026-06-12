import { Container } from "@cloudflare/containers";

const HEX_64_RE = /^[a-f0-9]{64}$/;
const DEPLOY_PROBE = "cd-check-2026-06-12-b";

type Env = {
  CF_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  BLOSSOM_R2: R2Bucket;
  blossom_metadata: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  BLOSSOM_PUBLIC_DOMAIN?: string;
  BLOSSOM_ADMIN_PASSWORD?: string;
  BLOSSOM_APP: DurableObjectNamespace<BlossomAppContainer>;
};

interface BlobDescriptor {
  sha256: string;
  size: number;
  type: string | null;
  uploaded: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function extToMime(ext: string | null): string | null {
  if (!ext) return null;
  const map: Record<string, string> = {
    txt: "text/plain",
    json: "application/json",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    pdf: "application/pdf",
  };
  return map[ext.toLowerCase()] ?? null;
}

function parseBlobPath(
  pathname: string,
): { hash: string; ext: string | null } | null {
  const m = pathname.match(/^\/([a-f0-9]{64})(?:\.([A-Za-z0-9]+))?$/);
  if (!m) return null;
  return { hash: m[1], ext: m[2] ?? null };
}

function parsePubkeyFromAuth(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith("Nostr ")) return null;
  try {
    const payload = authHeader.slice("Nostr ".length).trim();
    const raw = atob(payload);
    const evt = JSON.parse(raw) as { pubkey?: string };
    const pubkey = evt.pubkey?.toLowerCase();
    return pubkey && HEX_64_RE.test(pubkey) ? pubkey : null;
  } catch {
    return null;
  }
}

async function d1One(
  db: D1Database,
  sql: string,
  args: Array<string | number> = [],
): Promise<Record<string, unknown> | null> {
  const result = await db.prepare(sql).bind(...args).all<
    Record<string, unknown>
  >();
  return result.results[0] ?? null;
}

async function d1All(
  db: D1Database,
  sql: string,
  args: Array<string | number> = [],
): Promise<Record<string, unknown>[]> {
  const result = await db.prepare(sql).bind(...args).all<
    Record<string, unknown>
  >();
  return result.results;
}

function parseIntParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function upsertDescriptor(
  env: Env,
  descriptor: BlobDescriptor,
  owner: string,
): Promise<void> {
  const db = env.blossom_metadata;
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO blobs (sha256, size, type, uploaded) VALUES (?, ?, ?, ?)",
    ).bind(
      descriptor.sha256,
      descriptor.size,
      descriptor.type,
      descriptor.uploaded,
    ),
    db.prepare("INSERT OR IGNORE INTO owners (blob, pubkey) VALUES (?, ?)")
      .bind(
        descriptor.sha256,
        owner,
      ),
    db.prepare(
      "INSERT OR REPLACE INTO accessed (blob, timestamp) VALUES (?, ?)",
    ).bind(
      descriptor.sha256,
      descriptor.uploaded,
    ),
  ]);
}

async function touchAccess(
  env: Env,
  hash: string,
  timestamp: number,
): Promise<void> {
  await env.blossom_metadata
    .prepare("INSERT OR REPLACE INTO accessed (blob, timestamp) VALUES (?, ?)")
    .bind(hash, timestamp)
    .run();
}

async function removeOwnerOrBlob(
  env: Env,
  hash: string,
  owner: string,
): Promise<void> {
  const db = env.blossom_metadata;
  await db.prepare("DELETE FROM owners WHERE blob = ? AND pubkey = ?").bind(
    hash,
    owner,
  ).run();
  const row = await d1One(
    db,
    "SELECT COUNT(*) AS c FROM owners WHERE blob = ?",
    [hash],
  );
  const count = Number(row?.c ?? 0);
  if (count === 0) {
    await db.prepare("DELETE FROM blobs WHERE sha256 = ?").bind(hash).run();
  }
}

async function handleMetadataApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const db = env.blossom_metadata;

  if (pathname === "/__meta/stats" && request.method === "GET") {
    const row = await d1One(
      db,
      `SELECT
         COUNT(*) AS blobCount,
         COALESCE(SUM(size), 0) AS totalSize,
         COUNT(CASE WHEN uploaded > unixepoch() - 86400 THEN 1 END) AS dailyUploads
       FROM blobs`,
    );
    return json({
      blobCount: Number(row?.blobCount ?? 0),
      totalSize: Number(row?.totalSize ?? 0),
      dailyUploads: Number(row?.dailyUploads ?? 0),
      deployProbe: DEPLOY_PROBE,
    });
  }

  if (pathname === "/__meta/blobs" && request.method === "GET") {
    const limit = parseIntParam(url.searchParams.get("limit"), 24, 1, 200);
    const offset = parseIntParam(
      url.searchParams.get("offset"),
      0,
      0,
      1_000_000,
    );
    const q = url.searchParams.get("q")?.trim() ?? "";
    const sort = (url.searchParams.get("sort") ?? "uploaded").toLowerCase();
    const dir = (url.searchParams.get("dir") ?? "DESC").toUpperCase() === "ASC"
      ? "ASC"
      : "DESC";

    const sortCol = ["sha256", "type", "size", "uploaded"].includes(sort)
      ? sort
      : "uploaded";

    const types = (url.searchParams.get("type") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (q) {
      if (HEX_64_RE.test(q)) {
        conditions.push("b.sha256 = ?");
        args.push(q);
      } else {
        conditions.push("(b.sha256 LIKE ? OR b.type LIKE ?)");
        args.push(`%${q}%`, `%${q}%`);
      }
    }
    if (types.length === 1) {
      conditions.push("b.type = ?");
      args.push(types[0]);
    } else if (types.length > 1) {
      conditions.push(`b.type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = await d1All(
      db,
      `SELECT b.sha256, b.size, b.type, b.uploaded,
              COALESCE(GROUP_CONCAT(o.pubkey, ','), '') AS owners
       FROM blobs b
       LEFT JOIN owners o ON o.blob = b.sha256
       ${where}
       GROUP BY b.sha256
       ORDER BY b.${sortCol} ${dir}
       LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );

    return json({
      items: rows.map((r) => ({
        sha256: String(r.sha256 ?? ""),
        size: Number(r.size ?? 0),
        type: r.type ? String(r.type) : null,
        uploaded: Number(r.uploaded ?? 0),
        owners: r.owners
          ? String(r.owners).split(",").filter((v) => v.length > 0)
          : [],
      })),
    });
  }

  if (pathname === "/__meta/blobs/count" && request.method === "GET") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const types = (url.searchParams.get("type") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (q) {
      if (HEX_64_RE.test(q)) {
        conditions.push("sha256 = ?");
        args.push(q);
      } else {
        conditions.push("(sha256 LIKE ? OR type LIKE ?)");
        args.push(`%${q}%`, `%${q}%`);
      }
    }
    if (types.length === 1) {
      conditions.push("type = ?");
      args.push(types[0]);
    } else if (types.length > 1) {
      conditions.push(`type IN (${types.map(() => "?").join(",")})`);
      args.push(...types);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const row = await d1One(
      db,
      `SELECT COUNT(*) AS count FROM blobs ${where}`,
      args,
    );
    return json({ count: Number(row?.count ?? 0) });
  }

  if (pathname === "/__meta/users" && request.method === "GET") {
    const limit = parseIntParam(url.searchParams.get("limit"), 24, 1, 200);
    const offset = parseIntParam(
      url.searchParams.get("offset"),
      0,
      0,
      1_000_000,
    );
    const q = url.searchParams.get("q")?.trim() ?? "";
    const pubkey = url.searchParams.get("pubkey")?.trim() ?? "";
    const dir = (url.searchParams.get("dir") ?? "ASC").toUpperCase() === "DESC"
      ? "DESC"
      : "ASC";

    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (q) {
      conditions.push("o.pubkey LIKE ?");
      args.push(`%${q}%`);
    }
    if (pubkey) {
      conditions.push("o.pubkey = ?");
      args.push(pubkey);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = await d1All(
      db,
      `SELECT o.pubkey, COALESCE(GROUP_CONCAT(o.blob, ','), '') AS blobs
       FROM owners o
       ${where}
       GROUP BY o.pubkey
       ORDER BY o.pubkey ${dir}
       LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );

    return json({
      items: rows.map((r) => ({
        pubkey: String(r.pubkey ?? ""),
        blobs: r.blobs
          ? String(r.blobs).split(",").filter((v) => v.length > 0)
          : [],
      })),
    });
  }

  if (pathname === "/__meta/users/count" && request.method === "GET") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const pubkey = url.searchParams.get("pubkey")?.trim() ?? "";

    const conditions: string[] = [];
    const args: Array<string | number> = [];
    if (q) {
      conditions.push("pubkey LIKE ?");
      args.push(`%${q}%`);
    }
    if (pubkey) {
      conditions.push("pubkey = ?");
      args.push(pubkey);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const row = await d1One(
      db,
      `SELECT COUNT(DISTINCT pubkey) AS count FROM owners ${where}`,
      args,
    );
    return json({ count: Number(row?.count ?? 0) });
  }

  if (pathname === "/__meta/reindex" && request.method === "POST") {
    const adminPassword = env.BLOSSOM_ADMIN_PASSWORD ?? "";
    if (adminPassword.length > 0) {
      const auth = request.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${adminPassword}`) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    const owner = url.searchParams.get("owner")?.trim() || "recovered-r2";
    const max = parseIntParam(url.searchParams.get("max"), 1000, 1, 1000);
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const page = await env.BLOSSOM_R2.list({ cursor, limit: max });
    let scanned = 0;
    let imported = 0;
    let skipped = 0;

    for (const obj of page.objects) {
      scanned += 1;
      const base = obj.key.split("/").pop() ?? obj.key;
      const m = base.match(/^([a-f0-9]{64})(?:\.([A-Za-z0-9]+))?$/);
      if (!m) {
        skipped += 1;
        continue;
      }
      const hash = m[1];
      const ext = m[2] ?? null;
      const uploaded = Math.floor(obj.uploaded.getTime() / 1000);
      const descriptor: BlobDescriptor = {
        sha256: hash,
        size: obj.size,
        type: extToMime(ext),
        uploaded,
      };
      await upsertDescriptor(env, descriptor, owner);
      imported += 1;
    }

    return json({
      scanned,
      imported,
      skipped,
      nextCursor: page.truncated ? page.cursor : null,
      done: !page.truncated,
    });
  }

  return null;
}

async function syncFromUploadResponse(
  request: Request,
  response: Response,
  env: Env,
): Promise<void> {
  if (!response.ok) return;
  if (request.method !== "PUT") return;

  const path = new URL(request.url).pathname;
  if (path !== "/upload" && path !== "/mirror" && path !== "/media") return;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return;

  const parsed = await response.clone().json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!parsed) return;

  const sha256 = typeof parsed.sha256 === "string"
    ? parsed.sha256.toLowerCase()
    : "";
  const size = Number(parsed.size ?? 0);
  const uploaded = Number(parsed.uploaded ?? Math.floor(Date.now() / 1000));
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!HEX_64_RE.test(sha256) || !Number.isFinite(size) || size < 0) return;

  const owner = parsePubkeyFromAuth(request.headers.get("authorization")) ??
    "anonymous";
  await upsertDescriptor(env, { sha256, size, type, uploaded }, owner);
}

async function syncAccessFromBlobRead(
  request: Request,
  response: Response,
  env: Env,
): Promise<void> {
  if (!(request.method === "GET" || request.method === "HEAD")) return;
  if (response.status < 200 || response.status >= 400) return;
  const parsed = parseBlobPath(new URL(request.url).pathname);
  if (!parsed) return;
  await touchAccess(env, parsed.hash, Math.floor(Date.now() / 1000));
}

async function syncDelete(
  request: Request,
  response: Response,
  env: Env,
): Promise<void> {
  if (request.method !== "DELETE" || !response.ok) return;
  const parsed = parseBlobPath(new URL(request.url).pathname);
  if (!parsed) return;
  const owner = parsePubkeyFromAuth(request.headers.get("authorization")) ??
    "anonymous";
  await removeOwnerOrBlob(env, parsed.hash, owner);
}

export class BlossomAppContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const envVars: Record<string, string> = {
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      BLOSSOM_PUBLIC_DOMAIN: env.BLOSSOM_PUBLIC_DOMAIN ?? "",
      BLOSSOM_ADMIN_PASSWORD: env.BLOSSOM_ADMIN_PASSWORD ?? "",
      D1_METADATA_ENABLED: "1",
    };

    // Metadata must live in a persistent remote libSQL database in Cloudflare
    // containers. Local SQLite inside the container is ephemeral across restarts.
    if (env.TURSO_DATABASE_URL) {
      envVars.TURSO_DATABASE_URL = env.TURSO_DATABASE_URL;
    }
    if (env.TURSO_AUTH_TOKEN) {
      envVars.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
    }

    this.envVars = envVars;
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const metaResponse = await handleMetadataApi(request, env);
    if (metaResponse) return metaResponse;

    // Keep blob upload/download paths on the existing container runtime.
    const container = env.BLOSSOM_APP.getByName("primary");
    await container.start();
    const response = await container.fetch(request);

    ctx.waitUntil(
      syncFromUploadResponse(request, response, env).catch(() => {}),
    );
    ctx.waitUntil(
      syncAccessFromBlobRead(request, response, env).catch(() => {}),
    );
    ctx.waitUntil(syncDelete(request, response, env).catch(() => {}));

    return response;
  },
};
