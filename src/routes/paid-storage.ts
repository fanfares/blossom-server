import { Hono } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import type { Client } from "@libsql/client";
import type { Config } from "../config/schema.ts";
import { listBlobsByPubkey } from "../db/blobs.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { BlossomVariables } from "../middleware/auth.ts";
import { errorResponse } from "../middleware/errors.ts";
import type { PaidStorageService } from "../paid-storage/service.ts";
import { getBaseUrl, getBlobUrl } from "../utils/url.ts";

/** Mounts Fanfares paid-storage account and Lightning checkout endpoints. */
export function buildPaidStorageRouter(
  db: Client,
  config: Config,
  service: PaidStorageService,
): Hono<{ Variables: BlossomVariables }> {
  const app = new Hono<{ Variables: BlossomVariables }>();

  app.get(
    "/storage/plan",
    (ctx) => ctx.json({ enabled: service.enabled, ...service.plan }),
  );

  app.get("/storage/account", async (ctx) => {
    const auth = getStorageAuth(ctx);
    if (auth instanceof Response) return auth;

    await service.processPendingPurchases(100, auth.pubkey);
    const [quota, grants, blobs] = await Promise.all([
      service.getQuota(auth.pubkey),
      service.getActiveGrants(auth.pubkey),
      listBlobsByPubkey(db, auth.pubkey, { limit: 1000 }),
    ]);
    const baseUrl = getBaseUrl(ctx.req.raw, config.publicDomain);
    return ctx.json({
      enabled: service.enabled,
      pubkey: auth.pubkey,
      plan: service.plan,
      quota,
      grants,
      files: blobs.map((blob) => ({
        url: getBlobUrl(blob.sha256, blob.type, baseUrl),
        sha256: blob.sha256,
        size: blob.size,
        type: blob.type ?? "application/octet-stream",
        uploaded: blob.uploaded,
      })),
    });
  });

  app.get("/storage/purchases", async (ctx) => {
    const auth = getStorageAuth(ctx);
    if (auth instanceof Response) return auth;
    await service.processPendingPurchases(100, auth.pubkey);
    const purchases = await service.listPurchases(auth.pubkey);
    return ctx.json(
      purchases.map((purchase) =>
        toPublicPurchase(purchase, service.plan.durationDays)
      ),
    );
  });

  app.post("/storage/purchases/preview", async (ctx) => {
    const auth = getStorageAuth(ctx);
    if (auth instanceof Response) return auth;
    try {
      const body = await ctx.req.json<{
        storageUnits?: number;
        durationYears?: number;
        alignExpiry?: boolean;
      }>();
      if (
        body.alignExpiry !== undefined && typeof body.alignExpiry !== "boolean"
      ) {
        return errorResponse(ctx, 400, "alignExpiry must be a boolean");
      }
      const preview = await service.previewPurchase(
        auth.pubkey,
        body.storageUnits ?? 1,
        body.durationYears ?? 1,
        body.alignExpiry ?? false,
      );
      return ctx.json(preview);
    } catch (err) {
      if (err instanceof RangeError) {
        return errorResponse(ctx, 400, err.message);
      }
      if (err instanceof Error && err.message === "Paid storage is disabled") {
        return errorResponse(ctx, 403, err.message);
      }
      return errorResponse(ctx, 400, "Invalid storage purchase preview");
    }
  });

  app.post("/storage/purchases", async (ctx) => {
    const auth = getStorageAuth(ctx);
    if (auth instanceof Response) return auth;

    let purchaseType: "new" | "extension" = "new";
    let storageUnits = 1;
    let durationYears = 1;
    let alignExpiry = false;
    try {
      const body = await ctx.req.json<{
        purchaseType?: "new" | "extension";
        storageUnits?: number;
        durationYears?: number;
        units?: number;
        alignExpiry?: boolean;
      }>();
      purchaseType = body.purchaseType ?? "new";
      storageUnits = body.storageUnits ?? body.units ?? 1;
      durationYears = body.durationYears ?? 1;
      alignExpiry = body.alignExpiry ?? false;
    } catch {
      return errorResponse(ctx, 400, "Request body must be valid JSON");
    }

    try {
      if (purchaseType !== "new" && purchaseType !== "extension") {
        return errorResponse(ctx, 400, "Invalid storage purchase type");
      }
      if (typeof alignExpiry !== "boolean") {
        return errorResponse(ctx, 400, "alignExpiry must be a boolean");
      }
      if (purchaseType === "extension" && alignExpiry) {
        return errorResponse(
          ctx,
          400,
          "Expiry alignment is available only when buying new storage",
        );
      }
      const purchase = purchaseType === "extension"
        ? await service.createExtensionPurchase(auth.pubkey, durationYears)
        : await service.getOrCreatePurchase(
          auth.pubkey,
          storageUnits,
          durationYears,
          alignExpiry,
        );
      return ctx.json(
        toPublicPurchase(purchase, service.plan.durationDays),
        201,
      );
    } catch (err) {
      if (err instanceof RangeError) {
        return errorResponse(ctx, 400, err.message);
      }
      if (err instanceof Error && err.message === "Paid storage is disabled") {
        return errorResponse(ctx, 403, err.message);
      }
      console.error("Failed to create paid-storage invoice:", err);
      return errorResponse(ctx, 502, "Lightning invoice provider unavailable");
    }
  });

  app.get("/storage/purchases/:id", async (ctx) => {
    const auth = getStorageAuth(ctx);
    if (auth instanceof Response) return auth;

    try {
      const purchase = await service.refreshPurchase(
        ctx.req.param("id"),
        auth.pubkey,
      );
      if (!purchase) {
        return errorResponse(ctx, 404, "Storage purchase not found");
      }
      return ctx.json(toPublicPurchase(purchase, service.plan.durationDays));
    } catch (err) {
      console.error("Failed to verify paid-storage invoice:", err);
      return errorResponse(
        ctx,
        502,
        "Lightning invoice verification unavailable",
      );
    }
  });

  return app;
}

function getStorageAuth(
  ctx: Parameters<typeof requireAuth>[0],
): ReturnType<typeof requireAuth> | Response {
  try {
    return requireAuth(ctx, "storage");
  } catch (err) {
    if (err instanceof HTTPException) {
      return errorResponse(ctx, err.status as 401 | 403, err.message);
    }
    throw err;
  }
}

function toPublicPurchase(
  purchase: Awaited<ReturnType<PaidStorageService["getOrCreatePurchase"]>>,
  durationDays: number,
) {
  return {
    id: purchase.id,
    purchaseType: purchase.purchaseType,
    units: purchase.units,
    storageUnits: purchase.units,
    durationYears: Math.round(
      purchase.durationSeconds / (durationDays * 24 * 60 * 60),
    ),
    quotaBytes: purchase.quotaBytes,
    amountSats: purchase.amountSats,
    invoice: purchase.invoice,
    state: purchase.state,
    invoiceExpires: purchase.invoiceExpires,
    createdAt: purchase.createdAt,
    paidAt: purchase.paidAt,
    creditedAt: purchase.creditedAt,
    alignExpiry: purchase.alignedExpiresAt !== null,
    alignedExpiresAt: purchase.alignedExpiresAt,
    baseAmountSats: purchase.baseAmountSats,
    alignmentAmountSats: purchase.alignmentAmountSats,
  };
}
