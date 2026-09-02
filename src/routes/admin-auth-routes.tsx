/** @jsxImportSource @hono/hono/jsx */
import type { Hono } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import type { NostrEvent } from "nostr-tools";
import type { Config } from "../config/schema.ts";
import { LoginPage } from "../admin/login-page.tsx";
import {
  ADMIN_CHALLENGE_COOKIE,
  ADMIN_FACTOR_COOKIE,
  ADMIN_SESSION_COOKIE,
  constantTimePasswordEqual,
  createAdminLoginTemplate,
  signAdminToken,
  verifyAdminLoginEvent,
  verifyAdminToken,
} from "../admin/admin-auth.ts";

const SESSION_SECONDS = 8 * 60 * 60;
const FACTOR_SECONDS = 5 * 60;
const CHALLENGE_SECONDS = 2 * 60;
const passwordFailures = new Map<
  string,
  { count: number; blockedUntil: number }
>();
const usedChallenges = new Map<string, number>();
const MAX_TRACKED_CHALLENGES = 10_000;

/** Returns hardened cookie options shared by every credential in the admin flow. */
function cookieOptions(
  c: { req: { url: string } },
  maxAge: number,
  publicDomain: string,
) {
  const configuredHost = publicDomain.split(":")[0].toLowerCase();
  const isLocal = configuredHost === "localhost" ||
    configuredHost === "127.0.0.1" || configuredHost === "::1";
  return {
    httpOnly: true,
    secure: !isLocal || new URL(c.req.url).protocol === "https:",
    sameSite: "Strict" as const,
    path: "/admin",
    maxAge,
  };
}

/** Accepts explicit or browser-verified same-origin mutations while rejecting cross-site requests. */
function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin) return origin === requestOrigin;

  // Some browsers omit Origin on an ordinary same-origin HTML form POST. The
  // Fetch Metadata header is browser-controlled and cannot be forged by page
  // JavaScript, so it safely covers that form-navigation case.
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;

  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === requestOrigin;
  } catch {
    return false;
  }
}

/** Consumes a challenge once and clears expired replay markers opportunistically. */
function consumeChallenge(nonce: string, expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, expiry] of usedChallenges) {
    if (expiry < now) usedChallenges.delete(key);
  }
  if (usedChallenges.has(nonce)) return false;
  if (usedChallenges.size >= MAX_TRACKED_CHALLENGES) return false;
  usedChallenges.set(nonce, expiresAt);
  return true;
}

/** Registers public factor routes, then installs the session gate for all later admin routes. */
export function registerAdminAuthentication(app: Hono, config: Config): void {
  app.use("*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "same-origin");
    c.header("x-content-type-options", "nosniff");
    c.header("x-frame-options", "DENY");
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  app.get("/login", (c) => c.html(<LoginPage step="nostr" />));
  app.get("/auth/challenge", async (c) => {
    const nonce = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const token = await signAdminToken(
      { purpose: "challenge", nonce, exp: now + CHALLENGE_SECONDS },
      config.dashboard.sessionSecret,
    );
    setCookie(
      c,
      ADMIN_CHALLENGE_COOKIE,
      token,
      cookieOptions(c, CHALLENGE_SECONDS, config.publicDomain),
    );
    return c.json(
      createAdminLoginTemplate(nonce, new URL(c.req.url).origin, now),
    );
  });

  app.post("/login", async (c) => {
    if (!hasValidOrigin(c.req.raw)) {
      return c.json({ error: "Invalid request origin." }, 403);
    }
    const challenge = await verifyAdminToken(
      getCookie(c, ADMIN_CHALLENGE_COOKIE),
      "challenge",
      config.dashboard.sessionSecret,
    );
    let event: NostrEvent;
    try {
      event = (await c.req.json<{ event: NostrEvent }>()).event;
    } catch {
      return c.json({ error: "Invalid login request." }, 400);
    }
    if (
      !challenge?.nonce ||
      !verifyAdminLoginEvent(
        event,
        challenge.nonce,
        new URL(c.req.url).origin,
        config.dashboard.adminPubkeys,
      ) ||
      !consumeChallenge(challenge.nonce, challenge.exp)
    ) {
      return c.json({ error: "This Nostr identity is not authorized." }, 403);
    }
    deleteCookie(c, ADMIN_CHALLENGE_COOKIE, { path: "/admin" });
    const now = Math.floor(Date.now() / 1000);
    setCookie(
      c,
      ADMIN_FACTOR_COOKIE,
      await signAdminToken(
        {
          purpose: "nostr-factor",
          pubkey: event.pubkey,
          exp: now + FACTOR_SECONDS,
        },
        config.dashboard.sessionSecret,
      ),
      cookieOptions(c, FACTOR_SECONDS, config.publicDomain),
    );
    return c.json({ redirect: "/admin/password" });
  });

  app.get("/password", async (c) => {
    const factor = await verifyAdminToken(
      getCookie(c, ADMIN_FACTOR_COOKIE),
      "nostr-factor",
      config.dashboard.sessionSecret,
    );
    return factor?.pubkey
      ? c.html(<LoginPage step="password" pubkey={factor.pubkey} />)
      : c.redirect("/admin/login", 303);
  });

  app.post("/password", async (c) => {
    if (!hasValidOrigin(c.req.raw)) return c.text("Forbidden", 403);
    const factor = await verifyAdminToken(
      getCookie(c, ADMIN_FACTOR_COOKIE),
      "nostr-factor",
      config.dashboard.sessionSecret,
    );
    if (!factor?.pubkey) return c.redirect("/admin/login", 303);
    const now = Math.floor(Date.now() / 1000);
    const failures = passwordFailures.get(factor.pubkey);
    if (failures && failures.blockedUntil > now) {
      return c.html(
        <LoginPage
          step="password"
          pubkey={factor.pubkey}
          error="Too many attempts. Try again in 15 minutes."
        />,
        429,
      );
    }
    const body = await c.req.parseBody();
    const password = typeof body.password === "string" ? body.password : "";
    if (
      !(await constantTimePasswordEqual(password, config.dashboard.password))
    ) {
      const count = (failures?.count ?? 0) + 1;
      passwordFailures.set(factor.pubkey, {
        count,
        blockedUntil: count >= 5 ? now + 15 * 60 : 0,
      });
      return c.html(
        <LoginPage
          step="password"
          pubkey={factor.pubkey}
          error="Incorrect password."
        />,
        401,
      );
    }
    passwordFailures.delete(factor.pubkey);
    deleteCookie(c, ADMIN_FACTOR_COOKIE, { path: "/admin" });
    setCookie(
      c,
      ADMIN_SESSION_COOKIE,
      await signAdminToken(
        {
          purpose: "session",
          pubkey: factor.pubkey,
          exp: now + SESSION_SECONDS,
        },
        config.dashboard.sessionSecret,
      ),
      cookieOptions(c, SESSION_SECONDS, config.publicDomain),
    );
    return c.redirect("/admin/blobs", 303);
  });

  app.use("*", async (c, next) => {
    const session = await verifyAdminToken(
      getCookie(c, ADMIN_SESSION_COOKIE),
      "session",
      config.dashboard.sessionSecret,
    );
    const isCurrentAdmin = session?.pubkey &&
      config.dashboard.adminPubkeys.some(
        (pubkey) => pubkey.toLowerCase() === session.pubkey?.toLowerCase(),
      );
    if (!isCurrentAdmin) {
      return c.req.path.includes("/api/")
        ? c.json({ error: "Admin session required." }, 401)
        : c.redirect("/admin/login", 303);
    }
    if (
      !hasValidOrigin(c.req.raw) && c.req.method !== "GET" &&
      c.req.method !== "HEAD"
    ) {
      return c.json({ error: "Invalid request origin." }, 403);
    }
    await next();
  });

  app.post("/logout", (c) => {
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: "/admin" });
    return c.redirect("/admin/login", 303);
  });
}
