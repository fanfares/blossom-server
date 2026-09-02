import type { FC } from "@hono/hono/jsx";
import type { IDbHandle } from "../db/handle.ts";
import { REPORT_TYPES } from "../db/reports.ts";
import {
  AdminLayout,
  Badge,
  DangerButton,
  EmptyState,
  formatDate,
  PageHeader,
  Pagination,
  SecondaryButton,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  truncateHash,
} from "./layout.tsx";

const PAGE_SIZE = 50;

function reportTypeColor(type: string | null): string {
  switch (type) {
    case "nudity":
      return "red";
    case "illegal":
      return "red";
    case "malware":
      return "red";
    case "spam":
      return "yellow";
    case "impersonation":
      return "yellow";
    case "profanity":
      return "gray";
    default:
      return "gray";
  }
}

interface ReportsPageProps {
  db: IDbHandle;
  page: number;
  typeFilter: string;
}

export const ReportsPage: FC<ReportsPageProps> = async (
  { db, page, typeFilter },
) => {
  const offset = (page - 1) * PAGE_SIZE;
  const filter = typeFilter ? { type: typeFilter } : undefined;

  const [reports, total] = await Promise.all([
    db.listAllReports({
      filter,
      limit: PAGE_SIZE,
      offset,
      sort: ["created", "DESC"],
    }),
    db.countReports(filter),
  ]);

  const baseUrl = typeFilter
    ? `/admin/reports?type=${encodeURIComponent(typeFilter)}`
    : "/admin/reports";

  return (
    <AdminLayout title="Reports" section="reports">
      <PageHeader
        title="Reports"
        subtitle={`${total.toLocaleString()} report${total !== 1 ? "s" : ""}${
          typeFilter ? ` of type "${typeFilter}"` : ""
        }`}
      />

      {/* Type filter tabs */}
      <div class="mb-5 flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.025] p-4">
        <a
          href="/admin/reports"
          class={!typeFilter
            ? "rounded-full border border-cyan-400/30 bg-cyan-400/15 px-4 py-2 text-xs font-semibold text-cyan-100"
            : "rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-gray-400 transition-colors hover:border-cyan-400/25 hover:text-cyan-100"}
        >
          All
        </a>
        {REPORT_TYPES.map((t) => (
          <a
            key={t}
            href={`/admin/reports?type=${t}`}
            class={typeFilter === t
              ? "rounded-full border border-cyan-400/30 bg-cyan-400/15 px-4 py-2 text-xs font-semibold text-cyan-100"
              : "rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold text-gray-400 transition-colors hover:border-cyan-400/25 hover:text-cyan-100"}
          >
            {t}
          </a>
        ))}
      </div>

      {reports.length === 0 ? <EmptyState message="No reports found." /> : (
        <>
          <Table>
            <Thead>
              <tr>
                <Th>ID</Th>
                <Th>Type</Th>
                <Th>Blob</Th>
                <Th>Reporter</Th>
                <Th>Content</Th>
                <Th>Date</Th>
                <Th>Actions</Th>
              </tr>
            </Thead>
            <Tbody>
              {reports.map((report) => {
                const dismissUrl = `/admin/api/reports/${report.id}/dismiss`;
                const deleteBlobUrl =
                  `/admin/api/reports/${report.id}/delete-blob`;
                return (
                  <tr
                    key={report.id}
                    class="transition-colors hover:bg-white/[0.025]"
                  >
                    <Td mono>
                      <a
                        href={`/admin/reports/${report.id}`}
                        class="text-cyan-200/80 transition-colors hover:text-cyan-100"
                      >
                        #{report.id}
                      </a>
                    </Td>
                    <Td>
                      {report.type
                        ? (
                          <Badge color={reportTypeColor(report.type)}>
                            {report.type}
                          </Badge>
                        )
                        : <span class="text-gray-600">—</span>}
                    </Td>
                    <Td mono>
                      <a
                        href={`/admin/blobs/${report.blob}`}
                        class="text-cyan-200/80 transition-colors hover:text-cyan-100"
                        title={report.blob}
                      >
                        {truncateHash(report.blob)}
                      </a>
                    </Td>
                    <Td mono>
                      <span title={report.reporter} class="text-gray-300">
                        {truncateHash(report.reporter)}
                      </span>
                    </Td>
                    <Td>
                      <span
                        class="text-gray-400 max-w-xs truncate block"
                        title={report.content}
                      >
                        {report.content || (
                          <em class="text-gray-600">no content</em>
                        )}
                      </span>
                    </Td>
                    <Td>{formatDate(report.created)}</Td>
                    <Td>
                      <div class="flex gap-2 flex-wrap">
                        <SecondaryButton
                          onclick={`adminAction('${dismissUrl}','POST','Dismiss report #${report.id}?')`}
                        >
                          Dismiss
                        </SecondaryButton>
                        <DangerButton
                          onclick={`adminAction('${deleteBlobUrl}','POST','Delete the reported blob and dismiss all its reports? This cannot be undone.')`}
                        >
                          Delete blob
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
