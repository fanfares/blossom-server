import type { FC } from "@hono/hono/jsx";
import type { BlobStats } from "../db/blobs.ts";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val % 1 === 0 ? val : val.toFixed(2)} ${units[i]}`;
}

const StatCard: FC<{ label: string; value: string | number }> = (
  { label, value },
) => (
  <div class="flex min-h-28 flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur-sm">
    <span class="text-2xl font-semibold leading-none tracking-tight text-white sm:text-3xl">
      {value}
    </span>
    <span class="mt-4 text-[11px] uppercase tracking-[0.28em] text-cyan-200/55">
      {label}
    </span>
  </div>
);

export const StatsBar: FC<{ stats: BlobStats }> = ({ stats }) => (
  <section>
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-sm font-semibold uppercase tracking-[0.35em] text-cyan-200/55">
        Server Stats
      </h2>
    </div>
    <div class="grid gap-4 sm:grid-cols-3">
      <StatCard label="Total Blobs" value={stats.blobCount.toLocaleString()} />
      <StatCard label="Storage Used" value={formatBytes(stats.totalSize)} />
      <StatCard
        label="Uploads (24h)"
        value={stats.dailyUploads.toLocaleString()}
      />
    </div>
  </section>
);
