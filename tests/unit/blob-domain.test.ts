import { assertEquals } from "@std/assert";
import {
  blobReadResponse,
  classifyBlobRequest,
} from "../../worker/blob-domain.ts";

const HASH = "a".repeat(64);
const BLOB_DOMAIN = "blobs.staging.blossom.fanfares.live";

Deno.test("dedicated blob hostname accepts only canonical reads", () => {
  assertEquals(
    classifyBlobRequest(
      new URL(`https://${BLOB_DOMAIN}/${HASH}.png`),
      "GET",
      BLOB_DOMAIN,
    ),
    "blob",
  );
  assertEquals(
    classifyBlobRequest(
      new URL(`https://${BLOB_DOMAIN}/${HASH}`),
      "HEAD",
      BLOB_DOMAIN,
    ),
    "blob",
  );
  for (const path of ["/admin", "/upload", `/prefix-${HASH}.html`]) {
    assertEquals(
      classifyBlobRequest(
        new URL(`https://${BLOB_DOMAIN}${path}`),
        "GET",
        BLOB_DOMAIN,
      ),
      "reject",
    );
  }
  assertEquals(
    classifyBlobRequest(
      new URL(`https://${BLOB_DOMAIN}/%61${HASH.slice(1)}`),
      "GET",
      BLOB_DOMAIN,
    ),
    "reject",
  );
  assertEquals(
    classifyBlobRequest(
      new URL(`https://${BLOB_DOMAIN}/${HASH}`),
      "DELETE",
      BLOB_DOMAIN,
    ),
    "reject",
  );
});

Deno.test("API hostname redirects blob reads and keeps other routes", () => {
  const api = "staging.blossom.fanfares.live";
  assertEquals(
    classifyBlobRequest(new URL(`https://${api}/${HASH}`), "GET", BLOB_DOMAIN),
    "redirect",
  );
  assertEquals(
    classifyBlobRequest(new URL(`https://${api}/admin`), "GET", BLOB_DOMAIN),
    "normal",
  );
  assertEquals(
    classifyBlobRequest(
      new URL(`https://${api}/${HASH}`),
      "DELETE",
      BLOB_DOMAIN,
    ),
    "normal",
  );
});

Deno.test("legacy blob redirects allow public cross-origin browser reads", () => {
  for (const method of ["GET", "HEAD"]) {
    const response = blobReadResponse(
      new Request(`https://staging.blossom.fanfares.live/${HASH}.mpga`, {
        method,
        headers: { Origin: "https://staging.fanfares.io" },
      }),
      BLOB_DOMAIN,
    )!;
    assertEquals(response.status, 308);
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(
      response.headers.get("location"),
      `https://${BLOB_DOMAIN}/${HASH}.mpga`,
    );
    assertEquals(response.headers.get("cache-control"), "no-store");
    assertEquals(response.headers.has("set-cookie"), false);
  }
});
Deno.test("public blob preflights permit reads without enabling uploads or admin routes", () => {
  for (const hostname of [BLOB_DOMAIN, "staging.blossom.fanfares.live"]) {
    const response = blobReadResponse(
      new Request(`https://${hostname}/${HASH}.mpga`, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "range",
        },
      }),
      BLOB_DOMAIN,
    )!;
    assertEquals(response.status, 204);
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
    assertEquals(
      response.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
    assertEquals(
      blobReadResponse(
        new Request(`https://${hostname}/${HASH}`, {
          method: "OPTIONS",
          headers: { "Access-Control-Request-Method": "PUT" },
        }),
        BLOB_DOMAIN,
      )?.status,
      404,
    );
    assertEquals(
      blobReadResponse(
        new Request(`https://${hostname}/admin`, {
          method: "OPTIONS",
          headers: { "Access-Control-Request-Method": "GET" },
        }),
        BLOB_DOMAIN,
      ),
      null,
    );
  }
});
