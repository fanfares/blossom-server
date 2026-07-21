import type { FC } from "@hono/hono/jsx";
import type { Config } from "../config/schema.ts";
import type { AdminBlobRecord, AdminUserRecord } from "../db/handle.ts";
import { mimeToExt } from "../utils/mime.ts";
import { Layout } from "./layout.tsx";
import { StatsBar } from "./stats-bar.tsx";
import { ServerInfo } from "./server-info.tsx";
import { UploadIsland } from "./upload-island.tsx";

type LandingTab = "overview" | "files" | "publishers" | "upload";

const PAGE_SIZE = 24;
const OVERVIEW_PREVIEW = 6;

function normalizeTab(tab: string | undefined): LandingTab {
  if (tab === "files" || tab === "publishers" || tab === "upload") return tab;
  return "overview";
}

function buildUrl(
  tab: LandingTab,
  opts: { q?: string; page?: number } = {},
): string {
  const params = new URLSearchParams();
  if (tab !== "overview") params.set("tab", tab);
  if (opts.q) params.set("q", opts.q);
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncate(value: string, head = 8, tail = 4): string {
  return value.length > head + tail + 1
    ? `${value.slice(0, head)}…${value.slice(-tail)}`
    : value;
}

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").slice(0, 19) +
    " UTC";
}

function chipClass(active = false): string {
  return active
    ? "rounded-full border border-cyan-400/30 bg-cyan-400/15 px-4 py-2 text-sm font-semibold text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
    : "rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-gray-300 hover:border-cyan-400/30 hover:bg-cyan-400/10 hover:text-cyan-100 transition-colors";
}

function panelClass(extra = ""): string {
  return `rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-sm ${extra}`;
}

function ownerPills(owners: string[]): string {
  if (owners.length === 0) return "—";
  const first = owners.slice(0, 2).map((owner) => truncate(owner)).join(" · ");
  return owners.length > 2 ? `${first} · +${owners.length - 2}` : first;
}

function blobUrl(sha256: string, type: string | null, config: Config): string {
  const ext = mimeToExt(type);
  const base = config.publicDomain
    ? `https://${config.publicDomain.replace(/\/$/, "")}`
    : "";
  return `${base}/${sha256}${ext ? `.${ext}` : ""}`;
}

function routeToPublisher(pubkey: string): string {
  return buildUrl("publishers", { q: pubkey });
}

interface LandingPageProps {
  db: {
    getStats(): Promise<
      { blobCount: number; totalSize: number; dailyUploads: number }
    >;
    listAllBlobs(opts?: {
      filter?: { q?: string; type?: string | string[] };
      sort?: [string, string];
      limit?: number;
      offset?: number;
    }): Promise<AdminBlobRecord[]>;
    countBlobs(
      filter?: { q?: string; type?: string | string[] },
    ): Promise<number>;
    listAllUsers(opts?: {
      filter?: { q?: string; pubkey?: string };
      sort?: [string, string];
      limit?: number;
      offset?: number;
    }): Promise<AdminUserRecord[]>;
    countUsers(filter?: { q?: string; pubkey?: string }): Promise<number>;
  };
  config: Config;
  tab: string;
  q: string;
  page: number;
}

export const LandingPage: FC<LandingPageProps> = async (
  { db, config, tab, q, page },
) => {
  const activeTab = normalizeTab(tab);
  const query = q.trim();
  const currentPage = Math.max(1, page || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const [
    stats,
    overviewBlobs,
    overviewUsers,
    fileBlobs,
    fileTotal,
    publisherRows,
    publisherTotal,
  ] = await Promise.all([
    db.getStats(),
    activeTab === "overview"
      ? db.listAllBlobs({ sort: ["uploaded", "DESC"], limit: OVERVIEW_PREVIEW })
      : Promise.resolve([] as AdminBlobRecord[]),
    activeTab === "overview"
      ? db.listAllUsers({ sort: ["pubkey", "ASC"], limit: OVERVIEW_PREVIEW })
      : Promise.resolve([] as AdminUserRecord[]),
    activeTab === "files"
      ? db.listAllBlobs({
        filter: query ? { q: query } : undefined,
        sort: ["uploaded", "DESC"],
        limit: PAGE_SIZE,
        offset,
      })
      : Promise.resolve([] as AdminBlobRecord[]),
    activeTab === "files"
      ? db.countBlobs(query ? { q: query } : undefined)
      : Promise.resolve(0),
    activeTab === "publishers"
      ? db.listAllUsers({
        filter: query ? { q: query } : undefined,
        sort: ["pubkey", "ASC"],
        limit: PAGE_SIZE,
        offset,
      })
      : Promise.resolve([] as AdminUserRecord[]),
    activeTab === "publishers"
      ? db.countUsers(query ? { q: query } : undefined)
      : Promise.resolve(0),
  ]);

  const fileRows = activeTab === "files" ? fileBlobs : overviewBlobs;
  const userRows = activeTab === "publishers" ? publisherRows : overviewUsers;
  const fileCount = activeTab === "files" ? fileTotal : stats.blobCount;
  const publisherCount = activeTab === "publishers"
    ? publisherTotal
    : userRows.length;

  return (
    <Layout title={`${config.landing.title} Dashboard`}>
      <div class="relative space-y-8">
        <section class="grid gap-6 xl:grid-cols-[1.6fr_0.9fr]">
          <div class={panelClass("overflow-hidden relative")}>
            <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.12),_transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_35%)]" />
            <div class="relative p-6 sm:p-8">
              <div class="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.35em] text-cyan-200/60">
                <span>{config.storage.backend.toUpperCase()} storage</span>
                <span class="text-white/20">•</span>
                <span>
                  {config.upload.enabled ? "Uploads enabled" : "Read only"}
                </span>
                <span class="text-white/20">•</span>
                <span>
                  {config.media.enabled
                    ? "Media processing enabled"
                    : "Media processing disabled"}
                </span>
              </div>
              <h1 class="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                {config.landing.title}
              </h1>
              <p class="mt-4 max-w-3xl text-sm leading-6 text-gray-300 sm:text-base">
                Fanfares Blossom Server connects the Fanfares client to Blossom
                storage. Search by blob hash, MIME type, or owner pubkey, and
                browse upload history in a compact dashboard.
              </p>

              <div class="mt-6 flex flex-wrap gap-3">
                <a
                  href={buildUrl("overview")}
                  class={chipClass(activeTab === "overview")}
                >
                  Overview
                </a>
                <a
                  href={buildUrl("files")}
                  class={chipClass(activeTab === "files")}
                >
                  Files
                </a>
                <a
                  href={buildUrl("publishers")}
                  class={chipClass(activeTab === "publishers")}
                >
                  Publishers
                </a>
                <a
                  href={buildUrl("upload")}
                  class={chipClass(activeTab === "upload")}
                >
                  Upload
                </a>
              </div>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <div class={panelClass("p-5")}>
              <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                Endpoint
              </div>
              <div class="mt-3 break-all font-mono text-sm text-white">
                {config.publicDomain
                  ? `https://${config.publicDomain.replace(/\/$/, "")}`
                  : "Local host / proxy origin"}
              </div>
            </div>
            <div class={panelClass("p-5")}>
              <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                Indexed fields
              </div>
              <ul class="mt-3 space-y-2 text-sm text-gray-300">
                <li>Blob hash and MIME type</li>
                <li>Owner pubkeys from uploads</li>
                <li>Upload time and last access time</li>
              </ul>
            </div>
            <div class={panelClass("p-5 sm:col-span-2 xl:col-span-1")}>
              <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                Query tips
              </div>
              <p class="mt-3 text-sm leading-6 text-gray-300">
                Use the Files tab to search hashes or MIME types. Use the
                Publishers tab to search by exact or partial pubkey.
              </p>
            </div>
          </div>
        </section>

        {activeTab === "overview" && (
          <section class="space-y-6">
            <StatsBar stats={stats} />
            <div class="grid gap-6 xl:grid-cols-[1.25fr_0.85fr]">
              <div class={panelClass("p-6")}>
                <div class="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                      Recent files
                    </div>
                    <h2 class="mt-2 text-lg font-semibold text-white">
                      Newest uploads
                    </h2>
                  </div>
                  <a
                    href={buildUrl("files")}
                    class="text-sm text-cyan-200/70 hover:text-cyan-100"
                  >
                    View all →
                  </a>
                </div>
                {overviewBlobs.length === 0
                  ? (
                    <p class="py-12 text-center text-sm text-gray-500">
                      No blobs stored yet.
                    </p>
                  )
                  : (
                    <div class="space-y-3">
                      {overviewBlobs.map((blob) => (
                        <article
                          key={blob.sha256}
                          class="rounded-2xl border border-white/10 bg-black/30 px-4 py-4 transition-colors hover:border-cyan-400/30"
                        >
                          <div class="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <a
                                href={blobUrl(blob.sha256, blob.type, config)}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-mono text-sm text-white hover:text-cyan-100"
                                title={`Open ${blob.sha256}`}
                              >
                                {truncate(blob.sha256)}
                              </a>
                              <p class="mt-1 text-xs text-gray-500">
                                Open blob in a new tab
                              </p>
                            </div>
                            <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                              {blob.type && (
                                <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-gray-200">
                                  {blob.type}
                                </span>
                              )}
                              <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-gray-200">
                                {formatBytes(blob.size)}
                              </span>
                              <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-gray-200">
                                {formatDate(blob.uploaded)}
                              </span>
                            </div>
                          </div>
                          <div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-400">
                            <span class="text-gray-500">Owners</span>
                            <span class="font-mono text-gray-300">
                              {ownerPills(blob.owners)}
                            </span>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
              </div>

              <div class="space-y-6">
                <div class={panelClass("p-6")}>
                  <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                    Recent publishers
                  </div>
                  <h2 class="mt-2 text-lg font-semibold text-white">
                    Latest owner pubkeys
                  </h2>
                  <div class="mt-5 space-y-3">
                    {overviewUsers.length === 0
                      ? (
                        <p class="py-8 text-center text-sm text-gray-500">
                          No publishers yet.
                        </p>
                      )
                      : overviewUsers.map((user) => (
                        <a
                          href={routeToPublisher(user.pubkey)}
                          class="block rounded-2xl border border-white/10 bg-black/30 px-4 py-4 transition-colors hover:border-cyan-400/30"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="font-mono text-xs text-white">
                              {truncate(user.pubkey, 12, 6)}
                            </span>
                            <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs text-gray-200">
                              {user.blobs.length} blobs
                            </span>
                          </div>
                          <div class="mt-2 text-xs text-gray-500">
                            Latest blob{" "}
                            {user.blobs[0] ? truncate(user.blobs[0]) : "—"}
                          </div>
                        </a>
                      ))}
                  </div>
                </div>

                <div class={panelClass("p-6")}>
                  <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                    Storage notes
                  </div>
                  <p class="mt-3 text-sm leading-6 text-gray-300">
                    Blossom stores blob metadata plus ownership, access, and
                    upload event ids. The actual file bytes live in{" "}
                    {config.storage.backend} storage.
                  </p>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "files" && (
          <section class="space-y-5">
            <div class={panelClass("p-5")}>
              <form
                method="get"
                action="/"
                class="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-center"
              >
                <input type="hidden" name="tab" value="files" />
                <input
                  type="text"
                  name="q"
                  value={query}
                  placeholder="Search hash, MIME type, or auth event id…"
                  class="w-full rounded-2xl border border-white/10 bg-black/60 px-4 py-3 text-sm text-white placeholder:text-gray-600 focus:border-cyan-400/50 focus:outline-none"
                />
                <button
                  type="submit"
                  class="rounded-2xl border border-cyan-400/20 bg-cyan-400/15 px-5 py-3 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/20"
                >
                  Search
                </button>
                {query && (
                  <a
                    href={buildUrl("files")}
                    class="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3 text-center text-sm font-semibold text-gray-300 hover:border-white/20 hover:text-white"
                  >
                    Clear
                  </a>
                )}
              </form>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <h2 class="text-xl font-semibold text-white">Files</h2>
                <p class="text-sm text-gray-400">
                  {fileCount.toLocaleString()}{" "}
                  matching blob{fileCount === 1 ? "" : "s"}
                </p>
              </div>
              <a
                href={buildUrl("upload")}
                class="text-sm text-cyan-200/70 hover:text-cyan-100"
              >
                Upload new blob →
              </a>
            </div>

            {fileRows.length === 0
              ? (
                <div
                  class={panelClass("p-10 text-center text-sm text-gray-500")}
                >
                  {query
                    ? `No blobs matching "${query}".`
                    : "No blobs stored yet."}
                </div>
              )
              : (
                <div class={panelClass("overflow-hidden")}>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-white/10 text-sm">
                      <thead class="bg-black/35 text-[11px] uppercase tracking-[0.28em] text-cyan-200/55">
                        <tr>
                          <th class="px-4 py-3 text-left font-medium">Hash</th>
                          <th class="px-4 py-3 text-left font-medium">
                            Owners
                          </th>
                          <th class="px-4 py-3 text-left font-medium">Type</th>
                          <th class="px-4 py-3 text-left font-medium">Size</th>
                          <th class="px-4 py-3 text-left font-medium">
                            Uploaded
                          </th>
                          <th class="px-4 py-3 text-left font-medium">Open</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-white/10 bg-black/20">
                        {fileRows.map((blob) => (
                          <tr key={blob.sha256} class="hover:bg-white/[0.03]">
                            <td class="px-4 py-4 align-top">
                              <a
                                href={blobUrl(blob.sha256, blob.type, config)}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-mono text-xs text-white hover:text-cyan-100"
                                title={`Open ${blob.sha256}`}
                              >
                                {truncate(blob.sha256)}
                              </a>
                            </td>
                            <td class="px-4 py-4 align-top text-xs text-gray-300">
                              <div class="flex flex-wrap gap-1.5">
                                {blob.owners.length === 0
                                  ? <span class="text-gray-600">—</span>
                                  : blob.owners.slice(0, 3).map((owner) => (
                                    <a
                                      href={routeToPublisher(owner)}
                                      class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-[11px] text-gray-200 hover:border-cyan-400/30 hover:text-cyan-100"
                                      title={owner}
                                    >
                                      {truncate(owner, 10, 5)}
                                    </a>
                                  ))}
                                {blob.owners.length > 3 && (
                                  <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-[11px] text-gray-400">
                                    +{blob.owners.length - 3}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td class="px-4 py-4 align-top text-gray-300">
                              {blob.type
                                ? blob.type
                                : <span class="text-gray-600">—</span>}
                            </td>
                            <td class="px-4 py-4 align-top text-gray-300">
                              {formatBytes(blob.size)}
                            </td>
                            <td class="px-4 py-4 align-top text-gray-300">
                              {formatDate(blob.uploaded)}
                            </td>
                            <td class="px-4 py-4 align-top">
                              <a
                                href={blobUrl(blob.sha256, blob.type, config)}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-sm text-cyan-200/70 hover:text-cyan-100"
                              >
                                Open ↗
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {fileTotal > PAGE_SIZE && (
                    <div class="flex items-center justify-between border-t border-white/10 px-4 py-4 text-sm text-gray-400">
                      <span>
                        Showing {offset + 1}–{Math.min(
                          offset + fileRows.length,
                          fileCount,
                        )} of {fileCount}
                      </span>
                      <div class="flex gap-2">
                        {currentPage > 1
                          ? (
                            <a
                              href={buildUrl("files", {
                                q: query,
                                page: currentPage - 1,
                              })}
                              class="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-100"
                            >
                              ← Prev
                            </a>
                          )
                          : (
                            <span class="rounded-full border border-white/5 bg-black/20 px-4 py-2 text-gray-600">
                              ← Prev
                            </span>
                          )}
                        <span class="px-2 py-2 font-mono text-xs text-gray-500">
                          {currentPage}
                        </span>
                        {offset + fileRows.length < fileCount
                          ? (
                            <a
                              href={buildUrl("files", {
                                q: query,
                                page: currentPage + 1,
                              })}
                              class="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-100"
                            >
                              Next →
                            </a>
                          )
                          : (
                            <span class="rounded-full border border-white/5 bg-black/20 px-4 py-2 text-gray-600">
                              Next →
                            </span>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              )}
          </section>
        )}

        {activeTab === "publishers" && (
          <section class="space-y-5">
            <div class={panelClass("p-5")}>
              <form
                method="get"
                action="/"
                class="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-center"
              >
                <input type="hidden" name="tab" value="publishers" />
                <input
                  type="text"
                  name="q"
                  value={query}
                  placeholder="Search by public key…"
                  class="w-full rounded-2xl border border-white/10 bg-black/60 px-4 py-3 text-sm text-white placeholder:text-gray-600 focus:border-cyan-400/50 focus:outline-none"
                />
                <button
                  type="submit"
                  class="rounded-2xl border border-cyan-400/20 bg-cyan-400/15 px-5 py-3 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/20"
                >
                  Search
                </button>
                {query && (
                  <a
                    href={buildUrl("publishers")}
                    class="rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3 text-center text-sm font-semibold text-gray-300 hover:border-white/20 hover:text-white"
                  >
                    Clear
                  </a>
                )}
              </form>
            </div>

            <div class="flex items-center justify-between gap-4">
              <div>
                <h2 class="text-xl font-semibold text-white">Publishers</h2>
                <p class="text-sm text-gray-400">
                  {publisherCount.toLocaleString()}{" "}
                  distinct pubkey{publisherCount === 1 ? "" : "s"}
                </p>
              </div>
              <a
                href={buildUrl("files")}
                class="text-sm text-cyan-200/70 hover:text-cyan-100"
              >
                Go to files →
              </a>
            </div>

            {userRows.length === 0
              ? (
                <div
                  class={panelClass("p-10 text-center text-sm text-gray-500")}
                >
                  {query
                    ? `No publishers matching "${query}".`
                    : "No publishers yet."}
                </div>
              )
              : (
                <div class={panelClass("overflow-hidden")}>
                  <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-white/10 text-sm">
                      <thead class="bg-black/35 text-[11px] uppercase tracking-[0.28em] text-cyan-200/55">
                        <tr>
                          <th class="px-4 py-3 text-left font-medium">
                            Pubkey
                          </th>
                          <th class="px-4 py-3 text-left font-medium">Blobs</th>
                          <th class="px-4 py-3 text-left font-medium">
                            Sample blob
                          </th>
                          <th class="px-4 py-3 text-left font-medium">Open</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-white/10 bg-black/20">
                        {userRows.map((user) => (
                          <tr key={user.pubkey} class="hover:bg-white/[0.03]">
                            <td class="px-4 py-4 align-top font-mono text-xs text-white">
                              {truncate(user.pubkey, 12, 6)}
                            </td>
                            <td class="px-4 py-4 align-top text-gray-300">
                              <span class="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs text-gray-200">
                                {user.blobs.length}
                              </span>
                            </td>
                            <td class="px-4 py-4 align-top font-mono text-xs text-gray-300">
                              {user.blobs[0]
                                ? (
                                  <a
                                    href={blobUrl(user.blobs[0], null, config)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="text-white hover:text-cyan-100"
                                    title={`Open ${user.blobs[0]}`}
                                  >
                                    {truncate(user.blobs[0])}
                                  </a>
                                )
                                : "—"}
                            </td>
                            <td class="px-4 py-4 align-top">
                              <a
                                href={routeToPublisher(user.pubkey)}
                                class="text-sm text-cyan-200/70 hover:text-cyan-100"
                              >
                                View files →
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {publisherTotal > PAGE_SIZE && (
                    <div class="flex items-center justify-between border-t border-white/10 px-4 py-4 text-sm text-gray-400">
                      <span>
                        Showing {offset + 1}–{Math.min(
                          offset + userRows.length,
                          publisherCount,
                        )} of {publisherCount}
                      </span>
                      <div class="flex gap-2">
                        {currentPage > 1
                          ? (
                            <a
                              href={buildUrl("publishers", {
                                q: query,
                                page: currentPage - 1,
                              })}
                              class="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-100"
                            >
                              ← Prev
                            </a>
                          )
                          : (
                            <span class="rounded-full border border-white/5 bg-black/20 px-4 py-2 text-gray-600">
                              ← Prev
                            </span>
                          )}
                        <span class="px-2 py-2 font-mono text-xs text-gray-500">
                          {currentPage}
                        </span>
                        {offset + userRows.length < publisherCount
                          ? (
                            <a
                              href={buildUrl("publishers", {
                                q: query,
                                page: currentPage + 1,
                              })}
                              class="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-gray-200 hover:border-cyan-400/30 hover:text-cyan-100"
                            >
                              Next →
                            </a>
                          )
                          : (
                            <span class="rounded-full border border-white/5 bg-black/20 px-4 py-2 text-gray-600">
                              Next →
                            </span>
                          )}
                      </div>
                    </div>
                  )}
                </div>
              )}
          </section>
        )}

        {activeTab === "upload" && (
          <section class="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div class={panelClass("overflow-hidden")}>
              <div class="border-b border-white/10 px-6 py-5">
                <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                  Upload
                </div>
                <h2 class="mt-2 text-lg font-semibold text-white">
                  Send new blobs to Blossom
                </h2>
                <p class="mt-2 text-sm text-gray-400">
                  Files are hashed, deduplicated, and then committed to storage
                  after the upload is verified.
                </p>
              </div>
              <UploadIsland
                requireAuth={config.upload.requireAuth}
                uploadEnabled={config.upload.enabled}
                mediaEnabled={config.media.enabled}
                mediaRequireAuth={config.media.requireAuth}
                mirrorEnabled={config.mirror.enabled}
                mirrorRequireAuth={config.mirror.requireAuth}
              />
            </div>

            <div class="space-y-6">
              <ServerInfo config={config} />
              <div class={panelClass("p-6")}>
                <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                  What gets tracked
                </div>
                <ul class="mt-4 space-y-2 text-sm leading-6 text-gray-300">
                  <li>• Blob hash, MIME type, and byte size</li>
                  <li>• Owner pubkeys that uploaded or re-uploaded the file</li>
                  <li>• Last access timestamp used for pruning</li>
                </ul>
              </div>
            </div>
          </section>
        )}
      </div>
    </Layout>
  );
};
