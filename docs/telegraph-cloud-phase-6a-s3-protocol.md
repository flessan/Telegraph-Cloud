# Telegraph Cloud — Phase 6A: S3 Protocol Compatibility Layer

Phase 6A adds a deliberately narrow, private S3-shaped HTTP/XML facade over the existing project-scoped Telegraph Cloud object engine. It does **not** replace the Phase 4–5.1 object engine, its Telegram byte adapter, its KV manifests/indexes, the legacy upload system, or the Bearer-key REST API.

> **Status:** experimental, self-hosted, administrator-only compatibility bridge. This is not Amazon S3, an R2 replacement, AWS SDK certification, a public object CDN, a filesystem, an ACID/transactional store, or an unlimited-throughput service.

Read the [Phase 4 object-engine reference](telegraph-cloud-phase-4-object-storage.md), [Phase 5 semantics/listing reference](telegraph-cloud-phase-5-object-semantics.md), and [Phase 5.1 repair reference](telegraph-cloud-phase-5-1-index-repair.md) for the authoritative persistence, consistency, range, cursor, and recovery behavior that this facade preserves.

## Architecture and isolation

Every compatible request follows one deliberately constrained path:

```text
S3-shaped HTTP request
  -> /s3 Pages middleware (opaque request id, temporary admin auth, local burst guard)
  -> S3 protocol adapter (route/query parsing, XML/header/error mapping)
  -> project-bound Telegraph object facade
  -> object manifests/list index in TELEGRAPH_CLOUD_KV + Telegram byte/event adapter
```

The S3 adapter has no direct Cloudflare KV, Telegram, Bot API, pointer, revision, or credential-binding access. It invokes the same project-bound object facade operations used by `/api/storage/*`: `putObject`, `getObject`, `headObject`, `deleteObject`, and `listObjects`, plus the narrow non-mutating marker lookup below.

`bucketExists` is a narrow, non-mutating facade seam that reads the engine-owned bucket marker so the protocol can distinguish `NoSuchBucket` from an existing empty bucket. It is not a bucket CRUD API, does not accept a project id, and does not make KV visible to the protocol adapter.

`/s3/*` is a dedicated Pages route. It does not intercept or alter `/api/storage/*`, `/api/db/*`, `/api/projects/*`, `/upload`, `/file/*`, dashboard routes, legacy Telegram/R2 behavior, public links, or developer Bearer-key behavior.

## Temporary Phase 6A authentication boundary

**No AWS Signature V4, access key, secret key, presigned URL, or developer API-key authentication exists on this route.** An unauthenticated external request is denied.

For tightly controlled local/operator testing only, set all of the following server-side bindings/secrets:

| Setting | Requirement | Purpose |
| --- | --- | --- |
| `BASIC_USER` and `BASIC_PASS` | Both must be non-empty | Existing dashboard Basic credentials. A valid dashboard session cookie is also accepted. The dashboard's legacy “auth disabled” mode never enables `/s3`. |
| `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` | Valid `prj_…` project identifier for the intended current project | The **sole** project scope for every `/s3` request in that deployment/environment. It is read only from server configuration; operators must keep it aligned with the intended project lifecycle. |
| `TELEGRAPH_CLOUD_KV` | Existing dedicated Cloud KV binding | Project/object manifests, bucket marker, list index, internal cursor state. Never use legacy `img_url` for this purpose. |
| `API_KEY_PEPPER` | Existing server-only secret, at least 32 UTF-8 bytes | Derives AES-GCM protection for the outer S3 continuation token. Changing it invalidates outstanding S3 tokens (and existing developer-key/list/repair state as documented by prior phases). |
| `TG_Bot_Token` and `TG_Chat_ID` | Existing object-engine configuration | Required for object PUT/GET/HEAD byte/event behavior. They remain server-only. |

The middleware calls `authenticateS3Request(request, env)`, which returns only server-side state shaped as `{ projectId, credentials, permissions }`. Its `credentials` field is a non-secret kind marker; it never contains a username, Basic header, session cookie, key, token, or password.

No route segment, query parameter, request header, body, metadata field, continuation token, or object key can select/override the project. In particular, `?project_id=…` is rejected: ListObjectsV2 accepts only its documented controls, and object requests accept no query controls in Phase 6A. A dashboard Basic/session identity is **not** converted into a developer key, and a developer Bearer key is **not** accepted as an S3 credential.

Because this bridge grants the configured project’s object read/write capability to a dashboard administrator, do not expose it publicly or treat it as a multi-tenant credential system. Leave `TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID` unset in normal production deployments; requests then fail closed as XML `AccessDenied`.

## Supported routes and operation mapping

Path-style requests only are supported; virtual-host bucket routing is not.

| Request | Engine operation | Success response |
| --- | --- | --- |
| `GET /s3/:bucket?list-type=2` | `listObjects` after marker lookup | `200` ListObjectsV2 XML |
| `PUT /s3/:bucket/:key` | `putObject` | `200`, empty body, quoted `ETag` |
| `GET /s3/:bucket/:key` | `getObject` | `200`/`206` byte response or `304` |
| `HEAD /s3/:bucket/:key` | `headObject` | `200`/`206` headers only or `304` |
| `DELETE /s3/:bucket/:key` | `deleteObject` | `204`, empty body |

There is no `ListBuckets`, `HeadBucket`, `CreateBucket`, `DeleteBucket`, ACL, policy, tagging, copy-object, checksum, encryption, object-lock, multipart upload, version API, or multipart-range endpoint. Bucket-root methods other than the documented list GET return XML `405 MethodNotAllowed` with `Allow: GET`.

### Bucket marker behavior

The underlying engine materializes a project-scoped bucket marker only after a successful active-object PUT. Therefore:

- GET, HEAD, DELETE, and ListObjectsV2 on a syntactically valid unmarked bucket return `NoSuchBucket`.
- PUT deliberately preserves the existing engine’s first-object materialization behavior: a successful PUT to an unmarked bucket creates its marker as part of the existing object mutation. This is a compatibility/bootstrap behavior, **not** an implemented `CreateBucket` operation.
- A logical object DELETE retains the marker, so an empty formerly used bucket remains listable and distinguishable from an unknown bucket.

This reflects the Phase 4 data model rather than claiming full S3 bucket administration.

## Object headers, bodies, ranges, and conditions

PUT reads the body through the existing bounded streaming/body helper before it reaches the Telegram multipart adapter. Existing object-byte, MIME, object-key, bucket-name, and `x-amz-meta-*` limits/validation apply unchanged. The engine still normalizes content types and metadata, hashes bounded bytes, creates immutable logical revisions, and avoids forwarding request credentials/headers to Telegram.

Supported safe request/response behavior:

- `Content-Type`, `If-Match`, `If-None-Match`, and `If-Unmodified-Since` on PUT/DELETE;
- `If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`, and one valid `Range: bytes=…` on GET/HEAD;
- GET/HEAD response `ETag: "sha256-…-vN"`, `Last-Modified`, `Accept-Ranges: bytes`, normalized `x-amz-meta-*`, and exact representation `Content-Type`/`Content-Length`;
- `206` with exact `Content-Range` for an engine-validated single range; unsatisfiable/multipart/malformed ranges produce `416 InvalidRange` and the safe `Content-Range: bytes */<logical-size>` header;
- a fixed `Content-Disposition: attachment; filename="download"` and `X-Content-Type-Options: nosniff`, preserving the private object route’s non-inline serving posture.

The S3 facade intentionally suppresses internal `X-Telegraph-Cloud-Object-Version` and never emits internal revision, manifest, outbox, pointer, KV, or Telegram fields. S3 success ETags are quoted in HTTP and in ListObjectsV2 XML.

`Content-MD5` and all non-metadata `x-amz-*` PUT headers are rejected as `InvalidRequest` rather than silently claiming support for ACLs, SSE, tagging, checksums, copy-source, object lock, or future SigV4 fields. `If-Range` and multipart ranges remain unsupported.

Conditional precedence is exactly the existing engine’s behavior: conditions are evaluated against the current active manifest before Telegram retrieval/range retrieval. For GET/HEAD: `If-Match`, then (when no `If-Match`) `If-Unmodified-Since`, then `If-None-Match`, then (when no `If-None-Match`) `If-Modified-Since`; `304` happens before range handling. For PUT/DELETE, `If-Match` wins over `If-Unmodified-Since`; otherwise `If-Unmodified-Since` is evaluated before `If-None-Match`. Combining write `If-Match` and `If-None-Match` is rejected; failed write conditions happen before a Telegram upload/event.

DELETE remains a logical tombstone. It returns `204` on a successful engine delete, does not claim physical Telegram deletion, and a later missing/tombstoned DELETE maps the existing engine behavior to `404 NoSuchKey` rather than pretending that all S3 deletes are idempotently successful.

## ListObjectsV2

ListObjectsV2 is selected only by literal `list-type=2` at the bucket root. It produces deterministic, UTF-8 declared XML:

```xml
<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">…</ListBucketResult>
```

The structured XML serializer validates element names and XML scalar characters and escapes every text/attribute value (`&`, `<`, `>`, quotes, and apostrophes). It does not concatenate user-controlled keys/prefixes directly into markup. Object keys, prefixes, bucket values, ETags, and tokens remain subject to their existing object-engine validation before rendering.

Supported controls are intentionally small and all duplicate/unknown controls are rejected:

| Control | Phase 6A rule |
| --- | --- |
| `list-type` | Required and must be exactly `2`. |
| `prefix` | Optional literal, case-sensitive safe object-key prefix. Empty is allowed. |
| `delimiter` | Optional literal `/` only. It emits immediate `CommonPrefixes`; no directory records exist. |
| `max-keys` | Optional decimal integer `1` through the configured/hard engine maximum (at most `100`). Default is the configured maximum. `0` and values above the bound are rejected rather than faking S3’s larger page size. |
| `continuation-token` | Optional opaque AES-GCM-protected outer token from the prior response. It is URL-encoded by callers. |
| `start-after` | Optional safe literal lower bound on an initial traversal. It cannot be combined with `continuation-token`. |
| `fetch-owner` | Omitted or exactly `false`; owner records do not exist in this engine. |
| `encoding-type` | Not implemented; XML escaping is already used. |

`ListBucketResult` contains `Name`, `Prefix`, `KeyCount`, `MaxKeys`, optional `Delimiter`/`StartAfter`, `IsTruncated`, safe `Contents` (`Key`, `LastModified`, quoted `ETag`, `Size`, `StorageClass=STANDARD`), optional `CommonPrefixes`, and `NextContinuationToken` when more traversal remains. Metadata, owners, versions, pointers, storage locations, project identifiers, and internal cursor values are never in list XML.

The existing index is deterministic `key:asc` traversal with bounded work, not a global snapshot. The S3 adapter preserves that order and wraps the existing opaque cursor in an outer AES-GCM token that binds project, bucket, prefix, delimiter, `max-keys`, and `start-after`. The outer token’s encrypted payload contains the inner cursor but no plaintext cursor/state appears on the wire. It expires with the approximately ten-minute underlying cursor state. Changing selection fields between pages, tampering, cross-project use, expiry, or malformed input returns safe `InvalidArgument`.

The underlying index has no native lower-bound seek. To make ordinary `start-after` requests useful while remaining bounded, the adapter may advance through at most four filtered engine pages in one request; it never performs a whole-bucket scan or stores unreturned list items in a token. An unusually distant `start-after` can therefore return a short (or empty) `IsTruncated=true` page with a continuation token; continue with that token rather than assuming a snapshot or retrying with a caller-built cursor.

## XML errors, request IDs, and rate behavior

Every `/s3` failure is a safe XML document with UTF-8 declaration/content type, `Cache-Control: private, no-store`, `Vary: Authorization, Cookie`, `X-Content-Type-Options: nosniff`, an opaque random `x-amz-request-id`, and matching `<RequestId>`. Where a validated route target is available it also has safe `<Resource>/bucket/key</Resource>`; it never contains a Telegram/KV/internal path.

| Situation | XML code / status |
| --- | --- |
| Missing test configuration, bad dashboard Basic/session, Bearer-only request | `AccessDenied` / `403` |
| Invalid route/query/header/body/key/prefix/token argument | `InvalidRequest` or `InvalidArgument` / `400` |
| Unmarked bucket | `NoSuchBucket` / `404` |
| Missing/tombstoned object in existing bucket | `NoSuchKey` / `404` |
| Failed condition | `PreconditionFailed` / `412` |
| Object body over configured limit | `EntityTooLarge` / `413` |
| Unsupported MIME type | `UnsupportedMediaType` / `415` |
| Invalid or unsupported range | `InvalidRange` / `416` |
| Method/operation not in this phase | `MethodNotAllowed` / `405` |
| Local mutation burst guard | `SlowDown` / `429`, with `Retry-After` |
| Engine conflict | `OperationAborted` / `409` |
| KV/Telegram/continuation configuration or transient dependency failure | `ServiceUnavailable` / `503` |
| Unexpected failure | `InternalError` / `500` |

The mutation guard is intentionally a small per-isolate, per-server-configured-project guard: at most 20 PUT/DELETE starts in 60 seconds. It is neither distributed quota enforcement nor billing/accounting. `/s3` deliberately has its own silent error middleware rather than the `/api` telemetry chain; it does not log raw URLs, Basic/session headers, future signature values, request bodies, Telegram diagnostics, or credentials.

## Consistency and retention

All Phase 4–5.1 limits remain true. Telegram and Cloudflare KV are independent systems; KV is eventually consistent and there is no global transaction, global compare-and-swap, strong serializability, or snapshot list guarantee. A successful object can briefly be absent from a list at another edge; concurrent replacement/delete/list activity can observe different current materializations; an internal/outer continuation is a position, not a snapshot; and cursors expire. Clients should deduplicate by key and confirm with GET/HEAD plus ETag before consequential work.

A mutation can succeed at Telegram and later need outbox/index recovery. The engine reports safe retryable failure instead of a false success. Historical byte/event documents can remain retained by Telegram after logical deletion. Use the existing Phase 5.1 dashboard-only repair workflow for deterministic manifest-first list-index repair; do not fabricate markers, list leaves, cursors, manifests, or tokens in KV.

## Deliberately excluded from Phase 6A

- AWS Signature V4, access/secret key provisioning, credential rotation, presigned URLs, and SDK certification;
- multipart upload/copy, bucket CRUD/listing, policy/ACL/lifecycle/tagging/SSE/object-lock/checksum APIs;
- full arbitrary S3 key/bucket behavior beyond the existing safe object engine subset;
- billing, analytics, dashboard redesign, CLI/SDK work, R2 migration, public delivery, or legacy route changes.

## Verification included

`test/s3-protocol.test.js` exercises dashboard Basic/session-only temporary auth, rejected Bearer/no-config modes, server-only project isolation, the route/middleware chain, all five object mappings, marker-backed `NoSuchBucket`, logical-delete `NoSuchKey`, bounded bodies/metadata, condition/range translation, XML parsing/escaping, opaque encrypted/tamper-resistant continuation tokens, prefix/delimiter/max-keys/start-after behavior, no internal-field leakage, selection/token isolation, and error/status mapping.

Run before deployment:

```bash
node --check functions/cloud/s3-auth.js
node --check functions/cloud/s3-xml.js
node --check functions/cloud/s3-protocol.js
node --check functions/s3/_middleware.js
node --check 'functions/s3/[[path]].js'
node --check functions/cloud/object-storage.js
git diff --check
npx mocha test/s3-protocol.test.js test/object-storage.test.js test/object-semantics.test.js --reporter dot
npm test
```

Also smoke-test Pages routing with a local Wrangler KV binding: verify anonymous `/s3/:bucket?list-type=2` returns XML `AccessDenied`, dashboard-Basic access with the test project configured reaches XML `NoSuchBucket` for an unused bucket, `/api/storage/:bucket` retains its JSON Bearer-only failure, and `/file/*` remains on the unchanged legacy route.

## Narrow Phase 6B recommendation: SigV4 only

If external S3 access is justified, Phase 6B should be a separate security review and implement only a real server-side **SigV4 credential-to-project resolver**: securely generated access-key identifiers, one-time secret reveal, server-side verifier material/rotation/revocation in `TELEGRAPH_CLOUD_KV`, canonical-request and signed-header verification with bounded clock skew/body-hash policy, constant-time checks where applicable, explicit project/scopes from verified credential metadata, redacted audit telemetry, and adversarial replay/cross-project/canonicalization tests.

Keep the temporary dashboard bridge disabled by default once that exists. Do not combine SigV4 with presigned URLs, multipart, bucket CRUD, ACL/policy, SDK certification, billing, analytics, or a dashboard redesign; each needs a separate protocol, storage, and threat-model decision.
