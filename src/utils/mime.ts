import { extension as extFromMime } from "@std/media-types";

/**
 * Derive the stored file extension from a MIME type.
 * Returns "bin" for unknown types and application/octet-stream: extensionless
 * storage keys proved unreliable on the R2 deployment (uploads returned 201
 * but the object was never retrievable), so every blob now gets an extension.
 * The read path in routes/blobs.ts still tries the bare-hash key as a legacy
 * fallback for blobs stored before this change.
 * Uses @std/media-types for comprehensive MIME → extension coverage.
 */
export function mimeToExt(mime: string | null): string {
  if (!mime || mime === "application/octet-stream") return "bin";
  return extFromMime(mime) ?? "bin";
}

// RFC 6838 restricted names: an alphanumeric first character, then name chars.
// Commas, quotes, spaces and every other separator are excluded, so a value
// that matches can never be read as a list of types by a browser.
const MIME_NAME = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
const MIME_ESSENCE_RE = new RegExp(`^${MIME_NAME}/${MIME_NAME}$`);
// Parameters are only kept when each one is a plain token=token pair.
const MIME_PARAM_RE = new RegExp(`^(${MIME_NAME})=([a-z0-9!#$&^_.+-]+)$`);

/** A Content-Type value that parsed strictly as exactly one media type. */
export interface ParsedMime {
  /** Lowercase `type/subtype`, without parameters. */
  essence: string;
  /** Canonical header value: the essence plus any `; name=value` parameters. */
  value: string;
}

/**
 * Parse a Content-Type value strictly as exactly one `type/subtype`.
 *
 * Returns null for anything a browser might read differently from this
 * server: empty values, comma lists (including duplicated headers, which
 * arrive joined with ", "), quoted or malformed parameters, control or
 * non-ASCII characters. The result is lowercase except parameter values.
 *
 * @param value Raw Content-Type header or stored blob type.
 */
export function parseMimeType(
  value: string | null | undefined,
): ParsedMime | null {
  if (typeof value !== "string") return null;
  const [rawEssence, ...rawParams] = value.split(";");
  const essence = rawEssence.trim().toLowerCase();
  if (!MIME_ESSENCE_RE.test(essence)) return null;
  const params: string[] = [];
  for (const raw of rawParams) {
    const param = raw.trim();
    if (param === "") continue; // tolerate "text/plain;" and "a/b; ; c=d"
    if (!MIME_PARAM_RE.test(param.toLowerCase())) return null;
    const eq = param.indexOf("=");
    params.push(`${param.slice(0, eq).toLowerCase()}=${param.slice(eq + 1)}`);
  }
  return { essence, value: [essence, ...params].join("; ") };
}

/**
 * Normalize an incoming Content-Type for storage and storage-rule checks.
 *
 * Returns the lowercase essence of a strictly parsed type. Anything
 * malformed or multi-valued is stored as `application/octet-stream` instead
 * of being rejected, so no client that worked before breaks, and an unsafe
 * value can never reach the database (storage rules then decide whether
 * octet-stream is accepted at all).
 *
 * @param value Raw Content-Type or X-Content-Type header, or null if absent.
 */
export function normalizeIncomingMime(
  value: string | null | undefined,
): string {
  return parseMimeType(value)?.essence ?? "application/octet-stream";
}

/**
 * Return whether a media type may be shown inline on the blob host.
 *
 * Allowlist: raster images (any `image/*` whose subtype does not mention
 * XML, so SVG is excluded), `audio/*`, `video/*`, `text/plain` and
 * `application/octet-stream`. Every other type, including HTML, XML, XSL,
 * JavaScript, PDF and anything unknown, is served as a sandboxed download.
 *
 * @param essence Lowercase `type/subtype` from {@link parseMimeType}.
 */
export function isInlineSafeMime(essence: string): boolean {
  if (essence === "text/plain" || essence === "application/octet-stream") {
    return true;
  }
  const [type, subtype] = essence.split("/");
  if (type === "audio" || type === "video") return true;
  return type === "image" && !subtype.includes("xml");
}

/** How a blob response presents its bytes to the browser. */
export interface ServedType {
  /** Content-Type header to send. */
  contentType: string;
  /** True when the blob must be an attachment inside a CSP sandbox. */
  download: boolean;
}

/**
 * Decide the Content-Type and disposition for serving a stored blob type.
 *
 * A strictly parsed, allowlisted type is served inline as its canonical
 * value. A strictly parsed type outside the allowlist keeps its canonical
 * value but becomes a download. Anything that does not parse strictly is a
 * download sent as `application/octet-stream`, so the original string never
 * reaches the browser.
 *
 * @param value Stored or resolved Content-Type, possibly with parameters.
 */
export function resolveServedType(
  value: string | null | undefined,
): ServedType {
  const parsed = parseMimeType(value);
  if (!parsed) {
    return { contentType: "application/octet-stream", download: true };
  }
  return {
    contentType: parsed.value,
    download: !isInlineSafeMime(parsed.essence),
  };
}
