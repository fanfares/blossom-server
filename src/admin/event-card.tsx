/** @jsxImportSource @hono/hono/jsx */
import type { FC } from "@hono/hono/jsx";
import { nip19 } from "nostr-tools";
import type { AdminEventGroup, AdminProfileSummary } from "./event-index.ts";
import { getEventKindLabel } from "./event-index.ts";
import {
  getFanfaresEventUrl,
  getFanfaresProfileUrl,
} from "./fanfares-links.ts";
import { Badge, formatBytes, formatDate, truncateHash } from "./layout.tsx";
import { mimeToExt } from "../utils/mime.ts";

interface EventCardProps {
  group: AdminEventGroup;
  profile?: AdminProfileSummary;
  publicDomain: string;
  blobBaseUrl: string;
}

function safeImageUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export const EventCard: FC<EventCardProps> = (
  { group, profile, publicDomain, blobBaseUrl },
) => {
  const authorName = profile?.displayName || profile?.display_name ||
    profile?.name || `Publisher ${group.event.pubkey.slice(0, 8)}…`;
  const avatar = safeImageUrl(profile?.picture || profile?.image);
  const npub = nip19.npubEncode(group.event.pubkey);
  const summary = group.event.tags.find((tag) => tag[0] === "summary")?.[1] ||
    (group.event.content.length <= 280 ? group.event.content : "");
  const preview = group.blobs.find(({ blob, reference }) =>
    !reference.encrypted && blob.type?.startsWith("image/")
  );
  const previewUrl = preview
    ? `${blobBaseUrl}/${preview.blob.sha256}${
      mimeToExt(preview.blob.type) ? `.${mimeToExt(preview.blob.type)}` : ""
    }`
    : null;

  return (
    <article class="overflow-hidden rounded-3xl border border-cyan-400/20 bg-white/[0.04] shadow-[0_20px_70px_rgba(0,0,0,0.25)]">
      <div class={previewUrl ? "grid lg:grid-cols-[220px_1fr]" : ""}>
        {previewUrl && (
          <a
            href={getFanfaresEventUrl(group.event, publicDomain)}
            target="_blank"
            rel="noopener noreferrer"
            class="block min-h-44 overflow-hidden bg-black/30"
          >
            <img
              src={previewUrl}
              alt=""
              class="h-full min-h-44 w-full object-cover transition-transform duration-300 hover:scale-[1.02]"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </a>
        )}
        <div class="p-5 sm:p-6">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="mb-3 flex flex-wrap items-center gap-2">
                <Badge color="blue">
                  {getEventKindLabel(group.event.kind)}
                </Badge>
              </div>
              <h3 class="text-lg font-semibold leading-6 text-cyan-50">
                {group.title}
              </h3>
              {summary && (
                <p class="mt-2 line-clamp-3 max-w-3xl text-sm leading-6 text-gray-400">
                  {summary}
                </p>
              )}
            </div>
            <a
              href={getFanfaresEventUrl(group.event, publicDomain)}
              target="_blank"
              rel="noopener noreferrer"
              class="rounded-full border border-cyan-300/25 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-300/20"
            >
              Open in Fanfares ↗
            </a>
          </div>

          <div class="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4">
            <a
              href={getFanfaresProfileUrl(group.event.pubkey, publicDomain)}
              target="_blank"
              rel="noopener noreferrer"
              class="flex min-w-0 items-center gap-3 rounded-xl transition-colors hover:text-cyan-100"
            >
              {avatar
                ? (
                  <img
                    src={avatar}
                    alt=""
                    width="40"
                    height="40"
                    class="h-10 w-10 flex-shrink-0 rounded-full bg-gray-800 object-cover"
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                )
                : (
                  <span class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.05] text-sm font-semibold text-gray-400">
                    {authorName.slice(0, 1).toUpperCase() || "?"}
                  </span>
                )}
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-gray-200">
                  {authorName}
                </span>
                <span class="block truncate font-mono text-xs text-gray-600">
                  {profile?.nip05 || `${npub.slice(0, 16)}…`}
                </span>
              </span>
            </a>
            <p class="text-xs text-gray-500">
              {formatBytes(group.totalSize)} · {group.blobs.length}{" "}
              file{group.blobs.length === 1 ? "" : "s"} ·{" "}
              {formatDate(group.event.created_at)}
            </p>
          </div>

          <details class="mt-4 rounded-2xl border border-white/[0.07] bg-black/20 px-4 py-3">
            <summary class="cursor-pointer text-sm font-medium text-gray-400 hover:text-white">
              Review {group.blobs.length}{" "}
              stored file{group.blobs.length === 1 ? "" : "s"}
            </summary>
            <div class="mt-3 grid gap-2 lg:grid-cols-2">
              {group.blobs.map(({ blob, reference }) => (
                <a
                  href={`/admin/blobs/${blob.sha256}`}
                  class="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2 transition-colors hover:border-cyan-400/20"
                >
                  <span class="min-w-0">
                    <span class="block truncate text-sm text-cyan-200/80">
                      {reference.name || reference.role ||
                        truncateHash(blob.sha256)}
                    </span>
                    <span class="block truncate text-xs text-gray-600">
                      {blob.type ?? "unknown"} · {formatBytes(blob.size)}
                    </span>
                  </span>
                  <Badge color={reference.encrypted ? "yellow" : "green"}>
                    {reference.encrypted ? "encrypted" : "public"}
                  </Badge>
                </a>
              ))}
            </div>
          </details>
        </div>
      </div>
    </article>
  );
};
