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

/**
 * Return whether a stored MIME type is a document a browser would execute.
 *
 * HTML, XML, every `+xml` subtype (SVG, XHTML, ...) and
 * `multipart/x-mixed-replace` can run script in the serving origin when a
 * browser opens them directly. Blob routes serve these as downloads so an
 * uploaded file can never act as a page on this host. Ordinary media
 * (images, audio, video, plain text) stays inline. Matches upstream
 * blossom-server 6.4.1.
 *
 * @param value Stored or resolved Content-Type, possibly with parameters.
 */
export function isActiveContentMime(value: string | null | undefined): boolean {
  const baseMime = value?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (
    baseMime === "text/html" ||
    baseMime === "text/xml" ||
    baseMime === "application/xml" ||
    baseMime === "multipart/x-mixed-replace"
  ) {
    return true;
  }
  const slash = baseMime.indexOf("/");
  return slash > 0 && baseMime.endsWith("+xml") &&
    baseMime.length - 4 > slash + 1;
}
