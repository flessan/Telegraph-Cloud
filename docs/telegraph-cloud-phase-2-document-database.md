# Telegraph Cloud — Phase 2: Telegram-backed Document Database

Phase 2 adds the first real Telegraph Cloud capability: a bounded document database with Pages REST routes. It is additive. Existing uploads, `/file/*`, legacy Telegram/R2 providers, dashboard media management, albums, short links, and authentication behavior remain unchanged.

> **Status:** experimental/self-hosted document API. This is a Telegram-backed document database, not PostgreSQL, not a SQL-compatible service, and not an ACID or strongly transactional system.

## Scope

Implemented:

- `POST /api/db/:collection`
- `GET /api/db/:collection`
- `GET /api/db/:collection/:id`
- `PATCH /api/db/:collection/:id`
- `DELETE /api/db/:collection/:id`
- immutable Telegram revision events;
- a separate `TELEGRAPH_CLOUD_KV` materialized record/collection/equality-index/outbox layer;
- tombstones, ETag/version preconditions, bounded idempotency, and retry-based index recovery;
- dashboard-session/Basic-auth protection for this interim owner-only API.

Explicitly not implemented:

- projects, multi-project isolation, or developer API keys;
- generic object storage, S3 compatibility, or `/storage/*`;
- dashboard database panels, an API playground, billing, or usage UI;
- SQL, joins, arbitrary expressions, relational constraints, transactions, or a promise of unlimited throughput/storage.

## Deploy and authenticate

The database needs all of the following Pages bindings/secrets:

| Requirement | Why |
| --- | --- |
| `TG_Bot_Token` secret | Sends immutable revision documents to the Telegram Bot API. |
| `TG_Chat_ID` secret/binding | Telegram channel or chat that receives those documents. The bot must be allowed to send documents there. |
| `TELEGRAPH_CLOUD_KV` KV binding | **Separate from** legacy `img_url`; stores the non-authoritative materialized index and mutation outbox. |
| `BASIC_USER` and `BASIC_PASS` secrets | Required in Phase 2. The API fails closed without both values. |
| `SESSION_SECRET` secret | Recommended for the existing dashboard session mechanism. |

The new routes reuse the existing dashboard HMAC session cookie and its deliberate Basic-auth fallback. They never use `img_url`, do not enable CORS, and do not accept an API key yet. A request without a valid existing dashboard session/Basic identity receives `401 {"error":"unauthenticated"}`. A deployment that does not configure both `BASIC_USER` and `BASIC_PASS` receives `503 {"error":"database_auth_not_configured"}` rather than exposing the database publicly.

For a script, use the current temporary Phase 2 auth form:

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-thio-20260912' \
  -d '{"name":"Thio","role":"admin"}' \
  https://your-domain.example/api/db/users
```

Phase 3 will replace this owner-only boundary with project-derived developer API keys. It must not be treated as a final public application-auth scheme. Phase 2 also applies a best-effort **20 mutation requests per authenticated identity per minute per running Function isolate** and returns `429 {"error":"rate_limited"}` with `Retry-After` when that local guard is full. It protects against accidental bursts before Telegram's own limits, but it is not a distributed quota or a substitute for future per-project abuse controls.

## Record model and public responses

A collection name is a lowercase, URL-safe name such as `users`. A record is an arbitrary **JSON object**. The server generates its opaque `rec_…` identifier; callers cannot supply or overwrite managed top-level fields:

```text
id, collection, record_id, version, created_at, updated_at, deleted, deleted_at,
tombstone, operation, event_id, parent, parent_event_id, schema, journal_pointer,
query_fields
```

The current public record response is intentionally free of Telegram identifiers:

```json
{
  "data": {
    "id": "rec_RandomServerGeneratedValue",
    "name": "Thio",
    "role": "admin"
  },
  "version": 1,
  "created_at": "2026-09-12T12:00:00.000Z",
  "updated_at": "2026-09-12T12:00:00.000Z"
}
```

`ETag` is the quoted version (`"1"`, `"2"`, and so on). `collection`, tombstone state, journal event ID, Telegram `file_id`, and Telegram `message_id` are internal metadata and never appear in normal API output. This database is not a secret manager: do not place bot tokens, API-key secrets, passwords, or credentials in record data, because the current materialized record is intentionally stored in KV as well as its immutable canonical revision in Telegram.

### Create

```text
POST /api/db/users
Content-Type: application/json
Idempotency-Key: create-thio-20260912

{"name":"Thio","role":"admin"}
```

A successful create returns `201`, `Location`, `ETag: "1"`, and the public response above. The server uploads a `telegraph-cloud.record.v1` immutable JSON document to Telegram before making the current record visible in KV.

### Read one record

```text
GET /api/db/users/rec_RandomServerGeneratedValue
```

Returns `200` plus the current public response and ETag. Missing records and tombstones both return:

```json
{ "error": "record_not_found" }
```

with `404`.

### List records

```text
GET /api/db/users?role=admin&limit=20
```

A list response is:

```json
{
  "data": [
    {
      "data": { "id": "rec_…", "name": "Thio", "role": "admin" },
      "version": 1,
      "created_at": "2026-09-12T12:00:00.000Z",
      "updated_at": "2026-09-12T12:00:00.000Z"
    }
  ],
  "limit": 20,
  "order": "id:asc",
  "next_cursor": "opaque-when-more-candidates-exist",
  "has_more": true
}
```

`next_cursor` is omitted when there are no further index candidates. It is opaque and bound to the same collection/filter selection; changing filters while reusing it produces `400 {"error":"invalid_cursor"}`.

The initial query language is deliberately small:

- default and only ordering is deterministic `id:asc`; `sort=id` or `sort=+id` is accepted explicitly, while other sort values return `unsupported_sort` rather than pretending KV is a general sort engine;
- `limit` is bounded and pagination is cursor-based;
- up to four equality filters may be supplied as ordinary query parameters (`?role=admin&team=core`);
- filters are exact matches on **top-level string fields** with safe, non-sensitive field names and values no longer than 64 UTF-8 bytes; sensitive-looking names such as `password`, `token`, or `secret` are never made into KV equality-index keys;
- the first matching filter uses a KV equality index; additional filters are checked against each candidate's materialized current document;
- arrays, nested paths, numbers/booleans, ranges, regexes, arbitrary JavaScript, joins, full-text search, SQL, and arbitrary sort expressions are not supported;
- `id` is addressed through `GET /api/db/:collection/:id`, not as a list filter.

A page is bounded to one index page. When several filters are combined, it can therefore contain fewer matches than `limit`; follow `next_cursor` to continue. This keeps KV reads and Telegram-independent query work bounded rather than presenting an unbounded database query planner.

### Patch and optimistic concurrency

`PATCH` uses a shallow top-level JSON update: supplied fields replace current top-level values, while unspecified fields remain. Nested objects are replaced as values rather than recursively merged. `null` is a stored JSON value; Phase 2 does not define a field-delete operator.

Every patch needs a current-version precondition. The documented JSON form is `_expected_version`; a standard `If-Match: "<version>"` header is also accepted. If both are supplied, they must agree.

```text
PATCH /api/db/users/rec_RandomServerGeneratedValue
Content-Type: application/json
Idempotency-Key: patch-thio-role-20260912

{"_expected_version":1,"role":"member"}
```

Success returns `200`, `ETag: "2"`, and the full current snapshot. The prior Telegram revision is never changed. A missing precondition returns `428 {"error":"precondition_required"}`. A stale precondition returns, for example:

```json
{ "error": "version_conflict", "current_version": 2 }
```

with `409`.

### Delete and tombstones

Delete also requires a version precondition, normally through `If-Match`:

```bash
curl -X DELETE -u "$BASIC_USER:$BASIC_PASS" \
  -H 'If-Match: "2"' \
  -H 'Idempotency-Key: delete-thio-20260912' \
  https://your-domain.example/api/db/users/rec_RandomServerGeneratedValue
```

A JSON body containing only `{"_expected_version":2}` is also accepted. Success returns `200`, a new ETag/version, and:

```json
{
  "data": { "id": "rec_…" },
  "version": 3,
  "created_at": "2026-09-12T12:00:00.000Z",
  "updated_at": "2026-09-12T12:02:00.000Z",
  "deleted_at": "2026-09-12T12:02:00.000Z",
  "deleted": true
}
```

The delete is a tombstone revision. Normal get/list requests hide it, but the immutable Telegram history remains. Phase 2 intentionally provides no history/undelete/public-admin endpoint and makes no physical-erasure promise for Telegram documents.

## Canonical persistence and materialized index

For each create/update/delete, the service builds a complete revision snapshot such as:

```json
{
  "schema": "telegraph-cloud.record.v1",
  "event_id": "evt_internal",
  "collection": "users",
  "record_id": "rec_internal",
  "operation": "update",
  "version": 2,
  "parent": { "event_id": "evt_previous", "version": 1 },
  "created_at": "2026-09-12T12:00:00.000Z",
  "updated_at": "2026-09-12T12:01:00.000Z",
  "deleted": false,
  "document": { "id": "rec_internal", "name": "Thio", "role": "member" }
}
```

It uploads this as a fixed-name Telegram JSON document through the Phase 1 append-only journal adapter. There is no Telegram message editing operation.

`TELEGRAPH_CLOUD_KV` then stores derived, non-authoritative state under the separate `tc:v1` prefix:

| Index namespace | Purpose |
| --- | --- |
| `db-record` | Current full materialized record and internal Telegram revision pointer. |
| `db-revision` | Internal materialized winning-version-to-event/pointer lookup for future history/repair work; competing immutable Telegram events are not discarded from Telegram. |
| `db-collection` | Current visible-record lookup for collection pages. |
| `db-filter` | Bounded top-level string equality lookup entries. |
| `db-outbox` | Mutation intent, journal pointer, applied result, or conflict state. |

Normal `GET` and list operations read this materialized index rather than scan Telegram history. KV is **not** represented as the source of truth: the canonical immutable revision is in Telegram, and KV only points to/materializes it. Telegram IDs stay inside these internal records and never cross the HTTP response boundary. There is deliberately no project segment in the Phase 2 keys because projects do not exist yet; Phase 3 must introduce a server-derived project scope rather than accepting an untrusted project selector from this API.

## Mutation sequence, retries, and recovery

For a mutation, the service:

1. validates the route, JSON, managed fields, expected version, and configured limits;
2. writes a bounded outbox intent to the dedicated KV namespace;
3. appends the immutable revision document to Telegram;
4. saves the resulting internal journal pointer to the outbox;
5. writes the revision/current/collection/filter materialized index entries; and
6. marks the outbox as applied.

`Idempotency-Key` is optional but strongly recommended for **every** create, patch, and delete. Its raw value is never stored in Telegram or used in a KV key; a SHA-256 digest identifies its outbox record. Applied/conflict idempotency receipts are retained for seven days; within that period, retrying the same mutation with the same key and request shape returns the original result without making a second logical record or revision. Reusing a key with another request returns `409 {"error":"idempotency_key_reused"}`. After the receipt expires, a caller must not assume a repeated create is deduplicated. When the header is omitted, the service creates an internal mutation ID for its own sequencing, but a client that times out has no stable handle for a deduplicated/recovery retry.

If Telegram fails before accepting the append, the request returns a safe `502` error and the outbox remains an intent for a same-key retry. An indeterminate Telegram transport failure can mean Telegram accepted the event even though no pointer reached the worker; a retry may then produce a duplicate **physical** Telegram document with the same internal event ID, never a second logical record/revision. If Telegram accepted the revision but a KV materialization write fails, the API returns:

```json
{ "error": "mutation_pending" }
```

with `503`; it does **not** claim a normal success. Retry the exact request with the same `Idempotency-Key` after KV recovers. The stored outbox resumes materialization from the internal journal pointer. If the failure happened before the pointer itself could be saved, retrying can create a duplicate physical Telegram document carrying the same internal event ID, but it will not create a second logical record; the service materializes that event only once.

There is no background repair worker or public repair endpoint in Phase 2. A same-key retry is the practical automatic recovery path. Telegram's Bot API does not provide a safe general channel-history query for reconstructing an erased KV namespace, so a total loss of `TELEGRAPH_CLOUD_KV` cannot be automatically rebuilt by this release. Keep the binding durable and treat the outbox as recovery metadata, not a substitute for backups/export tooling (which is future work).

## Consistency and concurrency limits

The service checks the current materialized version before appending and again while materializing. It writes a version-index entry and confirms the write/current pointer so ordinary stale writers receive `409` rather than silently replacing a newer record. However, Cloudflare KV has no cross-edge compare-and-swap or transaction. Two writers that start simultaneously at separate edges can still append competing immutable descendants before either edge observes the other.

The implementation retains those Telegram events. For competing children with the **same parent and version**, the materialized tie-break is deterministic: the lexically smaller internally generated opaque event ID wins when the candidates become visible. The derived KV revision/current pointer may therefore replace a larger competing child, while both Telegram revisions remain immutable for inspection/repair. A candidate that observes the smaller winner returns/stores a conflict. Because KV propagation is eventually consistent, an early successful response can still later lose that tie-break at another edge; clients must re-read before a dependent write.

This is practical optimistic concurrency, not serializable isolation. Clients must use `_expected_version`/`If-Match` and idempotency keys, retry conflicts by re-reading, and be prepared for temporary index propagation/recovery delays.

There are no multi-record transactions, rollback, ACID guarantees, SQL semantics, arbitrary historical replay, or unlimited performance claims.

## Limits and configuration

The following Phase 2 environment variables can only lower bounded hard ceilings:

| Variable | Default | Accepted range | Purpose |
| --- | ---: | ---: | --- |
| `TELEGRAPH_CLOUD_MAX_DOCUMENT_BYTES` | 98,304 bytes | 1,024–98,304 | Maximum parsed JSON request/current document size. Kept below the 128 KiB journal cap for revision metadata. |
| `TELEGRAPH_CLOUD_MAX_COLLECTION_NAME_LENGTH` | 64 | 1–64 | Maximum collection-name UTF-8 bytes. |
| `TELEGRAPH_CLOUD_MAX_RECORD_ID_LENGTH` | 128 | 26–128 | Maximum record-ID UTF-8 bytes. Generated IDs are currently 26 bytes/characters. |
| `TELEGRAPH_CLOUD_DEFAULT_QUERY_LIMIT` | 20 | 1–configured max | List limit when `limit` is omitted. |
| `TELEGRAPH_CLOUD_MAX_QUERY_LIMIT` | 100 | 1–100 | Maximum list page size. |

Fixed Phase 2 bounds: at most four filters, 16 indexed string fields per record, 64-byte filter field/value limits, 1,024-byte opaque cursor limit, and 128-byte idempotency-key limit. Invalid database-limit configuration fails safely with `503 {"error":"invalid_database_limit"}`.

Every database response uses `Cache-Control: no-store`. The service accepts only `application/json` bodies for POST/PATCH and for DELETE when a body is supplied; an empty DELETE body is permitted when `If-Match` supplies the required version. Malformed JSON is `400`, unsupported content types are `415`, oversized payloads are `413`, and unknown methods are `405` with an `Allow` header.

## Verification

Phase 2 coverage includes mocked Telegram journal calls and KV state for create/read/list/filter/cursor/update/delete, immutable revision preservation, tombstones, version conflicts, missing preconditions, idempotency, Telegram failures, partial index failure/retry recovery, payload/path/managed-field validation, no Telegram-pointer response leakage, authentication, and safe error handling.

The full repository suite remains the compatibility gate:

```bash
npm test
```

Latest Phase 2 verification: **360 passing** (approximately 36 seconds). The suite includes legacy upload/file/dashboard/auth coverage as well as the new database regression cases.

## Recommended next phase

Proceed to **Phase 3: projects and developer API keys** only after reviewing the owner-only database boundary. It should introduce project-derived authorization, securely generated one-time API-key secrets, hash-only storage with `API_KEY_PEPPER`, scopes, revoke/rotation, and project-bound database access—without changing the journal/index model or exposing Telegram internals.
