/** Decide which requests may reach the app on the dedicated blob hostname. */
export function classifyBlobRequest(
  url: URL,
  method: string,
  blobDomain: string,
): "blob" | "redirect" | "reject" | "normal" {
  if (!blobDomain) return "normal";
  const blobHost = url.hostname.toLowerCase() === blobDomain.toLowerCase();
  const blobPath = /^\/[a-f0-9]{64}(?:\.[A-Za-z0-9]+)?$/.test(url.pathname);
  const read = method === "GET" || method === "HEAD";
  if (blobHost) return blobPath && read ? "blob" : "reject";
  return blobPath && read ? "redirect" : "normal";
}

/** Public read responses must support browser fetch on every redirect hop. */
export function blobReadResponse(
  request: Request,
  blobDomain: string,
): Response | null {
  if (!blobDomain) return null;
  const url = new URL(request.url);
  const canonical = /^\/[a-f0-9]{64}(?:\.[A-Za-z0-9]+)?$/.test(url.pathname);
  if (canonical && request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Authorization, Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (classifyBlobRequest(url, request.method, blobDomain) !== "redirect") {
    return null;
  }
  url.hostname = blobDomain;
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
