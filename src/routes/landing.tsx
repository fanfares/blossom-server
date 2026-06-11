/**
 * Landing page router — runs on the main thread.
 *
 * Renders GET / via Hono JSX SSR.
 *
 * The landing client bundle must exist at public/client.js before startup.
 * Static files in public/ are served by the top-level app via Hono serveStatic.
 */

import { Hono } from "@hono/hono";
import type { Client } from "@libsql/client";
import type { Config } from "../config/schema.ts";
import { DirectDbHandle } from "../db/direct.ts";
import { MetaApiDbHandle } from "../db/meta-api.ts";
import { LandingPage } from "../landing/page.tsx";

const CLIENT_BUNDLE_PATH = "./public/client.js";

/** Warn at startup if the prebuilt landing client bundle is missing. */
async function warnIfClientBundleMissing(): Promise<void> {
  try {
    const stat = await Deno.stat(CLIENT_BUNDLE_PATH);
    if (!stat.isFile) {
      console.warn(
        "[landing] public/client.js exists but is not a file; GET /client.js will not be available.",
      );
      return;
    }
    console.log("[landing] client bundle found at public/client.js");
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.warn(
        "[landing] public/client.js not found; GET /client.js will return 404 until the bundle is built.",
      );
      return;
    }
    throw err;
  }
}

export async function buildLandingRouter(
  db: Client,
  config: Config,
): Promise<Hono> {
  const directHandle = new DirectDbHandle(db);
  const useWorkerMetadata = Deno.env.get("D1_METADATA_ENABLED") === "1";

  await warnIfClientBundleMissing();

  const app = new Hono();

  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "overview";
    const q = c.req.query("q") ?? "";
    const page = Number.parseInt(c.req.query("page") ?? "1", 10);
    const reqUrl = new URL(c.req.url);
    const metadataBaseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
    const handle = useWorkerMetadata
      ? new MetaApiDbHandle(metadataBaseUrl)
      : directHandle;

    return c.html(
      <LandingPage
        db={handle}
        config={config}
        tab={tab}
        q={q}
        page={Number.isFinite(page) && page > 0 ? page : 1}
      />,
    );
  });

  return app;
}
