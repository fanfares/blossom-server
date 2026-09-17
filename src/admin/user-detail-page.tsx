import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import type { BlobRecord } from "../db/handle.ts";
import type { AdminBlobRecord } from "../db/blobs.ts";
import type { Config } from "../config/schema.ts";
import { nip19 } from "nostr-tools";
import { fetchUserProfile } from "./nostr-profile.ts";
import { fetchOwnerEvents, groupBlobsByEvents } from "./event-index.ts";
import {
  AdminLayout,
  Badge,
  formatBytes,
  formatDate,
  PageHeader,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  truncateHash,
} from "./layout.tsx";

interface UserDetailPageProps {
  db: IDbHandle;
  config: Config;
  pubkey: string;
}

export const UserDetailPage: FC<UserDetailPageProps> = async (
  { db, config, pubkey },
) => {
  // Validate pubkey is a 64-char hex string
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    return (
      <AdminLayout title="User not found" section="users">
        <div class="mb-4">
          <a
            href="/admin/users"
            class="text-sm text-gray-500 hover:text-gray-300"
          >
            ← Back to Users
          </a>
        </div>
        <PageHeader title="User not found" />
        <p class="text-gray-400 text-sm">
          Invalid pubkey:{" "}
          <code class="font-mono text-cyan-200/75">{pubkey}</code>
        </p>
      </AdminLayout>
    );
  }

  // Fetch the complete moderation inventory, event snapshot, and profile in parallel.
  // fetchUserProfile has its own 4 s timeout — a slow relay never blocks
  // the page render beyond that, and null is the graceful-degradation value.
  const [blobs, profile, events] = await Promise.all([
    db.listBlobsByPubkeyAdmin(pubkey, { limit: 10_000 }),
    fetchUserProfile(pubkey),
    fetchOwnerEvents([pubkey], config.dashboard.lookupRelays),
  ]);
  const total = blobs.length;

  if (total === 0) {
    return (
      <AdminLayout title="User not found" section="users">
        <div class="mb-4">
          <a
            href="/admin/users"
            class="text-sm text-gray-500 hover:text-gray-300"
          >
            ← Back to Users
          </a>
        </div>
        <PageHeader title="User not found" />
        <p class="text-gray-400 text-sm">
          No blobs found for pubkey{" "}
          <code class="break-all font-mono text-cyan-200/75">{pubkey}</code>
        </p>
      </AdminLayout>
    );
  }

  const totalSize = blobs.reduce(
    (acc: number, b: BlobRecord) => acc + b.size,
    0,
  );
  const adminBlobs: AdminBlobRecord[] = blobs.map((blob) => ({
    ...blob,
    owners: [pubkey],
    events: [],
  }));
  const grouped = groupBlobsByEvents(adminBlobs, events, config.publicDomain);

  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    // Silently ignore encoding errors — pubkey stays as hex
  }

  // Resolved display name — prefer display_name, fall back to name.
  const displayName = profile?.display_name || profile?.name || null;

  return (
    <AdminLayout title={`User ${truncateHash(pubkey)}`} section="users">
      <div class="mb-4">
        <a
          href="/admin/users"
          class="text-sm text-gray-500 hover:text-gray-300"
        >
          ← Back to Users
        </a>
      </div>

      <PageHeader
        title={displayName ?? `User ${truncateHash(pubkey)}`}
        subtitle="Creator storage and publishing overview"
      />

      <div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div class="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-5">
          <p class="text-xs uppercase tracking-wider text-cyan-200/55">
            Published events
          </p>
          <p class="mt-2 text-3xl font-semibold text-cyan-50">
            {grouped.groups.length}
          </p>
          <p class="mt-1 text-xs text-gray-500">Matched to stored files</p>
        </div>
        <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <p class="text-xs uppercase tracking-wider text-gray-500">
            Total files
          </p>
          <p class="mt-2 text-3xl font-semibold text-white">
            {total.toLocaleString()}
          </p>
          <p class="mt-1 text-xs text-gray-500">Owned Blossom blobs</p>
        </div>
        <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <p class="text-xs uppercase tracking-wider text-gray-500">
            Stored data
          </p>
          <p class="mt-2 text-3xl font-semibold text-white">
            {formatBytes(totalSize)}
          </p>
          <p class="mt-1 text-xs text-gray-500">Across all files</p>
        </div>
      </div>

      {/* Identity card */}
      <div class="mb-6 space-y-4 rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.25)] backdrop-blur-sm">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Identity
        </h2>

        {/* Profile header — avatar + name + nip05, only when metadata available */}
        {profile && (
          <div class="flex items-center gap-4 pb-2 border-b border-gray-800">
            {profile.picture && (
              <img
                src={profile.picture}
                alt={displayName ?? pubkey}
                width="48"
                height="48"
                class="w-12 h-12 rounded-full object-cover flex-shrink-0 bg-gray-800"
                loading="lazy"
              />
            )}
            <div class="min-w-0">
              {displayName && (
                <p class="text-base font-semibold text-gray-100 truncate">
                  {displayName}
                </p>
              )}
              {profile.nip05 && (
                <p class="truncate font-mono text-xs text-cyan-200/75">
                  {profile.nip05}
                </p>
              )}
            </div>
          </div>
        )}

        {/* About / bio */}
        {profile?.about && (
          <p class="text-sm text-gray-400 italic leading-relaxed line-clamp-3">
            {profile.about.length > 280
              ? profile.about.slice(0, 280) + "…"
              : profile.about}
          </p>
        )}

        <dl class="space-y-3">
          <div>
            <dt class="text-xs text-gray-500 mb-0.5">Hex pubkey</dt>
            <dd class="font-mono text-xs text-gray-200 break-all select-all">
              {pubkey}
            </dd>
          </div>
          {npub && (
            <div>
              <dt class="text-xs text-gray-500 mb-0.5">npub</dt>
              <dd class="font-mono text-xs text-gray-200 break-all select-all">
                {npub}
              </dd>
            </div>
          )}
          <div>
            <dt class="text-xs text-gray-500 mb-0.5">Nostr profile</dt>
            <dd>
              <a
                href={`https://njump.me/${npub || pubkey}`}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-cyan-200/75 transition-colors hover:text-cyan-100"
              >
                View on njump.me ↗
              </a>
            </dd>
          </div>
        </dl>
      </div>

      {grouped.groups.length > 0 && (
        <section class="mb-7 space-y-4">
          <div>
            <h2 class="text-lg font-semibold text-white">Published events</h2>
            <p class="mt-1 text-sm text-gray-500">
              Files organized by their signed Nostr event.
            </p>
          </div>
          {grouped.groups.map((group) => (
            <article class="rounded-2xl border border-cyan-400/20 bg-white/[0.04] p-5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 class="font-semibold text-cyan-50">{group.title}</h3>
                  <p class="mt-1 text-sm text-gray-400">
                    {group.blobs.length}{" "}
                    file{group.blobs.length === 1 ? "" : "s"} ·{" "}
                    {formatBytes(group.totalSize)}
                    {group.encryptedCount
                      ? ` · ${group.encryptedCount} encrypted`
                      : ""} · {formatDate(group.event.created_at)}
                  </p>
                </div>
                <a
                  href={`https://njump.me/${
                    nip19.neventEncode({
                      id: group.event.id,
                      author: group.event.pubkey,
                    })
                  }`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-sm text-cyan-200/80 hover:text-cyan-100"
                >
                  View event ↗
                </a>
              </div>
              <details class="mt-4 border-t border-white/10 pt-3">
                <summary class="cursor-pointer text-sm text-gray-400 hover:text-white">
                  File details
                </summary>
                <div class="mt-3 space-y-2">
                  {group.blobs.map(({ blob, reference }) => (
                    <div class="flex flex-wrap items-center gap-2 text-sm">
                      <a
                        href={`/admin/blobs/${blob.sha256}`}
                        class="text-cyan-200/75 hover:text-cyan-100"
                      >
                        {reference.name || reference.role ||
                          truncateHash(blob.sha256)}
                      </a>
                      <Badge color={reference.encrypted ? "yellow" : "green"}>
                        {reference.encrypted ? "encrypted" : "public"}
                      </Badge>
                      <span class="text-gray-500">
                        {formatBytes(blob.size)} · {blob.type ?? "unknown"}
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </article>
          ))}
        </section>
      )}

      {grouped.ungrouped.length === 0 ? null : (
        <>
          <div class="mb-3">
            <h2 class="text-lg font-semibold text-white">Other uploads</h2>
            <p class="mt-1 text-sm text-gray-500">
              Files not referenced by a fetched event.
            </p>
          </div>
          <Table>
            <Thead>
              <tr>
                <Th>Hash</Th>
                <Th>Type</Th>
                <Th>Size</Th>
                <Th>Uploaded</Th>
                <Th>Actions</Th>
              </tr>
            </Thead>
            <Tbody>
              {grouped.ungrouped.map((blob: BlobRecord) => (
                <tr
                  key={blob.sha256}
                  class="transition-colors hover:bg-white/[0.025]"
                >
                  <Td mono>
                    <a
                      href={`/admin/blobs/${blob.sha256}`}
                      class="text-cyan-200/80 transition-colors hover:text-cyan-100"
                    >
                      {truncateHash(blob.sha256)}
                    </a>
                  </Td>
                  <Td>
                    {blob.type
                      ? <Badge color="blue">{blob.type}</Badge>
                      : <span class="text-gray-600 text-xs">—</span>}
                  </Td>
                  <Td>{formatBytes(blob.size)}</Td>
                  <Td>{formatDate(blob.uploaded)}</Td>
                  <Td>
                  </Td>
                </tr>
              ))}
            </Tbody>
          </Table>
        </>
      )}
    </AdminLayout>
  );
};
