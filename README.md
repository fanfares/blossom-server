# Blossom Server

A content-addressed blob storage server implementing the
[Blossom](https://github.com/hzrd149/blossom) protocol. Files are stored and
retrieved by their SHA-256 hash. Built with [Deno 2](https://deno.com),
[Hono](https://hono.dev), and [LibSQL](https://turso.tech/libsql).

## Features

- **BUD-01** — Blob retrieval (`GET`/`HEAD /:sha256`) with range requests,
  ETag/304, and CORS
- **BUD-02** — Upload (`PUT /upload`), delete (`DELETE /:sha256`), and list
  (`GET /list/:pubkey`)
- **BUD-04** — Server-side mirror (`PUT /mirror`) with SSRF protection
- **BUD-05** — Media optimisation (`PUT /media`): image resize/convert via
  sharp, video transcode via ffmpeg
- **BUD-06** — Upload preflight (`HEAD /upload`) to check size, type, and pool
  availability before sending the body
- **BUD-08** — `nip94` field in all blob descriptor responses
- **BUD-09** — Blob reports (`PUT /report`) accepting NIP-56 kind:1984 events
- **BUD-11** — Nostr-signed event authentication (kind 24242)
- Zero-copy streaming uploads — no body buffering, SHA-256 computed in a
  dedicated worker pool
- Content-addressed deduplication — re-uploading an existing hash skips the
  write
- Configurable storage retention rules with MIME-type glob patterns and
  per-pubkey scoping
- Automatic prune loop — expired blobs are removed on a configurable timer
- Local filesystem, S3-compatible, and Cloudflare R2 storage backends
- Optional server-side rendered admin dashboard at `/admin` (Hono JSX)
- Optional server-rendered landing page at `/`
- Docker-ready with a single-stage Dockerfile and health check

## Requirements

- **Docker + Docker Compose** (recommended)
- **or** [Deno 2.x](https://docs.deno.com/runtime/getting_started/installation/)
  for running from source

## Quick Start — Docker

```sh
# 1. Copy and edit the config
cp config.example.yml config.yml

# 2. Set at minimum: port, publicDomain, and storage backend
#    (see Configuration below)

# 3. Start the server
docker compose up --build
```

The server listens on port `3000` by default. Blob data and the SQLite database
are stored in a named Docker volume (`data`). The config file is mounted
read-only from the host.

## Quick Start — From Source

```sh
# 1. Clone the repo
git clone https://github.com/hzrd149/blossom-server.git
cd blossom-server

# 2. Copy and edit the config
cp config.example.yml config.yml

# 3. Build the landing page client bundle
deno task build

# 4. Start in development mode (file-watching)
deno task dev
```

For production:

```sh
deno task build
deno task start
```

Pass a custom config path as the first argument:

```sh
deno task start /etc/blossom/config.yml
```

## Configuration

Configuration is loaded from a YAML file (default: `config.yml` in the working
directory). Environment variables can be substituted anywhere in the file using
`${VAR_NAME}` syntax.

### Key Options

| Key                          | Default          | Description                                                                                                            |
| ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `port`                       | `3000`           | TCP port to listen on                                                                                                  |
| `host`                       | `0.0.0.0`        | Bind interface (`127.0.0.1` for loopback-only behind a proxy)                                                          |
| `publicDomain`               | _(Host header)_  | Bare hostname this server is publicly reachable at, used in blob URLs and BUD-11 server-tag validation (no `https://`) |
| `database.path`              | `data/sqlite.db` | Local SQLite database path                                                                                             |
| `database.url`               | —                | Remote libSQL/Turso URL (`libsql://your-db.turso.io` or `http://localhost:8080`)                                       |
| `storage.backend`            | `local`          | Storage backend: `local`, `s3`, or `r2`                                                                                |
| `storage.local.dir`          | `./data/blobs`   | Directory for blob files (local backend)                                                                               |
| `storage.removeWhenNoOwners` | `false`          | Delete blobs with no owners on each prune cycle, regardless of expiry rules                                            |
| `upload.enabled`             | `true`           | Enable `PUT /upload`                                                                                                   |
| `upload.requireAuth`         | `true`           | Require Nostr auth for uploads                                                                                         |
| `upload.maxSize`             | `2147483648`     | Maximum upload size in bytes (2 GB)                                                                                    |
| `upload.workers`             | `0`              | Upload worker threads (0 = one per CPU core)                                                                           |
| `upload.requirePubkeyInRule` | `false`          | Reject uploads unless the uploader's pubkey appears in a storage rule                                                  |
| `mirror.enabled`             | `true`           | Enable `PUT /mirror` (BUD-04)                                                                                          |
| `mirror.connectTimeout`      | `30000`          | Timeout (ms) to connect to the origin; 0 = no limit                                                                    |
| `mirror.bodyTimeout`         | `0`              | Timeout (ms) for full body transfer from origin; 0 = no limit                                                          |
| `delete.requireAuth`         | `true`           | Require Nostr auth for deletes                                                                                         |
| `list.enabled`               | `false`          | Enable `GET /list/:pubkey` (BUD-02); disabled by default                                                               |
| `list.requireAuth`           | `false`          | Require Nostr auth for list requests                                                                                   |
| `list.allowListOthers`       | `true`           | Allow listing blobs belonging to a different pubkey                                                                    |
| `media.enabled`              | `false`          | Enable `PUT /media` (BUD-05); requires ffmpeg for video                                                                |
| `report.enabled`             | `true`           | Enable `PUT /report` (BUD-09)                                                                                          |
| `landing.enabled`            | `true`           | Enable the landing page at `/`                                                                                         |
| `landing.title`              | `Blossom Server` | Page title shown in `<title>` and `<h1>`                                                                               |
| `dashboard.enabled`          | `false`          | Enable the admin dashboard at `/admin`                                                                                 |

For all options with inline documentation, see
[`config.example.yml`](config.example.yml).

### S3 Storage Backend

```yaml
storage:
  backend: s3
  s3:
    endpoint: https://s3.amazonaws.com
    bucket: my-blossom-bucket
    accessKey: "${S3_ACCESS_KEY}"
    secretKey: "${S3_SECRET_KEY}"
    region: us-east-1
    # Optional: redirect GET requests to this URL prefix instead of proxying
    # publicURL: https://my-bucket.s3.amazonaws.com/
    # Local buffer directory for uploads before committing to S3
    tmpDir: ./data/s3-tmp
```

### Cloudflare R2 Storage Backend

R2 is S3-compatible and is supported as a first-class backend.

```yaml
storage:
  backend: r2
  r2:
    accountId: "${CF_ACCOUNT_ID}"
    bucket: my-blossom-r2-bucket
    accessKey: "${R2_ACCESS_KEY_ID}"
    secretKey: "${R2_SECRET_ACCESS_KEY}"
    # Optional: redirect GET requests to this URL prefix instead of proxying
    # publicURL: https://media.example.com/
    # Local buffer directory for uploads before committing to R2
    tmpDir: ./data/r2-tmp
```

How to get R2 credentials:

1. In Cloudflare Dashboard, create an R2 bucket.
2. Create an R2 API token with Object Read + Write on that bucket.
3. Create access keys from that token.
4. Set `CF_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in your
   runtime environment.

## Deploying Behind Cloudflare

This server is a Deno process with ffmpeg/sharp support, so run it as a
container/VM origin and put Cloudflare in front.

1. Deploy this image on your preferred runtime (Docker host, Fly.io, Railway,
   Kubernetes, etc.).
2. Set `storage.backend: r2` and the `storage.r2` credentials in `config.yml`.
3. Set `publicDomain` to your Cloudflare hostname (for example
   `media.example.com`).
4. In Cloudflare DNS, point `media.example.com` to your origin (proxied/orange
   cloud enabled).
5. Optional but recommended: map your R2 bucket to the same hostname and set
   `storage.r2.publicURL` so GETs redirect directly to R2.

If you are running Docker yourself, one practical setup is Cloudflare Tunnel:

1. Run Blossom with Docker Compose on your host.
2. Install `cloudflared` on the host and create a tunnel to
   `http://localhost:3000`.
3. Route your Cloudflare DNS hostname to that tunnel.
4. Keep `publicDomain` set to that hostname.

This gives you Cloudflare TLS, DDoS protection, and caching at the edge while
Blossom remains the origin.

### Storage Retention Rules

Rules serve as both an upload allowlist and a retention policy. The first
matching rule governs a blob's expiry. When the list is non-empty, blobs whose
MIME type matches no rule are rejected with `415 Unsupported Media Type`.

```yaml
storage:
  rules:
    - type: "image/*"
      expiration: 1 month
    - type: "video/*"
      expiration: 1 week
    - type: "*"
      expiration: 1 week
```

Rules can be scoped to specific Nostr pubkeys (hex) to give certain users
different retention:

```yaml
storage:
  rules:
    - type: "image/*"
      expiration: 1 year
      pubkeys:
        - "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d"
    - type: "image/*"
      expiration: 1 month
    - type: "*"
      expiration: 1 week
```

## Authentication (BUD-11)

All authenticated endpoints expect a Nostr-signed event in the `Authorization`
header:

```
Authorization: Nostr <base64-encoded-JSON-event>
```

The event must be **kind 24242** and include:

| Tag          | Required | Description                                                    |
| ------------ | -------- | -------------------------------------------------------------- |
| `t`          | Yes      | Verb for this token: `upload`, `delete`, `get`, or `list`      |
| `expiration` | Yes      | Unix timestamp after which the token is invalid                |
| `x`          | No       | One or more SHA-256 hashes scoping the token to specific blobs |
| `server`     | No       | Hostname(s) this token is valid for                            |

Example event (before signing):

```json
{
  "kind": 24242,
  "content": "Authorize upload",
  "tags": [
    ["t", "upload"],
    ["expiration", "1735689600"],
    ["server", "blobs.example.com"]
  ],
  "created_at": 1704067200
}
```

## API Reference

### Blob Endpoints (BUD-01 / BUD-02)

| Method   | Path             | Auth       | Description                                                                                                                                           |
| -------- | ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/:sha256[.ext]` | Optional   | Download a blob by its SHA-256 hash. Extension is advisory. Supports `Range`, `If-None-Match`.                                                        |
| `HEAD`   | `/:sha256[.ext]` | Optional   | Same as GET without the body.                                                                                                                         |
| `PUT`    | `/upload`        | Required\* | Upload a blob. `Content-Length` is required. Returns a `BlobDescriptor`.                                                                              |
| `HEAD`   | `/upload`        | Required\* | Preflight check (BUD-06). Send `X-Content-Length`, `X-Content-Type`, `X-SHA-256` to verify the server will accept the upload before sending the body. |
| `DELETE` | `/:sha256`       | Required\* | Delete a blob. The file is removed when the last owner deletes it.                                                                                    |
| `GET`    | `/list/:pubkey`  | Optional\* | List blobs uploaded by a pubkey. Disabled by default (`list.enabled: false`).                                                                         |

### Mirror Endpoint (BUD-04)

| Method | Path      | Auth       | Description                                                                                    |
| ------ | --------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `PUT`  | `/mirror` | Required\* | Fetch a remote blob and store it locally. JSON body: `{ "url": "https://..." }`. SSRF-guarded. |

### Media Endpoint (BUD-05)

| Method | Path     | Auth       | Description                                                                                             |
| ------ | -------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `PUT`  | `/media` | Required\* | Upload an image or video; the server optimises/transcodes it and returns the optimised blob descriptor. |
| `HEAD` | `/media` | Required\* | Preflight check for the media endpoint.                                                                 |

### Report Endpoint (BUD-09)

| Method | Path      | Auth | Description                                                               |
| ------ | --------- | ---- | ------------------------------------------------------------------------- |
| `PUT`  | `/report` | None | Submit a NIP-56 kind:1984 Nostr event to flag a blob for operator review. |

_\* Auth requirement is configurable per-endpoint via `requireAuth` in the
config._

### Response Format

Successful upload, mirror, and media responses return a `BlobDescriptor`:

```json
{
  "sha256": "b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553",
  "size": 184292,
  "type": "image/jpeg",
  "url": "https://blobs.example.com/b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553.jpg",
  "uploaded": 1704067200,
  "nip94": {
    "tags": [
      ["url", "..."],
      ["x", "..."],
      ["size", "..."],
      ["m", "..."]
    ]
  }
}
```

### Error Responses

All error responses use `Content-Type: text/plain`. The reason is included in
both the response body and an `X-Reason` header.

## Admin Dashboard

Enable the server-rendered admin dashboard (Hono JSX, no separate SPA) to manage
blobs, users, rules, and reports:

```yaml
dashboard:
  enabled: true
  username: admin
  password: "" # Auto-generated and logged to stdout on first startup if blank
  # Nostr relays used to look up kind:0 profiles in the user detail view
  lookupRelays:
    - wss://purplepag.es
    - wss://index.hzrd149.com
    - wss://indexer.coracle.social
```

The dashboard is available at `http://localhost:3000/admin` and is protected by
HTTP Basic Auth. It provides pages for:

- **Blobs** — browse, search, and force-delete blobs
- **Users** — list uploaders with Nostr profile metadata lookup
- **Rules** — view active storage retention rules
- **Reports** — review and dismiss BUD-09 blob reports

## Development

```sh
# Build the landing page client bundle (output: public/client.js)
# Required before running `deno task dev` or `deno task start` when the
# landing page is enabled.
deno task build

# Start with file-watching
deno task dev

# Run the test suite
deno task test

# Run a single test file
deno test --env-file=.env --allow-net --allow-read --allow-write --allow-env --allow-ffi --allow-sys tests/unit/auth.test.ts

# Lint
deno lint

# Format
deno fmt
```

## Migrating from the Legacy Node.js Server

If you have an existing database from the original Node.js blossom-server, the
migration script imports all blob metadata atomically:

```sh
deno task migrate-from-legacy
```

The script reads the legacy SQLite database, imports all records into the Deno
server's schema, and performs an atomic file swap. Blob files on disk are left
untouched.

## License

MIT
