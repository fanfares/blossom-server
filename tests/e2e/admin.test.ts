/**
 * @flow Nostr admin authentication → password verification → moderation dashboard
 * @covers Protected routes, NIP-07 challenge login, second-factor password, signed session, and logout
 * @type e2e | deno
 * @pages /admin/login, /admin/password, /admin/blobs
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { NostrEvent } from "nostr-tools";
import { initDb } from "../../src/db/client.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { buildApp } from "../../src/server.ts";
import {
  ADMIN_CHALLENGE_COOKIE,
  ADMIN_FACTOR_COOKIE,
  ADMIN_SESSION_COOKIE,
} from "../../src/admin/admin-auth.ts";

/** Extracts the cookie pair a browser would retain from one Set-Cookie response. */
function responseCookie(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((value) =>
    value.startsWith(`${name}=`)
  );
  assert(header, "Expected the response to set a cookie");
  return header.split(";")[0];
}

Deno.test({
  name: "admin dashboard requires both authentication factors",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "blossom_admin_e2e_" });
    const db = await initDb({ path: join(tmpDir, "test.db") });
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const password = "correct-admin-password";
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      landing: { enabled: false },
      dashboard: {
        enabled: true,
        password,
        sessionSecret: "e2e-admin-session-secret-32-characters",
        adminPubkeys: [pubkey],
        lookupRelays: [],
      },
    });
    const app = await buildApp(db, storage, config);

    try {
      const protectedResponse = await app.fetch(
        new Request("http://localhost/admin/blobs"),
      );
      assertEquals(protectedResponse.status, 303);
      assertEquals(protectedResponse.headers.get("location"), "/admin/login");

      const challengeResponse = await app.fetch(
        new Request("http://localhost/admin/auth/challenge"),
      );
      assertEquals(challengeResponse.status, 200);
      const challengeCookie = responseCookie(
        challengeResponse,
        ADMIN_CHALLENGE_COOKIE,
      );
      const template = await challengeResponse.json() as Omit<
        NostrEvent,
        "id" | "pubkey" | "sig"
      >;
      const event = finalizeEvent(template, secretKey);

      const nostrResponse = await app.fetch(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: challengeCookie,
            origin: "http://localhost",
          },
          body: JSON.stringify({ event }),
        }),
      );
      assertEquals(nostrResponse.status, 200);
      const factorCookie = responseCookie(nostrResponse, ADMIN_FACTOR_COOKIE);
      assertEquals((await nostrResponse.json()).redirect, "/admin/password");

      const replayResponse = await app.fetch(
        new Request("http://localhost/admin/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: challengeCookie,
            origin: "http://localhost",
          },
          body: JSON.stringify({ event }),
        }),
      );
      assertEquals(replayResponse.status, 403);

      const crossSitePasswordResponse = await app.fetch(
        new Request("http://localhost/admin/password", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: factorCookie,
            origin: "https://attacker.example",
            "sec-fetch-site": "cross-site",
          },
          body: new URLSearchParams({ password }),
        }),
      );
      assertEquals(crossSitePasswordResponse.status, 403);

      const passwordResponse = await app.fetch(
        new Request("http://localhost/admin/password", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: factorCookie,
            "sec-fetch-site": "same-origin",
          },
          body: new URLSearchParams({ password }),
        }),
      );
      assertEquals(passwordResponse.status, 303);
      const sessionCookie = responseCookie(
        passwordResponse,
        ADMIN_SESSION_COOKIE,
      );

      const dashboardResponse = await app.fetch(
        new Request("http://localhost/admin/blobs", {
          headers: { cookie: sessionCookie },
        }),
      );
      assertEquals(dashboardResponse.status, 200);
      assertStringIncludes(await dashboardResponse.text(), "Inspect event");
    } finally {
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
});
