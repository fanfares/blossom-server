/** @jsxImportSource @hono/hono/jsx */
import { approvedMintUrls, getActiveMint } from "../db/storage-mints.ts";
import type { FC } from "@hono/hono/jsx";
import type { Client } from "@libsql/client";
import type { Config } from "../config/schema.ts";
import {
  getTreasuryDestination,
  listAdminPayments,
} from "../db/admin-payments.ts";
import { fetchUserProfiles } from "./nostr-profile.ts";
import {
  AdminLayout,
  Badge,
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

export const PaymentsPage: FC<
  {
    db: Client;
    config: Config;
    page: number;
    pubkey: string;
    state: string;
    notice?: string;
  }
> = async ({ db, config, page, pubkey, state, notice }) => {
  const [data, destination, audit, mintUrl, mintAudit] = await Promise.all([
    listAdminPayments(db, page, pubkey, state),
    getTreasuryDestination(
      db,
      config.paidStorage.treasury.lightningAddress ?? "",
    ),
    db.execute(
      "SELECT destination, previous_destination, changed_at, changed_by FROM admin_treasury_audit ORDER BY id DESC LIMIT 10",
    ),
    getActiveMint(db, config.paidStorage.cashu.mintUrl),
    db.execute(
      "SELECT mint_url, previous_mint_url, changed_at, changed_by FROM admin_mint_audit ORDER BY id DESC LIMIT 10",
    ),
  ]);
  const profiles = await fetchUserProfiles([
    ...new Set(data.rows.map((row) => String(row.pubkey))),
  ], 750);
  const baseUrl = `/admin/payments?pubkey=${encodeURIComponent(pubkey)}&state=${
    encodeURIComponent(state)
  }`;
  return (
    <AdminLayout title="Payments" section="payments">
      <PageHeader
        title="Storage payments"
        subtitle="Purchases, credited capacity, and Lightning forwarding"
      />
      {notice && <p role="status" class="admin-notice">{notice}</p>}
      <div class="admin-metrics">
        <div>
          <span>Payments received</span>
          <strong>{Number(data.summary.paid).toLocaleString()} sats</strong>
        </div>
        <div>
          <span>Forwarded to wallet</span>
          <strong>
            {Number(data.summary.forwarded).toLocaleString()} sats
          </strong>
        </div>
        <div>
          <span>Awaiting forwarding</span>
          <strong>
            {Number(data.summary.waiting).toLocaleString()} payouts
          </strong>
        </div>
      </div>
      <section class="admin-finance-settings">
        <h2>Payment destination</h2>
        <p>
          Current Lightning address:{" "}
          <strong>{destination || "Not configured"}</strong>
        </p>
        <p>
          Mint for new invoices: {mintUrl}. Forwarding is{" "}
          {config.paidStorage.treasury.enabled ? "enabled" : "disabled"}.
        </p>
        <p>
          Newly settled payments use this address. Existing queued payouts keep
          their original destination. Forwarded amounts exclude Lightning fees;
          Cashu change remains with the server.
        </p>
        {config.paidStorage.enabled && config.paidStorage.treasury.enabled && (
          <details>
            <summary>Change payment settings</summary>
            <form
              method="post"
              action="/admin/payments/destination"
              class="admin-settings-form"
            >
              <label>
                New Lightning address<input
                  required
                  name="destination"
                  type="text"
                  maxlength={254}
                  value={destination}
                  autocomplete="off"
                />
              </label>
              <label>
                Mint for new invoices<select name="mintUrl" required>
                  {approvedMintUrls(
                    config.paidStorage.cashu.mintUrl,
                    config.paidStorage.approvedMintUrls,
                  ).map((url) => (
                    <option value={url} selected={url === mintUrl}>
                      {url}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                Only server-approved mints are available. Existing invoices and
                payout retries keep their original mint. Changing mints does not
                move existing Cashu funds.
              </p>
              <label>
                Confirm admin password<input
                  required
                  name="password"
                  type="password"
                  autocomplete="current-password"
                />
              </label>
              <button type="submit">
                Save payment settings
              </button>
            </form>
          </details>
        )}
        <details>
          <summary>Recent payment settings changes</summary>
          {audit.rows.length === 0 && mintAudit.rows.length === 0
            ? <p>No dashboard changes. Using the configured destination.</p>
            : (
              <ul>
                {audit.rows.map((row) => (
                  <li>
                    {formatDate(Number(row.changed_at))}:{" "}
                    {String(row.previous_destination)} →{" "}
                    {String(row.destination)} ·{" "}
                    <a href={`/admin/users/${row.changed_by}`}>
                      {truncateHash(String(row.changed_by))}
                    </a>
                  </li>
                ))}
                {mintAudit.rows.map((row) => (
                  <li>
                    {formatDate(Number(row.changed_at))}: Mint{" "}
                    {String(row.previous_mint_url)} → {String(row.mint_url)} ·
                    {" "}
                    {truncateHash(String(row.changed_by))}
                  </li>
                ))}
              </ul>
            )}
        </details>
      </section>
      <form
        method="get"
        action="/admin/payments"
        class="admin-search admin-filter-form"
      >
        <label class="admin-filter-label">
          User pubkey<input
            name="pubkey"
            value={pubkey}
            placeholder="64-character hex pubkey"
          />
        </label>
        <label class="admin-filter-label">
          Purchase status<select name="state">
            <option value="">All purchases</option>
            {["pending", "paid", "expired", "failed"].map((value) => (
              <option value={value} selected={state === value}>{value}</option>
            ))}
          </select>
        </label>
        <button type="submit">Filter</button>
        <a class="admin-filter-clear" href="/admin/payments">Clear</a>
      </form>
      <p class="admin-caption">
        {data.total.toLocaleString()}{" "}
        purchases. Pending invoices are unpaid. Capacity is granted only after
        crediting. An expired grant does not delete retained files.
      </p>
      {data.rows.length === 0
        ? <EmptyState message="No storage purchases match these filters." />
        : (
          <div class="admin-payment-records">
            <Table>
              <Thead>
                <tr>
                  <Th>User / purchase</Th>
                  <Th>Purchase</Th>
                  <Th>Capacity / term</Th>
                  <Th>Wallet forwarding</Th>
                  <Th>Created</Th>
                </tr>
              </Thead>
              <Tbody>
                {data.rows.map((row) => {
                  const profile = profiles.get(String(row.pubkey));
                  return (
                    <tr>
                      <Td label="User / purchase">
                        <a href={`/admin/users/${row.pubkey}`}>
                          {profile?.displayName || profile?.display_name ||
                            profile?.name ||
                            truncateHash(String(row.pubkey))}
                        </a>
                        <small class="admin-subtext">{String(row.id)}</small>
                        <small class="admin-subtext">
                          Mint: {String(
                            row.mint_url || config.paidStorage.cashu.mintUrl,
                          )}
                        </small>
                      </Td>
                      <Td label="Purchase">
                        <strong>
                          {Number(row.amount_sats).toLocaleString()} sats
                        </strong>
                        <small class="admin-subtext">
                          <Badge
                            color={row.state === "paid" ? "green" : "gray"}
                          >
                            {String(row.state)}
                          </Badge>{" "}
                          {row.credited_at
                            ? "Capacity credited"
                            : "Not credited"}
                        </small>
                      </Td>
                      <Td label="Capacity / term">
                        {formatBytes(Number(row.quota_bytes))}
                        <small class="admin-subtext">
                          {Number(row.is_extension)
                            ? "Renewal of existing capacity"
                            : "New capacity"}
                        </small>
                        {Boolean(row.grant_expires_at) && (
                          <small class="admin-subtext">
                            Expires {formatDate(Number(row.grant_expires_at))}
                          </small>
                        )}
                        <small class="admin-subtext">
                          {Math.round(Number(row.duration_seconds) / 86400)}
                          {" "}
                          days
                        </small>
                      </Td>
                      <Td label="Wallet forwarding">
                        {row.destination
                          ? (
                            <>
                              <span>{String(row.destination)}</span>
                              <small class="admin-subtext">
                                {String(row.transfer_state)}
                                {row.transfer_state === "paid"
                                  ? ` · ${
                                    Number(row.forwarded_amount_sats)
                                      .toLocaleString()
                                  } sats forwarded`
                                  : ` · ${Number(row.attempt_count)} attempts`}
                              </small>
                              {row.forwarded_at && (
                                <small class="admin-subtext">
                                  {formatDate(Number(row.forwarded_at))}
                                </small>
                              )}
                            </>
                          )
                          : <span>Not queued for forwarding</span>}
                      </Td>
                      <Td label="Created">
                        {formatDate(Number(row.created_at))}
                      </Td>
                    </tr>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        )}
      <Pagination
        page={page}
        total={data.total}
        pageSize={50}
        baseUrl={baseUrl}
      />
    </AdminLayout>
  );
};
