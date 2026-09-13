# Telegraph Cloud — Phase 1: Boundaries and Safe Foundations

Phase 1 creates the internal seams required for Telegraph Cloud without enabling a new public database, project, API-key, S3, or dashboard feature. Existing Telegraph-Image behavior remains the supported public surface.

## Scope

Implemented in this phase:

- provider-neutral document-database and object-storage service contracts;
- a single injectable Telegram Bot API client;
- an append-only Telegram JSON journal transport;
- a separate Cloudflare KV index/outbox abstraction;
- shared strict validation for future Cloud route/data inputs;
- telemetry redaction and request-data minimization;
- safe Telegram download-header forwarding;
- non-leaky management API 500 responses;
- deployment documentation for the future Cloud KV binding and API-key pepper.

Explicitly **not** implemented:

- document database CRUD or `/api/db/*` routes;
- projects or project selection;
- developer API keys or API-key routes;
- generic object manifests, `/storage/*`, or S3 compatibility;
- new dashboard panels or a dashboard rebrand.

## Foundation layout

```text
functions/cloud/
├── contracts.js          provider-neutral future document/object service facades
├── errors.js             safe Cloud configuration, validation, and adapter errors
├── foundation.js         composition root for the index + Telegram journal
├── index-store.js        namespaced Cloudflare KV materialized-index boundary
├── telegram-client.js    all Telegram Bot API URL/fetch mechanics
├── telegram-journal.js   immutable JSON append/read transport
└── validation.js         strict future Cloud API validation helpers
```

The legacy flow is intentionally still separate:

```text
POST /upload → legacy storage provider → shared Telegram client → Telegram
GET /file/:id → legacy storage provider → shared Telegram client → Telegram/Telegraph
```

`functions/storage/r2.js` remains unchanged. `functions/storage/telegram.js` retains its existing `upload` / `fetchFile` contract and now calls the shared Telegram client. This preserves generated legacy file IDs, `/file/*`, the Telegram photo/document fallback, optional R2 storage, moderation, short links, and dashboard media workflows.

Future phases compose a different path:

```text
Phase 2 document adapter → document service contract → Cloud index + Telegram journal
Phase 4 object adapter   → object service contract   → Cloud index + Telegram transport
```

The service contracts deliberately have no concrete database or object adapter yet. They keep future Pages route handlers independent of Telegram-specific IDs and Bot API URL construction.

## Telegram persistence boundary

`createTelegramJournalAdapter()` has only two persistence primitives:

- `appendJson(payload)` serializes a validated JSON object as a fixed-name Telegram document and returns an **internal** `{ fileId, messageId }` pointer;
- `readJson(pointer)` retrieves that document only through the injected Telegram client.

There is no edit-message operation. This is intentional: Phase 2 record changes will be immutable journal entries, paired with a materialized index/outbox, rather than mutable Telegram messages. The adapter is not wired to a public route in Phase 1.

`createTelegramClient()` owns Bot API URL construction, upload fallback/retry behavior, `getFile`, download URL construction, and download fetch policy. New adapters receive an injectable client so unit tests do not need real Telegram credentials.

## Cloudflare KV index boundary

Future Cloud services require a dedicated Pages KV binding named:

```text
TELEGRAPH_CLOUD_KV
```

This is intentionally **not** `img_url`.

- `img_url` continues to hold only legacy media metadata, albums, short links, and moderation cache entries.
- `TELEGRAPH_CLOUD_KV` will hold Telegraph Cloud's non-authoritative materialized index, mutation outbox, project registry, and later API-key registry.
- Telegram will remain canonical for immutable document revisions and object bytes.

`createCloudIndexStore()` only accepts the explicit `TELEGRAPH_CLOUD_KV` binding and produces validated keys such as:

```text
tc:v1:records:prj_A1b2C3d4:users:usr_123
```

It does not fall back to `img_url`, which prevents accidental coupling or migration of existing media records. The index boundary exposes generic JSON read/write/delete/list mechanics only; it does not implement document CRUD.

Binding this namespace alone does not expose any new endpoint in Phase 1.

## Validation rules for future Cloud APIs

The helpers are deliberately strict before any value reaches a key, URL, header, index, or Telegram request:

| Input | Phase 1 rule |
| --- | --- |
| Project ID | Server-generated-style `prj_` ID with a URL-safe opaque suffix. |
| Collection name | Lowercase `a-z`, digits, `_`, `-`; bounded length. |
| Document ID | URL-safe opaque identifier; no slash, percent encoding, traversal, or control character. |
| Bucket name | Portable S3 DNS-style lowercase subset; 3–63 characters; no IP-style or ambiguous names. |
| Object key | NFC-normalized hierarchical path; allows Unicode and `/`, rejects empty/traversal segments, backslashes, `%`, query/fragment markers, controls, and keys over 1,024 UTF-8 bytes. |
| MIME type | Safe `type/subtype` token only; parameters are discarded for stored metadata. |
| Custom metadata | At most 20 lowercased header-safe string values, with per-value and total byte limits. |
| JSON document/journal | Root JSON object only; no prototype-pollution keys, non-finite numbers, non-JSON values, excessive depth/node count, or payloads over 128 KiB. |
| Object size | Future object uploads are bounded at 20 MiB before buffering for Telegram. |

These rules apply to **future Telegraph Cloud routes and adapters only**. They do not change the legacy `POST /upload` compatibility behavior in this phase.

The legacy file proxy gets a narrower compatibility-conscious guard: it blocks control characters, path separators, percent-encoded URL ambiguity, query/fragment markers, and oversized IDs before an upstream request. Historical opaque IDs and non-ASCII filenames that do not contain unsafe URL syntax remain supported.

## Security changes

### Telemetry

The shared telemetry middleware now:

- records only a small allowlist of non-secret request headers;
- represents `Authorization`, cookies, API keys, tokens, secrets, passwords, signatures, sessions, and CSRF headers as `[redacted]`;
- omits all unknown headers instead of copying them to Sentry;
- drops request query strings/fragments from telemetry URLs;
- masks Bot API token path segments in URLs, error messages, exception values, and breadcrumbs;
- removes automatically captured request bodies/cookies from Sentry events;
- limits Cloudflare request context to a small safe field allowlist;
- avoids logging raw caught error objects, which can embed a request URL.

### Telegram download proxy

Legacy Telegram/Telegraph downloads now forward only delivery/cache headers:

```text
Accept
If-Modified-Since
If-None-Match
If-Range
Range
```

Cookies, `Authorization`, Bearer/API keys, host headers, browser identity headers, `Referer`, `Origin`, arbitrary custom headers, and request bodies are not sent to the upstream file host. GET/HEAD behavior and range-related compatibility are retained.

### Management API errors

`/api/manage/*` middleware now responds to uncaught handler errors with:

```json
{ "error": "internal_error" }
```

The response is `500`, JSON, and `Cache-Control: no-store`. It no longer returns an exception message or stack trace.

## Configuration

The English and Chinese READMEs now document the separate `TELEGRAPH_CLOUD_KV` binding and reserve `API_KEY_PEPPER` as a Cloudflare secret for the later API-key phase. Neither should be put in static files, browser code, or a custom environment-management UI.

Existing environment variables remain unchanged:

- `TG_Bot_Token` and `TG_Chat_ID` remain Pages secrets/bindings consumed server-side.
- `BASIC_USER` / `BASIC_PASS` remain dashboard authentication.
- `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` retain legacy upload protection behavior.
- `img_url`, `img_r2`, and `AI` keep their existing roles.

## Verification

The Phase 1-focused foundation/security tests cover service contracts, index isolation, validation, immutable journal transport, telemetry redaction, safe Telegram forwarding, management error disclosure, and legacy file compatibility.

```text
npm test
342 passing
```

A local `wrangler pages dev` compatibility check also compiled the Pages worker successfully with the existing R2 development setup. The existing landing page and `/api/config` remained available, and an unsafe legacy file identifier returned `404` before any upstream request. No Cloud database route was registered during this phase.

## Limitations after Phase 1

- There is no database route, record query, version/outbox workflow, project isolation, developer authentication, generic object API, or S3 claim yet.
- The journal transport alone is not a database: Phase 2 must add immutable revision schema, outbox sequencing, materialized record indexes, conflict handling, and recovery behavior.
- Cloudflare KV is not transactional. No ACID or strong-concurrency guarantee is made by these foundations.
- Telegram rate/size/download constraints remain in force.
- Existing legacy public upload behavior remains intentionally broad until a compatibility-tested hardening phase.
