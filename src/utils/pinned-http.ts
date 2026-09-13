import { isIP } from "node:net";

/**
 * Deno's TCP fetch override is plaintext even for HTTPS URLs. For HTTPS,
 * bridge its HTTP stream to a TLS connection established against the validated
 * IP and verified using the original hostname. Fetch still owns HTTP parsing.
 */
export async function fetchPinnedHttp(
  url: URL,
  addresses: readonly string[],
  init?: RequestInit,
  tlsOptions: { caCerts?: string[] } = {},
): Promise<Response> {
  if (!addresses.length || addresses.some((address) => !isIP(address))) {
    throw new Error("No validated IP addresses for outbound request");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  let listener: Deno.TcpListener | undefined;
  let local: Deno.TcpConn | undefined;
  let remote: Deno.TcpConn | Deno.TlsConn | undefined;
  let closed = false;
  let disposed = false;
  let bridgeError: unknown;
  const closeConnections = () => {
    closed = true;
    for (const resource of [listener, local, remote]) {
      try {
        resource?.close();
      } catch { /* already closed */ }
    }
  };
  let hostname = addresses[0];
  let transportPort = port;
  if (url.protocol === "https:") {
    listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    hostname = "127.0.0.1";
    transportPort = listener.addr.port;
  }
  const client = Deno.createHttpClient({
    proxy: { transport: "tcp", hostname, port: transportPort },
    poolMaxIdlePerHost: 0,
    http2: false,
  });
  const close = () => {
    if (disposed) return;
    disposed = true;
    closeConnections();
    client.close();
    init?.signal?.removeEventListener("abort", close);
  };
  init?.signal?.addEventListener("abort", close, { once: true });
  if (init?.signal?.aborted) close();
  if (listener) {
    const bridge = async () => {
      local = await listener!.accept();
      listener!.close();
      const tcp = await Deno.connect({ hostname: addresses[0], port });
      if (closed) {
        tcp.close();
        return;
      }
      remote = tcp;
      remote = await Deno.startTls(tcp, {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        alpnProtocols: ["http/1.1"],
        caCerts: tlsOptions.caCerts,
      });
      if (closed) {
        remote.close();
        return;
      }
      await Promise.all([
        local.readable.pipeTo(remote.writable),
        remote.readable.pipeTo(local.writable),
      ]);
    };
    bridge().catch((error) => {
      bridgeError = error;
      // Closing the bridge propagates connect/TLS failures into fetch.
      closeConnections();
    });
  }
  try {
    const options: RequestInit & { client: Deno.HttpClient } = {
      ...init,
      redirect: "manual",
      client,
    };
    const response = await fetch(url, options);
    if (!response.body) {
      close();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              close();
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            close();
          }
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  } catch (error) {
    close();
    throw bridgeError ?? error;
  }
}
