/**
 * Admin dashboard router — runs on the main thread with direct database access.
 *
 * Owns all /admin/* SSR pages and JSON action endpoints.
 * HTTP Basic Auth gates the entire /admin/* namespace.
 *
 * Mounted at /admin in the parent app. Internal paths are relative to that prefix:
 *   GET  /admin                              → redirect to /admin/blobs
 *   GET  /admin/blobs                        → BlobsPage SSR
 *   GET  /admin/blobs/:sha256                → BlobDetailPage SSR
 *   GET  /admin/users                        → UsersPage SSR
 *   GET  /admin/users/:pubkey                → UserDetailPage SSR
 *   GET  /admin/rules                        → RulesPage SSR
 *   GET  /admin/reports                      → ReportsPage SSR
 *   GET  /admin/reports/:id                  → ReportDetailPage SSR
 *   DELETE /admin/api/blobs/:sha256          → force-delete blob
 *   DELETE /admin/api/users/:pubkey          → delete all blobs owned by pubkey
 *   POST   /admin/api/reports/:id/dismiss    → dismiss report
 *   POST   /admin/api/reports/:id/delete-blob → delete blob + all reports for it
 */

import { Hono } from "@hono/hono";
import { basicAuth } from "@hono/hono/basic-auth";
import type { Client } from "@libsql/client";
import type { IBlobStorage } from "../storage/interface.ts";
import type { Config } from "../config/schema.ts";
import { mimeToExt } from "../utils/mime.ts";
import { getBlob, listBlobsByPubkeyAdmin } from "../db/blobs.ts";
import { deleteReport, deleteReportsByBlob, getReport } from "../db/reports.ts";
import { DirectDbHandle } from "../db/direct.ts";
import { BlobsPage } from "../admin/blobs-page.tsx";
import { BlobDetailPage } from "../admin/blob-detail-page.tsx";
import { UsersPage } from "../admin/users-page.tsx";
import { UserDetailPage } from "../admin/user-detail-page.tsx";
import { RulesPage } from "../admin/rules-page.tsx";
import { ReportsPage } from "../admin/reports-page.tsx";
import { ReportDetailPage } from "../admin/report-detail-page.tsx";
import { withBlobMutationLock } from "../utils/blob-mutation-lock.ts";
import { deleteStoredBlob } from "../storage/deletion.ts";
import { lookupRelays$ } from "../admin/nostr-profile.ts";

export function buildAdminRouter(
  db: Client,
  storage: IBlobStorage,
  config: Config,
): Hono {
  // Push the configured relay list into the subject — the event loader will
  // immediately start using these relays. Can be updated later by calling
  // lookupRelays$.next(newRelays) from anywhere that imports this module.
  lookupRelays$.next(config.dashboard.lookupRelays);

  const dbHandle = new DirectDbHandle(db);
  const app = new Hono();

  // HTTP Basic Auth gate — covers all routes on this sub-app.
  // The "*" pattern matches everything because this router is mounted at /admin.
  app.use(
    "*",
    basicAuth({
      username: config.dashboard.username,
      password: config.dashboard.password,
    }),
  );

  // Basic Auth may be cached by browsers; reject cross-origin mutations.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const configured = config.publicDomain;
      const expected = configured
        ? new URL(
          configured.includes("://") ? configured : `https://${configured}`,
        ).origin
        : new URL(c.req.url).origin;
      if (c.req.header("origin") !== expected) {
        return c.json({ error: "Invalid request origin" }, 403);
      }
    }
    c.header("cache-control", "no-store");
    c.header("x-frame-options", "DENY");
    await next();
  });

  // ── SSR pages ───────────────────────────────────────────────────────────────

  app.get("/", (c) => c.redirect("/admin/blobs", 301));

  app.get("/blobs", (c) => {
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const q = c.req.query("q") ?? "";
    const host = c.req.header("host") ?? "localhost";
    return c.html(
      <BlobsPage db={dbHandle} config={config} host={host} page={page} q={q} />,
    );
  });

  app.get("/blobs/:sha256", (c) => {
    const sha256 = c.req.param("sha256");
    const host = c.req.header("host") ?? "localhost";
    return c.html(
      <BlobDetailPage
        db={dbHandle}
        config={config}
        host={host}
        sha256={sha256}
      />,
    );
  });

  app.get("/users", (c) => {
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const q = c.req.query("q") ?? "";
    return c.html(<UsersPage db={dbHandle} page={page} q={q} />);
  });

  app.get("/users/:pubkey", (c) => {
    const pubkey = c.req.param("pubkey");
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    return c.html(<UserDetailPage db={dbHandle} pubkey={pubkey} page={page} />);
  });

  app.get("/rules", (c) => {
    return c.html(<RulesPage config={config} />);
  });

  app.get("/reports", (c) => {
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const typeFilter = c.req.query("type") ?? "";
    return c.html(
      <ReportsPage db={dbHandle} page={page} typeFilter={typeFilter} />,
    );
  });

  app.get("/reports/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid report id" }, 400);
    return c.html(<ReportDetailPage db={dbHandle} reportId={id} />);
  });

  // ── JSON action endpoints ───────────────────────────────────────────────────

  // DELETE /api/blobs/:sha256 — force-delete a blob and its file
  app.delete("/api/blobs/:sha256", async (c) => {
    const sha256 = c.req.param("sha256");
    await withBlobMutationLock(sha256, async () => {
      const blob = await getBlob(db, sha256);
      if (blob) {
        await deleteStoredBlob(db, storage, sha256, mimeToExt(blob.type));
      }
    });

    return c.json({ success: true }, 200);
  });

  // DELETE /api/users/:pubkey — delete all blobs owned by a pubkey
  app.delete("/api/users/:pubkey", async (c) => {
    const pubkey = c.req.param("pubkey");

    // Fetch all blobs for this pubkey (large limit — admin operation)
    const blobs = await listBlobsByPubkeyAdmin(db, pubkey, { limit: 10_000 });

    let deleted = 0;
    for (const blob of blobs) {
      await withBlobMutationLock(blob.sha256, async () => {
        const current = await getBlob(db, blob.sha256);
        if (current) {
          await deleteStoredBlob(
            db,
            storage,
            blob.sha256,
            mimeToExt(current.type),
          );
        }
      });
      deleted++;
    }

    return c.json({ success: true, deleted }, 200);
  });

  // POST /api/reports/:id/dismiss — dismiss report only (keep blob)
  app.post("/api/reports/:id/dismiss", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid report id" }, 400);

    const deleted = await deleteReport(db, id);
    if (!deleted) return c.json({ error: "Report not found" }, 404);

    return c.json({ success: true }, 200);
  });

  // POST /api/reports/:id/delete-blob — delete blob + dismiss all its reports
  app.post("/api/reports/:id/delete-blob", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid report id" }, 400);

    const report = await getReport(db, id);
    if (!report) return c.json({ error: "Report not found" }, 404);

    const blobHash = report.blob;
    await withBlobMutationLock(blobHash, async () => {
      const blob = await getBlob(db, blobHash);
      if (blob) {
        await deleteStoredBlob(db, storage, blobHash, mimeToExt(blob.type));
      }
      await deleteReportsByBlob(db, blobHash);
    });

    return c.json({ success: true }, 200);
  });

  return app;
}
