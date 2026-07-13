/**
 * @module public-http
 * @covers
 *   - Private, reserved, mapped, unique-local, and link-local address rejection
 *   - DNS answer validation for mirror hostnames
 *   - Manual redirect validation before each outbound fetch
 *   - Redirect limits and connect-header timeout handling
 * @dependencies DNS resolver and fetch implementation (mocked)
 * @type unit | deno
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  assertPublicHttpUrl,
  fetchPublicHttpUrl,
  isBlockedNetworkHostname,
} from "../../src/utils/public-http.ts";

Deno.test("isBlockedNetworkHostname rejects private and special-use network targets", () => {
  for (
    const hostname of [
      "localhost",
      "service.internal",
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
    ]
  ) {
    assertEquals(isBlockedNetworkHostname(hostname), true, hostname);
  }
});

Deno.test("isBlockedNetworkHostname allows representative public IPv4 and IPv6 targets", () => {
  for (
    const hostname of [
      "1.1.1.1",
      "8.8.8.8",
      "[2606:4700:4700::1111]",
      "cdn.example.com",
    ]
  ) {
    assertEquals(isBlockedNetworkHostname(hostname), false, hostname);
  }
});

Deno.test("assertPublicHttpUrl rejects a hostname when any DNS answer is private", async () => {
  await assertRejects(
    () =>
      assertPublicHttpUrl(
        new URL("https://attacker.example/blob"),
        () => Promise.resolve(["93.184.216.34", "169.254.169.254"]),
      ),
    Error,
    "resolves to a non-public address",
  );
});

Deno.test("assertPublicHttpUrl fails closed when DNS returns no addresses", async () => {
  await assertRejects(
    () =>
      assertPublicHttpUrl(
        new URL("https://missing.example/blob"),
        () => Promise.resolve([]),
      ),
    Error,
    "Unable to validate mirror hostname",
  );
});

Deno.test("fetchPublicHttpUrl follows a public redirect with manual redirect mode", async () => {
  const fetchedUrls: string[] = [];
  const fetcher = (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    fetchedUrls.push(input.toString());
    assertEquals(init?.redirect, "manual");
    if (fetchedUrls.length === 1) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        }),
      );
    }
    return Promise.resolve(new Response("blob", { status: 200 }));
  };

  const response = await fetchPublicHttpUrl(
    new URL("https://origin.example/blob"),
    {
      connectTimeoutMs: 1_000,
      fetcher,
      resolver: () => Promise.resolve(["1.1.1.1"]),
    },
  );

  assertEquals(response.status, 200);
  assertEquals(fetchedUrls, [
    "https://origin.example/blob",
    "https://cdn.example/final",
  ]);
});

Deno.test("fetchPublicHttpUrl rejects a redirect to a private address before fetching it", async () => {
  let fetchCount = 0;
  const fetcher = (): Promise<Response> => {
    fetchCount += 1;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      }),
    );
  };

  await assertRejects(
    () =>
      fetchPublicHttpUrl(new URL("https://origin.example/blob"), {
        connectTimeoutMs: 1_000,
        fetcher,
        resolver: () => Promise.resolve(["1.1.1.1"]),
      }),
    Error,
    "non-public address",
  );
  assertEquals(fetchCount, 1);
});

Deno.test("fetchPublicHttpUrl enforces the configured redirect limit", async () => {
  let fetchCount = 0;
  const fetcher = (): Promise<Response> => {
    fetchCount += 1;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: `https://origin.example/${fetchCount}` },
      }),
    );
  };

  await assertRejects(
    () =>
      fetchPublicHttpUrl(new URL("https://origin.example/blob"), {
        connectTimeoutMs: 1_000,
        fetcher,
        resolver: () => Promise.resolve(["1.1.1.1"]),
        maxRedirects: 1,
      }),
    Error,
    "exceeded 1 redirects",
  );
  assertEquals(fetchCount, 2);
});

Deno.test("fetchPublicHttpUrl reports a connect timeout while waiting for headers", async () => {
  const fetcher = (
    _input: string | URL,
    init?: RequestInit,
  ): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")));
    });

  await assertRejects(
    () =>
      fetchPublicHttpUrl(new URL("https://origin.example/blob"), {
        connectTimeoutMs: 5,
        fetcher,
        resolver: () => Promise.resolve(["1.1.1.1"]),
      }),
    Error,
    "did not respond within 5ms",
  );
});
