import { assertEquals } from "@std/assert";
import { classifyBlobRequest } from "../../worker/blob-domain.ts";

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
