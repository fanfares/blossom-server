import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import {
  AdminLayout,
  Badge,
  EmptyState,
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

interface UsersPageProps {
  db: IDbHandle;
  page: number;
  q: string;
}

export const UsersPage: FC<UsersPageProps> = async ({ db, page, q }) => {
  const offset = (page - 1) * PAGE_SIZE;
  const filter = q ? { q } : undefined;

  const [users, total] = await Promise.all([
    db.listAllUsers({ filter, limit: PAGE_SIZE, offset }),
    db.countUsers(filter),
  ]);

  const baseUrl = q
    ? `/admin/users?q=${encodeURIComponent(q)}`
    : "/admin/users";

  return (
    <AdminLayout title="Users" section="users">
      <PageHeader
        title="Users"
        subtitle={`${total.toLocaleString()} distinct pubkey${
          total !== 1 ? "s" : ""
        }`}
      />

      {/* Search form */}
      <form
        method="get"
        action="/admin/users"
        class="mb-5 flex gap-3 rounded-2xl border border-white/10 bg-white/[0.025] p-4"
      >
        <input
          type="text"
          name="q"
          value={q}
          placeholder="Search by pubkey…"
          class="max-w-md flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-gray-200 outline-none transition-colors placeholder:text-gray-700 focus:border-cyan-300/35"
        />
        <button
          type="submit"
          class="rounded-full border border-cyan-300/30 bg-cyan-300/15 px-5 py-2 text-sm font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/20"
        >
          Search
        </button>
        {q && (
          <a
            href="/admin/users"
            class="rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-gray-400 transition-colors hover:border-white/20 hover:text-white"
          >
            Clear
          </a>
        )}
      </form>

      {users.length === 0
        ? (
          <EmptyState
            message={q ? `No users matching "${q}"` : "No users yet."}
          />
        )
        : (
          <>
            <Table>
              <Thead>
                <tr>
                  <Th>Pubkey</Th>
                  <Th>Blobs</Th>
                  <Th>Total Size</Th>
                  <Th>Actions</Th>
                </tr>
              </Thead>
              <Tbody>
                {users.map((user) => {
                  const blobCount = user.blobs.length;
                  return (
                    <tr
                      key={user.pubkey}
                      class="transition-colors hover:bg-white/[0.025]"
                    >
                      <Td mono>
                        <a
                          href={`/admin/users/${user.pubkey}`}
                          title={user.pubkey}
                          class="text-cyan-200/80 transition-colors hover:text-cyan-100"
                        >
                          {truncateHash(user.pubkey)}
                        </a>
                      </Td>
                      <Td>
                        <Badge>{blobCount}</Badge>
                      </Td>
                      <Td>—</Td>
                      <Td>
                        <a
                          href={`/admin/users/${user.pubkey}`}
                          class="text-xs text-cyan-200/75 transition-colors hover:text-cyan-100"
                        >
                          View →
                        </a>
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
