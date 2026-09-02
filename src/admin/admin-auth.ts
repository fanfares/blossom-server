import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { NostrEvent } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

export const ADMIN_SESSION_COOKIE = "blossom_admin_session";
export const ADMIN_FACTOR_COOKIE = "blossom_admin_nostr_factor";
export const ADMIN_CHALLENGE_COOKIE = "blossom_admin_challenge";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOGIN_KIND = 27235;

interface AuthToken {
  purpose: "challenge" | "nostr-factor" | "session";
  pubkey?: string;
  nonce?: string;
  exp: number;
}

/** Signs short-lived admin state so challenges and sessions need no server-side store. */
export async function signAdminToken(
  token: AuthToken,
  secret: string,
): Promise<string> {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(token)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Verifies a signed admin token, its purpose, and its absolute expiration. */
export async function verifyAdminToken(
  value: string | undefined,
  purpose: AuthToken["purpose"],
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AuthToken | null> {
  if (!value) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;
    const token = JSON.parse(
      decoder.decode(decodeBase64Url(payload)),
    ) as AuthToken;
    return token.purpose === purpose && token.exp >= now ? token : null;
  } catch {
    return null;
  }
}

/** Creates the unsigned NIP-07 event template bound to one login challenge and origin. */
export function createAdminLoginTemplate(
  nonce: string,
  origin: string,
  now = Math.floor(Date.now() / 1000),
): Omit<NostrEvent, "id" | "pubkey" | "sig"> {
  return {
    kind: LOGIN_KIND,
    created_at: now,
    content: "Authenticate to the Blossom moderation dashboard",
    tags: [["u", `${origin}/admin/login`], ["method", "POST"], [
      "challenge",
      nonce,
    ]],
  };
}

/** Validates the NIP-07 factor against its challenge, origin, time window, and admin allowlist. */
export function verifyAdminLoginEvent(
  event: NostrEvent,
  nonce: string,
  origin: string,
  adminPubkeys: string[],
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (
    !event || typeof event !== "object" ||
    typeof event.pubkey !== "string" || !/^[a-f0-9]{64}$/i.test(event.pubkey) ||
    !Array.isArray(event.tags)
  ) {
    return false;
  }
  const expectedUrl = `${origin}/admin/login`;
  return event.kind === LOGIN_KIND &&
    Math.abs(event.created_at - now) <= 60 &&
    adminPubkeys.some((pubkey) =>
      pubkey.toLowerCase() === event.pubkey.toLowerCase()
    ) &&
    event.tags.some((tag) => tag[0] === "u" && tag[1] === expectedUrl) &&
    event.tags.some((tag) => tag[0] === "method" && tag[1] === "POST") &&
    event.tags.some((tag) => tag[0] === "challenge" && tag[1] === nonce) &&
    verifyEvent(event);
}

/** Compares passwords over fixed-length SHA-256 digests to avoid timing leakage. */
export async function constantTimePasswordEqual(
  supplied: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
