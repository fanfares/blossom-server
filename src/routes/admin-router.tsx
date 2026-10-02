/** @jsxImportSource @hono/hono/jsx */
import { imageCachePurgeStatus } from "../admin/image-cache-purge.ts";
import { QuarantinePage } from "../admin/quarantine-page.tsx";
import {
  isQuarantined,
  quarantineTargets,
  setQuarantine,
} from "../db/quarantine.ts";
import { getCookie } from "@hono/hono/cookie";
import { bodyLimit } from "@hono/hono/body-limit";
import {
  ADMIN_SESSION_COOKIE,
  constantTimePasswordEqual,
  verifyAdminToken,
} from "../admin/admin-auth.ts";
import { getStorageQuotaSummary } from "../db/paid-storage.ts";
import { setTreasuryDestination } from "../db/admin-payments.ts";
import { PaymentsPage } from "../admin/payments-page.tsx";
import { ContentReportsPage } from "../admin/content-reports-page.tsx";
import { refreshContentReports } from "../admin/content-reports.ts";
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
import { fetchUserProfiles, lookupRelays$ } from "../admin/nostr-profile.ts";
import {
  fetchOwnerEvents,
  indexEventsForAdmin,
  inspectAndIndexEvent,
} from "../admin/event-index.ts";
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
  const walletFailures = new Map<string, { count: number; until: number }>();
  let reportRefresh: Promise<{ added: number; limited: boolean }> | undefined;

  app.get("/quarantine", async (c) => {
    const scope = c.req.query("scope") ?? "file";
    const id = c.req.query("id") ?? "";
    if (
      !["file", "event", "user"].includes(scope) || !/^[a-f0-9]{64}$/.test(id)
    ) return c.json({ error: "Invalid target" }, 400);
    const hashes = await quarantineTargets(db, scope, id);
    return c.html(
      <QuarantinePage
        scope={scope}
        id={id}
        hashes={hashes}
        active={scope === "file" && await isQuarantined(db, id)}
      />,
    );
  });
  app.post("/quarantine", bodyLimit({ maxSize: 700000 }), async (c) => {
    const session = await verifyAdminToken(
      getCookie(c, ADMIN_SESSION_COOKIE),
      "session",
      config.dashboard.sessionSecret,
    );
    if (!session?.pubkey) {
      return c.json({ error: "Admin session required" }, 401);
    }
    const body = await c.req.parseBody();
    const scope = String(body.scope ?? "");
    const id = String(body.id ?? "");
    const reason = String(body.reason ?? "").trim();
    if (
      !["file", "event", "user"].includes(scope) ||
      !/^[a-f0-9]{64}$/.test(id) || reason.length < 3 || reason.length > 1000 ||
      !["quarantine", "restore"].includes(String(body.action))
    ) return c.json({ error: "Invalid moderation request" }, 400);
    if (body.action === "restore" && scope !== "file") {
      return c.json({ error: "Restore individual files after review" }, 400);
    }
    const hashes = await quarantineTargets(db, scope, id);
    if (!hashes.length || hashes.join(",") !== body.selection) {
      return c.json({
        error:
          "File selection changed. Reload the confirmation page and review again.",
      }, 409);
    }
    try {
      await setQuarantine(
        db,
        hashes,
        body.action === "quarantine",
        session.pubkey,
        reason,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
    return c.redirect(`/admin/blobs/${hashes[0]}`, 303);
  });

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
      const profiles = await fetchUserProfiles(
        [result.event.pubkey],
        4_000,
        true,
      );
      await indexEventsForAdmin(
        db,
        [result.event],
        profiles,
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

  app.post("/events/refresh", async (c) => {
    try {
      const users = await dbHandle.listAllUsers({ limit: 10_000 });
      const pubkeys = users.map((user) => user.pubkey);
      const [events, profiles] = await Promise.all([
        fetchOwnerEvents(pubkeys, config.dashboard.lookupRelays, {
          maxWait: 4_000,
          force: true,
        }),
        fetchUserProfiles(pubkeys, 4_000, true),
      ]);
      const result = await indexEventsForAdmin(
        db,
        events,
        profiles,
        [config.publicDomain || new URL(c.req.url).hostname, config.blobDomain]
          .filter(Boolean),
      );
      const notice = `Refreshed ${result.events} verified event${
        result.events === 1 ? "" : "s"
      } and ${result.links} stored file link${result.links === 1 ? "" : "s"}.`;
      return c.redirect(
        `/admin/blobs?notice=${encodeURIComponent(notice)}`,
        303,
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Metadata refresh failed.";
      return c.redirect(
        `/admin/blobs?notice=${encodeURIComponent(message)}`,
        303,
      );
    }
  });

  app.get("/blobs/:sha256", async (c) => {
    const sha256 = c.req.param("sha256");
    const host = c.req.header("host") ?? "localhost";
    return c.html(
      <BlobDetailPage
        db={dbHandle}
        config={config}
        host={host}
        sha256={sha256}
        quarantined={await isQuarantined(db, sha256)}
        imagePurgeStatus={await imageCachePurgeStatus(db, sha256, config)}
        moderationHistory={(await db.execute({
          sql:
            "SELECT action, actor, reason, created_at FROM blob_quarantine_audit WHERE sha256 = ? ORDER BY id DESC LIMIT 50",
          args: [sha256],
        })).rows.map((row) => ({
          action: String(row.action),
          actor: String(row.actor),
          reason: String(row.reason),
          createdAt: Number(row.created_at),
        }))}
      />,
    );
  });

  app.get("/users", (c) => {
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10));
    const q = c.req.query("q") ?? "";
    return c.html(<UsersPage db={dbHandle} page={page} q={q} />);
  });

  app.get("/users/:pubkey", async (c) => {
    const pubkey = c.req.param("pubkey");
    if (!/^[a-f0-9]{64}$/i.test(pubkey)) {
      return c.json({ error: "Invalid pubkey" }, 400);
    }
    const [quota, paid] = await Promise.all([
      getStorageQuotaSummary(db, pubkey, Math.floor(Date.now() / 1000)),
      db.execute({
        sql:
          "SELECT COALESCE(SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM storage_purchase_extensions e WHERE e.purchase_id = p.id) THEN p.quota_bytes ELSE 0 END),0), COALESCE(SUM(p.amount_sats),0) FROM storage_purchases p WHERE p.pubkey = ? AND p.credited_at IS NOT NULL",
        args: [pubkey],
      }),
    ]);
    return c.html(
      <UserDetailPage
        db={dbHandle}
        config={config}
        pubkey={pubkey}
        quota={quota}
        purchasedBytes={Number(paid.rows[0][0])}
        paidSats={Number(paid.rows[0][1])}
        quarantinedHashes={(await db.execute({
          sql:
            "SELECT o.blob FROM owners o JOIN blob_quarantine q ON q.sha256 = o.blob WHERE o.pubkey = ? AND q.active = 1",
          args: [pubkey],
        })).rows.map((row) => String(row.blob))}
      />,
    );
  });

  app.get("/rules", (c) => {
    return c.html(<RulesPage config={config} />);
  });

  app.get("/payments", (c) => {
    const page = Math.min(
      100000,
      Math.max(1, Number(c.req.query("page")) || 1),
    );
    return c.html(
      <PaymentsPage
        db={db}
        config={config}
        page={Math.floor(page)}
        pubkey={(c.req.query("pubkey") ?? "").slice(0, 64)}
        state={c.req.query("state") ?? ""}
        notice={c.req.query("notice")}
      />,
    );
  });

  app.post("/payments/destination", bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!config.paidStorage.enabled || !config.paidStorage.treasury.enabled) {
      return c.json({ error: "Treasury forwarding is disabled." }, 400);
    }
    const session = await verifyAdminToken(
      getCookie(c, ADMIN_SESSION_COOKIE),
      "session",
      config.dashboard.sessionSecret,
    );
    if (!session?.pubkey) {
      return c.json({ error: "Admin session required." }, 401);
    }
    const now = Date.now();
    const failure = walletFailures.get(session.pubkey);
    if (failure && failure.until > now && failure.count >= 5) {
      return c.json({
        error: "Too many password attempts. Try again in 15 minutes.",
      }, 429);
    }
    const body = await c.req.parseBody();
    if (
      typeof body.password !== "string" ||
      !await constantTimePasswordEqual(body.password, config.dashboard.password)
    ) {
      walletFailures.set(session.pubkey, {
        count: (failure && failure.until > now ? failure.count : 0) + 1,
        until: now + 900000,
      });
      return c.json({ error: "Incorrect admin password." }, 403);
    }
    walletFailures.delete(session.pubkey);
    try {
      await setTreasuryDestination(
        db,
        typeof body.destination === "string" ? body.destination : "",
        session.pubkey,
        config.paidStorage.treasury.lightningAddress ?? "",
        typeof body.mintUrl === "string"
          ? {
            url: body.mintUrl,
            configured: config.paidStorage.cashu.mintUrl,
            approved: config.paidStorage.approvedMintUrls,
          }
          : undefined,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith("Enter a Lightning") ||
          error.message.startsWith("Select a mint"))
      ) return c.json({ error: error.message }, 400);
      throw error;
    }
    return c.redirect(
      "/admin/payments?notice=Payment%20settings%20saved.%20Existing%20invoices%20keep%20their%20original%20mint.",
      303,
    );
  });

  app.get(
    "/reports",
    (c) =>
      c.html(
        <ContentReportsPage
          db={db}
          config={config}
          page={Math.floor(
            Math.min(100000, Math.max(1, Number(c.req.query("page")) || 1)),
          )}
          status={c.req.query("status") === "reviewed" ? "reviewed" : "open"}
          q={(c.req.query("q") ?? "").slice(0, 200)}
          notice={c.req.query("notice")}
        />,
      ),
  );

  app.post("/reports/refresh", async (c) => {
    try {
      reportRefresh ??= refreshContentReports(db, config.dashboard.lookupRelays)
        .finally(() => {
          reportRefresh = undefined;
        });
      const result = await reportRefresh;
      return c.redirect(
        `/admin/reports?notice=${
          encodeURIComponent(
            `Imported ${result.added} new signed reports. ${
              result.limited
                ? "Sync limit reached; this is a partial view."
                : "Only reports available from the configured relays are included."
            }`,
          )
        }`,
        303,
      );
    } catch {
      return c.redirect(
        "/admin/reports?notice=Relay%20sync%20failed.%20Previously%20imported%20reports%20are%20retained.",
        303,
      );
    }
  });

  app.post(
    "/reports/:eventId/review",
    bodyLimit({ maxSize: 4096 }),
    async (c) => {
      const eventId = c.req.param("eventId");
      if (!/^[a-f0-9]{64}$/.test(eventId)) {
        return c.json({
          error: "Invalid report ID",
        }, 400);
      }
      const session = await verifyAdminToken(
        getCookie(c, ADMIN_SESSION_COOKIE),
        "session",
        config.dashboard.sessionSecret,
      );
      if (!session?.pubkey) {
        return c.json(
          { error: "Admin session required." },
          401,
        );
      }
      const body = await c.req.parseBody();
      const status = body.status === "open" ? "open" : "reviewed";
      await db.execute({
        sql:
          "UPDATE admin_content_reports SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE event_id = ?",
        args: [status, Math.floor(Date.now() / 1000), session.pubkey, eventId],
      });
      return c.redirect("/admin/reports", 303);
    },
  );

  app.get("/blob-reports", (c) => {
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
