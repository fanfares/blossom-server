/**
 * @module dns-over-https
 * @covers
 *   - Parallel A and AAAA resolution through the configured DoH endpoint
 *   - CNAME filtering and fail-closed upstream error handling
 * @dependencies fetch implementation (mocked)
 * @type unit | deno
 */

import { assertEquals, assertRejects } from "@std/assert";
import { resolveHostnameWithDoh } from "../../src/utils/dns-over-https.ts";

Deno.test("resolveHostnameWithDoh returns only A and AAAA address answers", async () => {
  const fetcher = (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    assertEquals(init?.redirect, "error");
    assertEquals(init?.headers, { Accept: "application/dns-json" });
    const isIPv4Query = url.searchParams.get("type") === "A";
    return Promise.resolve(Response.json({
      Answer: isIPv4Query
        ? [
          { type: 5, data: "alias.example." },
          { type: 1, data: " 93.184.216.34 " },
        ]
        : [{ type: 28, data: "2606:4700:4700::1111" }],
    }));
  };

  const answers = await resolveHostnameWithDoh("cdn.example", fetcher);

  assertEquals(answers, ["93.184.216.34", "2606:4700:4700::1111"]);
});

Deno.test("resolveHostnameWithDoh rejects when either DNS query fails", async () => {
  const fetcher = (input: string | URL): Promise<Response> => {
    const url = new URL(input);
    return Promise.resolve(
      url.searchParams.get("type") === "AAAA"
        ? new Response(null, { status: 503 })
        : Response.json({ Answer: [{ type: 1, data: "93.184.216.34" }] }),
    );
  };

  await assertRejects(
    () => resolveHostnameWithDoh("cdn.example", fetcher),
    Error,
    "DNS resolution failed",
  );
});
