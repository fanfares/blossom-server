# Initial quarantine implementation

Quarantine is an administrator hold on a content hash, not encryption or
owner-only access. All public GET/HEAD paths (including extension aliases, range
requests and conditional requests) return 404 with no-store. Bytes, metadata and
ownership remain intact. Database-backed holds survive container restarts. No
automatic process clears a hold.

From a file detail page, choose Quarantine file. Event cards and user pages link
to a confirmation listing the currently selected local files. Provide a reason
and confirm. Shared files are blocked for every owner. Event selections use the
existing admin event index; inspect an event first if it is not indexed. User
selections cover current files, not future uploads. Restore is deliberately
per-file, after review, with a required reason. Every action writes an audit
entry in the same database transaction as its state change. The detail page
shows the latest 50 entries; older entries remain stored.

The existing two-factor admin session and same-origin mutation gate protect
these actions. The confirmation selection is checked again before applying the
hold. Single-instance hash locks coordinate holds with deletion/pruning; the
deployment remains limited to one instance. SQL deletion guards also protect
held metadata and owner rows. Both pruning paths refuse physical deletion when
the guarded metadata deletion fails. Quarantined bytes are excluded from quota
usage/reservation checks, without removing purchased grants.

Passive image artwork uses private, no-cache, must-revalidate with its hash as
ETag. Browsers may keep the bytes, but must validate access before reusing them;
quarantine is checked before a 304. Indexed image validation avoids blob-storage
HEAD/GET calls and body transfers. Audio, ciphertext, active documents, missing
MIME metadata and held files retain no-store. This replaces the previous
year-long immutable policy without a stale-while-revalidate exposure window. It
cannot revoke downloads, active streams, old browser caches, copies on other
servers or existing frontend image optimizer caches. External cache removal must
be handled and verified separately; this dashboard does not claim a globally
verified takedown.

This is the foundation described by the supplied draft, not its complete
retention system. It does not implement user unpublish, timed purge, legal
classification, report-filed dates, restricted preservation storage, automatic
report-to-hold integration or CDN purge automation. Files stay in the existing
private storage backend, with serving blocked at Blossom. Do not treat the
reversible quarantine flag as a legally classified hold; those transitions need
their own schema and review process before introduction. Existing deletion
behavior remains for files without a hold.

Verification covers anonymous and forged-origin admin attempts, reason/audit
persistence, GET/HEAD/range/ETag suppression, ownership retention, expiry
pruning, quota accounting and per-file restore. Desktop and 390px previews
verify the confirmation layout and event toolbar alignment.
