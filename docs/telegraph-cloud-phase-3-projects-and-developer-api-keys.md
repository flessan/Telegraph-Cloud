# Telegraph Cloud — Phase 3: Projects and Developer API Keys

Phase 3 adds project boundaries and developer credentials to the additive Telegram-backed document database introduced in Phase 2. It does **not** change the established Telegraph-Image upload flow, `/file/*` links, Telegram/R2 media providers, media dashboard, albums, short links, or their existing authentication behavior.

> **Status:** experimental/self-hosted document API. Telegraph Cloud is a Telegram-backed document store, not PostgreSQL, SQL-compatible storage, a relational database, an ACID system, a secret manager, or an unlimited-throughput service.

## What this phase implements

- a KV control-plane project registry with opaque server-generated `prj_…` IDs, human-readable slug/name, lifecycle timestamps, and `active` / `disabled` / logical `deleted` status;
- dashboard-only project and developer-key management routes;
- cryptographically generated `tg_live_…` developer Bearer credentials, one-time plaintext reveal, HMAC-only persistent verification data, revocation, and rotation;
- a server-derived authorization chain: **Bearer key → key metadata → project → allowed database operation**;
- project-scoped document KV keys, outboxes, collection/filter indexes, revision indexes, and immutable Telegram revision metadata;
- continued, explicitly separate Phase 2 dashboard/session/Basic access to the pre-Phase-3 **unscoped legacy** document namespace;
- bounded, isolate-local mutation guards and telemetry defense-in-depth redaction.

Phase 3 itself did not implement object storage. Phase 4 now adds a separate generic object engine under `/api/storage/*`; see the [Phase 4 object-storage reference](telegraph-cloud-phase-4-object-storage.md). Neither phase implements S3 compatibility, bucket-management routes, presigned URLs, multipart uploads, a dashboard redesign, API playground, analytics, billing, SDKs, SQL, joins, or distributed rate limiting.

## Architecture and authority boundaries

```text
Dashboard Basic/session (administrator only)
  └─ /api/projects/*
      ├─ project records and slug index ──────────────┐
      └─ API-key metadata / HMAC lookup / key listing │
          all in TELEGRAPH_CLOUD_KV                   │
                                                        ▼
Developer request: Authorization: Bearer tg_live_…
  └─ domain-separated HMAC with API_KEY_PEPPER
      └─ direct HMAC lookup → key metadata → project status + scopes
          └─ project ID is server-derived, never taken from the request
              └─ /api/db/:collection[/:id]
                  ├─ scoped KV materialization / outbox
                  └─ immutable Telegram revision carrying project_id

Legacy dashboard Basic/session request to /api/db/*
  └─ existing unscoped Phase 2 KV/journal namespace only
```

`TELEGRAPH_CLOUD_KV` has two distinct roles:

1. **Control plane:** it is the persistent registry for projects, API-key metadata, revocation state, HMAC lookup entries, and project-to-key indexes. These records never go to Telegram.
2. **Document data-plane materialization:** it holds repairable current-record, collection, equality-filter, revision-pointer, and outbox state. Telegram remains the canonical append-only persistence substrate for document revision snapshots.

The control plane is intentionally separate from legacy `img_url`. Do not bind `img_url` as `TELEGRAPH_CLOUD_KV`.

### Project data isolation

For an authenticated developer key belonging to `prj_ExampleOpaqueId`, every document data-plane key receives that opaque ID as its first validated segment. For example:

```text
tc:v1:db-record:prj_ExampleOpaqueId:users:rec_Example
tc:v1:db-revision:prj_ExampleOpaqueId:users:rec_Example:2
tc:v1:db-outbox:prj_ExampleOpaqueId:idem_HashedRetryToken
tc:v1:db-collection:prj_ExampleOpaqueId:users:rec_Example
tc:v1:db-filter:prj_ExampleOpaqueId:users:role:YWRtaW4:rec_Example
```

The corresponding immutable `telegraph-cloud.record.v1` Telegram revision contains a non-secret `project_id`. Current record and index/outbox records carry the same scope for integrity validation. API-key plaintext, HMAC verifier, pepper, dashboard credential, Telegram `file_id`, and Telegram message ID are never returned in developer/database responses; the latter IDs remain internal pointers.

A project key cannot select another project by adding a `project_id` path value, header, or query parameter. The `/api/db/*` path still names only a collection and record; the authenticated key determines its project before the provider is constructed. A resource that is absent in that project returns the normal scoped `404`, even if another project has the same collection or record identifier.

Project isolation is an API authorization boundary, not encryption against infrastructure administrators. Anyone granted direct Cloudflare KV access or Telegram chat/history access remains an operator-level trust principal and must be restricted independently.

## Required bindings and secrets

Configure these in Cloudflare Pages and redeploy after changing them:

| Setting | Required for | Notes |
| --- | --- | --- |
| `TELEGRAPH_CLOUD_KV` KV binding | projects, keys, database materialization | A dedicated namespace, separate from `img_url`. |
| `API_KEY_PEPPER` secret | developer-key create/verify/rotate | A non-empty random secret of at least 32 UTF-8 bytes. Generate and store it only as a Pages secret, for example `openssl rand -base64 48`. Never place it in browser code, a static file, Telegram, or a document. |
| `TG_Bot_Token` secret | document journal and Phase 4 object byte/event transport | Existing server-side Bot API token; never expose it. |
| `TG_Chat_ID` binding/secret | document journal and Phase 4 object byte/event transport | Chat/channel where the bot can append documents. |
| `BASIC_USER` and `BASIC_PASS` secrets | dashboard and `/api/projects/*` | Both are required for project/key management. They remain distinct from developer keys. |
| `SESSION_SECRET` secret | dashboard HMAC session | Recommended existing dashboard-session signing secret. |

A developer-only database request can use a valid Bearer key even when dashboard Basic credentials are absent. By contrast, `/api/projects/*` always fails closed with `503 {"error":"project_auth_not_configured"}` until **both** dashboard credentials are configured. Existing dashboard/session/Basic access to `/api/db/*` continues to require both values and fails closed with the existing `database_auth_not_configured` response when they are absent.

Use a unique `API_KEY_PEPPER` for each environment. Replacing it invalidates verification of all existing developer keys in that environment; plan a controlled key reissue if it must be rotated. Safe metadata listing/revocation remains available to a dashboard administrator if the pepper is accidentally removed, but key creation, rotation, and developer authentication fail closed until a valid pepper is restored. Do not use `BASIC_PASS`, a bot token, or an application password as the pepper.

## Dashboard project management API

All routes in this section require the existing dashboard HMAC session cookie or `Authorization: Basic …` with `BASIC_USER` / `BASIC_PASS`. They do **not** accept developer Bearer keys. Responses use `Cache-Control: no-store`.

### Create and list projects

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"my-service","name":"My Service"}' \
  https://your-domain.example/api/projects
```

`POST /api/projects` returns `201` and a public-safe record:

```json
{
  "project_id": "prj_ServerGeneratedOpaqueId",
  "slug": "my-service",
  "name": "My Service",
  "status": "active",
  "created_at": "2026-09-12T12:34:56.000Z",
  "updated_at": "2026-09-12T12:34:56.000Z"
}
```

`project_id` is generated only by the server; clients may not supply it. A slug is a unique lowercase `a-z`, digit, hyphen identifier beginning with a letter and no longer than 48 UTF-8 bytes. A name is trimmed display text up to 120 UTF-8 bytes without control characters. The creation record intentionally keeps only `created_via: "dashboard"` internally, not a raw request, IP address, credential, or analytics payload.

`GET /api/projects?limit=20&cursor=…` returns a bounded page with `data`, `limit`, `order`, `has_more`, and an opaque `next_cursor` when another page exists. Only `limit` and `cursor` are accepted query parameters.

### Read, update, disable, and logically delete a project

```text
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
```

`PATCH` accepts one or more of `slug`, `name`, and `status`. `status` may be `active` or `disabled`:

```json
{ "status": "disabled" }
```

A disabled project keeps its data/key metadata but valid developer keys receive `403 {"error":"project_inactive"}`. Re-enable it with `{"status":"active"}` after operator review.

`DELETE` is a **logical control-plane deletion**: it marks the project deleted and removes its slug lookup. Existing developer credentials no longer authorize it (`403 project_inactive` after control-plane propagation). It does not claim physical erasure of immutable Telegram revisions, document materialization, or retained key metadata. There is no public undelete endpoint in this phase.

## Developer API-key management

Keys are created, listed, revoked, and rotated only underneath an administrator-selected project:

```text
POST   /api/projects/:id/keys
GET    /api/projects/:id/keys
DELETE /api/projects/:id/keys/:keyId
POST   /api/projects/:id/keys/:keyId/rotate
```

### Create: reveal exactly once

```bash
curl -u "$BASIC_USER:$BASIC_PASS" \
  -H 'Content-Type: application/json' \
  -d '{"label":"production deploy","scopes":["db:read","db:write"]}' \
  https://your-domain.example/api/projects/prj_ServerGeneratedOpaqueId/keys
```

`label` is safe display text; it defaults to `Developer key`. Allowed scopes are:

| Scope | Permits |
| --- | --- |
| `db:read` | `GET /api/db/:collection` and `GET /api/db/:collection/:id` |
| `db:write` | `POST`, `PATCH`, and `DELETE` database mutations |
| `storage:read` | `GET` and `HEAD /api/storage/:bucket/:key` in the key-derived project |
| `storage:write` | `PUT` and `DELETE /api/storage/:bucket/:key` in the key-derived project |

The default scope set remains both `db:read` and `db:write`; storage authority is opt-in. A key may have any least-privilege subset of the allowed scopes. The successful `201` creation response is the **only** time the plaintext `api_key` is available:

```json
{
  "api_key": "tg_live_key_<public-id>_<secret>",
  "key": {
    "key_id": "key_ServerGeneratedOpaqueId",
    "project_id": "prj_ServerGeneratedOpaqueId",
    "label": "production deploy",
    "key_prefix": "tg_live_key_ServerGeneratedOpaqueId…",
    "fingerprint": "safeHmacPrefix",
    "scopes": ["db:read", "db:write"],
    "status": "active",
    "created_at": "2026-09-12T12:34:56.000Z",
    "updated_at": "2026-09-12T12:34:56.000Z"
  }
}
```

Copy it directly into an appropriate server-side secret manager. Do not place it in source control, screenshots, browser local storage, telemetry, or a document record. There is intentionally no endpoint that can retrieve this plaintext later.

The usable grammar is `tg_live_key_<22-character-public-id>_<43-character-base64url-secret>`. It is generated using 32 bytes of cryptographically secure randomness for the secret; the public key ID is not a substitute for the secret.

### List, revoke, and rotate

`GET /api/projects/:id/keys?limit=20&cursor=…` returns a bounded `key_id:asc` page containing only safe key metadata, never `api_key`, a raw secret, or the pepper. It accepts only `limit` and an opaque `cursor`, and returns `next_cursor` when `has_more` is true. A key ID under the wrong project route returns the project-visible `404 {"error":"api_key_not_found"}` rather than confirming its existence elsewhere.

`DELETE /api/projects/:id/keys/:keyId` marks an active key revoked and returns its safe metadata. Repeating the delete returns the already-revoked metadata. Once a verifier sees revoked metadata, it rejects that credential as `401 {"error":"invalid_api_key"}`.

`POST /api/projects/:id/keys/:keyId/rotate` accepts the same optional `{ "label", "scopes" }` body as create. If fields are omitted it keeps the existing label/scopes. It creates a replacement and returns the replacement plaintext once with `201`; the prior key is revoked. The replacement's safe metadata has `rotated_from` set to the old key ID.

KV has no multi-record transaction. Rotation uses a conservative create-then-revoke sequence and attempts to revoke an unreturned replacement if the old-key revocation reports a failure. An administrator can inspect/revoke safe metadata if a control-plane failure interrupts that sequence; never assume an unreported new secret can be recovered.

## Developer database API

The document routes and record semantics remain those documented in the [Phase 2 database reference](telegraph-cloud-phase-2-document-database.md): JSON-object documents, server-generated record IDs, full immutable Telegram revisions, ETags/version preconditions, tombstones, bounded equality filters/cursors, and Idempotency-Key retries.

Use a developer credential only in the standard Authorization header:

```bash
curl https://your-domain.example/api/db/users \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY"
```

```bash
curl -X POST https://your-domain.example/api/db/users \
  -H "Authorization: Bearer $TELEGRAPH_CLOUD_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-user-20260912' \
  -d '{"name":"Thio","role":"admin"}'
```

Do not send a developer key in a query parameter, form field, cookie, collection name, project ID, or custom header. Only `Authorization: Bearer tg_live_…` selects developer mode. A malformed Bearer attempt never falls through to dashboard authentication. Query parameters remain ordinary bounded document-list controls/filters; they cannot change the project scope.

The old dashboard/session/Basic flow remains a separate compatibility mode for the unscoped Phase 2 namespace:

```bash
curl -u "$BASIC_USER:$BASIC_PASS" https://your-domain.example/api/db/users
```

It is useful for deliberate legacy export/migration, not a developer credential. A normal developer key cannot access `/api/projects/*`; those routes require dashboard Basic/session authentication.

### Status and visibility boundaries

| Situation | Status / safe response |
| --- | --- |
| Missing dashboard auth in legacy mode | `401 {"error":"unauthenticated"}` |
| Bearer key missing/malformed/unknown/revoked | `401 {"error":"invalid_api_key"}` |
| Valid developer key lacks the route scope | `403 {"error":"api_key_scope_forbidden"}` |
| Valid developer key belongs to disabled/deleted/missing project | `403 {"error":"project_inactive"}` |
| Record absent or tombstoned in the authenticated project | `404 {"error":"record_not_found"}` |
| Key ID addressed through another project management route | `404 {"error":"api_key_not_found"}` |
| Invalid document/path/body/precondition | Existing bounded Phase 2 `400` / `413` / `415` / `428` responses |

These responses do not reveal another project's collection, record, Telegram pointer, or key state. A dashboard administrator is deliberately a different trust role and can select a project by its dashboard management route.

## Credential storage and security model

A project key is generated as a one-time plaintext bearer credential. Persistent `TELEGRAPH_CLOUD_KV` records contain only:

- server-generated `key_id` and owning `project_id`;
- label, scopes, status/timestamps, safe public prefix, and rotation reference;
- a domain-separated HMAC-SHA-256 verifier of the **complete** credential, keyed with `API_KEY_PEPPER`;
- a truncated safe fingerprint derived from that verifier;
- an HMAC-indexed lookup pointer and project-to-key listing entry.

The plaintext credential, raw secret, `API_KEY_PEPPER`, bot token, dashboard password, and any plaintext/reversible secret representation are not stored in Telegram revisions or KV key metadata. Verification computes the same keyed HMAC for the supplied complete Bearer value, performs fixed-work/native Web Crypto HMAC verification of the stored verifier, checks active status, then obtains the project status/scopes. It does not scan every key and it never authorizes from a user-provided project ID.

Authorization headers are not logged by the project/database middleware. Existing telemetry already redacts Authorization, cookie, API-key, token, and secret headers; Phase 3 also redacts an accidentally interpolated `tg_live_…` value from telemetry messages, exception values, and breadcrumbs. Database and project error handlers return only allowlisted safe error codes, never caught exception text or stacks.

### Revocation and consistency limitation

Cloudflare KV is eventually consistent and has no transaction/CAS primitive. Revocation is written to key metadata first, and stale HMAC lookup cleanup cannot restore access once a verifier reads that revoked metadata. However, a geographically stale KV read can temporarily observe old control-plane state. Therefore revocation/disable/deletion is immediate **subject to KV control-plane propagation**, not a global instantaneous guarantee. Operators should rotate promptly, remove a compromised client secret, and treat the key as potentially usable only for the short propagation window documented by their KV deployment.

The document journal also has Phase 2 consistency limits: Telegram append and KV materialization are multi-step; an append that reaches Telegram but not KV can return retryable `mutation_pending`, and concurrent same-parent writes resolve only within the documented deterministic materialization behavior. Projects do not turn KV or Telegram into transactional storage.

## Migration from Phase 2 legacy database records

There is no default project, automatic reassignment, hidden migration, or silent interpretation of old records as belonging to a new project. This avoids accidentally granting a new developer credential access to pre-existing owner data.

Existing Phase 2 records remain reachable only through the separate dashboard/session/Basic `/api/db/*` legacy mode. To migrate deliberately:

1. Bind `TELEGRAPH_CLOUD_KV`, set a strong `API_KEY_PEPPER`, and retain the original `TG_Bot_Token`/`TG_Chat_ID` plus dashboard credentials.
2. Create the destination project through dashboard-authenticated `POST /api/projects` and create a least-privilege developer key under it.
3. With the dashboard legacy credential, page through each legacy collection using `GET /api/db/:collection`; record an external old-ID-to-new-ID mapping if callers depend on old identifiers.
4. Recreate each live document through the destination project's Bearer `POST /api/db/:collection`, removing the legacy managed `id` field because destination IDs are always server generated. Use unique Idempotency-Key values and verify result counts/content.
5. Update clients to use the new developer key. Keep the legacy source read-only until validation is complete, then follow your own retention/deletion policy.

This manual export/recreate flow does not preserve record IDs, old version numbers, or historical Telegram revisions. A future dedicated migration utility would need explicit operator confirmation and its own recovery design; it is not part of Phase 3.

## Local abuse guards and limits

- Database POST/PATCH/DELETE operations have a best-effort limit of **20 mutations per minute per running Function isolate** keyed by authenticated project in developer mode or dashboard identity in legacy mode.
- Dashboard project/key POST/PATCH/DELETE operations have a best-effort limit of **30 mutations per minute per running Function isolate** keyed by dashboard identity.
- These maps are local process memory only. They are not Cloudflare-wide, durable, exact, billing/usage analytics, or a substitute for edge WAF/rate-limit controls and Telegram's own constraints.
- Existing Phase 2 document byte/query/filter/idempotency limits still apply. Telegram document size/rate constraints and Cloudflare KV availability/consistency constraints still apply.

## Verification included in Phase 3

The test suite covers:

- opaque project creation, slug lifecycle/validation, disable/delete behavior, and safe control-plane metadata;
- `tg_live_…` grammar/random-secret handling, HMAC-only persisted key state, no plaintext in KV/list output, authentication, revoke, rotation, key scope, inactive-project behavior, and cross-project key `404` behavior;
- same-named collection and record isolation across project-scoped current/revision/outbox/index keys, plus `project_id` in Telegram revisions;
- full Pages route behavior for dashboard-only project/key APIs, one-time key reveal, Bearer database authorization, client project-hint non-authority, project-scope `404`, and retained dashboard legacy records;
- local guard behavior, safe error responses, legacy test regressions, and telemetry removal of an actual-shaped `tg_live_…` credential.

Run the full suite before deployment:

```bash
npm test
```

See the repository README for deployment setup and the Phase 2 reference for document request/response details.
