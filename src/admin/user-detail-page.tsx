/** @jsxImportSource @hono/hono/jsx */
import type { StorageQuotaSummary } from "../db/paid-storage.ts";
import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import type { BlobRecord } from "../db/handle.ts";
import type { AdminBlobRecord } from "../db/blobs.ts";
import type { Config } from "../config/schema.ts";
import { nip19 } from "nostr-tools";
import { fetchUserProfile } from "./nostr-profile.ts";
import { fetchOwnerEvents, groupBlobsByEvents } from "./event-index.ts";
import { EventCard } from "./event-card.tsx";
import { getFanfaresProfileUrl } from "./fanfares-links.ts";
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
  quota?: StorageQuotaSummary;
  purchasedBytes?: number;
  paidSats?: number;
}

export const UserDetailPage: FC<UserDetailPageProps> = async (
  { db, config, pubkey, quota, purchasedBytes = 0, paidSats = 0 },
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
  // Relay enrichment is best effort so external relays cannot stall navigation.
  const [blobs, profile, events] = await Promise.all([
    db.listBlobsByPubkeyAdmin(pubkey, { limit: 10_000 }),
    fetchUserProfile(pubkey, 750),
    fetchOwnerEvents([pubkey], config.dashboard.lookupRelays, {
      maxWait: 750,
    }),
  ]);
  const total = blobs.length;

  const totalSize = blobs.reduce(
    (acc: number, b: BlobRecord) => acc + b.size,
    0,
  );
  const adminBlobs: AdminBlobRecord[] = blobs.map((blob) => ({
    ...blob,
    owners: [pubkey],
    events: [],
  }));
  const grouped = groupBlobsByEvents(
    adminBlobs,
    events,
    [config.publicDomain, config.blobDomain].filter(Boolean),
  );

  let npub = "";
  try {
    npub = nip19.npubEncode(pubkey);
  } catch {
    // Silently ignore encoding errors — pubkey stays as hex
  }

  // Resolved display name — prefer display_name, fall back to name.
  const displayName = profile?.display_name || profile?.name || null;
  const publicDomain = config.publicDomain || "blossom.fanfares.live";
  const blobBaseUrl = `https://${publicDomain.replace(/\/$/, "")}`;

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

      <section class="admin-finance-settings">
        <h2>Storage balance</h2>
        {config.paidStorage.enabled && quota
          ? (
            <>
              <div class="admin-metrics">
                <div>
                  <span>Available for uploads</span>
                  <strong>{formatBytes(quota.availableBytes)}</strong>
                </div>
                <div>
                  <span>Active purchased quota</span>
                  <strong>{formatBytes(quota.quotaBytes)}</strong>
                </div>
                <div>
                  <span>Used / reserved</span>
                  <strong>
                    {formatBytes(quota.usedBytes)} /{" "}
                    {formatBytes(quota.reservedBytes)}
                  </strong>
                </div>
              </div>
              <p>
                Latest active grant expiry: {quota.expiresAt
                  ? formatDate(quota.expiresAt)
                  : "No active grants"}. Individual purchases can expire
                earlier.
              </p>
              <p>
                Lifetime new capacity purchased: {formatBytes(purchasedBytes)} ·
                {" "}
                {paidSats.toLocaleString()}{" "}
                sats paid. Payments include renewals, which extend existing
                capacity.
              </p>
            </>
          )
          : (
            <p>
              Paid storage is disabled. Upload access follows the server
              allowlist.
            </p>
          )}
        <a href={`/admin/payments?pubkey=${pubkey}`}>
          View this user’s purchases and wallet forwarding →
        </a>
      </section>

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
                href={getFanfaresProfileUrl(pubkey, publicDomain)}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-cyan-200/75 transition-colors hover:text-cyan-100"
              >
                View on Fanfares ↗
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
            <EventCard
              group={group}
              profile={profile ?? undefined}
              publicDomain={publicDomain}
              blobBaseUrl={blobBaseUrl}
            />
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
