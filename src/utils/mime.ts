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
