# PR #20 review notes

## Outcome

The dashboard and payment changes are ready for general review. Keep PR #20
stacked on PR #18 until that review is accepted. This review does not authorize
merging or a production deployment.

## Checks performed

- Full Deno suite: **212 passed, 0 failed**. Formatting, lint, and `main.ts`
  type checking passed.
- Browser checks with synthetic local data: expanded payment settings, readable
  payment records, and matching Filter/Clear positions and 40px heights. Desktop
  and phone layouts were checked during the dashboard work.
- Existing regressions cover invoice reuse, concurrent quote limits, idempotent
  storage crediting, renewals/aligned purchases, upload reservations, durable
  treasury retries, admin authentication, origin checks, and blob routing.
- New mint tests verify legacy invoice snapshots, original-mint settlement and
  payout routing after a switch, persistence across reopening the database,
  rejection of unapproved mints, and atomic rejection of a combined wallet/mint
  change. Existing aligned/renewal paths also write mint snapshots atomically.
- Report verification, persisted review state, quota display without uploads,
  indefinite staging retention, and private payment fields are covered by the
  dashboard operations test.

## Payment invariants

Every new purchase records its issuing mint in the same database batch as its
invoice. Changing the active mint first snapshots legacy invoices using the
configured mint. Settlement and treasury recovery select providers using the
purchase's saved mint; existing Cashu funds are never sent to a different mint
because the operator changes settings. New checkout selections use the current
approved mint; an already-open invoice may still be reused with its original
mint.

Wallet and mint changes require the existing Nostr/password-authenticated admin
session, same-origin submission, password confirmation, and a bounded body. They
are persisted and audited together in one write transaction. Invalid mint
selection leaves both settings unchanged. Existing treasury transfers preserve
their original destination. Dashboard payment queries omit Cashu proofs and
payment preimages.

Only server-approved mints are selectable. Additional mints belong in
`paidStorage.approvedMintUrls` after operator vetting; these must be HTTPS URLs
without credentials, fragments, or query strings. Staging currently approves
only the existing Minibits mint. Removing an active mint from approval stops new
quotes until an approved mint is selected, while historical purchases remain
recoverable using their saved mint.

## Other review findings addressed

Re-inspecting an event previously replaced its searchable row and cleared saved
author identity before an external profile lookup completed. Re-inspection now
updates the event title/search text while retaining its saved author name and
NIP-05. The existing refresh path also preserves those fields on profile
failure.

## Deployment and review limits

No real Lightning payments, wallet destination changes, or mint switches were
performed on staging during automated or browser testing. Provider routing was
verified with deterministic test providers. A newly approved mint still needs
operator verification of its Cashu/Lightning support and reliability before real
funds are routed through it.

The supported deployment remains one Cloudflare container (`max_instances: 1`).
The purchase and blob mutation locks are per process; scaling requires shared
coordination first. Report sync is a bounded view of reports available from the
configured relays about local uploaders/indexed events. It is not a complete
network-wide report archive. Staging disables automatic retention pruning;
deliberate owner deletion remains available.

After reviewer approval, merge PR #20 into PR #18 and rerun the checks on the
combined branch before merging to staging. Production follows the existing
reviewed staging-to-master release and manual GitHub Actions deploy process.
