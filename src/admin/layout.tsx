import type { Child, FC } from "@hono/hono/jsx";

// Shared inline JS helpers: confirm → fetch → reload for action buttons.
// Defined once in the layout head, used across all admin pages.
const ACTION_SCRIPT = `
async function adminAction(url, method, msg) {
  if (!confirm(msg)) return;
  try {
    const res = await fetch(url, { method });
    if (res.ok) {
      location.reload();
    } else {
      const body = await res.json().catch(() => ({}));
      alert('Error ' + res.status + (body.error ? ': ' + body.error : ''));
    }
  } catch (e) {
    alert('Request failed: ' + e.message);
  }
}
`;

interface LayoutProps {
  title: string;
  section: "blobs" | "users" | "rules" | "reports";
  children?: Child;
}

const NAV_ITEMS = [
  { id: "blobs", label: "Blobs", href: "/admin/blobs" },
  { id: "users", label: "Users", href: "/admin/users" },
  { id: "rules", label: "Rules", href: "/admin/rules" },
  { id: "reports", label: "Reports", href: "/admin/reports" },
] as const;

export const AdminLayout: FC<LayoutProps> = ({ title, section, children }) => (
  <html lang="en" class="bg-[#030303] text-gray-100">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{title} — Blossom Admin</title>
      <link rel="stylesheet" href="/admin.css" />
      {/* deno-fmt-ignore */}
      <script dangerouslySetInnerHTML={{ __html: ACTION_SCRIPT }} />
    </head>
    <body class="min-h-screen overflow-x-hidden bg-[#030303] text-gray-100 antialiased">
      <div class="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.10),_transparent_24%),radial-gradient(circle_at_bottom,_rgba(14,165,233,0.06),_transparent_34%)]" />
      <div class="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:72px_72px] opacity-20 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <main class="relative mx-auto min-h-screen w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <header class="mb-8 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_28px_90px_rgba(0,0,0,0.45)] backdrop-blur-sm">
          <div class="relative p-5 sm:p-7">
            <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.10),_transparent_25%)]" />
            <div class="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
                  Fanfares · secured moderation
                </div>
                <h1 class="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Blossom Admin
                </h1>
                <p class="mt-2 max-w-xl text-sm leading-6 text-gray-400">
                  Inspect storage, trace Nostr events, and moderate uploaded
                  media from one private workspace.
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <nav aria-label="Admin sections">
                  <ul class="flex flex-wrap gap-2">
                    {NAV_ITEMS.map((item) => (
                      <li key={item.id}>
                        <a
                          href={item.href}
                          class={item.id === section
                            ? "inline-flex rounded-full border border-cyan-400/30 bg-cyan-400/15 px-4 py-2 text-sm font-semibold text-cyan-100 shadow-[0_0_0_1px_rgba(34,211,238,0.14)]"
                            : "inline-flex rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-semibold text-gray-300 transition-colors hover:border-cyan-400/30 hover:bg-cyan-400/10 hover:text-cyan-100"}
                        >
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
                <form method="post" action="/admin/logout">
                  <button
                    type="submit"
                    class="rounded-full border border-white/10 px-4 py-2 text-sm text-gray-400 transition-colors hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </header>

        <section>{children}</section>
        <footer class="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 py-5 text-[11px] uppercase tracking-[0.24em] text-gray-600">
          <span>Nostr identity + password verified</span>
          <a href="/" class="transition-colors hover:text-cyan-200">
            Public dashboard ↗
          </a>
        </footer>
      </main>
    </body>
  </html>
);

// ── Shared UI primitives ─────────────────────────────────────────────────────

export const PageHeader: FC<{ title: string; subtitle?: string }> = (
  { title, subtitle },
) => (
  <div class="mb-6">
    <div class="text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
      Moderation workspace
    </div>
    <h2 class="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
      {title}
    </h2>
    {subtitle && <p class="mt-2 text-sm text-gray-400">{subtitle}</p>}
  </div>
);

export const Table: FC<{ children?: Child }> = ({ children }) => (
  <div class="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.035] shadow-[0_20px_70px_rgba(0,0,0,0.32)] backdrop-blur-sm">
    <table class="min-w-full divide-y divide-white/10 text-sm">
      {children}
    </table>
  </div>
);

export const Thead: FC<{ children?: Child }> = ({ children }) => (
  <thead class="bg-white/[0.035] text-[10px] uppercase tracking-[0.22em] text-cyan-200/45">
    {children}
  </thead>
);

export const Tbody: FC<{ children?: Child }> = ({ children }) => (
  <tbody class="divide-y divide-white/[0.07]">{children}</tbody>
);

export const Th: FC<{ children?: Child }> = ({ children }) => (
  <th class="px-4 py-4 text-left font-medium">{children}</th>
);

export const Td: FC<{ children?: Child; mono?: boolean }> = (
  { children, mono },
) => (
  <td class={`px-4 py-4 text-gray-300 ${mono ? "font-mono text-xs" : ""}`}>
    {children}
  </td>
);

export const Badge: FC<{ children?: Child; color?: string }> = (
  { children, color = "gray" },
) => {
  const colors: Record<string, string> = {
    gray: "border-white/10 bg-white/[0.05] text-gray-300",
    red: "border-red-400/20 bg-red-400/10 text-red-300",
    yellow: "border-amber-400/20 bg-amber-400/10 text-amber-200",
    green: "border-emerald-400/20 bg-emerald-400/10 text-emerald-200",
    purple: "border-violet-400/20 bg-violet-400/10 text-violet-200",
    blue: "border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
  };
  return (
    <span
      class={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        colors[color] ?? colors.gray
      }`}
    >
      {children}
    </span>
  );
};

export const DangerButton: FC<{
  onclick: string;
  children?: Child;
}> = ({ onclick, children }) => (
  <button
    type="button"
    onclick={onclick}
    class="inline-flex cursor-pointer items-center rounded-full border border-red-400/20 bg-red-400/10 px-3 py-1 text-xs font-medium text-red-300 transition-colors hover:border-red-400/40 hover:bg-red-400/15 hover:text-red-200"
  >
    {children}
  </button>
);

export const SecondaryButton: FC<{
  onclick: string;
  children?: Child;
}> = ({ onclick, children }) => (
  <button
    type="button"
    onclick={onclick}
    class="inline-flex cursor-pointer items-center rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-medium text-gray-300 transition-colors hover:border-cyan-400/25 hover:bg-cyan-400/10 hover:text-cyan-100"
  >
    {children}
  </button>
);

export const EmptyState: FC<{ message: string }> = ({ message }) => (
  <div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.025] py-16 text-center text-sm text-gray-500">
    {message}
  </div>
);

// ── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationProps {
  page: number;
  total: number;
  pageSize: number;
  baseUrl: string; // e.g. "/admin/blobs?q=foo"
}

export const Pagination: FC<PaginationProps> = (
  { page, total, pageSize, baseUrl },
) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const sep = baseUrl.includes("?") ? "&" : "?";
  const prevHref = page > 1 ? `${baseUrl}${sep}page=${page - 1}` : null;
  const nextHref = page < totalPages
    ? `${baseUrl}${sep}page=${page + 1}`
    : null;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div class="mt-5 flex items-center justify-between text-sm text-gray-500">
      <span>
        {start}–{end} of {total}
      </span>
      <div class="flex gap-2">
        {prevHref
          ? (
            <a
              href={prevHref}
              class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-gray-300 transition-colors hover:border-cyan-400/25 hover:text-cyan-100"
            >
              ← Prev
            </a>
          )
          : (
            <span class="cursor-not-allowed rounded-full border border-white/[0.06] px-3 py-1 text-gray-700">
              ← Prev
            </span>
          )}
        <span class="px-3 py-1">
          {page} / {totalPages}
        </span>
        {nextHref
          ? (
            <a
              href={nextHref}
              class="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-gray-300 transition-colors hover:border-cyan-400/25 hover:text-cyan-100"
            >
              Next →
            </a>
          )
          : (
            <span class="cursor-not-allowed rounded-full border border-white/[0.06] px-3 py-1 text-gray-700">
              Next →
            </span>
          )}
      </div>
    </div>
  );
};

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function truncateHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace("T", " ").slice(0, 19) +
    " UTC";
}
