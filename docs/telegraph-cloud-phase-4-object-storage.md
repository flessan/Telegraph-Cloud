# Telegraph Cloud — Phase 4: Project-scoped Telegram Object Storage

Phase 4 adds a small, authenticated **generic object API** beside the existing Telegraph-Image media uploader. It deliberately does **not** change `/upload`, `/file/*`, legacy `img_url` records, public links, Telegram/R2 media-provider selection, dashboard media management, albums, or dashboard authentication behavior.

> **Status:** experimental/self-hosted object engine. It is Telegram-backed object storage with a Cloudflare KV materialized index; it is **not** Amazon S3, R2, a filesystem, a relational/ACID database, durable transactional storage, a public CDN, a secret manager, or an unlimited-throughput service.

## What Phase 4 implements

- project/bucket/key object identity, with project context derived solely from a verified developer Bearer key;
- `PUT`, `GET`, `HEAD`, and logical `DELETE` routes under `/api/storage/:bucket/:key`;
- the `storage:read` and `storage:write` developer-key scopes;
- a provider-neutral object-service contract and a dedicated Telegram `sendDocument` byte/event adapter, separate from the legacy media provider;
- SHA-256-based revision ETags, `If-None-Match` / `If-Modified-Since` reads, and `If-Match` / `If-None-Match` write preconditions;
- validated bucket/key/MIME/custom metadata/body limits, private safe download headers, and a local mutation burst guard;
- a repairable KV current manifest, immutable revision-index records, staged mutation outboxes, Telegram byte documents, and Telegram immutable revision/tombstone events;
- logical tombstones rather than a false promise that Telegram bytes/messages were physically erased.

At the end of Phase 4, it deliberately deferred S3 XML routes, `ListObjectsV2`, bucket-management routes, AWS Signature V4, presigned URLs, multipart upload, ranges, AWS SDK compatibility, billing/analytics, a storage dashboard redesign, SDKs, public-object delivery, lifecycle rules, cross-region transactions, and globally exact rate limits. **Phase 5 supersedes the former listing/range deferral** with a private JSON `GET /api/storage/:bucket` list endpoint and valid single-byte-range reads over this same engine. S3 XML/ListObjectsV2 XML, SigV4, presigned URLs, multipart upload/ranges, SDK compatibility, and the other exclusions remain out of scope. See the [Phase 5 object semantics and listing reference](telegraph-cloud-phase-5-object-semantics.md).

## Architecture and authority boundary

```text
Application
  └─ Authorization: Bearer tg_live_…
      └─ HMAC-verifiable developer key in TELEGRAPH_CLOUD_KV
          └─ active project + storage:read or storage:write scope
              └─ project-bound object service (no caller project selector)
                  ├─ current manifest / outbox / revision index / bucket marker in KV
                  └─ dedicated Telegram object adapter
                      ├─ immutable sendDocument object bytes
                      └─ immutable JSON revision or tombstone event
```

The path names a bucket and key only. `project_id` is never accepted from a query parameter, header, body, object metadata, or path. A key for project A reading the same `bucket/key` used by project B sees only project A's manifest; absence is the normal `404 object_not_found` response.

The request route does not construct Bot API URLs or handle Telegram file IDs. `functions/cloud/telegram-object-storage.js` owns Telegram upload/download/event mechanics. `functions/cloud/object-storage.js` owns validation, hashing, manifests, outbox sequencing, and public response shaping. This is intentionally separate from `functions/storage/*`, which remains the legacy media/upload implementation.

## Deployment requirements

Bind/configure these Pages values, then redeploy:

| Setting | Required for | Notes |
| --- | --- | --- |
| `TELEGRAPH_CLOUD_KV` KV binding | projects, keys, object manifests/outboxes/revision indexes | Use a dedicated namespace. Never substitute legacy `img_url`. |
| `API_KEY_PEPPER` Pages secret | issuing/verifying developer keys | At least 32 UTF-8 bytes of unique random data per environment, e.g. `openssl rand -base64 48`. Replacing it invalidates existing keys. |
| `TG_Bot_Token` Pages secret | object byte/event upload; object GET/HEAD resolution | Never expose it to a client, log, metadata field, or dashboard. |
| `TG_Chat_ID` binding/secret | object byte/event upload | Bot must be able to send documents there. |
| `TELEGRAPH_CLOUD_MAX_OBJECT_BYTES` | optional object body limit | Decimal bytes from `1` through `20,971,520`; default `10,485,760` (10 MiB). It can lower the limit but cannot raise the hard 20 MiB ceiling. |
| `BASIC_USER` / `BASIC_PASS` | creating/rotating project keys through `/api/projects/*` | Existing dashboard credentials; they are not accepted by `/api/storage/*`. |

`TELEGRAPH_CLOUD_KV` stores control-plane records and small materialized metadata only. It never stores an object body or API-key plaintext. Telegram object bytes/events and Cloudflare KV access are operator-level infrastructure privileges; project isolation is an application authorization boundary, not encryption against an infrastructure administrator.

## Create a least-privilege storage key

A dashboard administrator creates a project and then creates a key under that project. Storage scopes are explicit; existing/new keys default to `db:read` + `db:write` only and receive no storage authority unless requested.

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"label":"asset deployer","scopes":["storage:read","storage:write"]}' \
  https://your-domain.example/api/projects/prj_ServerGeneratedOpaqueId/keys
```

The `api_key` in the successful creation/rotation response is a one-time secret. Store it in the application secret manager, not browser code, source control, Telegram, a query string, or custom metadata. Send it only as:

```text
Authorization: Bearer tg_live_…
```

A missing, malformed, revoked, or inactive-project key returns the safe authentication/authorization response; it never falls back to dashboard Basic/session authentication on storage routes.

## HTTP API

All object responses use `Cache-Control: private, no-store` and `Vary: Authorization`. The API is authenticated/private; it does not create public `/file/*` links.

| Method | Route | Required scope | Result |
| --- | --- | --- | --- |
| `PUT` | `/api/storage/:bucket/:key` | `storage:write` | Create or replace one raw object. |
| `GET` | `/api/storage/:bucket/:key` | `storage:read` | Retrieve exact bytes from the active manifest. |
| `HEAD` | `/api/storage/:bucket/:key` | `storage:read` | Retrieve active metadata without downloading byte content. |
| `DELETE` | `/api/storage/:bucket/:key` | `storage:write` | Create a logical tombstone. |

Keys may contain safe slash hierarchy, so `:key` can be `reports/2026/summary.json`. Phase 5 adds the separate authenticated bucket-root `GET /api/storage/:bucket` JSON listing route; it is documented in the [Phase 5 reference](telegraph-cloud-phase-5-object-semantics.md), not an S3/ListObjectsV2 endpoint.

### PUT an object

```bash
curl -X PUT 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'Content-Type: text/plain; charset=utf-8' \
  -H 'X-Amz-Meta-Owner: reporting-service' \
  -H 'X-Amz-Meta-Retention: short' \
  -H 'Idempotency-Key: report-20260912-01' \
  --data-binary @summary.txt
```

A first active object returns `201`; a replacement returns `200`. The body is safe public metadata, not a Telegram pointer:

```json
{
  "data": {
    "bucket": "assets",
    "key": "reports/summary.txt",
    "size": 42,
    "content_type": "text/plain",
    "etag": "sha256-Base64urlSha256Digest-v1",
    "version": 1,
    "created_at": "2026-09-12T12:34:56.000Z",
    "updated_at": "2026-09-12T12:34:56.000Z",
    "metadata": {
      "owner": "reporting-service",
      "retention": "short"
    }
  }
}
```

The `ETag` response header is the quoted form of `data.etag`, for example `"sha256-…-v1"`. It is deterministic for the SHA-256 content digest and logical revision version; identical bytes written as a later revision receive a new version suffix.

`Idempotency-Key` is optional but strongly recommended for every `PUT`/`DELETE`. It must be a bounded opaque token. Its raw value and body are not placed in KV or Telegram. A same-key retry of the same mutation can complete staged recovery; reuse for a different operation, bucket/key, bytes, MIME type, or metadata returns `409 idempotency_key_reused`.

### GET and HEAD

```bash
curl 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -o summary.txt

curl -I 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY"
```

A successful `GET` has the manifest's validated `Content-Type`, exact `Content-Length`, quoted `ETag`, `Last-Modified`, custom `X-Amz-Meta-*` headers, `X-Content-Type-Options: nosniff`, and a fixed `Content-Disposition: attachment; filename="download"`. The fixed attachment behavior prevents a key or uploaded MIME type from becoming an executable same-origin document. `HEAD` returns the same metadata headers and no body; it resolves the internal Telegram file but does not request/download byte content.

Conditional cache validation occurs before any Telegram byte download:

```bash
curl -D - 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'If-None-Match: "sha256-Base64urlSha256Digest-v1"'
```

- `If-None-Match` supports `*` or quoted ETag lists (weak tags are accepted for GET/HEAD matching).
- If it is absent, `If-Modified-Since` is evaluated at HTTP-date second precision; an invalid date is ignored according to normal HTTP behavior.
- A matching condition returns `304` with safe cache/version/metadata headers and no Telegram byte download.
- Phase 5 evaluates `If-Match` / `If-Unmodified-Since` before `If-None-Match` / `If-Modified-Since`, then processes a valid single `Range`. A satisfiable range returns `206` with exact `Content-Range`, `Content-Length`, and `Accept-Ranges`; malformed/multipart/unsatisfiable ranges return safe `416 range_not_satisfiable` with `Content-Range: bytes */<size>`. See the [Phase 5 range and conditional precedence](telegraph-cloud-phase-5-object-semantics.md#conditional-precedence).

### Conditional replacement and delete

```bash
curl -X PUT 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'Content-Type: text/plain' \
  -H 'If-Match: "sha256-Base64urlSha256Digest-v1"' \
  --data-binary @next-summary.txt

curl -X DELETE 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'If-Match: "sha256-Base64urlSha256Digest-v2"'
```

`If-Match` uses strong matching against a current active ETag. `If-None-Match: *` only permits a missing/tombstoned object. Invalid or combined `If-Match` + `If-None-Match` headers return `400 invalid_precondition`; a condition that does not match returns `412 precondition_failed` before a new Telegram byte document is uploaded. Phase 5 also accepts `If-Unmodified-Since` on PUT/DELETE; `If-Match` takes precedence when both are sent. Full precedence and range interaction are documented in the [Phase 5 reference](telegraph-cloud-phase-5-object-semantics.md#conditional-precedence).

DELETE returns a safe tombstone confirmation:

```json
{
  "data": {
    "bucket": "assets",
    "key": "reports/summary.txt",
    "version": 3,
    "deleted": true,
    "deleted_at": "2026-09-12T12:40:00.000Z"
  }
}
```

After a successful tombstone, normal `GET`, `HEAD`, `LIST`, and a new DELETE request treat the object as absent (`404 object_not_found` for direct access). A same-`Idempotency-Key` DELETE retry instead returns its original logical deletion receipt, as documented above. A later PUT can recreate it as a new active revision; Phase 5 lists only that current active representation, not tombstones or historical revisions.

## Validation and safe limits

| Input | Phase 4 rule |
| --- | --- |
| Bucket | 3–63 character portable DNS-style lowercase name; rejects uppercase, IP-like forms, leading/trailing punctuation, and ambiguous `..`. |
| Key | Non-empty NFC UTF-8 text up to 1,024 bytes; allows safe `/` hierarchy; rejects empty, `.`, `..`, control characters, backslash, `%`, `?`, `#`, and traversal/ambiguous segments. |
| Body | Raw binary bytes, default max 10 MiB; configured max cannot exceed 20 MiB hard ceiling. Both declared and observed size are checked. |
| MIME | Optional `Content-Type`; valid RFC token `type/subtype` syntax only, normalized lower-case without parameters. Missing means `application/octet-stream`; invalid means `415 unsupported_media_type`. |
| Custom metadata | Request headers named `X-Amz-Meta-<bare-name>` only; lower-cased safe names/strings, at most 20 entries, name ≤64 bytes, value ≤1,024 bytes, total ≤8 KiB. Control characters and unsafe names are rejected. |
| Preconditions | Bounded strict ETag syntax; no arbitrary condition forwarding to Telegram. |

The current Pages/Telegram adapter reads the body incrementally while enforcing the configured limit, then constructs a **bounded in-memory buffer** because Web Crypto SHA-256 and `multipart/form-data` `sendDocument` need the same bytes. It does not use unbounded `arrayBuffer()` input, but it is not a streaming multipart implementation. Keep the limit conservative; do not treat it as a general large-file upload path.

Telegram's documented practical `getFile` retrieval boundary motivates the 20 MiB hard ceiling even though some Bot API uploads can be larger. Telegram and Cloudflare may impose lower operational/rate/memory limits. A local, best-effort guard permits at most 20 PUT/DELETE mutations per minute per project per running Function isolate. It is not global, durable, exact, or billing/usage enforcement; use platform WAF/rate limiting for stronger abuse controls.

## Persistence, revisions, and recovery

### Internal model

For each active/tombstoned object, the current KV manifest stores only bounded metadata:

- project ID, bucket, validated original key, a SHA-256-derived safe key token, state, logical version, opaque revision/parent IDs, timestamps, MIME type, size, metadata, content digest/ETag;
- internal Telegram pointer for the current immutable byte document; and
- internal Telegram pointer for the corresponding immutable object revision/tombstone event.

The manifest KV key uses `project/bucket/SHA-256-key-token`, not the arbitrary object key as a KV segment. A separate immutable KV revision-index entry retains each staged event/byte pointer, and a small mutation outbox stores state such as `intent`, `uploaded`, `ready`, and `applied`. Bucket markers are created by the first active PUT; Phase 5 adds a read-only bucket-root object-list API, not bucket administration. Its bounded chunked leaf index is secondary to the current manifest and is documented in the [Phase 5 reference](telegraph-cloud-phase-5-object-semantics.md#index-architecture-and-bounded-work). Object bodies are never placed in KV or event/outbox payloads and never appear in public responses.

A successful PUT follows this sequence:

1. Validate the server-derived project scope, route identity, headers, conditions, and bounded body; calculate a SHA-256 digest/ETag.
2. Write a small mutation intent to KV.
3. Upload immutable raw bytes through Telegram `sendDocument` and durably stage its internal pointer in the outbox.
4. Append a small immutable Telegram JSON revision event that references the internal byte pointer; stage its event pointer.
5. Persist the immutable KV revision-index record and materialize the active manifest/bucket marker. Phase 5 then materializes or removes the bounded list-index terminal leaf before the outbox is marked applied; a same-idempotency-key retry repairs this materialization stage.

A DELETE writes an intent, appends an immutable Telegram tombstone event, persists its revision-index record, and materializes a `deleted` manifest. It deliberately does **not** call Telegram `deleteMessage`; replacing/deleting an object can leave historical byte documents and event documents retained by Telegram. The API makes them inaccessible through this object engine but does not claim physical erasure or a provider retention guarantee.

### Failure and consistency boundaries

Telegram and KV are independent remote systems. There is no transaction spanning body upload, event append, revision index, and current-manifest writes. The API returns success only after the active/tombstone manifest is materialized. If Telegram succeeds but a subsequent durable KV stage cannot be confirmed, it returns `503 object_mutation_pending` rather than a false success.

Retry the **same** mutation with the same `Idempotency-Key` after KV recovers:

- If byte/event pointers already reached the staged outbox, the retry completes materialization without uploading again.
- If KV failed before an accepted Telegram pointer could be recorded, the retry may create a retained duplicate Telegram byte/event document. The duplicate is not publicly addressable by this API, but this is why keys/retries must be treated as at-least-once and Telegram retention must be understood.
- There is no background reconciliation worker in Phase 4. The bounded outbox/revision records make a retried mutation repairable; an operator recovery tool can be added later.

Cloudflare KV is eventually consistent and has no compare-and-swap/transaction. Conditions are checked against the current manifest visible to the request and protect ordinary stale replacement/delete attempts. Two edges can still start from the same parent. When same-parent revisions collide, the engine uses a deterministic opaque revision-ID ordering and reports the loser as `409 object_conflict`; it does not claim serializable, strongly consistent, or ACID writes. Reads can temporarily observe KV propagation state. Revoked keys/project state are likewise subject to KV control-plane propagation.

## Safe errors and visibility

| Situation | Status / response |
| --- | --- |
| Missing/malformed/unknown/revoked Bearer credential | `401 {"error":"invalid_api_key"}` |
| Valid key lacks required storage scope | `403 {"error":"api_key_scope_forbidden"}` |
| Disabled/deleted/missing key project | `403 {"error":"project_inactive"}` |
| Object absent/tombstoned in the caller project | `404 {"error":"object_not_found"}` |
| Invalid bucket/key/body/header/metadata | bounded `400`/`422` response such as `invalid_object_key` |
| Body exceeds limit | `413 {"error":"object_too_large"}` |
| Unsupported MIME | `415 {"error":"unsupported_media_type"}` |
| Invalid/unsatisfiable or multipart range request (Phase 5) | `416 {"error":"range_not_satisfiable"}` plus safe `Accept-Ranges: bytes` / `Content-Range: bytes */<size>` |
| Conditional mutation did not match | `412 {"error":"precondition_failed"}` |
| Concurrent/idempotency conflict | `409 object_conflict` or `idempotency_key_reused` |
| Telegram/KV stage unavailable | safe `503 storage_backend_failure` or `object_mutation_pending` |

Error bodies are allowlisted codes only. Telegram `file_id`, message ID, file path, Bot API URL/token, current-manifest internal pointer, raw upstream error, object body, API-key secret, and `API_KEY_PEPPER` are not exposed. Existing telemetry redacts Authorization/cookie/token/API-key headers; custom metadata is not in the telemetry header allowlist; object transport creates fresh Telegram requests rather than forwarding caller headers.

## Legacy coexistence and migration

Phase 4 has no automatic import/migration of legacy upload media. `/upload` continues to create legacy generated file IDs and `/file/*` continues to serve its established Telegram/R2/public-link behavior. A Phase 4 object URL is private, Bearer-key authenticated, project-scoped, and cannot be substituted for `/file/*`; a legacy `/file/*` ID is not a Phase 4 key.

Migrate only deliberately at application level: read/download an authorized legacy asset, choose a project/bucket/key and MIME/metadata policy, PUT it using a storage-scoped developer key with a unique idempotency key, verify a GET/HEAD, then update application references. This does not preserve legacy opaque IDs, public links, provider metadata, Telegram message identity, or a physical-deletion guarantee.

## Verification included in Phase 4

The test suite covers object create/read/head/delete/recreate, exact bytes, overwrite/version ETags, conditional reads/writes, unsafe path/MIME/metadata/body rejection, configurable limits, project isolation, scopes/Bearer-only route behavior, safe download headers, no internal Telegram identifiers in responses, logical tombstones, dedicated transport header isolation, Telegram failures, staged KV recovery, and existing legacy upload/file regressions.

Run before deployment:

```bash
npm test
```

## Phase 5 follow-on and deliberately scoped Phase 6 direction

Phase 5 was built **over this engine**, not by routing S3 traffic into legacy `/upload` or exposing Telegram pointers. It provides a bounded listing/index model and valid single ranges; see [its dedicated reference](telegraph-cloud-phase-5-object-semantics.md).

The Phase 5.1 follow-on is now available as the [operator-only checkpointed list-index repair workflow](telegraph-cloud-phase-5-1-index-repair.md): bounded manifest pages, dry-run/progress reporting, manifest-only reads, deterministic missing/stale index-path repair (including required branches), tombstone-leaf removal, and no public pointer exposure. It does not change this Phase 4 engine. The next recommendation remains **not** S3 protocol compatibility; only after operating Phase 5.1 should a separate operator-only raw-index audit planner be considered. SigV4, presigned authorization, S3 XML, multipart state, and SDK compatibility each need separate threat modeling and remain deferred.
