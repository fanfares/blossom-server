import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import type { Config } from "../config/schema.ts";
import { mimeToExt } from "../utils/mime.ts";
import {
  AdminLayout,
  Badge,
  DangerButton,
  EmptyState,
  formatBytes,
  formatDate,
  PageHeader,
  Pagination,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  truncateHash,
} from "./layout.tsx";

const PAGE_SIZE = 50;

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

function mimeColor(mime: string | null): string {
  if (!mime) return "gray";
  if (mime.startsWith("image/")) return "purple";
  if (mime.startsWith("video/")) return "blue";
  if (mime.startsWith("audio/")) return "green";
  if (mime.startsWith("text/")) return "yellow";
  return "gray";
}

interface BlobsPageProps {
  db: IDbHandle;
  config: Config;
  host: string;
  page: number;
  q: string;
  visibility: "" | "encrypted" | "public" | "unlinked";
  sort: "sha256" | "type" | "size" | "uploaded";
  direction: "ASC" | "DESC";
  notice?: string;
}

export const BlobsPage: FC<BlobsPageProps> = async (
  { db, config, host, page, q, visibility, sort, direction, notice },
) => {
  const offset = (page - 1) * PAGE_SIZE;
  const filter = q || visibility
    ? { q: q || undefined, visibility: visibility || undefined }
    : undefined;

  const [blobs, total] = await Promise.all([
    db.listAllBlobs({
      filter,
      limit: PAGE_SIZE,
      offset,
      sort: [sort, direction],
    }),
    db.countBlobs(filter),
  ]);

  const baseParams = new URLSearchParams();
  if (q) baseParams.set("q", q);
  if (visibility) baseParams.set("visibility", visibility);
  baseParams.set("sort", sort);
  baseParams.set("direction", direction);
  const baseUrl = `/admin/blobs?${baseParams.toString()}`;

  return (
    <AdminLayout title="Blobs" section="blobs">
      <PageHeader
        title="Blobs"
        subtitle={`${total.toLocaleString()} total blob${
          total !== 1 ? "s" : ""
        }`}
      />

      {notice && (
        <div class="mb-5 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      <form
        method="post"
        action="/admin/events/inspect"
        class="mb-5 flex flex-wrap gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_70px_rgba(0,0,0,0.25)] backdrop-blur-sm"
      >
        <input
          type="text"
          name="event"
          required
          placeholder="Event hex, note, nevent, or naddr…"
          class="min-w-72 flex-1 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-700 focus:border-cyan-300/35 focus:ring-1 focus:ring-cyan-300/20"
        />
        <button
          type="submit"
          class="rounded-full border border-cyan-300/30 bg-cyan-300/15 px-5 py-3 text-sm font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/20"
        >
          Inspect event
        </button>
        <p class="basis-full text-xs leading-5 text-gray-500">
          Fetches the signed event from configured relays and links its Blossom
          files for moderation.
        </p>
      </form>

      {/* Search form */}
      <form
        method="get"
        action="/admin/blobs"
        class="mb-5 flex flex-wrap gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4"
      >
        <input
          type="text"
          name="q"
          value={q}
          placeholder="Search hash, MIME, pubkey, or event ID…"
          class="max-w-md flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-700 focus:border-cyan-300/35"
        />
        <select
          name="visibility"
          class="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-gray-300 outline-none focus:border-cyan-300/35"
        >
          <option value="" selected={!visibility}>All visibility</option>
          <option value="encrypted" selected={visibility === "encrypted"}>
            Encrypted
          </option>
          <option value="public" selected={visibility === "public"}>
            Public
          </option>
          <option value="unlinked" selected={visibility === "unlinked"}>
            Not linked
          </option>
        </select>
        <select
          name="sort"
          class="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-gray-300 outline-none focus:border-cyan-300/35"
        >
          <option value="uploaded" selected={sort === "uploaded"}>
            Upload date
          </option>
          <option value="size" selected={sort === "size"}>Size</option>
          <option value="type" selected={sort === "type"}>MIME type</option>
          <option value="sha256" selected={sort === "sha256"}>Hash</option>
        </select>
        <select
          name="direction"
          class="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-gray-300 outline-none focus:border-cyan-300/35"
        >
          <option value="DESC" selected={direction === "DESC"}>
            Descending
          </option>
          <option value="ASC" selected={direction === "ASC"}>Ascending</option>
        </select>
        <button
          type="submit"
          class="rounded-full border border-cyan-300/30 bg-cyan-300/15 px-5 py-2 text-sm font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/20"
        >
          Search
        </button>
        {(q || visibility || sort !== "uploaded" || direction !== "DESC") && (
          <a
            href="/admin/blobs"
            class="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-gray-400 transition-colors hover:border-white/20 hover:text-white"
          >
            Clear
          </a>
        )}
      </form>

      {blobs.length === 0
        ? (
          <EmptyState
            message={q ? `No blobs matching "${q}"` : "No blobs stored yet."}
          />
        )
        : (
          <>
            <Table>
              <Thead>
                <tr>
                  <Th>Hash</Th>
                  <Th>Type</Th>
                  <Th>Size</Th>
                  <Th>Owners</Th>
                  <Th>Events</Th>
                  <Th>Uploaded</Th>
                  <Th>Actions</Th>
                </tr>
              </Thead>
              <Tbody>
                {blobs.map((blob) => {
                  const blobUrl = getBlobUrl(
                    blob.sha256,
                    blob.type,
                    config,
                    host,
                  );
                  const deleteUrl = `/admin/api/blobs/${blob.sha256}`;
                  return (
                    <tr
                      key={blob.sha256}
                      class="transition-colors hover:bg-white/[0.025]"
                    >
                      <Td mono>
                        <a
                          href={`/admin/blobs/${blob.sha256}`}
                          class="text-cyan-200/80 transition-colors hover:text-cyan-100"
                          title={blob.sha256}
                        >
                          {truncateHash(blob.sha256)}
                        </a>
                      </Td>
                      <Td>
                        {blob.type
                          ? (
                            <Badge color={mimeColor(blob.type)}>
                              {blob.type}
                            </Badge>
                          )
                          : <span class="text-gray-600">—</span>}
                      </Td>
                      <Td>{formatBytes(blob.size)}</Td>
                      <Td>
                        <Badge>{blob.owners.length}</Badge>
                      </Td>
                      <Td>
                        {blob.events.length === 0
                          ? <span class="text-gray-600">—</span>
                          : (
                            <div class="space-y-1">
                              {blob.events.slice(0, 3).map((event) => (
                                <div
                                  key={event.id}
                                  class="flex items-center gap-1"
                                >
                                  <a
                                    href={`/admin/blobs?q=${event.id}`}
                                    title={event.id}
                                    class="font-mono text-xs text-cyan-200/75 hover:text-cyan-100"
                                  >
                                    {truncateHash(event.id)}
                                  </a>
                                  <Badge
                                    color={event.encrypted ? "yellow" : "green"}
                                  >
                                    {event.encrypted ? "encrypted" : "public"}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          )}
                      </Td>
                      <Td>{formatDate(blob.uploaded)}</Td>
                      <Td>
                        <div class="flex gap-2 items-center">
                          <a
                            href={blobUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                          >
                            View ↗
                          </a>
                          <DangerButton
                            onclick={`adminAction('${deleteUrl}','DELETE','Delete blob ${
                              truncateHash(
                                blob.sha256,
                              )
                            }? This cannot be undone.')`}
                          >
                            Delete
                          </DangerButton>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </Tbody>
            </Table>
            <Pagination
              page={page}
              total={total}
              pageSize={PAGE_SIZE}
              baseUrl={baseUrl}
            />
          </>
        )}
    </AdminLayout>
  );
};
