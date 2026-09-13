# Telegraph Cloud — Phase 5: Object Storage Semantics and Listing

Phase 5 extends the Phase 4 project-scoped Telegram object engine with private JSON listing, bounded cursor pagination, slash-delimiter grouping, HTTP single-byte-range reads, and complete conditional-read/write behavior. It does **not** replace the Phase 4 engine, legacy media uploader, or `/file/*` behavior.

> **Status:** experimental/self-hosted object engine. This is Telegram-backed persistence plus Cloudflare KV materialization. It is not Amazon S3, R2, a filesystem, a relational/ACID database, a transactional object store, a public CDN, a secret manager, or an unlimited-throughput service.

Read the [Phase 4 object-engine reference](telegraph-cloud-phase-4-object-storage.md) for the base object lifecycle, project/key control plane, and Telegram adapter. This document is the source of truth for the Phase 5 additions and supersedes Phase 4's former “listing unavailable” and “range rejected” statements.

## Scope and compatibility

Phase 5 adds the following over the existing Phase 4 generic engine:

- authenticated `GET /api/storage/:bucket` listing under `storage:read`;
- deterministic lexicographic `key:asc` traversal, a literal `prefix` selector, bounded `limit`, short-lived opaque `cursor`, and practical slash `delimiter` / `common_prefixes` behavior;
- a bounded, repairable KV secondary index for current active object manifests;
- valid **single** `Range: bytes=…` object GET and HEAD behavior;
- read `If-Match`, `If-Unmodified-Since`, `If-None-Match`, and `If-Modified-Since` semantics, plus `If-Unmodified-Since` on PUT and DELETE;
- consistent public metadata across GET, HEAD, and LIST.

It deliberately does **not** add AWS Signature V4, S3 XML routes or `ListObjectsV2` XML, presigned URLs, multipart upload, AWS SDK compatibility, public versioning/history APIs, public delivery, bucket administration, billing, analytics, a storage dashboard redesign, a CLI, or an SDK. Multipart byte ranges are intentionally rejected rather than approximated.

The legacy `/upload`, `/file/*`, dashboard media records, `img_url` KV namespace, Telegram/R2 media-provider behavior, public links, and dashboard credentials remain separate and unchanged. A Phase 5 object is private and Bearer-key authenticated; it is not a legacy generated file ID or public file URL.

## Deployment and bindings

No new binding is required beyond the Phase 4 engine, but listing depends on the same dedicated KV namespace and secret used by project-scoped storage.

| Setting | Required for | Notes |
| --- | --- | --- |
| `TELEGRAPH_CLOUD_KV` KV binding | project/key control plane, object manifests/outboxes/revisions, Phase 5 list leaves and continuation state | Use a dedicated namespace, never legacy `img_url`. It stores metadata/index state only—never object bytes or API-key plaintext. |
| `API_KEY_PEPPER` Pages secret | developer-key verification and cursor HMAC signing | At least 32 UTF-8 bytes, unique per environment. Changing it invalidates developer keys and outstanding list cursors. |
| `TG_Bot_Token` and `TG_Chat_ID` | Telegram object bytes/revision events and GET resolution | Keep them server-side. They never appear in response bodies, list output, custom metadata, or telemetry. |
| `TELEGRAPH_CLOUD_MAX_OBJECT_BYTES` | existing Phase 4 object body limit | Decimal `1` through `20,971,520`; default `10,485,760` (10 MiB). This controls upload bodies, not list pages. |
| `TELEGRAPH_CLOUD_DEFAULT_OBJECT_LIST_LIMIT` | optional default list page size | Integer `1` through the configured maximum; default `50`. |
| `TELEGRAPH_CLOUD_MAX_OBJECT_LIST_LIMIT` | optional hard list page maximum | Integer `1` through `100`; default `100`. Do not increase it: the hard product maximum is 100. |
| `BASIC_USER` / `BASIC_PASS` | dashboard-only project/key issuance | These credentials are never accepted by `/api/storage/*`. Use a developer key with explicit storage scopes at runtime. |

The cursor signer deliberately reuses the already-required server-only `API_KEY_PEPPER` as a separately domain-separated HMAC key. The opaque cursor is not an API credential and does not grant access without a valid `storage:read` Bearer key.

## Private HTTP API

All object endpoints require `Authorization: Bearer tg_live_…`. The verified developer-key metadata selects exactly one project on the server; no client-provided `project_id` query parameter, header, body field, object key, cursor, or metadata value can select another project. A valid key must have the stated scope.

All successful object/list responses use `Cache-Control: private, no-store` and `Vary: Authorization`. They never produce a public `/file/*` link.

| Method | Route | Scope | Result |
| --- | --- | --- | --- |
| `GET` | `/api/storage/:bucket` | `storage:read` | List current public metadata in one bucket. |
| `PUT` | `/api/storage/:bucket/:key` | `storage:write` | Create or replace a bounded raw object. |
| `GET` | `/api/storage/:bucket/:key` | `storage:read` | Read active bytes, optionally a valid single range. |
| `HEAD` | `/api/storage/:bucket/:key` | `storage:read` | Read active metadata without downloading byte content. |
| `DELETE` | `/api/storage/:bucket/:key` | `storage:write` | Create a logical tombstone; Telegram historical bytes are retained. |

`GET /api/storage/:bucket` is the only bucket-root operation. `HEAD`, `PUT`, and `DELETE` at the bucket root return `405` with `Allow: GET`; bucket creation/deletion/listing is not an API feature.

### List current objects

```bash
curl -sS 'https://your-domain.example/api/storage/assets?prefix=reports%2F&delimiter=/&limit=50' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY"
```

A representative response is JSON, not S3 XML:

```json
{
  "objects": [
    {
      "bucket": "assets",
      "key": "reports/summary.txt",
      "size": 42,
      "content_type": "text/plain",
      "etag": "sha256-Base64urlSha256Digest-v3",
      "version": 3,
      "created_at": "2026-09-13T12:00:00.000Z",
      "updated_at": "2026-09-13T12:10:00.000Z",
      "metadata": { "owner": "reporting-service" }
    }
  ],
  "common_prefixes": ["reports/2026/"],
  "limit": 50,
  "order": "key:asc",
  "next_cursor": "opaque-short-lived-value",
  "has_more": true
}
```

Only `objects`, `common_prefixes` (when requested), `limit`, `order`, `next_cursor` (when more traversal remains), and `has_more` are returned. Object entries deliberately contain only public object metadata: bucket, key, size, normalized content type, ETag, logical version, created/updated timestamps, and validated `X-Amz-Meta-*` values represented by `metadata`. They do **not** contain Telegram `file_id`/message identifiers/file paths, Bot API URLs/tokens, KV names, index node IDs, outbox IDs, revision IDs, parent pointers, content hashes, deleted timestamps, or credential material.

#### Query controls

| Parameter | Rule |
| --- | --- |
| `prefix` | Optional literal, case-sensitive object-key prefix. Empty is allowed. It uses the same NFC UTF-8 safety rules as object keys, except a trailing slash is allowed. It is not a glob, regular expression, decoded path traversal mechanism, or directory lookup. |
| `delimiter` | Optional. The only supported value is literal `/`. When present, an object with another `/` after the selected prefix contributes its immediate common prefix instead of an object entry. No directory records are created. |
| `limit` | Optional decimal integer. Defaults to `TELEGRAPH_CLOUD_DEFAULT_OBJECT_LIST_LIMIT` (50 unless configured), must be at least 1, and must not exceed the configured/hard maximum (100). |
| `cursor` | Optional opaque continuation returned by the prior page. It must be sent unchanged and URL-encoded. It is valid for approximately ten minutes. |

Unknown or duplicate query controls are rejected. So are malformed/oversized prefixes, cursors, delimiter values, or limits. A `project_id` query hint is not accepted by the list endpoint; it cannot override the authenticated project.

Without `delimiter`, `objects` are sorted by full normalized key in ascending UTF-8 lexicographic order (`key:asc`). With `delimiter=/`, the combined logical stream is still key-order traversal: direct objects and each distinct `common_prefix` consume one `limit` slot. `objects` and `common_prefixes` are returned as separate arrays for convenient clients, so callers should use `next_cursor` rather than infer the combined order from the two arrays. Repeated keys under one common prefix never emit that common prefix twice across a cursor boundary.

The cursor is deliberately opaque. Its public envelope contains a random identifier and a domain-separated HMAC; the detailed traversal state stays in project-scoped KV with a ten-minute TTL. The HMAC binds it to the authenticated project, bucket, `prefix`, and `delimiter`, so tampering, using it in another project/bucket, or changing its selection returns `400 invalid_cursor`. The page `limit` may be changed between pages within the configured bound; it changes only how many subsequent logical entries are returned. Cursors expire, are not snapshots, and should never be stored as durable application state.

### GET/HEAD metadata and single ranges

A full GET returns `200`; a HEAD returns the equivalent metadata and no body. Both expose these safe headers for an active object:

- `ETag: "sha256-…-vN"` and `Last-Modified` derived from the current logical revision;
- `X-Telegraph-Cloud-Object-Version` with the logical version;
- normalized `X-Amz-Meta-*` headers;
- `Accept-Ranges: bytes`;
- for representation responses, exact `Content-Type`, `Content-Length`, fixed safe `Content-Disposition: attachment; filename="download"`, and `X-Content-Type-Options: nosniff`.

`Range` supports one exact bytes unit range only:

```bash
curl -D - 'https://your-domain.example/api/storage/assets/reports/summary.txt' \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'Range: bytes=0-1023'
```

Accepted forms are `bytes=<start>-<end>`, `bytes=<start>-`, and `bytes=-<suffix-length>`. The returned range is clamped at the object end where HTTP permits it. A satisfiable GET returns `206 Partial Content` with:

```text
Accept-Ranges: bytes
Content-Range: bytes <start>-<end>/<full-size>
Content-Length: <end - start + 1>
```

The body is the corresponding exact byte representation. A ranged HEAD returns the same range metadata/status and no body. The object adapter sends only the engine-normalized `Range` header to Telegram after authorization and condition processing; caller Authorization, cookies, arbitrary headers, conditions, Telegram IDs, and tokens are never forwarded. If Telegram/an intermediary does not return the requested `206`/`Content-Range` (or declares a mismatched length), the engine returns a safe `502 storage_range_unavailable` instead of mislabelling a full download as a partial response.

Malformed units, multiple/comma-separated ranges, non-numeric values, reversed/unsatisfiable ranges, a suffix length of zero, empty-object ranges, and oversized Range headers return `416 range_not_satisfiable`. That response includes exactly the safe HTTP information needed for recovery:

```text
Accept-Ranges: bytes
Content-Range: bytes */<public-object-size>
```

Multipart/byteranges responses and `If-Range` behavior are not implemented in Phase 5. Do not use `If-Range` as a conditional range control.

### Conditional precedence

All object conditions are evaluated against the current active manifest **before** Telegram byte retrieval or any range retrieval. This prevents a conditional cache check from causing an unnecessary backend download.

For GET and HEAD, precedence is:

1. `If-Match` uses strong matching. A non-match returns `412 precondition_failed`.
2. If `If-Match` was absent, `If-Unmodified-Since` is checked at HTTP-date second precision. A resource modified later returns `412`.
3. `If-None-Match` is then evaluated (`*` and weak tags are supported for safe GET/HEAD comparison). A match returns `304 Not Modified`.
4. Only when `If-None-Match` is absent is `If-Modified-Since` evaluated. A not-modified date returns `304`.
5. Only after those decisions is `Range` parsed and passed to the adapter.

An invalid HTTP date is ignored in the usual HTTP-compatible way; malformed/bounded-invalid ETag controls return `400 invalid_precondition`. A `304` has no body and is returned before range processing/download. It retains safe validator/metadata headers but does not promise a representation body.

For PUT and DELETE, `If-Match` is evaluated first; when it is present, `If-Unmodified-Since` is ignored. Otherwise `If-Unmodified-Since` is evaluated for an active current object, then `If-None-Match` is evaluated. Combining write `If-Match` and `If-None-Match` is rejected as `400 invalid_precondition`; a failed write condition is `412 precondition_failed` before a new Telegram byte document/event is created. Phase 4's `If-Match`/`If-None-Match` replacement protections and idempotent recovery behavior remain intact.

## Index architecture and bounded work

Listing does not scan a bucket's manifests on every request, does not rely on Telegram message order, does not put object bytes in KV, and does not create entries for every possible textual prefix.

Instead, after the Phase 4 mutation path has materialized the authoritative current manifest, it materializes a small active-key secondary index:

1. The normalized UTF-8 key is encoded into a lexicographically sortable token.
2. The token is divided into fixed 32-byte chunks. Existing-key-only shared branch markers and a terminal leaf give ordered traversal without placing an arbitrary 1,024-byte object key in a Cloudflare KV key name.
3. The terminal leaf uses a SHA-256-derived opaque key token, not a public response pointer. It carries no object body or Telegram pointer.
4. A list request walks at most fixed-size KV pages and at most 400 index candidates before producing/continuing a page. It reads the authoritative current manifest for each candidate before returning public metadata.

The tree depth is bounded by the existing 1,024-byte object-key maximum. Cloudflare KV's practical 512-byte key-name limit is respected even for a maximum-length key. Common branch markers are read-before-write deterministic markers; they are not rewritten for every object sharing a prefix. Branch markers may remain after the final leaf deletion because deleting a shared branch without an atomic child count would race an active sibling. They are non-public, bounded traversal state, not directories.

The current manifest remains authoritative. If a leaf is missing, stale, points to a tombstone, or disagrees with the current manifest, it is silently omitted from the public page. A tombstone removes its terminal leaf during normal mutation materialization; the revalidation rule prevents a partial index-repair failure from resurrecting deleted/replaced data.

### Mutation/recovery relationship

The Phase 4 order remains append-oriented:

1. stage mutation intent and immutable raw bytes/event in Telegram as needed;
2. persist immutable revision-index state;
3. materialize the current active/tombstoned manifest and bucket marker in KV;
4. materialize/update/remove the Phase 5 list leaf;
5. mark the existing outbox mutation applied.

There is no cross-system transaction. If a failure happens after Telegram accepts a byte/event document but before the manifest/list leaf is durably confirmed, the API returns `503 object_mutation_pending`, not false success. Retry the exact PUT/DELETE with the same `Idempotency-Key` after KV recovers. A ready outbox replay repairs manifest/list materialization without duplicating an already-staged Telegram upload/event. If KV failed before an accepted Telegram pointer was recorded, Telegram retention can still contain an inaccessible duplicate: the normal at-least-once limitation remains.

Phase 5 intentionally has no background scanner and no whole-bucket fallback. That keeps each normal list request bounded, but creates a deployment boundary: active Phase 4 manifests created before this list index exists may not have a leaf until a later successful mutation materializes one. Phase 5.1 now supplies a separate [dashboard-only, bounded manifest-first repair workflow](telegraph-cloud-phase-5-1-index-repair.md) for that index gap: it can dry-run and rebuild deterministic missing/stale index paths (including required branch markers) without making a new object revision. It is not part of public LIST and does not make arbitrary direct KV editing supported. An application-controlled rewrite/re-PUT remains an alternative when a new logical revision is desired; use known expected ETag / `If-Match` policy and an idempotency key.

## Consistency and concurrent mutation behavior

Telegram and Cloudflare KV are separate remote systems; KV is eventually consistent and has no global compare-and-swap transaction. Listing is therefore a bounded, best-effort view of manifests visible at the serving edge, **not a snapshot** and not an audit/history API.

In particular:

- A newly completed PUT can be temporarily absent from a list at another edge while its KV list leaf/manifest propagates.
- A delete/replacement can race a list. Manifest revalidation hides tombstones visible to that request, but another edge can temporarily see an older manifest/index view.
- A continuation cursor holds traversal position, not a frozen result set. Keys created before already-traversed order may not appear in that traversal; later keys may appear. Deletes are skipped; replacements/recreations can have metadata/version visible at the time their manifest is read.
- Stable data should traverse without duplicate logical keys. Under concurrent writes or cross-edge propagation, clients must not claim global exactly-once pagination: deduplicate by `key`, and use GET/HEAD plus ETag before making consequential decisions.
- Cursor state expires after about ten minutes. An expired/missing state is a safe `400 invalid_cursor`; restart from the first page rather than attempting to decode or repair it client-side.

The same Phase 4 optimistic condition checks protect ordinary stale writes. Concurrent writers can still originate from different eventually consistent views; deterministic revision conflict detection may return `409 object_conflict` rather than claim serializable semantics.

## Revision, deletion, and recreation semantics

Every successful PUT creates an immutable logical revision and advances the logical `version`; the public ETag is SHA-256 content digest plus that version. Replacing with identical bytes is still a later revision and receives a different version suffix/ETag. The current active manifest is the only normal GET/HEAD/LIST representation.

DELETE appends an immutable tombstone revision and changes the current manifest to `deleted`. Normal GET, HEAD, LIST, and a new DELETE treat it as absent (`404 object_not_found` for direct object access). DELETE does not call Telegram `deleteMessage`; historical byte/event documents can remain retained by Telegram and are deliberately not exposed through this API.

A later PUT of the same project/bucket/key recreates an active object as a newer logical revision. It keeps the immutable history internally, but Phase 5 intentionally has no public version/history API. LIST shows only the new active metadata, never a tombstone, historical revision, internal parent, or provider pointer.

## Limits, errors, and security boundaries

The Phase 4 bucket/key/MIME/custom-metadata/body limits continue to apply. In addition, list prefix/cursor/query values and Range headers are bounded before backend work. The hard list page maximum is 100; internal index traversal has a separate 400-candidate work bound to prevent an unbounded stale-index repair cost from becoming a single request scan.

| Situation | Safe response |
| --- | --- |
| Missing/malformed/revoked Bearer key | `401 {"error":"invalid_api_key"}` |
| Valid key without `storage:read` / `storage:write` | `403 {"error":"api_key_scope_forbidden"}` |
| Inactive/missing authenticated project | `403 {"error":"project_inactive"}` |
| Object absent/tombstoned in caller project | `404 {"error":"object_not_found"}` |
| Unsupported/duplicate list query control | `400 {"error":"invalid_object_list_query"}` |
| Bad list limit/delimiter/prefix/cursor | bounded `400`, such as `invalid_object_list_limit`, `invalid_object_delimiter`, `invalid_object_prefix`, or `invalid_cursor` |
| Bad/unsatisfiable/multipart byte range | `416 {"error":"range_not_satisfiable"}` with safe `Content-Range: bytes */<size>` and `Accept-Ranges: bytes` |
| Upstream does not honor validated single range | `502 {"error":"storage_range_unavailable"}` |
| Failed object read/write condition | `412 {"error":"precondition_failed"}` |
| Concurrent/idempotency conflict | `409 object_conflict` or `idempotency_key_reused` |
| KV/Telegram/list-index temporary failure | safe `503 storage_backend_failure`, `object_mutation_pending`, or `object_list_index_unavailable` |

Error bodies are allowlisted codes only. Cursor payloads are HMAC-verified and state is project-scoped. Object key/prefix validation rejects traversal and URL ambiguity; list paths never construct Telegram URLs. The adapter creates a fresh synthetic Telegram download request and forwards only an engine-validated Range header. Internal pointers, raw metadata storage state, upstream diagnostics, body bytes, API credentials, `API_KEY_PEPPER`, and Telegram tokens are not rendered or logged by these endpoints. Existing telemetry redaction remains in force; custom metadata is not a telemetry header allowlist field.

## Legacy coexistence and migration

Phase 5 does not import legacy uploaded media into object storage. To migrate an authorized legacy asset deliberately: download/read it through the existing legacy path, choose a project/bucket/key and safe MIME/metadata policy, PUT it with a storage-scoped key and unique idempotency key, verify GET/HEAD and list output, then update the application reference. This does not preserve a legacy file ID/public link/provider message identity or offer physical deletion.

For already-created Phase 4 objects, also account for the Phase 5 leaf-index deployment boundary described above. Do not fabricate list leaves or cursors in KV. Prefer the [Phase 5.1 operator-only repair workflow](telegraph-cloud-phase-5-1-index-repair.md) to inspect/rebuild deterministic leaves from current manifests without changing object revisions. Use an application-controlled, bounded rewrite only when a new logical version/ETag is intentionally desired.

## Verification included

Focused tests cover lexicographic pagination, cursor tampering/project/selection isolation, bounded controls, literal prefix and delimiter grouping, long-key chunk traversal, public-metadata filtering, project isolation, tombstones/recreation versions, index-materialization retry and stale-leaf hiding, range forms/errors/upstream refusal, conditional precedence, PUT `If-Unmodified-Since`, route-level authorization/listing/416 headers, and Phase 0–4 regressions.

Run before deployment:

```bash
node --check functions/cloud/object-list-index.js
node --check functions/cloud/object-storage.js
node --check functions/cloud/object-http.js
node --check functions/cloud/telegram-object-storage.js
node --check functions/api/storage/[bucket]/[[key]].js
node --check functions/api/storage/_middleware.js
git diff --check
npx mocha test/object-storage.test.js test/object-semantics.test.js test/cloud-index.test.js test/cloud-validation.test.js --reporter dot
npm test
```

A Pages/Wrangler smoke should also verify that the Functions router starts with a KV binding, that `GET /api/storage/:bucket` receives the Bearer-only `storage:read` boundary, and that legacy `/file/*` still responds through its unchanged path.

## Phase 5.1 repair and deliberately scoped Phase 6 direction

The former pre-Phase-5 migration recommendation is now delivered as [Phase 5.1](telegraph-cloud-phase-5-1-index-repair.md): a dashboard-authenticated, project-bound, checkpointed manifest scan with dry-run/apply modes, bounded pages, safe count-only progress, retryable dependency failures, and deterministic index-path/terminal-leaf repair/removal. It does not read bytes, create revisions, expose pointers, or expand `/api/storage/*`.

Before considering any S3 protocol work, first gather operational experience with that repair checkpoint. If follow-on work is justified, scope it to a separate **operator-only raw-index audit planner** for reporting orphan leaves/retained branch pressure in bounded, manifest-revalidated passes. It must retain dry-run-first behavior and have its own concurrency/retention threat model. Do not combine it with SigV4, presigned URLs, S3 XML, multipart state, an SDK, or public APIs.
