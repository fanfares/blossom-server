/** @jsxImportSource @hono/hono/jsx */
import type { FC } from "@hono/hono/jsx";
import { AdminLayout, PageHeader } from "./layout.tsx";

export const QuarantinePage: FC<
  { scope: string; id: string; hashes: string[]; active: boolean }
> = ({ scope, id, hashes, active }) => (
  <AdminLayout title="Quarantine" section="blobs">
    <PageHeader
      title={active ? "Restore public access" : "Quarantine files"}
      subtitle={`${hashes.length} stored file(s) selected`}
    />
    <p class="text-sm text-gray-400">
      {active
        ? "Restoring makes this file publicly accessible again."
        : "Public access will stop. File bytes and ownership records will be retained, and automatic pruning and user deletion will be blocked."}
    </p>
    <p class="mt-3 text-sm text-gray-400">
      This affects the selected files for every owner. A user action covers
      their current files only; it does not suspend future uploads. External
      cached copies require separate removal verification.
    </p>
    {hashes.length > 0
      ? (
        <form
          method="post"
          action="/admin/quarantine"
          class="admin-settings-form"
        >
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="id" value={id} />
          <input
            type="hidden"
            name="action"
            value={active ? "restore" : "quarantine"}
          />
          <input type="hidden" name="selection" value={hashes.join(",")} />
          <label>
            Reason<input
              name="reason"
              required
              minlength={3}
              maxlength={1000}
              placeholder="Explain this moderation decision"
            />
          </label>
          <button type="submit">
            {active ? "Confirm restore" : "Confirm quarantine"}
          </button>
          <a href="/admin/blobs">Cancel</a>
        </form>
      )
      : (
        <p class="mt-3 text-gray-400">
          No stored files found. For an event, inspect it first to index its
          local files.
        </p>
      )}
    <details class="mt-5">
      <summary>Selected file hashes</summary>
      <ul class="admin-moderation-selection">
        {hashes.map((hash) => (
          <li>
            <a class="text-sm text-cyan-100" href={`/admin/blobs/${hash}`}>
              {hash}
            </a>
          </li>
        ))}
      </ul>
    </details>
  </AdminLayout>
);
