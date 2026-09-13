import { assertEquals, assertRejects } from "@std/assert";
import { createServer } from "node:http";
import { fetchPinnedHttp } from "../../src/utils/pinned-http.ts";

Deno.test("pinned transport uses supplied address without resolving the original hostname and preserves Host", async () => {
  let host = "";
  const server = createServer((request, response) => {
    host = request.headers.host ?? "";
    response.end("pinned");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test port");
  }
  try {
    // This lower-level transport test uses loopback solely to serve its fixture.
    // PublicHttpUrl validates and rejects loopback before invoking transport.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetchPinnedHttp(
        new URL(`http://does-not-resolve.invalid:${address.port}/blob`),
        ["127.0.0.1"],
        { signal: controller.signal },
      );
      assertEquals(await response.text(), "pinned");
      assertEquals(host, `does-not-resolve.invalid:${address.port}`);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

Deno.test("pinned HTTPS transport verifies original hostname against a trusted test certificate", async () => {
  const cert = await Deno.readTextFile(
    new URL("../fixtures/pinned-http-cert.pem", import.meta.url),
  );
  const ca = await Deno.readTextFile(
    new URL("../fixtures/pinned-http-ca.pem", import.meta.url),
  );
  const key = await Deno.readTextFile(
    new URL("../fixtures/pinned-http-key.pem", import.meta.url),
  );
  const controller = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert,
    key,
    signal: controller.signal,
    onListen: () => {},
  }, () => new Response("tls-pinned"));
  try {
    const response = await fetchPinnedHttp(
      new URL(`https://origin.test:${server.addr.port}/`),
      ["127.0.0.1"],
      { signal: AbortSignal.timeout(1000) },
      { caCerts: [ca] },
    );
    assertEquals(await response.text(), "tls-pinned");
    await assertRejects(() =>
      fetchPinnedHttp(
        new URL(`https://wrong.test:${server.addr.port}/`),
        ["127.0.0.1"],
        { signal: AbortSignal.timeout(1000) },
        { caCerts: [ca] },
      )
    );
  } finally {
    controller.abort();
    await server.finished;
  }
});
