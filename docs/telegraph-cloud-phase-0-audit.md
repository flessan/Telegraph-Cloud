# Telegraph Cloud — Phase 0 Architecture Audit

**Audit date:** 2026-09-12  
**Repository baseline:** `cd381aa418d7c58d1d2b97cd59a837bece7cfc21` on `arena/01a095bf-telegraph-image`

## Purpose and outcome

This document records the architecture that exists before the Telegraph Cloud work begins and defines the incremental migration plan. The current deployment is a Cloudflare Pages project with file-based Pages Functions and a dependency-free static user interface. It is not being replaced wholesale.

The existing Telegraph-Image workflows will remain supported while Telegraph Cloud is introduced alongside them:

- `POST /upload`
- `GET|HEAD|OPTIONS /file/:id`
- `/api/manage/*`
- dashboard sign-in, media management, albums, moderation, short links, and existing public file URLs

No runtime behavior was intentionally changed during Phase 0.

## Existing architecture

### Deployment and UI

| Area | Current implementation | Reuse decision |
| --- | --- | --- |
| Hosting | Cloudflare Pages with file-based Functions in `functions/`; there is no Worker entry point or build step. | Preserve. New routes will use the same Pages Functions convention. |
| Public UI | Static `index.html`, `admin.html`, and `login.html`; vanilla ES modules under `js/` and CSS under `css/`. | Preserve the shared design tokens, responsive shell, dialog/focus patterns, command palette, theme, and localization foundations. |
| Dashboard | `/admin` is a mature remote-media workspace with paginated browsing, albums, MIME-aware previews, upload staging/queueing, moderation actions, and keyboard controls. | Evolve it into a control plane rather than replacing it. Legacy media remains a distinct compatible surface while Database, Storage, Projects, Keys, Usage, and Playground are added progressively. |
| Tests | Mocha unit/DOM tests plus optional Playwright scripts. | Extend the existing test style and helpers; do not introduce a framework merely for new features. |

### Current Pages Function routes

| Route | Responsibility |
| --- | --- |
| `POST /upload` | Accepts `multipart/form-data`, applies optional upload Basic Auth, selects a storage provider, uploads a file, and returns the stable `/file/...` URL contract. |
| `GET|HEAD|OPTIONS /file/:id` | Resolves short links, proxies legacy Telegraph/Telegram or R2 content, applies optional hotlinking/moderation, and supplies compatibility/CORS/content-disposition behavior. |
| `/api/manage/*` | Authenticated media metadata, pagination, albums, whitelist/blacklist, likes, rename, sign-in, and session APIs. |
| `GET /api/config` | Exposes non-secret UI/deployment status only. |
| `/api/bing/wallpaper` | Legacy auxiliary UI route. |

The Pages Functions use `context.env` bindings, which is the correct Cloudflare mechanism for secrets and bindings. There is no custom `.env` management surface.

### Existing Telegram and object-storage implementation

The repository already has a useful, narrow provider boundary:

- `functions/storage/index.js` selects `telegram` (default) or `r2`.
- `functions/storage/telegram.js` uploads through the Telegram Bot API and resolves an uploaded `file_id` through `getFile` before proxying the download.
- `functions/storage/r2.js` is an optional R2 provider with an `r2-` identifier prefix.
- `functions/utils/telegram.js` contains the direct Bot API mechanics (`sendPhoto`, `sendAudio`, `sendVideo`, `sendDocument`, `getFile`, retry behavior, and configuration validation).

This is a good starting point, but it is a legacy media-provider contract (`upload` / `fetchFile`) rather than a generic object-storage contract. It does not have buckets, caller-selected keys, manifests, object metadata, logical deletion, listing, or a public S3-shaped API yet.

Existing Telegram-backed media IDs are intentionally opaque in the public compatibility path. The current long ID is effectively a Telegram `file_id` plus filename extension; pre-existing short IDs are resolved from KV; old Telegraph IDs still fall back to `telegra.ph`.

### Existing Cloudflare KV use

The optional `img_url` KV binding currently stores **metadata/index data**, not media bytes:

- per-file moderation and display metadata;
- short-link mappings (`short:` prefix);
- album records (`album:` prefix);
- moderation model-cache records (`moderation:` prefix).

This metadata is deliberately namespaced and excluded from the legacy media list. It is already a useful precedent for a separate internal index, but it is not an atomic database and must not be treated as one.

### Existing authentication

| Surface | Current behavior | Preservation requirement |
| --- | --- | --- |
| Dashboard | `BASIC_USER` / `BASIC_PASS` are verified by an HMAC-signed, HttpOnly, SameSite session cookie. Basic credentials are still accepted for script compatibility. | Keep functioning. Telegraph Cloud dashboard access continues to be dashboard authentication, not a developer API key. |
| Legacy upload | `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` optionally protect `/upload`; an unset pair preserves public-upload compatibility. | Keep unchanged unless a concrete security regression requires a narrowly scoped fix. |
| Management APIs | `/api/manage/*` requires the existing dashboard session/Basic identity when dashboard credentials are configured. | Keep isolated from the new developer API authentication. |

There is no account system or multi-user identity provider today. The initial project model should therefore be deployment-local and managed by the existing dashboard owner, not pretend to be a hosted multi-tenant identity service.

## Important constraints discovered during the audit

### Telegram is a persistence substrate, not a database or S3 service

Telegram Bot API storage is practical for immutable bytes and small immutable JSON journal entries, but it does not provide the operations a database needs:

- no SQL engine, relational constraints, transactions, or ACID guarantees;
- no general Bot API operation to search or enumerate a channel's historical messages as a query index;
- download behavior and limits that must be respected (the existing project documents a practical ~20 MB Bot API download ceiling);
- rate limits and request failures that must be treated as normal operational conditions;
- no reliable physical-erasure guarantee after a logical delete.

A Cloudflare-side index is therefore required to find Telegram records and objects efficiently. The proposed core uses a **free Cloudflare KV binding named `TELEGRAPH_CLOUD_KV`** as a materialized index, mutation outbox, project registry, and API-key registry. Telegram remains the canonical store for object bytes and immutable document revision payloads. KV is not presented as PostgreSQL, nor as the authoritative history.

`TELEGRAPH_CLOUD_KV` is deliberately separate from the legacy `img_url` binding. This avoids coupling new project data and access control to the legacy media dashboard's metadata namespace. A later migration helper may read legacy metadata, but no existing binding or record needs to be rewritten to enable Telegraph Cloud.

### Proposed document journal and consistency model

Each create, update, or delete will be an immutable Telegram JSON document uploaded with `sendDocument`. A revision payload will contain, at minimum:

```json
{
  "schema": "telegraph-cloud.record.v1",
  "event_id": "evt_...",
  "project_id": "prj_...",
  "collection": "users",
  "record_id": "usr_123",
  "operation": "create | update | delete",
  "version": 2,
  "parent": { "event_id": "evt_...", "version": 1 },
  "created_at": "2026-09-12T00:00:00.000Z",
  "document": { "id": "usr_123", "name": "Thio", "role": "member" }
}
```

The payload stores a full current-document snapshot for practical reads; update metadata can additionally retain the applied patch. A delete is a tombstone that points to the prior revision. Telegram `file_id` and `message_id` are internal pointers only and never appear in developer responses.

The KV materialized index will hold the current visible revision pointer, bounded query/list metadata, and a mutation-outbox state. A mutation is planned as:

1. validate the document and read the known record version;
2. write a mutation intent/outbox entry with a caller or server-generated idempotency key;
3. append the immutable revision to Telegram;
4. persist its internal pointer in the outbox;
5. materialize the current-record index; and
6. mark the mutation applied.

If an edge invocation fails between Telegram append and index materialization, the outbox provides a repair/recovery trail rather than silently treating a single edited message as the database. Retried requests use the same mutation identifier to deduplicate the materialized state even if a network timeout caused duplicate Telegram uploads.

Cloudflare KV has no compare-and-swap transaction. The API will use version/ETag preconditions (`If-Match`) for PATCH and DELETE, and the dashboard will send them. Concurrent writers that start from the same version can still produce competing immutable descendants at different edges; the implementation will expose a conflict instead of claiming serializable behavior, retain both journal entries, and apply a documented deterministic materialization rule. A future optional coordination adapter can improve this, but it is not a prerequisite and will not be marketed as ACID.

### Proposed query model

Telegraph Cloud is a JSON/document database. It will use **collections** and **documents**, with no SQL or PostgreSQL compatibility claim.

The first query layer will be intentionally bounded:

- equality filters on explicitly supported scalar top-level fields, for example `GET /api/db/users?role=admin`;
- stable, bounded `limit` values;
- opaque cursor pagination;
- one explicitly selected sort field/direction;
- no joins, arbitrary expressions, full SQL, relational constraints, or unlimited collection scans.

The collection index may scan a bounded set of materialized entries, so query performance is proportional to data scanned rather than a database-query planner. The UI and documentation must say so.

### Proposed object-storage model

A new generic object-storage service will be built alongside the current legacy-media provider. Its first Telegram adapter will:

- use `sendDocument` to preserve uploaded object bytes and avoid media transformations;
- keep an internal object manifest in `TELEGRAPH_CLOUD_KV` keyed by project/bucket/object key;
- calculate and return a SHA-256 based ETag, size, validated MIME type, timestamps, and bounded custom metadata;
- treat Telegram identifiers and messages as opaque implementation details;
- make DELETE a logical delete in the manifest, with best-effort Telegram `deleteMessage` only where permitted—not a promise of physical erasure;
- enforce a conservative Telegram-compatible size limit before buffering/uploading;
- validate bucket and key syntax before any remote call.

The legacy `/file/*` path will not be repointed in the initial object-storage release. It will keep serving existing Telegraph/Telegram/R2 media exactly as it does today. The new storage API is separate and will gain public/presigned delivery only after its authorization model is complete.

### Proposed API key and project model

Developer API keys and dashboard authentication are different systems:

- dashboard owners continue to authenticate with the existing `BASIC_USER` / `BASIC_PASS` session mechanism;
- API keys will have a form such as `tg_live_<key-id>_<secret>` (with preview/development variants where useful);
- only a key identifier, fixed-time-verifiable keyed hash, safe display prefix, permissions, project ID, timestamps, and revocation state are persisted in the index;
- the raw secret is returned exactly once at creation and is never rendered in a list, config response, or log;
- an `API_KEY_PEPPER` Cloudflare secret will be required for new API-key hashing, rather than exposing or deriving developer-key material from UI credentials.

Each key resolves its project server-side. Developer API callers do not choose an arbitrary project via a request parameter. The first project registry will be deployment-local; no claim of hosted multi-user tenancy is made.

## Security findings to address before exposing new APIs

These are audit findings, not claims that legacy behavior has already been changed.

1. **Sensitive telemetry risk (high priority):** `functions/utils/middleware.js` currently copies every incoming request header into Sentry context/tags. That can include `Authorization`, cookies, and future `X-API-Key` values. Header allowlisting/redaction must land before API keys or authenticated Cloud APIs are exposed.
2. **Internal error disclosure:** `functions/api/manage/_middleware.js` currently returns an exception message and stack in a 500 response. New and existing management error handling should return a stable, non-secret error response while preserving server-side diagnostic correlation only.
3. **Credential forwarding:** the Telegram legacy proxy currently forwards the incoming request headers upstream. The refactor must forward only a small allowlist required for safe file delivery (such as `Range`/`If-Range`), never caller authorization or cookies.
4. **Legacy input limits:** `/upload` intentionally accepts broad legacy media/file behavior and currently has no project-object size, MIME, or object-key validation. New `/storage` requests will be strict without silently breaking legacy upload workflows; legacy hardening will be tested separately.
5. **Path validation:** the new storage and document routes must reject control characters, encoded traversal segments, invalid UTF-8/lengths, ambiguous key forms, and unsafe content metadata. Legacy file IDs need a compatibility-conscious validation pass before being included in any upstream URL.
6. **CORS:** new authenticated APIs must not use a permissive browser CORS policy. The default will be same-origin/no CORS; any future allowed-origin configuration will be explicit and will never combine a wildcard origin with credentials.
7. **Dependency review:** `npm ci` reported 24 dependency-audit findings (3 low, 5 moderate, 14 high, 2 critical) in the current dependency tree. Phase 8 will identify the affected packages, determine reachability, and update/mitigate deliberately rather than running a blind breaking `npm audit fix --force`.

## What can be reused

- The existing Pages Functions structure and `context.env` secret/binding usage.
- The storage-provider selection pattern, Telegram configuration checks, Telegram upload retry mechanics, and R2 compatibility provider.
- Opaque file IDs, `/file/*`, short links, moderation, albums, and non-destructive media metadata behavior.
- HMAC session implementation and dashboard Basic Auth fallback.
- Existing static dashboard primitives: responsive drawer, dialogs, keyboard handling, command palette, dark/light preferences, accessibility affordances, and English/Indonesian i18n discipline.
- Mocha test helpers that already mock KV and `fetch`, plus well-covered legacy upload/file tests.
- Existing KV key-prefix discipline as a model for avoiding accidental legacy-list exposure.

## What must be redesigned or added

- A Telegram client/journal boundary that supports immutable JSON revision payloads without scattering Bot API calls across route handlers.
- A document-store service and a KV materialized index/outbox abstraction.
- A project registry and API-key service with hash-only secrets and project-derived authorization.
- A generic object-storage interface (`putObject`, `getObject`, `headObject`, `deleteObject`, `listObjects`) separate from the legacy upload provider interface.
- New direct storage routes with safe bucket/key parsing and eventually S3-shaped request/response behavior.
- A Cloud dashboard information architecture that exposes backend features without deleting the media workspace.
- Usage aggregation, export/import, and API documentation that accurately describe Telegram/Cloudflare limitations.
- Systematic security, error, path, CORS, rate-limit, range-request, and recovery coverage.

## Phased implementation plan

### Phase 1 — Boundaries and safe foundations

**Goal:** introduce reusable Cloud service contracts without changing public legacy behavior.

- Add Cloud-specific error, validation, index-binding, Telegram-client, document-store, and object-storage contracts/factories.
- Refactor direct Telegram interactions behind a narrow client/adapter boundary while preserving the legacy provider contract.
- Add safe request-header telemetry redaction/allowlisting, non-leaky errors, and safe outbound-header forwarding.
- Add shared validation helpers for future project IDs, collection names, document IDs, buckets, keys, MIME types, metadata, and payload limits.
- Add tests proving existing `/upload` and `/file/*` compatibility and the new security boundaries.
- Document the required `TELEGRAPH_CLOUD_KV` binding and `API_KEY_PEPPER` secret without adding a configuration UI.

**Exit criterion:** legacy test suite remains green; no Telegram bot token, cookie, Authorization header, or future API key can be placed into telemetry by the shared middleware.

### Phase 2 — Telegram-backed document database CRUD

**Goal:** ship the document abstraction behind a controlled, initially dashboard/admin-only surface.

- Implement immutable Telegram record revisions, mutation outbox, materialized collection/record indexes, recovery metadata, and tombstones.
- Add the requested REST shapes:
  - `POST /api/db/:collection`
  - `GET /api/db/:collection`
  - `GET /api/db/:collection/:id`
  - `PATCH /api/db/:collection/:id`
  - `DELETE /api/db/:collection/:id`
- Support validated arbitrary JSON objects, equality filters, sorting, limits, cursors, version/ETag responses, and conditional updates/deletes.
- Test create/read/list/filter/sort/pagination/update/delete; Telegram failures; idempotency; fork/conflict behavior; recovery after an index write failure; and no raw Telegram IDs in responses.
- Publish the consistency/query model alongside the implementation.

**Exit criterion:** CRUD is real, journal-backed, tested with mocked Telegram calls, and explicitly documented as a bounded document database rather than SQL/PostgreSQL.

### Phase 3 — Projects and developer API keys

**Goal:** make the database safely consumable by applications.

- Add a deployment-local project registry, dashboard project selection, and a non-destructive default-project migration path.
- Add key creation, one-time secret display, permission scopes, revoke, and rotation flows.
- Require API-key-derived project context on public developer database routes; preserve dashboard session authentication for dashboard management routes.
- Add `Bearer` and/or `X-API-Key` parsing with fixed-time hash verification, no secret logs, and safe auth failures.
- Test project boundaries, key permissions, revoke/rotate behavior, malformed keys, and dashboard/API-key separation.

**Exit criterion:** a developer key cannot access another project and raw keys are never persisted or returned after creation.

### Phase 4 — Generic Telegram object-storage abstraction

**Goal:** introduce project/bucket/key object semantics while leaving `/upload` and `/file/*` intact.

- Implement the generic storage interface and Telegram-backed object manifests.
- Add authenticated `PUT`, `GET`, `HEAD`, and `DELETE /storage/:bucket/:key` handling.
- Return/maintain object ETag, size, MIME type, dates, and constrained custom metadata.
- Define logical deletion and best-effort remote cleanup honestly.
- Test object upload/download/head/delete, metadata integrity, size/type/key validation, Telegram failure behavior, project boundaries, and legacy route non-regression.

**Exit criterion:** storage object operations work through an abstraction that could accept R2/S3/local adapters later, without exposing Telegram details.

### Phase 5 — Incremental S3-compatible behavior

**Goal:** expand compatibility in the requested order without claiming full S3 support.

1. Complete PUT/GET/HEAD/DELETE response semantics.
2. Add bounded `ListObjects` / `ListObjectsV2` behavior.
3. Add metadata headers and object tags where practical.
4. Add correctly tested single-range GET behavior.
5. Design multipart state but defer implementation until Telegram constraints are proven.
6. Add AWS Signature V4 parsing/verification only after the simpler API-key flow is stable.
7. Add presigned URLs only after authorization and expiry handling are tested.

Each supported subset will be named and documented; unsupported S3 operations will return an explicit compatibility error rather than an imitation response.

### Phase 6 — Telegraph Cloud dashboard

**Goal:** evolve the existing Material-inspired workspace into a useful backend control plane.

- Rebrand the public/dashboard surfaces to Telegraph Cloud without removing legacy compatibility views.
- Add Projects, Database Explorer, Storage Explorer, API Keys, Usage, API Playground, and Settings navigation.
- Reuse the existing responsive shell, command palette, dialogs, focus management, theme support, and localization pattern.
- Provide database collection/record views, JSON editing, history, filters, pagination, and conflict feedback.
- Provide storage buckets/key hierarchy, list/grid views, previews, metadata, upload, delete, copy key/URL, and honest unsupported-operation states.

### Phase 7 — Developer experience, usage, export/import, and documentation

**Goal:** make the platform usable without exposing its implementation details.

- Add an authenticated API Playground that uses the selected project/key safely and masks secrets.
- Add informational usage derived from materialized indexes: document count, object count, stored bytes, API activity, and Telegram activity where measurable.
- Add bounded JSON collection export/import and project export with explicit snapshots/limitations.
- Update English and Chinese documentation with deployment instructions, bindings/secrets, REST curl and JavaScript examples, authentication, migration, consistency, storage/S3 support matrix, limits, and recovery guidance.

### Phase 8 — Hardening and compatibility release review

**Goal:** prepare an honest experimental/self-hostable release.

- Security review of auth, telemetry, error handling, CORS, object-key parsing, request sizes, abuse/rate-limiting, HTML/JSON rendering, and Telegram failure handling.
- Dependency-audit triage and targeted upgrades.
- Compatibility testing for `/upload`, `/file/*`, short links, moderation, albums, dashboard sessions, and old media IDs.
- Load/boundary tests for Telegram rate limits, index scans, pagination, range requests, recovery, and concurrent write conflicts.
- Final documentation review to remove any implication of PostgreSQL compatibility, ACID transactions, unlimited query performance, or guaranteed physical deletion.

## Initial route and data-shape direction

Developer APIs will derive `project_id` from the authenticated key rather than accepting it as an untrusted resource selector. The required database route shapes remain concise:

```text
POST   /api/db/:collection
GET    /api/db/:collection?role=admin&limit=20&sort=-created_at
GET    /api/db/:collection/:id
PATCH  /api/db/:collection/:id
DELETE /api/db/:collection/:id
```

The initial object API remains at the requested direct storage shape:

```text
PUT    /storage/:bucket/:key
GET    /storage/:bucket/:key
HEAD   /storage/:bucket/:key
DELETE /storage/:bucket/:key
GET    /storage/:bucket?list-type=2&prefix=...
```

Until AWS Signature V4 is implemented, developer calls will use a Telegraph Cloud API key rather than claiming SigV4 support. The documentation will include curl and JavaScript examples for that implemented form.

## Phase 0 test record

After installing the lockfile dependencies with `npm ci`, the current unit/DOM suite was run:

```text
npm test
314 passing (approximately 40 seconds)
```

The dependency installation was not added to the repository. The existing package script uses Mocha and the CI workflow already runs `npm ci` followed by `npm test` on Node 22.

## Known limitations at this point

- Telegraph Cloud database/storage routes, projects, API keys, generic object manifests, usage, export/import, and Cloud dashboard panels do not exist yet.
- Current Telegram storage remains optimized for legacy media upload/serving, not caller-keyed generic objects.
- Existing metadata KV updates are not transactional; this is one reason new Cloud records need a journal/outbox and explicit version model.
- The newly identified telemetry/error/forwarded-header concerns need Phase 1 remediation before exposing authenticated developer APIs.
- The current UI is branded “Telegraph Storage”/“Telegraph-Image”; rebranding is intentionally deferred until the product surfaces exist.

## Recommended next phase

Proceed with **Phase 1: Boundaries and safe foundations**. It is deliberately additive: it establishes the Telegram/index/security contracts required by later phases while keeping all currently tested upload, file-serving, moderation, dashboard, session, and album behavior intact.
