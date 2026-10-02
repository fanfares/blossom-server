/** Browser artwork bytes may be stored, but every reuse must check current access. */
export const ARTWORK_CACHE_CONTROL = "private, no-cache, must-revalidate";

/** Select the public read policy from stored MIME metadata, never the requested extension. */
export function blobCacheControl(mimeType: string | null | undefined): string {
  const type = (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
  // Active documents and non-image downloads keep the existing no-store policy.
  return type.startsWith("image/") && type !== "image/svg+xml" &&
      !type.endsWith("+xml")
    ? ARTWORK_CACHE_CONTROL
    : "no-store";
}

/** Compare GET/HEAD validators against the content hash using HTTP's weak comparison. */
export function matchesBlobETag(
  header: string | undefined,
  hash: string,
): boolean {
  return header?.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === `"${hash}"`;
  }) ?? false;
}
