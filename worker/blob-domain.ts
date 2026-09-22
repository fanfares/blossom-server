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
