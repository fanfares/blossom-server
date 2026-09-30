/** @jsxImportSource @hono/hono/jsx */
import type { FC } from "@hono/hono/jsx";
import type { Client } from "@libsql/client";
import type { Config } from "../config/schema.ts";
import { fetchUserProfiles } from "./nostr-profile.ts";
import { getFanfaresEventUrl } from "./fanfares-links.ts";
import { type ReportTarget, reportTargetUrl } from "./content-reports.ts";
import {
  AdminLayout,
  EmptyState,
  formatDate,
  PageHeader,
  Pagination,
  truncateHash,
} from "./layout.tsx";

export const ContentReportsPage: FC<
  {
    db: Client;
    config: Config;
    page: number;
    status: string;
    q: string;
    notice?: string;
  }
> = async ({ db, config, page, status, q, notice }) => {
  const where =
    "WHERE r.status = ? AND (? = '' OR r.content LIKE ? OR r.reporter = ? OR r.targets_json LIKE ?)";
  const args = [status, q, `%${q}%`, q, `%${q}%`];
  const [result, count, titles] = await Promise.all([
    db.execute({
      sql:
        `SELECT r.* FROM admin_content_reports r ${where} ORDER BY r.created_at DESC, r.event_id DESC LIMIT 50 OFFSET ?`,
      args: [...args, (page - 1) * 50],
    }),
    db.execute({
      sql: `SELECT COUNT(*) FROM admin_content_reports r ${where}`,
      args,
    }),
    db.execute(
      "SELECT event_id, title, author_name FROM admin_event_search ORDER BY refreshed_at DESC LIMIT 1000",
    ),
  ]);
  const names = new Map(titles.rows.map((row) => [String(row.event_id), row]));
  const reporterKeys = result.rows.flatMap((row) => {
    const targets = JSON.parse(String(row.targets_json)) as ReportTarget[];
    const author = targets.find((target) => target.type === "p");
    return [String(row.reporter), ...(author ? [author.value] : [])];
  });
  const profiles = await fetchUserProfiles(reporterKeys, 750);
  const baseUrl = `/admin/reports?status=${status}&q=${encodeURIComponent(q)}`;
  return (
    <AdminLayout title="Reports" section="reports">
      <PageHeader
        title="Content reports"
        subtitle="Signed Fanfares reports about events and authors"
      />
      {notice && <p role="status" class="admin-notice">{notice}</p>}
      <div class="admin-report-tools">
        <form
          method="get"
          action="/admin/reports"
          class="admin-search admin-filter-form"
        >
          <label class="admin-filter-label">
            Search<input
              name="q"
              value={q}
              maxlength={200}
              placeholder="Report text, event ID, or pubkey"
            />
          </label>
          <label class="admin-filter-label">
            Review status<select name="status">
              <option value="open" selected={status === "open"}>Open</option>
              <option value="reviewed" selected={status === "reviewed"}>
                Reviewed
              </option>
            </select>
          </label>
          <button type="submit">Filter</button>
        </form>
        <form method="post" action="/admin/reports/refresh">
          <button type="submit">Sync reports from relays</button>
        </form>
        <a href="/admin/blob-reports">Blossom file reports →</a>
      </div>
      <p class="admin-caption">
        Reports are allegations from their signers, not verified findings. Sync
        imports reports referring to local uploaders or indexed events from the
        configured relays. Relay availability and history affect coverage.
        Reviewing a report never deletes content.
      </p>
      {result.rows.length === 0
        ? (
          <EmptyState message="No reports in this view. Sync from relays to check for new submissions." />
        )
        : (
          <div class="admin-report-list">
            {result.rows.map((row) => {
              const targets = JSON.parse(
                String(row.targets_json),
              ) as ReportTarget[];
              const profile = profiles.get(String(row.reporter));
              return (
                <article class="admin-report-card">
                  <div class="admin-report-heading">
                    <h2>
                      {[
                        ...new Set(targets.map((target) =>
                          target.reason.charAt(0).toUpperCase() +
                          target.reason.slice(1)
                        )),
                      ]
                        .join(" · ")}
                    </h2>
                    <span>{formatDate(Number(row.created_at))}</span>
                  </div>
                  <p>
                    Reported by{" "}
                    <a href={`/admin/users/${row.reporter}`}>
                      {profile?.displayName || profile?.display_name ||
                        profile?.name ||
                        truncateHash(String(row.reporter))}
                    </a>{" "}
                    ·{" "}
                    <a
                      href={getFanfaresEventUrl({
                        id: String(row.event_id),
                        pubkey: String(row.reporter),
                      }, config.publicDomain)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View signed report ↗
                    </a>
                  </p>
                  {status === "reviewed" && row.reviewed_at && (
                    <p>
                      Reviewed {formatDate(Number(row.reviewed_at))} by{" "}
                      {truncateHash(String(row.reviewed_by))}
                    </p>
                  )}
                  <p class="admin-report-text">
                    {String(row.content) || "No additional details provided."}
                  </p>
                  <ul class="admin-report-targets">
                    {targets.map((target) => (
                      <li>
                        <span>
                          {target.type === "p"
                            ? "Author"
                            : target.type === "a"
                            ? "Addressable content"
                            : "Event"} · {target.reason}
                        </span>
                        <a
                          href={reportTargetUrl(target, config.publicDomain)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {target.type === "e" && names.has(target.value)
                            ? String(names.get(target.value)?.title)
                            : target.type === "p"
                            ? (profiles.get(target.value)?.displayName ||
                              profiles.get(target.value)?.display_name ||
                              profiles.get(target.value)?.name || target.value)
                            : target.value} ↗
                        </a>
                        {target.type === "e" &&
                          names.get(target.value)?.author_name && (
                          <small>
                            {String(names.get(target.value)?.author_name)}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form
                    method="post"
                    action={`/admin/reports/${row.event_id}/review`}
                  >
                    <input
                      type="hidden"
                      name="status"
                      value={status === "open" ? "reviewed" : "open"}
                    />
                    <button type="submit">
                      {status === "open" ? "Mark reviewed" : "Reopen report"}
                    </button>
                  </form>
                </article>
              );
            })}
          </div>
        )}
      <Pagination
        page={page}
        total={Number(count.rows[0][0])}
        pageSize={50}
        baseUrl={baseUrl}
      />
    </AdminLayout>
  );
};
