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
        <div class="mb-4 rounded border border-green-800 bg-green-950 px-3 py-2 text-sm text-green-300">
          {notice}
        </div>
      )}

      <form
        method="post"
        action="/admin/events/inspect"
        class="mb-5 flex flex-wrap gap-2 rounded-lg border border-gray-800 bg-gray-900 p-4"
      >
        <input
          type="text"
          name="event"
          required
          placeholder="Event hex, note, nevent, or naddr…"
          class="min-w-72 flex-1 rounded border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 focus:border-purple-500 focus:outline-none"
        />
        <button
          type="submit"
          class="rounded bg-purple-700 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600"
        >
          Inspect event
        </button>
        <p class="basis-full text-xs text-gray-500">
          Fetches the signed event from configured relays and links its Blossom
          files for moderation.
        </p>
      </form>

      {/* Search form */}
      <form
        method="get"
        action="/admin/blobs"
        class="mb-4 flex flex-wrap gap-2"
      >
        <input
          type="text"
          name="q"
          value={q}
          placeholder="Search hash, MIME, pubkey, or event ID…"
          class="flex-1 max-w-md bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-purple-500"
        />
        <select
          name="visibility"
          class="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
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
          class="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
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
          class="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
        >
          <option value="DESC" selected={direction === "DESC"}>
            Descending
          </option>
          <option value="ASC" selected={direction === "ASC"}>Ascending</option>
        </select>
        <button
          type="submit"
          class="px-4 py-2 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium transition-colors"
        >
          Search
        </button>
        {(q || visibility || sort !== "uploaded" || direction !== "DESC") && (
          <a
            href="/admin/blobs"
            class="px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
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
                      class="hover:bg-gray-900 transition-colors"
                    >
                      <Td mono>
                        <a
                          href={`/admin/blobs/${blob.sha256}`}
                          class="text-purple-400 hover:text-purple-300 hover:underline"
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
                                    class="font-mono text-xs text-purple-400 hover:underline"
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
