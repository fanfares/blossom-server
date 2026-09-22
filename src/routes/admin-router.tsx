/**
 * Admin dashboard router — runs on the main thread with direct database access.
 *
 * Owns all /admin/* SSR pages and JSON action endpoints.
 * An allowlisted Nostr signature and password-authenticated session gate the
 * entire /admin/* namespace. Login routes are the only public exceptions.
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
 *   POST   /admin/api/reports/:id/dismiss    → dismiss report
 */

import { Hono } from "@hono/hono";
import type { Client } from "@libsql/client";
import type { IBlobStorage } from "../storage/interface.ts";
import type { Config } from "../config/schema.ts";
import { deleteReport } from "../db/reports.ts";
import { DirectDbHandle } from "../db/direct.ts";
import { BlobsPage } from "../admin/blobs-page.tsx";
import { BlobDetailPage } from "../admin/blob-detail-page.tsx";
import { UsersPage } from "../admin/users-page.tsx";
import { UserDetailPage } from "../admin/user-detail-page.tsx";
import { RulesPage } from "../admin/rules-page.tsx";
import { ReportsPage } from "../admin/reports-page.tsx";
import { ReportDetailPage } from "../admin/report-detail-page.tsx";
import { lookupRelays$ } from "../admin/nostr-profile.ts";
import { inspectAndIndexEvent } from "../admin/event-index.ts";
import { registerAdminAuthentication } from "./admin-auth-routes.tsx";

export function buildAdminRouter(
  db: Client,
  _storage: IBlobStorage,
  config: Config,
): Hono {
  // Push the configured relay list into the subject — the event loader will
  // immediately start using these relays. Can be updated later by calling
  // lookupRelays$.next(newRelays) from anywhere that imports this module.
  lookupRelays$.next(config.dashboard.lookupRelays);

  const dbHandle = new DirectDbHandle(db);
  const app = new Hono();

  registerAdminAuthentication(app, config);

  // ── SSR pages ───────────────────────────────────────────────────────────────

  app.get("/", (c) => c.redirect("/admin/blobs", 301));

  app.get("/blobs", (c) => {
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const q = c.req.query("q") ?? "";
    const visibilityValue = c.req.query("visibility") ?? "";
    const visibility =
      ["encrypted", "public", "unlinked"].includes(visibilityValue)
        ? visibilityValue as "encrypted" | "public" | "unlinked"
        : "";
    const sortValue = c.req.query("sort") ?? "uploaded";
    const sort = ["sha256", "type", "size", "uploaded"].includes(sortValue)
      ? sortValue as "sha256" | "type" | "size" | "uploaded"
      : "uploaded";
    const direction = c.req.query("direction") === "ASC" ? "ASC" : "DESC";
    const host = c.req.header("host") ?? "localhost";
    return c.html(
      <BlobsPage
        db={dbHandle}
        config={config}
        host={host}
        page={page}
        q={q}
        visibility={visibility}
        sort={sort}
        direction={direction}
        notice={c.req.query("notice")}
      />,
    );
  });

  app.post("/events/inspect", async (c) => {
    const body = await c.req.parseBody();
    const identifier = typeof body.event === "string" ? body.event : "";
    try {
      const result = await inspectAndIndexEvent(
        db,
        identifier,
        config.dashboard.lookupRelays,
        [config.publicDomain || new URL(c.req.url).hostname, config.blobDomain]
          .filter(Boolean),
      );
      const notice =
        `Indexed event ${result.event.id}: ${result.linked.length} stored file(s), ${result.missing.length} missing.`;
      return c.redirect(
        `/admin/blobs?q=${result.event.id}&notice=${
          encodeURIComponent(notice)
        }`,
        303,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Event inspection failed.";
      return c.redirect(
        `/admin/blobs?notice=${encodeURIComponent(message)}`,
        303,
      );
    }
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
    return c.html(
      <UserDetailPage db={dbHandle} config={config} pubkey={pubkey} />,
    );
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

  // POST /api/reports/:id/dismiss — dismiss report only (keep blob)
  app.post("/api/reports/:id/dismiss", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return c.json({ error: "Invalid report id" }, 400);

    const deleted = await deleteReport(db, id);
    if (!deleted) return c.json({ error: "Report not found" }, 404);

    return c.json({ success: true }, 200);
  });

  return app;
}
