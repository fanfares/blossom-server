# Staging security remediation

This candidate starts from origin/staging at
a4220233e913cb6c3c917d06e0e0a74f3d8c528f. It implements the five demonstrated
audit findings and the related repository defects listed below. It is a source
remediation, not a claim that the public deployment or all external services
have been verified.

## Confirmed findings

| Finding                                                              | Enforcement boundary and resulting behavior                                                                                                                                                           | Regression evidence                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: relay membership accepted unverified events                      | Verify signatures, exact curator author, kind and plausible timestamp before selecting a contact list; validate member keys and cap response count. A genuinely signed empty list revokes membership. | Forged events, wrong authors/kinds and signed revocation list tested through the relay collection helper. Existing refresh, stale-cache and break-glass behavior retained.                            |
| F2: active blob documents execute with application-origin privileges | Sandbox CSP and nosniff on blob responses, including aliases, metadata fallback, HEAD, ranges and conditional responses. HTML/XHTML download as attachments.                                          | HTTP regressions assert isolation headers across response variants. Ordinary blob bytes and ranges remain covered by the existing suite.                                                              |
| F3: last-owner deletion races new owners                             | DELETE, prune, admin deletion, upload, mirror and media use the same per-hash mutation lock; authoritative metadata is read inside the lock. Prune also rereads access eligibility after waiting.     | Deterministic DELETE test holds the upload lock, adds an owner, and verifies that the owner's bytes survive.                                                                                          |
| F4: malformed expiration never expires                               | Require one decimal safe-integer expiration; reject malformed tags, unsafe event timestamps and duplicate auth actions. Expiry is enforced numerically.                                               | Genuinely signed NaN, Infinity, suffix garbage, fractional, unsafe and duplicate expiry inputs are rejected; existing valid tokens remain accepted.                                                   |
| F5: checkout races bypass cap and reuse                              | All new, aligned and extension checkouts share a buyer lock persisted in libSQL. Persistence is fenced by the live lock token in a write transaction. Quote reuse precedes the cap check.             | Fifteen competing selections through two service instances produce at most ten invoices. Matching requests reuse the same purchase even at the cap. Existing extension/alignment tests remain intact. |

## Related repairs

- Treasury claims and every subsequent state write require a unique, still-live
  lease token and check affected rows. Renew ownership before external steps.
  Expired or superseded workers cannot overwrite a new worker's results.
- After ambiguous mint issuance, restore the original persisted blinded outputs
  using NUT-09 and their original unblinding material. Reject incomplete or
  mismatched restoration. No replacement secrets or invoice are generated.
- Before replaying a persisted melt, check its status. PAID is reconciled with
  original change outputs; PENDING is retained without another submission.
  Recover a paid result after a lost melt response. Only a proven expired UNPAID
  quote may be discarded for a new payout attempt.
- Persist mint identity per purchase. Legacy rows bind to
  paidStorage.cashu.legacyMintUrl, whose default preserves staging's original
  Minibits mint. A different current mint fails closed for those purchases.
- Durable per-buyer/global one-minute request limits count failed external quote
  and verification attempts. Limits are 10/100 quote creations and 60/600 quote
  checks, respectively. Reusing an invoice does not consume a creation attempt.
- Expired upload reservations cannot be renewed back to life.
- Intentional deletion writes a durable tombstone before removing metadata and
  the object. Failed removal returns an error and stays hidden from fallback
  reads. Pruning retries unfinished removals. Completed tombstones remain so
  leftover aliases are hidden; a deliberate verified reupload clears the
  tombstone. Storage deletion is idempotent and failures remain retryable.
- Upload workers hash and write in one backpressured pass. Enforce actual byte
  counts, declared Content-Length, a 60-second stalled-read timeout and a
  one-hour stream lifetime. Reject jobs assigned to failed workers and restart
  workers with a bounded restart budget.
- Write sessions open their adapter stream writer lazily, close resources on
  commit/abort, and no longer poll an unused file handle.
- LNURL JSON responses are bounded to 64 KiB and a 10-second body deadline.
  Error response bodies are cancelled.
- Outbound HTTP connections use the exact validated IP. HTTPS bridges the HTTP
  client to a native TLS connection verified against the original hostname; HTTP
  parsing remains with Deno's fetch implementation. Redirects still undergo
  independent public-address validation.
- The legacy Basic Auth dashboard requires the configured Origin on mutations
  and sends no-store/frame-denial headers. This is the admin implementation
  actually present in staging.
- Manual deployment now checks formatting, lint, types, tests and the browser
  bundle before deployment. The workflow embeds the source revision in both
  builds and checks the live container header and Worker metadata revision.

## Validation and limits

The regression suite uses isolated databases, files and mocked payment
providers. Native HTTP/TLS fixtures verify connection pinning, preserved Host
and rejection of the wrong TLS hostname. The fixture private key is
intentionally public test material with no relationship to service credentials.

Cashu recovery tests exercise the application forwarder with mocked mint
responses and original persisted output data; they do not prove that Minibits
supports every recovery path or verify real spendable proofs after an outage.
Browser tests assert delivered headers, not interactive execution in every
browser. Worker compilation is a local dry run; a Docker image and deployed
runtime were not validated here.

The newer iefan/nostr-admin-panel branch is separate from this staging base. Its
challenge replay persistence, session revocation and admin-specific policy are
not changed by this candidate. Merge/rebase that work onto this candidate and
review the combined source before deploying it.

## Rollout requirements

1. Back up canonical Turso metadata and recoverable treasury material. Migration
   008_security_state.sql is additive and replayable. Avoid reverting to an
   older runtime while unfinished tombstones or fenced transfers exist: the
   older code does not enforce those states.
2. If upgrading a custom mint, set legacyMintUrl to the provider that created
   pre-migration purchases. Drain outstanding purchases and treasury transfers
   before changing mint identity. Keep old keysets and original preview secrets
   available for recovery.
3. Retain the single-writer blob topology: the staging Worker routes to one
   primary container and sets max_instances to 1. Blob locks are process-local.
   Payment locks and treasury fencing are durable, but they do not turn storage
   commits/deletion into distributed transactions. Introduce distributed blob
   coordination before allowing independent writers to share bucket/database.
4. Deploy the reviewed candidate to staging via the checked workflow. Check both
   served revisions and record the Cloudflare version/container image digest.
   Local deploys without revision stamping report unknown.
5. Purge previously cached active documents at the CDN when deploying the new
   headers. Previously cached browser responses and already-started downloads
   cannot be revoked by a server tombstone. Use a separate credential-free blob
   origin if strong separation and immediate policy change are required.
6. Complete controlled small-value mint/melt tests, injecting lost responses
   after remote success and restarting before local persistence. Confirm quota
   is credited once, payout is not repeated, and retained change is spendable.
   Persisted proofs and blinding data are money-bearing recovery material. This
   PR does not add automatic sweeping/export of retained change.
7. Decide public metadata policy explicitly. The public gallery, /__meta owner
   graph and configured /list behavior remain intentional public features. They
   are not private-file authorization; encrypted files require the external
   application's encryption/key delivery design. Restrict these APIs if their
   disclosure is unintended.
8. Verify real secret scoping, database/bucket isolation, GitHub environment and
   branch protection, egress controls, monitoring and parser/runtime privileges.
   Those external settings and a comprehensive dependency
   advisory/secret-history scan are not established by this source patch.

The PR is reviewable and does not itself deploy, merge, move funds or mutate the
live staging database.

## Candidate verification results

| Check                                                                | Result                            |
| -------------------------------------------------------------------- | --------------------------------- |
| Deno formatting check                                                | Passed                            |
| Deno lint                                                            | Passed                            |
| Deno type check of main.ts                                           | Passed                            |
| Full unit/E2E suite with test permissions                            | 200 passed, 0 failed              |
| Browser bundle build                                                 | Passed                            |
| Staging Worker dry-run compilation, without container rollout/upload | Passed with local Wrangler 4.94.0 |

The complete test command was: deno test --allow-net --allow-read --allow-write
--allow-env --allow-ffi --allow-sys tests/unit/ tests/e2e/. Loopback HTTP/TLS
fixtures required running outside the desktop filesystem/network sandbox. The
fixed triggers and legitimate controls are described in the findings table. The
independent candidate review identified missing mirror/media locking and
uncancelled LNURL error bodies; both were confirmed and corrected before the
final checks. PR checks run the same suite with a frozen dependency install.
Deployment uses the repository's pinned Wrangler 4.129.0; local compilation did
not exercise that deployment version or build/upload a container image.
