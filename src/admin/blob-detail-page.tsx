/** @jsxImportSource @hono/hono/jsx */
import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import type { Config } from "../config/schema.ts";
import { mimeToExt } from "../utils/mime.ts";
import { nip19 } from "nostr-tools";
import { getEventKindLabel } from "./event-index.ts";
import {
  AdminLayout,
  Badge,
  formatBytes,
  formatDate,
  PageHeader,
  truncateHash,
} from "./layout.tsx";

function getBlobUrl(
  sha256: string,
  type: string | null,
  config: Config,
  host: string,
): string {
  const ext = mimeToExt(type);
  const base = config.publicDomain
    ? `https://${config.publicDomain.replace(/\/$/, "")}`
    : `http://${host}`;
  return `${base}/${sha256}${ext ? "." + ext : ""}`;
}

interface BlobDetailPageProps {
  db: IDbHandle;
  config: Config;
  host: string;
  sha256: string;
  quarantined?: boolean;
  moderationHistory?: {
    action: string;
    actor: string;
    reason: string;
    createdAt: number;
  }[];
}

export const BlobDetailPage: FC<BlobDetailPageProps> = async (
  { db, config, host, sha256, quarantined = false, moderationHistory = [] },
) => {
  const blob = await db.getBlob(sha256);

  if (!blob) {
    return (
      <AdminLayout title="Blob not found" section="blobs">
        <PageHeader title="Blob not found" />
        <p class="text-gray-400 text-sm">
          No blob with hash{" "}
          <code class="font-mono text-cyan-200/75">{sha256}</code> exists.
        </p>
        <a
          href="/admin/blobs"
          class="mt-4 inline-block text-sm text-gray-500 hover:text-gray-300"
        >
          ← Back to Blobs
        </a>
      </AdminLayout>
    );
  }

  const blobsWithOwners = await db.listAllBlobs({
    filter: { q: sha256 },
    limit: 1,
  });
  const owners = blobsWithOwners[0]?.sha256 === sha256
    ? blobsWithOwners[0].owners
    : [];
  const events = blobsWithOwners[0]?.sha256 === sha256
    ? blobsWithOwners[0].events
    : [];

  const blobUrl = getBlobUrl(blob.sha256, blob.type, config, host);
  const mime = blob.type ?? "";

  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");
  const isAudio = mime.startsWith("audio/");

  return (
    <AdminLayout title={`Blob ${truncateHash(sha256)}`} section="blobs">
      <div class="mb-4">
        <a
          href="/admin/blobs"
          class="text-sm text-gray-500 hover:text-gray-300"
        >
          ← Back to Blobs
        </a>
      </div>

      <PageHeader title={`Blob ${truncateHash(sha256)}`} />

      <div class="admin-moderation-actions">
        <span>
          {quarantined
            ? "Quarantined · Public access blocked · Bytes retained"
            : "Public access enabled"}
        </span>
        <a href={`/admin/quarantine?scope=file&id=${sha256}`}>
          {quarantined ? "Review and restore access" : "Quarantine file"}
        </a>
      </div>
      {moderationHistory.length > 0 && (
        <details class="mb-5">
          <summary>Moderation history</summary>
          <ul>
            {moderationHistory.map((entry) => (
              <li class="mt-3 text-sm text-gray-400">
                <strong>{entry.action}</strong> · {formatDate(entry.createdAt)}
                {" "}
                · {truncateHash(entry.actor)}
                <p>{entry.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Metadata card */}
        <div class="space-y-4 rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.25)] backdrop-blur-sm">
          <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Details
          </h2>

          <dl class="space-y-3">
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">SHA-256</dt>
              <dd class="font-mono text-xs text-gray-200 break-all">
                {blob.sha256}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">MIME Type</dt>
              <dd>
                {blob.type
                  ? <Badge color="purple">{blob.type}</Badge>
                  : <span class="text-gray-600 text-sm">—</span>}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">Size</dt>
              <dd class="text-sm text-gray-200">{formatBytes(blob.size)}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">Uploaded</dt>
              <dd class="text-sm text-gray-200">{formatDate(blob.uploaded)}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">
                Owners ({owners.length})
              </dt>
              <dd class="space-y-1 mt-1">
                {owners.length === 0
                  ? <span class="text-gray-600 text-sm">No owners</span>
                  : (
                    owners.map((pk) => (
                      <div key={pk}>
                        <a
                          href={`/admin/users?q=${pk}`}
                          class="break-all font-mono text-xs text-cyan-200/75 transition-colors hover:text-cyan-100"
                        >
                          {pk}
                        </a>
                        <div class="font-mono text-xs text-gray-600 break-all">
                          {nip19.npubEncode(pk)}
                        </div>
                      </div>
                    ))
                  )}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">
                Related events ({events.length})
              </dt>
              <dd class="space-y-2 mt-1">
                {events.length === 0
                  ? <span class="text-gray-600 text-sm">Not indexed</span>
                  : events.map((event) => (
                    <div
                      key={event.id}
                      class="rounded border border-gray-800 p-2"
                    >
                      <a
                        href={`/admin/blobs?q=${event.id}`}
                        class="break-all font-mono text-xs text-cyan-200/75 hover:text-cyan-100"
                      >
                        {event.id}
                      </a>
                      <div class="mt-1 flex gap-2 text-xs text-gray-500">
                        <span>{getEventKindLabel(event.kind)}</span>
                        <Badge color={event.encrypted ? "yellow" : "green"}>
                          {event.encrypted ? "encrypted" : "public"}
                        </Badge>
                      </div>
                      <a
                        href={`/admin/users?q=${event.pubkey}`}
                        class="mt-1 block font-mono text-xs text-gray-500 hover:text-gray-300 break-all"
                      >
                        author {event.pubkey}
                      </a>
                    </div>
                  ))}
              </dd>
            </div>
          </dl>

          <div class="pt-2 flex gap-2">
            <a
              href={blobUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs transition-colors border border-gray-700"
            >
              View raw ↗
            </a>
          </div>
        </div>

        {/* Preview card */}
        <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.25)] backdrop-blur-sm">
          <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
            Preview
          </h2>
          {!quarantined && isImage && (
            <img
              src={blobUrl}
              alt={blob.sha256}
              class="max-w-full max-h-96 object-contain rounded border border-gray-800"
            />
          )}
          {!quarantined && isVideo && (
            <video
              src={blobUrl}
              controls
              class="max-w-full max-h-96 rounded border border-gray-800"
            />
          )}
          {!quarantined && isAudio && (
            <audio src={blobUrl} controls class="w-full mt-2" />
          )}
          {quarantined && (
            <p class="text-sm text-gray-400">
              Preview disabled while quarantined.
            </p>
          )}
          {!quarantined && !isImage && !isVideo && !isAudio && (
            <div class="py-8 text-center">
              <p class="text-gray-500 text-sm mb-3">
                No preview available for this file type.
              </p>
              <a
                href={blobUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="text-sm text-cyan-200/75 transition-colors hover:text-cyan-100"
              >
                Open file ↗
              </a>
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
};
