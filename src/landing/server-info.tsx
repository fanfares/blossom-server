import type { FC } from "@hono/hono/jsx";
import type { Config } from "../config/schema.ts";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val % 1 === 0 ? val : val.toFixed(2)} ${units[i]}`;
}

export const ServerInfo: FC<{ config: Config }> = ({ config }) => {
  const { upload, storage, media } = config;
  const allowedTypes = storage.rules.length > 0
    ? [...new Set(storage.rules.map((r) => r.type))]
    : ["All types accepted"];

  return (
    <section id="server-info">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-sm font-semibold uppercase tracking-[0.35em] text-cyan-200/55">
          Server Info
        </h2>
      </div>
      <div class="space-y-4 rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_90px_rgba(0,0,0,0.45)] backdrop-blur-sm">
        {/* Upload section */}
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm text-gray-400">Max upload size</span>
          <span class="font-mono text-sm text-white">
            {formatBytes(upload.maxSize)}
          </span>
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm text-gray-400">Authentication</span>
          {upload.requireAuth
            ? (
              <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
                Required
              </span>
            )
            : (
              <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                Open
              </span>
            )}
        </div>
        <div class="flex items-start justify-between gap-4">
          <span class="text-sm text-gray-400 shrink-0">Accepted types</span>
          <div class="flex flex-wrap gap-1 justify-end">
            {allowedTypes.map((t) => (
              <span class="rounded-full border border-white/10 bg-black/40 px-2.5 py-0.5 font-mono text-xs text-gray-200">
                {t}
              </span>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div class="border-t border-white/10" />

        {/* Media optimization section */}
        <div class="flex items-center justify-between gap-4">
          <span class="text-sm text-gray-400">Media optimization</span>
          {media.enabled
            ? (
              <span class="rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-200">
                Enabled
              </span>
            )
            : (
              <span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-semibold text-gray-400">
                Disabled
              </span>
            )}
        </div>
        {media.enabled && (
          <>
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-gray-400">Media auth</span>
              {media.requireAuth
                ? (
                  <span class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
                    Required
                  </span>
                )
                : (
                  <span class="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-200">
                    Open
                  </span>
                )}
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-gray-400">Max media size</span>
              <span class="font-mono text-sm text-white">
                {formatBytes(media.maxSize)}
              </span>
            </div>
            <div class="flex items-center justify-between gap-4">
              <span class="text-sm text-gray-400">Image output</span>
              <span class="font-mono text-xs text-gray-300 text-right">
                {media.image.outputFormat} ·{" "}
                {media.image.maxWidth}×{media.image.maxHeight}{" "}
                · q{media.image.quality}
                {media.image.progressive ? " · progressive" : ""}
                {` · ${media.image.fps}fps`}
              </span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-gray-400 text-sm">Video output</span>
              <span class="font-mono text-gray-300 text-xs">
                {media.video.format} · {media.video.videoCodec} ·{" "}
                {media.video.audioCodec} · {media.video.maxHeight}p ·{" "}
                {media.video.maxFps}fps · q{media.video.quality}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
